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
 */
import { AI_ASSISTANT_DEFAULT_LIMITS, type AiAssistantLimits } from "../../shared/appSettings";
import { ROLE_LABELS, type Role } from "../../shared/access";
import { REMEMBER_MESSAGES, memoryBlock, parseRememberCommand, type RememberCommand } from "../../shared/assistantMemory";
import { detectUnanswered } from "../../shared/assistantFeedback";
import { runChatTurn, type ChatKnowledge, type ChatTurnResult } from "../_core/ai/chat/engine";
import { appendExchange, resolveConversation } from "../_core/ai/chat/store";
import { helpIndex, parseHelpDoc, type HelpDoc, type HelpHit } from "../_core/ai/chat/retrieval";
import { userKey } from "../_core/ai/rateLimit";
import { assistantSystemPrompt } from "../_core/ai/prompts/assistant";
import { HELP_FILES } from "./helpDocs.generated";
import { STAFF_TOOLS, type StaffToolCtx } from "./tools";
import type { CityAccess } from "../cityAccess";

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
export async function assistantKnowledge(question: string, role: string, access: CityAccess | undefined): Promise<ChatKnowledge | null> {
  const { loadKnowledgeConfig } = await import("../knowledge/sync");
  if (!(await loadKnowledgeConfig()).useInAssistant) return null;
  const { retrieveKnowledge, knowledgeBlock, kbViewerFrom } = await import("../knowledge/retrieve");
  const r = await retrieveKnowledge({ question, viewer: kbViewerFrom(role, access), topK: 4, excludeSources: ["help"], helpTopK: HELP_KB_TOP_K });
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

/** Aviso para o modelo quando a base de conhecimento não respondeu (18d). */
export const KB_UNAVAILABLE_BLOCK = "<conhecimento>\nNão foi possível consultar os manuais agora (erro temporário). Se a pergunta for sobre procedimentos internos, diz que não conseguiste consultar os manuais e que tente de novo daqui a pouco — não digas que os manuais não falam disso.\n</conhecimento>";

export const ASSISTANT_FEATURE = "assistant" as const;
export const ASSISTANT_CHANNEL = "staff" as const;

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

/** Limites em vigor (Definições → Parâmetros → ai.assistantLimits). Nunca lança. */
export async function assistantLimits(): Promise<Required<AiAssistantLimits>> {
  let v: AiAssistantLimits | null = null;
  try {
    const { getSetting } = await import("../appSettings");
    v = await getSetting("ai.assistantLimits");
  } catch { v = null; }
  return {
    perMinute: v?.perMinute ?? AI_ASSISTANT_DEFAULT_LIMITS.perMinute,
    perDay: v?.perDay ?? AI_ASSISTANT_DEFAULT_LIMITS.perDay,
    maxInputChars: v?.maxInputChars ?? AI_ASSISTANT_DEFAULT_LIMITS.maxInputChars,
  };
}

/** Dia de hoje em Lisboa (AAAA-MM-DD). */
export function lisbonDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const WEEKDAYS = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

/** Contexto do turno (fora da cache): data, página, papel, cidades (e se a memória está desligada). PURA. */
export function turnContext(p: { today: string; path?: string | null; role: string; cities: string[] | "todas"; memoryOff?: boolean }): string {
  const wd = WEEKDAYS[new Date(`${p.today}T12:00:00Z`).getUTCDay()];
  return [
    `Hoje: ${p.today} (${wd}, Lisboa).`,
    p.path ? `Página aberta: ${p.path.split("?")[0]}` : null,
    `Papel da pessoa: ${ROLE_LABELS[p.role as Role] ?? p.role}.`,
    `Cidades a que tem acesso: ${p.cities === "todas" ? "todas" : p.cities.join(", ") || "nenhuma"}.`,
    p.memoryOff ? "A memória do Multis está desligada: não consegues guardar notas (se pedirem, diz que um administrador a liga em Definições → Automações)." : null,
  ].filter(Boolean).join("\n");
}

export interface AskInput {
  question: string;
  conversationId?: number | null;
  newConversation?: boolean;
  path?: string | null;
}

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
    /** Base de conhecimento (omisso = a real; null = sem). */
    knowledge?: ((question: string) => Promise<ChatKnowledge | null>) | null;
    /** Memória ligada? (omisso = o interruptor AI_ASSISTANT_MEMORY). */
    memoryEnabled?: boolean;
  } = {},
): Promise<ChatTurnResult> {
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
  const limits = await assistantLimits();
  const cities = toolCtx.access?.all ? "todas" : (toolCtx.access?.cityNames ?? (toolCtx.access?.cityName ? [toolCtx.access.cityName] : []));
  const r = await runChatTurn<StaffToolCtx>({
    feature: ASSISTANT_FEATURE,
    channel: ASSISTANT_CHANNEL,
    ownerKey: ownerKeyFor(user.id),
    userId: user.id,
    question: input.question,
    conversationId: input.conversationId ?? null,
    newConversation: input.newConversation,
    limits,
    rateKey: `assistant:${userKey(user.id)}`,
    system: staffSystemPrompt(),
    cacheSystem: true,
    context: turnContext({ today: toolCtx.today, path: input.path, role: user.role, cities, memoryOff: !memoryOn }),
    memory,
    helpDocs: toolCtx.helpDocs,
    path: input.path,
    tools: STAFF_TOOLS,
    toolCtx,
    knowledge: hooks.knowledge === null ? undefined : (hooks.knowledge ?? ((q) => assistantKnowledge(q, user.role, toolCtx.access))),
    onToolCall: async (name, args, conversationId) => {
      await hooks.logToolCall?.(name, args, conversationId);
    },
  });
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
  return r;
}
