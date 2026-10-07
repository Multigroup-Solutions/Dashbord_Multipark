/**
 * Serviços extra das reservas → tarefas. Desde 29–30 set 2026 (Jorge, "agendador
 * mais leve"): a tarefa nasce quando chega o WEBHOOK da reserva
 * (`runServiceTasksForBookings`, chamado em processMultiparkWebhookEvent) para
 * saídas até 72 h e vai logo para o Google Tarefas dos responsáveis; o que
 * falhar no webhook fica em `service_task_retries` e a fila do webhook repete
 * (`retryServiceTasks`). O trabalho `services-tasks` do agendador corre 1×/dia
 * às 18:00 — volta de segurança (a janela de 48 h, que cria as mais longe e
 * junta os team leaders escalados entretanto); o aviso das tarefas de AMANHÃ é
 * o trabalho `services-tomorrow` (interruptor). À mão em /api/cron/services-tasks.
 *
 * Lê AO VIVO da BD da Multipark (só leitura; regras de server/multiparkDb):
 *   "Park" (parques nossos — shared/multiparkParks.ts), "Booking" (id,
 *   allocation, status, checkOut, checkOutDate, parkId, vehicleId),
 *   "BookingExtraService" (id, name, done, bookingId), "BookingVehicle"
 *   (licensePlate). Canceladas também são lidas (para fechar as tarefas).
 *
 * Duas leituras:
 *   1. reservas com saída em [agora − 6 h, agora + 48 h) nos parques nossos,
 *      com pelo menos um serviço (só se algum tipo estiver ligado);
 *   2. as reservas das tarefas de serviço ainda ABERTAS que não vieram na 1.ª
 *      (saída mudada para longe, serviço retirado, reserva cancelada…).
 *
 * As decisões são puras (shared/serviceTasks.ts → planServiceTasks); aqui só
 * se lê e se aplica, com prazo (`deadlineAt`). Idempotente: uma tarefa por
 * linha BookingExtraService (tasks.sourceModule = 'service', sourceKey =
 * `svc:<reserva>:<linha>`), com chave única desde a migração 0325.
 */
import {
  SERVICE_TASK_CITIES,
  SERVICE_TASK_CITY_FROM_PARK,
  SERVICE_TASK_SOURCE,
  SERVICE_TASKS_SETTING_KEY,
  SERVICE_TASKS_WINDOW_HOURS,
  CLOSE_REASON_TEXT,
  DEFAULT_SERVICE_TASK_RULES,
  anyServiceTaskEnabled,
  checkoutShifts,
  parseServiceTaskKey,
  planServiceTasks,
  serviceTaskKey,
  type ExistingServiceTask,
  type ServiceLine,
  type ServiceTaskAction,
  type ServiceTaskCity,
  type ServiceTaskRules,
  type TeamLeaderRow,
} from "../shared/serviceTasks";
import { taskBookingRef } from "../shared/taskFilters";
import { isMultiparkDbConfigured, multiparkDbQuery, type SqlParam } from "./multiparkDb/client";

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

export const SERVICE_LINES_LIMIT = 3000;
/** Saídas recentes ainda lidas (o serviço pode ser marcado feito depois da saída). */
export const SERVICE_TASKS_LOOKBACK_HOURS = 6;
const IDS_CHUNK = 200;

const sqlTs = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const str = (v: unknown): string | null => {
  if (v == null || typeof v === "object") return null;
  const s = String(v).trim();
  return s || null;
};
const bool = (v: unknown) => v === true || v === 1 || v === "1" || v === "t" || v === "true";

// ─── SQL (PURO) ─────────────────────────────────────────────────────────────

const LINE_SELECT = [
  `e."id" AS line_id`,
  `e."name" AS service_name`,
  `e."done" AS done`,
  `b."id" AS booking_id`,
  `NULLIF(b."allocation", '') AS code`,
  `b."status"::text AS status`,
  `to_char(b."checkOut", 'YYYY-MM-DD HH24:MI:SS') AS check_out`,
  `b."parkId" AS park_id`,
  `NULLIF(v."licensePlate", '') AS plate`,
].join(", ");

/** Linhas de serviço das reservas com saída em [startMs, endMs) nos parques dados. PURA. */
export function buildServiceLinesWindowSql(startMs: number, endMs: number, parkIds: string[], limit = SERVICE_LINES_LIMIT): { sql: string; params: SqlParam[] } {
  if (!parkIds.length) throw new Error("Sem parques.");
  if (!(endMs > startMs)) throw new Error("Janela inválida.");
  const params: SqlParam[] = [];
  const add = (v: SqlParam) => { params.push(v); return `$${params.length}`; };
  const parks = parkIds.map((id) => add(id)).join(", ");
  const s = add(sqlTs(startMs));
  const e = add(sqlTs(endMs));
  // "checkOutDate" é muitas vezes só o dia (00:00): pré-filtro com 1 dia de folga (índice parkId+checkOutDate).
  const ws = add(sqlTs(startMs - 86_400_000));
  const we = add(sqlTs(endMs + 86_400_000));
  const lim = add(Math.min(Math.max(Math.floor(limit), 1), SERVICE_LINES_LIMIT + 1));
  const sql = [
    `SELECT ${LINE_SELECT}`,
    `FROM "Booking" b`,
    `JOIN "BookingExtraService" e ON e."bookingId" = b."id"`,
    `LEFT JOIN "BookingVehicle" v ON v."id" = b."vehicleId"`,
    `WHERE b."parkId" IN (${parks})`,
    `AND b."checkOutDate" >= ${ws}::timestamp AND b."checkOutDate" < ${we}::timestamp`,
    `AND b."checkOut" >= ${s}::timestamp AND b."checkOut" < ${e}::timestamp`,
    `ORDER BY b."checkOut" ASC, e."id" ASC`,
    `LIMIT ${lim}`,
  ].join("\n");
  return { sql, params };
}

/** Reservas dadas (todas as linhas; reserva sem serviços → 1 linha com line_id nulo). PURA. */
export function buildServiceLinesByIdsSql(bookingIds: string[]): { sql: string; params: SqlParam[] } {
  if (!bookingIds.length) throw new Error("Sem reservas.");
  const params: SqlParam[] = [];
  const add = (v: SqlParam) => { params.push(v); return `$${params.length}`; };
  const ids = bookingIds.map((id) => add(id)).join(", ");
  const sql = [
    `SELECT ${LINE_SELECT}`,
    `FROM "Booking" b`,
    `LEFT JOIN "BookingExtraService" e ON e."bookingId" = b."id"`,
    `LEFT JOIN "BookingVehicle" v ON v."id" = b."vehicleId"`,
    `WHERE b."id" IN (${ids})`,
    `LIMIT ${add(bookingIds.length * 20 + 20)}`,
  ].join("\n");
  return { sql, params };
}

export interface ServicePark { id: string; name: string; city: ServiceTaskCity }

/** Linha → linha de serviço (null: reserva sem linha, parque que não é nosso ou hora inválida). PURA. */
export function mapServiceLineRow(r: Record<string, unknown>, parks: ReadonlyMap<string, ServicePark>): ServiceLine | null {
  const lineId = str(r.line_id);
  const bookingId = str(r.booking_id);
  const park = parks.get(String(r.park_id ?? ""));
  const co = str(r.check_out);
  const checkOutMs = co ? Date.parse(`${co.replace(" ", "T")}Z`) : NaN;
  if (!lineId || !bookingId || !park || !Number.isFinite(checkOutMs)) return null;
  return {
    lineId, bookingId, code: str(r.code), status: String(r.status ?? ""), checkOutMs,
    parkName: park.name, city: park.city, plate: str(r.plate), serviceName: str(r.service_name) ?? "Serviço", done: bool(r.done),
  };
}

// ─── Dependências (BD nossa + BD Multipark) — injetáveis nos testes ─────────

export interface ServiceTasksDeps {
  multiparkConfigured(): boolean;
  query: Query;
  loadRules(): Promise<ServiceTaskRules>;
  /** Parques NOSSOS (Lisboa/Porto/Faro). */
  loadParks(query: Query): Promise<ServicePark[]>;
  loadOpenTasks(): Promise<ExistingServiceTask[]>;
  loadTasksByKeys(keys: string[]): Promise<ExistingServiceTask[]>;
  /** Todas as tarefas de serviço (abertas e fechadas) destas reservas — pela chave `svc:<reserva>:…`. */
  loadTasksForBookings(bookingIds: string[]): Promise<ExistingServiceTask[]>;
  loadTeamLeaders(dates: string[]): Promise<TeamLeaderRow[]>;
  cityProjectIds(): Promise<Partial<Record<ServiceTaskCity, number>>>;
  systemUserId(): Promise<number>;
  createTask(t: { title: string; description: string; projectId: number | null; createdById: number; dueMs: number; sourceKey: string; assigneeIds: number[] }): Promise<number>;
  updateTask(id: number, patch: { title: string; description: string; dueMs: number }): Promise<void>;
  addAssignees(id: number, employeeIds: number[]): Promise<void>;
  closeTask(id: number, comment: string, systemUserId: number): Promise<void>;
  /** Linhas marcadas feitas CÁ (página Serviços → `service_extra_done`). */
  loadLocalDone(lineIds: string[]): Promise<Set<string>>;
  /** Manda as tarefas para o Google Tarefas dos responsáveis (em segundo plano). */
  syncGoogle(taskIds: number[]): void;
}

const rowsOf = (res: unknown): any[] => (Array.isArray(res) ? (Array.isArray(res[0]) ? res[0] : res) : []) as any[];
const mysqlNow = (ms: number = Date.now()) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

const OPEN_TASKS_PAGE = 1000;
const OPEN_TASKS_MAX_PAGES = 20;

/** LIKE para as tarefas de UMA reserva (`svc:<reserva>:%`), com % e _ escapados. PURA. */
export function serviceKeyPrefixLike(bookingId: string): string {
  return `svc:${String(bookingId).replace(/[\\%_]/g, (c) => `\\${c}`)}:%`;
}

/** A tarefa desta linha já existe (criada por outra corrida ao mesmo tempo). */
export class ServiceTaskExistsError extends Error {
  readonly code = "SERVICE_TASK_EXISTS";
  constructor(key: string) { super(`Tarefa já existe (${key})`); this.name = "ServiceTaskExistsError"; }
}

const isDuplicateEntry = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "ER_DUP_ENTRY" || e?.cause?.code === "ER_DUP_ENTRY";
};

/**
 * Arquivada (0376, "Eliminar" nas Tarefas) conta como fechada: o planeador
 * não a recria, não a atualiza nem a volta a fechar.
 */
async function withAssignees(db: any, rows: Array<{ id: number; sourceKey: string | null; taskStatus: string; dueDate: string | null; archivedAt?: string | null }>): Promise<ExistingServiceTask[]> {
  if (!rows.length) return [];
  const { taskAssignees } = await import("../drizzle/schema");
  const { inArray } = await import("drizzle-orm");
  const a = await db.select({ taskId: taskAssignees.taskId, employeeId: taskAssignees.employeeId }).from(taskAssignees)
    .where(inArray(taskAssignees.taskId, rows.map((r) => r.id)));
  const by = new Map<number, number[]>();
  for (const x of a) {
    if (!by.has(x.taskId)) by.set(x.taskId, []);
    const list = by.get(x.taskId)!;
    if (!list.includes(Number(x.employeeId))) list.push(Number(x.employeeId)); // responsável repetido (corrida no "assign") conta uma vez
  }
  return rows.map((r) => ({ id: r.id, sourceKey: String(r.sourceKey ?? ""), taskStatus: r.archivedAt ? "done" : r.taskStatus, dueDate: r.dueDate ? String(r.dueDate) : null, assigneeIds: by.get(r.id) ?? [] }));
}

export const defaultServiceTasksDeps: ServiceTasksDeps = {
  multiparkConfigured: () => isMultiparkDbConfigured(),
  syncGoogle(taskIds) {
    import("./google/syncService").then((m) => m.scheduleGoogleTaskSync({ taskIds })).catch(() => undefined);
  },
  query: multiparkDbQuery,
  async loadRules() {
    const { getSetting } = await import("./appSettings");
    return (await getSetting(SERVICE_TASKS_SETTING_KEY as any) as ServiceTaskRules | null) ?? DEFAULT_SERVICE_TASK_RULES;
  },
  async loadParks(query) {
    const { buildParksSql, mapParks } = await import("./multiparkDb/dayBookings");
    const ps = buildParksSql();
    const out: ServicePark[] = [];
    for (const p of mapParks(await query(ps.sql, ps.params))) {
      const city = p.ours && p.city ? SERVICE_TASK_CITY_FROM_PARK[p.city] : undefined;
      if (city) out.push({ id: p.id, name: p.name, city });
    }
    return out;
  },
  async loadOpenTasks() {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) throw new Error("BD indisponível");
    const { tasks } = await import("../drizzle/schema");
    const { and, asc, eq, gt, isNull, ne } = await import("drizzle-orm");
    // Por páginas de 1000, por id (antes: 1000 sem ordem — acima disso uma tarefa
    // podia ficar de fora e nunca fechar quando o serviço era retirado).
    const out: ExistingServiceTask[] = [];
    let after = 0;
    for (let page = 0; page < OPEN_TASKS_MAX_PAGES; page++) {
      const rows = await db.select({ id: tasks.id, sourceKey: tasks.sourceKey, taskStatus: tasks.taskStatus, dueDate: tasks.dueDate }).from(tasks)
        .where(and(eq(tasks.sourceModule, SERVICE_TASK_SOURCE), ne(tasks.taskStatus, "done"), isNull(tasks.archivedAt), gt(tasks.id, after)))
        .orderBy(asc(tasks.id)).limit(OPEN_TASKS_PAGE);
      out.push(...await withAssignees(db, rows));
      if (rows.length < OPEN_TASKS_PAGE) break;
      after = rows[rows.length - 1].id;
    }
    return out;
  },
  async loadTasksForBookings(bookingIds) {
    const ids = [...new Set(bookingIds.filter(Boolean))];
    if (!ids.length) return [];
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) throw new Error("BD indisponível");
    const { tasks } = await import("../drizzle/schema");
    const { and, eq, like, or } = await import("drizzle-orm");
    const out: ExistingServiceTask[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const rows = await db.select({ id: tasks.id, sourceKey: tasks.sourceKey, taskStatus: tasks.taskStatus, dueDate: tasks.dueDate, archivedAt: tasks.archivedAt }).from(tasks)
        .where(and(eq(tasks.sourceModule, SERVICE_TASK_SOURCE), or(...chunk.map((id) => like(tasks.sourceKey, serviceKeyPrefixLike(id))))));
      out.push(...await withAssignees(db, rows));
    }
    return out;
  },
  async loadTasksByKeys(keys) {
    if (!keys.length) return [];
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) throw new Error("BD indisponível");
    const { tasks } = await import("../drizzle/schema");
    const { and, eq, inArray } = await import("drizzle-orm");
    const out: ExistingServiceTask[] = [];
    for (let i = 0; i < keys.length; i += 500) {
      const rows = await db.select({ id: tasks.id, sourceKey: tasks.sourceKey, taskStatus: tasks.taskStatus, dueDate: tasks.dueDate, archivedAt: tasks.archivedAt }).from(tasks)
        .where(and(eq(tasks.sourceModule, SERVICE_TASK_SOURCE), inArray(tasks.sourceKey, keys.slice(i, i + 500))));
      out.push(...await withAssignees(db, rows));
    }
    return out;
  },
  async loadTeamLeaders(dates) {
    if (!dates.length) return [];
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) return [];
    const { sql } = await import("drizzle-orm");
    const rows = rowsOf(await db.execute(sql`SELECT assignmentDate, shift, city, employeeId, status FROM extras_dia_assignments
      WHERE isTeamLeader = 1 AND employeeId IS NOT NULL AND assignmentDate IN (${sql.join(dates.map((d) => sql`${d}`), sql`, `)})`));
    return rows.map((r) => ({ date: String(r.assignmentDate), shift: String(r.shift), city: String(r.city), employeeId: Number(r.employeeId), status: r.status == null ? null : String(r.status) }));
  },
  async cityProjectIds() {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) return {};
    const { projects } = await import("../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const { handoverCityKey } = await import("../shared/shiftHandover");
    const out: Partial<Record<ServiceTaskCity, number>> = {};
    for (const p of await db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.level, "city"))) {
      const c = handoverCityKey(p.name);
      if (c && out[c] == null) out[c] = p.id;
    }
    return out;
  },
  async systemUserId() {
    const { getSystemUserId } = await import("./db");
    return getSystemUserId();
  },
  async createTask(t) {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) throw new Error("BD indisponível");
    const { tasks, taskAssignees } = await import("../drizzle/schema");
    let res: any;
    try {
      [res] = await db.insert(tasks).values({
        title: t.title, description: t.description, projectId: t.projectId, assigneeId: t.assigneeIds[0] ?? null,
        createdById: t.createdById, taskStatus: "todo", taskPriority: "high",
        dueDate: mysqlNow(t.dueMs), dueHasTime: 1, sourceModule: SERVICE_TASK_SOURCE, sourceId: null, sourceKey: t.sourceKey,
        // 0545: a reserva fica na tarefa (filtro e chip do estado da reserva nas Tarefas).
        bookingRef: taskBookingRef(SERVICE_TASK_SOURCE, t.sourceKey),
      });
    } catch (err) {
      // chave única (migração 0325): outra corrida criou-a no mesmo instante
      if (isDuplicateEntry(err)) throw new ServiceTaskExistsError(t.sourceKey);
      throw err;
    }
    const taskId = Number((res as any).insertId);
    if (taskId && t.assigneeIds.length) await db.insert(taskAssignees).values(t.assigneeIds.map((employeeId) => ({ taskId, employeeId })));
    return taskId;
  },
  async updateTask(id, patch) {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) throw new Error("BD indisponível");
    const { tasks } = await import("../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    await db.update(tasks).set({ title: patch.title, description: patch.description, dueDate: mysqlNow(patch.dueMs), dueHasTime: 1, notifiedOverdue: 0 }).where(eq(tasks.id, id));
  },
  async addAssignees(id, employeeIds) {
    if (!employeeIds.length) return;
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) throw new Error("BD indisponível");
    const { tasks, taskAssignees } = await import("../drizzle/schema");
    const { and, eq, isNull } = await import("drizzle-orm");
    await db.insert(taskAssignees).values(employeeIds.map((employeeId) => ({ taskId: id, employeeId })));
    await db.update(tasks).set({ assigneeId: employeeIds[0] }).where(and(eq(tasks.id, id), isNull(tasks.assigneeId)));
  },
  async closeTask(id, comment, systemUserId) {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) throw new Error("BD indisponível");
    const { tasks, taskComments } = await import("../drizzle/schema");
    const { and, eq, ne } = await import("drizzle-orm");
    // notifiedComplete = 1: fecho automático não avisa ninguém.
    const res: any = await db.update(tasks).set({ taskStatus: "done", completedAt: mysqlNow(), notifiedComplete: 1 })
      .where(and(eq(tasks.id, id), ne(tasks.taskStatus, "done")));
    if (Number(res?.[0]?.affectedRows ?? res?.affectedRows ?? 1) > 0) {
      await db.insert(taskComments).values({ taskId: id, userId: systemUserId, body: comment });
    }
  },
  async loadLocalDone(lineIds) {
    const out = new Set<string>();
    const ids = [...new Set(lineIds.filter(Boolean))];
    if (!ids.length) return out;
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) return out;
    const { sql } = await import("drizzle-orm");
    for (let i = 0; i < ids.length; i += 1000) {
      const chunk = ids.slice(i, i + 1000);
      const rows = rowsOf(await db.execute(sql`SELECT lineId FROM service_extra_done WHERE done = 1 AND lineId IN (${sql.join(chunk.map((x) => sql`${x}`), sql`, `)})`));
      for (const r of rows) out.add(String(r.lineId));
    }
    return out;
  },
};

/** Junta às linhas o "feito" marcado cá. Se a nossa BD falhar, fica como estava (só o da Multipark). */
async function markLocalDone(lines: ServiceLine[], d: ServiceTasksDeps): Promise<void> {
  if (!lines.length) return;
  const done = await d.loadLocalDone(lines.map((l) => l.lineId)).catch(() => new Set<string>());
  for (const l of lines) if (done.has(l.lineId)) l.doneLocal = true;
}

/**
 * "Feito" na página Serviços → fecha já a tarefa desta linha (sem esperar pela
 * volta das 18:00) e manda o fecho para o Google. O comentário fica em nome de
 * quem marcou. Devolve quantas fechou.
 */
export async function closeServiceTaskForLine(bookingId: string, lineId: string, userId: number, deps: Partial<ServiceTasksDeps> = {}): Promise<number> {
  const d: ServiceTasksDeps = { ...defaultServiceTasksDeps, ...deps };
  const key = serviceTaskKey(bookingId, lineId);
  if (!key) return 0;
  const open = (await d.loadTasksByKeys([key])).filter((t) => t.taskStatus !== "done");
  for (const t of open) await d.closeTask(t.id, CLOSE_REASON_TEXT.done_local, userId);
  if (open.length) d.syncGoogle(open.map((t) => t.id));
  return open.length;
}

// ─── Corrida ────────────────────────────────────────────────────────────────

export interface ServiceTasksReport {
  ok: boolean;
  skipped?: string;
  done: boolean;
  lines: number;
  bookings: number;
  created: number;
  updated: number;
  assigned: number;
  closed: { cancelled: number; removed: number; done_multipark: number; done_local: number };
  pending: number;
  /** Criações que outra corrida fez ao mesmo tempo (a chave única travou a gémea). */
  alreadyExisted: number;
  truncated: boolean;
  errors: string[];
}

const emptyReport = (): ServiceTasksReport => ({
  ok: true, done: true, lines: 0, bookings: 0, created: 0, updated: 0, assigned: 0,
  closed: { cancelled: 0, removed: 0, done_multipark: 0, done_local: 0 }, pending: 0, alreadyExisted: 0, truncated: false, errors: [],
});

/** Folga para gravar o resultado antes do fim do prazo. */
const APPLY_MARGIN_MS = 3_000;

export async function runServiceTasks(o: { deadlineAt: number; now?: number }, deps: Partial<ServiceTasksDeps> = {}): Promise<ServiceTasksReport> {
  const d: ServiceTasksDeps = { ...defaultServiceTasksDeps, ...deps };
  const now = o.now ?? Date.now();
  const out = emptyReport();
  if (!d.multiparkConfigured()) return { ...out, skipped: "DATABASE_URL_MULTIPARK não está definida" };

  const rules = await d.loadRules();
  const open = await d.loadOpenTasks();
  const enabled = anyServiceTaskEnabled(rules);
  if (!enabled && open.length === 0) return { ...out, skipped: "nenhum serviço com \"gera tarefa\" ligado" };

  const parks = await d.loadParks(d.query);
  const parkById = new Map(parks.map((p) => [p.id, p]));
  const lines: ServiceLine[] = [];
  const checked = new Set<string>();

  // 1. Saídas na janela (só com algum tipo ligado).
  if (enabled && parks.length) {
    const w = buildServiceLinesWindowSql(now - SERVICE_TASKS_LOOKBACK_HOURS * 3_600_000, now + SERVICE_TASKS_WINDOW_HOURS * 3_600_000, parks.map((p) => p.id), SERVICE_LINES_LIMIT + 1);
    const rows = await d.query(w.sql, w.params);
    out.truncated = rows.length > SERVICE_LINES_LIMIT;
    const kept = rows.slice(0, SERVICE_LINES_LIMIT);
    // Reserva cortada a meio pelo LIMIT: não conta como "lida" (não fecha tarefas dela).
    const lastBooking = out.truncated ? str(kept[kept.length - 1]?.booking_id) : null;
    for (const r of kept) {
      const bid = str(r.booking_id);
      if (bid && bid !== lastBooking) checked.add(bid);
      const l = mapServiceLineRow(r, parkById);
      if (l) lines.push(l);
    }
  }

  // 2. Reservas das tarefas abertas que não vieram na janela.
  const missing = [...new Set(open.map((t) => parseServiceTaskKey(t.sourceKey)?.bookingId).filter((x): x is string => !!x && !checked.has(x)))];
  for (let i = 0; i < missing.length; i += IDS_CHUNK) {
    if (o.deadlineAt - Date.now() < APPLY_MARGIN_MS * 2) { out.done = false; break; }
    const chunk = missing.slice(i, i + IDS_CHUNK);
    const q = buildServiceLinesByIdsSql(chunk);
    const rows = await d.query(q.sql, q.params);
    // Reservas lidas = as pedidas que existem OU não existem (apagadas → fecha); parque que deixou de ser nosso também fecha.
    for (const id of chunk) checked.add(id);
    for (const r of rows) {
      const l = mapServiceLineRow(r, parkById);
      if (l) lines.push(l);
    }
  }

  // A mesma linha pode vir nas 2 leituras (reserva cortada pelo LIMIT da janela).
  const uniq = new Map<string, ServiceLine>();
  for (const l of lines) uniq.set(`${l.bookingId}:${l.lineId}`, l);
  lines.length = 0;
  lines.push(...uniq.values());
  await markLocalDone(lines, d);
  out.lines = lines.length;
  out.bookings = new Set(lines.map((l) => l.bookingId)).size;

  const keys = lines.map((l) => serviceTaskKey(l.bookingId, l.lineId)).filter((k): k is string => !!k);
  const byId = new Map<number, ExistingServiceTask>(open.map((t) => [t.id, t]));
  for (const t of await d.loadTasksByKeys(keys)) byId.set(t.id, t);

  const dates = new Set<string>();
  for (const l of lines) {
    const s = checkoutShifts(l.checkOutMs);
    dates.add(s.leaving.date); dates.add(s.previous.date);
  }
  const teamLeaders = await d.loadTeamLeaders([...dates].sort());

  // abertas por último: com uma aberta e uma fechada da mesma chave, a aberta é a que conta
  const existing = [...byId.values()].sort((a, b) => Number(a.taskStatus !== "done") - Number(b.taskStatus !== "done"));
  const actions = planServiceTasks({ lines, checkedBookingIds: checked, rules, existing, teamLeaders, nowMs: now });
  await applyServiceTaskActions(actions, o.deadlineAt, d, out);
  return out;
}

/** Aplica as ações (até ao prazo) e manda as tarefas tocadas para o Google. */
async function applyServiceTaskActions(actions: ServiceTaskAction[], deadlineAt: number, d: ServiceTasksDeps, out: ServiceTasksReport): Promise<void> {
  if (!actions.length) return;
  const projectIds = actions.some((a) => a.kind === "create") ? await d.cityProjectIds() : {};
  const systemUser = await d.systemUserId();
  const touched: number[] = [];
  for (let i = 0; i < actions.length; i++) {
    if (deadlineAt - Date.now() < APPLY_MARGIN_MS) { out.done = false; out.pending = actions.length - i; break; }
    const a: ServiceTaskAction = actions[i];
    try {
      if (a.kind === "create") {
        try {
          touched.push(await d.createTask({ title: a.title, description: a.description, projectId: projectIds[a.line.city] ?? null, createdById: systemUser, dueMs: a.dueMs, sourceKey: a.key, assigneeIds: a.assigneeIds }));
          out.created++;
        } catch (err) {
          if ((err as { code?: string })?.code !== "SERVICE_TASK_EXISTS") throw err;
          out.alreadyExisted++; // outra corrida criou-a: a próxima leitura já a vê
        }
      } else if (a.kind === "update") {
        await d.updateTask(a.taskId, { title: a.title, description: a.description, dueMs: a.dueMs });
        touched.push(a.taskId);
        out.updated++;
      } else if (a.kind === "assign") {
        await d.addAssignees(a.taskId, a.employeeIds);
        touched.push(a.taskId);
        out.assigned += a.employeeIds.length;
      } else {
        await d.closeTask(a.taskId, CLOSE_REASON_TEXT[a.reason], systemUser);
        touched.push(a.taskId);
        out.closed[a.reason]++;
      }
    } catch (err: any) {
      out.errors.push(`${a.kind}: ${String(err?.message ?? err).slice(0, 160)}`);
    }
  }
  const ids = touched.filter((x) => Number.isInteger(x) && x > 0);
  if (ids.length) d.syncGoogle(ids);
  out.ok = out.errors.length === 0;
}

/**
 * Janela de criação quando a reserva chega pelo webhook (Jorge, 30 set 2026):
 * 72 h. O resto nasce na volta das 18:00 quando a saída entra nas 48 h dela.
 * (Com 400 dias as tarefas iam para o Google semanas antes, as mudanças nas
 * Definições não chegavam às já criadas e passava-se o limite de abertas.)
 */
export const SERVICE_TASKS_WEBHOOK_WINDOW_HOURS = 72;

/**
 * Só as reservas dadas (as do webhook ou da repetição): cria/atualiza/fecha as
 * tarefas delas logo que a reserva chega ou muda — sem esperar por nenhuma
 * volta. Os team leaders do turno só se juntam quando a escala existir (volta
 * das 18:00).
 */
export async function runServiceTasksForBookings(bookingIds: readonly string[], o: { deadlineAt: number; now?: number }, deps: Partial<ServiceTasksDeps> = {}): Promise<ServiceTasksReport> {
  const d: ServiceTasksDeps = { ...defaultServiceTasksDeps, ...deps };
  const now = o.now ?? Date.now();
  const out = emptyReport();
  const ids = [...new Set(bookingIds.map((x) => String(x ?? "").trim()).filter(Boolean))].slice(0, IDS_CHUNK);
  if (!ids.length) return { ...out, skipped: "sem reservas" };
  if (!d.multiparkConfigured()) return { ...out, skipped: "DATABASE_URL_MULTIPARK não está definida" };
  const rules = await d.loadRules();
  // as tarefas destas reservas pela chave (índice), abertas e fechadas — antes filtrava-se
  // uma lista de 1000 abertas sem ordem, e uma tarefa de fora nunca fechava
  const existing = await d.loadTasksForBookings(ids);
  if (!anyServiceTaskEnabled(rules) && !existing.some((t) => t.taskStatus !== "done")) return { ...out, skipped: "nenhum serviço com \"gera tarefa\" ligado" };
  const parkById = new Map((await d.loadParks(d.query)).map((p) => [p.id, p]));
  const q = buildServiceLinesByIdsSql(ids);
  const lines: ServiceLine[] = [];
  for (const r of await d.query(q.sql, q.params)) {
    const l = mapServiceLineRow(r, parkById);
    if (l) lines.push(l);
  }
  await markLocalDone(lines, d);
  out.lines = lines.length;
  out.bookings = new Set(lines.map((l) => l.bookingId)).size;
  // abertas por último: com uma aberta e uma fechada da mesma chave, a aberta é a que conta
  const ordered = [...existing].sort((a, b) => Number(a.taskStatus !== "done") - Number(b.taskStatus !== "done"));
  const dates = new Set<string>();
  for (const l of lines) { const s = checkoutShifts(l.checkOutMs); dates.add(s.leaving.date); dates.add(s.previous.date); }
  const teamLeaders = await d.loadTeamLeaders([...dates].sort());
  const actions = planServiceTasks({ lines, checkedBookingIds: new Set(ids), rules, existing: ordered, teamLeaders, nowMs: now, windowHours: SERVICE_TASKS_WEBHOOK_WINDOW_HOURS });
  await applyServiceTaskActions(actions, o.deadlineAt, d, out);
  return out;
}

// ─── Repetição do que falha no webhook ──────────────────────────────────────
// A volta é só às 18:00 (Jorge, 29 set 2026) e não cria tarefas de saídas que
// já passaram: uma tarefa que falhe no webhook (BD lenta, erro a gravar, prazo
// esgotado) e cuja saída seja antes das 18:00 perdia-se sem ninguém saber.
// Agora fica em `service_task_retries` e a fila do webhook (multipark-deliveries,
// de hora a hora) repete-a.

export const SERVICE_RETRY_MAX_ATTEMPTS = 10;
export const SERVICE_RETRY_DELAY_MS = 10 * 60_000;

/** O relatório de uma corrida por reservas pede repetição? PURA. */
export function serviceReportNeedsRetry(r: Pick<ServiceTasksReport, "skipped" | "errors" | "done">): boolean {
  return !r.skipped && (r.errors.length > 0 || !r.done);
}

export interface ServiceRetryStore {
  queue(bookingId: string, error: string, nextAttemptAt: string): Promise<void>;
  due(limit: number, maxAttempts: number): Promise<string[]>;
  markDone(ids: string[]): Promise<void>;
  markFailed(ids: string[], error: string, nextAttemptAt: string): Promise<void>;
}

const retryDb = async () => {
  const { getDb } = await import("./db");
  const db = await getDb();
  if (!db) throw new Error("BD indisponível");
  return db as any;
};
const inIds = async (ids: string[]) => { const { sql } = await import("drizzle-orm"); return sql.join(ids.map((x) => sql`${x}`), sql`, `); };

export const defaultServiceRetryStore: ServiceRetryStore = {
  async queue(bookingId, error, nextAttemptAt) {
    const db = await retryDb();
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`INSERT INTO service_task_retries (bookingExternalId, attempts, nextAttemptAt, lastError) VALUES (${bookingId}, 0, ${nextAttemptAt}, ${error.slice(0, 250)})
      ON DUPLICATE KEY UPDATE attempts = IF(doneAt IS NULL, attempts, 0), nextAttemptAt = VALUES(nextAttemptAt), lastError = VALUES(lastError), doneAt = NULL`);
  },
  async due(limit, maxAttempts) {
    const db = await retryDb();
    const { sql } = await import("drizzle-orm");
    const res: any = await db.execute(sql`SELECT bookingExternalId AS id FROM service_task_retries
      WHERE doneAt IS NULL AND attempts < ${maxAttempts} AND nextAttemptAt <= UTC_TIMESTAMP() ORDER BY nextAttemptAt LIMIT ${limit}`);
    return ((Array.isArray(res) ? res[0] : res) as any[] ?? []).map((r) => String(r.id));
  },
  async markDone(ids) {
    if (!ids.length) return;
    const db = await retryDb();
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`UPDATE service_task_retries SET doneAt = UTC_TIMESTAMP() WHERE bookingExternalId IN (${await inIds(ids)})`);
  },
  async markFailed(ids, error, nextAttemptAt) {
    if (!ids.length) return;
    const db = await retryDb();
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`UPDATE service_task_retries SET attempts = attempts + 1, nextAttemptAt = ${nextAttemptAt}, lastError = ${error.slice(0, 250)}
      WHERE bookingExternalId IN (${await inIds(ids)})`);
  },
};

/** Guarda a reserva para repetir as tarefas dela (a fila do webhook trata). */
export async function queueServiceTaskRetry(bookingId: string, error: string, o: { nowMs?: number; store?: ServiceRetryStore } = {}): Promise<void> {
  if (!bookingId) return;
  await (o.store ?? defaultServiceRetryStore).queue(bookingId, error || "erro", mysqlNow((o.nowMs ?? Date.now()) + SERVICE_RETRY_DELAY_MS));
}

/** Repete as tarefas das reservas que falharam no webhook (em lote, até ao prazo). */
export async function retryServiceTasks(
  o: { deadlineAt: number; limit?: number; nowMs?: number },
  store: ServiceRetryStore = defaultServiceRetryStore,
  run: typeof runServiceTasksForBookings = runServiceTasksForBookings,
): Promise<{ due: number; done: number; failed: number; report?: ServiceTasksReport }> {
  const ids = await store.due(Math.max(1, Math.min(IDS_CHUNK, o.limit ?? 50)), SERVICE_RETRY_MAX_ATTEMPTS);
  if (!ids.length) return { due: 0, done: 0, failed: 0 };
  const next = mysqlNow((o.nowMs ?? Date.now()) + SERVICE_RETRY_DELAY_MS);
  try {
    const report = await run(ids, { deadlineAt: o.deadlineAt });
    if (serviceReportNeedsRetry(report)) {
      await store.markFailed(ids, report.errors[0] ?? "prazo esgotado", next);
      return { due: ids.length, done: 0, failed: ids.length, report };
    }
    await store.markDone(ids);
    return { due: ids.length, done: ids.length, failed: 0, report };
  } catch (err: any) {
    await store.markFailed(ids, String(err?.message ?? err).slice(0, 250), next);
    return { due: ids.length, done: 0, failed: ids.length };
  }
}

// ─── Aviso das tarefas de amanhã (team leaders + supervisores da cidade) ────

export interface TomorrowServiceTask { id: number; title: string; dueDate: string; projectId: number | null }

/** Texto do aviso de uma cidade (hora de Lisboa, por ordem de saída). PURA. */
export function tomorrowAlertBody(list: readonly TomorrowServiceTask[]): string {
  const hm = (utc: string) => {
    const ms = Date.parse(`${utc.replace(" ", "T")}Z`);
    return Number.isFinite(ms) ? new Intl.DateTimeFormat("pt-PT", { timeZone: "Europe/Lisbon", hour: "2-digit", minute: "2-digit" }).format(ms) : "--:--";
  };
  const sorted = [...list].sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id - b.id);
  const lines = sorted.slice(0, 40).map((t) => `${hm(t.dueDate)} · ${t.title}`);
  if (sorted.length > 40) lines.push(`… e mais ${sorted.length - 40}`);
  return lines.join("\n");
}

/** Tarefas de serviço por fazer com prazo (saída) AMANHÃ, hora de Lisboa → 1 aviso por cidade. */
export async function sendServiceTasksTomorrowAlert(nowMs: number = Date.now()): Promise<{ date: string; tasks: number; cities: number }> {
  const { getDb } = await import("./db");
  const db = await getDb();
  if (!db) throw new Error("BD indisponível");
  const { tasks } = await import("../drizzle/schema");
  const { and, eq, gte, isNull, lt, ne } = await import("drizzle-orm");
  const { lisbonDayRangeUtc, lisbonDayOf, addDays: addDay } = await import("../shared/lisbonDay");
  const date = addDay(lisbonDayOf(nowMs), 1);
  const range = lisbonDayRangeUtc(date, date);
  const rows = await db.select({ id: tasks.id, title: tasks.title, dueDate: tasks.dueDate, projectId: tasks.projectId }).from(tasks)
    .where(and(eq(tasks.sourceModule, SERVICE_TASK_SOURCE), ne(tasks.taskStatus, "done"), isNull(tasks.archivedAt), gte(tasks.dueDate, range.start), lt(tasks.dueDate, range.end)))
    .limit(2000);
  const byProject = new Map<number | null, TomorrowServiceTask[]>();
  for (const r of rows) {
    const t = { id: r.id, title: String(r.title ?? ""), dueDate: String(r.dueDate ?? ""), projectId: r.projectId ?? null };
    if (!byProject.has(t.projectId)) byProject.set(t.projectId, []);
    byProject.get(t.projectId)!.push(t);
  }
  const { notify } = await import("./notify");
  for (const [projectId, list] of byProject) {
    await notify({
      kind: "service_tasks_tomorrow", projectId,
      title: `Serviços de amanhã (${date.split("-").reverse().join("/")}): ${list.length} tarefa${list.length === 1 ? "" : "s"}`,
      body: tomorrowAlertBody(list),
      link: "/servicos",
      entity: { type: "service_tasks_day", id: `${date}:${projectId ?? 0}` },
    });
  }
  return { date, tasks: rows.length, cities: byProject.size };
}

// ─── Definições: catálogo dos tipos e pessoas por cidade ────────────────────

export interface ServiceTaskCatalog {
  available: boolean;
  reason: string | null;
  cities: Record<ServiceTaskCity, Array<{ key: string; label: string; names: string[]; parks: number }>>;
  employees: Record<ServiceTaskCity, Array<{ id: number; fullName: string }>>;
}

/** Tipos do catálogo "ExtraService" (parques nossos) por cidade. PURA. */
export function buildExtraServiceCatalogSql(parkIds: string[]): { sql: string; params: SqlParam[] } {
  if (!parkIds.length) throw new Error("Sem parques.");
  const params: SqlParam[] = [...parkIds];
  const ph = parkIds.map((_, i) => `$${i + 1}`).join(", ");
  params.push(2000);
  return { sql: `SELECT x."name" AS name, x."parkId" AS park_id FROM "ExtraService" x WHERE x."parkId" IN (${ph}) ORDER BY x."sortOrder" ASC, x."name" ASC LIMIT $${params.length}`, params };
}

export async function loadServiceTaskCatalog(deps: Partial<Pick<ServiceTasksDeps, "multiparkConfigured" | "query" | "loadParks">> = {}): Promise<ServiceTaskCatalog> {
  const d = { ...defaultServiceTasksDeps, ...deps };
  const { groupServiceTypes } = await import("../shared/serviceTasks");
  const empty = () => ({ lisbon: [], porto: [], faro: [] }) as any;
  const out: ServiceTaskCatalog = { available: false, reason: null, cities: empty(), employees: empty() };
  // Pessoas por cidade (fichas ativas; cidade pela árvore de projetos).
  try {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (db) {
      const { employees } = await import("../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const rows = await db.select({ id: employees.id, fullName: employees.fullName, projectId: employees.projectId, address: employees.address })
        .from(employees).where(eq(employees.isActive, 1)).limit(5000);
      const { resolveEmployeeCities } = await import("./employeeCity");
      const cities = await resolveEmployeeCities(rows);
      for (const r of rows) {
        const c = cities.get(r.id)?.city;
        const key = c ? SERVICE_TASK_CITY_FROM_PARK[c] : undefined;
        if (key) out.employees[key].push({ id: r.id, fullName: r.fullName });
      }
      for (const c of SERVICE_TASK_CITIES) out.employees[c].sort((a, b) => a.fullName.localeCompare(b.fullName, "pt"));
    }
  } catch (err: any) {
    console.warn("[services-tasks] pessoas:", String(err?.message ?? err).slice(0, 160));
  }
  if (!d.multiparkConfigured()) return { ...out, reason: "DATABASE_URL_MULTIPARK não está definida." };
  try {
    const parks = await d.loadParks(d.query);
    if (!parks.length) return { ...out, available: true };
    const q = buildExtraServiceCatalogSql(parks.map((p) => p.id));
    const rows = await d.query(q.sql, q.params);
    const byPark = new Map(parks.map((p) => [p.id, p]));
    for (const c of SERVICE_TASK_CITIES) {
      const names: string[] = [];
      const parksOf = new Map<string, Set<string>>();
      for (const r of rows) {
        const p = byPark.get(String(r.park_id ?? ""));
        const name = str(r.name);
        if (!p || p.city !== c || !name) continue;
        names.push(name);
        const t = groupServiceTypes([name])[0];
        if (t) { if (!parksOf.has(t.key)) parksOf.set(t.key, new Set()); parksOf.get(t.key)!.add(p.id); }
      }
      out.cities[c] = groupServiceTypes(names).map((t) => ({ ...t, parks: parksOf.get(t.key)?.size ?? 0 }));
    }
    return { ...out, available: true };
  } catch (err: any) {
    const { redactSecrets } = await import("./multiparkDb/client");
    return { ...out, reason: `BD da Multipark indisponível (${redactSecrets(err).slice(0, 160)}).` };
  }
}

// ─── Página Serviços: tarefas geradas das reservas ──────────────────────────

/** Tarefas de serviço com prazo (= saída do carro) nos dias de Lisboa [start, end] — link na página /servicos. */
export async function serviceTasksInRange(startDate: string, endDate: string): Promise<Array<{ taskId: number; bookingId: string; lineId: string; serviceName: string; status: string }>> {
  const { getDb } = await import("./db");
  const db = await getDb();
  if (!db) return [];
  const { tasks } = await import("../drizzle/schema");
  const { and, eq, gte, isNull, lt } = await import("drizzle-orm");
  const { SERVICE_TASK_TITLE_SEP } = await import("../shared/serviceTasks");
  const { lisbonDayRangeUtc } = await import("../shared/lisbonDay");
  const { projectScope } = await import("./cityScope");
  const range = lisbonDayRangeUtc(startDate, endDate);
  const rows = await db.select({ id: tasks.id, sourceKey: tasks.sourceKey, title: tasks.title, taskStatus: tasks.taskStatus }).from(tasks)
    .where(and(eq(tasks.sourceModule, SERVICE_TASK_SOURCE), isNull(tasks.archivedAt), gte(tasks.dueDate, range.start), lt(tasks.dueDate, range.end), projectScope(tasks.projectId)))
    .limit(5000);
  const out: Array<{ taskId: number; bookingId: string; lineId: string; serviceName: string; status: string }> = [];
  for (const r of rows) {
    const k = parseServiceTaskKey(r.sourceKey);
    if (!k) continue;
    out.push({ taskId: r.id, bookingId: k.bookingId, lineId: k.lineId, serviceName: String(r.title ?? "").split(SERVICE_TASK_TITLE_SEP)[0] ?? "", status: r.taskStatus });
  }
  return out;
}
