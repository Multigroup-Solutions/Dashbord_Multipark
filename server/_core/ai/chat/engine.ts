/**
 * Um turno de chat — o núcleo reutilizável (assistente da equipa hoje, chat
 * público do multipark.app depois). Por ordem, do mais barato para o mais caro:
 *
 *   pergunta vazia/longa → interruptor/configuração → limite de pedidos →
 *   conversa + histórico (últimos N turnos + resumo extrativo) → ajuda
 *   relevante (palavras-chave, sem IA) → runAi (prefixo estável em cache de
 *   contexto; ferramentas só de leitura) → guarda pergunta + resposta.
 *
 * Nunca lança: devolve `{ ok: false, reason, message }` com texto PT-PT
 * para mostrar tal e qual (IA desligada, orçamento, muitos pedidos…).
 */
import { isAiError, aiUserMessage } from "../errors";
import { selectProvider } from "../client";
import type { AiFeature } from "../features";
import { redactPii } from "../pii";
import { checkRateLimit, type RateLimitRule } from "../rateLimit";
import { runAi } from "../run";
import { aiFeatureAvailableFresh } from "../status";
import { trimHistory, DEFAULT_MAX_TURNS } from "./history";
import { helpContext, pickHelpDocs, type HelpDoc } from "./retrieval";
import { appendExchange, loadMessages, resolveConversation, type ChatChannel } from "./store";
import { availableTools, makeToolExecutor, toolDeclarations, type ChatTool } from "./tools";
import { appendCitations, type KbCitation } from "../../../../shared/knowledge";

export interface ChatLimits extends RateLimitRule {
  maxInputChars: number;
}

export interface ChatTurnInput<Ctx> {
  feature: AiFeature;
  channel: ChatChannel;
  /** Dono da conversa: "user:<id>" (equipa) ou "ip:<hash>" (público). */
  ownerKey: string;
  userId?: number | null;
  question: string;
  conversationId?: number | null;
  newConversation?: boolean;
  limits: ChatLimits;
  /** Chave do limitador (ex.: "assistant:user:12"). */
  rateKey: string;
  /** Prefixo ESTÁVEL (regras + índice da ajuda) — vai para a cache de contexto. */
  system: string;
  cacheSystem?: boolean;
  /** Contexto deste turno (data, página, papel…) — fora da cache. */
  context?: string;
  helpDocs?: HelpDoc[];
  /**
   * Trechos de uma base de conhecimento para esta pergunta (bloco já pronto e
   * as citações [K1]…). Já filtrados pela visibilidade de quem pergunta; o
   * bloco passa pela mesma redação de dados pessoais que a pergunta.
   */
  knowledge?: (question: string) => Promise<{ block: string; citations: KbCitation[] } | null>;
  path?: string | null;
  tools?: ChatTool<Ctx>[];
  toolCtx?: Ctx;
  /** Auditoria de cada chamada de ferramenta (nome + parâmetros). */
  onToolCall?: (name: string, args: Record<string, unknown>, conversationId: number | null) => Promise<void> | void;
  maxTurns?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export type ChatFailure = "empty" | "too_long" | "disabled" | "not_configured" | "budget" | "rate_limited" | "error";

export type ChatTurnResult =
  | { ok: true; answer: string; conversationId: number | null; toolsUsed: string[]; helpFiles: string[]; citations?: KbCitation[] }
  | { ok: false; reason: ChatFailure; message: string; retryAfterSec?: number; conversationId?: number | null };

export const CHAT_MESSAGES: Record<Exclude<ChatFailure, "too_long" | "rate_limited" | "error">, string> = {
  empty: "Escreve uma pergunta.",
  disabled: "O assistente está desligado de momento. Fala com um administrador se precisares dele.",
  not_configured: "O assistente ainda não está configurado.",
  budget: "O assistente está temporariamente indisponível (limite de gastos do mês atingido). Tenta mais tarde.",
};

/** Separador para redigir histórico + pergunta de uma só vez (marcadores coerentes). */
const SEP = "\n␞\n";

export async function runChatTurn<Ctx>(input: ChatTurnInput<Ctx>): Promise<ChatTurnResult> {
  const question = String(input.question ?? "").trim();
  if (!question) return { ok: false, reason: "empty", message: CHAT_MESSAGES.empty };
  if (question.length > input.limits.maxInputChars) {
    return { ok: false, reason: "too_long", message: `A pergunta é demasiado longa (máximo ${input.limits.maxInputChars} caracteres).` };
  }

  if (!(await aiFeatureAvailableFresh(input.feature))) {
    const reason = selectProvider(process.env, input.feature) ? "disabled" : "not_configured";
    return { ok: false, reason, message: CHAT_MESSAGES[reason] };
  }

  const rl = await checkRateLimit(input.rateKey, { perMinute: input.limits.perMinute, perDay: input.limits.perDay });
  if (!rl.allowed) {
    const when = rl.limitedBy === "day" ? "amanhã" : `daqui a ${rl.retryAfterSec} s`;
    return { ok: false, reason: "rate_limited", retryAfterSec: rl.retryAfterSec, message: `Muitas perguntas seguidas. Tenta outra vez ${when}.` };
  }

  let conversationId: number | null = null;
  try {
    conversationId = await resolveConversation(input.channel, input.ownerKey, {
      userId: input.userId ?? null, conversationId: input.conversationId ?? null, forceNew: input.newConversation,
    });
  } catch { conversationId = null; }
  const stored = conversationId ? await loadMessages(input.channel, input.ownerKey, conversationId, 40).catch(() => []) : [];
  const { turns, summary } = trimHistory(stored, { maxTurns: input.maxTurns ?? DEFAULT_MAX_TURNS });

  const help = input.helpDocs?.length ? pickHelpDocs(input.helpDocs, question, { path: input.path }) : [];
  let kb: { block: string; citations: KbCitation[] } | null = null;
  if (input.knowledge) {
    try { kb = await input.knowledge(question); } catch { kb = null; }
    if (kb && !kb.block.trim()) kb = null;
  }

  // Dados pessoais escritos à mão (emails, telefones, matrículas…) não vão para
  // o fornecedor; a resposta é privada, por isso os marcadores são repostos.
  // O bloco da base de conhecimento vai na mesma redação (marcadores coerentes).
  const red = redactPii([...turns.map((t) => t.text), ...(kb ? [kb.block] : []), question].join(SEP));
  const redParts = red.text.split(SEP);
  const history = turns.map((t, i) => ({ role: t.role, text: redParts[i] ?? t.text }));
  const safeQuestion = redParts[redParts.length - 1] ?? question;
  const safeKnowledge = kb ? redParts[turns.length] ?? "" : "";

  const blocks: string[] = [];
  if (input.context?.trim()) blocks.push(`<contexto>\n${input.context.trim()}\n</contexto>`);
  if (summary) blocks.push(`<resumo>\n${summary}\n</resumo>`);
  if (help.length) blocks.push(helpContext(help));
  if (safeKnowledge) blocks.push(safeKnowledge);
  blocks.push(`<pergunta>\n${safeQuestion}\n</pergunta>`);

  const tools = input.tools && input.toolCtx !== undefined ? availableTools(input.tools, input.toolCtx) : [];
  const used: string[] = [];

  try {
    const r = await runAi({
      feature: input.feature,
      system: input.system,
      cacheSystem: input.cacheSystem ? { ttlSeconds: 3600 } : undefined,
      history,
      input: blocks.join("\n\n"),
      maxTokens: input.maxOutputTokens ?? 700,
      timeoutMs: input.timeoutMs ?? 40_000,
      temperature: 0.2,
      userId: input.userId ?? null,
      entity: "ai_chat_conversation",
      entityId: conversationId,
      ...(tools.length
        ? {
            tools: {
              declarations: toolDeclarations(tools),
              maxRounds: 3,
              execute: makeToolExecutor(tools, input.toolCtx as Ctx, {
                onCall: async (name, args) => {
                  used.push(name);
                  await input.onToolCall?.(name, args, conversationId);
                },
              }),
            },
          }
        : {}),
    });
    const cited = kb ? appendCitations(red.restore(r.output), kb.citations) : null;
    const answer = (cited ? cited.text : red.restore(r.output)).trim();
    if (conversationId) await appendExchange(conversationId, question, answer, { tools: used }).catch(() => undefined);
    return { ok: true, answer, conversationId, toolsUsed: [...new Set(used)], helpFiles: help.map((d) => d.file), ...(cited ? { citations: cited.used } : {}) };
  } catch (err) {
    if (isAiError(err)) {
      if (err.code === "disabled" || err.code === "not_configured" || err.code === "budget") {
        return { ok: false, reason: err.code, message: CHAT_MESSAGES[err.code], conversationId };
      }
      if (err.code === "rate_limited") return { ok: false, reason: "rate_limited", message: aiUserMessage(err), conversationId };
    }
    return { ok: false, reason: "error", message: aiUserMessage(err), conversationId };
  }
}
