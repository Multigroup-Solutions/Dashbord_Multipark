/**
 * Carta de condução dos extras (Jorge, 7 out 2026: "deve haver 'carta
 * pendente de validação' e 'carta validada'. Carta validada é quando o
 * condutor tem carta há mais de 3 anos").
 *
 * Decisão (7 out 2026): carta com menos de 3 anos → etiqueta + AVISO ao
 * escalar; nunca bloqueia.
 *
 * Estados (PURO — igual no cliente e no servidor):
 *   - "validated"  Carta validada: o RH viu a carta (data de emissão) E a
 *                  carta já tem 3 anos completos (calendário de Lisboa).
 *   - "under_3y"   Carta < 3 anos: a data de emissão (validada ou declarada
 *                  na candidatura) dá menos de 3 anos completos.
 *   - "pending"    Carta pendente de validação: há carta (documento, n.º ou
 *                  data declarada) mas o RH ainda não a validou.
 *   - "missing"    Sem carta: nada sobre a carta.
 *
 * Os anos contam no aniversário da emissão; uma carta de 29/02 faz anos a
 * 28/02 nos anos não bissextos (art. 279.º c) do Código Civil: sem dia
 * correspondente, o prazo acaba no último dia desse mês).
 */

export const LICENCE_MIN_YEARS = 3;

export const LICENCE_STATUSES = ["validated", "pending", "under_3y", "missing"] as const;
export type LicenceStatus = (typeof LICENCE_STATUSES)[number];

export const LICENCE_STATUS_LABELS: Record<LicenceStatus, string> = {
  validated: "Carta validada",
  pending: "Carta pendente de validação",
  under_3y: "Carta < 3 anos",
  missing: "Sem carta",
};

/** Explicação curta (tooltips e avisos). */
export const LICENCE_STATUS_HINTS: Record<LicenceStatus, string> = {
  validated: "O RH validou a carta e tem 3 ou mais anos.",
  pending: "Há carta (documento ou dados), mas o RH ainda não a validou.",
  under_3y: "A carta tem menos de 3 anos.",
  missing: "Não há carta na ficha (nem documento, nem número, nem data).",
};

/** Postos que conduzem (a etiqueta da carta interessa sempre). */
export const DRIVING_POSITIONS = ["extra", "driver", "senior_driver", "team_leader", "supervisor"] as const;

/**
 * Mostrar a etiqueta da carta nesta ficha? Sempre nos postos que conduzem;
 * nos outros (escritório, direção) só se houver alguma coisa da carta —
 * "Sem carta" num back office seria ruído. PURA.
 */
export function licenceRelevant(position: string | null | undefined, status: LicenceStatus | null | undefined): boolean {
  if (!status) return false;
  return (DRIVING_POSITIONS as readonly string[]).includes(String(position ?? "")) || status !== "missing";
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysInMonth(y: number, m1: number): number {
  return new Date(Date.UTC(y, m1, 0)).getUTCDate();
}

/** "YYYY-MM-DD" válido (dia que existe no calendário)? PURA. */
export function isCalendarDay(day: string | null | undefined): day is string {
  const m = DAY_RE.exec(String(day ?? ""));
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

/**
 * Anos COMPLETOS de `from` a `to` (dias "YYYY-MM-DD"). Faz anos no dia do
 * aniversário; 29/02 faz anos a 28/02 nos anos não bissextos. -1 se `from`
 * for depois de `to` (ainda não começou). PURA.
 */
export function fullYearsBetween(from: string, to: string): number {
  if (!isCalendarDay(from) || !isCalendarDay(to)) throw new Error(`Data inválida: ${from} / ${to}`);
  if (from > to) return -1;
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  let years = ty - fy;
  const anniversary = Math.min(fd, daysInMonth(ty, fm));
  if (tm < fm || (tm === fm && td < anniversary)) years--;
  return years;
}

/** Dia em que a carta faz `years` anos completos ("YYYY-MM-DD"). PURA. */
export function licenceAnniversary(issuedAt: string, years = LICENCE_MIN_YEARS): string {
  if (!isCalendarDay(issuedAt)) throw new Error(`Data inválida: ${issuedAt}`);
  const [y, m, d] = issuedAt.split("-").map(Number);
  const ty = y + years;
  const day = Math.min(d, daysInMonth(ty, m));
  return `${ty}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export interface LicenceFacts {
  /** Data de emissão (validada pelo RH ou declarada na candidatura), "YYYY-MM-DD". */
  issuedAt: string | null | undefined;
  /** Quando o RH validou a carta (null = por validar). */
  validatedAt: string | null | undefined;
  /** Há documento da carta entregue (pendente ou validado; recusados não contam). */
  hasDocument?: boolean;
  /** Há n.º da carta na ficha. */
  hasNumber?: boolean;
}

/** Estado da carta hoje (`today` = dia de Lisboa, "YYYY-MM-DD"). PURA. */
export function licenceStatus(f: LicenceFacts, today: string): LicenceStatus {
  const issued = isCalendarDay(f.issuedAt ?? null) ? (f.issuedAt as string) : null;
  if (issued && issued > today) return "pending"; // data no futuro: engano, o RH corrige ao validar
  if (issued && fullYearsBetween(issued, today) < LICENCE_MIN_YEARS) return "under_3y";
  if (issued && f.validatedAt) return "validated";
  if (issued || f.hasDocument || f.hasNumber) return "pending";
  return "missing";
}

/** Escalar esta pessoa merece aviso (nunca bloqueia)? Texto PT-PT ou null. PURA. */
export function licenceScheduleWarning(status: LicenceStatus | null | undefined, name?: string | null): string | null {
  const who = name?.trim() || "Esta pessoa";
  switch (status) {
    case "under_3y": return `${who} tem carta há menos de 3 anos. Podes escalar, mas confirma que pode conduzir os carros deste turno.`;
    case "pending": return `A carta de ${name?.trim() || "esta pessoa"} ainda não foi validada pelo RH.`;
    case "missing": return `${who} não tem carta na ficha. Confirma com o RH antes de a pôr a conduzir.`;
    default: return null;
  }
}

/**
 * "Data de Emissão da Carta" no payload da candidatura do site (quando o site
 * a enviar). Só chaves de EMISSÃO da carta — nunca o n.º nem a validade.
 * Aceita "YYYY-MM-DD", "DD/MM/YYYY" e "DD-MM-YYYY" (também com hora ISO).
 * PURA.
 */
export function licenceIssueDateFromPayload(payload: unknown): string | null {
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { return null; }
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (!isLicenceIssueKey(k)) continue;
    const day = parseDay(v);
    if (day) return day;
  }
  return null;
}

/** "Data de Emissão da Carta", "licenseIssueDate", "license_issue_date"… PURA. */
export function isLicenceIssueKey(key: string): boolean {
  const k = key.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const aboutLicence = /carta|licen[cs]e|licen[cs]a|driving/.test(k);
  const aboutIssue = /emiss|emitid|issue|obten/.test(k);
  return aboutLicence && aboutIssue;
}

function parseDay(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s);
  if (m) return isCalendarDay(`${m[1]}-${m[2]}-${m[3]}`) ? `${m[1]}-${m[2]}-${m[3]}` : null;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) {
    const day = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    return isCalendarDay(day) ? day : null;
  }
  return null;
}
