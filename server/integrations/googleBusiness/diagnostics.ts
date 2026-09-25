/**
 * Google Business Profile — diagnóstico dos erros da Google e o "Testar" das
 * Integrações, passo a passo, com uma mensagem PT-PT que diz o que fazer.
 *
 * Porque é que o "Testar" falhava (set 2026, "100% de erros" na My Business
 * Account Management API do Google Cloud): as APIs do Business Profile
 * começam com QUOTA 0 em todos os projetos. Enquanto a Google não aprovar o
 * pedido de acesso (formulário "Business Profile API"), cada pedido recebe
 * 429 RESOURCE_EXHAUSTED — no Google Cloud aparece como 100% de erros e o
 * "Testar" (que lista as contas por essa API) falha. Outros casos: API por
 * ativar (403 SERVICE_DISABLED), autorização sem business.manage (403
 * ACCESS_TOKEN_SCOPE_INSUFFICIENT), refresh token revogado (401 /
 * invalid_grant) e conta Google sem perfis (lista vazia).
 *
 * Do corpo do erro só se lê o que é estrutural (código, status, reason,
 * serviço, valor da quota e — nos 400 — os campos recusados). A mensagem
 * livre da Google nunca é guardada.
 */
import { safeError } from "./domain";

export const GBP_ACCESS_FORM_URL = "https://support.google.com/business/contact/api_default";
export const GBP_QUOTA_AFTER_APPROVAL = 300;

export const GBP_APIS: Record<string, { label: string; short: string }> = {
  "mybusinessaccountmanagement.googleapis.com": { label: "My Business Account Management API", short: "Contas" },
  "mybusinessbusinessinformation.googleapis.com": { label: "My Business Business Information API", short: "Perfis e horários" },
  "businessprofileperformance.googleapis.com": { label: "Business Profile Performance API", short: "Desempenho" },
  "mybusiness.googleapis.com": { label: "Google My Business API (v4: críticas e publicações)", short: "Críticas e publicações" },
};
export const apiLabel = (host: string | null | undefined) => (host && GBP_APIS[host]?.label) || String(host || "API do Google Business Profile");

export interface GbpErrorInfo {
  status: number;
  host: string;
  apiStatus: string | null;
  reason: string | null;
  service: string | null;
  quotaLimitValue: string | null;
  quotaMetric: string | null;
  retryAfterSec: number | null;
  fieldViolations: string[];
}

const str = (v: unknown, max = 120) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** Corpo de erro da Google → só os campos estruturais (sem a mensagem livre). PURA. */
export function parseGoogleErrorBody(status: number, host: string, body: unknown, retryAfter?: string | null): GbpErrorInfo {
  const e: any = (body as any)?.error ?? {};
  const details: any[] = Array.isArray(e.details) ? e.details : [];
  const info = details.find((d) => String(d?.["@type"] ?? "").endsWith("google.rpc.ErrorInfo")) ?? {};
  const bad = details.find((d) => String(d?.["@type"] ?? "").endsWith("google.rpc.BadRequest"));
  const meta = info.metadata ?? {};
  const fieldViolations = (Array.isArray(bad?.fieldViolations) ? bad.fieldViolations : [])
    .slice(0, 5)
    .map((v: any) => [str(v?.field, 80), str(v?.description, 160)].filter(Boolean).join(": "))
    .filter(Boolean);
  const ra = retryAfter != null && /^\d{1,4}$/.test(String(retryAfter).trim()) ? Number(retryAfter) : null;
  return {
    status,
    host,
    apiStatus: str(e.status, 40),
    reason: str(info.reason, 60),
    service: str(meta.service, 80) ?? (host.endsWith(".googleapis.com") ? host : null),
    quotaLimitValue: str(meta.quota_limit_value, 20),
    quotaMetric: str(meta.quota_metric, 120),
    retryAfterSec: ra,
    fieldViolations,
  };
}

/** Quota a 0 (projeto sem acesso aprovado)? PURA. */
export function isQuotaZero(i: Pick<GbpErrorInfo, "status" | "quotaLimitValue">): boolean {
  return i.status === 429 && i.quotaLimitValue === "0";
}

/** N.º do projeto Google Cloud a partir do ID do cliente OAuth ("123-abc.apps.googleusercontent.com"). PURA. */
export function projectNumberOfClientId(clientId: string | null | undefined): string | null {
  const m = /^(\d{6,20})-[a-z0-9]+\.apps\.googleusercontent\.com$/i.exec(String(clientId ?? "").trim());
  return m ? m[1] : null;
}

export interface DiagnoseContext { projectNumber?: string | null; accountEmail?: string | null }

/** Mensagem PT-PT com a causa e o passo seguinte, por modo de falha. PURA. */
export function diagnoseGbpError(i: GbpErrorInfo, ctx: DiagnoseContext = {}): string {
  const api = apiLabel(i.service || i.host);
  const proj = ctx.projectNumber ? ` (projeto n.º ${ctx.projectNumber})` : "";
  const who = ctx.accountEmail ? ` ${ctx.accountEmail}` : "";
  if (i.status === 429) {
    if (i.quotaLimitValue && i.quotaLimitValue !== "0") {
      return `${api}: limite de ${i.quotaLimitValue} pedidos por minuto atingido (quota). Tenta daqui a 1 minuto.`;
    }
    const lead = i.quotaLimitValue === "0" ? "quota 0" : "quota esgotada — quase sempre quota 0";
    return `${api}: ${lead}. O projeto Google Cloud${proj} das credenciais OAuth ainda não tem acesso aprovado à API do Business Profile ` +
      `(a Google começa todos os projetos com 0 pedidos/min). Pede acesso em ${GBP_ACCESS_FORM_URL} ("Application for Basic API Access", ` +
      `com o n.º do projeto e o email que gere os perfis); depois da aprovação a quota passa a ${GBP_QUOTA_AFTER_APPROVAL} pedidos/min.`;
  }
  if (i.status === 403) {
    if (i.reason === "SERVICE_DISABLED" || i.reason === "ACCESS_NOT_CONFIGURED" || i.reason === "API_DISABLED") {
      const svc = i.service || i.host;
      return `${api} não está ativa no projeto Google Cloud${proj} das credenciais OAuth. Ativa-a em https://console.cloud.google.com/apis/library/${svc}` +
        `${ctx.projectNumber ? `?project=${ctx.projectNumber}` : ""} e volta a testar daqui a uns minutos.`;
    }
    if (i.reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT") {
      return `${api}: a autorização guardada não inclui a permissão business.manage. Volta a ligar em Críticas → Ligar Google Business Profile e aceita todas as permissões.`;
    }
    if (i.reason === "RATE_LIMIT_EXCEEDED" || i.reason === "RESOURCE_EXHAUSTED") {
      return diagnoseGbpError({ ...i, status: 429 }, ctx);
    }
    return `${api}: acesso recusado. A conta Google ligada${who} tem de ser Proprietária ou Gestora dos perfis (business.google.com → Perfil → Utilizadores), ` +
      `e o projeto${proj} tem de ter o acesso à API do Business Profile aprovado.`;
  }
  if (i.status === 401) return `${api}: autorização inválida ou expirada. Volta a ligar a conta em Críticas → Ligar Google Business Profile.`;
  if (i.status === 404) return `${api}: não encontrado (perfil removido, noutro grupo de empresas ou sem acesso da conta ligada${who}).`;
  if (i.status === 400) return `${api} recusou o pedido${i.fieldViolations.length ? `: ${i.fieldViolations.join("; ")}` : i.reason ? ` (${i.reason})` : ""}.`;
  if (i.status >= 500) return `${api} indisponível (HTTP ${i.status}). Tenta mais tarde.`;
  return `${api}: erro HTTP ${i.status}${i.reason ? ` (${i.reason})` : ""}.`;
}

/** Erro de uma API do Business Profile, já com a mensagem PT-PT. */
export class GbpApiError extends Error {
  constructor(readonly info: GbpErrorInfo, ctx: DiagnoseContext = {}) {
    super(diagnoseGbpError(info, ctx));
    this.name = "GbpApiError";
  }
  get status() { return this.info.status; }
  get quotaZero() { return isQuotaZero(this.info); }
  /** Erro de configuração (quota 0, API por ativar, permissões) — repetir não adianta. */
  get isConfigError() {
    const i = this.info;
    return isQuotaZero(i) || (i.status === 429 && i.quotaLimitValue == null) || i.status === 401 || i.status === 403;
  }
}

// ─── Testar (Integrações) ───────────────────────────────────────────────────

export interface TestStep { api: string; ok: boolean; detail: string }
export interface GbpTestDeps {
  connection: () => Promise<{ status?: string | null; scope?: string | null; accountEmail?: string | null; refreshTokenEnc?: string | null } | null>;
  accessToken: () => Promise<string>;
  client: (token: string) => {
    accounts: () => Promise<{ accounts?: Array<{ name: string }> }>;
    locations: (account: string) => Promise<{ locations?: Array<{ name: string; title?: string }> }>;
    performanceProbe: (location: string) => Promise<unknown>;
    postsProbe: (account: string, location: string) => Promise<unknown>;
  };
  clientId: string | null;
  clientIdSource: "GOOGLE_BUSINESS_CLIENT_ID" | "GOOGLE_ADS_CLIENT_ID" | null;
}

const SCOPE = "https://www.googleapis.com/auth/business.manage";

/** Mensagem de um passo falhado (erros da Google já vêm diagnosticados). */
function stepError(err: unknown, ctx: DiagnoseContext): string {
  if (err instanceof GbpApiError) return err.message;
  const msg = safeError(err);
  if (/invalid_grant/.test(msg)) return "A autorização foi revogada ou expirou (invalid_grant). Volta a ligar em Críticas → Ligar Google Business Profile.";
  if (/invalid_client/.test(msg)) return "Credenciais OAuth recusadas pela Google (invalid_client): confirma GOOGLE_BUSINESS_CLIENT_ID e GOOGLE_BUSINESS_CLIENT_SECRET no Vercel.";
  return `${msg}${ctx.projectNumber ? ` (projeto n.º ${ctx.projectNumber})` : ""}`;
}

/**
 * "Testar" do Google Business Profile, passo a passo: ligação → permissão →
 * token → contas (Account Management) → perfis (Business Information) →
 * desempenho (Performance) → publicações (v4). Pára no 1.º passo que impede
 * os seguintes; nos opcionais (desempenho, publicações) diz o que falta mas
 * continua. Lança com todas as linhas se algum falhar.
 */
export async function testGoogleBusiness(deps: GbpTestDeps): Promise<string> {
  const projectNumber = projectNumberOfClientId(deps.clientId);
  const creds = deps.clientIdSource === "GOOGLE_ADS_CLIENT_ID"
    ? `credenciais OAuth partilhadas com o Google Ads (GOOGLE_ADS_CLIENT_ID${projectNumber ? `, projeto n.º ${projectNumber}` : ""})`
    : `credenciais OAuth GOOGLE_BUSINESS_CLIENT_ID${projectNumber ? ` (projeto n.º ${projectNumber})` : ""}`;
  const conn = await deps.connection();
  const ctx: DiagnoseContext = { projectNumber, accountEmail: conn?.accountEmail ?? null };
  if (!conn?.refreshTokenEnc || conn.status === "disconnected") {
    throw new Error("Não ligado: em Críticas → Ligar Google Business Profile entra com a conta Google que é Proprietária ou Gestora dos perfis da Multipark (a mesma que vês em business.google.com).");
  }
  if (conn.status === "reauth_required") throw new Error(`A autorização de ${conn.accountEmail ?? "a conta"} expirou ou foi revogada. Volta a ligar em Críticas → Ligar Google Business Profile.`);
  if (conn.scope && !conn.scope.split(" ").includes(SCOPE)) throw new Error("A autorização guardada não inclui business.manage. Volta a ligar em Críticas e aceita todas as permissões.");
  const steps: TestStep[] = [];
  const fail = (api: string, err: unknown) => steps.push({ api, ok: false, detail: stepError(err, ctx) });
  const render = () => [`Conta ${conn.accountEmail ?? "?"}; ${creds}.`, ...steps.map((s) => `${s.ok ? "✓" : "✗"} ${s.api}: ${s.detail}`)].join("\n");

  let token: string;
  try { token = await deps.accessToken(); steps.push({ api: "Token", ok: true, detail: "renovado" }); }
  catch (err) { fail("Token", err); throw new Error(render()); }
  const c = deps.client(token);

  let accounts: Array<{ name: string }> = [];
  try {
    accounts = (await c.accounts()).accounts ?? [];
    steps.push({ api: GBP_APIS["mybusinessaccountmanagement.googleapis.com"].label, ok: accounts.length > 0,
      detail: accounts.length ? `${accounts.length} conta(s)` : `a conta ${conn.accountEmail ?? "ligada"} não gere nenhum perfil — liga a conta que é Proprietária/Gestora em business.google.com, ou adiciona-a como Gestora em cada perfil.` });
  } catch (err) { fail(GBP_APIS["mybusinessaccountmanagement.googleapis.com"].label, err); }
  if (!accounts.length) throw new Error(render());

  let first: { account: string; location: string } | null = null;
  let total = 0;
  try {
    for (const a of accounts.slice(0, 5)) {
      const locs = (await c.locations(a.name)).locations ?? [];
      total += locs.length;
      if (!first && locs[0]) first = { account: a.name, location: locs[0].name };
    }
    steps.push({ api: GBP_APIS["mybusinessbusinessinformation.googleapis.com"].label, ok: total > 0,
      detail: total ? `${total} perfil(is)${accounts.length > 5 ? " (5 primeiras contas)" : ""}` : "nenhum perfil nas contas desta conta Google — confirma que os perfis dos parques estão no mesmo grupo de empresas (business.google.com) e que esta conta é Gestora." });
  } catch (err) { fail(GBP_APIS["mybusinessbusinessinformation.googleapis.com"].label, err); }
  if (first) {
    try { await c.performanceProbe(first.location); steps.push({ api: GBP_APIS["businessprofileperformance.googleapis.com"].label, ok: true, detail: "OK" }); }
    catch (err) { fail(GBP_APIS["businessprofileperformance.googleapis.com"].label, err); }
    try { await c.postsProbe(first.account, first.location); steps.push({ api: GBP_APIS["mybusiness.googleapis.com"].label, ok: true, detail: "OK" }); }
    catch (err) { fail(GBP_APIS["mybusiness.googleapis.com"].label, err); }
  }
  if (steps.some((s) => !s.ok)) throw new Error(render());
  return render();
}
