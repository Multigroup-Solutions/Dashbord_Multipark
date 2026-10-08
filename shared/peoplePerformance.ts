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
import { z } from "zod";
import { addDays, lisbonHourOf, OPERATIONAL_DAY_START_HOUR } from "./lisbonDay";

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
  | "partnerCharges"
  // 37d (Jorge, 6 out 2026): "os Pro ficam numa coluna à parte junto com as avenças"
  | "proPlanCharges"
  // 42c (Jorge, 7 out 2026): a equipa do TL (o turno dele) e do supervisor (a cidade) — "os movimentos da equipa e quanto é que a equipa gastou… extras a mais, extras a menos… se a equipa não anda com o Zello… não mexe… está muito tempo parada"
  | "teamDays" | "teamPersonDays" | "teamActions" | "teamCost" | "teamNoZello" | "teamHoursStopped" | "teamShortHours" | "teamOverHours" | "teamPoints"
  // 49e (Jorge, 8 out 2026: "avança com o desempenho"): da central Vodafone também as perdidas e o tempo ao telefone
  | "callsMissed" | "callMinutes";

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
  proPlanCharges: { key: "proPlanCharges", label: "Cobranças de Pro e avenças", source: "multipark" },
  teamDays: { key: "teamDays", label: "Dias com equipa", source: "dashboard" },
  teamPersonDays: { key: "teamPersonDays", label: "Pessoas·dia da equipa", source: "dashboard" },
  teamActions: { key: "teamActions", label: "Movimentos da equipa", source: "avaliação" },
  teamCost: { key: "teamCost", label: "Custo da equipa", source: "dashboard" },
  teamNoZello: { key: "teamNoZello", label: "Equipa a mexer sem Zello", source: "zello", bad: true },
  teamHoursStopped: { key: "teamHoursStopped", label: "Horas paradas da equipa", source: "zello", bad: true },
  teamShortHours: { key: "teamShortHours", label: "Extras a menos (h·pessoa)", source: "dashboard", bad: true },
  teamOverHours: { key: "teamOverHours", label: "Extras a mais (h·pessoa)", source: "dashboard", bad: true },
  teamPoints: { key: "teamPoints", label: "Pontos da equipa", source: "avaliação" },
  callsMissed: { key: "callsMissed", label: "Chamadas perdidas", source: "dashboard", bad: true },
  callMinutes: { key: "callMinutes", label: "Minutos ao telefone", source: "dashboard" },
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

/** Peso de cada métrica nos pontos de trabalho (métrica sem peso = não conta). */
export type PerfWeights = Partial<Record<PerfMetric, number>>;

/**
 * Pesos por omissão do escritório (a supervisão usa os mesmos e mais os da
 * equipa). 1 ponto ≈ 5 minutos de trabalho — ver GROUP_VIEW.
 */
const OFFICE_WEIGHTS: PerfWeights = {
  created: 2, updated: 0.5, returnFlights: 0.5,
  callsAnswered: 0.5, callsMade: 0.5, callMinutes: 0.2, callbacks: 1,
  emails: 1, waMessages: 0.2,
  complaintMsgs: 1, complaintsClosed: 2, reviewsReplied: 1, lostFound: 2, crmUpdates: 0.5,
  partnerAccounts: 1, partnerClosings: 6, partnerCharges: 1, proPlanCharges: 1,
  expenses: 1, expensesApproved: 0.5, cashCounts: 2, cashCorrections: 1,
  tasksDone: 1, leadsActions: 1,
};

/**
 * O que cada aba mostra (cartões, colunas, gráfico) e o peso de cada coisa
 * nos "pontos de trabalho" do ranking. Pesos negativos = descontam. Nos
 * condutores e team leaders o trabalho na rua conta pelos pontos da
 * avaliação (as mesmas regras de sempre: recolhas, entregas, movimentos,
 * levar ao parque, atrasos, reclamações, acidentes…).
 *
 * Pesos (8 out 2026, Jorge: "avança com os pesos do ranking"): 1 ponto ≈ 5
 * minutos de trabalho, a mesma escala da avaliação (recolha/entrega = 3,
 * movimento = 2, levar ao parque = 5). Horas e km continuam a não dar pontos
 * (o "por hora" já divide pelas horas). As chamadas perdidas aparecem mas não
 * contam (a chamada toca em várias consolas). Estes são as OMISSÕES: o super
 * admin muda-os sem deploy em Desempenho → "Como se contam os pontos desta
 * aba" → Editar pesos (definição `perf.rankWeights`; ver effectiveWeights).
 */
export const GROUP_VIEW: Record<PerfGroup, { cards: PerfMetric[]; columns: PerfMetric[]; chart: PerfMetric[]; weights: PerfWeights }> = {
  office: {
    cards: ["hours", "callsAnswered", "emails", "waMessages", "created", "updated", "complaintMsgs", "reviewsReplied"],
    columns: ["hours", "callsAnswered", "callsMade", "callbacks", "callsMissed", "callMinutes", "emails", "waMessages", "created", "updated", "returnFlights", "complaintMsgs", "complaintsClosed", "reviewsReplied", "lostFound", "crmUpdates", "partnerAccounts", "partnerClosings", "partnerCharges", "proPlanCharges", "expenses", "cashCorrections", "tasksDone", "leadsActions"],
    chart: ["callsAnswered", "emails", "created", "updated"],
    weights: { ...OFFICE_WEIGHTS },
  },
  supervision: {
    cards: ["hours", "leadsActions", "created", "updated", "cashCorrections", "complaintsClosed", "tasksDone", "callsAnswered"],
    columns: ["hours", "teamPoints", "leadsActions", "extrasDia", "created", "updated", "returnFlights", "callsAnswered", "callsMade", "callsMissed", "callMinutes", "emails", "waMessages", "complaintMsgs", "complaintsClosed", "reviewsReplied", "lostFound", "crmUpdates", "partnerAccounts", "partnerClosings", "partnerCharges", "proPlanCharges", "expenses", "expensesApproved", "cashCounts", "cashCorrections", "handovers", "tasksDone"],
    chart: ["leadsActions", "created", "cashCorrections", "complaintsClosed"],
    weights: { teamPoints: 1, ...OFFICE_WEIGHTS, extrasDia: 0.5, handovers: 2 },
  },
  teamleaders: {
    cards: ["hours", "recolhas", "entregas", "checkingIn", "checkingOut", "callsAnswered", "tlDays", "teamPeople"],
    columns: ["hours", "evalPoints", "teamPoints", "recolhas", "entregas", "movements", "checkingIn", "checkingOut", "updated", "returnFlights", "callsAnswered", "callsMade", "callsMissed", "callMinutes", "waMessages", "cashCounts", "handovers", "extrasDia", "lostFound", "tlDays", "teamPeople", "occurrences", "delays", "complaintsAgainst"],
    chart: ["recolhas", "entregas", "checkingIn", "checkingOut"],
    weights: { evalPoints: 1, teamPoints: 1, checkingIn: 0.5, checkingOut: 0.5, updated: 0.5, returnFlights: 0.5, callsAnswered: 0.5, callsMade: 0.5, callMinutes: 0.2, waMessages: 0.2, cashCounts: 2, handovers: 2, extrasDia: 0.5, lostFound: 2, occurrences: 1 },
  },
  drivers: {
    cards: ["hours", "recolhas", "entregas", "movements", "km", "overLimitDays", "occurrences", "evalPoints"],
    columns: ["hours", "workDays", "evalPoints", "recolhas", "entregas", "movements", "parkingMoves", "km", "maxSpeed", "overLimitDays", "speedAlerts", "occurrences", "delays", "complaintsAgainst", "accidents"],
    chart: ["recolhas", "entregas", "movements"],
    weights: { evalPoints: 1, overLimitDays: -10, occurrences: 1 },
  },
};

/**
 * Pontos de trabalho = soma ponderada (as horas e os km não contam). Sem
 * `weights`, as omissões da aba; o servidor passa os pesos em vigor
 * (effectiveWeights). PURA.
 */
export function workPoints(group: PerfGroup, t: PerfTotals, weights: PerfWeights = GROUP_VIEW[group].weights): number {
  let s = 0;
  for (const [k, w] of Object.entries(weights) as Array<[PerfMetric, number]>) {
    if (UNWEIGHTED_METRICS.has(k) || !Number.isFinite(w)) continue;
    s += (t[k] ?? 0) * w;
  }
  return Math.round(s * 10) / 10;
}

// ─── 42c: a equipa do TL e do supervisor ────────────────────────────────────

/** Abas com equipa: o TL (o turno dele na escala) e o supervisor (a cidade inteira, TL incluídos). */
export const TEAM_GROUPS: ReadonlyArray<PerfGroup> = ["teamleaders", "supervision"];

/** Colunas da tabela "A equipa" (TL e supervisão). */
export const TEAM_COLUMNS: PerfMetric[] = ["teamDays", "teamPersonDays", "teamActions", "teamCost", "teamNoZello", "teamHoursStopped", "teamShortHours", "teamOverHours", "teamPoints"];

/**
 * Pontos da equipa num dia, POR PESSOA da equipa (o tamanho da equipa não
 * conta — Lisboa não ganha ao Porto só por ser maior): cada movimento
 * (recolha, entrega ou movimento) por pessoa +1; cada pessoa que mexeu
 * carros sem o Zello ligado −20 a dividir pela equipa (a equipa toda sem
 * Zello apaga um dia normal); cada hora parada por pessoa −2. São as
 * omissões; o super admin muda-as em Editar pesos (`perf.rankWeights` → team).
 */
export interface TeamPointWeights { actionsPerPerson: number; noZelloPerPerson: number; stoppedHoursPerPerson: number }
export const TEAM_POINT_WEIGHTS: Readonly<TeamPointWeights> = { actionsPerPerson: 1, noZelloPerPerson: -20, stoppedHoursPerPerson: -2 };
export const TEAM_WEIGHT_KEYS: ReadonlyArray<keyof TeamPointWeights> = ["actionsPerPerson", "noZelloPerPerson", "stoppedHoursPerPerson"];
export const TEAM_WEIGHT_LABELS: Record<keyof TeamPointWeights, string> = {
  actionsPerPerson: "Movimento da equipa (recolha, entrega ou movimento)",
  noZelloPerPerson: "Pessoa que mexeu carros sem Zello",
  stoppedHoursPerPerson: "Hora parada (GPS)",
};

export interface TeamDay { people: number; actions: number; noZello: number; hoursStopped: number }

/** Pontos da equipa num dia (0 sem gente). Sem `w`, as omissões; o servidor passa os em vigor (effectiveTeamWeights). PURA. */
export function teamDayPoints(t: TeamDay, w: TeamPointWeights = TEAM_POINT_WEIGHTS): number {
  if (!(t.people > 0)) return 0;
  const v = (t.actions / t.people) * w.actionsPerPerson + (t.noZello / t.people) * w.noZelloPerPerson + (t.hoursStopped / t.people) * w.stoppedHoursPerPerson;
  return Math.round(v * 10) / 10;
}

// ─── Pesos editáveis (Jorge, 8 out 2026: "avança com os pesos do ranking") ──

/**
 * Definição com as sobreposições dos pesos (Definições → Parâmetros, ou o
 * botão Editar pesos do Desempenho). Só o que difere das omissões do código:
 * `{ "office": { "created": 3 }, "team": { "noZelloPerPerson": -10 } }`.
 * Um peso 0 = "não conta"; uma métrica ausente = a omissão. `{}` = omissões.
 */
export const PERF_RANK_WEIGHTS_KEY = "perf.rankWeights" as const;
/** Limite de cada peso (para os dois lados). */
export const RANK_WEIGHT_LIMIT = 10_000;
/** Nunca dão pontos: o "por hora" já divide pelas horas, e os km não são trabalho feito. */
export const UNWEIGHTED_METRICS: ReadonlySet<PerfMetric> = new Set<PerfMetric>(["hours", "km"]);

export const isPerfMetric = (k: string): k is PerfMetric => Object.prototype.hasOwnProperty.call(PERF_METRICS, k);
const oneDecimal = (n: number) => Math.abs(n * 10 - Math.round(n * 10)) < 1e-6;

/** Um peso: número entre −10 000 e 10 000, no máximo 1 casa decimal. */
export const rankWeightSchema = z.number({ error: "O peso tem de ser um número." })
  .min(-RANK_WEIGHT_LIMIT, "O peso tem de estar entre −10 000 e 10 000.")
  .max(RANK_WEIGHT_LIMIT, "O peso tem de estar entre −10 000 e 10 000.")
  .refine(oneDecimal, "O peso só pode ter 1 casa decimal (ex.: 0,5).")
  .transform((n) => Math.round(n * 10) / 10);

const groupWeightsSchema = z.record(z.string(), rankWeightSchema).superRefine((rec, ctx) => {
  for (const k of Object.keys(rec)) {
    if (!isPerfMetric(k)) ctx.addIssue({ code: "custom", message: `Métrica desconhecida: ${k}.` });
    else if (UNWEIGHTED_METRICS.has(k)) ctx.addIssue({ code: "custom", message: `${PERF_METRICS[k].label}: horas e km não dão pontos.` });
  }
});

const teamWeightsSchema = z.strictObject({
  actionsPerPerson: rankWeightSchema.optional(),
  noZelloPerPerson: rankWeightSchema.optional(),
  stoppedHoursPerPerson: rankWeightSchema.optional(),
}, { error: (iss) => (iss.code === "unrecognized_keys" ? `Peso da equipa desconhecido: ${iss.keys.join(", ")} (usa actionsPerPerson, noZelloPerPerson ou stoppedHoursPerPerson).` : undefined) });

/** Sobreposições dos pesos do ranking, por aba, e os da equipa. */
export const rankWeightsSchema = z.strictObject({
  office: groupWeightsSchema.optional(),
  supervision: groupWeightsSchema.optional(),
  teamleaders: groupWeightsSchema.optional(),
  drivers: groupWeightsSchema.optional(),
  team: teamWeightsSchema.optional(),
}, {
  error: (iss) => (iss.code === "unrecognized_keys" ? `Aba desconhecida: ${iss.keys.join(", ")} (usa office, supervision, teamleaders, drivers ou team).`
    : iss.code === "invalid_type" ? 'Tem de ser um objeto, ex.: {"office": {"created": 3}}.' : undefined),
});
export type RankWeightOverrides = z.output<typeof rankWeightsSchema>;

/**
 * Pesos em vigor numa aba: as omissões do código com as sobreposições por
 * cima. Um 0 fica (= não conta, e o ecrã mostra-o como alterado); métricas
 * desconhecidas, horas e km são ignoradas. PURA.
 */
export function effectiveWeights(group: PerfGroup, overrides?: RankWeightOverrides | null): PerfWeights {
  const out: PerfWeights = { ...GROUP_VIEW[group].weights };
  for (const [k, v] of Object.entries(overrides?.[group] ?? {})) {
    if (isPerfMetric(k) && !UNWEIGHTED_METRICS.has(k) && typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** Pesos da equipa em vigor (omissões + sobreposições). PURA. */
export function effectiveTeamWeights(overrides?: RankWeightOverrides | null): TeamPointWeights {
  const out: TeamPointWeights = { ...TEAM_POINT_WEIGHTS };
  const t = overrides?.team ?? {};
  for (const k of TEAM_WEIGHT_KEYS) {
    const v = t[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * O que o editor grava para uma aba: só os pesos que diferem da omissão (uma
 * métrica sem omissão com 0 não é sobreposição — já não contava). PURA.
 */
export function weightOverridesOf(group: PerfGroup, edited: PerfWeights): PerfWeights {
  const defaults = GROUP_VIEW[group].weights;
  const out: PerfWeights = {};
  for (const [k, v] of Object.entries(edited) as Array<[PerfMetric, number]>) {
    if (!isPerfMetric(k) || UNWEIGHTED_METRICS.has(k) || typeof v !== "number" || !Number.isFinite(v)) continue;
    if ((defaults[k] ?? 0) === v) continue;
    out[k] = v;
  }
  return out;
}

/** O mesmo para os pesos da equipa. PURA. */
export function teamWeightOverridesOf(edited: Partial<TeamPointWeights>): Partial<TeamPointWeights> {
  const out: Partial<TeamPointWeights> = {};
  for (const k of TEAM_WEIGHT_KEYS) {
    const v = edited[k];
    if (typeof v === "number" && Number.isFinite(v) && v !== TEAM_POINT_WEIGHTS[k]) out[k] = v;
  }
  return out;
}

/**
 * Junta o que se grava de uma aba (e, se vier, da equipa) às sobreposições
 * que já lá estão das outras abas. Vazio sai (volta à omissão). PURA.
 */
export function withTabOverrides(all: RankWeightOverrides | null | undefined, group: PerfGroup, groupOverrides: PerfWeights, team?: Partial<TeamPointWeights>): RankWeightOverrides {
  const next: RankWeightOverrides = { ...(all ?? {}) };
  if (Object.keys(groupOverrides).length) next[group] = { ...groupOverrides } as Record<string, number>;
  else delete next[group];
  if (team !== undefined) {
    if (Object.keys(team).length) next.team = { ...team };
    else delete next.team;
  }
  return next;
}

/** "+1", "−20", "+0,5", "0" (o sinal menos tipográfico, vírgula decimal). PURA. */
export function signedWeight(n: number): string {
  const abs = String(Math.abs(Math.round(n * 10) / 10)).replace(".", ",");
  return n > 0 ? `+${abs}` : n < 0 ? `−${abs}` : "0";
}

/**
 * 42c: a aba pela ESCALA do período — quem tem posto de condutor/extra mas
 * foi team leader em pelo menos metade dos dias em que esteve escalado conta
 * como team leader (ex.: um extra que passou a chefe de turno). PURA.
 */
export function rosterGroup(base: PerfGroup | null, roster: { days: number; tlDays: number } | undefined): PerfGroup | null {
  if (base === "drivers" && roster && roster.tlDays > 0 && roster.tlDays * 2 >= roster.days) return "teamleaders";
  return base;
}

/** 42c: "tem km e nenhum movimento" — o Zello/PDA e o agente da Multipark não estão na mesma ficha. PURA. */
export function kmWithoutMoves(t: Pick<PerfTotals, "km" | "recolhas" | "entregas" | "movements">): boolean {
  return t.km > 0 && t.recolhas + t.entregas + t.movements === 0;
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

// ─── 49e: telefonemas da central, emails das caixas pessoais, atividade por hora ──

/**
 * 39g/49e: uma chamada da central (consola Vodafone) é interna quando a
 * consola a ligou a um colega do RH ("emp-…") ou a uma extensão ("ext-…").
 * As internas não contam — exceto o supervisor a ligar a um extra (a chamar
 * o pessoal). O que cada chamada dá no Desempenho de quem a atendeu ou fez
 * (o SQL de server/peoplePerformance.ts faz o mesmo, agrupado). PURA.
 *  - recebida e atendida → atendida (+ minutos);
 *  - recebida e não atendida → perdida;
 *  - feita → feita (+ minutos); e devolução quando é a 1.ª chamada feita
 *    para um número/contacto com uma perdida nas 24 h anteriores.
 */
export function centralCallMetrics(c: {
  direction: "in" | "out"; held: boolean; contactRef: string | null; durationS: number | null;
  callerIsSupervisor?: boolean; otherIsExtra?: boolean; returnsMissed?: boolean;
}): Partial<Record<PerfMetric, number>> {
  const ref = String(c.contactRef ?? "");
  const internal = /^(emp|ext)-/.test(ref);
  const minutes = Math.max(0, Number(c.durationS ?? 0) || 0) / 60;
  if (c.direction === "in") {
    if (internal) return {};
    return c.held ? { callsAnswered: 1, callMinutes: minutes } : { callsMissed: 1 };
  }
  const supToExtra = ref.startsWith("emp-") && !!c.callerIsSupervisor && !!c.otherIsExtra;
  if (internal && !supToExtra) return {};
  return { callsMade: 1, callMinutes: minutes, ...(!internal && c.returnsMissed ? { callbacks: 1 } : {}) };
}

/** Janela da devolução: liga de volta até 24 h depois da perdida. */
export const CALLBACK_WINDOW_HOURS = 24;

/**
 * 49e: de quem é um email enviado. Uma linha de mail_messages conta UMA vez:
 *  - enviado pela dashboard → quem carregou em Enviar (`sentById`);
 *  - senão, enviado da caixa Gmail PESSOAL ligada (conta "user:N", fora das
 *    caixas partilhadas) → o dono dessa conta, N;
 *  - enviado diretamente de uma caixa partilhada (info@, reservas@…) fora da
 *    dashboard → sem autor (não conta).
 * Automáticos e recebidos nunca contam. PURA.
 */
export function emailAuthorOf(m: { direction: string; automated: number | null; sentById: number | null; accountKey: string | null; mailboxKey: string | null }): number | null {
  if (m.direction !== "out" || Number(m.automated ?? 0) !== 0) return null;
  if (m.sentById != null) return Number(m.sentById);
  const own = /^user:(\d+)$/.exec(String(m.accountKey ?? ""));
  return own && m.mailboxKey == null ? Number(own[1]) : null;
}

export const HOURS_OF_DAY = 24;
export const emptyHours = (): number[] => new Array(HOURS_OF_DAY).fill(0);

/** Hora de RELÓGIO de Lisboa (0–23) de uma hora UTC agrupada no SQL ("YYYY-MM-DD HH"); inválida → null. PURA. */
export function lisbonHourOfUtcHour(h: string): number | null {
  const ms = utcHourMs(h);
  return Number.isFinite(ms) ? lisbonHourOf(ms) : null;
}

/** Contagens por hora guardadas pela avaliação ("[0,0,…]", 24 números) → lista; outra coisa → null. PURA. */
export function parseHours(raw: unknown): number[] | null {
  if (raw == null || raw === "") return null;
  let v: unknown = raw;
  if (typeof raw === "string") { try { v = JSON.parse(raw); } catch { return null; } }
  if (!Array.isArray(v) || v.length !== HOURS_OF_DAY) return null;
  return v.map((x) => Math.max(0, Number(x) || 0));
}

/** Soma b em a (24 horas). Muda `a`. */
export function addHours(a: number[], b: ReadonlyArray<number>): number[] {
  for (let i = 0; i < HOURS_OF_DAY; i++) a[i] += Number(b[i] ?? 0) || 0;
  return a;
}

/**
 * Nível de cor de uma célula da grelha pessoa × hora: 0 = vazio; 1…levels
 * proporcional ao máximo (arredondado para cima: qualquer ação já pinta). PURA.
 */
export function heatLevel(v: number, max: number, levels = 5): number {
  if (!(v > 0) || !(max > 0)) return 0;
  return Math.min(levels, Math.max(1, Math.ceil((v / max) * levels)));
}

/**
 * Primeira e última hora com ações e a hora de pico, contadas pela ordem do
 * dia operacional (03h → 02h): quem faz a noite aparece "15h → 2h", não
 * "0h → 23h". Sem ações → nulls. PURA.
 */
export function hourSpan(hours: ReadonlyArray<number>): { first: number | null; last: number | null; peak: number | null } {
  const order = Array.from({ length: HOURS_OF_DAY }, (_, i) => (i + OPERATIONAL_DAY_START_HOUR) % HOURS_OF_DAY);
  const on = order.filter((h) => (hours[h] ?? 0) > 0);
  if (!on.length) return { first: null, last: null, peak: null };
  let peak = on[0];
  for (const h of on) if (hours[h] > hours[peak]) peak = h;
  return { first: on[0], last: on[on.length - 1], peak };
}
