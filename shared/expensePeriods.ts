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
