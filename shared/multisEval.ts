/**
 * Avaliação do Multis (plano MPV §8.2, F8) — a parte PURA: o formato das
 * perguntas (server/fixtures/multisEval/), a chave das respostas gravadas das
 * ferramentas, a nota de cada repetição, as contas do relatório, os critérios
 * do go/no-go (só no conjunto A) e o relatório em Markdown.
 *
 * Regras (do plano, sem mexer):
 *  - 3 repetições por pergunta (temperatura 0,2, a do chat); uma pergunta
 *    PASSA com ≥ 2 das 3; o relatório mostra a taxa média por repetição e as
 *    perguntas instáveis (1 ou 2 de 3);
 *  - uma ferramenta chamada com argumentos que não estão gravados é ERRO DO
 *    EVAL: a repetição e a pergunta falham e a chamada fica listada para gravar — nunca um
 *    resultado vazio;
 *  - o juiz IA só responde a "inventou uma regra?" e 20 % das respostas
 *    julgadas ficam marcadas para o Jorge rever;
 *  - teto de 15 € (com o juiz): atingido a meio → o eval PÁRA e fica
 *    "incompleto" (nunca um resultado parcial dado como bom);
 *  - critérios só no conjunto A: MPV-Argon ≥ 90 % de factos certos e secção
 *    certa, 0 regras inventadas, p95 < 25 s; MPV-lite ≥ 80 %; custo médio.
 */
import { z } from "zod";

// ─── Versões, conjuntos e papéis ────────────────────────────────────────────

export const EVAL_VARIANTS = ["v1-lite", "mpv-lite", "mpv-argon"] as const;
export type EvalVariant = (typeof EVAL_VARIANTS)[number];
export const EVAL_SETS = ["A", "B"] as const;
export type EvalSet = (typeof EVAL_SETS)[number];

export interface EvalVariantDef {
  label: string;
  /** O conteúdo do Multis: v1 (de sempre) ou mpv (árvore, perfis, ferramentas do piloto). */
  content: "v1" | "mpv";
  /** A funcionalidade que a versão imita em produção (voltas, teto de saída). */
  feature: "assistant" | "assistant_smart";
  tier: "lite" | "smart";
  /** Conjuntos em que corre (o Argon só no A — plano §8.2). */
  sets: readonly EvalSet[];
}
export const EVAL_VARIANT_DEFS: Record<EvalVariant, EvalVariantDef> = {
  "v1-lite": { label: "v1 (lite)", content: "v1", feature: "assistant", tier: "lite", sets: ["A", "B"] },
  "mpv-lite": { label: "MPV (lite)", content: "mpv", feature: "assistant", tier: "lite", sets: ["A", "B"] },
  "mpv-argon": { label: "MPV (Argon)", content: "mpv", feature: "assistant_smart", tier: "smart", sets: ["A"] },
};
export const isEvalVariant = (v: unknown): v is EvalVariant => typeof v === "string" && (EVAL_VARIANTS as readonly string[]).includes(v);
export const isEvalSet = (v: unknown): v is EvalSet => typeof v === "string" && (EVAL_SETS as readonly string[]).includes(v);

/** Papéis das perguntas (os quatro do plano + o super admin, para as páginas só dele). */
export const EVAL_ROLES = ["extra", "team_leader", "supervisor", "admin", "super_admin"] as const;
export type EvalRole = (typeof EVAL_ROLES)[number];
export const EVAL_CITIES = ["Lisboa", "Porto", "Faro"] as const;

export const EVAL_REPS_DEFAULT = 3;
/** Uma pergunta passa com ≥ 2 das 3 repetições. */
export const EVAL_PASS_MIN = 2;
/** Temperatura (a do chat, runChatTurn). */
export const EVAL_TEMPERATURE = 0.2;
/** Teto do eval (inclui o juiz), em euros. */
export const EVAL_BUDGET_EUR = 15;
/** Parte das respostas julgadas que fica marcada para o Jorge rever. */
export const EVAL_JUDGE_REVIEW_SHARE = 0.2;
/** Tamanho máximo do conjunto B. */
export const EVAL_SET_B_MAX = 100;
/** "Hoje" das perguntas sem data (reprodutível: o <contexto> leva esta data). */
export const EVAL_TODAY = "2026-10-21";

/** Critérios do lançamento (plano §8.2) — só no conjunto A. */
export const EVAL_CRITERIA = {
  argon: { factsSectionMin: 0.9, inventedMax: 0, p95MaxMs: 25_000 },
  lite: { factsSectionMin: 0.8 },
} as const;

/**
 * Reserva antes de cada repetição (o custo máximo provável de uma pergunta,
 * com o juiz): com menos do que isto até ao teto, o eval pára antes de
 * começar a seguinte (nunca passa do teto por mais do que uma pergunta).
 */
export const EVAL_REP_RESERVE_EUR: Record<EvalVariantDef["tier"], number> = { lite: 0.03, smart: 0.25 };

// ─── O formato das perguntas ────────────────────────────────────────────────

const argsObject = z.record(z.string(), z.unknown());

export const evalRecordingSchema = z.object({
  ferramenta: z.string().min(1).max(60),
  /** Os argumentos gravados (ou uma lista de alternativas que dão a mesma resposta). */
  args: z.union([argsObject, z.array(argsObject).min(1).max(20)]).default({}),
  /** Só para este papel (omisso: qualquer papel). */
  papel: z.enum(EVAL_ROLES).optional(),
  /** O que a ferramenta devolveu (antes de tapar os dados pessoais — o eval tapa como a produção). */
  resposta: argsObject,
}).strict();
export type EvalRecording = z.infer<typeof evalRecordingSchema>;

export const evalQuestionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._-]{1,48}$/, "id: letras, números, ponto, hífen ou _ (até 48)."),
  pergunta: z.string().trim().min(3).max(1000),
  /** A página onde se pergunta (o caminho, ex.: /extras-dia). */
  pagina: z.string().startsWith("/").max(200),
  separador: z.string().max(40).nullable().optional(),
  registo: z.object({ type: z.string().max(20), id: z.number().int().positive() }).nullable().optional(),
  papel: z.enum(EVAL_ROLES),
  /** Cidades da pessoa (omisso: Lisboa até supervisor; todas para admin e super admin). */
  cidades: z.array(z.enum(EVAL_CITIES)).min(1).max(3).optional(),
  /** Id da secção da ajuda que tem de ser usada (ficheiro.md#secção) ou null. */
  seccaoEsperada: z.string().max(200).nullable(),
  /** A ferramenta que tem de ser chamada ou null. */
  ferramentaEsperada: z.string().max(60).nullable(),
  /** Expressões regulares (sem barras; maiúsculas e acentos não contam) que TÊM de aparecer. */
  factosObrigatorios: z.array(z.string().min(1).max(300)).max(20).default([]),
  /** Expressões regulares que NÃO podem aparecer. */
  factosProibidos: z.array(z.string().min(1).max(300)).max(20).default([]),
  /** Respostas gravadas das ferramentas (por cima das partilhadas em gravacoes/). */
  gravacoes: z.array(evalRecordingSchema).max(30).default([]),
  /** Só nestas versões do conteúdo (omisso: as duas). */
  versoes: z.array(z.enum(["v1", "mpv"])).min(1).optional(),
  /** "Hoje" da pergunta (AAAA-MM-DD; omisso: EVAL_TODAY). */
  hoje: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Caso de injeção (instruções escondidas nos dados). */
  injecao: z.boolean().optional(),
  nota: z.string().max(500).optional(),
}).strict();
export type EvalQuestion = z.infer<typeof evalQuestionSchema>;
export type EvalQuestionInput = z.input<typeof evalQuestionSchema>;

/** Lê e valida um ficheiro de perguntas (uma lista ou { perguntas: [...] }). Expressões inválidas e ids repetidos são erro. PURA. */
export function parseEvalQuestions(raw: unknown, source = "perguntas"): { questions: EvalQuestion[]; errors: string[] } {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as any).perguntas) ? (raw as any).perguntas : null;
  if (!list) return { questions: [], errors: [`${source}: tem de ser uma lista de perguntas (ou { "perguntas": [...] }).`] };
  const questions: EvalQuestion[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  list.forEach((item: unknown, i: number) => {
    const r = evalQuestionSchema.safeParse(item);
    if (!r.success) {
      errors.push(`${source} #${i + 1}: ${r.error.issues.map((x) => `${x.path.join(".") || "pergunta"}: ${x.message}`).join("; ")}`);
      return;
    }
    const q = r.data;
    if (seen.has(q.id)) { errors.push(`${source}: id repetido ${q.id}.`); return; }
    seen.add(q.id);
    for (const p of [...q.factosObrigatorios, ...q.factosProibidos]) {
      try { new RegExp(p, "iu"); } catch { errors.push(`${source} ${q.id}: expressão inválida «${p}».`); }
    }
    questions.push(q);
  });
  return { questions, errors };
}

/** Lê e valida um ficheiro de respostas gravadas partilhadas (uma lista ou { gravacoes: [...] }). PURA. */
export function parseEvalRecordings(raw: unknown, source = "gravações"): { recordings: EvalRecording[]; errors: string[] } {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as any).gravacoes) ? (raw as any).gravacoes : null;
  if (!list) return { recordings: [], errors: [`${source}: tem de ser uma lista de gravações (ou { "gravacoes": [...] }).`] };
  const recordings: EvalRecording[] = [];
  const errors: string[] = [];
  list.forEach((item: unknown, i: number) => {
    const r = evalRecordingSchema.safeParse(item);
    if (r.success) recordings.push(r.data);
    else errors.push(`${source} #${i + 1}: ${r.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
  });
  return { recordings, errors };
}

// ─── Respostas gravadas: a chave dos argumentos ─────────────────────────────

/** Sem acentos (NFD sem as marcas). PURA. */
export const stripAccents = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

function canon(v: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  if (v == null) return undefined;
  if (typeof v === "string") {
    const t = stripAccents(v).trim().toLowerCase().replace(/\s+/g, " ");
    if (!t) return undefined;
    return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t;
  }
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map((x) => canon(x, depth + 1)).filter((x) => x !== undefined);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const c = canon((v as Record<string, unknown>)[k], depth + 1);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return undefined;
}

/**
 * Os argumentos em forma canónica: chaves ordenadas, sem os vazios
 * (null/""), texto sem maiúsculas, acentos nem espaços a mais, "15" = 15.
 * Assim "Lisboa" e "lisboa " são a mesma gravação. PURA.
 */
export function canonicalArgs(args: unknown): string {
  const c = canon(args && typeof args === "object" && !Array.isArray(args) ? args : {});
  return JSON.stringify(c ?? {});
}

/**
 * A resposta gravada desta chamada: primeiro as gravações do papel, depois
 * as de qualquer papel; dentro de cada grupo, a primeira que bate. null = não
 * gravada (erro do eval). PURA.
 */
export function findRecording(recordings: readonly EvalRecording[], tool: string, args: unknown, role: EvalRole): EvalRecording | null {
  const key = canonicalArgs(args);
  const fits = (r: EvalRecording) => r.ferramenta === tool && (Array.isArray(r.args) ? r.args : [r.args]).some((a) => canonicalArgs(a) === key);
  return recordings.find((r) => r.papel === role && fits(r)) ?? recordings.find((r) => !r.papel && fits(r)) ?? null;
}

// ─── Factos ─────────────────────────────────────────────────────────────────

/** A expressão aparece na resposta? (maiúsculas e acentos não contam). PURA. */
export function factMatches(pattern: string, answer: string): boolean {
  let re: RegExp, reFolded: RegExp;
  try {
    re = new RegExp(pattern, "iu");
    reFolded = new RegExp(stripAccents(pattern), "iu");
  } catch {
    return false;
  }
  const folded = stripAccents(answer);
  return re.test(answer) || re.test(folded) || reFolded.test(folded);
}

// ─── Uma repetição ──────────────────────────────────────────────────────────

export interface EvalToolCall {
  tool: string;
  args: Record<string, unknown>;
  /** De onde veio a resposta: gravada, do código (ajuda e regras) ou não gravada (erro do eval). */
  source: "gravada" | "codigo" | "nao_gravada" | "recusada";
}

export interface EvalRepOutcome {
  rep: number;
  /** O Multis respondeu (sem falha do turno). */
  ok: boolean;
  /** Motivo da falha do turno (error, budget…). */
  failure: string | null;
  answer: string;
  /** Parou pelo teto do eval a meio desta repetição (não conta para as contas). */
  aborted: boolean;
  /** Chamadas com argumentos não gravados (erro do eval). */
  unrecorded: Array<{ tool: string; args: Record<string, unknown> }>;
  toolCalls: EvalToolCall[];
  /** Secções (MPV) ou ficheiros (v1) da ajuda que o modelo recebeu ou abriu. */
  helpSeen: string[];
  /** A secção esperada foi recebida/aberta (calculado com a árvore). */
  sectionCovered: boolean;
  latencyMs: number;
  /** Custo do turno (sem o juiz). */
  costEur: number;
  model: string | null;
  rounds: number;
  forcedFinal: boolean;
  finishReason: string | null;
  fallback: boolean;
  /** Juiz: inventou uma regra? (null = não julgada ou o juiz falhou). */
  invented: boolean | null;
  inventedRule: string | null;
  judgeCostEur: number;
  judgeError: string | null;
}

export interface EvalRepScore {
  factsOk: boolean;
  missingFacts: string[];
  forbiddenFacts: string[];
  sectionOk: boolean;
  toolOk: boolean;
  evalError: boolean;
  /** Factos certos E secção certa (o critério do plano). */
  factsSectionOk: boolean;
  pass: boolean;
}

/** A nota de uma repetição. PURA. */
export function scoreRep(q: Pick<EvalQuestion, "factosObrigatorios" | "factosProibidos" | "seccaoEsperada" | "ferramentaEsperada">, o: EvalRepOutcome): EvalRepScore {
  const answer = o.ok ? o.answer : "";
  const missingFacts = q.factosObrigatorios.filter((p) => !factMatches(p, answer));
  const forbiddenFacts = q.factosProibidos.filter((p) => factMatches(p, answer));
  const factsOk = o.ok && missingFacts.length === 0 && forbiddenFacts.length === 0;
  const sectionOk = o.ok && (q.seccaoEsperada == null || o.sectionCovered);
  const toolOk = o.ok && (q.ferramentaEsperada == null || o.toolCalls.some((c) => c.tool === q.ferramentaEsperada && c.source !== "recusada"));
  const evalError = o.unrecorded.length > 0;
  // O texto de recurso nunca conta como "factos certos" (mesmo que por acaso tenha as palavras).
  const factsSectionOk = factsOk && sectionOk && !evalError && !o.fallback;
  const pass = factsSectionOk && toolOk && o.invented !== true && !o.fallback;
  return { factsOk, missingFacts, forbiddenFacts, sectionOk, toolOk, evalError, factsSectionOk, pass };
}

// ─── Uma pergunta e o conjunto ──────────────────────────────────────────────

export interface EvalQuestionResult {
  id: string;
  pergunta: string;
  papel: EvalRole;
  pagina: string;
  separador: string | null;
  seccaoEsperada: string | null;
  ferramentaEsperada: string | null;
  injecao: boolean;
  /** Não se aplica a esta versão (ex.: ferramenta só do MPV no v1). */
  skipped: string | null;
  reps: Array<EvalRepOutcome & { score: EvalRepScore }>;
  /** Repetições que contam (sem as paradas pelo teto). */
  counted: number;
  passes: number;
  passed: boolean;
  factsSectionPasses: number;
  factsSectionPassed: boolean;
  /** Passou em 1 ou 2 de 3 (nem sempre igual). */
  unstable: boolean;
  inventedReps: number;
  evalErrorReps: number;
}

/** Junta as repetições de uma pergunta. PURA. */
export function questionResult(
  q: EvalQuestion, reps: readonly EvalRepOutcome[], o: { repsWanted: number; skipped?: string | null },
): EvalQuestionResult {
  const scored = reps.map((r) => ({ ...r, score: scoreRep(q, r) }));
  const counted = scored.filter((r) => !r.aborted);
  const passes = counted.filter((r) => r.score.pass).length;
  const fs = counted.filter((r) => r.score.factsSectionOk).length;
  const need = Math.min(EVAL_PASS_MIN, o.repsWanted);
  // Erro do eval (chamada por gravar) em QUALQUER repetição → a pergunta falha (plano §8.2), mesmo com 2 de 3.
  const evalError = counted.some((r) => r.score.evalError);
  return {
    id: q.id, pergunta: q.pergunta, papel: q.papel, pagina: q.pagina, separador: q.separador ?? null,
    seccaoEsperada: q.seccaoEsperada, ferramentaEsperada: q.ferramentaEsperada, injecao: !!q.injecao,
    skipped: o.skipped ?? null,
    reps: scored,
    counted: counted.length,
    passes,
    passed: !o.skipped && !evalError && counted.length >= o.repsWanted && passes >= need,
    factsSectionPasses: fs,
    factsSectionPassed: !o.skipped && !evalError && counted.length >= o.repsWanted && fs >= need,
    unstable: !o.skipped && passes > 0 && passes < counted.length,
    inventedReps: counted.filter((r) => r.invented === true).length,
    evalErrorReps: counted.filter((r) => r.score.evalError).length,
  };
}

/** Percentil com interpolação linear (como o percentile_cont). null sem valores. PURA. */
export function percentileOf(values: readonly number[], q: number): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * Math.min(Math.max(q, 0), 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

export interface EvalSummary {
  /** Perguntas que contam (corridas por inteiro, sem as que não se aplicam). */
  questions: number;
  skipped: number;
  passed: number;
  passRate: number | null;
  factsSectionPassed: number;
  factsSectionRate: number | null;
  /** Taxa de "passa" em cada repetição (1.ª, 2.ª, 3.ª) e a média. */
  perRepRates: Array<number | null>;
  meanRepRate: number | null;
  unstable: string[];
  /** Perguntas com pelo menos uma regra inventada, e o total de repetições com regra inventada. */
  inventedQuestions: string[];
  inventedReps: number;
  /** Repetições julgadas pelo juiz (e as que o juiz não conseguiu julgar). */
  judged: number;
  /** Repetições que o juiz devia julgar (responderam, sem texto de recurso nem erro do eval). */
  judgeExpected: number;
  judgeFailed: number;
  evalErrorQuestions: string[];
  injectionQuestions: number;
  injectionPassed: number;
  p50Ms: number | null;
  p95Ms: number | null;
  /** Custo médio de UMA resposta do Multis (= uma pergunta em produção; sem o juiz). */
  costPerAnswerEur: number | null;
  turnsCostEur: number;
  judgeCostEur: number;
  avgRounds: number | null;
  forcedFinalShare: number | null;
  maxTokensShare: number | null;
  fallbackShare: number | null;
}

const share = (a: number, b: number) => (b > 0 ? a / b : null);

/** As contas do relatório. PURA. */
export function summarizeEval(results: readonly EvalQuestionResult[], repsWanted: number): EvalSummary {
  const run = results.filter((r) => !r.skipped && r.counted >= repsWanted);
  const allReps = results.flatMap((r) => r.reps.filter((x) => !x.aborted));
  const perRepRates: Array<number | null> = [];
  for (let i = 0; i < repsWanted; i++) {
    const at = run.map((r) => r.reps.filter((x) => !x.aborted)[i]).filter(Boolean);
    perRepRates.push(share(at.filter((x) => x.score.pass).length, at.length));
  }
  const rates = perRepRates.filter((x): x is number => x != null);
  const turnsCost = allReps.reduce((a, r) => a + r.costEur, 0);
  const judgeCost = results.flatMap((r) => r.reps).reduce((a, r) => a + r.judgeCostEur, 0);
  const lat = allReps.filter((r) => r.ok).map((r) => r.latencyMs);
  const inj = run.filter((r) => r.injecao);
  return {
    questions: run.length,
    skipped: results.filter((r) => r.skipped).length,
    passed: run.filter((r) => r.passed).length,
    passRate: share(run.filter((r) => r.passed).length, run.length),
    factsSectionPassed: run.filter((r) => r.factsSectionPassed).length,
    factsSectionRate: share(run.filter((r) => r.factsSectionPassed).length, run.length),
    perRepRates,
    meanRepRate: rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
    unstable: run.filter((r) => r.unstable).map((r) => r.id),
    inventedQuestions: run.filter((r) => r.inventedReps > 0).map((r) => r.id),
    inventedReps: run.reduce((a, r) => a + r.inventedReps, 0),
    judged: allReps.filter((r) => r.invented != null).length,
    judgeExpected: allReps.filter((r) => r.ok && !r.fallback && r.unrecorded.length === 0).length,
    judgeFailed: allReps.filter((r) => r.judgeError).length,
    evalErrorQuestions: run.filter((r) => r.evalErrorReps > 0).map((r) => r.id),
    injectionQuestions: inj.length,
    injectionPassed: inj.filter((r) => r.passed).length,
    p50Ms: percentileOf(lat, 0.5),
    p95Ms: percentileOf(lat, 0.95),
    costPerAnswerEur: allReps.length ? turnsCost / allReps.length : null,
    turnsCostEur: turnsCost,
    judgeCostEur: judgeCost,
    avgRounds: allReps.length ? allReps.reduce((a, r) => a + r.rounds, 0) / allReps.length : null,
    forcedFinalShare: share(allReps.filter((r) => r.forcedFinal).length, allReps.length),
    maxTokensShare: share(allReps.filter((r) => r.finishReason === "MAX_TOKENS").length, allReps.length),
    fallbackShare: share(allReps.filter((r) => r.fallback).length, allReps.length),
  };
}

// ─── Critérios (só no conjunto A) ───────────────────────────────────────────

export interface EvalCriterion { label: string; target: string; value: string; ok: boolean | null }
export interface EvalCriteria {
  /** Os critérios aplicam-se a este relatório? (só no A, com o eval completo e com perguntas). */
  applies: boolean;
  why: string | null;
  items: EvalCriterion[];
  /** Todos os critérios cumpridos (null = não se avalia, ou algum ficou por avaliar). */
  ok: boolean | null;
  /** Algum critério ficou por avaliar (ex.: sem juiz): o veredicto nunca é "Cumpre". */
  pending: boolean;
}

const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1).replace(".", ",")} %`);
const secs = (ms: number | null) => (ms == null ? "—" : `${(ms / 1000).toFixed(1).replace(".", ",")} s`);
export const eurText = (v: number | null) => (v == null ? "—" : `${v.toFixed(v < 1 ? 4 : 2).replace(".", ",")} €`);

/** Veredicto: algum "não" → false; algum por avaliar (fora o custo, que é só informação) → null; senão true. PURA. */
function verdict(items: readonly EvalCriterion[], infoOnly: ReadonlySet<EvalCriterion>): { ok: boolean | null; pending: boolean } {
  const pending = items.some((i) => i.ok == null && !infoOnly.has(i));
  if (items.some((i) => i.ok === false)) return { ok: false, pending };
  return { ok: pending ? null : true, pending };
}

/** Os critérios do go/no-go para esta versão. PURA. */
export function evalCriteria(set: EvalSet, variant: EvalVariant, s: EvalSummary, complete: boolean): EvalCriteria {
  if (set !== "A") return { applies: false, why: "Os critérios do lançamento só contam no conjunto A (perguntas reais).", items: [], ok: null, pending: false };
  if (!complete) return { applies: false, why: "Eval INCOMPLETO: os critérios não se avaliam (um resultado parcial nunca conta como bom).", items: [], ok: null, pending: false };
  if (!s.questions) return { applies: false, why: "Conjunto A vazio: sem perguntas, não há critérios.", items: [], ok: null, pending: false };
  const cost: EvalCriterion = { label: "Custo médio por pergunta", target: "dentro do teto do D2", value: eurText(s.costPerAnswerEur), ok: null };
  if (variant === "mpv-argon") {
    const c = EVAL_CRITERIA.argon;
    const items: EvalCriterion[] = [
      { label: "Factos certos e secção certa", target: `≥ ${c.factsSectionMin * 100} %`, value: pct(s.factsSectionRate), ok: s.factsSectionRate != null && s.factsSectionRate >= c.factsSectionMin },
      // Sem juiz (--no-judge), ou com repetições por julgar, este critério NÃO se avalia (nunca "cumpre" por omissão).
      s.judged < s.judgeExpected
        ? { label: "Regras inventadas (juiz)", target: `${c.inventedMax}`, value: `não avaliado (${s.judged} de ${s.judgeExpected} julgadas)`, ok: s.inventedReps > c.inventedMax ? false : null }
        : { label: "Regras inventadas (juiz)", target: `${c.inventedMax}`, value: `${s.inventedReps}`, ok: s.inventedReps <= c.inventedMax },
      { label: "Tempo de resposta p95", target: `< ${c.p95MaxMs / 1000} s`, value: secs(s.p95Ms), ok: s.p95Ms != null && s.p95Ms < c.p95MaxMs },
      cost,
    ];
    return { applies: true, why: null, items, ...verdict(items, new Set([cost])) };
  }
  if (variant === "mpv-lite") {
    const c = EVAL_CRITERIA.lite;
    const items: EvalCriterion[] = [
      { label: "Factos certos e secção certa", target: `≥ ${c.factsSectionMin * 100} %`, value: pct(s.factsSectionRate), ok: s.factsSectionRate != null && s.factsSectionRate >= c.factsSectionMin },
      cost,
    ];
    return { applies: true, why: null, items, ...verdict(items, new Set([cost])) };
  }
  return { applies: true, why: "O v1 é a referência (sem critério próprio): compara-se com o MPV.", items: [cost], ok: null, pending: false };
}

// ─── Amostra do juiz para o Jorge rever ─────────────────────────────────────

/** FNV-1a de 32 bits (amostras reprodutíveis). PURA. */
export function fnv32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/**
 * 20 % das respostas julgadas (pelo menos 1 se houver), escolhidas por um
 * hash fixo de (pergunta, repetição) — a mesma amostra em cada corrida —, mais
 * TODAS as que o juiz disse "inventou" (essas revêem-se sempre). PURA.
 */
export function judgeReviewSample<T extends { id: string; rep: number; invented: boolean | null }>(items: readonly T[], ratio = EVAL_JUDGE_REVIEW_SHARE): T[] {
  const judged = items.filter((x) => x.invented != null);
  if (!judged.length) return [];
  const n = Math.max(1, Math.ceil(judged.length * ratio));
  const sample = [...judged].sort((a, b) => fnv32(`${a.id}#${a.rep}`) - fnv32(`${b.id}#${b.rep}`) || a.id.localeCompare(b.id) || a.rep - b.rep).slice(0, n);
  const keys = new Set(sample.map((x) => `${x.id}#${x.rep}`));
  for (const x of judged) if (x.invented === true && !keys.has(`${x.id}#${x.rep}`)) { sample.push(x); keys.add(`${x.id}#${x.rep}`); }
  return sample;
}

// ─── O relatório ────────────────────────────────────────────────────────────

export interface EvalReport {
  set: EvalSet;
  variant: EvalVariant;
  reps: number;
  startedAt: string;
  finishedAt: string;
  models: string[];
  complete: boolean;
  incompleteReason: string | null;
  budgetEur: number;
  spentEur: number;
  questionsTotal: number;
  results: EvalQuestionResult[];
  summary: EvalSummary;
  criteria: EvalCriteria;
  judgeReview: Array<{ id: string; rep: number; invented: boolean | null; rule: string | null; answer: string }>;
  /** Chamadas por gravar (erro do eval), sem repetidas. */
  toRecord: Array<{ id: string; tool: string; args: Record<string, unknown> }>;
  /** Avisos (ex.: o nível smart não está no Argon). */
  warnings: string[];
}

/** As chamadas por gravar, sem repetidas (pergunta + ferramenta + argumentos canónicos). PURA. */
export function toRecordList(results: readonly EvalQuestionResult[]): EvalReport["toRecord"] {
  const out: EvalReport["toRecord"] = [];
  const seen = new Set<string>();
  for (const r of results) for (const rep of r.reps) for (const u of rep.unrecorded) {
    const k = `${r.id}|${u.tool}|${canonicalArgs(u.args)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ id: r.id, tool: u.tool, args: u.args });
  }
  return out;
}

const mdCell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const clipText = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** O relatório em Markdown (para o go/no-go). PURA. */
export function evalReportMarkdown(r: EvalReport): string {
  const s = r.summary;
  const L: string[] = [];
  L.push(`# Eval do Multis — conjunto ${r.set} · ${EVAL_VARIANT_DEFS[r.variant].label}`);
  L.push("");
  L.push(`- Corrida: ${r.startedAt} → ${r.finishedAt} · modelo(s): ${r.models.join(", ") || "—"} · ${r.reps} repetições por pergunta (temperatura ${String(EVAL_TEMPERATURE).replace(".", ",")}).`);
  L.push(`- Estado: **${r.complete ? "COMPLETO" : "INCOMPLETO"}**${r.incompleteReason ? ` — ${r.incompleteReason}` : ""}.`);
  L.push(`- Gasto: ${eurText(r.spentEur)} de ${eurText(r.budgetEur)} (Multis ${eurText(s.turnsCostEur)}, juiz ${eurText(s.judgeCostEur)}).`);
  for (const w of r.warnings) L.push(`- Aviso: ${w}`);
  L.push("");
  if (!r.complete) {
    L.push("> **Eval incompleto: nenhum número abaixo serve para decidir o go/no-go.**");
    L.push("");
  }
  L.push("## Critérios (go/no-go)");
  if (!r.criteria.applies || !r.criteria.items.length) L.push(r.criteria.why ?? "—");
  if (r.criteria.items.length) {
    if (r.criteria.why) L.push(r.criteria.why);
    L.push("");
    L.push("| Critério | Meta | Resultado | Cumpre |");
    L.push("|---|---|---|---|");
    for (const c of r.criteria.items) L.push(`| ${c.label} | ${c.target} | ${c.value} | ${c.ok == null ? "—" : c.ok ? "sim" : "**não**"} |`);
    if (r.criteria.ok != null) L.push("", `**${r.criteria.ok ? "Cumpre os critérios." : "NÃO cumpre os critérios."}**`);
    else if (r.criteria.pending) L.push("", "**Por avaliar: há critérios que não se avaliaram (ex.: sem juiz) — não conta como «Cumpre».**");
  }
  L.push("");
  L.push("## Resumo");
  L.push(`- Perguntas: ${s.questions} (passam ${s.passed} = ${pct(s.passRate)}; não se aplicam ${s.skipped}; total no conjunto ${r.questionsTotal}).`);
  L.push(`- Factos certos e secção certa: ${s.factsSectionPassed} = ${pct(s.factsSectionRate)}.`);
  L.push(`- Taxa por repetição: ${s.perRepRates.map((x, i) => `${i + 1}.ª ${pct(x)}`).join(" · ")} · média ${pct(s.meanRepRate)}.`);
  L.push(`- Instáveis (1 ou 2 de ${r.reps}): ${s.unstable.length ? s.unstable.join(", ") : "nenhuma"}.`);
  L.push(`- Regras inventadas (juiz): ${s.inventedReps} repetições${s.inventedQuestions.length ? ` em ${s.inventedQuestions.join(", ")}` : ""}; julgadas ${s.judged}${s.judgeFailed ? `, ${s.judgeFailed} por julgar (o juiz falhou)` : ""}.`);
  if (s.injectionQuestions) L.push(`- Injeção (instruções escondidas nos dados): passam ${s.injectionPassed} de ${s.injectionQuestions}.`);
  L.push(`- Erros do eval (ferramenta com argumentos por gravar): ${s.evalErrorQuestions.length ? s.evalErrorQuestions.join(", ") : "nenhum"}.`);
  L.push(`- Tempo de resposta: p50 ${secs(s.p50Ms)} · p95 ${secs(s.p95Ms)}.`);
  L.push(`- Custo médio por pergunta (uma resposta, sem o juiz): ${eurText(s.costPerAnswerEur)} · voltas em média ${s.avgRounds == null ? "—" : s.avgRounds.toFixed(2).replace(".", ",")} · rondas finais forçadas ${pct(s.forcedFinalShare)} · MAX_TOKENS ${pct(s.maxTokensShare)} · texto de recurso ${pct(s.fallbackShare)}.`);
  L.push("");
  if (r.toRecord.length) {
    L.push("## Chamadas por gravar (erro do eval)");
    L.push("Grava a resposta em `gravacoes` da pergunta (ou em `server/fixtures/multisEval/gravacoes/`) e corre outra vez.");
    L.push("");
    L.push("| Pergunta | Ferramenta | Argumentos |");
    L.push("|---|---|---|");
    for (const t of r.toRecord) L.push(`| ${t.id} | ${t.tool} | \`${mdCell(JSON.stringify(t.args))}\` |`);
    L.push("");
  }
  L.push(`## Amostra do juiz para rever (${r.judgeReview.length})`);
  L.push("20 % das respostas julgadas (sempre as mesmas) e todas as marcadas como \"inventou\". Confirma se o juiz acertou.");
  L.push("");
  if (r.judgeReview.length) {
    L.push("| Pergunta | Rep. | Juiz | Regra apontada | Resposta (início) |");
    L.push("|---|---|---|---|---|");
    for (const j of r.judgeReview) L.push(`| ${j.id} | ${j.rep} | ${j.invented ? "inventou" : "não inventou"} | ${mdCell(j.rule ?? "—")} | ${mdCell(clipText(j.answer, 160))} |`);
  } else L.push("Nenhuma resposta julgada.");
  L.push("");
  L.push("## Perguntas");
  L.push("");
  L.push("| Pergunta | Papel | Página | Passa | Factos+secção | Falhas |");
  L.push("|---|---|---|---|---|---|");
  for (const q of r.results) {
    if (q.skipped) { L.push(`| ${q.id} | ${q.papel} | ${q.pagina} | — | — | não se aplica: ${mdCell(q.skipped)} |`); continue; }
    const why = new Set<string>();
    for (const rep of q.reps) {
      if (rep.aborted) { why.add("parada pelo teto"); continue; }
      if (!rep.ok) why.add(`falhou: ${rep.failure ?? "erro"}`);
      if (rep.score.missingFacts.length) why.add(`faltam: ${rep.score.missingFacts.join(", ")}`);
      if (rep.score.forbiddenFacts.length) why.add(`proibidos: ${rep.score.forbiddenFacts.join(", ")}`);
      if (rep.ok && !rep.score.sectionOk) why.add("secção errada");
      if (rep.ok && !rep.score.toolOk) why.add("ferramenta não usada");
      if (rep.score.evalError) why.add("erro do eval");
      if (rep.invented) why.add("inventou");
      if (rep.fallback) why.add("texto de recurso");
    }
    L.push(`| ${q.id} | ${q.papel} | ${q.pagina}${q.separador ? ` · ${q.separador}` : ""} | ${q.passes}/${q.counted}${q.passed ? " ✓" : ""} | ${q.factsSectionPasses}/${q.counted} | ${mdCell([...why].join("; ") || "—")} |`);
  }
  L.push("");
  return L.join("\n");
}
