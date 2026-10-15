/**
 * Identidade do aparelho PDA neste browser (Fase 2). O token é guardado quando
 * o aparelho é registado (QR ou escolha na aba PDAs). Tudo em try/catch: em
 * modo privado o storage pode falhar e a app tem de continuar a funcionar.
 */
import { PERSONAL_TOKEN_KEY } from "@shared/personalDevice";

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

// ─── Telemóvel pessoal (não é um PDA partilhado; shared/personalDevice.ts) ───
// Outra chave e outra tabela: os fluxos do PDA (ligar no login, sessão de PDA,
// ponto→PDA, Google a pedir a conta) nunca veem este token.
/** Avisa os cartões "Este telemóvel" quando o registo deste aparelho muda. */
export const DEVICE_CHANGED_EVENT = "mp:device-changed";
const changed = () => { try { window.dispatchEvent(new Event(DEVICE_CHANGED_EVENT)); } catch { /* sem window */ } };

export function getPersonalToken(): string | null {
  try { return localStorage.getItem(PERSONAL_TOKEN_KEY); } catch { return null; }
}
export function setPersonalToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(PERSONAL_TOKEN_KEY, token);
    else localStorage.removeItem(PERSONAL_TOKEN_KEY);
  } catch { /* sem storage */ }
  changed();
}
/**
 * Um PDA convertido em telemóvel pessoal (por uma chefia): o token passa da
 * chave do PDA para a do telemóvel pessoal — o aparelho deixa de ser PDA aqui.
 */
export function movePdaTokenToPersonal(token: string): void {
  try {
    localStorage.setItem(PERSONAL_TOKEN_KEY, token);
    if (localStorage.getItem(PDA_TOKEN_KEY) === token) localStorage.removeItem(PDA_TOKEN_KEY);
  } catch { /* sem storage */ }
  markClaimed(null);
  changed();
}
