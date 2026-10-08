/**
 * Memória do Multis na BD (`assistant_memories`, migração 0605).
 *
 *  - Pessoais (scope 'user'): da própria pessoa; até 30 ativas.
 *  - Da empresa (scope 'company'): só admin/super_admin acrescentam/arquivam
 *    (verificado no router); toda a gente as lê. Até 100 ativas. Cada
 *    alteração fica em activity_logs.
 *  - Nada se apaga: arquivar marca `archivedAt`/`archivedById`; "Desfazer"/
 *    "Repor" tira a marca (se couber no limite).
 *
 * Regras puras (prefixo "Lembra-te", limites, bloco <memoria>) em
 * shared/assistantMemory.ts. Interruptor: AI_ASSISTANT_MEMORY.
 */
import { sql } from "drizzle-orm";
import { automationFlagDefault } from "../../shared/appSettings";
import {
  MEMORY_MAX_COMPANY, MEMORY_MAX_PERSONAL, cleanMemoryText, isDuplicateMemory, type MemoryScope,
} from "../../shared/assistantMemory";
import { mysqlNow } from "../_core/ai/chat/store";

export const MEMORY_FLAG = "AI_ASSISTANT_MEMORY" as const;

/** A memória está ligada? (interruptor AI_ASSISTANT_MEMORY; ligado por omissão). Nunca lança. */
export async function assistantMemoryEnabled(): Promise<boolean> {
  try {
    const { ensureFeatureFlagOverrides, isFeatureEnabled } = await import("../_core/featureFlags");
    await ensureFeatureFlagOverrides();
    return isFeatureEnabled(MEMORY_FLAG, { defaultEnabled: automationFlagDefault(MEMORY_FLAG) });
  } catch {
    return automationFlagDefault(MEMORY_FLAG);
  }
}

export interface MemoryItem {
  id: number;
  scope: MemoryScope;
  text: string;
  createdAt: string;
  createdById: number | null;
  createdByName: string | null;
  archivedAt: string | null;
  archivedByName: string | null;
}

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const insertIdOf = (res: unknown): number => Number(((Array.isArray(res) ? res[0] : res) as any)?.insertId ?? 0);
const affectedOf = (res: unknown): number => Number(((Array.isArray(res) ? res[0] : res) as any)?.affectedRows ?? 0);

async function db(): Promise<any | null> {
  try {
    const { getDb } = await import("../db");
    return await getDb();
  } catch {
    return null;
  }
}

const toItem = (r: any): MemoryItem => ({
  id: Number(r.id),
  scope: r.scope === "company" ? "company" : "user",
  text: String(r.text ?? ""),
  createdAt: String(r.createdAt ?? ""),
  createdById: r.createdById != null ? Number(r.createdById) : null,
  createdByName: r.createdByName != null ? String(r.createdByName) : null,
  archivedAt: r.archivedAt != null ? String(r.archivedAt) : null,
  archivedByName: r.archivedByName != null ? String(r.archivedByName) : null,
});

const COLS = sql`m.id, m.scope, m.text, m.createdById, u.name AS createdByName,
  DATE_FORMAT(m.createdAt, '%Y-%m-%dT%H:%i:%sZ') AS createdAt,
  DATE_FORMAT(m.archivedAt, '%Y-%m-%dT%H:%i:%sZ') AS archivedAt, a.name AS archivedByName`;
const FROM = sql`FROM assistant_memories m LEFT JOIN users u ON u.id = m.createdById LEFT JOIN users a ON a.id = m.archivedById`;

/**
 * As notas para o ecrã "Memória": as minhas (ativas + últimas 30 arquivadas)
 * e as da empresa (ativas; as arquivadas só para quem as gere). Lança se a
 * BD falhar (o ecrã mostra o erro — não é o mesmo que "sem notas").
 */
export async function listMemories(userId: number, opts: { withCompanyArchived?: boolean } = {}): Promise<{
  mine: MemoryItem[]; mineArchived: MemoryItem[]; company: MemoryItem[]; companyArchived: MemoryItem[];
}> {
  const d = await db();
  if (!d) throw new Error("Base de dados indisponível.");
  const mine = rowsOf(await d.execute(sql`SELECT ${COLS} ${FROM}
    WHERE m.scope = 'user' AND m.userId = ${userId} AND m.archivedAt IS NULL ORDER BY m.id DESC LIMIT ${MEMORY_MAX_PERSONAL * 2}`)).map(toItem);
  const mineArchived = rowsOf(await d.execute(sql`SELECT ${COLS} ${FROM}
    WHERE m.scope = 'user' AND m.userId = ${userId} AND m.archivedAt IS NOT NULL ORDER BY m.archivedAt DESC, m.id DESC LIMIT 30`)).map(toItem);
  const company = rowsOf(await d.execute(sql`SELECT ${COLS} ${FROM}
    WHERE m.scope = 'company' AND m.archivedAt IS NULL ORDER BY m.id DESC LIMIT ${MEMORY_MAX_COMPANY * 2}`)).map(toItem);
  const companyArchived = opts.withCompanyArchived
    ? rowsOf(await d.execute(sql`SELECT ${COLS} ${FROM}
      WHERE m.scope = 'company' AND m.archivedAt IS NOT NULL ORDER BY m.archivedAt DESC, m.id DESC LIMIT 30`)).map(toItem)
    : [];
  return { mine, mineArchived, company, companyArchived };
}

/** Notas ativas para o turno (mais recentes primeiro). Nunca lança: sem BD/erro → nenhuma. */
export async function activeNotesForTurn(userId: number): Promise<{ personal: { text: string }[]; company: { text: string }[] }> {
  const none = { personal: [], company: [] };
  try {
    const d = await db();
    if (!d) return none;
    const rows = rowsOf(await d.execute(sql`SELECT scope, text FROM assistant_memories
      WHERE archivedAt IS NULL AND (scope = 'company' OR (scope = 'user' AND userId = ${userId}))
      ORDER BY id DESC LIMIT ${MEMORY_MAX_PERSONAL + MEMORY_MAX_COMPANY}`));
    return {
      personal: rows.filter((r) => r.scope === "user").slice(0, MEMORY_MAX_PERSONAL).map((r) => ({ text: String(r.text ?? "") })),
      company: rows.filter((r) => r.scope === "company").slice(0, MEMORY_MAX_COMPANY).map((r) => ({ text: String(r.text ?? "") })),
    };
  } catch {
    return none;
  }
}

export type AddMemoryResult =
  | { ok: true; id: number; text: string }
  | { ok: false; reason: "invalid" | "full" | "exists" | "unavailable"; text?: string };

async function activeOf(d: any, scope: MemoryScope, userId: number): Promise<{ text: string }[]> {
  const where = scope === "company" ? sql`scope = 'company'` : sql`scope = 'user' AND userId = ${userId}`;
  return rowsOf(await d.execute(sql`SELECT text FROM assistant_memories WHERE ${where} AND archivedAt IS NULL LIMIT ${MEMORY_MAX_COMPANY * 2}`))
    .map((r) => ({ text: String(r.text ?? "") }));
}

/**
 * Acrescenta uma nota. Pessoal: dono = `byUserId`. Da empresa: o router já
 * verificou que é admin/super_admin; fica em activity_logs.
 */
export async function addMemory(scope: MemoryScope, byUserId: number, rawText: string, opts: { now?: number } = {}): Promise<AddMemoryResult> {
  const text = cleanMemoryText(rawText);
  if (!text) return { ok: false, reason: "invalid" };
  const d = await db();
  if (!d) return { ok: false, reason: "unavailable" };
  const active = await activeOf(d, scope, byUserId);
  if (isDuplicateMemory(text, active)) return { ok: false, reason: "exists", text };
  if (active.length >= (scope === "company" ? MEMORY_MAX_COMPANY : MEMORY_MAX_PERSONAL)) return { ok: false, reason: "full" };
  const res = await d.execute(sql`INSERT INTO assistant_memories (scope, userId, text, createdById, createdAt)
    VALUES (${scope}, ${scope === "company" ? null : byUserId}, ${text}, ${byUserId}, ${mysqlNow(new Date(opts.now ?? Date.now()))})`);
  const id = insertIdOf(res);
  if (scope === "company") await logCompany(byUserId, "assistant_memory_company_add", id, text);
  return { ok: true, id, text };
}

/** A nota (para verificar dono/âmbito antes de mexer). */
export async function getMemory(id: number): Promise<{ id: number; scope: MemoryScope; userId: number | null; text: string; archived: boolean } | null> {
  const d = await db();
  if (!d) return null;
  const r = rowsOf(await d.execute(sql`SELECT id, scope, userId, text, archivedAt FROM assistant_memories WHERE id = ${id} LIMIT 1`))[0];
  if (!r) return null;
  return { id: Number(r.id), scope: r.scope === "company" ? "company" : "user", userId: r.userId != null ? Number(r.userId) : null, text: String(r.text ?? ""), archived: r.archivedAt != null };
}

/**
 * Arquiva (UPDATE, nunca DELETE). Pessoal: só a do próprio (`ownerId`).
 * Devolve false se não havia nada para arquivar.
 */
export async function archiveMemory(id: number, byUserId: number, scope: MemoryScope, opts: { ownerId?: number; now?: number } = {}): Promise<boolean> {
  const d = await db();
  if (!d) return false;
  const owner = scope === "company" ? sql`scope = 'company'` : sql`scope = 'user' AND userId = ${opts.ownerId ?? byUserId}`;
  const res = await d.execute(sql`UPDATE assistant_memories SET archivedAt = ${mysqlNow(new Date(opts.now ?? Date.now()))}, archivedById = ${byUserId}
    WHERE id = ${id} AND ${owner} AND archivedAt IS NULL`);
  const ok = affectedOf(res) > 0;
  if (ok && scope === "company") await logCompany(byUserId, "assistant_memory_company_archive", id, null);
  return ok;
}

/** "Desfazer"/"Repor": volta a ativa (se couber no limite). */
export async function restoreMemory(id: number, byUserId: number, scope: MemoryScope, opts: { ownerId?: number } = {}): Promise<"ok" | "full" | "missing"> {
  const d = await db();
  if (!d) return "missing";
  const ownerId = opts.ownerId ?? byUserId;
  const active = await activeOf(d, scope, ownerId);
  if (active.length >= (scope === "company" ? MEMORY_MAX_COMPANY : MEMORY_MAX_PERSONAL)) return "full";
  const owner = scope === "company" ? sql`scope = 'company'` : sql`scope = 'user' AND userId = ${ownerId}`;
  const res = await d.execute(sql`UPDATE assistant_memories SET archivedAt = NULL, archivedById = NULL
    WHERE id = ${id} AND ${owner} AND archivedAt IS NOT NULL`);
  const ok = affectedOf(res) > 0;
  if (ok && scope === "company") await logCompany(byUserId, "assistant_memory_company_restore", id, null);
  return ok ? "ok" : "missing";
}

async function logCompany(userId: number, action: string, id: number, text: string | null): Promise<void> {
  try {
    const { logActivity } = await import("../db");
    await logActivity({
      userId,
      action,
      entity: "assistant_memory",
      entityId: id > 0 ? id : null,
      details: text ? JSON.stringify({ text }).slice(0, 1000) : null,
    });
  } catch { /* o registo nunca parte a memória */ }
}
