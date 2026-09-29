/**
 * Regras para DAR / RETIRAR overrides de módulo por utilizador (pedido do
 * dono, 24 set 2026). Puro (sem BD): o servidor chama-o antes de gravar e a
 * página Permissões usa-o para desligar o que a pessoa não pode mexer.
 *
 *  1. Só quem tem Permissões → gerir (acesso efetivo).
 *  2. Ninguém mexe nos próprios overrides.
 *  3. Só contas que o ator pode gerir (canGrantPermissionsTo) e nunca acima
 *     do próprio papel — o supervisor nunca mexe em admins nem em papéis
 *     nacionais.
 *  4. Quem não tem Permissões a nível nacional só mexe em contas da sua cidade.
 *  5. Marketing, Logs, Faturação e API Keys: só super_admin.
 *  6. "Não dás o que não tens": o override novo, o que lá estava e (ao repor
 *     o padrão) o que o papel dá têm de caber no acesso EFETIVO do ator —
 *     alcance igual ou mais estreito e só ações que ele próprio tem.
 */
import {
  ACCESS_RANK, MODULES, canGrantPermissionsTo, grantFor, normalizeGrant, roleGrantFor, roleRank, can,
  type Access, type AccessOverrides, type Action, type Grant, type ModuleId, type ModuleOverride,
} from "./access";

/** Módulos que só o super_admin dá ou retira. */
export const SUPER_ADMIN_ONLY_MODULES: readonly ModuleId[] = ["marketing", "logs", "faturacao", "api_keys"];

export interface OverrideActor { id: number; role: string; accessOverrides?: AccessOverrides | null }
export interface OverrideTarget {
  id: number;
  role: string;
  /** A conta é da(s) cidade(s) do ator (o servidor verifica pelo centro de custos). */
  inActorCity: boolean;
}

/** `g` cabe em `mine`? (alcance igual ou mais estreito e ações contidas) */
export function withinReach(mine: Grant, g: Grant): boolean {
  const n = normalizeGrant(g);
  if (n.access === "none") return true;
  if (mine.access === "none") return false;
  return ACCESS_RANK[n.access] <= ACCESS_RANK[mine.access] && n.actions.every(a => mine.actions.includes(a));
}

/** Motivo pelo qual o ator NÃO pode mexer nos overrides desta conta (null = pode). */
export function overrideTargetError(actor: OverrideActor | null | undefined, target: OverrideTarget | null | undefined): string | null {
  if (!actor || !target) return "Conta desconhecida.";
  if (!can(actor, "permissoes", "manage")) return "Sem permissão para gerir permissões.";
  if (actor.id === target.id) return "Não podes alterar as tuas próprias permissões.";
  if (!canGrantPermissionsTo(actor, target.role)) return "Não podes gerir as permissões desta conta.";
  if (actor.role !== "super_admin" && roleRank(target.role) > roleRank(actor.role)) return "Não podes gerir contas acima do teu papel.";
  if (grantFor(actor, "permissoes").access !== "national" && !target.inActorCity) return "Esta conta não pertence à tua cidade.";
  return null;
}

/**
 * Motivo pelo qual o ator NÃO pode pôr `next` (null = repor o padrão do
 * papel) no módulo desta conta, onde hoje está `existing`. null = pode.
 */
export function overrideChangeError(
  actor: OverrideActor | null | undefined,
  target: OverrideTarget | null | undefined,
  module: ModuleId,
  next: ModuleOverride | null,
  existing: ModuleOverride | null,
): string | null {
  const who = overrideTargetError(actor, target);
  if (who) return who;
  if (!MODULES.some(m => m.id === module)) return "Módulo desconhecido.";
  if (SUPER_ADMIN_ONLY_MODULES.includes(module) && actor!.role !== "super_admin") {
    return "Só o super admin dá ou retira este módulo.";
  }
  const mine = grantFor(actor, module);
  if (mine.access === "none") return "Não podes mexer num módulo a que não tens acesso.";
  if (next && !withinReach(mine, next)) return "Não podes dar mais do que tens (alcance ou ações acima dos teus).";
  if (existing && !withinReach(mine, existing)) return "O override atual foi dado por alguém com mais acesso; só essa pessoa (ou acima) o pode mudar.";
  if (!next && !withinReach(mine, roleGrantFor(target!.role, module))) return "Repor o padrão daria mais do que tens.";
  return null;
}

// ─── Rótulos (UI e registo de atividade) ────────────────────────────────────
export const ACCESS_LABELS_PT: Record<Access, string> = {
  none: "sem acesso",
  own: "próprio",
  below_city: "equipa (cidade)",
  city: "cidade",
  national: "nacional",
};
export const ACTION_LABELS_PT: Record<Action, string> = { view: "ver", edit: "editar", export: "exportar", manage: "gerir" };

/** "cidade: ver, editar" / "sem acesso" / "padrão do papel" (null). */
export function describeGrant(g: { access: Access; actions: readonly Action[] } | null | undefined): string {
  if (!g) return "padrão do papel";
  const n = normalizeGrant(g);
  if (n.access === "none") return "sem acesso";
  return `${ACCESS_LABELS_PT[n.access]}: ${n.actions.map(a => ACTION_LABELS_PT[a]).join(", ")}`;
}
