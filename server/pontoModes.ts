/**
 * Modo do ponto por pessoa (plano 63, passo 1) — o lado do servidor. As
 * regras puras estão em shared/pontoMode.ts; aqui só se lê e grava a BD (por
 * uma `PontoModeStore`, para os testes trocarem a BD por memória) e se juntam
 * as peças. Interruptor PONTO_MODOS (desligado, só o super admin o liga):
 * desligado, o cartão não aparece, nada grava e as picagens ficam como até aqui.
 *
 * Neste passo NENHUMA regra muda: o modo, os avisos lidos e os alertas ficam só
 * guardados e à vista; o rasto das picagens é só informação.
 */
import {
  PONTO_MODOS_FLAG, PONTO_NOTICES, latestAck, noticeForMode, normalizePontoMode, pontoAlertVisible,
  pontoModeChangeCheck, pontoModeEarliestFrom, pontoModeLabel, pontoModeOn, pontoModeTimeline, pontoTrailColumns,
  type PontoAckChannel, type PontoAlertStatus, type PontoMode, type PontoModeEntry, type PontoNoticeKey,
  type PontoTrailColumns, type PontoTrailInput,
} from "../shared/pontoMode";
import { operationalDayOf } from "../shared/lisbonDay";

export class PontoModeError extends Error {
  constructor(public code: "BAD_REQUEST" | "FORBIDDEN" | "NOT_FOUND" | "PRECONDITION_FAILED", message: string) {
    super(message);
  }
}

export interface PontoModeEmployee {
  id: number;
  fullName: string;
  position: string | null;
  contractType: string | null;
  zelloUsername: string | null;
  isActive: boolean;
  hasMultiparkAgent: boolean;
}

export interface PontoModeHistoryRow extends PontoModeEntry {
  employeeId: number;
  note: string | null;
  setById: number | null;
  setAt: string | null;
}

export interface PontoAckRow {
  id: number;
  employeeId: number;
  mode: string | null;
  notice: string;
  channel: string;
  ackAt: string;
  ackByUserId: number | null;
  note: string | null;
}

export interface PontoAlertRow {
  id: number;
  employeeId: number;
  kind: string;
  day: string;
  timeRecordId: number | null;
  detail: string | null;
  severity: string;
  status: string;
  reviewedById: number | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string | null;
}

/** O que o modo do ponto precisa da BD. */
export interface PontoModeStore {
  employee(id: number): Promise<PontoModeEmployee | null>;
  history(employeeId: number): Promise<PontoModeHistoryRow[]>;
  insertHistory(row: { employeeId: number; mode: PontoMode | null; effectiveFrom: string; note: string; setById: number; setAt: string }): Promise<number>;
  /** cópia do modo de hoje em `employees.pontoMode` */
  setCachedMode(employeeId: number, mode: PontoMode | null): Promise<void>;
  hasOpenCheckIn(employeeId: number): Promise<boolean>;
  /** meses com o ordenado fechado ("AAAA-MM"); lança se não der para ler */
  closedMonths(): Promise<Set<string>>;
  acks(employeeId: number): Promise<PontoAckRow[]>;
  insertAck(row: Omit<PontoAckRow, "id">): Promise<void>;
  alerts(employeeId: number, limit: number): Promise<PontoAlertRow[]>;
  alertById(id: number): Promise<PontoAlertRow | null>;
  reviewAlert(id: number, patch: { status: PontoAlertStatus; reviewedById: number; reviewedAt: string; reviewNote: string | null }): Promise<void>;
  userNames(ids: number[]): Promise<Map<number, string>>;
  log(entry: { userId: number; action: "create" | "update"; entity: string; entityId: number; details: string }): Promise<void>;
}

const nowDb = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/** Interruptor PONTO_MODOS (desligado por omissão; erro a ler → desligado). */
export async function pontoModesEnabled(): Promise<boolean> {
  try {
    const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([
      import("./_core/featureFlags"),
      import("../shared/appSettings"),
    ]);
    await ensureFeatureFlagOverrides();
    return isFeatureEnabled(PONTO_MODOS_FLAG, { defaultEnabled: automationFlagDefault(PONTO_MODOS_FLAG) });
  } catch {
    return false;
  }
}

// ─── Mudar o modo ────────────────────────────────────────────────────────────

export interface SetPontoModeInput {
  actor: { id: number; role: string };
  employeeId: number;
  mode: PontoMode | null;
  effectiveFrom: string;
  note: string;
  nowMs: number;
}

/**
 * Grava uma mudança do modo (só o super admin; as guardas em
 * `pontoModeChangeCheck`). Uma linha nova no histórico, a cópia em
 * `employees.pontoMode` e o registo de atividade. Nada se apaga.
 */
export async function setPontoMode(store: PontoModeStore, i: SetPontoModeInput): Promise<{ mode: PontoMode | null; effectiveFrom: string; current: PontoMode | null; warnings: string[] }> {
  if (i.actor.role !== "super_admin") throw new PontoModeError("FORBIDDEN", "Só o super admin muda o modo do ponto.");
  const emp = await store.employee(i.employeeId);
  if (!emp) throw new PontoModeError("NOT_FOUND", "Ficha não encontrada.");
  let closed: Set<string>;
  try {
    closed = await store.closedMonths();
  } catch {
    // um erro nunca pode passar por "nenhum mês fechado"
    throw new PontoModeError("PRECONDITION_FAILED", "Não deu para ler os meses fechados do ordenado: tenta outra vez daqui a pouco.");
  }
  const [history, hasOpenCheckIn] = await Promise.all([store.history(i.employeeId), store.hasOpenCheckIn(i.employeeId)]);
  const today = operationalDayOf(i.nowMs);
  const note = String(i.note ?? "").trim().slice(0, 255);
  const check = pontoModeChangeCheck({
    actorRole: i.actor.role,
    employee: { position: emp.position, contractType: emp.contractType, zelloUsername: emp.zelloUsername, hasMultiparkAgent: emp.hasMultiparkAgent, isActive: emp.isActive },
    history, mode: i.mode, effectiveFrom: i.effectiveFrom, today, closedMonths: closed, hasOpenCheckIn, note,
  });
  if (check.error) throw new PontoModeError("BAD_REQUEST", check.error);
  const before = pontoModeOn(today, history);
  const id = await store.insertHistory({ employeeId: i.employeeId, mode: i.mode, effectiveFrom: i.effectiveFrom, note, setById: i.actor.id, setAt: nowDb(i.nowMs) });
  const after = [...history, { id: id || history.reduce((m, e) => Math.max(m, e.id), 0) + 1, employeeId: i.employeeId, mode: i.mode, effectiveFrom: i.effectiveFrom, note, setById: i.actor.id, setAt: nowDb(i.nowMs) }];
  const current = pontoModeOn(today, after);
  await store.setCachedMode(i.employeeId, current);
  await store.log({
    userId: i.actor.id, action: "update", entity: "employee_ponto_mode", entityId: i.employeeId,
    details: `Modo do ponto: ${pontoModeLabel(before)} → ${pontoModeLabel(i.mode)} a partir de ${i.effectiveFrom} (${check.changedDays.length} dia(s)). Motivo: ${note}`.slice(0, 1000),
  });
  return { mode: i.mode, effectiveFrom: i.effectiveFrom, current, warnings: check.warnings };
}

// ─── O cartão da ficha ───────────────────────────────────────────────────────

export interface PontoModeViewer { id: number; role: string; isOwn: boolean; canManage: boolean }

export interface PontoModeView {
  employeeId: number;
  today: string;
  current: PontoMode | null;
  viewer: { isOwn: boolean; isSuperAdmin: boolean; canEdit: boolean; canRecordPaper: boolean };
  history: Array<{ id: number; mode: PontoMode | null; effectiveFrom: string; note: string | null; setByName: string | null; setAt: string | null; superseded: boolean }>;
  notice: null | {
    key: PontoNoticeKey; title: string; text: string;
    ack: null | { at: string; channel: string; byName: string | null };
  };
  alerts: Array<{ id: number; kind: string; day: string; detail: string | null; severity: string; status: string; reviewedByName: string | null; reviewedAt: string | null; reviewNote: string | null }>;
  /** só para o super admin: o que o cartão precisa para mostrar as guardas antes de gravar */
  guard: null | {
    employee: { position: string | null; contractType: string | null; zelloUsername: string | null; hasMultiparkAgent: boolean; isActive: boolean };
    closedMonths: string[];
    closedMonthsReadFailed: boolean;
    hasOpenCheckIn: boolean;
    earliestFrom: Record<"none" | PontoMode, string>;
    history: Array<{ id: number; mode: PontoMode | null; effectiveFrom: string }>;
  };
}

export async function pontoModeView(store: PontoModeStore, o: { employeeId: number; viewer: PontoModeViewer; nowMs: number }): Promise<PontoModeView> {
  const emp = await store.employee(o.employeeId);
  if (!emp) throw new PontoModeError("NOT_FOUND", "Ficha não encontrada.");
  const today = operationalDayOf(o.nowMs);
  const isSuperAdmin = o.viewer.role === "super_admin";
  const [history, acks, alertRows] = await Promise.all([
    store.history(o.employeeId),
    store.acks(o.employeeId),
    o.viewer.isOwn ? Promise.resolve([] as PontoAlertRow[]) : store.alerts(o.employeeId, 50),
  ]);
  const current = pontoModeOn(today, history);
  const alerts = alertRows.filter((a) => pontoAlertVisible(a.kind, o.viewer));
  const noticeKey = noticeForMode(current);
  const ack = noticeKey ? latestAck(acks, noticeKey) : null;
  const names = await store.userNames(Array.from(new Set([
    ...history.map((h) => h.setById), ...alerts.map((a) => a.reviewedById), ack?.ackByUserId,
  ].filter((x): x is number => typeof x === "number" && x > 0))));
  const nameOf = (id: number | null | undefined) => (id ? names.get(id) ?? `#${id}` : null);

  let guard: PontoModeView["guard"] = null;
  if (isSuperAdmin) {
    let closedMonths: string[] = [];
    let closedMonthsReadFailed = false;
    try { closedMonths = Array.from(await store.closedMonths()).sort(); } catch { closedMonthsReadFailed = true; }
    const closed = new Set(closedMonths);
    const hasOpenCheckIn = await store.hasOpenCheckIn(o.employeeId);
    const earliest = (mode: PontoMode | null) => pontoModeEarliestFrom({ mode, currentMode: current, today, closedMonths: closed });
    guard = {
      employee: { position: emp.position, contractType: emp.contractType, zelloUsername: emp.zelloUsername, hasMultiparkAgent: emp.hasMultiparkAgent, isActive: emp.isActive },
      closedMonths, closedMonthsReadFailed, hasOpenCheckIn,
      earliestFrom: { none: earliest(null), fixed: earliest("fixed"), exempt: earliest("exempt"), always_on: earliest("always_on") },
      history: history.map((h) => ({ id: h.id, mode: normalizePontoMode(h.mode), effectiveFrom: String(h.effectiveFrom).slice(0, 10) })),
    };
  }

  return {
    employeeId: o.employeeId,
    today,
    current,
    viewer: {
      isOwn: o.viewer.isOwn,
      isSuperAdmin,
      canEdit: isSuperAdmin,
      // o RH regista a leitura em papel de outra pessoa (nunca a própria)
      canRecordPaper: !o.viewer.isOwn && (isSuperAdmin || o.viewer.canManage),
    },
    history: pontoModeTimeline(history).reverse().map((h) => ({
      id: h.id, mode: normalizePontoMode(h.mode), effectiveFrom: String(h.effectiveFrom).slice(0, 10), note: h.note ?? null,
      setByName: nameOf(h.setById), setAt: h.setAt ?? null, superseded: h.superseded,
    })),
    notice: noticeKey ? {
      key: noticeKey, title: PONTO_NOTICES[noticeKey].title, text: PONTO_NOTICES[noticeKey].text,
      ack: ack ? { at: ack.ackAt, channel: ack.channel, byName: nameOf(ack.ackByUserId) } : null,
    } : null,
    alerts: alerts.map((a) => ({
      id: a.id, kind: a.kind, day: String(a.day).slice(0, 10), detail: a.detail, severity: a.severity, status: a.status,
      reviewedByName: nameOf(a.reviewedById), reviewedAt: a.reviewedAt, reviewNote: a.reviewNote,
    })),
    guard,
  };
}

// ─── Avisos lidos ────────────────────────────────────────────────────────────

/**
 * Regista a leitura de um aviso: "Li" na app (a própria pessoa, por qualquer
 * login da ficha) ou em papel (o RH, numa ficha que não é a dele). Só o aviso
 * do modo de hoje. Ler outra vez o mesmo aviso não cria outra linha.
 */
export async function recordPontoNoticeAck(store: PontoModeStore, o: {
  employeeId: number; notice: PontoNoticeKey; channel: PontoAckChannel; actorUserId: number; note?: string | null; nowMs: number;
}): Promise<{ already: boolean; ackAt: string }> {
  const today = operationalDayOf(o.nowMs);
  const history = await store.history(o.employeeId);
  const current = pontoModeOn(today, history);
  const expected = noticeForMode(current);
  if (!expected || expected !== o.notice) throw new PontoModeError("BAD_REQUEST", "Esse aviso não é o do modo do ponto de hoje desta ficha.");
  const acks = await store.acks(o.employeeId);
  const prev = latestAck(acks, o.notice);
  if (prev) return { already: true, ackAt: prev.ackAt };
  const ackAt = nowDb(o.nowMs);
  const note = o.channel === "paper" ? String(o.note ?? "").trim().slice(0, 255) || null : null;
  await store.insertAck({ employeeId: o.employeeId, mode: current, notice: o.notice, channel: o.channel, ackAt, ackByUserId: o.actorUserId, note });
  await store.log({
    userId: o.actorUserId, action: "create", entity: "ponto_mode_ack", entityId: o.employeeId,
    details: `Aviso do ponto "${PONTO_NOTICES[o.notice].title}" lido ${o.channel === "paper" ? "em papel (registado pelo RH)" : "na app (\"Li\")"}${note ? ` · ${note}` : ""}`.slice(0, 1000),
  });
  return { already: false, ackAt };
}

// ─── Alertas ─────────────────────────────────────────────────────────────────

/** Rever um alerta (visto / justificado / confirmado). Nunca na própria ficha. */
export async function reviewPontoAlert(store: PontoModeStore, o: {
  alertId: number; status: Exclude<PontoAlertStatus, "open">; note?: string | null; viewer: PontoModeViewer; nowMs: number;
}): Promise<void> {
  const a = await store.alertById(o.alertId);
  if (!a) throw new PontoModeError("NOT_FOUND", "Alerta não encontrado.");
  if (o.viewer.isOwn) throw new PontoModeError("FORBIDDEN", "Ninguém revê a própria ficha.");
  if (!pontoAlertVisible(a.kind, o.viewer)) throw new PontoModeError("FORBIDDEN", "Sem permissão para rever este alerta.");
  const note = String(o.note ?? "").trim().slice(0, 255) || null;
  await store.reviewAlert(o.alertId, { status: o.status, reviewedById: o.viewer.id, reviewedAt: nowDb(o.nowMs), reviewNote: note });
  await store.log({
    userId: o.viewer.id, action: "update", entity: "ponto_alert", entityId: o.alertId,
    details: `Alerta do ponto (${a.kind}, ${String(a.day).slice(0, 10)}) → ${o.status}${note ? ` · ${note}` : ""}`.slice(0, 1000),
  });
}

// ─── Rasto das picagens ──────────────────────────────────────────────────────

/**
 * As colunas do rasto para uma picagem (entrada ou saída). Com PONTO_MODOS
 * desligado → nada (a picagem fica como até aqui). Nunca impede o ponto: um erro
 * a ler o histórico dá só as colunas que não precisam dele.
 */
export async function pontoTrailForRecord(o: {
  employeeId: number; actorUserId: number; input?: PontoTrailInput | null; hasPhoto: boolean; nowMs?: number;
  enabled?: () => Promise<boolean>; store?: () => Promise<Pick<PontoModeStore, "history">>;
}): Promise<Partial<PontoTrailColumns>> {
  try {
    if (!(await (o.enabled ?? pontoModesEnabled)())) return {};
  } catch {
    return {};
  }
  let mode: PontoMode | null = null;
  try {
    const store = await (o.store ?? mysqlPontoModeStore)();
    mode = pontoModeOn(operationalDayOf(o.nowMs ?? Date.now()), await store.history(o.employeeId));
  } catch {
    mode = null;
  }
  return pontoTrailColumns({ input: o.input ?? null, hasPhoto: o.hasPhoto, actorUserId: o.actorUserId, mode });
}

// ─── Login da ficha ──────────────────────────────────────────────────────────

/** Esta conta é um login desta ficha (a principal ou uma conta extra)? */
export async function isLoginOfEmployee(userId: number, employeeId: number): Promise<boolean> {
  const { getEmployeeById } = await import("./db");
  const e = await getEmployeeById(employeeId);
  if (!e) return false;
  if (e.employee.userId != null && Number(e.employee.userId) === userId) return true;
  const { employeeIdForAliasUser } = await import("./employeeAliases");
  return (await employeeIdForAliasUser(userId)) === employeeId;
}

// ─── BD (MySQL) ──────────────────────────────────────────────────────────────

export async function mysqlPontoModeStore(): Promise<PontoModeStore> {
  const [{ getDb, logActivity }, schema, { desc, eq, inArray }] = await Promise.all([
    import("./db"), import("../drizzle/schema"), import("drizzle-orm"),
  ]);
  const db = await getDb();
  if (!db) throw new Error("BD indisponível");
  const { employees, employeePontoModes, pontoAlerts, pontoModeAcks, timeRecords, users } = schema;
  const str = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 19).replace("T", " ") : String(v));
  return {
    async employee(id) {
      const [e] = await db.select({
        id: employees.id, fullName: employees.fullName, position: employees.position, contractType: employees.contractType,
        zelloUsername: employees.zelloUsername, isActive: employees.isActive,
      }).from(employees).where(eq(employees.id, id)).limit(1);
      if (!e) return null;
      const { agentIdsOfEmployee } = await import("./personIdentity");
      const agents = await agentIdsOfEmployee(id).catch(() => ({ agentUserIds: [] as string[] }));
      return {
        id: Number(e.id), fullName: String(e.fullName), position: e.position ?? null, contractType: e.contractType ?? null,
        zelloUsername: e.zelloUsername ?? null, isActive: Number(e.isActive) === 1, hasMultiparkAgent: agents.agentUserIds.length > 0,
      };
    },
    async history(employeeId) {
      const rows = await db.select().from(employeePontoModes).where(eq(employeePontoModes.employeeId, employeeId)).orderBy(employeePontoModes.id);
      return rows.map((r) => ({
        id: Number(r.id), employeeId: Number(r.employeeId), mode: normalizePontoMode(r.mode), effectiveFrom: String(r.effectiveFrom).slice(0, 10),
        note: r.note ?? null, setById: r.setById ?? null, setAt: str(r.setAt),
      }));
    },
    async insertHistory(row) {
      const ins = await db.insert(employeePontoModes).values({
        employeeId: row.employeeId, mode: row.mode, effectiveFrom: row.effectiveFrom, note: row.note || null, setById: row.setById, setAt: row.setAt,
      });
      return Number((ins as any)?.[0]?.insertId ?? 0);
    },
    async setCachedMode(employeeId, mode) {
      await db.update(employees).set({ pontoMode: mode }).where(eq(employees.id, employeeId));
    },
    async hasOpenCheckIn(employeeId) {
      const [last] = await db.select({ type: timeRecords.type }).from(timeRecords)
        .where(eq(timeRecords.employeeId, employeeId)).orderBy(desc(timeRecords.recordedAt), desc(timeRecords.id)).limit(1);
      return last?.type === "check_in";
    },
    async closedMonths() {
      const { closedPayrollMonthKeys } = await import("./terminalPay");
      return closedPayrollMonthKeys();
    },
    async acks(employeeId) {
      const rows = await db.select().from(pontoModeAcks).where(eq(pontoModeAcks.employeeId, employeeId)).orderBy(pontoModeAcks.id);
      return rows.map((r) => ({
        id: Number(r.id), employeeId: Number(r.employeeId), mode: r.mode ?? null, notice: String(r.notice), channel: String(r.channel),
        ackAt: str(r.ackAt) ?? "", ackByUserId: r.ackByUserId ?? null, note: r.note ?? null,
      }));
    },
    async insertAck(row) {
      await db.insert(pontoModeAcks).values({
        employeeId: row.employeeId, mode: row.mode, notice: row.notice, channel: row.channel, ackAt: row.ackAt, ackByUserId: row.ackByUserId, note: row.note,
      });
    },
    async alerts(employeeId, limit) {
      const rows = await db.select().from(pontoAlerts).where(eq(pontoAlerts.employeeId, employeeId)).orderBy(desc(pontoAlerts.day), desc(pontoAlerts.id)).limit(limit);
      return rows.map(alertRow);
    },
    async alertById(id) {
      const [r] = await db.select().from(pontoAlerts).where(eq(pontoAlerts.id, id)).limit(1);
      return r ? alertRow(r) : null;
    },
    async reviewAlert(id, patch) {
      await db.update(pontoAlerts).set({ status: patch.status, reviewedById: patch.reviewedById, reviewedAt: patch.reviewedAt, reviewNote: patch.reviewNote })
        .where(eq(pontoAlerts.id, id));
    },
    async userNames(ids) {
      const out = new Map<number, string>();
      if (!ids.length) return out;
      const rows = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, ids));
      for (const r of rows) out.set(Number(r.id), String(r.name || r.email || `#${r.id}`));
      return out;
    },
    async log(entry) {
      await logActivity({ userId: entry.userId, action: entry.action, entity: entry.entity, entityId: entry.entityId, details: entry.details });
    },
  };
  function alertRow(r: any): PontoAlertRow {
    return {
      id: Number(r.id), employeeId: Number(r.employeeId), kind: String(r.kind), day: String(r.day).slice(0, 10), timeRecordId: r.timeRecordId ?? null,
      detail: r.detail ?? null, severity: String(r.severity ?? "amber"), status: String(r.status ?? "open"),
      reviewedById: r.reviewedById ?? null, reviewedAt: str(r.reviewedAt), reviewNote: r.reviewNote ?? null, createdAt: str(r.createdAt),
    };
  }
}
