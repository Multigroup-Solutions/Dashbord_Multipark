/**
 * Navegação na árvore da ajuda (plano MPV §3.2, F3) — só no MPV:
 *
 *  - `ajuda_abrir(id)`: página → a lista das secções (com os ids); secção →
 *    o texto (e as subsecções por baixo); secção só de arrumação → a lista
 *    das subsecções. Segue os ids antigos (shared/helpIdAliases.ts).
 *  - `ajuda_procurar(texto)`: ids + título + resumo das secções mais
 *    próximas (a mesma pesquisa lexical do v1 — palavras e prefixos —, mas
 *    POR SECÇÃO em vez de por ficheiro).
 *
 * Substituem o `abrir_ajuda` no MPV (o v1 fica com o `abrir_ajuda`).
 *
 * Visibilidade: a página da ajuda de um módulo que a pessoa não pode ver não
 * aparece (nem na pesquisa, nem a abrir, nem no bloco da pergunta). Módulos
 * que não são do mapa de acessos (ex.: "multis", "ia") e a página da entrada
 * ficam para toda a gente.
 *
 * Nenhuma chama IA; só leem a ajuda que vem no bundle. O texto devolvido
 * declara-se em `pii` (redação única do turno, F0b) — a ajuda não tem dados
 * pessoais, mas passa pelo mesmo caminho que tudo o resto.
 */
import { MODULE_IDS, can, type ModuleId } from "../../shared/access";
import { HELP_ID_ALIASES } from "../../shared/helpIdAliases";
import { findHelpNode, openHelpNode, splitFrontMatter, treePages, type HelpTree, type HelpTreePage, type HelpTreeSection } from "../../shared/helpTree";
import { excerptHelp, tokens } from "../_core/ai/chat/retrieval";
import { ToolUserError, type ChatTool } from "../_core/ai/chat/tools";
import { HELP_FILES } from "./helpDocs.generated";
import { knowledgeTree } from "./knowledgeTree";
import type { StaffToolCtx, StaffUser } from "./tools";

// ─── Visibilidade ────────────────────────────────────────────────────────────

/** Páginas da ajuda que toda a gente vê, seja qual for o módulo (entrar, menu, "Sem acesso"). */
export const HELP_ALWAYS_VISIBLE: readonly string[] = ["dashboards.entrada"];

const MODULES = new Set<string>(MODULE_IDS);

/** A pessoa pode ver a ajuda desta página? PURA. */
export function canSeeHelpPage(user: StaffUser, page: Pick<HelpTreePage, "id" | "module">): boolean {
  if (HELP_ALWAYS_VISIBLE.includes(page.id)) return true;
  if (!MODULES.has(page.module)) return true;
  try {
    return can(user, page.module as ModuleId, "view");
  } catch {
    return false;
  }
}

// ─── Texto de uma secção ─────────────────────────────────────────────────────

/**
 * O texto de uma secção COM as subsecções (cada uma com o título a negrito) —
 * um `##` só com `###` por baixo tem o conteúdo todo nos filhos. PURA.
 */
export function sectionFullText(page: HelpTreePage, section: HelpTreeSection): string {
  const byId = new Map(page.sections.map((s) => [s.id, s]));
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (s: HelpTreeSection, depth: number) => {
    if (seen.has(s.id) || depth > 6) return;
    seen.add(s.id);
    if (depth > 0) out.push(`**${s.title}**`);
    if (s.text) out.push(s.text);
    for (const id of s.children) {
      const c = byId.get(id);
      if (c) walk(c, depth + 1);
    }
  };
  walk(section, 0);
  return out.join("\n\n").trim();
}

/** Os ids da secção e de todas as subsecções (para não repetir no bloco da pergunta). PURA. */
export function sectionSubtreeIds(page: HelpTreePage, section: HelpTreeSection): Set<string> {
  const byId = new Map(page.sections.map((s) => [s.id, s]));
  const out = new Set<string>();
  const walk = (s: HelpTreeSection) => {
    if (out.has(s.id)) return;
    out.add(s.id);
    for (const id of s.children) {
      const c = byId.get(id);
      if (c) walk(c);
    }
  };
  walk(section);
  return out;
}

/**
 * Recorte de uma secção grande para a pergunta (excerptHelp), mas com as
 * tabelas e listas compridas partidas em linhas: o excerptHelp escolhe por
 * parágrafos, e uma tabela inteira (ex.: a do agendador, ~10 000 car.) é um
 * só parágrafo — sem isto ficava só o início. O cabeçalho de uma tabela vai
 * com a 1.ª linha. Cabe inteira → inteira. PURA.
 */
export function excerptSection(text: string, maxChars: number, question: string): string {
  if (text.length <= maxChars) return text;
  const long = maxChars / 3;
  const split = text
    .split(/\n{2,}/)
    .map((p) => {
      if (p.length <= long || !p.includes("\n")) return p;
      const lines = p.split("\n");
      const table = lines.length > 2 && /^\s*\|/.test(lines[0]) && /^\s*\|?\s*:?-{2,}/.test(lines[1]);
      return (table ? [lines.slice(0, 3).join("\n"), ...lines.slice(3)] : lines).join("\n\n");
    })
    .join("\n\n");
  return excerptHelp(split, maxChars, question);
}

// ─── Pesquisa lexical por secção ─────────────────────────────────────────────

const stem5 = (w: string) => (w.length > 5 ? w.slice(0, 5) : w);
const stems = (s: string) => new Set(tokens(s).map(stem5));

interface IndexedSection {
  page: HelpTreePage;
  section: HelpTreeSection;
  /** Título da secção (na introdução, o da página). */
  title: Set<string>;
  /** Título da página (vale menos: é igual em todas as secções da página). */
  pageTitle: Set<string>;
  text: Set<string>;
  keywords: Set<string>;
}

const indexMemo = new WeakMap<HelpTree, IndexedSection[]>();

/** Palavras-chave do cabeçalho de cada ficheiro (`palavras:`). */
let keywordsMemo: Map<string, Set<string>> | null = null;
function fileKeywords(): Map<string, Set<string>> {
  if (!keywordsMemo) {
    keywordsMemo = new Map(HELP_FILES.map((f) => [f.file, stems(splitFrontMatter(f.raw).head.palavras ?? "")]));
  }
  return keywordsMemo;
}

function sectionIndex(tree: HelpTree): IndexedSection[] {
  let idx = indexMemo.get(tree);
  if (!idx) {
    const kw = fileKeywords();
    idx = treePages(tree).flatMap((page) => page.sections.map((section) => ({
      page, section,
      title: stems(section.level === 1 ? page.title : section.title),
      pageTitle: stems(page.title),
      text: stems(`${section.summary} ${section.text}`),
      keywords: kw.get(page.file) ?? new Set<string>(),
    })));
    indexMemo.set(tree, idx);
  }
  return idx;
}

export interface HelpSectionHit {
  page: HelpTreePage;
  section: HelpTreeSection;
  score: number;
}

/**
 * As secções mais próximas da pergunta (palavras e prefixos de 5 letras,
 * como o v1): título da secção ×3, título da página ×1, texto ×1,
 * palavras-chave da página ×0,5, +1 se for da página aberta. Só as que chegam a 2 pontos e a metade da
 * melhor. Secções sem texto nem subsecções ficam de fora; `withText`: só as
 * que têm texto próprio ou subsecções com texto (para o bloco da pergunta). PURA.
 */
export function searchHelpSections(
  tree: HelpTree,
  question: string,
  opts: { canSee?: (page: HelpTreePage) => boolean; currentPage?: string | null; exclude?: ReadonlySet<string>; max?: number } = {},
): HelpSectionHit[] {
  const qs = [...stems(question)];
  if (!qs.length) return [];
  const max = Math.max(1, opts.max ?? 8);
  const scored: HelpSectionHit[] = [];
  for (const it of sectionIndex(tree)) {
    if (opts.exclude?.has(it.section.id)) continue;
    if (!it.section.text && !it.section.children.length) continue;
    if (opts.canSee && !opts.canSee(it.page)) continue;
    let title = 0, pageTitle = 0, text = 0, kw = 0;
    for (const w of qs) {
      if (it.title.has(w)) title++;
      else if (it.pageTitle.has(w)) pageTitle++;
      if (it.text.has(w)) text++;
      if (it.keywords.has(w)) kw++;
    }
    if (!title && !text) continue;
    const score = 3 * title + pageTitle + text + 0.5 * kw + (opts.currentPage && it.page.id === opts.currentPage ? 1 : 0);
    if (score >= 2) scored.push({ page: it.page, section: it.section, score });
  }
  scored.sort((a, b) => b.score - a.score || a.section.text.length - b.section.text.length || a.section.id.localeCompare(b.section.id));
  const best = scored[0]?.score ?? 0;
  return scored.filter((h) => h.score * 2 >= best).slice(0, max);
}

const hitRow = (h: HelpSectionHit) => ({
  id: h.section.id,
  titulo: h.section.level === 1 ? h.page.title : `${h.page.title} → ${h.section.title}`,
  pagina: h.page.id,
  resumo: h.section.summary || h.page.summary,
});

// ─── Ferramentas ─────────────────────────────────────────────────────────────

/** Teto do texto de uma secção aberta (a lista de uma página pode ir até PAGE). */
export const HELP_OPEN_MAX_CHARS = 4000;
export const HELP_OPEN_PAGE_MAX_CHARS = 6000;
export const HELP_SEARCH_MAX = 8;

const visibleFor = (ctx: StaffToolCtx) => (page: HelpTreePage) => canSeeHelpPage(ctx.user, page);

export const HELP_NAV_TOOLS: ChatTool<StaffToolCtx>[] = [
  {
    name: "ajuda_abrir",
    description: "Abre a ajuda da aplicação pelo id do índice: uma página (ex.: extras-dia) devolve a lista das secções com os ids; uma secção (ex.: extras-dia.md#separador-pressao-quando-e-que-aperta) devolve o texto; uma secção só de arrumação devolve as subsecções.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Id da página (como no índice) ou da secção (ficheiro.md#secção, como na lista da página ou no ajuda_procurar)." },
        tema: { type: "string", description: "Opcional: o que procuras (palavras da pergunta) — numa secção longa traz a parte certa." },
      },
      required: ["id"],
    },
    available: () => true,
    pii: { text: ["texto", "titulo"] },
    async run(args, ctx) {
      const id = String(args.id ?? "").trim().slice(0, 200);
      if (!id) throw new ToolUserError("Indica o id da página ou da secção (vê o índice ou usa o ajuda_procurar).");
      const tree = knowledgeTree();
      const hit = findHelpNode(tree, id, HELP_ID_ALIASES);
      if (!hit) {
        const near = searchHelpSections(tree, id.replace(/[#._-]+/g, " "), { canSee: visibleFor(ctx), max: 5 }).map(hitRow);
        return { error: "Não há ajuda com esse id.", parecidas: near };
      }
      if (!canSeeHelpPage(ctx.user, hit.page)) return { error: "Sem acesso à ajuda dessa página (o módulo não está nas tuas permissões)." };
      const open = openHelpNode(tree, id, HELP_ID_ALIASES)!;
      const isPage = !hit.section;
      const max = isPage ? HELP_OPEN_PAGE_MAX_CHARS : HELP_OPEN_MAX_CHARS;
      return {
        id: open.id,
        ...(open.id !== id && hit.section ? { pedido: id } : {}),
        titulo: isPage ? open.title : `${hit.page.title} → ${open.title}`,
        pagina: hit.page.id,
        tipo: isPage ? "pagina" : hit.section!.container ? "secoes" : "secao",
        texto: excerptSection(open.text, max, String(args.tema ?? "").slice(0, 300)),
      };
    },
  },
  {
    name: "ajuda_procurar",
    description: "Procura na ajuda da aplicação e devolve as secções mais próximas (id, título, página e resumo). Depois abre a certa com o ajuda_abrir.",
    parameters: {
      type: "object",
      properties: { texto: { type: "string", description: "O que procuras (palavras da pergunta)." } },
      required: ["texto"],
    },
    available: () => true,
    pii: { text: ["titulo", "resumo"] },
    async run(args, ctx) {
      const texto = String(args.texto ?? "").trim().slice(0, 300);
      if (!texto) throw new ToolUserError("Escreve o que procuras.");
      const hits = searchHelpSections(knowledgeTree(), texto, { canSee: visibleFor(ctx), max: HELP_SEARCH_MAX });
      return hits.length
        ? { resultados: hits.map(hitRow) }
        : { resultados: [], nota: "Nada encontrado com essas palavras: tenta outras ou abre a página certa pelo índice." };
    },
  },
];
