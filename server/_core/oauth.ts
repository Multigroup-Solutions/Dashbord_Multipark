import { AUTH_DENIED_PARAM, AUTH_DENIED_VALUE, COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { normalizeEmail } from "@shared/email";
import type { Express, Request, Response, CookieOptions } from "express";
import crypto from "node:crypto";
import * as db from "../db";
import { adoptPlaceholderAccountByEmail } from "../identity";
import { getSessionCookieOptions } from "./cookies";
import { sdk } from "./sdk";

// 30 dias é o novo default (em vez de 1 ano) — reduz janela de exposição
// caso uma cookie seja intercetada. O nome da env é opcional.
const SESSION_MAX_MS = (() => {
  const n = parseInt(process.env.SESSION_MAX_DAYS ?? "30", 10);
  return (Number.isFinite(n) && n > 0 ? n : 30) * 24 * 60 * 60 * 1000;
})();

const OAUTH_STATE_COOKIE = "app_oauth_state";
const OAUTH_STATE_MAX_MS = 10 * 60 * 1000; // 10 minutos para concluir o login

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

function renderErrorPage(title: string, message: string, details?: string): string {
  return `<!doctype html><html lang="pt"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:640px;margin:4rem auto;padding:0 1.5rem;color:#1f2937;line-height:1.6}
h1{color:#dc2626;margin-bottom:.5rem}code{background:#f3f4f6;padding:.15rem .4rem;border-radius:4px;font-size:.9em}
pre{background:#f3f4f6;padding:1rem;border-radius:6px;overflow-x:auto;font-size:.85em}
a{color:#2563eb}</style></head><body>
<h1>${title}</h1><p>${message}</p>${details ? `<pre>${details}</pre>` : ""}
<p><a href="/">← Voltar ao início</a></p></body></html>`;
}

export function registerOAuthRoutes(app: Express) {
  // Endpoint de diagnóstico — mostra o redirect_uri que será enviado à Google
  // para podermos comparar com o que está registado na Cloud Console.
  app.get("/api/oauth/_diag", (req: Request, res: Response) => {
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

        const sessionToken = await sdk.createSessionToken(openId, {
          name,
          expiresInMs: SESSION_MAX_MS,
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
      res.status(500).type("html").send(
        renderErrorPage(
          "Configuração de autenticação incompleta",
          `As seguintes variáveis de ambiente não estão definidas no servidor: <code>${missing.join("</code>, <code>")}</code>.`,
          "Adiciona-as em Vercel → Settings → Environment Variables e faz redeploy.\n\nVê o diagnóstico completo em: /api/oauth/_diag"
        )
      );
      return;
    }

    // Gera state aleatório e guarda em cookie httpOnly para validar no callback
    const state = crypto.randomBytes(32).toString("base64url");
    res.cookie(OAUTH_STATE_COOKIE, state, getStateCookieOptions(req));

    const redirectUri = `${getOrigin(req)}/api/oauth/callback`;
    const scope = "openid email profile";

    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", clientId!);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", scope);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
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
      console.error("[OAuth] Google devolveu erro:", googleError, description);
      res.status(400).type("html").send(
        renderErrorPage(
          "A Google rejeitou o pedido de autenticação",
          `Código: <code>${googleError}</code>`,
          `${description}\n\nCausa típica: o redirect_uri enviado não corresponde aos URIs autorizados na Google Cloud Console. Confirma em /api/oauth/_diag qual é o redirect_uri usado.`
        )
      );
      return;
    }

    const code = typeof req.query.code === "string" ? req.query.code : undefined;
    const returnedState =
      typeof req.query.state === "string" ? req.query.state : undefined;

    if (!code) {
      res.status(400).type("html").send(
        renderErrorPage(
          "Falta o código de autorização",
          "O callback da Google chegou sem o parâmetro <code>code</code>.",
          "Tenta de novo a partir de /api/oauth/login. Se persistir, verifica /api/oauth/_diag."
        )
      );
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
      res.status(400).type("html").send(
        renderErrorPage(
          "Estado OAuth inválido ou expirado",
          "O cookie de proteção CSRF não foi recebido ou não corresponde ao esperado.",
          "Causas típicas:\n• Passaram mais de 10 minutos entre clicar em 'Entrar' e voltar da Google\n• O domínio do login é diferente do domínio do callback (ex: preview vs production)\n• Cookies de terceiros bloqueados no browser\n\nFecha a janela, abre nova e tenta de novo a partir de /."
        )
      );
      return;
    }

    try {
      const redirectUri = `${getOrigin(req)}/api/oauth/callback`;

      const tokenResponse = await sdk.exchangeCodeForToken(code, redirectUri);
      const userInfo = await sdk.getUserInfo(tokenResponse.access_token);

      if (!userInfo.sub) {
        res.status(400).type("html").send(
          renderErrorPage(
            "Resposta da Google sem identificador",
            "A Google não devolveu o <code>sub</code> (ID do utilizador)."
          )
        );
        return;
      }

      // Use Google sub as openId
      const openId = `google_${userInfo.sub}`;
      const email = normalizeEmail(userInfo.email ?? "");

      // Modo fechado (opcional): só entra quem o backoffice já registou. Sem a
      // env, mantém-se o comportamento histórico — qualquer conta Google cria
      // um utilizador com role `user` (sem permissões relevantes).
      if (LOGIN_RESTRICTED_TO_REGISTERED) {
        const known = (await db.getUserByOpenId(openId)) ?? (email ? await db.getUserByEmail(email) : undefined);
        if (!known) {
          console.warn(`[OAuth] Acesso recusado <${email || "sem email"}> — conta não registada (modo fechado)`);
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
          `[OAuth] Acesso recusado <${email || "sem email"}> — ${account ? "conta desativada" : "conta não encontrada"}`,
        );
        denyAccess(req, res);
        return;
      }

      const sessionToken = await sdk.createSessionToken(openId, {
        name: userInfo.name || "",
        expiresInMs: SESSION_MAX_MS,
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, {
        ...cookieOptions,
        maxAge: SESSION_MAX_MS,
      });

      res.redirect(302, "/");
    } catch (error: any) {
      const msg = error?.message || String(error);
      console.error("[OAuth] Callback failed", error);
      res.status(500).type("html").send(
        renderErrorPage(
          "Falha ao concluir autenticação",
          "Ocorreu um erro ao trocar o código por um token ou ao gravar o utilizador.",
          `${msg}\n\nVerifica:\n• GOOGLE_CLIENT_SECRET está correto no Vercel?\n• DATABASE_URL aponta para uma BD acessível?\n• As tabelas (users) existem? Corre as migrações Drizzle.\n\nDiagnóstico: /api/oauth/_diag · Saúde: /api/health`
        )
      );
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
