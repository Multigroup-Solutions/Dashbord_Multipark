/**
 * Perdidos & Achados — "Possíveis correspondências" entre um perdido
 * (cliente reportou) e um achado (objeto encontrado sem dono conhecido).
 *
 *   1. pré-filtro determinístico em SQL + regras puras (shared/commsAi.ts):
 *      janela de ±30 dias, parque, matrícula/reserva, tipo → top 5;
 *   2. semelhança das descrições pela IA `lite` — UMA chamada por caso com
 *      todos os candidatos (sem ciclos de chamadas), descrições sem dados
 *      pessoais e cortadas; sem IA (interruptor/orçamento) ficam só as
 *      pontuações do pré-filtro.
 *
 * Confirmar uma correspondência só deixa nota interna nos dois casos:
 * contactar o cliente é SEMPRE uma pessoa.
 */
import { and, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import { lostFoundItems, lostFoundMatches } from "../drizzle/schema";
import { getDb, addLostFoundMessage } from "./db";
import { projectScope } from "./cityScope";
import {
  MATCH_WINDOW_DAYS,
  combinedMatchScore,
  lostFoundSide,
  rankMatchCandidates,
  type LostFoundLike,
} from "../shared/commsAi";
import { isStopAiError } from "./complaintTriage";

const rowsOf = (r: any): any[] => (Array.isArray(r?.[0]) ? r[0] : r) as any[];
const nowStr = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const toMs = (s: string | null | undefined) => (s ? Date.parse(String(s).replace(" ", "T") + (String(s).includes("Z") ? "" : "Z")) : Date.now());

type Item = LostFoundLike & { description?: string | null; foundLocation?: string | null };

const TYPE_PT: Record<string, string> = {
  money: "dinheiro", electronics: "eletrónica", clothing: "roupa", documents: "documentos", accessories: "acessórios", other: "objeto",
};

function itemText(i: Item): string {
  const where = i.foundLocation ? ` (encontrado: ${i.foundLocation})` : "";
  return `[${TYPE_PT[String(i.itemType ?? "other")] ?? "objeto"}] ${String(i.description ?? "").replace(/\s+/g, " ").trim()}${where}`;
}

/** Candidatos do lado oposto (SQL parametrizado, sem GROUP BY). */
async function loadCandidates(db: any, item: Item): Promise<Item[]> {
  const at = toMs(item.createdAt);
  const from = nowStr(at - MATCH_WINDOW_DAYS * 86_400_000);
  const to = nowStr(at + MATCH_WINDOW_DAYS * 86_400_000);
  const pid = item.projectId ?? null;
  return rowsOf(await db.execute(sql`
    SELECT id, clientName, status, convertedFromType, foundLocation, projectId, vehiclePlate, bookingRef, itemType, createdAt, description
      FROM lost_found_items
     WHERE id <> ${item.id}
       AND status NOT IN ('returned', 'closed', 'converted')
       AND createdAt BETWEEN ${from} AND ${to}
       AND (${pid} IS NULL OR projectId IS NULL OR projectId = ${pid})
     ORDER BY id DESC
     LIMIT 100`)).map((r) => ({ ...r, id: Number(r.id), projectId: r.projectId == null ? null : Number(r.projectId) }));
}

export interface MatchComputeResult { candidates: number; ai: boolean; error?: string }

/**
 * Calcula (ou recalcula) as correspondências de UM caso. `useAi:false` ou
 * IA indisponível → só o pré-filtro. Nunca lança por causa da IA.
 */
export async function computeMatchesFor(itemId: number, opts: { useAi?: boolean; userId?: number | null } = {}): Promise<MatchComputeResult> {
  const db = await getDb();
  if (!db) return { candidates: 0, ai: false, error: "db" };
  const [item] = await db.select().from(lostFoundItems).where(eq(lostFoundItems.id, itemId)).limit(1);
  if (!item) return { candidates: 0, ai: false, error: "not_found" };
  const side = lostFoundSide(item as any);
  if (!side) return { candidates: 0, ai: false };
  const ranked = rankMatchCandidates(item as Item, await loadCandidates(db, item as Item), side);

  // IA: uma chamada com todos os candidatos (só se houver algum).
  const aiScores = new Map<number, { score: number; reason: string }>();
  let usedAi = false;
  let error: string | undefined;
  if (ranked.length && opts.useAi !== false) {
    const { aiFeatureAvailableFresh } = await import("./_core/ai/status");
    if (await aiFeatureAvailableFresh("lost_found_match")) {
      const { runAi } = await import("./_core/ai/run");
      const { redactPii } = await import("./_core/ai/pii");
      const { aiErrorCode } = await import("./_core/ai/errors");
      const { LOST_MATCH_SYSTEM, lostMatchInput, lostMatchSchema } = await import("./_core/ai/prompts/comms");
      try {
        const r = await runAi({
          feature: "lost_found_match",
          system: LOST_MATCH_SYSTEM,
          input: lostMatchInput(
            { side, text: redactPii(itemText(item as Item)).text },
            ranked.map((c) => ({ id: c.item.id, text: redactPii(itemText(c.item)).text })),
          ),
          schema: lostMatchSchema,
          maxTokens: 400,
          timeoutMs: 15_000,
          userId: opts.userId ?? null,
          entity: "lost_found",
          entityId: itemId,
        });
        const allowed = new Set(ranked.map((c) => c.item.id));
        for (const m of r.output.matches ?? []) {
          const id = Number(m.id);
          if (!allowed.has(id)) continue; // a IA não inventa candidatos
          const s = Number(m.score);
          aiScores.set(id, { score: Math.round(Math.max(0, Math.min(100, s <= 1 && s > 0 ? s * 100 : s))), reason: String(m.reason ?? "").slice(0, 200) });
        }
        usedAi = true;
      } catch (err) {
        error = aiErrorCode(err);
        if (isStopAiError(err)) error += ":stop";
      }
    }
  }

  const keepIds: number[] = [];
  for (const c of ranked) {
    const lostId = side === "lost" ? itemId : c.item.id;
    const foundId = side === "lost" ? c.item.id : itemId;
    keepIds.push(c.item.id);
    const ai = aiScores.get(c.item.id);
    const reason = [ai?.reason, c.reasons.join(", ")].filter(Boolean).join(" · ").slice(0, 300) || null;
    await db.execute(sql`
      INSERT INTO lost_found_matches (lostId, foundId, prefilterScore, aiScore, reason, status, computedAt)
      VALUES (${lostId}, ${foundId}, ${c.score}, ${ai?.score ?? null}, ${reason}, 'suggested', UTC_TIMESTAMP())
      ON DUPLICATE KEY UPDATE prefilterScore = VALUES(prefilterScore),
        aiScore = COALESCE(VALUES(aiScore), aiScore), reason = VALUES(reason), computedAt = UTC_TIMESTAMP()`);
  }
  // Sugestões antigas que deixaram de ser candidatas saem (decididas ficam).
  const col = side === "lost" ? lostFoundMatches.lostId : lostFoundMatches.foundId;
  const other = side === "lost" ? lostFoundMatches.foundId : lostFoundMatches.lostId;
  await db.delete(lostFoundMatches).where(and(
    eq(col, itemId),
    eq(lostFoundMatches.status, "suggested"),
    keepIds.length ? notInArray(other, keepIds) : sql`1 = 1`,
  ));
  if (!error?.endsWith(":stop")) {
    await db.update(lostFoundItems).set({ aiMatchCheckedAt: nowStr() } as any).where(eq(lostFoundItems.id, itemId));
  }
  return { candidates: ranked.length, ai: usedAi, ...(error ? { error: error.replace(":stop", "") } : {}) };
}

/**
 * Varrimento limitado: perdidos abertos (cliente à espera) nunca verificados
 * ou verificados há mais de 1 dia. 1 chamada de IA por caso e só se o
 * pré-filtro encontrar candidatos.
 */
export async function runLostFoundMatchSweep(opts: { limit?: number; deadlineAt?: number } = {}): Promise<{ checked: number; skipped?: string }> {
  const out: { checked: number; skipped?: string } = { checked: 0 };
  const db = await getDb();
  if (!db) return out;
  const deadlineAt = opts.deadlineAt ?? Date.now() + 30_000;
  const ids = rowsOf(await db.execute(sql`
    SELECT id FROM lost_found_items
     WHERE status IN ('new', 'investigating')
       AND COALESCE(convertedFromType, '') <> 'incident'
       AND LOWER(TRIM(clientName)) NOT IN ('', 'desconhecido', 'desconhecida', 'n/a', '-')
       AND createdAt >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${MATCH_WINDOW_DAYS} DAY)
       AND (aiMatchCheckedAt IS NULL OR aiMatchCheckedAt < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY))
     ORDER BY (aiMatchCheckedAt IS NULL) DESC, id DESC
     LIMIT ${Math.max(1, Math.min(10, opts.limit ?? 3))}`)).map((r) => Number(r.id));
  for (const id of ids) {
    if (Date.now() + 17_000 > deadlineAt) { out.skipped = "deadline"; break; }
    const r = await computeMatchesFor(id);
    out.checked++;
    if (r.error === "disabled" || r.error === "budget" || r.error === "not_configured") { out.skipped = r.error; break; }
  }
  return out;
}

export interface MatchRow {
  id: number;
  otherId: number;
  otherSide: "lost" | "found";
  score: number;
  aiScore: number | null;
  prefilterScore: number;
  reason: string | null;
  status: string;
  other: { description: string; clientName: string | null; status: string; itemType: string; vehiclePlate: string | null; createdAt: string | null };
}

/** Correspondências de um caso (dos dois lados), com o outro caso no âmbito de cidade. */
export async function listMatchesFor(itemId: number): Promise<MatchRow[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(lostFoundMatches)
    .where(and(or(eq(lostFoundMatches.lostId, itemId), eq(lostFoundMatches.foundId, itemId)), sql`${lostFoundMatches.status} <> 'dismissed'`))
    .limit(20);
  if (!rows.length) return [];
  const otherIds = rows.map((r) => (r.lostId === itemId ? r.foundId : r.lostId));
  const others = await db.select({
    id: lostFoundItems.id, description: lostFoundItems.description, clientName: lostFoundItems.clientName, status: lostFoundItems.status,
    itemType: lostFoundItems.itemType, vehiclePlate: lostFoundItems.vehiclePlate, createdAt: lostFoundItems.createdAt,
  }).from(lostFoundItems).where(and(inArray(lostFoundItems.id, otherIds), projectScope(lostFoundItems.projectId)));
  const byId = new Map(others.map((o) => [o.id, o]));
  return rows
    .map((r): MatchRow | null => {
      const otherId = r.lostId === itemId ? r.foundId : r.lostId;
      const o = byId.get(otherId);
      if (!o) return null;
      return {
        id: r.id, otherId, otherSide: r.lostId === itemId ? "found" : "lost",
        score: combinedMatchScore(r.prefilterScore, r.aiScore), aiScore: r.aiScore ?? null, prefilterScore: r.prefilterScore,
        reason: r.reason ?? null, status: r.status,
        other: { description: String(o.description ?? "").slice(0, 300), clientName: o.clientName ?? null, status: o.status, itemType: o.itemType, vehiclePlate: o.vehiclePlate ?? null, createdAt: o.createdAt ?? null },
      };
    })
    .filter((x): x is MatchRow => !!x)
    .sort((a, b) => b.score - a.score);
}

/**
 * Confirmar / descartar. Confirmar só deixa nota interna nos dois casos — o
 * contacto com o cliente é feito por uma pessoa.
 */
export async function decideMatch(matchId: number, itemId: number, decision: "confirmed" | "dismissed", user: { id: number; name?: string | null }): Promise<{ ok: boolean; error?: string }> {
  const db = await getDb();
  if (!db) return { ok: false, error: "Base de dados indisponível." };
  const [m] = await db.select().from(lostFoundMatches).where(eq(lostFoundMatches.id, matchId)).limit(1);
  if (!m || (m.lostId !== itemId && m.foundId !== itemId)) return { ok: false, error: "Correspondência não encontrada." };
  await db.update(lostFoundMatches).set({ status: decision, decidedById: user.id, decidedAt: nowStr() }).where(eq(lostFoundMatches.id, matchId));
  if (decision === "confirmed") {
    const who = user.name || "Utilizador";
    const note = (other: number) => `🔗 Possível correspondência confirmada com o caso #${other} (${who}). Contactar o cliente antes de devolver.`;
    await addLostFoundMessage({ itemId: m.lostId, userId: user.id, userName: who, message: note(m.foundId), isInternal: 1 } as any);
    await addLostFoundMessage({ itemId: m.foundId, userId: user.id, userName: who, message: note(m.lostId), isInternal: 1 } as any);
  }
  return { ok: true };
}
