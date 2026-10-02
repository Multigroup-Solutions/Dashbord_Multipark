/**
 * P3 lote 19b — Google Ads: histórico não desaparece, recolha saltada ≠ feita,
 * chave de cifra antiga, conversões só Google, 35 dias, ligar/desligar só
 * super admin, prazo das recolhas.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { runAdsSync, LOCK_TTL_MIN, type AdsAccountRef, type AdsSyncStore, type RunPatch } from "./integrations/adsSyncRunner";
import { normalizeSyncKind, syncWindow, RECENT_SYNC_DAYS } from "./integrations/googleAds/metrics";
import { decryptSecret, decryptSecretInfo, encryptSecret } from "./integrations/googleAds/crypto";
import { adsCronDone } from "./cronJobs";
import { TICK_JOBS } from "./cronSchedule";
import { syncHealthAlert } from "../shared/marketingAlerts";

const read = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

function store() {
  let locked = false;
  const runs = new Map<number, RunPatch & { kind: string; cursor?: string | null; finishedAt?: boolean }>();
  let next = 1;
  const s: AdsSyncStore = {
    async acquireLock() { if (locked) return false; locked = true; return true; },
    async releaseLock() { locked = false; },
    async findResumableRun(_p, kind) {
      const r = Array.from(runs.entries()).reverse().find(([, x]) => x.kind === kind && x.status === "partial" && x.cursor && !x.finishedAt);
      return r ? { id: r[0], rowsWritten: 0, cursor: r[1].cursor ?? null, warnings: null } : null;
    },
    async createRun(_p, kind) { const id = next++; runs.set(id, { kind, status: "running" }); return id; },
    async updateRun(id, patch) { Object.assign(runs.get(id)!, patch, patch.finished ? { finishedAt: true } : {}); },
    async setAccountResult() {},
    async countApiRows() { return 0; },
    async writeChunk(_p, _a, _f, _t, _r, _d, payload) { return payload.daily.length; },
    async listSelectedAccounts() { return []; },
    async upsertAccount() {},
    async saveConnection() {},
  };
  return { s, runs, isLocked: () => locked };
}
const acc: AdsAccountRef = { id: 1, customerId: "111", currency: "EUR" };
const row = (date: string) => ({ campaigns: [{ externalId: "c1", name: "C", status: "ENABLED", channelType: "SEARCH", budgetMicros: null }], daily: [{ campaignExternalId: "c1", date, costMicros: 1_000_000, impressions: 1, clicks: 1, conversions: 0, conversionValueMicros: 0, allConversions: 0 }], actions: null });

describe("19b recolha: 35 dias, trinco e prazo", () => {
  it("'recent' = últimos 35 dias (conversões que a Google acerta depois) e é aceite", () => {
    expect(normalizeSyncKind("recent")).toBe("recent");
    expect(RECENT_SYNC_DAYS).toBe(35);
    expect(syncWindow("recent", "2026-10-02")).toEqual({ from: "2026-08-29", to: "2026-10-02" });
  });

  it("há uma recolha semanal de 35 dias no agendador e o enum da BD aceita 'recent'", () => {
    const j = TICK_JOBS.find((x) => x.key === "google-ads-recent");
    expect(j).toMatchObject({ runName: "google-ads", cadence: { kind: "weekly" } });
    expect(read("server/migrations/migration_0074.ts")).toMatch(/'recent'/);
    expect(read("drizzle/schema.ts")).toMatch(/'manual','daily','recent'\]/);
    expect(read("server/cronScheduler.ts")).toMatch(/google-ads-recent/);
  });

  it("trinco ocupado NÃO conta como recolha feita; sem ligação/sem contas conta", () => {
    expect(adsCronDone({ status: "skipped", skipped: "locked" })).toBe(false);
    expect(adsCronDone({ status: "skipped", skipped: "not_connected" })).toBe(true);
    expect(adsCronDone({ status: "partial", done: false })).toBe(false);
    expect(adsCronDone({ status: "done", done: true })).toBe(true);
    expect(LOCK_TTL_MIN).toBeLessThanOrEqual(5);
  });

  it("sem tempo para outro pedaço → parcial com cursor; a seguinte retoma onde parou; trinco sempre libertado", async () => {
    const m = store();
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const seen: string[] = [];
    const fetchChunk = async (_a: AdsAccountRef, from: string) => { seen.push(from); now += 20_000; return row(from); };
    const r1 = await runAdsSync({ provider: "x", kind: "recent", store: m.s, today: "2026-10-02", deadlineAt: now + 30_000, loadAccounts: async () => [acc], fetchChunk });
    expect(r1).toMatchObject({ ok: true, done: false, status: "partial" });
    expect(seen.length).toBe(1);                      // o 1.º pedaço corre sempre; o 2.º já não cabia
    expect(m.isLocked()).toBe(false);
    const r2 = await runAdsSync({ provider: "x", kind: "recent", store: m.s, today: "2026-10-02", deadlineAt: now + 1_000_000, loadAccounts: async () => [acc], fetchChunk });
    expect(r2).toMatchObject({ done: true, status: "done" });
    expect(seen[1]).not.toBe(seen[0]);                // retomou no pedaço seguinte
    expect(new Set(seen).size).toBe(seen.length);     // nenhum repetido
    vi.restoreAllMocks();
  });

  it("prazo esgotado a meio de um pedido à Google → parcial (não é falha da conta) e retoma no MESMO pedaço", async () => {
    const m = store();
    let calls = 0;
    const seen: string[] = [];
    const fetchChunk = async (_a: AdsAccountRef, from: string) => {
      calls++; seen.push(from);
      if (calls === 2) { const e: any = new Error("sem tempo"); e.deadline = true; throw e; }
      return row(from);
    };
    const r1 = await runAdsSync({ provider: "x", kind: "recent", store: m.s, today: "2026-10-02", deadlineAt: Date.now() + 600_000, loadAccounts: async () => [acc], fetchChunk });
    expect(r1).toMatchObject({ ok: true, done: false, status: "partial" });
    expect(r1.warnings.join(" ")).not.toMatch(/sem tempo/);
    const r2 = await runAdsSync({ provider: "x", kind: "recent", store: m.s, today: "2026-10-02", deadlineAt: Date.now() + 600_000, loadAccounts: async () => [acc], fetchChunk });
    expect(r2).toMatchObject({ done: true, status: "done" });
    expect(seen[2]).toBe(seen[1]);                    // o pedaço interrompido volta a correr
  });

  it("pedidos à API respeitam o prazo e as ações de conversão vazias substituem as antigas", () => {
    const client = read("server/integrations/googleAds/client.ts");
    expect(client).toMatch(/class DeadlineError/);
    expect(client).toMatch(/timeoutMs: Math\.min\(30_000, left\)/);
    const sync = read("server/integrations/googleAds/sync.ts");
    expect(sync).toMatch(/setGoogleAdsApiDeadline\(opts\.deadlineAt\)/);
    expect(sync).toMatch(/let actions: [^=]+ = \[\];/);
  });
});

describe("19b cifra: chave antiga continua a abrir", () => {
  const derived = (jwt: string) => crypto.createHash("sha256").update(`${jwt}:integrations:v1`).digest();
  it("token guardado com a chave derivada do JWT_SECRET abre depois de definir INTEGRATIONS_ENCRYPTION_KEY (e pede recifra)", () => {
    vi.stubEnv("JWT_SECRET", "jwt-secreto");
    vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY", "");
    const old = encryptSecret("refresh-123", derived("jwt-secreto"));
    vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY", crypto.randomBytes(32).toString("base64"));
    expect(decryptSecretInfo(old)).toEqual({ plain: "refresh-123", legacyKey: true });
    expect(decryptSecret(old)).toBe("refresh-123");
    const fresh = encryptSecret("refresh-123");
    expect(decryptSecretInfo(fresh)).toEqual({ plain: "refresh-123", legacyKey: false });
  });
  it("chave errada → erro claro (sem rebentar com 'unable to authenticate data')", () => {
    vi.stubEnv("JWT_SECRET", "outro");
    vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY", crypto.randomBytes(32).toString("base64"));
    const alien = encryptSecret("x", crypto.randomBytes(32));
    expect(() => decryptSecret(alien)).toThrow(/chave de cifra mudou/);
  });
  it("token que não abre → reauth_required (estado honesto) e recifra quando abriu com a antiga", () => {
    const oauth = read("server/integrations/googleAds/oauth.ts");
    expect(oauth).toMatch(/status: "reauth_required", lastError: msg/);
    expect(oauth).toMatch(/if \(d\.legacyKey\)/);
    expect(oauth).toMatch(/invalid_client: a Google não aceita/);
  });
});

describe("19b histórico e conversões", () => {
  it("desselecionar uma conta não apaga o gasto já recolhido dos totais", () => {
    const m = read("server/integrations/googleAds/adMetrics.ts");
    expect(m).not.toMatch(/innerJoin\(adAccounts, and\(eq\(adAccounts\.id, adDailyMetrics\.accountId\), eq\(adAccounts\.selected, 1\)/);
    expect(m).not.toMatch(/a\.selected = 1/);
    expect(m).toMatch(/if \(!db\) throw new Error/);
  });
  it("ROAS/conversões 'Google' são só do Google Ads; os canais recebem só as conversões Google", () => {
    const s = read("server/integrations/googleAds/marketingStats.ts");
    expect(s).toMatch(/conversionsGoogle: ads\.byProviderTotals\.google_ads\.conversions/);
    expect(s).toMatch(/roasGoogle: ads\.byProviderTotals\.google_ads\.roasGoogle/);
    expect(s).toMatch(/conversionsPlatforms: ads\.totals\.conversions/);
    expect(s).not.toMatch(/backfillBookingAttribution/);
    for (const f of ["server/routers.ts", "server/mcpMarketingApi.ts"]) expect(read(f)).toMatch(/adConversions: ads\.byProviderTotals\.google_ads\.conversions/);
  });
});

describe("19b ligar/desligar só super admin; registos", () => {
  it("início e retorno do OAuth exigem super admin e o MESMO utilizador; cron com comparação segura", () => {
    const r = read("server/integrations/googleAds/routes.ts");
    expect(r).toMatch(/user\.role !== "super_admin"/);
    expect(r).toMatch(/st\.userId !== user\.id/);
    expect(r).toMatch(/cronAuthOk\(req\.headers\["authorization"\]\)/);
    expect(r).toMatch(/action: "connect"/);
  });
  it("desligar: só super admin, revoga na Google, fica registado; inicial só com gestão; sem 'atribuir reservas'", () => {
    const r = read("server/integrations/googleAds/router.ts");
    expect(r).toMatch(/Só o super admin pode desligar o Google Ads/);
    expect(r).toMatch(/action: "disconnect"/);
    expect(r).toMatch(/entity: "ad_accounts"/);
    expect(r).toMatch(/input\.kind === "initial"\) requireAccess\(ctx\.user, "integracoes", "manage"\)/);
    expect(r).toMatch(/"recent"\]/);
    expect(r).not.toMatch(/backfillAttribution/);
    expect(read("server/integrations/googleAds/oauth.ts")).toMatch(/oauth2\.googleapis\.com\/revoke/);
    expect(read("server/integrations/meta/router.ts")).toMatch(/input\.kind === "initial"\) requireAccess/);
  });
});

describe("19b avisos de recolha", () => {
  const base = { provider: "google_ads" as const, lastSuccessAt: null, lastRunError: null };
  it("'Religar' só quando é preciso religar", () => {
    expect(syncHealthAlert({ ...base, connection: "reauth_required", lastRunStatus: null, stale: false } as any)?.linkLabel).toBe("Religar Google Ads");
    expect(syncHealthAlert({ ...base, connection: "connected", lastRunStatus: null, stale: true } as any)?.linkLabel).toBe("Abrir Integrações → Google Ads");
    expect(syncHealthAlert({ ...base, connection: "connected", lastRunStatus: "failed", stale: false } as any)?.linkLabel).toBe("Abrir Integrações → Google Ads");
  });
});
