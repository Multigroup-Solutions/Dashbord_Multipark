/**
 * IBAN / NIB (P3 lote 19c). PURO — usado pelo servidor (validação, registos
 * mascarados) e pelo cliente (formulário, "mostrar").
 *
 *  - aceita IBAN com espaços/hífenes e o NIB português de 21 dígitos (vira
 *    PT50 + NIB — o IBAN português é sempre isso);
 *  - valida o dígito de controlo (mod 97) e o comprimento do país (PT = 25);
 *  - nos registos e no ecrã aparece mascarado: "PT50 •••• 1234".
 */

const COUNTRY_LENGTH: Record<string, number> = {
  PT: 25, ES: 24, FR: 27, DE: 22, IT: 27, BE: 16, NL: 18, LU: 20, IE: 22, GB: 22, CH: 21, AT: 20, BR: 29, RO: 24, PL: 28,
};

/** Forma compacta em maiúsculas; 21 dígitos (NIB) → PT50 + NIB. PURA. */
export function normalizeIban(raw: string | null | undefined): string {
  const s = String(raw ?? "").replace(/[\s.\-]/g, "").toUpperCase();
  if (/^\d{21}$/.test(s)) return `PT50${s}`;
  return s;
}

/** Dígito de controlo mod 97 (ISO 13616). PURA. */
function mod97(iban: string): number {
  const re = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of re) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem;
}

/** Erro do IBAN em português, ou null se for válido. PURA. */
export function ibanError(raw: string | null | undefined): string | null {
  const iban = normalizeIban(raw);
  if (!iban) return "IBAN em falta.";
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return "IBAN inválido: começa por duas letras do país (ex.: PT50) seguidas de números.";
  const len = COUNTRY_LENGTH[iban.slice(0, 2)];
  if (len && iban.length !== len) return `IBAN inválido: um IBAN ${iban.slice(0, 2)} tem ${len} caracteres (este tem ${iban.length}).`;
  if (mod97(iban) !== 1) return "IBAN inválido: o número de controlo não bate certo (confirma os dígitos).";
  return null;
}

export const isValidIban = (raw: string | null | undefined) => ibanError(raw) == null;

/** "PT50 •••• 1234" (país + controlo + 4 últimos). Vazio → "—". PURA. */
export function maskIban(raw: string | null | undefined): string {
  const s = normalizeIban(raw);
  if (!s) return "—";
  if (s.length <= 8) return "••••";
  return `${s.slice(0, 4)} •••• ${s.slice(-4)}`;
}

/** IBAN em grupos de 4 ("PT50 0002 0123 …"). PURA. */
export function formatIban(raw: string | null | undefined): string {
  return normalizeIban(raw).replace(/(.{4})/g, "$1 ").trim();
}

/** "••••••123" — NIF mascarado (3 últimos). PURA. */
export function maskNif(raw: string | null | undefined): string {
  const s = String(raw ?? "").replace(/\s/g, "");
  if (!s) return "—";
  return s.length <= 3 ? "•••" : `${"•".repeat(Math.max(3, s.length - 3))}${s.slice(-3)}`;
}

/** O mesmo IBAN (ignora espaços, maiúsculas e NIB vs IBAN PT)? PURA. */
export function sameIban(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeIban(a) === normalizeIban(b);
}
