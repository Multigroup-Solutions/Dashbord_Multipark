/**
 * Caixa, fase 2 (detetar) — varredura (cron `cash-sweep`, de 10 em 10 min,
 * e `cash-close`, diário para as saídas de ontem e anteontem).
 *
 * Por cada reserva a ver (server/multiparkDb/cashSweep.ts): lê o dinheiro AO
 * VIVO, guarda um retrato se o estado mudou (`cash_live_snapshots`, só
 * acréscimo), junta o "era" (memória do webhook + retratos) e corre as regras
 * (server/cashCheck/sweepRules.ts). Os casos da "Correção de caixa" abrem,
 * atualizam, reabrem ou resolvem-se sozinhos (server/cashCheck/cases.ts), com
 * tudo registado em `cash_case_events`. Nunca escreve na Multipark.
 *
 * Também: R15 (reserva que tínhamos e desapareceu), R26 (permissões de
 * dinheiro dos agentes, 1× por dia) e R27 (parque com movimento sem webhooks).
 */
import { sql } from "drizzle-orm";
import type { LiveFinance } from "./cashCheck/rules";
import type { SweepExtras } from "./multiparkDb/cashSweep";
import {
  agentPermsFinding, ALERT_CODES, evaluateSweep, missingFinding, parkSilentFinding, snapFromLive, stateHash, SWEEP_LABELS,
  type Finding, type SweepCode, type SweepSnap,
} from "./cashCheck/sweepRules";
import { actionNote, planCaseActions, type CaseAction, type ExistingCase } from "./cashCheck/cases";

type Db = { execute: (q: any) => Promise<any> };
const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const inList = (xs: readonly (string | number)[]) => sql.join(xs.map((x) => sql`${x}`), sql`, `);
export const utc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const toDb = (iso: string | null | undefined) => (iso ? utc(Date.parse(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`)) : null);
const lisbonDay = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`) : NaN;
  return Number.isFinite(t) ? new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon" }).format(new Date(t)) : null;
};

export const SWEEP_CHUNK = 400;
export const SWEEP_OVERLAP_MS = 5 * 60_000;
export const SWEEP_FIRST_WINDOW_MS = 30 * 60_000;
export const PARK_SILENT_HOURS = 3;
export const PARK_SILENT_MIN_MOVES = 3;
/** Códigos avaliados para uma reserva encontrada (todos menos os de agente/parque). */
const BOOKING_CODES = new Set(Object.keys(SWEEP_LABELS).filter((c) => c !== "agent_perms_changed" && c !== "park_webhook_silent" && c !== "count_mismatch"));

export async function database(): Promise<Db> {
  const { getDb } = await import("./db");
  const d = await getDb();
  if (!d) throw new Error("BD indisponível");
  return d as unknown as Db;
}

async function getState(d: Db, key: string): Promise<string | null> {
  return rowsOf(await d.execute(sql`SELECT value FROM cash_sweep_state WHERE \`key\` = ${key}`))[0]?.value ?? null;
}
async function setState(d: Db, key: string, value: string): Promise<void> {
  await d.execute(sql`INSERT INTO cash_sweep_state (\`key\`, value) VALUES (${key}, ${value}) ON DUPLICATE KEY UPDATE value = VALUES(value)`);
}

/** Retratos nossos (os mais recentes primeiro cortados a 30 por reserva). */
async function loadSnaps(d: Db, ids: readonly string[]): Promise<Map<string, Array<SweepSnap & { hash: string }>>> {
  const out = new Map<string, Array<SweepSnap & { hash: string }>>();
  if (!ids.length) return out;
  const rows = rowsOf(await d.execute(sql`SELECT id, bookingExternalId, hash, snapJson FROM cash_live_snapshots
    WHERE bookingExternalId IN (${inList(ids)}) ORDER BY bookingExternalId, capturedAt, id LIMIT 20000`));
  for (const r of rows) {
    let snap: SweepSnap;
    try { snap = JSON.parse(String(r.snapJson)); } catch { continue; }
    const list = out.get(String(r.bookingExternalId)) ?? [];
    list.push({ ...snap, id: -Number(r.id), hash: String(r.hash) });
    out.set(String(r.bookingExternalId), list.slice(-30));
  }
  return out;
}

export async function loadCases(d: Db, subjectType: string, ids: readonly string[]): Promise<Map<string, ExistingCase[]>> {
  const out = new Map<string, ExistingCase[]>();
  if (!ids.length) return out;
  const rows = rowsOf(await d.execute(sql`SELECT id, subjectId, code, state, detail, severity FROM cash_cases
    WHERE subjectType = ${subjectType} AND subjectId IN (${inList(ids)})`));
  for (const r of rows) {
    const list = out.get(String(r.subjectId)) ?? [];
    list.push({ id: Number(r.id), code: String(r.code), state: r.state, detail: r.detail ?? null, severity: String(r.severity) });
    out.set(String(r.subjectId), list);
  }
  return out;
}

export interface SubjectMeta { subjectType: "booking" | "agent" | "park" | "count"; subjectId: string; parkId: string | null; projectId: number | null; bookingCode: string | null; day: string | null }

export interface CaseAlert { caseId: number; meta: SubjectMeta; finding: Finding }
/** Alertas por enviar desta corrida (casos graves abertos ou reabertos). */
let pendingAlerts: CaseAlert[] = [];

/** Aplica as ações de um sujeito (casos + eventos). Devolve contagens. */
export async function applyActions(d: Db, meta: SubjectMeta, actions: readonly CaseAction[], nowDb: string): Promise<{ opened: number; reopened: number; resolved: number }> {
  let opened = 0, reopened = 0, resolved = 0;
  for (const a of actions) {
    let caseId: number;
    if (a.kind === "open") {
      const f = a.finding;
      const res: any = await d.execute(sql`INSERT INTO cash_cases (subjectType, subjectId, code, ruleRef, severity, state, label, detail, parkId, projectId, bookingCode, day, openedAt, lastSeenAt)
        VALUES (${meta.subjectType}, ${meta.subjectId}, ${f.code}, ${f.rule}, ${f.severity}, 'aberto', ${f.label}, ${f.detail}, ${meta.parkId}, ${meta.projectId}, ${meta.bookingCode}, ${meta.day}, ${nowDb}, ${nowDb})
        ON DUPLICATE KEY UPDATE lastSeenAt = VALUES(lastSeenAt)`);
      caseId = Number((Array.isArray(res) ? res[0] : res)?.insertId ?? 0);
      if (!caseId) caseId = Number(rowsOf(await d.execute(sql`SELECT id FROM cash_cases WHERE subjectType = ${meta.subjectType} AND subjectId = ${meta.subjectId} AND code = ${f.code}`))[0]?.id ?? 0);
      opened++;
    } else if (a.kind === "update") {
      caseId = a.caseId;
      await d.execute(sql`UPDATE cash_cases SET lastSeenAt = ${nowDb}, detail = ${a.finding.detail}, severity = ${a.finding.severity},
        parkId = ${meta.parkId}, projectId = ${meta.projectId}, bookingCode = ${meta.bookingCode}, day = ${meta.day} WHERE id = ${caseId}`);
      if (!a.detailChanged) continue;
    } else if (a.kind === "reopen") {
      caseId = a.caseId;
      await d.execute(sql`UPDATE cash_cases SET state = 'aberto', lastSeenAt = ${nowDb}, detail = ${a.finding.detail}, severity = ${a.finding.severity},
        resolvedAt = NULL, closedAt = NULL, reopenCount = reopenCount + 1, alertedAt = NULL WHERE id = ${caseId}`);
      reopened++;
    } else {
      caseId = a.caseId;
      await d.execute(sql`UPDATE cash_cases SET state = ${a.state}, resolvedAt = ${nowDb} WHERE id = ${caseId}`);
      resolved++;
    }
    if (caseId && (a.kind === "open" || a.kind === "reopen") && (a.finding.severity === "critical" || ALERT_CODES.has(a.finding.code as SweepCode))) {
      pendingAlerts.push({ caseId, meta, finding: a.finding });
    }
    if (caseId) {
      const e = actionNote(a);
      await d.execute(sql`INSERT INTO cash_case_events (caseId, at, userId, action, note) VALUES (${caseId}, ${nowDb}, NULL, ${e.action}, ${e.note})`);
    }
  }
  return { opened, reopened, resolved };
}

export interface SweepReport { mode: string; bookings: number; snapshots: number; missing: number; opened: number; reopened: number; resolved: number; partial: boolean; parksSilent?: number; agents?: number; alerts?: number; digests?: number }

/**
 * Processa reservas já lidas ao vivo (e as que desapareceram). Usado pela
 * varredura por janela e pelo fecho do dia.
 */
async function processBookings(d: Db, o: {
  live: readonly LiveFinance[]; missingIds: readonly string[]; ourParks: Map<string, number | null>; nowMs: number;
}): Promise<Omit<SweepReport, "mode" | "partial">> {
  const nowIso = new Date(o.nowMs).toISOString();
  const nowDb = utc(o.nowMs);
  const ids = [...o.live.map((l) => l.id), ...o.missingIds];
  const [{ readSweepExtras }, { listMemoryForBookings }] = await Promise.all([import("./multiparkDb/cashSweep"), import("./webhookMemory")]);
  const [extrasMap, memory, snaps] = await Promise.all([
    o.live.length ? readSweepExtras(o.live.map((l) => l.id)) : Promise.resolve(new Map<string, SweepExtras>()),
    listMemoryForBookings(ids).catch(() => new Map()),
    loadSnaps(d, ids),
  ]);
  const cases = await loadCases(d, "booking", ids);
  const rep = { bookings: 0, snapshots: 0, missing: 0, opened: 0, reopened: 0, resolved: 0 };
  for (const live of o.live) {
    rep.bookings++;
    const extras = extrasMap.get(live.id) ?? null;
    const mine = snaps.get(live.id) ?? [];
    const hash = stateHash(live, extras);
    const era: SweepSnap[] = [...(memory.get(live.id) ?? []), ...mine];
    if (mine[mine.length - 1]?.hash !== hash) {
      const snap = snapFromLive(live, extras, nowIso);
      await d.execute(sql`INSERT INTO cash_live_snapshots (bookingExternalId, parkId, status, checkOut, hash, snapJson, capturedAt)
        VALUES (${live.id}, ${live.parkId}, ${live.status}, ${toDb(live.checkOut)}, ${hash}, ${JSON.stringify(snap)}, ${nowDb})`);
      rep.snapshots++;
    }
    const findings = evaluateSweep({ live, extras, era, nowIso });
    const meta: SubjectMeta = {
      subjectType: "booking", subjectId: live.id, parkId: live.parkId, projectId: live.parkId ? o.ourParks.get(live.parkId) ?? null : null,
      bookingCode: live.code, day: lisbonDay(live.checkOut),
    };
    const r = await applyActions(d, meta, planCaseActions(cases.get(live.id) ?? [], findings, BOOKING_CODES), nowDb);
    rep.opened += r.opened; rep.reopened += r.reopened; rep.resolved += r.resolved;
  }
  for (const id of o.missingIds) {
    const last = (snaps.get(id) ?? []).slice(-1)[0];
    if (!last) continue;
    rep.missing++;
    const meta: SubjectMeta = {
      subjectType: "booking", subjectId: id, parkId: last.parkId, projectId: last.parkId ? o.ourParks.get(last.parkId) ?? null : null,
      bookingCode: null, day: lisbonDay(last.checkOut),
    };
    const r = await applyActions(d, meta, planCaseActions(cases.get(id) ?? [], [missingFinding(last)], new Set(["missing"])), nowDb);
    rep.opened += r.opened; rep.reopened += r.reopened; rep.resolved += r.resolved;
  }
  return rep;
}

export const ALERTS_PER_RUN = 25;

/** Envia os alertas pendentes (1 por caso — `alertedAt`), no máximo ALERTS_PER_RUN. */
export async function flushCaseAlerts(d: Db, nowDb: string): Promise<number> {
  const list = pendingAlerts.splice(0, pendingAlerts.length);
  if (!list.length) return 0;
  const { notify } = await import("./notify");
  let sent = 0;
  for (const a of list.slice(0, ALERTS_PER_RUN)) {
    try {
      const subject = a.meta.subjectType === "booking" ? `reserva ${a.meta.bookingCode ?? a.meta.subjectId}` : a.meta.subjectType === "count" ? "contagem da caixa" : a.meta.subjectType;
      await notify({
        kind: "cash_case_alert", projectId: a.meta.projectId,
        title: `Caixa: ${a.finding.label} (${subject})`, body: a.finding.detail.slice(0, 500),
        link: `/faturacao?tab=cash-check&case=${a.caseId}`, entity: { type: "cash_case", id: a.caseId },
      });
      await d.execute(sql`UPDATE cash_cases SET alertedAt = ${nowDb} WHERE id = ${a.caseId}`);
      sent++;
    } catch (err) {
      console.warn("[cash-sweep] alerta:", (err as Error)?.message);
    }
  }
  return sent;
}

/** Resumo diário: casos por explicar, por centro (cidade). */
export async function sendDailyDigest(d: Db): Promise<number> {
  const rows = rowsOf(await d.execute(sql`SELECT projectId, COUNT(*) AS n,
      SUM(severity = 'critical') AS crit, SUM(severity = 'high') AS high
    FROM cash_cases WHERE state IN ('aberto', 'em_analise') GROUP BY projectId`));
  if (!rows.length) return 0;
  const { notify } = await import("./notify");
  let sent = 0;
  for (const r of rows) {
    const n = Number(r.n), crit = Number(r.crit ?? 0), high = Number(r.high ?? 0);
    try {
      await notify({
        kind: "cash_daily_digest", projectId: r.projectId == null ? null : Number(r.projectId),
        title: `Caixa: ${n} caso(s) por explicar`, body: `${crit} crítico(s), ${high} grave(s). Faturação → Correção de caixa.`,
        link: "/faturacao?tab=cash-check", entity: { type: "cash_digest", id: `${r.projectId ?? "all"}` },
      });
      sent++;
    } catch (err) {
      console.warn("[cash-close] resumo:", (err as Error)?.message);
    }
  }
  return sent;
}

/** Lê ao vivo em blocos, respeitando o prazo; devolve o que leu e o que faltou/desapareceu. */
async function readChunks(ids: readonly string[], deadlineAt: number) {
  const { readLiveFinanceByIds } = await import("./multiparkDb/cashCheck");
  const live: LiveFinance[] = [];
  const missing: string[] = [];
  let partial = false;
  for (let i = 0; i < ids.length; i += SWEEP_CHUNK) {
    if (Date.now() > deadlineAt - 8_000) { partial = true; break; }
    const chunk = ids.slice(i, i + SWEEP_CHUNK);
    const got = await readLiveFinanceByIds(chunk, undefined);
    const found = new Set(got.map((g) => g.id));
    live.push(...got);
    missing.push(...chunk.filter((x) => !found.has(x)));
  }
  return { live, missing, partial };
}

/** Varredura de 10 em 10 min: alteradas desde a última + ativas + saídas de 48 h + casos abertos. */
export async function runCashSweep(o: { deadlineAt: number; nowMs?: number }): Promise<SweepReport> {
  const nowMs = o.nowMs ?? Date.now();
  pendingAlerts = [];
  const d = await database();
  const [{ loadLiveContext }, { readSweepIds }] = await Promise.all([import("./finance/liveBookings"), import("./multiparkDb/cashSweep")]);
  const ctx = await loadLiveContext();
  const parkIds = [...ctx.ourParks.keys()];
  const last = await getState(d, "sweep_at");
  const sinceMs = last ? Date.parse(`${last.replace(" ", "T")}Z`) - SWEEP_OVERLAP_MS : nowMs - SWEEP_FIRST_WINDOW_MS;
  const found = await readSweepIds({ parkIds, since: utc(sinceMs), now: utc(nowMs) });
  // Casos de reserva abertos (para se resolverem sozinhos) e retratos das últimas 48 h (para R15).
  const openIds = rowsOf(await d.execute(sql`SELECT DISTINCT subjectId FROM cash_cases WHERE subjectType = 'booking' AND state IN ('aberto', 'em_analise') LIMIT 1000`)).map((r) => String(r.subjectId));
  const recentIds = rowsOf(await d.execute(sql`SELECT DISTINCT bookingExternalId AS id FROM cash_live_snapshots WHERE capturedAt >= ${utc(nowMs - 48 * 3_600_000)} LIMIT 3000`)).map((r) => String(r.id));
  const ids = [...new Set([...found.map((f) => f.id), ...openIds, ...recentIds])];
  const read = await readChunks(ids, o.deadlineAt);
  const rep = await processBookings(d, { live: read.live, missingIds: read.missing, ourParks: ctx.ourParks, nowMs });
  const report: SweepReport = { mode: "janela", ...rep, partial: read.partial };
  if (!read.partial) await setState(d, "sweep_at", utc(nowMs));
  // R27 — parques nossos com movimento e sem webhooks (horas de operação).
  try { report.parksSilent = await checkParksSilent(d, ctx, nowMs); } catch (err) { console.warn("[cash-sweep] R27:", (err as Error)?.message); }
  // R26 — permissões dos agentes, 1× por dia.
  try { report.agents = await maybeSnapshotAgents(d, ctx, nowMs); } catch (err) { console.warn("[cash-sweep] R26:", (err as Error)?.message); }
  report.alerts = await flushCaseAlerts(d, utc(nowMs));
  return report;
}

/** Fecho do dia (D-1 e D-2): todas as saídas desses dias nos parques nossos. */
export async function runCashClose(o: { deadlineAt: number; nowMs?: number; days?: string[] }): Promise<SweepReport> {
  const nowMs = o.nowMs ?? Date.now();
  pendingAlerts = [];
  const d = await database();
  const [{ loadLiveContext }, { lisbonDayBounds }, { readLiveCheckoutPage }] = await Promise.all([
    import("./finance/liveBookings"), import("./multiparkDb/dayBookings"), import("./multiparkDb/cashCheck"),
  ]);
  const ctx = await loadLiveContext();
  const parkIds = [...ctx.ourParks.keys()];
  const today = lisbonDay(new Date(nowMs).toISOString())!;
  const days = o.days ?? [1, 2].map((k) => lisbonDay(new Date(Date.parse(`${today}T12:00:00Z`) - k * 86_400_000).toISOString())!);
  const live: LiveFinance[] = [];
  let partial = false;
  for (const day of days) {
    let cursor: string | null = null;
    do {
      if (Date.now() > o.deadlineAt - 10_000) { partial = true; break; }
      const page: { rows: LiveFinance[]; nextCursor: string | null } = await readLiveCheckoutPage(lisbonDayBounds(day), parkIds, cursor, 200, undefined);
      live.push(...page.rows);
      cursor = page.nextCursor;
    } while (cursor);
  }
  const rep = await processBookings(d, { live, missingIds: [], ourParks: ctx.ourParks, nowMs });
  if (!partial) await setState(d, "close_at", `${days.join(",")}`.slice(0, 64));
  const alerts = await flushCaseAlerts(d, utc(nowMs));
  const digests = await sendDailyDigest(d).catch(() => 0);
  return { mode: `fecho ${days.join(" e ")}`, ...rep, partial, alerts, digests };
}

async function checkParksSilent(d: Db, ctx: { ourParks: Map<string, number | null>; parkInfo?: Map<string, { name: string; city: string | null }> }, nowMs: number): Promise<number> {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Lisbon", hour: "2-digit", hourCycle: "h23" }).format(new Date(nowMs)));
  if (hour < 8 || hour >= 22) return 0;
  const { readParkMovement } = await import("./multiparkDb/cashSweep");
  const since = utc(nowMs - PARK_SILENT_HOURS * 3_600_000);
  const parkIds = [...ctx.ourParks.keys()];
  const moved = await readParkMovement({ parkIds, since });
  const got = new Map(rowsOf(await d.execute(sql`SELECT parkId, COUNT(*) AS n FROM multipark_webhook_snapshots WHERE receivedAt >= ${since} GROUP BY parkId`))
    .map((r) => [String(r.parkId), Number(r.n)]));
  const cases = await loadCases(d, "park", parkIds);
  let silent = 0;
  const nowDb = utc(nowMs);
  for (const parkId of parkIds) {
    const m = moved.get(parkId) ?? 0;
    const findings: Finding[] = m >= PARK_SILENT_MIN_MOVES && !(got.get(parkId) ?? 0)
      ? [parkSilentFinding({ parkName: ctx.parkInfo?.get(parkId)?.name ?? null, moved: m, hours: PARK_SILENT_HOURS })] : [];
    silent += findings.length;
    await applyActions(d, { subjectType: "park", subjectId: parkId, parkId, projectId: ctx.ourParks.get(parkId) ?? null, bookingCode: null, day: null },
      planCaseActions(cases.get(parkId) ?? [], findings, new Set(["park_webhook_silent"])), nowDb);
  }
  return silent;
}

async function maybeSnapshotAgents(d: Db, ctx: { ourParks: Map<string, number | null> }, nowMs: number): Promise<number> {
  const last = await getState(d, "agents_at");
  if (last && nowMs - Date.parse(`${last.replace(" ", "T")}Z`) < 20 * 3_600_000) return 0;
  const { readAgentPerms } = await import("./multiparkDb/cashSweep");
  const { createHash } = await import("node:crypto");
  const agents = await readAgentPerms([...ctx.ourParks.keys()]);
  const prev = new Map(rowsOf(await d.execute(sql`SELECT p.agentId, p.hash, p.permsJson FROM cash_agent_perms p
    JOIN (SELECT agentId, MAX(id) AS id FROM cash_agent_perms GROUP BY agentId) m ON m.id = p.id`)).map((r) => [String(r.agentId), r]));
  const cases = await loadCases(d, "agent", agents.map((a) => a.agentId));
  const nowDb = utc(nowMs);
  let changed = 0;
  for (const a of agents) {
    const permsJson = JSON.stringify(a.perms);
    const hash = createHash("sha1").update(`${a.role}|${a.parkId}|${permsJson}`).digest("hex");
    const p = prev.get(a.agentId);
    if (p && String(p.hash) === hash) continue;
    await d.execute(sql`INSERT INTO cash_agent_perms (agentId, parkId, name, role, permsJson, hash, capturedAt) VALUES (${a.agentId}, ${a.parkId}, ${a.name}, ${a.role}, ${permsJson}, ${hash}, ${nowDb})`);
    if (!p) continue; // primeiro retrato: sem "antes"
    let before: string[] = [];
    try { before = JSON.parse(String(p.permsJson)); } catch { before = []; }
    const f = agentPermsFinding({ name: a.name, before, after: a.perms });
    if (!f) continue;
    changed++;
    await applyActions(d, { subjectType: "agent", subjectId: a.agentId, parkId: a.parkId, projectId: a.parkId ? ctx.ourParks.get(a.parkId) ?? null : null, bookingCode: null, day: null },
      planCaseActions(cases.get(a.agentId) ?? [], [f], new Set()), nowDb);
  }
  await setState(d, "agents_at", nowDb);
  return changed;
}
