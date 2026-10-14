/**
 * Catálogo da Formação por ÁREA e "procurar formação por tema" (Jorge, 14 out
 * 2026: "devia dar para procurar a formação que queres por tema, e depois ele
 * diz-te 'faz esta formação'").
 *
 *  - catálogo: manuais publicados e vídeos (não arquivados), cada um com a
 *    área/subsecção gravada ou a proposta pelas regras (shared/trainingAreas);
 *  - procurar: primeiro por palavras (searchCatalog, sempre); depois, se a
 *    IA estiver ligada (training_search → interruptor do tutor), a IA escolhe
 *    no catálogo pelo sentido (só títulos e resumos, com redactPii). Se a IA
 *    falhar, ficar sem tempo ou passar o limite, fica a pesquisa por palavras.
 *    Também mostra até 3 documentos da base de conhecimento que a pessoa pode ver.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { kbPlainText, type KbViewer } from "../shared/knowledge";
import { effectiveArea, searchCatalog, TRAINING_AREA_LABELS, type TrainingAreaId } from "../shared/trainingAreas";

export interface CatalogItem {
  key: string;
  itemType: "manual" | "video";
  id: number;
  title: string;
  description: string;
  /** Tipo de conteúdo do manual (manual, procedure, update, news, link). */
  manualType: string | null;
  categoryId: number | null;
  categoryName: string | null;
  area: TrainingAreaId | null;
  subarea: string | null;
  areaGuessed: boolean;
  durationMinutes: number | null;
  careerLevel: string | null;
  updatedAt: string | null;
}

const MANUAL_TYPE_LABELS: Record<string, string> = { manual: "Manual", update: "Atualização", news: "Notícia", procedure: "Procedimento", link: "Link interativo" };

async function db() {
  const { getDb } = await import("./db");
  const d = await getDb();
  if (!d) throw new Error("Base de dados indisponível");
  return d;
}

/** Resumo curto (sem Markdown) para o catálogo e para a IA. PURA. */
export function shortText(s: string | null | undefined, max = 180): string {
  const t = kbPlainText(String(s ?? "")).replace(/\s+/g, " ").trim();
  if (/^https?:\/\/\S+$/.test(t)) return "";
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Catálogo (com o texto para a pesquisa em `text`, que não vai para o browser). */
export async function loadCatalogWithText(): Promise<Array<CatalogItem & { text: string }>> {
  const d = await db();
  const { trainingCategories, trainingManuals, trainingVideos } = await import("../drizzle/schema");
  const [cats, manuals, videos] = await Promise.all([
    d.select({ id: trainingCategories.id, name: trainingCategories.name }).from(trainingCategories),
    d.select().from(trainingManuals).where(and(eq(trainingManuals.published, 1), isNull(trainingManuals.archivedAt))).orderBy(desc(trainingManuals.updatedAt)).limit(500),
    d.select().from(trainingVideos).where(isNull(trainingVideos.archivedAt)).orderBy(desc(trainingVideos.updatedAt)).limit(500),
  ]);
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  const out: Array<CatalogItem & { text: string }> = [];
  for (const m of manuals) {
    const cn = m.categoryId ? catName.get(m.categoryId) ?? null : null;
    const a = effectiveArea(m, cn);
    out.push({
      key: `manual:${m.id}`, itemType: "manual", id: m.id, title: m.title, description: shortText(m.content), manualType: m.type ?? "manual",
      categoryId: m.categoryId ?? null, categoryName: cn, area: a.area, subarea: a.subarea, areaGuessed: a.guessed,
      durationMinutes: null, careerLevel: m.careerLevel ?? null, updatedAt: m.updatedAt ?? null, text: String(m.content ?? "").slice(0, 3000),
    });
  }
  for (const v of videos) {
    const cn = catName.get(v.categoryId) ?? null;
    const a = effectiveArea({ ...v, content: v.description }, cn);
    out.push({
      key: `video:${v.id}`, itemType: "video", id: v.id, title: v.title, description: shortText(v.description), manualType: null,
      categoryId: v.categoryId ?? null, categoryName: cn, area: a.area, subarea: a.subarea, areaGuessed: a.guessed,
      durationMinutes: v.durationMinutes ?? null, careerLevel: v.careerLevel ?? null, updatedAt: v.updatedAt ?? null, text: String(v.description ?? "").slice(0, 3000),
    });
  }
  return out;
}

export async function loadCatalog(): Promise<CatalogItem[]> {
  return (await loadCatalogWithText()).map(({ text: _t, ...rest }) => rest);
}

export interface FindResult {
  q: string;
  mode: "ai" | "text";
  results: Array<CatalogItem & { reason: string | null }>;
  kb: Array<{ docId: number; title: string; section: string | null }>;
}

/** Linha do catálogo para a IA (id | tipo | área | título | resumo). PURA. */
export function catalogLine(i: CatalogItem): string {
  const area = i.area ? `${TRAINING_AREA_LABELS[i.area]}${i.subarea ? ` › ${i.subarea}` : ""}` : "—";
  const type = i.itemType === "video" ? "Vídeo" : MANUAL_TYPE_LABELS[i.manualType ?? "manual"] ?? "Manual";
  return `${i.itemType === "video" ? "v" : "m"}${i.id} | ${type} | ${area} | ${i.title.slice(0, 120)} | ${i.description.slice(0, 140)}`;
}

/** Ids devolvidos pela IA → itens do catálogo (só os que existem, sem repetir). PURA. */
export function resolvePicks<T extends Pick<CatalogItem, "id" | "itemType">>(picks: ReadonlyArray<{ id: string; reason: string }>, candidates: readonly T[], max = 5): Array<{ item: T; reason: string }> {
  const byId = new Map(candidates.map((c) => [`${c.itemType === "video" ? "v" : "m"}${c.id}`, c]));
  const out: Array<{ item: T; reason: string }> = [];
  const seen = new Set<string>();
  for (const p of picks ?? []) {
    const k = String(p?.id ?? "").trim().toLowerCase();
    const item = byId.get(k);
    if (!item || seen.has(k)) continue;
    seen.add(k);
    out.push({ item, reason: String(p?.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 160) });
    if (out.length >= max) break;
  }
  return out;
}

export interface FindDeps {
  catalog(): Promise<Array<CatalogItem & { text: string }>>;
  aiAvailable(): Promise<boolean>;
  rateOk(userId: number): Promise<boolean>;
  aiPick(q: string, lines: string[], userId: number): Promise<Array<{ id: string; reason: string }>>;
  /** `embeddings`: pode usar o vetor da pergunta (um pedido de embeddings) — só dentro do limite de pedidos. */
  kb(q: string, viewer: KbViewer, embeddings: boolean): Promise<FindResult["kb"]>;
}

export const realFindDeps: FindDeps = {
  catalog: loadCatalogWithText,
  async aiAvailable() {
    const { aiFeatureAvailableFresh } = await import("./_core/ai/status");
    return aiFeatureAvailableFresh("training_search");
  },
  async rateOk(userId) {
    try {
      const { checkRateLimit, userKey } = await import("./_core/ai/rateLimit");
      return (await checkRateLimit(`training_search:${userKey(userId)}`, { perMinute: 6, perDay: 60 })).allowed;
    } catch {
      return false;
    }
  },
  async aiPick(q, lines, userId) {
    const { runAi } = await import("./_core/ai/run");
    const { redactPii } = await import("./_core/ai/pii");
    const { TRAINING_SEARCH_SYSTEM, trainingSearchInput, trainingSearchResponseSchema } = await import("./_core/ai/prompts/trainingAi");
    const red = redactPii(trainingSearchInput(q, lines));
    const r = await runAi({
      feature: "training_search", system: TRAINING_SEARCH_SYSTEM, input: red.text, schema: trainingSearchResponseSchema,
      maxTokens: 500, timeoutMs: 9_000, retries: 0, userId, entity: "training_search", entityId: null,
    });
    return r.output.picks.map((p) => ({ id: p.id, reason: red.strip(p.reason) }));
  },
  async kb(q, viewer, embeddings) {
    const { retrieveKnowledge } = await import("./knowledge/retrieve");
    // Fora do limite: só palavras-chave (sem pedido de embeddings).
    const r = await retrieveKnowledge({ question: q, viewer, topK: 6, ...(embeddings ? {} : { embedQuery: null }) });
    const out: FindResult["kb"] = [];
    for (const h of r.hits) {
      if (out.some((x) => x.docId === h.docId)) continue;
      out.push({ docId: h.docId, title: h.title, section: h.section });
      if (out.length >= 3) break;
    }
    return out;
  },
};

/**
 * "Faz esta formação": a melhor formação para o tema, outras sugestões e
 * documentos da base de conhecimento. Nunca lança por causa da IA.
 */
export async function findTraining(input: { q: string; userId: number; viewer: KbViewer }, deps: FindDeps = realFindDeps): Promise<FindResult> {
  const q = String(input.q ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  const empty: FindResult = { q, mode: "text", results: [], kb: [] };
  if (q.length < 2) return empty;
  // Um só pedido ao limitador por pesquisa (6/min, 60/dia): conta para a IA E para os embeddings da
  // base de conhecimento — quem carrega muitas vezes fica com a pesquisa por palavras, sem custos.
  const rateOk = q.length >= 3 ? await deps.rateOk(input.userId).catch(() => false) : false;
  const [catalog, kb] = await Promise.all([deps.catalog(), deps.kb(q, input.viewer, rateOk).catch(() => [] as FindResult["kb"])]);
  const strip = ({ text: _t, ...rest }: CatalogItem & { text: string }): CatalogItem => rest;
  // A categoria e o tipo também contam na pesquisa por palavras (o catálogo guarda-os noutros campos).
  const textHits = searchCatalog(q, catalog.map((c) => ({
    key: c.key, title: c.title, area: c.area, subarea: c.subarea, category: c.categoryName,
    typeLabel: c.itemType === "video" ? "Vídeo" : MANUAL_TYPE_LABELS[c.manualType ?? "manual"] ?? "Manual", text: c.text, c,
  })), 12).map((h) => ({ ...h, item: h.item.c }));
  const textResults = textHits.map((h) => ({ ...strip(h.item), reason: null as string | null }));
  if (catalog.length && q.length >= 3) {
    try {
      if (rateOk && (await deps.aiAvailable())) {
        // Candidatos: os da pesquisa por palavras e, para o "sentido", o resto do catálogo (até 80).
        const seen = new Set(textHits.map((h) => h.item.key));
        const candidates = [...textHits.map((h) => h.item), ...catalog.filter((c) => !seen.has(c.key))].slice(0, 80);
        const picks = resolvePicks(await deps.aiPick(q, candidates.map(catalogLine), input.userId), candidates, 5);
        if (picks.length) {
          const chosen = new Set(picks.map((p) => p.item.key));
          const rest = textResults.filter((r) => !chosen.has(r.key)).slice(0, 3);
          return { q, mode: "ai", results: [...picks.map((p) => ({ ...strip(p.item), reason: p.reason || null })), ...rest], kb };
        }
      }
    } catch { /* fica a pesquisa por palavras */ }
  }
  return { q, mode: "text", results: textResults.slice(0, 8), kb };
}
