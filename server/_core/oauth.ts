import { AUTH_DENIED_PARAM, AUTH_DENIED_VALUE, COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { normalizeEmail } from "@shared/email";
import { googlePromptFor, safeReturnPath } from "@shared/loginReturn";
import type { Express, Request, Response, CookieOptions } from "express";
import crypto from "node:crypto";
import * as db from "../db";
import { adoptPlaceholderAccountByEmail, linkEmployeesToUserByEmail } from "../identity";
import { getSessionCookieOptions } from "./cookies";
import { sdk } from "./sdk";
import { shouldRejectUnverifiedGoogleEmail } from "./googleIdentity";

// 30 dias é o novo default (em vez de 1 ano) — reduz janela de exposição
// caso uma cookie seja intercetada. O nome da env é opcional.
export const SESSION_MAX_MS = (() => {
  const n = parseInt(process.env.SESSION_MAX_DAYS ?? "30", 10);
  return (Number.isFinite(n) && n > 0 ? n : 30) * 24 * 60 * 60 * 1000;
})();

const OAUTH_STATE_COOKIE = "app_oauth_state";
const OAUTH_STATE_MAX_MS = 10 * 60 * 1000; // 10 minutos para concluir o login
/** Para onde voltar depois do login (`/api/oauth/login?next=…`, validado em shared/loginReturn.ts). */
const OAUTH_NEXT_COOKIE = "app_oauth_next";

/**
 * Modo fechado: recusa quem não tenha sido registado pelo backoffice, em vez
 * de criar automaticamente um utilizador com role `user`. Desligado por
 * defeito para não mudar o comportamento em produção sem decisão explícita.
 */
const LOGIN_RESTRICTED_TO_REGISTERED = /^(1|true|yes|on)$/i.test(
  process.env.RESTRICT_LOGIN_TO_REGISTERED ?? "",
);

/**
 * Recusa de acesso — ponto ÚNICO: limpa a sessão e devolve a pessoa à página
 * de entrada com o sinal que faz aparecer `ACCESS_DENIED_MSG`. Todos os
 * motivos (desconhecido, desativado, modo fechado) passam por aqui, para a
 * mensagem ser sempre a mesma.
 */
function denyAccess(req: Request, res: Response): void {
  res.clearCookie(COOKIE_NAME, { ...getSessionCookieOptions(req), maxAge: -1 });
  res.redirect(302, `/?${AUTH_DENIED_PARAM}=${AUTH_DENIED_VALUE}`);
}

function getStateCookieOptions(req: Request): CookieOptions {
  const base = getSessionCookieOptions(req);
  return {
    ...base,
    // A cookie de state é lida no callback OAuth, que vem via cross-site
    // redirect da Google — com SameSite=Strict o browser NÃO enviaria a
    // cookie. Lax é o mínimo necessário para este fluxo funcionar.
    sameSite: "lax",
    maxAge: OAUTH_STATE_MAX_MS,
  };
}

/** Texto → HTML seguro (20d: a página de erro nunca interpreta o que vem no pedido). PURA. */
export function escapeHtml(v: unknown): string {
  return String(v ?? "").replace(/[&<>"'`]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" } as Record<string, string>)[c]);
}

/** Email nos logs do servidor: "an***@dominio.pt" (20d). PURA. */
export function maskEmailForLog(email: string | null | undefined): string {
  const e = String(email ?? "").trim();
  if (!e) return "sem email";
  const [user, domain] = e.split("@");
  if (!domain) return "***";
  return `${user.slice(0, 2)}***@${domain}`;
}

/**
 * Página de erro do login. TUDO é texto escapado (20d: antes o
 * `error`/`error_description` da query entravam no HTML tal como vinham —
 * XSS), sem scripts (CSP) e sem detalhes internos.
 */
export function renderErrorPage(title: string, message: string, details?: string): string {
  return `<!doctype html><html lang="pt"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:640px;margin:4rem auto;padding:0 1.5rem;color:#1f2937;line-height:1.6}
h1{color:#dc2626;margin-bottom:.5rem}
pre{background:#f3f4f6;padding:1rem;border-radius:6px;white-space:pre-wrap;word-break:break-word;font-size:.85em}
a{color:#2563eb}</style></head><body>
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${details ? `<pre>${escapeHtml(details)}</pre>` : ""}
<p><a href="/">← Voltar ao início</a></p></body></html>`;
}

const ERROR_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function sendErrorPage(res: Response, status: number, title: string, message: string, details?: string): void {
  res.status(status)
    .set("Content-Security-Policy", ERROR_PAGE_CSP)
    .set("X-Content-Type-Options", "nosniff")
    .set("Cache-Control", "no-store")
    .type("html")
    .send(renderErrorPage(title, message, details));
}

/** Entradas e recusas no registo de atividade (20d). Nunca parte o login. */
async function logLogin(entry: { userId: number; action: "login" | "login_denied"; entityId: number | null; details: string }): Promise<void> {
  try {
    await db.logActivity({ userId: entry.userId, action: entry.action, entity: "user", entityId: entry.entityId, details: entry.details, source: "ui" } as any);
  } catch { /* registo */ }
}

export function registerOAuthRoutes(app: Express) {
  // Endpoint de diagnóstico — mostra o redirect_uri que será enviado à Google
  // para podermos comparar com o que está registado na Cloud Console.
  // 20d: só o super admin (antes estava aberto a qualquer pessoa na Internet).
  app.get("/api/oauth/_diag", async (req: Request, res: Response) => {
    let allowed = false;
    try { allowed = (await sdk.authenticateRequest(req))?.role === "super_admin"; } catch { allowed = false; }
    if (!allowed) { res.status(404).json({ error: "Not found" }); return; }
    res.json({
      origin: getOrigin(req),
      redirectUri: `${getOrigin(req)}/api/oauth/callback`,
      env: {
        GOOGLE_CLIENT_ID: !!process.env.GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET: !!process.env.GOOGLE_CLIENT_SECRET,
        JWT_SECRET: !!process.env.JWT_SECRET,
        DATABASE_URL: !!process.env.DATABASE_URL,
        NODE_ENV: process.env.NODE_ENV ?? null,
      },
      headers: {
        host: req.headers.host,
        "x-forwarded-host": req.headers["x-forwarded-host"],
        "x-forwarded-proto": req.headers["x-forwarded-proto"],
      },
      hint: "Copia o valor de 'redirectUri' e regista-o na Google Cloud Console → Credentials → OAuth Client → Authorized redirect URIs.",
    });
  });

  // Dev login — só disponível quando NODE_ENV != production E com token explícito
  if (process.env.NODE_ENV !== "production") {
    app.get("/api/dev-login", async (req: Request, res: Response) => {
      const expected = process.env.DEV_LOGIN_TOKEN;
      const provided =
        (typeof req.query.token === "string" ? req.query.token : undefined) ??
        (typeof req.headers["x-dev-login-token"] === "string"
          ? (req.headers["x-dev-login-token"] as string)
          : undefined);

      if (!expected) {
        res.status(403).json({
          error:
            "Dev login desativado: define a variável de ambiente DEV_LOGIN_TOKEN para ativar.",
        });
        return;
      }
      if (!provided || provided.length < 16 || !safeEquals(provided, expected)) {
        res.status(401).json({ error: "Token de dev-login inválido" });
        return;
      }

      try {
        const openId = "dev_admin_local";
        const name = "Admin Dev";
        const email = "admin@multipark.local";

        await db.upsertUser({
          openId,
          name,
          email,
          loginMethod: "google",
          role: "super_admin" as any,
          lastSignedIn: new Date().toISOString().slice(0, 19).replace("T", " "),
        });

        const devAccount = await db.getUserByOpenId(openId);
        const sessionToken = await sdk.createSessionToken(openId, {
          name,
          expiresInMs: SESSION_MAX_MS,
          sessionVersion: devAccount?.sessionVersion ?? 0,
        });

        const cookieOptions = getSessionCookieOptions(req);
        res.cookie(COOKIE_NAME, sessionToken, {
          ...cookieOptions,
          maxAge: SESSION_MAX_MS,
        });

        res.redirect(302, "/");
      } catch (error) {
        console.error("[Dev Login] Failed", error);
        res.status(500).json({ error: "Dev login failed" });
      }
    });
  }

  // Step 1: Redirect user to Google login (com state anti-CSRF)
  app.get("/api/oauth/login", (req: Request, res: Response) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const jwtSecret = process.env.JWT_SECRET;

    const missing: string[] = [];
    if (!clientId) missing.push("GOOGLE_CLIENT_ID");
    if (!clientSecret) missing.push("GOOGLE_CLIENT_SECRET");
    if (!jwtSecret) missing.push("JWT_SECRET");

    if (missing.length > 0) {
      console.error("[OAuth] Login bloqueado — env vars em falta:", missing);
      sendErrorPage(res, 500,
        "Configuração de autenticação incompleta",
        "O servidor ainda não tem tudo o que precisa para o login com a Google.",
        "Avisa o administrador (falta configuração no servidor).");
      return;
    }

    // Gera state aleatório e guarda em cookie httpOnly para validar no callback
    const state = crypto.randomBytes(32).toString("base64url");
    res.cookie(OAUTH_STATE_COOKIE, state, getStateCookieOptions(req));
    // Regresso depois do login (ex.: o convite): só caminhos desta app.
    rememberReturnPath(req, res);

    const redirectUri = `${getOrigin(req)}/api/oauth/callback`;
    const scope = "openid email profile";

    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", clientId!);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", scope);
    url.searchParams.set("access_type", "offline");
    // D61: num PDA (pda=1) a Google pede sempre para escolher a conta.
    url.searchParams.set("prompt", googlePromptFor(req.query.pda));
    url.searchParams.set("state", state);

    res.redirect(302, url.toString());
  });

  // Step 2: Google redirects back here with code + state
  app.get("/api/oauth/callback", async (req: Request, res: Response) => {
    // Se a Google devolveu erro (ex: redirect_uri_mismatch, access_denied),
    // ela passa-o em ?error=... — mostra-o claramente em vez de continuar.
    const googleError = typeof req.query.error === "string" ? req.query.error : undefined;
    if (googleError) {
      const description =
        typeof req.query.error_description === "string"
          ? req.query.error_description
          : "(sem descrição)";
      console.error("[OAuth] Google devolveu erro:", googleError.slice(0, 64), description.slice(0, 200));
      // 20d: só o código, e só se tiver a forma de um código da Google — nunca o texto do pedido.
      const code = /^[a-z_]{1,64}$/.test(googleError) ? googleError : "desconhecido";
      sendErrorPage(res, 400,
        code === "access_denied" ? "Entrada cancelada" : "A Google rejeitou o pedido de autenticação",
        code === "access_denied" ? "Cancelaste a entrada com a Google." : `Código: ${code}.`,
        "Tenta de novo a partir da página inicial. Se persistir, avisa o administrador.");
      return;
    }

    const code = typeof req.query.code === "string" ? req.query.code : undefined;
    const returnedState =
      typeof req.query.state === "string" ? req.query.state : undefined;

    if (!code) {
      sendErrorPage(res, 400,
        "Falta o código de autorização",
        "A resposta da Google chegou incompleta.",
        "Tenta de novo a partir da página inicial.");
      return;
    }

    // Validar state anti-CSRF
    const savedState = readCookie(req, OAUTH_STATE_COOKIE);
    // limpa sempre o cookie, success ou fail
    res.clearCookie(OAUTH_STATE_COOKIE, {
      ...getSessionCookieOptions(req),
    });

    if (!savedState || !returnedState || !safeEquals(savedState, returnedState)) {
      console.error("[OAuth] State inválido:", {
        hasSaved: !!savedState,
        hasReturned: !!returnedState,
      });
      sendErrorPage(res, 400,
        "O pedido de entrada expirou",
        "A proteção do login não confirmou este pedido.",
        "Causas típicas:\n• Passaram mais de 10 minutos entre clicar em 'Entrar' e voltar da Google\n• Começaste noutro endereço da aplicação\n• O browser bloqueou os cookies\n\nFecha a janela, abre uma nova e tenta de novo a partir da página inicial.");
      return;
    }

    try {
      const redirectUri = `${getOrigin(req)}/api/oauth/callback`;

      const tokenResponse = await sdk.exchangeCodeForToken(code, redirectUri);
      const userInfo = await sdk.getUserInfo(tokenResponse.access_token);

      if (!userInfo.sub) {
        sendErrorPage(res, 400, "Resposta da Google sem identificador", "A Google não devolveu o identificador da conta. Tenta de novo.");
        return;
      }

      // Email por verificar na Google não serve de identidade (liga contas e
      // fichas por email) — recusa o login.
      if (shouldRejectUnverifiedGoogleEmail(userInfo)) {
        console.warn("[OAuth] Acesso recusado — email Google não verificado");
        await logLogin({ userId: 0, action: "login_denied", entityId: null, details: `Entrada recusada: email Google não verificado <${maskEmailForLog(userInfo.email)}>` });
        sendErrorPage(res, 403,
          "Email Google não verificado",
          "A Google indica que o email desta conta ainda não foi verificado.",
          "Verifica o email na tua conta Google e tenta entrar de novo.");
        return;
      }

      // Use Google sub as openId
      const openId = `google_${userInfo.sub}`;
      const email = normalizeEmail(userInfo.email ?? "");

      // Modo fechado (opcional): só entra quem o backoffice já registou. Sem a
      // env, mantém-se o comportamento histórico — qualquer conta Google cria
      // um utilizador com role `user` (sem permissões relevantes).
      if (LOGIN_RESTRICTED_TO_REGISTERED) {
        let known: unknown = (await db.getUserByOpenId(openId)) ?? (email ? await db.getUserByEmail(email) : undefined);
        // Email (profissional OU pessoal) de uma ficha ativa também conta como
        // registado — a mesma pessoa pode entrar com qualquer dos dois (0081).
        if (!known && email) {
          const database0 = await db.getDb();
          if (database0) {
            const { sql } = await import("drizzle-orm");
            const [r] = (await database0.execute(sql`SELECT id FROM employees WHERE isActive = 1
              AND (LOWER(TRIM(email)) = ${email} OR LOWER(TRIM(personalEmail)) = ${email}) LIMIT 1`)) as any;
            known = (r as any[])?.[0];
          }
        }
        if (!known) {
          console.warn(`[OAuth] Acesso recusado <${maskEmailForLog(email)}> — conta não registada (modo fechado)`);
          await logLogin({ userId: 0, action: "login_denied", entityId: null, details: `Entrada recusada: conta não registada <${maskEmailForLog(email)}>` });
          denyAccess(req, res);
          return;
        }
      }

      // A identidade é o EMAIL: se o backoffice já registou esta pessoa à mão,
      // o primeiro login Google ADOTA essa conta (role/permissões incluídos)
      // em vez de criar uma segunda linha em `users` com role default.
      const database = await db.getDb();
      if (database && email) {
        await adoptPlaceholderAccountByEmail(database, email, openId, userInfo.name || null);
      }

      await db.upsertUser({
        openId,
        name: userInfo.name || null,
        email: email || null,
        loginMethod: "google",
        lastSignedIn: new Date().toISOString().slice(0, 19).replace("T", " "),
      });

      // Porta de acesso ÚNICA: conta desativada (ou sem linha em `users`, se a
      // BD estiver indisponível) → sem sessão e com a MESMA mensagem para
      // todos os casos. Nunca distinguir "desconhecido" de "desativado".
      const account = await db.getUserByOpenId(openId);
      if (!account || account.isActive !== 1) {
        console.warn(
          `[OAuth] Acesso recusado <${maskEmailForLog(email)}> — ${account ? "conta desativada" : "conta não encontrada"}`,
        );
        await logLogin({ userId: 0, action: "login_denied", entityId: account?.id ?? null, details: `Entrada recusada: ${account ? "conta desativada" : "conta não encontrada"} <${maskEmailForLog(email)}>` });
        denyAccess(req, res);
        return;
      }

      // A ficha de colaborador com o MESMO email é desta pessoa: fica ligada à
      // conta (regra do Jorge, 2026-09-10). Sem isto o login criava a conta e a
      // ficha ficava órfã. Best-effort — nunca pode partir o login.
      if (database && email) {
        try {
          const linked = await linkEmployeesToUserByEmail(database, account.id, email, { actorId: account.id, source: "ui" });
          if (linked.length) console.log(`[OAuth] <${maskEmailForLog(email)}> ligado à(s) ficha(s) #${linked.join(", #")}`);
        } catch (err) {
          console.warn("[OAuth] Falha a ligar ficha por email:", String((err as Error)?.message ?? err).slice(0, 160));
        }
      }

      const sessionToken = await sdk.createSessionToken(openId, {
        name: userInfo.name || "",
        expiresInMs: SESSION_MAX_MS,
        sessionVersion: account.sessionVersion ?? 0,
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, {
        ...cookieOptions,
        maxAge: SESSION_MAX_MS,
      });
      await logLogin({ userId: account.id, action: "login", entityId: account.id, details: "Entrou com a Google" });

      res.redirect(302, takeReturnPath(req, res));
    } catch (error: any) {
      // 20d: o detalhe (mensagens internas, SQL) fica só no log, com uma referência.
      const ref = crypto.randomBytes(4).toString("hex");
      console.error(`[OAuth] Callback failed ref=${ref}`, error);
      sendErrorPage(res, 500,
        "Não foi possível concluir a entrada",
        "Ocorreu um erro do nosso lado ao concluir o login. Tenta de novo daqui a pouco.",
        `Se voltar a acontecer, avisa o administrador com esta referência: ${ref}`);
    }
  });
}

function getOrigin(req: Request): string {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
  return `${proto}://${host}`;
}

/** Comparação de strings em tempo constante. */
function safeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Extrai uma cookie específica do header Cookie sem precisar de middleware. */
/** No /api/oauth/login: guarda o `?next=` (se for um caminho seguro desta app) até ao callback. */
export function rememberReturnPath(req: Request, res: Response): void {
  const next = safeReturnPath((req.query as any)?.next);
  if (next) res.cookie(OAUTH_NEXT_COOKIE, next, getStateCookieOptions(req));
  else res.clearCookie(OAUTH_NEXT_COOKIE, { ...getSessionCookieOptions(req) });
}

/** No callback com sucesso: para onde voltar (validado OUTRA vez) — e a cookie sai. */
export function takeReturnPath(req: Request, res: Response): string {
  let raw: string | null = null;
  try { raw = readCookie(req, OAUTH_NEXT_COOKIE); } catch { raw = null; }
  res.clearCookie(OAUTH_NEXT_COOKIE, { ...getSessionCookieOptions(req) });
  return safeReturnPath(raw) ?? "/";
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const pair of raw.split(";")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    const k = pair.slice(0, idx).trim();
    if (k === name) {
      return decodeURIComponent(pair.slice(idx + 1).trim());
    }
  }
  return null;
}
