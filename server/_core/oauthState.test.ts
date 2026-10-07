import { describe, expect, it } from "vitest";
import { OAUTH_STATE_MAX_MS, checkCallbackState, createOAuthState, peekIsPda, peekReturnTo, retryLoginUrl, verifyOAuthState } from "./oauthState";
import { escapeHtml, renderErrorPage } from "./oauth";
import { loginUrlWithReturn } from "../../shared/loginReturn";

const SECRET = "segredo-de-teste-com-tamanho-suficiente";
const PDA_PATH = "/pda/registar?pda=20&c=5131a65e02b5422a8698c298b9d9b5f4";

describe("state assinado", () => {
  it("valida o state criado e devolve o destino", () => {
    const now = 1_000_000;
    const st = createOAuthState(SECRET, { returnTo: PDA_PATH, now });
    expect(verifyOAuthState(SECRET, st, now + 60_000)).toEqual({ ok: true, returnTo: PDA_PATH });
  });

  it("recusa assinatura errada, adulterado, expirado ou mal formado", () => {
    const now = 1_000_000;
    const st = createOAuthState(SECRET, { returnTo: "/x", now });
    expect(verifyOAuthState("outro-segredo", st, now)).toEqual({ ok: false, reason: "bad_signature" });
    const [payload, sig] = st.split(".");
    const forged = Buffer.from(JSON.stringify({ n: "x", t: now, r: "/admin" })).toString("base64url");
    expect(verifyOAuthState(SECRET, `${forged}.${sig}`, now)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyOAuthState(SECRET, st, now + OAUTH_STATE_MAX_MS + 1)).toEqual({ ok: false, reason: "expired" });
    expect(verifyOAuthState(SECRET, payload, now)).toEqual({ ok: false, reason: "malformed" });
    // state do formato antigo (aleatório, sem ponto) → recusado sem rebentar
    expect(verifyOAuthState(SECRET, "abcDEF123", now).ok).toBe(false);
  });

  it("destino inválido não entra no state", () => {
    const st = createOAuthState(SECRET, { returnTo: "https://evil.com" });
    expect(verifyOAuthState(SECRET, st)).toEqual({ ok: true, returnTo: null });
  });
});

describe("checkCallbackState", () => {
  const now = 5_000_000;
  const st = createOAuthState(SECRET, { returnTo: PDA_PATH, now });

  it("cookie igual → ok, ligado ao browser", () => {
    expect(checkCallbackState({ secret: SECRET, returned: st, saved: st, now })).toEqual({ ok: true, returnTo: PDA_PATH, cookieMatched: true });
  });

  it("SEM cookie (login acabou noutro browser, QR no PDA) → aceita o state assinado", () => {
    expect(checkCallbackState({ secret: SECRET, returned: st, saved: null, now })).toEqual({ ok: true, returnTo: PDA_PATH, cookieMatched: false });
  });

  it("cookie diferente → recusa (ligação ao browser mantém-se quando existe)", () => {
    const other = createOAuthState(SECRET, { now });
    expect(checkCallbackState({ secret: SECRET, returned: st, saved: other, now })).toEqual({ ok: false, reason: "cookie_mismatch" });
  });

  it("sem state ou state não assinado por nós → recusa", () => {
    expect(checkCallbackState({ secret: SECRET, returned: null, saved: st, now })).toEqual({ ok: false, reason: "missing" });
    expect(checkCallbackState({ secret: SECRET, returned: "aleatorio", saved: "aleatorio", now }).ok).toBe(false);
  });
});

describe("página de erro do login", () => {
  it("o botão Tentar de novo volta ao mesmo destino e o href é escapado", () => {
    const html = renderErrorPage("Entrada cancelada", "x", undefined, loginUrlWithReturn(PDA_PATH));
    expect(html).toContain("Tentar de novo");
    expect(html).toContain(escapeHtml(loginUrlWithReturn(PDA_PATH)));
    expect(renderErrorPage("t", "m", undefined, `"><script>alert(1)</script>`)).not.toContain("<script>");
    expect(renderErrorPage("t", "m")).not.toContain("Tentar de novo");
  });

  it("peekReturnTo lê o destino de um state (para o botão de repetir)", () => {
    expect(peekReturnTo(createOAuthState(SECRET, { returnTo: PDA_PATH }))).toBe(PDA_PATH);
    expect(peekReturnTo("lixo")).toBeNull();
    expect(peekReturnTo(null)).toBeNull();
  });

  it("Tentar de novo num PDA volta a pedir a conta (pda=1, D61); fora do PDA não", () => {
    const pda = createOAuthState(SECRET, { returnTo: PDA_PATH, pda: true });
    const pc = createOAuthState(SECRET, { returnTo: "/rh" });
    expect(peekIsPda(pda)).toBe(true);
    expect(peekIsPda(pc)).toBe(false);
    expect(peekIsPda("lixo")).toBe(false);
    expect(retryLoginUrl(pda)).toBe(`${loginUrlWithReturn(PDA_PATH)}&pda=1`);
    expect(retryLoginUrl(createOAuthState(SECRET, { pda: true }))).toBe("/api/oauth/login?pda=1");
    expect(retryLoginUrl(pc)).toBe(loginUrlWithReturn("/rh"));
    expect(retryLoginUrl(null)).toBe("/api/oauth/login");
  });

  it("o destino só entra no state se for um caminho seguro desta app", () => {
    expect(verifyOAuthState(SECRET, createOAuthState(SECRET, { returnTo: "//evil.example" }))).toEqual({ ok: true, returnTo: null });
  });
});
