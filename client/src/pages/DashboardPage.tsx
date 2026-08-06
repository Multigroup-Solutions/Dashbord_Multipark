import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { Card } from "@/components/ui/card";
import {
  Euro,
  Users,
  Star,
  CalendarCheck,
  Truck,
  Megaphone,
  MessageSquareWarning,
  AlertTriangle,
  ShieldAlert,
  Clock,
  CheckCircle2,
  UserCheck,
  Car,
} from "lucide-react";

const fmtNum = (n: number) => n.toLocaleString("pt-PT");
const fmtCurrency = (n: number) =>
  n.toLocaleString("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

function KPI({
  icon: Icon,
  iconColor,
  iconBg,
  label,
  value,
  subtitle,
  loading,
}: {
  icon: React.ElementType;
  iconColor: string;
  iconBg: string;
  label: string;
  value: string;
  subtitle?: string;
  loading?: boolean;
}) {
  return (
    <Card className="p-5 hover:shadow-md transition-all">
      <div className="flex items-start justify-between mb-3">
        <div
          className="h-11 w-11 rounded-xl flex items-center justify-center"
          style={{ backgroundColor: iconBg }}
        >
          <Icon className="h-5 w-5" style={{ color: iconColor }} />
        </div>
      </div>
      <div className="text-[13px] font-medium text-muted-foreground mb-1">{label}</div>
      {loading ? (
        <div className="h-8 w-20 bg-muted rounded animate-pulse" />
      ) : (
        <div className="font-display text-2xl font-bold text-[#0c1f3f] leading-none tracking-[-0.01em]">{value}</div>
      )}
      {subtitle && !loading && (
        <div className="text-xs text-muted-foreground mt-1">{subtitle}</div>
      )}
    </Card>
  );
}

const dashboardModules = [
  {
    icon: Euro,
    label: "Financeiro",
    path: "/financeiro",
    iconColor: "#3B82F6",
    iconBg: "#DBEAFE",
    accentColor: "#3B82F6",
  },
  {
    icon: Truck,
    label: "Operações",
    path: "/operacoes-dashboard",
    iconColor: "#F59E0B",
    iconBg: "#FEF3C7",
    accentColor: "#F59E0B",
  },
  {
    icon: Users,
    label: "Pessoas",
    path: "/pessoas-dashboard",
    iconColor: "#8B5CF6",
    iconBg: "#EDE9FE",
    accentColor: "#8B5CF6",
  },
  {
    icon: ShieldAlert,
    label: "Suporte",
    path: "/suporte-dashboard",
    iconColor: "#EF4444",
    iconBg: "#FEE2E2",
    accentColor: "#EF4444",
  },
  {
    icon: Megaphone,
    label: "Marketing",
    path: "/marketing-dashboard",
    iconColor: "#EC4899",
    iconBg: "#FCE7F3",
    accentColor: "#EC4899",
  },
];

export default function DashboardPage() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  // expenses.stats é admin-only no servidor — não chamar sem permissão
  const isAdmin = ["admin", "super_admin"].includes(user?.role ?? "");
  // ── Queries (dados reais da BD) ──
  const { data: expStats, isLoading: expLoading } = trpc.expenses.stats.useQuery(undefined, { enabled: isAdmin });
  const { data: bookingStats, isLoading: bkLoading } = trpc.multipark.bookingStats.useQuery();
  const { data: complaintStats, isLoading: compLoading } = trpc.complaints.stats.useQuery();
  const { data: reviewStats, isLoading: revLoading } = trpc.reviews.stats.useQuery();
  const { data: hrStats, isLoading: hrLoading } = trpc.rh.stats.useQuery();

  return (
    <div className="space-y-8">
      {/* 10 KPI Cards - 2 rows of 5 */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        <KPI
          icon={CalendarCheck}
          iconColor="#6366F1"
          iconBg="#EEF2FF"
          label="Reservas Hoje"
          value={fmtNum(bookingStats?.reservasHoje ?? 0)}
          subtitle={`${fmtNum(bookingStats?.reservasMes ?? 0)} este mês`}
          loading={bkLoading}
        />
        <KPI
          icon={Car}
          iconColor="#10B981"
          iconBg="#D1FAE5"
          label="Check-ins Hoje"
          value={fmtNum(bookingStats?.checkinHoje ?? 0)}
          subtitle={`${fmtNum(bookingStats?.checkinMes ?? 0)} este mês`}
          loading={bkLoading}
        />
        <KPI
          icon={CheckCircle2}
          iconColor="#3B82F6"
          iconBg="#DBEAFE"
          label="Check-outs Hoje"
          value={fmtNum(bookingStats?.checkoutHoje ?? 0)}
          subtitle={`${fmtNum(bookingStats?.checkoutMes ?? 0)} este mês`}
          loading={bkLoading}
        />
        <KPI
          icon={AlertTriangle}
          iconColor="#EF4444"
          iconBg="#FEE2E2"
          label="Cancelados Hoje"
          value={fmtNum(bookingStats?.canceladosHoje ?? 0)}
          subtitle={`${fmtNum(bookingStats?.canceladosMes ?? 0)} este mês`}
          loading={bkLoading}
        />
        <KPI
          icon={Euro}
          iconColor="#059669"
          iconBg="#D1FAE5"
          label="Receita Hoje"
          value={fmtCurrency(bookingStats?.receitaHoje ?? 0)}
          subtitle={`${fmtCurrency(bookingStats?.receitaMes ?? 0)} este mês`}
          loading={bkLoading}
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        <KPI
          icon={Euro}
          iconColor="#6366F1"
          iconBg="#EEF2FF"
          label="Despesas Mês"
          value={fmtCurrency(expStats?.monthly?.total ?? 0)}
          subtitle={`${expStats?.monthly?.count ?? 0} registos`}
          loading={isAdmin && expLoading}
        />
        <KPI
          icon={Clock}
          iconColor="#F59E0B"
          iconBg="#FEF3C7"
          label="Pendente"
          value={fmtCurrency(expStats?.pending?.total ?? 0)}
          subtitle={`${expStats?.pending?.count ?? 0} por pagar`}
          loading={isAdmin && expLoading}
        />
        <KPI
          icon={MessageSquareWarning}
          iconColor="#EF4444"
          iconBg="#FEE2E2"
          label="Reclamações"
          value={fmtNum(complaintStats?.total ?? 0)}
          subtitle={`${complaintStats?.overdue ?? 0} em atraso`}
          loading={compLoading}
        />
        <KPI
          icon={Star}
          iconColor="#EC4899"
          iconBg="#FCE7F3"
          label="Média Google"
          value={`${reviewStats?.avg != null ? Number(reviewStats.avg).toFixed(1) : "—"}★`}
          subtitle={`${reviewStats?.pending ?? 0} pendentes`}
          loading={revLoading}
        />
        <KPI
          icon={UserCheck}
          iconColor="#8B5CF6"
          iconBg="#EDE9FE"
          label="Colaboradores"
          value={fmtNum(hrStats?.totalActive ?? 0)}
          subtitle={`${hrStats?.totalPermanent ?? 0} efetivos · ${hrStats?.totalExtras ?? 0} extras`}
          loading={hrLoading}
        />
      </div>

      {/* Dashboards — cartões estilo v2 (barrinha azul + ícone em quadrado azul) */}
      <div>
        <div className="flex items-center gap-2.5 mb-3">
          <span className="w-1 h-4 rounded-sm bg-primary inline-block" />
          <h2 className="m-0 font-display text-xs font-bold tracking-[.12em] text-[#0c1f3f] uppercase">
            Dashboards
          </h2>
          <span className="text-xs text-slate-400">· {dashboardModules.length} atalhos</span>
        </div>
        <div className="grid grid-cols-2 md:[grid-template-columns:repeat(auto-fill,minmax(190px,1fr))] gap-3 md:gap-3.5">
          {dashboardModules.map((mod) => (
            <button
              key={mod.path}
              type="button"
              onClick={() => navigate(mod.path)}
              className="flex flex-col items-start gap-3 bg-white border border-slate-200 rounded-[14px] p-4 md:p-[18px] text-left shadow-[0_1px_2px_rgba(12,31,63,0.05)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_8px_20px_rgba(12,31,63,0.10)] hover:border-primary cursor-pointer"
            >
              <span className="w-10 h-10 rounded-xl bg-primary text-white flex items-center justify-center shrink-0">
                <mod.icon className="w-5 h-5" />
              </span>
              <span className="font-display text-[13px] font-semibold text-[#0c1f3f] uppercase tracking-[.02em]">
                {mod.label}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
