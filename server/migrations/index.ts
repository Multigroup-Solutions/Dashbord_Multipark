/**
 * Migrações aplicadas sozinhas no arranque (rede de segurança). Saíram do
 * `db.ts` a 1 out 2026 (P2: só mudança de sítio — o comportamento é o mesmo;
 * o `db.ts` chama `ensureRecentSchema` uma vez por processo, em `getDb()`).
 *
 * Para acrescentar uma: `migration_NNNN.ts` com `MIGRATION_NNNN_STATEMENTS` e
 * `IDEMPOTENT_ERROR_CODES_NNNN`, e uma linha NO FIM de `SCHEMA_MIGRATIONS`
 * (a ordem é a de aplicação e tem de ser crescente — há teste).
 * As migrações só à mão (0044–0049, botões DB:NNNN e scripts/run-migration.ts)
 * não entram aqui.
 */
import { sql } from "drizzle-orm";

export interface SchemaMigrationStep {
  statements: readonly string[];
  /** Códigos do MySQL que querem dizer "já estava aplicada" (calados). */
  idempotentErrors: ReadonlySet<string>;
}

const step = (statements: readonly string[], idempotentErrors: ReadonlySet<string>): SchemaMigrationStep => ({ statements, idempotentErrors });

/** [id, carregador] por ordem de aplicação. */
export const SCHEMA_MIGRATIONS: ReadonlyArray<readonly [string, () => Promise<SchemaMigrationStep>]> = [
  ["0050", () => import("./migration_0050").then((m) => step(m.MIGRATION_0050_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0050))],
  ["0051", () => import("./migration_0051").then((m) => step(m.MIGRATION_0051_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0051))],
  ["0052", () => import("./migration_0052").then((m) => step(m.MIGRATION_0052_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0052))],
  ["0053", () => import("./migration_0053").then((m) => step(m.MIGRATION_0053_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0053))],
  ["0054", () => import("./migration_0054").then((m) => step(m.MIGRATION_0054_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0054))],
  ["0055", () => import("./migration_0055").then((m) => step(m.MIGRATION_0055_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0055))],
  ["0056", () => import("./migration_0056").then((m) => step(m.MIGRATION_0056_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0056))],
  ["0058", () => import("./migration_0058").then((m) => step(m.MIGRATION_0058_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0058))],
  ["0059", () => import("./migration_0059").then((m) => step(m.MIGRATION_0059_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0059))],
  ["0060", () => import("./migration_0060").then((m) => step(m.MIGRATION_0060_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0060))],
  ["0061", () => import("./migration_0061").then((m) => step(m.MIGRATION_0061_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0061))],
  ["0062", () => import("./migration_0062").then((m) => step(m.MIGRATION_0062_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0062))],
  ["0063", () => import("./migration_0063").then((m) => step(m.MIGRATION_0063_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0063))],
  ["0064", () => import("./migration_0064").then((m) => step(m.MIGRATION_0064_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0064))],
  ["0065", () => import("./migration_0065").then((m) => step(m.MIGRATION_0065_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0065))],
  ["0066", () => import("./migration_0066").then((m) => step(m.MIGRATION_0066_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0066))],
  ["0067", () => import("./migration_0067").then((m) => step(m.MIGRATION_0067_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0067))],
  ["0068", () => import("./migration_0068").then((m) => step(m.MIGRATION_0068_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0068))],
  ["0069", () => import("./migration_0069").then((m) => step(m.MIGRATION_0069_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0069))],
  ["0070", () => import("./migration_0070").then((m) => step(m.MIGRATION_0070_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0070))],
  ["0071", () => import("./migration_0071").then((m) => step(m.MIGRATION_0071_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0071))],
  ["0072", () => import("./migration_0072").then((m) => step(m.MIGRATION_0072_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0072))],
  ["0073", () => import("./migration_0073").then((m) => step(m.MIGRATION_0073_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0073))],
  ["0074", () => import("./migration_0074").then((m) => step(m.MIGRATION_0074_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0074))],
  ["0075", () => import("./migration_0075").then((m) => step(m.MIGRATION_0075_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0075))],
  ["0076", () => import("./migration_0076").then((m) => step(m.MIGRATION_0076_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0076))],
  ["0077", () => import("./migration_0077").then((m) => step(m.MIGRATION_0077_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0077))],
  ["0078", () => import("./migration_0078").then((m) => step(m.MIGRATION_0078_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0078))],
  ["0079", () => import("./migration_0079").then((m) => step(m.MIGRATION_0079_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0079))],
  ["0080", () => import("./migration_0080").then((m) => step(m.MIGRATION_0080_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0080))],
  ["0081", () => import("./migration_0081").then((m) => step(m.MIGRATION_0081_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0081))],
  ["0082", () => import("./migration_0082").then((m) => step(m.MIGRATION_0082_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0082))],
  ["0083", () => import("./migration_0083").then((m) => step(m.MIGRATION_0083_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0083))],
  ["0084", () => import("./migration_0084").then((m) => step(m.MIGRATION_0084_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0084))],
  ["0085", () => import("./migration_0085").then((m) => step(m.MIGRATION_0085_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0085))],
  ["0086", () => import("./migration_0086").then((m) => step(m.MIGRATION_0086_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0086))],
  ["0087", () => import("./migration_0087").then((m) => step(m.MIGRATION_0087_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0087))],
  ["0088", () => import("./migration_0088").then((m) => step(m.MIGRATION_0088_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0088))],
  ["0090", () => import("./migration_0090").then((m) => step(m.MIGRATION_0090_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0090))],
  ["0091", () => import("./migration_0091").then((m) => step(m.MIGRATION_0091_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0091))],
  ["0092", () => import("./migration_0092").then((m) => step(m.MIGRATION_0092_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0092))],
  ["0093", () => import("./migration_0093").then((m) => step(m.MIGRATION_0093_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0093))],
  ["0094", () => import("./migration_0094").then((m) => step(m.MIGRATION_0094_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0094))],
  ["0095", () => import("./migration_0095").then((m) => step(m.MIGRATION_0095_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0095))],
  ["0096", () => import("./migration_0096").then((m) => step(m.MIGRATION_0096_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0096))],
  ["0097", () => import("./migration_0097").then((m) => step(m.MIGRATION_0097_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0097))],
  ["0098", () => import("./migration_0098").then((m) => step(m.MIGRATION_0098_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0098))],
  ["0099", () => import("./migration_0099").then((m) => step(m.MIGRATION_0099_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0099))],
  ["0100", () => import("./migration_0100").then((m) => step(m.MIGRATION_0100_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0100))],
  ["0101", () => import("./migration_0101").then((m) => step(m.MIGRATION_0101_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0101))],
  ["0105", () => import("./migration_0105").then((m) => step(m.MIGRATION_0105_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0105))],
  ["0110", () => import("./migration_0110").then((m) => step(m.MIGRATION_0110_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0110))],
  ["0111", () => import("./migration_0111").then((m) => step(m.MIGRATION_0111_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0111))],
  ["0115", () => import("./migration_0115").then((m) => step(m.MIGRATION_0115_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0115))],
  ["0123", () => import("./migration_0123").then((m) => step(m.MIGRATION_0123_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0123))],
  ["0125", () => import("./migration_0125").then((m) => step(m.MIGRATION_0125_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0125))],
  ["0130", () => import("./migration_0130").then((m) => step(m.MIGRATION_0130_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0130))],
  ["0138", () => import("./migration_0138").then((m) => step(m.MIGRATION_0138_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0138))],
  ["0140", () => import("./migration_0140").then((m) => step(m.MIGRATION_0140_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0140))],
  ["0145", () => import("./migration_0145").then((m) => step(m.MIGRATION_0145_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0145))],
  ["0150", () => import("./migration_0150").then((m) => step(m.MIGRATION_0150_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0150))],
  ["0155", () => import("./migration_0155").then((m) => step(m.MIGRATION_0155_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0155))],
  ["0160", () => import("./migration_0160").then((m) => step(m.MIGRATION_0160_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0160))],
  ["0165", () => import("./migration_0165").then((m) => step(m.MIGRATION_0165_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0165))],
  ["0170", () => import("./migration_0170").then((m) => step(m.MIGRATION_0170_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0170))],
  ["0175", () => import("./migration_0175").then((m) => step(m.MIGRATION_0175_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0175))],
  ["0180", () => import("./migration_0180").then((m) => step(m.MIGRATION_0180_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0180))],
  ["0185", () => import("./migration_0185").then((m) => step(m.MIGRATION_0185_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0185))],
  ["0190", () => import("./migration_0190").then((m) => step(m.MIGRATION_0190_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0190))],
  ["0195", () => import("./migration_0195").then((m) => step(m.MIGRATION_0195_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0195))],
  ["0200", () => import("./migration_0200").then((m) => step(m.MIGRATION_0200_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0200))],
  ["0205", () => import("./migration_0205").then((m) => step(m.MIGRATION_0205_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0205))],
  ["0210", () => import("./migration_0210").then((m) => step(m.MIGRATION_0210_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0210))],
  ["0215", () => import("./migration_0215").then((m) => step(m.MIGRATION_0215_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0215))],
  ["0220", () => import("./migration_0220").then((m) => step(m.MIGRATION_0220_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0220))],
  ["0225", () => import("./migration_0225").then((m) => step(m.MIGRATION_0225_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0225))],
  ["0230", () => import("./migration_0230").then((m) => step(m.MIGRATION_0230_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0230))],
  ["0235", () => import("./migration_0235").then((m) => step(m.MIGRATION_0235_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0235))],
  ["0240", () => import("./migration_0240").then((m) => step(m.MIGRATION_0240_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0240))],
  ["0245", () => import("./migration_0245").then((m) => step(m.MIGRATION_0245_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0245))],
  ["0250", () => import("./migration_0250").then((m) => step(m.MIGRATION_0250_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0250))],
  ["0255", () => import("./migration_0255").then((m) => step(m.MIGRATION_0255_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0255))],
  ["0260", () => import("./migration_0260").then((m) => step(m.MIGRATION_0260_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0260))],
  ["0265", () => import("./migration_0265").then((m) => step(m.MIGRATION_0265_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0265))],
  ["0270", () => import("./migration_0270").then((m) => step(m.MIGRATION_0270_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0270))],
  ["0275", () => import("./migration_0275").then((m) => step(m.MIGRATION_0275_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0275))],
  ["0280", () => import("./migration_0280").then((m) => step(m.MIGRATION_0280_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0280))],
  ["0285", () => import("./migration_0285").then((m) => step(m.MIGRATION_0285_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0285))],
  ["0290", () => import("./migration_0290").then((m) => step(m.MIGRATION_0290_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0290))],
  ["0295", () => import("./migration_0295").then((m) => step(m.MIGRATION_0295_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0295))],
  ["0300", () => import("./migration_0300").then((m) => step(m.MIGRATION_0300_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0300))],
  ["0305", () => import("./migration_0305").then((m) => step(m.MIGRATION_0305_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0305))],
  ["0310", () => import("./migration_0310").then((m) => step(m.MIGRATION_0310_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0310))],
  ["0315", () => import("./migration_0315").then((m) => step(m.MIGRATION_0315_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0315))],
  ["0320", () => import("./migration_0320").then((m) => step(m.MIGRATION_0320_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0320))],
  ["0325", () => import("./migration_0325").then((m) => step(m.MIGRATION_0325_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0325))],
  ["0330", () => import("./migration_0330").then((m) => step(m.MIGRATION_0330_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0330))],
  ["0335", () => import("./migration_0335").then((m) => step(m.MIGRATION_0335_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0335))],
  ["0340", () => import("./migration_0340").then((m) => step(m.MIGRATION_0340_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0340))],
  ["0345", () => import("./migration_0345").then((m) => step(m.MIGRATION_0345_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0345))],
  ["0350", () => import("./migration_0350").then((m) => step(m.MIGRATION_0350_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0350))],
  ["0355", () => import("./migration_0355").then((m) => step(m.MIGRATION_0355_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0355))],
  ["0360", () => import("./migration_0360").then((m) => step(m.MIGRATION_0360_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0360))],
  ["0365", () => import("./migration_0365").then((m) => step(m.MIGRATION_0365_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0365))],
  ["0370", () => import("./migration_0370").then((m) => step(m.MIGRATION_0370_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0370))],
  ["0375", () => import("./migration_0375").then((m) => step(m.MIGRATION_0375_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0375))],
  ["0376", () => import("./migration_0376").then((m) => step(m.MIGRATION_0376_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0376))],
  ["0380", () => import("./migration_0380").then((m) => step(m.MIGRATION_0380_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0380))],
  ["0385", () => import("./migration_0385").then((m) => step(m.MIGRATION_0385_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0385))],
  ["0390", () => import("./migration_0390").then((m) => step(m.MIGRATION_0390_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0390))],
  ["0395", () => import("./migration_0395").then((m) => step(m.MIGRATION_0395_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0395))],
  ["0400", () => import("./migration_0400").then((m) => step(m.MIGRATION_0400_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0400))],
  ["0405", () => import("./migration_0405").then((m) => step(m.MIGRATION_0405_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0405))],
  ["0410", () => import("./migration_0410").then((m) => step(m.MIGRATION_0410_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0410))],
  ["0415", () => import("./migration_0415").then((m) => step(m.MIGRATION_0415_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0415))],
  ["0420", () => import("./migration_0420").then((m) => step(m.MIGRATION_0420_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0420))],
  ["0425", () => import("./migration_0425").then((m) => step(m.MIGRATION_0425_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0425))],
  ["0430", () => import("./migration_0430").then((m) => step(m.MIGRATION_0430_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0430))],
  ["0435", () => import("./migration_0435").then((m) => step(m.MIGRATION_0435_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0435))],
  ["0440", () => import("./migration_0440").then((m) => step(m.MIGRATION_0440_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0440))],
  ["0445", () => import("./migration_0445").then((m) => step(m.MIGRATION_0445_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0445))],
  ["0450", () => import("./migration_0450").then((m) => step(m.MIGRATION_0450_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0450))],
  ["0455", () => import("./migration_0455").then((m) => step(m.MIGRATION_0455_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0455))],
  ["0460", () => import("./migration_0460").then((m) => step(m.MIGRATION_0460_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0460))],
  ["0465", () => import("./migration_0465").then((m) => step(m.MIGRATION_0465_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0465))],
  ["0470", () => import("./migration_0470").then((m) => step(m.MIGRATION_0470_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0470))],
  ["0475", () => import("./migration_0475").then((m) => step(m.MIGRATION_0475_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0475))],
  ["0480", () => import("./migration_0480").then((m) => step(m.MIGRATION_0480_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0480))],
  ["0485", () => import("./migration_0485").then((m) => step(m.MIGRATION_0485_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0485))],
  ["0490", () => import("./migration_0490").then((m) => step(m.MIGRATION_0490_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0490))],
  ["0495", () => import("./migration_0495").then((m) => step(m.MIGRATION_0495_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0495))],
  ["0500", () => import("./migration_0500").then((m) => step(m.MIGRATION_0500_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0500))],
  ["0505", () => import("./migration_0505").then((m) => step(m.MIGRATION_0505_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0505))],
  ["0510", () => import("./migration_0510").then((m) => step(m.MIGRATION_0510_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0510))],
  ["0515", () => import("./migration_0515").then((m) => step(m.MIGRATION_0515_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0515))],
  ["0520", () => import("./migration_0520").then((m) => step(m.MIGRATION_0520_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0520))],
  ["0525", () => import("./migration_0525").then((m) => step(m.MIGRATION_0525_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0525))],
  ["0530", () => import("./migration_0530").then((m) => step(m.MIGRATION_0530_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0530))],
  ["0535", () => import("./migration_0535").then((m) => step(m.MIGRATION_0535_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0535))],
  ["0540", () => import("./migration_0540").then((m) => step(m.MIGRATION_0540_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0540))],
  ["0545", () => import("./migration_0545").then((m) => step(m.MIGRATION_0545_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0545))],
  ["0550", () => import("./migration_0550").then((m) => step(m.MIGRATION_0550_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0550))],
  ["0555", () => import("./migration_0555").then((m) => step(m.MIGRATION_0555_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0555))],
  ["0560", () => import("./migration_0560").then((m) => step(m.MIGRATION_0560_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0560))],
  ["0565", () => import("./migration_0565").then((m) => step(m.MIGRATION_0565_STATEMENTS, m.IDEMPOTENT_ERROR_CODES_0565))],
];

export const SCHEMA_MIGRATION_IDS: readonly string[] = SCHEMA_MIGRATIONS.map(([id]) => id);

type Executor = { execute: (q: any) => Promise<unknown> };

/**
 * Aplica (idempotente, uma vez por processo) as migrations cujo SCHEMA drizzle
 * já referencia colunas/tabelas novas — senão `select()` parte com "Unknown
 * column" antes de alguém carregar no botão DB:NNNN. Limitado às migrations que
 * introduzem schema lido no arranque (0050 extras_availability, 0051 threading).
 * Os botões manuais continuam a existir; isto é só uma rede de segurança.
 */
export async function ensureRecentSchema(db: Executor): Promise<void> {
  try {
    const mods = (await Promise.all(SCHEMA_MIGRATIONS.map(([, load]) => load()))).map((m) => ({ s: m.statements, ok: m.idempotentErrors }));
    for (const { s, ok } of mods) {
      for (const stmt of s) {
        try {
          await db.execute(sql.raw(stmt));
        } catch (err: any) {
          // O drizzle embrulha o erro do mysql2 (DrizzleQueryError) — o código
          // MySQL vem em `cause.code`; sem isto TODAS as migrações já aplicadas
          // faziam warning em cada arranque.
          const code = err?.code ?? err?.cause?.code;
          if (!(code && ok.has(code))) {
            console.warn("[Schema ensure]", code ?? "ERR", String(err?.cause?.message ?? err?.message ?? err).slice(0, 160));
          }
        }
      }
    }
  } catch (err: any) {
    console.warn("[Schema ensure] falhou:", String(err?.message ?? err).slice(0, 160));
  }
  // Passos de DADOS (código, uma vez, guardados por marca) — depois do SQL.
  try {
    const { runMigration0210Data } = await import("./migration_0210");
    const r = await runMigration0210Data(db as any);
    if (r.status === "applied" && r.patches.length) console.log("[Schema ensure] 0210 caixas de email:", r.patches.map((p) => `${p.mailboxKey} (${p.changes.join("; ")})`).join(" · ").slice(0, 500));
  } catch (err: any) {
    console.warn("[Schema ensure] 0210 (dados das caixas de email) falhou:", String(err?.cause?.message ?? err?.message ?? err).slice(0, 160));
  }
  try {
    const { runMigration0215Collation } = await import("./migration_0215");
    const converted = await runMigration0215Collation(db as any);
    if (converted.length) console.log("[Schema ensure] 0215 CRM: collation igual à de multipark_bookings em", converted.join(", "));
  } catch (err: any) {
    console.warn("[Schema ensure] 0215 (collation do CRM) falhou:", String(err?.cause?.message ?? err?.message ?? err).slice(0, 160));
  }
  try {
    // (Remetente de sistema lido pela própria migração — getSetting usaria
    // getDb(), que espera por ESTE ensureRecentSchema.)
    const { runMigration0230Data } = await import("./migration_0230");
    const r = await runMigration0230Data(db as any);
    if (r.status === "applied" && r.messages) console.log(`[Schema ensure] 0230 envios automáticos: ${r.messages} mensagem(ns), ${r.threads} conversa(s) escondida(s)/recalculada(s), ${r.sends} envio(s) na ficha dos extras`);
  } catch (err: any) {
    console.warn("[Schema ensure] 0230 (envios automáticos na Comunicação) falhou:", String(err?.cause?.message ?? err?.message ?? err).slice(0, 160));
  }
  try {
    const { runMigration0410Data } = await import("./migration_0410");
    const r = await runMigration0410Data(db as any);
    if (r.status === "applied") console.log("[Schema ensure] 0410 marcadores das fichas copiados dos logs (cidade pedida, ficha do site)");
  } catch (err: any) {
    console.warn("[Schema ensure] 0410 (marcadores das fichas) falhou:", String(err?.cause?.message ?? err?.message ?? err).slice(0, 160));
  }
  try {
    const { runMigration0545Collation } = await import("./migration_0545");
    if (await runMigration0545Collation(db as any)) console.log("[Schema ensure] 0545 tasks.bookingRef: collation igual à de multipark_bookings.externalId");
  } catch (err: any) {
    console.warn("[Schema ensure] 0545 (collation de tasks.bookingRef) falhou:", String(err?.cause?.message ?? err?.message ?? err).slice(0, 160));
  }
}
