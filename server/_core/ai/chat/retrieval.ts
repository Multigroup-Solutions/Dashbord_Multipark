/**
 * Recuperação barata de ajuda (sem embeddings, sem chamada à IA): cada ficheiro
 * de ajuda tem um cabeçalho com módulo, rotas e palavras-chave; a pergunta é
 * normalizada (minúsculas, sem acentos) e pontuada contra as palavras-chave e
 * o título, com bónus para o módulo da página onde a pessoa está. Só os 1–2
 * ficheiros mais relevantes vão para o contexto. PURO.
 *
 * Multis 2 (8 out 2026): quando a base de conhecimento responde no mesmo turno
 * (a ajuda está lá indexada como fonte "help", com embeddings), os ficheiros
 * que ela acha pelo SIGNIFICADO juntam-se aos das palavras-chave
 * (`combineHelpDocs`, máx. 3, sem repetir); sem base → só palavras-chave. Dos
 * ficheiros longos vai a parte que interessa à pergunta (`excerptHelp`), não
 * só o início.
 *
 * Formato de um ficheiro (docs/ajuda/*.md):
 *
 *   ---
 *   modulo: extras_dia
 *   titulo: Extras-Dia
 *   rotas: /extras-dia
 *   palavras: extras, escala, turno, team leader
 *   ---
 *   # Extras-Dia
 *   …
 */

export interface HelpDoc {
  /** Nome do ficheiro (ex.: "extras-dia.md"). */
  file: string;
  module: string;
  title: string;
  routes: string[];
  keywords: string[];
  /** 1.ª linha de texto depois do título (para o índice). */
  summary: string;
  /** Corpo em markdown (sem o cabeçalho). */
  body: string;
}

/** minúsculas, sem acentos, só letras/dígitos/espaços. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9/]+/g, " ")
    .trim();
}

/** Palavras que não ajudam a escolher (PT). */
const STOP = new Set(
  "a o as os um uma uns umas de do da dos das em no na nos nas por para com sem que como se eu tu me te nao sim e ou mas quando onde qual quais quem ja so mais menos muito pouco este esta isto esse essa isso aquilo meu minha meus minhas teu tua ao aos pode posso consigo fazer faz faco ver vejo tem ter ha hoje amanha ontem dia dias app aplicacao pagina ecra botao"
    .split(" "),
);

export function tokens(s: string): string[] {
  return normalizeText(s)
    .split(" ")
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

/** Lê um ficheiro de ajuda com cabeçalho `---`. Sem cabeçalho → módulo = nome do ficheiro. */
export function parseHelpDoc(file: string, raw: string): HelpDoc {
  const text = raw.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const head: Record<string, string> = {};
  if (m) {
    for (const line of m[1].split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) head[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
  }
  const body = (m ? text.slice(m[0].length) : text).trim();
  const list = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const titleLine = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const summary = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#")) ?? "";
  return {
    file,
    module: head.modulo || file.replace(/\.md$/, ""),
    title: head.titulo || titleLine || file,
    routes: list(head.rotas),
    keywords: list(head.palavras),
    summary: summary.slice(0, 160),
    body,
  };
}

/** A página atual pertence a este ficheiro? (rota exata ou prefixo "/rota/…"). */
export function docMatchesPath(doc: HelpDoc, path: string | null | undefined): boolean {
  if (!path) return false;
  const p = path.split("?")[0].replace(/\/+$/, "") || "/";
  return doc.routes.some((r) => r !== "/" && (p === r || p.startsWith(`${r}/`)));
}

export interface ScoredDoc { doc: HelpDoc; score: number }

/**
 * Pontua os ficheiros para uma pergunta. Palavra-chave com várias palavras
 * ("passagem de turno") conta quando aparece inteira na pergunta; palavra
 * simples conta por prefixo comum (≥ 5 letras: "reclamacoes" ~ "reclamacao").
 */
export function scoreDocs(docs: HelpDoc[], question: string, opts: { path?: string | null } = {}): ScoredDoc[] {
  const q = ` ${normalizeText(question)} `;
  const qTokens = tokens(question);
  const stem = (w: string) => (w.length > 5 ? w.slice(0, 5) : w);
  const qStems = new Set(qTokens.map(stem));
  return docs
    .map((doc) => {
      let score = 0;
      for (const kw of [...doc.keywords, doc.title]) {
        const k = normalizeText(kw);
        if (!k) continue;
        if (k.includes(" ")) {
          // Só palavras com significado; sem nenhuma ("ver mais") não conta —
          // um every() sobre a lista vazia dava acerto em qualquer pergunta.
          const words = k.split(" ").filter((w) => w.length >= 3 && !STOP.has(w));
          if (q.includes(` ${k} `)) score += 3;
          else if (words.length && words.every((w) => qStems.has(stem(w)))) score += 2;
        } else if (!STOP.has(k) && k.length >= 3) {
          if (q.includes(` ${k} `)) score += 2;
          else if (k.length >= 5 && qStems.has(stem(k))) score += 1;
        }
      }
      if (score > 0 && docMatchesPath(doc, opts.path)) score += 2;
      return { doc, score };
    })
    .sort((a, b) => b.score - a.score || a.doc.file.localeCompare(b.doc.file));
}

/**
 * Os ficheiros a meter no contexto: os que pontuam (máx. `max`, e só os que
 * chegam a metade do melhor; fora das perguntas de "como se usa", só com
 * pontuação ≥ 2). Sem nenhum, o da página atual (se a pergunta parecer de
 * "como se usa"). PURO.
 */
export function pickHelpDocs(docs: HelpDoc[], question: string, opts: { path?: string | null; max?: number } = {}): HelpDoc[] {
  const max = Math.max(1, opts.max ?? 2);
  const howTo = looksLikeHowTo(question);
  // Pergunta de dados ("quantas reservas…") com uma só correspondência fraca
  // não leva ajuda (poupa tokens).
  const scored = scoreDocs(docs, question, opts).filter((s) => s.score >= (howTo ? 1 : 2));
  if (scored.length) {
    const best = scored[0].score;
    return scored.filter((s) => s.score * 2 >= best).slice(0, max).map((s) => s.doc);
  }
  if (howTo) {
    const here = docs.find((d) => docMatchesPath(d, opts.path));
    if (here) return [here];
  }
  return [];
}

/** "como…", "onde…", "posso…", "o que é…" — perguntas de utilização. */
export function looksLikeHowTo(question: string): boolean {
  const q = normalizeText(question);
  return /^(como|onde|posso|consigo|o que|para que|explica|ensina|ajuda|qual e o|quais sao os passos)\b/.test(q) || /\b(como (se )?(faz|usa|uso|marco|registo|crio|vejo))\b/.test(q);
}

/** Índice curto (para o prompt estável): uma linha por ficheiro. */
export function helpIndex(docs: HelpDoc[]): string {
  return docs.map((d) => `- ${d.title} (${d.module})${d.routes.length ? ` [${d.routes.join(", ")}]` : ""}: ${d.summary}`).join("\n");
}

// ─── Ajuda pelo significado (base de conhecimento) ──────────────────────────

/** Um trecho da ajuda achado pela base de conhecimento (ficheiro, pontuação 0–1, texto). */
export interface HelpHit {
  file: string;
  score: number;
  text?: string;
}

/** No máximo 3 páginas da ajuda por pergunta. */
export const HELP_MAX_FILES = 3;
/** Pontuação mínima de um trecho achado pela base (pergunta de "como se usa"). */
export const HELP_SEMANTIC_MIN = 0.5;
/** …e numa pergunta de dados ("quantas reservas…"), mais exigente — poupa tokens. */
export const HELP_SEMANTIC_MIN_DATA = 0.6;

/**
 * Junta os ficheiros das palavras-chave com os achados pela base (pelo
 * significado): alternados (1.º das palavras-chave, 1.º da base, 2.º das
 * palavras-chave…), sem repetir, no máximo `max` (3). Da base só contam os
 * trechos com pontuação mínima e perto do melhor (≥ 75 %). Sem trechos da base
 * → as palavras-chave tal como antes. PURA.
 */
export function combineHelpDocs(docs: HelpDoc[], keyword: HelpDoc[], semantic: readonly HelpHit[], opts: { max?: number; question?: string } = {}): HelpDoc[] {
  const max = Math.max(1, opts.max ?? HELP_MAX_FILES);
  const byFile = new Map(docs.map((d) => [d.file, d]));
  const min = opts.question != null && !looksLikeHowTo(opts.question) ? HELP_SEMANTIC_MIN_DATA : HELP_SEMANTIC_MIN;
  const best = Math.max(0, ...semantic.map((h) => h.score));
  const sem: HelpDoc[] = [];
  for (const h of [...semantic].sort((a, b) => b.score - a.score)) {
    if (!(h.score >= min) || h.score < best * 0.75) continue;
    const d = byFile.get(h.file);
    if (d && !sem.includes(d)) sem.push(d);
  }
  const order = [keyword[0], sem[0], keyword[1], sem[1], ...keyword.slice(2), ...sem.slice(2)];
  const out: HelpDoc[] = [];
  for (const d of order) if (d && !out.includes(d)) out.push(d);
  return out.slice(0, max);
}

/** Trechos da base por ficheiro (para escolher a parte certa de um ficheiro longo). PURA. */
export function helpHints(hits: readonly HelpHit[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const h of hits) if (h.text) (out[h.file] ??= []).push(h.text);
  return out;
}

const isHeadingOnly = (p: string) => !p.includes("\n") && (/^#{1,6}\s/.test(p) || /^\*\*[^*]+\*\*:?$/.test(p.trim()));
const stem5 = (w: string) => (w.length > 5 ? w.slice(0, 5) : w);

/**
 * A parte de um ficheiro de ajuda que interessa à pergunta, até `maxChars`:
 * o título e a introdução, mais os parágrafos com mais palavras da pergunta
 * (e os que estão nos trechos achados pela base, `hints`), pela ordem do
 * ficheiro, com "[…]" onde se salta. Cabe inteiro → inteiro; nada a apontar
 * → o início, como antes. PURA.
 */
export function excerptHelp(body: string, maxChars: number, question: string, hints: readonly string[] = []): string {
  if (body.length <= maxChars) return body;
  const cut = () => `${body.slice(0, Math.max(0, maxChars - 1))}…`;
  const qStems = new Set(tokens(question).map(stem5));
  const hintText = hints.map((h) => normalizeText(h)).filter(Boolean);
  if (!qStems.size && !hintText.length) return cut();
  const paras = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const scored = paras.map((p, i) => {
    let score = 0;
    if (qStems.size) {
      const ps = new Set(tokens(p).map(stem5));
      for (const w of qStems) if (ps.has(w)) score++;
    }
    const key = normalizeText(p).slice(0, 80);
    if (key.length >= 20 && hintText.some((h) => h.includes(key))) score += 2;
    return { i, p, score };
  });
  const SEP = 7; // "\n\n[…]\n\n" no pior caso
  const keep = new Set<number>();
  let used = 0;
  const take = (i: number) => { keep.add(i); used += paras[i].length + SEP; };
  // Título + introdução (se a introdução não comer mais de 1/4 do espaço).
  take(0);
  if (isHeadingOnly(paras[0]) && paras[1] && paras[1].length + SEP <= maxChars / 4) take(1);
  const ranked = scored.filter((x) => x.score > 0 && !keep.has(x.i)).sort((a, b) => b.score - a.score || a.i - b.i);
  let added = 0;
  for (const x of ranked) {
    const ids = [x.i];
    // O título da secção (parágrafo só com o título) vai com o parágrafo.
    if (x.i > 0 && !keep.has(x.i - 1) && isHeadingOnly(paras[x.i - 1])) ids.unshift(x.i - 1);
    const len = ids.reduce((n, i) => n + paras[i].length + SEP, 0);
    if (used + len > maxChars) continue;
    for (const i of ids) take(i);
    added++;
  }
  if (!added) return cut();
  const out: string[] = [];
  let prev = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (prev >= 0 && i !== prev + 1) out.push("[…]");
    out.push(paras[i]);
    prev = i;
  }
  if (prev < paras.length - 1) out.push("[…]");
  const text = out.join("\n\n");
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/** Teto do bloco <ajuda> (todas as páginas juntas). */
export const HELP_CONTEXT_CHARS = 6000;

/**
 * Os ficheiros escolhidos → bloco de contexto com teto de caracteres. O
 * espaço reparte-se pelos ficheiros (o que um curto não usa passa para os
 * seguintes); com a pergunta, de um ficheiro longo vai a parte que interessa
 * (`excerptHelp`), senão o início.
 */
export function helpContext(docs: HelpDoc[], maxChars = HELP_CONTEXT_CHARS, opts: { question?: string; hints?: Record<string, string[]> } = {}): string {
  const out: string[] = [];
  let left = maxChars;
  docs.forEach((d, idx) => {
    const share = Math.floor(left / (docs.length - idx));
    if (share <= 200) return;
    const chunk = d.body.length <= share
      ? d.body
      : opts.question != null
        ? excerptHelp(d.body, share, opts.question, opts.hints?.[d.file] ?? [])
        : `${d.body.slice(0, share - 1)}…`;
    out.push(`<ajuda ficheiro="${d.file}">\n${chunk}\n</ajuda>`);
    left -= chunk.length;
  });
  return out.join("\n\n");
}
