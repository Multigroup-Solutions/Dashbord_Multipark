/**
 * Mapa de férias (plano 63, passo 11) — leituras e escritas com BD. As regras
 * puras (validação, quem vê o quê, quem aprova quem) estão em
 * shared/leaves.ts; os leitores que CONTAM ausências (folha, Avaliação,
 * faltas) usam approvedLeaveSql (server/leavesSql.ts).
 *
 * Este módulo lê TODOS os estados de propósito (é o mapa: pedidos, recusas e
 * cancelamentos aparecem a quem os pode ver), por isso está na lista de
 * exceções do teste dos leitores.
 *
 * Nada se apaga: cancelar muda o estado. Um mês fechado (ordenado aprovado
 * ou pago) não muda. Avisos só com FERIAS_AVISOS (e o FERIAS_MAPA) ligado.
 */
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { getDb, getEmployeeById, getEmployeeByUserId, logActivity } from "./db";
import { scopedProjectIds } from "./cityScope";
import {
  DEFAULT_VACATION_APPROVALS, DEFAULT_VACATION_DAYS_PER_YEAR, FERIAS_AVISOS_FLAG, FERIAS_MAPA_FLAG, HR_PEOPLE_KEY, LEAVE_STATUS_LABELS, LEAVE_TYPE_LABELS,
  LEAVES_VIEW_ALL_KEY, PARTNER_COMPANY_CONTRACT, VACATION_APPROVALS_KEY, VACATION_DAYS_PER_YEAR_KEY,
  blocksAutoProposal, cancelLeaveError, closedMonthMessage, closedMonthOfPeriod, decideLeaveError, isActiveLeave, launchApprovedVacationError, leaveForViewer, leaveInputError,
  leaveViewerMode, parseApproverIds, periodsOverlap, shortDayPt, vacationApproversFor, vacationDaysInYear, workingDaysIn,
  type ApproverCandidate, type ApproversResult, type LeaveType, type LeaveTypeShown, type LeaveViewerMode, type VacationApprovals,
} from "../shared/leaves";
import { lisbonDayOf } from "../shared/lisbonDay";

const rowsOf = (res: unknown): any[] => (Array.isArray(res) ? (Array.isArray(res[0]) ? res[0] : res) : []) as any[];
const str = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 19).replace("T", " ") : String(v));
const nowSql = () => new Date().toISOString().slice(0, 19).replace("T", " ");

async function db() {
  const d = await getDb();
  if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "BD indisponível. Tenta de novo daqui a pouco." });
  return d;
}

// ─── Interruptores e definições ─────────────────────────────────────────────

async function flagOn(name: string): Promise<boolean> {
  const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([import("./_core/featureFlags"), import("../shared/appSettings")]);
  await ensureFeatureFlagOverrides();
  return isFeatureEnabled(name, { defaultEnabled: automationFlagDefault(name) });
}
export const feriasMapaOn = () => flagOn(FERIAS_MAPA_FLAG);
export const feriasAvisosOn = async () => (await flagOn(FERIAS_MAPA_FLAG)) && (await flagOn(FERIAS_AVISOS_FLAG));

export const MAP_OFF_MESSAGE = "O mapa de férias ainda está desligado (Definições → Automações → \"RH: mapa de férias e pedidos\").";
export async function assertMapOn(): Promise<void> {
  if (!(await feriasMapaOn())) throw new TRPCError({ code: "PRECONDITION_FAILED", message: MAP_OFF_MESSAGE });
}

export interface LeaveSettings { rules: VacationApprovals; hrPeople: number[]; viewAll: number[]; daysPerYear: number }

export async function loadLeaveSettings(): Promise<LeaveSettings> {
  const { getSetting } = await import("./appSettings");
  const [rules, hr, all, days] = await Promise.all([
    getSetting(VACATION_APPROVALS_KEY), getSetting(HR_PEOPLE_KEY), getSetting(LEAVES_VIEW_ALL_KEY), getSetting(VACATION_DAYS_PER_YEAR_KEY),
  ]);
  return {
    rules: (rules as VacationApprovals | null) ?? DEFAULT_VACATION_APPROVALS,
    hrPeople: ((hr as number[] | null) ?? []).map(Number),
    viewAll: ((all as number[] | null) ?? []).map(Number),
    daysPerYear: typeof days === "number" ? days : DEFAULT_VACATION_DAYS_PER_YEAR,
  };
}

// ─── Cidades ─────────────────────────────────────────────────────────────────

async function cityResolver(): Promise<(projectId: number | null | undefined) => string | null> {
  const { projectCityResolver } = await import("./aiOps/cities");
  return projectCityResolver(await db());
}

// ─── Quem está a ver ─────────────────────────────────────────────────────────

export interface LeaveViewer {
  userId: number;
  role: string;
  mode: LeaveViewerMode;
  employeeId: number | null;
  fullName: string | null;
  position: string | null;
  projectId: number | null;
  city: string | null;
  isExtra: boolean;
  isPartner: boolean;
  isActive: boolean;
  /** contas (logins) da ficha de quem vê */
  logins: number[];
  /** supervisor: os centros da sua área (null = todas as cidades) */
  scopeProjectIds: number[] | null;
  settings: LeaveSettings;
}

export async function employeeLogins(employeeId: number): Promise<number[]> {
  const { listEmployeeLogins } = await import("./personIdentity");
  return (await listEmployeeLogins(employeeId).catch(() => [])).map((l) => l.userId);
}

export async function resolveLeaveViewer(user: { id: number; role: string }): Promise<LeaveViewer> {
  const [me, settings, cityOf] = await Promise.all([getEmployeeByUserId(user.id), loadLeaveSettings(), cityResolver()]);
  const e = me?.employee ?? null;
  const isExtra = !!e && (e.position === "extra" || e.contractType === "extra");
  const logins = e ? Array.from(new Set([user.id, ...(await employeeLogins(e.id))])) : [user.id];
  const mode = leaveViewerMode({ role: user.role, userId: user.id, hasEmployee: !!e, isExtra, viewAll: settings.viewAll, hrPeople: settings.hrPeople });
  return {
    userId: user.id, role: user.role, mode,
    employeeId: e?.id ?? null, fullName: e?.fullName ?? null, position: e?.position ?? null,
    projectId: e?.projectId ?? null, city: cityOf(e?.projectId ?? null),
    isExtra, isPartner: e?.contractType === PARTNER_COMPANY_CONTRACT, isActive: !!e && Number(e.isActive) === 1,
    logins,
    scopeProjectIds: mode === "supervisor" ? (scopedProjectIds() ?? null) : null,
    settings,
  };
}

// ─── Linhas ──────────────────────────────────────────────────────────────────

export interface LeaveDbRow {
  id: number;
  employeeId: number;
  leaveType: LeaveType;
  status: string;
  fromDate: string;
  toDate: string;
  hours: number | null;
  notes: string | null;
  decisionNote: string | null;
  requestedById: number | null;
  requestedAt: string | null;
  decidedById: number | null;
  decidedAt: string | null;
  approverUserIds: number[];
  cancelledById: number | null;
  cancelledAt: string | null;
  createdById: number | null;
  createdAt: string | null;
}

const LEAVE_COLUMNS = sql.raw("l.id, l.employeeId, l.leaveType, l.status, l.fromDate, l.toDate, l.hours, l.notes, l.decisionNote, l.requestedById, l.requestedAt, l.decidedById, l.decidedAt, l.approverUserIds, l.cancelledById, l.cancelledAt, l.createdById, l.createdAt");

function toRow(r: any): LeaveDbRow {
  const h = r.hours == null || r.hours === "" ? null : Number(r.hours);
  return {
    id: Number(r.id), employeeId: Number(r.employeeId), leaveType: String(r.leaveType) as LeaveType, status: String(r.status ?? "approved"),
    fromDate: String(r.fromDate).slice(0, 10), toDate: String(r.toDate).slice(0, 10), hours: h != null && Number.isFinite(h) ? h : null,
    notes: r.notes ?? null, decisionNote: r.decisionNote ?? null,
    requestedById: r.requestedById == null ? null : Number(r.requestedById), requestedAt: str(r.requestedAt),
    decidedById: r.decidedById == null ? null : Number(r.decidedById), decidedAt: str(r.decidedAt),
    approverUserIds: parseApproverIds(r.approverUserIds),
    cancelledById: r.cancelledById == null ? null : Number(r.cancelledById), cancelledAt: str(r.cancelledAt),
    createdById: r.createdById == null ? null : Number(r.createdById), createdAt: str(r.createdAt),
  };
}

export async function loadLeave(id: number): Promise<LeaveDbRow | null> {
  const r = rowsOf(await (await db()).execute(sql`SELECT ${LEAVE_COLUMNS} FROM employee_leaves l WHERE l.id = ${id} LIMIT 1`))[0];
  return r ? toRow(r) : null;
}

async function leavesOf(employeeIds: readonly number[], from: string, to: string, statuses: readonly string[] | null): Promise<LeaveDbRow[]> {
  const ids = Array.from(new Set(employeeIds.filter((x) => Number.isInteger(x) && x > 0)));
  if (!ids.length) return [];
  const st = statuses ? sql` AND l.status IN (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})` : sql``;
  const out: LeaveDbRow[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = rowsOf(await (await db()).execute(sql`SELECT ${LEAVE_COLUMNS} FROM employee_leaves l
       WHERE l.employeeId IN (${sql.join(chunk.map((id) => sql`${id}`), sql`, `)}) AND l.fromDate <= ${to} AND l.toDate >= ${from}${st}
       ORDER BY l.fromDate, l.id`));
    out.push(...rows.map(toRow));
  }
  return out;
}

// ─── Mês fechado ─────────────────────────────────────────────────────────────

/** Recusa se o período tocar um mês fechado (ou se não der para o confirmar). */
export async function assertPeriodOpen(p: { fromDate: string; toDate: string }): Promise<void> {
  let closed: Set<string>;
  try {
    closed = await (await import("./terminalPay")).closedPayrollMonthKeys();
  } catch {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Não deu para confirmar se o mês está fechado: nada foi gravado. Tenta de novo daqui a pouco." });
  }
  const m = closedMonthOfPeriod(p, closed);
  if (m) throw new TRPCError({ code: "PRECONDITION_FAILED", message: closedMonthMessage(m) });
}

// ─── Quem aprova ─────────────────────────────────────────────────────────────

/** A conta como candidata a aprovar (o supervisor com as cidades que cobre). */
async function approverCandidate(r: { id: number; role: string; isActive: boolean }): Promise<ApproverCandidate> {
  const u: ApproverCandidate = { id: r.id, role: r.role, isActive: r.isActive };
  if (u.role === "supervisor") {
    const { loadCityAccessParts } = await import("./cityAccess");
    const { opsCityOf } = await import("./aiOps/cities");
    try {
      const { access } = await loadCityAccessParts(u.id, "supervisor");
      u.cities = access.all ? "all" : (access.cityNames ?? (access.cityName ? [access.cityName] : [])).map((n) => opsCityOf(n)).filter((c): c is NonNullable<typeof c> => !!c);
    } catch { u.cities = []; }
  }
  return u;
}

/** As contas que podem aprovar as férias desta ficha (regras de agora). */
export async function approversForEmployee(employeeId: number, settings?: LeaveSettings): Promise<ApproversResult & { requesterUserIds: number[]; city: string | null }> {
  const s = settings ?? (await loadLeaveSettings());
  const [emp, logins, cityOf] = await Promise.all([getEmployeeById(employeeId), employeeLogins(employeeId), cityResolver()]);
  if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "Ficha não encontrada." });
  const city = cityOf(emp.employee.projectId ?? null);
  const explicit = Array.from(new Set([
    ...s.hrPeople, ...s.rules.hrPeople.userIds,
    ...Object.values(s.rules.positions).flatMap((r) => r?.userIds ?? []),
    ...s.rules.people.flatMap((p) => p.userIds),
  ].filter((n) => Number.isInteger(n) && n > 0)));
  const rows = rowsOf(await (await db()).execute(sql`SELECT id, role, isActive FROM users
     WHERE isActive = 1 AND (role IN ('supervisor', 'super_admin')${explicit.length ? sql` OR id IN (${sql.join(explicit.map((id) => sql`${id}`), sql`, `)})` : sql``})`));
  const users: ApproverCandidate[] = [];
  for (const r of rows) users.push(await approverCandidate({ id: Number(r.id), role: String(r.role), isActive: Number(r.isActive) === 1 }));
  const requesterUserIds = Array.from(new Set([...(emp.employee.userId ? [Number(emp.employee.userId)] : []), ...logins]));
  const res = vacationApproversFor({ employeeId, position: emp.employee.position ?? null, city, userIds: requesterUserIds }, s.rules, users, s.hrPeople);
  return { ...res, requesterUserIds, city };
}

/**
 * Pode lançar FÉRIAS já aprovadas a esta ficha? (shared/leaves.ts →
 * launchApprovedVacationError: quem as aprova, o RH ou o super admin; as
 * próprias não.) Lança FORBIDDEN com o motivo.
 */
export async function assertCanLaunchApprovedVacation(user: { id: number; role: string }, employeeId: number, principalUserId?: number | null): Promise<void> {
  if (user.role === "super_admin") return;
  // a conta principal da ficha: quem chama já a tem (senão lê-se a ficha)
  const principal = principalUserId !== undefined ? principalUserId : ((await getEmployeeById(employeeId))?.employee?.userId ?? null);
  const [logins, me] = await Promise.all([employeeLogins(employeeId), getEmployeeByUserId(user.id)]);
  const own = logins.includes(user.id) || me?.employee?.id === employeeId || (principal != null && Number(principal) === user.id);
  // mapa desligado: como antes (só as próprias não) — não se leem regras nem contas
  const mapOn = !own && (await feriasMapaOn());
  const s = mapOn ? await loadLeaveSettings() : null;
  // o RH não precisa de ler as regras; os outros têm de estar entre quem aprova (regras de agora)
  const approverUserIds = !s || s.hrPeople.includes(user.id) ? [] : (await approversForEmployee(employeeId, s)).userIds;
  const err = launchApprovedVacationError({ actorUserId: user.id, actorRole: user.role, own, mapOn, hrPeople: s?.hrPeople ?? [], approverUserIds });
  if (err) throw new TRPCError({ code: "FORBIDDEN", message: err });
}

/**
 * Para o ecrã de lançar: a que fichas ESTA conta pode lançar férias já
 * aprovadas (o servidor volta a confirmar ao gravar). Uma só leitura das
 * regras e das contas: basta saber se a conta que lança está entre quem
 * aprova cada ficha, por isso a lista de candidatas é só ela.
 */
export async function vacationLaunchableIds(user: { id: number; role: string }, people: ReadonlyArray<{ id: number; position: string | null; projectId: number | null; userId: number | null }>): Promise<Set<number>> {
  const out = new Set<number>();
  if (!people.length) return out;
  const mapOn = await feriasMapaOn();
  const s = await loadLeaveSettings();
  const [me, cityOf, actor] = await Promise.all([getEmployeeByUserId(user.id), cityResolver(), approverCandidate({ id: user.id, role: user.role, isActive: true })]);
  // contas extra das fichas que importam aqui: as do RH (a regra do RH ganha ao posto) e a de quem lança (as próprias não)
  const relevant = Array.from(new Set([...s.hrPeople, user.id]));
  const extra = new Map<number, number[]>();
  try {
    const rows = rowsOf(await (await db()).execute(sql`SELECT employeeId, userId FROM employee_accounts WHERE userId IN (${sql.join(relevant.map((id) => sql`${id}`), sql`, `)})`));
    for (const r of rows) extra.set(Number(r.employeeId), [...(extra.get(Number(r.employeeId)) ?? []), Number(r.userId)]);
  } catch { /* sem contas extra: só a principal */ }
  for (const p of people) {
    const userIds = Array.from(new Set([...(p.userId != null ? [Number(p.userId)] : []), ...(extra.get(p.id) ?? [])]));
    const own = me?.employee?.id === p.id || userIds.includes(user.id);
    const approverUserIds = own || !mapOn || user.role === "super_admin" || s.hrPeople.includes(user.id) ? []
      : vacationApproversFor({ employeeId: p.id, position: p.position, city: cityOf(p.projectId), userIds }, s.rules, [actor], s.hrPeople).userIds;
    if (!launchApprovedVacationError({ actorUserId: user.id, actorRole: user.role, own, mapOn, hrPeople: s.hrPeople, approverUserIds })) out.add(p.id);
  }
  return out;
}

// ─── Avisos (FERIAS_AVISOS) ──────────────────────────────────────────────────

const period = (l: { fromDate: string; toDate: string; hours?: number | null }) =>
  l.fromDate === l.toDate ? `${shortDayPt(l.fromDate)}${l.hours ? ` (${String(l.hours).replace(".", ",")} h)` : ""}` : `${shortDayPt(l.fromDate)} a ${shortDayPt(l.toDate)}`;

/** "Férias, 21/12 a 24/12 (por aprovar)" — a ausência que já ocupa esses dias. */
const clashText = (l: { leaveType: LeaveType; status: string; fromDate: string; toDate: string; hours?: number | null }) =>
  `${LEAVE_TYPE_LABELS[l.leaveType]}, ${period(l)} (${(LEAVE_STATUS_LABELS[l.status as keyof typeof LEAVE_STATUS_LABELS] ?? l.status).toLowerCase()})`;

async function notifySafe(input: Parameters<typeof import("./notify").notify>[0]): Promise<void> {
  try {
    if (!(await feriasAvisosOn())) return;
    const { notify } = await import("./notify");
    await notify(input);
  } catch (err: any) {
    console.warn("[férias] aviso não enviado:", String(err?.message ?? err).slice(0, 160));
  }
}

// ─── O mapa ──────────────────────────────────────────────────────────────────

export type MapCity = "lisbon" | "porto" | "faro";
export interface MapPerson { id: number; fullName: string; position: string | null; isExtra: boolean; city: string | null; isSelf: boolean }
export interface MapLeave {
  id: number;
  employeeId: number;
  leaveType: LeaveTypeShown;
  status: string;
  fromDate: string;
  toDate: string;
  hours: number | null;
  notes: string | null;
  decisionNote: string | null;
  workingDays: number;
  canApprove: boolean;
  canCancel: boolean;
}

function shownLeave(v: LeaveViewer, person: { id: number; city: string | null }, row: LeaveDbRow, requesterUserIds: readonly number[], canManage: boolean): MapLeave | null {
  const own = v.employeeId === row.employeeId;
  const shown = leaveForViewer(v.mode, own, row);
  if (!shown) return null;
  const actor = { userId: v.userId, role: v.role, employeeId: v.employeeId };
  return {
    id: row.id, employeeId: row.employeeId, leaveType: shown.leaveType, status: row.status,
    fromDate: row.fromDate, toDate: row.toDate, hours: row.hours,
    notes: (shown.notes as string | null | undefined) ?? null, decisionNote: (shown.decisionNote as string | null | undefined) ?? null,
    workingDays: row.hours ? 0 : workingDaysIn(row.fromDate, row.toDate, person.city),
    canApprove: decideLeaveError(actor, row, requesterUserIds) == null,
    canCancel: cancelLeaveError({ ...actor, canManage }, row, requesterUserIds) == null,
  };
}

/**
 * O mapa do ano: as pessoas que esta conta pode ver e as ausências ativas
 * (pedidas e aprovadas), já filtradas no servidor (shared/leaves.ts →
 * leaveForViewer). Parceiros-empresa fora.
 */
export async function leaveMap(v: LeaveViewer, input: { year: number; cityKey?: MapCity | "all" | null; canManageRh: boolean }) {
  const yFrom = `${input.year}-01-01`, yTo = `${input.year}-12-31`;
  if (v.mode === "none") return { year: input.year, mode: v.mode, people: [] as MapPerson[], leaves: [] as MapLeave[] };
  const cityOf = await cityResolver();
  const rows = rowsOf(await (await db()).execute(sql`
    SELECT e.id, e.fullName, e.position, e.contractType, e.projectId, e.isActive,
           EXISTS (SELECT 1 FROM employee_leaves l WHERE l.employeeId = e.id AND l.fromDate <= ${yTo} AND l.toDate >= ${yFrom} AND l.status IN ('requested', 'approved')) AS hasLeaves
      FROM employees e
     WHERE COALESCE(e.contractType, '') <> ${PARTNER_COMPANY_CONTRACT}
       AND (e.isActive = 1 OR EXISTS (SELECT 1 FROM employee_leaves l2 WHERE l2.employeeId = e.id AND l2.fromDate <= ${yTo} AND l2.toDate >= ${yFrom} AND l2.status IN ('requested', 'approved')))
     ORDER BY e.fullName`));
  const want = input.cityKey && input.cityKey !== "all" ? input.cityKey : null;
  const people: MapPerson[] = [];
  for (const r of rows) {
    const id = Number(r.id);
    const isSelf = id === v.employeeId;
    const isExtra = r.position === "extra" || r.contractType === "extra";
    const city = cityOf(r.projectId == null ? null : Number(r.projectId));
    const hasLeaves = Number(r.hasLeaves) === 1;
    let visible = false;
    if (v.mode === "full") visible = (!want || city === want) && (!isExtra || hasLeaves || isSelf);
    else if (v.mode === "supervisor") {
      const inScope = v.scopeProjectIds == null || (r.projectId != null && v.scopeProjectIds.includes(Number(r.projectId)));
      visible = (inScope || isSelf) && (!want || city === want || isSelf) && (!isExtra || hasLeaves || isSelf);
    } else if (v.mode === "employee") visible = isSelf || (!isExtra && !!v.city && city === v.city && Number(r.isActive) === 1);
    else if (v.mode === "extra") visible = isSelf;
    if (visible) people.push({ id, fullName: String(r.fullName ?? ""), position: r.position ?? null, isExtra, city, isSelf });
  }
  const byId = new Map(people.map((p) => [p.id, p]));
  const leaves: MapLeave[] = [];
  const raw = await leavesOf(people.map((p) => p.id), yFrom, yTo, ["requested", "approved"]);
  for (const row of raw) {
    const person = byId.get(row.employeeId)!;
    // quem gere a ficha cancela; o servidor volta a confirmar ao cancelar
    const m = shownLeave(v, person, row, person.isSelf ? v.logins : [], input.canManageRh && (v.mode === "full" || v.mode === "supervisor"));
    if (m) leaves.push(m);
  }
  return { year: input.year, mode: v.mode, people, leaves };
}

// ─── As minhas ───────────────────────────────────────────────────────────────

export async function myLeaves(v: LeaveViewer, year: number) {
  if (!v.employeeId) return { year, leaves: [] as MapLeave[], yearTotal: 0, daysPerYear: v.settings.daysPerYear, city: v.city };
  const rows = await leavesOf([v.employeeId], `${year}-01-01`, `${year}-12-31`, null);
  const me = { id: v.employeeId, city: v.city };
  const leaves = rows.map((r) => shownLeave({ ...v, mode: "full" }, me, r, v.logins, false)!).reverse();
  return { year, leaves, yearTotal: vacationDaysInYear(rows, year, v.city), daysPerYear: v.settings.daysPerYear, city: v.city };
}

// ─── Por aprovar ─────────────────────────────────────────────────────────────

export async function pendingForApprover(v: LeaveViewer) {
  const d = await db();
  const mine = v.role === "super_admin" ? sql`1 = 1` : sql`JSON_CONTAINS(l.approverUserIds, ${String(v.userId)})`;
  const rows = rowsOf(await d.execute(sql`SELECT ${LEAVE_COLUMNS}, e.fullName, e.projectId, e.position FROM employee_leaves l JOIN employees e ON e.id = l.employeeId
     WHERE l.status = 'requested' AND ${mine} ORDER BY l.fromDate, l.id LIMIT 300`));
  if (!rows.length) return [];
  const cityOf = await cityResolver();
  const empIds = Array.from(new Set(rows.map((r) => Number(r.employeeId))));
  const years = Array.from(new Set(rows.flatMap((r) => [String(r.fromDate).slice(0, 4), String(r.toDate).slice(0, 4)]))).sort();
  const all = await leavesOf(empIds, `${years[0]}-01-01`, `${years[years.length - 1]}-12-31`, ["requested", "approved"]);
  // quem mais (da mesma cidade) está de férias nesses dias — para quem aprova decidir
  const minFrom = rows.map((r) => String(r.fromDate).slice(0, 10)).sort()[0];
  const maxTo = rows.map((r) => String(r.toDate).slice(0, 10)).sort().reverse()[0];
  const away = rowsOf(await d.execute(sql`SELECT l.id, l.employeeId, l.fromDate, l.toDate, e.fullName, e.projectId FROM employee_leaves l JOIN employees e ON e.id = l.employeeId
     WHERE l.leaveType = 'vacation' AND l.status IN ('requested', 'approved') AND l.fromDate <= ${maxTo} AND l.toDate >= ${minFrom} LIMIT 2000`))
    .map((x) => ({ id: Number(x.id), employeeId: Number(x.employeeId), fromDate: String(x.fromDate).slice(0, 10), toDate: String(x.toDate).slice(0, 10), fullName: String(x.fullName ?? ""), city: cityOf(x.projectId == null ? null : Number(x.projectId)) }));
  const out = [];
  for (const r of rows) {
    const row = toRow(r);
    if (row.employeeId === v.employeeId) continue; // ninguém aprova as suas
    const logins = await employeeLogins(row.employeeId);
    if (logins.includes(v.userId)) continue;
    const city = cityOf(r.projectId == null ? null : Number(r.projectId));
    const year = Number(row.fromDate.slice(0, 4));
    const others = all.filter((x) => x.employeeId === row.employeeId);
    out.push({
      ...row,
      fullName: String(r.fullName ?? ""), position: r.position ?? null, city,
      workingDays: workingDaysIn(row.fromDate, row.toDate, city),
      yearTotal: vacationDaysInYear(others, year, city),
      daysPerYear: v.settings.daysPerYear,
      colleaguesAway: Array.from(new Set(away.filter((x) => x.employeeId !== row.employeeId && x.city === city && periodsOverlap(x, row)).map((x) => x.fullName))).slice(0, 8),
    });
  }
  return out;
}

// ─── Pedir (o próprio) ───────────────────────────────────────────────────────

/**
 * Funcionário → pedido de FÉRIAS (por aprovar; as do super admin ficam
 * aprovadas sozinhas). Extra → aviso "não vou estar" (entra logo, sem
 * aprovação nem pagamento). Parceiros-empresa: fora.
 */
export async function requestLeave(v: LeaveViewer, input: { fromDate: string; toDate: string; notes?: string | null }) {
  if (!v.employeeId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A tua conta não está ligada a nenhuma ficha do RH." });
  if (!v.isActive) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A tua ficha está inativa." });
  if (v.isPartner) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Os parceiros-empresa ficam fora do mapa de férias." });
  const leaveType: LeaveType = v.isExtra ? "unavailable" : "vacation";
  const err = leaveInputError({ leaveType, fromDate: input.fromDate, toDate: input.toDate });
  if (err) throw new TRPCError({ code: "BAD_REQUEST", message: err });
  const today = lisbonDayOf(Date.now());
  if (input.fromDate < today) throw new TRPCError({ code: "BAD_REQUEST", message: "Só se marca de hoje em diante (o que já passou lança-o o RH)." });
  await assertPeriodOpen(input);
  const mine = await leavesOf([v.employeeId], input.fromDate, input.toDate, ["requested", "approved"]);
  const clash = mine.find((l) => periodsOverlap(l, input));
  if (clash) throw new TRPCError({ code: "CONFLICT", message: `Já tens nesses dias: ${clashText(clash)}.` });

  const { createEmployeeLeave } = await import("./db");
  const notes = input.notes?.trim() ? input.notes.trim().slice(0, 255) : null;
  if (leaveType === "unavailable" || v.role === "super_admin") {
    const id = await createEmployeeLeave({ employeeId: v.employeeId, leaveType, fromDate: input.fromDate, toDate: input.toDate, notes, createdById: v.userId, status: "approved", decidedById: leaveType === "vacation" ? v.userId : null });
    await logActivity({ userId: v.userId, action: "create", entity: "employee_leave", entityId: v.employeeId, details: `${leaveType === "unavailable" ? "indisponível" : "férias (aprovadas sozinhas: super admin)"} ${input.fromDate}→${input.toDate}` });
    return { id, status: "approved" as const, approvers: 0 };
  }
  const ap = await approversForEmployee(v.employeeId, v.settings);
  const id = await createEmployeeLeave({ employeeId: v.employeeId, leaveType, fromDate: input.fromDate, toDate: input.toDate, notes, createdById: v.userId, status: "requested", approverUserIds: ap.userIds });
  await logActivity({ userId: v.userId, action: "create", entity: "employee_leave", entityId: v.employeeId, details: `pedido de férias ${input.fromDate}→${input.toDate} (aprovam: ${ap.userIds.join(", ") || "ninguém"}${ap.fallback ? ", super admin por falta de regra" : ""})` });
  await notifySafe({
    kind: "leave_to_approve", targetUserIds: ap.userIds,
    title: `${v.fullName ?? "Alguém"} pediu férias: ${period(input)}`,
    body: `${workingDaysIn(input.fromDate, input.toDate, v.city)} dia(s) úteis.${notes ? `\nNota: ${notes}` : ""}\nAprova ou recusa no Mapa de férias → Por aprovar.`,
    link: "/ferias?tab=aprovar", entity: { type: "employee_leave", id: id ?? `${v.employeeId}-${input.fromDate}` },
  });
  return { id, status: "requested" as const, approvers: ap.userIds.length };
}

// ─── Aprovar ou recusar ──────────────────────────────────────────────────────

export async function decideLeave(v: LeaveViewer, input: { id: number; approve: boolean; note?: string | null }) {
  const leave = await loadLeave(input.id);
  if (!leave) throw new TRPCError({ code: "NOT_FOUND", message: "Pedido não encontrado." });
  const requesterUserIds = await employeeLogins(leave.employeeId);
  const err = decideLeaveError({ userId: v.userId, role: v.role, employeeId: v.employeeId }, leave, requesterUserIds);
  if (err) throw new TRPCError({ code: "FORBIDDEN", message: err });
  const note = input.note?.trim() ? input.note.trim().slice(0, 255) : null;
  if (!input.approve && !note) throw new TRPCError({ code: "BAD_REQUEST", message: "Escreve o motivo da recusa (a pessoa vê-o)." });
  if (input.approve) await assertPeriodOpen(leave);
  const res: any = await (await db()).execute(sql`UPDATE employee_leaves SET status = ${input.approve ? "approved" : "rejected"}, decidedById = ${v.userId}, decidedAt = ${nowSql()}, decisionNote = ${note}
     WHERE id = ${leave.id} AND status = 'requested'`);
  const affected = Number(res?.[0]?.affectedRows ?? res?.affectedRows ?? 0);
  if (!affected) throw new TRPCError({ code: "CONFLICT", message: "Este pedido já foi tratado por outra pessoa. Atualiza a página." });
  await logActivity({ userId: v.userId, action: input.approve ? "approve" : "reject", entity: "employee_leave", entityId: leave.employeeId, details: `férias ${leave.fromDate}→${leave.toDate}${note ? ` — ${note}` : ""}` });
  await notifySafe({
    kind: "my_leave", targetUserIds: requesterUserIds,
    title: input.approve ? `Férias aprovadas: ${period(leave)}` : `Férias recusadas: ${period(leave)}`,
    body: input.approve ? `As tuas férias de ${period(leave)} foram aprovadas.` : `O teu pedido de férias de ${period(leave)} foi recusado.\nMotivo: ${note}`,
    // a chave inclui a decisão: aprovar e depois cancelar (dentro da janela de 30 min) são dois avisos, não um repetido
    link: "/ferias?tab=minhas", entity: { type: "employee_leave", id: `${leave.id}:${input.approve ? "approved" : "rejected"}` },
  });
  return { id: leave.id, status: input.approve ? "approved" : "rejected" };
}

// ─── Cancelar (nunca apagar) ────────────────────────────────────────────────

export async function cancelLeave(actor: { userId: number; role: string; employeeId: number | null }, input: { id: number; note?: string | null }, canManage: boolean) {
  const leave = await loadLeave(input.id);
  if (!leave) throw new TRPCError({ code: "NOT_FOUND", message: "Ausência não encontrada." });
  const requesterUserIds = await employeeLogins(leave.employeeId);
  const err = cancelLeaveError({ ...actor, canManage }, leave, requesterUserIds);
  if (err) throw new TRPCError({ code: "FORBIDDEN", message: err });
  await assertPeriodOpen(leave);
  const { cancelEmployeeLeave } = await import("./db");
  const note = input.note?.trim() ? input.note.trim().slice(0, 255) : null;
  if (!(await cancelEmployeeLeave(leave.id, actor.userId, note))) throw new TRPCError({ code: "CONFLICT", message: "Já estava cancelada ou recusada. Atualiza a página." });
  await logActivity({ userId: actor.userId, action: "cancel", entity: "employee_leave", entityId: leave.employeeId, details: `${leave.leaveType} ${leave.fromDate}→${leave.toDate} (${leave.status} → cancelada)${note ? ` — ${note}` : ""}` });
  const own = actor.employeeId === leave.employeeId || requesterUserIds.includes(actor.userId);
  if (!own && leave.leaveType === "vacation" && isActiveLeave(leave)) {
    await notifySafe({
      kind: "my_leave", targetUserIds: requesterUserIds,
      title: `Férias canceladas: ${period(leave)}`,
      body: `As tuas férias de ${period(leave)} foram canceladas.${note ? `\nMotivo: ${note}` : ""}`,
      link: "/ferias?tab=minhas", entity: { type: "employee_leave", id: `${leave.id}:cancelled` },
    });
  }
  return { id: leave.id, status: "cancelled" as const };
}

// ─── O RH lança (aprovada) ───────────────────────────────────────────────────

/**
 * O RH (quem gere a ficha — o router já confirmou) lança uma ausência:
 * entra APROVADA, como sempre. FÉRIAS só as lança quem as aprova (regra
 * `rh.vacationApprovals`, agora), o RH (`rh.hrPeople`) ou o super admin — o
 * supervisor da cidade já não as lança a quem não aprova; as próprias não
 * (ninguém aprova as suas), salvo o super admin. Parceiros-empresa: fora.
 */
export async function launchLeave(user: { id: number; role: string }, input: { employeeId: number; leaveType: LeaveType; fromDate: string; toDate: string; hours?: number | null; notes?: string | null }) {
  const err = leaveInputError(input);
  if (err) throw new TRPCError({ code: "BAD_REQUEST", message: err });
  const emp = await getEmployeeById(input.employeeId);
  if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "Ficha não encontrada." });
  if (emp.employee.contractType === PARTNER_COMPANY_CONTRACT) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Os parceiros-empresa ficam fora do mapa de férias e da folha." });
  const isExtra = emp.employee.position === "extra" || emp.employee.contractType === "extra";
  if (input.leaveType === "unavailable" && !isExtra) throw new TRPCError({ code: "BAD_REQUEST", message: "\"Indisponível\" é só para extras; para um funcionário usa férias ou uma ausência." });
  // Férias já aprovadas: só quem as aprova (regra de agora), o RH ou o super admin; as próprias não (Jorge, 15 out 2026).
  if (input.leaveType === "vacation") await assertCanLaunchApprovedVacation(user, input.employeeId, emp.employee.userId ?? null);
  await assertPeriodOpen(input);
  // Sobreposições: o mesmo dia não fica com duas ausências ativas (duas férias contavam a dobrar no total do
  // ano e no PDF; uma baixa por cima de férias aprovadas deixava o mapa a mostrar "férias"). Cancela-se a
  // outra primeiro (fica no histórico) — como no pedido.
  const clash = (await leavesOf([input.employeeId], input.fromDate, input.toDate, ["requested", "approved"])).find((l) => periodsOverlap(l, input));
  if (clash) {
    throw new TRPCError({ code: "CONFLICT", message: `Essa pessoa já tem nesses dias: ${clashText(clash)}. Cancela essa primeiro (fica no histórico) ou escolhe outras datas.` });
  }
  const { createEmployeeLeave } = await import("./db");
  const notes = input.notes?.trim() ? input.notes.trim().slice(0, 255) : null;
  const id = await createEmployeeLeave({ employeeId: input.employeeId, leaveType: input.leaveType, fromDate: input.fromDate, toDate: input.toDate, hours: input.hours ?? null, notes, createdById: user.id, status: "approved", decidedById: user.id });
  await logActivity({ userId: user.id, action: "create", entity: "employee_leave", entityId: input.employeeId, details: `${input.leaveType} ${input.fromDate}→${input.toDate}${input.hours ? ` (${input.hours} h)` : ""}` });
  return { id };
}

// ─── A ficha (rh.leaves.list): o mesmo filtro do mapa ───────────────────────

export async function leavesForEmployee(v: LeaveViewer, employeeId: number, year?: number) {
  const from = year ? `${year}-01-01` : "2000-01-01", to = year ? `${year}-12-31` : "2100-12-31";
  const rows = (await leavesOf([employeeId], from, to, null)).reverse();
  const own = v.employeeId === employeeId;
  // quem não vê tudo vê a ficha como supervisor (quem chega aqui já passou a guarda da ficha)
  const mode: LeaveViewerMode = own || v.mode === "full" ? "full" : "supervisor";
  return rows.map((r) => {
    const shown = leaveForViewer(mode, own, r);
    return shown ? { ...shown, approverUserIds: undefined } : null;
  }).filter((x): x is NonNullable<typeof x> => !!x);
}

// ─── Extras-Dia: quem não está nesse dia ─────────────────────────────────────

/**
 * Ausências APROVADAS que cobrem o dia, por ficha — para quem escala ver
 * "indisponível (avisou a DD/MM)" / "de férias" / "ausente" (nunca o motivo
 * de uma baixa). Só com FERIAS_MAPA ligado; desligado ou erro → vazio.
 */
export async function absencesOnDay(day: string, employeeIds: readonly number[]): Promise<Map<number, import("../shared/leaves").SchedulerAbsence>> {
  const out = new Map<number, import("../shared/leaves").SchedulerAbsence>();
  try {
    if (!employeeIds.length || !(await feriasMapaOn())) return out;
    const { absenceForScheduler } = await import("../shared/leaves");
    const rows = await leavesOf(employeeIds, day, day, ["approved"]);
    for (const r of rows) {
      const a = absenceForScheduler(r);
      // o dia inteiro ganha à parte do dia; a indisponibilidade ganha às outras
      const prev = out.get(r.employeeId);
      if (!prev || (prev.partial && !a.partial) || (a.kind === "unavailable" && prev.kind !== "unavailable")) out.set(r.employeeId, a);
    }
  } catch (err: any) {
    console.warn("[férias] ausências do dia não lidas:", String(err?.message ?? err).slice(0, 160));
  }
  return out;
}

/**
 * Quem a proposta automática do Extras-Dia (e o "Preencher") deixa de fora
 * nesse dia: avisou que não está — "não vou estar" ou outra ausência aprovada
 * de dia inteiro (shared/leaves.ts → blocksAutoProposal). Só com FERIAS_MAPA
 * ligado (desligado → ninguém sai, como antes); erro → ninguém sai. À mão
 * continua a poder pôr-se, com o aviso.
 */
export async function awayForAutoProposal(day: string, employeeIds: readonly number[]): Promise<Set<number>> {
  const out = new Set<number>();
  for (const [id, a] of await absencesOnDay(day, employeeIds)) if (blocksAutoProposal(a)) out.add(id);
  return out;
}

// ─── PDF ─────────────────────────────────────────────────────────────────────

/** O mapa para imprimir: só FÉRIAS aprovadas (sem baixas), por pessoa. */
export async function leaveMapForPdf(v: LeaveViewer, year: number, cityKey: MapCity | "all" | null) {
  const map = await leaveMap({ ...v }, { year, cityKey, canManageRh: false });
  const people = map.people.filter((p) => !p.isExtra);
  const byEmp = new Map<number, MapLeave[]>();
  for (const l of map.leaves) {
    if (l.leaveType !== "vacation" || l.status !== "approved") continue;
    byEmp.set(l.employeeId, [...(byEmp.get(l.employeeId) ?? []), l]);
  }
  return {
    year, cityKey: cityKey ?? "all",
    rows: people.map((p) => {
      const periods = (byEmp.get(p.id) ?? []).sort((a, b) => a.fromDate.localeCompare(b.fromDate))
        // os dias úteis DESTE ano (umas férias de 28/12 a 04/01 não somam os de janeiro no mapa do ano anterior)
        .map((x) => ({ fromDate: x.fromDate, toDate: x.toDate, workingDays: workingDaysIn(x.fromDate, x.toDate, p.city, `${year}-01-01`, `${year}-12-31`) }));
      return { fullName: p.fullName, city: p.city, periods, total: periods.reduce((s, x) => s + x.workingDays, 0) };
    }),
  };
}
