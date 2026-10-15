/**
 * Vetores da base de conhecimento EM MEMÓRIA, por instância (plano MPV §3.4, F5).
 *
 * Para os "vizinhos por vetor" (os trechos mais parecidos com a pergunta pelo
 * significado, mesmo sem palavras em comum) não se vai à BD em cada pergunta:
 * cada instância lê os vetores uma vez (`kb_chunks.embedding`) e guarda-os,
 * normalizados, num só Float32Array por âmbito:
 *
 *  - "help_sec": as secções da ajuda (Multis do piloto);
 *  - "kb": os manuais (Drive e carregados — o que o Multis consulta).
 *
 * Invalidação: a versão em `kb_sync_state` (`vectors:version`, muda sempre que
 * há vetores novos — store.saveEmbeddings / sync.embedHelpSections) é lida no
 * máximo a cada 60 s; se mudou, volta a ler. Se a BD falhar, fica a cópia que
 * havia (ou nenhuma → só a pesquisa lexical).
 *
 * Memória com teto: acima de `VECTOR_CACHE_MAX_CHUNKS` trechos o âmbito NÃO se
 * carrega (fica só a pesquisa lexical, com um aviso no registo) — 768 dimensões
 * × 4 bytes ≈ 3 KB por trecho, por isso as ≈ 430 secções da ajuda ficam em
 * ≈ 1,5 MB e o teto dos manuais (6 000 trechos) em ≈ 18 MB. `vectorCacheStats()`
 * mede o que está carregado.
 *
 * Segurança: a cópia em memória só ESCOLHE candidatos (com a visibilidade que
 * tinham quando se leram, para não gastar os 20 lugares em documentos que a
 * pessoa não vê). Quem chama confirma-os SEMPRE na BD com `kbVisibilitySql` e
 * `canSeeKbDoc` (retrieve.chunksByIds) — um documento restringido ou retirado
 * depois da leitura nunca passa.
 *
 * Nunca regista texto (só contagens e o âmbito).
 */
import { sql } from "drizzle-orm";
import { parseVisibility, type KbVisibility } from "../../shared/knowledge";
import { VECTORS_VERSION_KEY, getState, rowsOf, type Db } from "./store";

export type VectorScope = "help_sec" | "kb";

/** Teto de trechos por âmbito (acima disto o âmbito não se carrega: fica só a lexical). */
export const VECTOR_CACHE_MAX_CHUNKS: Readonly<Record<VectorScope, number>> = { help_sec: 3_000, kb: 6_000 };
/** A versão dos vetores lê-se no máximo uma vez por este intervalo. */
export const VECTOR_VERSION_CHECK_MS = 60_000;

export interface VectorIndex {
  scope: VectorScope;
  version: string;
  dims: number;
  size: number;
  /** size × dims, cada vetor já com norma 1 (o cosseno é o produto interno). */
  vectors: Float32Array;
  chunkIds: Int32Array;
  docIds: Int32Array;
  /** kb_documents.driveFileId de cada trecho (nas secções: "help:<ficheiro>.md#<secção>"). */
  refs: Array<string | null>;
  /** Visibilidade de cada documento quando se leu (só para pré-escolher; confirma-se na BD). */
  visibility: Map<number, KbVisibility>;
  bytes: number;
  loadedAt: number;
}

interface Slot {
  index: VectorIndex | null;
  version: string | null;
  checkedAt: number;
  /** O âmbito passou o teto na última leitura (não ficou carregado). */
  overCap: boolean;
  loading: Promise<VectorIndex | null> | null;
}

const slots = new Map<VectorScope, Slot>();
const warned = new Set<string>();

const SCOPE_SQL = {
  help_sec: sql`d.source = 'help_sec'`,
  kb: sql`d.source NOT IN ('help', 'help_sec')`,
} as const;

/** Para os testes: esquece tudo o que estava em memória. */
export function resetVectorCacheForTests(): void {
  slots.clear();
  warned.clear();
}

/** Monta o índice a partir das linhas lidas (normaliza; descarta vetores com outro tamanho). PURA (salvo decodificar). */
export async function buildVectorIndex(scope: VectorScope, version: string, rows: ReadonlyArray<{ id: unknown; docId: unknown; embedding: unknown; driveFileId?: unknown; visibilityRoles?: unknown; visibilityCities?: unknown }>, now = Date.now()): Promise<VectorIndex> {
  const { decodeVector } = await import("../_core/ai/embed");
  const decoded: Array<{ v: Float32Array; row: (typeof rows)[number] }> = [];
  let dims = 0;
  for (const r of rows) {
    const v = decodeVector(r.embedding != null ? String(r.embedding) : null);
    if (!v || !v.length) continue;
    if (!dims) dims = v.length;
    if (v.length !== dims) continue; // outro modelo/tamanho: fica de fora
    decoded.push({ v, row: r });
  }
  const size = decoded.length;
  const vectors = new Float32Array(size * dims);
  const chunkIds = new Int32Array(size);
  const docIds = new Int32Array(size);
  const refs: Array<string | null> = new Array(size);
  const visibility = new Map<number, KbVisibility>();
  decoded.forEach(({ v, row }, i) => {
    let n = 0;
    for (let k = 0; k < dims; k++) n += v[k] * v[k];
    const inv = n > 0 ? 1 / Math.sqrt(n) : 0;
    for (let k = 0; k < dims; k++) vectors[i * dims + k] = v[k] * inv;
    chunkIds[i] = Number(row.id);
    const docId = Number(row.docId);
    docIds[i] = docId;
    refs[i] = row.driveFileId != null ? String(row.driveFileId) : null;
    if (!visibility.has(docId)) visibility.set(docId, parseVisibility(row.visibilityRoles, row.visibilityCities));
  });
  // Memória: os vetores e os ids (exato) + as referências e a visibilidade (estimativa: 2 bytes por carácter + 64 por entrada).
  const refBytes = refs.reduce((s, r) => s + (r ? r.length * 2 + 16 : 8), 0);
  const visBytes = visibility.size * 64;
  return { scope, version, dims, size, vectors, chunkIds, docIds, refs, visibility, bytes: vectors.byteLength + chunkIds.byteLength + docIds.byteLength + refBytes + visBytes, loadedAt: now };
}

async function loadIndex(d: Db, scope: VectorScope, version: string, now: number): Promise<{ index: VectorIndex | null; overCap: boolean }> {
  const cap = VECTOR_CACHE_MAX_CHUNKS[scope];
  const { embedModelFor } = await import("../_core/ai/embed");
  // Só os vetores do modelo atual (outro modelo = outro espaço: o cosseno não vale nada).
  const where = sql`d.deletedAt IS NULL AND d.status = 'synced' AND c.embedding IS NOT NULL AND ${SCOPE_SQL[scope]} AND d.embedModel = ${embedModelFor()}`;
  // Contar primeiro: acima do teto nem se leem os vetores (≈ 4 KB cada em base64).
  const n = Number(rowsOf(await d.execute(sql`SELECT COUNT(*) AS n FROM kb_chunks c JOIN kb_documents d ON d.id = c.docId WHERE ${where}`))[0]?.n ?? 0);
  const rows = n > cap ? [] : rowsOf(await d.execute(sql`SELECT c.id, c.docId, c.embedding, d.driveFileId, d.visibilityRoles, d.visibilityCities
    FROM kb_chunks c JOIN kb_documents d ON d.id = c.docId
    WHERE ${where}
    ORDER BY c.id LIMIT ${cap + 1}`));
  if (n > cap || rows.length > cap) {
    if (!warned.has(`${scope}:cap`)) {
      warned.add(`${scope}:cap`);
      console.warn(`[knowledge] vetores "${scope}" acima do teto (${cap} trechos): fica só a pesquisa lexical.`);
    }
    return { index: null, overCap: true };
  }
  const index = await buildVectorIndex(scope, version, rows, now);
  if (!warned.has(`${scope}:${version}`)) {
    warned.add(`${scope}:${version}`);
    console.info(`[knowledge] vetores "${scope}" em memória: ${index.size} trechos, ${(index.bytes / 1_048_576).toFixed(2)} MB.`);
  }
  return { index, overCap: false };
}

/**
 * O índice em memória do âmbito, em dia (a versão lê-se no máximo a cada 60 s).
 * null = sem vetores, acima do teto, ou a BD não respondeu à 1.ª leitura.
 * Nunca lança.
 */
export async function getVectorIndex(d: Db, scope: VectorScope, now: number = Date.now()): Promise<VectorIndex | null> {
  let slot = slots.get(scope);
  if (slot?.loading) return slot.loading;
  if (slot && now - slot.checkedAt < VECTOR_VERSION_CHECK_MS) return slot.index;
  const work = (async (): Promise<VectorIndex | null> => {
    let version: string;
    try {
      version = (await getState(d, VECTORS_VERSION_KEY)) ?? "";
    } catch {
      // BD sem resposta: fica a cópia que havia (tenta outra vez daqui a 60 s).
      if (slot) slot.checkedAt = now;
      return slot?.index ?? null;
    }
    if (slot && slot.version === version) {
      slot.checkedAt = now;
      return slot.index;
    }
    try {
      const { index, overCap } = await loadIndex(d, scope, version, now);
      slot = { index, version, checkedAt: now, overCap, loading: null };
      slots.set(scope, slot);
      return index;
    } catch {
      if (slot) slot.checkedAt = now;
      return slot?.index ?? null;
    }
  })();
  if (!slot) {
    slot = { index: null, version: null, checkedAt: 0, overCap: false, loading: null };
    slots.set(scope, slot);
  }
  slot.loading = work;
  try {
    return await work;
  } finally {
    const cur = slots.get(scope);
    if (cur) cur.loading = null;
  }
}

export interface VectorNeighbor {
  chunkId: number;
  docId: number;
  ref: string | null;
  /** Cosseno com a pergunta (−1…1). */
  cos: number;
}

/**
 * Os `k` trechos mais parecidos com `query` (cosseno), só entre os que
 * `accept` deixa (visibilidade em memória, secções sem acesso…). Com
 * `distinctDocs`, no máx. um trecho por documento (o melhor). PURA.
 */
export function nearestNeighbors(index: VectorIndex, query: readonly number[], k: number, opts: {
  accept?: (e: { chunkId: number; docId: number; ref: string | null; visibility: KbVisibility | undefined }) => boolean;
  distinctDocs?: boolean;
} = {}): VectorNeighbor[] {
  if (!index.size || query.length !== index.dims || k <= 0) return [];
  let n = 0;
  for (let i = 0; i < query.length; i++) n += query[i] * query[i];
  if (!(n > 0)) return [];
  const inv = 1 / Math.sqrt(n);
  const scored: VectorNeighbor[] = [];
  const dims = index.dims;
  for (let i = 0; i < index.size; i++) {
    const entry = { chunkId: index.chunkIds[i], docId: index.docIds[i], ref: index.refs[i], visibility: index.visibility.get(index.docIds[i]) };
    if (opts.accept && !opts.accept(entry)) continue;
    let dot = 0;
    const base = i * dims;
    for (let j = 0; j < dims; j++) dot += index.vectors[base + j] * query[j];
    scored.push({ chunkId: entry.chunkId, docId: entry.docId, ref: entry.ref, cos: dot * inv });
  }
  scored.sort((a, b) => b.cos - a.cos || a.chunkId - b.chunkId);
  if (!opts.distinctDocs) return scored.slice(0, k);
  const out: VectorNeighbor[] = [];
  const seen = new Set<number>();
  for (const s of scored) {
    if (out.length >= k) break;
    if (seen.has(s.docId)) continue;
    seen.add(s.docId);
    out.push(s);
  }
  return out;
}

/** O que está em memória nesta instância (para medir). */
export function vectorCacheStats(): Record<VectorScope, { chunks: number; dims: number; bytes: number; version: string | null; overCap: boolean; checkedAt: number } | null> {
  const one = (scope: VectorScope) => {
    const s = slots.get(scope);
    if (!s) return null;
    return { chunks: s.index?.size ?? 0, dims: s.index?.dims ?? 0, bytes: s.index?.bytes ?? 0, version: s.version, overCap: s.overCap, checkedAt: s.checkedAt };
  };
  return { help_sec: one("help_sec"), kb: one("kb") };
}
