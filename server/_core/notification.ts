/**
 * Alertas ao dono (OWNER_EMAIL). O envio é o serviço único de email pela API
 * do Gmail (server/mail/systemMail.ts) — já não há SMTP.
 */
import { TRPCError } from "@trpc/server";

export type NotificationPayload = {
  title: string;
  content: string;
};

const TITLE_MAX_LENGTH = 1200;
const CONTENT_MAX_LENGTH = 20000;

const trimValue = (value: string): string => value.trim();
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

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
 * Envia um email de notificação ao dono do projeto (OWNER_EMAIL) pela API do
 * Gmail (remetente de sistema). Devolve `true` só se o email saiu; sem envio
 * configurado/OWNER_EMAIL devolve `false` e fica no log.
 */
export async function notifyOwner(
  payload: NotificationPayload
): Promise<boolean> {
  const { title, content } = validatePayload(payload);
  const ownerEmail = process.env.OWNER_EMAIL;
  if (!ownerEmail) {
    console.warn(`[Notification] Não enviado (OWNER_EMAIL em falta): ${title}: ${content.slice(0, 500)}`);
    return false;
  }
  const { sendEmailDetailed } = await import("../mail/systemMail");
  const r = await sendEmailDetailed({
    to: ownerEmail,
    subject: `[Dashboard Multipark] ${title.replace(/[\r\n]+/g, " ")}`,
    text: content,
    html: `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(content).replace(/\n/g, "<br>")}</p>`,
    fromName: "Dashboard Multipark",
    kind: "system",
  });
  if (!r.ok) console.warn(`[Notification] Não enviado (${r.error ?? "falhou"}): ${title}`);
  return r.ok;
}
