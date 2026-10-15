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
  /** Texto da secção (markdown, sem a linha do título e sem as subsecções). */
  text: string;
  /**
   * Ids das subsecções diretas (`##` → os `###` e as linhas a negrito até ao
   * `##` seguinte; `###` → as linhas a negrito até ao título seguinte de nível
   * igual ou maior). Vazio nas folhas.
   */
  children: string[];
  /** Secção só de arrumação (sem texto próprio, com subsecções): abrir = ver a lista dos filhos. */
  container: boolean;
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
  const text = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
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
/** Linha que é SÓ negrito, com ou sem ":" no fim (também "**X** :"). */
export const BOLD_SECTION_RE = /^\*\*([^*]+)\*\*\s*:?\s*$/;

/** Abre/fecha um bloco de código: a linha é só a cerca (``` ou ~~~, com a língua a seguir), nada mais. */
const FENCE_RE = /^\s*(```|~~~)[^`~]*$/;

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

/** Abreviaturas que acabam em "." sem acabar a frase (minúsculas, sem o ponto). */
const ABBREVIATIONS = new Set([
  "sr", "sra", "srs", "dr", "dra", "drs", "eng", "enga", "arq", "prof", "profa", "ex", "p", "pág", "pags", "págs", "n", "nº", "n.º", "art", "av", "etc", "máx", "mín", "aprox", "obs", "tel", "telm", "vs", "sto", "sta", "lda", "s.a", "cf", "ref",
]);

/** Corta no fim da 1.ª frase: ". ", "! " ou "? " seguido de maiúscula (ou o fim), sem cortar em "Sr.", "p. ex.", "3.5". PURA. */
function cutSentence(s: string): string {
  const re = /[.!?](?=\s+[A-ZÁÉÍÓÚÂÊÔÃÕÀÇ"“(«]|\s*$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (s[m.index] === ".") {
      const before = /([\p{L}.º]+)$/u.exec(s.slice(0, m.index))?.[1]?.toLowerCase() ?? "";
      if (ABBREVIATIONS.has(before) || ABBREVIATIONS.has(before.replace(/^.*\./, "")) || /^\p{L}$/u.test(before)) continue;
    }
    return s.slice(0, m.index + 1).trim();
  }
  return s.trim();
}

/** 1.ª frase do texto, sem markdown, no máx. `max` caracteres (corta à palavra, com "…"). PURA. */
export function firstSentence(text: string, max = HELP_SUMMARY_MAX): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !/^(#|---|```|~~~|\|)/.test(l));
  const first = stripMarkdown((lines[0] ?? "").replace(/^([-*]|\d+[.)])\s+/, ""));
  if (!first) return "";
  const sentence = cutSentence(first);
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:\s]+$/, "")}…`;
}

/**
 * Divide o corpo em secções (regra única; ignora o que está dentro de blocos
 * ``` ou ~~~ — um bloco aberto no fim é erro). Slugs repetidos: `-2`, `-3`…,
 * saltando os que já existam (ex.: "Notas", "Notas", "Notas 2" → notas,
 * notas-2, notas-2-2). PURA.
 */
export function splitSections(file: string, body: string, pageTitle: string): HelpTreeSection[] {
  const lines = body.split("\n");
  type Raw = { title: string; level: 1 | 2 | 3 | 4; lines: string[] };
  const raws: Raw[] = [{ title: pageTitle, level: 1, lines: [] }];
  let fence: string | null = null;
  let fenceLine = 0;
  lines.forEach((line, i) => {
    const f = FENCE_RE.exec(line);
    if (f && (fence === null || f[1] === fence)) {
      if (fence === null) { fence = f[1]; fenceLine = i + 1; } else fence = null;
      raws[raws.length - 1].lines.push(line);
      return;
    }
    if (fence === null && /^#\s+/.test(line) && raws.length === 1 && !raws[0].lines.some((l) => l.trim())) return; // título "# …" da página
    const h = fence === null ? sectionHeading(line) : null;
    if (h) raws.push({ title: h.title, level: h.level, lines: [] });
    else raws[raws.length - 1].lines.push(line);
  });
  if (fence !== null) throw new HelpTreeError(`${file}: bloco de código aberto na linha ${fenceLine} do corpo e nunca fechado.`);
  const used = new Set<string>();
  const kept = raws.map((r) => ({ ...r, text: r.lines.join("\n").trim() })).filter((r) => r.level > 1 || r.text);
  const out: HelpTreeSection[] = kept.map((r) => {
    const base = r.level === 1 ? "inicio" : slugify(r.title);
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
    used.add(slug);
    return { id: `${file}#${slug}`, file, slug, title: r.title, level: r.level, summary: firstSentence(r.text), text: r.text, children: [], container: false };
  });
  // Filhos diretos: as secções seguintes de nível mais fundo, até à próxima do mesmo nível ou acima.
  out.forEach((s, i) => {
    if (s.level === 1 || s.level === 4) return;
    for (let j = i + 1; j < out.length && out[j].level > s.level; j++) {
      const parentOfJ = (() => { for (let k = j - 1; k >= i; k--) if (out[k].level < out[j].level) return k; return i; })();
      if (parentOfJ === i) s.children.push(out[j].id);
    }
    s.container = !s.text && s.children.length > 0;
  });
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

/**
 * Página ou secção pelo id (`pagina` ou `ficheiro.md#slug`; aceita também
 * `ficheiro.md`). Um id antigo (renomeado) segue o mapa de aliases. PURA.
 */
export function findHelpNode(
  tree: HelpTree,
  id: string,
  aliases: Readonly<Record<string, string>> = {},
): { page: HelpTreePage; section: HelpTreeSection | null } | null {
  const live = (key: string) => {
    for (const page of treePages(tree)) {
      if (page.id === key || page.file === key) return { page, section: null };
      const section = page.sections.find((s) => s.id === key);
      if (section) return { page, section };
    }
    return null;
  };
  // 1.º o id vivo (um alias nunca tapa um id que existe); só depois o alias.
  let key = id.trim();
  const seen = new Set<string>();
  for (;;) {
    const hit = live(key);
    if (hit) return hit;
    const next = Object.prototype.hasOwnProperty.call(aliases, key) ? aliases[key] : undefined;
    if (!next || seen.has(key)) return null;
    seen.add(key);
    key = next;
  }
}

/**
 * O que `ajuda_abrir(id)` mostra: página → a lista das secções; secção
 * contentor → a lista dos filhos (id, título, resumo); secção normal → o texto
 * (e, se tiver subsecções, a lista delas por baixo). null = id desconhecido. PURA.
 */
export function openHelpNode(tree: HelpTree, id: string, aliases: Readonly<Record<string, string>> = {}): { id: string; title: string; text: string } | null {
  const hit = findHelpNode(tree, id, aliases);
  if (!hit) return null;
  const { page, section } = hit;
  if (!section) return { id: page.id, title: page.title, text: renderPageSections(page) };
  const kids = section.children
    .map((cid) => page.sections.find((s) => s.id === cid))
    .filter((s): s is HelpTreeSection => !!s)
    .map((s) => `- ${s.id}: ${s.title}${s.summary ? ` — ${s.summary}` : ""}`)
    .join("\n");
  const text = section.container ? `Subsecções (abre cada uma pelo id):\n${kids}` : kids ? `${section.text}\n\nSubsecções:\n${kids}` : section.text;
  return { id: section.id, title: section.title, text };
}

/** A árvore sem o texto das secções (o texto está no helpDocs e lê-se em execução). */
export type HelpTreeOutlineSection = Omit<HelpTreeSection, "text"> & { chars: number };
export type HelpTreeOutline = { groups: Array<{ group: HelpGroup; pages: Array<Omit<HelpTreePage, "sections"> & { sections: HelpTreeOutlineSection[] }> }> };

/** Tira o texto (fica o n.º de caracteres) — para o ficheiro gerado não repetir a ajuda. PURA. */
export function treeOutline(tree: HelpTree): HelpTreeOutline {
  return {
    groups: tree.groups.map((g) => ({
      group: g.group,
      pages: g.pages.map((p) => ({ ...p, sections: p.sections.map(({ text, ...s }) => ({ ...s, chars: text.length })) })),
    })),
  };
}

/** Todos os ids (páginas e secções), por ordem. PURA. */
export function treeIds(tree: HelpTree | HelpTreeOutline): string[] {
  return tree.groups.flatMap((g) => g.pages.flatMap((p) => [p.id, ...p.sections.map((s) => s.id)]));
}

function normPath(path: string): string {
  return path.split("?")[0].split("#")[0].replace(/\/+$/, "") || "/";
}

/**
 * Páginas da ajuda para um caminho da app, da mais específica para a menos:
 *  1. rota exata antes de prefixo; rota mais comprida antes da mais curta;
 *  2. a rota é a principal da página (1.ª da lista) antes de ser secundária;
 *  3. o nome da página (último pedaço do id) é o último pedaço da rota
 *     (/marketing/web → marketing.web; /definicoes → definicoes);
 *  4. a página com menos rotas (mais específica);
 *  5. a página principal (id sem ".") antes dos tópicos; por fim o ficheiro.
 * "/" só conta exato. PURA.
 */
export function pagesForPath<T extends HelpTree | HelpTreeOutline>(tree: T, path: string | null | undefined): Array<T["groups"][number]["pages"][number]> {
  type Page = T["groups"][number]["pages"][number];
  if (!path) return [];
  const p = normPath(path);
  const last = p.split("/").filter(Boolean).pop() ?? "";
  type Score = { page: Page; exact: number; len: number; idx: number; named: number; nRoutes: number; main: number };
  const scored: Score[] = [];
  for (const page of (tree.groups as Array<{ pages: Page[] }>).flatMap((g) => g.pages)) {
    let best: { exact: number; len: number; idx: number } | null = null;
    page.routes.forEach((r0, idx) => {
      const r = normPath(r0);
      const exact = p === r;
      if (!exact && (r === "/" || !p.startsWith(`${r}/`))) return;
      const cand = { exact: exact ? 1 : 0, len: r.length, idx };
      if (!best || cand.exact > best.exact || (cand.exact === best.exact && (cand.len > best.len || (cand.len === best.len && cand.idx < best.idx)))) best = cand;
    });
    if (!best) continue;
    const name = page.id.split(".").pop() ?? page.id;
    scored.push({ page, ...(best as { exact: number; len: number; idx: number }), named: last && name === last ? 1 : 0, nRoutes: page.routes.length, main: page.id.includes(".") ? 0 : 1 });
  }
  return scored
    .sort((a, b) => b.exact - a.exact || b.len - a.len || a.idx - b.idx || b.named - a.named || a.nRoutes - b.nRoutes || b.main - a.main || a.page.file.localeCompare(b.page.file))
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
