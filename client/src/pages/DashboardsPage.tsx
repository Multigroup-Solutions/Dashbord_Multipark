import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Home, Building2, Truck, Users, MessageSquareWarning, Megaphone,
} from "lucide-react";
import DashboardPage from "./DashboardPage";
import FinanceiroDashboard from "./FinanceiroDashboard";
import OperacoesDashboard from "./OperacoesDashboard";
import PessoasDashboard from "./PessoasDashboard";
import SuporteDashboard from "./SuporteDashboard";
import MarketingPage from "./MarketingPage";

export default function DashboardsPage() {
  const [tab, setTab] = useState("geral");
  return (
    <div className="p-4 md:p-6 space-y-6 max-w-[1400px] mx-auto">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="geral"><Home className="w-4 h-4 mr-1" />Geral</TabsTrigger>
          <TabsTrigger value="financeiro"><Building2 className="w-4 h-4 mr-1" />Financeiro</TabsTrigger>
          <TabsTrigger value="operacoes"><Truck className="w-4 h-4 mr-1" />Operações</TabsTrigger>
          <TabsTrigger value="pessoas"><Users className="w-4 h-4 mr-1" />Pessoas</TabsTrigger>
          <TabsTrigger value="suporte"><MessageSquareWarning className="w-4 h-4 mr-1" />Suporte</TabsTrigger>
          <TabsTrigger value="marketing"><Megaphone className="w-4 h-4 mr-1" />Marketing</TabsTrigger>
        </TabsList>

        <TabsContent value="geral" className="mt-4"><DashboardPage /></TabsContent>
        <TabsContent value="financeiro" className="mt-4"><FinanceiroDashboard /></TabsContent>
        <TabsContent value="operacoes" className="mt-4"><OperacoesDashboard /></TabsContent>
        <TabsContent value="pessoas" className="mt-4"><PessoasDashboard /></TabsContent>
        <TabsContent value="suporte" className="mt-4"><SuporteDashboard /></TabsContent>
        <TabsContent value="marketing" className="mt-4"><MarketingPage /></TabsContent>
      </Tabs>
    </div>
  );
}
