/**
 * Normalização de EMAIL — a chave de identidade de todo o sistema.
 *
 * Regra única e não-negociável: um email identifica UMA pessoa. Toda a
 * comparação (login, criação de utilizador, matching de submissões do site)
 * tem de passar por aqui, para que `  Joao@Gmail.COM ` e `joao@gmail.com`
 * sejam sempre a mesma identidade.
 *
 * Em SQL, o equivalente é `LOWER(TRIM(coluna)) = <email normalizado>` — não
 * confiar na collation da BD (varia por tabela/servidor).
 */

/** Forma canónica: sem espaços à volta e em minúsculas. */
export function normalizeEmail(email: string | null | undefined): string {
  if (typeof email !== "string") return "";
  return email.trim().toLowerCase();
}

/** Compara dois emails pela forma canónica (ambos vazios → false). */
export function sameEmail(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeEmail(a);
  const nb = normalizeEmail(b);
  return na.length > 0 && na === nb;
}

/**
 * Validação leve — suficiente para rejeitar lixo antes de tocar na BD, sem
 * tentar implementar o RFC 5322 (isso é trabalho do zod `.email()` nas
 * fronteiras de input).
 */
export function isPlausibleEmail(email: string | null | undefined): boolean {
  const e = normalizeEmail(email);
  return e.length > 2 && e.length <= 320 && /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(e);
}
