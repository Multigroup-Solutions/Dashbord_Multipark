/**
 * CRM — pesquisa e filtros (partilhado entre o ecrã e a API).
 *
 * Do Odoo ficaram só os filtros (Jorge): barra única em que se escolhe o
 * campo, filtros em grupos (OU dentro do grupo, E entre grupos), regras
 * específicas ("carro vermelho, saiu a 10 set, com familiar cliente"),
 * ordem e intervalo, e filtros guardados.
 */
import { z } from "zod";

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
  /** pessoa ou empresa (21a: o "Pro ou particular" não distingue uma empresa que não é Pro) */
  type?: ("person" | "company")[];
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

// ─── Esquemas (servidor, exportação e filtros guardados usam os mesmos) ─────

const RULE_OPS = ["is", "is_not", "contains", "gte", "lte", "before", "after", "on", "within_days", "older_than_days", "yes", "no"] as const;
const SEARCH_IDS = SEARCH_FIELDS.map((f) => f.id) as [SearchField, ...SearchField[]];
const SORT_IDS = SORTS.map((s) => s.id) as [CrmSort, ...CrmSort[]];
export const crmRuleSchema = z.object({ field: z.string().max(40), op: z.enum(RULE_OPS), value: z.union([z.string().max(200), z.number()]).nullable().optional() });
const crmList = (max = 60) => z.array(z.string().max(160)).max(max).optional();
export const crmGroupsSchema = z.object({
  segment: z.array(z.enum(["new", "recurring", "vip", "at_risk", "partner"])).optional(),
  city: crmList(), region: crmList(), country: crmList(), park: crmList(200), clientCountry: crmList(), channel: crmList(), partner: crmList(200),
  kind: z.array(z.enum(["pro", "private"])).optional(),
  type: z.array(z.enum(["person", "company"])).optional(),
  alerts: z.array(z.enum(["noEmail", "genericEmail", "duplicate"])).optional(),
});
export const crmRulesSchema = z.object({ match: z.enum(["all", "any"]), items: z.array(crmRuleSchema).max(20) });
/** A pesquisa da lista (crm.list) — também a da exportação ("exatamente o conjunto escolhido"). */
export const crmQuerySchema = z.object({
  tab: z.enum(["clients", "pro"]).optional(),
  search: z.object({ text: z.string().max(200), field: z.enum(SEARCH_IDS) }).nullable().optional(),
  groups: crmGroupsSchema.optional(),
  rules: crmRulesSchema.nullable().optional(),
  sort: z.enum(SORT_IDS).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
  offset: z.number().int().min(0).max(1_000_000).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

/** O que um filtro guardado guarda (a vista, sem página). */
export const savedViewSchema = z.object({
  tab: z.enum(["clients", "pro", "partners", "parks"]).optional(),
  search: crmQuerySchema.shape.search,
  groups: crmGroupsSchema.optional(),
  rules: crmRulesSchema.nullable().optional(),
  sort: z.enum(SORT_IDS).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
});
export type SavedView = z.infer<typeof savedViewSchema>;
/** Tamanho máximo de um filtro guardado (JSON). Acima disto recusa-se — nunca se corta a meio. */
export const SAVED_VIEW_MAX_CHARS = 60_000;

/**
 * Filtro guardado lido de volta: o que ainda é válido aplica-se, o resto cai
 * e conta-se (campo de regra que deixou de existir, valor mau, grupo novo…).
 * Nunca lança — um filtro antigo não parte a página. PURA.
 */
export function sanitizeSavedView(raw: unknown): { view: SavedView; dropped: number } {
  const ok = savedViewSchema.safeParse(raw);
  if (ok.success) {
    const items = ok.data.rules?.items ?? [];
    const keep = items.filter((r) => RULE_FIELDS.some((f) => f.id === r.field));
    const dropped = items.length - keep.length;
    return { view: { ...ok.data, rules: keep.length ? { match: ok.data.rules!.match, items: keep } : null }, dropped };
  }
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  let dropped = 0;
  const pick = <T,>(schema: z.ZodType<T>, v: unknown): T | undefined => {
    if (v === undefined) return undefined;
    const p = schema.safeParse(v);
    if (p.success) return p.data;
    dropped++;
    return undefined;
  };
  const view: SavedView = {};
  view.tab = pick(savedViewSchema.shape.tab, o.tab);
  view.search = pick(savedViewSchema.shape.search, o.search) ?? null;
  view.sort = pick(savedViewSchema.shape.sort, o.sort);
  view.dir = pick(savedViewSchema.shape.dir, o.dir);
  // grupos um a um (um grupo mau não leva os outros)
  const g = (o.groups && typeof o.groups === "object" ? o.groups : {}) as Record<string, unknown>;
  const groups: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(g)) {
    const sch = (crmGroupsSchema.shape as Record<string, z.ZodTypeAny>)[k];
    if (!sch) { dropped++; continue; }
    const p = sch.safeParse(v);
    if (p.success) groups[k] = p.data; else dropped++;
  }
  view.groups = groups as SavedView["groups"];
  // regras uma a uma
  const r = (o.rules && typeof o.rules === "object" ? o.rules : null) as { match?: unknown; items?: unknown } | null;
  if (r) {
    const items = (Array.isArray(r.items) ? r.items : []).slice(0, 20);
    const good = items.flatMap((it) => {
      const p = crmRuleSchema.safeParse(it);
      if (p.success && RULE_FIELDS.some((f) => f.id === p.data.field)) return [p.data];
      dropped++;
      return [];
    });
    if (Array.isArray(r.items) && r.items.length > 20) dropped += r.items.length - 20;
    view.rules = good.length ? { match: r.match === "any" ? "any" : "all", items: good } : null;
  }
  return { view, dropped };
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
