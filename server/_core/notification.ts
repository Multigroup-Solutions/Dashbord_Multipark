import { TRPCError } from "@trpc/server";
import { createTransport, type Transporter } from "nodemailer";

export type NotificationPayload = {
  title: string;
  content: string;
};

const TITLE_MAX_LENGTH = 1200;
const CONTENT_MAX_LENGTH = 20000;

const trimValue = (value: string): string => value.trim();
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

let _transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (_transporter) return _transporter;

  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    console.warn("[Notification] SMTP not configured (SMTP_HOST, SMTP_USER, SMTP_PASS)");
    return null;
  }

  _transporter = createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  return _transporter;
}

const validatePayload = (input: NotificationPayload): NotificationPayload => {
  if (!isNonEmptyString(input.title)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification title is required.",
    });
  }
  if (!isNonEmptyString(input.content)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification content is required.",
    });
  }

  const title = trimValue(input.title);
  const content = trimValue(input.content);

  if (title.length > TITLE_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification title must be at most ${TITLE_MAX_LENGTH} characters.`,
    });
  }

  if (content.length > CONTENT_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification content must be at most ${CONTENT_MAX_LENGTH} characters.`,
    });
  }

  return { title, content };
};

/** Escapa texto para HTML (títulos/conteúdos vêm de dados de pessoas e de APIs). PURA. */
export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/**
 * Envia um email de notificação ao dono do projeto (OWNER_EMAIL).
 * Devolve `true` só se o email saiu. Sem SMTP/OWNER_EMAIL devolve `false` e
 * fica no log — antes devolvia `true` e quem chamava julgava-se avisado.
 */
export async function notifyOwner(
  payload: NotificationPayload
): Promise<boolean> {
  const { title, content } = validatePayload(payload);

  const transporter = getTransporter();
  const ownerEmail = process.env.OWNER_EMAIL;
  const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER;

  if (!transporter || !ownerEmail) {
    console.warn(`[Notification] Não enviado (${!transporter ? "SMTP não configurado" : "OWNER_EMAIL em falta"}): ${title}: ${content.slice(0, 500)}`);
    return false;
  }

  try {
    await transporter.sendMail({
      from: `"Dashboard Multipark" <${fromEmail}>`,
      to: ownerEmail,
      subject: `[Dashboard Multipark] ${title.replace(/[\r\n]+/g, " ")}`,
      text: content,
      html: `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(content).replace(/\n/g, "<br>")}</p>`,
    });
    return true;
  } catch (error) {
    console.warn("[Notification] Failed to send email:", error);
    return false;
  }
}

/** true = há SMTP configurado (SMTP_HOST/SMTP_USER/SMTP_PASS). */
export function isSmtpConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

export type SendEmailOptions = {
  to: string;
  cc?: string;
  subject: string;
  text?: string;
  html?: string;
  from?: string;     // endereço de envio (ex: recursos-humanos@multipark.pt); default SMTP_FROM
  fromName?: string; // nome do remetente apresentado
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
  /** Threading: Message-ID a que isto responde (In-Reply-To). */
  inReplyTo?: string;
  /** Threading: cadeia de Message-IDs (References). */
  references?: string | string[];
};

/**
 * Send an email to any recipient.
 */
export async function sendEmail(options: SendEmailOptions): Promise<boolean> {
  return (await sendEmailDetailed(options)).ok;
}

/** Como sendEmail, mas devolve também o Message-ID enviado (threading). */
export async function sendEmailDetailed(options: SendEmailOptions): Promise<{ ok: boolean; messageId?: string }> {
  const transporter = getTransporter();
  // Só permite enviar de aliases do próprio domínio (send-as configurados no Gmail).
  const allowedDomain = (process.env.SMTP_USER || "").split("@")[1] || "multipark.pt";
  const requested = options.from && options.from.endsWith(`@${allowedDomain}`) ? options.from : undefined;
  const fromEmail = requested || process.env.SMTP_FROM || process.env.SMTP_USER;
  const fromName = options.fromName || "Multipark";

  if (!transporter) {
    console.warn("[Email] SMTP not configured, cannot send email");
    return { ok: false };
  }

  const { from: _from, fromName: _fromName, inReplyTo, references, ...rest } = options;
  try {
    const info = await transporter.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      ...rest,
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(references && (Array.isArray(references) ? references.length : references) ? { references } : {}),
    });
    return { ok: true, messageId: typeof info?.messageId === "string" ? info.messageId : undefined };
  } catch (error) {
    console.warn("[Email] Failed to send:", error);
    return { ok: false };
  }
}
