/**
 * Google Workspace — base comum (Fase 1): configuração, clientes OAuth por
 * utilizador e service account com delegação ao nível do domínio (DWD),
 * sempre pelas bibliotecas OFICIAIS (google-auth-library + @googleapis/gmail)
 * e sempre com prazo (fetchWithTimeout como `fetchImplementation` do gaxios).
 *
 * Variáveis (servidor):
 *   GOOGLE_WORKSPACE_CLIENT_ID / _SECRET  cliente OAuth (ecrã de consentimento
 *                                         "Internal"); omissão: GOOGLE_CLIENT_ID/SECRET do login
 *   GOOGLE_WORKSPACE_REDIRECT_URI         omissão: <APP_URL>/api/google-account/oauth/callback
 *   GOOGLE_WORKSPACE_DOMAINS              domínios aceites (claim `hd`), ex.: "multipark.pt"
 *   GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON conta de serviço com DWD (JSON cru ou base64);
 *                                         omissão: GOOGLE_SERVICE_ACCOUNT_JSON
 *   GOOGLE_WORKSPACE_ADMIN_SUBJECT        conta a impersonar quando a caixa não diz qual (opcional)
 */
import { CodeChallengeMethod, JWT, OAuth2Client } from "google-auth-library";
import { gmail as gmailFactory, type gmail_v1 } from "@googleapis/gmail";
import { fetchWithTimeout } from "../_core/fetchWithTimeout";
import { parseServiceAccount } from "../_core/ai/client";
import { GOOGLE_FEATURE_SCOPES, parseDomainList, type GoogleFeature } from "../../shared/mail";

type Env = Record<string, string | undefined>;

/** Prazo de cada pedido às APIs Google (o cron tem 45 s no total). */
export const GOOGLE_API_TIMEOUT_MS = 20_000;
export const GOOGLE_ACCOUNT_CALLBACK_PATH = "/api/google-account/oauth/callback";
export const GOOGLE_ACCOUNT_START_PATH = "/api/google-account/oauth/start";
export const GOOGLE_USER_PROVIDER = "google_user";

const clean = (v: string | undefined) => (v ?? "").trim();

export interface WorkspaceConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  domains: string[];
  serviceAccount: { client_email: string; private_key: string } | null;
  adminSubject: string | null;
}

function appOrigin(env: Env): string {
  return (clean(env.APP_URL) || clean(env.PUBLIC_APP_URL) || "https://dashboard.multipark.pt").replace(/\/+$/, "");
}

/** Configuração (PURA sobre o env). */
export function workspaceConfig(env: Env = process.env): WorkspaceConfig {
  const sa = parseServiceAccount(env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON || env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const email = typeof sa?.client_email === "string" ? sa.client_email : "";
  const key = typeof sa?.private_key === "string" ? sa.private_key : "";
  return {
    clientId: clean(env.GOOGLE_WORKSPACE_CLIENT_ID) || clean(env.GOOGLE_CLIENT_ID),
    clientSecret: clean(env.GOOGLE_WORKSPACE_CLIENT_SECRET) || clean(env.GOOGLE_CLIENT_SECRET),
    redirectUri: clean(env.GOOGLE_WORKSPACE_REDIRECT_URI) || `${appOrigin(env)}${GOOGLE_ACCOUNT_CALLBACK_PATH}`,
    domains: parseDomainList(env.GOOGLE_WORKSPACE_DOMAINS || "multipark.pt"),
    serviceAccount: email && key ? { client_email: email, private_key: key } : null,
    adminSubject: clean(env.GOOGLE_WORKSPACE_ADMIN_SUBJECT).toLowerCase() || null,
  };
}

export function oauthConfigured(env: Env = process.env): boolean {
  const c = workspaceConfig(env);
  return !!(c.clientId && c.clientSecret);
}
export function dwdConfigured(env: Env = process.env): boolean {
  return !!workspaceConfig(env).serviceAccount;
}

/** `fetch` com prazo para o gaxios (todas as chamadas Google passam aqui). */
export function timedFetch(timeoutMs = GOOGLE_API_TIMEOUT_MS): typeof fetch {
  return ((input: any, init?: any) => fetchWithTimeout(input, { ...(init ?? {}), timeoutMs })) as typeof fetch;
}

const transporterOptions = () => ({ fetchImplementation: timedFetch(), timeout: GOOGLE_API_TIMEOUT_MS });

/** Cliente OAuth (sem credenciais) para o consentimento/troca do código. */
export function newOAuthClient(cfg: WorkspaceConfig = workspaceConfig()): OAuth2Client {
  if (!cfg.clientId || !cfg.clientSecret) throw new Error("Cliente OAuth Google em falta (GOOGLE_WORKSPACE_CLIENT_ID/SECRET ou GOOGLE_CLIENT_ID/SECRET).");
  return new OAuth2Client({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri: cfg.redirectUri, transporterOptions: transporterOptions() });
}

/** Âmbitos a pedir: identidade + os das funcionalidades (autorização incremental). PURA. */
export function scopesFor(features: readonly GoogleFeature[]): string[] {
  const out = new Set<string>(["openid", "email", "profile"]);
  for (const f of features) for (const s of GOOGLE_FEATURE_SCOPES[f]) out.add(s);
  return Array.from(out);
}

/** URL de consentimento (PKCE S256 + state + hd + incremental). */
export function consentUrl(client: OAuth2Client, opts: { state: string; codeChallenge: string; features: readonly GoogleFeature[]; loginHint?: string | null; hd?: string | null }): string {
  return client.generateAuthUrl({
    access_type: "offline",
    // "consent" garante refresh_token; include_granted_scopes = autorização incremental.
    prompt: "consent",
    include_granted_scopes: true,
    scope: scopesFor(opts.features),
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
    ...(opts.hd ? { hd: opts.hd } : {}),
    ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
  });
}

/** Cliente OAuth de um utilizador (refresh token já decifrado). */
export function userAuthClient(refreshToken: string, cfg: WorkspaceConfig = workspaceConfig()): OAuth2Client {
  const c = newOAuthClient(cfg);
  c.setCredentials({ refresh_token: refreshToken });
  return c;
}

/** Service account a impersonar `subject` (DWD) com os âmbitos dados. */
export function delegatedClient(subject: string, scopes: readonly string[], cfg: WorkspaceConfig = workspaceConfig()): JWT {
  if (!cfg.serviceAccount) throw new Error("Conta de serviço Google em falta (GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON ou GOOGLE_SERVICE_ACCOUNT_JSON).");
  return new JWT({
    email: cfg.serviceAccount.client_email,
    key: cfg.serviceAccount.private_key,
    scopes: [...scopes],
    subject,
    transporterOptions: transporterOptions(),
  });
}

/** API Gmail v1 (oficial) com o cliente de autenticação dado. */
export function gmailFor(auth: OAuth2Client | JWT): gmail_v1.Gmail {
  return gmailFactory({ version: "v1", auth, timeout: GOOGLE_API_TIMEOUT_MS, fetchImplementation: timedFetch() });
}

/**
 * Erro de autorização definitiva (revogada/expirada/sem delegação)? Lê o
 * código do gaxios (`response.data.error`) ou a mensagem. PURA.
 */
export function isAuthRevokedError(err: unknown): boolean {
  const e = err as any;
  const code = String(e?.response?.data?.error ?? e?.code ?? "");
  const msg = String(e?.message ?? "");
  return /invalid_grant|unauthorized_client|invalid_client/.test(code) || /invalid_grant|unauthorized_client|invalid_client/.test(msg);
}

/** HTTP status de um erro do gaxios (ou null). PURA. */
export function httpStatusOf(err: unknown): number | null {
  const e = err as any;
  const s = Number(e?.response?.status ?? e?.status ?? (typeof e?.code === "number" ? e.code : NaN));
  return Number.isFinite(s) ? s : null;
}

/** Mensagem curta para a UI/registos — sem tokens. PURA. */
export function googleErrorMessage(err: unknown): string {
  const e = err as any;
  const data = e?.response?.data;
  const detail = typeof data?.error === "object" ? data.error?.message : (data?.error_description ?? data?.error);
  return String(detail || e?.message || err).replace(/ya29\.[\w.-]+/g, "ya29…").replace(/1\/\/[\w.-]+/g, "1//…").slice(0, 300);
}
