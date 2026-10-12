/**
 * Plano 56 (A1): rotas da entrada por email + código + palavra-passe (dentro
 * de `auth`). A lógica está em server/loginCode.ts; as portas comuns (as do
 * Google) em `completeLogin` (server/_core/oauth.ts).
 *
 *  - públicas: `auth.options`, `auth.code.request`, `auth.code.verify`,
 *    `auth.password.login` — só JSON e só da própria app (Origin);
 *  - da própria pessoa: `auth.password.status/set/change`,
 *    `auth.codes.pendingForMe` (cartão "Códigos de entrada").
 *  - A2 (PDAs): `auth.pda.device` (este aparelho é um PDA registado? há
 *    Google?), `auth.pda.bind` (a sessão Google num PDA passa a sessão de
 *    PDA). O código e a palavra-passe levam o `pdaToken` do aparelho: num PDA
 *    registado a sessão fica presa ao PDA (server/pdaSession.ts).
 * Com ENTRAR_COM_CODIGO desligado, tudo recusa (e a página não as usa).
 */
import { TRPCError } from "@trpc/server";
import { parse as parseCookieHeader } from "cookie";
import { z } from "zod";
import { ACCESS_DENIED_MSG, COOKIE_NAME } from "@shared/const";
import { safeReturnPath } from "@shared/loginReturn";
import { CODE_LOGIN_OFF_MSG, LOGIN_CODE, LOGIN_NONCE_COOKIE, ROLE_GOOGLE_MSG, canUsePassword, deviceLabelFromUserAgent } from "@shared/loginCode";
import { PDA_SESSION_FAILED_MSG, googleShownOnDevice } from "@shared/pdaSession";
import { normalizeEmail } from "@shared/email";
import { getSessionCookieOptions } from "./_core/cookies";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import type { TrpcContext } from "./_core/context";

type Req = TrpcContext["req"];
type Res = TrpcContext["res"];

/** Só pedidos JSON vindos desta app (o browser põe o Origin nos POST). */
export function assertSameOriginJson(req: Req): void {
  const h = (req?.headers ?? {}) as Record<string, string | string[] | undefined>;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const origin = one(h.origin);
  if (origin) {
    const host = one(h["x-forwarded-host"] || h.host).split(",")[0].trim().toLowerCase();
    let originHost = "";
    try { originHost = new URL(origin).host.toLowerCase(); } catch { originHost = ""; }
    if (!host || originHost !== host) throw new TRPCError({ code: "FORBIDDEN", message: "Pedido recusado." });
  }
  const ct = one(h["content-type"]).toLowerCase();
  if (ct && !ct.includes("application/json")) throw new TRPCError({ code: "FORBIDDEN", message: "Pedido recusado." });
}

function readCookie(req: Req, name: string): string | null {
  try {
    const raw = (req?.headers as any)?.cookie;
    if (!raw) return null;
    return parseCookieHeader(String(raw))[name] ?? null;
  } catch {
    return null;
  }
}

const clientIp = (req: Req): string | null => {
  const fwd = String((req?.headers as any)?.["x-forwarded-for"] ?? "").split(",")[0].trim();
  return (req as any)?.ip || fwd || (req as any)?.socket?.remoteAddress || null;
};
const userAgentOf = (req: Req): string | null => {
  const ua = (req?.headers as any)?.["user-agent"];
  return typeof ua === "string" ? ua.slice(0, 400) : null;
};

function nonceCookieOptions(req: Req) {
  return { ...getSessionCookieOptions(req as any), maxAge: LOGIN_CODE.nonceMinutes * 60_000 };
}

function clearSession(req: Req, res: Res): void {
  try { res.clearCookie(COOKIE_NAME, { ...getSessionCookieOptions(req as any), maxAge: -1 }); } catch { /* sem resposta (testes) */ }
}

/** Novo cookie de sessão para ESTE aparelho com a versão atual (as outras sessões caem; num PDA fica presa ao PDA). */
async function reissueSession(req: Req, res: Res, user: { id: number; openId: string; name: string | null }): Promise<void> {
  const { bumpSessionVersion } = await import("./appSettings");
  const version = await bumpSessionVersion(user.id);
  const { reissueSessionCookie } = await import("./pdaSession");
  await reissueSessionCookie(req, res, user, version);
}

/** O PDA registado deste aparelho (token validado em `pdas.deviceToken`), só com as sessões de PDA ligadas. */
async function registeredPda(token: string | null | undefined): Promise<{ id: number; name: string; token: string } | null> {
  if (!token) return null;
  const { pdaSessionsEnabled } = await import("./pdaSession");
  if (!(await pdaSessionsEnabled())) return null;
  const { loginStore } = await import("./loginStore");
  const pda = await loginStore().pdaByToken(token).catch(() => null);
  return pda ? { id: pda.id, name: pda.name, token } : null;
}

function refusal(reason: "missing" | "inactive" | "method" | "pda"): string {
  return reason === "method" ? ROLE_GOOGLE_MSG : reason === "pda" ? PDA_SESSION_FAILED_MSG : ACCESS_DENIED_MSG;
}

const EMAIL = z.string().trim().min(3, "Escreve o teu email.").max(320);
const NEXT = z.string().max(512).nullable().optional();
const PDA_TOKEN = z.string().max(80).nullable().optional();

export const loginProcedures = {
  /** A página de entrada mostra o email/código? (o interruptor). */
  options: publicProcedure.query(async () => {
    const { codeLoginEnabled } = await import("./loginCode");
    const { googleOnPdasFlag } = await import("./pdaSession");
    const [codeLogin, googleOnPdas] = await Promise.all([codeLoginEnabled(), googleOnPdasFlag()]);
    return { codeLogin, resendAfterSec: LOGIN_CODE.resendSeconds, googleOnPdas: googleShownOnDevice({ registeredPda: true, codeLogin, googleOnPdas }) };
  }),

  pda: router({
    /**
     * A página de entrada num aparelho com `deviceToken`: é mesmo um PDA
     * registado? Há botão Google? (mutação: o token vai no corpo, nunca no endereço).
     */
    device: publicProcedure
      .input(z.object({ deviceToken: z.string().max(80) }))
      .mutation(async ({ ctx, input }) => {
        assertSameOriginJson(ctx.req);
        const { codeLoginEnabled } = await import("./loginCode");
        const { googleOnPdasFlag } = await import("./pdaSession");
        const [codeLogin, googleOnPdas] = await Promise.all([codeLoginEnabled(), googleOnPdasFlag()]);
        const { loginStore } = await import("./loginStore");
        const pda = codeLogin ? await loginStore().pdaByToken(input.deviceToken).catch(() => null) : null;
        return { registered: !!pda, name: pda?.name ?? null, google: googleShownOnDevice({ registeredPda: !!pda, codeLogin, googleOnPdas }) };
      }),
    /** Sessão sem PDA num aparelho com `deviceToken` (ex.: login Google no PDA) → sessão de PDA. Nunca logout. */
    bind: protectedProcedure
      .input(z.object({ deviceToken: z.string().min(16).max(80) }))
      .mutation(async ({ ctx, input }) => {
        assertSameOriginJson(ctx.req);
        const { bindPdaSession } = await import("./pdaSession");
        return bindPdaSession(ctx.req, ctx.res, ctx.user, input.deviceToken);
      }),
  }),

  code: router({
    /** "Pedir código": a resposta é SEMPRE a mesma (exista ou não a conta). */
    request: publicProcedure
      .input(z.object({ email: EMAIL, pdaToken: PDA_TOKEN }))
      .mutation(async ({ ctx, input }) => {
        assertSameOriginJson(ctx.req);
        const { realLoginDeps, requestLoginCode, hashNonce, isDeviceNonce, newDeviceNonce } = await import("./loginCode");
        const deps = await realLoginDeps();
        if (!(await deps.flagOn())) throw new TRPCError({ code: "PRECONDITION_FAILED", message: CODE_LOGIN_OFF_MSG });
        let nonce = readCookie(ctx.req, LOGIN_NONCE_COOKIE);
        if (!isDeviceNonce(nonce)) nonce = newDeviceNonce();
        ctx.res.cookie(LOGIN_NONCE_COOKIE, nonce, nonceCookieOptions(ctx.req));
        const r = await requestLoginCode(deps, { email: input.email, nonceHash: hashNonce(nonce), ip: clientIp(ctx.req), userAgent: userAgentOf(ctx.req), pdaToken: input.pdaToken ?? null });
        return { ok: true as const, message: r.message, resendAfterSec: LOGIN_CODE.resendSeconds };
      }),

    /** O código de 6 algarismos (no MESMO aparelho). Certo → as portas do Google → sessão. */
    verify: publicProcedure
      .input(z.object({ email: EMAIL, code: z.string().max(20), next: NEXT, pdaToken: PDA_TOKEN }))
      .mutation(async ({ ctx, input }) => {
        assertSameOriginJson(ctx.req);
        const { realLoginDeps, verifyLoginCode, accountForCodeLogin, noticeCodeUsed, hashNonce, isDeviceNonce } = await import("./loginCode");
        const deps = await realLoginDeps();
        const nonce = readCookie(ctx.req, LOGIN_NONCE_COOKIE);
        const code = await verifyLoginCode(deps, { email: input.email, nonceHash: isDeviceNonce(nonce) ? hashNonce(nonce) : null, code: input.code, ip: clientIp(ctx.req) });
        const target = await accountForCodeLogin(deps, input.email);
        if (!target.ok) {
          await deps.store.log({ userId: 0, action: "login_denied", entityId: null, details: `Entrada com código recusada (${target.reason === "restricted" ? "conta não registada, modo fechado" : "email de caixa partilhada ou de várias contas"}) · pedido #${code.id}` });
          clearSession(ctx.req, ctx.res);
          throw new TRPCError({ code: "FORBIDDEN", message: ACCESS_DENIED_MSG });
        }
        if (code.userId !== target.user.id) await deps.store.setCodeUser(code.id, target.user.id);
        // A2: num PDA registado a sessão fica presa ao PDA; os funcionários só
        // entram com código no PDA onde o código foi pedido.
        const pda = await registeredPda(input.pdaToken);
        const { completeLogin } = await import("./_core/oauth");
        const done = await completeLogin({
          req: ctx.req as any, res: ctx.res as any, account: target.user, method: "code", email: target.email,
          sessionName: target.user.name || "Utilizador",
          pda, registeredPda: !!pda && code.pdaId === pda.id,
          reload: () => deps.store.userById(target.user.id),
          beforeSession: async (a) => {
            await deps.store.markSignedIn(a.id, "email_code", deps.now());
            return deps.store.userById(a.id);
          },
        });
        if (!done.ok) {
          clearSession(ctx.req, ctx.res);
          throw new TRPCError({ code: "FORBIDDEN", message: refusal(done.reason) });
        }
        try { ctx.res.clearCookie(LOGIN_NONCE_COOKIE, { ...getSessionCookieOptions(ctx.req as any), maxAge: -1 }); } catch { /* testes */ }
        await noticeCodeUsed(deps, done.account.id, code);
        const state = await deps.store.passwordState(done.account.id);
        return { ok: true as const, needsPassword: canUsePassword(done.account.role) && !state?.hash, next: safeReturnPath(input.next), pdaSession: !!done.pdaSession };
      }),
  }),

  password: router({
    login: publicProcedure
      .input(z.object({ email: EMAIL, password: z.string().min(1, "Escreve a palavra-passe.").max(200), next: NEXT, pdaToken: PDA_TOKEN }))
      .mutation(async ({ ctx, input }) => {
        assertSameOriginJson(ctx.req);
        const { realLoginDeps, passwordLogin } = await import("./loginCode");
        const deps = await realLoginDeps();
        const pda = await registeredPda(input.pdaToken);
        const user = await passwordLogin(deps, { email: input.email, password: input.password, ip: clientIp(ctx.req), device: pda?.name ?? deviceLabelFromUserAgent(userAgentOf(ctx.req)) });
        const { completeLogin } = await import("./_core/oauth");
        const done = await completeLogin({
          req: ctx.req as any, res: ctx.res as any, account: user, method: "password", email: normalizeEmail(input.email),
          sessionName: user.name || "Utilizador", pda,
          reload: () => deps.store.userById(user.id),
          beforeSession: async (a) => {
            await deps.store.markSignedIn(a.id, "password", deps.now());
            return deps.store.userById(a.id);
          },
        });
        if (!done.ok) {
          clearSession(ctx.req, ctx.res);
          throw new TRPCError({ code: "FORBIDDEN", message: refusal(done.reason) });
        }
        return { ok: true as const, next: safeReturnPath(input.next), pdaSession: !!done.pdaSession };
      }),

    /** Perfil → Palavra-passe. */
    status: protectedProcedure.query(async ({ ctx }) => {
      const { realLoginDeps, passwordStatus } = await import("./loginCode");
      return passwordStatus(await realLoginDeps(), ctx.user);
    }),

    /** Criar (a 1.ª vez, ou nos 15 min depois de entrar com um código). */
    set: protectedProcedure
      .input(z.object({ password: z.string().max(200) }))
      .mutation(async ({ ctx, input }) => {
        const { realLoginDeps, setPassword } = await import("./loginCode");
        const r = await setPassword(await realLoginDeps(), ctx.user, { password: input.password });
        if (r.endOthers) await reissueSession(ctx.req, ctx.res, ctx.user);
        return { ok: true as const, mode: r.mode };
      }),

    /** Mudar (pede a atual). Termina as sessões nos outros aparelhos. */
    change: protectedProcedure
      .input(z.object({ current: z.string().min(1, "Escreve a palavra-passe atual.").max(200), password: z.string().max(200) }))
      .mutation(async ({ ctx, input }) => {
        const { realLoginDeps, setPassword } = await import("./loginCode");
        const r = await setPassword(await realLoginDeps(), ctx.user, { password: input.password, current: input.current });
        if (r.endOthers) await reissueSession(ctx.req, ctx.res, ctx.user);
        return { ok: true as const, mode: r.mode };
      }),
  }),

  codes: router({
    /** Cartão "Códigos de entrada" (Atividade diária → Ao vivo): os pedidos cujo código veio para mim. */
    pendingForMe: protectedProcedure.query(async ({ ctx }) => {
      const { realLoginDeps, codesForMe } = await import("./loginCode");
      return codesForMe(await realLoginDeps(), ctx.user.id);
    }),
  }),
};
