/**
 * Só para testes: BD falsa que regista cada statement (SQL + parâmetros) e
 * responde por padrão, e um fornecedor falso com respostas em fila.
 */
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { AiProvider, ProviderRequest, ProviderResponse } from "./client";

const dialect = new MySqlDialect();

export interface FakeQuery { sql: string; params: unknown[] }

export function createFakeDb(respond: (q: FakeQuery) => unknown = () => [[]]) {
  const queries: FakeQuery[] = [];
  return {
    queries,
    execute: async (q: any) => {
      const compiled = typeof q?.getSQL === "function" || q?.queryChunks ? dialect.sqlToQuery(q) : { sql: String(q), params: [] };
      const entry = { sql: compiled.sql.replace(/\s+/g, " ").trim(), params: compiled.params as unknown[] };
      queries.push(entry);
      return respond(entry);
    },
  };
}

type Step = ProviderResponse | Error | ((req: ProviderRequest) => Promise<ProviderResponse>);

export function createFakeProvider(id: "gemini" | "legacy", steps: Step[]) {
  const calls: ProviderRequest[] = [];
  const provider: AiProvider & { calls: ProviderRequest[] } = {
    id,
    calls,
    async generate(req) {
      calls.push(req);
      const step = steps.length > 1 ? steps.shift()! : steps[0];
      if (step instanceof Error) throw step;
      if (typeof step === "function") return step(req);
      return step;
    },
  };
  return provider;
}

export function okResponse(text: string, model = "gemini-3.1-flash-lite"): ProviderResponse {
  return { text, model, finishReason: "STOP", usage: { inputTokens: 1000, outputTokens: 200, cachedTokens: 0 } };
}

export function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}
