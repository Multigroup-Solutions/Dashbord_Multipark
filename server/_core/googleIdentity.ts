/**
 * Só aceitamos o email da Google quando a própria Google o dá como
 * VERIFICADO — o email liga a conta a utilizadores e fichas (identidade),
 * portanto um email por verificar não pode abrir sessão.
 */
export function isGoogleEmailVerified(info: { email?: string | null; email_verified?: unknown }): boolean {
  const v = info.email_verified;
  return v === true || (typeof v === "string" && v.trim().toLowerCase() === "true");
}

/** Pura: recusa o login? (há email mas a Google não o verificou) */
export function shouldRejectUnverifiedGoogleEmail(info: { email?: string | null; email_verified?: unknown }): boolean {
  const email = (info.email ?? "").trim();
  if (!email) return false;
  return !isGoogleEmailVerified(info);
}
