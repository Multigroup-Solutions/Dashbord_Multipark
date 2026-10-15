/**
 * Ids da árvore da ajuda que mudaram de nome (antigo → novo). Os ids
 * (`pagina` ou `ficheiro.md#slug`) podem estar guardados noutros sítios —
 * Base de conhecimento (`help:<ficheiro>.md#<secção>`), perguntas de teste do
 * eval, histórico do Multis — por isso nunca desaparecem em silêncio: o
 * gerador (scripts/gen-ajuda.ts) guarda todos os que já existiram em
 * server/assistant/knowledgeTreeIds.json e falha se um deixar de existir sem
 * entrada aqui. `findHelpNode`/`openHelpNode` seguem estes aliases.
 *
 * Ao mudar o título de uma secção (ou mover/juntar), acrescenta
 * "ficheiro.md#slug-antigo": "ficheiro.md#slug-novo" (ou a página que ficou).
 */
export const HELP_ID_ALIASES: Readonly<Record<string, string>> = {};
