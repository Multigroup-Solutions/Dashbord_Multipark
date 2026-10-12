/**
 * Lote 57 (Jorge, 12 out 2026): filtros da página das Reclamações — uma regra
 * só, PURA, para a lista, o quadro e os contadores (o contador conta a MESMA
 * lista que se vê: nunca outra consulta).
 *
 * Estado, tipo, cidade ("sem cidade"), responsável, origem, datas (dia de
 * criação em Lisboa) e pesquisa (regra única de texto: shared/textKey.ts).
 * A cidade escolhe-se no filtro global (o servidor já devolve só essa cidade);
 * aqui fica só o "sem cidade". As arquivadas e a janela dos 90 dias são do
 * servidor (complaints.list).
 */
import { complaintOverdue, COMPLAINT_OPEN_STATUSES } from "./caseRules";
import { lisbonDayOf } from "./lisbonDay";
import { textMatches } from "./textKey";

// ─── Origem ─────────────────────────────────────────────────────────────────

/** De onde veio a reclamação (coluna complaints.origin, migração 0630). */
export const COMPLAINT_ORIGINS = ["email", "ia", "whatsapp", "critica", "conversao", "manual", "api"] as const;
export type ComplaintOrigin = (typeof COMPLAINT_ORIGINS)[number];
export const COMPLAINT_ORIGIN_LABELS: Record<ComplaintOrigin, string> = {
  email: "Email (reclamacoes@)",
  ia: "IA (email noutra caixa)",
  whatsapp: "WhatsApp",
  critica: "Crítica Google",
  conversao: "Ocorrência ou perdido",
  manual: "Criada à mão",
  api: "API",
};
export const isComplaintOrigin = (v: unknown): v is ComplaintOrigin => typeof v === "string" && (COMPLAINT_ORIGINS as readonly string[]).includes(v);

/** Etiqueta da origem (sem origem registada → "Sem origem registada"). PURA. */
export function complaintOriginLabel(v: string | null | undefined): string {
  return isComplaintOrigin(v) ? COMPLAINT_ORIGIN_LABELS[v] : "Sem origem registada";
}

// ─── Filtros ────────────────────────────────────────────────────────────────

/** Estado: os do quadro + "em aberto" e "em atraso". "closed" junta as convertidas (coluna Fechado). */
export const COMPLAINT_STATUS_FILTERS = ["all", "open", "overdue", "new", "analyzing", "waiting_client", "resolved", "closed"] as const;
export type ComplaintStatusFilter = (typeof COMPLAINT_STATUS_FILTERS)[number];
export const COMPLAINT_STATUS_FILTER_LABELS: Record<ComplaintStatusFilter, string> = {
  all: "Todos",
  open: "Em aberto",
  overdue: "Em atraso (SLA)",
  new: "Novo",
  analyzing: "Em Análise",
  waiting_client: "Aguarda Cliente",
  resolved: "Resolvido",
  closed: "Fechado",
};

export interface ComplaintListFilters {
  q?: string | null;
  status?: ComplaintStatusFilter | null;
  /** damage | dirt | delay | overcharge | staff | other ("all" ou vazio = todos). */
  type?: string | null;
  /** "all" | "none" (sem responsável) | id da ficha. */
  assignee?: "all" | "none" | number | null;
  /** "all" | origem | "unknown" (sem origem registada). */
  origin?: ComplaintOrigin | "all" | "unknown" | null;
  /** Só as que não têm cidade (projeto) — a cidade em si escolhe-se no filtro global. */
  noCity?: boolean | null;
  /** Dia de criação (Lisboa), "AAAA-MM-DD", inclusive. */
  from?: string | null;
  to?: string | null;
}

export interface ComplaintFilterRow {
  id: number;
  title?: string | null;
  complaintType?: string | null;
  complaintStatus?: string | null;
  slaDeadline?: string | null;
  clientName?: string | null;
  clientEmail?: string | null;
  clientPhone?: string | null;
  reservationRef?: string | null;
  vehiclePlate?: string | null;
  assignedToId?: number | null;
  assignedToName?: string | null;
  projectId?: number | null;
  origin?: string | null;
  createdAt?: string | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayOrNull = (v: string | null | undefined): string | null => (v && DAY.test(v) ? v : null);

/** Texto onde a pesquisa procura (nº, título, cliente, email, telefone, reserva, matrícula, responsável). PURA. */
export function complaintSearchHaystack(c: ComplaintFilterRow): string {
  return [c.id, c.title, c.clientName, c.clientEmail, c.clientPhone, c.reservationRef, c.vehiclePlate, c.assignedToName]
    .filter((v) => v != null && v !== "").join(" ");
}

/** Dia de criação em Lisboa (null se não houver data). PURA. */
export function complaintCreatedDay(c: Pick<ComplaintFilterRow, "createdAt">): string | null {
  if (!c.createdAt) return null;
  try { return lisbonDayOf(String(c.createdAt)); } catch { return null; }
}

/** A reclamação passa nos filtros? PURA. */
export function complaintMatchesFilters(c: ComplaintFilterRow, f: ComplaintListFilters, nowMs: number): boolean {
  const status = f.status ?? "all";
  const st = String(c.complaintStatus ?? "");
  if (status === "open" && !COMPLAINT_OPEN_STATUSES.includes(st)) return false;
  if (status === "overdue" && !complaintOverdue(c, nowMs)) return false;
  if (status === "closed" && st !== "closed" && st !== "converted") return false;
  if ((status === "new" || status === "analyzing" || status === "waiting_client" || status === "resolved") && st !== status) return false;

  if (f.type && f.type !== "all" && c.complaintType !== f.type) return false;

  const a = f.assignee ?? "all";
  if (a === "none" && c.assignedToId != null) return false;
  if (typeof a === "number" && c.assignedToId !== a) return false;

  const o = f.origin ?? "all";
  if (o === "unknown" && isComplaintOrigin(c.origin)) return false;
  if (o !== "all" && o !== "unknown" && c.origin !== o) return false;

  if (f.noCity && c.projectId != null) return false;

  const from = dayOrNull(f.from);
  const to = dayOrNull(f.to);
  if (from || to) {
    const day = complaintCreatedDay(c);
    if (!day) return false;
    if (from && day < from) return false;
    if (to && day > to) return false;
  }

  const q = String(f.q ?? "").trim();
  if (q && !textMatches(complaintSearchHaystack(c), q.replace(/^#/, ""))) return false;
  return true;
}

/** A lista filtrada (mesma ordem). É esta lista que o quadro, a lista e os contadores usam. PURA. */
export function filterComplaintRows<T extends ComplaintFilterRow>(rows: readonly T[], f: ComplaintListFilters, nowMs: number): T[] {
  return rows.filter((c) => complaintMatchesFilters(c, f, nowMs));
}

/** Quantos filtros estão ativos (para "Filtros (3)" e "Limpar"). PURA. */
export function activeComplaintFilterCount(f: ComplaintListFilters): number {
  let n = 0;
  if (String(f.q ?? "").trim()) n++;
  if (f.status && f.status !== "all") n++;
  if (f.type && f.type !== "all") n++;
  if (f.assignee != null && f.assignee !== "all") n++;
  if (f.origin && f.origin !== "all") n++;
  if (f.noCity) n++;
  if (dayOrNull(f.from) || dayOrNull(f.to)) n++;
  return n;
}

/** Com datas escolhidas a janela dos 90 dias deixa de valer (o servidor devolve todas). PURA. */
export function complaintFiltersNeedAllTime(f: ComplaintListFilters): boolean {
  return !!(dayOrNull(f.from) || dayOrNull(f.to));
}

/** Datas ao contrário (de > até)? Mostra-se o aviso e não se filtra às cegas. PURA. */
export function complaintDateRangeInvalid(f: Pick<ComplaintListFilters, "from" | "to">): boolean {
  const from = dayOrNull(f.from);
  const to = dayOrNull(f.to);
  return !!(from && to && from > to);
}

/**
 * Responsáveis para o filtro: os que aparecem na lista (nome do servidor), por
 * ordem alfabética, sem repetir. Escolher um que deixou de ter casos dá 0
 * (mostra-se como tal, nunca desaparece em silêncio). PURA.
 */
export function complaintAssigneeOptions(rows: readonly ComplaintFilterRow[]): Array<{ id: number; name: string }> {
  const m = new Map<number, string>();
  for (const r of rows) if (r.assignedToId != null && !m.has(r.assignedToId)) m.set(r.assignedToId, String(r.assignedToName ?? `Ficha #${r.assignedToId}`));
  return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "pt"));
}
