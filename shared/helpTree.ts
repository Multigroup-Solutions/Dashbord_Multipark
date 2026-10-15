/**
 * Árvore de conhecimento da ajuda (plano MPV, §3.2): Grupo do menu → Página →
 * Secção, a partir de docs/ajuda/*.md. PURO (sem fs) — o gerador
 * (scripts/gen-ajuda.ts) lê os ficheiros e grava o resultado em
 * server/assistant/knowledgeTree.generated.ts.
 *
 * Cabeçalho de cada ficheiro (além de modulo/titulo/rotas/palavras do v1):
 *
 *   grupo: Operações                          (um de HELP_GROUPS — os grupos do menu)
 *   pagina: extras-dia                        (id estável; "pai.topico" = tópico de uma página)
 *   separadores: dia=Dia, pressao=Pressão     (separador do código = título da secção)
 *
 * Regra das secções (fecha a ambiguidade): só abrem secção os títulos `##` e
 * `###` e as linhas que são SÓ negrito (`**Título**`, com ou sem `:` no fim).
 * Negrito dentro de frases, listas ou passos numerados não abre secção. O texto
 * antes da 1.ª secção é a secção "inicio" da página.
 *
 * Ids: página = `pagina`; secção = `<ficheiro>#<slug do título>` (repetido no
 * mesmo ficheiro → `-2`, `-3`…). Não dependem da posição: acrescentar uma
 * secção não muda os ids das outras.
 */

/** Os grupos do menu (client/src/components/DashboardLayout.tsx: "Dashboards" do hub + menuGroups). */
export const HELP_GROUPS = ["Dashboards", "Financeiro", "Pessoas", "Operações", "Suporte", "Comunicação", "Sistema"] as const;
export type HelpGroup = (typeof HELP_GROUPS)[number];

/** Teto do índice no prompt estável (tokens ≈ caracteres / 3,8). */
export const HELP_INDEX_MAX_TOKENS = 6000;
export const HELP_SUMMARY_MAX = 160;

export interface HelpTreeSection {
  /** `<ficheiro>#<slug>` — estável. */
  id: string;
  file: string;
  slug: string;
  title: string;
  /** 1 = início da página (antes da 1.ª secção), 2 = `##`, 3 = `###`, 4 = linha só a negrito. */
  level: 1 | 2 | 3 | 4;
  /** 1.ª frase (≤ 160 car.), sem markdown. */
  summary: string;
  /** Texto da secção (markdown, sem a linha do título). */
  text: string;
}

export interface HelpTreeTab {
  /** Id do separador no código (ex.: "pressao"). */
  tab: string;
  /** Título da secção que o explica (como está no front matter). */
  section: string;
  /** Id da secção encontrada (o gerador falha se não existir). */
  sectionId: string;
}

export interface HelpTreePage {
  id: string;
  file: string;
  group: HelpGroup;
  module: string;
  title: string;
  routes: string[];
  tabs: HelpTreeTab[];
  /** 1.ª frase da página (≤ 160 car.). */
  summary: string;
  sections: HelpTreeSection[];
}

export interface HelpTreeGroup {
  group: HelpGroup;
  pages: HelpTreePage[];
}

export interface HelpTree {
  groups: HelpTreeGroup[];
}

export class HelpTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HelpTreeError";
  }
}

// ─── Leitura do ficheiro ─────────────────────────────────────────────────────

/** Separa o cabeçalho `---` do corpo. Chaves em minúsculas. PURA. */
export function splitFrontMatter(raw: string): { head: Record<string, string>; body: string } {
  const text = raw.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const head: Record<string, string> = {};
  if (m) {
    for (const line of m[1].split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) head[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
  }
  return { head, body: (m ? text.slice(m[0].length) : text).trim() };
}

const list = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

/** `dia=Dia, pressao=Pressão` → pares (a vírgula só separa antes de um `id=`). PURA. */
export function parseTabsField(v: string | undefined): Array<{ tab: string; section: string }> {
  if (!v || !v.trim()) return [];
  return v
    .split(/,\s*(?=[a-z0-9_-]+\s*=)/i)
    .map((part) => {
      const i = part.indexOf("=");
      if (i <= 0) throw new HelpTreeError(`Separador sem "=": "${part.trim()}" (formato: id=Título da secção).`);
      return { tab: part.slice(0, i).trim(), section: part.slice(i + 1).trim() };
    })
    .filter((t) => t.tab && t.section);
}

const HEADING_RE = /^(#{2,3})\s+(.+?)\s*#*\s*$/;
/** Linha que é SÓ negrito, com ou sem ":" no fim. */
export const BOLD_SECTION_RE = /^\*\*([^*]+)\*\*:?\s*$/;

/** A linha abre secção? (regra única). PURA. */
export function sectionHeading(line: string): { title: string; level: 2 | 3 | 4 } | null {
  const h = HEADING_RE.exec(line);
  if (h) return { title: cleanTitle(h[2]), level: h[1].length as 2 | 3 };
  const b = BOLD_SECTION_RE.exec(line);
  if (b) return { title: cleanTitle(b[1]), level: 4 };
  return null;
}

function cleanTitle(s: string): string {
  return stripMarkdown(s).replace(/:\s*$/, "").trim();
}

/** Texto sem marcas de markdown (negrito, itálico, código, links, títulos). PURA. */
export function stripMarkdown(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|\s)\*([^*\s][^*]*)\*/g, "$1$2")
    .replace(/^#+\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "Pressão → p75 (Porto)" → "pressao-p75-porto". PURA. */
export function slugify(title: string): string {
  const s = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, 60).replace(/-+$/g, "") || "secao";
}

/** 1.ª frase do texto, sem markdown, no máx. `max` caracteres (corta à palavra, com "…"). PURA. */
export function firstSentence(text: string, max = HELP_SUMMARY_MAX): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !/^(#|---|```|\|)/.test(l));
  const first = stripMarkdown((lines[0] ?? "").replace(/^([-*]|\d+[.)])\s+/, ""));
  if (!first) return "";
  // fim da frase: ". " / "! " / "? " seguido de maiúscula ou fim (evita "p. ex." e "3.5")
  const m = /^(.+?[.!?])(\s+(?=[A-ZÁÉÍÓÚÂÊÔÃÕÀÇ"“(«])|$)/.exec(first);
  const sentence = (m ? m[1] : first).trim();
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:\s]+$/, "")}…`;
}

/** Divide o corpo em secções (regra única; ignora o que está dentro de ``` ). PURA. */
export function splitSections(file: string, body: string, pageTitle: string): HelpTreeSection[] {
  const lines = body.split("\n");
  type Raw = { title: string; level: 1 | 2 | 3 | 4; lines: string[] };
  const raws: Raw[] = [{ title: pageTitle, level: 1, lines: [] }];
  let fence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) fence = !fence;
    if (!fence && /^#\s+/.test(line) && raws.length === 1 && !raws[0].lines.some((l) => l.trim())) continue; // título "# …" da página
    const h = fence ? null : sectionHeading(line);
    if (h) raws.push({ title: h.title, level: h.level, lines: [] });
    else raws[raws.length - 1].lines.push(line);
  }
  const used = new Map<string, number>();
  const out: HelpTreeSection[] = [];
  for (const r of raws) {
    const text = r.lines.join("\n").trim();
    if (r.level === 1 && !text) continue;
    const base = r.level === 1 ? "inicio" : slugify(r.title);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    const slug = n === 1 ? base : `${base}-${n}`;
    out.push({ id: `${file}#${slug}`, file, slug, title: r.title, level: r.level, summary: firstSentence(text), text });
  }
  return out;
}

/**
 * O título do separador no front matter aponta para esta secção? Igual (sem
 * acentos/maiúsculas/pontuação) ou igual ao início antes de um "(…)" final:
 * `pressao=Separador "Pressão"` acha `## Separador "Pressão" (quando é que aperta)`. PURA.
 */
export function sectionTitleMatches(sectionTitle: string, wanted: string): boolean {
  const a = slugify(sectionTitle), b = slugify(wanted);
  if (a === b) return true;
  const i = sectionTitle.indexOf(" (");
  return i > 0 && slugify(sectionTitle.slice(0, i)) === b;
}

/** Um ficheiro → página da árvore. Falha (HelpTreeError) com cabeçalho em falta ou separador sem secção. PURA. */
export function parseHelpPage(file: string, raw: string): HelpTreePage {
  const { head, body } = splitFrontMatter(raw);
  const group = head.grupo as HelpGroup;
  if (!group) throw new HelpTreeError(`${file}: falta "grupo:" no cabeçalho.`);
  if (!(HELP_GROUPS as readonly string[]).includes(group)) throw new HelpTreeError(`${file}: grupo "${group}" não é um grupo do menu (${HELP_GROUPS.join(", ")}).`);
  const id = head.pagina;
  if (!id) throw new HelpTreeError(`${file}: falta "pagina:" no cabeçalho.`);
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)?$/.test(id)) throw new HelpTreeError(`${file}: pagina "${id}" inválida (minúsculas, números, "-" e no máx. um ".").`);
  const title = head.titulo || /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || file;
  const sections = splitSections(file, body, title);
  const tabs = parseTabsField(head.separadores).map((t) => {
    const sec = sections.find((s) => sectionTitleMatches(s.title, t.section));
    if (!sec) throw new HelpTreeError(`${file}: o separador "${t.tab}" aponta para a secção "${t.section}", que não existe.`);
    return { tab: t.tab, section: t.section, sectionId: sec.id };
  });
  const seenTabs = new Set<string>();
  for (const t of tabs) {
    if (seenTabs.has(t.tab)) throw new HelpTreeError(`${file}: separador "${t.tab}" repetido.`);
    seenTabs.add(t.tab);
  }
  return {
    id,
    file,
    group,
    module: head.modulo || file.replace(/\.md$/, ""),
    title,
    routes: list(head.rotas),
    tabs,
    summary: sections[0]?.level === 1 ? sections[0].summary : firstSentence(body.replace(/^#\s+.+$/m, "")),
    sections,
  };
}

/** Todos os ficheiros → árvore (grupos pela ordem do menu; páginas por id). Ids repetidos = erro. PURA. */
export function buildHelpTree(files: ReadonlyArray<{ file: string; raw: string }>): HelpTree {
  const pages = files.map((f) => parseHelpPage(f.file, f.raw));
  const ids = new Map<string, string>();
  const secIds = new Set<string>();
  for (const p of pages) {
    const other = ids.get(p.id);
    if (other) throw new HelpTreeError(`pagina "${p.id}" repetida em ${other} e ${p.file}.`);
    ids.set(p.id, p.file);
    for (const s of p.sections) {
      if (secIds.has(s.id)) throw new HelpTreeError(`secção "${s.id}" repetida.`);
      secIds.add(s.id);
    }
  }
  return {
    groups: HELP_GROUPS.map((group) => ({
      group,
      pages: pages.filter((p) => p.group === group).sort((a, b) => a.id.localeCompare(b.id)),
    })).filter((g) => g.pages.length > 0),
  };
}

// ─── Consultas ───────────────────────────────────────────────────────────────

export function treePages(tree: HelpTree): HelpTreePage[] {
  return tree.groups.flatMap((g) => g.pages);
}

/** Página ou secção pelo id (`pagina` ou `ficheiro.md#slug`; aceita também `ficheiro.md`). PURA. */
export function findHelpNode(tree: HelpTree, id: string): { page: HelpTreePage; section: HelpTreeSection | null } | null {
  const key = id.trim();
  for (const page of treePages(tree)) {
    if (page.id === key || page.file === key) return { page, section: null };
    const section = page.sections.find((s) => s.id === key);
    if (section) return { page, section };
  }
  return null;
}

function normPath(path: string): string {
  return path.split("?")[0].split("#")[0].replace(/\/+$/, "") || "/";
}

/**
 * Páginas da ajuda para um caminho da app, da mais específica para a menos:
 * rota exata > rota mais comprida a servir de prefixo; depois a página
 * principal (id sem ".") antes dos tópicos; depois a rota principal (1.ª da
 * lista) antes das outras; por fim o ficheiro. "/" só conta exato. PURA.
 */
export function pagesForPath(tree: HelpTree, path: string | null | undefined): HelpTreePage[] {
  if (!path) return [];
  const p = normPath(path);
  const scored: Array<{ page: HelpTreePage; exact: number; len: number; main: number; idx: number }> = [];
  for (const page of treePages(tree)) {
    let best: { exact: number; len: number; idx: number } | null = null;
    page.routes.forEach((r0, idx) => {
      const r = normPath(r0);
      const exact = p === r;
      if (!exact && (r === "/" || !p.startsWith(`${r}/`))) return;
      const cand = { exact: exact ? 1 : 0, len: r.length, idx };
      if (!best || cand.exact > best.exact || (cand.exact === best.exact && (cand.len > best.len || (cand.len === best.len && cand.idx < best.idx)))) best = cand;
    });
    if (best) scored.push({ page, ...(best as { exact: number; len: number; idx: number }), main: page.id.includes(".") ? 0 : 1 });
  }
  return scored
    .sort((a, b) => b.exact - a.exact || b.len - a.len || b.main - a.main || a.idx - b.idx || a.page.file.localeCompare(b.page.file))
    .map((s) => s.page);
}

/** A secção do separador aberto (ou null). PURA. */
export function sectionForTab(page: HelpTreePage, tab: string | null | undefined): HelpTreeSection | null {
  if (!tab) return null;
  const t = page.tabs.find((x) => x.tab === tab);
  return t ? page.sections.find((s) => s.id === t.sectionId) ?? null : null;
}

// ─── Índices (prompt) ────────────────────────────────────────────────────────

/** Tokens estimados (caracteres / 3,8, como na medição do plano). PURA. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.8);
}

/** Lista das secções de uma página (o que `ajuda_abrir(pagina)` mostra). PURA. */
export function renderPageSections(page: HelpTreePage): string {
  const head = `${page.title} [${page.id}]${page.routes.length ? ` ${page.routes.join(", ")}` : ""}`;
  const tabs = page.tabs.length ? `\nSeparadores: ${page.tabs.map((t) => `${t.tab} → ${t.sectionId}`).join("; ")}` : "";
  const secs = page.sections
    .map((s) => `${"  ".repeat(Math.max(0, s.level - 2))}- ${s.id}: ${s.title}${s.summary && s.level > 1 ? ` — ${s.summary}` : ""}`)
    .join("\n");
  return `${head}${tabs}\n${secs}`;
}

/** Título sem o "(…)" do fim — no índice basta o nome da secção (poupa tokens). PURA. */
export function shortTitle(title: string): string {
  const i = title.indexOf(" (");
  return i > 0 ? title.slice(0, i) : title;
}

/**
 * Índice da árvore. "pages": Grupo → Página (+ 1 frase); "sections": também
 * os títulos das secções (sem resumo). PURA.
 */
export function renderHelpIndex(tree: HelpTree, level: "pages" | "sections"): string {
  return tree.groups
    .map((g) => {
      const pages = g.pages.map((p) => {
        const line = `- ${p.id}: ${p.title}${p.routes.length ? ` [${p.routes.join(", ")}]` : ""}${p.summary ? ` — ${p.summary}` : ""}`;
        if (level === "pages") return line;
        const secs = p.sections.filter((s) => s.level > 1).map((s) => shortTitle(s.title)).join(" · ");
        return secs ? `${line}\n  ${secs}` : line;
      });
      return `## ${g.group}\n${pages.join("\n")}`;
    })
    .join("\n");
}

/** O nível do índice que cabe no teto (secções se couber; senão só páginas). PURA. */
export function chooseIndexLevel(tree: HelpTree, maxTokens = HELP_INDEX_MAX_TOKENS): "sections" | "pages" {
  return estimateTokens(renderHelpIndex(tree, "sections")) <= maxTokens ? "sections" : "pages";
}
