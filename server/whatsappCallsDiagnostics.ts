/**
 * "Testar" do cartão "WhatsApp — Chamadas" (Definições → Integrações):
 *  1. GET /{PHONE_NUMBER_ID}/settings — chamadas ativas? horário? pedido de
 *     autorização no "ligar de volta"? restrições da Meta?
 *  2. subscrição do campo `calls` no webhook da app Meta — GET /app (id da
 *     app do token) e GET /{app-id}/subscriptions com o token da app
 *     (`app_id|WHATSAPP_APP_SECRET`). Se não for possível ler, diz como
 *     confirmar à mão (não falha só por isso).
 * Nunca devolve tokens nem segredos.
 */
import { fetchWithTimeout } from "./_core/fetchWithTimeout";
import { getCallingSettings, summarizeCallingSettings } from "./whatsappCallsApi";
import { whatsappApiVersion } from "./whatsapp";

type Env = Record<string, string | undefined>;

export interface CallingDiagnosis {
  settingsError: string | null;
  summary: ReturnType<typeof summarizeCallingSettings> | null;
  /** true/false = subscrito ou não; null = não foi possível confirmar. */
  callsFieldSubscribed: boolean | null;
  subscriptionNote: string | null;
}

/** Mensagem final + ok. PURA. */
export function describeCallingDiagnosis(d: CallingDiagnosis): { ok: boolean; message: string } {
  const parts: string[] = [];
  let ok = true;
  if (d.settingsError || !d.summary) {
    ok = false;
    parts.push(`Não foi possível ler as definições de chamadas do número: ${d.settingsError ?? "resposta vazia"}.`);
  } else {
    const s = d.summary;
    if (!s.enabled) {
      ok = false;
      parts.push("Chamadas DESATIVADAS neste número — ativa em WhatsApp → Chamadas → Configuração (super admin) ou no WhatsApp Manager → Números de telefone → Chamadas.");
    } else {
      parts.push("Chamadas ativas no número.");
    }
    parts.push(`Horário: ${s.callHours}.`);
    if (s.callbackPermission != null) parts.push(`Pedir autorização ao ligar de volta: ${s.callbackPermission ? "sim" : "não"}.`);
    if (s.iconVisibility === "DISABLE_ALL") parts.push("Ícone de chamada escondido aos clientes (call_icon_visibility = DISABLE_ALL).");
    if (s.restrictions.length) {
      ok = false;
      parts.push(`Restrições da Meta: ${s.restrictions.join("; ")}.`);
    }
  }
  if (d.callsFieldSubscribed === false) {
    ok = false;
    parts.push("O campo \"calls\" NÃO está subscrito no webhook da app Meta (App Dashboard → WhatsApp → Configuração → Webhooks → subscrever \"calls\") — sem isso as chamadas não chegam ao dashboard.");
  } else if (d.callsFieldSubscribed === true) {
    parts.push("Webhook: campo \"calls\" subscrito.");
  } else {
    parts.push(`Webhook: não foi possível confirmar a subscrição do campo "calls"${d.subscriptionNote ? ` (${d.subscriptionNote})` : ""} — confirma em App Dashboard → WhatsApp → Configuração → Webhooks.`);
  }
  return { ok, message: parts.join(" ") };
}

/** A lista de subscrições da app inclui `calls` no objeto whatsapp_business_account? PURA. */
export function callsFieldInSubscriptions(data: any): boolean | null {
  const list = Array.isArray(data?.data) ? data.data : null;
  if (!list) return null;
  const waba = list.find((x: any) => String(x?.object ?? "") === "whatsapp_business_account");
  if (!waba) return false;
  const fields = Array.isArray(waba.fields) ? waba.fields : [];
  return fields.some((f: any) => (typeof f === "string" ? f : f?.name) === "calls");
}

async function graph(url: string, token?: string): Promise<any> {
  const r = await fetchWithTimeout(url, token ? { headers: { Authorization: `Bearer ${token}` }, timeoutMs: 10_000 } : { timeoutMs: 10_000 });
  const body: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error?.message ? String(body.error.message).slice(0, 160) : `HTTP ${r.status}`);
  return body;
}

export async function diagnoseCalling(env: Env = process.env): Promise<CallingDiagnosis> {
  const out: CallingDiagnosis = { settingsError: null, summary: null, callsFieldSubscribed: null, subscriptionNote: null };
  const s = await getCallingSettings({ env });
  if (s.ok) out.summary = summarizeCallingSettings(s.data);
  else out.settingsError = s.error;

  const version = whatsappApiVersion(env);
  const secret = env.WHATSAPP_APP_SECRET?.trim();
  if (!secret) {
    out.subscriptionNote = "falta WHATSAPP_APP_SECRET";
    return out;
  }
  try {
    const appId = env.META_APP_ID?.trim() || env.WHATSAPP_APP_ID?.trim() || String((await graph(`https://graph.facebook.com/${version}/app?fields=id`, env.WHATSAPP_TOKEN!.trim()))?.id ?? "");
    if (!appId) throw new Error("id da app desconhecido");
    const subs = await graph(`https://graph.facebook.com/${version}/${encodeURIComponent(appId)}/subscriptions?access_token=${encodeURIComponent(`${appId}|${secret}`)}`);
    out.callsFieldSubscribed = callsFieldInSubscriptions(subs);
  } catch (e: any) {
    // Nunca ecoa o URL (leva o token da app na query string).
    out.subscriptionNote = String(e?.message ?? e).replace(/access_token=[^&\s]+/g, "access_token=…").slice(0, 120);
  }
  return out;
}

/** Usado pelo hub de integrações: lança com a mensagem se algo estiver mal. */
export async function testWhatsappCalling(env: Env = process.env): Promise<string> {
  const d = describeCallingDiagnosis(await diagnoseCalling(env));
  if (!d.ok) throw new Error(d.message);
  return d.message;
}
