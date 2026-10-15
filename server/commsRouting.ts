/**
 * A IA lê os emails das caixas partilhadas e o WhatsApp — UM só encaminhador
 * (lote 41 ponto 13 + decisões do Jorge, 8 e 14 out 2026). Regras puras:
 * shared/commsRouting.ts e shared/mailTriage.ts.
 *
 * Email (caixas PARTILHADAS — nunca as pessoais): cada mensagem recebida de
 * uma pessoa é lida UMA vez (registo `comms_ai_routing`, sourceRef UNIQUE) e
 * a IA diz, pelo sentido, do que trata e se traz uma reclamação ou um objeto
 * perdido (mesmo dentro de outro pedido, numa resposta ou num reencaminhamento):
 *  - reclamação / perdido → abre o caso (ou junta-se ao aberto) e a conversa
 *    vai para a caixa Reclamações / Perdidos, POR LER; com certeza média o caso
 *    fica "Por confirmar (IA)" (server/complaintMailIntake.ts);
 *  - crítica → caixa das Críticas, LIDA (o caso nas Críticas vem pela API do
 *    Google / criticas@ — daqui não se cria nada);
 *  - ocorrência → caixa das Ocorrências (o aviso automático da app liga-se à
 *    ocorrência da Multipark e fica LIDO — server/mailNotices.ts);
 *  - o resto: conversa nova → caixa do tema, por ler; não percebeu → info;
 *    lixo fica onde está. Uma resposta num fio só muda de caixa se trouxer um caso.
 * A IA falhou → nada se mexe: fica onde está, por ler, e volta a ser lida
 * (até 3 vezes). O que uma pessoa já mexeu nunca volta a ser mexido.
 * Corre na sincronização (logo) até ao teto por corrida; o que sobra fica
 * "pending" e o varrimento ai-comms trata. O varrimento dos antigos
 * (`runMailBackfill`, interruptor próprio) aplica as mesmas regras aos emails
 * dos últimos dias sem caso.
 *
 * WhatsApp: a intenção vem da triagem (server/whatsappTriage.ts — UMA chamada à
 * IA, nunca outra aqui). Conversa que já tem caixa (ou antiga) fica onde está;
 * conversa nova → caixa do tema (ou Geral quando não percebeu).
 *
 * Recrutamento em 1.º contacto → lead + candidatura (server/recruitmentFirstContact.ts).
 *
 * Interruptores: AI_MAIL_ROUTING (feature `mail_routing`), AI_MAIL_COMPLAINTS,
 * AI_MAIL_LOST_FOUND, AI_MAIL_NOTICES e AI_MAIL_BACKFILL. Nunca responde a
 * ninguém; nunca apaga nada.
 */
import { sql, type SQL } from "drizzle-orm";
import {
  commsRoutingSettings, normalizeCandidate, routingNoteText, whatsappRoutingPlan,
  ROUTING_BODY_MAX, ROUTING_SUBJECT_MAX, type CandidateData, type CommsRoutingSettings,
} from "../shared/commsRouting";
import { GENERAL_BOX_KEY } from "../shared/commsBoxes";
import { CITY_LABELS, cityKeyFromText } from "../shared/city";
import { isAutomatedSender } from "../shared/extraLeadsFunnel";
import { COMPLAINT_INTAKE_DEFAULTS, complaintIntakeSettings } from "../shared/complaintIntake";
import {
  CASE_BOX, MAIL_TRIAGE_MAX_ATTEMPTS, decideMailTriage, forwardedExternalSender, mailBackfillSettings, preTriageMail, senderKindOf, splitQuotedText, triageReasonText,
  type MailTriageCategory, type OccurrenceNotice, type PreTriage, type PreTriageFacts, type SenderKind, type TriageDecision, type TriageFeatures, type TriageThresholds,
} from "../shared/mailTriage";
import type { WhatsappIntent } from "../shared/commsAi";
import type { FirstContactInput, FirstContactResult } from "./recruitmentFirstContact";
import type { MailRoutingOutput } from "./_core/ai/prompts/comms";
import { mailReadCacheGet, mailReadCacheKey, mailReadCacheSet } from "./mailReadCache";
import type { IntakeResult, IntakeVerdict } from "./complaintMailIntake";

const nowStr = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const rowsOf = (r: any): any[] => (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : Array.isArray(r) ? r : []);
const affected = (r: any): number => Number((Array.isArray(r) ? r[0] : r)?.affectedRows ?? 0);
const oneLine = (s: unknown, max = 300): string | null => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max) || null;

async function database() {
  const { getDb } = await import("./db");
  const d = await getDb();
  if (!d) throw new Error("Base de dados indisponível");
  return d;
}

/** Caixa (só o que interessa aqui). */
export interface BoxLite { key: string; label: string; active: boolean; pipeline?: string | null }

// ─── Dependências (injetáveis nos testes) ────────────────────────────────────

export interface EmailRoutingMessage {
  threadId: number;
  messageId: number;
  fromBoxKey: string;
  subject: string;
  text: string;
  fromName: string | null;
  fromEmail: string | null;
  attachmentNames: string[];
  /** Cidade da conversa (alias/ligações), se houver. */
  projectId: number | null;
  /** 14 out 2026: a mensagem abre a conversa (omissão: sim — só estas mudam de caixa de tema). */
  newThread?: boolean;
  /** Quem escreve (omissão: de fora). */
  senderKind?: SenderKind;
  /** A empresa reencaminha a mensagem de alguém de fora (pode abrir caso). */
  forwardedExternal?: boolean;
  /** Envio em massa pelos cabeçalhos (newsletter) — nunca abre caso. */
  listMail?: boolean;
  /** "sync" (email que acabou de chegar, omissão) ou "sweep" (varrimento dos antigos). */
  mode?: "sync" | "sweep";
  /** Quando chegou (UTC "AAAA-MM-DD HH:MM:SS") — para encontrar a ocorrência da app. */
  sentAt?: string | null;
}

export interface ClassifiedEmail { output: MailRoutingOutput; restore: (s: string) => string; /** Modelo que respondeu (para o "Testar a triagem"). */ model?: string }

/** Procura da ocorrência da app Multipark de um aviso (só leitura). */
export type OccurrenceLookup = { status: "found"; id: string } | { status: "none" } | { status: "unavailable" };

export interface EmailRoutingDeps {
  enabled(): Promise<boolean>;
  settings(): Promise<CommsRoutingSettings>;
  /** Certezas dos casos (ai.mailComplaints). Omissão: as do lote 57. */
  caseSettings?(): Promise<Pick<TriageThresholds, "createMinConfidence" | "suggestMinConfidence">>;
  /** Interruptores dos casos e dos avisos. Omissão: casos com o `caseIntake`, avisos desligados. */
  features?(): Promise<TriageFeatures>;
  boxes(): Promise<BoxLite[]>;
  /** Reserva a mensagem (INSERT IGNORE): false = já foi lida antes. */
  claim(msg: EmailRoutingMessage): Promise<boolean>;
  classify(msg: EmailRoutingMessage, fromLabel: string): Promise<ClassifiedEmail>;
  /**
   * Move a conversa (sem a marcar como lida). false = já não estava lá ou uma
   * pessoa já a moveu. `reroute`: pode mudar uma conversa que a IA já separou
   * (um caso numa resposta) — nunca uma movida à mão.
   */
  move(threadId: number, boxKey: string, opts?: { reroute?: boolean }): Promise<boolean>;
  record(messageId: number, patch: DecisionPatch): Promise<void>;
  firstContact(input: FirstContactInput): Promise<FirstContactResult>;
  cityProjectId(text: string | null): Promise<number | null>;
  /** Candidato no RH: pipeline do recrutamento (lista Recrutamento + leitura do CV) e ligação à lead. */
  afterRh(threadId: number, opts: { moved: boolean; leadId: number | null }): Promise<void>;
  /**
   * Lote 57 / 14 out: a IA viu uma reclamação ou um perdido → abre o caso (ou
   * junta) — server/complaintMailIntake.ts. Nunca escreve ao cliente.
   */
  caseIntake?(msg: EmailRoutingMessage, verdict: IntakeVerdict): Promise<IntakeResult>;
  /** Fica lida (críticas e avisos da app). */
  markRead?(messageId: number): Promise<void>;
  findOccurrence?(notice: OccurrenceNotice, sentAt: string | null): Promise<OccurrenceLookup>;
  linkOccurrence?(threadId: number, messageId: number, occurrenceId: string): Promise<void>;
}

export interface DecisionPatch {
  status: "moved" | "kept" | "failed" | "pending";
  via?: "ai" | "triage" | "rule" | "fallback";
  aiBoxKey?: string | null;
  boxKey?: string | null;
  confidence?: number | null;
  reason?: string | null;
  error?: string | null;
  candidateJson?: string | null;
  recruitOutcome?: string | null;
  leadId?: number | null;
  applicationId?: number | null;
  /** 14 out: a categoria da triagem e as certezas de caso. */
  category?: string | null;
  complaintScore?: number | null;
  lostScore?: number | null;
  notice?: string | null;
  markedRead?: boolean;
  /**
   * Varrimento de um email que o encaminhador antigo já tinha separado: grava
   * só o que a triagem leu (a linha "Movido pela IA →" fica como estava).
   */
  onlyTriage?: boolean;
}

export type EmailRoutingResult =
  | { status: "off" | "seen" | "pending" }
  | {
    status: "moved" | "kept" | "failed"; boxKey: string; recruit?: FirstContactResult | null; complaint?: IntakeResult | null;
    category?: MailTriageCategory | null; decision?: TriageDecision | null;
  };

const caseThresholdsOf = async (deps: EmailRoutingDeps) => (deps.caseSettings ? deps.caseSettings() : { ...COMPLAINT_INTAKE_DEFAULTS });
const featuresOf = async (deps: EmailRoutingDeps): Promise<TriageFeatures> =>
  deps.features ? deps.features() : { complaints: !!deps.caseIntake, lostFound: !!deps.caseIntake, notices: false };
const caseOpened = (r: IntakeResult | null | undefined) => !!r && (r.status === "created" || r.status === "linked");

// ─── Email ───────────────────────────────────────────────────────────────────

/**
 * Uma mensagem nova numa caixa partilhada que a IA tem de ler (a pré-triagem
 * já disse "ai"). `run.left` = leituras que ainda cabem nesta corrida; sem
 * espaço (ou sem tempo) fica "pending" para o varrimento.
 */
export async function routeEmailMessage(
  msg: EmailRoutingMessage,
  deps: EmailRoutingDeps = dbEmailRoutingDeps,
  run: { left: number; deadlineAt?: number } = { left: 1 },
): Promise<EmailRoutingResult> {
  if (!(await deps.enabled())) return { status: "off" };
  if (!(await deps.claim(msg))) return { status: "seen" };
  if (run.left <= 0 || (run.deadlineAt != null && Date.now() + 16_000 > run.deadlineAt)) return { status: "pending" };
  run.left--;
  return classifyAndApply(msg, deps);
}

/** Lê com a IA e aplica (mensagem já reservada). Nunca lança por causa da IA. */
export async function classifyAndApply(msg: EmailRoutingMessage, deps: EmailRoutingDeps): Promise<EmailRoutingResult> {
  const [settings, boxes, features, caseT] = await Promise.all([deps.settings(), deps.boxes(), featuresOf(deps), caseThresholdsOf(deps)]);
  const active = new Set(boxes.filter((b) => b.active).map((b) => b.key));
  const fromLabel = boxes.find((b) => b.key === msg.fromBoxKey)?.label ?? msg.fromBoxKey;
  const sweep = msg.mode === "sweep";

  let classified: ClassifiedEmail | null = null;
  let error: string | null = null;
  try {
    classified = await deps.classify(msg, fromLabel);
  } catch (err: any) {
    error = String(err?.code ?? err?.name ?? "erro").slice(0, 60);
  }
  // Desligaram a IA entretanto: não é "não percebeu" — fica onde entrou.
  if (!classified && error === "disabled") {
    await deps.record(msg.messageId, { status: "kept", via: "fallback", boxKey: msg.fromBoxKey, error, onlyTriage: sweep });
    return { status: "kept", boxKey: msg.fromBoxKey };
  }
  // 14 out 2026: a IA falhou → nada se mexe (nunca se perde): fica onde está,
  // por ler, e volta a ser lida pelo varrimento (até MAIL_TRIAGE_MAX_ATTEMPTS).
  if (!classified) {
    // Varrimento: a linha antiga (o encaminhador já a tinha separado) fica como estava — só o erro e a tentativa;
    // o próprio varrimento volta a tentar (runMailBackfill, até MAIL_TRIAGE_MAX_ATTEMPTS).
    await deps.record(msg.messageId, { status: "failed", via: "fallback", boxKey: msg.fromBoxKey, error, onlyTriage: sweep });
    return { status: "failed", boxKey: msg.fromBoxKey };
  }

  const d = decideMailTriage(
    classified.output,
    { sender: msg.senderKind ?? "external", forwardedExternal: !!msg.forwardedExternal, newThread: msg.newThread ?? true, mode: sweep ? "sweep" : "sync" },
    { minConfidence: settings.minConfidence, ...caseT },
    features,
    active,
  );
  const aiReason = oneLine(classified.output.reason);

  // 1) Reclamação / perdido → o caso (criar ou juntar). Nunca escreve ao cliente.
  let complaint: IntakeResult | null = null;
  if (d.caseKind && deps.caseIntake) {
    // Ronda 3: "Por confirmar" que a certeza sozinha não mostra à porta do caso (só o sim/não da IA a levou ao limiar).
    const forceUncertain = d.uncertain && d.caseScore != null && d.caseScore >= caseT.createMinConfidence;
    complaint = await deps.caseIntake(msg, { kind: d.caseKind, aiBoxKey: d.aiBoxKey, confidence: d.caseScore, reason: aiReason, ...(forceUncertain ? { uncertain: true } : {}) }).catch((err: any) => {
      console.warn("[IA caixas] caso (email) falhou:", msg.threadId, String(err?.message ?? err).slice(0, 160));
      return null;
    });
  }
  const opened = caseOpened(complaint);

  // 2) Caixa: com caso → a caixa do caso, por ler (mesmo numa resposta, ou já
  //    separada pela IA; nunca uma movida à mão). Sem caso → a do tema (só
  //    conversa nova). Sem a caixa do caso ativa → a do tema.
  const caseBox = opened ? CASE_BOX[d.caseKind!] : null;
  const target = caseBox && active.has(caseBox) ? caseBox : d.routeBox;
  let moved = false;
  if (target && target !== msg.fromBoxKey) moved = await deps.move(msg.threadId, target, opened ? { reroute: true } : undefined);
  const finalBox = moved ? target! : msg.fromBoxKey;

  // 3) Crítica (elogio/opinião) → fica lida.
  let markedRead = false;
  if (d.markRead && deps.markRead) {
    markedRead = await deps.markRead(msg.messageId).then(() => true).catch((err: any) => {
      console.warn("[IA caixas] marcar lida falhou:", msg.threadId, String(err?.message ?? err).slice(0, 160));
      return false;
    });
  }

  // 4) Candidato no RH (o que já fazia).
  let recruit: FirstContactResult | null = null;
  let candidate: CandidateData | null = null;
  if (!sweep && d.understood && finalBox === "rh" && classified.output.candidate === true) {
    candidate = candidateFromEmail(classified, msg);
    try {
      recruit = await deps.firstContact({
        channel: "email", sourceRef: `ai:mail_thread:${msg.threadId}`, candidate,
        projectId: (await deps.cityProjectId(candidate.city)) ?? msg.projectId, reason: aiReason,
      });
    } catch (err: any) {
      console.warn("[IA caixas] candidato (email) falhou:", msg.threadId, String(err?.message ?? err).slice(0, 160));
    }
  }
  // Candidato: o email entra também na lista do Recrutamento (pipeline do RH,
  // com a leitura do CV) — só candidaturas, não qualquer email do RH.
  if (candidate) {
    await deps.afterRh(msg.threadId, { moved, leadId: recruit?.leadId ?? null }).catch((err: any) =>
      console.warn("[IA caixas] RH (pipeline) falhou:", msg.threadId, String(err?.message ?? err).slice(0, 160)));
  }

  const status: "moved" | "kept" = moved ? "moved" : "kept";
  await deps.record(msg.messageId, {
    status, via: "ai", aiBoxKey: d.aiBoxKey, boxKey: finalBox, confidence: d.confidence,
    reason: opened ? triageReasonText(d, aiReason) : aiReason, error: null, candidateJson: candidate ? JSON.stringify(candidate) : null,
    recruitOutcome: recruit?.outcome ?? null, leadId: recruit?.leadId ?? null, applicationId: recruit?.applicationId ?? null,
    category: d.category, complaintScore: d.complaintScore, lostScore: d.lostScore, markedRead,
    // Varrimento sem mudança de caixa: a linha antiga ("Movido pela IA → …") fica.
    onlyTriage: sweep && !moved,
  });
  return { status, boxKey: finalBox, recruit, complaint, category: d.category, decision: d };
}

/**
 * Regras sem IA (a pré-triagem reconheceu): aviso de avaliação → Críticas,
 * lido; aviso de ocorrência da app → liga à ocorrência da Multipark, vai para
 * as Ocorrências, lido; Livro de Reclamações → reclamação; envio em massa →
 * fica onde está. Com o interruptor do caso/avisos desligado não se mexe (nem
 * se reserva — ligar depois apanha-o no varrimento).
 */
export async function applyRuleTriage(
  msg: EmailRoutingMessage,
  rule: Extract<PreTriage, { action: "rule" }>,
  deps: EmailRoutingDeps = dbEmailRoutingDeps,
  opts: { claimed?: boolean } = {},
): Promise<EmailRoutingResult> {
  const features = await featuresOf(deps);
  if ((rule.notice === "review" || rule.notice === "occurrence") && !features.notices) return { status: "off" };
  if (rule.notice === "livro" && !features.complaints) return { status: "off" };
  if (!opts.claimed && !(await deps.claim(msg))) return { status: "seen" };
  const active = new Set((await deps.boxes()).filter((b) => b.active).map((b) => b.key));
  const sweep = msg.mode === "sweep";
  const moveTo = async (box: string, reroute = false) => (box !== msg.fromBoxKey && active.has(box) ? deps.move(msg.threadId, box, reroute ? { reroute: true } : undefined) : false);
  const read = async () => (deps.markRead ? deps.markRead(msg.messageId).then(() => true).catch(() => false) : false);
  const done = async (moved: boolean, target: string, patch: Partial<DecisionPatch>): Promise<EmailRoutingResult> => {
    const finalBox = moved ? target : msg.fromBoxKey;
    await deps.record(msg.messageId, { status: moved ? "moved" : "kept", via: "rule", boxKey: finalBox, category: rule.category, notice: rule.notice, ...patch });
    return { status: moved ? "moved" : "kept", boxKey: finalBox, category: rule.category };
  };

  if (rule.notice === "automatic") {
    return done(false, msg.fromBoxKey, { reason: "envio automático (cabeçalhos de lista ou resposta automática)", onlyTriage: sweep });
  }
  if (rule.notice === "review") {
    // A crítica entra nas Críticas pela API do Google / criticas@ — daqui só a caixa e o lido.
    const moved = await moveTo("criticas");
    const markedRead = await read();
    return done(moved, "criticas", { reason: "aviso de avaliação — fica lido (a crítica entra sozinha nas Críticas)", markedRead });
  }
  if (rule.notice === "occurrence") {
    const look: OccurrenceLookup = deps.findOccurrence && rule.occurrence
      ? await deps.findOccurrence(rule.occurrence, msg.sentAt ?? null).catch(() => ({ status: "unavailable" as const }))
      : { status: "unavailable" };
    if (look.status === "unavailable") {
      // A Multipark não respondeu: nada se mexe; volta a tentar (o email fica por ler).
      await deps.record(msg.messageId, { status: "pending", via: "rule", boxKey: msg.fromBoxKey, category: "ocorrencias", notice: "occurrence", error: "multipark_indisponivel", reason: "a app Multipark não respondeu" });
      return { status: "pending" };
    }
    const moved = await moveTo("ocorrencias");
    if (look.status === "found") {
      if (deps.linkOccurrence) await deps.linkOccurrence(msg.threadId, msg.messageId, look.id).catch(() => {});
      const markedRead = await read();
      return done(moved, "ocorrencias", { reason: "aviso da app — ligado à ocorrência da Multipark, fica lido", markedRead });
    }
    return done(moved, "ocorrencias", { reason: "aviso de ocorrência que não está na app Multipark — fica por ler" });
  }
  // Livro de Reclamações (aviso oficial): reclamação, mesmo vindo de um endereço automático.
  const complaint = deps.caseIntake
    ? await deps.caseIntake(msg, { kind: "complaint", aiBoxKey: "reclamacoes", confidence: 1, reason: "Livro de Reclamações", notice: "livro" }).catch(() => null)
    : null;
  const moved = caseOpened(complaint) ? await moveTo("reclamacoes", true) : false;
  const r = await done(moved, "reclamacoes", { reason: "Livro de Reclamações (aviso oficial)" });
  return { ...(r as any), complaint };
}

/** Dados do candidato de um email: o que a IA leu + o remetente (quando é uma pessoa). PURA. */
export function candidateFromEmail(c: ClassifiedEmail, msg: Pick<EmailRoutingMessage, "fromName" | "fromEmail">): CandidateData {
  const cand = normalizeCandidate(c.output as unknown as Record<string, unknown>, c.restore);
  const header = String(msg.fromEmail ?? "").trim().toLowerCase();
  // O remetente ganha (é quem escreve), menos portais/no-reply e o nosso domínio.
  const headerIsPerson = !!header && !isAutomatedSender(header);
  const name = String(msg.fromName ?? "").replace(/^["']|["']$/g, "").trim();
  return {
    ...cand,
    email: headerIsPerson ? header : cand.email,
    fullName: cand.fullName ?? (name && !name.includes("@") ? name.slice(0, 120) : null),
  };
}

/** Separador entre a mensagem nova e o citado no texto que se tapa (nunca é um dado pessoal). */
const QUOTED_SEP = "§§§CITADO§§§";

/**
 * Leitura real (lite): só o 1.º nome, a mensagem nova + o citado/reencaminhado
 * como contexto (cortados), e os dados pessoais tapados. O MESMO pedido serve
 * a sincronização, o varrimento e o "Testar a triagem".
 */
export async function classifyEmailWithAi(
  msg: EmailRoutingMessage,
  fromLabel: string,
  opts: {
    // Plano MPV F6b (T1): só a avaliação (scripts/eval-mail-triage.ts --thinking) compara os níveis.
    thinkingLevel?: import("../shared/aiFeatures").AiThinkingLevel;
    thinkingFromCaller?: boolean;
    /**
     * Seguimento F6b: reaproveitar a leitura de um pedido igual (o MESMO email
     * sincronizado por duas contas — info@ por 2, jorgetabuada@ por 3). Só a
     * sincronização da caixa passa isto (server/mail/service.ts); a avaliação,
     * o "Testar" e o filtro de ruído da reclamacoes@/perdidos@ leem sempre.
     */
    reuseRead?: boolean;
  } = {},
): Promise<ClassifiedEmail> {
  const { runAi, resolvedAiCall } = await import("./_core/ai/run");
  const { mailRoutingSchema } = await import("./_core/ai/prompts/comms");
  const req = await mailRoutingRequest(msg, fromLabel);
  // A chave leva o fornecedor, o modelo e o raciocínio já resolvidos: mudar o
  // ai.thinkingLevels, o ai.featureTiers ou o modelo dá uma leitura nova.
  let call: Awaited<ReturnType<typeof resolvedAiCall>> = null;
  if (opts.reuseRead && !opts.thinkingFromCaller) {
    try { call = await resolvedAiCall("mail_routing"); } catch { call = null; /* sem chave = sem cache (lê) */ }
  }
  const cacheKey = call ? mailReadCacheKey(req.system, req.input, `${call.provider}|${call.model}|${call.thinking ?? "-"}`) : null;
  const hit = cacheKey ? mailReadCacheGet(cacheKey) : null;
  if (hit) return { output: hit.output, restore: req.restore, model: hit.model };
  const r = await runAi({
    feature: "mail_routing", system: req.system, schema: mailRoutingSchema, input: req.input,
    maxTokens: 700, timeoutMs: 15_000, retries: 1, entity: "mail_thread", entityId: msg.threadId || null,
    ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
    ...(opts.thinkingFromCaller ? { thinkingFromCaller: true } : {}),
  });
  // Só se guarda a leitura do modelo da chave (uma queda 404/429 para outro modelo não fica com a chave deste).
  if (cacheKey && call && r.model === call.model) mailReadCacheSet(cacheKey, { output: r.output, model: r.model });
  return { output: r.output, restore: req.restore, model: r.model };
}

// A mesma leitura para o mesmo pedido (seguimento F6b): server/mailReadCache.ts.
export { clearMailReadCache, mailReadCacheGet, mailReadCacheKey, mailReadCacheSet, MAIL_READ_CACHE_TTL_MS } from "./mailReadCache";

/**
 * O pedido EXATO que vai à IA (sistema + utilizador), já com os dados
 * pessoais tapados e os cortes. Uma só fonte: a leitura real, o "Testar a
 * triagem" e a avaliação offline (scripts/eval-mail-triage.ts --dump) usam
 * esta função. Sem I/O.
 */
export async function mailRoutingRequest(msg: Pick<EmailRoutingMessage, "subject" | "text" | "fromName" | "senderKind" | "attachmentNames">, fromLabel: string): Promise<{ system: string; input: string; restore: (s: string) => string }> {
  const { redactPii, firstName } = await import("./_core/ai/pii");
  const { MAIL_ROUTING_SYSTEM, MAIL_QUOTED_MAX, mailRoutingInput } = await import("./_core/ai/prompts/comms");
  const parts = splitQuotedText(msg.text);
  const red = redactPii(`${msg.subject.slice(0, ROUTING_SUBJECT_MAX).replace(/\n/g, " ")}\n${parts.fresh.slice(0, ROUTING_BODY_MAX)}\n${QUOTED_SEP}\n${parts.quoted.slice(0, MAIL_QUOTED_MAX)}`);
  const [head, quoted = ""] = red.text.split(`\n${QUOTED_SEP}\n`);
  const [subject, ...body] = head.split("\n");
  const input = mailRoutingInput({
    subject: subject ?? "", body: body.join("\n"), quoted, fromBox: fromLabel,
    senderFirstName: firstName(msg.fromName, ""), senderKind: msg.senderKind ?? null, attachmentNames: msg.attachmentNames,
  });
  return { system: MAIL_ROUTING_SYSTEM, input, restore: red.restore };
}

/** Tira o histórico citado ("> …", "Em … escreveu:") — só a mensagem nova. PURA. */
export function stripQuoted(text: string): string {
  return splitQuotedText(text).fresh;
}

// ─── Email: dependências reais ──────────────────────────────────────────────

async function routingSettings(): Promise<CommsRoutingSettings> {
  try {
    const { getSetting } = await import("./appSettings");
    return commsRoutingSettings(await getSetting("ai.commsRouting"));
  } catch {
    return commsRoutingSettings(null);
  }
}

async function caseSettingsReal(): Promise<Pick<TriageThresholds, "createMinConfidence" | "suggestMinConfidence">> {
  try {
    const { getSetting } = await import("./appSettings");
    return complaintIntakeSettings(await getSetting("ai.mailComplaints"));
  } catch {
    return complaintIntakeSettings(null);
  }
}

async function flagOn(name: string): Promise<boolean> {
  const { ensureFeatureFlagOverrides, isFeatureEnabled } = await import("./_core/featureFlags");
  const { automationFlagDefault } = await import("../shared/appSettings");
  await ensureFeatureFlagOverrides().catch(() => {});
  return isFeatureEnabled(name, { defaultEnabled: automationFlagDefault(name) });
}

/** Interruptores: AI_MAIL_COMPLAINTS (ligado), AI_MAIL_LOST_FOUND e AI_MAIL_NOTICES (desligados por omissão). */
export async function triageFeatures(): Promise<TriageFeatures> {
  const [complaints, lostFound, notices] = await Promise.all([flagOn("AI_MAIL_COMPLAINTS"), flagOn("AI_MAIL_LOST_FOUND"), flagOn("AI_MAIL_NOTICES")]);
  return { complaints, lostFound, notices };
}

async function routingEnabled(): Promise<boolean> {
  const { aiFeatureAvailableFresh } = await import("./_core/ai/status");
  return aiFeatureAvailableFresh("mail_routing");
}

async function cityProjectIdOf(text: string | null): Promise<number | null> {
  if (!text) return null;
  try {
    const [{ getProjects }, { cityProjectIdFromText }] = await Promise.all([import("./db"), import("./extraLeadsSync")]);
    return cityProjectIdFromText(text, (await getProjects()) as any);
  } catch {
    return null;
  }
}

export async function recordDecision(sourceRef: string, p: DecisionPatch): Promise<void> {
  const d = await database();
  const attemptsInc = p.status === "failed" || (p.status === "pending" && !!p.error) ? 1 : 0;
  const readAt = p.markedRead ? nowStr() : null;
  if (p.onlyTriage) {
    // Linha que o encaminhador antigo já tinha decidido: só o que a triagem leu
    // (uma linha "pending" do varrimento passa a decidida). As atribuições
    // correm da esquerda para a direita: o estado muda por último.
    await d.execute(sql`UPDATE comms_ai_routing SET
        via = IF(status = 'pending', COALESCE(${p.via ?? null}, via), via),
        aiBoxKey = IF(status = 'pending', ${p.aiBoxKey ?? null}, aiBoxKey),
        boxKey = IF(status = 'pending', ${p.boxKey ?? null}, boxKey),
        confidence = IF(status = 'pending', ${p.confidence ?? null}, confidence),
        reason = IF(status = 'pending', ${p.reason ?? null}, reason),
        error = ${p.error ?? null},
        category = ${p.category ?? null}, complaintScore = ${p.complaintScore ?? null}, lostScore = ${p.lostScore ?? null},
        notice = COALESCE(${p.notice ?? null}, notice), markedReadAt = COALESCE(${readAt}, markedReadAt),
        attempts = attempts + ${attemptsInc},
        decidedAt = IF(status = 'pending', ${nowStr()}, decidedAt),
        status = IF(status = 'pending', ${p.status}, status)
      WHERE sourceRef = ${sourceRef}`);
    return;
  }
  // O candidato que uma leitura anterior registou não se perde (ex.: o varrimento abre um caso na mesma conversa).
  await d.execute(sql`UPDATE comms_ai_routing SET status = ${p.status}, via = COALESCE(${p.via ?? null}, via),
      aiBoxKey = ${p.aiBoxKey ?? null}, boxKey = ${p.boxKey ?? null}, confidence = ${p.confidence ?? null}, reason = ${p.reason ?? null},
      error = ${p.error ?? null},
      candidateJson = COALESCE(${p.candidateJson ?? null}, candidateJson), recruitOutcome = COALESCE(${p.recruitOutcome ?? null}, recruitOutcome),
      leadId = COALESCE(${p.leadId ?? null}, leadId), applicationId = COALESCE(${p.applicationId ?? null}, applicationId),
      category = ${p.category ?? null}, complaintScore = ${p.complaintScore ?? null}, lostScore = ${p.lostScore ?? null},
      notice = COALESCE(${p.notice ?? null}, notice), markedReadAt = COALESCE(${readAt}, markedReadAt),
      attempts = attempts + ${attemptsInc}, decidedAt = ${nowStr()}
    WHERE sourceRef = ${sourceRef}`);
}

/** Candidato no RH: corre o pipeline do recrutamento (se a caixa o tiver e o email veio de outra caixa) e liga o email à lead. */
async function afterRhReal(threadId: number, opts: { moved: boolean; leadId: number | null }): Promise<void> {
  const { getMailbox } = await import("./mail/store");
  const { aliasPipeline } = await import("../shared/mail");
  const rh = await getMailbox("rh");
  if (opts.moved && rh && aliasPipeline(rh, null, null) === "recursos-humanos") {
    const { reprocessThreadPipeline } = await import("./mail/service");
    await reprocessThreadPipeline(threadId, rh, null);
  }
  if (opts.leadId == null) return;
  // O email do RH (lista Recrutamento) fica deste candidato: o leitor dos anexos
  // (D39) lê o CV para ESTA lead e a importação de hora a hora não cria outra.
  const d = await database();
  const ids = rowsOf(await d.execute(sql`SELECT rfcMessageId FROM mail_messages WHERE threadId = ${threadId} AND direction = 'in' AND rfcMessageId IS NOT NULL LIMIT 10`))
    .map((r) => String(r.rfcMessageId)).filter(Boolean);
  if (!ids.length) return;
  const emails = rowsOf(await d.execute(sql`SELECT id FROM inbound_emails WHERE alias = 'recursos-humanos' AND messageId IN (${sql.join(ids.map((x) => sql`${x}`), sql`, `)}) LIMIT 10`));
  for (const e of emails) {
    await d.execute(sql`INSERT IGNORE INTO extra_lead_sources (sourceRef, leadId, outcome) VALUES (${`email:${e.id}`}, ${opts.leadId}, 'merged')`);
  }
}

export const dbEmailRoutingDeps: EmailRoutingDeps = {
  enabled: routingEnabled,
  settings: routingSettings,
  caseSettings: caseSettingsReal,
  features: triageFeatures,
  async boxes() {
    const { listMailboxes } = await import("./mail/store");
    return (await listMailboxes()).map((b) => ({ key: b.key, label: b.label, active: b.active, pipeline: b.pipeline }));
  },
  async claim(msg) {
    const d = await database();
    const res = await d.execute(sql`INSERT IGNORE INTO comms_ai_routing (channel, sourceRef, threadId, messageId, fromBoxKey, via, status)
      VALUES ('email', ${`mail_message:${msg.messageId}`}, ${msg.threadId}, ${msg.messageId}, ${msg.fromBoxKey}, 'ai', 'pending')`);
    return affected(res) === 1;
  },
  classify: classifyEmailWithAi,
  async move(threadId, boxKey, opts) {
    const { moveThreadToBox } = await import("./mail/service");
    return moveThreadToBox(threadId, boxKey, "ai", opts);
  },
  record: (messageId, p) => recordDecision(`mail_message:${messageId}`, p),
  async firstContact(input) {
    const { onRecruitmentFirstContact } = await import("./recruitmentFirstContact");
    return onRecruitmentFirstContact(input);
  },
  cityProjectId: cityProjectIdOf,
  afterRh: afterRhReal,
  async caseIntake(msg, verdict) {
    const { intakeFromRouting } = await import("./complaintMailIntake");
    return intakeFromRouting(msg, verdict);
  },
  async markRead(messageId) {
    const { markMessageReadBySystem } = await import("./mail/store");
    await markMessageReadBySystem(messageId);
  },
  async findOccurrence(notice, sentAt) {
    const { findOccurrenceForNotice } = await import("./mailNotices");
    return findOccurrenceForNotice(notice, sentAt);
  },
  async linkOccurrence(threadId, messageId, occurrenceId) {
    const { addAutoLink } = await import("./mail/store");
    await addAutoLink({ threadId, messageId, entityType: "occurrence", entityId: occurrenceId, confidence: 100, reason: "aviso da app Multipark (ocorrência)" });
  },
};

// ─── Emails já guardados (pendentes, falhados, varrimento) ──────────────────

/**
 * Uma conversa "já tem caso" só por uma ligação FORTE a uma reclamação ou a um
 * perdido: feita à mão, pelo pipeline/IA (100) ou pela mesma conversa (95).
 * Auditoria (14 out 2026): as ligações automáticas fracas "reclamação/perdido
 * aberto do mesmo cliente" (70) — que se fazem a QUALQUER email desse cliente,
 * mesmo de um perdido de há meses — faziam a nova tentativa e o varrimento
 * saltar uma reclamação nova ("a conversa já tem caso").
 */
export const STRONG_CASE_LINK_MIN_CONFIDENCE = 95;
export const strongCaseLinkSql = (threadCol: SQL) => sql`EXISTS (SELECT 1 FROM mail_links l WHERE l.threadId = ${threadCol}
  AND l.entityType IN ('complaint', 'lost_found') AND l.removedAt IS NULL AND (l.source = 'manual' OR l.confidence >= ${STRONG_CASE_LINK_MIN_CONFIDENCE}))`;

export interface StoredTriageMessage {
  msg: EmailRoutingMessage;
  pre: PreTriageFacts;
}

/**
 * Mensagem guardada → o que a triagem precisa (BD). null = já não existe.
 * "Uma pessoa já mexeu": moveu à mão, corrigiu a IA, recusou o caso, resolveu
 * ou arquivou a conversa.
 */
export async function loadStoredTriageMessage(messageId: number, mode: "sync" | "sweep" = "sync"): Promise<StoredTriageMessage | null> {
  const d = await database();
  const r = rowsOf(await d.execute(sql`SELECT m.id, m.threadId, m.subject, m.bodyText, m.snippet, m.fromName, m.fromEmail, m.attachmentsJson,
      CASE WHEN m.bodyText IS NULL OR m.bodyText = '' THEN m.bodyHtml END AS bodyHtml,
      m.direction, m.automated, m.pipeline, m.pipelineStatus, DATE_FORMAT(m.sentAt, '%Y-%m-%d %H:%i:%s') AS sentAt,
      t.mailboxKey, t.routedBy, t.projectId, t.ownerUserId, t.status AS threadStatus, t.archivedAt,
      (SELECT MIN(x.id) FROM mail_messages x WHERE x.threadId = m.threadId AND x.direction = 'in') AS firstInId,
      ${strongCaseLinkSql(sql`m.threadId`)} AS hasCase,
      EXISTS (SELECT 1 FROM comms_ai_routing c WHERE c.threadId = m.threadId AND c.correctedBoxKey IS NOT NULL) AS corrected,
      (SELECT i.status FROM complaint_mail_intake i WHERE i.threadId = m.threadId LIMIT 1) AS intakeStatus
    FROM mail_messages m JOIN mail_threads t ON t.id = m.threadId WHERE m.id = ${messageId} LIMIT 1`))[0];
  if (!r) return null;
  const { listMailboxes, loadBrandDomains } = await import("./mail/store");
  const { isCompanyAddress } = await import("../shared/mail");
  const [boxes, brandDomains] = await Promise.all([listMailboxes(), loadBrandDomains()]);
  const box = boxes.find((b) => b.key === r.mailboxKey) ?? null;
  const company = (a: string) => isCompanyAddress(a, brandDomains);
  let names: string[] = [];
  try { names = (JSON.parse(String(r.attachmentsJson ?? "[]")) as any[]).filter((a) => !a?.inline).map((a) => String(a?.filename ?? "")).filter(Boolean); } catch { /* sem anexos */ }
  // Ronda 2: um email só em HTML lê-se pelo HTML (não só o resumo do Gmail).
  const { readableMailText } = await import("./complaintEmail");
  const text = readableMailText({ text: r.bodyText ?? null, html: r.bodyHtml ?? null, snippet: r.snippet ?? null });
  const automated = Number(r.automated ?? 0);
  const senderKind = senderKindOf({ fromEmail: r.fromEmail ?? null, automated }, company);
  const intake = r.intakeStatus != null ? String(r.intakeStatus) : null;
  // "Por classificar" não conta: os casos nascem na mesma (a conversa é que não muda de caixa sozinha).
  const humanTouched = r.routedBy === "manual" || Number(r.corrected) === 1 || intake === "dismissed" || r.archivedAt != null
    || (mode === "sweep" && r.threadStatus === "resolvido");
  const pre: PreTriageFacts = {
    outbound: r.direction === "out", personal: r.mailboxKey == null && r.ownerUserId != null, systemMail: automated === 3, automated,
    // R2 (plano MPV F6b): entrou pelas Críticas mas não era crítica → tria-se como numa caixa sem pipeline.
    mailboxKey: r.mailboxKey ?? null, pipeline: r.pipelineStatus === "not_review" ? null : r.pipeline ?? box?.pipeline ?? null, fromEmail: r.fromEmail ?? null, text,
    senderIsCompany: senderKind === "company", createdCase: false,
    threadHasCase: Number(r.hasCase) === 1 || intake === "created" || intake === "linked" || intake === "creating" || intake === "suggested",
    humanTouched,
  };
  return {
    pre,
    msg: {
      threadId: Number(r.threadId), messageId: Number(r.id), fromBoxKey: String(r.mailboxKey ?? ""), subject: String(r.subject ?? ""),
      text, fromName: r.fromName ?? null, fromEmail: r.fromEmail ?? null, attachmentNames: names,
      projectId: r.projectId != null ? Number(r.projectId) : null,
      newThread: r.firstInId != null && Number(r.firstInId) === Number(r.id),
      senderKind, forwardedExternal: senderKind === "company" && !!forwardedExternalSender(text, company), mode, sentAt: r.sentAt ?? null,
    },
  };
}

const SKIP_REASONS: Record<string, string> = {
  not_inbound: "não é um email recebido", personal: "caixa pessoal", no_box: "sem caixa", system: "email de sistema", reservation: "notificação de reserva",
  human: "uma pessoa já mexeu nesta conversa", case_box: "entrou pela caixa do caso", pipeline: "caixa que trata os emails sozinha", has_case: "a conversa já tem caso",
};

/**
 * Um email guardado (já reservado) passa pela triagem toda: pré-triagem →
 * regra ou IA. Usado pelos pendentes, pelos que falharam e pelo varrimento.
 */
export async function triageStoredMessage(
  messageId: number,
  deps: EmailRoutingDeps & { load?: typeof loadStoredTriageMessage } = dbEmailRoutingDeps,
  opts: { mode?: "sync" | "sweep" } = {},
): Promise<EmailRoutingResult> {
  const mode = opts.mode ?? "sync";
  const stored = await (deps.load ?? loadStoredTriageMessage)(messageId, mode);
  if (!stored) {
    await deps.record(messageId, { status: "kept", via: "rule", reason: "o email já não está na Comunicação", onlyTriage: true });
    return { status: "kept", boxKey: "" };
  }
  const pre = preTriageMail(stored.pre);
  if (pre.action === "skip") {
    await deps.record(messageId, { status: "kept", via: "rule", boxKey: stored.msg.fromBoxKey || null, reason: SKIP_REASONS[pre.why] ?? pre.why, onlyTriage: true });
    return { status: "kept", boxKey: stored.msg.fromBoxKey };
  }
  if (pre.action === "rule") {
    const r = await applyRuleTriage(stored.msg, pre, deps, { claimed: true });
    // Interruptor desligado: a linha reservada fica decidida (não volta a ser lida; o varrimento só pega no que nunca leu).
    if (r.status === "off") await deps.record(messageId, { status: "kept", via: "rule", boxKey: stored.msg.fromBoxKey, category: pre.category, notice: pre.notice, reason: "interruptor desligado", onlyTriage: true });
    return r;
  }
  if (!(await deps.enabled())) return { status: "off" };
  return classifyAndApply(stored.msg, deps);
}

/**
 * Um email que o pipeline da caixa largou (R2, plano MPV F6b: entrou pelas
 * Críticas e não era crítica) passa pela triagem normal: pré-triagem → regra
 * ou IA (uma leitura; sem leitura nesta corrida fica "pending" e o varrimento
 * apanha-o). Usado pela nova tentativa dos casos (retryPipelineMessage).
 */
export async function triageReleasedMessage(messageId: number, deps: EmailRoutingDeps = dbEmailRoutingDeps): Promise<EmailRoutingResult | null> {
  const stored = await loadStoredTriageMessage(messageId, "sync");
  if (!stored) return null;
  const pre = preTriageMail(stored.pre);
  if (pre.action === "skip") return null;
  if (pre.action === "rule") return applyRuleTriage(stored.msg, pre, deps);
  return routeEmailMessage(stored.msg, deps, { left: 1 });
}

/**
 * Varrimento (ai-comms, de 15 em 15 min): as mensagens que ficaram "pending"
 * (teto da corrida, sem tempo, a Multipark não respondeu) e as que a IA não
 * conseguiu ler (até 3 tentativas). Só as dos últimos 2 dias.
 */
export async function runPendingEmailRoutings(opts: { limit?: number; deadlineAt?: number } = {}, deps: EmailRoutingDeps = dbEmailRoutingDeps): Promise<{ routed: number; skipped?: string }> {
  const out: { routed: number; skipped?: string } = { routed: 0 };
  if (!(await deps.enabled())) return { ...out, skipped: "disabled" };
  const settings = await deps.settings();
  const deadlineAt = opts.deadlineAt ?? Date.now() + 30_000;
  const d = await database();
  const since = nowStr(Date.now() - 2 * 86_400_000);
  // As que o varrimento dos antigos acabou de reservar ficam com ele (só se pega nelas se ficarem presas > 10 min).
  const sweepStale = nowStr(Date.now() - 10 * 60_000);
  // Auditoria: as linhas do varrimento (sweptAt) ficam com ele — só se pega numa que ficou presa
  // "pending" (a corrida morreu a meio) e SEMPRE em modo varrimento (nunca mexe na caixa de tema de um email antigo).
  const rows = rowsOf(await d.execute(sql`SELECT messageId, sweptAt FROM comms_ai_routing
    WHERE channel = 'email' AND createdAt >= ${since} AND attempts < ${MAIL_TRIAGE_MAX_ATTEMPTS}
      AND (sweptAt IS NULL OR (status = 'pending' AND sweptAt < ${sweepStale}))
      AND (status = 'pending' OR (status = 'failed' AND via = 'fallback' AND (error IS NULL OR error <> 'disabled')))
    ORDER BY id LIMIT ${Math.max(1, Math.min(settings.perRun, opts.limit ?? settings.perRun))}`));
  for (const r of rows) {
    if (Date.now() + 16_000 > deadlineAt) { out.skipped = "deadline"; break; }
    const res = await triageStoredMessage(Number(r.messageId), deps, { mode: r.sweptAt != null ? "sweep" : "sync" });
    if (res.status !== "failed" && res.status !== "pending") out.routed++;
  }
  return out;
}

// ─── Varrimento dos emails que já estão nas caixas (AI_MAIL_BACKFILL) ──────

/** Uma linha que o varrimento já leu mas cuja leitura falhou (e ainda tem tentativas). */
const retryableSweep = (r: SQL, stale: string) =>
  sql`${r}.sweptAt < ${stale} AND ${r}.category IS NULL AND ${r}.error IS NOT NULL AND ${r}.attempts > 0 AND ${r}.attempts < ${MAIL_TRIAGE_MAX_ATTEMPTS}`;
/** Uma leitura da sincronização que falhou e que a nova tentativa (runPendingEmailRoutings, 2 dias) ainda vai repetir — não é do varrimento. */
const ownedByPending = (r: SQL, since2d: string) =>
  sql`${r}.sweptAt IS NULL AND ${r}.status = 'failed' AND ${r}.attempts < ${MAIL_TRIAGE_MAX_ATTEMPTS} AND ${r}.createdAt >= ${since2d}`;
/**
 * Ronda 2: um email que a sincronização reservou ("pending") mas nunca leu
 * (teto da corrida, sem tempo) e que já saiu da janela de 2 dias da nova
 * tentativa — antes ficava por ler para sempre; agora o varrimento pega nele.
 */
const strandedPending = (r: SQL, since2d: string) => sql`${r}.status = 'pending' AND ${r}.sweptAt IS NULL AND ${r}.createdAt < ${since2d}`;

export interface BackfillReport { read: number; ai: number; cases: number; skipped?: string }

/**
 * "Tudo o que está na caixa de correio e é uma reclamação tem de ir para lá":
 * os emails recebidos nos últimos `days` dias (Definições, "ai.mailBackfill")
 * nas caixas partilhadas, ainda sem caso, passam pela MESMA triagem (regras +
 * IA). Por lotes, com teto por corrida, do mais recente para o mais antigo.
 * Idempotente: cada email é lido uma vez (a linha em comms_ai_routing fica
 * marcada); o que já tem caso, o que uma pessoa mexeu (moveu, corrigiu,
 * recusou, resolveu, arquivou) e as caixas que criam o caso sozinhas ficam
 * como estão. Não baralha as caixas de tema dos emails antigos: só abre casos
 * (e a conversa vai para a caixa do caso) e trata os avisos.
 */
export async function runMailBackfill(
  opts: { limit?: number; deadlineAt?: number } = {},
  deps: EmailRoutingDeps & { load?: typeof loadStoredTriageMessage; backfillEnabled?: () => Promise<boolean> } = dbEmailRoutingDeps,
): Promise<BackfillReport> {
  const out: BackfillReport = { read: 0, ai: 0, cases: 0 };
  if (!(await (deps.backfillEnabled ?? (() => flagOn("AI_MAIL_BACKFILL")))())) return { ...out, skipped: "disabled" };
  let cfg = mailBackfillSettings(null);
  try { cfg = mailBackfillSettings(await (await import("./appSettings")).getSetting("ai.mailBackfill")); } catch { /* omissão */ }
  const perRun = Math.max(1, Math.min(cfg.perRun, opts.limit ?? cfg.perRun));
  const deadlineAt = opts.deadlineAt ?? Date.now() + 30_000;
  const d = await database();
  const since = nowStr(Date.now() - cfg.days * 86_400_000);
  // Uma leitura que falhou (IA em baixo) volta a ser tentada pelo próprio varrimento, até MAIL_TRIAGE_MAX_ATTEMPTS.
  const stale = nowStr(Date.now() - 10 * 60_000);
  const since2d = nowStr(Date.now() - 2 * 86_400_000);
  // Ronda 2: um email acabado de guardar (m.createdAt < 10 min) é da sincronização — lê-o como email NOVO,
  // com a caixa do tema; o varrimento só lhe pega depois e nunca lhe "rouba" a leitura numa corrida em paralelo.
  const rows = rowsOf(await d.execute(sql`SELECT m.id, m.threadId FROM mail_messages m JOIN mail_threads t ON t.id = m.threadId
    WHERE m.direction = 'in' AND m.sentAt >= ${since} AND m.automated IN (0, 1) AND m.archivedAt IS NULL
      AND m.createdAt < ${stale}
      AND t.mailboxKey IS NOT NULL AND t.ownerUserId IS NULL AND t.archivedAt IS NULL
      AND (t.routedBy IS NULL OR t.routedBy <> 'manual') AND t.status <> 'resolvido'
      AND NOT EXISTS (SELECT 1 FROM comms_ai_routing r WHERE r.sourceRef = CONCAT('mail_message:', m.id)
        AND (r.category IS NOT NULL OR (r.status = 'pending' AND NOT (${strandedPending(sql`r`, since2d)})) OR (${ownedByPending(sql`r`, since2d)})
          OR (r.sweptAt IS NOT NULL AND NOT (${retryableSweep(sql`r`, stale)}))))
      AND NOT EXISTS (SELECT 1 FROM comms_ai_routing c WHERE c.threadId = m.threadId AND c.correctedBoxKey IS NOT NULL)
      AND NOT ${strongCaseLinkSql(sql`m.threadId`)}
      AND NOT EXISTS (SELECT 1 FROM complaint_mail_intake i WHERE i.threadId = m.threadId AND i.status <> 'skipped')
    ORDER BY m.sentAt DESC LIMIT ${perRun * 3}`));
  const routingOn = await deps.enabled();
  for (const r of rows) {
    if (Date.now() + 16_000 > deadlineAt) { out.skipped = "deadline"; break; }
    if (out.ai >= perRun) break;
    const messageId = Number(r.id);
    // IA desligada: o que precisa dela fica por varrer (não se reserva) — volta quando a IA voltar.
    const stored = await (deps.load ?? loadStoredTriageMessage)(messageId, "sweep");
    const willUseAi = !!stored && preTriageMail(stored.pre).action === "ai";
    if (willUseAi && !routingOn) continue;
    // Reserva: linha nova, ou a linha antiga ainda nunca varrida (ou cuja leitura falhou).
    const ins = await d.execute(sql`INSERT IGNORE INTO comms_ai_routing (channel, sourceRef, threadId, messageId, fromBoxKey, via, status, sweptAt)
      SELECT 'email', ${`mail_message:${messageId}`}, m.threadId, m.id, t.mailboxKey, 'ai', 'pending', ${nowStr()}
      FROM mail_messages m JOIN mail_threads t ON t.id = m.threadId WHERE m.id = ${messageId}`);
    let claimed = affected(ins) === 1;
    if (!claimed) {
      const upd = await d.execute(sql`UPDATE comms_ai_routing r SET r.sweptAt = ${nowStr()}
        WHERE r.sourceRef = ${`mail_message:${messageId}`} AND r.category IS NULL
          AND ((r.status <> 'pending' AND ((r.sweptAt IS NULL AND NOT (${ownedByPending(sql`r`, since2d)})) OR ${retryableSweep(sql`r`, stale)}))
            OR (${strandedPending(sql`r`, since2d)}))`);
      claimed = affected(upd) === 1;
    }
    if (!claimed) continue;
    const res = await triageStoredMessage(messageId, { ...deps, load: async () => stored }, { mode: "sweep" });
    out.read++;
    if (willUseAi) out.ai++;
    if ("complaint" in res && caseOpened(res.complaint)) out.cases++;
  }
  return out;
}

// ─── WhatsApp ────────────────────────────────────────────────────────────────

export interface WhatsappConversationLite {
  id: number;
  boxKey: string | null;
  boxSource: string | null;
  employeeId: number | null;
  isLead: boolean;
  phoneE164: string;
  profileName: string | null;
  firstMessageAtMs: number | null;
  /** Texto das últimas mensagens RECEBIDAS (para o email/cidade do candidato; não vai à IA). */
  inboundText: string;
}

export interface WhatsappRoutingDeps {
  enabled(): Promise<boolean>;
  settings(): Promise<CommsRoutingSettings>;
  load(conversationId: number): Promise<WhatsappConversationLite | null>;
  claim(conversationId: number, fromBoxKey: string | null): Promise<boolean>;
  /** Só se a conversa ainda não tiver caixa. false = alguém a pôs entretanto. */
  setBox(conversationId: number, boxKey: string | null, source: "rule" | "ai"): Promise<boolean>;
  record(conversationId: number, patch: DecisionPatch): Promise<void>;
  firstContact(input: FirstContactInput): Promise<FirstContactResult>;
  cityProjectId(text: string | null): Promise<number | null>;
}

export type WhatsappRoutingResult = { status: "off" | "leave" | "seen"; why?: string } | { status: "moved" | "kept"; boxKey: string | null; recruit?: FirstContactResult | null };

/**
 * Depois da triagem (que já leu a conversa — nada de segunda chamada à IA):
 * conversa nova sem caixa → caixa do tema; "outro" ou pouca confiança → Geral.
 * Recrutamento em 1.º contacto → lead (+ candidatura se houver email).
 */
export async function routeWhatsappConversation(
  conversationId: number,
  triage: { intent: WhatsappIntent | null; confidence: number | null; reason: string | null },
  deps: WhatsappRoutingDeps = dbWhatsappRoutingDeps,
  nowMs: number = Date.now(),
): Promise<WhatsappRoutingResult> {
  if (!(await deps.enabled())) return { status: "off" };
  const c = await deps.load(conversationId);
  if (!c) return { status: "leave", why: "missing" };
  const settings = await deps.settings();
  const plan = whatsappRoutingPlan({ ...c, intent: triage.intent, confidence: triage.confidence, nowMs }, settings);
  if (plan.action === "leave") return { status: "leave", why: plan.why };
  if (!(await deps.claim(conversationId, c.boxKey))) return { status: "seen" };
  const applied = await deps.setBox(conversationId, plan.boxKey, plan.boxSource);
  const status: "moved" | "kept" = applied && plan.boxKey ? "moved" : "kept";
  const reason = plan.boxSource === "rule" ? "colaborador ou candidato" : (triage.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || null;

  let recruit: FirstContactResult | null = null;
  let candidate: CandidateData | null = null;
  if (applied && plan.boxSource === "ai" && plan.understood && plan.boxKey === "rh" && triage.intent === "recrutamento") {
    candidate = candidateFromWhatsapp(c);
    try {
      recruit = await deps.firstContact({
        channel: "whatsapp", sourceRef: `ai:whatsapp:${conversationId}`, candidate,
        projectId: await deps.cityProjectId(candidate.city), reason,
      });
    } catch (err: any) {
      console.warn("[IA caixas] candidato (WhatsApp) falhou:", conversationId, String(err?.message ?? err).slice(0, 160));
    }
  }
  await deps.record(conversationId, {
    status, via: plan.boxSource === "rule" ? "rule" : "triage", aiBoxKey: plan.boxSource === "ai" && plan.understood ? plan.boxKey : null,
    boxKey: applied ? plan.boxKey : c.boxKey, confidence: triage.confidence, reason,
    candidateJson: candidate ? JSON.stringify(candidate) : null,
    recruitOutcome: recruit?.outcome ?? null, leadId: recruit?.leadId ?? null, applicationId: recruit?.applicationId ?? null,
  });
  return { status, boxKey: applied ? plan.boxKey : c.boxKey, recruit };
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

/** Candidato de uma conversa de WhatsApp: telefone da conversa, nome do perfil, email/cidade escritos. PURA. */
export function candidateFromWhatsapp(c: Pick<WhatsappConversationLite, "phoneE164" | "profileName" | "inboundText">): CandidateData {
  const name = String(c.profileName ?? "").trim();
  const city = cityKeyFromText(c.inboundText);
  return {
    fullName: name && /\p{L}{2,}/u.test(name) && !/[@\d]/.test(name) ? name.slice(0, 120) : null,
    phone: c.phoneE164,
    email: EMAIL_RE.exec(c.inboundText)?.[0]?.toLowerCase() ?? null,
    city: city ? CITY_LABELS[city] : null,
    hasLicense: null,
    licenseYears: null,
    availability: null,
  };
}

export const dbWhatsappRoutingDeps: WhatsappRoutingDeps = {
  async enabled() {
    // O WhatsApp não chama a IA aqui (a triagem já leu): só conta o interruptor.
    const { aiFeatureEnabledFresh } = await import("./_core/ai/features");
    return aiFeatureEnabledFresh("mail_routing");
  },
  settings: routingSettings,
  async load(conversationId) {
    const d = await database();
    const c = rowsOf(await d.execute(sql`SELECT c.id, c.boxKey, c.boxSource, c.employeeId, c.phoneE164, c.profileName,
        EXISTS (SELECT 1 FROM extra_leads l WHERE l.phoneE164 = c.phoneE164 COLLATE utf8mb4_unicode_ci) AS isLead,
        (SELECT MIN(m.createdAt) FROM whatsapp_messages m WHERE m.conversationId = c.id) AS firstAt
      FROM whatsapp_conversations c WHERE c.id = ${conversationId} LIMIT 1`))[0];
    if (!c) return null;
    const msgs = rowsOf(await d.execute(sql`SELECT body FROM whatsapp_messages WHERE conversationId = ${conversationId} AND direction = 'in' AND body IS NOT NULL ORDER BY id DESC LIMIT 6`));
    const firstAt = c.firstAt ? Date.parse(String(c.firstAt instanceof Date ? c.firstAt.toISOString() : String(c.firstAt).replace(" ", "T") + "Z")) : NaN;
    return {
      id: Number(c.id), boxKey: c.boxKey ?? null, boxSource: c.boxSource ?? null, employeeId: c.employeeId != null ? Number(c.employeeId) : null,
      isLead: Number(c.isLead) === 1, phoneE164: String(c.phoneE164 ?? ""), profileName: c.profileName ?? null,
      firstMessageAtMs: Number.isFinite(firstAt) ? firstAt : null,
      inboundText: msgs.map((m) => String(m.body ?? "")).reverse().join("\n").slice(0, 2000),
    };
  },
  async claim(conversationId, fromBoxKey) {
    const d = await database();
    const res = await d.execute(sql`INSERT IGNORE INTO comms_ai_routing (channel, sourceRef, conversationId, fromBoxKey, via, status)
      VALUES ('whatsapp', ${`whatsapp_conversation:${conversationId}`}, ${conversationId}, ${fromBoxKey}, 'triage', 'pending')`);
    return affected(res) === 1;
  },
  async setBox(conversationId, boxKey, source) {
    const d = await database();
    const res = await d.execute(sql`UPDATE whatsapp_conversations SET boxKey = ${boxKey}, boxSource = ${source}
      WHERE id = ${conversationId} AND boxKey IS NULL AND boxSource IS NULL`);
    return affected(res) === 1;
  },
  record: (conversationId, p) => recordDecision(`whatsapp_conversation:${conversationId}`, p),
  async firstContact(input) {
    const { onRecruitmentFirstContact } = await import("./recruitmentFirstContact");
    return onRecruitmentFirstContact(input);
  },
  cityProjectId: cityProjectIdOf,
};

// ─── Correções à mão e o que se mostra no ecrã ──────────────────────────────

/** Uma pessoa mudou a caixa: fica registado como correção (nunca lança). `boxKey` null = Geral. */
export async function noteManualBoxChange(channel: "email" | "whatsapp", id: number, boxKey: string | null, userId: number): Promise<void> {
  try {
    const d = await database();
    const col = channel === "email" ? sql`threadId` : sql`conversationId`;
    await d.execute(sql`UPDATE comms_ai_routing SET correctedBoxKey = ${boxKey ?? ""}, correctedById = ${userId}, correctedAt = ${nowStr()}
      WHERE channel = ${channel} AND ${col} = ${id} AND status <> 'pending'`);
  } catch (err: any) {
    console.warn("[IA caixas] registar correção:", String(err?.message ?? err).slice(0, 160));
  }
}

/** "Movido pela IA → caixa (motivo)" de uma conversa (quem chama já verificou o acesso). */
export async function routingNoteFor(channel: "email" | "whatsapp", id: number): Promise<{ text: string; status: string; boxKey: string | null; corrected: boolean } | null> {
  const d = await database();
  const col = channel === "email" ? sql`threadId` : sql`conversationId`;
  // 14 out 2026: uma conversa pode ter várias leituras (as respostas também são lidas) — mostra a
  // última que MUDOU a caixa (ex.: a resposta que abriu a reclamação); sem nenhuma, a primeira.
  const r = rowsOf(await d.execute(sql`SELECT status, via, boxKey, fromBoxKey, reason, confidence, correctedBoxKey FROM comms_ai_routing
    WHERE channel = ${channel} AND ${col} = ${id} AND status <> 'pending'
    ORDER BY (status = 'moved') DESC, CASE WHEN status = 'moved' THEN -id ELSE id END LIMIT 1`))[0];
  if (!r) return null;
  const { listMailboxes } = await import("./mail/store");
  const labels = new Map((await listMailboxes()).map((b) => [b.key, b.label]));
  const label = (k: string | null) => (k ? labels.get(k) ?? k : channel === "whatsapp" ? "Geral" : labels.get(GENERAL_BOX_KEY) ?? "Geral");
  const row = {
    status: String(r.status), via: String(r.via), boxKey: r.boxKey ?? null, fromBoxKey: r.fromBoxKey ?? null, reason: r.reason ?? null,
    confidence: r.confidence != null ? Number(r.confidence) : null, correctedBoxKey: r.correctedBoxKey ?? null,
  };
  const text = routingNoteText(row, label);
  return text ? { text, status: row.status, boxKey: row.boxKey, corrected: row.correctedBoxKey != null } : null;
}

export interface AiIntakeRow {
  id: number;
  channel: "email" | "whatsapp";
  threadId: number | null;
  conversationId: number | null;
  outcome: string;
  reason: string | null;
  confidence: number | null;
  leadId: number | null;
  applicationId: number | null;
  leadName: string | null;
  /** Caixa onde ficou (para o link da conversa). */
  boxKey: string | null;
  decidedAt: string | null;
}

/**
 * Recrutamento: o que entrou pela IA (últimos `days` dias), para a página dos
 * Leads. Só as leads das cidades de quem vê (sem lead: só quem vê todas).
 */
export async function listAiIntake(opts: { days?: number; scope: number[] | undefined }): Promise<AiIntakeRow[]> {
  const d = await database();
  const since = nowStr(Date.now() - Math.max(1, Math.min(90, opts.days ?? 30)) * 86_400_000);
  const rows = rowsOf(await d.execute(sql`SELECT r.id, r.channel, r.threadId, r.conversationId, r.recruitOutcome, r.reason, r.confidence, r.leadId, r.applicationId, r.boxKey,
      DATE_FORMAT(r.decidedAt, '%Y-%m-%d %H:%i:%s') AS decidedAt, l.fullName AS leadName, l.projectId AS leadProjectId
    FROM comms_ai_routing r LEFT JOIN extra_leads l ON l.id = r.leadId
    WHERE r.recruitOutcome IS NOT NULL AND r.createdAt >= ${since}
    ORDER BY r.id DESC LIMIT 100`));
  const { projectVisible } = await import("./extrasCityFilter");
  return rows
    .filter((r) => (r.leadId != null ? projectVisible(r.leadProjectId != null ? Number(r.leadProjectId) : null, opts.scope) : opts.scope === undefined))
    .map((r) => ({
      id: Number(r.id), channel: r.channel === "whatsapp" ? "whatsapp" : "email",
      threadId: r.threadId != null ? Number(r.threadId) : null, conversationId: r.conversationId != null ? Number(r.conversationId) : null,
      outcome: String(r.recruitOutcome), reason: r.reason ?? null, confidence: r.confidence != null ? Number(r.confidence) : null,
      leadId: r.leadId != null ? Number(r.leadId) : null, applicationId: r.applicationId != null ? Number(r.applicationId) : null,
      leadName: r.leadName ?? null, boxKey: r.boxKey ?? null, decidedAt: r.decidedAt ?? null,
    }));
}
