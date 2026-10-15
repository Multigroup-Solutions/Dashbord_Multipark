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
 *    explicar à pessoa; outros erros viram uma mensagem genérica;
 *  - dados pessoais nos RESULTADOS (plano MPV §3.7, F0b): cada ferramenta
 *    declara os seus campos (`pii`) e o executor passa-os pelo contexto de
 *    redação ÚNICO do turno (o mesmo da pergunta; numeração contínua; repõe-se
 *    uma vez no fim): colaboradores → [NOME_n] (repostos), clientes → só o
 *    1.º nome, texto livre → emails/telefones/IBAN/NIF/matrículas tapados.
 */
import type { AiToolCall, AiToolDeclaration } from "../client";
import { firstName, type RedactionContext } from "../pii";

export const MAX_TOOL_ROWS = 20;

/**
 * Campos com dados pessoais no resultado de uma ferramenta (pelo NOME da
 * chave, em qualquer nível do objeto/listas).
 */
export interface ToolPiiFields {
  /** Nome completo de colaboradores → [NOME_n] (reposto na resposta). */
  people?: readonly string[];
  /** Nome de clientes/avaliadores → só o 1.º nome (não se repõe). */
  clients?: readonly string[];
  /** Texto livre (títulos, notas, críticas) → redação de emails, telefones, IBAN, NIF, matrículas. */
  text?: readonly string[];
}

export interface ChatTool<Ctx> {
  name: string;
  description: string;
  /** JSON Schema de objeto (tipos simples: string, integer, boolean, enum). */
  parameters?: Record<string, unknown>;
  available(ctx: Ctx): boolean;
  /**
   * `extra.redact`: o contexto de redação do turno (para quem precise de o usar à mão);
   * `extra.maskPeople`: a mesma opção do executor (false → colegas só pelo 1.º nome).
   */
  run(args: Record<string, unknown>, ctx: Ctx, extra?: { redact?: RedactionContext; maskPeople?: boolean }): Promise<Record<string, unknown>>;
  /** Campos com dados pessoais no resultado (ver ToolPiiFields). */
  pii?: ToolPiiFields;
  /**
   * A ferramenta já passa os seus campos `pii` pela redação do turno (com
   * `extra.redact`/`extra.maskPeople`) ANTES de cortar textos ou listas — o
   * executor não volta a redigir (um corte antes da redação deixava escapar
   * "joao@gmail.c…"). Plano MPV F4.
   */
  selfRedacts?: boolean;
}

/**
 * Resposta a uma ferramenta declarada que a pessoa não pode usar (MPV:
 * declaram-se todas; plano §3.7). O texto diz "Sem acesso", como a regra do
 * sistema do MPV.
 */
export const TOOL_REFUSED_ERROR = "Sem acesso: esta ferramenta não está nas permissões desta pessoa.";

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
 * Passa os campos declarados de um resultado pelo contexto de redação (em
 * qualquer nível; listas incluídas). Sem campos ou sem contexto → igual. PURA
 * (muda só o contexto).
 */
export function redactToolResult(
  result: Record<string, unknown>, fields: ToolPiiFields | undefined, redact: RedactionContext | undefined,
  opts: { maskPeople?: boolean } = {},
): Record<string, unknown> {
  if (!fields) return result;
  // Sem contexto de redação (ou sem onde guardar a versão com marcadores), os colegas vão só pelo 1.º nome.
  const maskPeople = !!redact && opts.maskPeople !== false;
  const people = new Set(fields.people ?? []);
  const clients = new Set(fields.clients ?? []);
  const text = new Set(fields.text ?? []);
  if (!people.size && !clients.size && !text.size) return result;
  const walk = (v: unknown, key: string | null, depth: number): unknown => {
    if (depth > 8) return v;
    if (typeof v === "string" && key != null) {
      if (people.has(key)) return maskPeople ? (redact!.person(v) ?? v) : firstName(v, "");
      if (clients.has(key)) return firstName(v, "");
      if (text.has(key)) return redact ? redact.text(v) : v;
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key, depth + 1));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, k, depth + 1);
      return out;
    }
    return v;
  };
  return walk(result, null, 0) as Record<string, unknown>;
}

/**
 * Executor para o runAi: só corre ferramentas desta lista (o modelo não
 * inventa outras), verifica `available` outra vez e chama `onCall` ANTES de
 * correr (registo de auditoria: nome + parâmetros, nunca resultados).
 * `onError` recebe o texto de cada `{ error }` devolvido (Multis 2: a resposta
 * fica marcada em "Perguntas que falharam"). `opts.redact`: o contexto de
 * redação do turno — os campos `pii` de cada ferramenta passam por ele.
 */
export function makeToolExecutor<Ctx>(
  tools: ChatTool<Ctx>[],
  ctx: Ctx,
  hooks: {
    onCall?: (name: string, args: Record<string, unknown>) => Promise<void> | void;
    onError?: (name: string, error: string) => void;
    /** Com `refuseUnavailable`: uma chamada recusada (sem acesso) — não passa por onCall nem onError. */
    onRefused?: (name: string, args: Record<string, unknown>) => Promise<void> | void;
  } = {},
  opts: {
    redact?: RedactionContext; maskPeople?: boolean;
    /**
     * MPV (todas declaradas): uma ferramenta conhecida que a pessoa não pode
     * usar é RECUSADA à parte (TOOL_REFUSED_ERROR; não conta como usada nem
     * como erro). Omisso: como sempre.
     */
    refuseUnavailable?: boolean;
  } = {},
): (call: AiToolCall) => Promise<Record<string, unknown>> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const run = async (call: AiToolCall, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const tool = byName.get(call.name);
    if (!tool || !tool.available(ctx)) return { error: "Ferramenta indisponível para esta pessoa." };
    try {
      const result = await tool.run(args, ctx, { redact: opts.redact, maskPeople: opts.maskPeople });
      return tool.selfRedacts ? result : redactToolResult(result, tool.pii, opts.redact, { maskPeople: opts.maskPeople });
    } catch (err) {
      if (err instanceof ToolUserError) return { error: err.message };
      const code = (err as any)?.code;
      if (code === "FORBIDDEN" || code === "UNAUTHORIZED") return { error: "Sem permissão para ver estes dados." };
      if (code === "BAD_REQUEST") return { error: "Parâmetros inválidos." };
      return { error: "Não foi possível obter estes dados agora." };
    }
  };
  return async (call) => {
    const args = call.args && typeof call.args === "object" ? call.args : {};
    if (opts.refuseUnavailable) {
      const tool = byName.get(call.name);
      let ok = false;
      try { ok = !!tool && tool.available(ctx); } catch { ok = false; }
      if (tool && !ok) {
        try { await hooks.onRefused?.(call.name, args); } catch { /* idem */ }
        return { error: TOOL_REFUSED_ERROR };
      }
    }
    try { await hooks.onCall?.(call.name, args); } catch { /* o registo nunca parte o chat */ }
    const result = await run(call, args);
    if (typeof result?.error === "string") {
      try { hooks.onError?.(call.name, result.error); } catch { /* idem */ }
    }
    return result;
  };
}
