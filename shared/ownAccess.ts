/**
 * Lote 46 (Jorge, 7 out 2026): "eles entram, supostamente são utilizadores e
 * deviam de poder ir à ficha deles e pôr as disponibilidades, e não
 * conseguem". O que é de cada um (a ficha, a disponibilidade) abre a TODOS os
 * papéis (shared/access.ts: ficha e disponibilidade = own:ve). Quando não abre,
 * a causa é quase sempre uma de duas e a pessoa tem de saber qual:
 *   1. a conta Google com que entrou não está ligada a nenhuma ficha (email
 *      diferente do da ficha) — o login é SÓ com a Google e tem de ser sempre
 *      com o mesmo email;
 *   2. a ficha não tem cidade (centro de custos).
 * Textos e regras PURAS, usadas no servidor e no ecrã.
 */
import { normalizeEmail } from "./email";
import { matchWords } from "./textKey";

/** Conta sem ficha: diz QUAL é a conta Google e o que fazer. PURA. */
export function noLinkedRecordMessage(email: string | null | undefined): string {
  const e = normalizeEmail(email);
  return e
    ? `A tua conta Google ${e} não está ligada a nenhuma ficha. Pede ao RH para pôr este email na tua ficha (ou entra sempre com o email que está na ficha).`
    : "A tua conta Google não está ligada a nenhuma ficha. Pede ao RH para pôr o teu email na tua ficha.";
}

/** Ficha sem cidade (centro de custos): o que é da pessoa abre na mesma. */
export const NO_CITY_OWN_MESSAGE =
  "A tua ficha ainda não tem cidade (centro de custos). Pede ao RH para pôr a tua cidade na ficha. Entretanto abres na mesma a tua ficha e a tua disponibilidade.";

/**
 * Página que a pessoa não pode abrir, mas cujo "seu" lado está noutra página
 * (ex.: um extra que vai ao Extras Dia para pôr a disponibilidade). Continua a
 * ser "Sem acesso" (lote 20d: nunca saltar em silêncio) — com um atalho. PURA.
 */
const OWN_SIDE_OF: Record<string, { to: string; label: string; text: string }> = {
  "/extras-dia": {
    to: "/disponibilidade",
    label: "Abrir a minha disponibilidade",
    text: "A escala do Extras Dia é da gestão. A tua disponibilidade marcas na página Disponibilidade.",
  },
};

export function noAccessHint(path: string, allowedPaths: ReadonlySet<string>): { to: string; label: string; text: string } | null {
  const base = "/" + (String(path ?? "").split("?")[0].split("/")[1] ?? "");
  const hint = OWN_SIDE_OF[base];
  return hint && allowedPaths.has(hint.to) ? hint : null;
}

/** Ficha → conta: as contas de login que podem ser desta pessoa (sem ficha). */
export interface LoginCandidateInput { name: string | null; email: string | null }

const words = (s: string | null | undefined) => matchWords(s).filter((w) => w.length >= 3);

/**
 * Porque é que esta conta SEM ficha parece ser a pessoa da ficha (ou null).
 * Só sugere — ligar é sempre uma pessoa do RH (nunca junta sozinho). PURA.
 *  - mesmo email (profissional ou pessoal da ficha);
 *  - pelo menos dois nomes em comum (nome da conta Google ou parte antes do @).
 */
export function loginCandidateReason(ficha: { fullName: string; emails: ReadonlyArray<string | null | undefined> }, account: LoginCandidateInput): string | null {
  const email = normalizeEmail(account.email);
  if (email && ficha.emails.some((e) => normalizeEmail(e) === email)) return "mesmo email da ficha";
  const fichaWords = new Set(words(ficha.fullName));
  if (fichaWords.size < 2) return null;
  const local = (account.email ?? "").split("@")[0].replace(/\d+/g, " ");
  const accountWords = new Set([...words(account.name), ...words(local)]);
  const common = Array.from(fichaWords).filter((w) => accountWords.has(w));
  return common.length >= 2 ? `nome parecido (${common.join(", ")})` : null;
}
