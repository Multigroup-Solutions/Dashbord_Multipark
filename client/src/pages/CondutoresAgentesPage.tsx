/**
 * Condutores e agentes (separador Pessoas) — Jorge, 3 out 2026: os
 * separadores "Condutores" e "Agentes" saíram das Críticas para aqui ("é para
 * nós; depois fazemos outra coisa").
 * 14 out 2026 (Jorge: "isto não devia aparecer a toda a gente"): módulo
 * próprio `condutores_agentes` — Condutores e Agentes só para supervisor (as
 * cidades dele), back office, admin e super admin; Desempenho só o super
 * admin. Quem não pode não vê o menu, nem os separadores, e o URL direto dá
 * "Sem acesso" (o servidor recusa na mesma). Regras em shared/condutoresAccess.ts.
 * 37a: aba "Desempenho" (tudo o que cada pessoa fez, por posto, com
 * ranking) — escondida, só o super admin.
 * 41a: "?ficha=<id>" abre logo os Agentes com essa pessoa escolhida (o botão
 * "Abrir agente" da ficha do RH e da lista de Utilizadores).
 * 42b: Condutores e Agentes são LISTAS (totais por pessoa, filtro de cidade e
 * marca do topo, escolher a pessoa); o número abre o detalhe e o nome a ficha
 * (components/people/MovementPeoplePanel.tsx).
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { condutoresTabs, initialCondutoresTab, type CondutoresTab } from "@shared/condutoresAccess";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BarChart3, Car, Users } from "lucide-react";
import { PeoplePerformancePanel } from "@/components/people/PeoplePerformancePanel";
import { MovementPeoplePanel, type DetailTarget } from "@/components/people/MovementPeoplePanel";
import { useMultisPage } from "@/components/assistant/useMultisPage";

/** 41a: a ficha pedida no URL (?ficha=123), ou "". */
function fichaFromUrl(): string {
  if (typeof window === "undefined") return "";
  const v = new URLSearchParams(window.location.search).get("ficha") ?? "";
  return /^\d{1,9}$/.test(v) ? v : "";
}

export default function CondutoresAgentesPage() {
  const { user } = useAuth();
  const [initialFicha] = useState(fichaFromUrl);
  const tabs = condutoresTabs(user as any);
  const [tab, setTab] = useState<CondutoresTab | null>(null);
  // Plano MPV §3.1: o Multis sabe o separador aberto.
  useMultisPage({ tab: tabs.length ? (tab && tabs.includes(tab) ? tab : initialCondutoresTab(tabs, initialFicha ? "agents" : "drivers")) : null });
  if (!user) return null;
  // 14 out 2026: só supervisor, back office, admin e super admin (o servidor também confirma)
  if (!tabs.length) return <div className="p-6 text-sm text-muted-foreground">Sem acesso a esta página.</div>;
  const current = tab && tabs.includes(tab) ? tab : initialCondutoresTab(tabs, initialFicha ? "agents" : "drivers")!;
  const has = (t: CondutoresTab) => tabs.includes(t);
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">Recolhas, entregas, movimentos e km de cada condutor e as ações de cada agente da Multipark, nas tuas cidades (lidas ao vivo). Cidade e marca: o filtro do topo.</p>
      <Tabs value={current} onValueChange={(v) => setTab(v as CondutoresTab)}>
        <TabsList className="max-w-full justify-start overflow-x-auto">
          {has("drivers") && <TabsTrigger value="drivers"><Car className="w-4 h-4 mr-1" /> Condutores</TabsTrigger>}
          {has("agents") && <TabsTrigger value="agents"><Users className="w-4 h-4 mr-1" /> Agentes</TabsTrigger>}
          {/* 37a: o desempenho por pessoa é só do super admin (o servidor também confirma) */}
          {has("performance") && <TabsTrigger value="performance"><BarChart3 className="w-4 h-4 mr-1" /> Desempenho</TabsTrigger>}
        </TabsList>
        {has("drivers") && <TabsContent value="drivers" className="mt-4"><CheckoutDriversPanel /></TabsContent>}
        {has("agents") && <TabsContent value="agents" className="mt-4"><AgentPerformancePanel initialEmployeeId={initialFicha} /></TabsContent>}
        {has("performance") && <TabsContent value="performance" className="mt-4"><PeoplePerformancePanel /></TabsContent>}
      </Tabs>
    </div>
  );
}

// ─── CONDUTORES (42b) ────────────────────────────────────────────────────────

function CheckoutDriversPanel() {
  return <MovementPeoplePanel mode="drivers" />;
}

// ─── AGENTES (42b: lista primeiro; ?ficha= abre logo o detalhe dessa pessoa) ─

function AgentPerformancePanel({ initialEmployeeId = "" }: { initialEmployeeId?: string }) {
  const [first] = useState(initialEmployeeId);
  const peopleQ = trpc.reviews.agentPeople.useQuery(undefined, { enabled: !!first });
  const chosen = (peopleQ.data ?? []).find((p: any) => String(p.id) === first);
  const initial: DetailTarget | null = first && (chosen || !peopleQ.isLoading)
    ? { employeeId: Number(first), agentUserIds: [], name: chosen?.fullName ?? "Pessoa", types: null, label: "Todas as ações" }
    : null;
  if (first && peopleQ.isLoading) return <p className="text-sm text-muted-foreground">A abrir a pessoa…</p>;
  return <MovementPeoplePanel mode="agents" initialDetail={initial} />;
}
