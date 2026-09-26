/**
 * Cliente fino da WhatsApp Business Calling API (Graph API da Meta).
 *
 *  - POST /{PHONE_NUMBER_ID}/calls — ações `pre_accept`, `accept`, `reject`,
 *    `terminate` (chamadas recebidas) e `connect` (chamada feita por nós, com
 *    a oferta SDP do browser);
 *  - GET/POST /{PHONE_NUMBER_ID}/settings — configuração das chamadas
 *    (ativar, horário, pedido de autorização no "ligar de volta");
 *  - GET /{PHONE_NUMBER_ID}/call_permissions — autorização do cliente;
 *  - POST /{PHONE_NUMBER_ID}/messages — pedido de autorização (mensagem
 *    interativa `call_permission_request`, ou um template aprovado).
 *
 * Os construtores de payload são PUROS (testados). O executor recebe o `fetch`
 * por injeção (testes). Nunca regista SDP nem números completos.
 */
import { maskPhone, maskPhonesInText } from "../shared/maskPhone";
import { describeCallError } from "../shared/whatsappCalls";
import { fetchWithTimeout } from "./_core/fetchWithTimeout";
import { whatsappApiVersion } from "./whatsapp";

const GRAPH_BASE = "https://graph.facebook.com";

export type CallAction = "pre_accept" | "accept" | "reject" | "terminate";

/** Meta aceita o destinatário em dígitos (sem o "+"). */
export const toRecipient = (e164: string): string => String(e164 ?? "").replace(/^\+/, "").replace(/\D/g, "");

// ─── Payloads (PUROS) ───────────────────────────────────────────────────────

/** Corpo de pre_accept/accept/reject/terminate. `sdp` = resposta SDP do browser (só pre_accept/accept). */
export function buildCallActionPayload(action: CallAction, callId: string, sdp?: string | null, bizOpaque?: string | null): Record<string, unknown> {
  if (!callId) throw new Error("callId em falta");
  const body: Record<string, unknown> = { messaging_product: "whatsapp", call_id: callId, action };
  if (action === "pre_accept" || action === "accept") {
    if (!sdp || !sdp.trim()) throw new Error(`${action} precisa da resposta SDP`);
    body.session = { sdp_type: "answer", sdp };
    if (action === "accept" && bizOpaque) body.biz_opaque_callback_data = bizOpaque;
  }
  return body;
}

/** Corpo do `connect` (chamada feita pela empresa, com a oferta SDP do browser). */
export function buildConnectPayload(toE164: string, sdpOffer: string, bizOpaque?: string | null): Record<string, unknown> {
  const to = toRecipient(toE164);
  if (!to) throw new Error("Número do cliente em falta");
  if (!sdpOffer || !sdpOffer.trim()) throw new Error("Oferta SDP em falta");
  return {
    messaging_product: "whatsapp",
    to,
    action: "connect",
    session: { sdp_type: "offer", sdp: sdpOffer },
    ...(bizOpaque ? { biz_opaque_callback_data: bizOpaque } : {}),
  };
}

/** Pedido de autorização em texto livre (só com a janela de 24 h aberta). */
export function buildPermissionRequestPayload(toE164: string, bodyText?: string | null): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toRecipient(toE164),
    type: "interactive",
    interactive: {
      type: "call_permission_request",
      action: { name: "call_permission_request" },
      ...(bodyText && bodyText.trim() ? { body: { text: bodyText.trim().slice(0, 1024) } } : {}),
    },
  };
}

/** Pedido de autorização por template (janela fechada) — template aprovado com o componente call_permission_request. */
export function buildPermissionTemplatePayload(toE164: string, templateName: string, languageCode: string): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toRecipient(toE164),
    type: "template",
    template: { name: templateName, language: { code: languageCode } },
  };
}

export interface CallHoursInput {
  enabled: boolean;
  timezoneId: string;
  /** dia (MONDAY…SUNDAY) → [abre "HHMM", fecha "HHMM"] */
  weekly: Array<{ day: string; open: string; close: string }>;
}

export interface CallingSettingsInput {
  enabled: boolean;
  callIconVisibility?: "DEFAULT" | "DISABLE_ALL";
  callbackPermission?: boolean;
  callHours?: CallHoursInput | null;
}

const DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];
const HHMM = /^([01]\d|2[0-3])[0-5]\d$/;

/** Corpo de POST /settings (só o bloco `calling`). PURA; lança com mensagem PT se inválido. */
export function buildCallingSettingsPayload(input: CallingSettingsInput): { calling: Record<string, unknown> } {
  const calling: Record<string, unknown> = { status: input.enabled ? "ENABLED" : "DISABLED" };
  if (input.callIconVisibility) calling.call_icon_visibility = input.callIconVisibility;
  if (input.callbackPermission != null) calling.callback_permission_status = input.callbackPermission ? "ENABLED" : "DISABLED";
  if (input.callHours) {
    const h = input.callHours;
    const weekly = h.weekly.map((w) => {
      const day = String(w.day).toUpperCase();
      if (!DAYS.includes(day)) throw new Error(`Dia inválido: ${w.day}`);
      if (!HHMM.test(w.open) || !HHMM.test(w.close)) throw new Error(`Horas inválidas em ${day} (formato HHMM, ex.: 0900).`);
      if (w.open >= w.close) throw new Error(`Em ${day} a hora de fecho tem de ser depois da de abertura.`);
      return { day_of_week: day, open_time: w.open, close_time: w.close };
    });
    if (h.enabled && !weekly.length) throw new Error("Horário ligado sem nenhum dia.");
    calling.call_hours = { status: h.enabled ? "ENABLED" : "DISABLED", timezone_id: h.timezoneId || "Europe/Lisbon", weekly_operating_hours: weekly };
  }
  return { calling };
}

// ─── Executor ───────────────────────────────────────────────────────────────

export type GraphResult<T = any> = { ok: true; data: T } | { ok: false; error: string; code?: number };

export interface GraphDeps {
  fetch?: typeof fetchWithTimeout;
  env?: Record<string, string | undefined>;
}

function cfg(env: Record<string, string | undefined>): { token: string; phoneNumberId: string; version: string } | null {
  const token = env.WHATSAPP_TOKEN?.trim();
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!token || !phoneNumberId) return null;
  return { token, phoneNumberId, version: whatsappApiVersion(env) };
}

/** Pedido à Graph API no número configurado (`path` relativo ao número). Nunca lança. */
export async function graphPhoneRequest<T = any>(method: "GET" | "POST", path: string, body?: unknown, deps: GraphDeps = {}): Promise<GraphResult<T>> {
  const env = deps.env ?? process.env;
  const c = cfg(env);
  if (!c) return { ok: false, error: "WhatsApp não configurado (falta WHATSAPP_TOKEN e/ou WHATSAPP_PHONE_NUMBER_ID)." };
  const doFetch = deps.fetch ?? fetchWithTimeout;
  const url = `${GRAPH_BASE}/${c.version}/${encodeURIComponent(c.phoneNumberId)}/${path.replace(/^\//, "")}`;
  try {
    const resp = await doFetch(url, {
      method,
      headers: { Authorization: `Bearer ${c.token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      timeoutMs: 15_000,
    } as any);
    const data: any = await resp.json().catch(() => ({}));
    if (resp.ok) return { ok: true, data };
    const err = data?.error;
    const code = Number.isFinite(Number(err?.code)) ? Number(err.code) : undefined;
    const detail = err?.error_data?.details || err?.message || `HTTP ${resp.status}`;
    if (code === 190) {
      try {
        const { recordWhatsappAuthError } = await import("./integrations/whatsappConnection");
        await recordWhatsappAuthError(String(err?.message ?? "token"));
      } catch { /* segue */ }
    }
    const msg = describeCallError(code, detail);
    return { ok: false, error: code != null ? `${msg} (código ${code})` : msg, code };
  } catch (e: any) {
    return { ok: false, error: `Erro de rede: ${maskPhonesInText(String(e?.message ?? e)).slice(0, 160)}` };
  }
}

/** pre_accept / accept / reject / terminate. */
export async function callAction(action: CallAction, callId: string, sdp?: string | null, deps?: GraphDeps): Promise<GraphResult> {
  let body: Record<string, unknown>;
  try { body = buildCallActionPayload(action, callId, sdp); } catch (e: any) { return { ok: false, error: String(e?.message ?? e) }; }
  const r = await graphPhoneRequest("POST", "calls", body, deps);
  if (!r.ok) console.warn(`[WhatsAppCalls] ${action} falhou: ${r.error.slice(0, 160)}`);
  return r;
}

/** Chamada feita pela empresa → id da chamada (wacid.…). */
export async function connectCall(toE164: string, sdpOffer: string, bizOpaque?: string | null, deps?: GraphDeps): Promise<{ ok: true; callId: string } | { ok: false; error: string; code?: number }> {
  let body: Record<string, unknown>;
  try { body = buildConnectPayload(toE164, sdpOffer, bizOpaque); } catch (e: any) { return { ok: false, error: String(e?.message ?? e) }; }
  const r = await graphPhoneRequest<{ calls?: Array<{ id?: string }> }>("POST", "calls", body, deps);
  if (!r.ok) {
    console.warn(`[WhatsAppCalls] connect para ${maskPhone(toE164)} falhou: ${r.error.slice(0, 160)}`);
    return r;
  }
  const id = r.data?.calls?.[0]?.id;
  return id ? { ok: true, callId: String(id) } : { ok: false, error: "Resposta da Meta sem id da chamada." };
}

/** Envia o pedido de autorização (interativo ou template) → id da mensagem. */
export async function sendPermissionRequest(
  toE164: string,
  opts: { bodyText?: string | null; template?: { name: string; language: string } | null },
  deps?: GraphDeps,
): Promise<{ ok: true; waMessageId: string | null } | { ok: false; error: string; code?: number }> {
  const body = opts.template
    ? buildPermissionTemplatePayload(toE164, opts.template.name, opts.template.language)
    : buildPermissionRequestPayload(toE164, opts.bodyText);
  const r = await graphPhoneRequest<{ messages?: Array<{ id?: string }> }>("POST", "messages", body, deps);
  if (!r.ok) {
    console.warn(`[WhatsAppCalls] pedido de autorização para ${maskPhone(toE164)} falhou: ${r.error.slice(0, 160)}`);
    return r;
  }
  return { ok: true, waMessageId: r.data?.messages?.[0]?.id ? String(r.data.messages[0].id) : null };
}

export interface RemotePermission {
  status: "none" | "temporary" | "permanent";
  expiresAt: number | null;
  canRequest: boolean | null;
}

/** GET call_permissions (estado na Meta). PURA a partir da resposta. */
export function parseCallPermissionsResponse(data: any): RemotePermission {
  const raw = String(data?.permission?.status ?? "").toLowerCase();
  const status = raw === "temporary" ? "temporary" : raw === "permanent" ? "permanent" : "none";
  const exp = Number(data?.permission?.expiration_time);
  const act = (Array.isArray(data?.actions) ? data.actions : []).find((a: any) => a?.action_name === "send_call_permission_request");
  return { status, expiresAt: Number.isFinite(exp) && exp > 0 ? exp * 1000 : null, canRequest: act ? act.can_perform_action !== false : null };
}

export async function fetchCallPermission(toE164: string, deps?: GraphDeps): Promise<GraphResult<RemotePermission>> {
  const r = await graphPhoneRequest("GET", `call_permissions?user_wa_id=${encodeURIComponent(toRecipient(toE164))}`, undefined, deps);
  return r.ok ? { ok: true, data: parseCallPermissionsResponse(r.data) } : r;
}

export async function getCallingSettings(deps?: GraphDeps): Promise<GraphResult> {
  return graphPhoneRequest("GET", "settings", undefined, deps);
}

export async function updateCallingSettings(input: CallingSettingsInput, deps?: GraphDeps): Promise<GraphResult> {
  let body: { calling: Record<string, unknown> };
  try { body = buildCallingSettingsPayload(input); } catch (e: any) { return { ok: false, error: String(e?.message ?? e) }; }
  return graphPhoneRequest("POST", "settings", body, deps);
}

/** Resumo legível das definições de chamadas (GET /settings). PURA. */
export function summarizeCallingSettings(data: any): { enabled: boolean; callbackPermission: boolean | null; callHours: string; iconVisibility: string | null; restrictions: string[] } {
  const c = data?.calling ?? {};
  const enabled = String(c?.status ?? "").toUpperCase() === "ENABLED";
  const cb = c?.callback_permission_status == null ? null : String(c.callback_permission_status).toUpperCase() === "ENABLED";
  const h = c?.call_hours;
  let callHours = "sem horário (sempre disponível)";
  if (h && String(h.status ?? "").toUpperCase() === "ENABLED") {
    const days = (Array.isArray(h.weekly_operating_hours) ? h.weekly_operating_hours : [])
      .map((w: any) => `${String(w.day_of_week ?? "").slice(0, 3)} ${w.open_time}-${w.close_time}`)
      .join(", ");
    callHours = `${h.timezone_id ?? "?"}: ${days || "sem dias"}`;
  }
  const restrictions: string[] = [];
  const rs = c?.restrictions ?? data?.restrictions;
  const list = Array.isArray(rs?.restrictions_list) ? rs.restrictions_list : Array.isArray(rs) ? rs : [];
  for (const r of list) restrictions.push(String(r?.type ?? r?.restriction_type ?? "restrição") + (r?.expiration ? ` até ${new Date(Number(r.expiration) * 1000).toISOString().slice(0, 10)}` : ""));
  return { enabled, callbackPermission: cb, callHours, iconVisibility: c?.call_icon_visibility ?? null, restrictions };
}
