// Migration 0680 — Velocidade: 120 km/h sem tolerância (tarefa 62, P1; Jorge,
// 14 out 2026: "120, 0 % de tolerância").
//
// Esquema: `daily_driver_history.speedThresholdKmh` = o limiar (km/h, já com a
// tolerância) com que a linha do GPS foi recolhida ou re-dividida. Gravam-no a
// recolha diária (as duas passagens: a final atualiza a linha da provisória) e
// a re-divisão (server/jobs/dailyDriverCollection.ts). As linhas antigas ficam
// a NULL = recolhidas com a omissão antiga (132). É a "trava da linha GPS"
// (shared/speedRules.ts → gpsDayOverThreshold): um dia só conta excesso acima
// do MAIOR entre o limiar de hoje e o da recolha — nunca se inventa um excesso
// com uma máxima que a recolha não confirmou.
//
// Dados — um passo que corre UMA vez em toda a frota, nunca dois em paralelo
// (o mesmo padrão da 0675):
//  1. reclama a tarefa com uma linha em `app_settings`
//     (`gps.speedRuleTolerance0V1`; INSERT IGNORE na chave primária → só um
//     arranque ganha; "failed" ou "running" há mais de 15 min → retoma-se com
//     um UPDATE condicional);
//  2. a definição `gps.speedRule` gravada com {120 km/h, 10 %, x} passa a
//     {120, 0, x} (UPDATE condicional: só se ainda estiver assim) e fica uma
//     linha em `app_settings_audit` (quem = NULL, o sistema). Sem valor
//     gravado: nada a fazer (vale a omissão nova, 120/0). Outro valor
//     (alguém já o escolheu): não se toca, e o log diz-o;
//  3. marca "done" com o que fez (fica em app_settings e nos logs).
// A recolha lê a regra sem cache (getSettingFresh): vale logo a seguir.
// Nada se apaga.

import { sql } from "drizzle-orm";
import { SPEED_RULE_SETTING_KEY } from "../../shared/speedRules";

export const MIGRATION_0680_NAME = "0680_speed_rule_tolerance_0";
export const MIGRATION_0680_STATEMENTS: string[] = [
  "ALTER TABLE `daily_driver_history` ADD COLUMN `speedThresholdKmh` DECIMAL(6,2) NULL AFTER `metricsVersion`",
];
export const IDEMPOTENT_ERROR_CODES_0680 = new Set<string>(["ER_DUP_FIELDNAME"]);

export const SPEED_RULE_FLAG_0680 = "gps.speedRuleTolerance0V1";
/** "running" mais antigo do que isto = tentativa abandonada (pode ser retomada). */
export const STALE_RUNNING_MS_0680 = 15 * 60_000;

/** O valor antigo que passa a 0 % (a omissão de antes da tarefa 62). */
const OLD_LIMIT_KMH = 120;
const OLD_TOLERANCE_PERCENT = 10;

export type SpeedRulePlan0680 =
  | { action: "update"; from: Record<string, unknown>; to: Record<string, unknown> }
  | { action: "none" }
  | { action: "keep"; value: unknown };

/** O que fazer ao valor gravado de `gps.speedRule`. PURA. */
export function planSpeedRuleTolerance(value: unknown): SpeedRulePlan0680 {
  if (value == null) return { action: "none" };
  if (typeof value !== "object" || Array.isArray(value)) return { action: "keep", value };
  const v = value as Record<string, unknown>;
  if (Number(v.limitKmh) === OLD_LIMIT_KMH && Number(v.tolerancePercent) === OLD_TOLERANCE_PERCENT) {
    return { action: "update", from: { ...v }, to: { ...v, tolerancePercent: 0 } };
  }
  return { action: "keep", value };
}

type Executor = { execute: (q: any) => Promise<unknown> };

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const affectedOf = (res: unknown): number => {
  const h = Array.isArray(res) ? res[0] : res;
  return Number((h as any)?.affectedRows ?? 0);
};
/** O mysql2 devolve JSON como objeto (MySQL) ou texto (MariaDB). */
const parseJson = (raw: unknown): unknown => {
  if (raw == null) return null;
  if (typeof raw === "string") { try { return JSON.parse(raw); } catch { return raw; } }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(raw)) { try { return JSON.parse(raw.toString("utf8")); } catch { return null; } }
  return raw;
};

/** Reclama a tarefa: só um arranque ganha (chave primária / UPDATE condicional). */
async function claim0680(db: Executor, now: Date): Promise<boolean> {
  const running = JSON.stringify({ state: "running", at: now.toISOString() });
  const ins = await db.execute(sql`INSERT IGNORE INTO app_settings (settingKey, \`value\`) VALUES (${SPEED_RULE_FLAG_0680}, ${running})`);
  if (affectedOf(ins) === 1) return true;
  // `at` é ISO (UTC, sempre o mesmo formato) → comparar como texto dá a ordem certa.
  const staleBefore = new Date(now.getTime() - STALE_RUNNING_MS_0680).toISOString();
  const retry = await db.execute(sql`UPDATE app_settings SET \`value\` = ${running}
    WHERE settingKey = ${SPEED_RULE_FLAG_0680} AND (
      JSON_UNQUOTE(JSON_EXTRACT(\`value\`, '$.state')) = 'failed'
      OR (JSON_UNQUOTE(JSON_EXTRACT(\`value\`, '$.state')) = 'running' AND JSON_UNQUOTE(JSON_EXTRACT(\`value\`, '$.at')) < ${staleBefore})
    )`);
  return affectedOf(retry) === 1;
}

async function finish0680(db: Executor, value: Record<string, unknown>): Promise<void> {
  await db.execute(sql`UPDATE app_settings SET \`value\` = ${JSON.stringify(value)} WHERE settingKey = ${SPEED_RULE_FLAG_0680}`);
}

export type Migration0680Result =
  | { status: "skipped" }
  | { status: "applied"; result: "updated"; from: Record<string, unknown>; to: Record<string, unknown> }
  | { status: "applied"; result: "no_value" }
  | { status: "applied"; result: "other_value"; value: unknown }
  | { status: "applied"; result: "changed_meanwhile" };

export async function runMigration0680Data(db: Executor, opts: { now?: Date } = {}): Promise<Migration0680Result> {
  if (!(await claim0680(db, opts.now ?? new Date()))) return { status: "skipped" };
  try {
    const row = rowsOf(await db.execute(sql`SELECT \`value\` FROM app_settings WHERE settingKey = ${SPEED_RULE_SETTING_KEY} LIMIT 1`))[0];
    const plan = planSpeedRuleTolerance(row ? parseJson(row.value) : null);
    let out: Migration0680Result;
    if (plan.action === "none") out = { status: "applied", result: "no_value" };
    else if (plan.action === "keep") out = { status: "applied", result: "other_value", value: plan.value };
    else {
      const fromJson = JSON.stringify(plan.from), toJson = JSON.stringify(plan.to);
      // Só se ainda estiver {120, 10, x} — alguém pode ter mudado entretanto (fica o dele).
      const upd = await db.execute(sql`UPDATE app_settings SET \`value\` = ${toJson}, updatedById = NULL
        WHERE settingKey = ${SPEED_RULE_SETTING_KEY}
          AND JSON_EXTRACT(\`value\`, '$.limitKmh') = ${OLD_LIMIT_KMH}
          AND JSON_EXTRACT(\`value\`, '$.tolerancePercent') = ${OLD_TOLERANCE_PERCENT}`);
      if (affectedOf(upd) === 1) {
        await db.execute(sql`INSERT INTO app_settings_audit (settingKey, oldValue, newValue, changedById)
          VALUES (${SPEED_RULE_SETTING_KEY}, ${fromJson}, ${toJson}, NULL)`);
        out = { status: "applied", result: "updated", from: plan.from, to: plan.to };
      } else {
        out = { status: "applied", result: "changed_meanwhile" };
      }
    }
    const { status: _s, ...detail } = out as Exclude<Migration0680Result, { status: "skipped" }>;
    await finish0680(db, { state: "done", at: new Date().toISOString(), ...detail });
    return out;
  } catch (err: any) {
    // Deixa voltar a tentar no próximo arranque (só um, pelo UPDATE condicional).
    try { await finish0680(db, { state: "failed", at: new Date().toISOString(), error: String(err?.cause?.message ?? err?.message ?? err).slice(0, 200) }); } catch { /* fica "running" */ }
    throw err;
  }
}

/** Linha do log do arranque (PT). PURA. */
export function describe0680(r: Migration0680Result): string | null {
  if (r.status === "skipped") return null;
  switch (r.result) {
    case "updated": return `0680 velocidade: limite gravado ${JSON.stringify(r.from)} → ${JSON.stringify(r.to)} (0 % de tolerância; conta acima de 120 km/h)`;
    case "no_value": return "0680 velocidade: sem valor gravado — vale a omissão nova (120 km/h, 0 %)";
    case "other_value": return `0680 velocidade: valor gravado ${JSON.stringify(r.value)} ≠ {120, 10 %}: não se tocou (escolha de alguém)`.slice(0, 400);
    case "changed_meanwhile": return "0680 velocidade: o valor mudou entretanto — não se tocou";
  }
}
