import { describe, expect, it, vi } from "vitest";
import { makeRequireSession } from "./_core/requireSession";

function fakeRes() {
  const res: any = { statusCode: 200, body: null };
  res.status = vi.fn((c: number) => { res.statusCode = c; return res; });
  res.json = vi.fn((b: unknown) => { res.body = b; return res; });
  return res;
}

describe("guarda de sessão de /api/upload e /api/file", () => {
  it("sem sessão → 401 e não chama o handler", async () => {
    const guard = makeRequireSession(async () => { throw new Error("Invalid session cookie"); });
    const res = fakeRes(); const next = vi.fn();
    await guard({ headers: {} } as any, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
  it("autenticador devolve nulo → 401", async () => {
    const guard = makeRequireSession(async () => null);
    const res = fakeRes(); const next = vi.fn();
    await guard({ headers: {} } as any, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
  it("com sessão → segue e expõe o utilizador", async () => {
    const guard = makeRequireSession(async () => ({ id: 1, role: "extra" }));
    const req: any = { headers: { cookie: "x" } }; const res = fakeRes(); const next = vi.fn();
    await guard(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.sessionUser).toEqual({ id: 1, role: "extra" });
  });
});
