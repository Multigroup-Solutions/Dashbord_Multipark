/**
 * Estado da Multis que sobrevive à navegação (e a recarregar a página no PC):
 * aberta/fechada e a conversa em que se estava. O painel do computador fica
 * acoplado à direita e não fecha ao mudar de página.
 */
import { useSyncExternalStore } from "react";

const OPEN_KEY = "mp.multis.open";
const CONV_KEY = "mp.multis.conversationId";

export interface MultisState { open: boolean; conversationId: number | null }

const isDesktop = () => typeof window !== "undefined" && window.innerWidth >= 768;

function load(): MultisState {
  try {
    const id = Number(localStorage.getItem(CONV_KEY));
    // No telemóvel não reabre sozinha ao carregar (a folha de baixo tapava o ecrã).
    return { open: isDesktop() && localStorage.getItem(OPEN_KEY) === "1", conversationId: Number.isInteger(id) && id > 0 ? id : null };
  } catch {
    return { open: false, conversationId: null };
  }
}

let state: MultisState = typeof window === "undefined" ? { open: false, conversationId: null } : load();
const listeners = new Set<() => void>();

function set(patch: Partial<MultisState>) {
  state = { ...state, ...patch };
  try {
    localStorage.setItem(OPEN_KEY, state.open ? "1" : "0");
    if (state.conversationId) localStorage.setItem(CONV_KEY, String(state.conversationId));
    else localStorage.removeItem(CONV_KEY);
  } catch { /* sem storage: só nesta visita */ }
  for (const l of listeners) l();
}

export const setMultisOpen = (open: boolean) => set({ open });
export const setMultisConversation = (conversationId: number | null) => set({ conversationId });

export function useMultisState(): MultisState {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => state,
    () => state,
  );
}
