/**
 * `users.lastSignedIn` era escrito em CADA pedido autenticado (um UPDATE por
 * chamada tRPC). Passa a ser escrito no máximo uma vez a cada 5 minutos,
 * comparando em memória com a linha do utilizador já carregada.
 *
 * O valor é gravado como 'YYYY-MM-DD HH:MM:SS' em UTC (ver sdk.ts).
 */
export const LAST_SIGNED_IN_THROTTLE_MS = 5 * 60_000;

export function parseLastSignedIn(value: unknown): number | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value !== "string" || !value.trim()) return null;
  const s = value.trim().replace(" ", "T");
  const hasZone = /(?:[zZ]|[+-]\d\d:?\d\d)$/.test(s);
  const t = Date.parse(hasZone ? s : `${s}Z`);
  return Number.isNaN(t) ? null : t;
}

/** Pura: deve atualizar-se o lastSignedIn agora? */
export function shouldTouchLastSignedIn(last: unknown, now: number = Date.now(), intervalMs = LAST_SIGNED_IN_THROTTLE_MS): boolean {
  const t = parseLastSignedIn(last);
  if (t == null) return true;
  // Valor no futuro (relógio/fuso estranho): corrige em vez de ficar preso.
  if (t - now > intervalMs) return true;
  return now - t >= intervalMs;
}
