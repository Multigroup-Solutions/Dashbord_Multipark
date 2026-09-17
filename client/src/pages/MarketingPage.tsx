import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import { BarChart3, Megaphone } from "lucide-react";
import MarketingGoogleAdsPage from "./MarketingGoogleAdsPage";

/**
 * Marketing (Jorge, 16 set 2026): o menu "Marketing" abre o DASHBOARD de
 * marketing; o Google Ads (gasto por marca e por conta/cidade) é outra
 * página, num separador próprio — "são coisas diferentes".
 *
 *  - /marketing e /marketing-dashboard → separador Dashboard
 *  - /marketing/google-ads → separador Google Ads
 *
 * O conteúdo do Dashboard ainda está por definir pelo Jorge; até lá fica
 * o esqueleto (sem inventar indicadores).
 */

const ADS_PATH = "/marketing/google-ads";
const DASH_PATH = "/marketing";

export function MarketingDashboardPanel() {
  return (
    <Card className="p-12 text-center">
      <BarChart3 className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
      <p className="font-medium">Dashboard de Marketing</p>
      <p className="text-sm text-muted-foreground mt-1">Conteúdo por definir. O gasto do Google Ads por marca e por cidade está no separador Google Ads.</p>
    </Card>
  );
}

export default function MarketingPage() {
  const [location, navigate] = useLocation();
  const tabFromPath = (p: string) => (p.startsWith(ADS_PATH) ? "ads" : "dashboard");
  const [tab, setTab] = useState(tabFromPath(location));
  useEffect(() => { setTab(tabFromPath(location)); }, [location]);
  const onTab = (v: string) => {
    setTab(v);
    // só muda o URL quando estamos numa rota de Marketing (nos Dashboards fica só o estado)
    if (location.startsWith("/marketing")) navigate(v === "ads" ? ADS_PATH : DASH_PATH, { replace: true });
  };

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Marketing</h1>
        <p className="text-muted-foreground">Dashboard de marketing e Google Ads</p>
      </div>
      <Tabs value={tab} onValueChange={onTab}>
        <TabsList>
          <TabsTrigger value="dashboard"><BarChart3 className="w-4 h-4 mr-1" />Dashboard</TabsTrigger>
          <TabsTrigger value="ads"><Megaphone className="w-4 h-4 mr-1" />Google Ads</TabsTrigger>
        </TabsList>
        <TabsContent value="dashboard" className="mt-4"><MarketingDashboardPanel /></TabsContent>
        <TabsContent value="ads" className="mt-4"><MarketingGoogleAdsPage /></TabsContent>
      </Tabs>
    </div>
  );
}
