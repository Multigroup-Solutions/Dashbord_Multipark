/**
 * `state` do login Google: ASSINADO (HMAC-SHA256 com JWT_SECRET) e com prazo,
 * em vez de depender só de um cookie.
 *
 * Porquê: no PDA o QR é lido por uma app de leitura que abre o link no browser
 * DELA; a Google pode devolver a pessoa noutro browser (Chrome). O cookie de
 * state ficava no primeiro browser e o callback respondia 400 "O pedido de
 * entrada expirou" (`hasSaved:false` nos logs de 2026-10-07). Com o state
 * assinado o callback valida-o sozinho; o cookie, quando existe, continua a
 * ter de bater certo (mantém a ligação ao browser sempre que é possível).
 *
 * O state leva também o destino depois do login (`?next=`), pela mesma razão:
 * o cookie `app_oauth_next` também se perdia ao mudar de browser, e o registo
 * do PDA não continuava.
 */
import crypto from "node:crypto";
import { safeReturnPath } from "@shared/loginReturn";

export const OAUTH_STATE_MAX_MS = 10 * 60 * 1000; // 10 minutos para concluir o login

function sign(secret: string, payload: string): string {
  return crypto.createHmac("sha256", secret).update(`oauth-state.${payload}`).digest("base64url");
}

/** Cria o state: `<payload base64url>.<assinatura>`. */
export function createOAuthState(secret: string, opts: { returnTo?: string | null; now?: number } = {}): string {
  const payload = Buffer.from(
    JSON.stringify({
      n: crypto.randomBytes(16).toString("base64url"),
      t: opts.now ?? Date.now(),
      r: safeReturnPath(opts.returnTo) ?? undefined,
    }),
  ).toString("base64url");
  return `${payload}.${sign(secret, payload)}`;
}

export type OAuthStateCheck =
  | { ok: true; returnTo: string | null }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

/** Valida assinatura e prazo. PURA (a hora entra por parâmetro). */
export function verifyOAuthState(secret: string, state: string, now: number = Date.now()): OAuthStateCheck {
  const dot = state.indexOf(".");
  if (!secret || dot <= 0 || dot === state.length - 1) return { ok: false, reason: "malformed" };
  const payload = state.slice(0, dot);
  const given = Buffer.from(state.slice(dot + 1));
  const expected = Buffer.from(sign(secret, payload));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, reason: "bad_signature" };
  }
  let data: any;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const t = Number(data?.t);
  if (!Number.isFinite(t) || now - t > OAUTH_STATE_MAX_MS || t - now > 60_000) return { ok: false, reason: "expired" };
  return { ok: true, returnTo: safeReturnPath(data?.r) };
}

export type CallbackStateCheck =
  | { ok: true; returnTo: string | null; cookieMatched: boolean }
  | { ok: false; reason: "missing" | "cookie_mismatch" | "malformed" | "bad_signature" | "expired" };

/**
 * Decisão do callback sobre o state. PURA.
 *  - o state devolvido pela Google tem de ser NOSSO (assinatura) e recente;
 *  - se o cookie do browser existir, tem de ser igual (ligação ao browser);
 *  - sem cookie (login acabou noutro browser, caso do QR no PDA) aceita-se o
 *    state assinado sozinho.
 */
export function checkCallbackState(opts: {
  secret: string;
  returned: string | null | undefined;
  saved: string | null | undefined;
  now?: number;
}): CallbackStateCheck {
  if (!opts.returned) return { ok: false, reason: "missing" };
  const verified = verifyOAuthState(opts.secret, opts.returned, opts.now);
  if (!verified.ok) return verified;
  if (opts.saved && opts.saved !== opts.returned) return { ok: false, reason: "cookie_mismatch" };
  return { ok: true, returnTo: verified.returnTo, cookieMatched: !!opts.saved };
}

/**
 * Destino guardado num state, SEM validar assinatura nem prazo: só para o
 * botão "Tentar de novo" de uma página de erro (não dá acesso a nada; o novo
 * login cria um state novo e o destino volta a ser validado). PURA.
 */
export function peekReturnTo(state: string | null | undefined): string | null {
  if (!state) return null;
  const payload = state.split(".")[0];
  try {
    return safeReturnPath(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))?.r);
  } catch {
    return null;
  }
}
