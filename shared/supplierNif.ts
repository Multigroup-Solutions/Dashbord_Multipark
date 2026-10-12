/**
 * NIF do fornecedor de uma despesa (cliente + servidor). Aceita o que as
 * pessoas escrevem e o que a IA lê do talão: "PT 500 697 370", "500.697.370",
 * "IE6388047V". Os NIF portugueses (9 dígitos) têm de ter o dígito de controlo
 * certo; os estrangeiros (2 letras + 2 a 14 letras/dígitos) passam como estão.
 * Tudo PURO.
 */

/** NIF português: 9 dígitos com o dígito de controlo válido. */
export function isValidPtNif(d: string): boolean {
  if (!/^\d{9}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += Number(d[i]) * (9 - i);
  const check = 11 - (sum % 11);
  return (check >= 10 ? 0 : check) === Number(d[8]);
}

export const SUPPLIER_NIF_INVALID = "NIF inválido — confirma os 9 dígitos ou apaga-o.";

/** Vazio → `nif: null`; válido → normalizado (sem espaços nem "PT"); senão → erro. */
export function normalizeSupplierNif(raw: string | null | undefined): { ok: true; nif: string | null } | { ok: false; message: string } {
  let s = String(raw ?? "").toUpperCase().replace(/[\s.\-/]/g, "");
  if (!s || s === "NULL" || s === "UNDEFINED") return { ok: true, nif: null };
  if (/^PT\d{9}$/.test(s)) s = s.slice(2);
  if (/^\d+$/.test(s)) return isValidPtNif(s) ? { ok: true, nif: s } : { ok: false, message: SUPPLIER_NIF_INVALID };
  if (/^[A-Z]{2}[A-Z0-9]{2,14}$/.test(s)) return { ok: true, nif: s };
  return { ok: false, message: SUPPLIER_NIF_INVALID };
}
