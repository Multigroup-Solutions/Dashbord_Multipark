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
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HELP_INDEX_MAX_TOKENS, buildHelpTree, chooseIndexLevel, estimateTokens, renderHelpIndex } from "../shared/helpTree";
import { renderRuleMarkers } from "../shared/helpRuleValues";

export const AJUDA_DIR = resolve(import.meta.dirname ?? __dirname, "..", "docs", "ajuda");
export const GENERATED_FILE = resolve(import.meta.dirname ?? __dirname, "..", "server", "assistant", "helpDocs.generated.ts");
export const TREE_FILE = resolve(import.meta.dirname ?? __dirname, "..", "server", "assistant", "knowledgeTree.generated.ts");

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

export function renderKnowledgeTree(files: Array<{ file: string; raw: string }>): string {
  const tree = buildHelpTree(files);
  const level = chooseIndexLevel(tree);
  const index = renderHelpIndex(tree, level);
  return [
    "// GERADO por scripts/gen-ajuda.ts a partir de docs/ajuda/*.md — não editar à mão.",
    "// Árvore da ajuda (Grupo do menu → Página → Secção), plano MPV §3.2.",
    'import type { HelpTree } from "../../shared/helpTree";',
    "",
    `/** Nível do índice que cabe no teto de ${HELP_INDEX_MAX_TOKENS} tokens ("sections" = com os títulos das secções). */`,
    `export const KNOWLEDGE_INDEX_LEVEL: "sections" | "pages" = ${JSON.stringify(level)};`,
    `/** Índice para o prompt estável (≈ ${estimateTokens(index)} tokens). */`,
    `export const KNOWLEDGE_INDEX: string = ${JSON.stringify(index)};`,
    "",
    "export const KNOWLEDGE_TREE: HelpTree = " + JSON.stringify(tree, null, 2) + ";",
    "",
  ].join("\n");
}

if (process.argv[1] && /gen-ajuda\.ts$/.test(process.argv[1])) {
  const files = readAjudaFiles();
  writeFileSync(GENERATED_FILE, renderGenerated(files));
  console.log(`Escrito ${GENERATED_FILE}`);
  writeFileSync(TREE_FILE, renderKnowledgeTree(files));
  console.log(`Escrito ${TREE_FILE}`);
}
