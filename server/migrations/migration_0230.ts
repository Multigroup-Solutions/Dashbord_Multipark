// Migration 0230 — Caixa sem os envios automáticos da aplicação (set 2026).
//
// Problema (dono, 27 set 2026): na Comunicação → "Reservas (geral)" apareciam
// ~300 conversas "Disponibilidade — semana de …" abertas e sem responsável —
// os pedidos/lembretes de disponibilidade que a PRÓPRIA aplicação manda aos
// extras (saem por recursos-humanos@ e, por saírem por um alias, não levavam
// o cabeçalho X-Multipark-System).
//
//  - mail_auto_sends: cada envio automático ligado a um colaborador/extra
//    (conta, ids do Gmail, tipo, destinatário, assunto). A ficha do extra
//    mostra-os em "Comunicações automáticas" com o estado (enviado/respondido).
//  - Passo de DADOS `runMigration0230Data` (uma vez, marca em
//    app_notification_maintenance): as mensagens ENVIADAS já sincronizadas de
//    recursos-humanos@ / reservas@ / remetente de sistema com assunto de uma
//    automação (shared/mail.ts automaticOutboundKind) passam a automáticas
//    (3); as conversas que só têm mensagens automáticas ficam escondidas
//    (mail_threads.automated = 1). Conversas em que a pessoa respondeu ficam
//    visíveis (a resposta é humana). Os envios encontrados entram também em
//    mail_auto_sends (colaborador pelo email do destinatário).
//
// Barato: lê só (id, threadId, …) pelo índice de fromEmail, em lotes por id;
// atualiza em lotes de 200. Idempotente: só toca em `automated = 0`,
// INSERT IGNORE nos envios; a marca só é gravada no fim (se falhar a meio,
// volta a correr no próximo arranque sem estragar nada).

import { sql } from "drizzle-orm";
import { AUTO_MAIL_SENDERS, automaticOutboundKind, extractAddresses, normalizeAddress, MAIL_AUTOMATED_RESERVATION, MAIL_AUTOMATED_SYSTEM } from "../../shared/mail";

export const MIGRATION_0230_NAME = "0230_mail_auto_sends";
export const DATA_0230_ID = "0230_mail_auto_outbound_backfill";

export const MIGRATION_0230_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `mail_auto_sends` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`accountKey` VARCHAR(360) NOT NULL, " +
    "`gmailMessageId` VARCHAR(32) NOT NULL, " +
    "`gmailThreadId` VARCHAR(32) NULL, " +
    "`rfcMessageId` VARCHAR(255) NULL, " +
    "`kind` VARCHAR(40) NOT NULL, " +
    "`employeeId` INT NULL, " +
    "`toEmail` VARCHAR(320) NULL, " +
    "`subject` VARCHAR(500) NULL, " +
    "`sentAt` DATETIME NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_mail_auto_sends_msg` (`accountKey`, `gmailMessageId`), " +
    "KEY `idx_mail_auto_sends_employee` (`employeeId`, `sentAt`), " +
    "KEY `idx_mail_auto_sends_thread` (`accountKey`, `gmailThreadId`)" +
    ") ENGINE=InnoDB",
  // Nasceu na 0140; aqui só por segurança (o passo de dados precisa dela).
  "CREATE TABLE IF NOT EXISTS `app_notification_maintenance` (" +
    "`id` VARCHAR(64) NOT NULL, " +
    "`ranAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
];

export const IDEMPOTENT_ERROR_CODES_0230 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME", "ER_DUP_ENTRY"]);

/** Prefixos de assunto das automações (pré-filtro SQL; o filtro exato é automaticOutboundKind). */
export const AUTO_SUBJECT_LIKE_0230: readonly string[] = [
  "Disponibilidade%semana de %",
  "Estás disponível %",
  "Que horas podes fazer %",
  "Preciso de um condutor %",
  "[TESTE] %",
  "Escala Multipark%",
  "Formação por concluir%",
  "[Dashboard Multipark] %",
];

export type Candidate0230 = { id: number; threadId: number; direction: string; fromEmail: string | null; subject: string | null };

/**
 * Das mensagens candidatas, as que são envios automáticos nossos (só
 * enviadas, remetente das automações, assunto conhecido). PURA.
 */
export function pickAutoOutbound0230(rows: readonly Candidate0230[], senders: readonly string[]): Array<Candidate0230 & { kind: string }> {
  const out: Array<Candidate0230 & { kind: string }> = [];
  for (const r of rows) {
    const kind = automaticOutboundKind({ outbound: r.direction === "out", fromEmail: r.fromEmail, subject: r.subject }, senders);
    if (kind) out.push({ ...r, kind });
  }
  return out;
}

type Executor = { execute: (q: any) => Promise<unknown> };

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const inList = (xs: readonly (string | number)[]) => sql.join(xs.map((x) => sql`${x}`), sql`, `);

const READ_BATCH = 1000;
const WRITE_BATCH = 200;

/**
 * Aplica a limpeza uma única vez (ver o topo). "applied" = correu agora;
 * "skipped" = já tinha corrido. Lança em erro (volta a tentar no próximo
 * arranque — os passos são idempotentes).
 */
export async function runMigration0230Data(db: Executor, opts: { systemSender?: string | null } = {}): Promise<{ status: "applied" | "skipped"; messages: number; threads: number; sends: number }> {
  const done = rowsOf(await db.execute(sql`SELECT id FROM app_notification_maintenance WHERE id = ${DATA_0230_ID} LIMIT 1`));
  if (done.length) return { status: "skipped", messages: 0, threads: 0, sends: 0 };

  let systemSender = opts.systemSender ?? null;
  if (systemSender == null) {
    // Definições → Comunicação (app_settings, valor JSON) — lido aqui, sem getSetting (ver server/db.ts).
    try {
      const v = rowsOf(await db.execute(sql`SELECT \`value\` FROM app_settings WHERE settingKey = 'mail.systemSender' LIMIT 1`))[0]?.value;
      const parsed = typeof v === "string" ? (() => { try { return JSON.parse(v); } catch { return v; } })() : v;
      systemSender = typeof parsed === "string" ? parsed : null;
    } catch { systemSender = null; }
  }
  const senders = Array.from(new Set([...AUTO_MAIL_SENDERS, normalizeAddress(systemSender)].filter(Boolean)));
  const subjectCond = sql.join(AUTO_SUBJECT_LIKE_0230.map((p) => sql`subject LIKE ${p}`), sql` OR `);
  let lastId = 0;
  let messages = 0, sends = 0;
  const threadIds = new Set<number>();
  for (;;) {
    const raw = rowsOf(await db.execute(sql`SELECT id, threadId, direction, fromEmail, subject, accountKey, gmailMessageId, gmailThreadId, rfcMessageId, toJson, sentAt
      FROM mail_messages
      WHERE fromEmail IN (${inList(senders)}) AND direction = 'out' AND automated = 0 AND id > ${lastId} AND (${subjectCond})
      ORDER BY id LIMIT ${READ_BATCH}`));
    if (!raw.length) break;
    lastId = Number(raw[raw.length - 1].id);
    const rows: Candidate0230[] = raw.map((r) => ({ id: Number(r.id), threadId: Number(r.threadId), direction: String(r.direction), fromEmail: r.fromEmail ?? null, subject: r.subject ?? null }));
    const hits = pickAutoOutbound0230(rows, senders);
    const byId = new Map(raw.map((r) => [Number(r.id), r]));
    for (let i = 0; i < hits.length; i += WRITE_BATCH) {
      const chunk = hits.slice(i, i + WRITE_BATCH);
      await db.execute(sql`UPDATE mail_messages SET automated = ${MAIL_AUTOMATED_SYSTEM} WHERE automated = 0 AND id IN (${inList(chunk.map((h) => h.id))})`);
      messages += chunk.length;
      for (const h of chunk) threadIds.add(h.threadId);
      // Envios → mail_auto_sends (colaborador pelo email do destinatário).
      const toOf = new Map<number, string | null>();
      for (const h of chunk) {
        let to: string[] = [];
        try { to = extractAddresses((JSON.parse(String(byId.get(h.id)?.toJson ?? "[]")) as string[]).join(", ")); } catch { to = []; }
        toOf.set(h.id, to[0] ?? null);
      }
      const emails = Array.from(new Set(Array.from(toOf.values()).filter((x): x is string => !!x)));
      const empByEmail = new Map<string, number>();
      if (emails.length) {
        try {
          const emps = rowsOf(await db.execute(sql`SELECT id, LOWER(TRIM(email)) AS email FROM employees WHERE LOWER(TRIM(email)) IN (${inList(emails)}) ORDER BY id`));
          for (const e of emps) if (!empByEmail.has(String(e.email))) empByEmail.set(String(e.email), Number(e.id));
        } catch { /* sem employees: envios sem colaborador */ }
      }
      for (const h of chunk) {
        const r = byId.get(h.id);
        const to = toOf.get(h.id) ?? null;
        const employeeId = to ? empByEmail.get(to) ?? null : null;
        if (employeeId == null) continue;
        await db.execute(sql`INSERT IGNORE INTO mail_auto_sends (accountKey, gmailMessageId, gmailThreadId, rfcMessageId, kind, employeeId, toEmail, subject, sentAt)
          VALUES (${String(r.accountKey)}, ${String(r.gmailMessageId)}, ${r.gmailThreadId ?? null}, ${r.rfcMessageId ?? null}, ${h.kind}, ${employeeId}, ${to},
            ${h.subject ? String(h.subject).slice(0, 500) : null}, ${r.sentAt ?? null})`);
        sends++;
      }
    }
    if (raw.length < READ_BATCH) break;
  }

  // Conversas: automática = todas as mensagens automáticas (2/3).
  const ids = Array.from(threadIds);
  for (let i = 0; i < ids.length; i += WRITE_BATCH) {
    const chunk = ids.slice(i, i + WRITE_BATCH);
    await db.execute(sql`UPDATE mail_threads t SET t.automated = CASE WHEN EXISTS (
        SELECT 1 FROM mail_messages m WHERE m.threadId = t.id AND m.automated NOT IN (${MAIL_AUTOMATED_RESERVATION}, ${MAIL_AUTOMATED_SYSTEM})
      ) THEN 0 ELSE 1 END
      WHERE t.id IN (${inList(chunk)})`);
  }

  try {
    await db.execute(sql`INSERT INTO app_notification_maintenance (id) VALUES (${DATA_0230_ID})`);
  } catch (err: any) {
    const code = err?.code ?? err?.cause?.code;
    if (code !== "ER_DUP_ENTRY") throw err;
  }
  return { status: "applied", messages, threads: ids.length, sends };
}
