/**
 * Web & SEO — o que a app usa: configuração, vista geral (KPIs com
 * comparação, séries, canais, dispositivos, funil, ligação ao negócio),
 * alertas diários (notify), resumo semanal (IA lite) e o teste de acesso
 * ("Testar" nas Integrações e nas Definições).
 */
import {
  DEFAULT_WEB_ANALYTICS_CONFIG, WEB_ANALYTICS_SETTING_KEY, businessJoin, comparisonRange, cruxTargets, daysBetweenInclusive, evaluateWebAlerts, parseCursor,
  scopeByBrand, webFactsText, webInsightFallback,
  type AlertInputs, type CompareMode, type WebAlert, type WebAnalyticsConfig, type WebWeekFacts,
} from "../../shared/webAnalytics";
import { addDays, daysInRange } from "../../shared/lisbonDay";
import { adSpendByDay, bookingsByDay, dimCompare, gaDaily, gaDailyByProperty, scDaily, scDailyBySite, sumGa, sumSc } from "./queries";
import { cursorKey, errorKey, gaUnitKey, scUnitKey, type LastRunInfo } from "./sync";

export async function loadWebAnalyticsConfig(): Promise<WebAnalyticsConfig> {
  const { getSetting } = await import("../appSettings");
  return ((await getSetting(WEB_ANALYTICS_SETTING_KEY as any)) as WebAnalyticsConfig | null) ?? DEFAULT_WEB_ANALYTICS_CONFIG;
}

async function state() {
  const { dbWebStore } = await import("./store");
  return dbWebStore;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

// ─── Vista geral ────────────────────────────────────────────────────────────

export interface OverviewInput { from: string; to: string; brand?: string | null; compare: CompareMode }

export async function webOverview(i: OverviewInput) {
  const cfg = await loadWebAnalyticsConfig();
  const brand = i.brand || null;
  const scope = scopeByBrand(cfg, brand);
  const prev = comparisonRange(i.from, i.to, i.compare);
  const cur = { from: i.from, to: i.to };
  const [gaCur, gaPrev, scCur, scPrev] = await Promise.all([
    gaDaily(scope.properties, cur.from, cur.to), gaDaily(scope.properties, prev.from, prev.to),
    scDaily(scope.sites, cur.from, cur.to), scDaily(scope.sites, prev.from, prev.to),
  ]);
  const list = (source: "ga" | "sc", dim: any, limit: number, sort: any) =>
    dimCompare({ source, ids: source === "ga" ? scope.properties : scope.sites, dim, cur, prev, sort, limit, offset: 0 }).then((r) => r.rows);
  const [channels, devicesGa, devicesSc, events] = await Promise.all([
    list("ga", "channel", 12, "sessions"), list("ga", "device", 6, "sessions"), list("sc", "device", 6, "clicks"), list("ga", "event", 20, "sessions"),
  ]);
  // Negócio: reservas (Multipark) e gasto (anúncios) no mesmo período e marca.
  const [bookCur, bookPrev, spendCur, spendPrev] = await Promise.all([
    bookingsByDay(cur.from, cur.to, brand).catch(() => new Map()), bookingsByDay(prev.from, prev.to, brand).catch(() => new Map()),
    adSpendByDay(cur.from, cur.to, brand), adSpendByDay(prev.from, prev.to, brand),
  ]);
  const sessionsMap = (rows: typeof gaCur) => new Map(rows.map((r) => [r.day, r.sessions]));
  const business = businessJoin(daysInRange(cur.from, cur.to), { sessions: sessionsMap(gaCur), bookings: bookCur, spend: spendCur.byDay });
  const businessPrev = businessJoin(daysInRange(prev.from, prev.to), { sessions: sessionsMap(gaPrev), bookings: bookPrev, spend: spendPrev.byDay });

  // Séries alinhadas (dia i do período ↔ dia i da comparação).
  const curDays = daysInRange(cur.from, cur.to), prevDays = daysInRange(prev.from, prev.to);
  const gaBy = new Map(gaCur.map((r) => [r.day, r])), gaPrevBy = new Map(gaPrev.map((r) => [r.day, r]));
  const scBy = new Map(scCur.map((r) => [r.day, r])), scPrevBy = new Map(scPrev.map((r) => [r.day, r]));
  const series = curDays.map((day, idx) => {
    const pd = prevDays[idx];
    const b = business.rows[idx];
    return {
      day,
      sessions: gaBy.get(day)?.sessions ?? 0, prevSessions: pd ? gaPrevBy.get(pd)?.sessions ?? 0 : null,
      users: gaBy.get(day)?.totalUsers ?? 0, keyEvents: gaBy.get(day)?.keyEvents ?? 0,
      clicks: scBy.get(day)?.clicks ?? null, prevClicks: pd ? scPrevBy.get(pd)?.clicks ?? null : null,
      impressions: scBy.get(day)?.impressions ?? null, position: scBy.get(day)?.position ?? null,
      siteBookings: b?.siteBookings ?? 0, conversionRate: b?.conversionRate ?? null, spend: b?.spend ?? 0,
    };
  });
  // Funil pela ordem das Definições (só os eventos que existem).
  const evBy = new Map(events.map((e) => [e.value, e]));
  const funnel = cfg.funnelEvents.filter((e) => evBy.has(e)).map((e) => ({ event: e, count: evBy.get(e)!.cur.events ?? 0, prevCount: evBy.get(e)!.prev.events ?? 0 }));

  const store = await state();
  const lastRun = parseJson<LastRunInfo>(await store.getState("lastRun"));
  const insight = parseJson<{ week: string; from: string; to: string; text: string; ai: boolean; createdAt: string }>(await store.getState("insight:latest"));
  const alerts = parseJson<{ day: string; alerts: WebAlert[] }>(await store.getState("alerts:latest"));
  const coverage = async (key: string) => { const c = parseCursor(await store.getState(cursorKey(key))); return { from: c.coveredFrom, to: c.coveredTo }; };
  const sources = [
    ...(await Promise.all(cfg.ga4Properties.filter((p) => p.active && scope.properties.includes(p.propertyId)).map(async (p) => ({
      source: "ga" as const, id: p.propertyId, label: p.label || `GA4 ${p.propertyId}`, brand: p.brand, error: await store.getState(errorKey("ga", p.propertyId)), coverage: await coverage(gaUnitKey(p.propertyId, "totals")),
    })))),
    ...(await Promise.all(cfg.searchConsoleSites.filter((s) => s.active && scope.sites.includes(s.siteUrl)).map(async (s) => ({
      source: "sc" as const, id: s.siteUrl, label: s.label || s.siteUrl, brand: s.brand, error: await store.getState(errorKey("sc", s.siteUrl)), coverage: await coverage(scUnitKey(s.siteUrl, "totals")),
    })))),
  ];
  const brands = Array.from(new Set([...cfg.ga4Properties, ...cfg.searchConsoleSites, ...cfg.pagespeedUrls].filter((x: any) => (x.active ?? true) && x.brand).map((x) => x.brand)));

  return {
    configured: cfg.enabled && (cfg.ga4Properties.length > 0 || cfg.searchConsoleSites.length > 0),
    enabled: cfg.enabled,
    range: cur,
    prevRange: prev,
    days: daysBetweenInclusive(cur.from, cur.to),
    brands,
    sources,
    ga: { cur: sumGa(gaCur), prev: sumGa(gaPrev), hasData: gaCur.length > 0 },
    sc: { cur: sumSc(scCur), prev: sumSc(scPrev), hasData: scCur.length > 0 },
    series,
    channels,
    devices: { ga: devicesGa, sc: devicesSc },
    funnel,
    business: { totals: business.totals, prevTotals: businessPrev.totals, adSpendAvailable: spendCur.available },
    lastRun,
    lastSuccessAt: await store.getState("lastSuccessAt"),
    insight,
    alerts,
  };
}

// ─── Alertas (1×/dia, depois da atualização) ────────────────────────────────

export async function buildAlertInputs(cfg: WebAnalyticsConfig, today: string) {
  const { dbWebStore } = await import("./store");
  const props = cfg.ga4Properties.filter((p) => p.active);
  const sites = cfg.searchConsoleSites.filter((s) => s.active);
  const yesterday = addDays(today, -1);
  const scEnd = addDays(today, -3);
  const gaRows = await gaDailyByProperty(props.map((p) => p.propertyId), addDays(yesterday, -8), yesterday);
  const scRows = await scDailyBySite(sites.map((s) => s.siteUrl), addDays(scEnd, -13), scEnd);
  const latest = await dbWebStore.latestPagespeed();
  const psLabel = new Map(cfg.pagespeedUrls.map((u) => [u.url, u.label]));
  // Dados reais (CrUX) das páginas-chave: a própria página ou, sem dados, a origem.
  let crux: AlertInputs["crux"] = [];
  if (cfg.cruxEnabled) {
    try {
      const { latestCrux } = await import("./queries");
      const keyTargets = cruxTargets(cfg.pagespeedUrls).filter((t) => t.type === "url" && t.keyUrl);
      const origins = Array.from(new Set(keyTargets.map((t) => new URL(t.target).origin))).map((o) => ({ type: "origin", target: o }));
      const recs = await latestCrux([...keyTargets, ...origins]);
      const seenOrigin = new Set<string>();
      for (const t of keyTargets) {
        for (const ff of ["PHONE", "DESKTOP"]) {
          const own = recs.find((r) => r.targetType === "url" && r.target === t.target && r.formFactor === ff);
          const origin = new URL(t.target).origin;
          const rec = own ?? (seenOrigin.has(`${origin}:${ff}`) ? null : recs.find((r) => r.targetType === "origin" && r.target === origin && r.formFactor === ff));
          if (!rec) continue;
          if (!own) seenOrigin.add(`${origin}:${ff}`);
          crux.push({ target: rec.target, label: own ? t.label : `${new URL(origin).host} (site todo)`, formFactor: ff, periodEnd: rec.periodEnd, lcpP75: rec.lcpP75, inpP75: rec.inpP75, clsP75: rec.clsP75 });
        }
      }
    } catch { crux = []; }
  }
  const queries: Array<{ siteId: string; siteLabel: string; query: string; prevClicks: number; curPosition: number | null; prevPosition: number | null }> = [];
  const curR = { from: addDays(scEnd, -6), to: scEnd };
  const prevR = { from: addDays(scEnd, -13), to: addDays(scEnd, -7) };
  for (const s of sites) {
    const r = await dimCompare({ source: "sc", ids: [s.siteUrl], dim: "query", cur: curR, prev: prevR, sort: "clicks", limit: 200, offset: 0 });
    for (const q of r.rows) queries.push({ siteId: s.siteUrl, siteLabel: s.label || s.siteUrl, query: q.value, prevClicks: q.prev.clicks ?? 0, curPosition: q.position, prevPosition: q.prevPosition });
  }
  return {
    today, scEnd, thresholds: cfg.alerts,
    ga: props.map((p) => ({ id: p.propertyId, label: p.label || `GA4 ${p.propertyId}`, days: gaRows.filter((r) => r.propertyId === p.propertyId) })),
    sc: sites.map((s) => ({ id: s.siteUrl, label: s.label || s.siteUrl, days: scRows.filter((r) => r.siteUrl === s.siteUrl) })),
    pagespeed: latest.filter((l) => psLabel.has(l.url)).map((l) => ({ ...l, label: psLabel.get(l.url) ?? l.url })),
    queries,
    crux,
  };
}

export async function runWebAlerts(cfg: WebAnalyticsConfig, today: string, o: { force?: boolean } = {}): Promise<number | null> {
  const store = await state();
  if (!o.force && (await store.getState("alerts:day")) === today) return null;
  const alerts = evaluateWebAlerts(await buildAlertInputs(cfg, today));
  if (alerts.length) {
    const { notify } = await import("../notify");
    for (const a of alerts) {
      await notify({
        kind: "web_analytics_alert",
        title: a.title,
        body: [a.detail, ...(a.items ?? []).map((x) => `• ${x}`)].join("\n"),
        link: "/marketing/web",
        entity: { type: "web_alert", id: a.key },
      });
    }
  }
  await store.setState("alerts:latest", JSON.stringify({ day: today, alerts }));
  await store.setState("alerts:day", today);
  return alerts.length;
}

// ─── Resumo semanal ("o que mudou e porquê") ───────────────────────────────

/** Segunda-feira da semana de `day`. PURA. */
export function mondayOf(day: string): string {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 = domingo
  return addDays(day, -((dow + 6) % 7));
}

export async function buildWeekFacts(cfg: WebAnalyticsConfig, today: string): Promise<WebWeekFacts> {
  const scope = scopeByBrand(cfg, null);
  // Semana móvel até ao último dia completo das duas fontes (Search Console ~3 dias).
  const to = addDays(today, -3), from = addDays(to, -6);
  const prevTo = addDays(from, -1), prevFrom = addDays(prevTo, -6);
  const cur = { from, to }, prev = { from: prevFrom, to: prevTo };
  const [gaC, gaP, scC, scP] = await Promise.all([gaDaily(scope.properties, from, to), gaDaily(scope.properties, prevFrom, prevTo), scDaily(scope.sites, from, to), scDaily(scope.sites, prevFrom, prevTo)]);
  const g = sumGa(gaC), gp = sumGa(gaP), s = sumSc(scC), sp = sumSc(scP);
  const channels = scope.properties.length ? (await dimCompare({ source: "ga", ids: scope.properties, dim: "channel", cur, prev, sort: "sessions", limit: 8, offset: 0 })).rows : [];
  const gain = scope.sites.length ? (await dimCompare({ source: "sc", ids: scope.sites, dim: "query", cur, prev, sort: "gaining", limit: 5, offset: 0 })).rows : [];
  const lose = scope.sites.length ? (await dimCompare({ source: "sc", ids: scope.sites, dim: "query", cur, prev, sort: "losing", limit: 5, offset: 0 })).rows : [];
  const { dbWebStore } = await import("./store");
  const latest = (await dbWebStore.latestPagespeed()).filter((l) => l.strategy === "mobile");
  const psLabel = new Map(cfg.pagespeedUrls.map((u) => [u.url, u.label || u.url]));
  let bookings: WebWeekFacts["bookings"] = null;
  try {
    const sum = (m: Map<string, { siteBookings: number }>) => Array.from(m.values()).reduce((t, x) => t + x.siteBookings, 0);
    bookings = { siteBookings: sum(await bookingsByDay(from, to, null)), prevSiteBookings: sum(await bookingsByDay(prevFrom, prevTo, null)) };
  } catch { bookings = null; }
  return {
    from, to,
    ga: gaC.length ? { sessions: g.sessions, prevSessions: gp.sessions, users: g.totalUsers, prevUsers: gp.totalUsers, keyEvents: g.keyEvents, prevKeyEvents: gp.keyEvents, revenue: g.revenue, prevRevenue: gp.revenue } : null,
    channels: channels.map((c) => ({ name: c.value, cur: c.cur.sessions ?? 0, prev: c.prev.sessions ?? 0 })),
    sc: scC.length ? { clicks: s.clicks, prevClicks: sp.clicks, impressions: s.impressions, prevImpressions: sp.impressions, position: s.position, prevPosition: sp.position } : null,
    gainers: gain.map((q) => ({ query: q.value, delta: (q.cur.clicks ?? 0) - (q.prev.clicks ?? 0) })).filter((q) => q.delta > 0),
    losers: lose.map((q) => ({ query: q.value, delta: (q.cur.clicks ?? 0) - (q.prev.clicks ?? 0) })).filter((q) => q.delta < 0),
    pagespeed: latest.filter((l) => psLabel.has(l.url)).map((l) => ({ label: psLabel.get(l.url)!, score: l.score })),
    bookings,
  };
}

const INSIGHT_SYSTEM = [
  "És analista de marketing digital da Multipark (parques de estacionamento e valet nos aeroportos de Lisboa, Porto e Faro).",
  "Recebes só totais agregados da última semana vs a anterior (Google Analytics 4, Search Console, PageSpeed e reservas feitas no site).",
  "Escreve em português de Portugal (PT-PT), 3 a 5 frases curtas, sem listas nem títulos: o que mudou e a explicação mais provável a partir dos números (canal, pesquisas, velocidade, sazonalidade).",
  "Usa só os números dados; nunca inventes valores nem causas que os dados não suportem — se não houver explicação clara, diz que é preciso ver mais detalhe.",
].join(" ");

export async function runWebInsight(cfg: WebAnalyticsConfig, today: string, o: { force?: boolean } = {}): Promise<{ created: boolean; ai: boolean } | null> {
  const store = await state();
  const week = mondayOf(today);
  if (!o.force && (await store.getState("insight:week")) === week) return null;
  const facts = await buildWeekFacts(cfg, today);
  if (!facts.ga && !facts.sc) return { created: false, ai: false };
  let text = webInsightFallback(facts);
  let ai = false;
  if (cfg.aiInsight) {
    const { tryAi } = await import("../aiOps/aiCall");
    const r = await tryAi({ feature: "web_insight", system: INSIGHT_SYSTEM, input: webFactsText(facts), maxTokens: 350, entity: "web_insight" });
    if (r.ok && typeof r.output === "string" && r.output.trim()) { text = r.output.replace(/\s+/g, " ").trim().slice(0, 1200); ai = true; }
  }
  await store.setState("insight:latest", JSON.stringify({ week, from: facts.from, to: facts.to, text, ai, createdAt: new Date().toISOString() }));
  await store.setState("insight:week", week);
  return { created: true, ai };
}

/** Linha para o relatório semanal de marketing (se houver resumo recente). */
export async function webInsightNote(maxAgeDays = 8): Promise<string | null> {
  try {
    const store = await state();
    const v = parseJson<{ text: string; createdAt: string }>(await store.getState("insight:latest"));
    if (!v?.text || !v.createdAt) return null;
    if (Date.now() - Date.parse(v.createdAt) > maxAgeDays * 86_400_000) return null;
    return `Web & SEO: ${v.text}`.slice(0, 600);
  } catch {
    return null;
  }
}

// ─── Teste de acesso (Integrações → Testar / Definições) ────────────────────

export interface AccessCheck {
  serviceAccountEmail: string | null;
  impersonating: string | null;
  ga: Array<{ id: string; label: string; ok: boolean; error: string | null }>;
  sc: Array<{ id: string; label: string; ok: boolean; permissionLevel: string | null; error: string | null }>;
}

const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`Sem resposta em ${Math.round(ms / 1000)}s`)), ms); })]).finally(() => t && clearTimeout(t));
};

/** Lê cada propriedade GA4 e da Search Console configurada (pedido mínimo, em paralelo). */
export async function checkWebAccess(which: { ga?: boolean; sc?: boolean } = { ga: true, sc: true }): Promise<AccessCheck> {
  const cfg = await loadWebAnalyticsConfig();
  const { workspaceConfig, googleErrorMessage } = await import("../google/workspace");
  const email = workspaceConfig().serviceAccount?.client_email ?? null;
  const out: AccessCheck = { serviceAccountEmail: email, impersonating: cfg.impersonateEmail || null, ga: [], sc: [] };
  if (!email) {
    const err = "Conta de serviço em falta no servidor.";
    if (which.ga) out.ga = cfg.ga4Properties.map((p) => ({ id: p.propertyId, label: p.label, ok: false, error: err }));
    if (which.sc) out.sc = cfg.searchConsoleSites.map((s) => ({ id: s.siteUrl, label: s.label, ok: false, permissionLevel: null, error: err }));
    return out;
  }
  const { webAuth, gaApi, scApi } = await import("./apis");
  const auth = webAuth(cfg.impersonateEmail || null);
  const retry = { deadlineAt: Date.now() + 20_000, retries: 1 };
  if (which.ga) {
    const api = gaApi(auth, retry);
    out.ga = await Promise.all(cfg.ga4Properties.map(async (p) => {
      try {
        await withTimeout(api.runReport(p.propertyId, { dateRanges: [{ startDate: "7daysAgo", endDate: "yesterday" }], metrics: [{ name: "sessions" }], limit: "1" }), 18_000);
        return { id: p.propertyId, label: p.label, ok: true, error: null };
      } catch (err) {
        return { id: p.propertyId, label: p.label, ok: false, error: googleErrorMessage(err).slice(0, 200) };
      }
    }));
  }
  if (which.sc) {
    const api = scApi(auth, retry);
    out.sc = await Promise.all(cfg.searchConsoleSites.map(async (s) => {
      try {
        const r = await withTimeout(api.getSite(s.siteUrl), 18_000);
        const ok = !!r.permissionLevel && r.permissionLevel !== "siteUnverifiedUser";
        return { id: s.siteUrl, label: s.label, ok, permissionLevel: r.permissionLevel, error: ok ? null : "A conta de serviço não é utilizadora desta propriedade." };
      } catch (err) {
        return { id: s.siteUrl, label: s.label, ok: false, permissionLevel: null, error: googleErrorMessage(err).slice(0, 200) };
      }
    }));
  }
  return out;
}

/** Mensagem do "Testar" (lança com a lista do que falta e o email a adicionar). */
export function accessCheckMessage(kind: "ga" | "sc", c: AccessCheck): string {
  const list = kind === "ga" ? c.ga : c.sc;
  const what = kind === "ga" ? "propriedade(s) GA4" : "propriedade(s) da Search Console";
  if (!list.length) throw new Error(`Nenhuma ${what} configurada (Definições → Integrações → Web & SEO).`);
  const bad = list.filter((x) => !x.ok);
  const who = c.impersonating ? `a conta ${c.impersonating} (delegação)` : `a conta de serviço ${c.serviceAccountEmail ?? "(em falta)"}`;
  if (bad.length) {
    const how = kind === "ga" ? "GA4 → Administração → Gestão de acesso à propriedade → + → Leitor" : "Search Console → Definições → Utilizadores e autorizações → Adicionar utilizador (Restrito)";
    throw new Error(`Sem acesso a ${bad.length} de ${list.length} ${what}: ${bad.map((b) => `${b.label || b.id} (${b.error ?? "sem acesso"})`).join("; ")}. Adiciona ${who} em ${how}.`.slice(0, 600));
  }
  return `Acesso OK a ${list.length} ${what} (${who}).`;
}

export async function testPagespeed(): Promise<string> {
  const cfg = await loadWebAnalyticsConfig();
  const url = cfg.pagespeedUrls[0]?.url;
  if (!url) throw new Error("Nenhuma página configurada para a PageSpeed (Definições → Integrações → Web & SEO).");
  const { psiApi } = await import("./apis");
  const { parsePagespeed } = await import("../../shared/webAnalytics");
  const res = parsePagespeed(await psiApi().run(url, "mobile", 45_000));
  const keyNote = String(process.env.GOOGLE_PAGESPEED_API_KEY ?? "").trim() ? "com chave" : "sem chave (quota baixa — recomenda-se GOOGLE_PAGESPEED_API_KEY)";
  return `PageSpeed respondeu ${keyNote}: ${url} — móvel ${res.score ?? "?"}/100.`;
}

/** "Testar" da Chrome UX Report: dados reais da origem da 1.ª página (telemóvel). */
export async function testCrux(): Promise<string> {
  const cfg = await loadWebAnalyticsConfig();
  const url = cfg.pagespeedUrls[0]?.url;
  if (!url) throw new Error("Nenhuma página configurada (Definições → Integrações → Web & SEO).");
  const { cruxApi } = await import("./apis");
  const api = cruxApi();
  if (!api) throw new Error("Sem chave: define GOOGLE_PAGESPEED_API_KEY (ou GOOGLE_CRUX_API_KEY) no Vercel e ativa a \"Chrome UX Report API\" no projeto da chave.");
  const { parseCruxHistory } = await import("../../shared/webAnalytics");
  const origin = new URL(url).origin;
  const res = await api.history({ type: "origin", target: origin }, "PHONE", 15_000);
  if (!res) return `Chrome UX Report respondeu: ${origin} ainda não tem visitas Chrome suficientes para dados reais (normal em sites pequenos).`;
  const rows = parseCruxHistory(res);
  const last = rows[rows.length - 1];
  if (!last) return `Chrome UX Report respondeu (${origin}) mas sem métricas.`;
  const s = (v: number | null) => (v == null ? "—" : `${(v / 1000).toFixed(1).replace(".", ",")} s`);
  return `Chrome UX Report OK — ${origin} (telemóvel, 28 dias até ${last.periodEnd}): LCP ${s(last.p75.lcp)}, INP ${last.p75.inp ?? "—"} ms, CLS ${last.p75.cls ?? "—"} (${rows.length} período(s) de histórico).`;
}

const EXPLAIN_SYSTEM = [
  "És especialista em desempenho web e explicas a uma equipa de marketing (não técnica) de uma empresa de estacionamento em aeroportos.",
  "Recebes a lista de problemas do Lighthouse (PageSpeed) de UMA página, já ordenada por impacto, com a poupança estimada.",
  "Em português de Portugal (PT-PT), explica em 3 a 6 pontos curtos (começa cada um por \"- \") o que corrigir primeiro e porquê, em linguagem simples, e a quem pedir (quem gere o site/programador).",
  "Usa só os dados dados; não inventes números nem ferramentas; se a lista estiver vazia, diz que não há nada urgente.",
].join(" ");

/** Explicação IA (lite) das oportunidades mais recentes de uma página; sem IA → null. */
export async function explainOpportunities(url: string, strategy: "mobile" | "desktop", userId: number): Promise<{ text: string | null; skipped: string | null }> {
  const { latestAudits } = await import("./queries");
  const audits = await latestAudits(url, strategy);
  if (!audits.length) return { text: null, skipped: "empty" };
  const lines = audits.slice(0, 10).map((a, i) => `${i + 1}. ${a.title}${a.savingsMs ? ` — poupa ~${(a.savingsMs / 1000).toFixed(1)} s` : ""}${a.savingsBytes ? ` — ${Math.round(a.savingsBytes / 1024)} KB` : ""}${a.displayValue ? ` (${a.displayValue})` : ""}`);
  const { tryAi } = await import("../aiOps/aiCall");
  const r = await tryAi({ feature: "pagespeed_explain", system: EXPLAIN_SYSTEM, input: `Página (${strategy === "mobile" ? "telemóvel" : "computador"}): ${new URL(url).pathname}\n${lines.join("\n")}`, maxTokens: 450, userId, entity: "pagespeed_explain" });
  if (!r.ok) return { text: null, skipped: r.skipped };
  return { text: String(r.output ?? "").trim().slice(0, 2000) || null, skipped: null };
}
