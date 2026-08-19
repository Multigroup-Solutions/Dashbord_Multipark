/**
 * Pesquisa de contactos (nome OU número) — puro e partilhado cliente/servidor.
 *
 * Regras:
 * - Texto comparado sem acentos e sem maiúsculas ("joao" encontra "João").
 * - Cada palavra da pesquisa tem de bater no nome OU no número (AND entre
 *   palavras, OR entre campos): "joao 912" encontra o João cujo número tem 912.
 * - Número comparado só por dígitos: "912 345", "+351912", "00351 912" são o
 *   mesmo que "351912".
 * - Pesquisa vazia → tudo passa.
 */

export function normalizeSearchText(raw: string | null | undefined): string {
  return String(raw ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function digitsOnly(raw: string | null | undefined): string {
  return String(raw ?? "").replace(/\D/g, "");
}

export interface SearchableContact {
  name?: string | null;
  phone?: string | null;
}

export function matchesContactQuery(query: string, contact: SearchableContact): boolean {
  const tokens = normalizeSearchText(query).split(" ").filter(Boolean);
  if (!tokens.length) return true;

  const name = normalizeSearchText(contact.name);
  const phoneDigits = digitsOnly(contact.phone);

  return tokens.every((tok) => {
    if (name && name.includes(tok)) return true;
    // "00351…" é a forma de marcação de "+351…" — o número guardado não tem o 00.
    const tokDigits = digitsOnly(tok).replace(/^00/, "");
    return tokDigits.length > 0 && phoneDigits.includes(tokDigits);
  });
}
