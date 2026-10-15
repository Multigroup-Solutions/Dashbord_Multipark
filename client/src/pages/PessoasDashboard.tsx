import { useMemo } from "react";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { trpc } from "@/lib/trpc";
import { isForbidden, retryTransient } from "@/lib/queryRetry";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { useDashboardFilters, DashboardFilterBar } from "@/components/DashboardFilterBar";
import { useAuth } from "@/_core/hooks/useAuth";
import { can, scopeFor } from "@shared/access";
import { addDays, lisbonDayOf, operationalDayOf } from "@shared/lisbonDay";
import { contractsExpiring, missingDocsTotals } from "@shared/peopleStats";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import {
  Users,
  FileWarning,
  CalendarClock,
  ClipboardCheck,
  GraduationCap,
  Trophy,
  Loader2,
} from "lucide-react";

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

type Position =
  | "director" | "supervisor" | "team_leader" | "backoffice"
  | "frontoffice" | "senior_driver" | "driver" | "extra";

type ContractType = "permanent" | "fixed_term" | "extra" | "partner_company";

const POSITION_LABELS: Record<Position, string> = {
  director: "Director",
  supervisor: "Supervisor",
  team_leader: "Team Leader",
  backoffice: "Backoffice",
  frontoffice: "Frontoffice",
  senior_driver: "Condutor Sénior",
  driver: "Condutor",
  extra: "Extra",
};

const CONTRACT_LABELS: Record<ContractType, string> = {
  permanent: "Permanente",
  fixed_term: "Termo Certo",
  extra: "Extra",
  partner_company: "Parceiro (empresa)",
};

const PIE_COLORS = ["#6366f1", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#14b8a6"];
const DONUT_COLORS = ["#3b82f6", "#f97316", "#a855f7"];

// Legenda legível: texto na cor do texto (não na cor da fatia) e com o valor —
// substitui as etiquetas à volta da tarte, que eram cortadas em ecrãs estreitos.
const legendLabel = (value: string, entry: any) => (
  <span className="text-foreground">
    {value}: <span className="font-semibold tabular-nums">{entry?.payload?.value}</span>
  </span>
);

/** Subtítulo de um cartão cuja leitura falhou: "Sem acesso" (permissão) ou erro — nunca 0 (plano 64, D12). */
const failedNote = (error: unknown) => (isForbidden(error) ? "Sem acesso" : "Leitura falhou — não é 0");

// ─── KPI CARD ────────────────────────────────────────────────────────────────

function KpiCard({
  title,
  value,
  subtitle,
  icon: Icon,
  iconColor = "text-primary",
  iconBg = "bg-primary/10",
}: {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: any;
  iconColor?: string;
  iconBg?: string;
}) {
  return (
    <Card className="relative overflow-hidden">
      <CardContent className="p-4 sm:p-6">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1 min-w-0">
            <p className="text-xs sm:text-sm text-muted-foreground font-medium break-words">{title}</p>
            <p className="text-2xl font-bold text-foreground tabular-nums truncate" title={String(value)}>{value}</p>
            {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
          </div>
          <div className={`h-8 w-8 sm:h-10 sm:w-10 shrink-0 rounded-xl flex items-center justify-center ${iconBg}`}>
            <Icon className={`h-5 w-5 ${iconColor}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── MAIN DASHBOARD ──────────────────────────────────────────────────────────

export default function PessoasDashboard() {
  const filters = useDashboardFilters();
  const globalFilters = useGlobalFilters();
  const { user } = useAuth();
  // Plano 64 (D1–D8): a cidade/marca do topo vale para TODOS os cartões, com as
  // mesmas consultas das páginas de referência (lista do RH, Avaliação, Formação).
  const scope = globalFilters.projectId !== undefined ? { projectId: globalFilters.projectId } : {};
  // Avaliação: o MESMO motor da página Avaliação, nos últimos 7 dias
  // operacionais ATÉ ONTEM (o dia de hoje ainda não está calculado).
  const evalTo = addDays(operationalDayOf(Date.now()), -1);
  const evalFrom = addDays(evalTo, -6);
  const canEval = !!user && can(user as any, "avaliacao", "view") && scopeFor(user as any, "avaliacao") !== "own";

  // Queries ("—" com a nota quando falham, nunca 0)
  const statsQ = trpc.rh.stats.useQuery(scope, { retry: retryTransient });
  const stats = statsQ.data;
  const loadingStats = statsQ.isLoading;
  // A MESMA lista do RH (fichas ativas, cidade/marca do topo): saem as inativas, desativadas e candidatos.
  const listQ = trpc.rh.list.useQuery({ isActive: true, ...scope }, { retry: retryTransient });
  const employees = listQ.data ?? [];
  const docsQ = trpc.rh.documents.allStatus.useQuery(undefined, { retry: retryTransient });
  const docStatus = docsQ.data;
  const evalQ = trpc.evaluation.ranking.useQuery({ from: evalFrom, to: evalTo, ...scope }, { enabled: canEval, retry: retryTransient });
  const evaluations = evalQ.data ?? [];
  const quizQ = trpc.training.quizRanking.useQuery(scope, { retry: retryTransient });
  const quizRanking = quizQ.data ?? [];
  const examsQ = trpc.training.careerExamAttempts.useQuery(scope, { retry: retryTransient });
  const examAttempts = examsQ.data ?? [];

  // ── Employee map (fichas ativas da lista)
  const employeeMap = useMemo(() => {
    const m = new Map<number, { fullName: string; position: string; contractType: string; contractEnd: string | null }>();
    employees.forEach((e: any) => {
      const emp = e.employee || e;
      m.set(emp.id, {
        fullName: emp.fullName,
        position: emp.position,
        // contrato vazio = "sem termo" (o valor por omissão da ficha)
        contractType: emp.contractType || "permanent",
        contractEnd: emp.contractEnd || null,
      });
    });
    return m;
  }, [employees]);

  // ── KPI: Contratos a expirar (dias de Lisboa: hoje ≤ fim ≤ hoje + 30)
  const contractsExpiring30d = useMemo(
    () => (listQ.data ? contractsExpiring(Array.from(employeeMap.values()), lisbonDayOf(Date.now())) : null),
    [employeeMap, listQ.data],
  );

  // ── KPI: Documentos em falta — só as fichas ATIVAS da lista (uma ficha sem documentos tem os 7 em falta)
  const missingDocs = useMemo(() => {
    if (!docStatus || !listQ.data) return null;
    return missingDocsTotals(Array.from(employeeMap.keys()).map((id) => ({ id })), docStatus as Record<number, { total: number; present: number }>);
  }, [docStatus, listQ.data, employeeMap]);

  // ── KPI: pessoas avaliadas nos últimos 7 dias ("—" sem dados: nunca 0 por erro)
  const evaluationsThisWeek: string | number = !canEval ? "—" : evalQ.data ? evaluations.length : "—";

  // ── KPI: Taxa de aprovação exames (exames não arquivados, fichas ativas, cidade do topo)
  const examApprovalRate = useMemo(() => {
    if (examAttempts.length === 0) return null;
    const passed = examAttempts.filter((a: any) => a.passed).length;
    return Math.round((passed / examAttempts.length) * 100);
  }, [examAttempts]);

  const kpiFailures = [
    statsQ.error ? { key: "stats", error: statsQ.error, what: "as fichas ativas", retry: () => statsQ.refetch(), fetching: statsQ.isFetching } : null,
    listQ.error ? { key: "list", error: listQ.error, what: "a lista do RH (contratos e gráficos)", retry: () => listQ.refetch(), fetching: listQ.isFetching } : null,
    docsQ.error ? { key: "docs", error: docsQ.error, what: "os documentos", retry: () => docsQ.refetch(), fetching: docsQ.isFetching } : null,
    examsQ.error ? { key: "exams", error: examsQ.error, what: "os exames", retry: () => examsQ.refetch(), fetching: examsQ.isFetching } : null,
  ].filter((x): x is NonNullable<typeof x> => x != null);

  // ── Chart: Distribuição por posição
  const positionDistribution = useMemo(() => {
    const counts: Record<string, number> = {};
    employeeMap.forEach((emp) => {
      const pos = emp.position || "other";
      counts[pos] = (counts[pos] || 0) + 1;
    });
    return Object.entries(counts)
      .map(([key, value]) => ({
        name: POSITION_LABELS[key as Position] || key,
        value,
      }))
      .sort((a, b) => b.value - a.value);
  }, [employeeMap]);

  // ── Chart: Distribuição por contrato
  const contractDistribution = useMemo(() => {
    const counts: Record<string, number> = {};
    employeeMap.forEach((emp) => {
      const ct = emp.contractType || "other";
      counts[ct] = (counts[ct] || 0) + 1;
    });
    return Object.entries(counts)
      .map(([key, value]) => ({
        name: CONTRACT_LABELS[key as ContractType] || key,
        value,
      }))
      .sort((a, b) => b.value - a.value);
  }, [employeeMap]);

  // ── Chart: Top 5 condutores performance
  const top5Performance = useMemo(() => {
    return evaluations
      .slice(0, 5)
      .map((ev) => ({
        name: employeeMap.get(ev.employeeId)?.fullName || ev.employeeName || `#${ev.employeeId}`,
        totalPoints: Math.round(ev.score.totalPoints * 10) / 10,
      }));
  }, [evaluations, employeeMap]);

  // ── Top 5 quiz ranking (só fichas ativas, cidade do topo)
  const top5Quiz = useMemo(() => {
    return quizRanking.slice(0, 5).map((r: any) => ({
      employeeId: r.employeeId,
      name: employeeMap.get(r.employeeId)?.fullName || r.name || `#${r.employeeId}`,
      totalScore: r.totalScore,
      totalAttempts: r.totalAttempts,
      bestScore: r.bestScore,
    }));
  }, [quizRanking, employeeMap]);

  // ── Loading state
  if (loadingStats) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Dashboard Pessoas</h1>
        <p className="text-muted-foreground">
          Visão geral de RH, desempenho e formação
        </p>
      </div>

      {/* Sem Período (D8): os números são "agora" ou janelas fixas com o rótulo a dizer qual;
          a cidade e a marca valem para todos os cartões. */}
      <DashboardFilterBar
        from={filters.from}
        to={filters.to}
        onFromChange={filters.setFrom}
        onToChange={filters.setTo}
        cityId={filters.cityId}
        onCityChange={filters.setCityId}
        brandId={filters.brandId}
        onBrandChange={filters.setBrandId}
        showDates={false}
      />

      {/* KPI Row */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <KpiCard
          title="Fichas ativas"
          value={stats ? stats.totalActive : "—"}
          subtitle={stats
            ? `${stats.staff} funcionários · ${stats.extras} extras${stats.partners > 0 ? ` · ${stats.partners} parceiros-empresa` : ""}`
            : statsQ.error ? failedNote(statsQ.error) : ""}
          icon={Users}
          iconColor="text-blue-600"
          iconBg="bg-blue-100"
        />
        <KpiCard
          title="Contratos a Expirar"
          value={contractsExpiring30d ?? "—"}
          subtitle={listQ.error ? failedNote(listQ.error) : "Próximos 30 dias (hoje incluído)"}
          icon={CalendarClock}
          iconColor="text-amber-600"
          iconBg="bg-amber-100"
        />
        <KpiCard
          title="Documentos em Falta"
          value={missingDocs ? missingDocs.missing : "—"}
          subtitle={missingDocs
            ? `em ${missingDocs.employees} fichas ativas`
            : docsQ.error ? failedNote(docsQ.error) : listQ.error ? failedNote(listQ.error) : ""}
          icon={FileWarning}
          iconColor="text-red-600"
          iconBg="bg-red-100"
        />
        <KpiCard
          title="Avaliados (7 dias)"
          value={evaluationsThisWeek}
          subtitle={!canEval ? "Sem acesso" : evalQ.error ? failedNote(evalQ.error) : "últimos 7 dias operacionais (até ontem)"}
          icon={ClipboardCheck}
          iconColor="text-green-600"
          iconBg="bg-green-100"
        />
        <KpiCard
          title="Taxa Aprovação Exames"
          value={examsQ.data && examApprovalRate !== null ? `${examApprovalRate}%` : "—"}
          subtitle={examsQ.error ? failedNote(examsQ.error) : examsQ.data ? `${examAttempts.length} tentativas` : ""}
          icon={GraduationCap}
          iconColor="text-purple-600"
          iconBg="bg-purple-100"
        />
      </div>
      {kpiFailures.length > 0 && (
        <div className="space-y-2">
          {kpiFailures.map((f) => (
            <QueryErrorNote key={f.key} error={f.error} what={f.what} onRetry={f.retry} retrying={f.fetching} />
          ))}
        </div>
      )}

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Distribuicao por Posicao (Pie) */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Distribuição por Posição (fichas ativas)</CardTitle>
          </CardHeader>
          <CardContent>
            {listQ.error ? (
              <p className="text-center text-muted-foreground py-8">{failedNote(listQ.error)}</p>
            ) : positionDistribution.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">Sem dados</p>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={positionDistribution}
                    cx="50%"
                    cy="50%"
                    outerRadius="80%"
                    dataKey="value"
                  >
                    {positionDistribution.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend formatter={legendLabel} wrapperStyle={{ fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Distribuicao por Contrato (Donut) */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Distribuição por Tipo de Contrato (fichas ativas)</CardTitle>
          </CardHeader>
          <CardContent>
            {listQ.error ? (
              <p className="text-center text-muted-foreground py-8">{failedNote(listQ.error)}</p>
            ) : contractDistribution.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">Sem dados</p>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={contractDistribution}
                    cx="50%"
                    cy="50%"
                    innerRadius="50%"
                    outerRadius="80%"
                    dataKey="value"
                  >
                    {contractDistribution.map((_, i) => (
                      <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend formatter={legendLabel} wrapperStyle={{ fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Bottom Row: Performance + Quiz */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Top 5 Performance - Horizontal Bar */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Trophy className="w-4 h-4 text-yellow-500" />
              Top 5 — últimos 7 dias operacionais (até ontem)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!canEval ? (
              <p className="text-center text-muted-foreground py-8">A tua conta não vê a avaliação de outras pessoas.</p>
            ) : evalQ.isError ? (
              <QueryErrorNote error={evalQ.error} onRetry={() => evalQ.refetch()} retrying={evalQ.isFetching} what="a avaliação" />
            ) : evalQ.isLoading ? (
              <p className="text-center text-muted-foreground py-8">A carregar…</p>
            ) : top5Performance.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">
                Sem dias avaliados nos últimos 7 dias
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart
                  data={top5Performance}
                  layout="vertical"
                  margin={{ left: 10, right: 20 }}
                >
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" />
                  <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 12 }} />
                  <Tooltip formatter={(value: number) => [`${value} pts`, "Pontuação"]} />
                  <Bar dataKey="totalPoints" fill="#6366f1" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Top 5 Quiz Ranking */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <GraduationCap className="w-4 h-4 text-purple-500" />
              Top 5 Quiz Ranking
            </CardTitle>
          </CardHeader>
          <CardContent>
            {quizQ.error ? (
              <QueryErrorNote error={quizQ.error} onRetry={() => quizQ.refetch()} retrying={quizQ.isFetching} what="o ranking do quiz" />
            ) : quizQ.isLoading ? (
              <p className="text-center text-muted-foreground py-8">A carregar…</p>
            ) : top5Quiz.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">
                Nenhuma tentativa ainda
              </p>
            ) : (
              <div className="space-y-3">
                {top5Quiz.map((r, i) => (
                  <div
                    key={r.employeeId}
                    className="flex items-center justify-between gap-2 p-3 rounded-lg bg-accent/30"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className={`font-bold text-lg w-8 shrink-0 ${
                          i === 0
                            ? "text-amber-600"
                            : i === 1
                            ? "text-gray-500"
                            : i === 2
                            ? "text-amber-700"
                            : "text-muted-foreground"
                        }`}
                      >
                        #{i + 1}
                      </span>
                      <div className="min-w-0">
                        <p className="font-medium text-sm truncate" title={r.name}>{r.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {r.totalAttempts} jogos · melhor: {r.bestScore} pts
                        </p>
                      </div>
                    </div>
                    <Badge variant="secondary" className="text-sm shrink-0 tabular-nums">
                      {r.totalScore} pts
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
