/**
 * Gera, a partir de docs/ajuda/*.md (a ajuda vai DENTRO do bundle — o Vercel
 * não tem os .md):
 *
 *   - server/assistant/helpDocs.generated.ts — os ficheiros (Multis v1,
 *     pesquisa global e Base de conhecimento);
 *   - server/assistant/knowledgeTree.generated.ts — a árvore Grupo → Página →
 *     Secção (plano MPV, §3.2; shared/helpTree.ts) e o índice para o prompt.
 *
 * Os marcadores `{{regra:…}}` são trocados pelos valores do código
 * (shared/helpRuleValues.ts) ANTES de gravar: o que as pessoas veem nunca leva
 * o marcador cru. Marcador desconhecido = erro.
 *
 *   pnpm tsx scripts/gen-ajuda.ts
 *
 * Testes (server/assistant/assistant.test.ts e server/helpTree.test.ts) falham
 * se os gerados não corresponderem aos ficheiros.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HELP_INDEX_MAX_TOKENS, HelpTreeError, buildHelpTree, chooseIndexLevel, estimateTokens, findHelpNode, renderHelpIndex, treeIds, treeOutline, type HelpTree } from "../shared/helpTree";
import { HELP_ID_ALIASES } from "../shared/helpIdAliases";
import { renderRuleMarkers } from "../shared/helpRuleValues";

export const AJUDA_DIR = resolve(import.meta.dirname ?? __dirname, "..", "docs", "ajuda");
export const GENERATED_FILE = resolve(import.meta.dirname ?? __dirname, "..", "server", "assistant", "helpDocs.generated.ts");
export const TREE_FILE = resolve(import.meta.dirname ?? __dirname, "..", "server", "assistant", "knowledgeTree.generated.ts");
/** Todos os ids que já existiram (só cresce): um id que desaparece tem de ter alias em shared/helpIdAliases.ts. */
export const IDS_FILE = resolve(import.meta.dirname ?? __dirname, "..", "server", "assistant", "knowledgeTreeIds.json");

/** Os .md tal como estão no disco (com os marcadores). */
export function readAjudaSources(dir = AJUDA_DIR): Array<{ file: string; raw: string }> {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((file) => ({ file, raw: readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n") }));
}

/** Os .md com os marcadores `{{regra:…}}` já trocados pelos valores (o que se grava e se mostra). */
export function readAjudaFiles(dir = AJUDA_DIR): Array<{ file: string; raw: string }> {
  return readAjudaSources(dir).map((f) => ({ file: f.file, raw: renderRuleMarkers(f.raw, f.file) }));
}

export function renderGenerated(files: Array<{ file: string; raw: string }>): string {
  return [
    "// GERADO por scripts/gen-ajuda.ts a partir de docs/ajuda/*.md — não editar à mão.",
    "export const HELP_FILES: ReadonlyArray<{ file: string; raw: string }> = " + JSON.stringify(files, null, 2) + ";",
    "",
  ].join("\n");
}

/** Os ids gravados até agora (vazio se ainda não há ficheiro). */
export function readKnownIds(path = IDS_FILE): string[] {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as string[]) : [];
}

/** Ids antigos que já não existem e não têm alias (com alias para um id que existe). PURA. */
export function missingIds(tree: HelpTree, known: readonly string[], aliases: Readonly<Record<string, string>> = HELP_ID_ALIASES): string[] {
  const now = new Set(treeIds(tree));
  return known.filter((id) => !now.has(id) && !findHelpNode(tree, id, aliases));
}

/** O ficheiro de ids: os conhecidos + os de agora, ordenados. Falha se um id desapareceu sem alias. */
export function renderKnownIds(tree: HelpTree, known: readonly string[]): string {
  const gone = missingIds(tree, known);
  if (gone.length) {
    throw new HelpTreeError(`ids da ajuda que desapareceram: ${gone.slice(0, 10).join(", ")}${gone.length > 10 ? "…" : ""} — acrescenta em shared/helpIdAliases.ts para onde foram (antigo → novo).`);
  }
  return JSON.stringify([...new Set([...known, ...treeIds(tree)])].sort(), null, 1) + "\n";
}

/** A árvore SEM o texto das secções (o texto está no helpDocs; lê-se em execução com server/assistant/knowledgeTree.ts). */
export function renderKnowledgeTree(files: Array<{ file: string; raw: string }>): string {
  const tree = buildHelpTree(files);
  const level = chooseIndexLevel(tree);
  const index = renderHelpIndex(tree, level);
  return [
    "// GERADO por scripts/gen-ajuda.ts a partir de docs/ajuda/*.md — não editar à mão.",
    "// Árvore da ajuda (Grupo do menu → Página → Secção), plano MPV §3.2.",
    'import type { HelpTreeOutline } from "../../shared/helpTree";',
    "",
    `/** Nível do índice que cabe no teto de ${HELP_INDEX_MAX_TOKENS} tokens ("sections" = com os títulos das secções). */`,
    `export const KNOWLEDGE_INDEX_LEVEL: "sections" | "pages" = ${JSON.stringify(level)};`,
    `/** Índice para o prompt estável (≈ ${estimateTokens(index)} tokens). */`,
    `export const KNOWLEDGE_INDEX: string = ${JSON.stringify(index)};`,
    "",
    "/** Estrutura da árvore (sem o texto das secções; `chars` = tamanho). O texto: knowledgeTree() em server/assistant/knowledgeTree.ts. */",
    "export const KNOWLEDGE_OUTLINE: HelpTreeOutline = " + JSON.stringify(treeOutline(tree), null, 1) + ";",
    "",
  ].join("\n");
}

if (process.argv[1] && /gen-ajuda\.ts$/.test(process.argv[1])) {
  const files = readAjudaFiles();
  writeFileSync(GENERATED_FILE, renderGenerated(files));
  console.log(`Escrito ${GENERATED_FILE}`);
  writeFileSync(TREE_FILE, renderKnowledgeTree(files));
  console.log(`Escrito ${TREE_FILE}`);
  writeFileSync(IDS_FILE, renderKnownIds(buildHelpTree(files), readKnownIds()));
  console.log(`Escrito ${IDS_FILE}`);
}
