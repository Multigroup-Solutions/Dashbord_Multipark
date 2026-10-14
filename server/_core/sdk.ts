import { ACCESS_DENIED_MSG, COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { ForbiddenError } from "@shared/_core/errors";
import { parse as parseCookieHeader } from "cookie";
import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import type { User } from "../../drizzle/schema";
import * as db from "../db";
import { ENV } from "./env";
import { shouldTouchLastSignedIn } from "./lastSignedIn";
import { isPdaNonce } from "@shared/pdaSession";
import type { GoogleTokenResponse, GoogleUserInfo } from "./types/oauthTypes";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export type SessionPayload = {
  openId: string;
  appId: string;
  name: string;
  /** Versão da sessão (users.sessionVersion) no momento do login; ausente = 0. */
  sv?: number;
  /** Plano 56 (A2): sessão de PDA — o PDA e o nonce que tem de estar em `pdas.sessionNonce`. */
  pda?: number;
  pn?: string;
  /** Plano 05 (F3): a sessão do be-shared (conta Multipark) — revalidada no máximo de 5 em 5 min. */
  ss?: string;
};

/** O que vem num cookie de sessão válido (assinatura e forma). */
export type VerifiedSession = {
  openId: string; appId: string; name: string; sv: number;
  /** Sessão de PDA (A2) ou null. */
  pda: number | null; pn: string | null;
  /** Fim do cookie (segundos, `exp` do JWT) ou null. */
  exp: number | null;
  /** Plano 05: sessão do be-shared ou null (cookies antigos e de PDA não têm). */
  ss: string | null;
};

/** O cookie ainda vale para a versão atual da conta? (cookies antigos sem `sv` = 0). PURA. */
export function sessionVersionMatches(cookieVersion: number | undefined | null, userVersion: number | undefined | null): boolean {
  return (cookieVersion ?? 0) === (userVersion ?? 0);
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

class OAuthService {
  /**
   * Exchange authorization code for Google tokens
   */
  async exchangeCodeForToken(
    code: string,
    redirectUri: string
  ): Promise<GoogleTokenResponse> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured");
    }

    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Google token exchange failed: ${response.status} ${error}`);
    }

    return (await response.json()) as GoogleTokenResponse;
  }

  /**
   * Get user profile from Google using access token
   */
  async getUserInfo(accessToken: string): Promise<GoogleUserInfo> {
    const response = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error(`Google userinfo failed: ${response.status}`);
    }

    return (await response.json()) as GoogleUserInfo;
  }
}

class SDKServer {
  private readonly oauthService: OAuthService;

  constructor() {
    this.oauthService = new OAuthService();
  }

  async exchangeCodeForToken(code: string, redirectUri: string) {
    return this.oauthService.exchangeCodeForToken(code, redirectUri);
  }

  async getUserInfo(accessToken: string) {
    return this.oauthService.getUserInfo(accessToken);
  }

  private parseCookies(cookieHeader: string | undefined) {
    if (!cookieHeader) return new Map<string, string>();
    const parsed = parseCookieHeader(cookieHeader);
    return new Map(Object.entries(parsed));
  }

  private getSessionSecret() {
    const secret = ENV.cookieSecret;
    if (!secret) throw new Error("JWT_SECRET is not configured");
    return new TextEncoder().encode(secret);
  }

  /**
   * Create a session token for a user openId
   */
  async createSessionToken(
    openId: string,
    options: { expiresInMs?: number; name?: string; sessionVersion?: number; pda?: { id: number; nonce: string } | null; sharedSessionId?: string | null } = {}
  ): Promise<string> {
    return this.signSession(
      {
        openId,
        appId: ENV.appId,
        name: options.name || "",
        sv: options.sessionVersion ?? 0,
        ...(options.pda ? { pda: options.pda.id, pn: options.pda.nonce } : {}),
        ...(options.sharedSessionId ? { ss: options.sharedSessionId } : {}),
      },
      options
    );
  }

  async signSession(
    payload: SessionPayload,
    options: { expiresInMs?: number } = {}
  ): Promise<string> {
    const issuedAt = Date.now();
    const expiresInMs = options.expiresInMs ?? ONE_YEAR_MS;
    const expirationSeconds = Math.floor((issuedAt + expiresInMs) / 1000);
    const secretKey = this.getSessionSecret();

    return new SignJWT({
      openId: payload.openId,
      appId: payload.appId,
      name: payload.name,
      sv: payload.sv ?? 0,
      ...(payload.pda != null && payload.pn ? { pda: payload.pda, pn: payload.pn } : {}),
      ...(payload.ss ? { ss: payload.ss } : {}),
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setExpirationTime(expirationSeconds)
      .sign(secretKey);
  }

  async verifySession(
    cookieValue: string | undefined | null
  ): Promise<VerifiedSession | null> {
    if (!cookieValue) return null;

    try {
      const secretKey = this.getSessionSecret();
      const { payload } = await jwtVerify(cookieValue, secretKey, {
        algorithms: ["HS256"],
      });
      const { openId, appId, name, sv, pda, pn, exp, ss } = payload as Record<string, unknown>;

      if (!isNonEmptyString(openId) || !isNonEmptyString(appId) || !isNonEmptyString(name)) {
        return null;
      }

      const version = typeof sv === "number" && Number.isInteger(sv) && sv >= 0 ? sv : 0;
      // Sessão de PDA (A2): os dois juntos e bem formados; meio cookie de PDA não vale.
      const hasPda = pda !== undefined || pn !== undefined;
      if (hasPda && !(typeof pda === "number" && Number.isSafeInteger(pda) && pda > 0 && isPdaNonce(pn))) return null;
      return {
        openId, appId, name, sv: version,
        pda: hasPda ? (pda as number) : null, pn: hasPda ? (pn as string) : null,
        exp: typeof exp === "number" ? exp : null,
        ss: typeof ss === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(ss) ? ss : null,
      };
    } catch {
      return null;
    }
  }

  /** Os dados do cookie de sessão deste pedido (sem ir à BD), ou null. */
  async sessionOf(req: Request): Promise<VerifiedSession | null> {
    return this.verifySession(this.parseCookies(req.headers.cookie).get(COOKIE_NAME));
  }

  async authenticateRequest(req: Request): Promise<User> {
    const cookies = this.parseCookies(req.headers.cookie);
    const sessionCookie = cookies.get(COOKIE_NAME);
    const session = await this.verifySession(sessionCookie);

    if (!session) {
      throw ForbiddenError("Invalid session cookie");
    }

    let user = await db.getUserByOpenId(session.openId);

    if (!user) {
      throw ForbiddenError(ACCESS_DENIED_MSG);
    }

    // Conta desativada perde o acesso IMEDIATAMENTE, mesmo com cookie válido —
    // a sessão dura 30 dias e não pode sobreviver a uma desativação. Mesma
    // mensagem do login recusado (ver ACCESS_DENIED_MSG).
    if (user.isActive !== 1) {
      throw ForbiddenError(ACCESS_DENIED_MSG);
    }

    // "Terminar todas as sessões" sobe users.sessionVersion: os cookies
    // emitidos antes deixam de valer (sessão inválida → volta ao login).
    if (!sessionVersionMatches(session.sv, (user as { sessionVersion?: number }).sessionVersion)) {
      throw ForbiddenError("Invalid session cookie");
    }

    // Plano 05 (F3): sessão aberta com a conta Multipark — o be-shared ainda a
    // aceita? (de 5 em 5 min no máximo; falha aberta se o be-shared não responder).
    if (session.ss) {
      const { sharedSessionStillValid } = await import("../sharedSessionCheck");
      if (!(await sharedSessionStillValid(session.ss))) {
        throw ForbiddenError(ACCESS_DENIED_MSG);
      }
    }

    // Plano 56 (A2): sessão de PDA — só vale enquanto o nonce em `pdas` for o
    // do cookie (outra entrada, logout, saída do ponto e fecho automático
    // limpam-no) e até 16 h. Também para contas sem ficha. Cookies sem PDA
    // (todos os de hoje) nem vão à BD.
    if (session.pda != null) {
      const { pdaSessionStillValid } = await import("../pdaSession");
      if (!(await pdaSessionStillValid({ pdaId: session.pda, nonce: session.pn, userId: user.id }))) {
        throw ForbiddenError("Invalid session cookie");
      }
    }

    // No máximo uma escrita a cada 5 min (antes: um UPDATE por pedido).
    if (shouldTouchLastSignedIn(user.lastSignedIn)) {
      await db.upsertUser({
        openId: user.openId,
        lastSignedIn: new Date().toISOString().slice(0, 19).replace("T", " "),
      });
    }

    return user;
  }
}

export const sdk = new SDKServer();
