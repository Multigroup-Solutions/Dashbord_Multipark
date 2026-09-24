/**
 * Identidade do aparelho PDA neste browser (Fase 2). O token é guardado quando
 * o aparelho é registado (QR ou escolha na aba PDAs). Tudo em try/catch: em
 * modo privado o storage pode falhar e a app tem de continuar a funcionar.
 */
export const PDA_TOKEN_KEY = "mp.pda.deviceToken";
const CLAIM_KEY = "mp.pda.claimedFor";
const PENDING_QR_KEY = "mp.pda.pendingQr";

export function getPdaToken(): string | null {
  try { return localStorage.getItem(PDA_TOKEN_KEY); } catch { return null; }
}
export function setPdaToken(token: string): void {
  try { localStorage.setItem(PDA_TOKEN_KEY, token); } catch { /* sem storage */ }
}
/** Já ligámos este aparelho a este utilizador nesta sessão do browser? */
export function claimedFor(userId: number): boolean {
  try { return sessionStorage.getItem(CLAIM_KEY) === String(userId); } catch { return false; }
}
export function markClaimed(userId: number | null): void {
  try {
    if (userId == null) sessionStorage.removeItem(CLAIM_KEY);
    else sessionStorage.setItem(CLAIM_KEY, String(userId));
  } catch { /* sem storage */ }
}
/** QR lido antes do login: guardado para continuar depois de entrar. */
export function setPendingQr(search: string | null): void {
  try {
    if (search) localStorage.setItem(PENDING_QR_KEY, search);
    else localStorage.removeItem(PENDING_QR_KEY);
  } catch { /* sem storage */ }
}
export function getPendingQr(): string | null {
  try { return localStorage.getItem(PENDING_QR_KEY); } catch { return null; }
}
