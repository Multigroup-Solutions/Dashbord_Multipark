import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BarChart3, CircleAlert, Globe, Megaphone, Network, Target } from "lucide-react";
import MarketingGoogleAdsPage from "./MarketingGoogleAdsPage";
import MarketingDashboardPanel from "@/components/marketing/MarketingDashboardPanel";
import MarketingChannelsPanel from "@/components/marketing/MarketingChannelsPanel";
import MarketingBudgetsPanel from "@/components/marketing/MarketingBudgetsPanel";
import MarketingWebPanel from "@/components/marketing/MarketingWebPanel";
import AnomalyAlerts from "@/components/aiOps/AnomalyAlerts";
import { TABS_SCROLL } from "@/components/finance/layoutClasses";

/**
 * Marketing (Jorge, 16 set 2026): o menu "Marketing" abre o DASHBOARD de
 * marketing; os anúncios (gasto por marca, por campanha e ROAS por campanha)
 * são outro separador, e os orçamentos mensais (24 set 2026) outro.
 *
 *  - /marketing → Dashboard (o antigo /marketing-dashboard redireciona para aqui)
 *  - /marketing/google-ads → Anúncios (Google Ads + Meta)
 *  - /marketing/canais → Canais e clientes
 *  - /marketing/orcamentos → Orçamentos
 *  - /marketing/web → Web & SEO (GA4, Search Console, PageSpeed — set 2026)
 *
 * Por cima de todos os separadores: aviso VERMELHO quando a recolha do Google
 * Ads / Meta falhou, pede reautorização ou está parada (> 26 h).
 */

const ADS_PATH = "/marketing/google-ads";
const DASH_PATH = "/marketing";
const CHANNELS_PATH = "/marketing/canais";
const BUDGETS_PATH = "/marketing/orcamentos";
const WEB_PATH = "/marketing/web";

export { MarketingDashboardPanel };

/** Aviso vermelho das recolhas (Google Ads / Meta) — mesmo alerta da rota marketing.alerts. */
function SyncHealthBanner() {
  const { projectId } = useGlobalFilters();
  const { data } = trpc.marketing.alerts.useQuery({ projectId }, { staleTime: 60_000 });
  const syncAlerts = (data?.alerts ?? []).filter((a: any) => String(a.code).startsWith("ads_sync_"));
  if (!syncAlerts.length) return null;
  return (
    <div className="space-y-2">
      {syncAlerts.map((a: any) => (
        <div key={a.code} role="alert" className="rounded-md border border-rose-300 bg-rose-50 text-rose-900 dark:bg-rose-950/40 dark:text-rose-200 px-3 py-2 text-sm flex flex-wrap items-center gap-x-3 gap-y-1">
          <CircleAlert className="w-4 h-4 shrink-0" />
          <span className="font-semibold">{a.title}</span>
          <span className="text-xs">{a.detail}</span>
          {a.link && <Link href={a.link} className="ml-auto text-xs font-semibold underline">{a.linkLabel ?? "Abrir Integrações"}</Link>}
        </div>
      ))}
    </div>
  );
}

export default function MarketingPage() {
  const [location, navigate] = useLocation();
  const tabFromPath = (p: string) => (p.startsWith(ADS_PATH) ? "ads" : p.startsWith(CHANNELS_PATH) ? "channels" : p.startsWith(BUDGETS_PATH) ? "budgets" : p.startsWith(WEB_PATH) ? "web" : "dashboard");
  const [tab, setTab] = useState(tabFromPath(location));
  useEffect(() => { setTab(tabFromPath(location)); }, [location]);
  const onTab = (v: string) => {
    setTab(v);
    // só muda o URL quando estamos numa rota de Marketing (nos Dashboards fica só o estado)
    if (location.startsWith("/marketing")) navigate(v === "ads" ? ADS_PATH : v === "channels" ? CHANNELS_PATH : v === "budgets" ? BUDGETS_PATH : v === "web" ? WEB_PATH : DASH_PATH, { replace: true });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold">Marketing</h1>
        <p className="text-muted-foreground">Dashboard, canais e clientes, anúncios (Google Ads e Meta), orçamentos e Web & SEO</p>
      </div>
      <SyncHealthBanner />
      <AnomalyAlerts domain="marketing" />
      <Tabs value={tab} onValueChange={onTab}>
        <TabsList className={TABS_SCROLL}>
          <TabsTrigger value="dashboard"><BarChart3 className="w-4 h-4 mr-1" />Dashboard</TabsTrigger>
          <TabsTrigger value="channels"><Network className="w-4 h-4 mr-1" />Canais e clientes</TabsTrigger>
          <TabsTrigger value="ads"><Megaphone className="w-4 h-4 mr-1" />Anúncios</TabsTrigger>
          <TabsTrigger value="budgets"><Target className="w-4 h-4 mr-1" />Orçamentos</TabsTrigger>
          <TabsTrigger value="web"><Globe className="w-4 h-4 mr-1" />Web & SEO</TabsTrigger>
        </TabsList>
        <TabsContent value="dashboard" className="mt-4"><MarketingDashboardPanel /></TabsContent>
        <TabsContent value="channels" className="mt-4"><MarketingChannelsPanel /></TabsContent>
        <TabsContent value="ads" className="mt-4"><MarketingGoogleAdsPage /></TabsContent>
        <TabsContent value="budgets" className="mt-4"><MarketingBudgetsPanel /></TabsContent>
        <TabsContent value="web" className="mt-4">{tab === "web" && <MarketingWebPanel />}</TabsContent>
      </Tabs>
    </div>
  );
}
