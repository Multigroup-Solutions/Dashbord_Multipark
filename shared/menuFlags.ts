/**
 * Plano 05: itens do menu que só aparecem com um interruptor ligado
 * (MenuItem.flag no DashboardLayout). Hoje só "Identidade partilhada" (super
 * admin, com SHARED_AUTH_LINK ou SHARED_AUTH_LOGIN). PURO (testado no servidor).
 */

export type MenuFlag = "sharedIdentity";

/** Interruptores (Definições → Automações) de cada item: basta um ligado. */
export const MENU_FLAG_SWITCHES: Record<MenuFlag, readonly string[]> = {
  sharedIdentity: ["SHARED_AUTH_LINK", "SHARED_AUTH_LOGIN"],
};

/** Que itens ficam visíveis com estes interruptores. Sem lista (ainda a carregar, erro) → nenhum. */
export function menuFlagsFrom(flags: ReadonlyArray<{ name: string; effective: boolean }> | null | undefined): ReadonlySet<MenuFlag> {
  const on = new Set((flags ?? []).filter((f) => f.effective).map((f) => f.name));
  return new Set((Object.keys(MENU_FLAG_SWITCHES) as MenuFlag[]).filter((k) => MENU_FLAG_SWITCHES[k].some((n) => on.has(n))));
}
