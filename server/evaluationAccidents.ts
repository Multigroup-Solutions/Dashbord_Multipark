/**
 * Acidentes da avaliação (P3 lote 22c, D15 — Jorge, 3 out 2026: "acidente dá
 * pontos negativos: −6000").
 *
 * As ocorrências vivem na app Multipark (só leitura). Um acidente só conta
 * quando um team leader (ou acima) o CONFIRMA na ocorrência e diz quem
 * conduzia — a sugestão é o agente das últimas ações nessa reserva antes da
 * ocorrência. A confirmação fica em `evaluation_accidents` (migração 0425) e
 * o motor conta-a no dia operacional da ocorrência (−6000, shared/evaluationRules).
 *
 *  - Nunca se apaga: "Desfazer" marca voidedAt (quem e porquê) e a linha fica.
 *  - Uma confirmação ativa por ocorrência (UNIQUE activeKey).
 *  - Ninguém confirma nem desfaz um acidente seu; o team leader só a equipa.
 *  - Depois de confirmar/desfazer, esse dia recalcula-se em segundo plano.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { getDb, getEmployeeByUserId, logActivity } from "./db";
import { employees, evaluationAccidents } from "../drizzle/schema";
import { operationalDayOf } from "../shared/lisbonDay";
import type { MultiparkOccurrence } from "./multiparkDb/read";
import type { EvaluationIdentity } from "./evaluationIdentity";

type Viewer = { id: number; role: string; name?: string | null };

// ─── Puros ──────────────────────────────────────────────────────────────────

export interface AccidentCandidate {
  /** null = agente sem ficha (não se pode confirmar contra ele). */
  employeeId: number | null;
  name: string;
  agentName: string | null;
  changeType: string | null;
  /** instante UTC "YYYY-MM-DD HH:MM:SS" da última ação dele antes da ocorrência */
  at: string | null;
}

/**
 * Quem conduzia: os agentes das últimas ações na reserva ATÉ à ocorrência, do
 * mais recente para o mais antigo, uma vez cada pessoa. PURA.
 */
export function accidentCandidates(
  rows: { agentUserId: string | null; agentName: string | null; changeType: string | null; actionTime: string | null }[],
  identity: Pick<EvaluationIdentity, "agent">,
  max = 5,
): AccidentCandidate[] {
  const sorted = [...rows].sort((a, b) => String(b.actionTime ?? "").localeCompare(String(a.actionTime ?? "")));
  const seen = new Set<string>();
  const out: AccidentCandidate[] = [];
  for (const r of sorted) {
    if (!r.agentUserId && !r.agentName) continue;
    const who = identity.agent(r.agentUserId, r.agentName);
    if (who.kind === "ignorado" || who.kind === "parceiro") continue;
    if (seen.has(who.key)) continue;
    seen.add(who.key);
    out.push({ employeeId: who.employeeId, name: who.name, agentName: r.agentName, changeType: r.changeType, at: r.actionTime });
    if (out.length >= max) break;
  }
  return out;
}

/** Dia operacional (03h–03h Lisboa) da ocorrência; sem data → null. PURA. */
export function accidentDayOf(occ: Pick<MultiparkOccurrence, "createdAt">): string | null {
  if (!occ.createdAt) return null;
  const ms = Date.parse(occ.createdAt);
  return Number.isFinite(ms) ? operationalDayOf(ms) : null;
}

// ─── Leitura ────────────────────────────────────────────────────────────────

export interface AccidentRecord {
  id: number;
  occurrenceId: string;
  employeeId: number;
  employeeName: string | null;
  day: string;
  note: string | null;
  confirmedByName: string | null;
  confirmedAt: string | null;
  voidedAt: string | null;
  voidedByName: string | null;
  voidReason: string | null;
}

/** Confirmações de uma ocorrência (a ativa primeiro, depois as desfeitas). */
export async function listAccidentRecords(occurrenceId: string): Promise<AccidentRecord[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ a: evaluationAccidents, employeeName: employees.fullName })
    .from(evaluationAccidents)
    .leftJoin(employees, eq(employees.id, evaluationAccidents.employeeId))
    .where(eq(evaluationAccidents.occurrenceId, occurrenceId))
    .orderBy(desc(evaluationAccidents.id))
    .limit(20);
  return rows
    .map(({ a, employeeName }) => ({
      id: a.id, occurrenceId: a.occurrenceId, employeeId: a.employeeId, employeeName: employeeName ?? null, day: a.day,
      note: a.note ?? null, confirmedByName: a.confirmedByName ?? null, confirmedAt: a.confirmedAt ?? null,
      voidedAt: a.voidedAt ?? null, voidedByName: a.voidedByName ?? null, voidReason: a.voidReason ?? null,
    }))
    .sort((x, y) => Number(!!x.voidedAt) - Number(!!y.voidedAt));
}

// ─── Guardas ────────────────────────────────────────────────────────────────

/** Quem confirma: vê a avaliação de outras pessoas (team leader e acima). */
export async function canConfirmAccidents(user: Viewer): Promise<boolean> {
  const { requireAccess } = await import("./_core/access");
  try { requireAccess(user, "avaliacao", "view"); return true; } catch { return false; }
}

async function assertCanJudge(user: Viewer, employeeId: number) {
  const { requireAccess } = await import("./_core/access");
  requireAccess(user, "avaliacao", "view");
  const me = await getEmployeeByUserId(user.id);
  if (me?.employee?.id === employeeId) throw new TRPCError({ code: "FORBIDDEN", message: "Não podes confirmar nem desfazer um acidente teu." });
  const { assertEmployeeAccess } = await import("./cityScope");
  await assertEmployeeAccess(employeeId);
  const { evaluationTeamIds } = await import("./evaluationRouter");
  const team = await evaluationTeamIds(user);
  if (team && !team.has(employeeId)) throw new TRPCError({ code: "FORBIDDEN", message: "Só confirmas acidentes da tua equipa." });
}

/** Recalcula esse dia depois de responder (no Vercel, waitUntil). Nunca falha o pedido. */
function recomputeDayLater(day: string) {
  const work = import("./evaluationEngine")
    .then((m) => m.recomputeRange(day, day))
    .catch((err: any) => { console.warn("[acidentes] recálculo do dia falhou:", String(err?.message ?? err).slice(0, 200)); });
  import("@vercel/functions").then(({ waitUntil }) => waitUntil(work)).catch(() => { /* fora do Vercel continua sozinha */ });
}

// ─── Escrita ────────────────────────────────────────────────────────────────

const isDupKey = (err: any) => err?.code === "ER_DUP_ENTRY" || err?.cause?.code === "ER_DUP_ENTRY" || /Duplicate entry/i.test(String(err?.message ?? ""));

/** Confirma o acidente da ocorrência (já lida dentro do âmbito de cidade) contra quem conduzia. */
export async function confirmAccident(user: Viewer, occ: MultiparkOccurrence, input: { employeeId: number; note?: string | null }): Promise<{ id: number; day: string }> {
  await assertCanJudge(user, input.employeeId);
  const day = accidentDayOf(occ);
  if (!day) throw new TRPCError({ code: "BAD_REQUEST", message: "A ocorrência não tem data: não dá para saber o dia da avaliação." });
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Base de dados indisponível." });
  let id: number;
  try {
    const res: any = await db.insert(evaluationAccidents).values({
      occurrenceId: occ.id, activeKey: occ.id, employeeId: input.employeeId, day,
      occurredAt: occ.createdAt ? occ.createdAt.slice(0, 19).replace("T", " ") : null,
      title: occ.title.slice(0, 200), bookingId: occ.bookingId, bookingCode: occ.bookingCode, plate: occ.plate?.slice(0, 32) ?? null,
      parkCity: occ.parkCity, note: input.note?.trim().slice(0, 500) || null,
      confirmedById: user.id, confirmedByName: user.name ?? null,
    });
    id = Number((Array.isArray(res) ? res[0] : res)?.insertId ?? 0);
  } catch (err) {
    if (isDupKey(err)) throw new TRPCError({ code: "CONFLICT", message: "Este acidente já foi confirmado por outra pessoa. Recarrega." });
    throw err;
  }
  await logActivity({ userId: user.id, action: "create", entity: "evaluation_accident", entityId: id, details: `Acidente confirmado: ocorrência ${occ.id} (${occ.title}) · colaborador ${input.employeeId} · dia ${day}` });
  recomputeDayLater(day);
  return { id, day };
}

/** Desfaz uma confirmação (fica no histórico, deixa de contar). */
export async function voidAccident(user: Viewer, input: { id: number; reason: string }): Promise<{ day: string }> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Base de dados indisponível." });
  const [row] = await db.select().from(evaluationAccidents).where(eq(evaluationAccidents.id, input.id)).limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Confirmação não encontrada." });
  await assertCanJudge(user, row.employeeId);
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const res: any = await db.update(evaluationAccidents)
    .set({ voidedAt: now, voidedById: user.id, voidedByName: user.name ?? null, voidReason: input.reason.trim().slice(0, 255), activeKey: null })
    .where(and(eq(evaluationAccidents.id, input.id), isNull(evaluationAccidents.voidedAt)));
  if (Number((Array.isArray(res) ? res[0] : res)?.affectedRows ?? 0) === 0) {
    throw new TRPCError({ code: "CONFLICT", message: "Esta confirmação já foi desfeita. Recarrega." });
  }
  await logActivity({ userId: user.id, action: "update", entity: "evaluation_accident", entityId: input.id, details: `Acidente desfeito (ocorrência ${row.occurrenceId}, dia ${row.day}): ${input.reason.trim().slice(0, 200)}` });
  recomputeDayLater(row.day);
  return { day: row.day };
}

/** Acidentes ativos de um conjunto de ocorrências (para a lista). */
export async function activeAccidentIds(occurrenceIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!occurrenceIds.length) return out;
  const db = await getDb();
  if (!db) return out;
  try {
    const rows = await db.select({ occurrenceId: evaluationAccidents.occurrenceId }).from(evaluationAccidents)
      .where(and(inArray(evaluationAccidents.occurrenceId, occurrenceIds.slice(0, 500)), isNull(evaluationAccidents.voidedAt)));
    for (const r of rows) out.add(r.occurrenceId);
  } catch { /* sem a tabela: nenhuma */ }
  return out;
}
