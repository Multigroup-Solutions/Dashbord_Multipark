/**
 * Serviços extra das reservas → tarefas (regras PURAS, cliente + servidor).
 *
 * Regra do dono: cada serviço que obriga a mexer no carro (lavagens,
 * carregamentos elétricos, …) pode gerar uma tarefa no módulo Tarefas, com
 * prazo na SAÍDA do carro (Booking.checkOut). Configuração POR CIDADE e por
 * TIPO de serviço (Definições → Parâmetros → "Serviços → tarefas"):
 *   - "gera tarefa" (sim/não) e, opcionalmente, um responsável da cidade;
 *   - responsáveis da tarefa = esse responsável (se houver) + SEMPRE os team
 *     leaders do turno em que o carro SAI e os do turno ANTERIOR (escala do
 *     Extras-Dia: extras_dia_assignments.isTeamLeader).
 *
 * Os tipos vêm do catálogo "ExtraService" da Multipark (nomes agrupados por
 * `serviceTypeOf`). Uma tarefa por linha "BookingExtraService" (chave
 * `svc:<reserva>:<linha>` em tasks.sourceKey) — idempotente.
 */
import { z } from "zod";
import { addDays } from "./lisbonDay";
import { operationalShift, type HandoverShift } from "./shiftHandover";

// ─── Cidades e definição ────────────────────────────────────────────────────

/** Mesmos ids do Extras-Dia / escala (extras_dia_assignments.city). */
export const SERVICE_TASK_CITIES = ["lisbon", "porto", "faro"] as const;
export type ServiceTaskCity = (typeof SERVICE_TASK_CITIES)[number];
export const SERVICE_TASK_CITY_LABELS: Record<ServiceTaskCity, string> = { lisbon: "Lisboa", porto: "Porto", faro: "Faro" };
/** Cidade da classificação dos parques (shared/city.ts) → cidade da escala. */
export const SERVICE_TASK_CITY_FROM_PARK: Record<string, ServiceTaskCity> = { lisboa: "lisbon", porto: "porto", faro: "faro" };

export const SERVICE_TASKS_SETTING_KEY = "services.taskRules";
/** tasks.sourceModule das tarefas geradas. */
export const SERVICE_TASK_SOURCE = "service";
/** Janela de criação: saídas nas próximas N horas. */
export const SERVICE_TASKS_WINDOW_HOURS = 48;

export const SERVICE_TYPE_KEY_RE = /^[a-z0-9_]{1,48}$/;

export const serviceTaskRuleSchema = z.object({
  enabled: z.boolean({ error: "Gera tarefa: sim ou não." }),
  responsibleEmployeeId: z.number().int().positive("Responsável inválido.").nullable().default(null),
});
export type ServiceTaskRule = z.infer<typeof serviceTaskRuleSchema>;

const cityRulesSchema = z
  .record(z.string().regex(SERVICE_TYPE_KEY_RE, "Tipo de serviço inválido."), serviceTaskRuleSchema)
  .refine((r) => Object.keys(r).length <= 80, "No máximo 80 tipos de serviço por cidade.");

export const serviceTaskRulesSchema = z.object({
  lisbon: cityRulesSchema.default({}),
  porto: cityRulesSchema.default({}),
  faro: cityRulesSchema.default({}),
});
export type ServiceTaskRules = z.infer<typeof serviceTaskRulesSchema>;
export const DEFAULT_SERVICE_TASK_RULES: ServiceTaskRules = { lisbon: {}, porto: {}, faro: {} };

/** Alguma cidade tem um tipo com "gera tarefa" ligado? */
export function anyServiceTaskEnabled(rules: ServiceTaskRules | null | undefined): boolean {
  if (!rules) return false;
  return SERVICE_TASK_CITIES.some((c) => Object.values(rules[c] ?? {}).some((r) => r?.enabled));
}

// ─── Tipos de serviço (nome do catálogo → tipo) ─────────────────────────────

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Marcas operacionais a ~0 € que não são serviços (não mexem no carro). */
const OPERATIONAL_FLAGS = new Set(["no pay", "after hour collections"]);

export interface ServiceType { key: string; label: string }

/**
 * Tipo de um serviço a partir do nome ("Lavagem Exterior" → lavagem). Nomes
 * desconhecidos ficam como tipo próprio (nome normalizado). Marcas
 * operacionais (No pay, After hour collections, Aeroporto … partidas) → null.
 */
export function serviceTypeOf(name: string | null | undefined): ServiceType | null {
  const n = fold(String(name ?? ""));
  if (!n) return null;
  if (OPERATIONAL_FLAGS.has(n) || /^aeroporto .*partidas$/.test(n)) return null;
  if (/lavag|lavar|wash|limpez|clean/.test(n)) return { key: "lavagem", label: "Lavagem" };
  if (/carreg|recarga|charg|eletric|electric|\bev\b/.test(n)) return { key: "carregamento_eletrico", label: "Carregamento elétrico" };
  if (/valet|flex/.test(n)) return { key: "valet_flex", label: "Valet / Flexível" };
  const key = n.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
  if (!key) return null;
  const raw = String(name).trim().replace(/\s+/g, " ");
  return { key, label: raw.charAt(0).toUpperCase() + raw.slice(1) };
}

export interface CatalogServiceType extends ServiceType { names: string[] }

/** Nomes do catálogo → tipos agrupados (ordenados pelo rótulo). */
export function groupServiceTypes(names: Iterable<string>): CatalogServiceType[] {
  const byKey = new Map<string, CatalogServiceType>();
  for (const name of names) {
    const t = serviceTypeOf(name);
    if (!t) continue;
    const cur = byKey.get(t.key) ?? { ...t, names: [] };
    const clean = String(name).trim();
    if (!cur.names.some((x) => fold(x) === fold(clean))) cur.names.push(clean);
    byKey.set(t.key, cur);
  }
  return [...byKey.values()]
    .map((t) => ({ ...t, names: t.names.sort((a, b) => a.localeCompare(b, "pt")) }))
    .sort((a, b) => a.label.localeCompare(b.label, "pt"));
}

// ─── Turnos e team leaders ──────────────────────────────────────────────────

export interface ShiftRef { date: string; shift: HandoverShift }
export const shiftRefKey = (r: ShiftRef) => `${r.date}|${r.shift}`;

/** Turno em que o carro sai (manhã 03–15h, noite 15–03h de Lisboa) e o anterior. */
export function checkoutShifts(checkOutMs: number): { leaving: ShiftRef; previous: ShiftRef } {
  const leaving = operationalShift(checkOutMs);
  const previous: ShiftRef = leaving.shift === "night"
    ? { date: leaving.date, shift: "morning" }
    : { date: addDays(leaving.date, -1), shift: "night" };
  return { leaving, previous };
}

export interface TeamLeaderRow { date: string; shift: string; city: string; employeeId: number; status?: string | null }

/**
 * Team leaders escalados num turno da cidade. Havendo linhas confirmadas,
 * só essas; sem nenhuma confirmada, os propostos (a escala de amanhã só é
 * confirmada ao fim da tarde).
 */
export function teamLeadersFor(rows: readonly TeamLeaderRow[], city: string, ref: ShiftRef): number[] {
  const hits = rows.filter((r) => r.city === city && r.date === ref.date && r.shift === ref.shift && r.employeeId > 0);
  const confirmed = hits.filter((r) => (r.status ?? "confirmed") !== "proposed");
  return [...new Set((confirmed.length ? confirmed : hits).map((r) => r.employeeId))];
}

/**
 * Responsáveis de uma tarefa de serviço: o responsável configurado (se
 * houver) + TL(s) do turno da saída + TL(s) do turno anterior. PURA.
 */
export function serviceTaskAssignees(o: {
  rule: Pick<ServiceTaskRule, "responsibleEmployeeId"> | null | undefined;
  city: string;
  checkOutMs: number;
  teamLeaders: readonly TeamLeaderRow[];
}): number[] {
  const { leaving, previous } = checkoutShifts(o.checkOutMs);
  const out: number[] = [];
  const add = (id: number | null | undefined) => { if (id != null && id > 0 && !out.includes(id)) out.push(id); };
  add(o.rule?.responsibleEmployeeId ?? null);
  for (const id of teamLeadersFor(o.teamLeaders, o.city, leaving)) add(id);
  for (const id of teamLeadersFor(o.teamLeaders, o.city, previous)) add(id);
  return out;
}

// ─── Chave, título e texto ──────────────────────────────────────────────────

export function serviceTaskKey(bookingId: string, lineId: string): string | null {
  const k = `svc:${bookingId}:${lineId}`;
  return bookingId && lineId && k.length <= 128 ? k : null;
}

/** "svc:<reserva>:<linha>" → partes (null se não for uma chave de serviço). */
export function parseServiceTaskKey(key: string | null | undefined): { bookingId: string; lineId: string } | null {
  const m = /^svc:([^:]+):(.+)$/.exec(String(key ?? ""));
  return m ? { bookingId: m[1], lineId: m[2] } : null;
}

export const bookingLink = (bookingId: string) => `/reserva/${encodeURIComponent(bookingId)}`;

const lisbonFmt = new Intl.DateTimeFormat("pt-PT", {
  timeZone: "Europe/Lisbon", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
});
export const fmtLisbon = (ms: number) => lisbonFmt.format(new Date(ms)).replace(",", "");

export interface ServiceLine {
  lineId: string;
  bookingId: string;
  /** Código da reserva (Booking.allocation). */
  code: string | null;
  status: string;
  checkOutMs: number;
  parkName: string | null;
  city: ServiceTaskCity;
  plate: string | null;
  serviceName: string;
  done: boolean;
}

/** Separador entre o nome do serviço e o resto do título (lido pela página Serviços). */
export const SERVICE_TASK_TITLE_SEP = " · ";

export function serviceTaskTitle(l: Pick<ServiceLine, "serviceName" | "code" | "plate" | "bookingId">): string {
  const parts = [l.serviceName.trim() || "Serviço", l.code ? `reserva ${l.code}` : `reserva ${l.bookingId}`, l.plate ?? ""].filter(Boolean);
  return parts.join(SERVICE_TASK_TITLE_SEP).slice(0, 256);
}

export function serviceTaskDescription(l: ServiceLine): string {
  return [
    `Serviço: ${l.serviceName}`,
    `Reserva: ${l.code ?? l.bookingId}`,
    `Matrícula: ${l.plate ?? "—"}`,
    `Parque: ${l.parkName ?? "—"} (${SERVICE_TASK_CITY_LABELS[l.city]})`,
    `Saída do carro: ${fmtLisbon(l.checkOutMs)}`,
    `Ficha da reserva: ${bookingLink(l.bookingId)}`,
    "",
    "Tarefa criada automaticamente (Definições → Parâmetros → Serviços → tarefas). Prazo: a saída do carro. Fecha sozinha quando a Multipark marca o serviço como feito, se o serviço for retirado ou se a reserva for cancelada.",
  ].join("\n");
}

// ─── Plano (o que criar / atualizar / fechar) ───────────────────────────────

export interface ExistingServiceTask {
  id: number;
  sourceKey: string;
  taskStatus: string;
  /** "YYYY-MM-DD HH:MM:SS" (UTC) ou null. */
  dueDate: string | null;
  assigneeIds: number[];
}

export type CloseReason = "cancelled" | "removed" | "done_multipark";
export const CLOSE_REASON_TEXT: Record<CloseReason, string> = {
  cancelled: "Fechada automaticamente: a reserva foi cancelada na Multipark.",
  removed: "Fechada automaticamente: o serviço já não está na reserva.",
  done_multipark: "Fechada automaticamente: o serviço foi marcado como feito na Multipark.",
};

export type ServiceTaskAction =
  | { kind: "create"; key: string; line: ServiceLine; typeKey: string; title: string; description: string; dueMs: number; assigneeIds: number[] }
  | { kind: "update"; taskId: number; key: string; title: string; description: string; dueMs: number }
  | { kind: "assign"; taskId: number; employeeIds: number[] }
  | { kind: "close"; taskId: number; reason: CloseReason };

const utcMsOf = (mysql: string | null) => (mysql ? Date.parse(`${mysql.replace(" ", "T").slice(0, 19)}Z`) : NaN);

/**
 * Decide as ações. PURA.
 *  - linha com o tipo ligado na cidade, sem tarefa, reserva não cancelada,
 *    serviço por fazer e saída em (agora, agora + janela] → criar;
 *  - tarefa aberta: reserva cancelada → fechar; serviço feito na Multipark →
 *    fechar; saída mudou → novo prazo; faltam responsáveis (ex.: escala
 *    publicada depois) → acrescentar (nunca tira ninguém);
 *  - tarefa aberta cuja reserva foi lida mas já não tem a linha → fechar;
 *  - tarefas já concluídas nunca são mexidas nem recriadas.
 */
export function planServiceTasks(o: {
  lines: readonly ServiceLine[];
  /** Reservas lidas (todas as linhas delas estão em `lines`). */
  checkedBookingIds: ReadonlySet<string>;
  rules: ServiceTaskRules;
  existing: readonly ExistingServiceTask[];
  teamLeaders: readonly TeamLeaderRow[];
  nowMs: number;
  windowHours?: number;
}): ServiceTaskAction[] {
  const out: ServiceTaskAction[] = [];
  const byKey = new Map(o.existing.map((t) => [t.sourceKey, t]));
  const seenKeys = new Set<string>();
  const windowEnd = o.nowMs + (o.windowHours ?? SERVICE_TASKS_WINDOW_HOURS) * 3_600_000;

  for (const l of o.lines) {
    const key = serviceTaskKey(l.bookingId, l.lineId);
    if (!key) continue;
    seenKeys.add(key);
    const type = serviceTypeOf(l.serviceName);
    const rule = type ? o.rules[l.city]?.[type.key] : undefined;
    const cancelled = l.status === "CANCELLED";
    const ex = byKey.get(key);
    if (ex) {
      if (ex.taskStatus === "done") continue;
      if (cancelled) { out.push({ kind: "close", taskId: ex.id, reason: "cancelled" }); continue; }
      if (l.done) { out.push({ kind: "close", taskId: ex.id, reason: "done_multipark" }); continue; }
      const due = utcMsOf(ex.dueDate);
      if (!Number.isFinite(due) || Math.abs(due - l.checkOutMs) >= 60_000) {
        out.push({ kind: "update", taskId: ex.id, key, title: serviceTaskTitle(l), description: serviceTaskDescription(l), dueMs: l.checkOutMs });
      }
      if (rule?.enabled) {
        const want = serviceTaskAssignees({ rule, city: l.city, checkOutMs: l.checkOutMs, teamLeaders: o.teamLeaders });
        const missing = want.filter((id) => !ex.assigneeIds.includes(id));
        if (missing.length) out.push({ kind: "assign", taskId: ex.id, employeeIds: missing });
      }
      continue;
    }
    // PENDING = compra online por acabar (o CRM e a página Serviços também a deixam de fora)
    if (!type || !rule?.enabled || cancelled || l.done || l.status === "PENDING") continue;
    if (l.checkOutMs <= o.nowMs || l.checkOutMs > windowEnd) continue;
    out.push({
      kind: "create", key, line: l, typeKey: type.key,
      title: serviceTaskTitle(l), description: serviceTaskDescription(l), dueMs: l.checkOutMs,
      assigneeIds: serviceTaskAssignees({ rule, city: l.city, checkOutMs: l.checkOutMs, teamLeaders: o.teamLeaders }),
    });
  }

  for (const t of o.existing) {
    if (t.taskStatus === "done" || seenKeys.has(t.sourceKey)) continue;
    const k = parseServiceTaskKey(t.sourceKey);
    if (k && o.checkedBookingIds.has(k.bookingId)) out.push({ kind: "close", taskId: t.id, reason: "removed" });
  }
  return out;
}
