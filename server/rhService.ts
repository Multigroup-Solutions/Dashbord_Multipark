/**
 * Serviço de RH — bloqueios com motivos separados, faltas como "possível
 * falta" pendente de validação, revisão do ponto e fecho mensal de ordenados.
 *
 * Princípios (auditoria set 2026):
 *  - consultas NÃO escrevem (o auth.me deixou de desbloquear ninguém);
 *  - um processo nunca apaga o bloqueio criado por outro (docs / faltas /
 *    manual são flags separadas; loginBlocked = OR);
 *  - uma falta automática só conta pontos depois de confirmada;
 *  - registos de ponto suspeitos não pagam até serem aprovados;
 *  - um fecho mensal é uma versão imutável do cálculo.
 */
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { getDb, getDocumentChecklistForEmployee, getPayrollData, toMysqlDateTime } from "./db";
import { employeePenalties, employees, extrasDiaAssignments, payrollRunLines, payrollRuns, timeRecords } from "../drizzle/schema";

const nowMysql = () => toMysqlDateTime(new Date());

// ─── Bloqueio de login: motivos separados ────────────────────────────────────
export async function recomputeLoginBlocked(employeeId: number): Promise<{ blocked: boolean; reason: string | null }> {
  const db = await getDb();
  if (!db) return { blocked: false, reason: null };
  const [e] = await db.select({ blockedByDocs: employees.blockedByDocs, blockedByPenalties: employees.blockedByPenalties, blockedManually: employees.blockedManually, loginBlockedReason: employees.loginBlockedReason })
    .from(employees).where(eq(employees.id, employeeId)).limit(1);
  if (!e) return { blocked: false, reason: null };
  const reasons: string[] = [];
  if (e.blockedByPenalties) reasons.push("faltas em extras-dia sem aviso");
  if (e.blockedByDocs) reasons.push("documentos obrigatórios em falta");
  if (e.blockedManually) reasons.push(e.loginBlockedReason && !/falta|documento/i.test(e.loginBlockedReason) ? e.loginBlockedReason : "bloqueio manual");
  const blocked = reasons.length > 0;
  await db.update(employees).set({ loginBlocked: blocked ? 1 : 0, loginBlockedReason: blocked ? `${reasons.join(" · ")}. Contacta o supervisor.`.slice(0, 255) : null }).where(eq(employees.id, employeeId));
  return { blocked, reason: blocked ? reasons.join(" · ") : null };
}

/** Desbloqueio manual (supervisor+): limpa os três motivos. */
export async function unblockAll(employeeId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(employees).set({ blockedByDocs: 0, blockedByPenalties: 0, blockedManually: 0, loginBlocked: 0, loginBlockedReason: null }).where(eq(employees.id, employeeId));
}

// ─── Documentos: estado (LEITURA) vs aplicação (escrita, cron/ação admin) ────
export interface DocsStatus { blocked: boolean; warning: boolean; missingDocs: string[]; daysSinceStart: number; blockedBy: { docs: boolean; penalties: boolean; manual: boolean } }

export async function getExtraDocsStatus(employeeId: number): Promise<DocsStatus | null> {
  const db = await getDb();
  if (!db) return null;
  const [emp] = await db.select({ position: employees.position, contractStart: employees.contractStart, createdAt: employees.createdAt, loginBlocked: employees.loginBlocked, docsWarningAt: employees.docsWarningAt, blockedByDocs: employees.blockedByDocs, blockedByPenalties: employees.blockedByPenalties, blockedManually: employees.blockedManually })
    .from(employees).where(eq(employees.id, employeeId)).limit(1);
  if (!emp || emp.position !== "extra") return null;
  const startDate = new Date(emp.contractStart ?? emp.createdAt ?? new Date());
  const daysSinceStart = Math.floor((Date.now() - startDate.getTime()) / 86_400_000);
  const checklist = await getDocumentChecklistForEmployee(employeeId);
  const missingDocs = checklist.filter((c: any) => !c.present).map((c: any) => c.docType);
  return {
    blocked: Boolean(emp.loginBlocked), warning: Boolean(emp.docsWarningAt) || (missingDocs.length > 0 && daysSinceStart >= 14),
    missingDocs, daysSinceStart,
    blockedBy: { docs: Boolean(emp.blockedByDocs), penalties: Boolean(emp.blockedByPenalties), manual: Boolean(emp.blockedManually) },
  };
}

/**
 * Aplica a regra documental (escreve): 14 dias → aviso; 21 dias → bloqueio por
 * documentos (SUSPENSO por decisão do Jorge, 6 ago 2026 — só o aviso). Só mexe
 * em blockedByDocs/docsWarningAt; NUNCA nos outros motivos.
 */
export async function applyDocsCompliance(employeeId: number, opts: { enforceBlock?: boolean } = {}): Promise<DocsStatus | null> {
  const db = await getDb();
  if (!db) return null;
  const st = await getExtraDocsStatus(employeeId);
  if (!st) return null;
  const [emp] = await db.select({ docsWarningAt: employees.docsWarningAt, blockedByDocs: employees.blockedByDocs }).from(employees).where(eq(employees.id, employeeId)).limit(1);
  if (!emp) return st;
  if (st.missingDocs.length === 0) {
    if (emp.blockedByDocs || emp.docsWarningAt) {
      await db.update(employees).set({ blockedByDocs: 0, docsWarningAt: null }).where(eq(employees.id, employeeId));
      await recomputeLoginBlocked(employeeId);
    }
    return getExtraDocsStatus(employeeId);
  }
  const shouldBlock = Boolean(opts.enforceBlock) && st.daysSinceStart >= 21;
  const patch: Record<string, unknown> = {};
  if (st.daysSinceStart >= 14 && !emp.docsWarningAt) patch.docsWarningAt = nowMysql();
  if (shouldBlock && !emp.blockedByDocs) patch.blockedByDocs = 1;
  if (!shouldBlock && emp.blockedByDocs) patch.blockedByDocs = 0;   // regra suspensa: levanta SÓ o motivo documental
  if (Object.keys(patch).length) {
    await db.update(employees).set(patch).where(eq(employees.id, employeeId));
    await recomputeLoginBlocked(employeeId);
  }
  return getExtraDocsStatus(employeeId);
}

/** Cron diário: aplica a regra documental a todos os extras ativos. */
export async function applyDocsComplianceAll(): Promise<{ checked: number }> {
  const db = await getDb();
  if (!db) return { checked: 0 };
  const rows = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.position, "extra"), eq(employees.isActive, 1)));
  for (const r of rows) { try { await applyDocsCompliance(r.id); } catch (err) { console.warn("[docs] compliance", r.id, err); } }
  return { checked: rows.length };
}

// ─── Faltas: "possível falta" pendente de validação ─────────────────────────
/**
 * Extras escalados num dia sem check-in nesse dia → penalização PENDENTE
 * (não conta pontos, não bloqueia). Idempotente (UNIQUE employeeId+reason+relatedId).
 */
export async function detectExtraDiaNoShows(dateStr: string): Promise<{ scanned: number; created: number; alreadyPending: number }> {
  const db = await getDb();
  if (!db) return { scanned: 0, created: 0, alreadyPending: 0 };
  const rows = await db.select({ id: extrasDiaAssignments.id, employeeId: extrasDiaAssignments.employeeId, personName: extrasDiaAssignments.personName, startHour: extrasDiaAssignments.startHour, city: extrasDiaAssignments.city })
    .from(extrasDiaAssignments)
    .where(and(eq(extrasDiaAssignments.assignmentDate, dateStr), eq(extrasDiaAssignments.isTeamLeader, 0), isNotNull(extrasDiaAssignments.employeeId)));
  let created = 0, alreadyPending = 0;
  for (const r of rows) {
    if (r.employeeId == null) continue;
    // check-in no próprio dia (Lisboa ≈ UTC; folga de 1 h para turnos cedo)
    const start = new Date(`${dateStr}T00:00:00Z`), end = new Date(`${dateStr}T23:59:59Z`);
    const [ci] = await db.select({ id: timeRecords.id }).from(timeRecords)
      .where(and(eq(timeRecords.employeeId, r.employeeId), eq(timeRecords.type, "check_in"), gte(timeRecords.recordedAt, toMysqlDateTime(new Date(start.getTime() - 3600000))), lte(timeRecords.recordedAt, toMysqlDateTime(end)))).limit(1);
    if (ci) continue;
    try {
      await db.insert(employeePenalties).values({
        employeeId: r.employeeId, reason: "no_show_extra_dia", severity: "penalty", points: 1, relatedId: r.id, status: "pending",
        notes: `Possível falta ao extras-dia em ${dateStr} (${r.personName}, ${r.city}, ${r.startHour}h) — sem check-in nesse dia; confirmar com a operação`,
      });
      created++;
    } catch (err: any) {
      if (err?.code === "ER_DUP_ENTRY" || err?.cause?.code === "ER_DUP_ENTRY") { alreadyPending++; continue; }
      throw err;
    }
  }
  return { scanned: rows.length, created, alreadyPending };
}

export async function listPendingPenalties(limit = 100) {
  const db = await getDb();
  if (!db) return [];
  return db.select({ penalty: employeePenalties, employee: { id: employees.id, fullName: employees.fullName, phone: employees.phone, projectId: employees.projectId } })
    .from(employeePenalties).leftJoin(employees, eq(employees.id, employeePenalties.employeeId))
    .where(eq(employeePenalties.status, "pending")).orderBy(desc(employeePenalties.createdAt)).limit(limit);
}

/** Pontos ABERTOS e CONFIRMADOS por colaborador (pendentes não contam). */
export async function confirmedOpenPoints(employeeId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const [agg] = await db.select({ total: sql<number>`COALESCE(SUM(${employeePenalties.points}), 0)` }).from(employeePenalties)
    .where(and(eq(employeePenalties.employeeId, employeeId), isNull(employeePenalties.clearedAt), eq(employeePenalties.status, "confirmed")));
  return Number(agg?.total ?? 0);
}

export async function reviewPenalty(id: number, decision: "confirmed" | "dismissed", reviewerId: number, note?: string | null): Promise<{ points: number; blocked: boolean }> {
  const db = await getDb();
  if (!db) throw new Error("DB indisponível");
  const [p] = await db.select().from(employeePenalties).where(eq(employeePenalties.id, id)).limit(1);
  if (!p) throw new Error("Penalização não encontrada");
  await db.update(employeePenalties).set({ status: decision, reviewedById: reviewerId, reviewedAt: nowMysql(), notes: note ? `${p.notes ?? ""} · revisão: ${note}`.slice(0, 512) : p.notes, clearedAt: decision === "dismissed" ? nowMysql() : p.clearedAt, clearedById: decision === "dismissed" ? reviewerId : p.clearedById })
    .where(eq(employeePenalties.id, id));
  const points = await confirmedOpenPoints(p.employeeId);
  const shouldBlock = points >= 3;
  await db.update(employees).set({ blockedByPenalties: shouldBlock ? 1 : 0 }).where(eq(employees.id, p.employeeId));
  const r = await recomputeLoginBlocked(p.employeeId);
  return { points, blocked: r.blocked };
}

// ─── Ponto: revisão de registos suspeitos ───────────────────────────────────
export async function listSuspiciousTimeRecords(opts: { employeeId?: number; limit?: number } = {}) {
  const db = await getDb();
  if (!db) return [];
  const conds: any[] = [eq(timeRecords.reviewStatus, "suspicious")];
  if (opts.employeeId) conds.push(eq(timeRecords.employeeId, opts.employeeId));
  return db.select({ record: timeRecords, employee: { id: employees.id, fullName: employees.fullName } })
    .from(timeRecords).leftJoin(employees, eq(employees.id, timeRecords.employeeId))
    .where(and(...conds)).orderBy(desc(timeRecords.recordedAt)).limit(opts.limit ?? 200);
}

export async function reviewTimeRecord(id: number, decision: "approved" | "rejected", reviewerId: number, note?: string | null, correctedHours?: number | null) {
  const db = await getDb();
  if (!db) throw new Error("DB indisponível");
  const patch: Record<string, unknown> = { reviewStatus: decision, reviewedById: reviewerId, reviewedAt: nowMysql(), reviewNote: note?.slice(0, 255) ?? null };
  if (decision === "approved" && correctedHours != null && correctedHours >= 0 && correctedHours <= 24) patch.hoursWorked = correctedHours.toFixed(2);
  await db.update(timeRecords).set(patch).where(eq(timeRecords.id, id));
}

// ─── Fecho mensal ───────────────────────────────────────────────────────────
export async function createPayrollRun(year: number, month: number, userId: number, notes?: string | null) {
  const db = await getDb();
  if (!db) throw new Error("DB indisponível");
  const rows = await getPayrollData(year, month);
  const [last] = await db.select({ v: sql<number>`COALESCE(MAX(${payrollRuns.version}), 0)` }).from(payrollRuns).where(and(eq(payrollRuns.year, year), eq(payrollRuns.month, month)));
  const version = Number(last?.v ?? 0) + 1;
  const totalGross = rows.reduce((s, r: any) => s + Number(r.totalPayment ?? 0), 0);
  const totalNet = rows.reduce((s, r: any) => s + Number(r.netEstimate ?? 0), 0);
  const warningsCount = rows.reduce((s, r: any) => s + ((r.warnings?.length ?? 0) > 0 ? 1 : 0), 0);
  const ins = await db.insert(payrollRuns).values({ year, month, version, status: "draft", employeesCount: rows.length, totalGross: totalGross.toFixed(2), totalNetEstimate: totalNet.toFixed(2), warningsCount, notes: notes ?? null, createdById: userId });
  const runId = Number((ins as any)?.[0]?.insertId ?? 0);
  for (let i = 0; i < rows.length; i += 200) {
    await db.insert(payrollRunLines).values(rows.slice(i, i + 200).map((r: any) => ({
      runId, employeeId: r.employeeId, fullName: r.fullName, isExtra: r.isExtra ? 1 : 0,
      totalHours: Number(r.totalHours ?? 0).toFixed(2), totalPayment: Number(r.totalPayment ?? 0).toFixed(2), netEstimate: Number(r.netEstimate ?? 0).toFixed(2),
      snapshot: JSON.stringify(r),
    })));
  }
  return { runId, version, employeesCount: rows.length, totalGross, warningsCount };
}

export async function listPayrollRuns(year?: number, month?: number) {
  const db = await getDb();
  if (!db) return [];
  const conds: any[] = [];
  if (year) conds.push(eq(payrollRuns.year, year));
  if (month) conds.push(eq(payrollRuns.month, month));
  const q = db.select().from(payrollRuns).orderBy(desc(payrollRuns.year), desc(payrollRuns.month), desc(payrollRuns.version));
  return conds.length ? q.where(and(...conds)) : q;
}

export async function getPayrollRun(runId: number) {
  const db = await getDb();
  if (!db) return null;
  const [run] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, runId)).limit(1);
  if (!run) return null;
  const lines = await db.select().from(payrollRunLines).where(eq(payrollRunLines.runId, runId));
  return { run, lines: lines.map((l) => ({ ...l, snapshot: safeJson(l.snapshot) })) };
}
function safeJson(s: string) { try { return JSON.parse(s); } catch { return null; } }

export async function transitionPayrollRun(runId: number, to: "approved" | "paid" | "void", userId: number, paymentRef?: string | null) {
  const db = await getDb();
  if (!db) throw new Error("DB indisponível");
  const [run] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, runId)).limit(1);
  if (!run) throw new Error("Fecho não encontrado");
  const allowed: Record<string, string[]> = { draft: ["approved", "void"], approved: ["paid", "void"], paid: [], void: [] };
  if (!allowed[run.status].includes(to)) throw new Error(`Transição inválida: ${run.status} → ${to}`);
  const patch: Record<string, unknown> = { status: to };
  if (to === "approved") { patch.approvedById = userId; patch.approvedAt = nowMysql(); }
  if (to === "paid") { patch.paidById = userId; patch.paidAt = nowMysql(); patch.paymentRef = paymentRef ?? null; }
  await db.update(payrollRuns).set(patch).where(eq(payrollRuns.id, runId));
  return { ok: true };
}

/** Pagamentos CONFIRMADOS (fechos pagos) por colaborador nos últimos N meses — o que "recebido" deve significar. */
export async function paidTotalsLookback(employeeIds: number[], months: Array<{ year: number; month: number }>) {
  const db = await getDb();
  const out = new Map<number, { paid: number; approved: number }>();
  if (!db || employeeIds.length === 0 || months.length === 0) return out;
  const runs = await db.select({ id: payrollRuns.id, status: payrollRuns.status, year: payrollRuns.year, month: payrollRuns.month })
    .from(payrollRuns).where(and(inArray(payrollRuns.status, ["approved", "paid"]), inArray(payrollRuns.year, Array.from(new Set(months.map((m) => m.year))))));
  const wanted = new Set(months.map((m) => `${m.year}-${m.month}`));
  // por mês, só a versão mais recente aprovada/paga
  const byMonth = new Map<string, typeof runs[number]>();
  for (const r of runs) { const k = `${r.year}-${r.month}`; if (!wanted.has(k)) continue; const cur = byMonth.get(k); if (!cur || r.id > cur.id) byMonth.set(k, r); }
  const ids = Array.from(byMonth.values()).map((r) => r.id);
  if (!ids.length) return out;
  const lines = await db.select({ runId: payrollRunLines.runId, employeeId: payrollRunLines.employeeId, totalPayment: payrollRunLines.totalPayment })
    .from(payrollRunLines).where(and(inArray(payrollRunLines.runId, ids), inArray(payrollRunLines.employeeId, employeeIds)));
  const statusOf = new Map(Array.from(byMonth.values()).map((r) => [r.id, r.status]));
  for (const l of lines) {
    const e = out.get(l.employeeId) ?? { paid: 0, approved: 0 };
    if (statusOf.get(l.runId) === "paid") e.paid += Number(l.totalPayment); else e.approved += Number(l.totalPayment);
    out.set(l.employeeId, e);
  }
  return out;
}

// ─── Ponto: inserção ATÓMICA (contra duplo toque / dois pedidos simultâneos) ─
// Transação com bloqueio da linha do colaborador (SELECT … FOR UPDATE): o
// último registo é relido dentro do bloqueio e a validação repete-se.
export async function insertTimeRecordAtomic(
  employeeId: number,
  type: "check_in" | "check_out",
  data: Omit<typeof timeRecords.$inferInsert, "employeeId" | "type">,
): Promise<{ id: number }> {
  const db = await getDb();
  if (!db) throw new Error("DB indisponível");
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM employees WHERE id = ${employeeId} FOR UPDATE`);
    const [last] = await tx.select({ type: timeRecords.type, recordedAt: timeRecords.recordedAt }).from(timeRecords)
      .where(eq(timeRecords.employeeId, employeeId)).orderBy(desc(timeRecords.recordedAt), desc(timeRecords.id)).limit(1);
    if (type === "check_in" && last?.type === "check_in") throw new Error("Já tens uma entrada em aberto. Faz check-out primeiro.");
    if (type === "check_out" && (!last || last.type !== "check_in")) throw new Error("Não tens entrada em aberto. Faz check-in primeiro.");
    const ins = await tx.insert(timeRecords).values({ employeeId, type, ...data });
    return { id: Number((ins as any)?.[0]?.insertId ?? 0) };
  });
}
