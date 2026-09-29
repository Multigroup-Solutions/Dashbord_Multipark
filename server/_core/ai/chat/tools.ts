/**
 * Registo de ferramentas do chat (function calling), independente de quem
 * as usa: o assistente da equipa tem ferramentas de dados (com as permissões
 * de quem pergunta); um chat público teria só ferramentas de FAQ.
 *
 * Regras (as ferramentas são SÓ de leitura):
 *  - `available(ctx)` decide se a ferramenta é sequer declarada ao modelo
 *    (ex.: sem acesso ao Financeiro, o modelo nem sabe que existe);
 *  - `run(args, ctx)` volta a verificar o acesso (nunca confiar no modelo)
 *    e devolve agregados ou listas curtas (máx. MAX_TOOL_ROWS linhas);
 *  - erros de acesso devolvem `{ error }` com texto PT-PT para o modelo
 *    explicar à pessoa; outros erros viram uma mensagem genérica.
 */
import type { AiToolCall, AiToolDeclaration } from "../client";

export const MAX_TOOL_ROWS = 20;

export interface ChatTool<Ctx> {
  name: string;
  description: string;
  /** JSON Schema de objeto (tipos simples: string, integer, boolean, enum). */
  parameters?: Record<string, unknown>;
  available(ctx: Ctx): boolean;
  run(args: Record<string, unknown>, ctx: Ctx): Promise<Record<string, unknown>>;
}

/** Erro que o modelo pode ver (acesso negado, parâmetro inválido…). */
export class ToolUserError extends Error {}

export function availableTools<Ctx>(tools: ChatTool<Ctx>[], ctx: Ctx): ChatTool<Ctx>[] {
  return tools.filter((t) => {
    try { return t.available(ctx); } catch { return false; }
  });
}

export function toolDeclarations<Ctx>(tools: ChatTool<Ctx>[]): AiToolDeclaration[] {
  return tools.map((t) => ({ name: t.name, description: t.description, ...(t.parameters ? { parameters: t.parameters } : {}) }));
}

/** Corta listas longas (e diz quantas havia). PURA. */
export function capRows<T>(rows: T[], max = MAX_TOOL_ROWS): { rows: T[]; total: number; truncated: boolean } {
  return { rows: rows.slice(0, max), total: rows.length, truncated: rows.length > max };
}

/**
 * Executor para o runAi: só corre ferramentas desta lista (o modelo não
 * inventa outras), verifica `available` outra vez e chama `onCall` ANTES de
 * correr (registo de auditoria: nome + parâmetros, nunca resultados).
 */
export function makeToolExecutor<Ctx>(
  tools: ChatTool<Ctx>[],
  ctx: Ctx,
  hooks: { onCall?: (name: string, args: Record<string, unknown>) => Promise<void> | void } = {},
): (call: AiToolCall) => Promise<Record<string, unknown>> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return async (call) => {
    const tool = byName.get(call.name);
    const args = call.args && typeof call.args === "object" ? call.args : {};
    try { await hooks.onCall?.(call.name, args); } catch { /* o registo nunca parte o chat */ }
    if (!tool || !tool.available(ctx)) return { error: "Ferramenta indisponível para esta pessoa." };
    try {
      return await tool.run(args, ctx);
    } catch (err) {
      if (err instanceof ToolUserError) return { error: err.message };
      const code = (err as any)?.code;
      if (code === "FORBIDDEN" || code === "UNAUTHORIZED") return { error: "Sem permissão para ver estes dados." };
      if (code === "BAD_REQUEST") return { error: "Parâmetros inválidos." };
      return { error: "Não foi possível obter estes dados agora." };
    }
  };
}
