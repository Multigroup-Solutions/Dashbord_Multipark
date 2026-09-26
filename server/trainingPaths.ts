/**
 * Formação — percursos obrigatórios (onboarding), atribuições, progresso
 * "visto/lido", bloqueio da escala, dashboard de conclusão e automação
 * (lembretes + recertificação). Regras puras em ./trainingRules.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, logActivity } from "./db";
import { projectScope } from "./cityScope";
import {
  careerExams, employees, faqs, quizQuestions, trainingAssignments, trainingCategories, trainingCertificates,
  trainingManuals, trainingPathItems, trainingPaths, trainingProgress, trainingVideos,
} from "../drizzle/schema";
import {
  assignmentStatusFor, certificateStatus, computePathProgress, daysLate, escalaEligibility, isReminderHour, lisbonDay, parseDbDate,
  selectReminders, toDbDate, trainingBlocksEscalaEnabled, trainingRemindersEnabled, type EligibilityResult, type TrainingItemType,
} from "./trainingRules";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Base de dados indisponível");
  return d;
}
const insertId = (r: any): number => Number(r?.[0]?.insertId ?? r?.insertId ?? 0);
const affected = (r: any): number => Number(r?.[0]?.affectedRows ?? r?.affectedRows ?? 0);

// ─── Percursos ─────────────────────────────────────────────────────────────

export interface PathInput {
  name: string;
  description?: string | null;
  targetRole?: string | null;
  city?: string | null;
  active?: boolean;
  isDefaultOnboarding?: boolean;
  blocksEscala?: boolean;
  dueDays?: number;
}

export async function listPaths(opts: { includeInactive?: boolean } = {}) {
  const d = await db();
  const paths = await d.select().from(trainingPaths)
    .where(opts.includeInactive ? undefined : eq(trainingPaths.active, 1))
    .orderBy(desc(trainingPaths.isDefaultOnboarding), asc(trainingPaths.name));
  if (!paths.length) return [];
  const items = await d.select().from(trainingPathItems)
    .where(inArray(trainingPathItems.pathId, paths.map(p => p.id)))
    .orderBy(asc(trainingPathItems.sortOrder), asc(trainingPathItems.id));
  const titles = await itemTitles(items);
  const counts = await d.select({ pathId: trainingAssignments.pathId, n: sql<number>`COUNT(*)` })
    .from(trainingAssignments).groupBy(trainingAssignments.pathId);
  const countMap = new Map(counts.map(c => [c.pathId, Number(c.n)]));
  return paths.map(p => ({
    ...p,
    assignedCount: countMap.get(p.id) ?? 0,
    items: items.filter(i => i.pathId === p.id).map(i => ({ ...i, title: titles.get(`${i.itemType}:${i.itemId}`) ?? `(${i.itemType} #${i.itemId} removido)` })),
  }));
}

function pathValues(input: PathInput) {
  return {
    name: input.name.trim(),
    description: input.description ?? null,
    targetRole: input.targetRole || null,
    city: input.city || null,
    active: input.active === false ? 0 : 1,
    isDefaultOnboarding: input.isDefaultOnboarding ? 1 : 0,
    blocksEscala: input.blocksEscala === false ? 0 : 1,
    dueDays: Math.max(1, Math.min(365, Math.trunc(input.dueDays ?? 7))),
  };
}

export async function createPath(input: PathInput, userId: number) {
  const d = await db();
  const r = await d.insert(trainingPaths).values({ ...pathValues(input), createdById: userId });
  const id = insertId(r);
  await logActivity({ userId, action: "create", entity: "training_path", entityId: id, details: input.name });
  return { id };
}

export async function updatePath(id: number, input: PathInput, userId: number) {
  const d = await db();
  await d.update(trainingPaths).set(pathValues(input)).where(eq(trainingPaths.id, id));
  await logActivity({ userId, action: "update", entity: "training_path", entityId: id, details: input.name });
}

/** Apaga um percurso SEM atribuições; com atribuições, só se pode desativar. */
export async function deletePath(id: number, userId: number): Promise<{ ok: boolean; assigned: number }> {
  const d = await db();
  const [c] = await d.select({ n: sql<number>`COUNT(*)` }).from(trainingAssignments).where(eq(trainingAssignments.pathId, id));
  const assigned = Number(c?.n ?? 0);
  if (assigned > 0) return { ok: false, assigned };
  await d.delete(trainingPathItems).where(eq(trainingPathItems.pathId, id));
  await d.delete(trainingPaths).where(eq(trainingPaths.id, id));
  await logActivity({ userId, action: "delete", entity: "training_path", entityId: id, details: "" });
  return { ok: true, assigned: 0 };
}

export async function setPathItems(pathId: number, items: Array<{ itemType: TrainingItemType; itemId: number; required: boolean }>, userId: number) {
  const d = await db();
  await d.delete(trainingPathItems).where(eq(trainingPathItems.pathId, pathId));
  if (items.length) {
    await d.insert(trainingPathItems).values(items.map((it, i) => ({
      pathId, itemType: it.itemType, itemId: it.itemId, sortOrder: i, required: it.required ? 1 : 0,
    })));
  }
  await logActivity({ userId, action: "update", entity: "training_path", entityId: pathId, details: `${items.length} itens` });
  // O progresso de quem já tem o percurso muda com os itens.
  const emps = await d.select({ employeeId: trainingAssignments.employeeId }).from(trainingAssignments).where(eq(trainingAssignments.pathId, pathId));
  for (const e of emps) await refreshAssignmentsFor(e.employeeId);
}

/** Títulos dos itens (vídeo/manual/exame/quiz) para mostrar nos percursos. */
async function itemTitles(items: Array<{ itemType: string; itemId: number }>): Promise<Map<string, string>> {
  const d = await db();
  const out = new Map<string, string>();
  const ids = (t: string) => Array.from(new Set(items.filter(i => i.itemType === t).map(i => i.itemId)));
  const v = ids("video"), m = ids("manual"), e = ids("exam"), q = ids("quiz");
  if (v.length) for (const r of await d.select({ id: trainingVideos.id, title: trainingVideos.title }).from(trainingVideos).where(inArray(trainingVideos.id, v))) out.set(`video:${r.id}`, r.title);
  if (m.length) for (const r of await d.select({ id: trainingManuals.id, title: trainingManuals.title }).from(trainingManuals).where(inArray(trainingManuals.id, m))) out.set(`manual:${r.id}`, r.title);
  if (e.length) for (const r of await d.select({ id: careerExams.id, title: careerExams.title }).from(careerExams).where(inArray(careerExams.id, e))) out.set(`exam:${r.id}`, r.title);
  if (q.length) {
    out.set("quiz:0", "Quiz (qualquer categoria)");
    const cats = q.filter(x => x > 0);
    if (cats.length) for (const r of await d.select({ id: trainingCategories.id, name: trainingCategories.name }).from(trainingCategories).where(inArray(trainingCategories.id, cats))) out.set(`quiz:${r.id}`, `Quiz — ${r.name}`);
  }
  return out;
}

// ─── Atribuições ───────────────────────────────────────────────────────────

function dueFrom(now: Date, days: number): string {
  return toDbDate(new Date(now.getTime() + days * 86400_000));
}

/**
 * Atribui um percurso. Já atribuído → mantém (a menos que `reset`, usado na
 * recertificação, que reabre a atribuição com novo prazo).
 */
export async function assignPath(pathId: number, employeeIds: number[], opts: { assignedById?: number | null; source?: string; reset?: boolean; now?: Date } = {}) {
  const d = await db();
  const [path] = await d.select().from(trainingPaths).where(eq(trainingPaths.id, pathId)).limit(1);
  if (!path) throw new Error("Percurso não encontrado.");
  const now = opts.now ?? new Date();
  const dueAt = dueFrom(now, path.dueDays ?? 7);
  let created = 0, reset = 0, skipped = 0;
  for (const employeeId of Array.from(new Set(employeeIds))) {
    const [existing] = await d.select().from(trainingAssignments)
      .where(and(eq(trainingAssignments.employeeId, employeeId), eq(trainingAssignments.pathId, pathId))).limit(1);
    if (existing) {
      if (opts.reset) {
        await d.update(trainingAssignments).set({
          status: "assigned", dueAt, completedAt: null, lastReminderAt: null, escalatedAt: null,
          assignedById: opts.assignedById ?? null, source: opts.source ?? existing.source, assignedAt: toDbDate(now),
        }).where(eq(trainingAssignments.id, existing.id));
        reset++;
      } else skipped++;
      continue;
    }
    await d.insert(trainingAssignments).values({
      employeeId, pathId, status: "assigned", dueAt, assignedById: opts.assignedById ?? null, source: opts.source ?? "manual",
    });
    created++;
  }
  for (const id of employeeIds) await refreshAssignmentsFor(id, now);
  // Prazo da formação no Google Calendar de quem a recebeu (se ligou), já.
  if (created || reset) import("./google/pendingSync").then((m) => m.scheduleGoogleEmployeesSync(employeeIds, "training")).catch(() => undefined);
  return { created, reset, skipped };
}

export async function unassign(assignmentId: number, userId: number) {
  const d = await db();
  await d.delete(trainingAssignments).where(eq(trainingAssignments.id, assignmentId));
  await logActivity({ userId, action: "delete", entity: "training_assignment", entityId: assignmentId, details: "" });
}

/** Botão "atribuir a todos os extras ativos" (âmbito da cidade de quem pede). */
export async function assignToActiveExtras(pathId: number, userId: number) {
  const d = await db();
  const rows = await d.select({ id: employees.id }).from(employees)
    .where(and(eq(employees.isActive, 1), eq(employees.position, "extra"), projectScope(employees.projectId)));
  const out = await assignPath(pathId, rows.map(r => r.id), { assignedById: userId, source: "bulk" });
  await logActivity({ userId, action: "update", entity: "training_path", entityId: pathId, details: `Atribuído a extras ativos: ${out.created} novos` });
  return { ...out, total: rows.length };
}

/**
 * Atribui o(s) percurso(s) de onboarding por defeito a um extra novo (lead
 * convertido / candidatura aprovada). Best-effort: NUNCA lança.
 */
export async function autoAssignOnboarding(employeeId: number, source: string, assignedById: number | null = null): Promise<number> {
  try {
    const d = await getDb();
    if (!d) return 0;
    const paths = await d.select().from(trainingPaths)
      .where(and(eq(trainingPaths.active, 1), eq(trainingPaths.isDefaultOnboarding, 1)));
    if (!paths.length) return 0;
    let city: string | null = null;
    if (paths.some(p => p.city)) {
      const { resolveCitiesForEmployeeIds } = await import("./employeeCity");
      city = (await resolveCitiesForEmployeeIds([employeeId])).get(employeeId)?.city ?? null;
    }
    let n = 0;
    for (const p of paths) {
      if (p.city && city && p.city !== city) continue;
      const r = await assignPath(p.id, [employeeId], { assignedById, source });
      n += r.created;
    }
    return n;
  } catch (err: any) {
    console.warn("[Training] auto-atribuição falhou:", String(err?.message ?? err).slice(0, 160));
    return 0;
  }
}

// ─── Progresso ─────────────────────────────────────────────────────────────

export async function recordProgress(employeeId: number, itemType: TrainingItemType, itemId: number, opts: { completed?: boolean; seconds?: number; now?: Date } = {}) {
  const d = await db();
  const now = toDbDate(opts.now ?? new Date());
  const secs = Math.max(0, Math.min(86400, Math.trunc(opts.seconds ?? 0)));
  await d.insert(trainingProgress).values({
    employeeId, itemType, itemId, viewedAt: now, completedAt: opts.completed ? now : null, seconds: secs,
  }).onDuplicateKeyUpdate({
    set: {
      // Sem VALUES() (obsoleto no MySQL 8.0.20+): valores literais.
      viewedAt: sql`COALESCE(${trainingProgress.viewedAt}, ${now})`,
      completedAt: opts.completed ? sql`COALESCE(${trainingProgress.completedAt}, ${now})` : sql`${trainingProgress.completedAt}`,
      seconds: sql`GREATEST(${trainingProgress.seconds}, ${secs})`,
    },
  });
  await refreshAssignmentsFor(employeeId);
}

/** Limpa a conclusão de um item (recertificação de um exame). */
export async function clearProgress(employeeId: number, itemType: TrainingItemType, itemId: number) {
  const d = await db();
  await d.update(trainingProgress).set({ completedAt: null })
    .where(and(eq(trainingProgress.employeeId, employeeId), eq(trainingProgress.itemType, itemType), eq(trainingProgress.itemId, itemId)));
}

/** Recalcula o estado das atribuições de uma pessoa (após progresso/itens). */
export async function refreshAssignmentsFor(employeeId: number, now: Date = new Date()) {
  const d = await db();
  const assigns = await d.select().from(trainingAssignments).where(eq(trainingAssignments.employeeId, employeeId));
  if (!assigns.length) return;
  const items = await d.select().from(trainingPathItems).where(inArray(trainingPathItems.pathId, assigns.map(a => a.pathId)));
  const progress = await d.select().from(trainingProgress).where(eq(trainingProgress.employeeId, employeeId));
  for (const a of assigns) {
    const p = computePathProgress(items.filter(i => i.pathId === a.pathId), progress);
    const status = assignmentStatusFor(p, a.dueAt, now);
    if (status !== a.status) {
      await d.update(trainingAssignments).set({ status, completedAt: status === "completed" ? toDbDate(now) : null })
        .where(eq(trainingAssignments.id, a.id));
    }
  }
}

/** A formação do próprio: percursos atribuídos com itens e progresso. */
export async function employeeTraining(employeeId: number, now: Date = new Date()) {
  const d = await db();
  const assigns = await d.select({ a: trainingAssignments, p: trainingPaths }).from(trainingAssignments)
    .innerJoin(trainingPaths, eq(trainingPaths.id, trainingAssignments.pathId))
    .where(eq(trainingAssignments.employeeId, employeeId))
    .orderBy(desc(trainingAssignments.assignedAt));
  const pathIds = assigns.map(x => x.p.id);
  const items = pathIds.length ? await d.select().from(trainingPathItems).where(inArray(trainingPathItems.pathId, pathIds)).orderBy(asc(trainingPathItems.sortOrder), asc(trainingPathItems.id)) : [];
  const progress = await d.select().from(trainingProgress).where(eq(trainingProgress.employeeId, employeeId));
  const titles = await itemTitles(items);
  const progMap = new Map(progress.map(p => [`${p.itemType}:${p.itemId}`, p]));
  const assignments = assigns.map(({ a, p }) => {
    const its = items.filter(i => i.pathId === p.id);
    const pr = computePathProgress(its, progress);
    return {
      id: a.id, pathId: p.id, pathName: p.name, description: p.description, blocksEscala: !!p.blocksEscala, active: !!p.active,
      status: assignmentStatusFor(pr, a.dueAt, now), dueAt: a.dueAt, assignedAt: a.assignedAt, completedAt: a.completedAt,
      daysLate: pr.complete ? 0 : daysLate(a.dueAt, now), progress: pr,
      items: its.map(i => {
        const g = progMap.get(`${i.itemType}:${i.itemId}`);
        return { id: i.id, itemType: i.itemType, itemId: i.itemId, required: !!i.required, title: titles.get(`${i.itemType}:${i.itemId}`) ?? "(removido)", viewedAt: g?.viewedAt ?? null, completedAt: g?.completedAt ?? null, seconds: g?.seconds ?? 0 };
      }),
    };
  });
  return { assignments, progress };
}

// ─── Escala ────────────────────────────────────────────────────────────────

async function eligibilityRows(employeeIds: number[]) {
  const d = await db();
  if (!employeeIds.length) return [];
  return d.select({
    employeeId: trainingAssignments.employeeId, status: trainingAssignments.status, pathName: trainingPaths.name,
    pathActive: trainingPaths.active, blocksEscala: trainingPaths.blocksEscala,
  }).from(trainingAssignments)
    .innerJoin(trainingPaths, eq(trainingPaths.id, trainingAssignments.pathId))
    .where(inArray(trainingAssignments.employeeId, employeeIds));
}

export async function checkEscalaEligibility(employeeId: number, opts: { override?: boolean; canOverride?: boolean } = {}): Promise<EligibilityResult> {
  const enabled = trainingBlocksEscalaEnabled();
  if (!enabled) return escalaEligibility({ assignments: [], enabled });
  // Estado fresco (o progresso pode ter sido feito entretanto)
  try { await refreshAssignmentsFor(employeeId); } catch { /* segue com o estado guardado */ }
  const rows = await eligibilityRows([employeeId]);
  return escalaEligibility({ assignments: rows, enabled, override: opts.override, canOverride: opts.canOverride });
}

/** Ids (do conjunto dado) com formação obrigatória em falta — badge + autofill. */
export async function employeesMissingTraining(employeeIds: number[]): Promise<Set<number>> {
  const out = new Set<number>();
  if (!trainingBlocksEscalaEnabled() || !employeeIds.length) return out;
  try {
    const rows = await eligibilityRows(employeeIds);
    for (const r of rows) if (r.pathActive && r.blocksEscala && r.status !== "completed") out.add(r.employeeId);
  } catch (err: any) {
    console.warn("[Training] verificação da formação falhou:", String(err?.message ?? err).slice(0, 160));
  }
  return out;
}

/** Pessoa atualmente numa linha da escala (para só verificar trocas). */
export async function escalaAssignmentEmployeeId(assignmentId: number): Promise<number | null> {
  const d = await db();
  const { extrasDiaAssignments } = await import("../drizzle/schema");
  const [row] = await d.select({ employeeId: extrasDiaAssignments.employeeId }).from(extrasDiaAssignments).where(eq(extrasDiaAssignments.id, assignmentId)).limit(1);
  return row?.employeeId ?? null;
}

// ─── Dashboard de conclusão ────────────────────────────────────────────────

export async function completionDashboard(filters: { city?: string | null; pathId?: number | null; targetRole?: string | null; employeeIds?: Set<number> | null } = {}, now: Date = new Date()) {
  const d = await db();
  const allRows = await d.select({
    id: trainingAssignments.id, employeeId: trainingAssignments.employeeId, status: trainingAssignments.status,
    dueAt: trainingAssignments.dueAt, completedAt: trainingAssignments.completedAt, assignedAt: trainingAssignments.assignedAt,
    pathId: trainingPaths.id, pathName: trainingPaths.name, targetRole: trainingPaths.targetRole,
    fullName: employees.fullName, position: employees.position, projectId: employees.projectId,
  }).from(trainingAssignments)
    .innerJoin(trainingPaths, eq(trainingPaths.id, trainingAssignments.pathId))
    .innerJoin(employees, eq(employees.id, trainingAssignments.employeeId))
    .where(and(eq(employees.isActive, 1), projectScope(employees.projectId),
      filters.pathId ? eq(trainingPaths.id, filters.pathId) : undefined,
      filters.targetRole ? eq(trainingPaths.targetRole, filters.targetRole) : undefined));
  // team_leader: só a equipa (o chamador passa as fichas permitidas).
  const rows = filters.employeeIds ? allRows.filter(r => filters.employeeIds!.has(r.employeeId)) : allRows;
  const { resolveCitiesForEmployeeIds } = await import("./employeeCity");
  const cities = await resolveCitiesForEmployeeIds(Array.from(new Set(rows.map(r => r.employeeId))));
  const list = rows.map(r => {
    const city = cities.get(r.employeeId)?.city ?? null;
    const status = r.status === "completed" ? "completed" : (r.dueAt && parseDbDate(r.dueAt).getTime() < now.getTime() ? "overdue" : r.status);
    return { ...r, city, status, daysLate: status === "overdue" ? daysLate(r.dueAt, now) : 0 };
  }).filter(r => !filters.city || r.city === filters.city);

  const groups = new Map<string, { city: string | null; targetRole: string | null; pathId: number; pathName: string; assigned: number; completed: number; overdue: number; pct: number }>();
  for (const r of list) {
    const key = `${r.city ?? "-"}|${r.pathId}`;
    const g = groups.get(key) ?? { city: r.city, targetRole: r.targetRole, pathId: r.pathId, pathName: r.pathName, assigned: 0, completed: 0, overdue: 0, pct: 0 };
    g.assigned++;
    if (r.status === "completed") g.completed++;
    if (r.status === "overdue") g.overdue++;
    groups.set(key, g);
  }
  const summary = Array.from(groups.values()).map(g => ({ ...g, pct: g.assigned ? Math.round(g.completed * 100 / g.assigned) : 0 }))
    .sort((a, b) => (a.city ?? "").localeCompare(b.city ?? "") || a.pathName.localeCompare(b.pathName));
  const overdue = list.filter(r => r.status === "overdue").sort((a, b) => b.daysLate - a.daysLate)
    .map(r => ({ assignmentId: r.id, employeeId: r.employeeId, fullName: r.fullName, pathName: r.pathName, dueAt: r.dueAt, daysLate: r.daysLate, city: r.city }));

  const totals = {
    assigned: list.length,
    completed: list.filter(r => r.status === "completed").length,
    overdue: overdue.length,
  };
  return { totals: { ...totals, pct: totals.assigned ? Math.round(totals.completed * 100 / totals.assigned) : 0 }, summary, overdue, assignments: list };
}

// ─── Automação (cron horário) ─────────────────────────────────────────────

function appOrigin(): string {
  return (process.env.APP_URL || process.env.PUBLIC_APP_URL || "https://dashboard.multipark.pt").replace(/\/+$/, "");
}

export interface TrainingAutomationReport { skipped?: string; overdueMarked: number; reminded: number; emailed: number; escalated: number; recert: number }

/**
 * Chamado de hora a hora (runExtrasAutomation). De dia (Lisboa):
 *  - marca atribuições em atraso;
 *  - lembrete (in-app + email) às que vencem em ≤2 dias ou estão em atraso,
 *    no máximo 1×/dia por atribuição (`lastReminderAt`);
 *  - 3 dias em atraso → avisa backoffice/supervisão (1×, `escalatedAt`);
 *  - certificados expirados → atribui a recertificação.
 */
export async function runTrainingAutomation(now: Date, hour: number): Promise<TrainingAutomationReport> {
  const report: TrainingAutomationReport = { overdueMarked: 0, reminded: 0, emailed: 0, escalated: 0, recert: 0 };
  if (!trainingRemindersEnabled()) return { ...report, skipped: "TRAINING_REMINDERS=off" };
  if (!isReminderHour(hour)) return { ...report, skipped: "fora de horas" };
  const d = await db();
  const nowDb = toDbDate(now);

  const marked = await d.update(trainingAssignments).set({ status: "overdue" })
    .where(and(sql`${trainingAssignments.status} IN ('assigned','in_progress')`, sql`${trainingAssignments.dueAt} < ${nowDb}`));
  report.overdueMarked = affected(marked);

  const open = await d.select({
    id: trainingAssignments.id, status: trainingAssignments.status, dueAt: trainingAssignments.dueAt,
    lastReminderAt: trainingAssignments.lastReminderAt, escalatedAt: trainingAssignments.escalatedAt,
    employeeId: trainingAssignments.employeeId, pathName: trainingPaths.name,
    fullName: employees.fullName, userId: employees.userId, email: employees.email, personalEmail: employees.personalEmail,
    projectId: employees.projectId,
  }).from(trainingAssignments)
    .innerJoin(trainingPaths, eq(trainingPaths.id, trainingAssignments.pathId))
    .innerJoin(employees, eq(employees.id, trainingAssignments.employeeId))
    .where(and(sql`${trainingAssignments.status} <> 'completed'`, eq(trainingPaths.active, 1), eq(employees.isActive, 1)));

  const { remind, escalate } = selectReminders(open, now);
  const byId = new Map(open.map(o => [o.id, o]));
  const { notify } = await import("./notify");
  const { sendEmail, isSmtpConfigured } = await import("./_core/notification");
  const smtp = isSmtpConfigured();
  const link = `${appOrigin()}/formacao`;
  for (const id of remind) {
    const a = byId.get(id)!;
    const late = daysLate(a.dueAt, now);
    const body = late > 0
      ? `A formação "${a.pathName}" está em atraso há ${late} dia(s). Conclui-a em ${link}`
      : `A formação "${a.pathName}" termina a ${lisbonDay(parseDbDate(a.dueAt!))}. Conclui-a em ${link}`;
    if (a.userId) {
      await notify({ kind: "my_training", targetUserId: a.userId, title: `Formação por concluir — ${a.pathName}`, body, link: "/formacao", entity: { type: "training_assignment", id: a.id } });
    }
    const to = a.email || a.personalEmail;
    if (to && smtp) {
      try {
        const ok = await sendEmail({
          to, subject: `Formação por concluir — ${a.pathName}`,
          text: `Olá ${a.fullName.split(" ")[0]},\n\n${body}\n\nObrigado,\nMultipark`,
          html: `<p>Olá ${escapeHtml(a.fullName.split(" ")[0])},</p><p>${escapeHtml(body.replace(` Conclui-a em ${link}`, ""))}</p><p><a href="${link}">Abrir a Formação</a></p><p>Obrigado,<br>Multipark</p>`,
        });
        if (ok) report.emailed++;
      } catch { /* segue */ }
    }
    await d.update(trainingAssignments).set({ lastReminderAt: nowDb }).where(eq(trainingAssignments.id, id));
    report.reminded++;
  }
  if (escalate.length) {
    for (const id of escalate) {
      const a = byId.get(id)!;
      // Chefias DA CIDADE da pessoa (team leader/supervisor) + quem vê todas.
      await notify({
        kind: "training_overdue", projectId: a.projectId ?? null,
        title: `Formação em atraso: ${a.fullName}`, body: `"${a.pathName}" está em atraso há ${daysLate(a.dueAt, now)} dia(s).`, link: "/formacao",
        entity: { type: "training_assignment", id: a.id },
      });
      await d.update(trainingAssignments).set({ escalatedAt: nowDb }).where(eq(trainingAssignments.id, id));
      report.escalated++;
    }
  }

  report.recert = await assignRecertifications(now);
  return report;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** Percurso de recertificação de um exame (criado on-demand, 1 por exame). */
export async function recertPathFor(examId: number): Promise<number> {
  const d = await db();
  const [exam] = await d.select().from(careerExams).where(eq(careerExams.id, examId)).limit(1);
  if (!exam) throw new Error("Exame não encontrado.");
  const name = `Recertificação — ${exam.title}`.slice(0, 255);
  const [existing] = await d.select({ id: trainingPaths.id }).from(trainingPaths).where(eq(trainingPaths.name, name)).limit(1);
  if (existing) return existing.id;
  const r = await d.insert(trainingPaths).values({
    name, description: "Atribuído automaticamente quando o certificado expira.", targetRole: null, city: null,
    active: 1, isDefaultOnboarding: 0, blocksEscala: 0, dueDays: 14,
  });
  const id = insertId(r);
  await d.insert(trainingPathItems).values({ pathId: id, itemType: "exam", itemId: examId, sortOrder: 0, required: 1 });
  return id;
}

/** Certificados expirados (o mais recente de cada pessoa+exame) → recertificação. */
export async function assignRecertifications(now: Date = new Date()): Promise<number> {
  const d = await db();
  const today = lisbonDay(now);
  const expired = await d.select().from(trainingCertificates)
    .where(and(isNull(trainingCertificates.recertAssignedAt), sql`${trainingCertificates.validUntil} IS NOT NULL`, sql`${trainingCertificates.validUntil} < ${today}`));
  let n = 0;
  for (const c of expired) {
    // Há um certificado mais recente e válido do mesmo exame? Então não.
    const [newer] = await d.select({ id: trainingCertificates.id }).from(trainingCertificates)
      .where(and(eq(trainingCertificates.employeeId, c.employeeId), eq(trainingCertificates.examId, c.examId), sql`${trainingCertificates.id} > ${c.id}`)).limit(1);
    if (!newer && certificateStatus(c.validUntil, now) === "expired") {
      try {
        const pathId = await recertPathFor(c.examId);
        await clearProgress(c.employeeId, "exam", c.examId);
        await assignPath(pathId, [c.employeeId], { source: "recert", reset: true, now });
        n++;
      } catch (err: any) {
        console.warn("[Training] recertificação falhou:", String(err?.message ?? err).slice(0, 160));
        continue;
      }
    }
    await d.update(trainingCertificates).set({ recertAssignedAt: toDbDate(now) }).where(eq(trainingCertificates.id, c.id));
  }
  return n;
}

// ─── Categorias: uso (para recusar apagar categorias com conteúdo) ─────────

export async function categoryUsage(categoryId: number) {
  const d = await db();
  const count = async (t: any) => Number((await d.select({ n: sql<number>`COUNT(*)` }).from(t).where(eq(t.categoryId, categoryId)))[0]?.n ?? 0);
  const [videos, manuals, faqCount, questions] = await Promise.all([count(trainingVideos), count(trainingManuals), count(faqs), count(quizQuestions)]);
  return { videos, manuals, faqs: faqCount, questions, total: videos + manuals + faqCount + questions };
}
