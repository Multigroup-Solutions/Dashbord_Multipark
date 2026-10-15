/**
 * Assistente da EQUIPA: liga o núcleo do chat (server/_core/ai/chat) à
 * aplicação — ajuda de docs/ajuda, ferramentas de dados com as permissões da
 * pessoa (tools.ts), limites de Definições e registo em activity_logs.
 *
 * Multis 2 (Jorge, 8 out 2026):
 *  - ajuda também pelo SIGNIFICADO (a mesma consulta à base de conhecimento
 *    traz os trechos da ajuda; máx. 3 páginas);
 *  - memória: "Lembra-te…" grava a nota SEM IA (memory.ts); as notas ativas
 *    vão no contexto do turno (<memoria>), nunca no prompt estável;
 *  - depois de cada resposta, as que não responderam (não sei / sem acesso /
 *    ferramenta com erro) ficam marcadas em "Perguntas que falharam".
 *
 * Plano MPV (F0b):
 *  - piloto: com o interruptor MPV ligado e a pessoa em `ai.assistantPilot`,
 *    o turno usa a funcionalidade `assistant_smart` (nível smart, limites e
 *    teto € próprios); senão `assistant` (lite), como sempre. Teto próprio
 *    atingido → `assistant` com a nota "modo económico" (não bloqueia nada);
 *  - contexto da página: o separador aberto e o registo aberto (validados
 *    contra as listas do código, shared/multisPage.ts) vão no <contexto>.
 *
 * Plano MPV (F3) — o CONTEÚDO do MPV, só para quem está no piloto (o v1 fica
 * exatamente igual): sistema com o índice da árvore (igual para todos),
 * ferramentas declaradas iguais para todos (+ a lista das permitidas no
 * <contexto>), `ajuda_abrir`/`ajuda_procurar` em vez do `abrir_ajuda`, e por
 * pergunta o perfil da página + as secções da ajuda (mpv.ts).
 *
 * Plano MPV (F5, só no piloto): as 2 secções a mais, o `ajuda_procurar` e os
 * manuais procuram-se também pelo significado (lexical/FULLTEXT ∪ vizinhos por
 * vetor em memória — helpSearch.ts, knowledge/vectorIndex.ts), com o vetor da
 * pergunta calculado UMA vez no pedido; sem vetores (ou > 3 s), a lexical.
 */
import {
  AI_ASSISTANT_DEFAULT_LIMITS, AI_ASSISTANT_SMART_DEFAULT_LIMITS, automationFlagDefault, type AiAssistantLimits,
} from "../../shared/appSettings";
import { MULTIS_ENTITY_LABELS, pagePathOf, sanitizeMultisPage, type MultisEntity } from "../../shared/multisPage";
import type { OwnBudgetReason } from "../_core/ai/usage";
import { ROLE_LABELS, type Role } from "../../shared/access";
import { REMEMBER_MESSAGES, memoryBlock, parseRememberCommand, type RememberCommand } from "../../shared/assistantMemory";
import { detectUnanswered } from "../../shared/assistantFeedback";
import { runChatTurn, type ChatKnowledge, type ChatTurnResult } from "../_core/ai/chat/engine";
import { appendExchange, resolveConversation } from "../_core/ai/chat/store";
import { helpIndex, parseHelpDoc, type HelpDoc, type HelpHit } from "../_core/ai/chat/retrieval";
import { userKey } from "../_core/ai/rateLimit";
import { assistantSystemPrompt } from "../_core/ai/prompts/assistant";
import { HELP_FILES } from "./helpDocs.generated";
import { staffToolsFor, type StaffToolCtx } from "./tools";
import { MPV_VARIANT, mpvAllowedToolNames, mpvSystemPrompt, mpvTurnBudget, mpvTurnKnowledgeAsync } from "./mpv";
import { makeSectionSearch } from "./helpSearch";
import { kbViewerFrom, onceQueryEmbed, type QueryEmbedFn } from "../knowledge/retrieve";
import type { CityAccess } from "../cityAccess";
import type { AiFeature } from "../_core/ai/features";
import type { AiTier } from "../_core/ai/models";
import type { ChatTool } from "../_core/ai/chat/tools";

/** Quantos trechos da ajuda a base devolve por pergunta (dão até 3 ficheiros). */
export const HELP_KB_TOP_K = 6;

/** "help:caixa.md" → "caixa.md" (o resto não é ajuda). PURA. */
export function helpFileOfRef(ref: string | null | undefined): string | null {
  const m = /^help:(.+\.md)$/.exec(String(ref ?? ""));
  return m ? m[1] : null;
}

/**
 * Trechos da base de conhecimento para o assistente — só os que a pessoa pode
 * ver (papel + cidades do pedido). Na MESMA consulta (um só vetor da
 * pergunta) vêm os trechos da ajuda da app achados pelo significado
 * (`helpHits`), que se juntam aos ficheiros escolhidos por palavras-chave.
 * Nunca lança; desligado nas definições → nada (a ajuda fica só por
 * palavras-chave, como antes).
 */
export async function assistantKnowledge(
  question: string, role: string, access: CityAccess | undefined,
  /**
   * MPV: a ajuda vem da árvore (mpv.ts) → sem trechos da ajuda da base (helpTopK 0);
   * F5: + os vizinhos por vetor, com o vetor da pergunta do pedido (`embedQuery`).
   */
  opts: { helpTopK?: number; vectorNeighbors?: boolean; embedQuery?: QueryEmbedFn | null } = {},
): Promise<ChatKnowledge | null> {
  const { loadKnowledgeConfig } = await import("../knowledge/sync");
  if (!(await loadKnowledgeConfig()).useInAssistant) return null;
  const { retrieveKnowledge, knowledgeBlock, kbViewerFrom } = await import("../knowledge/retrieve");
  const r = await retrieveKnowledge({
    question, viewer: kbViewerFrom(role, access), topK: 4, excludeSources: ["help"], helpTopK: opts.helpTopK ?? HELP_KB_TOP_K,
    ...(opts.vectorNeighbors ? { vectorNeighbors: true, embedQuery: opts.embedQuery ?? null } : {}),
  });
  // 18d: a consulta falhou → o assistente diz que não conseguiu consultar (não
  // que os manuais não falam disso).
  if (r.failed) return { block: KB_UNAVAILABLE_BLOCK, citations: [] };
  const helpHits: HelpHit[] = [];
  for (const h of r.helpHits ?? []) {
    const file = helpFileOfRef(h.ref);
    if (file) helpHits.push({ file, score: h.score, text: h.text });
  }
  if (!r.hits.length && !helpHits.length) return null;
  return { block: r.hits.length ? knowledgeBlock(r.hits) : "", citations: r.citations, helpHits };
}

/** O vetorizador do piloto (null se os vetores estiverem desligados). Nunca lança. */
async function mpvQueryEmbedderLazy(): Promise<QueryEmbedFn | null> {
  const { mpvQueryEmbedder } = await import("../knowledge/retrieve");
  return mpvQueryEmbedder();
}

/** Aviso para o modelo quando a base de conhecimento não respondeu (18d). */
export const KB_UNAVAILABLE_BLOCK = "<conhecimento>\nNão foi possível consultar os manuais agora (erro temporário). Se a pergunta for sobre procedimentos internos, diz que não conseguiste consultar os manuais e que tente de novo daqui a pouco — não digas que os manuais não falam disso.\n</conhecimento>";

export const ASSISTANT_FEATURE = "assistant" as const;
/** Plano MPV §5.2: o Multis das pessoas do piloto (nível smart, teto próprio). */
export const ASSISTANT_SMART_FEATURE = "assistant_smart" as const;
export type AssistantFeature = typeof ASSISTANT_FEATURE | typeof ASSISTANT_SMART_FEATURE;
/** Teto de saída BASE no smart (plano MPV §3.6: Argon low 2 048; medium sobe a 4 096 pelo maxTokensFor). */
export const ASSISTANT_SMART_MAX_OUTPUT_TOKENS = 2048;
export const ASSISTANT_CHANNEL = "staff" as const;
/** Teto de um pedido ao Multis, contado desde o início (a função da Vercel tem 60 s). */
export const ASSISTANT_REQUEST_MAX_MS = 50_000;

let docsMemo: HelpDoc[] | null = null;
export function staffHelpDocs(): HelpDoc[] {
  if (!docsMemo) docsMemo = HELP_FILES.map((f) => parseHelpDoc(f.file, f.raw));
  return docsMemo;
}

let systemMemo: string | null = null;
/** Prefixo estável (igual para toda a gente → uma cache de contexto por conjunto de ferramentas). */
export function staffSystemPrompt(): string {
  if (!systemMemo) systemMemo = assistantSystemPrompt(helpIndex(staffHelpDocs()));
  return systemMemo;
}

export const ownerKeyFor = (userId: number) => userKey(userId);

/**
 * Limites em vigor (Definições → Parâmetros → ai.assistantLimits; no piloto
 * smart, ai.assistantSmartLimits). Nunca lança.
 */
export async function assistantLimits(feature: AssistantFeature = ASSISTANT_FEATURE): Promise<Required<AiAssistantLimits>> {
  const smart = feature === ASSISTANT_SMART_FEATURE;
  const defaults = smart ? AI_ASSISTANT_SMART_DEFAULT_LIMITS : AI_ASSISTANT_DEFAULT_LIMITS;
  let v: AiAssistantLimits | null = null;
  try {
    const { getSetting } = await import("../appSettings");
    v = smart ? await getSetting("ai.assistantSmartLimits") : await getSetting("ai.assistantLimits");
  } catch { v = null; }
  return {
    perMinute: v?.perMinute ?? defaults.perMinute,
    perDay: v?.perDay ?? defaults.perDay,
    maxInputChars: v?.maxInputChars ?? defaults.maxInputChars,
  };
}

/** Esta pessoa está no piloto? (interruptor MPV ligado + id em ai.assistantPilot). Nunca lança. */
export async function inAssistantPilot(userId: number): Promise<boolean> {
  try {
    const { ensureFeatureFlagOverrides, isFeatureEnabled } = await import("../_core/featureFlags");
    await ensureFeatureFlagOverrides();
    if (!isFeatureEnabled("MPV", { defaultEnabled: automationFlagDefault("MPV") })) return false;
    const { getSetting } = await import("../appSettings");
    const pilot = await getSetting("ai.assistantPilot");
    return Array.isArray(pilot?.userIds) && pilot.userIds.includes(userId);
  } catch {
    return false;
  }
}

export interface AssistantMode {
  /** A funcionalidade que vai responder a esta pessoa. */
  feature: AssistantFeature;
  /** Está no piloto (MPV + ai.assistantPilot). */
  pilot: boolean;
  /** No piloto, mas o teto próprio foi atingido → responde o lite ("modo económico"). */
  economy: boolean;
  economyReason: OwnBudgetReason | null;
}

/**
 * A funcionalidade EFETIVA desta pessoa (plano MPV §5.2/§5.3): fora do piloto,
 * `assistant`; no piloto com o smart disponível e dentro do teto,
 * `assistant_smart`; no piloto com o teto atingido, `assistant` em modo
 * económico; no piloto com o smart desligado, `assistant` (sem nota). Nunca lança.
 */
export async function assistantModeFor(userId: number): Promise<AssistantMode> {
  const base: AssistantMode = { feature: ASSISTANT_FEATURE, pilot: false, economy: false, economyReason: null };
  if (!(await inAssistantPilot(userId))) return base;
  try {
    const { aiFeatureAvailableFresh } = await import("../_core/ai/status");
    // Desligar o assistente pára também o piloto (o status mostra "desligado").
    if (!(await aiFeatureAvailableFresh(ASSISTANT_FEATURE))) return { ...base, pilot: true };
    if (!(await aiFeatureAvailableFresh(ASSISTANT_SMART_FEATURE))) return { ...base, pilot: true };
    const { ownBudgetCheck } = await import("../_core/ai/usage");
    const own = await ownBudgetCheck(ASSISTANT_SMART_FEATURE, userId);
    if (!own.ok) return { ...base, pilot: true, economy: true, economyReason: own.reason };
    return { feature: ASSISTANT_SMART_FEATURE, pilot: true, economy: false, economyReason: null };
  } catch {
    return { ...base, pilot: true };
  }
}

/** Nota curta do modo económico (widget e status), pelo motivo. PURA. */
export function economyNote(reason: OwnBudgetReason | string | null | undefined): string {
  switch (reason) {
    case "user_day": return "Modo económico: hoje já chegaste ao teu teto diário do Multis do piloto, por isso respondo com o modelo de sempre (volta amanhã).";
    case "day": return "Modo económico: hoje o Multis do piloto já chegou ao teto do dia, por isso respondo com o modelo de sempre (volta amanhã).";
    case "month": return "Modo económico: este mês o Multis do piloto já chegou ao teto do mês, por isso respondo com o modelo de sempre.";
    default: return "Modo económico: agora não consegui confirmar o gasto do Multis do piloto, por isso respondo com o modelo de sempre.";
  }
}

/** Dia de hoje em Lisboa (AAAA-MM-DD). */
export function lisbonDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const WEEKDAYS = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

/**
 * Contexto do turno (fora da cache): data, página, separador e registo abertos
 * (já validados — sanitizeMultisPage), papel, cidades (e se a memória está
 * desligada). PURA.
 */
export function turnContext(p: {
  today: string; path?: string | null; role: string; cities: string[] | "todas"; memoryOff?: boolean;
  tab?: string | null; entity?: MultisEntity | null;
  /** MPV: as ferramentas que esta pessoa pode usar (todas vão declaradas; §3.7). */
  tools?: readonly string[];
}): string {
  const wd = WEEKDAYS[new Date(`${p.today}T12:00:00Z`).getUTCDay()];
  return [
    `Hoje: ${p.today} (${wd}, Lisboa).`,
    pagePathOf(p.path) ? `Página aberta: ${pagePathOf(p.path)}` : null,
    p.tab ? `Separador aberto: ${p.tab}` : null,
    p.entity ? `Registo aberto: ${p.entity.type} #${p.entity.id} (${MULTIS_ENTITY_LABELS[p.entity.type]})` : null,
    `Papel da pessoa: ${ROLE_LABELS[p.role as Role] ?? p.role}.`,
    `Cidades a que tem acesso: ${p.cities === "todas" ? "todas" : p.cities.join(", ") || "nenhuma"}.`,
    p.memoryOff ? "A memória do Multis está desligada: não consegues guardar notas (se pedirem, diz que um administrador a liga em Definições → Automações)." : null,
    p.tools ? `Ferramentas que podes usar: ${p.tools.length ? p.tools.join(", ") : "nenhuma"}.` : null,
  ].filter(Boolean).join("\n");
}

export interface AskInput {
  question: string;
  conversationId?: number | null;
  newConversation?: boolean;
  path?: string | null;
  /** Separador aberto (validado contra a lista da página; fora dela, ignorado). */
  tab?: string | null;
  /** Registo aberto ({ type, id }; validado; fora da lista, ignorado). */
  entity?: unknown;
}

/** Resposta do Multis + a versão que respondeu (piloto / modo económico). */
export type AssistantTurnResult = ChatTurnResult & {
  /** Funcionalidade que respondeu (assistant | assistant_smart). */
  feature?: AssistantFeature;
  /** Respondeu o lite porque o teto do piloto foi atingido (ou não se conseguiu medir). */
  economy?: boolean;
  /** Texto do modo económico, pelo motivo. */
  economyNote?: string;
};

/**
 * "Lembra-te…" (sem IA): grava a nota pessoal e responde. A troca fica na
 * conversa como as outras. Nunca lança.
 */
export async function rememberTurn(cmd: Exclude<RememberCommand, { kind: "none" }>, input: AskInput, userId: number): Promise<ChatTurnResult> {
  let answer: string;
  let memory: "saved" | "exists" | "rejected" = "rejected";
  if (cmd.kind === "empty") answer = REMEMBER_MESSAGES.empty;
  else if (cmd.kind === "too_long") answer = REMEMBER_MESSAGES.tooLong(cmd.length);
  else {
    const { addMemory } = await import("./memory");
    const r = await addMemory("user", userId, cmd.text).catch(() => ({ ok: false as const, reason: "unavailable" as const }));
    if (r.ok) { answer = REMEMBER_MESSAGES.saved(r.text); memory = "saved"; }
    else if (r.reason === "exists") { answer = REMEMBER_MESSAGES.exists(r.text ?? cmd.text); memory = "exists"; }
    else if (r.reason === "full") answer = REMEMBER_MESSAGES.full;
    else answer = REMEMBER_MESSAGES.failed;
  }
  let conversationId: number | null = null;
  let messageId: number | null = null;
  try {
    conversationId = await resolveConversation(ASSISTANT_CHANNEL, ownerKeyFor(userId), {
      userId, conversationId: input.conversationId ?? null, forceNew: input.newConversation,
    });
    if (conversationId) messageId = (await appendExchange(conversationId, input.question.trim(), answer, { path: input.path })).answerId;
  } catch { /* a nota já está (ou não) guardada; a conversa é secundária */ }
  return { ok: true, answer, conversationId, messageId, toolsUsed: [], helpFiles: [], toolErrors: [], memory };
}

/** Um turno do assistente para a pessoa de `toolCtx.user`. Nunca lança. */
export async function askAssistant(
  input: AskInput,
  toolCtx: StaffToolCtx,
  hooks: {
    logToolCall?: (name: string, args: Record<string, unknown>, conversationId: number | null) => Promise<void>;
    /** MPV: chamada recusada (ferramenta declarada a que a pessoa não tem acesso) — registo à parte. */
    logToolRefused?: (name: string, args: Record<string, unknown>, conversationId: number | null) => Promise<void>;
    /** Base de conhecimento (omisso = a real; null = sem). */
    knowledge?: ((question: string) => Promise<ChatKnowledge | null>) | null;
    /** Memória ligada? (omisso = o interruptor AI_ASSISTANT_MEMORY). */
    memoryEnabled?: boolean;
    /** Versão desta pessoa (omisso = assistantModeFor). */
    mode?: AssistantMode;
    /** MPV (F5): o vetorizador da pergunta (omisso = o real, se os vetores estiverem ligados; null = sem vetores). */
    embedQuery?: QueryEmbedFn | null;
    /**
     * Avaliação (scripts/eval-multis.ts, plano MPV §8.2/F8): o turno corre como
     * `feature` (assistant_eval) no `tier` da versão, sem conversa guardada nem
     * limite de pedidos e sem descer para o lite, com as ferramentas embrulhadas
     * (respostas gravadas). O resto — sistema, contexto, ajuda, perfis, voltas —
     * é o da versão (`mode`). Nunca em produção.
     */
    evalRun?: { feature: AiFeature; tier: AiTier; wrapTools: (tools: ChatTool<StaffToolCtx>[]) => ChatTool<StaffToolCtx>[] };
  } = {},
): Promise<AssistantTurnResult> {
  const startedAt = Date.now();
  const user = toolCtx.user;
  const { assistantMemoryEnabled, activeNotesForTurn } = await import("./memory");
  const memoryOn = hooks.memoryEnabled ?? (await assistantMemoryEnabled());
  let memory = "";
  if (memoryOn) {
    const cmd = parseRememberCommand(input.question);
    if (cmd.kind !== "none") return rememberTurn(cmd, input, user.id);
    const notes = await activeNotesForTurn(user.id);
    memory = memoryBlock(notes.personal, notes.company, input.question);
  }
  const mode = hooks.mode ?? (await assistantModeFor(user.id));
  const cities = toolCtx.access?.all ? "todas" : (toolCtx.access?.cityNames ?? (toolCtx.access?.cityName ? [toolCtx.access.cityName] : []));
  const page = sanitizeMultisPage({ path: input.path, tab: input.tab, entity: input.entity });
  // Plano MPV (F3): quem está no piloto recebe o conteúdo do MPV (também no
  // modo económico — é o "MPV-lite"); os outros, o v1 tal e qual.
  const mpv = mode.pilot;
  const tools = hooks.evalRun ? hooks.evalRun.wrapTools(staffToolsFor(mode)) : staffToolsFor(mode);
  const context = turnContext({
    today: toolCtx.today, path: input.path, role: user.role, cities, memoryOff: !memoryOn, tab: page.tab, entity: page.entity,
    ...(mpv ? { tools: mpvAllowedToolNames(toolCtx, tools) } : {}),
  });
  // Plano MPV (F5): no piloto a ajuda e os manuais procuram-se também pelo significado. O vetor
  // da pergunta calcula-se UMA vez no pedido (partilhado pelo bloco da ajuda, pela base de
  // conhecimento e pela descida smart → lite); sem vetores, a lexical de sempre.
  // O eval (F8) é reprodutível: sem vetores (a ajuda vem pela lexical da árvore), salvo se o pedir.
  const rawEmbed = mpv ? (hooks.embedQuery !== undefined ? hooks.embedQuery : hooks.evalRun ? null : await mpvQueryEmbedderLazy()) : null;
  const embedQuery = rawEmbed ? onceQueryEmbed(rawEmbed) : null;
  const sectionSearch = mpv && embedQuery ? makeSectionSearch({ viewer: kbViewerFrom(user.role, toolCtx.access), embedQuery }) : null;
  const turnCtx: StaffToolCtx = sectionSearch ? { ...toolCtx, sectionSearch } : toolCtx;
  // O bloco da página calcula-se no motor (depois do limite de pedidos), EM PARALELO com a base
  // de conhecimento, e UMA vez por pedido (a descida smart → lite reaproveita-o).
  let pkOnce: Promise<{ block: string; refs: string[] }> | null = null;
  const pageKnowledge = mpv
    ? () => (pkOnce ??= mpvTurnKnowledgeAsync({ path: input.path, tab: page.tab, question: input.question, ctx: toolCtx }, sectionSearch)
        .then((r) => ({ block: r.block, refs: r.refs })))
    : null;
  const knowledgeFor = (q: string) => assistantKnowledge(q, user.role, toolCtx.access, mpv ? { helpTopK: 0, vectorNeighbors: true, embedQuery } : {});
  const kbSource = hooks.knowledge === null ? undefined : (hooks.knowledge ?? knowledgeFor);
  // A base de conhecimento consulta-se UMA vez por pedido (a descida smart → lite reaproveita-a).
  let kbOnce: Promise<ChatKnowledge | null> | null = null;
  const knowledge = kbSource ? (q: string) => (kbOnce ??= kbSource(q)) : undefined;
  const turn = async (feature: AssistantFeature, conversationId: number | null, newConversation: boolean | undefined, deadlineMs?: number) => runChatTurn<StaffToolCtx>({
    feature: hooks.evalRun?.feature ?? feature,
    ...(hooks.evalRun ? { tier: hooks.evalRun.tier, ephemeral: true } : {}),
    channel: ASSISTANT_CHANNEL,
    ownerKey: ownerKeyFor(user.id),
    userId: user.id,
    question: input.question,
    conversationId,
    newConversation,
    limits: await assistantLimits(feature),
    // O lite fica com a chave de sempre; o piloto tem a sua (limites próprios).
    rateKey: `${feature}:${userKey(user.id)}`,
    system: mpv ? mpvSystemPrompt() : staffSystemPrompt(),
    cacheSystem: true,
    // A versão do conteúdo (v1 | mpv) fica no registo e na resposta guardada; o nível também.
    variant: mpv ? MPV_VARIANT : "v1",
    ...(feature === ASSISTANT_SMART_FEATURE ? { maxOutputTokens: ASSISTANT_SMART_MAX_OUTPUT_TOKENS } : {}),
    // MPV §3.6: prazo 35 s (8 s para a chamada final), 4 voltas no Argon e 3 no lite; o v1 fica como está.
    ...(mpv ? mpvTurnBudget(feature) : {}),
    ...(deadlineMs != null ? { deadlineMs } : {}),
    context,
    memory,
    ...(pageKnowledge ? { pageKnowledge } : { helpDocs: toolCtx.helpDocs }),
    path: input.path,
    // Plano MPV (F2/F3): no piloto as ferramentas do MPV (ajuda_abrir/ajuda_procurar, regras_em_vigor, sem abrir_ajuda); fora dele, o de sempre.
    tools,
    // MPV: as mesmas ferramentas declaradas a toda a gente (uma cache por modelo, §5.4).
    ...(mpv ? { declareAllTools: true } : {}),
    toolCtx: turnCtx,
    knowledge,
    onToolCall: async (name, args, cid) => {
      await hooks.logToolCall?.(name, args, cid);
    },
    onToolRefused: async (name, args, cid) => {
      await hooks.logToolRefused?.(name, args, cid);
    },
  });
  let feature: AssistantFeature = mode.feature;
  let economy = mode.economy;
  let economyWhy: string | null = mode.economyReason;
  let r = await turn(feature, input.conversationId ?? null, input.newConversation);
  // Teto próprio atingido entre a escolha e a chamada (ou orçamento): desce para o lite, na mesma conversa.
  if (!r.ok && r.reason === "budget" && feature === ASSISTANT_SMART_FEATURE && !hooks.evalRun) {
    feature = ASSISTANT_FEATURE;
    economy = r.budgetScope === "own";
    economyWhy = r.budgetReason ?? null;
    const cid = r.conversationId ?? input.conversationId ?? null;
    // O total (as duas tentativas) cabe nos 60 s da Vercel com margem: prazo contado desde o início.
    r = await turn(feature, cid, cid ? false : input.newConversation, startedAt + ASSISTANT_REQUEST_MAX_MS);
  }
  // Respostas que não responderam → "Perguntas que falharam" (marca automática).
  if (r.ok && r.messageId) {
    const why = detectUnanswered(r.answer, r.toolErrors);
    if (why) {
      const { recordAutoFlag } = await import("./feedback");
      await recordAutoFlag({
        messageId: r.messageId, conversationId: r.conversationId, userId: user.id, question: input.question, answer: r.answer,
        path: input.path, tools: r.toolsUsed, helpFiles: r.helpFiles, comment: why,
      });
    }
  }
  if (!r.ok) return r;
  // O `run` (custo, voltas) é só para o eval: o widget recebe o formato de sempre.
  const { run, ...rest } = r;
  return { ...rest, ...(hooks.evalRun && run ? { run } : {}), feature, ...(economy ? { economy: true, economyNote: economyNote(economyWhy) } : {}) };
}
