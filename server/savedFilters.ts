/**
 * Filtros guardados (padrão do Odoo: com nome, privados ou partilhados, um por
 * omissão) — UMA tabela para as páginas que os têm: `crm_saved_filters` com a
 * coluna `page` (migração 0665). "crm" = Clientes (o de sempre); "avaliacao" =
 * Avaliação → Mês (14 out 2026).
 *
 * Cada página valida o que guarda (o seu esquema) e limpa o que lê (o que
 * deixou de existir cai e conta-se). Um filtro é uma preferência da pessoa, não
 * um dado de negócio: apagar tira-o da lista e fica no registo (com o nome e se
 * era partilhado).
 */
import { sql } from "drizzle-orm";

export const SAVED_FILTER_PAGES = ["crm", "avaliacao"] as const;
export type SavedFilterPage = (typeof SAVED_FILTER_PAGES)[number];

interface PageSpec {
  /** valida antes de guardar (nunca se corta o JSON a meio) */
  parse(raw: unknown): { ok: true; data: unknown } | { ok: false };
  /** lê de volta: o que ainda vale + quantas partes caíram */
  sanitize(raw: unknown): { view: unknown; dropped: number };
  maxChars: number;
  tooBig: string;
  /** registo de "apagar" */
  logAction: string;
  logEntity: string;
}

async function specOf(page: SavedFilterPage): Promise<PageSpec> {
  if (page === "avaliacao") {
    const f = await import("../shared/evaluationFilters");
    return {
      parse: (raw) => { const p = f.evalSavedViewSchema.safeParse(raw ?? {}); return p.success ? { ok: true, data: p.data } : { ok: false }; },
      sanitize: (raw) => f.sanitizeEvalSavedView(raw),
      maxChars: f.EVAL_SAVED_VIEW_MAX_CHARS,
      tooBig: "O filtro é grande demais para guardar. Tira algumas pesquisas ou regras e tenta de novo.",
      logAction: "evaluation_filter_delete",
      logEntity: "evaluation_filter",
    };
  }
  const f = await import("../shared/crmFilters");
  return {
    parse: (raw) => { const p = f.savedViewSchema.safeParse(raw ?? {}); return p.success ? { ok: true, data: p.data } : { ok: false }; },
    sanitize: (raw) => f.sanitizeSavedView(raw),
    maxChars: f.SAVED_VIEW_MAX_CHARS,
    tooBig: "O filtro é grande demais para guardar. Tira alguns valores (parques, parceiros) e tenta de novo.",
    logAction: "crm_filter_delete",
    logEntity: "crm_filter",
  };
}

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const insertId = (res: any) => Number((Array.isArray(res) ? res[0] : res)?.insertId ?? 0);
function safeJson(s: unknown) { try { return JSON.parse(String(s ?? "{}")); } catch { return {}; } }

export interface SavedFilterRow<V = unknown> {
  id: number; name: string; shared: boolean; isDefault: boolean; mine: boolean; ownerName: string | null; payload: V; dropped: number;
}

/** Os meus + os partilhados desta página (os meus primeiro). */
export async function listSavedFiltersFor(db: any, userId: number, page: SavedFilterPage): Promise<SavedFilterRow[]> {
  const spec = await specOf(page);
  return rowsOf(await db.execute(sql`SELECT f.id, f.userId, f.name, f.payloadJson, f.shared, f.isDefault, u.name AS ownerName
    FROM crm_saved_filters f LEFT JOIN users u ON u.id = f.userId
    WHERE (f.userId = ${userId} OR f.shared = 1) AND f.page = ${page} ORDER BY f.userId = ${userId} DESC, f.name`)).map((f) => {
    // 21a: um filtro antigo com valores que deixaram de existir aplica o que ainda vale e diz quantos caíram
    const { view, dropped } = spec.sanitize(safeJson(f.payloadJson));
    return {
      id: Number(f.id), name: String(f.name), shared: Number(f.shared) === 1, isDefault: Number(f.isDefault) === 1 && Number(f.userId) === userId,
      mine: Number(f.userId) === userId, ownerName: f.ownerName ?? null, payload: view, dropped,
    };
  });
}

export async function saveFilterFor(db: any, userId: number, page: SavedFilterPage, o: { id?: number; name: string; payload: unknown; shared: boolean; isDefault: boolean }) {
  const spec = await specOf(page);
  // 21a: valida-se ao guardar; nunca se corta o JSON a meio (cortado ficava inválido e abria "sem filtro")
  const parsed = spec.parse(o.payload);
  if (!parsed.ok) throw new Error("O filtro tem valores inválidos e não foi guardado.");
  const payload = JSON.stringify(parsed.data);
  if (payload.length > spec.maxChars) throw new Error(spec.tooBig);
  // "Abrir com este": um por pessoa EM CADA página
  if (o.isDefault) await db.execute(sql`UPDATE crm_saved_filters SET isDefault = 0 WHERE userId = ${userId} AND page = ${page}`);
  if (o.id) {
    await db.execute(sql`UPDATE crm_saved_filters SET name = ${o.name.slice(0, 128)}, payloadJson = ${payload}, shared = ${o.shared ? 1 : 0}, isDefault = ${o.isDefault ? 1 : 0}
      WHERE id = ${o.id} AND userId = ${userId} AND page = ${page}`);
    return { id: o.id };
  }
  const res = await db.execute(sql`INSERT INTO crm_saved_filters (userId, name, payloadJson, shared, isDefault, page)
    VALUES (${userId}, ${o.name.slice(0, 128)}, ${payload}, ${o.shared ? 1 : 0}, ${o.isDefault ? 1 : 0}, ${page})`);
  return { id: insertId(res) };
}

export async function deleteFilterFor(db: any, userId: number, page: SavedFilterPage, id: number) {
  const spec = await specOf(page);
  // Preferência da pessoa (não é um dado de negócio): sai, mas fica no registo — com o nome
  // e se era partilhado, porque um partilhado desaparece também aos outros.
  const [f] = rowsOf(await db.execute(sql`SELECT name, shared FROM crm_saved_filters WHERE id = ${id} AND userId = ${userId} AND page = ${page}`));
  if (!f) throw new Error("Filtro não encontrado.");
  await db.execute(sql`DELETE FROM crm_saved_filters WHERE id = ${id} AND userId = ${userId} AND page = ${page}`);
  const { logActivity } = await import("./db");
  await logActivity({ userId, action: spec.logAction, entity: spec.logEntity, entityId: id, details: JSON.stringify({ name: String(f.name), shared: Number(f.shared) === 1 }) } as any);
}
