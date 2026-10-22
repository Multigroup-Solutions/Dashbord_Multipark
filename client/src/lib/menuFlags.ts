/**
 * Plano 05: itens do menu atrás de um interruptor (shared/menuFlags.ts). Só o
 * super admin pergunta ao servidor (a lista das Automações, a mesma das
 * Definições); sem resposta o item fica escondido — com os interruptores
 * desligados o menu é o de sempre.
 */
import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { menuFlagsFrom, type MenuFlag } from "@shared/menuFlags";

export type { MenuFlag } from "@shared/menuFlags";

export function useMenuFlags(user: { role?: string | null } | null | undefined): ReadonlySet<MenuFlag> {
  const superAdmin = user?.role === "super_admin";
  const q = trpc.settings.flags.list.useQuery(undefined, { enabled: superAdmin, staleTime: 5 * 60_000, retry: false, refetchOnWindowFocus: false });
  return useMemo(() => (superAdmin ? menuFlagsFrom(q.data) : new Set<MenuFlag>()), [superAdmin, q.data]);
}
