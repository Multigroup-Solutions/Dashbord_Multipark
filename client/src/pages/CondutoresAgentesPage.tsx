/**
 * Condutores e agentes (separador Pessoas) — Jorge, 3 out 2026: os
 * separadores "Condutores" e "Agentes" saíram das Críticas para aqui ("é para
 * nós; depois fazemos outra coisa"). Mesmos dados e as mesmas regras de acesso
 * de antes (módulo Críticas, team leader ou acima, nas tuas cidades).
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
import { can } from "@shared/access";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BarChart3, Car, Users } from "lucide-react";
import { PeoplePerformancePanel } from "@/components/people/PeoplePerformancePanel";
import { MovementPeoplePanel, type DetailTarget } from "@/components/people/MovementPeoplePanel";

/** 41a: a ficha pedida no URL (?ficha=123), ou "". */
function fichaFromUrl(): string {
  if (typeof window === "undefined") return "";
  const v = new URLSearchParams(window.location.search).get("ficha") ?? "";
  return /^\d{1,9}$/.test(v) ? v : "";
}

export default function CondutoresAgentesPage() {
  const { user } = useAuth();
  const [initialFicha] = useState(fichaFromUrl);
  const [tab, setTab] = useState(() => (initialFicha ? "agents" : "drivers"));
  if (!user) return null;
  if (!can(user as any, "criticas", "view")) return <div className="p-6 text-sm text-muted-foreground">Sem acesso a esta página.</div>;
  // 37a: o desempenho por pessoa é só do super admin (o servidor também confirma)
  const isSuper = (user as any).role === "super_admin";
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">Recolhas, entregas, movimentos e km de cada condutor e as ações de cada agente da Multipark, nas tuas cidades (lidas ao vivo). Cidade e marca: o filtro do topo.</p>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="drivers"><Car className="w-4 h-4 mr-1" /> Condutores</TabsTrigger>
          <TabsTrigger value="agents"><Users className="w-4 h-4 mr-1" /> Agentes</TabsTrigger>
          {isSuper && <TabsTrigger value="performance"><BarChart3 className="w-4 h-4 mr-1" /> Desempenho</TabsTrigger>}
        </TabsList>
        <TabsContent value="drivers" className="mt-4"><CheckoutDriversPanel /></TabsContent>
        <TabsContent value="agents" className="mt-4"><AgentPerformancePanel initialEmployeeId={initialFicha} /></TabsContent>
        {isSuper && <TabsContent value="performance" className="mt-4"><PeoplePerformancePanel /></TabsContent>}
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
