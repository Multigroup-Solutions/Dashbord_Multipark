/**
 * 7 out 2026 — "Religar" da conta Google sem motivo (a mesma frase duas vezes)
 * e Reclamações/Perdidos sem agentes da viatura (UNION com colações diferentes).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { googleRevokedReason } from "./google/workspace";

const executed: string[] = [];
const db = {
  execute: vi.fn(async (q: any) => {
    const text = (q?.queryChunks ?? []).map((c: any) => (Array.isArray(c?.value) ? c.value.join("") : typeof c?.value === "string" ? c.value : "")).join("");
    executed.push(text);
    if (/UNION/i.test(text)) throw new Error("Illegal mix of collations for operation 'UNION'");
    if (/FROM employees e WHERE e\.multiparkAgentUserId/.test(text)) return [[{ id: 1, fullName: "Ana Principal", agentUserId: "A1" }]];
    if (/FROM employee_agents a JOIN employees e/.test(text)) return [[{ id: 2, fullName: "Bruno Extra", agentUserId: "A2" }, { id: 9, fullName: "Outro", agentUserId: "A1" }]];
    return [[]];
  }),
};
vi.mock("./db", () => ({ getDb: async () => db }));

describe("conta Google: motivo real da recusa", () => {
  it("invalid_grant explica as causas e leva o texto da Google", () => {
    const why = googleRevokedReason({ response: { data: { error: "invalid_grant", error_description: "Token has been expired or revoked." } } });
    expect(why).toMatch(/revogou o token/);
    expect(why).toMatch(/modo de teste \(7 dias\)/);
    expect(why).toMatch(/Token has been expired or revoked\./);
  });
  it("unauthorized_client = token de outro cliente OAuth", () => {
    expect(googleRevokedReason(new Error("unauthorized_client: Unauthorized"))).toMatch(/outro cliente OAuth/);
  });
  it("invalid_client = cliente apagado ou segredo mudado", () => {
    expect(googleRevokedReason({ response: { data: { error: "invalid_client", error_description: "The OAuth client was not found." } } })).toMatch(/foi apagado ou o segredo mudou/);
  });
  it("nunca deixa passar tokens", () => {
    expect(googleRevokedReason(new Error("invalid_grant ya29.abcDEF 1//refreshXYZ"))).not.toMatch(/abcDEF|refreshXYZ/);
  });
  it("guarda o motivo (não a frase genérica) e escreve no log", () => {
    const src = readFileSync("server/google/userAccounts.ts", "utf8");
    expect(src).toMatch(/const why = googleRevokedReason\(err\);/);
    expect(src).toMatch(/console\.warn\(`\[GoogleAccount\]/);
    expect(src).toMatch(/setGoogleAccountStatus\(userId, "reauth_required", why\)/);
    const card = readFileSync("client/src/components/GoogleAccountCard.tsx", "utf8");
    expect(card).not.toMatch(/A autorização expirou ou foi revogada — o teu email/);
    expect(card).toMatch(/s\?\.lastError \|\| "A autorização expirou ou foi revogada\."/);
  });
});

describe("agentes → fichas sem UNION (colações diferentes)", () => {
  beforeEach(() => { executed.length = 0; });
  it("duas leituras; o agente principal ganha ao extra", async () => {
    const { employeesForAgentIds } = await import("./personIdentity");
    const m = await employeesForAgentIds(["A1", "A2", "A1", ""]);
    expect(executed.some((t) => /UNION/i.test(t))).toBe(false);
    expect(executed).toHaveLength(2);
    expect(m.get("A1")).toEqual({ id: 1, fullName: "Ana Principal" });
    expect(m.get("A2")).toEqual({ id: 2, fullName: "Bruno Extra" });
  });
  it("sem IDs não vai à BD", async () => {
    const { employeesForAgentIds } = await import("./personIdentity");
    expect((await employeesForAgentIds([])).size).toBe(0);
    expect(executed).toHaveLength(0);
  });
  it("a pesquisa de agentes usa a mesma leitura", () => {
    const src = readFileSync("server/personIdentity.ts", "utf8");
    expect(src).not.toMatch(/UNION ALL SELECT e\.id, e\.fullName, a\.agentUserId/);
    expect(src).toMatch(/await employeesForAgentIds\(hits\.map/);
  });
});
