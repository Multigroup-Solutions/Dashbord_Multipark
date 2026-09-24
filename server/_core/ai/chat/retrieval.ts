/**
 * Recuperação barata de ajuda (sem embeddings, sem chamada à IA): cada ficheiro
 * de ajuda tem um cabeçalho com módulo, rotas e palavras-chave; a pergunta é
 * normalizada (minúsculas, sem acentos) e pontuada contra as palavras-chave e
 * o título, com bónus para o módulo da página onde a pessoa está. Só os 1–2
 * ficheiros mais relevantes vão para o contexto. PURO.
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
          if (q.includes(` ${k} `)) score += 3;
          else if (k.split(" ").filter((w) => w.length >= 3 && !STOP.has(w)).every((w) => qStems.has(stem(w)))) score += 2;
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

/** Os ficheiros escolhidos → bloco de contexto com teto de caracteres. */
export function helpContext(docs: HelpDoc[], maxChars = 4000): string {
  const out: string[] = [];
  let left = maxChars;
  for (const d of docs) {
    if (left <= 200) break;
    const chunk = d.body.length > left ? `${d.body.slice(0, left - 1)}…` : d.body;
    out.push(`<ajuda ficheiro="${d.file}">\n${chunk}\n</ajuda>`);
    left -= chunk.length;
  }
  return out.join("\n\n");
}
