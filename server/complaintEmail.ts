// server/complaintEmail.ts
// Helpers PUROS da ingestão de reclamações por email (sem DB) — testáveis
// isoladamente. Usados por server/jobs/emailInboundSync.ts, server/db.ts e
// server/complaintsExtended.ts.
//
//  - remetentes internos / nomes genéricos ("Multipark") NUNCA contam como
//    sinal do cliente (senão todos os reencaminhamentos do backoffice caíam na
//    mesma reclamação);
//  - matrícula normalizada (sem espaços/hífens, maiúsculas) — igual ao lookup
//    de reservas em complaintDossier.ts;
//  - etiqueta do caso no assunto `[REC-<id>]` (respostas do cliente voltam ao
//    caso certo mesmo quando o thread se perde);
//  - HTML → texto com `html-to-text` (mantém quebras de linha para o parsing
//    `Etiqueta: valor`, descodifica entidades, ignora <style>/<script>).

import { isFeatureEnabled } from "./_core/featureFlags";
import { convert } from "html-to-text";
import { INTERNAL_EMAIL_DOMAINS } from "../shared/crmIdentity";

/** SLA por omissão de uma reclamação (igual ao valor por omissão do formulário manual). */
export const COMPLAINT_DEFAULT_SLA_HOURS = 48;

/** Janela do agrupamento por sinais do cliente (email/matrícula/nome). */
export const COMPLAINT_SIGNALS_WINDOW_DAYS = 60;

// ── Remetentes internos ─────────────────────────────────────────────────────

/** Domínio de um endereço (minúsculas), ou null. */
function emailDomain(email?: string | null): string | null {
  const m = String(email ?? "").trim().toLowerCase().match(/@([a-z0-9.\-]+)\s*>?$/);
  return m ? m[1] : null;
}

/** true = endereço da casa (multipark.pt, airpark.pt, …, incl. subdomínios). */
export function isInternalEmail(email?: string | null): boolean {
  const d = emailDomain(email);
  if (!d) return false;
  return INTERNAL_EMAIL_DOMAINS.some((x) => d === x || d.endsWith(`.${x}`));
}

const BRAND_RE = /\b(multi\s?park|air\s?park|red\s?park|sky\s?park|multi\s?group)\b/;
const GENERIC_NAMES = new Set([
  "info", "geral", "reservas", "reserva", "reclamacoes", "reclamacao", "apoio", "apoio ao cliente",
  "suporte", "backoffice", "atendimento", "noreply", "no-reply", "no reply", "livro de reclamacoes",
  "desconhecido", "cliente", "customer service", "support",
]);

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** true = nome de apresentação genérico/da marca (não identifica um cliente). */
export function isGenericSenderName(name?: string | null): boolean {
  const n = stripAccents(String(name ?? "")).toLowerCase().replace(/["'<>]/g, "").replace(/\s+/g, " ").trim();
  if (!n) return true;
  if (BRAND_RE.test(n)) return true;
  if (GENERIC_NAMES.has(n)) return true;
  // "reservas@multipark.pt" usado como nome
  if (n.includes("@")) return isInternalEmail(n);
  return false;
}

/** Email utilizável como sinal do cliente (válido e não interno), senão undefined. */
export function clientSignalEmail(email?: string | null): string | undefined {
  const e = String(email ?? "").trim();
  if (!/^[\w.\-+]+@[\w.\-]+\.\w{2,}$/.test(e)) return undefined;
  if (isInternalEmail(e)) return undefined;
  return e;
}

/** Nome utilizável como sinal do cliente (≥ 6 chars, não genérico), senão undefined. */
export function clientSignalName(name?: string | null): string | undefined {
  const n = String(name ?? "").trim();
  if (n.length < 6 || isGenericSenderName(n)) return undefined;
  return n;
}

// ── Matrícula ───────────────────────────────────────────────────────────────

/** "aa-11 bb" → "AA11BB" (mesma normalização do lookup de reservas). */
export function normalizePlate(p?: string | null): string {
  return String(p ?? "").replace(/[\s\-.]/g, "").toUpperCase();
}

// ── Etiqueta do caso no assunto ─────────────────────────────────────────────

export function complaintCaseTag(id: number): string {
  return `[REC-${id}]`;
}

/** Id da reclamação na etiqueta `[REC-<id>]` do assunto (1ª ocorrência), ou null. */
export function parseComplaintCaseTag(subject?: string | null): number | null {
  const m = String(subject ?? "").match(/\[\s*REC-(\d{1,9})\s*\]/i);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** Acrescenta `[REC-<id>]` ao assunto, só uma vez. */
export function tagComplaintSubject(subject: string | null | undefined, id: number): string {
  const s = String(subject ?? "").trim();
  if (parseComplaintCaseTag(s) === id) return s;
  return s ? `${s} ${complaintCaseTag(id)}` : complaintCaseTag(id);
}

/** Assunto de resposta: "Re: <assunto original>" sem acumular "Re: Re:". */
export function replySubject(subject?: string | null): string {
  const s = String(subject ?? "").trim();
  return /^(re|res|resp)\s*:/i.test(s) ? s : `Re: ${s}`;
}

// ── HTML → texto ────────────────────────────────────────────────────────────

/**
 * Converte o HTML de um email em texto simples, mantendo as quebras de linha
 * (parágrafos, <br>, linhas de tabela) para o parsing `Etiqueta: valor`.
 * Descodifica entidades, descarta <style>/<script>/<head> e imagens, e não
 * acrescenta os URLs dos links (ruído no corpo das reclamações).
 */
export function htmlToPlainText(html?: string | null): string {
  if (!html) return "";
  try {
    return convert(html, {
      wordwrap: false,
      selectors: [
        { selector: "a", options: { ignoreHref: true } },
        { selector: "img", format: "skip" },
        { selector: "style", format: "skip" },
        { selector: "script", format: "skip" },
        { selector: "head", format: "skip" },
        { selector: "h1", options: { uppercase: false } },
        { selector: "h2", options: { uppercase: false } },
        { selector: "h3", options: { uppercase: false } },
        { selector: "h4", options: { uppercase: false } },
        { selector: "h5", options: { uppercase: false } },
        { selector: "h6", options: { uppercase: false } },
        { selector: "table", format: "dataTable", options: { uppercaseHeaderCells: false } },
      ],
    })
      .replace(/ /g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch {
    // Último recurso: nunca perder o email por causa de HTML partido.
    return html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
}

/**
 * Tira do HTML, em tempo LINEAR (sem expressões que voltam atrás), o que nunca
 * é texto do email: comentários, <head>, <style> e <script>. Um bloco sem fecho
 * vai até ao fim (como no browser). Ronda 3 da auditoria: um <head> com 500 KB
 * de estilos deixava de fora o texto todo quando se cortava o HTML. PURA.
 */
export function stripHtmlNoise(html: string): string {
  const lower = html.toLowerCase();
  const n = html.length;
  const parts: string[] = [];
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { parts.push(html.slice(i)); break; }
    parts.push(html.slice(i, lt));
    if (lower.startsWith("<!--", lt)) {
      const end = lower.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    const tag = (["head", "style", "script"] as const).find((t) => lower.startsWith(`<${t}`, lt) && /^[\s>/]?$/.test(lower.charAt(lt + t.length + 1)));
    if (tag) {
      const close = lower.indexOf(`</${tag}`, lt + tag.length + 1);
      const gt = close < 0 ? -1 : lower.indexOf(">", close);
      i = gt < 0 ? n : gt + 1;
      continue;
    }
    parts.push("<");
    i = lt + 1;
  }
  return parts.join("");
}

/**
 * Teto do HTML que se converte para a triagem (ronda 3 da auditoria): a
 * conversão demora mais do que o tamanho em HTML muito aninhado (1 MB de
 * <div> encadeados = ~19 s a bloquear a sincronização). 100 KB de corpo (sem
 * cabeçalho nem estilos) dão muito mais texto do que a IA lê.
 */
export const READABLE_HTML_MAX = 100_000;
/** O mesmo teto para os pipelines das caixas (reclamacoes@, perdidos@…), que guardam até 20 000 caracteres do texto. */
export const INBOUND_HTML_MAX = 150_000;

/** HTML → texto com teto: tira o que não é texto (linear) e corta antes de converter. Nunca lança. PURA. */
export function boundedHtmlToText(html: string | null | undefined, max: number = READABLE_HTML_MAX): string {
  if (!html) return "";
  return htmlToPlainText(stripHtmlNoise(String(html)).slice(0, Math.max(0, max)));
}

/**
 * O texto de um email para LER (triagem da IA, regras): o text/plain; um email
 * só em HTML (sem parte de texto — alguns clientes de email e formulários)
 * passa a texto pelo HTML (com teto — `READABLE_HTML_MAX`); por fim o resumo
 * do Gmail. Ronda 2 da auditoria (14 out 2026): sem isto, a IA lia só o
 * resumo (~200 caracteres) e uma reclamação depois da saudação e de outro
 * pedido ficava de fora.
 */
export function readableMailText(m: { text?: string | null; html?: string | null; snippet?: string | null }): string {
  if (String(m.text ?? "").trim()) return String(m.text);
  const fromHtml = boundedHtmlToText(m.html, READABLE_HTML_MAX);
  return fromHtml || String(m.snippet ?? "");
}

// ── Livro de Reclamações / SLA ──────────────────────────────────────────────

/** Livro de Reclamações oficial (nº ROR…) → urgente. */
export function isLivroReclamacoes(subject?: string | null, body?: string | null): boolean {
  return /livro de reclama|ROR\d{6,}/i.test(`${subject ?? ""}\n${body ?? ""}`);
}

/** slaDeadline "YYYY-MM-DD HH:MM:SS" (UTC) a partir de agora, como o create manual. */
export function complaintSlaDeadline(hours = COMPLAINT_DEFAULT_SLA_HOURS, now = Date.now()): string {
  return new Date(now + hours * 3600000).toISOString().slice(0, 19).replace("T", " ");
}

// ── Aviso de receção automático ─────────────────────────────────────────────

/** Desligado com COMPLAINT_AUTO_ACK=off|false|0|no. */
export function isComplaintAutoAckEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return isFeatureEnabled("COMPLAINT_AUTO_ACK", { env });
}

/**
 * Endereço a quem se pode mandar o aviso de receção: email válido, externo
 * (não da casa) e não automático (noreply/mailer-daemon…).
 */
export function isAutoAckRecipient(email?: string | null): boolean {
  const e = clientSignalEmail(email);
  if (!e) return false;
  return !/(^|[.\-_])(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce[s]?)([.\-_+@]|$)/i.test(e.split("@")[0] + "@");
}

/** Corpo do aviso de receção (a saudação é acrescentada no envio). */
export function complaintAckBody(id: number): string {
  return [
    `Recebemos a sua reclamação, que ficou registada com o número ${complaintCaseTag(id)}.`,
    "Estamos a analisar a situação reportada e damos-lhe notícias assim que possível.",
    "Para acrescentar informação, basta responder a este email mantendo o número do processo no assunto.",
    "",
    "Com os melhores cumprimentos,",
    "Equipa Multipark",
  ].join("\n");
}
