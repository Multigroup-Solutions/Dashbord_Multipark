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
import { matchKey, searchText } from "./textKey";

export function normalizeSearchText(raw: string | null | undefined): string {
  // Regra única (shared/textKey.ts): sem acentos, maiúsculas, apóstrofos nem traços.
  return searchText(raw);
}

function digitsOnly(raw: string | null | undefined): string {
  return String(raw ?? "").replace(/\D/g, "");
}

export interface SearchableContact {
  name?: string | null;
  phone?: string | null;
}

export function matchesContactQuery(query: string, contact: SearchableContact): boolean {
  if (!String(query ?? "").trim()) return true;
  const tokens = normalizeSearchText(query).split(" ").filter(Boolean);
  if (!tokens.length) return false; // só pontuação: nada a procurar

  // Nome comparado pela chave compacta: "almeidasa" encontra "Almeida-Sá".
  const name = matchKey(contact.name);
  const phoneDigits = digitsOnly(contact.phone);

  return tokens.every((tok) => {
    if (name && name.includes(tok)) return true;
    // "00351…" é a forma de marcação de "+351…" — o número guardado não tem o 00.
    const tokDigits = digitsOnly(tok).replace(/^00/, "");
    return tokDigits.length > 0 && phoneDigits.includes(tokDigits);
  });
}

/**
 * 44a: relevância de um nome para a pesquisa — serve para ORDENAR (o filtro
 * continua a ser `matchesContactQuery`). Jorge: "começa sempre com o A e o B"
 * — quem começa pelo que se escreveu tem de vir primeiro.
 *   3 = o nome começa pela pesquisa ("ana s" → "Ana Silva");
 *   2 = cada palavra da pesquisa começa uma palavra do nome ("sil ana" → "Ana Rita Silva");
 *   1 = aparece no meio ("ana" → "Mariana");
 *   0 = não bate.
 * Pesquisa vazia → 1 (tudo igual, fica a ordem que já havia). PURA.
 */
export function nameMatchScore(query: string, name: string | null | undefined): number {
  const q = normalizeSearchText(query);
  if (!q) return 1;
  const n = normalizeSearchText(name);
  if (!n) return 0;
  if (n.startsWith(q)) return 3;
  const words = n.split(" ");
  if (q.split(" ").every((t) => words.some((w) => w.startsWith(t)))) return 2;
  return matchesContactQuery(query, { name }) ? 1 : 0;
}

/** Ordena por relevância (estável: empates mantêm a ordem de entrada). PURA. */
export function sortByNameMatch<T>(query: string, rows: readonly T[], nameOf: (r: T) => string | null | undefined): T[] {
  if (!normalizeSearchText(query)) return rows.slice();
  return rows
    .map((r, i) => ({ r, i, s: nameMatchScore(query, nameOf(r)) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.r);
}
