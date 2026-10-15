/**
 * Um turno de chat — o núcleo reutilizável (assistente da equipa hoje, chat
 * público do multipark.app depois). Por ordem, do mais barato para o mais caro:
 *
 *   pergunta vazia/longa → interruptor/configuração → limite de pedidos →
 *   conversa + histórico (últimos N turnos + resumo extrativo) → base de
 *   conhecimento (uma consulta: manuais + ajuda pelo significado) → ajuda
 *   relevante (palavras-chave + significado, máx. 3) → memória (<memoria>)
 *   → runAi (prefixo estável em cache de contexto; ferramentas só de
 *   leitura) → guarda pergunta + resposta (+ ajuda usada e página).
 *
 * Nunca lança: devolve `{ ok: false, reason, message }` com texto PT-PT
 * para mostrar tal e qual (IA desligada, orçamento, muitos pedidos…).
 *
 * Dados pessoais (plano MPV §3.7, F0b): UM contexto de redação por turno —
 * histórico, conhecimento, memória, pergunta E os resultados das ferramentas
 * (campos `pii` de cada uma) partilham a numeração dos marcadores; a resposta
 * é reposta UMA vez, no fim, com tudo. A resposta guarda-se também com os
 * nomes dos colegas como [NOME_n] (+ o mapa, migração 0695) e é ESSA versão
 * que volta no histórico, com os marcadores renumerados neste contexto — os
 * nomes completos nunca voltam ao fornecedor. BD antes da 0695: as
 * ferramentas mandam só o 1.º nome dos colegas.
 */
import { AiBudgetExceededError, isAiError, aiUserMessage } from "../errors";
import { selectProvider } from "../client";
import type { AiFeature } from "../features";
import { createRedactionContext } from "../pii";
import { checkRateLimit, type RateLimitRule } from "../rateLimit";
import { runAi } from "../run";
import { aiFeatureAvailableFresh } from "../status";
import { trimHistory, DEFAULT_MAX_TURNS } from "./history";
import { combineHelpDocs, helpContext, helpHints, pickHelpDocs, type HelpDoc, type HelpHit } from "./retrieval";
import { appendExchange, loadMessages, maskedHistoryAvailable, resolveConversation, type ChatChannel } from "./store";
import { availableTools, makeToolExecutor, toolDeclarations, type ChatTool } from "./tools";
import { appendCitations, type KbCitation } from "../../../../shared/knowledge";
import type { ToolErrorNote } from "../../../../shared/assistantFeedback";

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
   * `helpHits`: os trechos da AJUDA que a mesma consulta achou pelo
   * significado — juntam-se aos ficheiros das palavras-chave (máx. 3).
   */
  knowledge?: (question: string) => Promise<ChatKnowledge | null>;
  /**
   * Bloco <memoria> deste turno (notas guardadas, Multis 2) — vai no contexto
   * (fora da cache) e passa pela mesma redação de dados pessoais.
   */
  memory?: string;
  path?: string | null;
  /**
   * Plano MPV (F3): o bloco POR PERGUNTA já pronto (perfil da página + as
   * secções da ajuda) e os ids das secções (`refs`, guardados como os
   * ficheiros da ajuda). Vai fora da cache, na MESMA redação que a pergunta,
   * e substitui o <ajuda> das palavras-chave (`helpDocs` fica sem efeito).
   * F5: pode ser uma função (calcula-se depois do limite de pedidos, em
   * paralelo com `knowledge`); uma falha → sem bloco.
   */
  pageKnowledge?: { block: string; refs: string[] } | (() => Promise<{ block: string; refs: string[] } | null>);
  tools?: ChatTool<Ctx>[];
  /**
   * Plano MPV §3.7/§5.4: declara TODAS as ferramentas (a mesma lista para toda
   * a gente → uma cache por modelo); o acesso é verificado ao executar (a
   * chamada recusada devolve "indisponível"). Omisso: só as que a pessoa pode
   * usar (como sempre).
   */
  declareAllTools?: boolean;
  toolCtx?: Ctx;
  /** MPV: uma chamada recusada (ferramenta declarada sem acesso) — registo à parte. */
  onToolRefused?: (name: string, args: Record<string, unknown>, conversationId: number | null) => Promise<void> | void;
  /**
   * Prazo ABSOLUTO do turno (instante em ms) — p. ex. na descida smart → lite,
   * contado desde o início do pedido. Vale o mais cedo entre este e `timeoutMs`.
   */
  deadlineMs?: number;
  /** Auditoria de cada chamada de ferramenta (nome + parâmetros). */
  onToolCall?: (name: string, args: Record<string, unknown>, conversationId: number | null) => Promise<void> | void;
  maxTurns?: number;
  /**
   * Teto de saída BASE (omissão 700): sobe ao mínimo do nível de raciocínio
   * (maxTokensFor — com "low" no lite fica 900), porque o raciocínio gasta do
   * mesmo teto que a resposta.
   */
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** Máximo de voltas com ferramentas (omissão 3; MPV-Argon 4 — plano §3.6). */
  maxToolRounds?: number;
  /**
   * Tempo guardado para a chamada final sem ferramentas (omisso = o do runAi,
   * 8 s). As voltas com ferramentas param quando sobra menos (plano §3.6).
   */
  finalReserveMs?: number;
  /** Versão do chamador (registo + resposta guardada), ex.: "v1". */
  variant?: string;
}

export type ChatFailure = "empty" | "too_long" | "disabled" | "not_configured" | "budget" | "rate_limited" | "error";

export interface ChatKnowledge {
  block: string;
  citations: KbCitation[];
  helpHits?: HelpHit[];
}

export type ChatTurnResult =
  | {
      ok: true;
      answer: string;
      conversationId: number | null;
      /** Id da resposta guardada (ai_chat_messages) — para o 👍/👎; null sem BD. */
      messageId: number | null;
      toolsUsed: string[];
      helpFiles: string[];
      /** Ferramentas que devolveram `{ error }` neste turno. */
      toolErrors: ToolErrorNote[];
      /** MPV: chamadas recusadas (sem acesso) — à parte das usadas e dos erros. */
      toolsRefused?: string[];
      citations?: KbCitation[];
      /** Turno do "Lembra-te" (sem IA): o que aconteceu à nota. */
      memory?: "saved" | "exists" | "rejected";
      /** Nível do modelo que respondeu (lite/fast/smart); ausente sem IA. */
      tier?: string;
    }
  | {
      ok: false; reason: ChatFailure; message: string; retryAfterSec?: number; conversationId?: number | null;
      /** reason "budget": o orçamento global ou o teto próprio da funcionalidade (plano MPV §5.3). */
      budgetScope?: "global" | "own";
      /** Teto próprio: qual (day | month | user_day | unknown). */
      budgetReason?: string | null;
    };

export const CHAT_MESSAGES: Record<Exclude<ChatFailure, "too_long" | "rate_limited" | "error">, string> = {
  empty: "Escreve uma pergunta.",
  disabled: "O Multis está desligado de momento. Fala com um administrador se precisares dele.",
  not_configured: "O Multis ainda não está configurado.",
  budget: "O Multis está temporariamente indisponível (limite de gastos do mês atingido). Tenta mais tarde.",
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
  // Um só contexto de redação no turno (histórico, pergunta e ferramentas continuam a numeração).
  const red = createRedactionContext();
  // Respostas anteriores: a versão com marcadores dos colegas, renumerados neste contexto.
  const storedSafe = stored.map((m) => (m.role === "assistant" && m.masked ? { ...m, content: red.adoptNames(m.masked.content, m.masked.names) } : m));
  const { turns, summary } = trimHistory(storedSafe, { maxTurns: input.maxTurns ?? DEFAULT_MAX_TURNS });
  // Sem onde guardar a versão com marcadores (BD antes da 0695) → colegas só pelo 1.º nome.
  const maskPeople = maskedHistoryAvailable();

  // Base de conhecimento (uma só consulta: manuais + ajuda pelo significado). MPV (F5):
  // o bloco da página pode vir por calcular — corre AQUI (depois do limite de pedidos) e
  // EM PARALELO com a base (as duas partes vetoriais ao mesmo tempo).
  let kb: ChatKnowledge | null = null;
  const pkInput = input.pageKnowledge;
  const pkPromise = typeof pkInput === "function"
    ? Promise.resolve().then(() => pkInput()).catch(() => null)
    : null;
  if (input.knowledge) {
    try { kb = await input.knowledge(question); } catch { kb = null; }
  }
  const pkResolved = pkPromise ? await pkPromise : (pkInput as { block: string; refs: string[] } | undefined);
  const helpHits = kb?.helpHits ?? [];
  if (kb && !kb.block.trim()) kb = null;
  const pageKnowledge = pkResolved?.block.trim() ? pkResolved : null;
  const useHelpDocs = !pageKnowledge && !!input.helpDocs?.length;
  const keywordHelp = useHelpDocs ? pickHelpDocs(input.helpDocs!, question, { path: input.path }) : [];
  const help = useHelpDocs ? combineHelpDocs(input.helpDocs!, keywordHelp, helpHits, { question }) : [];

  // Dados pessoais escritos à mão (emails, telefones, matrículas…) não vão para
  // o fornecedor; a resposta é privada, por isso os marcadores são repostos.
  // O bloco da base de conhecimento e a memória vão na mesma redação
  // (marcadores coerentes).
  const memory = input.memory?.trim() ? input.memory.trim() : "";
  const parts = turns.map((t) => t.text);
  const kbAt = kb ? parts.push(kb.block) - 1 : -1;
  const memAt = memory ? parts.push(memory) - 1 : -1;
  const sumAt = summary ? parts.push(summary) - 1 : -1;
  const pageAt = pageKnowledge ? parts.push(pageKnowledge.block.trim()) - 1 : -1;
  parts.push(question);
  const redParts = red.text(parts.join(SEP)).split(SEP);
  const history = turns.map((t, i) => ({ role: t.role, text: redParts[i] ?? t.text }));
  const safeQuestion = redParts[redParts.length - 1] ?? question;
  const safeKnowledge = kbAt >= 0 ? redParts[kbAt] ?? "" : "";
  const safeMemory = memAt >= 0 ? redParts[memAt] ?? "" : "";
  const safeSummary = sumAt >= 0 ? redParts[sumAt] ?? "" : "";
  const safePage = pageAt >= 0 ? redParts[pageAt] ?? "" : "";

  const blocks: string[] = [];
  if (input.context?.trim()) blocks.push(`<contexto>\n${input.context.trim()}\n</contexto>`);
  if (safeMemory) blocks.push(safeMemory);
  if (safeSummary) blocks.push(`<resumo>\n${safeSummary}\n</resumo>`);
  if (safePage) blocks.push(safePage);
  if (help.length) blocks.push(helpContext(help, undefined, { question, hints: helpHints(helpHits) }));
  if (safeKnowledge) blocks.push(safeKnowledge);
  blocks.push(`<pergunta>\n${safeQuestion}\n</pergunta>`);

  const tools = input.tools && input.toolCtx !== undefined ? (input.declareAllTools ? input.tools : availableTools(input.tools, input.toolCtx)) : [];
  const used: string[] = [];
  const toolErrors: ToolErrorNote[] = [];
  const refused: string[] = [];

  try {
    const r = await runAi({
      feature: input.feature,
      system: input.system,
      cacheSystem: input.cacheSystem ? { ttlSeconds: 3600 } : undefined,
      history,
      input: blocks.join("\n\n"),
      maxTokens: input.maxOutputTokens ?? 700,
      scaleMaxTokensForThinking: true,
      timeoutMs: input.timeoutMs ?? 40_000,
      ...(input.finalReserveMs != null ? { finalReserveMs: input.finalReserveMs } : {}),
      ...(input.deadlineMs != null ? { deadlineMs: input.deadlineMs } : {}),
      variant: input.variant ?? null,
      temperature: 0.2,
      userId: input.userId ?? null,
      entity: "ai_chat_conversation",
      entityId: conversationId,
      ...(tools.length
        ? {
            tools: {
              declarations: toolDeclarations(tools),
              maxRounds: input.maxToolRounds ?? 3,
              execute: makeToolExecutor(tools, input.toolCtx as Ctx, {
                onCall: async (name, args) => {
                  used.push(name);
                  await input.onToolCall?.(name, args, conversationId);
                },
                onError: (name, error) => { toolErrors.push({ tool: name, error: error.slice(0, 200) }); },
                onRefused: async (name, args) => {
                  refused.push(name);
                  await input.onToolRefused?.(name, args, conversationId);
                },
              }, { redact: red, maskPeople, ...(input.declareAllTools ? { refuseUnavailable: true } : {}) }),
            },
          }
        : {}),
    });
    // Restauro UMA vez, no fim (pergunta, conhecimento e ferramentas).
    const restored = red.restore(r.output);
    const cited = kb ? appendCitations(restored, kb.citations) : null;
    const answer = (cited ? cited.text : restored).trim();
    // Para o histórico: a mesma resposta com os colegas ainda como [NOME_n] (+ o mapa).
    const forStorage = red.maskForStorage(r.output);
    const maskedContent = (kb ? appendCitations(forStorage.content, kb.citations).text : forStorage.content).trim();
    const helpFiles = pageKnowledge ? [...pageKnowledge.refs] : help.map((d) => d.file);
    let messageId: number | null = null;
    if (conversationId) {
      const saved = await appendExchange(conversationId, question, answer, { tools: used, helpFiles, path: input.path, variant: input.variant ?? null, tier: r.tier, masked: { content: maskedContent, names: forStorage.names } }).catch(() => null);
      messageId = saved?.answerId ?? null;
    }
    return {
      ok: true, answer, conversationId, messageId, toolsUsed: [...new Set(used)], helpFiles, toolErrors, tier: r.tier,
      ...(cited ? { citations: cited.used } : {}), ...(refused.length ? { toolsRefused: [...new Set(refused)] } : {}),
    };
  } catch (err) {
    if (isAiError(err)) {
      if (err.code === "budget") {
        return { ok: false, reason: "budget", message: CHAT_MESSAGES.budget, conversationId, budgetScope: err instanceof AiBudgetExceededError ? err.scope : "global", budgetReason: err instanceof AiBudgetExceededError ? err.ownReason : null };
      }
      if (err.code === "disabled" || err.code === "not_configured") {
        return { ok: false, reason: err.code, message: CHAT_MESSAGES[err.code], conversationId };
      }
      if (err.code === "rate_limited") return { ok: false, reason: "rate_limited", message: aiUserMessage(err), conversationId };
    }
    return { ok: false, reason: "error", message: aiUserMessage(err), conversationId };
  }
}
