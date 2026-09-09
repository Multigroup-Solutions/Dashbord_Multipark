import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { useDashboardFilters, DashboardFilterBar } from "@/components/DashboardFilterBar";
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

type ContractType = "permanent" | "fixed_term" | "extra";

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
};

import { CHART_PALETTE, CHART_PRIMARY } from "@/lib/chart-theme";

const PIE_COLORS = CHART_PALETTE;
const DONUT_COLORS = [CHART_PRIMARY, CHART_PALETTE[6], CHART_PALETTE[4]];

function getWeekNumber(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

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
      <CardContent className="pt-6">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground font-medium">{title}</p>
            <p className="text-2xl font-bold text-foreground">{value}</p>
            {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
          </div>
          <div className={`h-10 w-10 rounded-xl flex items-center justify-center ${iconBg}`}>
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
  const now = new Date();
  const currentWeek = getWeekNumber(now);
  const currentYear = now.getFullYear();

  // Queries
  const { data: stats, isLoading: loadingStats } = trpc.rh.stats.useQuery();
  const { data: employees = [] } = trpc.rh.list.useQuery();
  const { data: docStatus } = trpc.rh.documents.allStatus.useQuery();
  const { data: evaluations = [] } = trpc.performance.list.useQuery({
    weekNumber: currentWeek,
    yearNumber: currentYear,
  });
  const { data: quizRanking = [] } = trpc.training.quizRanking.useQuery();
  const { data: examAttempts = [] } = trpc.training.careerExamAttempts.useQuery({});

  // ── Employee map
  const employeeMap = useMemo(() => {
    const m = new Map<number, { fullName: string; position: string; contractType: string; contractEnd: string | null }>();
    employees.forEach((e: any) => {
      const emp = e.employee || e;
      m.set(emp.id, {
        fullName: emp.fullName,
        position: emp.position,
        contractType: emp.contractType,
        contractEnd: emp.contractEnd || null,
      });
    });
    return m;
  }, [employees]);

  // ── KPI: Contratos a expirar em 30 dias
  const contractsExpiring30d = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + 30);
    let count = 0;
    employeeMap.forEach((emp) => {
      if (emp.contractEnd) {
        const end = new Date(emp.contractEnd);
        if (end >= now && end <= cutoff) count++;
      }
    });
    return count;
  }, [employeeMap]);

  // ── KPI: Documentos em falta
  const missingDocsCount = useMemo(() => {
    if (!docStatus) return 0;
    let total = 0;
    Object.values(docStatus).forEach((s: any) => {
      total += s.missing.length;
    });
    return total;
  }, [docStatus]);

  // ── KPI: Employees with missing docs (for subtitle)
  const employeesWithMissingDocs = useMemo(() => {
    if (!docStatus) return 0;
    return Object.values(docStatus).filter((s: any) => s.missing.length > 0).length;
  }, [docStatus]);

  // ── KPI: Avaliações esta semana
  const evaluationsThisWeek = evaluations.length;

  // ── KPI: Taxa de aprovação exames
  const examApprovalRate = useMemo(() => {
    if (examAttempts.length === 0) return null;
    const passed = examAttempts.filter((a: any) => a.passed).length;
    return Math.round((passed / examAttempts.length) * 100);
  }, [examAttempts]);

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
      .map((ev: any) => ({
        name: employeeMap.get(ev.employeeId)?.fullName || `#${ev.employeeId}`,
        totalPoints: ev.totalPoints || 0,
      }));
  }, [evaluations, employeeMap]);

  // ── Top 5 quiz ranking
  const top5Quiz = useMemo(() => {
    return quizRanking.slice(0, 5).map((r: any) => ({
      employeeId: r.employeeId,
      name: employeeMap.get(r.employeeId)?.fullName || `#${r.employeeId}`,
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
          Visao geral de RH, desempenho e formacao
        </p>
      </div>

      <DashboardFilterBar
        from={filters.from}
        to={filters.to}
        onFromChange={filters.setFrom}
        onToChange={filters.setTo}
        cityId={filters.cityId}
        onCityChange={filters.setCityId}
        brandId={filters.brandId}
        onBrandChange={filters.setBrandId}
      />

      {/* KPI Row */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <KpiCard
          title="Funcionarios Ativos"
          value={stats?.totalActive ?? 0}
          subtitle={`${stats?.totalPermanent ?? 0} permanentes`}
          icon={Users}
          iconColor="text-blue-600"
          iconBg="bg-blue-100"
        />
        <KpiCard
          title="Contratos a Expirar"
          value={contractsExpiring30d}
          subtitle="Proximos 30 dias"
          icon={CalendarClock}
          iconColor="text-amber-600"
          iconBg="bg-amber-100"
        />
        <KpiCard
          title="Documentos em Falta"
          value={missingDocsCount}
          subtitle={`${employeesWithMissingDocs} colaboradores`}
          icon={FileWarning}
          iconColor="text-red-600"
          iconBg="bg-red-100"
        />
        <KpiCard
          title="Avaliacoes esta Semana"
          value={evaluationsThisWeek}
          subtitle={`Semana ${currentWeek}/${currentYear}`}
          icon={ClipboardCheck}
          iconColor="text-green-600"
          iconBg="bg-green-100"
        />
        <KpiCard
          title="Taxa Aprovacao Exames"
          value={examApprovalRate !== null ? `${examApprovalRate}%` : "—"}
          subtitle={`${examAttempts.length} tentativas`}
          icon={GraduationCap}
          iconColor="text-purple-600"
          iconBg="bg-purple-100"
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Distribuicao por Posicao (Pie) */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Distribuicao por Posicao</CardTitle>
          </CardHeader>
          <CardContent>
            {positionDistribution.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">Sem dados</p>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie
                    data={positionDistribution}
                    cx="50%"
                    cy="50%"
                    outerRadius={100}
                    dataKey="value"
                    label={({ name, value }) => `${name}: ${value}`}
                  >
                    {positionDistribution.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Distribuicao por Contrato (Donut) */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Distribuicao por Tipo de Contrato</CardTitle>
          </CardHeader>
          <CardContent>
            {contractDistribution.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">Sem dados</p>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie
                    data={contractDistribution}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    dataKey="value"
                    label={({ name, value }) => `${name}: ${value}`}
                  >
                    {contractDistribution.map((_, i) => (
                      <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend />
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
              Top 5 Condutores — Semana {currentWeek}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {top5Performance.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">
                Sem avaliacoes esta semana
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
                  <Tooltip formatter={(value: number) => [`${value} pts`, "Pontuacao"]} />
                  <Bar dataKey="totalPoints" fill={CHART_PRIMARY} radius={[0, 4, 4, 0]} />
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
            {top5Quiz.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">
                Nenhuma tentativa ainda
              </p>
            ) : (
              <div className="space-y-3">
                {top5Quiz.map((r, i) => (
                  <div
                    key={r.employeeId}
                    className="flex items-center justify-between p-3 rounded-lg bg-accent/30"
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={`font-bold text-lg w-8 ${
                          i === 0
                            ? "text-amber-500"
                            : i === 1
                            ? "text-gray-400"
                            : i === 2
                            ? "text-amber-700"
                            : "text-muted-foreground"
                        }`}
                      >
                        #{i + 1}
                      </span>
                      <div>
                        <p className="font-medium text-sm">{r.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {r.totalAttempts} jogos · melhor: {r.bestScore} pts
                        </p>
                      </div>
                    </div>
                    <Badge variant="secondary" className="text-sm">
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
