/**
 * Avaliação — UMA página com dois separadores principais:
 *  - "Dia" (antiga Avaliação operacional): a escala do Extras Dia × os
 *    movimentos lidos AO VIVO da BD da Multipark, por pessoa, com a lista de
 *    movimentos e o GPS do Zello (components/evaluation/DayEvaluationTab);
 *  - "Mês" (antes "4 semanas"; 42a): ranking do período sobre o
 *    motor único (employee_day_metrics + ajustes + contestações), o resumo
 *    vivo dos movimentos por pessoa e "Recalcular".
 * Mais "A minha avaliação" e "Contestações" (gestão).
 *
 * O motor lê os movimentos da BD da Multipark sozinho (cron diário do
 * último mês e ao abrir um dia) — não há botões para ir buscar
 * histórico. O âmbito de cidade é aplicado no servidor.
 * 42a: o filtro de cidade/marca do topo chega ao ranking e aos movimentos.
 * Rotas: /avaliacao?tab=dia|mes|minha|contestacoes (tab=semanas → mes) (/avaliacao-operacional
 * redireciona para ?tab=dia).
 */
import EvaluationExplanation from "@/components/aiOps/EvaluationExplanation";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Trophy } from "lucide-react";
import { can } from "@shared/access";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import DayEvaluationTab from "@/components/evaluation/DayEvaluationTab";
// 12 out 2026: o "Mês" é um componente próprio (também na Atividade diária → "Avaliação do mês").
import MonthEvaluationTab, { PeriodNav, thisMonth } from "@/components/evaluation/MonthEvaluationTab";
import { canSeeEvaluationRanking } from "@shared/operationalTabs";
import {
  DisputeList,
  EmployeeEvaluationDetail,
  ResolveDisputeDialog,
  ptsClass,
  fmtPts,
} from "@/components/evaluation/EvaluationBreakdown";

type TabKey = "dia" | "mes" | "minha" | "contestacoes";

export default function AvaliacaoPage() {
  const { user } = useAuth();
  // Só para mostrar/esconder — quem decide é o servidor, com a MESMA matriz
  // (shared/access.ts + permissões por utilizador).
  const canDay = !!user && can(user as any, "avaliacao_operacional", "view");
  // A MESMA regra do separador "Avaliação do mês" da Atividade diária (12 out 2026).
  const canRank = canSeeEvaluationRanking(user as any);
  const isSupervisor = !!user && can(user as any, "avaliacao", "edit");
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const allowed: TabKey[] = [
    ...(canDay ? ["dia" as const] : []),
    ...(canRank ? ["mes" as const] : []),
    "minha",
    ...(isSupervisor ? ["contestacoes" as const] : []),
  ];
  const askedRaw = params.get("tab");
  const asked = (askedRaw === "semanas" ? "mes" : askedRaw) as TabKey | null;
  const [tab, setTabState] = useState<TabKey>(asked && allowed.includes(asked) ? asked : allowed[0]);
  const setTab = (t: string) => {
    setTabState(t as TabKey);
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("tab", t);
      u.searchParams.delete("date");
      window.history.replaceState({}, "", u.pathname + u.search);
    } catch { /* sem URL (testes) */ }
  };

  const [range, setRange] = useState(thisMonth);
  const hasRange = !!range.start && !!range.end;
  const periodNav = <PeriodNav range={range} onChange={setRange} />;

  return (
    <div className="space-y-4 max-w-7xl mx-auto w-full">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><Trophy className="h-6 w-6 text-purple-600" /> Avaliação</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Pontuação por dia operacional (03h→03h). Os movimentos vêm em tempo real da BD da Multipark; o GPS, o ponto e a escala vêm do dashboard.
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap h-auto">
          {canDay && <TabsTrigger value="dia">Dia</TabsTrigger>}
          {canRank && <TabsTrigger value="mes">Mês</TabsTrigger>}
          <TabsTrigger value="minha">A minha avaliação</TabsTrigger>
          {isSupervisor && <TabsTrigger value="contestacoes">Contestações</TabsTrigger>}
        </TabsList>
        {canDay && (
          <TabsContent value="dia" className="mt-4">
            {tab === "dia" && <DayEvaluationTab initialDate={params.get("date") ?? undefined} />}
          </TabsContent>
        )}
        {canRank && (
          <TabsContent value="mes" className="mt-4">
            {/* 12 out 2026: o mesmo componente da Atividade diária → "Avaliação do mês". */}
            <MonthEvaluationTab isSupervisor={isSupervisor} range={range} onRangeChange={setRange} active={tab === "mes"} />
          </TabsContent>
        )}
        <TabsContent value="minha" className="mt-4 space-y-4">
          {periodNav}
          {hasRange && tab === "minha" && <MineView from={range.start} to={range.end} />}
        </TabsContent>
        {isSupervisor && (
          <TabsContent value="contestacoes" className="mt-4">
            {tab === "contestacoes" && <DisputesView />}
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

// ─── A minha avaliação ───────────────────────────────────────────────────────

function MineView({ from, to }: { from: string; to: string }) {
  const utils = trpc.useUtils();
  const q = trpc.evaluation.mine.useQuery({ from, to });
  if (q.isLoading) return <p className="text-sm text-muted-foreground">A carregar...</p>;
  if (q.error) return <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="a tua avaliação" />;
  const d = q.data;
  if (!d?.employee) {
    return <Card className="p-8 text-center text-muted-foreground">A tua conta não está ligada a uma ficha de colaborador — fala com o RH.</Card>;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex flex-wrap items-center gap-2">
          {d.employee.fullName}
          {d.totals && <Badge variant="secondary" className={`tabular-nums ${ptsClass(d.totals.score.totalPoints)}`}>{fmtPts(d.totals.score.totalPoints)} pts</Badge>}
        </CardTitle>
        <p className="text-xs text-muted-foreground">Só vês os teus dados. Se algo estiver errado num dia, abre o dia e carrega em "Contestar".</p>
      </CardHeader>
      <CardContent>
        <div className="mb-4"><EvaluationExplanation from={from} to={to} /></div>
        <EmployeeEvaluationDetail employeeId={d.employee.id} detail={d as any} mode="self"
          onChanged={() => utils.evaluation.mine.invalidate()} />
      </CardContent>
    </Card>
  );
}

// ─── Contestações (gestão) ───────────────────────────────────────────────────

function DisputesView() {
  const utils = trpc.useUtils();
  const [status, setStatus] = useState<"open" | "accepted" | "rejected">("open");
  const q = trpc.evaluation.disputes.list.useQuery({ status });
  const [resolving, setResolving] = useState<any>(null);
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center gap-2 space-y-0">
        <CardTitle className="text-base">Contestações</CardTitle>
        <div className="ml-auto inline-flex flex-wrap rounded-md border p-0.5">
          {(["open", "accepted", "rejected"] as const).map((s) => (
            <Button key={s} size="sm" variant={status === s ? "selected" : "ghost"} className="h-8" onClick={() => setStatus(s)}>
              {s === "open" ? "Em análise" : s === "accepted" ? "Aceites" : "Recusadas"}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {q.isLoading ? <p className="text-sm text-muted-foreground">A carregar...</p>
          : q.error ? <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="as contestações" />
          : (q.data ?? []).length === 0 ? <p className="text-sm text-muted-foreground">Sem contestações.</p>
          : <DisputeList disputes={q.data ?? []} onResolve={setResolving} />}
      </CardContent>
      {resolving && (
        <ResolveDisputeDialog dispute={resolving} onClose={() => setResolving(null)}
          onDone={() => { setResolving(null); utils.evaluation.invalidate(); }} />
      )}
    </Card>
  );
}
