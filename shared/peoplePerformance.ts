/**
 * P3 lote 37a — Desempenho por pessoa (Jorge, 6 out 2026): "na aba dos
 * condutores e agentes quero um histórico por dia, semana, mês, ano, por
 * hora trabalhada, por movimentação… independentemente do posto: front
 * office (chamadas, emails, reservas, modificações, reclamações, horas),
 * supervisão, team leaders (recolhas, entregas, pôs em entrega/recolha,
 * telefonemas, que pessoas tinha), condutores e extras (o que mexeu, km,
 * excessos de velocidade, horas, ocorrências)… e as despesas, a caixa, a
 * correção de caixa, as avaliações do Google, as respostas aos clientes, as
 * alterações de reserva. Visual, com ranking, só super admins."
 *
 * Regras PURAS: grupos (abas), períodos e baldes, catálogo de métricas e o
 * ranking (pontos de trabalho = soma ponderada; por hora quando há horas).
 */
import { addDays } from "./lisbonDay";

// ─── Grupos (abas) ──────────────────────────────────────────────────────────

export type PerfGroup = "office" | "supervision" | "teamleaders" | "drivers";
export const PERF_GROUPS: ReadonlyArray<{ id: PerfGroup; label: string }> = [
  { id: "office", label: "Back e front office" },
  { id: "supervision", label: "Supervisão" },
  { id: "teamleaders", label: "Team leaders" },
  { id: "drivers", label: "Condutores e extras" },
];

/**
 * Aba de uma pessoa: o papel da conta manda quando é de escritório/chefia
 * (a ficha nasce com posto "condutor" por omissão); senão o posto da ficha.
 * Administração sem posto de chefia não entra. PURA.
 */
export function groupOf(p: { position: string | null; role: string | null; contractType?: string | null }): PerfGroup | null {
  const role = p.role ?? "";
  if (role === "frontoffice" || role === "backoffice") return "office";
  if (role === "supervisor") return "supervision";
  if (role === "team_leader") return "teamleaders";
  switch (p.position) {
    case "frontoffice": case "backoffice": return "office";
    case "supervisor": case "director": return "supervision";
    case "team_leader": return "teamleaders";
    case "driver": case "senior_driver": case "extra": return "drivers";
  }
  if (p.contractType === "extra") return "drivers";
  return null;
}

// ─── Períodos e baldes ──────────────────────────────────────────────────────

export type PerfPeriod = "day" | "week" | "month" | "year";
export const PERF_PERIODS: ReadonlyArray<{ id: PerfPeriod; label: string }> = [
  { id: "day", label: "Dia" }, { id: "week", label: "Semana" }, { id: "month", label: "Mês" }, { id: "year", label: "Ano" },
];

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n: number) => String(n).padStart(2, "0");
/** 0 = segunda … 6 = domingo. PURA. */
function weekdayMon0(day: string): number {
  const d = new Date(`${day}T12:00:00Z`).getUTCDay();
  return (d + 6) % 7;
}
function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export interface PerfRange { from: string; to: string; buckets: string[]; bucketLabels: string[] }
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const WEEKDAYS = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"];

/**
 * Intervalo (dias operacionais, 03h→03h) e baldes do gráfico: dia → o dia;
 * semana (segunda a domingo) e mês → dias; ano → meses. PURA.
 */
export function perfRange(period: PerfPeriod, anchor: string): PerfRange {
  if (!DAY.test(anchor)) throw new Error("Dia inválido.");
  const [y, m] = anchor.split("-").map(Number);
  if (period === "day") return { from: anchor, to: anchor, buckets: [anchor], bucketLabels: [anchor.slice(8) + "/" + anchor.slice(5, 7)] };
  if (period === "week") {
    const from = addDays(anchor, -weekdayMon0(anchor));
    const buckets = Array.from({ length: 7 }, (_, i) => addDays(from, i));
    return { from, to: buckets[6], buckets, bucketLabels: buckets.map((d, i) => `${WEEKDAYS[i]} ${d.slice(8)}`) };
  }
  if (period === "month") {
    const n = lastDayOfMonth(y, m);
    const buckets = Array.from({ length: n }, (_, i) => `${y}-${pad(m)}-${pad(i + 1)}`);
    return { from: buckets[0], to: buckets[n - 1], buckets, bucketLabels: buckets.map((d) => d.slice(8)) };
  }
  const buckets = Array.from({ length: 12 }, (_, i) => `${y}-${pad(i + 1)}`);
  return { from: `${y}-01-01`, to: `${y}-12-31`, buckets, bucketLabels: MONTHS.slice() };
}

/** Balde de um dia operacional no período (null = fora). PURA. */
export function bucketOf(period: PerfPeriod, day: string, r: PerfRange): string | null {
  if (day < r.from || day > r.to) return null;
  return period === "year" ? day.slice(0, 7) : day;
}

/** Período anterior/seguinte (para as setas). PURA. */
export function shiftAnchor(period: PerfPeriod, anchor: string, dir: -1 | 1): string {
  if (period === "day") return addDays(anchor, dir);
  if (period === "week") return addDays(anchor, 7 * dir);
  const [y, m, d] = anchor.split("-").map(Number);
  if (period === "month") {
    const ny = m + dir < 1 ? y - 1 : m + dir > 12 ? y + 1 : y;
    const nm = ((m - 1 + dir + 12) % 12) + 1;
    return `${ny}-${pad(nm)}-${pad(Math.min(d, lastDayOfMonth(ny, nm)))}`;
  }
  return `${y + dir}-${pad(m)}-${pad(Math.min(d, lastDayOfMonth(y + dir, m)))}`;
}

/** "outubro de 2026", "semana de 5 out", "6 out 2026", "2026". PURA. */
export function periodTitle(period: PerfPeriod, anchor: string): string {
  const r = perfRange(period, anchor);
  const [y, m, d] = anchor.split("-").map(Number);
  if (period === "day") return `${d} ${MONTHS[m - 1]} ${y}`;
  if (period === "week") return `semana de ${Number(r.from.slice(8))} ${MONTHS[Number(r.from.slice(5, 7)) - 1]} a ${Number(r.to.slice(8))} ${MONTHS[Number(r.to.slice(5, 7)) - 1]}`;
  if (period === "month") return `${MONTHS[m - 1]} ${y}`;
  return String(y);
}

// ─── Métricas ───────────────────────────────────────────────────────────────

export type PerfMetric =
  | "hours" | "workDays" | "evalPoints"
  | "recolhas" | "entregas" | "movements" | "parkingMoves" | "cancels" | "checkingIn" | "checkingOut"
  | "created" | "updated" | "occurrences" | "speedAlerts" | "delays" | "complaintsAgainst" | "accidents"
  | "km" | "gpsDays" | "overLimitDays" | "maxSpeed"
  | "callsAnswered" | "callsMade" | "callbacks" | "waMessages" | "emails"
  | "complaintMsgs" | "complaintsClosed" | "reviewsReplied"
  | "expenses" | "expensesApproved" | "cashCounts" | "cashCorrections"
  | "tasksDone" | "leadsActions" | "handovers" | "tlDays" | "teamPeople"
  // 37b (Jorge, 6 out 2026): "há mais: contas de parceiros, faturação e cobrança de parceiros, o extra dia, a atualização do CRM, perdidos e achados, pedido de voo de regresso, alteração da reserva"
  | "partnerAccounts" | "partnerClosings" | "extrasDia" | "crmUpdates" | "lostFound" | "returnFlights"
  // 37c (Jorge, 6 out 2026): "guarda quem regista as cobranças de parceiros" — o autor vem da Multipark
  | "partnerCharges";

export interface PerfMetricDef {
  key: PerfMetric;
  label: string;
  /** de onde vem (mostrado na legenda) */
  source: "dashboard" | "multipark" | "zello" | "avaliação";
  /** Maior é pior (vermelho no ranking). */
  bad?: boolean;
  /** Não se soma (ex.: velocidade máxima). */
  max?: boolean;
}

export const PERF_METRICS: Record<PerfMetric, PerfMetricDef> = {
  hours: { key: "hours", label: "Horas trabalhadas", source: "dashboard" },
  workDays: { key: "workDays", label: "Dias com trabalho", source: "dashboard" },
  evalPoints: { key: "evalPoints", label: "Pontos da avaliação", source: "avaliação" },
  recolhas: { key: "recolhas", label: "Recolhas", source: "multipark" },
  entregas: { key: "entregas", label: "Entregas", source: "multipark" },
  movements: { key: "movements", label: "Movimentos", source: "multipark" },
  parkingMoves: { key: "parkingMoves", label: "Levar ao parque", source: "multipark" },
  cancels: { key: "cancels", label: "Cancelamentos", source: "multipark" },
  checkingIn: { key: "checkingIn", label: "Pôs em recolha", source: "multipark" },
  checkingOut: { key: "checkingOut", label: "Pôs em entrega", source: "multipark" },
  created: { key: "created", label: "Reservas criadas", source: "multipark" },
  updated: { key: "updated", label: "Alterações de reserva", source: "multipark" },
  occurrences: { key: "occurrences", label: "Ocorrências registadas", source: "multipark" },
  speedAlerts: { key: "speedAlerts", label: "Alertas de velocidade", source: "zello", bad: true },
  delays: { key: "delays", label: "Atrasos", source: "avaliação", bad: true },
  complaintsAgainst: { key: "complaintsAgainst", label: "Reclamações contra", source: "avaliação", bad: true },
  accidents: { key: "accidents", label: "Acidentes", source: "avaliação", bad: true },
  km: { key: "km", label: "Km (GPS)", source: "zello" },
  gpsDays: { key: "gpsDays", label: "Dias com GPS", source: "zello" },
  overLimitDays: { key: "overLimitDays", label: "Dias acima do limite", source: "zello", bad: true },
  maxSpeed: { key: "maxSpeed", label: "Velocidade máxima", source: "zello", max: true },
  callsAnswered: { key: "callsAnswered", label: "Chamadas atendidas", source: "dashboard" },
  callsMade: { key: "callsMade", label: "Chamadas feitas", source: "dashboard" },
  callbacks: { key: "callbacks", label: "Devoluções de chamada", source: "dashboard" },
  waMessages: { key: "waMessages", label: "Mensagens WhatsApp", source: "dashboard" },
  emails: { key: "emails", label: "Emails enviados", source: "dashboard" },
  complaintMsgs: { key: "complaintMsgs", label: "Respostas em reclamações", source: "dashboard" },
  complaintsClosed: { key: "complaintsClosed", label: "Reclamações fechadas", source: "dashboard" },
  reviewsReplied: { key: "reviewsReplied", label: "Críticas Google respondidas", source: "dashboard" },
  expenses: { key: "expenses", label: "Despesas lançadas", source: "dashboard" },
  expensesApproved: { key: "expensesApproved", label: "Despesas aprovadas", source: "dashboard" },
  cashCounts: { key: "cashCounts", label: "Contagens de caixa", source: "dashboard" },
  cashCorrections: { key: "cashCorrections", label: "Correções de caixa", source: "dashboard" },
  tasksDone: { key: "tasksDone", label: "Tarefas concluídas", source: "dashboard" },
  leadsActions: { key: "leadsActions", label: "Respostas a leads", source: "dashboard" },
  handovers: { key: "handovers", label: "Passagens de turno", source: "dashboard" },
  tlDays: { key: "tlDays", label: "Dias como team leader", source: "dashboard" },
  teamPeople: { key: "teamPeople", label: "Pessoas na equipa (média)", source: "dashboard", max: true },
  partnerAccounts: { key: "partnerAccounts", label: "Contas de parceiros", source: "dashboard" },
  partnerClosings: { key: "partnerClosings", label: "Fechos de mês de parceiros", source: "dashboard" },
  extrasDia: { key: "extrasDia", label: "Extras do dia escalados", source: "dashboard" },
  crmUpdates: { key: "crmUpdates", label: "Atualizações do CRM", source: "dashboard" },
  lostFound: { key: "lostFound", label: "Perdidos e achados", source: "dashboard" },
  returnFlights: { key: "returnFlights", label: "Voos de regresso registados", source: "multipark" },
  partnerCharges: { key: "partnerCharges", label: "Cobranças de parceiros", source: "multipark" },
};

export type PerfTotals = Record<PerfMetric, number>;
export const emptyTotals = (): PerfTotals => Object.fromEntries(Object.keys(PERF_METRICS).map((k) => [k, 0])) as PerfTotals;

/** Soma b em a (máximos onde é máximo). Muda `a`. PURA quanto ao resto. */
export function addTotals(a: PerfTotals, b: Partial<PerfTotals>): PerfTotals {
  for (const [k, v] of Object.entries(b) as Array<[PerfMetric, number]>) {
    if (!Number.isFinite(v)) continue;
    a[k] = PERF_METRICS[k].max ? Math.max(a[k], v) : a[k] + v;
  }
  return a;
}

/**
 * O que cada aba mostra (cartões, colunas, gráfico) e o peso de cada coisa
 * nos "pontos de trabalho" do ranking. Pesos negativos = descontam. Nos
 * condutores e team leaders o trabalho na rua conta pelos pontos da
 * avaliação (as mesmas regras de sempre: recolhas, entregas, movimentos,
 * levar ao parque, atrasos, reclamações, acidentes…).
 */
export const GROUP_VIEW: Record<PerfGroup, { cards: PerfMetric[]; columns: PerfMetric[]; chart: PerfMetric[]; weights: Partial<Record<PerfMetric, number>> }> = {
  office: {
    cards: ["hours", "callsAnswered", "emails", "waMessages", "created", "updated", "complaintMsgs", "reviewsReplied"],
    columns: ["hours", "callsAnswered", "callsMade", "emails", "waMessages", "created", "updated", "returnFlights", "complaintMsgs", "complaintsClosed", "reviewsReplied", "lostFound", "crmUpdates", "partnerAccounts", "partnerClosings", "partnerCharges", "expenses", "cashCorrections", "tasksDone", "leadsActions"],
    chart: ["callsAnswered", "emails", "created", "updated"],
    weights: { callsAnswered: 2, callsMade: 1, callbacks: 1, emails: 2, waMessages: 0.5, created: 3, updated: 1, returnFlights: 1, complaintMsgs: 2, complaintsClosed: 3, reviewsReplied: 2, lostFound: 2, crmUpdates: 1, partnerAccounts: 1, partnerClosings: 3, partnerCharges: 3, expenses: 1, expensesApproved: 1, cashCorrections: 2, cashCounts: 1, tasksDone: 1, leadsActions: 1 },
  },
  supervision: {
    cards: ["hours", "leadsActions", "created", "updated", "cashCorrections", "complaintsClosed", "tasksDone", "callsAnswered"],
    columns: ["hours", "leadsActions", "extrasDia", "created", "updated", "returnFlights", "callsAnswered", "emails", "waMessages", "complaintMsgs", "complaintsClosed", "reviewsReplied", "lostFound", "crmUpdates", "partnerAccounts", "partnerClosings", "partnerCharges", "expenses", "expensesApproved", "cashCounts", "cashCorrections", "handovers", "tasksDone"],
    chart: ["leadsActions", "created", "cashCorrections", "complaintsClosed"],
    weights: { leadsActions: 2, extrasDia: 1, created: 3, updated: 1, returnFlights: 1, callsAnswered: 2, callsMade: 1, emails: 2, waMessages: 0.5, complaintMsgs: 2, complaintsClosed: 3, reviewsReplied: 2, lostFound: 2, crmUpdates: 1, partnerAccounts: 1, partnerClosings: 3, partnerCharges: 3, expenses: 1, expensesApproved: 2, cashCounts: 2, cashCorrections: 2, handovers: 2, tasksDone: 1 },
  },
  teamleaders: {
    cards: ["hours", "recolhas", "entregas", "checkingIn", "checkingOut", "callsAnswered", "tlDays", "teamPeople"],
    columns: ["hours", "evalPoints", "recolhas", "entregas", "movements", "checkingIn", "checkingOut", "updated", "returnFlights", "callsAnswered", "waMessages", "cashCounts", "handovers", "extrasDia", "lostFound", "tlDays", "teamPeople", "occurrences", "delays", "complaintsAgainst"],
    chart: ["recolhas", "entregas", "checkingIn", "checkingOut"],
    weights: { evalPoints: 1, checkingIn: 1, checkingOut: 1, updated: 1, returnFlights: 1, callsAnswered: 2, callsMade: 1, waMessages: 0.5, cashCounts: 3, handovers: 3, extrasDia: 1, lostFound: 2, occurrences: 1 },
  },
  drivers: {
    cards: ["hours", "recolhas", "entregas", "movements", "km", "overLimitDays", "occurrences", "evalPoints"],
    columns: ["hours", "workDays", "evalPoints", "recolhas", "entregas", "movements", "parkingMoves", "km", "maxSpeed", "overLimitDays", "speedAlerts", "occurrences", "delays", "complaintsAgainst", "accidents"],
    chart: ["recolhas", "entregas", "movements"],
    weights: { evalPoints: 1, overLimitDays: -10, occurrences: 1 },
  },
};

/** Pontos de trabalho = soma ponderada (as horas e os km não contam). PURA. */
export function workPoints(group: PerfGroup, t: PerfTotals): number {
  let s = 0;
  for (const [k, w] of Object.entries(GROUP_VIEW[group].weights) as Array<[PerfMetric, number]>) s += (t[k] ?? 0) * w;
  return Math.round(s * 10) / 10;
}

/** Abaixo disto de horas no período não há "por hora" (dá números absurdos). */
export const MIN_HOURS_FOR_RATE = 4;

export interface RankRow { employeeId: number; name: string; totals: PerfTotals; points: number; perHour: number | null }
export type RankMode = "total" | "perHour";

/**
 * Ranking: por pontos totais ou por pontos por hora (quem tem menos de
 * MIN_HOURS_FOR_RATE horas vai para o fim, por pontos). Desempate pelo nome.
 * Devolve com a posição e uma nota 0–100 (o melhor = 100). PURA.
 */
export function rankPeople<T extends RankRow>(rows: T[], mode: RankMode): Array<T & { rank: number; grade: number }> {
  const val = (r: RankRow) => (mode === "perHour" ? r.perHour : r.points);
  const sorted = [...rows].sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va == null && vb != null) return 1;
    if (vb == null && va != null) return -1;
    if (va != null && vb != null && vb !== va) return vb - va;
    if (b.points !== a.points) return b.points - a.points;
    return a.name.localeCompare(b.name, "pt");
  });
  const best = Math.max(0, ...sorted.map((r) => val(r) ?? 0));
  return sorted.map((r, i) => ({ ...r, rank: i + 1, grade: best > 0 && val(r) != null ? Math.max(0, Math.round(((val(r) as number) / best) * 100)) : 0 }));
}

/** Pontos por hora (null abaixo do mínimo de horas). PURA. */
export function perHourOf(points: number, hours: number): number | null {
  return hours >= MIN_HOURS_FOR_RATE ? Math.round((points / hours) * 10) / 10 : null;
}

/** Hora UTC "YYYY-MM-DD HH:00:00" → instante (ms). PURA. */
export const utcHourMs = (h: string) => Date.parse(`${String(h).replace(" ", "T").slice(0, 13)}:00:00Z`);
