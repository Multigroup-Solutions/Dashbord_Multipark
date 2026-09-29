/**
 * Base de conhecimento — partir o texto extraído em trechos (PURO, sem I/O).
 *
 *  - ~800–1200 tokens por trecho (≈ 4 caracteres/token em PT), com
 *    sobreposição (~150 tokens) entre trechos seguidos do mesmo documento
 *    para uma frase partida ao meio não perder o contexto;
 *  - cada trecho guarda a secção (último título antes dele: markdown "#",
 *    "**Título**" ou "1.2 Título" — as mesmas regras do tutor da formação);
 *  - parágrafos gigantes são cortados por frases; frases gigantes por
 *    caracteres (nunca um trecho acima do máximo).
 *
 * `checksum` (sha256 do texto normalizado) decide se um documento mudou
 * (sincronização incremental: mesmo checksum → não se volta a partir nem a
 * gerar vetores).
 */
import { createHash } from "node:crypto";
import { headingOf } from "../trainingTutorRules";

export interface KbChunk {
  ord: number;
  section: string | null;
  text: string;
  tokens: number;
}

export interface ChunkOptions {
  /** Alvo por trecho (tokens). */
  targetTokens?: number;
  /** Máximo absoluto (tokens). */
  maxTokens?: number;
  /** Sobreposição com o trecho anterior (tokens). */
  overlapTokens?: number;
  /** Caracteres por token (estimativa). */
  charsPerToken?: number;
}

export const CHUNK_DEFAULTS: Required<ChunkOptions> = { targetTokens: 1000, maxTokens: 1200, overlapTokens: 150, charsPerToken: 4 };

/** Texto normalizado (quebras de linha, espaços, linhas vazias repetidas). PURA. */
export function normalizeExtracted(text: string): string {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** sha256 hex do texto normalizado. PURA. */
export function textChecksum(text: string): string {
  return createHash("sha256").update(normalizeExtracted(text), "utf8").digest("hex");
}

export function tokenEstimate(text: string, charsPerToken = CHUNK_DEFAULTS.charsPerToken): number {
  return Math.ceil(String(text ?? "").length / charsPerToken);
}

/** Corta um bloco em pedaços ≤ max caracteres (frases; em último caso caracteres). */
function splitBlock(block: string, max: number): string[] {
  if (block.length <= max) return [block];
  const out: string[] = [];
  let cur = "";
  for (const sentence of block.split(/(?<=[.!?;:])\s+/)) {
    let s = sentence;
    while (s.length > max) {
      if (cur) { out.push(cur); cur = ""; }
      out.push(s.slice(0, max));
      s = s.slice(max);
    }
    if (cur && cur.length + s.length + 1 > max) { out.push(cur); cur = ""; }
    cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

/** Fim do trecho anterior para começar o seguinte (a partir de um início de frase/palavra). */
function overlapTail(text: string, chars: number): string {
  if (chars <= 0 || text.length <= chars) return chars > 0 ? text : "";
  const tail = text.slice(-chars);
  const sentence = tail.search(/(?<=[.!?])\s+\S/);
  if (sentence >= 0 && sentence < tail.length / 2) return tail.slice(sentence).trim();
  const space = tail.indexOf(" ");
  return (space >= 0 ? tail.slice(space + 1) : tail).trim();
}

/** Parte o texto em trechos com secção. PURA. */
export function chunkText(text: string, opts: ChunkOptions = {}): KbChunk[] {
  const o = { ...CHUNK_DEFAULTS, ...opts };
  const target = o.targetTokens * o.charsPerToken;
  const max = Math.max(target, o.maxTokens * o.charsPerToken);
  const overlap = Math.min(Math.floor(target / 3), o.overlapTokens * o.charsPerToken);
  const clean = normalizeExtracted(text);
  if (!clean) return [];

  // Blocos: parágrafos, com o título em vigor.
  const blocks: Array<{ section: string | null; text: string; heading: boolean }> = [];
  let section: string | null = null;
  let para: string[] = [];
  const flush = () => {
    const t = para.join("\n").trim();
    if (t) blocks.push({ section, text: t, heading: false });
    para = [];
  };
  for (const line of clean.split("\n")) {
    const h = headingOf(line);
    if (h) {
      flush();
      section = h.slice(0, 300);
      blocks.push({ section, text: line.trim(), heading: true });
    } else if (!line.trim()) flush();
    else para.push(line);
  }
  flush();

  const out: KbChunk[] = [];
  let cur = "";
  /** `cur` só tem a sobreposição do trecho anterior (ainda nada novo). */
  let onlyOverlap = false;
  let curSection: string | null = null;
  const emit = () => {
    const t = cur.trim();
    if (t && !onlyOverlap) out.push({ ord: out.length, section: curSection, text: t, tokens: tokenEstimate(t, o.charsPerToken) });
    cur = "";
    onlyOverlap = false;
  };
  const restartWithOverlap = (prev: string, section: string | null) => {
    cur = overlapTail(prev, overlap);
    onlyOverlap = !!cur;
    curSection = section;
  };
  for (const b of blocks) {
    if (b.heading) {
      // Título novo: a sobreposição da secção anterior não passa para esta; um
      // trecho já com meio alvo fecha aqui (secções pequenas juntam-se).
      if (onlyOverlap) { cur = ""; onlyOverlap = false; }
      else if (cur.length >= target / 2) emit();
    }
    for (const piece of splitBlock(b.text, max - overlap - 2)) {
      if (!cur) curSection = b.section;
      if (cur && cur.length + piece.length + 2 > max) {
        const prev = cur;
        emit();
        if (b.heading) curSection = b.section;
        else restartWithOverlap(prev, b.section);
      }
      cur = cur ? `${cur}\n\n${piece}` : piece;
      onlyOverlap = false;
      if (cur.length >= target) {
        const prev = cur;
        emit();
        restartWithOverlap(prev, b.section);
      }
    }
  }
  emit();
  return out;
}
