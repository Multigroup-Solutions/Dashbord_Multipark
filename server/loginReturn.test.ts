import { describe, expect, it } from "vitest";
import { isPublicPath, loginUrlWithReturn, safeReturnPath } from "@shared/loginReturn";
import { rememberReturnPath, takeReturnPath } from "./_core/oauth";

// Convite e PDA sem login precoce (P1, 1 out 2026): as páginas públicas não
// pedem dados protegidos e o login volta para onde a pessoa estava.

describe("isPublicPath", () => {
  it("convite e registo de PDA são públicos; o resto não", () => {
    expect(isPublicPath("/convite/abc123")).toBe(true);
    expect(isPublicPath("/pda/registar")).toBe(true);
    expect(isPublicPath("/pda/registar?pda=3&c=x")).toBe(true);
    expect(isPublicPath("/")).toBe(false);
    expect(isPublicPath("/rh")).toBe(false);
    expect(isPublicPath("/convites")).toBe(false);
    expect(isPublicPath(null)).toBe(false);
  });
});

describe("safeReturnPath — só caminhos desta app", () => {
  it.each([
    ["/convite/abc123", "/convite/abc123"],
    ["/pda/registar?pda=3&c=x", "/pda/registar?pda=3&c=x"],
    ["/rh?tab=ponto", "/rh?tab=ponto"],
    ["/api/file/payroll/folha.pdf", "/api/file/payroll/folha.pdf"],
  ])("aceita %s", (input, out) => {
    expect(safeReturnPath(input)).toBe(out);
  });

  it.each([
    "https://evil.example/x", "//evil.example/x", "/\\evil.example", "\\\\evil", "javascript:alert(1)",
    "rh", "/", "", "/api/oauth/logout", "/api/trpc/users.list", "/a b", "/x\ny", "/" + "a".repeat(600), 42, null,
  ])("recusa %s", (input) => {
    expect(safeReturnPath(input as any)).toBeNull();
  });

  it("loginUrlWithReturn leva o caminho codificado (ou nenhum)", () => {
    expect(loginUrlWithReturn("/convite/abc")).toBe("/api/oauth/login?next=%2Fconvite%2Fabc");
    expect(loginUrlWithReturn("https://evil.example")).toBe("/api/oauth/login");
    expect(loginUrlWithReturn()).toBe("/api/oauth/login");
  });
});

function fakeRes() {
  const cookies: Record<string, string> = {};
  const cleared: string[] = [];
  return {
    cookies,
    cleared,
    cookie: (name: string, value: string) => { cookies[name] = value; },
    clearCookie: (name: string) => { cleared.push(name); },
  };
}
const reqWith = (o: { next?: unknown; cookie?: string }) =>
  ({ query: o.next === undefined ? {} : { next: o.next }, headers: { cookie: o.cookie, host: "dashboard.multipark.pt" }, protocol: "https" }) as any;

describe("OAuth: regresso depois do login", () => {
  it("o /login guarda o caminho seguro e o callback volta para ele (e apaga a cookie)", () => {
    const res1 = fakeRes();
    rememberReturnPath(reqWith({ next: "/convite/abc123" }), res1 as any);
    expect(res1.cookies.app_oauth_next).toBe("/convite/abc123");

    const res2 = fakeRes();
    const to = takeReturnPath(reqWith({ cookie: `app_oauth_state=x; app_oauth_next=${encodeURIComponent("/convite/abc123")}` }), res2 as any);
    expect(to).toBe("/convite/abc123");
    expect(res2.cleared).toContain("app_oauth_next");
  });

  it("caminho de fora (ou cookie mexida) → vai para /", () => {
    const res1 = fakeRes();
    rememberReturnPath(reqWith({ next: "https://evil.example" }), res1 as any);
    expect(res1.cookies.app_oauth_next).toBeUndefined();
    expect(res1.cleared).toContain("app_oauth_next");

    expect(takeReturnPath(reqWith({ cookie: `app_oauth_next=${encodeURIComponent("//evil.example")}` }), fakeRes() as any)).toBe("/");
    expect(takeReturnPath(reqWith({}), fakeRes() as any)).toBe("/");
  });
});
