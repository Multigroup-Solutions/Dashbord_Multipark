/**
 * Cliente do be-shared (a autenticação do grupo — a "conta Multipark"). Plano 05
 * (docs/integration/05-dashboard-auth-unificada.md).
 *
 *  - Só servidor → servidor. O browser nunca vê tokens do be-shared.
 *  - Credencial de serviço PRÓPRIA do dashboard (`SHARED_AUTH_SERVICE_TOKEN`), com
 *    âmbitos (users.lookup, users.create, sessions.status) — NUNCA o SERVICE_TOKEN
 *    do be-multipark (esse dá service-login a qualquer conta, admins incluídos).
 *  - `X-Client-Name: dashboard` → o be-shared dá às sessões do dashboard a
 *    duração das apps (30 dias), não a do site (7).
 *  - Palavra-passe: as apps do grupo mandam `btoa(password)` e o be-shared guarda
 *    bcrypt disso — o dashboard tem de fazer igual, senão ninguém entra.
 *  - Nunca regista corpos de pedido nem tokens; nos logs só ids e o domínio do email.
 */
import { fetchWithTimeout, FetchTimeoutError } from "./fetchWithTimeout";

export type SharedAuthErrorCode =
  | "not_configured"
  | "invalid_credentials"
  | "account_deactivated"
  | "not_found"
  | "conflict"
  | "invalid_token"
  | "rate_limited"
  | "bad_request"
  | "forbidden"
  | "unavailable";

export class SharedAuthError extends Error {
  constructor(readonly code: SharedAuthErrorCode, readonly status?: number, message?: string) {
    super(message ?? code);
    this.name = "SharedAuthError";
  }
}

/** O que o dashboard usa de um utilizador do be-shared (sem IBAN/NIF/telefone). */
export interface SharedUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
  /** null = email por confirmar; undefined = be-shared antigo (não diz). */
  emailVerifiedAt: string | null | undefined;
}

export interface SharedSession {
  user: SharedUser;
  sessionId: string | null;
  refreshToken: string | null;
  accessToken: string | null;
}

/** Quem está a entrar (vai em X-Client-IP / X-Client-User-Agent com a credencial de serviço). */
export interface ClientMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export interface SharedAuthConfig {
  url: string;
  serviceToken: string;
  timeoutMs: number;
}

export function sharedAuthConfig(env: Record<string, string | undefined> = process.env): SharedAuthConfig | null {
  const url = String(env.SHARED_AUTH_URL ?? "").trim().replace(/\/+$/, "");
  const serviceToken = String(env.SHARED_AUTH_SERVICE_TOKEN ?? "").trim();
  if (!url || !serviceToken) return null;
  const t = Number.parseInt(env.SHARED_AUTH_TIMEOUT_MS ?? "", 10);
  return { url, serviceToken, timeoutMs: Number.isFinite(t) && t > 0 ? t : 8000 };
}

/** Igual ao `btoa(password)` das apps (UTF-8 → base64). PURA. */
export function encodeSharedPassword(password: string): string {
  return Buffer.from(password, "utf8").toString("base64");
}

/** "ana@gmail.com" → "gmail.com" (para logs). PURA. */
export const emailDomain = (email: string | null | undefined): string => String(email ?? "").split("@")[1] ?? "?";

/** Só os campos de que o dashboard precisa — nunca guarda o resto. PURA. */
export function pickSharedUser(raw: any): SharedUser | null {
  const u = raw && typeof raw === "object" ? raw : null;
  if (!u || typeof u.id !== "string" || typeof u.email !== "string") return null;
  return {
    id: u.id,
    email: String(u.email).trim().toLowerCase(),
    firstName: typeof u.firstName === "string" ? u.firstName : "",
    lastName: typeof u.lastName === "string" ? u.lastName : "",
    isActive: u.isActive !== false,
    emailVerifiedAt: u.emailVerifiedAt === undefined ? undefined : (typeof u.emailVerifiedAt === "string" ? u.emailVerifiedAt : null),
  };
}

export const sharedDisplayName = (u: Pick<SharedUser, "firstName" | "lastName" | "email">): string =>
  `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email;

type FetchFn = (input: any, init?: any) => Promise<Response>;

interface RequestOpts {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  service?: boolean;
  meta?: ClientMeta;
}

/** Erro HTTP → código. PURA. */
export function mapStatus(status: number, body: any): SharedAuthErrorCode {
  const code = typeof body?.code === "string" ? body.code : "";
  if (status === 401) return code.includes("TOKEN") ? "invalid_token" : "invalid_credentials";
  if (status === 403) return code === "SERVICE_SCOPE_DENIED" ? "forbidden" : "account_deactivated";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "bad_request";
  return "unavailable";
}

export function createSharedAuthClient(config: SharedAuthConfig | null = sharedAuthConfig(), fetchImpl: FetchFn = fetch) {
  async function request<T>(opts: RequestOpts): Promise<{ status: number; data: T }> {
    if (!config) throw new SharedAuthError("not_configured");
    const headers: Record<string, string> = { "Content-Type": "application/json", "X-Client-Name": "dashboard" };
    if (opts.service || opts.meta) headers["X-Service-Token"] = config.serviceToken;
    if (opts.meta?.ip) headers["X-Client-IP"] = String(opts.meta.ip).slice(0, 64);
    if (opts.meta?.userAgent) headers["X-Client-User-Agent"] = String(opts.meta.userAgent).slice(0, 400);
    let res: Response;
    try {
      res = await fetchWithTimeout(`${config.url}${opts.path}`, {
        method: opts.method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        timeoutMs: config.timeoutMs,
      }, fetchImpl);
    } catch (err) {
      const why = err instanceof FetchTimeoutError ? "timeout" : "rede";
      console.warn(`[SharedAuth] ${opts.method} ${opts.path.split("/").slice(0, 4).join("/")} indisponível (${why})`);
      throw new SharedAuthError("unavailable");
    }
    let data: any = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const code = mapStatus(res.status, data);
      if (code === "unavailable") console.warn(`[SharedAuth] ${opts.method} ${opts.path.split("/").slice(0, 4).join("/")} → ${res.status}`);
      throw new SharedAuthError(code, res.status);
    }
    return { status: res.status, data: data as T };
  }

  const sessionOf = (data: any): SharedSession => {
    const user = pickSharedUser(data?.user);
    if (!user) throw new SharedAuthError("unavailable", 200, "resposta sem utilizador");
    return {
      user,
      sessionId: typeof data?.sessionId === "string" ? data.sessionId : null,
      refreshToken: typeof data?.refreshToken === "string" ? data.refreshToken : null,
      accessToken: typeof data?.token === "string" ? data.token : null,
    };
  };

  return {
    configured: !!config,

    /** Email + palavra-passe da conta Multipark (cria uma sessão no be-shared). */
    async passwordLogin(email: string, password: string, meta?: ClientMeta): Promise<SharedSession> {
      const { data } = await request<any>({
        method: "POST", path: "/api/auth/login", meta: meta ?? {},
        body: { email: email.trim().toLowerCase(), password: encodeSharedPassword(password) },
      });
      return sessionOf(data);
    },

    /** ID token Google (o mesmo client OAuth tem de estar em GOOGLE_AUTH_CLIENT_IDS do be-shared). */
    async googleLogin(idToken: string, allowCreate: boolean, meta?: ClientMeta): Promise<SharedSession> {
      const { data } = await request<any>({ method: "POST", path: "/api/auth/google", meta: meta ?? {}, body: { credential: idToken, allowCreate } });
      return sessionOf(data);
    },

    /** Termina a sessão do be-shared (sempre 200 lá; aqui nunca lança). */
    async logout(session: Pick<SharedSession, "refreshToken" | "accessToken">): Promise<void> {
      if (!config || (!session.refreshToken && !session.accessToken)) return;
      try {
        await fetchWithTimeout(`${config.url}/api/auth/logout`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Client-Name": "dashboard", ...(session.accessToken ? { Authorization: `Bearer ${session.accessToken}` } : {}) },
          body: JSON.stringify(session.refreshToken ? { refreshToken: session.refreshToken } : {}),
          timeoutMs: config.timeoutMs,
        }, fetchImpl);
      } catch { /* a sessão expira sozinha */ }
    },

    /** users.lookup — null se não existir. */
    async userByEmail(email: string): Promise<SharedUser | null> {
      try {
        const { data } = await request<any>({ method: "GET", path: `/api/getUserByEmail/${encodeURIComponent(email.trim().toLowerCase())}`, service: true });
        return pickSharedUser(data);
      } catch (err) {
        if (err instanceof SharedAuthError && err.code === "not_found") return null;
        throw err;
      }
    },

    /** users.lookup — null se não existir. */
    async userById(id: string): Promise<SharedUser | null> {
      try {
        const { data } = await request<any>({ method: "GET", path: `/api/getUser/${encodeURIComponent(id)}`, service: true });
        return pickSharedUser(data?.user);
      } catch (err) {
        if (err instanceof SharedAuthError && err.code === "not_found") return null;
        throw err;
      }
    },

    /** users.create — encontra ou cria (conta nova sem palavra-passe utilizável). */
    async createAccount(input: { email: string; firstName: string; lastName: string; sendSetPasswordEmail: boolean; lang?: string }): Promise<{ user: SharedUser; created: boolean; setPasswordEmailSent: boolean }> {
      const { data } = await request<any>({ method: "POST", path: "/api/users/service-create", service: true, body: input });
      const user = pickSharedUser(data?.user);
      if (!user) throw new SharedAuthError("unavailable", 200, "resposta sem utilizador");
      return { user, created: data?.created === true, setPasswordEmailSent: data?.setPasswordEmailSent === true };
    },

    /** sessions.end — termina uma sessão aberta pelo dashboard (logout). Nunca lança. */
    async endSession(sessionId: string | null | undefined): Promise<boolean> {
      if (!config || !sessionId) return false;
      try {
        const { data } = await request<{ ended?: number }>({ method: "POST", path: "/api/auth/sessions/service-end", service: true, body: { sessionId } });
        return Number(data?.ended ?? 0) > 0;
      } catch {
        return false;
      }
    },

    /** sessions.status — os ids ATIVOS (sessão viva e conta ativa) de entre os pedidos. */
    async activeSessions(sessionIds: string[]): Promise<Set<string>> {
      if (sessionIds.length === 0) return new Set();
      const { data } = await request<{ active?: unknown }>({ method: "POST", path: "/api/auth/sessions/status", service: true, body: { sessionIds } });
      return new Set(Array.isArray(data?.active) ? data.active.filter((x): x is string => typeof x === "string") : []);
    },
  };
}

export type SharedAuthClient = ReturnType<typeof createSharedAuthClient>;

let client: SharedAuthClient | null = null;
/** Cliente com a configuração do ambiente (lido na 1.ª chamada). */
export function sharedAuth(): SharedAuthClient {
  if (!client) client = createSharedAuthClient();
  return client;
}
