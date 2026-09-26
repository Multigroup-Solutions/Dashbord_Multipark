/**
 * Estado das integrações — fonte do hub /integracoes (e do resumo em
 * Definições → Integrações). Diz só SE está configurada (sim/não + nomes das
 * variáveis em falta) — NUNCA o valor dos segredos. Por integração junta:
 *   - estado da ligação guardada (integration_connections: Google Ads, Meta,
 *     Google Business, WhatsApp);
 *   - última recolha com sucesso e último erro (integration_sync_runs para
 *     Google Ads/Meta; cron_runs para IMAP, Zello, Multipark, Google Business);
 *   - avisos (chave de cifra derivada do JWT_SECRET, LLM_MODEL por omissão…);
 *   - ligações para as páginas de gestão.
 * "Testar" só existe onde há um teste barato e sem efeitos:
 *   - Base de dados: SELECT 1;
 *   - SMTP: ligação + autenticação (transporter.verify — não envia nada);
 *   - IMAP: ligação + autenticação + logout (não lê emails);
 *   - WhatsApp: GET do número (Graph API);
 *   - Meta Ads: GET /me com o token (Graph API);
 *   - Google Ads: renova o access token + listAccessibleCustomers;
 *   - Google Business: token → contas → perfis → desempenho → publicações,
 *     com o diagnóstico de cada falha (quota 0, API por ativar, religar…);
 *   - Zello: gettoken + login;
 *   - LLM: uma chamada de 1 token.
 *   - Google Analytics 4 / Search Console: lê cada propriedade configurada
 *     (pedido mínimo) e diz quais a conta de serviço não consegue ler;
 *   - PageSpeed: uma análise móvel da 1.ª página configurada;
 *   - Chrome UX Report: dados reais da origem da 1.ª página (telemóvel).
 * As mensagens de erro passam por `scrubSecrets` antes de sair.
 */
import { sql } from "drizzle-orm";

type Env = Record<string, string | undefined>;

export interface IntegrationLink { label: string; href: string }

export interface IntegrationStatus {
  id: string;
  label: string;
  description: string;
  configured: boolean;
  missing: string[];
  testable: boolean;
  group: "main" | "system";
  links: IntegrationLink[];
  /** Estado da ligação guardada (Google Ads / Meta / Business / WhatsApp), se houver. */
  connection?: { status: string; lastCheckedAt: string | null; hasError: boolean } | null;
  /** Última recolha/corrida com sucesso ("AAAA-MM-DD HH:MM:SS", UTC). */
  lastSyncAt?: string | null;
  /** Último erro conhecido (já sem segredos, curto). */
  lastError?: string | null;
  warnings?: string[];
}

const has = (env: Env, k: string) => !!String(env[k] ?? "").trim();

interface Def {
  id: string;
  label: string;
  description: string;
  /** Grupos "qualquer um destes" (todos os grupos obrigatórios). */
  require: string[][];
  testable?: boolean;
  /** linha em integration_connections */
  provider?: string;
  /** integration_sync_runs.provider (última recolha "done") */
  syncProvider?: string;
  /** cron_runs.name (última corrida OK / último erro) */
  cron?: string;
  group: "main" | "system";
  links: IntegrationLink[];
}

const DEFS: Def[] = [
  // ── principais (uma cartão cada no hub) ──
  { id: "google_ads", label: "Google Ads", description: "Métricas de anúncios (OAuth, só leitura).", require: [["GOOGLE_ADS_CLIENT_ID"], ["GOOGLE_ADS_CLIENT_SECRET"]], provider: "google_ads", syncProvider: "google_ads", cron: "google-ads", testable: true, group: "main",
    links: [{ label: "Gerir ligação, contas e recolha", href: "/integracoes/google-ads" }, { label: "Marketing", href: "/marketing" }] },
  { id: "meta_ads", label: "Meta Ads", description: "Métricas Facebook/Instagram (só leitura).", require: [["META_ACCESS_TOKEN"], ["META_AD_ACCOUNT_IDS"]], provider: "meta", syncProvider: "meta", cron: "meta-ads", testable: true, group: "main",
    links: [{ label: "Gerir contas e recolha", href: "/integracoes/google-ads#meta" }] },
  { id: "google_business", label: "Google Business Profile", description: "Críticas Google e resposta pelo dashboard; desempenho dos perfis (impressões, chamadas, direções, pesquisas), horários e publicações no Marketing → Web & SEO (OAuth business.manage). O Testar verifica cada API (contas, perfis, desempenho, publicações) e diz o que falta (quota 0 → pedir acesso; API por ativar; religar).", require: [["GOOGLE_BUSINESS_CLIENT_ID", "GOOGLE_ADS_CLIENT_ID"], ["GOOGLE_BUSINESS_CLIENT_SECRET", "GOOGLE_ADS_CLIENT_SECRET"]], provider: "google_business", cron: "google-business", testable: true, group: "main",
    links: [{ label: "Ligação e perfis (Críticas)", href: "/criticas#google-business" }, { label: "Desempenho, horários e publicações", href: "/marketing/web?sec=google-business" }] },
  { id: "whatsapp", label: "WhatsApp (Cloud API)", description: "Envio de mensagens e templates.", require: [["WHATSAPP_TOKEN"], ["WHATSAPP_PHONE_NUMBER_ID"]], provider: "whatsapp", testable: true, group: "main",
    links: [{ label: "WhatsApp", href: "/whatsapp" }] },
  { id: "whatsapp_calls", label: "WhatsApp — Chamadas", description: "Chamadas de voz do WhatsApp no dashboard (Business Calling API): receber no browser e devolver chamadas com autorização do cliente. O Testar lê as definições de chamadas do número (ativas, horário, pedido de autorização) e confirma se o campo \"calls\" está subscrito no webhook da app Meta.", require: [["WHATSAPP_TOKEN"], ["WHATSAPP_PHONE_NUMBER_ID"]], testable: true, group: "main",
    links: [{ label: "Chamadas (WhatsApp)", href: "/whatsapp?chamadas=1" }] },
  { id: "imap", label: "Email de entrada (IMAP)", description: "Leitura da caixa reservas@ (reclamações, perdidos…).", require: [["IMAP_USER"], ["IMAP_PASS"]], cron: "email-inbound", testable: true, group: "main",
    links: [{ label: "Estado do cron", href: "/definicoes" }] },
  { id: "gmail", label: "Gmail (Comunicação)", description: "Caixas de email partilhadas lidas e enviadas pela API do Gmail (conta de serviço com delegação no Workspace).", require: [["GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON", "GOOGLE_SERVICE_ACCOUNT_JSON"]], cron: "mail-sync", testable: true, group: "main",
    links: [{ label: "Caixas (Definições → Comunicação)", href: "/definicoes" }, { label: "Comunicação", href: "/comunicacao" }] },
  { id: "google_sync", label: "Google Tarefas & Calendário", description: "Tarefas atribuídas ↔ lista \"Multipark\" do Google Tasks (nos dois sentidos) e calendário \"Multipark\" de cada pessoa (turnos, passagens de turno, formação, prazos, SLAs); calendários partilhados da escala por cidade (opcional, delegação); reuniões com Meet.", require: [["GOOGLE_WORKSPACE_CLIENT_ID", "GOOGLE_CLIENT_ID"], ["GOOGLE_WORKSPACE_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET"]], cron: "google-sync", testable: true, group: "main",
    links: [{ label: "Perfil → Google", href: "/perfil" }, { label: "Calendários partilhados (Definições → Comunicação)", href: "/definicoes" }] },
  { id: "google_contacts", label: "Google Contactos (People API)", description: "Diretório da empresa (conta de serviço com delegação, 1×/dia), grupo \"Multipark — Serviço\" no telemóvel de condutores/TL (clientes de hoje e amanhã, apagados depois da retenção) e sugestões a partir dos contactos Google de cada pessoa.", require: [["GOOGLE_WORKSPACE_CLIENT_ID", "GOOGLE_CLIENT_ID"], ["GOOGLE_WORKSPACE_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET"]], cron: "google-sync", testable: true, group: "main",
    links: [{ label: "Contactos", href: "/contactos" }, { label: "Contactos Google (Definições → Comunicação)", href: "/definicoes" }] },
  { id: "google_drive", label: "Google Drive / Docs / Sheets", description: "Anexar do Drive e \"Guardar no Drive\" (cada pessoa, só drive.file), documentos gerados a partir de modelos Google Docs, \"Exportar para Sheets\", importação de folhas e Shared Drive \"Multipark\" da empresa (delegação: pastas por registo, espelho de documentos, relatórios ao vivo).", require: [["GOOGLE_WORKSPACE_CLIENT_ID", "GOOGLE_CLIENT_ID"], ["GOOGLE_WORKSPACE_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET"]], cron: "google-sync", testable: true, group: "main",
    links: [{ label: "Perfil → Google", href: "/perfil" }, { label: "Google Drive (Definições → Comunicação)", href: "/definicoes" }] },
  { id: "knowledge_base", label: "Base de conhecimento (manuais do Drive)", description: "Pastas do Shared Drive (ex.: Formação/, Procedimentos/) sincronizadas de hora a hora para a base de conhecimento usada pelo tutor da formação, pelo assistente e pela pesquisa global; ficheiros carregados na app. Precisa do Shared Drive configurado (Definições → Comunicação → Google Drive).", require: [["GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON", "GOOGLE_SERVICE_ACCOUNT_JSON"]], cron: "knowledge-sync", group: "main",
    links: [{ label: "Base de conhecimento", href: "/formacao/conhecimento" }, { label: "Google Drive (Definições → Comunicação)", href: "/definicoes" }] },
  { id: "google_analytics", label: "Google Analytics 4", description: "Tráfego dos sites por dia (sessões, canais, páginas de entrada, dispositivos, funil) no Marketing → Web & SEO. A conta de serviço é adicionada como Leitor em cada propriedade GA4 (sem delegação).", require: [["GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON", "GOOGLE_SERVICE_ACCOUNT_JSON"]], cron: "web-analytics", testable: true, group: "main",
    links: [{ label: "Web & SEO (Marketing)", href: "/marketing/web" }, { label: "Propriedades (Definições → Integrações)", href: "/definicoes" }] },
  { id: "search_console", label: "Search Console", description: "Cliques, impressões, posição, pesquisas e páginas do Google orgânico no Marketing → Web & SEO. A conta de serviço é adicionada como utilizador em cada propriedade.", require: [["GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON", "GOOGLE_SERVICE_ACCOUNT_JSON"]], cron: "web-analytics", testable: true, group: "main",
    links: [{ label: "Web & SEO (Marketing)", href: "/marketing/web" }, { label: "Propriedades (Definições → Integrações)", href: "/definicoes" }] },
  { id: "pagespeed", label: "PageSpeed Insights", description: "Velocidade das páginas principais (móvel e computador) 1×/semana. Funciona sem chave com quota baixa; GOOGLE_PAGESPEED_API_KEY opcional.", require: [], cron: "web-analytics", testable: true, group: "main",
    links: [{ label: "Web & SEO (Marketing)", href: "/marketing/web" }] },
  { id: "crux", label: "Chrome UX Report (CrUX)", description: "Dados reais dos visitantes Chrome (p75 de LCP, INP, CLS, FCP e TTFB, 28 dias) por origem e por página, telemóvel e computador, 1×/semana ao lado da PageSpeed. Precisa de chave de API (GOOGLE_PAGESPEED_API_KEY ou GOOGLE_CRUX_API_KEY) com a \"Chrome UX Report API\" ativa.", require: [["GOOGLE_PAGESPEED_API_KEY", "GOOGLE_CRUX_API_KEY"]], cron: "web-analytics", testable: true, group: "main",
    links: [{ label: "Velocidade (Web & SEO)", href: "/marketing/web?sec=velocidade" }] },
  { id: "google_account", label: "Contas Google dos utilizadores", description: "\"Ligar a minha conta Google\" (OAuth interno do Workspace) para \"O meu email\".", require: [["GOOGLE_WORKSPACE_CLIENT_ID", "GOOGLE_CLIENT_ID"], ["GOOGLE_WORKSPACE_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET"]], group: "main",
    links: [{ label: "Perfil", href: "/perfil" }] },
  { id: "smtp", label: "Email de saída (SMTP)", description: "Emails enviados pela aplicação e alertas ao dono.", require: [["SMTP_HOST"], ["SMTP_USER"], ["SMTP_PASS"]], testable: true, group: "main", links: [] },
  { id: "zello", label: "Zello", description: "Rádio e GPS dos condutores (recolha diária).", require: [["ZELLO_API_KEY"], ["ZELLO_USERNAME"], ["ZELLO_PASSWORD"]], cron: "daily-ops", testable: true, group: "main",
    links: [{ label: "Estado do cron (daily-ops)", href: "/definicoes" }] },
  { id: "llm", label: "IA (Gemini)", description: "Faturas, críticas, rádio, passagem de turno, WhatsApp e formação (server/_core/ai).", require: [["GEMINI_API_KEY", "GOOGLE_CLOUD_PROJECT", "LLM_API_KEY", "OPENAI_API_KEY"]], testable: true, group: "main",
    links: [{ label: "Interruptores e custo (Definições)", href: "/definicoes" }] },
  { id: "multipark", label: "API Multipark", description: "Reservas dos parques (chave geral ou por parque).", require: [["MULTIPARK_API_KEY", "MULTIPARK_API_KEY_LISBON_AIRPARK", "MULTIPARK_API_KEY_FARO_AIRPARK", "MULTIPARK_API_KEY_LISBON_REDPARK", "MULTIPARK_API_KEY_LISBON_SKYPARK"]], cron: "multipark-sync", group: "main",
    links: [{ label: "Sincronização", href: "/multipark/sync" }] },
  { id: "storage", label: "Armazenamento de ficheiros", description: "S3 ou Vercel Blob.", require: [["BLOB_READ_WRITE_TOKEN", "AWS_S3_BUCKET_NAME"]], group: "main", links: [] },
  // ── sistema ──
  { id: "database", label: "Base de dados", description: "MySQL principal.", require: [["DATABASE_URL"]], testable: true, group: "system", links: [] },
  { id: "multipark_webhook", label: "Webhook Multipark", description: "Reservas em tempo real (assinatura HMAC).", require: [["MULTIPARK_WEBHOOK_SECRET"]], group: "system", links: [] },
  { id: "cron", label: "Crons (GitHub Actions)", description: "Segredo partilhado com os workflows.", require: [["CRON_SECRET"]], group: "system", links: [{ label: "Estado do sistema", href: "/definicoes" }] },
  { id: "google_login", label: "Login Google", description: "Entrada na aplicação com conta Google.", require: [["GOOGLE_CLIENT_ID"], ["GOOGLE_CLIENT_SECRET"], ["JWT_SECRET"]], group: "system", links: [] },
  { id: "whatsapp_webhook", label: "Webhook WhatsApp", description: "Mensagens recebidas (verificação + assinatura).", require: [["WHATSAPP_VERIFY_TOKEN"], ["WHATSAPP_APP_SECRET"]], group: "system", links: [] },
];

/** Variáveis em falta (um nome por grupo "qualquer um destes"). PURA. */
export function missingEnvs(require: string[][], env: Env): string[] {
  return require.filter((group) => !group.some((k) => has(env, k))).map((group) => group.join(" ou "));
}

/** Estado estático (só env). PURA — nunca devolve valores. */
export function integrationStatusesFromEnv(env: Env = process.env): IntegrationStatus[] {
  return DEFS.map((d) => {
    const missing = missingEnvs(d.require, env);
    return { id: d.id, label: d.label, description: d.description, configured: missing.length === 0, missing, testable: !!d.testable, group: d.group, links: d.links, warnings: [] };
  });
}

/** Tira de uma mensagem qualquer valor de segredo presente na env. PURA. */
export function scrubSecrets(message: string, env: Env = process.env, max = 300): string {
  let out = String(message ?? "");
  const secretish = /(KEY|TOKEN|SECRET|PASS|PASSWORD|DATABASE_URL)/;
  for (const [k, v] of Object.entries(env)) {
    if (!v || v.length < 6 || !secretish.test(k)) continue;
    out = out.split(v).join("***");
  }
  // Credenciais em URLs (user:pass@host) e tokens em query strings.
  out = out.replace(/\/\/[^/@\s:]+:[^/@\s]+@/g, "//***:***@").replace(/(access_token=)[^&\s]+/gi, "$1***");
  return out.slice(0, max);
}

/**
 * Origem da chave que cifra os tokens guardados (refresh tokens Google).
 * "derived" = derivada do JWT_SECRET (rodar o JWT_SECRET invalida as ligações)
 * → aviso no hub. PURA.
 */
export function encryptionKeyStatus(env: Env = process.env): { source: "env" | "derived" | "none" | "invalid"; warning: string | null } {
  const raw = env.INTEGRATIONS_ENCRYPTION_KEY;
  if (raw) {
    return Buffer.from(raw, "base64").length === 32
      ? { source: "env", warning: null }
      : { source: "invalid", warning: "INTEGRATIONS_ENCRYPTION_KEY inválida (tem de ser 32 bytes em base64: openssl rand -base64 32)." };
  }
  if (env.JWT_SECRET) return { source: "derived", warning: "INTEGRATIONS_ENCRYPTION_KEY não definida: os tokens guardados estão cifrados com uma chave derivada do JWT_SECRET — mudar o JWT_SECRET obriga a religar Google Ads e Google Business." };
  return { source: "none", warning: "Sem chave de cifra (INTEGRATIONS_ENCRYPTION_KEY nem JWT_SECRET): não é possível guardar ligações OAuth." };
}

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const oneLine = (s: unknown) => scrubSecrets(String(s ?? "").replace(/\s+/g, " ").trim()).slice(0, 240) || null;

export async function listIntegrationStatuses(env: Env = process.env): Promise<IntegrationStatus[]> {
  const list = integrationStatusesFromEnv(env);
  const byId = new Map(list.map((s) => [s.id, s]));
  const defOf = (id: string) => DEFS.find((d) => d.id === id)!;

  // Avisos que só dependem da env / do código
  const key = encryptionKeyStatus(env);
  if (key.warning) for (const id of ["google_ads", "google_business"]) byId.get(id)?.warnings?.push(key.warning);
  try {
    const { aiStatus } = await import("./_core/ai/status");
    const llm = byId.get("llm");
    const st = aiStatus(env);
    if (llm) llm.configured = st.provider != null;
    if (llm?.configured) llm.warnings!.push(...st.warnings);
    if (llm?.configured && st.provider === "legacy") {
      const { llmModelStatus } = await import("./_core/llm");
      const m = llmModelStatus(env);
      if (m.warning) llm.warnings!.push(m.warning);
    }
  } catch { /* indicador */ }

  try {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) return list;

    const connRes = await db.execute(sql`
      SELECT provider, status, DATE_FORMAT(lastCheckedAt, '%Y-%m-%d %H:%i:%s') AS lastCheckedAt, lastError
        FROM integration_connections`);
    const conns = new Map(rowsOf(connRes).map((r: any) => [String(r.provider), r]));

    // Última recolha "done" e última execução terminada por fornecedor (sem colunas soltas no GROUP BY).
    const syncOkRes = await db.execute(sql`
      SELECT provider, DATE_FORMAT(MAX(finishedAt), '%Y-%m-%d %H:%i:%s') AS lastOk
        FROM integration_sync_runs WHERE status = 'done' GROUP BY provider`);
    const syncLastRes = await db.execute(sql`
      SELECT r.provider AS provider, r.status AS status, r.error AS error
        FROM integration_sync_runs r
        JOIN (SELECT provider, MAX(id) AS mx FROM integration_sync_runs WHERE finishedAt IS NOT NULL GROUP BY provider) m ON m.mx = r.id`);
    const syncOk = new Map(rowsOf(syncOkRes).map((r: any) => [String(r.provider), r.lastOk ? String(r.lastOk) : null]));
    const syncLast = new Map(rowsOf(syncLastRes).map((r: any) => [String(r.provider), r]));

    const cronNames = DEFS.map((d) => d.cron).filter((c): c is string => !!c);
    const cronOkRes = await db.execute(sql`
      SELECT name, DATE_FORMAT(MAX(finishedAt), '%Y-%m-%d %H:%i:%s') AS lastOk
        FROM cron_runs WHERE ok = 1 AND name IN (${sql.join(cronNames.map((n) => sql`${n}`), sql`, `)}) GROUP BY name`);
    const cronLastRes = await db.execute(sql`
      SELECT r.name AS name, r.ok AS ok, r.error AS error
        FROM cron_runs r
        JOIN (SELECT name, MAX(id) AS mx FROM cron_runs WHERE finishedAt IS NOT NULL AND name IN (${sql.join(cronNames.map((n) => sql`${n}`), sql`, `)}) GROUP BY name) m ON m.mx = r.id`);
    const cronOk = new Map(rowsOf(cronOkRes).map((r: any) => [String(r.name), r.lastOk ? String(r.lastOk) : null]));
    const cronLast = new Map(rowsOf(cronLastRes).map((r: any) => [String(r.name), r]));

    for (const s of list) {
      const d = defOf(s.id);
      if (d.provider) {
        const r = conns.get(d.provider);
        s.connection = r ? { status: String(r.status), lastCheckedAt: r.lastCheckedAt ? String(r.lastCheckedAt) : null, hasError: !!(r.lastError && String(r.lastError).trim()) } : null;
        if (r?.lastError) s.lastError = oneLine(r.lastError);
      }
      if (d.syncProvider) {
        s.lastSyncAt = syncOk.get(d.syncProvider) ?? null;
        const last = syncLast.get(d.syncProvider);
        if (!s.lastError && last && last.status !== "done" && last.error) s.lastError = oneLine(last.error);
      }
      if (d.cron) {
        if (!s.lastSyncAt) s.lastSyncAt = cronOk.get(d.cron) ?? null;
        const last = cronLast.get(d.cron);
        if (!s.lastError && last && Number(last.ok) === 0 && last.error) s.lastError = oneLine(last.error);
      }
      if (d.id === "google_business" && !s.lastSyncAt && s.connection?.lastCheckedAt) s.lastSyncAt = s.connection.lastCheckedAt;
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
  const { fetchWithTimeout } = await import("./_core/fetchWithTimeout");
  const r = await fetchWithTimeout(`https://graph.facebook.com${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const body: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (Number(body?.error?.code) === 190 && path.includes(String(process.env.WHATSAPP_PHONE_NUMBER_ID ?? "\u0000"))) {
      const { recordWhatsappAuthError } = await import("./integrations/whatsappConnection");
      await recordWhatsappAuthError(String(body?.error?.message ?? "token"));
    }
    throw new Error(body?.error?.message ? `Meta: ${body.error.message}` : `HTTP ${r.status}`);
  }
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
        case "google_sync": {
          const { testGoogleSync } = await import("./google/syncService");
          message = await testGoogleSync();
          break;
        }
        case "google_contacts": {
          const { testGoogleContacts } = await import("./google/contactsService");
          message = await testGoogleContacts();
          break;
        }
        case "google_drive": {
          const { testGoogleDrive } = await import("./google/driveService");
          message = await testGoogleDrive();
          break;
        }
        case "google_analytics":
        case "search_console": {
          const { accessCheckMessage, checkWebAccess } = await import("./webAnalytics/service");
          const kind = id === "google_analytics" ? "ga" : "sc";
          message = accessCheckMessage(kind, await checkWebAccess(kind === "ga" ? { ga: true } : { sc: true }));
          break;
        }
        case "pagespeed": {
          const { testPagespeed } = await import("./webAnalytics/service");
          message = await testPagespeed();
          break;
        }
        case "gmail": {
          const { listMailboxes } = await import("./mail/store");
          const { sourceAccountKey } = await import("../shared/mail");
          const keys = Array.from(new Set((await listMailboxes({ fresh: true })).filter((m) => m.active && m.sourceKind === "dwd").map((m) => sourceAccountKey(m)).filter((k): k is string => !!k)));
          // Sem caixas ainda: testa a delegação com GOOGLE_WORKSPACE_ADMIN_SUBJECT (se houver).
          const { workspaceConfig } = await import("./google/workspace");
          const subject = workspaceConfig(env).adminSubject;
          if (!keys.length && subject) keys.push(`dwd:${subject}`);
          if (!keys.length) throw new Error("Nenhuma caixa partilhada configurada (Definições → Comunicação) nem GOOGLE_WORKSPACE_ADMIN_SUBJECT.");
          const { gmailApiForAccount } = await import("./mail/gmailApi");
          const api = await gmailApiForAccount(keys[0]);
          const p = await api.getProfile();
          const oc = workspaceConfig(env);
          const oauth = oc.clientSource ? ` "Ligar a minha conta Google" usa ${oc.clientSource} (…${oc.clientId.split(".")[0].slice(-8)}); URI de redirecionamento: ${oc.redirectUri}.` : "";
          message = `Ligação OK (${p.emailAddress ?? keys[0]}; ${keys.length} conta(s) de origem).${oauth}`;
          break;
        }
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
          const t = createTransport({ host: env.SMTP_HOST, port, secure: port === 465, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS }, connectionTimeout: 15_000 });
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
            connectionTimeout: 15_000,
          });
          await client.connect();
          await client.logout().catch(() => undefined);
          message = "Caixa IMAP aceitou a autenticação (nenhum email lido).";
          break;
        }
        case "whatsapp": {
          const { whatsappApiVersion } = await import("./whatsapp");
          const b = await graphGet(`/${whatsappApiVersion(env)}/${encodeURIComponent(env.WHATSAPP_PHONE_NUMBER_ID!.trim())}?fields=display_phone_number,verified_name`, env.WHATSAPP_TOKEN!.trim());
          message = `Número ${b.display_phone_number ?? "?"}${b.verified_name ? ` (${b.verified_name})` : ""} acessível.`;
          const { recordWhatsappSuccess } = await import("./integrations/whatsappConnection");
          await recordWhatsappSuccess();
          break;
        }
        case "whatsapp_calls": {
          const { testWhatsappCalling } = await import("./whatsappCallsDiagnostics");
          message = await testWhatsappCalling(env);
          break;
        }
        case "meta_ads": {
          const { readMetaConfig } = await import("./integrations/meta/config");
          const cfg = readMetaConfig(env);
          await graphGet(`/${cfg.apiVersion}/me?fields=id`, cfg.accessToken!);
          message = `Token válido (${cfg.accountIds.length} conta(s) configurada(s)).`;
          break;
        }
        case "google_ads": {
          const { getAccessToken } = await import("./integrations/googleAds/oauth");
          const { listAccessibleCustomers } = await import("./integrations/googleAds/client");
          await getAccessToken({ forceRefresh: true });
          const ids = await listAccessibleCustomers();
          message = `Token renovado; ${ids.length} conta(s) acessível(is) pela API.`;
          break;
        }
        case "google_business": {
          // Passo a passo (token → contas → perfis → desempenho → publicações),
          // com a causa exata e o que fazer (quota 0, API por ativar, religar…).
          const { accessToken, connection } = await import("./integrations/googleBusiness/oauth");
          const { BusinessClient } = await import("./integrations/googleBusiness/client");
          const { config } = await import("./integrations/googleBusiness/config");
          const { testGoogleBusiness, projectNumberOfClientId } = await import("./integrations/googleBusiness/diagnostics");
          const { addDays } = await import("../shared/lisbonDay");
          const { lisbonToday } = await import("../shared/expensePeriods");
          const c = config();
          const conn = await connection();
          const ctx = { projectNumber: projectNumberOfClientId(c.clientId), accountEmail: conn?.accountEmail ?? null };
          const day = addDays(lisbonToday(), -7);
          message = await testGoogleBusiness({
            connection: async () => conn,
            accessToken,
            client: (token) => {
              const bc = new BusinessClient(token, { context: ctx, timeoutMs: 8_000 });
              return {
                accounts: () => bc.accounts(),
                locations: (account) => bc.locations(account, "", "name,title"),
                performanceProbe: (location) => bc.performance(location, day, day),
                postsProbe: (account, location) => bc.listPosts(account, location, 1),
              };
            },
            clientId: c.clientId || null,
            clientIdSource: env.GOOGLE_BUSINESS_CLIENT_ID?.trim() ? "GOOGLE_BUSINESS_CLIENT_ID" : env.GOOGLE_ADS_CLIENT_ID?.trim() ? "GOOGLE_ADS_CLIENT_ID" : null,
          });
          break;
        }
        case "crux": {
          const { testCrux } = await import("./webAnalytics/service");
          message = await testCrux();
          break;
        }
        case "zello": {
          const { testZelloLogin } = await import("./zello");
          await testZelloLogin();
          message = "Zello aceitou o login (nenhum dado lido).";
          break;
        }
        case "llm": {
          const { testAi } = await import("./_core/ai/status");
          const r = await testAi();
          message = `IA respondeu (${r.provider}, modelo ${r.model}).`;
          break;
        }
        default:
          throw new Error("Sem teste.");
      }
    })(), id === "llm" || id === "pagespeed" ? 50_000 : id === "google_analytics" || id === "search_console" || id === "google_business" || id === "whatsapp_calls" ? 30_000 : 20_000);
    return { ok: true, message, ms: Date.now() - started };
  } catch (err: any) {
    const { isAiError, aiErrorCode } = await import("./_core/ai/errors");
    if (isAiError(err)) return { ok: false, message: `${err.userMessage} (${aiErrorCode(err)})`, ms: Date.now() - started };
    // Diagnósticos passo a passo (Google Business) são mais longos: até 1200 caracteres.
    return { ok: false, message: scrubSecrets(String(err?.message ?? err), env, 1200) || "Falhou.", ms: Date.now() - started };
  }
}
