/**
 * `formacao_procurar` — D7 (Jorge, 16 out 2026): o Multis é o tutor da página
 * Formação. A ferramenta faz o que o tutor próprio fazia antes de responder:
 * procura nos manuais e vídeos da formação (o módulo aberto primeiro, depois
 * o catálogo) e na base de conhecimento quando "Tutor da formação usa a base"
 * está ligado — com as MESMAS regras e a MESMA visibilidade (procedimento
 * `training.tutor.search`, chamado COMO quem pergunta).
 *
 * Só no MPV (entra em MPV_STAFF_TOOLS; o v1 não muda — testes de hash). Só
 * leitura e sem IA (nem o vetor da pergunta). Textos livres passam pela
 * redação do turno ANTES de serem cortados (dataTool).
 */
import { can } from "../../shared/access";
import { TUTOR_SEARCH_MAX_CHARS, type TutorContext } from "../../shared/trainingTutor";
import { ToolUserError, type ChatTool } from "../_core/ai/chat/tools";
import { dataTool } from "./mpvDataTools";
import type { StaffToolCtx } from "./tools";

export const FORMACAO_SEARCH_TOOL_NAME = "formacao_procurar" as const;

/** Tamanho de cada trecho devolvido ao modelo (o tutor usava trechos até 1 500). */
export const FORMACAO_SEARCH_TEXT_MAX = 900;

const MODULE_TYPES: Record<string, TutorContext["type"]> = { manual: "manual", video: "video", percurso: "path" };

/** Os argumentos do modelo → o pedido ao procedimento. PURA (lança ToolUserError). */
export function formacaoSearchInput(args: Record<string, unknown>): { question: string; context?: TutorContext } {
  const question = String(args.texto ?? "").trim();
  if (question.length < 2) throw new ToolUserError("Diz o que procurar (texto).");
  const tipo = args.tipo == null ? "" : String(args.tipo).trim().toLowerCase();
  const id = Number(args.id);
  const type = MODULE_TYPES[tipo];
  const context = type && Number.isSafeInteger(id) && id > 0 ? { type, id } : undefined;
  return { question: question.slice(0, TUTOR_SEARCH_MAX_CHARS), ...(context ? { context } : {}) };
}

const KIND_LABEL: Record<string, string> = { manual: "manual", video: "vídeo", outro: "percurso" };

async function formacaoProcurar(args: Record<string, unknown>, ctx: StaffToolCtx): Promise<Record<string, unknown>> {
  const input = formacaoSearchInput(args);
  let r: any;
  try {
    r = await ctx.call("training.tutor.search", input);
  } catch {
    return { indisponivel: "Não consegui consultar os manuais da formação agora: diz isso e que tente de novo daqui a pouco (não digas que os manuais não falam disso)." };
  }
  if (r?.failed) return { indisponivel: "Não consegui consultar os manuais da formação agora: diz isso e que tente de novo daqui a pouco (não digas que os manuais não falam disso)." };
  const trechos = ((r?.hits ?? []) as any[]).map((h) => ({
    fonte: KIND_LABEL[h.kind] ?? "manual",
    titulo: String(h.title ?? ""),
    secao: h.heading && h.heading !== h.title ? String(h.heading) : null,
    texto: String(h.text ?? ""),
    ...(h.href ? { ligacao: String(h.href) } : {}),
  }));
  const base = ((r?.kb ?? []) as any[]).map((h) => ({
    titulo: String(h.title ?? ""),
    secao: h.section && h.section !== h.title ? String(h.section) : null,
    texto: String(h.text ?? ""),
    ...(h.href ? { ligacao: String(h.href) } : {}),
  }));
  return {
    procurado: input.question,
    ...(r?.moduleTitle ? { moduloAberto: String(r.moduleTitle) } : {}),
    trechos,
    baseDeConhecimento: base,
    nota: trechos.length || base.length
      ? "Responde só com estes trechos e diz de que manual ou vídeo vem cada parte. Não dês as respostas dos quizzes nem dos exames."
      : "Não encontrei nos manuais nem nos vídeos da formação: diz isso e sugere perguntar ao formador (nunca inventes procedimentos).",
  };
}

export const FORMACAO_SEARCH_TOOL: ChatTool<StaffToolCtx> = dataTool({
  name: FORMACAO_SEARCH_TOOL_NAME,
  description: "Procura nos manuais e vídeos da Formação (e na base de conhecimento, se estiver ligada para o tutor) os trechos sobre um tema, com o título do manual/vídeo, a secção e a ligação para o abrir. Com tipo e id (o manual, vídeo ou percurso aberto, que vem no contexto), procura primeiro nesse. Só o que a pessoa pode ver.",
  parameters: {
    type: "object",
    properties: {
      texto: { type: "string", description: "O que procurar (ex.: \"entregar as chaves ao cliente\")." },
      tipo: { type: "string", enum: ["manual", "video", "percurso"], description: "Tipo do módulo aberto (opcional)." },
      id: { type: "integer", description: "Id do módulo aberto (opcional; ex.: o de \"Registo aberto: training_manual #12\")." },
    },
    required: ["texto"],
  },
  available: (ctx) => can(ctx.user, "formacao", "view"),
  // Conteúdos da formação: texto livre (podem trazer emails/telefones de exemplo) → redação antes do corte.
  pii: { text: ["titulo", "secao", "texto", "moduloAberto", "procurado"] },
  textMax: { texto: FORMACAO_SEARCH_TEXT_MAX, titulo: 160, secao: 160 },
  protect: ["trechos"],
  impl: formacaoProcurar,
});
