/**
 * Condutores e agentes (separador Pessoas) — Jorge, 3 out 2026: os
 * separadores "Condutores" e "Agentes" saíram das Críticas para aqui ("é para
 * nós; depois fazemos outra coisa"). Mesmos dados e as mesmas regras de acesso
 * de antes (módulo Críticas, team leader ou acima, nas tuas cidades).
 * 37a: aba "Desempenho" (tudo o que cada pessoa fez, por posto, com
 * ranking) — escondida, só o super admin.
 */
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { can } from "@shared/access";
import { lisbonDayOf } from "@shared/lisbonDay";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { BarChart3, Car, Loader2, Users } from "lucide-react";
import { PeoplePerformancePanel } from "@/components/people/PeoplePerformancePanel";

function lisbonMonthToDate(): { start: string; end: string } {
  const today = lisbonDayOf(new Date());
  return { start: `${today.slice(0, 8)}01`, end: today };
}

export default function CondutoresAgentesPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState("drivers");
  if (!user) return null;
  if (!can(user as any, "criticas", "view")) return <div className="p-6 text-sm text-muted-foreground">Sem acesso a esta página.</div>;
  // 37a: o desempenho por pessoa é só do super admin (o servidor também confirma)
  const isSuper = (user as any).role === "super_admin";
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">Entregas por condutor e ações de cada agente da Multipark, nas tuas cidades (lidas ao vivo).</p>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="drivers"><Car className="w-4 h-4 mr-1" /> Condutores</TabsTrigger>
          <TabsTrigger value="agents"><Users className="w-4 h-4 mr-1" /> Agentes</TabsTrigger>
          {isSuper && <TabsTrigger value="performance"><BarChart3 className="w-4 h-4 mr-1" /> Desempenho</TabsTrigger>}
        </TabsList>
        <TabsContent value="drivers" className="mt-4"><CheckoutDriversPanel /></TabsContent>
        <TabsContent value="agents" className="mt-4"><AgentPerformancePanel /></TabsContent>
        {isSuper && <TabsContent value="performance" className="mt-4"><PeoplePerformancePanel /></TabsContent>}
      </Tabs>
    </div>
  );
}

// ─── CHECKOUT DRIVERS PANEL ──────────────────────────────────────────────────

function CheckoutDriversPanel() {
  const [startDate, setStartDate] = useState(() => lisbonMonthToDate().start);
  const [endDate, setEndDate] = useState(() => lisbonMonthToDate().end);

  const driversQ = trpc.reviews.checkoutDrivers.useQuery(
    { startDate, endDate },
    { enabled: !!startDate && !!endDate && startDate <= endDate }
  );
  const { data, isLoading } = driversQ;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Car className="w-5 h-5" /> Ranking de Condutores (Checkout)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-4 mb-4 flex-wrap">
            <div>
              <Label className="text-xs">De</Label>
              <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="w-40" />
            </div>
            <div>
              <Label className="text-xs">Até</Label>
              <Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="w-40" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground mb-3">Entregas (CHECK_OUT) por agente da Multipark, nas tuas cidades, lidas ao vivo.</p>
          {startDate > endDate ? (
            <p className="text-sm text-muted-foreground">A data "De" tem de ser antes de "Até".</p>
          ) : driversQ.error ? (
            <QueryErrorNote error={driversQ.error} onRetry={() => driversQ.refetch()} retrying={driversQ.isFetching} what="o ranking (BD da Multipark)" />
          ) : isLoading ? (
            <div className="flex justify-center py-8"><div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" /></div>
          ) : !data?.drivers?.length ? (
            <p className="text-sm text-muted-foreground">Sem dados para o período selecionado.</p>
          ) : (
            <div className="space-y-2">
              <div className="grid grid-cols-[1fr_auto] gap-2 text-xs font-medium text-muted-foreground border-b pb-1">
                <span>Condutor</span>
                <span className="text-right">Entregas</span>
              </div>
              {data.drivers.map((d: any, i: number) => (
                <div key={d.userId || i} className="grid grid-cols-[1fr_auto] gap-2 items-center py-1.5 border-b border-border/50">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${i < 3 ? "bg-amber-100 text-amber-800" : "bg-muted text-muted-foreground"}`}>
                      {i + 1}
                    </span>
                    <span className="font-medium text-sm">{d.name}</span>
                  </div>
                  <span className="font-semibold text-sm text-right">{d.count}</span>
                </div>
              ))}
              <p className="text-xs text-muted-foreground mt-2">Total: {data.total} entregas no período</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── AGENT PERFORMANCE PANEL ─────────────────────────────────────────────────

function AgentPerformancePanel() {
  const [startDate, setStartDate] = useState(() => lisbonMonthToDate().start);
  const [endDate, setEndDate] = useState(() => lisbonMonthToDate().end);
  // D27: escolhe-se a FICHA (os agentes da Multipark ligados a ela), não um nome escrito.
  const [employeeId, setEmployeeId] = useState("");
  const peopleQ = trpc.reviews.agentPeople.useQuery();
  const people = peopleQ.data ?? [];
  const personOptions = useMemo(
    () => people.map((p) => ({ value: String(p.id), label: `${p.fullName}${p.isActive ? "" : " (inativa)"}${p.agents > 1 ? ` · ${p.agents} agentes` : ""}` })),
    [people],
  );
  const chosen = people.find((p) => String(p.id) === employeeId);

  const historyQ = trpc.reviews.agentHistory.useQuery(
    { startDate, endDate, employeeId: Number(employeeId) },
    { enabled: !!startDate && !!endDate && startDate <= endDate && !!employeeId }
  );
  const { data } = historyQ;
  const isLoading = historyQ.isFetching && !data;

  const actionStats = (data?.history || []).reduce((acc: Record<string, number>, h: any) => {
    acc[h.changeType] = (acc[h.changeType] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="w-5 h-5" /> Performance de Agentes
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-4 mb-4 flex-wrap">
            <div>
              <Label className="text-xs">De</Label>
              <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="w-40" />
            </div>
            <div>
              <Label className="text-xs">Até</Label>
              <Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="w-40" />
            </div>
            <div className="flex-1 min-w-[200px]">
              <Label className="text-xs">Pessoa (ficha)</Label>
              <div className="flex gap-2 items-center">
                <SearchableSelect
                  value={employeeId}
                  onChange={setEmployeeId}
                  options={personOptions}
                  placeholder={peopleQ.isLoading ? "A carregar…" : "Escolher pessoa…"}
                  searchPlaceholder="Procurar pela ficha…"
                  emptyText="Nenhuma ficha com agente da Multipark ligado"
                  className="w-full"
                  disabled={peopleQ.isLoading || !!peopleQ.error}
                />
                {isLoading && <Loader2 className="w-4 h-4 animate-spin shrink-0" />}
              </div>
            </div>
          </div>

          {peopleQ.error ? (
            <QueryErrorNote error={peopleQ.error} onRetry={() => peopleQ.refetch()} retrying={peopleQ.isFetching} what="as fichas com agente" />
          ) : !employeeId ? (
            <p className="text-sm text-muted-foreground">Escolhe uma pessoa: contam as ações de todos os agentes da Multipark ligados à ficha dela (RH → Ligações). Só aparecem fichas com agente ligado.</p>
          ) : startDate > endDate ? (
            <p className="text-sm text-muted-foreground">A data "De" tem de ser antes de "Até".</p>
          ) : historyQ.error ? (
            <QueryErrorNote error={historyQ.error} onRetry={() => historyQ.refetch()} retrying={historyQ.isFetching} what="as ações do agente (BD da Multipark)" />
          ) : isLoading ? (
            <div className="flex justify-center py-8"><div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" /></div>
          ) : data?.noAgent ? (
            <p className="text-sm text-muted-foreground">A ficha de {data.agentName} não tem nenhum agente da Multipark ligado — liga-o em RH → Ligações.</p>
          ) : !data?.history?.length ? (
            <p className="text-sm text-muted-foreground">Sem ações de {chosen?.fullName ?? data?.agentName ?? "esta pessoa"} no período.</p>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {Object.entries(actionStats).map(([type, count]) => (
                  <Card key={type}>
                    <CardContent className="p-3 text-center">
                      <p className="text-2xl font-bold">{count as number}</p>
                      <p className="text-xs text-muted-foreground">{type.replace(/_/g, " ")}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
              <p className="text-sm font-medium">Total: {data.truncated ? `pelo menos ${data.total}` : data.total} ações</p>
              {data.truncated && <p className="text-xs text-amber-700">Mostra só as {data.total} mais recentes: escolhe um período mais curto para ver tudo.</p>}
              <div className="max-h-96 overflow-y-auto space-y-1">
                {data.history.map((h: any) => (
                  <div key={h.id} className="flex items-center justify-between gap-2 flex-wrap text-sm p-2 rounded bg-muted">
                    <div className="flex items-center gap-2 flex-wrap min-w-0">
                      <Badge variant="outline" className="text-xs">{h.changeType}</Badge>
                      <span>{h.booking?.licensePlate || "—"}</span>
                      <span className="text-muted-foreground">{h.booking?.parkName || ""}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">{h.actionTime ? fmtPTDateTime(h.actionTime) : "—"}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
