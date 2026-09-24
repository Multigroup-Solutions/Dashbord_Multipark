/**
 * Leitura de uma mensagem da API Gmail (formato "full") para a forma que
 * guardamos: cabeçalhos, destinatários, texto/HTML (base64url), anexos
 * (só metadados — os bytes vêm a pedido), direção. PURA (testável).
 */
import type { gmail_v1 } from "@googleapis/gmail";
import { extractAddresses, parseMailbox } from "../../shared/mail";

export interface MailAttachmentMeta {
  index: number;
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string | null;
  /** Content-ID (imagens inline "cid:"). */
  contentId: string | null;
  inline: boolean;
  /** Guardado no storage (só os do pipeline antigo: fotos de reclamações, CVs). */
  url?: string;
  key?: string;
}

export interface ParsedGmailMessage {
  gmailMessageId: string;
  gmailThreadId: string;
  labelIds: string[];
  historyId: string | null;
  sentAt: string | null;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  snippet: string;
  fromName: string | null;
  fromEmail: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  deliveredTo: string[];
  xOriginalTo: string[];
  replyTo: string | null;
  autoSubmitted: string | null;
  precedence: string | null;
  text: string;
  html: string;
  attachments: MailAttachmentMeta[];
  outbound: boolean;
  unread: boolean;
}

/** base64url (Gmail) → texto UTF-8. PURA. */
export function decodeBase64Url(data: string | null | undefined): string {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/** Todos os valores de um cabeçalho (sem distinguir maiúsculas). PURA. */
export function headerValues(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string[] {
  const n = name.toLowerCase();
  return (headers ?? []).filter((h) => String(h.name ?? "").toLowerCase() === n).map((h) => String(h.value ?? ""));
}
const header = (headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string) => headerValues(headers, name)[0] ?? null;

const msgIdList = (v: string | null | undefined): string[] => (String(v ?? "").match(/<[^<>\s]+>/g) ?? []).map((x) => x.trim());

function walk(part: gmail_v1.Schema$MessagePart | undefined, out: { text: string[]; html: string[]; attachments: MailAttachmentMeta[] }) {
  if (!part) return;
  const mime = String(part.mimeType ?? "").toLowerCase();
  const filename = String(part.filename ?? "");
  const disposition = String(header(part.headers, "Content-Disposition") ?? "").toLowerCase();
  const contentId = (header(part.headers, "Content-ID") ?? "").replace(/[<>]/g, "").trim() || null;
  const isAttachment = !!filename || !!part.body?.attachmentId && !mime.startsWith("text/") || disposition.startsWith("attachment");
  if (part.parts?.length) {
    for (const p of part.parts) walk(p, out);
    return;
  }
  if (isAttachment) {
    out.attachments.push({
      index: out.attachments.length,
      filename: filename || (contentId ? `${contentId}` : "anexo"),
      mimeType: mime || "application/octet-stream",
      size: Number(part.body?.size ?? 0),
      attachmentId: part.body?.attachmentId ?? null,
      contentId,
      inline: disposition.startsWith("inline") || (!!contentId && !disposition.startsWith("attachment")),
    });
    return;
  }
  if (mime === "text/plain") out.text.push(decodeBase64Url(part.body?.data));
  else if (mime === "text/html") out.html.push(decodeBase64Url(part.body?.data));
}

/** Gmail "full" → forma interna. PURA. */
export function parseGmailMessage(m: gmail_v1.Schema$Message, opts: { accountEmail?: string | null } = {}): ParsedGmailMessage {
  const h = m.payload?.headers;
  const bodies = { text: [] as string[], html: [] as string[], attachments: [] as MailAttachmentMeta[] };
  walk(m.payload, bodies);
  const from = parseMailbox(header(h, "From"));
  const labelIds = (m.labelIds ?? []).map(String);
  const internal = Number(m.internalDate ?? NaN);
  const sentAt = Number.isFinite(internal) ? new Date(internal).toISOString().slice(0, 19).replace("T", " ") : null;
  const account = String(opts.accountEmail ?? "").toLowerCase();
  const outbound = labelIds.includes("SENT") || (!labelIds.includes("INBOX") && !!account && from.email === account && !labelIds.includes("DRAFT"));
  const refs = msgIdList(header(h, "References"));
  return {
    gmailMessageId: String(m.id ?? ""),
    gmailThreadId: String(m.threadId ?? m.id ?? ""),
    labelIds,
    historyId: m.historyId ?? null,
    sentAt,
    rfcMessageId: msgIdList(header(h, "Message-ID") ?? header(h, "Message-Id"))[0] ?? null,
    inReplyTo: msgIdList(header(h, "In-Reply-To"))[0] ?? null,
    references: refs,
    subject: (header(h, "Subject") ?? "").slice(0, 500),
    snippet: String(m.snippet ?? "").slice(0, 300),
    fromName: from.name,
    fromEmail: from.email,
    to: extractAddresses(headerValues(h, "To").join(", ")),
    cc: extractAddresses(headerValues(h, "Cc").join(", ")),
    bcc: extractAddresses(headerValues(h, "Bcc").join(", ")),
    deliveredTo: extractAddresses(headerValues(h, "Delivered-To").join(", ")),
    xOriginalTo: extractAddresses([...headerValues(h, "X-Original-To"), ...headerValues(h, "X-Forwarded-To"), ...headerValues(h, "X-Forwarded-For")].join(", ")),
    replyTo: extractAddresses(header(h, "Reply-To"))[0] ?? null,
    autoSubmitted: header(h, "Auto-Submitted"),
    precedence: header(h, "Precedence"),
    text: bodies.text.join("\n\n").slice(0, 200_000),
    html: bodies.html.join("\n").slice(0, 1_000_000),
    attachments: bodies.attachments,
    outbound,
    unread: labelIds.includes("UNREAD"),
  };
}

/**
 * Id da conversa do Gmail no formato do IMAP (X-GM-THRID é o MESMO número em
 * decimal; a API dá-o em hexadecimal). Mantém `inbound_emails.gmThreadId`
 * compatível entre as duas fontes. PURA.
 */
export function gmailThreadIdToImap(hex: string | null | undefined): string | null {
  const s = String(hex ?? "").trim();
  if (!/^[0-9a-f]{1,16}$/i.test(s)) return null;
  try { return BigInt(`0x${s}`).toString(10); } catch { return null; }
}

/** Parte externa principal da conversa (quem não é da empresa). PURA. */
export function externalParty(p: Pick<ParsedGmailMessage, "outbound" | "fromEmail" | "fromName" | "to" | "cc" | "replyTo">, isCompany: (a: string) => boolean): { email: string | null; name: string | null } {
  if (!p.outbound) {
    const e = p.replyTo && !isCompany(p.replyTo) ? p.replyTo : p.fromEmail;
    if (e && !isCompany(e)) return { email: e, name: e === p.fromEmail ? p.fromName : null };
    return { email: null, name: null };
  }
  const e = [...p.to, ...p.cc].find((a) => !isCompany(a)) ?? null;
  return { email: e, name: null };
}
