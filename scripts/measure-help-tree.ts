/**
 * Medição da árvore da ajuda (plano MPV, §3.2) — corre ANTES e depois de
 * mexer na ajuda:
 *
 *   pnpm tsx scripts/measure-help-tree.ts
 *
 * Conta as secções de cada ficheiro pela regra única (`##`/`###` e linhas só a
 * negrito — shared/helpTree.ts) e estima os tokens do índice (caracteres / 3,8)
 * nos dois níveis: só páginas (Grupo → Página + 1 frase) e com os títulos das
 * secções. Não precisa do cabeçalho novo (grupo/pagina): usa o ficheiro como
 * página quando falta.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HELP_INDEX_MAX_TOKENS, buildHelpTree, chooseIndexLevel, estimateTokens, firstSentence, renderHelpIndex, shortTitle, splitFrontMatter, splitSections } from "../shared/helpTree";
import { renderRuleMarkers } from "../shared/helpRuleValues";

const DIR = resolve(import.meta.dirname ?? __dirname, "..", "docs", "ajuda");

const rows = readdirSync(DIR)
  .filter((f) => f.endsWith(".md"))
  .sort()
  .map((file) => {
    const raw = renderRuleMarkers(readFileSync(join(DIR, file), "utf8").replace(/\r\n/g, "\n"), file);
    const { head, body } = splitFrontMatter(raw);
    const title = head.titulo || file;
    const sections = splitSections(file, body, title);
    const real = sections.filter((s) => s.level > 1);
    const summary = sections[0]?.level === 1 ? sections[0].summary : firstSentence(body);
    const page = `- ${head.pagina || file.replace(/\.md$/, "")}: ${title}${head.rotas ? ` [${head.rotas}]` : ""}${summary ? ` — ${summary}` : ""}`;
    const withSections = real.length ? `${page}\n  ${real.map((s) => shortTitle(s.title)).join(" · ")}` : page;
    return {
      file,
      group: head.grupo || "(sem grupo)",
      chars: raw.length,
      sections: real.length,
      byLevel: { h2: real.filter((s) => s.level === 2).length, h3: real.filter((s) => s.level === 3).length, bold: real.filter((s) => s.level === 4).length },
      biggest: Math.max(0, ...sections.map((s) => s.text.length)),
      page,
      withSections,
    };
  });

const groups = [...new Set(rows.map((r) => r.group))];
const pagesIndex = groups.map((g) => `## ${g}\n${rows.filter((r) => r.group === g).map((r) => r.page).join("\n")}`).join("\n");
const sectionsIndex = groups.map((g) => `## ${g}\n${rows.filter((r) => r.group === g).map((r) => r.withSections).join("\n")}`).join("\n");

console.log("ficheiro".padEnd(30), "car.".padStart(7), "secções".padStart(8), "##".padStart(4), "###".padStart(4), "neg.".padStart(5), "maior".padStart(7));
for (const r of rows) {
  console.log(r.file.padEnd(30), String(r.chars).padStart(7), String(r.sections).padStart(8), String(r.byLevel.h2).padStart(4), String(r.byLevel.h3).padStart(4), String(r.byLevel.bold).padStart(5), String(r.biggest).padStart(7));
}
const total = rows.reduce((s, r) => s + r.sections, 0);
const noSections = rows.filter((r) => r.sections === 0).map((r) => r.file);
console.log("");
console.log(`Ficheiros: ${rows.length} · caracteres: ${rows.reduce((s, r) => s + r.chars, 0)} · secções: ${total}`);
console.log(`Sem nenhuma secção: ${noSections.length ? noSections.join(", ") : "nenhum"}`);
console.log(`Índice só com páginas: ${pagesIndex.length} car. ≈ ${estimateTokens(pagesIndex)} tokens`);
console.log(`Índice com as secções: ${sectionsIndex.length} car. ≈ ${estimateTokens(sectionsIndex)} tokens`);
console.log(`Teto: ${HELP_INDEX_MAX_TOKENS} tokens → nível do índice: ${estimateTokens(sectionsIndex) <= HELP_INDEX_MAX_TOKENS ? "secções" : "só páginas (secções com ajuda_abrir(pagina))"}`);

// Com o cabeçalho novo em todos os ficheiros: o índice tal como o gerador o grava.
try {
  const tree = buildHelpTree(readdirSync(DIR).filter((f) => f.endsWith(".md")).sort().map((file) => ({ file, raw: renderRuleMarkers(readFileSync(join(DIR, file), "utf8").replace(/\r\n/g, "\n"), file) })));
  const pages = tree.groups.reduce((n, g) => n + g.pages.length, 0);
  const secs = tree.groups.reduce((n, g) => n + g.pages.reduce((m, p) => m + p.sections.length, 0), 0);
  const p = renderHelpIndex(tree, "pages"), s = renderHelpIndex(tree, "sections");
  console.log(`Árvore (gerador): ${tree.groups.length} grupos · ${pages} páginas · ${secs} secções (com as de início)`);
  console.log(`  índice só páginas ≈ ${estimateTokens(p)} tokens · com secções ≈ ${estimateTokens(s)} tokens → ${chooseIndexLevel(tree)}`);
} catch (err) {
  console.log(`Árvore (gerador): ainda não dá — ${(err as Error).message}`);
}
