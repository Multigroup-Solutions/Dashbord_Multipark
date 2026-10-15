/**
 * Mapa de férias (plano 63, passo 11) — regras PURAS, usadas pelo servidor,
 * pelo ecrã e pelos testes.
 *
 * Jorge (15 out 2026): "para toda a gente".
 *  - Funcionários (permanentes e a termo) marcam FÉRIAS: ficam "pedidas" até
 *    alguém aprovar (cadeia configurável, `rh.vacationApprovals`). As do super
 *    admin ficam aprovadas sozinhas. Ninguém aprova as suas.
 *  - Extras avisam "daqui até aqui não vou estar" (`unavailable`): é um aviso,
 *    entra logo, sem aprovação e sem pagamento. Se avisaram ANTES de serem
 *    escalados, a falta desse dia fica sem pontos; avisos depois de escalados
 *    não tiram a falta.
 *  - Quem vê tudo: o super admin, `rh.leavesViewAll` e `rh.hrPeople` (o RH).
 *    O supervisor vê a sua área e as baixas/ausências só como "ausente"
 *    (sem o motivo). Os colegas só veem as FÉRIAS uns dos outros. Os extras
 *    só as suas indisponibilidades.
 *  - Nada se apaga: "apagar" passa a CANCELAR. Um mês fechado (ordenado
 *    aprovado ou pago) não muda.
 *  - Parceiros-empresa (`partner_company`): fora do mapa e da folha.
 *  - Ausência de parte do dia: `hours` (só "ausência justificada", um dia).
 */
import { z } from "zod";
import { addDays, lisbonDayOf } from "./lisbonDay";
import { ptHolidayOf } from "./workSchedule";

// ─── Tipos e estados ─────────────────────────────────────────────────────────

export const LEAVE_TYPES = ["vacation", "sick", "unpaid", "other", "unavailable"] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];
/** O que o supervisor vê no lugar de uma baixa ou ausência (sem o motivo). */
export type LeaveTypeShown = LeaveType | "absent";

export const LEAVE_STATUSES = ["requested", "approved", "rejected", "cancelled"] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

export const LEAVE_TYPE_LABELS: Record<LeaveTypeShown, string> = {
  vacation: "Férias",
  sick: "Baixa",
  unpaid: "Ausência não remunerada",
  other: "Ausência justificada",
  unavailable: "Indisponível (extra)",
  absent: "Ausente",
};
export const LEAVE_STATUS_LABELS: Record<LeaveStatus, string> = {
  requested: "Por aprovar",
  approved: "Aprovado",
  rejected: "Recusado",
  cancelled: "Cancelado",
};

/** Baixas e ausências: dados pessoais/de saúde — só o próprio e quem vê tudo veem o tipo. */
export const PRIVATE_LEAVE_TYPES: readonly LeaveType[] = ["sick", "unpaid", "other"];

// ─── Interruptores e definições ─────────────────────────────────────────────

/** O mapa, os pedidos, a indisponibilidade dos extras no Extras-Dia (desligado por omissão). */
export const FERIAS_MAPA_FLAG = "FERIAS_MAPA";
/** O sino a quem aprova e a quem pediu (desligado por omissão). */
export const FERIAS_AVISOS_FLAG = "FERIAS_AVISOS";

export const HR_PEOPLE_KEY = "rh.hrPeople" as const;
export const LEAVES_VIEW_ALL_KEY = "rh.leavesViewAll" as const;
export const VACATION_APPROVALS_KEY = "rh.vacationApprovals" as const;
export const VACATION_DAYS_PER_YEAR_KEY = "rh.vacationDaysPerYear" as const;
export const DEFAULT_VACATION_DAYS_PER_YEAR = 22;

/** Tipo de contrato dos parceiros-empresa: fora do mapa e da folha. */
export const PARTNER_COMPANY_CONTRACT = "partner_company" as const;

// ─── Datas ───────────────────────────────────────────────────────────────────

/** "AAAA-MM-DD" e uma data que existe (2026-02-30 não). PURA. */
export function isRealIsoDay(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (y < 2000 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Dias de calendário de um período (inclusive). PURA. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10)) - Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10))) / 86_400_000) + 1;
}

export const LEAVE_MAX_DAYS = 366;
export const LEAVE_HOURS_MIN = 0.25;
export const LEAVE_HOURS_MAX = 12;

/**
 * Validação de uma ausência (datas a sério, início ≤ fim, no máximo um ano;
 * parte do dia só numa ausência justificada de um só dia). Devolve a
 * mensagem de erro ou null. PURA.
 */
export function leaveInputError(i: { leaveType: string; fromDate: string; toDate: string; hours?: number | null }): string | null {
  if (!(LEAVE_TYPES as readonly string[]).includes(i.leaveType)) return "Tipo de ausência desconhecido.";
  if (!isRealIsoDay(i.fromDate)) return "Data de início inválida (AAAA-MM-DD).";
  if (!isRealIsoDay(i.toDate)) return "Data de fim inválida (AAAA-MM-DD).";
  if (i.fromDate > i.toDate) return "A data de fim é antes da de início.";
  if (daysBetween(i.fromDate, i.toDate) > LEAVE_MAX_DAYS) return "No máximo um ano de cada vez.";
  if (i.hours != null) {
    if (i.leaveType !== "other") return "Parte do dia só numa ausência justificada.";
    if (i.fromDate !== i.toDate) return "Parte do dia: escolhe um só dia (de = até).";
    if (!Number.isFinite(i.hours) || i.hours < LEAVE_HOURS_MIN || i.hours > LEAVE_HOURS_MAX) return `Horas entre ${String(LEAVE_HOURS_MIN).replace(".", ",")} e ${LEAVE_HOURS_MAX}.`;
    if (Math.round(i.hours * 4) !== i.hours * 4) return "Horas em quartos de hora (ex.: 1,5 ou 2,25).";
  }
  return null;
}

/** O período cobre este dia de calendário? PURA. */
export function leaveCoversDay(l: { fromDate: string; toDate: string }, day: string): boolean {
  return String(l.fromDate).slice(0, 10) <= day && day <= String(l.toDate).slice(0, 10);
}

/** Dois períodos tocam-se? PURA. */
export function periodsOverlap(a: { fromDate: string; toDate: string }, b: { fromDate: string; toDate: string }): boolean {
  return a.fromDate <= b.toDate && b.fromDate <= a.toDate;
}

/**
 * Dias ÚTEIS do período (segunda a sexta, menos os feriados nacionais e o
 * municipal da cidade), opcionalmente só dentro de [clampFrom, clampTo]. PURA.
 */
export function workingDaysIn(from: string, to: string, city?: string | null, clampFrom?: string, clampTo?: string): number {
  const f = clampFrom && clampFrom > from ? clampFrom : from;
  const t = clampTo && clampTo < to ? clampTo : to;
  let n = 0;
  for (let d = f, guard = 0; d <= t && guard < 800; d = addDays(d, 1), guard++) {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    if (ptHolidayOf(d, city)) continue;
    n++;
  }
  return n;
}

/** Os meses ("AAAA-MM") que o período toca. PURA. */
export function monthsOfPeriod(from: string, to: string): string[] {
  const out: string[] = [];
  let y = +from.slice(0, 4), m = +from.slice(5, 7);
  const ty = +to.slice(0, 4), tm = +to.slice(5, 7);
  for (let guard = 0; (y < ty || (y === ty && m <= tm)) && guard < 40; guard++) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

/** O primeiro mês FECHADO (ordenado aprovado ou pago) que o período toca, ou null. PURA. */
export function closedMonthOfPeriod(p: { fromDate: string; toDate: string }, closed: ReadonlySet<string>): string | null {
  if (!closed.size) return null;
  return monthsOfPeriod(p.fromDate, p.toDate).find((m) => closed.has(m)) ?? null;
}

const MONTHS_PT = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
/** "2026-09" → "setembro de 2026". PURA. */
export function monthLabelPt(ym: string): string {
  return `${MONTHS_PT[+ym.slice(5, 7) - 1] ?? ym.slice(5, 7)} de ${ym.slice(0, 4)}`;
}
/** "2026-08-03" → "03/08". PURA. */
export function shortDayPt(day: string | null | undefined): string {
  const d = String(day ?? "");
  return d.length >= 10 ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : d;
}

export const closedMonthMessage = (ym: string) => `O mês de ${monthLabelPt(ym)} já está fechado (ordenado aprovado ou pago): não se muda.`;

// ─── Contas do total do ano ─────────────────────────────────────────────────

export interface LeaveLikeRow {
  leaveType: string;
  status?: string | null;
  fromDate: string;
  toDate: string;
  hours?: number | string | null;
}

/** Ativa = pedida ou aprovada (as recusadas e as canceladas já não contam). PURA. */
export const isActiveLeave = (l: { status?: string | null }): boolean => (l.status ?? "approved") === "approved" || l.status === "requested";

/**
 * Dias úteis de FÉRIAS (pedidas + aprovadas) dentro do ano — o aviso dos 22
 * dias (só aviso, nunca bloqueia). PURA.
 */
export function vacationDaysInYear(leaves: readonly LeaveLikeRow[], year: number, city?: string | null): number {
  const yFrom = `${year}-01-01`, yTo = `${year}-12-31`;
  let n = 0;
  for (const l of leaves) {
    if (l.leaveType !== "vacation" || !isActiveLeave(l)) continue;
    if (l.toDate < yFrom || l.fromDate > yTo) continue;
    n += workingDaysIn(l.fromDate, l.toDate, city, yFrom, yTo);
  }
  return n;
}

/** Texto do aviso dos dias do ano (null = dentro). PURA. */
export function vacationYearWarning(total: number, perYear: number): string | null {
  if (!(perYear > 0) || total <= perYear) return null;
  return `Com este pedido ficas com ${total} dias úteis de férias no ano (o normal são ${perYear}). É só um aviso.`;
}

// ─── Quem vê o quê ───────────────────────────────────────────────────────────

export type LeaveViewerMode = "full" | "supervisor" | "employee" | "extra" | "none";

/**
 * Como esta conta vê o mapa (decisão do Jorge):
 *  - "full": o super admin, as contas de `rh.leavesViewAll` e as do RH
 *    (`rh.hrPeople`) — tudo, de todas as cidades, com o tipo e as notas;
 *  - "supervisor": a sua área; baixas e ausências como "ausente";
 *  - "employee": as suas e as FÉRIAS dos colegas da sua cidade;
 *  - "extra": só as suas indisponibilidades;
 *  - "none": conta sem ficha (nada além do que for seu, que não há). PURA.
 */
export function leaveViewerMode(v: { role: string; userId: number; hasEmployee: boolean; isExtra: boolean; viewAll: readonly number[]; hrPeople: readonly number[] }): LeaveViewerMode {
  if (v.role === "super_admin" || v.viewAll.includes(v.userId) || v.hrPeople.includes(v.userId)) return "full";
  if (v.role === "supervisor") return "supervisor";
  if (!v.hasEmployee) return "none";
  return v.isExtra ? "extra" : "employee";
}

export interface LeaveViewRow {
  id: number;
  employeeId: number;
  leaveType: string;
  status: string;
  fromDate: string;
  toDate: string;
  hours?: number | string | null;
  notes?: string | null;
  decisionNote?: string | null;
}

/**
 * O que esta conta pode ver de UMA ausência (filtro do SERVIDOR, não do
 * ecrã). null = não vê. PURA.
 *  - a própria e quem vê tudo: tudo;
 *  - supervisor: as férias e as indisponibilidades; as baixas e ausências
 *    passam a "ausente", sem notas nem motivos;
 *  - colegas: só as férias (pedidas ou aprovadas), sem notas nem motivos;
 *  - extras: nada dos outros.
 */
export function leaveForViewer<T extends LeaveViewRow>(mode: LeaveViewerMode, isOwn: boolean, row: T): (Omit<T, "leaveType"> & { leaveType: LeaveTypeShown }) | null {
  if (isOwn || mode === "full") return row as Omit<T, "leaveType"> & { leaveType: LeaveTypeShown };
  if (mode === "supervisor") {
    if ((PRIVATE_LEAVE_TYPES as readonly string[]).includes(row.leaveType)) {
      return { ...row, leaveType: "absent", notes: null, decisionNote: null };
    }
    return row as Omit<T, "leaveType"> & { leaveType: LeaveTypeShown };
  }
  if (mode === "employee") {
    if (row.leaveType !== "vacation" || !isActiveLeave(row)) return null;
    return { ...row, leaveType: "vacation", notes: null, decisionNote: null };
  }
  return null;
}

// ─── Quem aprova quem (configurável) ─────────────────────────────────────────

export const APPROVER_SOURCES = ["hr", "city_supervisor", "any_supervisor", "super_admin", "accounts"] as const;
export type ApproverSource = (typeof APPROVER_SOURCES)[number];
export const APPROVER_SOURCE_LABELS: Record<ApproverSource, string> = {
  hr: "RH (as contas do RH)",
  city_supervisor: "Supervisor da cidade de quem pede",
  any_supervisor: "Qualquer supervisor",
  super_admin: "Super admin",
  accounts: "Contas escolhidas",
};

/** Postos da ficha que pedem férias (os extras só avisam: não há aprovação). */
export const REQUESTER_POSITIONS = ["team_leader", "frontoffice", "backoffice", "supervisor", "director", "senior_driver", "driver"] as const;
export type RequesterPosition = (typeof REQUESTER_POSITIONS)[number];
export const REQUESTER_POSITION_LABELS: Record<RequesterPosition, string> = {
  team_leader: "Team leader",
  frontoffice: "Front office",
  backoffice: "Back office",
  supervisor: "Supervisor",
  director: "Diretor",
  senior_driver: "Condutor sénior",
  driver: "Condutor",
};

const accountIds = z.array(z.number({ error: "Escolhe as contas na lista." }).int().positive()).max(30, "No máximo 30 contas.")
  .transform((ids) => Array.from(new Set(ids)));
const approverList = z.array(z.enum(APPROVER_SOURCES, { error: "Fonte de aprovação desconhecida." })).max(APPROVER_SOURCES.length)
  .transform((xs) => Array.from(new Set(xs)));

export const approvalRuleSchema = z.object({ approvers: approverList, userIds: accountIds.default([]) }).strict();
export type ApprovalRule = z.output<typeof approvalRuleSchema>;

export const vacationApprovalsSchema = z.object({
  /** Regra por posto da ficha de quem pede. */
  positions: z.object(Object.fromEntries(REQUESTER_POSITIONS.map((p) => [p, approvalRuleSchema.optional()])) as Record<RequesterPosition, z.ZodOptional<typeof approvalRuleSchema>>).strict(),
  /** Quem está no RH (`rh.hrPeople`) — ganha ao posto. */
  hrPeople: approvalRuleSchema,
  /** Exceções por pessoa (ficha) — ganham a tudo. Ex.: o supervisor de todas as cidades → super admin. */
  people: z.array(z.object({
    employeeId: z.number({ error: "Escolhe a pessoa." }).int().positive(),
    approvers: approverList,
    userIds: accountIds.default([]),
    note: z.string().trim().max(120).optional(),
  }).strict()).max(60, "No máximo 60 exceções.")
    .refine((xs) => new Set(xs.map((x) => x.employeeId)).size === xs.length, "Uma exceção por pessoa."),
}).strict();
export type VacationApprovals = z.output<typeof vacationApprovalsSchema>;

/**
 * Omissão (decisão do Jorge, 15 out 2026), sem nomes no código:
 *  - team leader → RH ou supervisor da cidade;
 *  - front office → supervisor da cidade ou RH;
 *  - back office → RH;
 *  - supervisor → o super admin ou as contas escolhidas (a direção
 *    escolhe-se nas Definições);
 *  - diretor → super admin;
 *  - condutores com contrato → supervisor da cidade ou RH (proposta);
 *  - quem está no RH → super admin;
 *  - o supervisor de todas as cidades e outras pessoas à parte → exceções
 *    por pessoa (super admin), escolhidas nas Definições.
 * Sem ninguém → super admin (rede de segurança).
 */
export const DEFAULT_VACATION_APPROVALS: VacationApprovals = {
  positions: {
    team_leader: { approvers: ["hr", "city_supervisor"], userIds: [] },
    frontoffice: { approvers: ["city_supervisor", "hr"], userIds: [] },
    backoffice: { approvers: ["hr"], userIds: [] },
    supervisor: { approvers: ["super_admin", "accounts"], userIds: [] },
    director: { approvers: ["super_admin"], userIds: [] },
    senior_driver: { approvers: ["city_supervisor", "hr"], userIds: [] },
    driver: { approvers: ["city_supervisor", "hr"], userIds: [] },
  },
  hrPeople: { approvers: ["super_admin"], userIds: [] },
  people: [],
};

export interface ApprovalRequester {
  employeeId: number;
  position: string | null;
  /** cidade da ficha ("lisbon" | "porto" | "faro"), ou null */
  city: string | null;
  /** todas as contas (logins) da ficha de quem pede */
  userIds: readonly number[];
}

export interface ApproverCandidate {
  id: number;
  role: string;
  isActive: boolean;
  /** cidades que a conta cobre (supervisores); "all" = todas */
  cities?: "all" | readonly string[];
}

export type ApprovalRuleKind = "person" | "hr" | "position" | "default";

/** A regra que vale para quem pede (exceção > RH > posto > omissão). PURA. */
export function approvalRuleFor(requester: ApprovalRequester, rules: VacationApprovals, hrPeople: readonly number[]): { rule: ApprovalRule; kind: ApprovalRuleKind } {
  const person = rules.people.find((p) => p.employeeId === requester.employeeId);
  if (person) return { rule: { approvers: person.approvers, userIds: person.userIds }, kind: "person" };
  if (requester.userIds.some((id) => hrPeople.includes(id))) return { rule: rules.hrPeople, kind: "hr" };
  const pos = (REQUESTER_POSITIONS as readonly string[]).includes(String(requester.position)) ? (requester.position as RequesterPosition) : null;
  const byPos = pos ? rules.positions[pos] : undefined;
  if (byPos) return { rule: byPos, kind: "position" };
  return { rule: { approvers: ["super_admin"], userIds: [] }, kind: "default" };
}

export interface ApproversResult {
  userIds: number[];
  kind: ApprovalRuleKind;
  /** ninguém configurado (ou só o próprio) → caiu no super admin */
  fallback: boolean;
}

/**
 * Quem pode aprovar as férias desta pessoa (tabela 11.3). Basta um. Ninguém
 * aprova as suas: as contas da própria ficha saem sempre. Sem ninguém →
 * super admin. Só contas ATIVAS. PURA.
 */
export function vacationApproversFor(requester: ApprovalRequester, rules: VacationApprovals, users: readonly ApproverCandidate[], hrPeople: readonly number[]): ApproversResult {
  const { rule, kind } = approvalRuleFor(requester, rules, hrPeople);
  const own = new Set(requester.userIds);
  const active = users.filter((u) => u.isActive && !own.has(u.id));
  const byId = new Map(active.map((u) => [u.id, u]));
  const out = new Set<number>();
  const coversCity = (u: ApproverCandidate) => u.cities === "all" || (!!requester.city && (u.cities ?? []).includes(requester.city));
  for (const src of rule.approvers) {
    if (src === "hr") for (const id of hrPeople) { if (byId.has(id)) out.add(id); }
    if (src === "super_admin") for (const u of active) { if (u.role === "super_admin") out.add(u.id); }
    if (src === "any_supervisor") for (const u of active) { if (u.role === "supervisor") out.add(u.id); }
    if (src === "city_supervisor") for (const u of active) { if (u.role === "supervisor" && coversCity(u)) out.add(u.id); }
    if (src === "accounts") for (const id of rule.userIds) { if (byId.has(id)) out.add(id); }
  }
  if (out.size) return { userIds: Array.from(out).sort((a, b) => a - b), kind, fallback: false };
  const supers = active.filter((u) => u.role === "super_admin").map((u) => u.id).sort((a, b) => a - b);
  return { userIds: supers, kind, fallback: true };
}

// ─── Aprovar, recusar, cancelar ──────────────────────────────────────────────

export interface LeaveActor { userId: number; role: string; employeeId: number | null }

/** Pode aprovar ou recusar este pedido? Devolve a recusa, ou null. PURA. */
export function decideLeaveError(actor: LeaveActor, leave: { employeeId: number; status: string; approverUserIds: readonly number[] }, requesterUserIds: readonly number[]): string | null {
  if (leave.status !== "requested") return "Este pedido já foi tratado.";
  if (actor.employeeId === leave.employeeId || requesterUserIds.includes(actor.userId)) return "Ninguém aprova as suas férias.";
  if (actor.role !== "super_admin" && !leave.approverUserIds.includes(actor.userId)) return "Não estás entre quem aprova este pedido.";
  return null;
}

/**
 * Pode cancelar? A pessoa cancela um pedido seu (e um extra o seu aviso); as
 * aprovadas cancela-as quem aprova, quem gere a ficha ou o super admin. PURA.
 */
export function cancelLeaveError(actor: LeaveActor & { canManage: boolean }, leave: { employeeId: number; status: string; leaveType: string; approverUserIds: readonly number[] }, requesterUserIds: readonly number[]): string | null {
  if (leave.status !== "requested" && leave.status !== "approved") return "Já está cancelado ou recusado.";
  const own = actor.employeeId === leave.employeeId || requesterUserIds.includes(actor.userId);
  if (own) {
    if (leave.status === "requested" || leave.leaveType === "unavailable" || actor.role === "super_admin") return null;
    return "As tuas férias aprovadas só as cancela quem as aprova (pede-lhe).";
  }
  if (actor.role === "super_admin" || actor.canManage || leave.approverUserIds.includes(actor.userId)) return null;
  return "Sem permissão para cancelar esta ausência.";
}

/** Lê a lista de quem podia aprovar (coluna JSON: array, texto JSON ou nada). PURA. */
export function parseApproverIds(raw: unknown): number[] {
  let v: unknown = raw;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return []; } }
  return Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
}

// ─── Extras-Dia: quem avisou antes de ser escalado ───────────────────────────

/** "AAAA-MM-DD HH:MM:SS" / ISO / Date → ms (UTC, como o MySQL guarda). PURA. */
function tsMs(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  const s = String(v ?? "").trim();
  if (!s) return NaN;
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
}

export interface NoticeLeave extends LeaveLikeRow {
  /** quando ficou registado (o pedido ou o lançamento) */
  requestedAt?: string | Date | null;
  createdAt?: string | Date | null;
}

/**
 * A falta ao Extras-Dia fica SEM pontos quando a pessoa tinha avisado ANTES de
 * ser escalada (ausência aprovada desse dia, de dia inteiro, registada antes
 * da linha da escala). Avisos depois de escalado não contam ("ninguém foge a
 * uma falta à última hora"). Devolve o aviso que justifica, ou null. PURA.
 */
export function noticeBeforeAssignment<T extends NoticeLeave>(leaves: readonly T[], day: string, assignmentCreatedAt: string | Date | null | undefined): T | null {
  const at = tsMs(assignmentCreatedAt);
  if (!Number.isFinite(at)) return null;
  for (const l of leaves) {
    if ((l.status ?? "approved") !== "approved" || (l.hours != null && l.hours !== "") || !leaveCoversDay(l, day)) continue;
    const noticed = tsMs(l.requestedAt ?? l.createdAt);
    if (Number.isFinite(noticed) && noticed < at) return l;
  }
  return null;
}

export interface SchedulerAbsence {
  /** o que quem escala vê: indisponível (extra), férias ou só "ausente" */
  kind: "unavailable" | "vacation" | "absent";
  fromDate: string;
  toDate: string;
  /** dia em que ficou registado ("avisou a DD/MM") */
  noticeDay: string | null;
  partial: boolean;
}

/** Ausência aprovada vista por quem escala (sem o motivo das baixas). PURA. */
export function absenceForScheduler(l: NoticeLeave): SchedulerAbsence {
  const kind: SchedulerAbsence["kind"] = l.leaveType === "unavailable" ? "unavailable" : l.leaveType === "vacation" ? "vacation" : "absent";
  const ms = tsMs(l.requestedAt ?? l.createdAt);
  return {
    kind, fromDate: String(l.fromDate).slice(0, 10), toDate: String(l.toDate).slice(0, 10),
    // o dia em Lisboa (um aviso às 00:30 de 26 out é de 26, não do dia 25 em UTC)
    noticeDay: Number.isFinite(ms) ? lisbonDayOf(ms) : null,
    partial: l.hours != null && l.hours !== "",
  };
}

/** "Indisponível (avisou a 03/08)" / "De férias" / "Ausente". PURA. */
export function schedulerAbsenceText(a: SchedulerAbsence | null | undefined): string | null {
  if (!a) return null;
  const when = a.noticeDay ? ` (avisou a ${shortDayPt(a.noticeDay)})` : "";
  if (a.kind === "unavailable") return `Indisponível${when}`;
  if (a.kind === "vacation") return `De férias${a.partial ? " (parte do dia)" : ""}`;
  return `Ausente${a.partial ? " (parte do dia)" : ""}`;
}
