/**
 * Registo dos 500 do tRPC (complaints.vehicleAgents dava 500 sem nada no log):
 * só INTERNAL_SERVER_ERROR, com o caminho, o código e a causa — nunca o input,
 * dados pessoais, segredos nem o stack inteiro em produção.
 */
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import express from "express";
import { initTRPC, TRPCError } from "@trpc/server";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { describeTrpcServerError, logTrpcServerError, safeErrorText, stackFunctions } from "./trpcErrorLog";

const STACK = [
  "Error: could not resize shared memory segment [53100]",
  "    at wrapDriverError (file:///var/task/api/index.js:100:10)",
  "    at withReadOnly (file:///var/task/api/index.js:200:11)",
  "    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
  "    at async Object.query [as query] (file:///var/task/api/index.js:300:12)",
  "    at async readLiveHistory (file:///var/task/api/index.js:400:13)",
  "    at async getVehicleAgentsByPlate (file:///var/task/api/index.js:500:14)",
  "    at async PromisePool.query (file:///var/task/node_modules/mysql2/lib/promise/pool.js:36:22)",
].join("\n");

/** O que o tRPC faz a um erro qualquer lançado num procedimento. */
function internal(cause: Error): TRPCError {
  const e = new TRPCError({ code: "INTERNAL_SERVER_ERROR", cause });
  e.stack = cause.stack;
  return e;
}

afterEach(() => vi.restoreAllMocks());

describe("registo dos 500 do tRPC", () => {
  it("só INTERNAL_SERVER_ERROR: os erros esperados não se registam", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const code of ["FORBIDDEN", "NOT_FOUND", "BAD_REQUEST", "UNAUTHORIZED"] as const) {
      logTrpcServerError({ error: new TRPCError({ code, message: "esperado" }), path: "complaints.getById", type: "query" });
    }
    expect(spy).not.toHaveBeenCalled();
    logTrpcServerError({ error: internal(new Error("BD indisponível")), path: "complaints.vehicleAgents", type: "query" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain("[tRPC 500] complaints.vehicleAgents (query) INTERNAL_SERVER_ERROR");
    expect(String(spy.mock.calls[0][0])).toContain("Error: BD indisponível");
  });

  it("causa com o código do driver; a mensagem do drizzle perde os params (dados pessoais)", () => {
    const driver = Object.assign(new Error("Illegal mix of collations (utf8mb4_0900_ai_ci,IMPLICIT) and (utf8mb4_unicode_ci,IMPLICIT) for operation 'UNION'"), { code: "ER_CANT_AGGREGATE_2COLLATIONS", errno: 1267, sqlState: "HY000" });
    const drizzle = Object.assign(new Error("Failed query: SELECT e.id FROM employees e WHERE e.email = ?\nparams: cliente@exemplo.pt,912345678", { cause: driver }), { name: "DrizzleQueryError" });
    const { line } = describeTrpcServerError({ error: internal(drizzle), path: "complaints.vehicleAgents", type: "query" }, true);
    expect(line).toContain("DrizzleQueryError: Failed query: SELECT e.id FROM employees e WHERE e.email = ?");
    expect(line).toContain("causa: Error [ER_CANT_AGGREGATE_2COLLATIONS, errno 1267, sqlState HY000]: Illegal mix of collations");
    expect(line).not.toMatch(/params|cliente@exemplo\.pt|912345678/);
  });

  it("máscara: emails, telefones, matrículas, valores ecoados pelo MySQL e credenciais", () => {
    const t = safeErrorText("Duplicate entry 'João Silva' for key 'employees.fullName' · Truncated incorrect DOUBLE value: 'abc' · ana@exemplo.pt · +351 912 345 678 · AA-00-BB · postgres://utilizador:segredo@bd.exemplo.pt:5432/multipark");
    expect(t).not.toMatch(/João Silva|'abc'|ana@exemplo\.pt|912 345 678|AA-00-BB|segredo|utilizador/);
    expect(t).toContain("Duplicate entry '***' for key 'employees.fullName'");
    expect(t).toContain("value: '***'");
  });

  it("em produção: sem stack, só os nomes das funções onde rebentou", () => {
    const cause = Object.assign(new Error("could not resize shared memory segment [53100]"), { name: "MultiparkDbError", code: "QUERY_FAILED", stack: STACK });
    const prod = describeTrpcServerError({ error: internal(cause), path: "complaints.vehicleAgents", type: "query" }, true);
    expect(prod.stack).toBeUndefined();
    expect(prod.line).toContain("MultiparkDbError [QUERY_FAILED]: could not resize shared memory segment [53100]");
    expect(prod.line).toContain("em: wrapDriverError ← withReadOnly ← Object.query ← readLiveHistory ← getVehicleAgentsByPlate");
    expect(prod.line).not.toMatch(/\bat |index\.js|node_modules|node:internal/);
    const dev = describeTrpcServerError({ error: internal(cause), path: "complaints.vehicleAgents", type: "query" }, false);
    expect(dev.stack).toBe(STACK);
  });

  it("nomes das funções: sem node_modules, node:internal nem anónimas", () => {
    expect(stackFunctions(STACK)).toEqual(["wrapDriverError", "withReadOnly", "Object.query", "readLiveHistory", "getVehicleAgentsByPlate"]);
    expect(stackFunctions("Error: x\n    at file:///var/task/api/index.js:1:2\n    at new MultiparkDbError (file:///var/task/api/index.js:9:9)")).toEqual(["MultiparkDbError"]);
    expect(stackFunctions("Error: x\n    at <anonymous> (file:///tmp/a.mts:3:9)\n    at async Promise.all (index 0)\n    at async loadPeople (file:///var/task/api/index.js:7:7)")).toEqual(["loadPeople"]);
    expect(stackFunctions(undefined)).toEqual([]);
  });

  it("no servidor tRPC (batch): o 500 regista caminho e causa, o FORBIDDEN não, e o input nunca", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = initTRPC.create();
    const router = t.router({
      complaints: t.router({
        vehicleAgents: t.procedure.input(z.object({ plate: z.string(), email: z.string() })).query(() => {
          throw new Error("could not resize shared memory segment [53100]");
        }),
        getById: t.procedure.query(() => { throw new TRPCError({ code: "FORBIDDEN", message: "Sem acesso" }); }),
      }),
    });
    const app = express();
    app.use("/api/trpc", createExpressMiddleware({ router, onError: logTrpcServerError }));
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const input = encodeURIComponent(JSON.stringify({ 0: { plate: "AA-00-BB", email: "cliente@exemplo.pt" } }));
      const res = await fetch(`http://127.0.0.1:${port}/api/trpc/complaints.vehicleAgents,complaints.getById?batch=1&input=${input}`);
      expect(res.status).toBe(207);
    } finally {
      await new Promise((r) => server.close(r));
    }
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = spy.mock.calls[0].map(String).join(" ");
    expect(logged).toContain("[tRPC 500] complaints.vehicleAgents (query) INTERNAL_SERVER_ERROR");
    expect(logged).toContain("could not resize shared memory segment [53100]");
    expect(logged).not.toMatch(/AA-00-BB|cliente@exemplo\.pt/);
  });

  it("os dois servidores (Vercel e Railway) ligam o registo ao tRPC", () => {
    for (const f of ["./api-entry.ts", "./index.ts"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      expect(src).toMatch(/createExpressMiddleware\(\{[^}]*onError: logTrpcServerError/);
    }
  });
});
