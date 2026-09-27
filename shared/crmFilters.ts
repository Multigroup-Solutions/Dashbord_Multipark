/**
 * CRM — pesquisa e filtros (partilhado entre o ecrã e a API).
 *
 * Do Odoo ficaram só os filtros (Jorge): barra única em que se escolhe o
 * campo, filtros em grupos (OU dentro do grupo, E entre grupos), regras
 * específicas ("carro vermelho, saiu a 10 set, com familiar cliente"),
 * ordem e intervalo, e filtros guardados.
 */

export const SEARCH_FIELDS = [
  { id: "all", label: "Qualquer campo" },
  { id: "name", label: "Nome" },
  { id: "email", label: "Email" },
  { id: "phone", label: "Telefone" },
  { id: "plate", label: "Matrícula" },
  { id: "nif", label: "NIF" },
  { id: "number", label: "N.º de cliente" },
  { id: "booking", label: "N.º de reserva" },
  { id: "carColor", label: "Cor do carro" },
  { id: "carModel", label: "Marca ou modelo do carro" },
  { id: "tags", label: "Notas e etiquetas" },
] as const;
export type SearchField = (typeof SEARCH_FIELDS)[number]["id"];

export const SEGMENTS = [
  { id: "new", label: "Novo" },
  { id: "recurring", label: "Recorrente" },
  { id: "vip", label: "VIP" },
  { id: "at_risk", label: "Em risco" },
  { id: "partner", label: "Via parceiro ou agência" },
] as const;
export type Segment = (typeof SEGMENTS)[number]["id"];

export const ALERTS = [
  { id: "noEmail", label: "Sem email" },
  { id: "genericEmail", label: "Email estranho (balcão/agregador)" },
  { id: "duplicate", label: "Possível ficha repetida" },
] as const;
export type AlertId = (typeof ALERTS)[number]["id"];

/** Grupos de filtros (valores escolhidos numa lista). */
export interface CrmGroups {
  segment?: Segment[];
  /** cidade do parque onde reservou */
  city?: string[];
  region?: string[];
  /** país do parque onde reservou */
  country?: string[];
  park?: string[];
  /** país do cliente (telefone) */
  clientCountry?: string[];
  channel?: string[];
  partner?: string[];
  kind?: ("pro" | "private")[];
  alerts?: AlertId[];
}

export type RuleType = "text" | "number" | "date" | "bool";
export type RuleOp = "is" | "is_not" | "contains" | "gte" | "lte" | "before" | "after" | "on" | "within_days" | "older_than_days" | "yes" | "no";

export const RULE_FIELDS: { id: string; label: string; type: RuleType; finance?: boolean }[] = [
  { id: "vehicle.color", label: "Carro › Cor", type: "text" },
  { id: "vehicle.brand", label: "Carro › Marca", type: "text" },
  { id: "vehicle.model", label: "Carro › Modelo", type: "text" },
  { id: "vehicle.plate", label: "Carro › Matrícula", type: "text" },
  { id: "booking.checkIn", label: "Reserva › Data de entrada", type: "date" },
  { id: "booking.checkOut", label: "Reserva › Data de saída", type: "date" },
  { id: "booking.park", label: "Reserva › Parque", type: "text" },
  { id: "booking.status", label: "Reserva › Estado", type: "text" },
  { id: "booking.flight", label: "Reserva › Voo", type: "text" },
  { id: "client.bookings", label: "Cliente › N.º de reservas", type: "number" },
  { id: "client.completed", label: "Cliente › N.º de estadias", type: "number" },
  { id: "client.totalSpent", label: "Cliente › Gasto total (€)", type: "number", finance: true },
  { id: "client.lastVisit", label: "Cliente › Última vinda", type: "date" },
  { id: "client.firstVisit", label: "Cliente › Primeira vinda", type: "date" },
  { id: "client.upcoming", label: "Cliente › Tem reserva futura", type: "bool" },
  { id: "client.zone", label: "Cliente › Zona", type: "text" },
  { id: "client.tags", label: "Cliente › Etiquetas e notas", type: "text" },
  { id: "client.nif", label: "Cliente › Tem NIF", type: "bool" },
  { id: "client.photo", label: "Cliente › Tem foto", type: "bool" },
  { id: "relation.family", label: "Ligações › Tem familiar cliente", type: "bool" },
  { id: "relation.company", label: "Ligações › Empresa (nome)", type: "text" },
];

export const OPS_BY_TYPE: Record<RuleType, { id: RuleOp; label: string }[]> = {
  text: [{ id: "is", label: "é" }, { id: "contains", label: "contém" }, { id: "is_not", label: "não é" }],
  number: [{ id: "gte", label: "≥" }, { id: "lte", label: "≤" }, { id: "is", label: "=" }],
  date: [{ id: "on", label: "no dia" }, { id: "before", label: "antes de" }, { id: "after", label: "depois de" }, { id: "within_days", label: "nos últimos N dias" }, { id: "older_than_days", label: "há mais de N dias" }],
  bool: [{ id: "yes", label: "sim" }, { id: "no", label: "não" }],
};

export interface CrmRule { field: string; op: RuleOp; value?: string | number | null }

export type CrmSort = "lastVisit" | "firstVisit" | "bookings" | "totalSpent" | "name" | "number" | "nextCheckIn";
export const SORTS: { id: CrmSort; label: string; finance?: boolean }[] = [
  { id: "lastVisit", label: "Última vinda" },
  { id: "nextCheckIn", label: "Próxima reserva" },
  { id: "bookings", label: "N.º de reservas" },
  { id: "totalSpent", label: "Gasto total", finance: true },
  { id: "firstVisit", label: "Cliente desde" },
  { id: "name", label: "Nome" },
  { id: "number", label: "N.º de cliente" },
];

export interface CrmQuery {
  tab?: "clients" | "pro";
  search?: { text: string; field: SearchField } | null;
  groups?: CrmGroups;
  rules?: { match: "all" | "any"; items: CrmRule[] } | null;
  sort?: CrmSort;
  dir?: "asc" | "desc";
  offset?: number;
  limit?: number;
}

/** Segmentos de uma ficha a partir das métricas (mesmas regras que o SQL). PURO. */
export function segmentsOf(c: {
  bookings: number; cancelled: number; completed: number; upcoming: number; partnerBookings: number;
  totalSpent: number | null; lastVisit: string | null; isPro: boolean;
}, vipThreshold: number | null, now = new Date()): Segment[] {
  const out: Segment[] = [];
  if (c.bookings - c.cancelled === 1) out.push("new");
  if (c.completed >= 3) out.push("recurring");
  if (!c.isPro && vipThreshold != null && (c.totalSpent ?? 0) >= vipThreshold && (c.totalSpent ?? 0) > 0) out.push("vip");
  const risk = new Date(now);
  risk.setUTCMonth(risk.getUTCMonth() - 12);
  if (c.completed >= 3 && c.upcoming === 0 && c.lastVisit && c.lastVisit < risk.toISOString().slice(0, 19).replace("T", " ")) out.push("at_risk");
  if (c.bookings > 0 && c.partnerBookings * 2 > c.bookings) out.push("partner");
  return out;
}
