/**
 * Gera server/assistant/helpDocs.generated.ts a partir de docs/ajuda/*.md
 * (a ajuda do assistente vai DENTRO do bundle — o Vercel não tem os .md).
 *
 *   pnpm tsx scripts/gen-ajuda.ts
 *
 * Um teste (server/assistant/assistant.test.ts) falha se o gerado não
 * corresponder aos ficheiros.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const AJUDA_DIR = resolve(import.meta.dirname ?? __dirname, "..", "docs", "ajuda");
export const GENERATED_FILE = resolve(import.meta.dirname ?? __dirname, "..", "server", "assistant", "helpDocs.generated.ts");

export function readAjudaFiles(dir = AJUDA_DIR): Array<{ file: string; raw: string }> {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((file) => ({ file, raw: readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n") }));
}

export function renderGenerated(files: Array<{ file: string; raw: string }>): string {
  return [
    "// GERADO por scripts/gen-ajuda.ts a partir de docs/ajuda/*.md — não editar à mão.",
    "export const HELP_FILES: ReadonlyArray<{ file: string; raw: string }> = " + JSON.stringify(files, null, 2) + ";",
    "",
  ].join("\n");
}

if (process.argv[1] && /gen-ajuda\.ts$/.test(process.argv[1])) {
  writeFileSync(GENERATED_FILE, renderGenerated(readAjudaFiles()));
  console.log(`Escrito ${GENERATED_FILE}`);
}
