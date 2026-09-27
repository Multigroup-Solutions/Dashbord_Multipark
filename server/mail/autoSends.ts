/**
 * Envios automáticos da aplicação ligados a um colaborador/extra
 * (`mail_auto_sends`, migração 0220): pedidos e lembretes de disponibilidade,
 * avisos de escala, lembretes de formação… Não aparecem na caixa partilhada
 * (a conversa só com envios nossos fica automática/escondida) — ficam na
 * ficha do extra ("Comunicações automáticas"), com o estado enviado/respondido
 * e a ligação à conversa na Comunicação.
 */
import { sql } from "drizzle-orm";
import { autoMailKindLabel, autoSendStatus } from "../../shared/mail";
import { getDb } from "../db";
import type { AutoSendRecord } from "./systemMail";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const nowUtc = () => new Date().toISOString().slice(0, 19).replace("T", " ");

export async function recordAutoSend(r: AutoSendRecord): Promise<void> {
  const d = await getDb();
  if (!d) return;
  await d.execute(sql`INSERT IGNORE INTO mail_auto_sends (accountKey, gmailMessageId, gmailThreadId, rfcMessageId, kind, employeeId, toEmail, subject, sentAt)
    VALUES (${r.accountKey}, ${r.gmailMessageId}, ${r.gmailThreadId}, ${r.rfcMessageId ? r.rfcMessageId.slice(0, 255) : null}, ${r.kind.slice(0, 40)},
      ${r.employeeId}, ${r.toEmail ? r.toEmail.slice(0, 320) : null}, ${r.subject ? r.subject.slice(0, 500) : null}, ${nowUtc()})`);
}

export interface EmployeeAutoSend {
  id: number;
  sentAt: string | null;
  kind: string;
  kindLabel: string;
  subject: string | null;
  toEmail: string | null;
  status: "enviado" | "respondido";
  /** Conversa na Comunicação (quando já sincronizada). */
  threadId: number | null;
  mailboxKey: string | null;
}

/** Últimos envios automáticos a um colaborador (mais recentes primeiro). */
export async function listAutoSendsForEmployee(employeeId: number, limit = 30): Promise<EmployeeAutoSend[]> {
  const d = await getDb();
  if (!d) return [];
  const n = Math.max(1, Math.min(100, Math.floor(limit)));
  let rows: any[] = [];
  try {
    rows = rowsOf(await d.execute(sql`SELECT s.id, DATE_FORMAT(s.sentAt, '%Y-%m-%d %H:%i:%s') AS sentAt, s.kind, s.subject, s.toEmail,
        t.id AS threadId, t.mailboxKey, t.automated AS threadAutomated, DATE_FORMAT(t.lastInboundAt, '%Y-%m-%d %H:%i:%s') AS lastInboundAt
      FROM mail_auto_sends s
      LEFT JOIN mail_threads t ON t.accountKey = s.accountKey AND t.gmailThreadId = s.gmailThreadId
      WHERE s.employeeId = ${employeeId}
      ORDER BY s.sentAt DESC, s.id DESC LIMIT ${n}`));
  } catch { return []; } // tabela ainda por criar
  return rows.map((r) => ({
    id: Number(r.id),
    sentAt: r.sentAt ?? null,
    kind: String(r.kind ?? ""),
    kindLabel: autoMailKindLabel(r.kind),
    subject: r.subject ?? null,
    toEmail: r.toEmail ?? null,
    status: autoSendStatus(r.threadId != null ? { threadAutomated: r.threadAutomated, lastInboundAt: r.lastInboundAt } : null),
    threadId: r.threadId != null ? Number(r.threadId) : null,
    mailboxKey: r.mailboxKey ?? null,
  }));
}
