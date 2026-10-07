/**
 * Pedir os documentos em falta aos extras (pauta do Rafael, 7 out 2026:
 * "Extras template a pedir Docs em falta — criar automação enviar docs em
 * falta"). Regras PURAS, partilhadas pela pré-visualização (sem efeitos), pelo
 * envio à mão (ficha e lista do RH) e pelo pedido automático semanal
 * (server/rhDocsRequest.ts) — o que se vê na janela é o que segue.
 *
 *  - o que falta sai da checklist dos obrigatórios (shared/employeeDocuments.ts):
 *    um PENDENTE conta como entregue (não se pede); um RECUSADO volta a faltar
 *    e o pedido diz "recusado: <motivo>";
 *  - só se pede à pessoa o que ELA entrega (fotografia, CC/BI, carta, NIB e
 *    morada); o contrato e o termo de responsabilidade são do RH e ficam à
 *    parte ("a tratar pelo RH");
 *  - cadência: no máximo 1 pedido por pessoa a cada 7 dias (à mão ou
 *    automático) e no máximo 4 pedidos AUTOMÁTICOS por pessoa (depois só à mão);
 *  - canais: WhatsApp (template por cidade, configurado nas Definições; sem
 *    template → só email) e email (o de trabalho ou, sem ele, o pessoal);
 *    "Não enviar WhatsApp/email" da ficha, o STOP e os números sem WhatsApp
 *    respeitam-se.
 */
import { DOC_TYPE_LABELS, type ChecklistItem } from "./employeeDocuments";
import { noticeEmailAddress } from "./shiftNotice";
import { NO_AUTO_EMAIL_ERROR, NO_AUTO_WHATSAPP_ERROR } from "./contactPrefs";
import { lisbonDayOf } from "./lisbonDay";

export const DOCS_REQUEST_COOLDOWN_DAYS = 7;
export const DOCS_REQUEST_AUTO_MAX = 4;
const DAY_MS = 86_400_000;

export const DOCS_REQUEST_CHANNELS = ["whatsapp", "email"] as const;
export type DocsRequestChannel = (typeof DOCS_REQUEST_CHANNELS)[number];
export const DOCS_REQUEST_CHANNEL_LABELS: Record<DocsRequestChannel, string> = { whatsapp: "WhatsApp", email: "Email" };

export type DocsRequestMode = "manual" | "auto";
export const DOCS_REQUEST_MODE_LABELS: Record<DocsRequestMode, string> = { manual: "à mão", auto: "automático" };

/** Cidades (chaves da escala, as mesmas das Definições por cidade). */
export const DOCS_REQUEST_CITIES = ["lisbon", "porto", "faro"] as const;
export type DocsRequestCity = (typeof DOCS_REQUEST_CITIES)[number];
export const DOCS_REQUEST_CITY_LABELS: Record<DocsRequestCity, string> = { lisbon: "Lisboa", porto: "Porto", faro: "Faro" };

/**
 * Obrigatórios que a PRÓPRIA pessoa entrega (os outros obrigatórios —
 * contrato e termo de responsabilidade — carrega-os o RH; ver
 * SELF_UPLOAD_DOC_TYPES em server/rhAccess.ts). Ordem da ficha.
 */
export const DOCS_REQUEST_PERSON_DOC_TYPES = ["photo", "id_card", "driving_license", "nib_proof", "address_proof"] as const;

/** Caminho da ficha onde a pessoa carrega (quem não vê a lista do RH abre logo a sua ficha). */
export const DOCS_REQUEST_UPLOAD_PATH = "/rh";

// ─── Template do WhatsApp (Definições → "rh.docsRequestTemplates") ──────────

/** "nome_do_modelo|pt_PT" (o mesmo formato do modelo dos alertas sem PDA/Zello). */
export const DOCS_TEMPLATE_PATTERN = /^[a-z0-9_]{1,512}\|[a-z]{2}(_[A-Z]{2})?$/;

export interface DocsTemplateRef { name: string; language: string }

/** "nome|pt_PT" → { name, language }; vazio ou inválido → null ("template por configurar"). PURA. */
export function parseDocsTemplate(raw: string | null | undefined): DocsTemplateRef | null {
  const v = String(raw ?? "").trim();
  if (!DOCS_TEMPLATE_PATTERN.test(v)) return null;
  const [name, language] = v.split("|");
  return { name, language };
}

/** Templates por cidade a partir do valor da definição (cidades sem valor → null). PURA. */
export function docsTemplatesByCity(setting: Partial<Record<string, unknown>> | null | undefined): Record<DocsRequestCity, DocsTemplateRef | null> {
  const s = setting ?? {};
  return {
    lisbon: parseDocsTemplate(typeof s.lisbon === "string" ? s.lisbon : null),
    porto: parseDocsTemplate(typeof s.porto === "string" ? s.porto : null),
    faro: parseDocsTemplate(typeof s.faro === "string" ? s.faro : null),
  };
}

// ─── O que falta ────────────────────────────────────────────────────────────

export interface RequestedDoc {
  docType: string;
  label: string;
  /** "missing" = nunca entregue; "rejected" = o RH recusou (volta a faltar). */
  state: "missing" | "rejected";
  rejectedReason: string | null;
}

const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();

/**
 * O que falta a uma ficha, a partir da checklist dos obrigatórios. `request` =
 * o que se pede à pessoa; `rhOnly` = em falta mas é o RH que trata (contrato,
 * termo). Pendentes e validados não faltam. PURA.
 */
export function docsToRequest(checklist: readonly Pick<ChecklistItem, "docType" | "present" | "state" | "rejectedReason">[]): { request: RequestedDoc[]; rhOnly: RequestedDoc[] } {
  const request: RequestedDoc[] = [];
  const rhOnly: RequestedDoc[] = [];
  for (const c of checklist) {
    if (c.present) continue;
    const doc: RequestedDoc = {
      docType: c.docType,
      label: DOC_TYPE_LABELS[c.docType] ?? c.docType,
      state: c.state === "rejected" ? "rejected" : "missing",
      rejectedReason: c.state === "rejected" && c.rejectedReason ? oneLine(c.rejectedReason) : null,
    };
    if ((DOCS_REQUEST_PERSON_DOC_TYPES as readonly string[]).includes(c.docType)) request.push(doc);
    else rhOnly.push(doc);
  }
  return { request, rhOnly };
}

/** "Carta de Condução (recusado: ilegível)". PURA. */
export function requestedDocLabel(d: RequestedDoc, maxReason = 120): string {
  if (d.state !== "rejected") return d.label;
  const why = d.rejectedReason ? `: ${d.rejectedReason.length > maxReason ? `${d.rejectedReason.slice(0, maxReason - 1)}…` : d.rejectedReason}` : "";
  return `${d.label} (recusado${why})`;
}

/** Lista numa linha (vai no {{2}} do WhatsApp: sem quebras de linha, máx. 500 — a Meta aceita 512). PURA. */
export function docsRequestLine(docs: readonly RequestedDoc[], max = 500): string {
  const line = oneLine(docs.map((d) => requestedDocLabel(d, 80)).join(", "));
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Primeiro nome para o {{1}} e o "Olá …" (sem nome utilizável → "colega"). PURA. */
export function docsRequestFirstName(fullName: string | null | undefined): string {
  const first = oneLine(String(fullName ?? "")).split(" ")[0]?.slice(0, 64);
  return first || "colega";
}

export const DOCS_REQUEST_EMAIL_SUBJECT = "Documentos em falta na tua ficha — Multipark";

/** Email do pedido (texto simples; o servidor faz o HTML a partir dele). PURA. */
export function docsRequestEmailLines(p: { fullName: string; docs: readonly RequestedDoc[]; hasAccount: boolean; appUrl: string }): string[] {
  const list = p.docs.map((d) => `• ${d.state === "rejected" ? `${d.label} — recusado${d.rejectedReason ? `: ${d.rejectedReason}` : ""}` : d.label}`).join("\n");
  const how = p.hasAccount
    ? `Carrega-os na tua ficha: ${p.appUrl.replace(/\/+$/, "")}${DOCS_REQUEST_UPLOAD_PATH} (entra com a tua conta e abre "Documentos"). Também podes responder a este email com uma fotografia de cada um.`
    : "Responde a este email com uma fotografia de cada um (frente e verso, quando houver).";
  return [
    `Olá ${docsRequestFirstName(p.fullName)},`,
    "Faltam estes documentos na tua ficha da Multipark:",
    list,
    how,
    "Se já os enviaste, ignora esta mensagem.",
    "Obrigado,\nMultipark",
  ];
}

/** O que fica gravado na conversa do WhatsApp (o texto fixo é o do template na Meta). PURA. */
export function docsRequestWhatsappBody(firstName: string, line: string): string {
  return `Pedido de documentos em falta (${firstName}): ${line}`;
}

// ─── Registo e cadência ─────────────────────────────────────────────────────

/** Uma linha de employee_docs_requests (o que interessa às regras). */
export interface DocsRequestLogRow {
  employeeId: number;
  mode: DocsRequestMode;
  /** Instante do pedido (ms UTC). */
  atMs: number;
  whatsappStatus: string | null;
  emailStatus: string | null;
  /** Nome de quem pediu (null = automático ou desconhecido). */
  byName?: string | null;
}

/** Estados que contam como "pedido feito" (saiu, está a sair, ou a Meta não confirmou). */
const COUNTED = new Set(["sent", "sending", "unknown"]);
export const docsRequestChannelCounted = (status: string | null | undefined) => COUNTED.has(String(status ?? ""));

/** O pedido conta (pelo menos um canal saiu)? Falhado ou só ignorado não conta. PURA. */
export function docsRequestCounted(row: Pick<DocsRequestLogRow, "whatsappStatus" | "emailStatus">): boolean {
  return docsRequestChannelCounted(row.whatsappStatus) || docsRequestChannelCounted(row.emailStatus);
}

/** Canais que saíram num pedido. PURA. */
export function docsRequestSentChannels(row: Pick<DocsRequestLogRow, "whatsappStatus" | "emailStatus">): DocsRequestChannel[] {
  return DOCS_REQUEST_CHANNELS.filter((c) => docsRequestChannelCounted(c === "whatsapp" ? row.whatsappStatus : row.emailStatus));
}

export interface LastDocsRequest {
  atMs: number;
  mode: DocsRequestMode;
  byName: string | null;
  channels: DocsRequestChannel[];
}

export interface DocsRequestCadence {
  last: LastDocsRequest | null;
  /** Pedidos automáticos que contaram. */
  autoCount: number;
  /** Último pedido há menos de 7 dias. */
  withinCooldown: boolean;
  /** Já teve os 4 automáticos (daqui para a frente só à mão). */
  autoCapReached: boolean;
  /** A partir de quando pode voltar a receber (ms) — null se já pode. */
  nextAllowedAtMs: number | null;
}

/** Cadência de UMA pessoa a partir do registo dela. PURA. */
export function docsRequestCadence(rows: readonly DocsRequestLogRow[], nowMs: number): DocsRequestCadence {
  const counted = rows.filter(docsRequestCounted).slice().sort((a, b) => b.atMs - a.atMs);
  const lastRow = counted[0] ?? null;
  const autoCount = counted.filter((r) => r.mode === "auto").length;
  const until = lastRow ? lastRow.atMs + DOCS_REQUEST_COOLDOWN_DAYS * DAY_MS : null;
  const withinCooldown = until != null && nowMs < until;
  return {
    last: lastRow ? { atMs: lastRow.atMs, mode: lastRow.mode, byName: lastRow.byName ?? null, channels: docsRequestSentChannels(lastRow) } : null,
    autoCount,
    withinCooldown,
    autoCapReached: autoCount >= DOCS_REQUEST_AUTO_MAX,
    nextAllowedAtMs: withinCooldown ? until : null,
  };
}

/** "03/10" (dia de Lisboa). PURA. */
export function ddmm(ms: number): string {
  const [, m, d] = lisbonDayOf(ms).split("-");
  return `${d}/${m}`;
}

/** "Último pedido: 03/10 por Márcia (WhatsApp, Email)" / "… automático (Email)". PURA. */
export function lastDocsRequestLabel(last: LastDocsRequest | null): string | null {
  if (!last) return null;
  const who = last.mode === "auto" ? "automático" : last.byName ? `por ${last.byName}` : "à mão";
  const via = last.channels.map((c) => DOCS_REQUEST_CHANNEL_LABELS[c]).join(", ");
  return `Último pedido: ${ddmm(last.atMs)} ${who}${via ? ` (${via})` : ""}`;
}

// ─── Plano (quem recebe o quê e quem fica de fora) ──────────────────────────

export interface DocsRequestPerson {
  id: number;
  fullName: string;
  /** Posto da ficha (só extras recebem). */
  position: string | null;
  isActive: boolean;
  /** Tem conta para entrar na app (o email diz onde carregar). */
  hasAccount: boolean;
  email: string | null;
  personalEmail: string | null;
  /** Telemóvel normalizado (E.164) ou null. */
  phoneE164: string | null;
  noAutoEmail: boolean;
  noAutoWhatsapp: boolean;
  /** O número pediu STOP. */
  whatsappOptedOut: boolean;
  /** O número está marcado "sem WhatsApp" (131026 seguidos). */
  whatsappUnreachable: boolean;
  city: DocsRequestCity | null;
  checklist: readonly Pick<ChecklistItem, "docType" | "present" | "state" | "rejectedReason">[];
}

export type DocsChannelPlan =
  | { action: "send" }
  | { action: "off" }
  | { action: "skip"; kind: "not_configured" | "template_missing" | "no_city" | "no_contact" | "opted_out" | "unreachable"; reason: string };

export type DocsPersonSkipKind = "not_extra" | "inactive" | "no_missing" | "rh_only" | "cooldown" | "auto_cap";

export interface DocsRequestPersonPlan {
  employeeId: number;
  name: string;
  city: DocsRequestCity | null;
  /** O que se pede à pessoa. */
  docs: RequestedDoc[];
  /** Em falta, mas é o RH que trata (contrato, termo). */
  rhOnly: RequestedDoc[];
  /** {{1}} e {{2}} do template do WhatsApp. */
  whatsappParams: [string, string];
  /** Template da cidade da pessoa (null = por configurar ou sem cidade). */
  template: DocsTemplateRef | null;
  emailTo: string | null;
  emailSubject: string;
  emailLines: string[];
  /** Fica de fora (todos os canais) e porquê. */
  skip: { kind: DocsPersonSkipKind; reason: string } | null;
  channels: Record<DocsRequestChannel, DocsChannelPlan>;
  last: LastDocsRequest | null;
  autoCount: number;
}

export interface DocsRequestPlan {
  people: DocsRequestPersonPlan[];
  /** Pessoas com pelo menos um canal a enviar. */
  recipients: number;
  toSend: Record<DocsRequestChannel, number>;
}

/** Recebe alguma coisa? PURA. */
export function docsPlanWillSend(p: Pick<DocsRequestPersonPlan, "skip" | "channels">): boolean {
  return !p.skip && DOCS_REQUEST_CHANNELS.some((c) => p.channels[c].action === "send");
}

/** Porque é que fica de fora (vazio = recebe). PURA. */
export function docsPlanIgnoredReasons(p: Pick<DocsRequestPersonPlan, "skip" | "channels">): string[] {
  if (p.skip) return [p.skip.reason];
  if (docsPlanWillSend(p)) return [];
  return DOCS_REQUEST_CHANNELS.flatMap((c) => {
    const plan = p.channels[c];
    return plan.action === "skip" ? [`${DOCS_REQUEST_CHANNEL_LABELS[c]}: ${plan.reason}`] : [];
  });
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * O plano de um pedido de documentos: o texto exato por pessoa e canal, quem
 * recebe e quem fica de fora (e porquê). `log` = o registo de pedidos destas
 * pessoas. `force` (só à mão, numa ficha) passa por cima dos 7 dias. PURA.
 */
export function planDocsRequests(input: {
  people: readonly DocsRequestPerson[];
  log: readonly DocsRequestLogRow[];
  mode: DocsRequestMode;
  channels: readonly DocsRequestChannel[];
  configured: Record<DocsRequestChannel, boolean>;
  templates: Record<DocsRequestCity, DocsTemplateRef | null>;
  nowMs: number;
  appUrl: string;
  force?: boolean;
}): DocsRequestPlan {
  const people: DocsRequestPersonPlan[] = [];
  for (const p of input.people) {
    const { request, rhOnly } = docsToRequest(p.checklist);
    const cad = docsRequestCadence(input.log.filter((r) => r.employeeId === p.id), input.nowMs);
    const first = docsRequestFirstName(p.fullName);
    const line = docsRequestLine(request);
    const emailTo = noticeEmailAddress(p);
    const template = p.city ? input.templates[p.city] ?? null : null;

    let skip: DocsRequestPersonPlan["skip"] = null;
    if (p.position !== "extra") skip = { kind: "not_extra", reason: "não é extra (o pedido é só para extras)" };
    else if (!p.isActive) skip = { kind: "inactive", reason: "ficha inativa" };
    else if (!request.length && !rhOnly.length) skip = { kind: "no_missing", reason: "sem documentos em falta" };
    else if (!request.length) skip = { kind: "rh_only", reason: `só faltam documentos do RH (${rhOnly.map((d) => d.label).join(", ")})` };
    else if (input.mode === "auto" && cad.autoCapReached) {
      skip = { kind: "auto_cap", reason: `já teve ${plural(cad.autoCount, "pedido automático", "pedidos automáticos")} (máximo ${DOCS_REQUEST_AUTO_MAX}) — daqui para a frente só à mão` };
    } else if (cad.withinCooldown && !(input.force && input.mode === "manual")) {
      const days = Math.max(0, Math.floor((input.nowMs - cad.last!.atMs) / DAY_MS));
      skip = { kind: "cooldown", reason: `já pedido a ${ddmm(cad.last!.atMs)} (${days === 0 ? "hoje" : `há ${plural(days, "dia", "dias")}`}) — pode voltar a pedir-se a ${ddmm(cad.nextAllowedAtMs!)}` };
    }

    const plan = (channel: DocsRequestChannel): DocsChannelPlan => {
      if (skip || !input.channels.includes(channel)) return { action: "off" };
      if (channel === "whatsapp") {
        if (!input.configured.whatsapp) return { action: "skip", kind: "not_configured", reason: "WhatsApp não configurado" };
        if (p.noAutoWhatsapp) return { action: "skip", kind: "opted_out", reason: NO_AUTO_WHATSAPP_ERROR };
        if (!p.phoneE164) return { action: "skip", kind: "no_contact", reason: "sem telemóvel válido na ficha" };
        if (p.whatsappOptedOut) return { action: "skip", kind: "opted_out", reason: "pediu STOP no WhatsApp" };
        if (p.whatsappUnreachable) return { action: "skip", kind: "unreachable", reason: "sem WhatsApp (a Meta não entregou as últimas mensagens a este número)" };
        if (!p.city) return { action: "skip", kind: "no_city", reason: "ficha sem cidade — não se sabe que template usar" };
        if (!template) return { action: "skip", kind: "template_missing", reason: `template por configurar (${DOCS_REQUEST_CITY_LABELS[p.city]}) — Definições → Parâmetros (Extras-dia)` };
        return { action: "send" };
      }
      if (!input.configured.email) return { action: "skip", kind: "not_configured", reason: "Envio de email não configurado" };
      if (p.noAutoEmail) return { action: "skip", kind: "opted_out", reason: NO_AUTO_EMAIL_ERROR };
      if (!emailTo) return { action: "skip", kind: "no_contact", reason: "sem email (de trabalho nem pessoal) na ficha" };
      return { action: "send" };
    };

    people.push({
      employeeId: p.id,
      name: p.fullName,
      city: p.city,
      docs: request,
      rhOnly,
      whatsappParams: [first, line],
      template,
      emailTo,
      emailSubject: DOCS_REQUEST_EMAIL_SUBJECT,
      emailLines: docsRequestEmailLines({ fullName: p.fullName, docs: request, hasAccount: p.hasAccount, appUrl: input.appUrl }),
      skip,
      channels: { whatsapp: plan("whatsapp"), email: plan("email") },
      last: cad.last,
      autoCount: cad.autoCount,
    });
  }
  people.sort((a, b) => a.name.localeCompare(b.name, "pt") || a.employeeId - b.employeeId);
  return {
    people,
    recipients: people.filter(docsPlanWillSend).length,
    toSend: {
      whatsapp: people.filter((p) => !p.skip && p.channels.whatsapp.action === "send").length,
      email: people.filter((p) => !p.skip && p.channels.email.action === "send").length,
    },
  };
}

/** Estado de um canal no registo, em PT-PT. PURA. */
export function docsRequestStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case "sent": return "enviado";
    case "sending": return "a enviar";
    case "unknown": return "sem confirmação da Meta";
    case "failed": return "falhou";
    case "skipped": return "não enviado";
    default: return "—";
  }
}
