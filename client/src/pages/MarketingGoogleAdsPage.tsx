import React, { useState, useMemo } from "react";
import { can, roleRank, seesBeyondOwn } from "@shared/access";
import { trpc } from "@/lib/trpc";
import DateRangeNav from "@/components/DateRangeNav";
import { campaignTabBrand } from "@shared/adCampaignMapping";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Megaphone, BarChart3, CheckCircle2, Loader2, TrendingUp } from "lucide-react";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import CampaignRoasPanel from "@/components/marketing/CampaignRoasPanel";

/**
 * Marketing → Google Ads (Jorge, 16 set 2026). É UMA das páginas do Marketing
 * (a outra é o Dashboard, em MarketingPage.tsx):
 *  - "Por marca": gasto por MARCA (a escolhida em cada campanha; sem escolha,
 *    a da conta — Multipark.pt e Multipark SA são a marca Marketplace),
 *    reservas reais dessa marca, as que vieram pelos anúncios e o seu valor;
 *  - um separador por CONTA Google, com as campanhas divididas por
 *    marca/cidade (+ reservas dessa marca/cidade para comparar com as
 *    conversões da Google). "Nacional" (Brand, Pmax, Portugal) mostra-se à
 *    parte, mas o gasto é repartido pelas cidades da marca.
 * Tudo vem das APIs (Google Ads e Meta, recolha diária); não há importações
 * manuais. Mesmo gasto e mesmo âmbito (cidades do utilizador + filtro global
 * de projeto) do Dashboard — a fonte única é getAdMetrics.
 * "ROAS por campanha": gasto → reservas ligadas, ROAS s/ IVA e CPA.
 */

// Dia de calendário em Lisboa (o toISOString() dava o último dia do mês anterior no verão).
function lisbonDay(d = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

// PT-PT via Intl ("12,34 €"), como no resto do Marketing
const EUR = new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eur = (v: number | null | undefined) => (v == null ? "—" : EUR.format(Number(v)));
const roasX = (v: number | null | undefined) => (v == null ? "—" : `${v.toFixed(2).replace(".", ",")}×`);
/** Estado da campanha na plataforma → etiqueta (removida/arquivada/pausada). */
export function campaignStatusBadge(status: string | null | undefined): { label: string; cls: string } | null {
  const s = String(status ?? "").toUpperCase();
  if (s === "REMOVED" || s === "DELETED") return { label: "removida", cls: "text-rose-700 border-rose-200" };
  if (s === "ARCHIVED") return { label: "arquivada", cls: "text-muted-foreground" };
  if (s === "PAUSED" || s === "CAMPAIGN_PAUSED") return { label: "pausada", cls: "text-amber-700 border-amber-200" };
  return null;
}
const num = (v: number | null | undefined) => (v == null ? "—" : Number(v).toLocaleString("pt-PT"));

export default function MarketingGoogleAdsPage() {
  const today = lisbonDay();
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [tab, setTab] = useState("resumo");
  const { projectId } = useGlobalFilters();
  const range = { from, to, projectId };

  const { data: stats } = trpc.marketing.dashboard.useQuery(range);
  const { data: byBrand } = trpc.marketing.byBrand.useQuery(range);
  const { data: projects = [] } = trpc.projects.list.useQuery();
  const st: any = stats;
  const accounts: Array<{ id: number; name: string }> = byBrand?.accounts ?? [];

  // Separadores por MARCA (Jorge, 24 set 2026): uma campanha marcada "Airpark
  // Faro" aparece no separador Airpark, seja de que conta Google for (ex.:
  // "Estacionamento Aeroporto Faro" da conta Multipark.pt). Sem marca escolhida
  // (nacional ou por associar), fica na marca da conta.
  const brandTabs = useMemo(() => {
    const byId = new Map<number, any>((projects as any[]).map((p) => [p.id, p]));
    const brandOf = (projectId: number | null): string | null => {
      let node = projectId != null ? byId.get(projectId) : undefined; const seen = new Set<number>();
      while (node && node.level !== "brand") { if (seen.has(node.id) || node.parentId == null) return null; seen.add(node.id); node = byId.get(node.parentId); }
      return node ? String(node.name) : null;
    };
    const accountBrand = new Map<number, string>();
    for (const b of (byBrand?.brands ?? []) as any[]) for (const a of b.accounts ?? []) if (b.mapped) accountBrand.set(a.id, b.brand);
    const accountName = new Map(accounts.map((a) => [a.id, a.name]));
    const tabs = new Map<string, { brand: string; rows: any[]; cost: number }>();
    for (const r of (st?.byCampaign ?? []) as any[]) {
      if (r.accountId == null) continue;
      const brand = campaignTabBrand(r, projects as any[], accountBrand, accountName);
      const t = tabs.get(brand) ?? { brand, rows: [], cost: 0 };
      t.rows.push({ ...r, accountLabel: accountName.get(r.accountId) ?? null }); t.cost += r.cost;
      tabs.set(brand, t);
    }
    const shares = (brand: string) => ((st?.nationalShares ?? []) as any[]).filter((x) => brandOf(x.projectId) === brand);
    return Array.from(tabs.values()).sort((a, b) => b.cost - a.cost).map((t) => ({ ...t, nationalShares: shares(t.brand) }));
  }, [st, byBrand, projects, accounts]);

  const cov = st?.coverage;
  const covLabel = !cov ? "" : cov.status === "none" ? "Sem dados de anúncios no período" : cov.status === "partial" ? `Dados incompletos: ${cov.missingDays} dia(s) sem recolha` : cov.status === "stale" ? "Recolha parada há mais de um dia" : "Dados completos";
  const covCls = !cov || cov.status === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : cov.status === "none" ? "border-muted bg-muted/40 text-muted-foreground" : "border-amber-200 bg-amber-50 text-amber-900";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <p className="text-muted-foreground">Gasto em anúncios (Google Ads e Meta) por marca e por campanha, reservas por marca e ROAS por campanha</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Dados das APIs Google Ads e Meta (recolha diária da última semana; no dia 2, o mês anterior fechado). Contas e ligação em <a href="/integracoes/google-ads" className="underline">Integrações</a>. As faturas entram pelas Despesas.
          </p>
        </div>
        <div>
          <Label className="text-xs mb-1 block">Período</Label>
          <DateRangeNav start={from} end={to} gran="month" showAll={false} onChange={(s2, e2) => { setFrom(s2); setTo(e2); }} />
        </div>
      </div>

      {st && (
        <div className={`rounded-md border px-3 py-2 text-xs flex flex-wrap gap-x-4 gap-y-1 ${covCls}`} role="status">
          <span className="font-medium">{covLabel}</span>
          <span>Última recolha: {cov?.lastSuccessfulSyncAt ? fmtPTDateTime(cov.lastSuccessfulSyncAt) : "nunca"}</span>
          <span>Último dia completo: {cov?.lastCompleteDay ?? "—"}</span>
          {st.unmappedCampaigns > 0 && <span>{st.unmappedCampaigns} campanha(s) por associar (contam só no total da marca até escolheres cidade ou Nacional)</span>}
          {st.connection !== "connected" && <a href="/integracoes/google-ads" className="underline">Ligar Google Ads</a>}
        </div>
      )}
      {st && st.currencyExcluded?.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="alert">
          <span className="font-medium">Fora dos totais (moeda diferente de EUR, sem conversão): </span>
          {st.currencyExcluded
            .map((c: { accountId: number; accountName: string | null; currency: string; cost: number }) => `${c.accountName ?? `Conta ${c.accountId}`} — ${c.cost.toFixed(2)} ${c.currency}`).join("; ")}
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="resumo"><BarChart3 className="w-4 h-4 mr-1" />Por marca</TabsTrigger>
          <TabsTrigger value="roas"><TrendingUp className="w-4 h-4 mr-1" />ROAS por campanha</TabsTrigger>
          {brandTabs.map((a) => (
            <TabsTrigger key={a.brand} value={`marca-${a.brand}`}><Megaphone className="w-4 h-4 mr-1" />{a.brand}</TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="resumo" className="mt-4">
          <BrandSummary data={byBrand} />
        </TabsContent>
        <TabsContent value="roas" className="mt-4">
          {tab === "roas" && <CampaignRoasPanel from={from} to={to} projectId={projectId} />}
        </TabsContent>
        {brandTabs.map((t) => (
          <TabsContent key={t.brand} value={`marca-${t.brand}`} className="mt-4">
            <AccountCampaigns account={{ id: 0, name: t.brand }} rows={t.rows} projects={projects as any[]} byBrandCity={byBrand?.byBrandCity ?? []} nationalShares={t.nationalShares} attributedByCampaign={st?.attributedByCampaign ?? {}} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

// ─── POR MARCA (= conta Google) ───────────────────────────────────────────────
function BrandSummary({ data }: { data: any }) {
  if (!data) return <div className="flex justify-center py-12"><div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" /></div>;
  const rows: any[] = data.brands ?? [];
  if (!rows.length) {
    return (
      <Card className="p-12 text-center">
        <Megaphone className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
        <p className="text-muted-foreground">Sem gasto nem contas de anúncios selecionadas neste âmbito. Liga e seleciona as contas em Integrações.</p>
      </Card>
    );
  }
  const totals = rows.reduce((t, r) => ({ spend: t.spend + r.spend, spendGoogle: t.spendGoogle + (r.spendGoogle ?? 0), spendMeta: t.spendMeta + (r.spendMeta ?? 0), conversions: t.conversions + (r.conversions ?? 0), bookings: t.bookings + r.bookings, revenue: t.revenue + r.revenue, attributed: t.attributed + r.attributed, revenueAttributed: t.revenueAttributed + (r.revenueAttributed ?? 0) }), { spend: 0, spendGoogle: 0, spendMeta: 0, conversions: 0, bookings: 0, revenue: 0, attributed: 0, revenueAttributed: 0 });
  const vat = Number(data.vatRate ?? 0.23);
  const roasNet = (rev: number, spend: number) => (spend > 0 ? rev / (1 + vat) / spend : null);
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Gasto e reservas por marca</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Marca = a escolhida em cada campanha (uma campanha da conta Multipark.pt marcada como Airpark Faro conta na Airpark); sem escolha, a marca da conta (Multipark.pt e Multipark SA são a marca Marketplace). Reservas = reservas Multipark reais dessa marca, por data de criação (dias de Lisboa), sem canceladas. "Ligadas" são as que trazem gclid/fbclid/utm pago no URL de origem. ROAS s/ IVA = valor reservado ÷ 1,23 ÷ gasto. Com âmbito de cidade, o gasto é o imputado a essas cidades (nacional pela sua parte).
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Marca</th>
                  <th className="text-left px-4 py-2 font-medium">Conta(s)</th>
                  <th className="text-right px-4 py-2 font-medium">Google</th>
                  <th className="text-right px-4 py-2 font-medium">Meta</th>
                  <th className="text-right px-4 py-2 font-medium">Gasto total</th>
                  <th className="text-right px-4 py-2 font-medium" title="Conversões contadas pela Google (tag no site) — medem melhor os anúncios do que as reservas que conseguimos ligar">Conv. Google</th>
                  <th className="text-right px-4 py-2 font-medium">Custo / conv.</th>
                  <th className="text-right px-4 py-2 font-medium">Reservas</th>
                  <th className="text-right px-4 py-2 font-medium" title="Reservas com gclid/utm pago no URL de origem — fica abaixo das conversões quando o gclid se perde">Ligadas (gclid)</th>
                  <th className="text-right px-4 py-2 font-medium">Valor via anúncios</th>
                  <th className="text-right px-4 py-2 font-medium">Valor reservado</th>
                  <th className="text-right px-4 py-2 font-medium">Gasto / reserva</th>
                  <th className="text-right px-4 py-2 font-medium" title="Valor reservado sem IVA ÷ gasto (todas as reservas da marca)">ROAS (s/ IVA)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.brand} className="border-b">
                    <td className="px-4 py-2 font-semibold">{r.brand}{!r.mapped && <Badge variant="outline" className="ml-2 text-[10px] text-amber-700">conta sem marca</Badge>}</td>
                    <td className="px-4 py-2 text-muted-foreground">{r.accounts.map((a: any) => `${a.name}${a.provider === "meta" ? " (Meta)" : ""}`).join(", ")}</td>
                    <td className="px-4 py-2 text-right text-muted-foreground">{eur(r.spendGoogle ?? 0)}</td>
                    <td className="px-4 py-2 text-right text-muted-foreground">{eur(r.spendMeta ?? 0)}</td>
                    <td className="px-4 py-2 text-right">{eur(r.spend)}</td>
                    <td className="px-4 py-2 text-right font-semibold">{(r.conversions ?? 0).toFixed(1)}</td>
                    <td className="px-4 py-2 text-right text-muted-foreground">{r.conversions > 0 ? eur(r.spend / r.conversions) : "—"}</td>
                    <td className="px-4 py-2 text-right font-semibold">{num(r.bookings)}</td>
                    <td className="px-4 py-2 text-right">{num(r.attributed)}</td>
                    <td className="px-4 py-2 text-right">{eur(r.revenueAttributed)}</td>
                    <td className="px-4 py-2 text-right text-muted-foreground">{eur(r.revenue)}</td>
                    <td className="px-4 py-2 text-right">{r.bookings > 0 ? eur(r.spend / r.bookings) : "—"}</td>
                    <td className="px-4 py-2 text-right">{roasX(r.roasNet ?? roasNet(r.revenue, r.spend))}</td>
                  </tr>
                ))}
                <tr className="bg-muted/40 font-semibold">
                  <td className="px-4 py-2" colSpan={2}>Total</td>
                  <td className="px-4 py-2 text-right">{eur(totals.spendGoogle)}</td>
                  <td className="px-4 py-2 text-right">{eur(totals.spendMeta)}</td>
                  <td className="px-4 py-2 text-right">{eur(totals.spend)}</td>
                  <td className="px-4 py-2 text-right">{totals.conversions.toFixed(1)}</td>
                  <td className="px-4 py-2 text-right text-muted-foreground">{totals.conversions > 0 ? eur(totals.spend / totals.conversions) : "—"}</td>
                  <td className="px-4 py-2 text-right">{num(totals.bookings)}</td>
                  <td className="px-4 py-2 text-right">{num(totals.attributed)}</td>
                  <td className="px-4 py-2 text-right">{eur(totals.revenueAttributed)}</td>
                  <td className="px-4 py-2 text-right text-muted-foreground">{eur(totals.revenue)}</td>
                  <td className="px-4 py-2 text-right">{totals.bookings > 0 ? eur(totals.spend / totals.bookings) : "—"}</td>
                  <td className="px-4 py-2 text-right">{roasX(roasNet(totals.revenue, totals.spend))}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
      {data.bookingsWithoutBrand > 0 && (
        <p className="text-xs text-muted-foreground">{num(data.bookingsWithoutBrand)} reserva(s) do período sem parque/marca atribuída — não entram em nenhuma linha.</p>
      )}
      {data.unassignedSpend > 0 && (
        <p className="text-xs text-muted-foreground">{eur(data.unassignedSpend)} de gasto sem cidade (campanhas por associar ou nacional de marca sem cidades) — conta no total da marca, em nenhuma cidade.</p>
      )}
    </div>
  );
}

// ─── UMA CONTA: campanhas divididas por cidade ───────────────────────────────
type BrandCityStats = { projectId: number; bookings: number; attributed: number; revenue: number; revenueAttributed: number };
type NationalShare = { key: string; accountId: number; projectId: number; cost: number; clicks: number; conversions: number; conversionValue: number };

function AccountCampaigns({ account, rows, projects, byBrandCity, nationalShares, attributedByCampaign }: { account: { id: number; name: string }; rows: any[]; projects: any[]; byBrandCity: BrandCityStats[]; nationalShares: NationalShare[]; attributedByCampaign: Record<string, number> }) {
  // Reservas ligadas (gclid) desta campanha — a chave é "api:<conta>:<ID externo>".
  const linked = (r: any) => (String(r.key).startsWith("api:") ? attributedByCampaign[String(r.key).split(":").slice(2).join(":")] ?? 0 : null);
  const { user } = useAuth();
  const isAdmin = can(user, "marketing", "manage");
  const utils = trpc.useUtils();
  const refresh = () => { utils.marketing.dashboard.invalidate(); utils.marketing.byBrand.invalidate(); utils.marketing.campaignRoas.invalidate(); utils.integrations.googleAds.campaigns.suggest.invalidate(); };
  const { data: suggestions = [] } = trpc.integrations.googleAds.campaigns.suggest.useQuery(undefined, { enabled: isAdmin, retry: false });
  const update = trpc.integrations.googleAds.campaigns.update.useMutation({ onSuccess: () => { refresh(); toast.success("Marca/cidade atualizada"); }, onError: (e) => toast.error(e.message) });
  const apply = trpc.integrations.googleAds.campaigns.applySuggestions.useMutation({
    onSuccess: (r) => { refresh(); toast.success(`${r.applied} campanha(s) associada(s) pelo nome`); },
    onError: (e) => toast.error(e.message),
  });

  const byId = useMemo(() => new Map<number, any>(projects.map((p) => [p.id, p])), [projects]);
  const cityOf = (projectId: number | null): string => {
    if (projectId == null) return "";
    let node = byId.get(projectId);
    const seen = new Set<number>();
    while (node && node.level !== "city") {
      if (seen.has(node.id) || node.parentId == null) return "";
      seen.add(node.id); node = byId.get(node.parentId);
    }
    return node?.name ?? "";
  };
  const brandNameOf = (projectId: number | null): string | null => {
    let node = projectId != null ? byId.get(projectId) : undefined; const seen = new Set<number>();
    while (node && node.level !== "brand") { if (seen.has(node.id) || node.parentId == null) return null; seen.add(node.id); node = byId.get(node.parentId); }
    return node ? String(node.name) : null;
  };
  const label = (id: number | null): string => {
    if (id == null) return "";
    const p = byId.get(id); if (!p) return `#${id}`;
    const parent = p.parentId != null ? byId.get(p.parentId) : null;
    return p.level === "brand" && parent ? `${p.name} ${parent.name}` : p.name;
  };
  const brandOptions = useMemo(() => projects
    .filter((p) => p.level === "brand")
    .map((p) => ({ id: p.id, name: label(p.id) }))
    .sort((a, b) => a.name.localeCompare(b.name)), [projects]); // eslint-disable-line react-hooks/exhaustive-deps
  const mySuggestions = useMemo(() => {
    const ids = new Set(rows.map((r) => r.campaignId).filter((x) => x != null));
    return (suggestions as any[]).filter((s) => ids.has(s.campaignId));
  }, [suggestions, rows]);
  const sugById = useMemo(() => new Map(mySuggestions.map((s) => [s.campaignId, s])), [mySuggestions]);

  // Grupos: uma linha por MARCA/CIDADE (a marca escolhida para a campanha, que
  // pode não ser a da conta — "Airpark Faro" dentro da conta Multipark.pt),
  // depois "Nacional" (só para se ver: o gasto está repartido pelas cidades da
  // marca) e por fim "Por associar" — Jorge, 16 set 2026.
  const NATIONAL = "Nacional (repartido pelas cidades)";
  const UNMAPPED = "Por associar";
  const groupRank = (name: string) => (name === UNMAPPED ? 2 : name === NATIONAL ? 1 : 0);
  type Group = { city: string; projectId: number | null; rows: any[]; cost: number; clicks: number; conversions: number; value: number; nationalCost: number; stats: BrandCityStats | null };
  const cityStats = useMemo(() => new Map(byBrandCity.map((c) => [c.projectId, c])), [byBrandCity]);
  const shareByProject = useMemo(() => {
    const m = new Map<number, number>();
    for (const s of nationalShares) m.set(s.projectId, (m.get(s.projectId) ?? 0) + s.cost);
    return m;
  }, [nationalShares]);
  const groups = useMemo(() => {
    const map = new Map<string, Group>();
    const getGroup = (city: string, projectId: number | null): Group => {
      const g = map.get(city) ?? { city, projectId, rows: [], cost: 0, clicks: 0, conversions: 0, value: 0, nationalCost: projectId != null ? (shareByProject.get(projectId) ?? 0) : 0, stats: projectId != null ? (cityStats.get(projectId) ?? null) : null };
      map.set(city, g);
      return g;
    };
    for (const r of rows) {
      const projectId = !r.national && r.projectId != null ? Number(r.projectId) : null;
      const city = r.national ? NATIONAL : (projectId != null ? label(projectId) : UNMAPPED);
      const g = getGroup(city, projectId);
      g.rows.push(r); g.cost += r.cost; g.clicks += r.clicks; g.conversions += r.conversions; g.value += r.conversionValue;
    }
    // cidades que só recebem gasto nacional repartido aparecem na mesma
    for (const projectId of shareByProject.keys()) getGroup(label(projectId), projectId);
    // e as cidades desta marca com reservas, mesmo sem campanha (as reservas nunca ficam escondidas)
    for (const c of byBrandCity) if (c.bookings > 0 && brandNameOf(c.projectId) === account.name) getGroup(label(c.projectId), c.projectId);
    for (const g of map.values()) g.rows.sort((a, b) => b.cost - a.cost);
    return Array.from(map.values()).sort((a, b) => groupRank(a.city) - groupRank(b.city) || (b.cost + b.nationalCost) - (a.cost + a.nationalCost));
  }, [rows, shareByProject, cityStats, byBrandCity, account.name]); // eslint-disable-line react-hooks/exhaustive-deps
  const nationalSplitText = useMemo(() => Array.from(shareByProject.entries()).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).map(([id, c]) => `${label(id)} ${eur(c)}`).join(" · "), [shareByProject]); // eslint-disable-line react-hooks/exhaustive-deps
  const bookingTotals = useMemo(() => groups.reduce((t, g) => g.stats ? { bookings: t.bookings + g.stats.bookings, attributed: t.attributed + g.stats.attributed, revenueAttributed: t.revenueAttributed + g.stats.revenueAttributed } : t, { bookings: 0, attributed: 0, revenueAttributed: 0 }), [groups]);

  const selectValue = (r: any) => (r.national ? "national" : r.projectId != null ? String(r.projectId) : "none");
  const choose = (campaignId: number, v: string) => {
    if (v === "national") update.mutate({ id: campaignId, projectId: null, scope: "national" });
    else if (v === "none") update.mutate({ id: campaignId, projectId: null, scope: "city" });
    else update.mutate({ id: campaignId, projectId: Number(v), scope: "city" });
  };
  const applySuggestion = (campaignId: number, sug: any) => {
    if (sug.kind === "national") update.mutate({ id: campaignId, projectId: null, scope: "national" });
    else update.mutate({ id: campaignId, projectId: sug.projectId, scope: "city" });
  };

  const total = rows.reduce((t, r) => ({ cost: t.cost + r.cost, clicks: t.clicks + r.clicks, conversions: t.conversions + r.conversions, value: t.value + r.conversionValue }), { cost: 0, clicks: 0, conversions: 0, value: 0 });

  if (!rows.length && !groups.length) {
    return <Card className="p-12 text-center"><p className="text-muted-foreground">Sem gasto desta marca no período.</p></Card>;
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-2">
        <div>
          <CardTitle>{account.name} · {eur(total.cost)} no período</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Campanhas divididas por marca/cidade (a escolhida para a campanha, mesmo que seja outra marca). "Nacional" (Brand, Pmax, Portugal) mostra-se à parte, mas o gasto é repartido pelas cidades da marca na proporção do gasto de cidade. Reservas = reservas Multipark reais dessa marca/cidade, para comparar com as conversões da Google.
          </p>
        </div>
        {isAdmin && mySuggestions.length > 0 && (
          <Button size="sm" variant="outline" disabled={apply.isPending} onClick={() => apply.mutate({ campaignIds: mySuggestions.map((s) => s.campaignId) })} title={mySuggestions.map((s) => s.projectName).join(", ")}>
            {apply.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-1" />} Associar {mySuggestions.length} pelo nome
          </Button>
        )}
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Campanha</th>
                <th className="text-left px-4 py-2 font-medium">Marca / cidade</th>
                <th className="text-right px-4 py-2 font-medium">Gasto</th>
                <th className="text-right px-4 py-2 font-medium">Impressões</th>
                <th className="text-right px-4 py-2 font-medium">Cliques</th>
                <th className="text-right px-4 py-2 font-medium">CPC</th>
                <th className="text-right px-4 py-2 font-medium">Conv. Google</th>
                <th className="text-right px-4 py-2 font-medium">Custo/conv.</th>
                <th className="text-right px-4 py-2 font-medium">Valor conv.</th>
                <th className="text-right px-4 py-2 font-medium border-l" title="Reservas Multipark reais da marca nessa cidade (todos os parques), por data de criação, sem canceladas">Reservas</th>
                <th className="text-right px-4 py-2 font-medium" title="Reservas com gclid/utm pago no URL de origem. Na linha da campanha: ligadas a essa campanha. Fica abaixo das conversões Google quando o gclid se perde.">Ligadas (gclid)</th>
                <th className="text-right px-4 py-2 font-medium" title="Valor reservado das reservas que vieram pelos anúncios">Valor via anúncios</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <React.Fragment key={g.city}>
                  <tr className="bg-muted/40 border-b">
                    <td className="px-4 py-2 font-semibold" colSpan={2}>
                      {g.city} <span className="text-xs font-normal text-muted-foreground">{g.rows.length} campanha(s)</span>
                      {g.city === NATIONAL && nationalSplitText && <div className="text-xs font-normal text-muted-foreground">Repartido: {nationalSplitText}</div>}
                      {g.nationalCost > 0 && <div className="text-xs font-normal text-muted-foreground">inclui {eur(g.nationalCost)} de nacional</div>}
                    </td>
                    <td className="px-4 py-2 text-right font-semibold">{g.city === NATIONAL ? <span className="text-muted-foreground" title="Já contado nas cidades">({eur(g.cost)})</span> : eur(g.cost + g.nationalCost)}</td>
                    <td className="px-4 py-2 text-right text-muted-foreground">—</td>
                    <td className="px-4 py-2 text-right font-semibold">{num(g.clicks)}</td>
                    <td className="px-4 py-2 text-right text-muted-foreground">{g.clicks > 0 ? eur(g.cost / g.clicks) : "—"}</td>
                    <td className="px-4 py-2 text-right font-semibold">{g.conversions.toFixed(1)}</td>
                    <td className="px-4 py-2 text-right text-muted-foreground">{g.conversions > 0 ? eur(g.cost / g.conversions) : "—"}</td>
                    <td className="px-4 py-2 text-right font-semibold">{eur(g.value)}</td>
                    <td className="px-4 py-2 text-right font-semibold border-l" title={g.projectId != null && !g.stats ? "Sem reservas desta marca/cidade no período" : undefined}>{g.stats ? num(g.stats.bookings) : g.projectId != null ? "0" : "—"}</td>
                    <td className="px-4 py-2 text-right font-semibold">{g.stats ? num(g.stats.attributed) : g.projectId != null ? "0" : "—"}</td>
                    <td className="px-4 py-2 text-right font-semibold">{g.stats ? eur(g.stats.revenueAttributed) : g.projectId != null ? eur(0) : "—"}</td>
                  </tr>
                  {g.rows.map((r) => {
                    const sug = r.campaignId != null ? sugById.get(r.campaignId) : null;
                    return (
                      <tr key={r.key} className="border-b last:border-0">
                        <td className="px-4 py-1.5 pl-8">
                          {r.name}
                          {r.provider === "meta" && <Badge variant="outline" className="ml-1.5 text-[10px]">Meta</Badge>}
                          {(() => { const b = campaignStatusBadge(r.status); return b ? <Badge variant="outline" className={`ml-1.5 text-[10px] ${b.cls}`}>{b.label}</Badge> : null; })()}
                          {r.accountLabel && <div className="text-[11px] text-muted-foreground">conta {r.accountLabel}</div>}
                        </td>
                        <td className="px-4 py-1.5">
                          {isAdmin && r.campaignId != null ? (
                            <div className="flex items-center gap-2">
                              <Select value={selectValue(r)} onValueChange={(v) => choose(r.campaignId, v)}>
                                <SelectTrigger className="h-7 w-52 text-xs"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="none">— por associar —</SelectItem>
                                  <SelectItem value="national">Nacional (marca, sem cidade)</SelectItem>
                                  {brandOptions.map((o) => <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>)}
                                </SelectContent>
                              </Select>
                              {r.projectId == null && !r.national && sug && (
                                <Badge variant="outline" className="text-[10px] cursor-pointer" title="Sugestão pelo nome — clica para aplicar" onClick={() => applySuggestion(r.campaignId, sug)}>
                                  sugestão: {sug.projectName}
                                </Badge>
                              )}
                            </div>
                          ) : (
                            <span className={r.projectId == null && !r.national ? "text-amber-700 text-xs" : "text-xs"}>{r.national ? "Nacional" : r.projectId != null ? label(r.projectId) : "por associar"}</span>
                          )}
                        </td>
                        <td className="px-4 py-1.5 text-right">{eur(r.cost)}</td>
                        <td className="px-4 py-1.5 text-right">{num(r.impressions)}</td>
                        <td className="px-4 py-1.5 text-right">{num(r.clicks)}</td>
                        <td className="px-4 py-1.5 text-right text-muted-foreground">{r.clicks > 0 ? eur(r.cost / r.clicks) : "—"}</td>
                        <td className="px-4 py-1.5 text-right">{Number(r.conversions).toFixed(1)}</td>
                        <td className="px-4 py-1.5 text-right text-muted-foreground">{r.conversions > 0 ? eur(r.cost / r.conversions) : "—"}</td>
                        <td className="px-4 py-1.5 text-right">{eur(r.conversionValue)}</td>
                        <td className="px-4 py-1.5 text-right text-muted-foreground border-l">—</td>
                        <td className="px-4 py-1.5 text-right">{linked(r) == null ? "—" : num(linked(r))}</td>
                        <td className="px-4 py-1.5 text-right text-muted-foreground">—</td>
                      </tr>
                    );
                  })}
                </React.Fragment>
              ))}
              <tr className="bg-muted/60 font-semibold">
                <td className="px-4 py-2" colSpan={2}>Total da marca</td>
                <td className="px-4 py-2 text-right">{eur(total.cost)}</td>
                <td className="px-4 py-2 text-right text-muted-foreground">—</td>
                <td className="px-4 py-2 text-right">{num(total.clicks)}</td>
                <td className="px-4 py-2 text-right text-muted-foreground">{total.clicks > 0 ? eur(total.cost / total.clicks) : "—"}</td>
                <td className="px-4 py-2 text-right">{total.conversions.toFixed(1)}</td>
                <td className="px-4 py-2 text-right text-muted-foreground">{total.conversions > 0 ? eur(total.cost / total.conversions) : "—"}</td>
                <td className="px-4 py-2 text-right">{eur(total.value)}</td>
                <td className="px-4 py-2 text-right border-l">{num(bookingTotals.bookings)}</td>
                <td className="px-4 py-2 text-right">{num(bookingTotals.attributed)}</td>
                <td className="px-4 py-2 text-right">{eur(bookingTotals.revenueAttributed)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
