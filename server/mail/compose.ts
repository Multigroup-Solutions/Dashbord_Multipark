/**
 * Composição de emails (RFC 5322 via MailComposer do nodemailer) para envio
 * pela API Gmail: assunto "Re:"/"Fwd:", In-Reply-To/References, texto +
 * HTML (texto escapado, parágrafos) + citação da mensagem anterior + anexos.
 * PURO exceto `buildRawMessage` (gera o Buffer).
 */
import MailComposer from "nodemailer/lib/mail-composer/index.js";

export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** Texto → HTML simples (escapado; linhas e links). PURA. */
export function textToHtml(text: string): string {
  const esc = escapeHtml(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  return esc.split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px">${p.replace(/\n/g, "<br>")}</p>`).join("");
}

/** "Re: …" sem acumular prefixos. PURA. */
export function prefixedSubject(subject: string | null | undefined, prefix: "Re" | "Fwd"): string {
  const base = String(subject ?? "").replace(/^\s*((re|res|fw|fwd|enc)\s*:\s*)+/i, "").trim() || "(sem assunto)";
  return `${prefix}: ${base}`.slice(0, 300);
}

/** References para responder: as da mensagem + o Message-ID dela (sem repetidos, máx. 20). PURA. */
export function replyReferences(original: { rfcMessageId: string | null; references: string[] }): string[] {
  const list = [...original.references, ...(original.rfcMessageId ? [original.rfcMessageId] : [])];
  return Array.from(new Set(list)).slice(-20);
}

export interface QuoteSource { fromName: string | null; fromEmail: string | null; sentAtLabel: string; text: string }

export function quoteText(q: QuoteSource): string {
  const who = q.fromName ? `${q.fromName} <${q.fromEmail ?? ""}>` : (q.fromEmail ?? "");
  const body = q.text.split("\n").slice(0, 200).map((l) => `> ${l}`).join("\n");
  return `\n\nEm ${q.sentAtLabel}, ${who} escreveu:\n${body}`;
}

export function quoteHtml(q: QuoteSource): string {
  const who = escapeHtml(q.fromName ? `${q.fromName} <${q.fromEmail ?? ""}>` : (q.fromEmail ?? ""));
  return `<div style="margin-top:16px;color:#555">Em ${escapeHtml(q.sentAtLabel)}, ${who} escreveu:</div><blockquote style="margin:4px 0 0 .6em;padding-left:.6em;border-left:2px solid #ccc;color:#555">${textToHtml(q.text.slice(0, 20_000))}</blockquote>`;
}

export interface RawMessageInput {
  from: { name: string | null; address: string };
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html: string;
  inReplyTo?: string | null;
  references?: string[];
  attachments?: Array<{ filename: string; contentType: string; content: Buffer }>;
}

export async function buildRawMessage(m: RawMessageInput): Promise<Buffer> {
  const composer = new MailComposer({
    from: m.from.name ? { name: m.from.name, address: m.from.address } : m.from.address,
    to: m.to,
    cc: m.cc.length ? m.cc : undefined,
    bcc: m.bcc.length ? m.bcc : undefined,
    subject: m.subject,
    text: m.text,
    html: m.html,
    inReplyTo: m.inReplyTo ?? undefined,
    references: m.references?.length ? m.references : undefined,
    attachments: (m.attachments ?? []).map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content })),
  });
  return composer.compile().build();
}
