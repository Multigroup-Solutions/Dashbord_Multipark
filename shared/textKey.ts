/**
 * Regra ÚNICA para comparar texto (decisão do dono, 29 set 2026): para ligar,
 * procurar ou juntar, só contam as letras e os números. Não contam acentos,
 * maiúsculas/minúsculas, apóstrofos, traços, pontos nem espaços a mais.
 *
 *   "João d'Almeida-Sá" · "JOAO DALMEIDA SA" · "joão  dalmeida sá"  → iguais
 *
 * - `matchKey`: a chave compacta (só [a-z0-9]) — para comparar/ligar.
 * - `matchWords`: as palavras (para "primeiro + último nome"); o apóstrofo
 *   cola ("d'Almeida" → "dalmeida"), o resto separa.
 * - `searchText`: texto com espaços simples, para pesquisas "contém".
 * - `textMatches`: pesquisa — cada palavra da pergunta tem de estar no texto
 *   (comparadas pela chave compacta, por isso "dalmeida" encontra "d'Almeida").
 *
 * Emails: `emailKey` (sem espaços, sem acentos, minúsculas; o resto mantém-se,
 * porque os pontos e o "+" contam num email).
 */

const ACCENTS = /[̀-ͯ]/g;
const APOSTROPHES = /['’`´ʼ]/g;

function fold(s: string | null | undefined): string {
  return String(s ?? "").normalize("NFD").replace(ACCENTS, "").toLowerCase()
    .replace(/ß/g, "ss").replace(/æ/g, "ae").replace(/œ/g, "oe").replace(/ø/g, "o").replace(/đ/g, "d").replace(/ł/g, "l");
}

/** Chave compacta: só letras e números, sem acentos, em minúsculas. PURA. */
export function matchKey(s: string | null | undefined): string {
  return fold(s).replace(/[^a-z0-9]+/g, "");
}

/** Palavras normalizadas (o apóstrofo cola; o resto da pontuação separa). PURA. */
export function matchWords(s: string | null | undefined): string[] {
  return fold(s).replace(APOSTROPHES, "").split(/[^a-z0-9]+/).filter(Boolean);
}

/** Texto normalizado com espaços simples (pesquisa, apresentação de chaves). PURA. */
export function searchText(s: string | null | undefined): string {
  return matchWords(s).join(" ");
}

/** Os dois textos são o mesmo (ambos vazios → false). PURA. */
export function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = matchKey(a);
  return ka.length > 0 && ka === matchKey(b);
}

/** Pesquisa: cada palavra da pergunta aparece no texto (comparando chaves compactas). PURA. */
export function textMatches(haystack: string | null | undefined, query: string | null | undefined): boolean {
  const words = matchWords(query);
  if (!words.length) return true;
  const hay = matchKey(haystack);
  return words.every((w) => hay.includes(w));
}

/** Email canónico para comparar: sem espaços, sem acentos, em minúsculas. PURA. */
export function emailKey(s: string | null | undefined): string {
  return fold(s).replace(/\s+/g, "");
}
