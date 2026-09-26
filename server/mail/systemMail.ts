/**
 * Envio de TODOS os emails da aplicação pela API do Gmail (sem SMTP).
 *
 *  - Emails de sistema (notificações, briefing, escala, tarefas, formação,
 *    relatórios, alertas ao dono): saem da conta remetente de sistema
 *    (Definições → Comunicação, `mail.systemSender`; por omissão
 *    reservas@multipark.pt), impersonada pela conta de serviço (delegação,
 *    gmail.send). Levam `X-Multipark-System: 1` + `Auto-Submitted:
 *    auto-generated`: a sincronização guarda-os como automáticos (escondidos)
 *    e nunca como conversa de cliente na Comunicação.
 *  - Emails a clientes com remetente de alias (reclamacoes@, perdidos@,
 *    recursos-humanos@…): saem da conta de origem da caixa que tem esse
 *    alias, com "Enviar como" verificado — a resposta do cliente volta à
 *    mesma caixa. Se o alias não estiver em "Enviar como", sai da conta de
 *    sistema com Reply-To = alias (e fica no log).
 *
 * Mesma autenticação e composição da Comunicação (gmailApi.ts + compose.ts).
 * Nunca lança: devolve ok:false (e o motivo) quando não consegue enviar.
 */
import { randomUUID } from "node:crypto";
import {
  DEFAULT_MAILBOX_SOURCE, SYSTEM_MAIL_HEADER, checkSendAs, extractAddresses, normalizeAddress, sourceAccountKey,
  type MailboxConfig, type SendAsEntry,
} from "../../shared/mail";
import { parseServiceAccount } from "../_core/ai/client";
import { buildRawMessage } from "./compose";

export type SendEmailOptions = {
  /** Um ou vários destinatários ("a@x.pt, b@y.pt" também serve). */
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  /** Alias de envio (ex.: reclamacoes@multipark.pt) — tem de ser de uma caixa configurada. */
  from?: string;
  /** Nome do remetente apresentado. */
  fromName?: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
  /** Threading: Message-ID a que isto responde (In-Reply-To). */
  inReplyTo?: string;
  /** Threading: cadeia de Message-IDs (References). */
  references?: string | string[];
  /** "system" (omissão sem `from`): marcado como automático; "client" (omissão com `from`): conversa normal. */
  kind?: "system" | "client";
};

export interface SendResult { ok: boolean; messageId?: string; from?: string; accountKey?: string; error?: string }

/** O que o envio usa da API Gmail (gmailApi.ts). */
export interface SenderApi {
  listSendAs(): Promise<SendAsEntry[]>;
  sendRaw(raw: Buffer, threadId?: string | null): Promise<{ id: string; threadId: string | null }>;
}

export interface SystemMailDeps {
  /** Conta remetente dos emails de sistema (Definições → Comunicação). */
  systemSender(): Promise<string>;
  /** Caixas configuradas (para encontrar a conta de origem de um alias). */
  mailboxes(): Promise<readonly MailboxConfig[]>;
  /** API Gmail de uma conta ("dwd:email" / "user:id"). */
  apiFor(accountKey: string): Promise<SenderApi>;
  /** Conta de serviço com delegação configurada? */
  dwdAvailable(): boolean;
  log?(msg: string): void;
}

const SEND_AS_TTL_MS = 10 * 60_000;
const sendAsCache = new Map<string, { at: number; list: SendAsEntry[] }>();

async function sendAsOf(accountKey: string, api: SenderApi): Promise<SendAsEntry[]> {
  const c = sendAsCache.get(accountKey);
  if (c && Date.now() - c.at < SEND_AS_TTL_MS) return c.list;
  const list = await api.listSendAs();
  sendAsCache.set(accountKey, { at: Date.now(), list });
  return list;
}

/** Só para os testes: esquece os "Enviar como" guardados. */
export function clearSendAsCache(): void { sendAsCache.clear(); }

const listOf = (v: string | string[] | undefined): string[] =>
  Array.from(new Set((Array.isArray(v) ? v : v ? [v] : []).flatMap((x) => extractAddresses(x)))).slice(0, 100);

/** Conta de origem de um alias (primeira caixa ativa DWD com esse endereço). PURA. */
export function accountForAlias(alias: string, mailboxes: readonly MailboxConfig[]): string | null {
  const a = normalizeAddress(alias);
  if (!a) return null;
  for (const m of mailboxes) {
    if (!m.active || m.sourceKind !== "dwd") continue;
    if (m.addresses.some((x) => normalizeAddress(x.address) === a)) return sourceAccountKey(m);
  }
  return null;
}

/** Núcleo (dependências injetáveis para os testes). Nunca lança. */
export async function sendMailWith(deps: SystemMailDeps, o: SendEmailOptions): Promise<SendResult> {
  const to = listOf(o.to), cc = listOf(o.cc), bcc = listOf(o.bcc);
  if (!to.length && !cc.length && !bcc.length) return { ok: false, error: "Sem destinatários." };
  if (!deps.dwdAvailable()) {
    deps.log?.(`[email] Não enviado (conta de serviço Google em falta): ${o.subject}`);
    return { ok: false, error: "Conta de serviço Google (delegação) em falta — sem envio de email." };
  }
  const kind = o.kind ?? (o.from ? "client" : "system");
  const system = normalizeAddress(await deps.systemSender().catch(() => DEFAULT_MAILBOX_SOURCE)) || DEFAULT_MAILBOX_SOURCE;
  const requested = normalizeAddress(o.from);

  // 1) Alias pedido → conta de origem da caixa, se o alias estiver em "Enviar como".
  let accountKey = `dwd:${system}`;
  let fromAddress = system;
  let replyTo: string | null = null;
  let api: SenderApi | null = null;
  try {
    if (requested && requested !== system) {
      const aliasAccount = accountForAlias(requested, await deps.mailboxes());
      const candidates = Array.from(new Set([aliasAccount, `dwd:${system}`].filter((k): k is string => !!k)));
      let chosen = false;
      for (const key of candidates) {
        const a = await deps.apiFor(key);
        const check = checkSendAs(requested, key.replace(/^dwd:/, ""), await sendAsOf(key, a));
        if (check.ok) { accountKey = key; fromAddress = check.email; api = a; chosen = true; break; }
      }
      if (!chosen) {
        deps.log?.(`[email] ${requested} não está em "Enviar como" (${candidates.join(", ")}) — sai de ${system} com Reply-To ${requested}.`);
        replyTo = requested;
      }
    }
    if (!api) api = await deps.apiFor(accountKey);

    const domain = fromAddress.split("@")[1] || "multipark.pt";
    const messageId = `<${randomUUID()}@${domain}>`;
    const refs = Array.isArray(o.references) ? o.references : o.references ? String(o.references).split(/\s+/) : [];
    const raw = await buildRawMessage({
      from: { name: (o.fromName || (kind === "system" ? "Dashboard Multipark" : "Multipark")).replace(/[\r\n"]+/g, " "), address: fromAddress },
      to, cc, bcc,
      subject: String(o.subject ?? "").replace(/[\r\n]+/g, " ").slice(0, 900),
      text: o.text ?? "",
      html: o.html ?? "",
      inReplyTo: o.inReplyTo ?? null,
      references: refs.filter(Boolean),
      attachments: (o.attachments ?? []).map((a) => ({ filename: a.filename, contentType: a.contentType || undefined, content: a.content })),
      headers: kind === "system" ? { [SYSTEM_MAIL_HEADER]: "1", "Auto-Submitted": "auto-generated" } : {},
      messageId,
      replyTo,
    });
    await api.sendRaw(raw, null);
    return { ok: true, messageId, from: fromAddress, accountKey };
  } catch (err: any) {
    const msg = String(err?.message ?? err).slice(0, 300);
    deps.log?.(`[email] Falhou o envio (${accountKey}): ${msg}`);
    return { ok: false, error: msg, accountKey };
  }
}

// ─── Dependências reais ─────────────────────────────────────────────────────

/** Remetente de sistema configurado (Definições → Comunicação); omissão reservas@. */
export async function systemSenderAddress(): Promise<string> {
  try {
    const { getSetting } = await import("../appSettings");
    return normalizeAddress((await getSetting("mail.systemSender")) as string | null) || DEFAULT_MAILBOX_SOURCE;
  } catch { return DEFAULT_MAILBOX_SOURCE; }
}

export const dbSystemMailDeps: SystemMailDeps = {
  systemSender: systemSenderAddress,
  async mailboxes() {
    try {
      const { listMailboxes } = await import("./store");
      return await listMailboxes();
    } catch { return []; }
  },
  async apiFor(accountKey) {
    const { gmailApiForAccount } = await import("./gmailApi");
    return gmailApiForAccount(accountKey);
  },
  dwdAvailable() {
    return isEmailSendConfigured();
  },
  log: (m) => console.warn(m),
};

/**
 * Há envio de email? (conta de serviço Google com delegação — o remetente tem
 * sempre um valor). Síncrono: serve de guarda antes de montar um email.
 */
export function isEmailSendConfigured(env: Record<string, string | undefined> = process.env): boolean {
  const sa = parseServiceAccount(env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON || env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return typeof sa?.client_email === "string" && !!sa.client_email && typeof sa?.private_key === "string" && !!sa.private_key;
}

/** Envia um email (Gmail API). true só se saiu. */
export async function sendEmail(options: SendEmailOptions): Promise<boolean> {
  return (await sendEmailDetailed(options)).ok;
}

/** Como sendEmail, mas devolve também o Message-ID enviado (threading) e o motivo de uma falha. */
export async function sendEmailDetailed(options: SendEmailOptions): Promise<SendResult> {
  return sendMailWith(dbSystemMailDeps, options);
}

/**
 * Teste das Integrações / botão "Testar" nas Definições: confirma que a conta
 * remetente aceita a delegação (perfil + "Enviar como"), sem enviar nada.
 */
export async function testSystemSender(): Promise<string> {
  if (!isEmailSendConfigured()) throw new Error("Conta de serviço Google (GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON) em falta.");
  const sender = await systemSenderAddress();
  const { gmailApiForAccount } = await import("./gmailApi");
  const api = await gmailApiForAccount(`dwd:${sender}`);
  const p = await api.getProfile();
  const sendAs = await api.listSendAs();
  const aliases = sendAs.filter((s) => !s.isPrimary && String(s.verificationStatus ?? "accepted").toLowerCase() === "accepted").length;
  return `Envio pela API do Gmail OK: remetente ${p.emailAddress ?? sender} (${aliases} alias(es) em "Enviar como"). Nada foi enviado.`;
}
