/**
 * Datas das despesas são DIAS DE CALENDÁRIO (Europe/Lisbon), não instantes.
 * A coluna `expenses.expenseDate` guarda "YYYY-MM-DD 00:00:00"; os filtros
 * comparam com "YYYY-MM-DD 00:00:00" … "YYYY-MM-DD 23:59:59" — o último dia
 * do intervalo entra SEMPRE por inteiro (o Excel perdia-o: usava 00:00:00).
 *
 * Tudo aqui é puro (sem Date local) para o cliente e o servidor concordarem.
 */

const ISO_DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function isIsoDay(s: unknown): s is string {
  if (typeof s !== "string" || !ISO_DAY.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= dim;
}

/** Limites SQL (inclusivos) de um intervalo de dias. Dias inválidos → erro. */
export function dayBounds(startDate?: string | null, endDate?: string | null): { start?: string; end?: string } {
  const out: { start?: string; end?: string } = {};
  if (startDate) {
    if (!isIsoDay(startDate)) throw new Error(`Data inicial inválida: ${startDate}`);
    out.start = `${startDate} 00:00:00`;
  }
  if (endDate) {
    if (!isIsoDay(endDate)) throw new Error(`Data final inválida: ${endDate}`);
    out.end = `${endDate} 23:59:59`;
  }
  if (out.start && out.end && out.start > out.end) {
    throw new Error("A data inicial é posterior à data final");
  }
  return out;
}

/** "YYYY-MM-DD" → "YYYY-MM-DD 00:00:00" (valor a GRAVAR em expenseDate/paymentDueDate). */
export function dayToMysql(day: string): string {
  if (!isIsoDay(day)) throw new Error(`Data inválida: ${day}`);
  return `${day} 00:00:00`;
}

/** Dia de calendário em Lisboa para um instante (por omissão, agora). */
export function lisbonToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function daysInMonth(y: number, m1: number): number {
  return new Date(Date.UTC(y, m1, 0)).getUTCDate();
}
const pad = (n: number) => String(n).padStart(2, "0");

export interface ComparePeriods {
  a: { from: string; to: string; label: string };
  b: { from: string; to: string; label: string };
  mode: "month_to_date" | "full_months";
}

/**
 * Períodos EQUIVALENTES por defeito: mês até hoje vs. os MESMOS dias do mês
 * anterior (1–9 set vs. 1–9 ago). Comparar setembro inteiro com agosto até ao
 * dia 9 dava sempre "gastaste menos". `full_months` compara meses completos.
 * `offsetMonths` = 1 (mês anterior) ou 12 (homólogo).
 */
export function comparePeriods(
  today: string,
  mode: ComparePeriods["mode"] = "month_to_date",
  offsetMonths = 1,
): ComparePeriods {
  if (!isIsoDay(today)) throw new Error(`Data inválida: ${today}`);
  const [y, m, d] = today.split("-").map(Number);
  // mês de referência B
  const total = y * 12 + (m - 1) - offsetMonths;
  const by = Math.floor(total / 12);
  const bm = (total % 12) + 1;
  const aFrom = `${y}-${pad(m)}-01`;
  const bFrom = `${by}-${pad(bm)}-01`;
  if (mode === "full_months") {
    return {
      mode,
      a: { from: aFrom, to: `${y}-${pad(m)}-${pad(daysInMonth(y, m))}`, label: `${y}-${pad(m)} completo` },
      b: { from: bFrom, to: `${by}-${pad(bm)}-${pad(daysInMonth(by, bm))}`, label: `${by}-${pad(bm)} completo` },
    };
  }
  const bd = Math.min(d, daysInMonth(by, bm));
  return {
    mode,
    a: { from: aFrom, to: today, label: `1–${d} de ${pad(m)}/${y}` },
    b: { from: bFrom, to: `${by}-${pad(bm)}-${pad(bd)}`, label: `1–${bd} de ${pad(bm)}/${by}` },
  };
}

/** Dia `n` meses depois do dia 1 do mês de `day` ("YYYY-MM-01"). */
function monthStart(day: string, n = 0): string {
  const [y, m] = day.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}-01`;
}

/** Janela [início, fim) em "YYYY-MM-DD 00:00:00" (fim exclusivo). */
export interface StatsWindow { start: string; end: string }

/**
 * Janelas do Resumo das despesas (dias de Lisboa, semana à segunda). Cada uma
 * tem FIM: antes "este mês"/"este ano" iam até ao infinito e somavam despesas
 * com data futura (um 2027 mal escrito entrava no total deste ano). A
 * tendência são os últimos 6 meses, até ao fim do mês corrente.
 */
export function expenseStatsWindows(today: string): Record<"day" | "week" | "month" | "year" | "trend", StatsWindow> {
  if (!isIsoDay(today)) throw new Error(`Data inválida: ${today}`);
  const [y, m, d] = today.split("-").map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // segunda = 0
  const plus = (n: number) => new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  const at = (day: string) => `${day} 00:00:00`;
  return {
    day: { start: at(today), end: at(plus(1)) },
    week: { start: at(plus(-dow)), end: at(plus(7 - dow)) },
    month: { start: at(monthStart(today)), end: at(monthStart(today, 1)) },
    year: { start: at(`${y}-01-01`), end: at(`${y + 1}-01-01`) },
    trend: { start: at(monthStart(today, -5)), end: at(monthStart(today, 1)) },
  };
}

/**
 * Dias de calendário de `today` até ao vencimento (0 = hoje, 1 = amanhã).
 * `due` vem da BD ("YYYY-MM-DD 00:00:00") — conta-se pelo DIA, sem passar por
 * `new Date("… 00:00:00")`, que no Safari dá data inválida (e a página caía).
 */
export function daysUntil(due: string, today: string): number | null {
  const day = String(due ?? "").slice(0, 10);
  if (!isIsoDay(day) || !isIsoDay(today)) return null;
  const ms = (s: string) => { const [a, b, c] = s.split("-").map(Number); return Date.UTC(a, b - 1, c); };
  return Math.round((ms(day) - ms(today)) / 86_400_000);
}
