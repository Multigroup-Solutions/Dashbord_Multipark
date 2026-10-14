/**
 * "Testar a triagem" (14 out 2026 — meta do Jorge: mais de 90 % das
 * reclamações e dos perdidos vão para lá).
 *
 * Corre o corpus rotulado (server/fixtures/mailTriageCorpus.ts) pelo MESMO
 * caminho de produção: os mesmos factos (remetente, automático, reencaminhado),
 * a mesma pré-triagem (regras sem IA), o MESMO pedido à IA
 * (classifyEmailWithAi, com o fornecedor configurado) e a MESMA decisão
 * (decideMailTriage com as certezas das Definições; reclamacoes@/perdidos@
 * pela mesma porta aliasGateIsNoise). Mede recall e precisão por categoria.
 * NÃO escreve nada nos casos nem na Comunicação: só o registo do custo da IA
 * e uma linha "[triagem-eval]" nos logs.
 *
 * Usado pelo botão em Definições → Comunicação (super admin, por lotes — cada
 * pedido cabe nos 60 s do Vercel) e por scripts/eval-mail-triage.ts.
 */
import {
  ALL_TRIAGE_FEATURES, DIRECT_CASE_PIPELINES, aliasGateIsNoise, decideMailTriage, forwardedExternalSender, parseTriageCategory, preTriageMail,
  senderKindOf, triageMetrics, triageMetricsLogLine,
  type MailTriageCategory, type PreTriageFacts, type TriageEvalRow, type TriageMetrics, type TriageThresholds,
} from "../shared/mailTriage";
import { DEFAULT_BRAND_DOMAINS, isAutomatedSender, isCompanyAddress } from "../shared/mail";
import { TRIAGE_CORPUS, type TriageCorpusItem } from "./fixtures/mailTriageCorpus";
import type { ClassifiedEmail, EmailRoutingMessage } from "./commsRouting";

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
      listMail: !!(item.headers?.listUnsubscribe || item.headers?.listId),
    },
  };
}

export interface EvalItemResult extends TriageEvalRow {
  via: "regra" | "ia" | "porta" | "falhou" | "fora";
  subject: string;
  note: string | null;
  reason: string | null;
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
  return { ...base, predicted: d.category, via: "ia", reason: [d.uncertain ? "por confirmar" : null, reason].filter(Boolean).join(" — ") || null, model: c.model };
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
  opts: { offset: number; limit: number; concurrency?: number },
  deps: { classify?: Classify; thresholds?: TriageThresholds; corpus?: readonly TriageCorpusItem[] } = {},
): Promise<{ total: number; items: EvalItemResult[]; model: string | null }> {
  const corpus = deps.corpus ?? TRIAGE_CORPUS;
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
  input: { rows: ReadonlyArray<{ id: string; predicted: string | null }>; ms?: number | null; model?: string | null },
  corpus: readonly TriageCorpusItem[] = TRIAGE_CORPUS,
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
  log(`${triageMetricsLogLine(m, { model: input.model ?? null, ms: input.ms ?? null })}${missing ? ` · faltaram ${missing}` : ""}`);
  return { ...m, missing };
}
