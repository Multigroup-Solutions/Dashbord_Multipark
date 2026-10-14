/**
 * FAQs automáticas a partir da base de conhecimento (Jorge, 14 out 2026: "a IA
 * podia pegar nos ficheiros que estamos sempre a atualizar na Base de
 * Conhecimento e pôr daqui mais algumas FAQs, automático… uma vez por semana
 * vai lá, escolhe duas ou três e põe lá. Não é preciso eu aprovar; se não
 * gostar de alguma, elimino").
 *
 *   interruptor KB_FAQ_WEEKLY (só no trabalho semanal; desligado por omissão)
 *   → IA disponível (AI_ENABLED + AI_KB_FAQ) → documentos públicos da base
 *   (Drive/carregados; nunca a ajuda da app nem documentos com papéis/cidades)
 *   → escolha (pickFaqDocs: atualizados há pouco e ainda sem FAQ primeiro)
 *   → a IA escreve 2 candidatas por documento (texto com redactPii, com a
 *   lista das FAQs que existem e existiram) → filtro sem repetidas (as
 *   eliminadas ficam arquivadas e contam) → até 3 FAQs publicadas, marcadas
 *   "IA", com o documento de origem.
 *
 * Nada se apaga: eliminar uma FAQ arquiva-a (0385) e a linha fica como marca.
 */
import { sql } from "drizzle-orm";
import {
  FAQ_CANDIDATES_PER_DOC, FAQ_MIN_DOC_CHARS, FAQ_WEEKLY_DOCS, FAQ_WEEKLY_MAX, pickFaqDocs, selectNewFaqs,
  type ExistingFaq, type FaqCandidate, type FaqDocCandidate, type NewFaq,
} from "./trainingAiRules";

export interface FaqRunResult {
  ok: boolean;
  /** Motivo de não ter feito nada (interruptor, IA, sem documentos). */
  skipped: string | null;
  docs: Array<{ id: number; title: string }>;
  created: Array<{ id: number; question: string; docId: number; docTitle: string }>;
  errors: string[];
  ranAt: string;
  trigger: "weekly" | "manual";
}

export interface FaqDeps {
  /** Interruptor do trabalho semanal (KB_FAQ_WEEKLY). */
  weeklyOn(): Promise<boolean>;
  /** IA utilizável (AI_ENABLED + AI_KB_FAQ + fornecedor). */
  aiAvailable(): Promise<boolean>;
  loadDocs(): Promise<FaqDocCandidate[]>;
  docText(id: number): Promise<string | null>;
  /** Todas as FAQs, incluindo as arquivadas (eliminadas), da mais recente para a mais antiga. */
  existingFaqs(): Promise<Array<ExistingFaq & { sourceKbDocId?: number | null }>>;
  generate(doc: { id: number; title: string; text: string }, avoid: readonly string[], userId: number | null): Promise<FaqCandidate[]>;
  insert(rows: readonly NewFaq[]): Promise<number[]>;
  saveRun(r: FaqRunResult): Promise<void>;
  log(userId: number | null, details: string): Promise<void>;
  /**
   * Uma corrida de cada vez (semanal e "Gerar agora", em qualquer instância):
   * devolve a chave do cadeado ou null se outra corrida o tem.
   */
  acquireLock(): Promise<string | null>;
  releaseLock(token: string): Promise<void>;
  /** "Gerar agora": limite de pedidos (FAQ_MANUAL_PER_HOUR / FAQ_MANUAL_PER_DAY, para toda a gente). */
  manualRateOk(): Promise<boolean>;
  now(): Date;
}

/** "Gerar agora": no máximo 3 por hora e 8 por dia (cada corrida são até 3 pedidos à IA). */
export const FAQ_MANUAL_PER_HOUR = 3;
export const FAQ_MANUAL_PER_DAY = 8;
/** O cadeado expira sozinho passado este tempo (uma corrida dura menos de 60 s). */
const FAQ_LOCK_SECONDS = 150;
const FAQ_LOCK_KEY = "faqRunLock";

async function db() {
  const { getDb } = await import("./db");
  const d = await getDb();
  if (!d) throw new Error("Base de dados indisponível");
  return d;
}
const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};

/** Documentos que TODA a gente pode ver (as FAQs são para todos). */
const PUBLIC_DOC = sql`(d.visibilityRoles IS NULL OR d.visibilityRoles = '' OR d.visibilityRoles = '[]')
  AND (d.visibilityCities IS NULL OR d.visibilityCities = '' OR d.visibilityCities = '[]')`;

export const realFaqDeps: FaqDeps = {
  async weeklyOn() {
    const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([import("./_core/featureFlags"), import("../shared/appSettings")]);
    await ensureFeatureFlagOverrides().catch(() => undefined);
    return isFeatureEnabled("KB_FAQ_WEEKLY", { defaultEnabled: automationFlagDefault("KB_FAQ_WEEKLY") });
  },
  async aiAvailable() {
    const { aiFeatureAvailableFresh } = await import("./_core/ai/status");
    return aiFeatureAvailableFresh("kb_faq");
  },
  async loadDocs() {
    const d = await db();
    const rows = rowsOf(await d.execute(sql`SELECT d.id, d.title, d.charCount, d.modifiedTime, d.syncedAt, d.createdAt,
        (SELECT COUNT(*) FROM faqs f WHERE f.sourceKbDocId = d.id) AS faqCount,
        (SELECT MAX(f.createdAt) FROM faqs f WHERE f.sourceKbDocId = d.id) AS lastFaqAt
      FROM kb_documents d
      WHERE d.deletedAt IS NULL AND d.status = 'synced' AND d.source IN ('drive', 'upload')
        AND d.charCount >= ${FAQ_MIN_DOC_CHARS} AND ${PUBLIC_DOC}
      ORDER BY d.syncedAt DESC LIMIT 400`));
    const iso = (v: unknown): string | null => (v == null || v === "" ? null : v instanceof Date ? v.toISOString() : String(v));
    return rows.map((r) => {
      const mod = iso(r.modifiedTime), syn = iso(r.syncedAt) ?? iso(r.createdAt);
      const ms = (s: string | null) => (s ? Date.parse(s.includes("T") ? s : `${s.replace(" ", "T")}Z`) : NaN);
      const updatedAt = [mod, syn].filter((x): x is string => !!x && Number.isFinite(ms(x))).sort((a, b) => ms(b) - ms(a))[0] ?? null;
      return { id: Number(r.id), title: String(r.title ?? ""), charCount: Number(r.charCount ?? 0), updatedAt, faqCount: Number(r.faqCount ?? 0), lastFaqAt: iso(r.lastFaqAt) };
    });
  },
  async docText(id) {
    const d = await db();
    // Volta a confirmar que é público e está sincronizado (pode ter mudado entretanto).
    const r = rowsOf(await d.execute(sql`SELECT d.textContent FROM kb_documents d WHERE d.id = ${id} AND d.deletedAt IS NULL AND d.status = 'synced' AND ${PUBLIC_DOC} LIMIT 1`))[0];
    return r?.textContent != null ? String(r.textContent) : null;
  },
  async existingFaqs() {
    const d = await db();
    const { faqs } = await import("../drizzle/schema");
    const { desc } = await import("drizzle-orm");
    return (await d.select({ question: faqs.question, aiKey: faqs.aiKey, sourceKbDocId: faqs.sourceKbDocId }).from(faqs).orderBy(desc(faqs.id)))
      .map((r) => ({ question: r.question, aiKey: r.aiKey ?? null, sourceKbDocId: r.sourceKbDocId ?? null }));
  },
  async generate(doc, avoid, userId) {
    const { runAi } = await import("./_core/ai/run");
    const { redactPii } = await import("./_core/ai/pii");
    const { KB_FAQ_SYSTEM, kbFaqInput, kbFaqResponseSchema } = await import("./_core/ai/prompts/trainingAi");
    const red = redactPii(doc.text.slice(0, 20_000));
    const r = await runAi({
      feature: "kb_faq",
      system: KB_FAQ_SYSTEM,
      input: kbFaqInput({ title: doc.title, text: red.text, existing: avoid, n: FAQ_CANDIDATES_PER_DOC }),
      schema: kbFaqResponseSchema,
      maxTokens: 900,
      timeoutMs: 20_000,
      retries: 0,
      userId,
      entity: "kb_document",
      entityId: doc.id,
    });
    return r.output.faqs.slice(0, 4).map((f) => ({ question: red.strip(f.question), answer: red.strip(f.answer) }));
  },
  async insert(rows) {
    if (!rows.length) return [];
    const d = await db();
    const { faqs } = await import("../drizzle/schema");
    const ids: number[] = [];
    for (const r of rows) {
      const [res] = await d.insert(faqs).values({ question: r.question, answer: r.answer, categoryId: null, sortOrder: 0, source: "ai", sourceKbDocId: r.docId, aiKey: r.aiKey }).$returningId();
      ids.push(Number((res as any)?.id ?? 0));
    }
    return ids;
  },
  async saveRun(r) {
    const store = await import("./knowledge/store");
    await store.setState(await store.kbDb(), "faqLastRun", JSON.stringify({ ...r, created: r.created.slice(0, 5), errors: r.errors.slice(0, 5) }));
  },
  async log(userId, details) {
    try {
      const { logActivity } = await import("./db");
      await logActivity({ userId: userId ?? 0, action: "create", entity: "faq", entityId: null, details: details.slice(0, 300) } as any);
    } catch { /* auditoria nunca parte a corrida */ }
  },
  async acquireLock() {
    const d = await db();
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    await d.execute(sql`INSERT IGNORE INTO kb_sync_state (stateKey, value) VALUES (${FAQ_LOCK_KEY}, NULL)`);
    const res: any = await d.execute(sql`UPDATE kb_sync_state SET value = ${token}, updatedAt = NOW()
      WHERE stateKey = ${FAQ_LOCK_KEY} AND (value IS NULL OR value = '' OR updatedAt < NOW() - INTERVAL ${FAQ_LOCK_SECONDS} SECOND)`);
    const n = Number((Array.isArray(res) ? res[0] : res)?.affectedRows ?? 0);
    return n === 1 ? token : null;
  },
  async releaseLock(token) {
    try {
      const d = await db();
      await d.execute(sql`UPDATE kb_sync_state SET value = NULL WHERE stateKey = ${FAQ_LOCK_KEY} AND value = ${token}`);
    } catch { /* expira sozinho */ }
  },
  async manualRateOk() {
    try {
      const { checkRateLimit } = await import("./_core/ai/rateLimit");
      return (await checkRateLimit("kb_faq_now:all", { perHour: FAQ_MANUAL_PER_HOUR, perDay: FAQ_MANUAL_PER_DAY })).allowed;
    } catch {
      return false;
    }
  },
  now: () => new Date(),
};

/**
 * Uma corrida (semanal ou "Gerar agora"). Nunca lança: os erros vão em
 * `errors` (e `ok:false` quando nenhum documento conseguiu passar pela IA).
 */
export async function runKbFaqGeneration(opts: { trigger: "weekly" | "manual"; userId?: number | null; deadlineAt?: number }, deps: FaqDeps = realFaqDeps): Promise<FaqRunResult> {
  const now = deps.now();
  const out: FaqRunResult = { ok: true, skipped: null, docs: [], created: [], errors: [], ranAt: now.toISOString(), trigger: opts.trigger };
  const userId = opts.userId ?? null;
  if (opts.trigger === "weekly" && !(await deps.weeklyOn().catch(() => false))) return { ...out, skipped: "desligado (Definições → Automações: Formação: FAQs novas da base de conhecimento)" };
  if (!(await deps.aiAvailable().catch(() => false))) {
    const r = { ...out, skipped: "IA desligada (Definições → Automações: IA: FAQs a partir da base de conhecimento)" };
    await deps.saveRun(r).catch(() => undefined);
    return r;
  }
  // Uma corrida de cada vez: sem isto, a semanal e um "Gerar agora" (ou dois
  // cliques) liam as mesmas FAQs e gravavam as mesmas perguntas duas vezes.
  const lock = await deps.acquireLock().catch(() => null);
  // Semanal: "locked" faz o agendador tentar outra vez no tick seguinte.
  if (!lock) return { ...out, skipped: opts.trigger === "weekly" ? "locked" : "já há uma geração a correr (a semanal ou outro «Gerar agora») — tenta daqui a um minuto" };
  try {
    if (opts.trigger === "manual" && !(await deps.manualRateOk())) {
      return { ...out, skipped: `limite do «Gerar agora» (${FAQ_MANUAL_PER_HOUR} por hora e ${FAQ_MANUAL_PER_DAY} por dia) — tenta mais tarde` };
    }
    return await generateLocked(opts, deps, out, now, userId);
  } finally {
    await deps.releaseLock(lock).catch(() => undefined);
  }
}

async function generateLocked(opts: { trigger: "weekly" | "manual"; deadlineAt?: number }, deps: FaqDeps, out: FaqRunResult, now: Date, userId: number | null): Promise<FaqRunResult> {
  try {
    const docs = pickFaqDocs(await deps.loadDocs(), now, FAQ_WEEKLY_DOCS);
    out.docs = docs.map((d) => ({ id: d.id, title: d.title }));
    if (!docs.length) {
      const r = { ...out, skipped: "sem documentos novos ou atualizados na base de conhecimento" };
      await deps.saveRun(r).catch(() => undefined);
      return r;
    }
    const existing = await deps.existingFaqs();
    const perDoc: Array<{ docId: number; docTitle: string; items: FaqCandidate[] }> = [];
    let tried = 0;
    for (const doc of docs) {
      // Cada documento é um pedido à IA (até 20 s): só começa outro se ainda houver tempo.
      if (opts.deadlineAt && tried > 0 && Date.now() > opts.deadlineAt - 22_000) break;
      const text = await deps.docText(doc.id);
      if (!text || text.trim().length < FAQ_MIN_DOC_CHARS) continue;
      tried++;
      // Para a IA: primeiro as FAQs deste documento, depois as mais recentes (o filtro a sério é o selectNewFaqs).
      const avoid = [...existing.filter((e) => e.sourceKbDocId === doc.id), ...existing.filter((e) => e.sourceKbDocId !== doc.id)].map((e) => e.question);
      try {
        perDoc.push({ docId: doc.id, docTitle: doc.title, items: await deps.generate({ id: doc.id, title: doc.title, text }, avoid, userId) });
      } catch (err: any) {
        const { aiUserMessage } = await import("./_core/ai/errors");
        out.errors.push(`«${doc.title.slice(0, 80)}»: ${aiUserMessage(err)}`);
      }
    }
    const fresh = selectNewFaqs(perDoc, existing, FAQ_WEEKLY_MAX);
    const ids = await deps.insert(fresh);
    out.created = fresh.map((f, i) => ({ id: ids[i] ?? 0, question: f.question, docId: f.docId, docTitle: f.docTitle }));
    if (tried > 0 && !perDoc.length) out.ok = false;
    if (out.created.length) {
      await deps.log(userId, `FAQs da base de conhecimento (${opts.trigger === "weekly" ? "semanal" : "Gerar agora"}): ${out.created.length} nova(s) — ${out.created.map((c) => c.question).join(" · ")}`);
    } else if (!out.errors.length) {
      out.skipped = "a IA não trouxe nenhuma FAQ nova (as que propôs já existiam)";
    }
  } catch (err: any) {
    out.ok = false;
    out.errors.push(String(err?.message ?? err).slice(0, 200));
  }
  await deps.saveRun(out).catch(() => undefined);
  return out;
}

/** Última corrida (para o cartão das FAQs). */
export async function lastFaqRun(): Promise<FaqRunResult | null> {
  try {
    const store = await import("./knowledge/store");
    const raw = await store.getState(await store.kbDb(), "faqLastRun");
    return raw ? (JSON.parse(raw) as FaqRunResult) : null;
  } catch {
    return null;
  }
}
