/**
 * Estado das integrações (Definições → Integrações). Diz só SE está
 * configurada (sim/não + nomes das variáveis em falta) — NUNCA o valor dos
 * segredos. "Testar ligação" só existe onde há um teste barato e sem efeitos:
 *   - Base de dados: SELECT 1;
 *   - SMTP: ligação + autenticação (transporter.verify — não envia nada);
 *   - IMAP: ligação + autenticação + logout (não lê emails);
 *   - WhatsApp: GET do número (Graph API);
 *   - Meta Ads: GET /me com o token (Graph API).
 * As mensagens de erro passam por `scrubSecrets` antes de sair.
 */
import { sql } from "drizzle-orm";

type Env = Record<string, string | undefined>;

export interface IntegrationStatus {
  id: string;
  label: string;
  description: string;
  configured: boolean;
  missing: string[];
  testable: boolean;
  /** Estado da ligação OAuth guardada (Google Ads / Business), se houver. */
  connection?: { status: string; lastCheckedAt: string | null; hasError: boolean } | null;
}

const has = (env: Env, k: string) => !!String(env[k] ?? "").trim();

interface Def {
  id: string;
  label: string;
  description: string;
  /** Grupos "qualquer um destes" (todos os grupos obrigatórios). */
  require: string[][];
  testable?: boolean;
  provider?: string;
}

const DEFS: Def[] = [
  { id: "database", label: "Base de dados", description: "MySQL principal.", require: [["DATABASE_URL"]], testable: true },
  { id: "multipark", label: "API Multipark", description: "Reservas dos parques (chave geral ou por parque).", require: [["MULTIPARK_API_KEY", "MULTIPARK_API_KEY_LISBON_AIRPARK", "MULTIPARK_API_KEY_FARO_AIRPARK", "MULTIPARK_API_KEY_LISBON_REDPARK", "MULTIPARK_API_KEY_LISBON_SKYPARK"]] },
  { id: "multipark_webhook", label: "Webhook Multipark", description: "Reservas em tempo real (assinatura HMAC).", require: [["MULTIPARK_WEBHOOK_SECRET"]] },
  { id: "cron", label: "Crons (GitHub Actions)", description: "Segredo partilhado com os workflows.", require: [["CRON_SECRET"]] },
  { id: "google_login", label: "Login Google", description: "Entrada na aplicação com conta Google.", require: [["GOOGLE_CLIENT_ID"], ["GOOGLE_CLIENT_SECRET"], ["JWT_SECRET"]] },
  { id: "google_ads", label: "Google Ads", description: "Métricas de anúncios (OAuth).", require: [["GOOGLE_ADS_CLIENT_ID"], ["GOOGLE_ADS_CLIENT_SECRET"]], provider: "google_ads" },
  { id: "google_business", label: "Google Business Profile", description: "Críticas Google (OAuth).", require: [["GOOGLE_BUSINESS_CLIENT_ID", "GOOGLE_ADS_CLIENT_ID"], ["GOOGLE_BUSINESS_CLIENT_SECRET", "GOOGLE_ADS_CLIENT_SECRET"]], provider: "google_business" },
  { id: "meta_ads", label: "Meta Ads", description: "Métricas Facebook/Instagram (só leitura).", require: [["META_ACCESS_TOKEN"], ["META_AD_ACCOUNT_IDS"]], testable: true },
  { id: "whatsapp", label: "WhatsApp (Cloud API)", description: "Envio de mensagens e templates.", require: [["WHATSAPP_TOKEN"], ["WHATSAPP_PHONE_NUMBER_ID"]], testable: true },
  { id: "whatsapp_webhook", label: "Webhook WhatsApp", description: "Mensagens recebidas (verificação + assinatura).", require: [["WHATSAPP_VERIFY_TOKEN"], ["WHATSAPP_APP_SECRET"]] },
  { id: "smtp", label: "Email de saída (SMTP)", description: "Emails enviados pela aplicação.", require: [["SMTP_HOST"], ["SMTP_USER"], ["SMTP_PASS"]], testable: true },
  { id: "imap", label: "Email de entrada (IMAP)", description: "Leitura da caixa reservas@ (reclamações, perdidos…).", require: [["IMAP_USER"], ["IMAP_PASS"]], testable: true },
  { id: "llm", label: "IA (LLM)", description: "Resumos, classificação e preenchimento automático.", require: [["LLM_API_KEY", "OPENAI_API_KEY"], ["LLM_API_URL", "OPENAI_API_URL"]] },
  { id: "zello", label: "Zello", description: "Rádio e GPS dos condutores.", require: [["ZELLO_API_KEY"], ["ZELLO_USERNAME"], ["ZELLO_PASSWORD"]] },
  { id: "storage", label: "Armazenamento de ficheiros", description: "S3 ou Vercel Blob.", require: [["BLOB_READ_WRITE_TOKEN", "AWS_S3_BUCKET_NAME"]] },
  { id: "google_maps", label: "Google Maps", description: "Mapas e moradas.", require: [["GOOGLE_MAPS_API_KEY"]] },
];

/** Variáveis em falta (um nome por grupo "qualquer um destes"). PURA. */
export function missingEnvs(require: string[][], env: Env): string[] {
  return require.filter((group) => !group.some((k) => has(env, k))).map((group) => group.join(" ou "));
}

/** Estado estático (só env). PURA — nunca devolve valores. */
export function integrationStatusesFromEnv(env: Env = process.env): IntegrationStatus[] {
  return DEFS.map((d) => {
    const missing = missingEnvs(d.require, env);
    return { id: d.id, label: d.label, description: d.description, configured: missing.length === 0, missing, testable: !!d.testable };
  });
}

/** Tira de uma mensagem qualquer valor de segredo presente na env. PURA. */
export function scrubSecrets(message: string, env: Env = process.env): string {
  let out = String(message ?? "");
  const secretish = /(KEY|TOKEN|SECRET|PASS|PASSWORD|DATABASE_URL)/;
  for (const [k, v] of Object.entries(env)) {
    if (!v || v.length < 6 || !secretish.test(k)) continue;
    out = out.split(v).join("***");
  }
  // Credenciais em URLs (user:pass@host) e tokens em query strings.
  out = out.replace(/\/\/[^/@\s:]+:[^/@\s]+@/g, "//***:***@").replace(/(access_token=)[^&\s]+/gi, "$1***");
  return out.slice(0, 300);
}

export async function listIntegrationStatuses(): Promise<IntegrationStatus[]> {
  const list = integrationStatusesFromEnv();
  try {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (db) {
      const res = await db.execute(sql`
        SELECT provider, status, DATE_FORMAT(lastCheckedAt, '%Y-%m-%d %H:%i:%s') AS lastCheckedAt,
               (lastError IS NOT NULL AND lastError <> '') AS hasError
          FROM integration_connections`);
      const rows = (Array.isArray(res) ? res[0] : res) as unknown as any[];
      const byProvider = new Map((rows ?? []).map((r: any) => [String(r.provider), r]));
      for (const s of list) {
        const provider = DEFS.find((d) => d.id === s.id)?.provider;
        if (!provider) continue;
        const r = byProvider.get(provider);
        s.connection = r ? { status: String(r.status), lastCheckedAt: r.lastCheckedAt ? String(r.lastCheckedAt) : null, hasError: Number(r.hasError) === 1 } : null;
      }
    }
  } catch { /* só o estado da env */ }
  return list;
}

export interface TestResult { ok: boolean; message: string; ms: number }

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`Sem resposta em ${ms / 1000}s`)), ms); })]);
  } finally {
    if (t) clearTimeout(t);
  }
}

async function graphGet(path: string, token: string): Promise<any> {
  const r = await fetch(`https://graph.facebook.com${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const body: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error?.message ? `Meta: ${body.error.message}` : `HTTP ${r.status}`);
  return body;
}

export async function testIntegration(id: string): Promise<TestResult> {
  const started = Date.now();
  const env = process.env;
  const def = DEFS.find((d) => d.id === id);
  if (!def || !def.testable) return { ok: false, message: "Esta integração não tem teste de ligação.", ms: 0 };
  const missing = missingEnvs(def.require, env);
  if (missing.length) return { ok: false, message: `Não configurada (falta ${missing.join(", ")}).`, ms: 0 };
  try {
    let message = "Ligação OK.";
    await withTimeout((async () => {
      switch (id) {
        case "database": {
          const { getDb } = await import("./db");
          const db = await getDb();
          if (!db) throw new Error("Sem ligação à base de dados.");
          await db.execute(sql`SELECT 1`);
          break;
        }
        case "smtp": {
          const { createTransport } = await import("nodemailer");
          const port = parseInt(env.SMTP_PORT || "587", 10);
          const t = createTransport({ host: env.SMTP_HOST, port, secure: port === 465, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } });
          try { await t.verify(); } finally { t.close(); }
          message = "Servidor SMTP aceitou a autenticação (nada foi enviado).";
          break;
        }
        case "imap": {
          const { ImapFlow } = await import("imapflow");
          const client = new ImapFlow({
            host: env.IMAP_HOST || "imap.gmail.com",
            port: Number(env.IMAP_PORT || 993),
            secure: true,
            auth: { user: env.IMAP_USER!, pass: env.IMAP_PASS! },
            logger: false,
          });
          await client.connect();
          await client.logout().catch(() => undefined);
          message = "Caixa IMAP aceitou a autenticação (nenhum email lido).";
          break;
        }
        case "whatsapp": {
          const version = (env.WHATSAPP_API_VERSION || "v21.0").trim();
          const b = await graphGet(`/${version}/${encodeURIComponent(env.WHATSAPP_PHONE_NUMBER_ID!.trim())}?fields=display_phone_number,verified_name`, env.WHATSAPP_TOKEN!.trim());
          message = `Número ${b.display_phone_number ?? "?"}${b.verified_name ? ` (${b.verified_name})` : ""} acessível.`;
          break;
        }
        case "meta_ads": {
          const { readMetaConfig } = await import("./integrations/meta/config");
          const cfg = readMetaConfig(env);
          await graphGet(`/${cfg.apiVersion}/me?fields=id`, cfg.accessToken!);
          message = `Token válido (${cfg.accountIds.length} conta(s) configurada(s)).`;
          break;
        }
        default:
          throw new Error("Sem teste.");
      }
    })(), 12_000);
    return { ok: true, message, ms: Date.now() - started };
  } catch (err: any) {
    return { ok: false, message: scrubSecrets(String(err?.message ?? err), env) || "Falhou.", ms: Date.now() - started };
  }
}
