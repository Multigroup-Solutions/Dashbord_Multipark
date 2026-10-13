/**
 * Plano 56 (A2): fim da sessão de PDA depois da saída do ponto. O servidor já
 * acabou a sessão (a resposta da saída traz `pdaSessionEnded` e o resumo); o
 * ecrã mostra o resumo e "A sessão termina em 10 s" e depois volta à página
 * de entrada — sem pedir mais nada ao servidor (a sessão já não vale).
 *
 * Enquanto isto corre, um 401 de outro pedido NÃO salta logo para o login
 * (main.tsx pergunta `isPdaSessionEnding()`).
 */
import { RECENT_SEARCHES_KEY } from "@shared/globalSearch";
import { markClaimed } from "@/lib/pdaDevice";

export const PDA_SESSION_END_EVENT = "mp:pda-session-end";

let ending = false;

export function isPdaSessionEnding(): boolean {
  return ending;
}

export interface PdaSessionEndDetail { lines: string[] }

/** A saída do ponto acabou a sessão deste PDA: mostra o resumo e termina. */
export function beginPdaSessionEnd(lines: string[]): void {
  ending = true;
  try {
    window.dispatchEvent(new CustomEvent<PdaSessionEndDetail>(PDA_SESSION_END_EVENT, { detail: { lines } }));
  } catch { /* sem window (testes) */ }
}

/** O que fica no aparelho partilhado sai (pesquisas, passos da entrada, ligação ao PDA). */
export function clearSharedDeviceState(): void {
  markClaimed(null);
  try { localStorage.removeItem(RECENT_SEARCHES_KEY); } catch { /* sem storage */ }
  try { sessionStorage.clear(); } catch { /* sem storage */ }
}
