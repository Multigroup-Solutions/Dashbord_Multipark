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
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { getDb, getDocumentChecklistForEmployee, getPayrollData, toMysqlDateTime } from "./db";
import { employeeLeaves, employeePenalties, employees, extrasDiaAssignments, payrollRunLines, payrollRuns, timeRecords } from "../drizzle/schema";
import { manualBlockReason } from "../shared/suspendSuggest";
import { isTerminalExtra } from "../shared/terminalSession";

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
  // 41a: o motivo manual (ex.: suspensão) sai do texto guardado sem os outros motivos nem o sufixo
  if (e.blockedManually) reasons.push(manualBlockReason(e.loginBlockedReason));
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
  // 1.º aviso (14 dias): RH da cidade (backoffice/supervisor) + a própria pessoa.
  if (patch.docsWarningAt) await notifyDocsMissing(employeeId, st.missingDocs, st.daysSinceStart);
  return getExtraDocsStatus(employeeId);
}

/** Avisos "documentos em falta" (1× por aviso: só quando docsWarningAt é gravado). Nunca lança. */
async function notifyDocsMissing(employeeId: number, missingDocs: string[], days: number): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    const [emp] = await db.select({ fullName: employees.fullName, userId: employees.userId, projectId: employees.projectId })
      .from(employees).where(eq(employees.id, employeeId)).limit(1);
    if (!emp) return;
    const list = missingDocs.slice(0, 6).join(", ") + (missingDocs.length > 6 ? "…" : "");
    const { notify } = await import("./notify");
    const entity = { type: "employee_docs", id: employeeId };
    await notify({
      kind: "rh_docs_missing", projectId: emp.projectId ?? null,
      title: `Documentos em falta: ${emp.fullName}`, body: `Há ${days} dias sem: ${list}.`, link: "/rh", entity,
    });
    if (emp.userId) {
      await notify({
        kind: "my_docs_missing", targetUserId: emp.userId,
        title: "Tens documentos em falta", body: `Carrega na tua ficha: ${list}.`, link: "/perfil", entity,
      });
    }
  } catch (err) {
    console.warn("[docs] aviso de documentos em falta:", String((err as any)?.message ?? err).slice(0, 160));
  }
}

/** Semanal (trabalho rh-docs-weekly, segunda 04:45): aplica a regra documental a todos os extras ativos. */
export async function applyDocsComplianceAll(): Promise<{ checked: number }> {
  const db = await getDb();
  if (!db) return { checked: 0 };
  const rows = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.position, "extra"), eq(employees.isActive, 1)));
  for (const r of rows) { try { await applyDocsCompliance(r.id); } catch (err) { console.warn("[docs] compliance", r.id, err); } }
  return { checked: rows.length };
}

// ─── Faltas: "possível falta" pendente de validação ─────────────────────────
/**
 * Janela em que um check-in conta como presença num turno do extras-dia.
 * startHour/endHour podem passar das 24 (turnos da madrugada seguinte: 25 =
 * 01h do dia a seguir). Hora de Lisboa vs UTC do ponto: folga de 2 h antes do
 * início (1 h de fuso + 1 h para quem chega cedo) e 1 h depois do fim.
 */
export function noShowWindow(dateStr: string, startHour: number, endHour?: number | null): { from: Date; to: Date } {
  const base = new Date(`${dateStr}T00:00:00Z`).getTime();
  const H = 3600000;
  const end = endHour != null && endHour > startHour ? endHour : startHour + 8;
  return { from: new Date(base + (startHour - 2) * H), to: new Date(base + (end + 1) * H) };
}

/**
 * 41b: o que NÃO é uma possível falta. PURA.
 *  - turno só proposto (escala automática por confirmar) — ninguém foi chamado;
 *  - mandado para casa (sentHomeHour) — esteve lá;
 *  - picou o ponto no turno;
 *  - mexeu em carros na Multipark nesse dia (trabalhou sem picar o ponto).
 */
export type NoShowSkip = "proposed" | "sent_home" | "check_in" | "multipark";
export function noShowSkipReason(r: { status?: string | null; sentHomeHour?: number | null; hasCheckIn: boolean; multiparkMoves: number }): NoShowSkip | null {
  if (r.status != null && r.status !== "confirmed") return "proposed";
  if (r.sentHomeHour != null) return "sent_home";
  if (r.hasCheckIn) return "check_in";
  if (r.multiparkMoves > 0) return "multipark";
  return null;
}

/**
 * Plano 63, passo 2b (decidido: as faltas dos funcionários nunca bloqueiam):
 * os pontos de uma possível falta ao Extras-Dia. Extra (posto ou contrato
 * "extra", a mesma regra de isExtraEmployee) → 1 ponto (3 confirmados
 * bloqueiam a entrada na app, como sempre); funcionário escalado numa linha
 * normal (condutor com salário, back office…) → 0 pontos — a falta fica
 * marcada, sem pontos, como no horário fixo. As linhas de TL continuam sem
 * possível falta. Sem a ficha lida → 1, como antes. PURA.
 */
export function extraDiaNoShowPoints(e: { position?: string | null; contractType?: string | null } | null | undefined): 0 | 1 {
  if (!e) return 1;
  return isTerminalExtra(e) ? 1 : 0;
}

export interface NoShowReport { scanned: number; created: number; alreadyPending: number; skipped: Record<NoShowSkip, number>; multiparkRead: boolean }

/**
 * Extras escalados num dia sem check-in dentro da janela do turno → penalização PENDENTE
 * (não conta pontos, não bloqueia). Idempotente (UNIQUE employeeId+reason+relatedId).
 * 41b: fora os turnos só propostos, os mandados para casa e quem trabalhou na
 * Multipark nesse dia operacional (movimentos dos agentes da ficha, ao vivo).
 */
export async function detectExtraDiaNoShows(dateStr: string): Promise<NoShowReport> {
  const skipped: Record<NoShowSkip, number> = { proposed: 0, sent_home: 0, check_in: 0, multipark: 0 };
  const db = await getDb();
  if (!db) return { scanned: 0, created: 0, alreadyPending: 0, skipped, multiparkRead: false };
  const rows = await db.select({ id: extrasDiaAssignments.id, employeeId: extrasDiaAssignments.employeeId, personName: extrasDiaAssignments.personName, startHour: extrasDiaAssignments.startHour, endHour: extrasDiaAssignments.endHour, city: extrasDiaAssignments.city, status: extrasDiaAssignments.status, sentHomeHour: extrasDiaAssignments.sentHomeHour })
    .from(extrasDiaAssignments)
    .where(and(eq(extrasDiaAssignments.assignmentDate, dateStr), eq(extrasDiaAssignments.isTeamLeader, 0), isNotNull(extrasDiaAssignments.employeeId)));
  const candidates: typeof rows = [];
  for (const r of rows) {
    if (r.employeeId == null) continue;
    const early = noShowSkipReason({ status: r.status, sentHomeHour: r.sentHomeHour, hasCheckIn: false, multiparkMoves: 0 });
    if (early) { skipped[early]++; continue; }
    // check-in dentro da janela DESTE turno (antes: 00h–24h do dia, o que dava
    // falta falsa nos turnos da madrugada — startHour 24–26)
    const { from, to } = noShowWindow(dateStr, Number(r.startHour), r.endHour == null ? null : Number(r.endHour));
    const [ci] = await db.select({ id: timeRecords.id }).from(timeRecords)
      .where(and(eq(timeRecords.employeeId, r.employeeId), eq(timeRecords.type, "check_in"), gte(timeRecords.recordedAt, toMysqlDateTime(from)), lte(timeRecords.recordedAt, toMysqlDateTime(to)))).limit(1);
    if (ci) { skipped.check_in++; continue; }
    candidates.push(r);
  }
  // Movimentos na Multipark nesse dia operacional (só leitura). Sem BD → como antes, com nota.
  const movesByEmployee = new Map<number, number>();
  let multiparkRead = candidates.length === 0;
  if (candidates.length) {
    try {
      const { agentIdsOfEmployee } = await import("./personIdentity");
      const agentsOf = new Map<number, string[]>();
      for (const id of new Set(candidates.map((c) => Number(c.employeeId)))) agentsOf.set(id, (await agentIdsOfEmployee(id)).agentUserIds);
      const allIds = Array.from(new Set(Array.from(agentsOf.values()).flat()));
      if (!allIds.length) multiparkRead = true;
      else {
        const { getAgentMovementSummaries } = await import("./multiparkDb/movements");
        const live = await getAgentMovementSummaries({ startDay: dateStr, endDay: dateStr, byDay: false, userIds: allIds });
        if (live.available) {
          multiparkRead = true;
          const byAgent = new Map(live.data.map((s) => [s.agentUserId, s.total]));
          for (const [emp, ids] of agentsOf) movesByEmployee.set(emp, ids.reduce((n, id) => n + (byAgent.get(id) ?? 0), 0));
        }
      }
    } catch { /* sem identidade/Multipark: fica como antes */ }
  }
  // Plano 63 (2b): posto e contrato de cada um — o funcionário (não extra) fica com 0 pontos
  const kindOf = new Map<number, { position: string | null; contractType: string | null }>();
  const candIds = Array.from(new Set(candidates.map((c) => Number(c.employeeId)).filter((id) => Number.isFinite(id))));
  if (candIds.length) {
    for (const e of await db.select({ id: employees.id, position: employees.position, contractType: employees.contractType }).from(employees).where(inArray(employees.id, candIds))) {
      kindOf.set(Number(e.id), { position: e.position ?? null, contractType: e.contractType ?? null });
    }
  }
  let created = 0, alreadyPending = 0;
  for (const r of candidates) {
    if (r.employeeId == null) continue;
    if (noShowSkipReason({ status: r.status, sentHomeHour: r.sentHomeHour, hasCheckIn: false, multiparkMoves: movesByEmployee.get(r.employeeId) ?? 0 })) { skipped.multipark++; continue; }
    const points = extraDiaNoShowPoints(kindOf.get(r.employeeId));
    try {
      await db.insert(employeePenalties).values({
        employeeId: r.employeeId, reason: "no_show_extra_dia", severity: "penalty", points, relatedId: r.id, status: "pending",
        notes: `Possível falta ao extras-dia em ${dateStr} (${r.personName}, ${r.city}, ${r.startHour}h) — sem check-in no turno${multiparkRead ? " nem movimentos na Multipark" : " (movimentos da Multipark não lidos)"}${points === 0 ? " · funcionário: sem pontos" : ""}; confirmar com a operação`.slice(0, 512),
      });
      created++;
    } catch (err: any) {
      if (err?.code === "ER_DUP_ENTRY" || err?.cause?.code === "ER_DUP_ENTRY") { alreadyPending++; continue; }
      throw err;
    }
  }
  return { scanned: rows.length, created, alreadyPending, skipped, multiparkRead };
}

// ─── Tarefa 62 (Q8): possíveis faltas de quem tem horário fixo ─────────────

/** Interruptor (Definições → Automações; desligado por omissão, só o super admin). */
export const FIXED_SCHEDULE_NO_SHOWS_FLAG = "RH_FALTAS_HORARIO";
/** Marca no início das notas: é assim que a lista "Possíveis faltas" as distingue das outras penalizações "other". */
export const FIXED_NO_SHOW_NOTE_PREFIX = "[FALTA HORÁRIO]";
/** relatedId da penalização = o dia (AAAAMMDD): uma por pessoa e dia (índice único employeeId+reason+relatedId). */
export const fixedNoShowRelatedId = (day: string): number => Number(day.split("-").join(""));

export type FixedNoShowSkip = "escala" | "check_in" | "multipark";
/** `excluded`: quantas ficaram de fora pela lista "Fora das faltas automáticas" (rh.noShowSkip, plano 63 10a). */
export interface FixedNoShowReport { scanned: number; created: number; alreadyPending: number; skipped: Record<FixedNoShowSkip, number>; multiparkRead: boolean; excluded: number }

/**
 * Quem tinha horário fixo (RH → Horário; funcionários — os extras regem-se
 * pela escala e têm a sua deteção) num dia de trabalho e não picou a
 * entrada → "possível falta" PENDENTE na lista que já existe (RH →
 * Possíveis faltas), para alguém da operação confirmar ou dispensar. Fica
 * marcada como falta quando confirmada, SEM pontos de penalização (points 0:
 * não soma para o bloqueio das 3 faltas dos extras). Como nos extras: fora quem está na escala
 * do Extras-Dia nesse dia (tem a sua regra), as férias/baixas, os dias livres,
 * fora do contrato, os feriados (nacionais e o municipal da cidade da ficha) e
 * quem mexeu em carros na Multipark (trabalhou sem picar) e (plano 63, 10a)
 * quem está na lista "Fora das faltas automáticas" (`rh.noShowSkip`) até essa
 * data — ex.: quem ainda só pica na impressão digital.
 * Idempotente. Só corre com o interruptor RH_FALTAS_HORARIO ligado.
 */
export async function detectFixedScheduleNoShows(dateStr: string): Promise<FixedNoShowReport> {
  const skipped: Record<FixedNoShowSkip, number> = { escala: 0, check_in: 0, multipark: 0 };
  const db = await getDb();
  if (!db) return { scanned: 0, created: 0, alreadyPending: 0, skipped, multiparkRead: false, excluded: 0 };
  const { fixedScheduledStarts } = await import("../shared/workSchedule");
  const { NO_SHOW_SKIP_SETTING_KEY, noShowSkipFor } = await import("../shared/scheduleReview");
  const skipList = (await (await import("./appSettings")).getSetting(NO_SHOW_SKIP_SETTING_KEY)) ?? [];
  let excluded = 0;
  const { addDays } = await import("../shared/lisbonDay");
  const rowsOf = (res: unknown): any[] => (Array.isArray(res) ? (Array.isArray(res[0]) ? res[0] : res) : []) as any[];
  const scheduleRows = rowsOf(await db.execute(sql`
    SELECT s.id, s.employeeId, s.weekday, s.startTime, s.endTime, s.isWorkDay, e.projectId,
           DATE_FORMAT(e.contractStart, '%Y-%m-%d') AS contractStart, DATE_FORMAT(e.contractEnd, '%Y-%m-%d') AS contractEnd
      FROM schedules s JOIN employees e ON e.id = s.employeeId
     WHERE e.isActive = 1 AND s.isWorkDay = 1
       AND COALESCE(e.position, '') <> 'extra' AND COALESCE(e.contractType, '') <> 'extra'
     ORDER BY s.id`));
  // a cidade da ficha só serve para o feriado municipal (os nacionais ficam sempre fora)
  const cityOf: (projectId: number | null) => string | null = scheduleRows.length ? await (await import("./aiOps/cities")).projectCityResolver(db) : () => null;
  const schedules = scheduleRows.map((r) => ({
    id: r.id != null ? Number(r.id) : null, employeeId: Number(r.employeeId), weekday: Number(r.weekday), startTime: String(r.startTime ?? ""), endTime: r.endTime != null ? String(r.endTime) : null,
    isWorkDay: true, contractStart: r.contractStart ?? null, contractEnd: r.contractEnd ?? null,
    city: cityOf(r.projectId != null ? Number(r.projectId) : null),
  }));
  const leaves = rowsOf(await db.execute(sql`SELECT employeeId, fromDate, toDate FROM employee_leaves
     WHERE fromDate <= ${addDays(dateStr, 1)} AND toDate >= ${addDays(dateStr, -1)}`))
    .map((r) => ({ employeeId: Number(r.employeeId), fromDate: String(r.fromDate).slice(0, 10), toDate: String(r.toDate).slice(0, 10) }));
  const starts = fixedScheduledStarts(dateStr, dateStr, schedules, leaves);
  const escala = new Set((await db.select({ employeeId: extrasDiaAssignments.employeeId }).from(extrasDiaAssignments)
    .where(and(eq(extrasDiaAssignments.assignmentDate, dateStr), isNotNull(extrasDiaAssignments.employeeId)))).map((r) => Number(r.employeeId)));
  const candidates: typeof starts = [];
  for (const f of starts) {
    if (noShowSkipFor(skipList, f.employeeId, dateStr)) { excluded++; continue; }
    if (escala.has(f.employeeId)) { skipped.escala++; continue; }
    const from = new Date(f.startMs - 2 * 3_600_000), to = new Date((f.endMs ?? f.startMs + 9 * 3_600_000) + 3_600_000);
    const [ci] = await db.select({ id: timeRecords.id }).from(timeRecords)
      .where(and(eq(timeRecords.employeeId, f.employeeId), eq(timeRecords.type, "check_in"), gte(timeRecords.recordedAt, toMysqlDateTime(from)), lte(timeRecords.recordedAt, toMysqlDateTime(to)))).limit(1);
    if (ci) { skipped.check_in++; continue; }
    candidates.push(f);
  }
  // Mexeu em carros na Multipark nesse dia (só leitura): trabalhou sem picar. Sem BD → como nos extras, com nota.
  const movesByEmployee = new Map<number, number>();
  let multiparkRead = candidates.length === 0;
  if (candidates.length) {
    try {
      const { agentIdsOfEmployee } = await import("./personIdentity");
      const agentsOf = new Map<number, string[]>();
      for (const id of new Set(candidates.map((c) => c.employeeId))) agentsOf.set(id, (await agentIdsOfEmployee(id)).agentUserIds);
      const allIds = Array.from(new Set(Array.from(agentsOf.values()).flat()));
      if (!allIds.length) multiparkRead = true;
      else {
        const { getAgentMovementSummaries } = await import("./multiparkDb/movements");
        const live = await getAgentMovementSummaries({ startDay: dateStr, endDay: dateStr, byDay: false, userIds: allIds });
        if (live.available) {
          multiparkRead = true;
          const byAgent = new Map(live.data.map((s) => [s.agentUserId, s.total]));
          for (const [emp, ids] of agentsOf) movesByEmployee.set(emp, ids.reduce((n, id) => n + (byAgent.get(id) ?? 0), 0));
        }
      }
    } catch { /* sem identidade/Multipark: fica sem esta verificação (com nota) */ }
  }
  const hhmm = (ms: number) => new Intl.DateTimeFormat("pt-PT", { timeZone: "Europe/Lisbon", hour: "2-digit", minute: "2-digit" }).format(ms);
  let created = 0, alreadyPending = 0;
  for (const f of candidates) {
    if ((movesByEmployee.get(f.employeeId) ?? 0) > 0) { skipped.multipark++; continue; }
    try {
      await db.insert(employeePenalties).values({
        // points 0: marca a falta (Q8: "não vem: marca-se falta") sem somar pontos de penalização — nos extras, 3 pontos
        // confirmados bloqueiam a entrada na app; para quem tem horário fixo isso fica para o Jorge decidir
        employeeId: f.employeeId, reason: "other", severity: "penalty", points: 0, relatedId: fixedNoShowRelatedId(dateStr), status: "pending",
        notes: `${FIXED_NO_SHOW_NOTE_PREFIX} Possível falta em ${f.calendarDay} (horário ${hhmm(f.startMs)}${f.endMs ? `–${hhmm(f.endMs)}` : ""}) — sem entrada no ponto${multiparkRead ? " nem movimentos na Multipark" : " (movimentos da Multipark não lidos)"}; confirmar com a operação`.slice(0, 512),
      });
      created++;
    } catch (err: any) {
      if (err?.code === "ER_DUP_ENTRY" || err?.cause?.code === "ER_DUP_ENTRY") { alreadyPending++; continue; }
      throw err;
    }
  }
  return { scanned: starts.length, created, alreadyPending, skipped, multiparkRead, excluded };
}

/**
 * Possíveis faltas por validar, das cidades de quem vê (41b), com o TOTAL real
 * (antes o "(N)" parava nos 100 da lista).
 */
export async function listPendingPenalties(limit = 200) {
  const db = await getDb();
  if (!db) return { items: [], total: 0 };
  const { projectScope } = await import("./cityScope");
  const where = and(eq(employeePenalties.status, "pending"), projectScope(employees.projectId));
  const [agg] = await db.select({ n: sql<number>`COUNT(*)` }).from(employeePenalties).leftJoin(employees, eq(employees.id, employeePenalties.employeeId)).where(where);
  const items = await db.select({ penalty: employeePenalties, employee: { id: employees.id, fullName: employees.fullName, phone: employees.phone, projectId: employees.projectId } })
    .from(employeePenalties).leftJoin(employees, eq(employees.id, employeePenalties.employeeId))
    .where(where).orderBy(desc(employeePenalties.createdAt)).limit(limit);
  return { items, total: Number(agg?.n ?? 0) };
}

/** Pontos ABERTOS e CONFIRMADOS por colaborador (pendentes não contam). */
export async function confirmedOpenPoints(employeeId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const [agg] = await db.select({ total: sql<number>`COALESCE(SUM(${employeePenalties.points}), 0)` }).from(employeePenalties)
    .where(and(eq(employeePenalties.employeeId, employeeId), isNull(employeePenalties.clearedAt), eq(employeePenalties.status, "confirmed")));
  return Number(agg?.total ?? 0);
}

export async function reviewPenalty(id: number, decision: "confirmed" | "dismissed", reviewer: { id: number; role: string }, note?: string | null): Promise<{ points: number; blocked: boolean }> {
  const db = await getDb();
  if (!db) throw new Error("DB indisponível");
  const [p] = await db.select().from(employeePenalties).where(eq(employeePenalties.id, id)).limit(1);
  if (!p) throw new Error("Penalização não encontrada");
  // supervisor+, quem propôs não confirma, e só pessoas das cidades de quem revê
  const { penaltyReviewError } = await import("./rhAccess");
  const denied = penaltyReviewError({ reviewer, proposedById: (p as any).proposedById ?? null, decision });
  if (denied) throw new TRPCError({ code: "FORBIDDEN", message: denied });
  const { assertEmployeeAccess } = await import("./cityScope");
  await assertEmployeeAccess(p.employeeId);
  const reviewerId = reviewer.id;
  await db.update(employeePenalties).set({ status: decision, reviewedById: reviewerId, reviewedAt: nowMysql(), notes: note ? `${p.notes ?? ""} · revisão: ${note}`.slice(0, 512) : p.notes, clearedAt: decision === "dismissed" ? nowMysql() : p.clearedAt, clearedById: decision === "dismissed" ? reviewerId : p.clearedById })
    .where(eq(employeePenalties.id, id));
  const points = await confirmedOpenPoints(p.employeeId);
  const shouldBlock = points >= 3;
  await db.update(employees).set({ blockedByPenalties: shouldBlock ? 1 : 0 }).where(eq(employees.id, p.employeeId));
  const r = await recomputeLoginBlocked(p.employeeId);
  return { points, blocked: r.blocked };
}

/**
 * Plano 63 (10a): dispensar uma possível falta do HORÁRIO FIXO com motivo.
 * "Picou noutro sistema / picagem perdida" fica marcada para a verificação
 * do ponto (passo 0); "Férias", "Baixa" e "Falta justificada" criam a
 * ausência aprovada desse dia (employee_leaves; a mesma regra de quem a
 * lança na ficha), para não voltar a aparecer e para sair das horas
 * esperadas. Nada se apaga. As regras de quem revê são as de reviewPenalty,
 * verificadas ANTES de criar a ausência.
 */
export async function dismissFixedNoShow(id: number, reason: import("../shared/scheduleReview").FixedNoShowDismissReason, reviewer: { id: number; role: string }, note?: string | null): Promise<{ points: number; blocked: boolean; day: string | null; leaveId: number | null; leaveType: string | null; leaveAlready: boolean }> {
  const db = await getDb();
  if (!db) throw new Error("DB indisponível");
  const [p] = await db.select().from(employeePenalties).where(eq(employeePenalties.id, id)).limit(1);
  if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Possível falta não encontrada." });
  const { penaltyReviewError } = await import("./rhAccess");
  const denied = penaltyReviewError({ reviewer, proposedById: (p as any).proposedById ?? null, decision: "dismissed" });
  if (denied) throw new TRPCError({ code: "FORBIDDEN", message: denied });
  const { assertEmployeeAccess } = await import("./cityScope");
  await assertEmployeeAccess(p.employeeId);
  const { FIXED_NO_SHOW_DISMISS_LEAVE, fixedNoShowDismissPlan } = await import("../shared/scheduleReview");
  const existingLeaves = FIXED_NO_SHOW_DISMISS_LEAVE[reason]
    ? await db.select({ fromDate: employeeLeaves.fromDate, toDate: employeeLeaves.toDate }).from(employeeLeaves).where(eq(employeeLeaves.employeeId, p.employeeId))
    : [];
  const plan = fixedNoShowDismissPlan(p as any, reason, { notePrefix: FIXED_NO_SHOW_NOTE_PREFIX, existingLeaves, extraNote: note });
  if (!plan.ok) throw new TRPCError({ code: "BAD_REQUEST", message: plan.error });
  let leaveId: number | null = null;
  if (plan.leave) {
    const ins = await db.insert(employeeLeaves).values({ employeeId: p.employeeId, ...plan.leave, createdById: reviewer.id });
    leaveId = Number((ins as any)?.[0]?.insertId ?? 0) || null;
  }
  const r = await reviewPenalty(id, "dismissed", reviewer, plan.reviewNote);
  return { ...r, day: plan.day, leaveId, leaveType: plan.leave?.leaveType ?? null, leaveAlready: plan.leaveAlready };
}

// ─── Ponto: revisão de registos suspeitos ───────────────────────────────────
export async function listSuspiciousTimeRecords(opts: { employeeId?: number; limit?: number } = {}) {
  const db = await getDb();
  if (!db) return [];
  const conds: any[] = [eq(timeRecords.reviewStatus, "suspicious")];
  if (opts.employeeId) conds.push(eq(timeRecords.employeeId, opts.employeeId));
  // 41c: só as das cidades de quem vê (antes vinham as do país todo)
  const { projectScope } = await import("./cityScope");
  conds.push(projectScope(employees.projectId));
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

// ─── Ponto: terminal à mão (confirmar / desmarcar) ──────────────────────────
/**
 * Marca o troço de uma SAÍDA como terminal ("confirmed") ou desmarca-o
 * ("rejected"). Nada se apaga: fica o estado, quem, quando e o motivo.
 */
/**
 * Plano 56 B2: o turno de uma SAÍDA do ponto (a entrada anterior) e o estado
 * de terminal do método antigo, se houver. null = não é uma saída.
 */
export async function shiftOfCheckOut(id: number): Promise<{ employeeId: number; inAt: string | null; outAt: string; legacyStatus: string | null } | null> {
  const db = await getDb();
  if (!db) throw new Error("DB indisponível");
  const res: any = await db.execute(sql`
    SELECT o.employeeId, o.type, o.terminalStatus,
      DATE_FORMAT(o.recordedAt, '%Y-%m-%d %H:%i:%s') AS outAt,
      (SELECT DATE_FORMAT(MAX(i.recordedAt), '%Y-%m-%d %H:%i:%s') FROM time_records i
        WHERE i.employeeId = o.employeeId AND i.type = 'check_in' AND i.recordedAt < o.recordedAt) AS inAt
    FROM time_records o WHERE o.id = ${id} LIMIT 1`);
  const r = (Array.isArray(res) ? res[0] : res)?.[0];
  if (!r || String(r.type) !== "check_out") return null;
  const legacy = r.terminalStatus ? String(r.terminalStatus) : null;
  const { hasLegacyTerminal } = await import("../shared/pontoTerminal");
  return { employeeId: Number(r.employeeId), inAt: r.inAt ? String(r.inAt) : null, outAt: String(r.outAt), legacyStatus: hasLegacyTerminal(legacy) ? legacy : null };
}

export async function setTimeRecordTerminal(id: number, terminal: boolean, reviewerId: number, note: string): Promise<{ ok: true; status: "confirmed" | "rejected"; previous: string | null } | { ok: false; error: string }> {
  const db = await getDb();
  if (!db) throw new Error("DB indisponível");
  const [rec] = await db.select({ id: timeRecords.id, type: timeRecords.type, terminalStatus: timeRecords.terminalStatus })
    .from(timeRecords).where(eq(timeRecords.id, id)).limit(1);
  if (!rec) return { ok: false, error: "Registo de ponto não encontrado" };
  if (rec.type !== "check_out") return { ok: false, error: "O terminal marca-se na saída (o troço só fecha na saída)." };
  const status = terminal ? "confirmed" as const : "rejected" as const;
  await db.update(timeRecords).set({
    terminalStatus: status,
    terminalReviewedById: reviewerId,
    terminalReviewedAt: nowMysql(),
    terminalNote: note.slice(0, 255),
  }).where(eq(timeRecords.id, id));
  return { ok: true, status, previous: rec.terminalStatus ?? null };
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
  return { run, lines: lines.map((l) => ({ ...l, snapshot: payrollSnapshotForRead(safeJson(l.snapshot)) })) };
}
function safeJson(s: string) { try { return JSON.parse(s); } catch { return null; } }

/** Dados de identificação/bancários que o snapshot de um fecho guarda mas que nenhum ecrã do fecho usa. */
const SNAPSHOT_HIDDEN_FIELDS = ["nif", "nib"] as const;
/**
 * Snapshot de uma linha do fecho tal como sai para o cliente: o fecho guarda
 * tudo (nada se apaga), mas NIF e NIB não saem ao ler — servem à folha e aos
 * recibos, não ao fecho (decisão Jorge, 1 out 2026). PURA.
 */
export function payrollSnapshotForRead<T>(snapshot: T): T {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return snapshot;
  const out: Record<string, unknown> = { ...(snapshot as Record<string, unknown>) };
  for (const f of SNAPSHOT_HIDDEN_FIELDS) delete out[f];
  return out as T;
}

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

/** Teto da leitura do Zello no check-out (a saída já está gravada; o resto espera no máximo isto). */
export const CHECKOUT_ZELLO_CAP_MS = 20_000;

/**
 * Retrato do Zello do turno (km, velocidades, minutos com o Zello ligado e
 * desligado) junto à SAÍDA já gravada. Corre DEPOIS de gravar a saída e as
 * horas: um Zello lento ou um corte de 60 s nunca perdem a saída (antes lia-se
 * o Zello primeiro, até 15 s por chamada). Só preenche uma saída que ainda não
 * tem o retrato (`zelloKm` vazio): repetir não muda nada, nunca cria outra
 * saída e nunca mexe nas horas. Melhor esforço: nunca lança.
 */
export async function attachZelloToCheckOut(o: { recordId: number; employeeId: number; inAt: Date; outAt: Date }): Promise<import("./zello").ZelloShiftSummary | null> {
  if (!(o.recordId > 0)) return null;
  try {
    const { resolveZelloUsernameForShift } = await import("./db");
    // o PDA em que a pessoa picou nesse turno; senão a ligação fixa da ficha (telemóveis pessoais)
    const username = await resolveZelloUsernameForShift(o.employeeId, o.inAt, o.outAt);
    if (!username) return null;
    const { summarizeZelloShift } = await import("./zello");
    const z = await summarizeZelloShift(username, o.inAt, o.outAt);
    if (!z) return null;
    const db = await getDb();
    if (!db) return z;
    await db.update(timeRecords).set({
      zelloKm: String(z.km),
      zelloAvgSpeed: String(z.avgSpeed),
      zelloMaxSpeed: String(z.maxSpeed),
      zelloOfflineMinutes: z.offlineMinutes,
      zelloOnlineMinutes: z.onlineMinutes,
    }).where(and(eq(timeRecords.id, o.recordId), eq(timeRecords.employeeId, o.employeeId), eq(timeRecords.type, "check_out"), isNull(timeRecords.zelloKm)));
    return z;
  } catch (err) {
    console.warn("[checkOut] retrato do Zello não junto à saída (a saída está gravada):", String((err as Error)?.message ?? err).slice(0, 160));
    return null;
  }
}

/** Espera por `p` no máximo `ms`; depois disso devolve `fallback` (a promessa continua sozinha). */
export async function withCap<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); (timer as any)?.unref?.(); });
  try { return await Promise.race([p, cap]); } finally { if (timer) clearTimeout(timer); }
}
