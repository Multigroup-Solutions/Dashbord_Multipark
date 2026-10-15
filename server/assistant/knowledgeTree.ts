/**
 * A árvore da ajuda em execução (plano MPV, §3.2). O ficheiro gerado
 * (knowledgeTree.generated.ts) só tem a estrutura e o índice; o texto das
 * secções sai do helpDocs.generated.ts (o mesmo texto que o Multis v1, a
 * pesquisa e a Base de conhecimento usam), lido uma vez por instância com o
 * mesmo leitor do gerador — o bundle não leva a ajuda duas vezes.
 */
import { buildHelpTree, openHelpNode, pagesForPath, sectionForTab, type HelpTree, type HelpTreePage, type HelpTreeSection } from "../../shared/helpTree";
import { HELP_ID_ALIASES } from "../../shared/helpIdAliases";
import { HELP_FILES } from "./helpDocs.generated";

export { KNOWLEDGE_INDEX, KNOWLEDGE_INDEX_LEVEL, KNOWLEDGE_OUTLINE } from "./knowledgeTree.generated";

let memo: HelpTree | null = null;

/** A árvore completa (com o texto), construída na 1.ª chamada. */
export function knowledgeTree(): HelpTree {
  if (!memo) memo = buildHelpTree(HELP_FILES);
  return memo;
}

/** O que `ajuda_abrir(id)` mostra (página → secções; contentor → filhos; secção → texto). */
export function openKnowledge(id: string): { id: string; title: string; text: string } | null {
  return openHelpNode(knowledgeTree(), id, HELP_ID_ALIASES);
}

/** A página da ajuda do caminho aberto (a mais específica) e a secção do separador, se houver. */
export function knowledgeForPage(path: string | null | undefined, tab?: string | null): { page: HelpTreePage; tabSection: HelpTreeSection | null } | null {
  const page = pagesForPath(knowledgeTree(), path)[0];
  return page ? { page, tabSection: sectionForTab(page, tab) } : null;
}
