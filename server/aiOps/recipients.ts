/**
 * Destinatários dos emails das automações — SEM mexer nas regras de acesso:
 *  - briefing/resumo da passagem de uma cidade: team leaders e supervisores
 *    ATIVOS com email, com acesso ao módulo e com essa cidade no seu acesso
 *    (centro de custos + cidades dadas, como o resto da app);
 *  - relatórios semanais: quem tem o módulo com alcance NACIONAL.
 * Cada destinatário leva os seus overrides para o email mostrar só o que vê.
 */
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { grantFor, type AccessOverrides, type ModuleId } from "../../shared/access";
import { opsCityOf, type OpsCity } from "./cities";

const rowsOf = (res: unknown): any[] => (Array.isArray(res) ? (Array.isArray(res[0]) ? res[0] : res) : []) as any[];

export interface Recipient { userId: number; email: string; name: string | null; role: string; accessOverrides: AccessOverrides }

export const CITY_RECIPIENT_ROLES = ["team_leader", "supervisor"] as const;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Elegível para o email de uma cidade? PURA. */
export function eligibleForCity(
  c: { role: string; email: string | null; accessOverrides: AccessOverrides },
  cityNames: string[] | undefined,
  city: OpsCity,
  module: ModuleId,
): boolean {
  if (!(CITY_RECIPIENT_ROLES as readonly string[]).includes(c.role)) return false;
  if (!c.email || !EMAIL_RE.test(c.email)) return false;
  const g = grantFor({ role: c.role, accessOverrides: c.accessOverrides } as any, module);
  if (g.access === "none" || !g.actions.includes("view")) return false;
  return (cityNames ?? []).some((n) => opsCityOf(n) === city);
}

/** Elegível para um relatório nacional do módulo? PURA. */
export function eligibleNational(c: { role: string; email: string | null; accessOverrides: AccessOverrides }, module: ModuleId): boolean {
  if (!c.email || !EMAIL_RE.test(c.email)) return false;
  const g = grantFor({ role: c.role, accessOverrides: c.accessOverrides } as any, module);
  return g.access === "national" && g.actions.includes("view");
}

async function activeUsers(roles?: readonly string[]): Promise<Array<{ id: number; email: string | null; name: string | null; role: string }>> {
  const db = await getDb();
  if (!db) return [];
  const rows = rowsOf(await db.execute(sql`
    SELECT id, email, name, role FROM users
     WHERE isActive = 1 AND email IS NOT NULL AND email <> ''
       ${roles ? sql`AND role IN (${sql.join(roles.map((r) => sql`${r}`), sql`, `)})` : sql``}
     ORDER BY id LIMIT 500`));
  return rows.map((r) => ({ id: Number(r.id), email: r.email ? String(r.email).trim().toLowerCase() : null, name: r.name ?? null, role: String(r.role) }));
}

export async function cityRecipients(city: OpsCity, module: ModuleId): Promise<Recipient[]> {
  const { getUserModuleOverrides } = await import("../db");
  const { loadCityAccess } = await import("../cityAccess");
  const out: Recipient[] = [];
  for (const u of await activeUsers(CITY_RECIPIENT_ROLES)) {
    try {
      const accessOverrides = await getUserModuleOverrides(u.id);
      const access = await loadCityAccess(u.id, u.role);
      if (access.missingCostCenter) continue;
      if (!eligibleForCity({ role: u.role, email: u.email, accessOverrides }, access.cityNames ?? (access.cityName ? [access.cityName] : []), city, module)) continue;
      out.push({ userId: u.id, email: u.email!, name: u.name, role: u.role, accessOverrides });
    } catch { /* sem ficha / centro de custos → não recebe */ }
  }
  return out;
}

export async function nationalRecipients(module: ModuleId): Promise<Recipient[]> {
  const { getUserModuleOverrides } = await import("../db");
  const { loadCityAccess } = await import("../cityAccess");
  const out: Recipient[] = [];
  for (const u of await activeUsers()) {
    try {
      const accessOverrides = await getUserModuleOverrides(u.id);
      if (!eligibleNational({ role: u.role, email: u.email, accessOverrides }, module)) continue;
      const access = await loadCityAccess(u.id, u.role);
      if (access.missingCostCenter) continue;
      out.push({ userId: u.id, email: u.email!, name: u.name, role: u.role, accessOverrides });
    } catch { /* ignora */ }
  }
  return out;
}
