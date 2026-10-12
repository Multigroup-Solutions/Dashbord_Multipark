import { describe, expect, it } from "vitest";
import { actionAllowed, matchesSearch, procedureAllowed, resolveOwnerId, resultJson, reviveIsoDates, MAX_RESULT_BYTES, MCP_ACTIONS } from "./mcpProceduresApi";
import { capabilitiesFor, capabilitiesLabel, normalizeCapabilities } from "../shared/apiKeyCapabilities";
import { v1Allowed } from "./apiKeyAuth";

describe("MCP pessoal: que procedimentos passam", () => {
  it("só queries; alterações e subscrições ficam de fora", () => {
    expect(procedureAllowed("rh.list", "query")).toEqual({ ok: true });
    expect(procedureAllowed("rh.update", "mutation")).toMatchObject({ ok: false, status: 403 });
    expect(procedureAllowed("whatsapp.stream", "subscription")).toMatchObject({ ok: false, status: 403 });
  });
  it("desconhecido → 404", () => {
    expect(procedureAllowed("nao.existe", undefined)).toMatchObject({ ok: false, status: 404 });
  });
  it("chaves de API e tokens nunca saem, mesmo sendo queries", () => {
    expect(procedureAllowed("apiKeys.list", "query")).toMatchObject({ ok: false, status: 403 });
    expect(procedureAllowed("googleDrive.pickerToken", "query")).toMatchObject({ ok: false, status: 403 });
    expect(procedureAllowed("integrations.refreshToken", "query")).toMatchObject({ ok: false, status: 403 });
  });
});

describe("MCP pessoal: que alterações passam", () => {
  it("só as da lista, e só mutations", () => {
    expect(actionAllowed("tasks.setStatus", "mutation", undefined)).toEqual({ ok: true });
    expect(actionAllowed("rh.penalties.review", "mutation", undefined)).toEqual({ ok: true });
    expect(actionAllowed("rh.delete", "mutation", undefined)).toMatchObject({ ok: false, status: 403 });
    expect(actionAllowed("tasks.delete", "mutation", undefined)).toMatchObject({ ok: false, status: 403 });
    expect(actionAllowed("rh.payrollRuns.approve", "mutation", undefined)).toMatchObject({ ok: false, status: 403 });
    expect(actionAllowed("tasks.list", "query", undefined)).toMatchObject({ ok: false, status: 400 });
    expect(actionAllowed("nao.existe", undefined, undefined)).toMatchObject({ ok: false, status: 404 });
  });
  it("o que sai para fora pede confirmExternal: true (e só true)", () => {
    for (const p of ["reviews.publishReply", "complaints.sendEmailToClient", "lostFound.sendEmailToClient"]) {
      expect(MCP_ACTIONS[p]?.external, p).toBe(true);
      expect(actionAllowed(p, "mutation", undefined), p).toMatchObject({ ok: false, status: 400 });
      expect(actionAllowed(p, "mutation", "true"), p).toMatchObject({ ok: false, status: 400 });
      expect(actionAllowed(p, "mutation", true), p).toEqual({ ok: true });
    }
  });
  it("nada de apagar, ficheiros, salários nem chaves na lista", () => {
    for (const p of Object.keys(MCP_ACTIONS)) {
      expect(p, p).not.toMatch(/\.(delete|upload\w*|remove\w*Photo)$|payroll|payslip|apiKeys|token/i);
    }
  });
});

describe("pesquisa", () => {
  it("todas as palavras têm de aparecer, sem acentos nem maiúsculas", () => {
    expect(matchesSearch("rh.timeRecords.list", "rh time")).toBe(true);
    expect(matchesSearch("rh.timeRecords.list", "RH.records")).toBe(true);
    expect(matchesSearch("rh.timeRecords.list", "despesas")).toBe(false);
    expect(matchesSearch("expenses.list", "")).toBe(true);
    expect(matchesSearch("expenses.list", undefined)).toBe(true);
  });
});

describe("datas em texto → Date (2.ª tentativa)", () => {
  it("converte datas e datas-hora ISO, em qualquer nível", () => {
    const r = reviveIsoDates({ from: "2026-10-01", range: { to: "2026-10-12T23:59:59Z" }, days: ["2026-10-02"], name: "Rui", n: 3 });
    expect(r.changed).toBe(true);
    const v = r.value as any;
    expect(v.from).toBeInstanceOf(Date);
    expect(v.from.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(v.range.to).toBeInstanceOf(Date);
    expect(v.days[0]).toBeInstanceOf(Date);
    expect(v.name).toBe("Rui");
    expect(v.n).toBe(3);
  });
  it("sem datas → changed false (não repete a chamada)", () => {
    expect(reviveIsoDates({ search: "AA-11-BB", id: 7 }).changed).toBe(false);
    expect(reviveIsoDates(undefined).changed).toBe(false);
    expect(reviveIsoDates("2026-13-45").changed).toBe(false);
  });
});

describe("resultado", () => {
  it("BigInt vira número (ou texto se for grande demais); undefined → null", () => {
    expect(resultJson({ a: BigInt(5) })).toBe('{"a":5}');
    expect(resultJson({ a: BigInt("9007199254740993") })).toBe('{"a":"9007199254740993"}');
    expect(resultJson(undefined)).toBe("null");
  });
  it("limite abaixo dos 4,5 MB do Vercel", () => {
    expect(MAX_RESULT_BYTES).toBeLessThan(4_500_000);
  });
});

describe("em nome de quem corre", () => {
  const users: Record<number, { isActive: unknown; loginMethod?: string | null }> = {
    1: { isActive: 1 },
    2: { isActive: 0, loginMethod: "merged_into_1" },
    3: { isActive: 0, loginMethod: "email" },
    4: { isActive: 0, loginMethod: "merged_into_5" },
    5: { isActive: 0, loginMethod: "merged_into_4" },
  };
  const load = async (id: number) => users[id] ?? null;
  it("quem criou a chave, ou a conta que ficou depois de juntar contas", async () => {
    expect(await resolveOwnerId(1, load)).toBe(1);
    expect(await resolveOwnerId(2, load)).toBe(1);
  });
  it("sem autor, conta inativa, inexistente ou em ciclo → null", async () => {
    expect(await resolveOwnerId(null, load)).toBeNull();
    expect(await resolveOwnerId(3, load)).toBeNull();
    expect(await resolveOwnerId(99, load)).toBeNull();
    expect(await resolveOwnerId(4, load)).toBeNull();
  });
});

describe("capacidades owner:read e owner:write", () => {
  it("nem admin nem as chaves antigas as trazem", () => {
    for (const p of ['["admin"]', '["read"]', '["read","write"]', "*", "full", null]) {
      for (const c of ["owner:read", "owner:write"] as const) {
        expect(capabilitiesFor(p).has(c), `${p} ${c}`).toBe(false);
        expect(v1Allowed(capabilitiesFor(p), [c]), `${p} ${c}`).toBe(false);
      }
    }
  });
  it("ler não dá para alterar, e vice-versa", () => {
    expect(v1Allowed(capabilitiesFor('["owner:read"]'), ["owner:write"])).toBe(false);
    expect(v1Allowed(capabilitiesFor('["owner:write"]'), ["owner:read"])).toBe(false);
    expect(normalizeCapabilities(["admin", "owner:write", "owner:read"])).toEqual(["admin", "owner:read", "owner:write"]);
  });
  it("marcada à mão funciona, sozinha ou com admin", () => {
    expect(v1Allowed(capabilitiesFor('["owner:read"]'), ["owner:read"])).toBe(true);
    expect(v1Allowed(capabilitiesFor('["admin","owner:read"]'), ["owner:read"])).toBe(true);
  });
  it("ao gravar, admin não a apaga", () => {
    expect(normalizeCapabilities(["admin", "owner:read", "pii"])).toEqual(["admin", "owner:read"]);
    expect(normalizeCapabilities(["owner:read"])).toEqual(["owner:read"]);
    expect(normalizeCapabilities(["admin"])).toEqual(["admin"]);
  });
  it("etiqueta para os logs", () => {
    expect(capabilitiesLabel(["admin", "owner:read"])).toBe("Administração (tudo), MCP pessoal (ler tudo como eu)");
    expect(capabilitiesLabel(["owner:read"])).toBe("MCP pessoal (ler tudo como eu)");
  });
});
