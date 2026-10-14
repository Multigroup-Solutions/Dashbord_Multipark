/**
 * Avisos de excesso de velocidade do GPS do Zello (Jorge, 14 out 2026: "porque
 * é que os 141 não dão aviso nenhum?"). Antes só havia o "verificar agora"
 * (sem ecrã) e os alertas da API externa — a recolha diária contava pontos
 * acima de um limite que nem existia (999 km/h sem `speed_limits`) e nunca
 * avisava ninguém.
 *
 * Interruptor GPS_SPEED_ALERTS — DESLIGADO por omissão (coisas novas que
 * avisam gente entram desligadas). Com ele ligado, na recolha (provisória das
 * 23h e final de D-2), por cada pessoa e dia com excessos:
 *  - cada excesso fica em `speed_violations` (uma linha por excesso; a mesma
 *    hora de início do mesmo Zello não se repete — as duas passagens e a
 *    re-recolha não duplicam);
 *  - UM aviso no sino ("Excesso de velocidade", tipo speed_alert → team leader
 *    e supervisor da cidade da pessoa), com quantos e a máxima — só quando há
 *    excessos novos.
 * Os pontos da Avaliação NÃO dependem disto (contam pelo que a recolha grava).
 * Nunca lança.
 */
import type { SpeedExcess } from "../shared/speedRules";

export const GPS_SPEED_ALERTS_FLAG = "GPS_SPEED_ALERTS";

export interface SpeedAlertInput {
  zello: string;
  displayName: string;
  /** dia de Lisboa da recolha */
  day: string;
  limitKmh: number;
  excesses: SpeedExcess[];
  /** quem tinha o Zello nesse instante (s) — a parte do PDA, o dono ou a pessoa da linha */
  employeeAt: (tsSec: number) => number | null;
  employeeName?: (employeeId: number) => string | null;
}

export interface SpeedAlertDeps {
  flagOn(): Promise<boolean>;
  /** instantes de início ("YYYY-MM-DD HH:MM:SS" UTC) já registados para este Zello */
  existingStarts(zello: string, startsUtc: string[]): Promise<Set<string>>;
  record(row: { zelloUsername: string; displayName: string; speed: string; speedLimit: number; excessPercent: string; latitude: string | null; longitude: string | null; notificationSent: number; occurredAt: string; notes: string }): Promise<unknown>;
  notify(input: Record<string, any>): Promise<unknown>;
}

export type SpeedAlertOutcome = { outcome: "flag_off" | "none" | "already" | "notified"; recorded: number; notified: number };

const utcStamp = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 19).replace("T", " ");
const lisbonTime = (sec: number) => new Intl.DateTimeFormat("pt-PT", { timeZone: "Europe/Lisbon", hour: "2-digit", minute: "2-digit" }).format(new Date(sec * 1000));
const kmh = (v: number) => `${Math.round(v)} km/h`;

/** Núcleo (dependências injetáveis nos testes). */
export async function recordSpeedExcessesWith(deps: SpeedAlertDeps, input: SpeedAlertInput): Promise<SpeedAlertOutcome> {
  if (!input.excesses.length) return { outcome: "none", recorded: 0, notified: 0 };
  if (!(await deps.flagOn())) return { outcome: "flag_off", recorded: 0, notified: 0 };
  const starts = input.excesses.map((e) => utcStamp(e.startTs));
  const seen = await deps.existingStarts(input.zello, starts);
  const fresh = input.excesses.filter((e, i) => !seen.has(starts[i]));
  if (!fresh.length) return { outcome: "already", recorded: 0, notified: 0 };
  // por pessoa (um PDA partilhado pode ter excessos de duas pessoas no mesmo dia)
  const byPerson = new Map<string, { employeeId: number | null; list: SpeedExcess[] }>();
  let recorded = 0;
  for (const e of fresh) {
    const employeeId = input.employeeAt(e.startTs);
    const name = employeeId != null ? input.employeeName?.(employeeId) ?? null : null;
    await deps.record({
      zelloUsername: input.zello, displayName: input.displayName,
      speed: String(e.maxSpeed), speedLimit: Math.round(input.limitKmh),
      excessPercent: String(Math.min(999.99, Math.round(((e.maxSpeed - input.limitKmh) / input.limitKmh) * 10_000) / 100)),
      latitude: e.lat != null ? String(e.lat) : null, longitude: e.lon != null ? String(e.lon) : null,
      notificationSent: 1, occurredAt: utcStamp(e.startTs),
      notes: `GPS do Zello, ${input.day}: ${e.points} ponto(s) acima de ${kmh(input.limitKmh)} entre ${lisbonTime(e.startTs)} e ${lisbonTime(e.endTs)}${employeeId != null ? ` · ficha #${employeeId}${name ? ` (${name})` : ""}` : ""}`.slice(0, 500),
    });
    recorded++;
    const k = employeeId == null ? `z:${input.zello}` : `e:${employeeId}`;
    const g = byPerson.get(k) ?? { employeeId, list: [] };
    g.list.push(e);
    byPerson.set(k, g);
  }
  let notified = 0;
  for (const g of byPerson.values()) {
    const top = g.list.reduce((m, e) => (e.maxSpeed > m.maxSpeed ? e : m), g.list[0]);
    const who = (g.employeeId != null ? input.employeeName?.(g.employeeId) : null) || input.displayName || input.zello;
    await deps.notify({
      kind: "speed_alert",
      employeeId: g.employeeId,
      title: "Excesso de velocidade",
      body: `${who}: ${g.list.length} excesso(s) acima de ${kmh(input.limitKmh)} em ${input.day.split("-").reverse().join("/")} — máxima ${kmh(top.maxSpeed)} às ${lisbonTime(top.maxAt)} (GPS do Zello)`.slice(0, 500),
      link: "/operacional",
      entity: { type: "gps_speeding", id: `${input.zello}|${input.day}|${g.employeeId ?? ""}` },
    });
    notified++;
  }
  return { outcome: "notified", recorded, notified };
}

export async function recordSpeedExcesses(input: SpeedAlertInput): Promise<SpeedAlertOutcome | { outcome: "error"; recorded: 0; notified: 0 }> {
  try {
    return await recordSpeedExcessesWith({
      async flagOn() {
        const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([import("./_core/featureFlags"), import("../shared/appSettings")]);
        await ensureFeatureFlagOverrides();
        return isFeatureEnabled(GPS_SPEED_ALERTS_FLAG, { defaultEnabled: automationFlagDefault(GPS_SPEED_ALERTS_FLAG) });
      },
      async existingStarts(zello, startsUtc) {
        const { getDb } = await import("./db");
        const { sql } = await import("drizzle-orm");
        const db = await getDb();
        if (!db || !startsUtc.length) return new Set();
        const res: any = await db.execute(sql`SELECT DATE_FORMAT(occurredAt, '%Y-%m-%d %H:%i:%s') AS at FROM speed_violations
          WHERE zelloUsername = ${zello} AND occurredAt IN (${sql.join(startsUtc.map((s) => sql`${s}`), sql`, `)})`);
        const rows = ((Array.isArray(res) ? res[0] : res) as any[]) ?? [];
        return new Set(rows.map((r) => String(r.at)));
      },
      async record(row) {
        const { recordSpeedViolation } = await import("./db");
        return recordSpeedViolation(row as any);
      },
      async notify(n) {
        const { notify } = await import("./notify");
        return notify(n as any);
      },
    }, input);
  } catch (err) {
    console.warn("[speedAlerts] falhou:", String((err as any)?.message ?? err).slice(0, 160));
    return { outcome: "error", recorded: 0, notified: 0 };
  }
}
