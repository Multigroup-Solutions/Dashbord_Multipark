/**
 * Adaptador da API Gmail oficial (@googleapis/gmail) para o que a
 * Comunicação usa — leitura (perfil, lista, histórico, mensagem, anexos),
 * "Enviar como", envio, marcar lida e watch (push). A autenticação é a
 * service account com delegação (caixas partilhadas) ou a conta ligada do
 * utilizador (OAuth). Todos os pedidos têm prazo (workspace.ts).
 */
import type { gmail_v1 } from "@googleapis/gmail";
import { GOOGLE_FEATURE_SCOPES, userIdOfAccountKey, type SendAsEntry } from "../../shared/mail";
import { delegatedClient, gmailFor, googleErrorMessage, isAuthRevokedError } from "../google/workspace";
import type { GmailApiLike } from "./sync";

export interface GmailApi extends GmailApiLike {
  getAttachment(messageId: string, attachmentId: string): Promise<Buffer>;
  listSendAs(): Promise<SendAsEntry[]>;
  sendRaw(raw: Buffer, threadId?: string | null): Promise<{ id: string; threadId: string | null }>;
  modifyLabels(id: string, add: string[], remove: string[]): Promise<void>;
  watch(topicName: string): Promise<{ historyId: string | null; expiration: number | null }>;
}

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function wrapGmail(g: gmail_v1.Gmail): GmailApi {
  return {
    async getProfile() {
      const r = await g.users.getProfile({ userId: "me" });
      return { emailAddress: r.data.emailAddress ?? null, historyId: r.data.historyId ?? null };
    },
    async listMessages({ q, pageToken, maxResults }) {
      const r = await g.users.messages.list({ userId: "me", q, maxResults, includeSpamTrash: false, ...(pageToken ? { pageToken } : {}) });
      return { ids: (r.data.messages ?? []).map((m) => String(m.id)).filter(Boolean), nextPageToken: r.data.nextPageToken ?? null };
    },
    async listHistory({ startHistoryId, pageToken }) {
      const r = await g.users.history.list({
        userId: "me", startHistoryId, maxResults: 500,
        historyTypes: ["messageAdded", "labelAdded", "labelRemoved"],
        ...(pageToken ? { pageToken } : {}),
      });
      return { history: r.data.history ?? [], historyId: r.data.historyId ?? null, nextPageToken: r.data.nextPageToken ?? null };
    },
    async getMessage(id) {
      const r = await g.users.messages.get({ userId: "me", id, format: "full" });
      return r.data ?? null;
    },
    async getAttachment(messageId, attachmentId) {
      const r = await g.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId });
      const data = String(r.data.data ?? "");
      return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    },
    async listSendAs() {
      const r = await g.users.settings.sendAs.list({ userId: "me" });
      return (r.data.sendAs ?? []).map((s) => ({
        sendAsEmail: s.sendAsEmail ?? null, verificationStatus: s.verificationStatus ?? null,
        isPrimary: s.isPrimary ?? null, isDefault: s.isDefault ?? null, displayName: s.displayName ?? null,
      }));
    },
    async sendRaw(raw, threadId) {
      const r = await g.users.messages.send({ userId: "me", requestBody: { raw: b64url(raw), ...(threadId ? { threadId } : {}) } });
      return { id: String(r.data.id ?? ""), threadId: r.data.threadId ?? null };
    },
    async modifyLabels(id, add, remove) {
      await g.users.messages.modify({ userId: "me", id, requestBody: { addLabelIds: add, removeLabelIds: remove } });
    },
    async watch(topicName) {
      const r = await g.users.watch({ userId: "me", requestBody: { topicName, labelIds: ["INBOX", "SENT"], labelFilterBehavior: "include" } });
      return { historyId: r.data.historyId ?? null, expiration: r.data.expiration ? Number(r.data.expiration) : null };
    },
  };
}

/** Âmbitos da delegação (os mesmos do OAuth pessoal). */
export const GMAIL_SCOPES = GOOGLE_FEATURE_SCOPES.gmail;

/** API Gmail de uma conta de sincronização ("dwd:email" ou "user:<id>"). */
export async function gmailApiForAccount(accountKey: string): Promise<GmailApi> {
  const uid = userIdOfAccountKey(accountKey);
  if (uid != null) {
    const { userGoogleAuth } = await import("../google/userAccounts");
    const { client } = await userGoogleAuth(uid, "gmail");
    return wrapGmail(gmailFor(client));
  }
  const email = accountKey.replace(/^dwd:/, "");
  const client = delegatedClient(email, GMAIL_SCOPES);
  try {
    await client.authorize();
  } catch (err) {
    const msg = isAuthRevokedError(err)
      ? `A conta de serviço não tem delegação para ${email} (Admin Google → Segurança → Controlos de API → Delegação ao nível do domínio: autoriza o client ID com gmail.modify e gmail.send).`
      : googleErrorMessage(err);
    const e = new Error(msg);
    (e as any).authFailure = isAuthRevokedError(err);
    throw e;
  }
  return wrapGmail(gmailFor(client));
}
