/**
 * "Testar a triagem" (14 out 2026 — meta do Jorge: mais de 90 % das
 * reclamações e dos perdidos vão para lá).
 *
 * Corre os corpora rotulados — o principal (server/fixtures/mailTriageCorpus.ts),
 * o de CONTROLO, escrito à parte por quem auditou
 * (server/fixtures/mailTriageHoldout.ts), e o CEGO, escrito na 2.ª auditoria
 * antes de ler os outros (server/fixtures/mailTriageBlind.ts) — pelo MESMO caminho de produção: os
 * mesmos factos (remetente, automático, reencaminhado), a mesma pré-triagem
 * (regras sem IA), o MESMO pedido à IA (classifyEmailWithAi, com o fornecedor
 * configurado), a MESMA decisão (decideMailTriage com as certezas das
 * Definições; reclamacoes@/perdidos@ pela mesma porta aliasGateIsNoise) e a
 * MESMA porta do caso (caseIntakeDecision: interno, automático, envio em
 * massa, aviso de avaliação). Uma reclamação ou um perdido só contam como
 * "foram para lá" quando o caso abre de facto. Mede recall e precisão por
 * categoria e conta os "Por confirmar". NÃO escreve nada nos casos nem na
 * Comunicação: só o registo do custo da IA e uma linha "[triagem-eval]" nos logs.
 *
 * Usado pelo botão em Definições → Comunicação (super admin, por lotes — cada
 * pedido cabe nos 60 s do Vercel) e por scripts/eval-mail-triage.ts.
 */
import {
  ALL_TRIAGE_FEATURES, DIRECT_CASE_PIPELINES, TRIAGE_CORPUS_KEYS, TRIAGE_CORPUS_LABELS, aliasGateIsNoise, bulkListMail, decideMailTriage, forwardedExternalSender,
  parseTriageCategory, preTriageMail, senderKindOf, triageMetrics, triageMetricsLogLine,
  type MailTriageCategory, type PreTriageFacts, type TriageCorpusKey, type TriageEvalRow, type TriageMetrics, type TriageThresholds,
} from "../shared/mailTriage";
import { DEFAULT_BRAND_DOMAINS, isAutomatedSender, isCompanyAddress } from "../shared/mail";
import { caseIntakeDecision } from "../shared/complaintIntake";
import { TRIAGE_CORPUS, type TriageCorpusItem } from "./fixtures/mailTriageCorpus";
import { TRIAGE_HOLDOUT } from "./fixtures/mailTriageHoldout";
import { TRIAGE_BLIND } from "./fixtures/mailTriageBlind";
import type { ClassifiedEmail, EmailRoutingMessage } from "./commsRouting";
import { mailRoutingSchema, type MailRoutingOutput } from "./_core/ai/prompts/comms";

/**
 * Uma resposta dada à mão ao script (`--answers`, scripts/eval-mail-triage.ts)
 * passa pelo MESMO esquema que a resposta da IA em produção (ronda 3 da
 * auditoria): "true" vale sim, um campo em falta vale 0 / não, e fora do
 * formato é como a IA ter falhado (lança "invalid_output") — senão o teste
 * offline media outra porta. PURA.
 */
export function parseOfflineAnswer(raw: unknown): MailRoutingOutput {
  const r = mailRoutingSchema.safeParse(raw);
  if (!r.success) throw Object.assign(new Error("resposta fora do formato"), { code: "invalid_output" });
  return r.data;
}

/** Os corpora rotulados: o principal, o de controlo (independente) e o cego (auditoria, ronda 2). */
export const TRIAGE_CORPORA: Record<TriageCorpusKey, readonly TriageCorpusItem[]> = { principal: TRIAGE_CORPUS, controlo: TRIAGE_HOLDOUT, cego: TRIAGE_BLIND };
export { TRIAGE_CORPUS_KEYS, TRIAGE_CORPUS_LABELS, type TriageCorpusKey };
const corpusOf = (k: TriageCorpusKey | null | undefined): readonly TriageCorpusItem[] => TRIAGE_CORPORA[k ?? "principal"] ?? TRIAGE_CORPUS;

/**
 * Teto de custo do "Testar a triagem" (por pessoa): cada lote são até 20
 * leituras da IA; os três corpora (~260 emails) são ~23 lotes de 12 — uma
 * corrida completa por hora e umas 4 por dia.
 */
export const MAIL_TRIAGE_EVAL_LIMITS = { perHour: 40, perDay: 110 } as const;

/** Pipeline de cada caixa do corpus (o das caixas reais). */
const BOX_PIPELINE: Record<string, string> = {
  reclamacoes: "reclamacoes", perdidos: "perdidos", criticas: "criticas", ocorrencias: "ocorrencias", rh: "recursos-humanos", campanhas: "campanhas",
};
const BOX_LABEL: Record<string, string> = {
  info: "Info (geral)", reservas: "Reservas (geral)", rh: "Recursos Humanos", reclamacoes: "Reclamações", perdidos: "Perdidos e Achados",
  criticas: "Críticas", ocorrencias: "Ocorrências", alteracoes: "Alterações", cancelamentos: "Cancelamentos", faturacao: "Faturação", comercial: "Comercial",
};
/** Todas as caixas de tema existem (a avaliação mede a leitura, não a configuração). */
const ALL_BOXES: ReadonlySet<string> = new Set(["info", "rh", "reservas", "alteracoes", "cancelamentos", "servicos_extra", "reclamacoes", "perdidos", "parcerias", "faturacao", "criticas", "ocorrencias"]);

export interface CorpusFacts { pre: PreTriageFacts; msg: EmailRoutingMessage; fromLabel: string }

/** Um email do corpus → os factos que a produção calcula de um email guardado (sem BD). PURA. */
export function corpusFacts(item: TriageCorpusItem, brandDomains: Record<string, string[]> = DEFAULT_BRAND_DOMAINS): CorpusFacts {
  const company = (a: string) => isCompanyAddress(a, brandDomains);
  // Como a sincronização (server/mail/sync.ts): automático pelo endereço OU pelos cabeçalhos.
  const automated = isAutomatedSender(item.fromEmail, item.headers ?? {}) ? 1 : 0;
  const senderKind = senderKindOf({ fromEmail: item.fromEmail, automated }, company);
  const pipeline = BOX_PIPELINE[item.box] ?? null;
  return {
    fromLabel: BOX_LABEL[item.box] ?? item.box,
    pre: {
      outbound: false, personal: false, systemMail: false, automated, mailboxKey: item.box, pipeline, fromEmail: item.fromEmail, text: item.body,
      senderIsCompany: senderKind === "company", createdCase: false, threadHasCase: false, humanTouched: false,
    },
    msg: {
      threadId: 0, messageId: 0, fromBoxKey: item.box, subject: item.subject, text: item.body, fromName: item.fromName, fromEmail: item.fromEmail,
      attachmentNames: item.attachments ?? [], projectId: null, newThread: item.newThread ?? true, senderKind, mode: "sync",
      forwardedExternal: senderKind === "company" && !!forwardedExternalSender(item.body, company),
      listMail: bulkListMail({ automated, listUnsubscribe: item.headers?.listUnsubscribe, listId: item.headers?.listId }),
    },
  };
}

export interface EvalItemResult extends TriageEvalRow {
  via: "regra" | "ia" | "porta" | "falhou" | "fora";
  subject: string;
  note: string | null;
  reason: string | null;
  /** O caso que abriria (null = nenhum). */
  caseKind?: "complaint" | "lost_found" | null;
  /** O caso nasceria "Por confirmar (IA)". */
  uncertain?: boolean;
  error?: string;
}

type Classify = (msg: EmailRoutingMessage, fromLabel: string) => Promise<ClassifiedEmail & { model?: string }>;

/**
 * Um email do corpus pelo caminho de produção. A IA falhou → `predicted`
 * null (conta como errado). Nunca lança.
 */
export async function evalCorpusItem(item: TriageCorpusItem, classify: Classify, t: TriageThresholds): Promise<EvalItemResult & { model?: string }> {
  const base = { id: item.id, expected: item.expected, subject: item.subject, note: item.note ?? null };
  const f = corpusFacts(item);
  const pre = preTriageMail(f.pre);
  if (pre.action === "rule") return { ...base, predicted: pre.category, via: "regra", reason: `regra: ${pre.notice}` };
  const direct = pre.action === "skip" && pre.why === "case_box" && !!f.pre.pipeline && DIRECT_CASE_PIPELINES.has(f.pre.pipeline);
  if (pre.action === "skip" && !direct) return { ...base, predicted: null, via: "fora", reason: `fora da triagem: ${pre.why}` };
  let c: (ClassifiedEmail & { model?: string }) | null = null;
  try {
    c = await classify(f.msg, f.fromLabel);
  } catch (err: any) {
    // reclamacoes@/perdidos@: sem IA o caso abre na mesma (é o que a produção faz).
    if (direct) return { ...base, predicted: f.pre.pipeline === "perdidos" ? "perdidos" : "reclamacoes", via: "porta", reason: "a IA falhou — o caso abre na mesma", error: String(err?.code ?? err?.message ?? "erro").slice(0, 80) };
    return { ...base, predicted: null, via: "falhou", reason: null, error: String(err?.code ?? err?.message ?? "erro").slice(0, 80) };
  }
  const reason = String(c.output.reason ?? "").slice(0, 160) || null;
  if (direct) {
    const noise = aliasGateIsNoise(c.output, t);
    return { ...base, predicted: noise ? "ruido" : f.pre.pipeline === "perdidos" ? "perdidos" : "reclamacoes", via: "porta", reason, model: c.model };
  }
  const d = decideMailTriage(c.output, { sender: f.msg.senderKind!, forwardedExternal: !!f.msg.forwardedExternal, newThread: f.msg.newThread ?? true, mode: "sync" }, t, ALL_TRIAGE_FEATURES, ALL_BOXES);
  // A porta do caso (a mesma de produção, server/complaintMailIntake.ts): sem
  // caso aberto, uma reclamação ou um perdido NÃO "foram para lá".
  let predicted: MailTriageCategory = d.category;
  let caseKind = d.caseKind;
  let uncertain = d.uncertain;
  if (d.caseKind) {
    // Como a produção com os interruptores todos ligados (AI_MAIL_PARTNER_CASES incluído).
    const gate = caseIntakeDecision(d.caseKind, d.caseScore, corpusIntakeFacts(item, f), { createMinConfidence: t.createMinConfidence, suggestMinConfidence: t.suggestMinConfidence }, { partnerCases: true });
    if (gate.action === "create") uncertain = uncertain || gate.uncertain === true;
    else caseKind = null;
  }
  if (!caseKind && (predicted === "reclamacoes" || predicted === "perdidos")) predicted = "geral";
  const why = [caseKind ? (uncertain ? "por confirmar" : "caso") : null, reason].filter(Boolean).join(" — ") || null;
  return { ...base, predicted, via: "ia", reason: why, caseKind: caseKind ?? null, uncertain: !!caseKind && uncertain, model: c.model };
}

/** Os factos que a porta do caso lê (server/complaintMailIntake.ts factsOf), a partir do corpus. PURA. */
function corpusIntakeFacts(item: TriageCorpusItem, f: CorpusFacts) {
  const automated = f.pre.automated !== 0;
  return {
    fromBoxKey: item.box, fromBoxPipeline: f.pre.pipeline ?? null, outbound: false, automated, systemMail: false, personal: false,
    senderIsCompany: f.msg.senderKind === "company", forwardedExternal: !!f.msg.forwardedExternal,
    senderIsAutomated: isAutomatedSender(item.fromEmail), senderIsPartner: !!item.partner,
    subject: item.subject, text: item.body, senderEmail: item.fromEmail, listMail: !!f.msg.listMail,
  };
}

/** As certezas de produção (Definições), com a omissão se a BD não responder. */
export async function productionThresholds(): Promise<TriageThresholds> {
  const { commsRoutingSettings } = await import("../shared/commsRouting");
  const { complaintIntakeSettings } = await import("../shared/complaintIntake");
  let routing = commsRoutingSettings(null);
  let cases = complaintIntakeSettings(null);
  try {
    const { getSetting } = await import("./appSettings");
    routing = commsRoutingSettings(await getSetting("ai.commsRouting"));
    cases = complaintIntakeSettings(await getSetting("ai.mailComplaints"));
  } catch { /* omissão */ }
  return { minConfidence: routing.minConfidence, ...cases };
}

/** Um lote do corpus (`offset`, `limit`), `concurrency` pedidos de cada vez. */
export async function evalTriageSlice(
  opts: { offset: number; limit: number; concurrency?: number; corpus?: TriageCorpusKey },
  deps: { classify?: Classify; thresholds?: TriageThresholds; corpus?: readonly TriageCorpusItem[] } = {},
): Promise<{ total: number; items: EvalItemResult[]; model: string | null }> {
  const corpus = deps.corpus ?? corpusOf(opts.corpus);
  const classify = deps.classify ?? (async (m: EmailRoutingMessage, l: string) => (await import("./commsRouting")).classifyEmailWithAi(m, l));
  const t = deps.thresholds ?? (await productionThresholds());
  const slice = corpus.slice(Math.max(0, opts.offset), Math.max(0, opts.offset) + Math.max(1, Math.min(30, opts.limit)));
  const out: Array<EvalItemResult & { model?: string }> = new Array(slice.length);
  const width = Math.max(1, Math.min(6, opts.concurrency ?? 4));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, slice.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= slice.length) return;
      out[i] = await evalCorpusItem(slice[i], classify, t);
    }
  }));
  const model = out.find((r) => r?.model)?.model ?? null;
  return { total: corpus.length, items: out.map(({ model: _m, ...r }) => r), model };
}

/**
 * Contas finais a partir do que cada lote previu (os rótulos vêm SEMPRE do
 * corpus do servidor) e a linha "[triagem-eval]" nos logs.
 */
export function triageEvalReport(
  input: { rows: ReadonlyArray<{ id: string; predicted: string | null }>; ms?: number | null; model?: string | null; corpus?: TriageCorpusKey | null },
  corpus: readonly TriageCorpusItem[] = corpusOf(input.corpus),
  log: (line: string) => void = (l) => console.log(l),
): TriageMetrics & { missing: number } {
  const byId = new Map(corpus.map((c) => [c.id, c]));
  const rows: TriageEvalRow[] = [];
  for (const r of input.rows) {
    const c = byId.get(r.id);
    if (!c) continue;
    rows.push({ id: r.id, expected: c.expected, predicted: (r.predicted ? parseTriageCategory(r.predicted) : null) as MailTriageCategory | null });
  }
  const seen = new Set(rows.map((r) => r.id));
  const missing = corpus.filter((c) => !seen.has(c.id)).length;
  const m = triageMetrics(rows);
  log(`${triageMetricsLogLine(m, { model: input.model ?? null, ms: input.ms ?? null })} · corpus=${input.corpus ?? "principal"}${missing ? ` · faltaram ${missing}` : ""}`);
  return { ...m, missing };
}
