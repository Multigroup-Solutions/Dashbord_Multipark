/**
 * Triagem das reclamações que chegam por email (reclamacoes@) — IA `lite`.
 *
 * Sugere tipo, prioridade, SLA, reserva, duplicado e um rascunho de resposta
 * em PT-PT (cita a reserva, nunca promete compensações). As sugestões ficam
 * SEPARADAS dos campos humanos (`ai_suggestions`, com confiança e motivo); só
 * se aplicam sozinhas com confiança ≥ 0,85 e campo vazio (shared/commsAi.ts),
 * guardando o valor anterior para "Desfazer". O rascunho nunca é enviado: vai
 * para a caixa "Enviar email" e uma pessoa carrega em Enviar.
 *
 * Custo: texto sem dados pessoais (redactPii), primeiro nome, entrada cortada
 * (COMPLAINT_INPUT_MAX), 1 chamada por reclamação, no máximo N por corrida.
 * Interruptor desligado / orçamento esgotado → não chama e não dá erro.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { aiSuggestions, complaints } from "../drizzle/schema";
import { getDb, addComplaintMessage } from "./db";
import {
  SLA_HOURS_BY_PRIORITY,
  MIN_SHOW_CONFIDENCE,
  clampConfidence,
  finalizeComplaintDraft,
  mapComplaintPriority,
  mapComplaintType,
  pickDuplicate,
  shouldAutoApply,
  DUPLICATE_WINDOW_DAYS,
  COMPLAINT_TYPE_LABEL_PT,
  COMPLAINT_PRIORITY_LABEL_PT,
  type ComplaintPriority,
  type ComplaintType,
  type SuggestionField,
  type SuggestionStatus,
} from "../shared/commsAi";

const ENTITY = "complaint";
const rowsOf = (r: any): any[] => (Array.isArray(r?.[0]) ? r[0] : r) as any[];
const nowStr = (d = new Date()) => d.toISOString().slice(0, 19).replace("T", " ");

/** Erros que param um varrimento inteiro (não vale a pena tentar o próximo). */
export function isStopAiError(err: unknown): boolean {
  const code = (err as any)?.code;
  return code === "disabled" || code === "not_configured" || code === "budget";
}

export interface SuggestionRow {
  field: SuggestionField;
  value: string | null;
  confidence: number | null;
  reason: string | null;
  status: SuggestionStatus;
  previousValue: string | null;
  decidedAt: string | null;
}

interface Proposed {
  field: SuggestionField;
  value: string;
  confidence: number;
  reason: string;
}

function slaFrom(createdAt: string | null | undefined, hours: number): string {
  const base = createdAt ? Date.parse(String(createdAt).replace(" ", "T") + "Z") : Date.now();
  return nowStr(new Date((Number.isFinite(base) ? base : Date.now()) + hours * 3_600_000));
}

/** Patch da reclamação para aplicar uma sugestão (e o valor anterior). */
function applyPatch(c: any, field: SuggestionField, value: string, extra?: { projectId?: number | null }): { patch: Record<string, unknown>; previous: string | null } | null {
  switch (field) {
    case "type": return { patch: { complaintType: value }, previous: c.complaintType ?? null };
    case "priority": return { patch: { complaintPriority: value }, previous: c.complaintPriority ?? null };
    case "sla": return { patch: { slaDeadline: slaFrom(c.createdAt, Number(value)) }, previous: c.slaDeadline ?? null };
    case "booking": {
      const patch: Record<string, unknown> = { reservationRef: value.slice(0, 100) };
      if (c.projectId == null && extra?.projectId) patch.projectId = extra.projectId;
      return { patch, previous: c.reservationRef ?? null };
    }
    default: return null;
  }
}

/** Reverte uma sugestão aplicada (valor anterior). */
function revertPatch(field: SuggestionField, previous: string | null): Record<string, unknown> | null {
  switch (field) {
    case "type": return { complaintType: previous || "other" };
    case "priority": return { complaintPriority: previous || "medium" };
    case "sla": return { slaDeadline: previous };
    case "booking": return { reservationRef: previous };
    default: return null;
  }
}

async function findDuplicate(db: any, c: any) {
  const { plateKey } = await import("./clientsCrm");
  const { isInternalEmail } = await import("./complaintEmail");
  const email = c.clientEmail && !isInternalEmail(c.clientEmail) ? String(c.clientEmail).trim().toLowerCase() : "";
  const ref = String(c.reservationRef ?? "").trim();
  const plate = plateKey(c.vehiclePlate);
  const conds = [
    email ? sql`LOWER(TRIM(clientEmail)) = ${email}` : null,
    ref ? sql`reservationRef = ${ref}` : null,
    plate.length >= 4 ? sql`UPPER(REPLACE(REPLACE(TRIM(vehiclePlate), ' ', ''), '-', '')) = ${plate}` : null,
  ].filter(Boolean) as ReturnType<typeof sql>[];
  if (!conds.length) return null;
  const rows = rowsOf(await db.execute(sql`
    SELECT id, clientEmail, reservationRef, vehiclePlate, complaint_status AS complaintStatus, createdAt
      FROM complaints
     WHERE id <> ${c.id}
       AND complaint_status IN ('new', 'analyzing', 'waiting_client')
       AND createdAt >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${DUPLICATE_WINDOW_DAYS} DAY)
       AND (${sql.join(conds, sql` OR `)})
     ORDER BY id ASC
     LIMIT 20`));
  return pickDuplicate({ ...c, clientEmail: email }, rows.map((r) => ({ ...r, id: Number(r.id) })));
}

async function upsertSuggestion(db: any, entityId: number, p: Proposed, status: SuggestionStatus, previousValue: string | null) {
  const conf = p.confidence.toFixed(3);
  await db.execute(sql`
    INSERT INTO ai_suggestions (entityType, entityId, field, value, confidence, reason, status, previousValue)
    VALUES (${ENTITY}, ${entityId}, ${p.field}, ${p.value}, ${conf}, ${p.reason.slice(0, 500)}, ${status}, ${previousValue})
    ON DUPLICATE KEY UPDATE
      value = IF(status IN ('accepted', 'rejected', 'applied'), value, VALUES(value)),
      confidence = IF(status IN ('accepted', 'rejected', 'applied'), confidence, VALUES(confidence)),
      reason = IF(status IN ('accepted', 'rejected', 'applied'), reason, VALUES(reason)),
      previousValue = IF(status IN ('accepted', 'rejected', 'applied'), previousValue, VALUES(previousValue)),
      status = IF(status IN ('accepted', 'rejected', 'applied'), status, VALUES(status))`);
}

export interface TriageResult {
  ok: boolean;
  skipped?: "disabled" | "not_found" | "already";
  error?: string;
  applied: SuggestionField[];
  suggested: SuggestionField[];
}

/**
 * Triagem de UMA reclamação. Nunca lança (o email já foi gravado); erros de
 * IA → `{ ok:false, error }` com código curto. `force` repete mesmo que já
 * tenha sido feita (botão "Voltar a analisar").
 */
export async function triageComplaint(complaintId: number, opts: { userId?: number | null; force?: boolean; timeoutMs?: number } = {}): Promise<TriageResult> {
  const out: TriageResult = { ok: false, applied: [], suggested: [] };
  const { aiFeatureAvailableFresh } = await import("./_core/ai/status");
  if (!(await aiFeatureAvailableFresh("complaint_triage"))) return { ...out, skipped: "disabled" };
  const db = await getDb();
  if (!db) return { ...out, error: "db" };
  const [c] = await db.select().from(complaints).where(eq(complaints.id, complaintId)).limit(1);
  if (!c) return { ...out, skipped: "not_found" };
  if (c.aiTriagedAt && !opts.force) return { ...out, skipped: "already" };

  const { runAi } = await import("./_core/ai/run");
  const { redactPii, firstName } = await import("./_core/ai/pii");
  const { aiErrorCode } = await import("./_core/ai/errors");
  const { COMPLAINT_TRIAGE_SYSTEM, complaintTriageInput, complaintTriageSchema, COMPLAINT_INPUT_MAX } = await import("./_core/ai/prompts/comms");

  const body = String(c.description ?? "").replace(/\s+\n/g, "\n").slice(0, COMPLAINT_INPUT_MAX);
  const red = redactPii(body);
  const subj = redactPii(String(c.title ?? ""));
  let ai;
  try {
    ai = await runAi({
      feature: "complaint_triage",
      system: COMPLAINT_TRIAGE_SYSTEM,
      input: complaintTriageInput({ firstName: firstName(c.clientName), subject: subj.text, body: red.text, knownBooking: !!c.reservationRef }),
      schema: complaintTriageSchema,
      maxTokens: 700,
      timeoutMs: opts.timeoutMs ?? 20_000,
      userId: opts.userId ?? null,
      entity: "complaint",
      entityId: complaintId,
    });
  } catch (err) {
    // Desligada/orçamento/sem fornecedor: não marca (tenta noutra altura).
    if (!isStopAiError(err)) await db.update(complaints).set({ aiTriagedAt: nowStr() } as any).where(eq(complaints.id, complaintId));
    return { ...out, error: aiErrorCode(err) };
  }
  const o = ai.output;
  const type: ComplaintType = mapComplaintType(o.type);
  const priority: ComplaintPriority = mapComplaintPriority(o.priority);
  const reason = String(o.reason ?? "").slice(0, 200);
  const proposals: (Proposed & { projectId?: number | null })[] = [];
  const typeConf = clampConfidence(o.typeConfidence);
  const prioConf = clampConfidence(o.priorityConfidence);
  if (typeConf >= MIN_SHOW_CONFIDENCE) proposals.push({ field: "type", value: type, confidence: typeConf, reason: reason || COMPLAINT_TYPE_LABEL_PT[type] });
  if (prioConf >= MIN_SHOW_CONFIDENCE) {
    proposals.push({ field: "priority", value: priority, confidence: prioConf, reason: reason || COMPLAINT_PRIORITY_LABEL_PT[priority] });
    proposals.push({ field: "sla", value: String(SLA_HOURS_BY_PRIORITY[priority]), confidence: prioConf, reason: `Prioridade ${COMPLAINT_PRIORITY_LABEL_PT[priority].toLowerCase()} → ${SLA_HOURS_BY_PRIORITY[priority]} h` });
  }

  // Reserva: referência/matrícula que a IA encontrou no texto (marcadores
  // repostos cá dentro) → helper da casa (ref exata ganha; senão matrícula na data).
  let bookingRef: string | null = c.reservationRef ?? null;
  if (!bookingRef) {
    const aiRef = red.restore(String(o.bookingRef ?? "")).replace(/[^\w/-]/g, "").trim();
    const aiPlate = red.restore(String(o.plate ?? "")).trim();
    const plate = c.vehiclePlate || (/\d/.test(aiPlate) && /[a-z]/i.test(aiPlate) ? aiPlate : "");
    if (aiRef.length >= 4 || plate) {
      try {
        const { deriveBookingForCase } = await import("./caseOps");
        const b = await deriveBookingForCase({ bookingRef: aiRef.length >= 4 ? aiRef : null, plate: plate || null, atUtc: c.createdAt ?? null });
        if (b?.externalId) {
          const byRef = aiRef.length >= 4 && (aiRef === b.externalId);
          proposals.push({ field: "booking", value: b.externalId, confidence: byRef ? 0.95 : 0.7, reason: byRef ? "Referência no email" : "Matrícula na data da reclamação", projectId: b.projectId });
          bookingRef = b.externalId;
        }
      } catch { /* sugestão de reserva é opcional */ }
    }
  }

  // Duplicado (determinístico): aberta do mesmo cliente/reserva/matrícula.
  try {
    const dup = await findDuplicate(db, c);
    if (dup) proposals.push({ field: "duplicate", value: String(dup.id), confidence: dup.confidence, reason: `#${dup.id}: ${dup.reason}` });
  } catch { /* opcional */ }

  // Rascunho (privado até uma pessoa o enviar): marcadores repostos; recusado
  // se falar em compensações; cita sempre a reserva.
  const draft = finalizeComplaintDraft(red.restore(String(o.draft ?? "")), bookingRef);
  if (draft) proposals.push({ field: "draft", value: draft, confidence: 1, reason: "Rascunho — rever antes de enviar" });

  const patch: Record<string, unknown> = {};
  for (const p of proposals) {
    let status: SuggestionStatus = "pending";
    let previous: string | null = null;
    if (shouldAutoApply(p.field, p.confidence, c as any)) {
      const ap = applyPatch(c, p.field, p.value, { projectId: p.projectId });
      if (ap) {
        Object.assign(patch, ap.patch);
        previous = ap.previous;
        status = "applied";
        out.applied.push(p.field);
      }
    }
    if (status === "pending") out.suggested.push(p.field);
    await upsertSuggestion(db, complaintId, p, status, previous);
  }
  await db.update(complaints).set({ ...patch, aiTriagedAt: nowStr() } as any).where(eq(complaints.id, complaintId));
  out.ok = true;
  return out;
}

/**
 * Varrimento limitado: reclamações criadas pelo sistema (email) nos últimos 3
 * dias e ainda sem triagem. Para no 1.º erro "de paragem" (desligada,
 * orçamento, sem fornecedor) e respeita o prazo da função.
 */
export async function triagePendingComplaints(opts: { limit?: number; deadlineAt?: number } = {}): Promise<{ triaged: number; skipped?: string; errors: number }> {
  const out = { triaged: 0, errors: 0 } as { triaged: number; skipped?: string; errors: number };
  const { aiFeatureAvailableFresh } = await import("./_core/ai/status");
  if (!(await aiFeatureAvailableFresh("complaint_triage"))) return { ...out, skipped: "disabled" };
  const db = await getDb();
  if (!db) return out;
  const limit = Math.max(1, Math.min(10, opts.limit ?? 5));
  const deadlineAt = opts.deadlineAt ?? Date.now() + 40_000;
  const ids = (await db
    .select({ id: complaints.id })
    .from(complaints)
    .where(and(
      isNull(complaints.aiTriagedAt),
      isNull(complaints.createdById),
      sql`${complaints.createdAt} >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 DAY)`,
      sql`${complaints.complaintStatus} NOT IN ('closed', 'converted', 'resolved')`,
    ))
    .orderBy(sql`${complaints.id} DESC`)
    .limit(limit)).map((r) => r.id);
  for (const id of ids) {
    if (Date.now() + 22_000 > deadlineAt) { out.skipped = "deadline"; break; }
    const r = await triageComplaint(id, { timeoutMs: 20_000 });
    if (r.ok) out.triaged++;
    else if (r.skipped === "disabled" || r.error === "disabled" || r.error === "budget" || r.error === "not_configured") { out.skipped = r.error ?? r.skipped; break; }
    else if (r.error) out.errors++;
  }
  return out;
}

// ─── Leitura + decisões (UI) ────────────────────────────────────────────────

export async function getComplaintSuggestions(complaintId: number): Promise<SuggestionRow[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(aiSuggestions)
    .where(and(eq(aiSuggestions.entityType, ENTITY), eq(aiSuggestions.entityId, complaintId)))
    .orderBy(aiSuggestions.id);
  return rows.map((r) => ({
    field: r.field as SuggestionField,
    value: r.value ?? null,
    confidence: r.confidence != null ? Number(r.confidence) : null,
    reason: r.reason ?? null,
    status: r.status as SuggestionStatus,
    previousValue: r.previousValue ?? null,
    decidedAt: r.decidedAt ?? null,
  }));
}

/**
 * Aceitar/rejeitar uma sugestão. Aceitar aplica o valor (duplicado: nota
 * interna nas duas reclamações; rascunho: só marca como usado — o envio é
 * sempre pelo "Enviar email"). Rejeitar uma sugestão aplicada sozinha repõe o
 * valor anterior. Nunca envia nada ao cliente.
 */
export async function decideComplaintSuggestion(
  complaintId: number,
  field: SuggestionField,
  decision: "accept" | "reject",
  user: { id: number; name?: string | null },
): Promise<{ ok: boolean; error?: string }> {
  const db = await getDb();
  if (!db) return { ok: false, error: "Base de dados indisponível." };
  const [s] = await db.select().from(aiSuggestions)
    .where(and(eq(aiSuggestions.entityType, ENTITY), eq(aiSuggestions.entityId, complaintId), eq(aiSuggestions.field, field))).limit(1);
  if (!s) return { ok: false, error: "Sugestão não encontrada." };
  if (s.status === "accepted" || s.status === "rejected") return { ok: false, error: "Esta sugestão já foi decidida." };
  const [c] = await db.select().from(complaints).where(eq(complaints.id, complaintId)).limit(1);
  if (!c) return { ok: false, error: "Reclamação não encontrada." };

  if (decision === "accept" && s.status === "pending") {
    if (field === "duplicate") {
      const otherId = Number(s.value);
      if (Number.isFinite(otherId) && otherId > 0) {
        const who = user.name || "Utilizador";
        await addComplaintMessage({ complaintId, message: `🔁 Marcada como possível duplicado da reclamação #${otherId} (${who}).`, isInternal: 1, authorId: user.id, authorName: who } as any);
        await addComplaintMessage({ complaintId: otherId, message: `🔁 A reclamação #${complaintId} foi marcada como duplicado desta (${who}).`, isInternal: 1, authorId: user.id, authorName: who } as any);
      }
    } else if (field !== "draft") {
      const ap = applyPatch(c, field, String(s.value ?? ""));
      if (ap) {
        if (field === "booking" && c.projectId == null) {
          try {
            const { deriveBookingForCase } = await import("./caseOps");
            const b = await deriveBookingForCase({ bookingRef: String(s.value ?? "") });
            if (b?.projectId) ap.patch.projectId = b.projectId;
          } catch { /* opcional */ }
        }
        await db.update(complaints).set(ap.patch as any).where(eq(complaints.id, complaintId));
        await db.update(aiSuggestions).set({ previousValue: ap.previous }).where(eq(aiSuggestions.id, s.id));
      }
    }
  }
  if (decision === "reject" && s.status === "applied") {
    const back = revertPatch(field, s.previousValue ?? null);
    if (back) await db.update(complaints).set(back as any).where(eq(complaints.id, complaintId));
  }
  await db.update(aiSuggestions).set({
    status: decision === "accept" ? "accepted" : "rejected",
    decidedById: user.id,
    decidedAt: nowStr(),
  }).where(eq(aiSuggestions.id, s.id));
  return { ok: true };
}
