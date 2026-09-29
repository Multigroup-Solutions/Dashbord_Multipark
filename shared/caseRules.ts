/**
 * Regras PURAS de Ocorrências / Perdidos / Reclamações (sem BD, iguais no
 * cliente e no servidor). Tudo o que é "decisão" vive aqui para ser testado:
 * elegibilidade de pontos, transições de estado + timestamps, janela de
 * duplicados, mapeamento das conversões, cruzamento de condutores e escape de
 * HTML dos emails.
 *
 * Timestamps: SEMPRE UTC no formato das colunas ("YYYY-MM-DD HH:MM:SS").
 */
import { lisbonDayOf, lisbonOffsetMs } from "./lisbonDay";

// ─── Estados ────────────────────────────────────────────────────────────────
export const INCIDENT_STATUSES = ["open", "investigating", "resolved", "dismissed", "converted"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export const INCIDENT_TYPES = ["vidro_aberto", "mal_estacionado", "dano", "chave_errada", "combustivel", "limpeza", "documentos", "outro"] as const;
export const INCIDENT_SEVERITIES = ["low", "medium", "high", "critical"] as const;

export const LOST_STATUSES = ["new", "investigating", "found", "returned", "closed", "converted"] as const;
export type LostStatus = (typeof LOST_STATUSES)[number];
export const LOST_ITEM_TYPES = ["money", "electronics", "clothing", "documents", "accessories", "other"] as const;
export const LOST_PRIORITIES = ["low", "medium", "high"] as const;

export type CaseKind = "incident" | "complaint" | "lost";

const INCIDENT_CLOSED = new Set<string>(["resolved", "dismissed", "converted"]);
const LOST_CLOSED = new Set<string>(["returned", "closed", "converted"]);
export const isIncidentClosed = (s: string | null | undefined) => INCIDENT_CLOSED.has(String(s ?? ""));
export const isLostClosed = (s: string | null | undefined) => LOST_CLOSED.has(String(s ?? ""));

export function utcNowStr(now: Date = new Date()): string {
  return now.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Patch de estado de uma ocorrência: resolvedAt/resolvedBy são postos ao
 * FECHAR (resolvida, descartada ou convertida) e limpos ao REABRIR. Mudar entre
 * estados fechados mantém o instante original do fecho.
 */
export function incidentStatusPatch(
  prev: { status: string; resolvedAt?: string | null },
  next: IncidentStatus,
  nowStr: string,
  userId: number | null,
): { status: IncidentStatus; resolvedAt?: string | null; resolvedBy?: number | null } {
  if (isIncidentClosed(next)) {
    if (isIncidentClosed(prev.status) && prev.resolvedAt) return { status: next };
    return { status: next, resolvedAt: nowStr, resolvedBy: userId };
  }
  if (isIncidentClosed(prev.status) || prev.resolvedAt) return { status: next, resolvedAt: null, resolvedBy: null };
  return { status: next };
}

/** Igual para os Perdidos: closedAt/closedById ao fechar (devolvido/fechado/convertido). */
export function lostStatusPatch(
  prev: { status: string; closedAt?: string | null },
  next: LostStatus,
  nowStr: string,
  userId: number | null,
): { status: LostStatus; closedAt?: string | null; closedById?: number | null } {
  if (isLostClosed(next)) {
    if (isLostClosed(prev.status) && prev.closedAt) return { status: next };
    return { status: next, closedAt: nowStr, closedById: userId };
  }
  if (isLostClosed(prev.status) || prev.closedAt) return { status: next, closedAt: null, closedById: null };
  return { status: next };
}

// ─── Pontos justos ─────────────────────────────────────────────────────────
/**
 * Uma ocorrência só conta CONTRA o condutor quando: tem condutor, o
 * envolvimento foi confirmado (team leader+) e não foi descartada/convertida.
 */
export function incidentCountsAgainstDriver(inc: {
  employeeId?: number | null;
  driverConfirmed?: number | boolean | null;
  status?: string | null;
}): boolean {
  if (!inc.employeeId) return false;
  if (!inc.driverConfirmed) return false;
  return inc.status !== "dismissed" && inc.status !== "converted";
}

// ─── Datas ─────────────────────────────────────────────────────────────────
/** Semana ISO + ANO ISO do dia de Lisboa do instante (31 dez pode ser semana 1 do ano seguinte). */
export function isoWeekYearLisbon(at: Date | number | string): { week: number; year: number } {
  const [y, m, d] = lisbonDayOf(at).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const year = date.getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return { week, year };
}

/** Hora de parede de Lisboa ("YYYY-MM-DD HH:MM[:SS]") → UTC no formato da BD. */
export function lisbonLocalToUtc(local: string): string | null {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  let t = guess - lisbonOffsetMs(guess);
  t = guess - lisbonOffsetMs(t);
  return utcNowStr(new Date(t));
}

export function parseUtc(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
}

export const DEFAULT_INCIDENT_SLA_HOURS = 48;
export const DEFAULT_LOST_SLA_DAYS = 7;

export function incidentSlaHours(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.INCIDENT_SLA_HOURS);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 24 * 30) : DEFAULT_INCIDENT_SLA_HOURS;
}

export function addHoursUtc(fromUtc: string, hours: number): string {
  const ms = parseUtc(fromUtc) ?? Date.now();
  return utcNowStr(new Date(ms + hours * 3_600_000));
}

/** Balde de idade de um caso aberto (para o painel). */
export type AgeBucket = "lt1d" | "d1to3" | "d3to7" | "gt7d";
export function ageBucket(createdUtc: string, nowMs: number): AgeBucket {
  const h = (nowMs - (parseUtc(createdUtc) ?? nowMs)) / 3_600_000;
  if (h < 24) return "lt1d";
  if (h < 72) return "d1to3";
  if (h < 168) return "d3to7";
  return "gt7d";
}

/** Lembrete no máximo 1× por dia de Lisboa. */
export function reminderDue(lastReminderAt: string | null | undefined, now: Date): boolean {
  if (!lastReminderAt) return true;
  const last = parseUtc(lastReminderAt);
  if (last == null) return true;
  return lisbonDayOf(last) !== lisbonDayOf(now);
}

/** Horas de lembretes (Lisboa): 9h–20h. */
export function isCaseReminderHour(hour: number): boolean {
  return hour >= 9 && hour <= 20;
}

// ─── Duplicados (email ↔ remarks Multipark) ─────────────────────────────────
export const DEDUPE_WINDOW_MS = 2 * 3_600_000;

export function normalizePlateKey(p: string | null | undefined): string {
  return String(p ?? "").replace(/[\s.\-]/g, "").toUpperCase();
}

/**
 * Candidato é DUPLICADO se: mesma matrícula, a reserva não contradiz (ambas
 * iguais, ou uma delas desconhecida) e as horas distam ≤ 2h.
 */
export function isDuplicateIncident(
  a: { plate?: string | null; bookingRef?: string | null; atMs: number | null },
  b: { plate?: string | null; bookingRef?: string | null; atMs: number | null },
  windowMs: number = DEDUPE_WINDOW_MS,
): boolean {
  const pa = normalizePlateKey(a.plate), pb = normalizePlateKey(b.plate);
  if (!pa || pa !== pb) return false;
  const ra = (a.bookingRef ?? "").trim(), rb = (b.bookingRef ?? "").trim();
  if (ra && rb && ra !== rb) return false;
  if (a.atMs == null || b.atMs == null) return false;
  return Math.abs(a.atMs - b.atMs) <= windowMs;
}

// ─── HTML seguro nos emails ao cliente ─────────────────────────────────────
export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
/** Texto livre → HTML: escapa TUDO e só depois transforma quebras de linha. */
export function textToSafeHtml(s: string): string {
  return `<p>${escapeHtml(s).replace(/\r?\n/g, "<br>")}</p>`;
}

// ─── Tipos de ficheiro ─────────────────────────────────────────────────────
const MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  heic: "image/heic", heif: "image/heif", bmp: "image/bmp", svg: "image/svg+xml",
  pdf: "application/pdf", txt: "text/plain", mp4: "video/mp4", mov: "video/quicktime",
};
export function contentTypeForFilename(filename: string): string {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}
/** Extensão segura para a key do storage (só [a-z0-9], máx. 5). */
export function safeExt(filename: string): string {
  const ext = (filename.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5);
  return ext || "bin";
}

// ─── Conversões (mapeamento de campos) ─────────────────────────────────────
export const INCIDENT_TYPE_LABEL: Record<string, string> = {
  vidro_aberto: "Vidro Aberto", mal_estacionado: "Mal Estacionado", dano: "Dano",
  chave_errada: "Chave Errada", combustivel: "Combustível", limpeza: "Limpeza",
  documentos: "Documentos", outro: "Ocorrência",
};

type Incident = {
  id: number; incidentType: string; severity: string; description?: string | null;
  vehiclePlate?: string | null; projectId?: number | null; reservationLink?: string | null;
  costAmount?: string | number | null; employeeId?: number | null;
};
type Lost = {
  id: number; description?: string | null; priority?: string | null; clientName?: string | null;
  clientEmail?: string | null; clientPhone?: string | null; vehiclePlate?: string | null;
  bookingRef?: string | null; projectId?: number | null; assignedTo?: number | null;
  clientNotes?: string | null; itemType?: string | null; estimatedValue?: number | null;
};
type Complaint = {
  id: number; title: string; description?: string | null; complaintPriority?: string | null;
  complaintType?: string | null; clientName?: string | null; clientEmail?: string | null;
  clientPhone?: string | null; vehiclePlate?: string | null; reservationRef?: string | null;
  projectId?: number | null; assignedToId?: number | null; clientNotes?: string | null;
};

const LOST_TYPE_LABEL: Record<string, string> = {
  money: "Dinheiro", electronics: "Eletrónica", clothing: "Roupa", documents: "Documentos", accessories: "Acessórios", other: "Outro",
};

const isBookingRef = (s: string | null | undefined) => !!s && /^[A-Za-z0-9_-]{4,128}$/.test(s.trim());

export function incidentToComplaintFields(inc: Incident) {
  const prio = inc.severity === "critical" ? "urgent" : inc.severity === "high" ? "high" : inc.severity === "low" ? "low" : "medium";
  return {
    title: `${INCIDENT_TYPE_LABEL[inc.incidentType] ?? "Ocorrência"}${inc.vehiclePlate ? ` — ${inc.vehiclePlate}` : ""}: ${(inc.description ?? "").split("\n")[0]}`.slice(0, 255),
    description: inc.description ?? null,
    complaintType: (inc.incidentType === "dano" ? "damage" : inc.incidentType === "limpeza" ? "dirt" : "other") as "damage" | "dirt" | "other",
    complaintStatus: "new" as const,
    complaintPriority: prio as "urgent" | "high" | "low" | "medium",
    vehiclePlate: inc.vehiclePlate ?? null,
    reservationRef: isBookingRef(inc.reservationLink) ? inc.reservationLink!.trim() : null,
    projectId: inc.projectId ?? null,
    convertedFromType: "incident" as const,
    convertedFromId: inc.id,
  };
}

export function incidentToLostFields(inc: Incident) {
  return {
    clientName: "Desconhecido",
    vehiclePlate: inc.vehiclePlate ?? null,
    bookingRef: isBookingRef(inc.reservationLink) ? inc.reservationLink!.trim() : null,
    projectId: inc.projectId ?? null,
    itemType: "other" as const,
    description: inc.description || `Ocorrência #${inc.id}`,
    estimatedValue: inc.costAmount != null && inc.costAmount !== "" ? Math.round(Number(inc.costAmount)) || null : null,
    status: "new" as const,
    priority: (inc.severity === "critical" || inc.severity === "high" ? "high" : inc.severity === "low" ? "low" : "medium") as "high" | "low" | "medium",
    convertedFromType: "incident" as const,
    convertedFromId: inc.id,
  };
}

export function lostToComplaintFields(item: Lost) {
  const typeLabel = item.itemType && item.itemType !== "other" ? `[${LOST_TYPE_LABEL[item.itemType] ?? item.itemType}] ` : "";
  const value = item.estimatedValue ? `\n\nValor estimado: ${item.estimatedValue}€` : "";
  return {
    title: `${typeLabel}${(item.description || `Perdido #${item.id}`).split("\n")[0]}`.slice(0, 255),
    description: `${item.description ?? ""}${value}`.trim() || null,
    complaintType: "other" as const,
    complaintStatus: "new" as const,
    complaintPriority: (item.priority === "high" ? "high" : item.priority === "low" ? "low" : "medium") as "high" | "low" | "medium",
    clientName: item.clientName ?? null,
    clientEmail: item.clientEmail ?? null,
    clientPhone: item.clientPhone ?? null,
    vehiclePlate: item.vehiclePlate ?? null,
    reservationRef: item.bookingRef ?? null,
    projectId: item.projectId ?? null,
    assignedToId: item.assignedTo ?? null,
    clientNotes: item.clientNotes ?? null,
    convertedFromType: "lost" as const,
    convertedFromId: item.id,
  };
}

export function complaintToLostFields(c: Complaint) {
  return {
    clientName: c.clientName || "Desconhecido",
    clientEmail: c.clientEmail ?? null,
    clientPhone: c.clientPhone ?? null,
    vehiclePlate: c.vehiclePlate ?? null,
    bookingRef: c.reservationRef ?? null,
    projectId: c.projectId ?? null,
    itemType: "other" as const,
    description: `${c.title}${c.description ? `\n\n${c.description}` : ""}`.trim(),
    status: "new" as const,
    priority: (c.complaintPriority === "urgent" || c.complaintPriority === "high" ? "high" : c.complaintPriority === "low" ? "low" : "medium") as "high" | "low" | "medium",
    clientNotes: c.clientNotes ?? null,
    assignedTo: c.assignedToId ?? null,
    convertedFromType: "complaint" as const,
    convertedFromId: c.id,
  };
}

/** Patch aplicado ao ORIGINAL numa conversão (fica fechado e ligado ao novo). */
export function convertedOriginPatch(toType: CaseKind, toId: number) {
  return { convertedToType: toType, convertedToId: toId };
}

// ─── Cruzamento de condutores ───────────────────────────────────────────────
export function normName(s: string | null | undefined): string {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase().replace(/\s+/g, " ");
}
export function driverKey(employeeId: number | null | undefined, name: string | null | undefined): string {
  return employeeId ? `e:${employeeId}` : `n:${normName(name)}`;
}

export interface CrossRefLink {
  caseId: number;
  via: "attached" | "movement";
  employeeId: number | null;
  name: string | null;
}
export interface CrossRefMovementTotal { employeeId: number | null; agentName: string; total: number; inCase: number }
export interface CrossRefRow {
  key: string;
  employeeId: number | null;
  name: string;
  caseCount: number;
  caseIds: number[];
  attachedCases: number;
  movementCases: number;
  incidents: number;
  complaints: number;
  totalMovements: number;
  caseMovements: number;
  /** % dos movimentos do condutor (no período) que foram em reservas com caso. */
  caseRate: number | null;
  /** Razão face à média da equipa (1 = igual à média). */
  vsTeam: number | null;
}

/**
 * Agrega as ligações caso↔condutor (anexados + quem mexeu na reserva) por
 * condutor: nº de casos DISTINTOS, incidentes/reclamações no período e % de
 * movimentos que acabaram num caso vs média da equipa. Ordena por casos,
 * depois taxa.
 */
export function buildDriverCrossRef(input: {
  links: CrossRefLink[];
  movementTotals: CrossRefMovementTotal[];
  incidentsByEmployee: Map<number, number>;
  complaintsByEmployee: Map<number, number>;
  employeeNames?: Map<number, string>;
}): { rows: CrossRefRow[]; teamRate: number | null; totalCases: number } {
  const byKey = new Map<string, { employeeId: number | null; name: string; cases: Set<number>; attached: Set<number>; movement: Set<number> }>();
  const allCases = new Set<number>();
  for (const l of input.links) {
    if (!l.employeeId && !normName(l.name)) continue;
    const key = driverKey(l.employeeId, l.name);
    const name = (l.employeeId && input.employeeNames?.get(l.employeeId)) || l.name || `#${l.employeeId}`;
    const e = byKey.get(key) ?? { employeeId: l.employeeId ?? null, name, cases: new Set(), attached: new Set(), movement: new Set() };
    e.cases.add(l.caseId);
    (l.via === "attached" ? e.attached : e.movement).add(l.caseId);
    allCases.add(l.caseId);
    byKey.set(key, e);
  }
  const mov = new Map<string, { total: number; inCase: number }>();
  let teamTotal = 0, teamInCase = 0;
  for (const m of input.movementTotals) {
    const key = driverKey(m.employeeId, m.agentName);
    const cur = mov.get(key) ?? { total: 0, inCase: 0 };
    cur.total += Number(m.total) || 0;
    cur.inCase += Number(m.inCase) || 0;
    mov.set(key, cur);
    teamTotal += Number(m.total) || 0;
    teamInCase += Number(m.inCase) || 0;
  }
  const teamRate = teamTotal > 0 ? teamInCase / teamTotal : null;
  const rows: CrossRefRow[] = [];
  for (const [key, e] of Array.from(byKey.entries())) {
    const m = mov.get(key) ?? { total: 0, inCase: 0 };
    const caseRate = m.total > 0 ? m.inCase / m.total : null;
    rows.push({
      key,
      employeeId: e.employeeId,
      name: e.name,
      caseCount: e.cases.size,
      caseIds: Array.from(e.cases).sort((a, b) => b - a),
      attachedCases: e.attached.size,
      movementCases: e.movement.size,
      incidents: e.employeeId ? input.incidentsByEmployee.get(e.employeeId) ?? 0 : 0,
      complaints: e.employeeId ? input.complaintsByEmployee.get(e.employeeId) ?? 0 : 0,
      totalMovements: m.total,
      caseMovements: m.inCase,
      caseRate,
      vsTeam: caseRate != null && teamRate ? caseRate / teamRate : null,
    });
  }
  rows.sort((a, b) => (b.caseCount - a.caseCount) || ((b.caseRate ?? -1) - (a.caseRate ?? -1)) || a.name.localeCompare(b.name));
  return { rows, teamRate, totalCases: allCases.size };
}

/** Para um caso: quantos OUTROS casos tem cada um dos seus condutores. */
export function repeatDriversForCase(caseId: number, links: CrossRefLink[]): Array<{ key: string; name: string; employeeId: number | null; otherCaseIds: number[] }> {
  const mine = new Map<string, { name: string; employeeId: number | null }>();
  for (const l of links) if (l.caseId === caseId && (l.employeeId || normName(l.name))) {
    mine.set(driverKey(l.employeeId, l.name), { name: l.name || `#${l.employeeId}`, employeeId: l.employeeId });
  }
  const others = new Map<string, Set<number>>();
  for (const l of links) {
    if (l.caseId === caseId) continue;
    const k = driverKey(l.employeeId, l.name);
    if (!mine.has(k)) continue;
    const s = others.get(k) ?? new Set<number>();
    s.add(l.caseId);
    others.set(k, s);
  }
  return Array.from(mine.entries())
    .map(([key, v]) => ({ key, name: v.name, employeeId: v.employeeId, otherCaseIds: Array.from(others.get(key) ?? []).sort((a, b) => b - a) }))
    .filter((r) => r.otherCaseIds.length > 0)
    .sort((a, b) => b.otherCaseIds.length - a.otherCaseIds.length);
}
