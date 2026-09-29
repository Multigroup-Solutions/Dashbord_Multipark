/**
 * PDAs no mapa do Zello (decisão do dono, 29 set 2026): quando alguém faz
 * login num PDA, o nome da conta Zello desse PDA passa a "PDA 12 · Rui Santos";
 * no logout (ou check-out) volta a "PDA 12". Interruptor ZELLO_PDA_NAMES
 * (desligado por omissão). Nunca lança: o login não pode falhar por causa disto.
 */
import { sql } from "drizzle-orm";

type Db = { execute: (q: any) => Promise<any> };
const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r?.rows ?? r) as any[]) ?? [];

export const ZELLO_FULL_NAME_MAX = 64;

/** "Gelson Manuel Leão Sousa" → "Gelson Sousa". PURA. */
function shortName(full: string): string {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  return parts.length <= 2 ? parts.join(" ") : `${parts[0]} ${parts[parts.length - 1]}`;
}

/** Nome a mostrar no Zello: "PDA 12 · Rui Santos", ou só "PDA 12" sem ninguém. PURA. */
export function zelloDisplayName(pdaName: string, holderFullName: string | null | undefined): string {
  const base = String(pdaName ?? "").trim() || "PDA";
  const who = holderFullName ? shortName(holderFullName) : "";
  return (who ? `${base} · ${who}` : base).slice(0, ZELLO_FULL_NAME_MAX);
}

async function enabled(): Promise<boolean> {
  try {
    const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([import("./_core/featureFlags"), import("../shared/appSettings")]);
    await ensureFeatureFlagOverrides();
    return isFeatureEnabled("ZELLO_PDA_NAMES", { defaultEnabled: automationFlagDefault("ZELLO_PDA_NAMES") });
  } catch { return false; }
}

async function database(): Promise<Db | null> {
  const { getDb } = await import("./db");
  return ((await getDb()) as unknown as Db | null) ?? null;
}

/** Acerta o nome no Zello do PDA conforme quem o tem agora. */
export async function syncPdaZelloName(pdaId: number): Promise<"ok" | "skip" | "error"> {
  try {
    if (!(await enabled())) return "skip";
    const { isZelloConfigured, setZelloUserFullName } = await import("./zello");
    if (!isZelloConfigured()) return "skip";
    const d = await database();
    if (!d) return "skip";
    const pda = rowsOf(await d.execute(sql`SELECT id, name, zelloUsername FROM pdas WHERE id = ${pdaId} LIMIT 1`))[0];
    if (!pda?.zelloUsername) return "skip";
    const holder = rowsOf(await d.execute(sql`SELECT e.fullName FROM pda_checkins c JOIN employees e ON e.id = c.employeeId
      WHERE c.pdaId = ${pdaId} AND c.checkin_status = 'checked_in' ORDER BY c.checkinAt DESC LIMIT 1`))[0];
    await setZelloUserFullName(String(pda.zelloUsername), zelloDisplayName(String(pda.name), holder?.fullName ?? null));
    return "ok";
  } catch (err) {
    console.warn("[pda] nome no Zello falhou:", (err as Error)?.message);
    return "error";
  }
}

export async function syncPdaZelloNameByToken(deviceToken: string): Promise<void> {
  const d = await database();
  const r = d ? rowsOf(await d.execute(sql`SELECT id FROM pdas WHERE deviceToken = ${deviceToken} LIMIT 1`).catch(() => [[]]))[0] : null;
  if (r) await syncPdaZelloName(Number(r.id));
}

export async function syncPdaZelloNameByCheckin(checkinId: number): Promise<void> {
  const d = await database();
  const r = d ? rowsOf(await d.execute(sql`SELECT pdaId FROM pda_checkins WHERE id = ${checkinId} LIMIT 1`).catch(() => [[]]))[0] : null;
  if (r) await syncPdaZelloName(Number(r.pdaId));
}

/** Depois de fechar os check-ins de uma pessoa (saída do ponto): acerta os PDAs que ela largou agora. */
export async function syncPdaZelloNamesForEmployee(employeeId: number): Promise<void> {
  const d = await database();
  if (!d) return;
  const rows = rowsOf(await d.execute(sql`SELECT DISTINCT pdaId FROM pda_checkins WHERE employeeId = ${employeeId}
    AND checkoutAt >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)`).catch(() => [[]]));
  for (const r of rows) await syncPdaZelloName(Number(r.pdaId));
}
