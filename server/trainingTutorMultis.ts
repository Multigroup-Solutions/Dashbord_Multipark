/**
 * D7 (Jorge, 16 out 2026): "o Multis passa a ser o tutor da página Formação"
 * (plano MPV §3.5). Liga o Multis aos MESMOS materiais que o tutor próprio
 * usava, sem IA:
 *
 *  - os manuais da formação (training_manuals) e as descrições dos vídeos,
 *    partidos em trechos e procurados por palavras-chave com as MESMAS regras
 *    do tutor (`chunkManuals` + `retrieveChunks`, server/trainingTutorRules.ts);
 *    primeiro no módulo aberto (manual, vídeo, percurso ou quiz —
 *    `trainingTutorStore.loadModule`, como o tutor), depois em todo o catálogo;
 *  - a visibilidade é a de hoje: só manuais publicados (os não publicados só
 *    para admin e acima, como no ecrã e no tutor) e nunca arquivados no
 *    catálogo; a base de conhecimento passa sempre por `kbVisibilitySql` +
 *    `canSeeKbDoc` (retrieveKnowledge), com o papel e as cidades do pedido.
 *
 * `training.tutorMode` = "proprio" → nada disto corre e o Multis fica como era.
 */
import { roleRank } from "../shared/access";
import { pagePathOf } from "../shared/multisPage";
import {
  TUTOR_DEFAULT_MODE, TUTOR_MODES, TUTOR_PAGE_CONTEXT, TUTOR_PAGE_PATH, type TutorContext, type TutorMode,
} from "../shared/trainingTutor";
import { chunkManuals, questionKey, retrieveChunks, type Chunk, type ManualDoc } from "./trainingTutorRules";

/** Quem faz de tutor na Formação (Definições; sem valor gravado ou inválido → "multis"). Nunca lança. */
export async function trainingTutorMode(): Promise<TutorMode> {
  try {
    const { getSetting } = await import("./appSettings");
    const v = await getSetting("training.tutorMode");
    return v && (TUTOR_MODES as readonly string[]).includes(v) ? v : TUTOR_DEFAULT_MODE;
  } catch {
    return TUTOR_DEFAULT_MODE;
  }
}

/** É a página Formação (caminho exato, sem "?…")? PURA. */
export function isTutorPagePath(path: unknown): boolean {
  return pagePathOf(path) === TUTOR_PAGE_PATH;
}

/** Os manuais não publicados: só admin e acima (o mesmo critério do ecrã e do tutor). PURA. */
export function seesUnpublishedTraining(role: string): boolean {
  return roleRank(role) >= roleRank("admin");
}

// ─── Trechos da formação ─────────────────────────────────────────────────────

export type TrainingHitKind = "manual" | "video" | "outro";

export interface TrainingHit {
  kind: TrainingHitKind;
  /** Id do manual ou do vídeo (null = descrição de um percurso). */
  id: number | null;
  title: string;
  heading: string;
  text: string;
  /** Abre o manual/vídeo na página Formação (null sem id). */
  href: string | null;
}

/** Vídeos entram como documentos com id negativo (−id do vídeo); 0 = descrição de percurso. */
const videoDocId = (videoId: number) => -Math.abs(videoId);

/** Um trecho → resultado com o tipo e a ligação. PURA. */
export function trainingHitOf(c: Chunk): TrainingHit {
  if (c.manualId > 0) return { kind: "manual", id: c.manualId, title: c.manualTitle, heading: c.heading, text: c.text, href: `${TUTOR_PAGE_PATH}?manual=${c.manualId}` };
  if (c.manualId < 0) {
    const id = -c.manualId;
    return { kind: "video", id, title: c.manualTitle, heading: c.heading, text: c.text, href: `${TUTOR_PAGE_PATH}?video=${id}` };
  }
  return { kind: "outro", id: null, title: c.manualTitle, heading: c.heading, text: c.text, href: null };
}

/**
 * Junta os trechos do módulo aberto (primeiro) com os do catálogo, sem
 * repetir o mesmo trecho, até `topK`. PURA.
 */
export function mergeTrainingHits(moduleHits: readonly Chunk[], catalogHits: readonly Chunk[], topK: number): Chunk[] {
  const out: Chunk[] = [];
  const seen = new Set<string>();
  for (const c of [...moduleHits, ...catalogHits]) {
    if (out.length >= topK) break;
    const k = `${c.manualId}|${c.heading}|${c.text.slice(0, 80)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

const CATALOG_TTL_MS = 60_000;
const CATALOG_MAX_MANUALS = 300;
const CATALOG_MAX_VIDEOS = 300;
const catalogMemo = new Map<boolean, { at: number; chunks: Chunk[] }>();

export function resetTrainingCatalogForTests(): void {
  catalogMemo.clear();
}

/**
 * O catálogo como o ecrã o mostra: manuais publicados (admin e acima: também
 * os não publicados), nunca os arquivados, e as descrições dos vídeos não
 * arquivados. Em memória por 60 s (por instância). Lança se a BD falhar.
 */
async function catalogChunks(includeUnpublished: boolean, now = Date.now()): Promise<Chunk[]> {
  const memo = catalogMemo.get(includeUnpublished);
  if (memo && now - memo.at < CATALOG_TTL_MS) return memo.chunks;
  const { getTrainingManuals, getTrainingVideos } = await import("./db");
  const [manuals, videos] = await Promise.all([getTrainingManuals(undefined, undefined, includeUnpublished), getTrainingVideos()]);
  const docs: ManualDoc[] = [
    ...(manuals as Array<{ id: number; title: string; content: string | null }>).slice(0, CATALOG_MAX_MANUALS)
      .map((m) => ({ id: m.id, title: m.title, content: m.content ?? "" })),
    ...(videos as Array<{ id: number; title: string; description: string | null }>).slice(0, CATALOG_MAX_VIDEOS)
      .filter((v) => (v.description ?? "").trim())
      .map((v) => ({ id: videoDocId(v.id), title: `Vídeo: ${v.title}`, content: v.description ?? "" })),
  ];
  const chunks = chunkManuals(docs);
  catalogMemo.set(includeUnpublished, { at: now, chunks });
  return chunks;
}

/**
 * Os trechos do módulo aberto (o MESMO conteúdo que o tutor lia:
 * `loadModule`). No vídeo, a descrição do próprio vídeo ganha o id dele (para
 * a ligação). Módulo que a pessoa não vê (ex.: manual não publicado) → nada.
 */
async function moduleChunks(module: TutorContext, includeUnpublished: boolean): Promise<{ title: string | null; chunks: Chunk[] }> {
  const { loadModule } = await import("./trainingTutorStore");
  const mod = await loadModule(module, { includeUnpublished });
  if (!mod.found) return { title: null, chunks: [] };
  const docs = mod.manuals.map((d) => (module.type === "video" && d.id === 0 && d.title.startsWith("Vídeo: ") ? { ...d, id: videoDocId(module.id) } : d));
  return { title: mod.title, chunks: chunkManuals(docs) };
}

export interface TrainingSearch {
  hits: TrainingHit[];
  /** Título do módulo aberto (se for um que a pessoa vê). */
  moduleTitle: string | null;
  /** A leitura falhou (BD) — não é o mesmo que "os manuais não falam disso". */
  failed: boolean;
}

/**
 * Procura nos manuais e vídeos da formação (sem IA). Primeiro o módulo aberto,
 * depois o catálogo. Nunca lança (falha → `failed`).
 */
export async function searchTrainingContent(question: string, opts: { role: string; module?: TutorContext | null; topK?: number }): Promise<TrainingSearch> {
  const q = String(question ?? "").trim();
  const topK = Math.max(1, Math.min(8, opts.topK ?? 3));
  if (q.length < 2) return { hits: [], moduleTitle: null, failed: false };
  const includeUnpublished = seesUnpublishedTraining(opts.role);
  let moduleTitle: string | null = null;
  let failed = false;
  let fromModule: Chunk[] = [];
  if (opts.module) {
    try {
      const m = await moduleChunks(opts.module, includeUnpublished);
      moduleTitle = m.title;
      fromModule = retrieveChunks(q, m.chunks, { topK });
    } catch {
      failed = true;
    }
  }
  let fromCatalog: Chunk[] = [];
  try {
    fromCatalog = retrieveChunks(q, await catalogChunks(includeUnpublished), { topK });
  } catch {
    failed = true;
  }
  const hits = mergeTrainingHits(fromModule, fromCatalog, topK).map(trainingHitOf);
  return { hits, moduleTitle, failed: failed && !hits.length };
}

// ─── Agregado anónimo para os formadores ─────────────────────────────────────

/**
 * Como o tutor próprio fazia: a pergunta (já sem dados pessoais) entra no
 * agregado ANÓNIMO "Perguntas ao tutor" do módulo aberto (ou da página, sem
 * módulo), com "sem resposta" quando não havia nada nos manuais ou o Multis
 * não respondeu. Nunca lança.
 */
export async function recordTutorQuestion(question: string, module: TutorContext | null, unanswered: boolean): Promise<void> {
  try {
    const { redactPii } = await import("./_core/ai/pii");
    const safe = redactPii(String(question ?? "").trim()).text;
    const key = questionKey(safe);
    if (!key) return;
    const { recordQuestion } = await import("./trainingTutorStore");
    await recordQuestion(module ?? { type: TUTOR_PAGE_CONTEXT, id: 0 }, key, safe, unanswered);
  } catch (err) {
    console.warn("[TrainingTutor] pergunta ao Multis não registada:", String((err as any)?.message ?? err).slice(0, 120));
  }
}
