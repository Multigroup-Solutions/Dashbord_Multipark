import { describe, expect, it, vi } from "vitest";
import { fileAccessRule, makeFileRoute, outputSignRule, type FileRouteDeps } from "./fileRoute";
import { requireAccess } from "./_core/access";

describe("fileAccessRule — quem abre cada key", () => {
  it.each([
    ["employees/5/docs/id_card-1-cc.jpg", { kind: "employeeDocs", employeeId: 5 }],
    ["employees/5/ponto/1700000000.jpg", { kind: "employeeTime", employeeId: 5 }],
    ["employees/5/photo-1700000000.jpg", { kind: "session" }],
    ["payroll/folha_ordenados_2026_9_1.pdf", { kind: "module", modules: ["rh_salarios"] }],
    ["payslips/recibo_ana_2026_9.pdf", { kind: "module", modules: ["rh_salarios"] }],
    ["invoices/12/1700-ab-fatura.pdf", { kind: "ownInvoice", userId: 12 }],
    ["complaints/9/1-x.jpg", { kind: "module", modules: ["reclamacoes"] }],
    ["lost-found/3/1-x.jpg", { kind: "module", modules: ["perdidos"] }],
    ["training/certificates/5/cert-1.pdf", { kind: "module", modules: ["formacao"] }],
    ["crm/4/photo-1.jpg", { kind: "module", modules: ["clientes"] }],
    ["cash/mb/1/2026-10-01/talao-1.jpg", { kind: "module", modules: ["faturacao"] }],
    ["whatsapp/inbound/image/wamid.jpg", { kind: "module", modules: ["whatsapp"] }],
    ["driver-history/2026-10-01/joao.geojson", { kind: "module", modules: ["historico_diario", "atividade_diaria"] }],
    ["uploads/1700-abc.pdf", { kind: "admin" }],
    ["inbound/1700-cv.pdf", { kind: "admin" }],
    ["knowledge/1700-manual.pdf", { kind: "admin" }],
    ["qualquer/outra/coisa.bin", { kind: "admin" }],
    // um "photo-" dentro de docs/ continua a ser documento
    ["employees/5/docs/photo-1.jpg", { kind: "employeeDocs", employeeId: 5 }],
  ])("%s", (key, rule) => {
    expect(fileAccessRule(key)).toEqual(rule);
  });
});

describe("outputSignRule — links que saem de um procedimento", () => {
  it("só os sensíveis mantêm a regra; o resto vai a quem o procedimento mostrou", () => {
    expect(outputSignRule("employees/5/docs/cc.jpg")).toEqual({ kind: "employeeDocs", employeeId: 5 });
    expect(outputSignRule("employees/5/ponto/1.jpg")).toEqual({ kind: "employeeTime", employeeId: 5 });
    expect(outputSignRule("payroll/folha.pdf")).toEqual({ kind: "module", modules: ["rh_salarios"] });
    expect(outputSignRule("invoices/12/f.pdf")).toEqual({ kind: "ownInvoice", userId: 12 });
    for (const k of ["crm/4/photo-1.jpg", "complaints/9/1.jpg", "driver-history/d/j.geojson", "uploads/1-a.mp3", "inbound/1-cv.pdf"]) {
      expect(outputSignRule(k)).toEqual({ kind: "session" });
    }
  });
});

type Who = { id: number; role: string };
const SIGNED = "https://dashboard-multipark-bucket.s3.eu-west-1.amazonaws.com/k?X-Amz-Signature=x";

function harness(who: Who | null, opts: { docsOwner?: number; readUrl?: string } = {}) {
  const forbidden = () => Object.assign(new Error("Sem permissão"), { code: "FORBIDDEN" });
  const deps: FileRouteDeps = {
    authenticate: async () => who,
    overrides: async () => ({}),
    cityAccess: async () => ({ all: true } as any),
    inScope: async (_a, fn) => fn(),
    // documentos / ponto: só o próprio (opts.docsOwner) ou admin
    assertDocs: async (u, emp) => { if (u.role !== "admin" && emp !== opts.docsOwner) throw forbidden(); },
    assertTime: async (u, emp) => { if (u.role !== "admin" && emp !== opts.docsOwner) throw forbidden(); },
    // matriz real de acessos (shared/access.ts)
    assertModule: (u, m) => { requireAccess(u, m, "view"); },
    readUrl: vi.fn(async () => opts.readUrl ?? SIGNED),
    localPath: () => null,
  };
  const route = makeFileRoute(deps);
  const call = async (key: string, headers: Record<string, string> = {}) => {
    const res: any = { statusCode: 200, headers: {} as Record<string, string>, body: null, location: null };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
    res.redirect = (c: number, u: string) => { res.statusCode = c; res.location = u; };
    res.sendFile = (p: string) => { res.body = p; };
    await route({ params: { 0: key }, headers } as any, res);
    return res;
  };
  return { call, deps };
}

describe("GET /api/file/<key> — autorização por entidade", () => {
  it("sem sessão → 401 e não gera link", async () => {
    const h = harness(null);
    const r = await h.call("employees/5/docs/cc.jpg");
    expect(r.statusCode).toBe(401);
    expect(h.deps.readUrl).not.toHaveBeenCalled();
    // clique no link do email sem sessão → login
    const nav = await h.call("payroll/folha.pdf", { accept: "text/html,application/xhtml+xml" });
    expect(nav.statusCode).toBe(302);
    expect(nav.location).toBe("/api/oauth/login");
  });

  it("condutor não abre os documentos de outra ficha; abre os seus (302 para o link assinado)", async () => {
    const h = harness({ id: 30, role: "condutor" }, { docsOwner: 7 });
    const other = await h.call("employees/5/docs/cc.jpg");
    expect(other.statusCode).toBe(403);
    expect(h.deps.readUrl).not.toHaveBeenCalled();
    const own = await h.call("employees/7/docs/cc.jpg");
    expect(own.statusCode).toBe(302);
    expect(own.location).toBe(SIGNED);
    expect(own.headers["Cache-Control"]).toBe("private, no-store");
  });

  it("fotos do ponto de outra pessoa: recusadas a quem não as vê", async () => {
    const r = await harness({ id: 30, role: "condutor" }, { docsOwner: 7 }).call("employees/5/ponto/1.jpg");
    expect(r.statusCode).toBe(403);
  });

  it("folha de ordenados: só com RH — ordenados (o supervisor não)", async () => {
    expect((await harness({ id: 1, role: "supervisor" }).call("payroll/folha_2026_9.pdf")).statusCode).toBe(403);
    expect((await harness({ id: 1, role: "admin" }).call("payroll/folha_2026_9.pdf")).statusCode).toBe(302);
  });

  it("fatura de despesa: o próprio abre; outro sem o módulo não", async () => {
    expect((await harness({ id: 12, role: "extra" }).call("invoices/12/f.pdf")).statusCode).toBe(302);
    expect((await harness({ id: 13, role: "extra" }).call("invoices/12/f.pdf")).statusCode).toBe(403);
  });

  it("prefixos partilhados (uploads/, inbound/): só admin ou acima", async () => {
    expect((await harness({ id: 1, role: "supervisor" }).call("uploads/1-a.pdf")).statusCode).toBe(403);
    expect((await harness({ id: 1, role: "condutor" }).call("inbound/1-cv.pdf")).statusCode).toBe(403);
    expect((await harness({ id: 1, role: "admin" }).call("uploads/1-a.pdf")).statusCode).toBe(302);
  });

  it("foto de perfil: qualquer sessão", async () => {
    expect((await harness({ id: 1, role: "extra" }).call("employees/5/photo-1.jpg")).statusCode).toBe(302);
  });

  it("key com '..' → 400; ficheiro que não existe → 404", async () => {
    expect((await harness({ id: 1, role: "admin" }).call("employees/../x")).statusCode).toBe(400);
    expect((await harness({ id: 1, role: "admin" }, { readUrl: "" }).call("uploads/nada.pdf")).statusCode).toBe(404);
  });
});
