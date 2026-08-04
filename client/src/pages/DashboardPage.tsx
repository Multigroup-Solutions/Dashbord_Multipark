import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { ModuleCard } from "@/components/ModuleCard";
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
        <div className="text-2xl font-bold text-foreground leading-none">{value}</div>
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

      {/* Dashboard Modules */}
      <div>
        <h2 className="text-xs font-bold text-muted-foreground tracking-wider uppercase mb-4">
          Dashboards
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          {dashboardModules.map((mod) => (
            <ModuleCard
              key={mod.path}
              icon={mod.icon}
              iconColor={mod.iconColor}
              iconBg={mod.iconBg}
              label={mod.label}
              path={mod.path}
              accentColor={mod.accentColor}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
