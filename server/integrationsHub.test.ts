import { afterEach, describe, expect, it, vi } from "vitest";
import { cronOutcome, CRON_JOBS } from "../shared/appSettings";
import { safeRedirectPath } from "./integrations/googleAds/config";
import { identityChanged, identityFromIdToken } from "./integrations/googleAds/oauth";
import { errorCodeOf } from "./integrations/googleAds/client";
import { attributionFromUrl, isMetaPaidUtm } from "./integrations/googleAds/attribution";
import { countsInEurTotals, summarizeCurrencyExclusions } from "../shared/marketingRules";
import { isMetaRetryable, metaGetJson, MetaApiError } from "./integrations/meta/insights";
import { readMetaConfig } from "./integrations/meta/config";
import { fetchWithTimeout, FetchTimeoutError } from "./_core/fetchWithTimeout";
import { shouldOpenComplaint, shouldStopPaging } from "./integrations/googleBusiness/domain";
import { runAdsSync, type AdsAccountRef, type AdsSyncStore, type ChunkPayload, type RunPatch } from "./integrations/adsSyncRunner";
import { runMetaAdsSync } from "./integrations/meta/sync";
import { alertMessage, alertTransition, connectionAlertState } from "./integrations/alerts";
import { llmErrorMessage, llmModelStatus } from "./_core/llm";
import { escapeHtml } from "./_core/notification";
import { encryptionKeyStatus, integrationStatusesFromEnv } from "./integrationsStatus";
import { CAMPAIGN_SUGGEST_PROVIDERS, suggestCampaignProjects, type ProjectNode } from "../shared/adCampaignMapping";
import { whatsappApiVersion } from "./whatsapp";
import { isWhatsappTokenError } from "./integrations/whatsappConnection";

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

// ─── 1. Crons honestos ──────────────────────────────────────────────────────

describe("cronOutcome lê reason, errors[] e warnings", () => {
  it("skipped com motivo é verde mas deixa nota", () => {
    expect(cronOutcome(200, { ok: true, status: "skipped", skipped: "not_connected", reason: "Google Ads não está ligado" }))
      .toEqual({ ok: true, error: null, note: "saltado: not_connected — Google Ads não está ligado" });
    expect(cronOutcome(200, { ok: true, skipped: "reauth_required" }).note).toContain("reauth_required");
  });
  it("avisos ficam na nota; erros de itens com ok:true explícito também", () => {
    const r = cronOutcome(200, { ok: true, warnings: ["a", "b"], errors: ["email 1 falhou"] });
    expect(r.ok).toBe(true);
    expect(r.note).toContain("2 aviso(s)");
    expect(r.note).toContain("email 1 falhou");
  });
  it("errors[] sem ok explícito = falha; reason vira a mensagem quando não há error", () => {
    expect(cronOutcome(200, { errors: ["x", "y"] })).toEqual({ ok: false, error: "x | y" });
    expect(cronOutcome(200, { ok: false, reason: "2 de 3 conta(s) falharam" })).toEqual({ ok: false, error: "2 de 3 conta(s) falharam" });
    expect(cronOutcome(200, { ok: false, error: "boom", reason: "outra" }).error).toBe("boom");
  });
  it("mantém o comportamento antigo", () => {
    expect(cronOutcome(200, { ok: true })).toEqual({ ok: true, error: null });
    expect(cronOutcome(503, undefined)).toEqual({ ok: false, error: "HTTP 503" });
    expect(cronOutcome(200, { ok: true, stepErrors: ["RH: x"] })).toEqual({ ok: false, error: "RH: x" });
  });
  it("todos os /api/cron/* agendados têm entrada com intervalo (incl. evaluation-recompute)", () => {
    const names = CRON_JOBS.map((j) => j.name);
    for (const n of ["evaluation-recompute", "daily-ops", "google-ads", "meta-ads", "google-business", "mail-sync", "extras-auto", "identity-sweep", "multipark-sync", "multipark-future", "multipark-deliveries"]) {
      expect(names).toContain(n);
    }
    expect(CRON_JOBS.find((j) => j.name === "evaluation-recompute")?.intervalMinutes).toBe(1440);
  });
});

// ─── 7. Segurança: redirectTo, identidade Google, HTML ──────────────────────

describe("redirectTo do OAuth Google Ads", () => {
  it("aceita só caminhos relativos da app", () => {
    expect(safeRedirectPath("/integracoes/google-ads")).toBe("/integracoes/google-ads");
    expect(safeRedirectPath("/marketing?tab=roas")).toBe("/marketing?tab=roas");
  });
  it.each(["//evil.example/x", "/\\evil.example", "https://evil.example", "javascript:alert(1)", "evil", "", "/a\nb", "/a\\b", null, 42])("recusa %s", (v) => {
    expect(safeRedirectPath(v as any)).toBeNull();
  });
});

describe("identidade Google (religar com outra conta limpa as contas)", () => {
  const tok = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
  it("lê o email (ou o sub) do id_token", () => {
    expect(identityFromIdToken(tok({ email: "Jorge@Multipark.pt", sub: "1" }))).toBe("jorge@multipark.pt");
    expect(identityFromIdToken(tok({ sub: "123" }))).toBe("sub:123");
    expect(identityFromIdToken("lixo")).toBeNull();
    expect(identityFromIdToken(undefined)).toBeNull();
  });
  it("só conta como mudança com as duas identidades conhecidas e diferentes", () => {
    expect(identityChanged("a@x.pt", "b@x.pt")).toBe(true);
    expect(identityChanged("A@x.pt", "a@x.pt")).toBe(false);
    expect(identityChanged(null, "a@x.pt")).toBe(false);
    expect(identityChanged("a@x.pt", null)).toBe(false);
  });
});

describe("notifyOwner: HTML escapado", () => {
  it("escapa marcação", () => {
    expect(escapeHtml(`<img src=x onerror="a">&'`)).toBe("&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;");
  });
});

describe("chave de cifra das integrações", () => {
  it("dedicada / derivada do JWT_SECRET (aviso) / inválida / nenhuma", () => {
    expect(encryptionKeyStatus({ INTEGRATIONS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") })).toEqual({ source: "env", warning: null });
    expect(encryptionKeyStatus({ JWT_SECRET: "x" }).source).toBe("derived");
    expect(encryptionKeyStatus({ JWT_SECRET: "x" }).warning).toMatch(/JWT_SECRET/);
    expect(encryptionKeyStatus({ INTEGRATIONS_ENCRYPTION_KEY: "curta" }).source).toBe("invalid");
    expect(encryptionKeyStatus({}).source).toBe("none");
  });
});

describe("hub: cartões por fornecedor", () => {
  it("um cartão principal por fornecedor, sem Google Maps, com testes baratos", () => {
    const list = integrationStatusesFromEnv({});
    const main = list.filter((i) => i.group === "main").map((i) => i.id);
    expect(main).toEqual(["google_ads", "meta_ads", "google_business", "whatsapp", "whatsapp_calls", "gmail", "google_sync", "google_contacts", "google_drive", "knowledge_base", "google_analytics", "search_console", "pagespeed", "crux", "google_account", "gmail_send", "zello", "llm", "multipark", "multipark_db", "storage"]);
    expect(list.some((i) => i.id === "google_maps")).toBe(false);
    for (const id of ["google_ads", "google_business", "zello", "llm", "google_analytics", "search_console", "pagespeed"]) expect(list.find((i) => i.id === id)?.testable).toBe(true);
    // PageSpeed funciona sem chave (quota baixa) → configurada sem variáveis.
    expect(list.find((i) => i.id === "pagespeed")?.configured).toBe(true);
    expect(list.find((i) => i.id === "multipark")?.testable).toBe(false);
    // BD Multipark (só leitura): tem Testar (só super_admin); sem a env → não configurada.
    expect(list.find((i) => i.id === "multipark_db")).toMatchObject({ testable: true, configured: false, missing: ["DATABASE_URL_MULTIPARK"] });
    expect(list.find((i) => i.id === "google_ads")?.links.map((l) => l.href)).toContain("/integracoes/google-ads");
    expect(list.find((i) => i.id === "google_business")?.links.map((l) => l.href)).toContain("/criticas#google-business");
    // CrUX precisa de chave (a da PageSpeed serve) e tem Testar.
    expect(list.find((i) => i.id === "crux")).toMatchObject({ testable: true, configured: false, missing: ["GOOGLE_PAGESPEED_API_KEY ou GOOGLE_CRUX_API_KEY"] });
    expect(integrationStatusesFromEnv({ GOOGLE_PAGESPEED_API_KEY: "k" }).find((i) => i.id === "crux")?.configured).toBe(true);
  });
});

// ─── 5. Timeouts, retries, precedência ──────────────────────────────────────

describe("fetchWithTimeout", () => {
  const hanging = (_url: any, init: any) => new Promise<Response>((_, reject) => {
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  it("aborta ao fim do prazo com erro curto (só o host, nunca o URL)", async () => {
    const err = await fetchWithTimeout("https://api.exemplo.pt/x?access_token=segredo", { timeoutMs: 20 }, hanging as any).catch((e) => e);
    expect(err).toBeInstanceOf(FetchTimeoutError);
    expect(err.message).toContain("api.exemplo.pt");
    expect(err.message).not.toContain("segredo");
  });
  it("devolve a resposta dentro do prazo e passa um signal", async () => {
    const f = vi.fn(async (_u: any, init: any) => { expect(init.signal).toBeDefined(); return new Response("ok"); });
    const r = await fetchWithTimeout("https://x.pt", { method: "GET" }, f as any);
    expect(await r.text()).toBe("ok");
    expect(f.mock.calls[0][1]).toMatchObject({ method: "GET" });
  });
  it("respeita o abort de quem chama (não é timeout)", async () => {
    const c = new AbortController();
    const p = fetchWithTimeout("https://x.pt", { signal: c.signal, timeoutMs: 5000 }, hanging as any).catch((e) => e);
    c.abort();
    const err = await p;
    expect(err).not.toBeInstanceOf(FetchTimeoutError);
  });
});

describe("Meta: repetição nos limites", () => {
  it("classifica 4, 17, 80004 e HTTP 429 como repetíveis; 190/100 não", () => {
    for (const c of [4, 17, 80004]) expect(isMetaRetryable(400, c)).toBe(true);
    expect(isMetaRetryable(429, null)).toBe(true);
    expect(isMetaRetryable(400, 190)).toBe(false);
    expect(isMetaRetryable(400, 100)).toBe(false);
    expect(isMetaRetryable(500, null)).toBe(false);
  });
  const cfg = readMetaConfig({ META_ACCESS_TOKEN: "tok", META_AD_ACCOUNT_IDS: "1" });
  it("repete com espera progressiva e acaba por ter sucesso", async () => {
    const sleeps: number[] = [];
    const f = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: { message: "User request limit reached", code: 17 } }) })
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [1] }) });
    const body = await metaGetJson(cfg, "https://graph.facebook.com/v24.0/x", f as any, { attempts: 3, baseDelayMs: 10, sleep: async (ms) => { sleeps.push(ms); } });
    expect(body).toEqual({ data: [1] });
    expect(sleeps).toEqual([10, 20]);
  });
  it("desiste ao fim das tentativas e não repete erros de token", async () => {
    const limit = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: "limite", code: 80004 } }) });
    await expect(metaGetJson(cfg, "https://graph.facebook.com/x", limit as any, { attempts: 2, sleep: async () => {} })).rejects.toBeInstanceOf(MetaApiError);
    expect(limit).toHaveBeenCalledTimes(2);
    const auth = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: "token", code: 190 } }) });
    await expect(metaGetJson(cfg, "https://graph.facebook.com/x", auth as any, { attempts: 3, sleep: async () => {} })).rejects.toMatchObject({ isAuth: true });
    expect(auth).toHaveBeenCalledTimes(1);
  });
});

describe("Google Ads: código de erro (precedência corrigida)", () => {
  it("status primeiro; senão o errorCode dos detalhes", () => {
    expect(errorCodeOf({ error: { status: "PERMISSION_DENIED", details: [{ errors: [{ errorCode: { a: "B" } }] }] } })).toBe("PERMISSION_DENIED");
    expect(errorCodeOf({ error: { details: [{ errors: [{ errorCode: { authorizationError: "X" } }] }] } })).toBe('{"authorizationError":"X"}');
    expect(errorCodeOf({})).toBeUndefined();
  });
});

// ─── 6. Dados de marketing ──────────────────────────────────────────────────

describe("atribuição Meta: utm_source só conta com medium pago", () => {
  it.each(["cpc", "paid", "paid_social", "ppc", "cpm", "Paid_Social"])("facebook/ig + %s → meta_paid", (medium) => {
    expect(attributionFromUrl(`https://x.pt/?utm_source=ig&utm_medium=${medium}`).adAttribution).toBe("meta_paid");
    expect(isMetaPaidUtm("facebook", medium)).toBe(true);
  });
  it.each(["", "social", "organic", "referral", "bio"])("facebook sem medium pago (%s) → unknown", (medium) => {
    const url = `https://x.pt/?utm_source=facebook${medium ? `&utm_medium=${medium}` : ""}`;
    expect(attributionFromUrl(url).adAttribution).toBe("unknown");
  });
  it("fbclid continua a provar clique pago; Google continua a ganhar", () => {
    expect(attributionFromUrl("https://x.pt/?fbclid=abc").adAttribution).toBe("meta_paid");
    expect(attributionFromUrl("https://x.pt/?gclid=1&utm_source=ig&utm_medium=paid").adAttribution).toBe("google_paid");
  });
});

describe("moeda: só EUR entra nos totais", () => {
  it("EUR e moeda desconhecida contam; o resto não", () => {
    expect(countsInEurTotals("EUR")).toBe(true);
    expect(countsInEurTotals(" eur ")).toBe(true);
    expect(countsInEurTotals(null)).toBe(true);
    expect(countsInEurTotals("")).toBe(true);
    expect(countsInEurTotals("USD")).toBe(false);
    expect(countsInEurTotals("GBP")).toBe(false);
  });
  it("junta por conta o gasto excluído (para o aviso)", () => {
    const r = summarizeCurrencyExclusions([
      { accountId: 1, accountName: "PT", provider: "google_ads", currency: "EUR", cost: 100 },
      { accountId: 2, accountName: "UK", provider: "meta", currency: "gbp", cost: 5 },
      { accountId: 2, accountName: "UK", provider: "meta", currency: "GBP", cost: 7 },
      { accountId: 3, accountName: "US", provider: "google_ads", currency: "USD", cost: 50 },
    ]);
    expect(r).toEqual([
      { accountId: 3, accountName: "US", provider: "google_ads", currency: "USD", cost: 50 },
      { accountId: 2, accountName: "UK", provider: "meta", currency: "GBP", cost: 12 },
    ]);
  });
});

describe("sugestões marca/cidade também para campanhas Meta", () => {
  const P: ProjectNode[] = [
    { id: 48, name: "Multipark", level: "group", parentId: null },
    { id: 49, name: "Lisboa", level: "city", parentId: 48 },
    { id: 51, name: "Faro", level: "city", parentId: 48 },
    { id: 52, name: "Airpark", level: "brand", parentId: 49 },
    { id: 54, name: "Airpark", level: "brand", parentId: 51 },
  ];
  it("a rota inclui o fornecedor Meta e um nome Meta tem sugestão", () => {
    expect(CAMPAIGN_SUGGEST_PROVIDERS).toContain("meta");
    expect(CAMPAIGN_SUGGEST_PROVIDERS).toContain("google_ads");
    const s = suggestCampaignProjects([{ id: 9, name: "Airpark - Faro - Leads Instagram", accountProjectId: 52, projectId: null }], P);
    expect(s.map((x) => [x.campaignId, x.projectId])).toEqual([[9, 54]]);
  });
});

// ─── 2. Google Business ─────────────────────────────────────────────────────

describe("Google Business: parar a paginação cedo", () => {
  it("página toda igual → pára (fora de backfill/dirty)", () => {
    expect(shouldStopPaging({ results: ["unchanged", "unchanged"], backfill: false, dirty: false })).toBe(true);
  });
  it("continua se algo mudou, em backfill, com dirtyAt ou página vazia", () => {
    expect(shouldStopPaging({ results: ["unchanged", "updated"], backfill: false, dirty: false })).toBe(false);
    expect(shouldStopPaging({ results: ["unchanged"], backfill: true, dirty: false })).toBe(false);
    expect(shouldStopPaging({ results: ["unchanged"], backfill: false, dirty: true })).toBe(false);
    expect(shouldStopPaging({ results: [], backfill: false, dirty: false })).toBe(false);
  });
});

describe("Google Business: reclamações na 1.ª importação", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  const base = { rating: 1, hasComplaint: false, dismissed: false, hasReply: false, nowMs: now };
  it("1.ª importação: só críticas recentes (≤14 dias) e sem resposta", () => {
    expect(shouldOpenComplaint({ ...base, firstImport: true, updatedIso: "2026-09-20T12:00:00Z" })).toBe(true);
    expect(shouldOpenComplaint({ ...base, firstImport: true, updatedIso: "2026-09-01T12:00:00Z" })).toBe(false);
    expect(shouldOpenComplaint({ ...base, firstImport: true, updatedIso: "2026-09-20T12:00:00Z", hasReply: true })).toBe(false);
  });
  it("depois da 1.ª importação: regra normal (≤3★, sem reclamação, não descartada)", () => {
    expect(shouldOpenComplaint({ ...base, firstImport: false, updatedIso: "2020-01-01T00:00:00Z" })).toBe(true);
    expect(shouldOpenComplaint({ ...base, firstImport: false, updatedIso: "2026-09-20T12:00:00Z", rating: 4 })).toBe(false);
    expect(shouldOpenComplaint({ ...base, firstImport: false, updatedIso: "2026-09-20T12:00:00Z", hasComplaint: true })).toBe(false);
    expect(shouldOpenComplaint({ ...base, firstImport: false, updatedIso: "2026-09-20T12:00:00Z", dismissed: true })).toBe(false);
  });
});

// ─── 4. Alertas ─────────────────────────────────────────────────────────────

describe("alertas uma vez por transição", () => {
  it("estado de alerta da ligação", () => {
    expect(connectionAlertState("reauth_required")).toBe("reauth_required");
    expect(connectionAlertState("error")).toBe("error");
    expect(connectionAlertState("connected")).toBe("ok");
    expect(connectionAlertState("disconnected")).toBe("ok");
  });
  it("só avisa quando passa a mau; recuperação não avisa", () => {
    expect(alertTransition(null, "reauth_required")).toBe("alert");
    expect(alertTransition("ok", "stale")).toBe("alert");
    expect(alertTransition("error", "reauth_required")).toBe("alert");
    expect(alertTransition("reauth_required", "reauth_required")).toBe("none");
    expect(alertTransition("reauth_required", "ok")).toBe("recovered");
    expect(alertTransition(null, "ok")).toBe("none");
  });
  it("mensagens legíveis", () => {
    expect(alertMessage("conn", "google_ads", "reauth_required", null).title).toBe("Google Ads precisa de ser religado");
    expect(alertMessage("cron", "daily-ops", "stale", null, "Manutenção diária").title).toBe("Cron parado: Manutenção diária");
  });
});

describe("WhatsApp: token expirado e versão da Graph API", () => {
  it("190 = token", () => {
    expect(isWhatsappTokenError(190)).toBe(true);
    expect(isWhatsappTokenError(131047)).toBe(false);
  });
  it("versão por omissão = a do Meta (v24.0); env sobrepõe", () => {
    expect(whatsappApiVersion({})).toBe("v24.0");
    expect(whatsappApiVersion({ WHATSAPP_API_VERSION: "23.0" })).toBe("v23.0");
  });
});

// ─── 10. LLM ────────────────────────────────────────────────────────────────

describe("LLM: modelo e erros", () => {
  it("avisa quando LLM_MODEL não está definido ou é o de omissão", () => {
    expect(llmModelStatus({}).source).toBe("default");
    expect(llmModelStatus({}).warning).toMatch(/LLM_MODEL/);
    const def = llmModelStatus({ LLM_API_URL: "https://api.anthropic.com" }).model;
    expect(llmModelStatus({ LLM_API_URL: "https://api.anthropic.com", LLM_MODEL: def }).warning).toMatch(/omissão/);
    expect(llmModelStatus({ LLM_MODEL: "modelo com espacos" }).warning).toMatch(/inválido/);
    expect(llmModelStatus({ LLM_MODEL: "meu-modelo-1" }).warning).toBeNull();
  });
  it("a mensagem para a UI nunca leva o corpo do fornecedor", () => {
    const body = JSON.stringify({ error: { type: "invalid_request_error", message: "prompt com dados do cliente João 912345678" } });
    const m = llmErrorMessage(400, body);
    expect(m).toContain("HTTP 400");
    expect(m).toContain("invalid_request_error");
    expect(m).not.toContain("João");
    expect(llmErrorMessage(429, "<html>rate</html>")).toContain("limite");
  });
});

// ─── 9. Motor comum da recolha + Meta através dele ──────────────────────────

type Ev = string;
function memoryStore(opts: { lockBusy?: boolean } = {}) {
  const events: Ev[] = [];
  let locked = !!opts.lockBusy;
  const runs = new Map<number, RunPatch & { id: number; kind: string; cursor?: string | null; rowsWritten?: number; warnings?: string | null; finishedAt?: boolean }>();
  const accounts = new Map<string, { id: number; customerId: string; currency: string | null; selected: number; name: string }>();
  const writes: Array<{ from: string; to: string; payload: ChunkPayload }> = [];
  const connections: Array<Record<string, unknown>> = [];
  const accountResults: Array<[number, boolean, string | null]> = [];
  let nextRun = 1;
  const store: AdsSyncStore = {
    async acquireLock() { events.push("lock"); if (locked) return false; locked = true; return true; },
    async releaseLock() { events.push("unlock"); locked = false; },
    async findResumableRun(_p, kind) {
      const r = Array.from(runs.values()).reverse().find((x) => x.kind === kind && x.status === "partial" && x.cursor && !x.finishedAt);
      return r ? { id: r.id, rowsWritten: r.rowsWritten ?? 0, cursor: r.cursor ?? null, warnings: r.warnings ?? null } : null;
    },
    async createRun(_p, kind) { const id = nextRun++; runs.set(id, { id, kind, status: "running" }); return id; },
    async updateRun(id, patch) { const r = runs.get(id)!; Object.assign(r, patch, patch.finished ? { finishedAt: true } : {}); },
    async setAccountResult(id, ok, error) { accountResults.push([id, ok, error]); },
    async countApiRows() { return 0; },
    async writeChunk(_p, _a, from, to, _run, _today, payload) { writes.push({ from, to, payload }); return payload.daily.length; },
    async listSelectedAccounts() { return Array.from(accounts.values()).filter((a) => a.selected).map((a) => ({ id: a.id, customerId: a.customerId, currency: a.currency, isManager: 0 })); },
    async upsertAccount(_p, row) {
      events.push(`upsert:${row.customerId}`);
      const ex = accounts.get(row.customerId);
      accounts.set(row.customerId, { id: ex?.id ?? accounts.size + 1, customerId: row.customerId, currency: row.currency, selected: ex?.selected ?? 1, name: row.name });
    },
    async saveConnection(_p, patch) { connections.push(patch); },
  };
  return { store, events, runs, writes, connections, accountResults, isLocked: () => locked };
}

function metaFetch(opts: { insightsError?: { code: number; message: string } } = {}) {
  return vi.fn(async (url: string) => {
    const u = new URL(url);
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (u.pathname.endsWith("/insights")) {
      if (opts.insightsError) return { ok: false, status: 400, json: async () => ({ error: opts.insightsError }) };
      const since = JSON.parse(u.searchParams.get("time_range") ?? "{}").since;
      return ok({ data: [{ campaign_id: "c1", campaign_name: "Airpark Faro", date_start: since, spend: "10.5", impressions: "100", clicks: "30", inline_link_clicks: "12" }] });
    }
    if (u.pathname.endsWith("/campaigns")) return ok({ data: [{ id: "c1", name: "Airpark - Faro", effective_status: "ACTIVE", daily_budget: "1500" }] });
    return ok({ name: "Conta Meta", currency: "EUR", timezone_name: "Europe/Lisbon", account_status: 1 });
  });
}

describe("motor comum da recolha (adsSyncRunner)", () => {
  const acc: AdsAccountRef = { id: 1, customerId: "111", currency: "EUR" };
  it("lock ocupado → skipped com ok:true (nada a fazer não é falha)", async () => {
    const m = memoryStore({ lockBusy: true });
    const r = await runAdsSync({ provider: "x", kind: "daily", store: m.store, today: "2026-09-20", loadAccounts: async () => [acc], fetchChunk: async () => ({ campaigns: [], daily: [], actions: null }) });
    expect(r).toMatchObject({ ok: true, status: "skipped", skipped: "locked" });
  });
  it("sem contas → skipped com ok:true, e o lock é libertado", async () => {
    const m = memoryStore();
    const r = await runAdsSync({ provider: "x", kind: "daily", store: m.store, today: "2026-09-20", loadAccounts: async () => [], fetchChunk: async () => ({ campaigns: [], daily: [], actions: null }) });
    expect(r).toMatchObject({ ok: true, status: "skipped", skipped: "no_accounts" });
    expect(m.isLocked()).toBe(false);
  });
  it("um erro inesperado liberta SEMPRE o lock (try/finally)", async () => {
    const m = memoryStore();
    const r = await runAdsSync({ provider: "x", kind: "daily", store: m.store, today: "2026-09-20", loadAccounts: async () => { throw new Error("BD caiu"); }, fetchChunk: async () => ({ campaigns: [], daily: [], actions: null }) });
    expect(r).toMatchObject({ ok: false, status: "failed", reason: "BD caiu" });
    expect(m.isLocked()).toBe(false);
  });
});

describe("Meta através do motor comum", () => {
  const env = () => { vi.stubEnv("META_ACCESS_TOKEN", "tok"); vi.stubEnv("META_AD_ACCOUNT_IDS", "act_111"); };
  it("garante as contas UMA vez, já com o lock; escreve cliques no link; ligação ok", async () => {
    env();
    const m = memoryStore();
    const f = metaFetch();
    const r = await runMetaAdsSync({ kind: "daily", store: m.store, fetchImpl: f as any, today: "2026-09-20" });
    expect(r).toMatchObject({ ok: true, done: true, status: "done", accountsTotal: 1, accountsDone: 1 });
    expect(m.events.filter((e) => e.startsWith("upsert")).length).toBe(1);
    expect(m.events.indexOf("lock")).toBeLessThan(m.events.indexOf("upsert:111"));
    expect(m.events[m.events.length - 1]).toBe("unlock");
    expect(m.writes.length).toBeGreaterThan(0);
    const daily = m.writes[0].payload.daily[0];
    expect(daily).toMatchObject({ campaignExternalId: "c1", clicks: 12, costMicros: 10_500_000 });
    expect(m.writes[0].payload.campaigns[0]).toMatchObject({ externalId: "c1", name: "Airpark - Faro", status: "ACTIVE", channelType: "META", budgetMicros: 15_000_000 });
    expect(m.connections.at(-1)).toMatchObject({ status: "connected", lastError: null });
  });
  it("token inválido (190) → failed + ligação reauth_required; lock libertado", async () => {
    env();
    const m = memoryStore();
    const r = await runMetaAdsSync({ kind: "daily", store: m.store, fetchImpl: metaFetch({ insightsError: { code: 190, message: "Error validating access token" } }) as any, today: "2026-09-20" });
    expect(r).toMatchObject({ ok: false, status: "failed" });
    expect(r.authError).toMatch(/access token/);
    expect(m.connections.at(-1)).toMatchObject({ status: "reauth_required" });
    expect(m.isLocked()).toBe(false);
  });
  it("prazo esgotado → partial done:false com cursor; a chamada seguinte retoma e termina", async () => {
    env();
    const m = memoryStore();
    const first = await runMetaAdsSync({ kind: "daily", store: m.store, fetchImpl: metaFetch() as any, today: "2026-09-20", deadlineAt: Date.now() - 1 });
    expect(first).toMatchObject({ ok: true, done: false, status: "partial" });
    expect(m.isLocked()).toBe(false);
    const second = await runMetaAdsSync({ kind: "daily", store: m.store, fetchImpl: metaFetch() as any, today: "2026-09-20" });
    expect(second).toMatchObject({ ok: true, done: true, status: "done", runId: first.runId });
  });
  it("não configurada → skipped not_configured sem tocar na BD", async () => {
    vi.stubEnv("META_ACCESS_TOKEN", "");
    vi.stubEnv("META_AD_ACCOUNT_IDS", "");
    const m = memoryStore();
    const r = await runMetaAdsSync({ kind: "daily", store: m.store });
    expect(r).toMatchObject({ ok: true, status: "skipped", skipped: "not_configured" });
    expect(m.events).toEqual([]);
  });
});
