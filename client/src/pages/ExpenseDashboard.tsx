import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  TrendingUp,
  TrendingDown,
  Receipt,
  AlertCircle,
  Clock,
  CheckCircle2,
  Euro,
  Loader2,
  Bell,
} from "lucide-react";
import { format } from "date-fns";
import { pt } from "date-fns/locale";
import { useAuth } from "@/_core/hooks/useAuth";
import { toast } from "sonner";

const COLORS = ["#6366f1", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#06b6d4"];

function StatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  trend,
  color = "primary",
}: {
  title: string;
  value: string;
  subtitle?: string;
  icon: any;
  trend?: "up" | "down" | "neutral";
  color?: string;
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
          <div className={`h-10 w-10 rounded-xl flex items-center justify-center bg-primary/10`}>
            <Icon className="h-5 w-5 text-primary" />
          </div>
        </div>
        {trend && (
          <div className="mt-3 flex items-center gap-1 text-xs">
            {trend === "up" ? (
              <TrendingUp className="h-3 w-3 text-red-500" />
            ) : trend === "down" ? (
              <TrendingDown className="h-3 w-3 text-green-500" />
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function ExpenseDashboard() {
  const { user } = useAuth();
  const utils = trpc.useUtils();

  // stats/upcomingPayments são admin-only no servidor — não chamar sem permissão
  const isAdmin = ["admin", "super_admin"].includes(user?.role ?? "");
  const { data: stats, isLoading: statsLoading } = trpc.expenses.stats.useQuery(undefined, { enabled: isAdmin });
  const { data: upcoming, isLoading: upcomingLoading } = trpc.expenses.upcomingPayments.useQuery(undefined, { enabled: isAdmin });

  const checkOverdueMutation = trpc.expenses.checkOverdue.useMutation({
    onSuccess: (data) => {
      toast.success(`${data.updated} despesa(s) marcadas como em atraso`);
      utils.expenses.stats.invalidate();
    },
    onError: () => toast.error("Erro ao verificar despesas em atraso"),
  });

  const isSuperAdmin = user?.role === "super_admin";

  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center py-24 text-center text-muted-foreground text-sm">
        A visão financeira das despesas está reservada à administração.
      </div>
    );
  }

  if (statsLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const totalAmount = (stats?.yearly?.total ?? 0);
  const pendingAmount = stats?.pending?.total ?? 0;
  const overdueAmount = stats?.overdue?.total ?? 0;
  const paidAmount = (totalAmount - pendingAmount - overdueAmount);

  const statusData = [
    { name: "Pendente", value: pendingAmount, count: stats?.pending?.count ?? 0 },
    { name: "Em atraso", value: overdueAmount, count: stats?.overdue?.count ?? 0 },
    { name: "Pago", value: Math.max(0, paidAmount), count: 0 },
  ].filter(s => s.value > 0);

  const categoryData = (stats?.byCategory ?? []).map((c: any) => ({
    name: c.categoryName ?? "Sem categoria",
    total: c.total ?? 0,
    count: c.count,
  }));

  const monthlyData = (stats?.monthlyTrend ?? []).map((m: any) => ({
    month: m.month,
    total: m.total ?? 0,
  }));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Visão geral dos gastos da empresa</p>
        </div>
        {isSuperAdmin && (
          <Button
            variant="outline"
            onClick={() => checkOverdueMutation.mutate()}
            disabled={checkOverdueMutation.isPending}
            className="gap-2 shrink-0"
          >
            {checkOverdueMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Bell className="h-4 w-4" />
            )}
            Verificar Atrasos
          </Button>
        )}
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Total de Despesas"
          value={totalAmount.toLocaleString("pt-PT", { style: "currency", currency: "EUR" })}
          subtitle={`${stats?.yearly?.count ?? 0} registos`}
          icon={Euro}
        />
        <StatCard
          title="Pendente"
          value={parseFloat(String(pendingAmount)).toLocaleString("pt-PT", { style: "currency", currency: "EUR" })}
          icon={Clock}
        />
        <StatCard
          title="Em Atraso"
          value={parseFloat(String(overdueAmount)).toLocaleString("pt-PT", { style: "currency", currency: "EUR" })}
          icon={AlertCircle}
        />
        <StatCard
          title="Pago"
          value={parseFloat(String(paidAmount)).toLocaleString("pt-PT", { style: "currency", currency: "EUR" })}
          icon={CheckCircle2}
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Monthly Bar Chart */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base font-semibold">Despesas Mensais</CardTitle>
          </CardHeader>
          <CardContent>
            {monthlyData.length === 0 ? (
              <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
                Sem dados mensais disponíveis
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={monthlyData} margin={{ top: 4, right: 4, left: 0, bottom: 4 }} style={{ background: "transparent" }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="month" tick={{ fontSize: 12, fill: "#64748b" }} />
                  <YAxis tick={{ fontSize: 12, fill: "#64748b" }} tickFormatter={(v) => `${v}€`} />
                  <Tooltip
                    formatter={(v: any) => [parseFloat(v).toLocaleString("pt-PT", { style: "currency", currency: "EUR" }), "Total"]}
                    contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "8px" }}
                  />
                  <Bar dataKey="total" fill="#6366f1" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Status Pie Chart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">Por Estado</CardTitle>
          </CardHeader>
          <CardContent>
            {statusData.length === 0 ? (
              <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
                Sem dados disponíveis
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <PieChart>
                  <Pie
                    data={statusData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={90}
                    paddingAngle={3}
                    dataKey="value"
                  >
                    {statusData.map((_: any, i: number) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(v: any) => [parseFloat(v).toLocaleString("pt-PT", { style: "currency", currency: "EUR" })]}
                    contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px" }}
                  />
                  <Legend iconSize={10} wrapperStyle={{ fontSize: "12px" }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Category Chart */}
      {categoryData.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">Despesas por Categoria</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={categoryData} layout="vertical" margin={{ top: 4, right: 16, left: 80, bottom: 4 }} style={{ background: "transparent" }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 12, fill: "#64748b" }} tickFormatter={(v) => `${v}€`} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 12, fill: "#64748b" }} width={80} />
                <Tooltip
                  formatter={(v: any) => [parseFloat(v).toLocaleString("pt-PT", { style: "currency", currency: "EUR" }), "Total"]}
                  contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "8px" }}
                />
                <Bar dataKey="total" fill="#f59e0b" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Upcoming Payments */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Clock className="h-4 w-4 text-yellow-500" />
            Pagamentos nos Próximos 7 Dias
          </CardTitle>
        </CardHeader>
        <CardContent>
          {upcomingLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : !upcoming || upcoming.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              Nenhum pagamento pendente nos próximos 7 dias
            </div>
          ) : (
            <div className="space-y-3">
              {upcoming.map(({ expense, project }: any) => {
                const daysLeft = Math.ceil(
                  (new Date(expense.paymentDueDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
                );
                return (
                  <div key={expense.id} className="flex items-center justify-between p-3 rounded-lg bg-muted/50 border">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm text-foreground truncate">{expense.supplier ?? "Sem fornecedor"}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {project?.name ?? "Sem projeto"} · Vence em {format(new Date(expense.paymentDueDate), "dd MMM", { locale: pt })}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 ml-4">
                      <span className="font-semibold text-sm">
                        {parseFloat(String(expense.amount)).toLocaleString("pt-PT", { style: "currency", currency: "EUR" })}
                      </span>
                      <Badge
                        variant="outline"
                        className={daysLeft <= 1 ? "border-red-300 text-red-700 bg-red-50" : daysLeft <= 3 ? "border-yellow-300 text-yellow-700 bg-yellow-50" : "border-blue-300 text-blue-700 bg-blue-50"}
                      >
                        {daysLeft === 0 ? "Hoje" : daysLeft === 1 ? "Amanhã" : `${daysLeft} dias`}
                      </Badge>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
