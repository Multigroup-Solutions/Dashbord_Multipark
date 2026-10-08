import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./oauth", () => ({ getAccessToken: vi.fn(async () => "test-access-token"), getConnection: vi.fn() }));

import { gaqlClickView, parseClickViewRow } from "./gaql";
import { fetchClickView, GoogleAdsApiError } from "./client";
import {
  CLICK_BACKFILL_DAYS_PER_RUN, CLICK_SYNC_FLAG, CLICK_VIEW_DAYS, clickWindow, dedupeClicks, missingClickDays, mysqlClickStore, planClickTasks,
  runGoogleAdsClickSync, summarizeClickDays, type ClickStore, type ClickSyncDeps,
} from "./clicks";
import { applyClickCampaigns, gclidsToResolve, GCLID_LOOKUP_CHUNK, lookupClickCampaigns, withClickCampaigns } from "./clickAttribution";
import { matchBookingsToCampaigns, matchBookingsToCampaignsBy } from "../../marketingCampaignRoas";
import { describeMatchCounts } from "../../../shared/campaignEvidence";
import { MIGRATION_0610_STATEMENTS } from "../../migrations/migration_0610";
import { TICK_JOBS, describeCadence } from "../../cronSchedule";
import { AUTOMATION_FLAGS, CRON_JOBS, automationFlagDefault } from "../../../shared/appSettings";

const render = (q: any) => new MySqlDialect().sqlToQuery(q);
const src = (p: string) => readFileSync(resolve(import.meta.dirname, p), "utf8");

// ─── click_view: consulta e resposta ────────────────────────────────────────

describe("click_view (gclid → campanha)", () => {
  it("uma consulta por dia, só leitura, com o dia validado", () => {
    const q = gaqlClickView("2026-10-07");
    expect(q).toBe("SELECT click_view.gclid, campaign.id, ad_group.id, segments.date FROM click_view WHERE segments.date = '2026-10-07'");
    expect(q).not.toMatch(/BETWEEN|DURING/);
    expect(() => gaqlClickView("ontem")).toThrow();
    expect(() => gaqlClickView("2026-10-07' OR 1=1 --")).toThrow();
  });

  it("lê a linha do REST (camelCase); sem gclid, campanha ou dia → fora", () => {
    expect(parseClickViewRow({ clickView: { gclid: " Cj0KCQjwAbC-_x " }, campaign: { id: "21890123456" }, adGroup: { id: "1570000001" }, segments: { date: "2026-10-07" } }))
      .toEqual({ gclid: "Cj0KCQjwAbC-_x", campaignId: "21890123456", adGroupId: "1570000001", date: "2026-10-07" });
    // grupo de anúncios é opcional (PMax)
    expect(parseClickViewRow({ clickView: { gclid: "G1" }, campaign: { id: 777 }, segments: { date: "2026-10-07" } })).toMatchObject({ campaignId: "777", adGroupId: null });
    expect(parseClickViewRow({ campaign: { id: "1" }, segments: { date: "2026-10-07" } })).toBeNull();
    expect(parseClickViewRow({ clickView: { gclid: "G" }, segments: { date: "2026-10-07" } })).toBeNull();
    expect(parseClickViewRow({ clickView: { gclid: "G" }, campaign: { id: "1" } })).toBeNull();
    expect(parseClickViewRow({ clickView: { gclid: "G".repeat(129) }, campaign: { id: "1" }, segments: { date: "2026-10-07" } })).toBeNull();
    expect(parseClickViewRow(null)).toBeNull();
  });

  it("dedupe por gclid (o último ganha)", () => {
    const r = (g: string, c: string) => ({ gclid: g, campaignId: c, adGroupId: null, date: "2026-10-07" });
    expect(dedupeClicks([r("a", "1"), r("b", "2"), r("a", "3")])).toEqual([r("a", "3"), r("b", "2")]);
  });
});

describe("fetchClickView pelo searchStream (só leitura)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("GOOGLE_ADS_CLIENT_ID", "test-client");
    vi.stubEnv("GOOGLE_ADS_CLIENT_SECRET", "test-secret");
    vi.stubEnv("GOOGLE_ADS_LOGIN_CUSTOMER_ID", undefined);
    vi.stubEnv("GOOGLE_ADS_API_VERSION", undefined);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("pede o dia à conta e devolve os cliques válidos", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([{ results: [
      { clickView: { gclid: "G1" }, campaign: { id: "555" }, adGroup: { id: "9" }, segments: { date: "2026-10-07" } },
      { clickView: {}, campaign: { id: "555" }, segments: { date: "2026-10-07" } },
    ] }, { results: [{ clickView: { gclid: "G2" }, campaign: { id: "777" }, segments: { date: "2026-10-07" } }] }])));
    const rows = await fetchClickView("123-456-7890", "2026-10-07", "999");
    expect(rows.map((r) => [r.gclid, r.campaignId])).toEqual([["G1", "555"], ["G2", "777"]]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://googleads.googleapis.com/v25/customers/1234567890/googleAds:searchStream");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body).query).toContain("FROM click_view WHERE segments.date = '2026-10-07'");
    expect(init.headers["login-customer-id"]).toBe("999");
  });
});

// ─── janela de 90 dias e plano das voltas ───────────────────────────────────

describe("janela do click_view e plano (puro)", () => {
  const today = "2026-10-08";
  it("90 dias com hoje; em falta = de ontem para trás, dentro da janela", () => {
    expect(CLICK_VIEW_DAYS).toBe(90);
    expect(clickWindow(today)).toEqual({ from: "2026-07-11", to: "2026-10-08" });
    const missing = missingClickDays(today, new Set());
    expect(missing).toHaveLength(89);
    expect(missing[0]).toBe("2026-10-07");
    expect(missing[88]).toBe("2026-07-11");
    expect(missingClickDays(today, new Set(["2026-10-07", "2026-10-06"]))[0]).toBe("2026-10-05");
  });

  it("cada volta: hoje e ontem de todas as contas primeiro; depois os em falta, do mais recente para trás, à vez por conta", () => {
    const accounts = [{ customerId: "A" }, { customerId: "B", loginCustomerId: "M" }];
    const tasks = planClickTasks({ today, accounts, doneDays: new Map([["B", new Set(["2026-10-06"])]]), maxBackfill: 2 });
    expect(tasks.map((t) => `${t.customerId}:${t.day}:${t.kind}`)).toEqual([
      "A:2026-10-08:recent", "B:2026-10-08:recent", "A:2026-10-07:recent", "B:2026-10-07:recent",
      "A:2026-10-06:backfill", "B:2026-10-05:backfill", "A:2026-10-05:backfill", "B:2026-10-04:backfill",
    ]);
    expect(tasks.find((t) => t.customerId === "B")!.loginCustomerId).toBe("M");
  });

  it("backfill aos poucos: no máximo N dias por conta por volta e nunca fora dos 90 dias", () => {
    const tasks = planClickTasks({ today, accounts: [{ customerId: "A" }], doneDays: new Map() });
    expect(tasks.filter((t) => t.kind === "backfill")).toHaveLength(CLICK_BACKFILL_DAYS_PER_RUN);
    // tudo lido menos o dia mais antigo da janela → é esse que se pede (e nada antes dele)
    const done = new Set(missingClickDays(today, new Set()).filter((d) => d !== "2026-07-11"));
    const t2 = planClickTasks({ today, accounts: [{ customerId: "A" }], doneDays: new Map([["A", done]]) });
    expect(t2.filter((t) => t.kind === "backfill").map((t) => t.day)).toEqual(["2026-07-11"]);
    for (const t of planClickTasks({ today, accounts: [{ customerId: "A" }], doneDays: new Map(), maxBackfill: 500 })) expect(t.day >= "2026-07-11" && t.day <= today).toBe(true);
    // ontem não se repete no backfill
    expect(planClickTasks({ today, accounts: [{ customerId: "A" }], doneDays: new Map(), maxBackfill: 500 }).filter((t) => t.day === "2026-10-07")).toHaveLength(1);
  });

  it("resumo: último dia lido e dias em falta (união das contas)", () => {
    const s = summarizeClickDays(today, ["A", "B"], new Map([["A", new Set(["2026-10-08", "2026-10-07"])], ["B", new Set(["2026-10-07", "2026-10-06"])]]));
    expect(s.lastDay).toBe("2026-10-08");
    // A falta 06 e para trás; B falta 05 para trás → união = 06 … 11 jul
    expect(s.missingDays).toBe(88);
    expect(s.oldestMissing).toBe("2026-07-11");
    expect(summarizeClickDays(today, [], new Map())).toMatchObject({ lastDay: null, missingDays: 0, oldestMissing: null });
  });
});

// ─── recolha (orquestração com dependências falsas) ─────────────────────────

function memoryStore(): ClickStore & { days: Map<string, number>; clicks: Map<string, string> } {
  const days = new Map<string, number>(), clicks = new Map<string, string>();
  return {
    days, clicks,
    async loadDoneDays(ids) {
      const out = new Map<string, Set<string>>();
      for (const k of days.keys()) { const [id, d] = k.split("|"); if (!ids.includes(id)) continue; const s = out.get(id) ?? new Set<string>(); s.add(d); out.set(id, s); }
      return out;
    },
    async saveDay(id, day, rows) { for (const r of dedupeClicks(rows)) clicks.set(r.gclid, r.campaignId); days.set(`${id}|${day}`, rows.length); return dedupeClicks(rows).length; },
  };
}
function deps(over: Partial<ClickSyncDeps> & { store?: ClickStore } = {}): ClickSyncDeps {
  const store = over.store ?? memoryStore();
  return {
    flagOn: async () => true,
    precheck: async () => null,
    loadAccounts: async () => [{ customerId: "A", loginCustomerId: null }, { customerId: "B", loginCustomerId: null }],
    fetchDay: async (id, day) => [{ gclid: `${id}-${day}`, campaignId: id === "A" ? "555" : "777", adGroupId: null, date: day }],
    setDeadline: () => {},
    today: () => "2026-10-08",
    ...over,
    store: async () => store,
  };
}

describe("runGoogleAdsClickSync", () => {
  it("interruptor ligado por omissão; desligado → salta sem ler nada", async () => {
    expect(CLICK_SYNC_FLAG).toBe("GOOGLE_ADS_CLICK_SYNC");
    expect(automationFlagDefault("GOOGLE_ADS_CLICK_SYNC")).toBe(true);
    expect(AUTOMATION_FLAGS.find((f) => f.name === "GOOGLE_ADS_CLICK_SYNC")?.description).toMatch(/gclid/);
    const fetchDay = vi.fn();
    const r = await runGoogleAdsClickSync({}, deps({ flagOn: async () => false, fetchDay }));
    expect(r).toMatchObject({ ok: true, status: "skipped", skipped: "GOOGLE_ADS_CLICK_SYNC desligado" });
    expect(fetchDay).not.toHaveBeenCalled();
  });

  it("sem ligação ou sem contas → salta (ok)", async () => {
    expect(await runGoogleAdsClickSync({}, deps({ precheck: async () => ({ skipped: "not_connected", reason: "x" }) }))).toMatchObject({ ok: true, status: "skipped", skipped: "not_connected" });
    expect(await runGoogleAdsClickSync({}, deps({ loadAccounts: async () => [] }))).toMatchObject({ ok: true, status: "skipped", skipped: "no_accounts" });
  });

  it("lê hoje, ontem e o backfill; grava e marca os dias; a 2.ª volta já não repete os dias lidos", async () => {
    const store = memoryStore();
    const r = await runGoogleAdsClickSync({ maxBackfill: 3 }, deps({ store }));
    expect(r).toMatchObject({ ok: true, done: true, status: "done", accounts: 2, daysPlanned: 10, daysRead: 10, clicksWritten: 10 });
    expect(r.missingDays).toBe(89 - 4);
    expect(store.clicks.get("A-2026-10-08")).toBe("555");
    const fetchDay = vi.fn(async (_id: string, day: string) => [{ gclid: `x-${day}`, campaignId: "1", adGroupId: null, date: day }]);
    await runGoogleAdsClickSync({ maxBackfill: 3 }, deps({ store, fetchDay }));
    const days = fetchDay.mock.calls.map((c) => c[1]);
    expect(days.filter((d) => d === "2026-10-06")).toHaveLength(0);
    expect(days).toContain("2026-10-03");
  });

  it("sem acesso a uma conta (403) → pára essa conta; as outras seguem", async () => {
    const fetchDay = vi.fn(async (id: string, day: string) => {
      if (id === "A") throw new GoogleAdsApiError("Google Ads API 403: PERMISSION_DENIED", 403);
      return [{ gclid: `${id}-${day}`, campaignId: "777", adGroupId: null, date: day }];
    });
    const r = await runGoogleAdsClickSync({ maxBackfill: 2 }, deps({ fetchDay }));
    expect(fetchDay.mock.calls.filter((c) => c[0] === "A")).toHaveLength(1);
    expect(r).toMatchObject({ ok: true, status: "done", daysRead: 4 });
    expect(r.warnings[0]).toMatch(/^A: sem acesso/);
  });

  it("um dia com erro não pára os outros; nada lido e só erros → failed", async () => {
    const some = await runGoogleAdsClickSync({ maxBackfill: 0 }, deps({ fetchDay: async (id, day) => { if (day === "2026-10-08") throw new Error("500"); return []; } }));
    expect(some).toMatchObject({ ok: true, status: "done", daysRead: 2 });
    expect(some.warnings).toHaveLength(2);
    const none = await runGoogleAdsClickSync({ maxBackfill: 0 }, deps({ fetchDay: async () => { throw new Error("rede"); } }));
    expect(none).toMatchObject({ ok: false, status: "failed" });
  });

  it("token recusado → failed e pára tudo; prazo → parcial (o resto na volta seguinte)", async () => {
    const fetchDay = vi.fn(async () => { const e: any = new Error("invalid_grant"); e.oauthError = "invalid_grant"; throw e; });
    expect(await runGoogleAdsClickSync({}, deps({ fetchDay }))).toMatchObject({ ok: false, status: "failed" });
    expect(fetchDay).toHaveBeenCalledTimes(1);
    let n = 0;
    const cut = await runGoogleAdsClickSync({}, deps({ fetchDay: async (id, day) => { if (++n === 3) { const e: any = new Error("sem tempo"); e.deadline = true; throw e; } return [{ gclid: `${id}${day}`, campaignId: "1", adGroupId: null, date: day }]; } }));
    expect(cut).toMatchObject({ ok: true, done: false, status: "partial", daysRead: 2 });
    // prazo já esgotado antes de começar → não pede nada
    const fetch2 = vi.fn();
    expect(await runGoogleAdsClickSync({ deadlineAt: Date.now() + 1_000 }, deps({ fetchDay: fetch2 }))).toMatchObject({ status: "partial", daysRead: 0 });
    expect(fetch2).not.toHaveBeenCalled();
  });
});

// ─── BD: só INSERT … ON DUPLICATE KEY UPDATE, nunca DELETE ──────────────────

describe("sem DELETE (tabela de apoio, sem purga)", () => {
  it("gravar um dia = INSERT … ON DUPLICATE KEY UPDATE dos cliques e do dia", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const store = mysqlClickStore({ execute: async (q: any) => { calls.push(render(q)); return [[]]; } });
    const rows = Array.from({ length: 1001 }, (_, i) => ({ gclid: `g${i}`, campaignId: "555", adGroupId: null, date: "2026-10-07" }));
    expect(await store.saveDay("123", "2026-10-07", rows)).toBe(1001);
    expect(calls).toHaveLength(4); // 3 pedaços de ≤ 500 + o dia
    for (const c of calls) {
      expect(c.sql).toMatch(/^\s*INSERT INTO google_ads_click/);
      expect(c.sql).toMatch(/ON DUPLICATE KEY UPDATE/);
      expect(c.sql).not.toMatch(/\bDELETE\b|\bTRUNCATE\b|\bDROP\b/i);
    }
    expect(calls[3].params).toEqual(["123", "2026-10-07", 1001, expect.any(String)]);
  });

  it("nem no código, nem na migração", () => {
    for (const f of ["./clicks.ts", "./clickAttribution.ts", "../../migrations/migration_0610.ts"]) {
      expect(src(f), f).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE|DROP\s+TABLE)\b/i);
    }
    expect(MIGRATION_0610_STATEMENTS.every((s) => /^CREATE TABLE IF NOT EXISTS/.test(s))).toBe(true);
    // gclid comparado à letra (distingue maiúsculas)
    expect(MIGRATION_0610_STATEMENTS[0]).toMatch(/`gclid` VARCHAR\(128\) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL/);
    expect(MIGRATION_0610_STATEMENTS[0]).toMatch(/PRIMARY KEY \(`gclid`\)/);
  });
});

// ─── atribuição: link > gclid; em lote ──────────────────────────────────────

describe("reserva → campanha pelo clique (gclid)", () => {
  const clicks = new Map([["G-KNOWN", { customerId: "123", campaignId: "555" }]]);
  const b = (o: any) => ({ id: "x", adAttribution: "google_paid", adCampaignExternalId: null, gclid: null, ...o });

  it("o ID no link ganha; gclid conhecido → campanha do clique; gclid desconhecido → sem ligação", () => {
    const input = [
      b({ id: "link", adCampaignExternalId: "999", gclid: "G-KNOWN" }),
      b({ id: "click", gclid: "G-KNOWN" }),
      b({ id: "unknown", gclid: "G-OTHER" }),
      b({ id: "none", adAttribution: "unknown" }),
    ];
    const out = applyClickCampaigns(input, clicks);
    expect(out.map((x) => [x.id, x.adCampaignExternalId, x.campaignEvidence])).toEqual([
      ["link", "999", "link"], ["click", "555", "gclid"], ["unknown", null, null], ["none", null, null],
    ]);
    // não mexe na lista de entrada (vem de uma cache partilhada)
    expect(input[1].adCampaignExternalId).toBeNull();
  });

  it("só procura os gclid das reservas sem ID no link, sem repetir", () => {
    expect(gclidsToResolve([b({ gclid: "A" }), b({ gclid: " A " }), b({ gclid: "B", adCampaignExternalId: "1" }), b({ gclid: "" }), b({})])).toEqual(["A"]);
  });

  it("em lote: UMA procura para todas as reservas; sem gclids não procura; procura em baixo → só o link", async () => {
    const lookup = vi.fn(async (g: string[]) => new Map(g.filter((x) => x === "G-KNOWN").map((x) => [x, { customerId: "123", campaignId: "555" }])));
    const out = await withClickCampaigns([b({ gclid: "G-KNOWN" }), b({ gclid: "G-OTHER" }), b({ gclid: "G-KNOWN" })], lookup);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0][0]).toEqual(["G-KNOWN", "G-OTHER"]);
    expect(out.map((x) => x.adCampaignExternalId)).toEqual(["555", null, "555"]);
    const none = vi.fn();
    await withClickCampaigns([b({ adCampaignExternalId: "1", gclid: "G" })], none);
    expect(none).not.toHaveBeenCalled();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const down = await withClickCampaigns([b({ gclid: "G-KNOWN" }), b({ adCampaignExternalId: "1" })], async () => { throw new Error("Table 'google_ads_clicks' doesn't exist"); });
    expect(down.map((x) => [x.adCampaignExternalId, x.campaignEvidence])).toEqual([[null, null], ["1", "link"]]);
    warn.mockRestore();
  });

  it("a procura na BD vai por pedaços (WHERE gclid IN …), nunca uma por reserva", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = { execute: async (q: any) => { const r = render(q); calls.push(r); return [r.params.filter((p) => p === "g7").map((g) => ({ gclid: g, customerId: "123", campaignId: "555" }))]; } };
    const gclids = Array.from({ length: GCLID_LOOKUP_CHUNK * 2 + 1 }, (_, i) => `g${i}`);
    const m = await lookupClickCampaigns(gclids, db);
    expect(calls).toHaveLength(3);
    expect(calls[0].sql).toMatch(/SELECT gclid, customerId, campaignId FROM google_ads_clicks\s+WHERE gclid IN \(/);
    expect(calls[0].params).toHaveLength(GCLID_LOOKUP_CHUNK);
    expect(m.get("g7")).toEqual({ customerId: "123", campaignId: "555" });
    expect(await lookupClickCampaigns([], db)).toEqual(new Map());
    expect(calls).toHaveLength(3);
  });

  it("ROAS por campanha: a ligação pelo clique entra como ID e fica marcada \"gclid\"", () => {
    const campaigns = [{ key: "api:1:555", provider: "google_ads", externalId: "555", campaignId: 10 }];
    const links = [{ id: 1, adCampaignId: 10, keyType: "utm_campaign" as const, keyValue: "verao" }];
    const bk = (o: any) => ({ id: 1, adAttribution: "google_paid", ext: null, utmCampaign: null, code: null, codeName: null, totalPrice: 50, ...o });
    const by = matchBookingsToCampaignsBy([bk({ id: 1, ext: "555" }), bk({ id: 2, ext: "555", via: "gclid" }), bk({ id: 3, utmCampaign: "Verao" }), bk({ id: 4, ext: "000", via: "gclid" })], campaigns, links);
    expect(by.get("api:1:555")!.map((m) => [m.booking.id, m.by])).toEqual([[1, "link"], [2, "gclid"], [3, "utm"]]);
    // a lista simples continua igual
    expect(matchBookingsToCampaigns([bk({ id: 2, ext: "555", via: "gclid" })], campaigns, links).get("api:1:555")!.map((x) => x.id)).toEqual([2]);
    expect(describeMatchCounts({ link: 1, gclid: 2, utm: 0 })).toBe("1 · ID da campanha no link; 2 · gclid → campanha (Google Ads)");
  });
});

// ─── agendador ──────────────────────────────────────────────────────────────

describe("agendador: leitura dos cliques de hora a hora", () => {
  it("trabalho próprio, de hora a hora, com função e entrada nos crons conhecidos", async () => {
    const j = TICK_JOBS.find((x) => x.key === "google-ads-clicks")!;
    expect(j).toBeTruthy();
    expect(describeCadence(j.cadence)).toBe("de hora a hora");
    expect(j.runName).toBe("google-ads-clicks");
    expect(CRON_JOBS.find((c) => c.name === "google-ads-clicks")?.intervalMinutes).toBe(60);
    const { JOB_RUNNERS } = await import("../../cronScheduler");
    expect(typeof JOB_RUNNERS["google-ads-clicks"]).toBe("function");
  });

  it("a volta fica sempre feita (o corte do prazo segue na hora seguinte, não retoma à frente dos outros)", async () => {
    vi.resetModules();
    vi.doMock("./clicks", () => ({ runGoogleAdsClickSync: async () => ({ ok: true, done: false, status: "partial", daysRead: 3, warnings: [] }) }));
    const { googleAdsClicksCron } = await import("../../cronJobs");
    const r = await googleAdsClicksCron({ deadlineAt: Date.now() + 30_000 });
    expect(r).toMatchObject({ httpStatus: 200, done: true, body: { status: "partial", done: true } });
    vi.doUnmock("./clicks");
  });
});
