/**
 * Assistente da EQUIPA: liga o núcleo do chat (server/_core/ai/chat) à
 * aplicação — ajuda de docs/ajuda, ferramentas de dados com as permissões da
 * pessoa (tools.ts), limites de Definições e registo em activity_logs.
 */
import { AI_ASSISTANT_DEFAULT_LIMITS, type AiAssistantLimits } from "../../shared/appSettings";
import { ROLE_LABELS, type Role } from "../../shared/access";
import { runChatTurn, type ChatTurnResult } from "../_core/ai/chat/engine";
import { helpIndex, parseHelpDoc, type HelpDoc } from "../_core/ai/chat/retrieval";
import { userKey } from "../_core/ai/rateLimit";
import { assistantSystemPrompt } from "../_core/ai/prompts/assistant";
import { HELP_FILES } from "./helpDocs.generated";
import { STAFF_TOOLS, type StaffToolCtx } from "./tools";

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

/** Contexto do turno (fora da cache): data, página, papel, cidades. PURA. */
export function turnContext(p: { today: string; path?: string | null; role: string; cities: string[] | "todas" }): string {
  const wd = WEEKDAYS[new Date(`${p.today}T12:00:00Z`).getUTCDay()];
  return [
    `Hoje: ${p.today} (${wd}, Lisboa).`,
    p.path ? `Página aberta: ${p.path.split("?")[0]}` : null,
    `Papel da pessoa: ${ROLE_LABELS[p.role as Role] ?? p.role}.`,
    `Cidades a que tem acesso: ${p.cities === "todas" ? "todas" : p.cities.join(", ") || "nenhuma"}.`,
  ].filter(Boolean).join("\n");
}

export interface AskInput {
  question: string;
  conversationId?: number | null;
  newConversation?: boolean;
  path?: string | null;
}

/** Um turno do assistente para a pessoa de `toolCtx.user`. Nunca lança. */
export async function askAssistant(
  input: AskInput,
  toolCtx: StaffToolCtx,
  hooks: { logToolCall?: (name: string, args: Record<string, unknown>, conversationId: number | null) => Promise<void> } = {},
): Promise<ChatTurnResult> {
  const limits = await assistantLimits();
  const user = toolCtx.user;
  const cities = toolCtx.access?.all ? "todas" : (toolCtx.access?.cityNames ?? (toolCtx.access?.cityName ? [toolCtx.access.cityName] : []));
  return runChatTurn<StaffToolCtx>({
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
    context: turnContext({ today: toolCtx.today, path: input.path, role: user.role, cities }),
    helpDocs: toolCtx.helpDocs,
    path: input.path,
    tools: STAFF_TOOLS,
    toolCtx,
    onToolCall: async (name, args, conversationId) => {
      await hooks.logToolCall?.(name, args, conversationId);
    },
  });
}
