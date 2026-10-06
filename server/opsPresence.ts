/**
 * Alertas "a trabalhar sem PDA ou Zello ligado" (passo 4, regras em
 * shared/opsPresence.ts). Corre de 5 em 5 minutos (cron `ops-presence`):
 *
 *  1. lê quem tem o ponto aberto, quem tem PDA na mão, o Zello ao vivo e os
 *     movimentos da Multipark dos últimos 15 min (ao vivo, só leitura);
 *  2. abre / mantém / fecha os alertas em `ops_presence_alerts` (sempre — a
 *     lista aparece em Operacional → PDAs mesmo com os avisos desligados);
 *  3. OPS_PRESENCE_ALERTS: avisa no sino o team leader escalado na cidade, os
 *     team leaders com ponto aberto na cidade e o supervisor;
 *  4. OPS_PRESENCE_WHATSAPP: sem ligação nem "Visto" passados N minutos,
 *     WhatsApp (modelo aprovado) aos administradores da cidade + cópia.
 *
 * Nunca lança para fora: o Zello ou a Multipark em baixo só desligam a parte
 * que depende deles.
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import {
  MOVEMENT_CHANGE_TYPES, MOVEMENT_LOOKBACK_MINUTES, PRESENCE_KINDS, PRESENCE_KIND_LABELS,
  clockIsOpen, diffPresenceAlerts, dueForEscalation, evaluatePresence, isOperationalPosition, presenceOneLine, presenceRecipients,
  type OpenPresenceAlert, type PresenceKind, type PresenceMovement, type PresencePerson, type ZelloStatus,
} from "../shared/opsPresence";
import { NOTIFY_CITY_LABELS, notifyCityOf, type NotifyCity } from "../shared/notificationRouting";
import { presenceFichaId } from "../shared/appSettings";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};

/** Timestamp da BD (UTC) → ms. */
export function dbMs(v: unknown): number | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  const s = String(v).trim();
  if (!s) return null;
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(" ", "T") : `${s.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** ms → "YYYY-MM-DD HH:MM:SS" UTC. */
export function utcStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

interface PersonRow extends PresencePerson { userIds: number[] }

async function loadPeople(db: any): Promise<PersonRow[]> {
  const rows = rowsOf(await db.execute(sql`
    SELECT e.id, e.fullName, e.position, e.zelloUsername, e.userId,
      (SELECT t.type FROM time_records t WHERE t.employeeId = e.id ORDER BY t.recordedAt DESC, t.id DESC LIMIT 1) AS lastType,
      (SELECT t.recordedAt FROM time_records t WHERE t.employeeId = e.id ORDER BY t.recordedAt DESC, t.id DESC LIMIT 1) AS lastAt
    FROM employees e WHERE e.isActive = 1`));
  const pdaRows = rowsOf(await db.execute(sql`
    SELECT c.employeeId, p.name AS pdaName, COALESCE(NULLIF(p.zelloUsername, ''), NULLIF(c.zelloUsername, '')) AS zello
    FROM pda_checkins c JOIN pdas p ON p.id = c.pdaId
    WHERE c.checkin_status = 'checked_in' AND c.employeeId IS NOT NULL
    ORDER BY c.checkinAt DESC`));
  const accountRows = rowsOf(await db.execute(sql`SELECT employeeId, userId FROM employee_accounts`).catch(() => [[]]));

  const pdaBy = new Map<number, { pdaName: string; zello: string | null }>();
  for (const r of pdaRows) {
    const id = Number(r.employeeId);
    if (!pdaBy.has(id)) pdaBy.set(id, { pdaName: String(r.pdaName ?? "PDA"), zello: r.zello ? String(r.zello) : null });
  }
  const accountsBy = new Map<number, number[]>();
  for (const r of accountRows) {
    const id = Number(r.employeeId);
    if (!accountsBy.has(id)) accountsBy.set(id, []);
    accountsBy.get(id)!.push(Number(r.userId));
  }

  const { resolveCitiesForEmployeeIds } = await import("./employeeCity");
  const cities = await resolveCitiesForEmployeeIds(rows.map((r) => Number(r.id))).catch(() => new Map());
  const { loadZelloGpsExclusions } = await import("./zello");
  const { isZelloGpsExcluded } = await import("../shared/appSettings");
  const excluded = await loadZelloGpsExclusions();

  return rows.map((r) => {
    const id = Number(r.id);
    const pda = pdaBy.get(id) ?? null;
    const zello = pda?.zello ?? (r.zelloUsername ? String(r.zelloUsername) : null);
    const city = notifyCityOf((cities.get(id) as any)?.city ?? null);
    return {
      employeeId: id,
      name: String(r.fullName ?? `Ficha ${id}`),
      position: r.position ? String(r.position) : null,
      city,
      clockOpenSince: String(r.lastType ?? "") === "check_in" ? dbMs(r.lastAt) : null,
      pdaName: pda?.pdaName ?? null,
      zelloUsername: zello,
      zelloExcluded: zello ? isZelloGpsExcluded(zello, excluded) : false,
      userIds: Array.from(new Set([r.userId == null ? null : Number(r.userId), ...(accountsBy.get(id) ?? [])].filter((x): x is number => typeof x === "number" && x > 0))),
    };
  });
}

/** Zello ao vivo; `null` = não configurado ou em baixo. */
async function loadZello(): Promise<Map<string, ZelloStatus> | null> {
  try {
    const { getZelloLocations, isZelloConfigured } = await import("./zello");
    if (!isZelloConfigured()) return null;
    const list = await getZelloLocations();
    return new Map(list.map((l) => [String(l.username).trim().toLowerCase(), { username: l.username, status: l.status, lastReportDelay: l.lastReportDelay }]));
  } catch (err: any) {
    console.warn("[ops-presence] Zello indisponível:", String(err?.message ?? err).slice(0, 160));
    return null;
  }
}

/** Movimentos da Multipark (ao vivo) feitos por pessoas com ficha; `null` = BD em baixo. */
async function loadMovements(db: any, now: number, people: readonly PersonRow[]): Promise<PresenceMovement[] | null> {
  try {
    const { isMultiparkDbConfigured } = await import("./multiparkDb/client");
    if (!isMultiparkDbConfigured()) return null;
    const { readLiveHistory } = await import("./multiparkDb/historyLive");
    const rows = await readLiveHistory({
      from: utcStamp(now - MOVEMENT_LOOKBACK_MINUTES * 60_000),
      changeTypes: [...MOVEMENT_CHANGE_TYPES],
      limit: 1000,
      order: "desc",
    });
    if (!rows.length) return [];
    const agentBy = new Map<string, number>();
    const primary = rowsOf(await db.execute(sql`SELECT id, multiparkAgentUserId FROM employees WHERE isActive = 1 AND multiparkAgentUserId IS NOT NULL AND multiparkAgentUserId <> ''`));
    for (const r of primary) agentBy.set(String(r.multiparkAgentUserId), Number(r.id));
    const { listAgentAliases } = await import("./employeeAliases");
    for (const a of await listAgentAliases().catch(() => [])) if (!agentBy.has(a.agentUserId)) agentBy.set(a.agentUserId, a.employeeId);
    const known = new Set(people.map((p) => p.employeeId));
    const out: PresenceMovement[] = [];
    for (const r of rows) {
      const emp = r.agentUserId ? agentBy.get(r.agentUserId) : undefined;
      const at = dbMs(r.actionTime);
      if (emp == null || !known.has(emp) || at == null) continue;
      out.push({ employeeId: emp, changeType: String(r.changeType ?? ""), at, bookingCode: r.bookingCode, plate: r.licensePlate });
    }
    return out;
  } catch (err: any) {
    console.warn("[ops-presence] Multipark indisponível:", String(err?.message ?? err).slice(0, 160));
    return null;
  }
}

async function loadOpenAlerts(db: any): Promise<(OpenPresenceAlert & { city: string | null; detail: string | null; notifiedAt: number | null; escalatedAt: number | null; acknowledgedAt: number | null })[]> {
  const rows = rowsOf(await db.execute(sql`
    SELECT id, employeeId, kind, city, detail, openedAt, notifiedAt, escalatedAt, acknowledgedAt
    FROM ops_presence_alerts WHERE resolvedAt IS NULL`));
  return rows
    .filter((r) => (PRESENCE_KINDS as readonly string[]).includes(String(r.kind)))
    .map((r) => ({
      id: Number(r.id), employeeId: Number(r.employeeId), kind: String(r.kind) as PresenceKind,
      openedAt: dbMs(r.openedAt) ?? Date.now(), city: r.city ? String(r.city) : null, detail: r.detail ? String(r.detail) : null,
      notifiedAt: dbMs(r.notifiedAt), escalatedAt: dbMs(r.escalatedAt), acknowledgedAt: dbMs(r.acknowledgedAt),
    }));
}

/** userIds a avisar numa cidade (TL escalado + TL com ponto aberto + supervisor). */
async function recipientsForCity(db: any, city: NotifyCity | null, now: number, people: readonly PersonRow[], selfUserIds: number[]): Promise<number[]> {
  if (!city) return [];
  const { operationalShift } = await import("../shared/shiftHandover");
  const { date, shift } = operationalShift(now);
  const scheduled = rowsOf(await db.execute(sql`
    SELECT DISTINCT employeeId FROM extras_dia_assignments
    WHERE assignmentDate = ${date} AND shift = ${shift} AND city = ${city} AND isTeamLeader = 1 AND employeeId IS NOT NULL`).catch(() => [[]]))
    .map((r) => Number(r.employeeId));
  const byEmp = new Map(people.map((p) => [p.employeeId, p]));
  const scheduledUsers = scheduled.flatMap((id) => byEmp.get(id)?.userIds ?? []);

  const { loadCandidatesFromDb } = await import("./notify");
  const candidates = await loadCandidatesFromDb().catch(() => []);
  const roleBy = new Map(candidates.map((c) => [c.id, c.role]));
  const clockedTl = people
    .filter((p) => p.city === city && clockIsOpen(p.clockOpenSince, now))
    .flatMap((p) => p.userIds)
    .filter((u) => roleBy.get(u) === "team_leader");
  const supervisors = candidates
    .filter((c) => c.role === "supervisor" && !c.personalOnly && (c.cities === "all" || c.cities.includes(city)))
    .map((c) => c.id);
  return presenceRecipients({ scheduledTeamLeaders: scheduledUsers, clockedTeamLeaders: clockedTl, supervisors }, selfUserIds);
}

async function flags(): Promise<{ alerts: boolean; whatsapp: boolean }> {
  const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([import("./_core/featureFlags"), import("../shared/appSettings")]);
  await ensureFeatureFlagOverrides();
  const on = (n: string) => isFeatureEnabled(n, { defaultEnabled: automationFlagDefault(n) });
  const alerts = on("OPS_PRESENCE_ALERTS");
  return { alerts, whatsapp: alerts && on("OPS_PRESENCE_WHATSAPP") };
}

export interface PresenceRunResult {
  people: number;
  zello: boolean;
  multipark: boolean;
  opened: number;
  resolved: number;
  notified: number;
  escalated: number;
}

export async function runOpsPresence(opts: { now?: number } = {}): Promise<PresenceRunResult> {
  const now = opts.now ?? Date.now();
  const out: PresenceRunResult = { people: 0, zello: false, multipark: false, opened: 0, resolved: 0, notified: 0, escalated: 0 };
  const db = await getDb();
  if (!db) return out;

  const people = await loadPeople(db);
  out.people = people.filter((p) => isOperationalPosition(p.position) && clockIsOpen(p.clockOpenSince, now)).length;
  const [locations, movements] = await Promise.all([loadZello(), loadMovements(db, now, people)]);
  out.zello = locations != null;
  out.multipark = movements != null;

  const problems = evaluatePresence({ now, people, movements: movements ?? [], locations });
  const open = await loadOpenAlerts(db);
  const diff = diffPresenceAlerts({ now, open, problems, people, locations });

  for (const p of diff.toOpen) {
    await db.execute(sql`INSERT INTO ops_presence_alerts (employeeId, kind, city, detail, openedAt, lastSeenAt)
      VALUES (${p.employeeId}, ${p.kind}, ${p.city}, ${p.detail.slice(0, 500)}, ${utcStamp(now)}, ${utcStamp(now)})`);
    out.opened++;
  }
  if (diff.toTouch.length) {
    await db.execute(sql`UPDATE ops_presence_alerts SET lastSeenAt = ${utcStamp(now)} WHERE id IN (${sql.join(diff.toTouch.map((id) => sql`${id}`), sql`, `)})`);
  }
  for (const r of diff.toResolve) {
    await db.execute(sql`UPDATE ops_presence_alerts SET resolvedAt = ${utcStamp(now)}, resolution = ${r.resolution} WHERE id = ${r.id} AND resolvedAt IS NULL`);
    out.resolved++;
  }

  const f = await flags().catch(() => ({ alerts: false, whatsapp: false }));
  if (!f.alerts) return out;

  const personBy = new Map(people.map((p) => [p.employeeId, p]));
  const still = await loadOpenAlerts(db);
  const { notify } = await import("./notify");
  const recipientsCache = new Map<string, number[]>();

  // Aviso no sino (uma vez por alerta).
  for (const a of still.filter((x) => x.notifiedAt == null)) {
    const p = personBy.get(a.employeeId);
    const city = notifyCityOf(a.city);
    const key = `${city ?? "-"}:${a.employeeId}`;
    if (!recipientsCache.has(key)) recipientsCache.set(key, await recipientsForCity(db, city, now, people, p?.userIds ?? []));
    const targets = recipientsCache.get(key)!;
    const r = await notify({
      kind: "ops_presence", city, targetUserIds: targets,
      title: `${PRESENCE_KIND_LABELS[a.kind]}: ${p?.name ?? `ficha ${a.employeeId}`}`,
      body: `${a.detail ?? ""}\nLiga o PDA/Zello da pessoa ou carrega em "Visto" em Operacional → PDAs. Sem resposta, passa ao WhatsApp dos administradores.`,
      link: "/operacional?tab=pdas",
      entity: { type: "ops_presence", id: a.id },
    });
    await db.execute(sql`UPDATE ops_presence_alerts SET notifiedAt = ${utcStamp(now)} WHERE id = ${a.id}`);
    if (r.recipients.length) out.notified++;
  }

  if (!f.whatsapp) return out;
  const { getSetting } = await import("./appSettings");
  const minutes = Number((await getSetting("ops.presenceEscalateMinutes").catch(() => null)) ?? 10) || 10;
  const phones = ((await getSetting("ops.presencePhones").catch(() => null)) ?? { lisbon: [], porto: [], faro: [], copy: [] }) as Record<string, string[]>;
  const tpl = String((await getSetting("ops.presenceTemplate").catch(() => null)) ?? "alerta_operacional|pt_PT");
  const [tplName, tplLang] = tpl.split("|");
  const { normalizePhoneE164 } = await import("../shared/phone");
  const { sendTemplateMessage } = await import("./whatsapp");
  // 38a: as pessoas escolhidas do RH ("ficha:<id>") → telefone da ficha (o de trabalho, senão o pessoal)
  const fichaIds = [...new Set(Object.values(phones).flat().map((x) => presenceFichaId(String(x))).filter((x): x is number => x != null))];
  const fichaPhones = new Map<number, string | null>();
  if (fichaIds.length) {
    for (const r of rowsOf(await db.execute(sql`SELECT id, isActive, noAutoWhatsapp, COALESCE(NULLIF(phone, ''), NULLIF(personalPhone, '')) AS phone
        FROM employees WHERE id IN (${sql.join(fichaIds.map((id) => sql`${id}`), sql`, `)})`).catch(() => [[]]))) {
      fichaPhones.set(Number(r.id), Number(r.isActive) === 1 && Number(r.noAutoWhatsapp) !== 1 && r.phone ? String(r.phone) : null);
    }
  }

  for (const a of still) {
    if (a.notifiedAt == null) continue; // ainda não foi ao sino → espera pela próxima volta
    if (!dueForEscalation({ openedAt: a.notifiedAt, acknowledgedAt: a.acknowledgedAt, escalatedAt: a.escalatedAt, resolvedAt: null }, now, minutes)) continue;
    const city = notifyCityOf(a.city);
    const { phones: list, missing } = resolvePresenceRecipients([...(city ? phones[city] ?? [] : []), ...(phones.copy ?? [])], fichaPhones, normalizePhoneE164);
    const p = personBy.get(a.employeeId);
    const cityLabel = city ? NOTIFY_CITY_LABELS[city] : "sem cidade";
    const line = presenceOneLine(a.kind, p?.name ?? `ficha ${a.employeeId}`, null, `${a.detail ?? ""} Sem resposta do team leader há ${minutes} min.`);
    let ok = 0;
    let lastErr = "";
    for (const to of list) {
      const r = await sendTemplateMessage(to, tplName, tplLang || "pt_PT", [{ type: "body", parameters: [{ type: "text", text: cityLabel }, { type: "text", text: line }] }]).catch((e: any) => ({ ok: false as const, error: String(e?.message ?? e) }));
      if (r.ok) ok++; else lastErr = String((r as any).error ?? "").slice(0, 120);
    }
    const noPhone = missing.length ? ` · ${missing.length} pessoa(s) do RH sem envio (sem telefone na ficha, inativa ou "Não enviar")` : "";
    const result = (list.length ? `WhatsApp: ${ok}/${list.length}${lastErr ? ` (${lastErr})` : ""}` : "WhatsApp: sem números em Definições") + noPhone;
    await db.execute(sql`UPDATE ops_presence_alerts SET escalatedAt = ${utcStamp(now)}, escalationResult = ${result.slice(0, 255)} WHERE id = ${a.id}`);
    if (ok) out.escalated++;
  }
  return out;
}

/**
 * 38a: quem recebe o WhatsApp dos alertas. Cada entrada é um telefone ou
 * "ficha:<id>" (o telefone vem da ficha; inativa, sem telefone ou com "Não
 * enviar" → não recebe e conta em `missing`). Sem repetidos. PURA.
 */
export function resolvePresenceRecipients(
  entries: readonly string[],
  fichaPhones: ReadonlyMap<number, string | null>,
  normalize: (raw: string) => string | null,
): { phones: string[]; missing: number[] } {
  const phones = new Set<string>();
  const missing = new Set<number>();
  for (const raw of entries) {
    const id = presenceFichaId(String(raw));
    const tel = id != null ? fichaPhones.get(id) ?? null : String(raw);
    const e164 = tel ? normalize(tel) : null;
    if (e164) phones.add(e164);
    else if (id != null) missing.add(id);
  }
  return { phones: [...phones], missing: [...missing] };
}

export interface PresenceAlertView {
  id: number;
  employeeId: number;
  name: string;
  kind: PresenceKind;
  kindLabel: string;
  city: string | null;
  detail: string | null;
  openedAt: string | null;
  notifiedAt: string | null;
  escalatedAt: string | null;
  escalationResult: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  ackNote: string | null;
  resolvedAt: string | null;
  resolution: string | null;
}

/** Abertos + fechados nas últimas `hours` horas, no âmbito de cidade do pedido. */
export async function listPresenceAlerts(hours = 24): Promise<PresenceAlertView[]> {
  const db = await getDb();
  if (!db) return [];
  const { employeeScope } = await import("./cityScope");
  const since = utcStamp(Date.now() - Math.max(1, Math.min(168, hours)) * 3_600_000);
  const rows = rowsOf(await db.execute(sql`
    SELECT a.*, e.fullName, u.name AS ackName
    FROM ops_presence_alerts a
    LEFT JOIN employees e ON e.id = a.employeeId
    LEFT JOIN users u ON u.id = a.acknowledgedById
    WHERE (a.resolvedAt IS NULL OR a.resolvedAt >= ${since}) AND ${employeeScope(sql`a.employeeId`)}
    ORDER BY (a.resolvedAt IS NULL) DESC, a.openedAt DESC
    LIMIT 300`));
  const iso = (v: unknown) => { const ms = dbMs(v); return ms == null ? null : new Date(ms).toISOString(); };
  return rows.map((r) => ({
    id: Number(r.id), employeeId: Number(r.employeeId), name: String(r.fullName ?? `Ficha ${r.employeeId}`),
    kind: String(r.kind) as PresenceKind, kindLabel: PRESENCE_KIND_LABELS[String(r.kind) as PresenceKind] ?? String(r.kind),
    city: r.city ? String(r.city) : null, detail: r.detail ? String(r.detail) : null,
    openedAt: iso(r.openedAt), notifiedAt: iso(r.notifiedAt), escalatedAt: iso(r.escalatedAt), escalationResult: r.escalationResult ? String(r.escalationResult) : null,
    acknowledgedAt: iso(r.acknowledgedAt), acknowledgedBy: r.ackName ? String(r.ackName) : null, ackNote: r.ackNote ? String(r.ackNote) : null,
    resolvedAt: iso(r.resolvedAt), resolution: r.resolution ? String(r.resolution) : null,
  }));
}

/** "Visto": o team leader tratou; não passa ao WhatsApp (o alerta fica aberto até o problema desaparecer). */
export async function acknowledgePresenceAlert(id: number, userId: number, note: string | null, received = false): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const { employeeScope } = await import("./cityScope");
  // Quem recebeu o aviso pode dar "Visto" mesmo fora do âmbito de cidade.
  const scope = received ? sql`1 = 1` : employeeScope(sql`a.employeeId`);
  const res: any = await db.execute(sql`
    UPDATE ops_presence_alerts a SET a.acknowledgedById = ${userId}, a.acknowledgedAt = ${utcStamp(Date.now())}, a.ackNote = ${note ? note.slice(0, 255) : null}
    WHERE a.id = ${id} AND a.resolvedAt IS NULL AND a.acknowledgedAt IS NULL AND ${scope}`);
  const affected = Number((Array.isArray(res) ? res[0] : res)?.affectedRows ?? 0);
  return affected > 0;
}

/** Esta pessoa recebeu no sino o aviso deste alerta? */
export async function receivedPresenceAlert(id: number, userId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const rows = rowsOf(await db.execute(sql`
    SELECT 1 FROM app_notifications WHERE userId = ${userId} AND kind = 'ops_presence' AND entityKey = ${`ops_presence:${id}`} LIMIT 1`));
  return rows.length > 0;
}
