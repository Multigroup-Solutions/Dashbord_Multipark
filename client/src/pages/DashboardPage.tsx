import OpsBriefingCard from "@/components/aiOps/OpsBriefingCard";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { useAuth } from "@/_core/hooks/useAuth";
import { can, type ModuleId } from "@shared/access";
import { isForbidden, retryTransient } from "@/lib/queryRetry";
import { StatValue } from "@/components/StatValue";
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
  note,
  value,
  subtitle,
  loading,
  failed,
  onRetry,
}: {
  icon: React.ElementType;
  iconColor: string;
  iconBg: string;
  label: string;
  /** Plano 64: o dia e os parques que o número conta ("00h–24h · todos os parques"). */
  note?: string;
  value: string;
  subtitle?: string;
  loading?: boolean;
  /** 20d: a leitura falhou — mostra "—" e "não carregou" (ou "sem acesso"), nunca 0. */
  failed?: "error" | "forbidden" | null;
  onRetry?: () => void;
}) {
  return (
    <Card className="p-4 sm:p-5 gap-0 min-w-0 hover:shadow-md transition-all">
      <div
        className="h-10 w-10 sm:h-11 sm:w-11 rounded-xl flex items-center justify-center mb-3 shrink-0"
        style={{ backgroundColor: iconBg }}
      >
        <Icon className="h-5 w-5" style={{ color: iconColor }} aria-hidden />
      </div>
      <div className="text-[13px] font-medium text-muted-foreground truncate" title={label}>{label}</div>
      {note ? <div className="text-[11px] text-muted-foreground/80 leading-snug mb-1 break-words">{note}</div> : <div className="mb-1" />}
      {loading ? (
        <div className="h-8 w-20 bg-muted rounded animate-pulse" />
      ) : failed ? (
        <StatValue value="—" className="text-muted-foreground tracking-[-0.01em]" />
      ) : (
        <StatValue value={value} className="text-foreground tracking-[-0.01em]" />
      )}
      {failed === "forbidden" && !loading ? (
        <div className="text-xs text-muted-foreground mt-1">Sem acesso</div>
      ) : failed && !loading ? (
        <button type="button" onClick={onRetry} role="alert" className="text-xs text-red-700 dark:text-red-300 mt-1 underline text-left">
          Não carregou · tentar de novo
        </button>
      ) : subtitle && !loading && (
        <div className="text-xs text-muted-foreground mt-1 tabular-nums break-words" title={subtitle}>{subtitle}</div>
      )}
    </Card>
  );
}

const dashboardModules: Array<{ icon: React.ElementType; label: string; path: string; module: ModuleId; iconColor: string; iconBg: string; accentColor: string }> = [
  {
    icon: Euro,
    label: "Financeiro",
    path: "/financeiro",
    module: "financeiro",
    iconColor: "#3B82F6",
    iconBg: "#DBEAFE",
    accentColor: "#3B82F6",
  },
  {
    icon: Truck,
    label: "Operações",
    path: "/operacoes-dashboard",
    module: "dashboards",
    iconColor: "#F59E0B",
    iconBg: "#FEF3C7",
    accentColor: "#F59E0B",
  },
  {
    icon: Users,
    label: "Pessoas",
    path: "/pessoas-dashboard",
    module: "dashboards",
    iconColor: "#8B5CF6",
    iconBg: "#EDE9FE",
    accentColor: "#8B5CF6",
  },
  {
    icon: ShieldAlert,
    label: "Suporte",
    path: "/suporte-dashboard",
    module: "dashboards",
    iconColor: "#EF4444",
    iconBg: "#FEE2E2",
    accentColor: "#EF4444",
  },
  {
    icon: Megaphone,
    label: "Marketing",
    path: "/marketing",
    module: "marketing",
    iconColor: "#EC4899",
    iconBg: "#FCE7F3",
    accentColor: "#EC4899",
  },
];

/** Plano 64: o dia e os parques de cada número, escritos no cartão. */
const TODAY_ALL_PARKS = "00h–24h · todos os parques";
const TODAY_OPERATED_PARKS = "00h–24h · parques que operamos";

export default function DashboardPage() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const globalFilters = useGlobalFilters();
  // Plano 64: a cidade/marca do topo vale para TODOS os cartões (as mesmas consultas das páginas).
  const scope = globalFilters.projectId !== undefined ? { projectId: globalFilters.projectId } : {};
  // B5: os euros (despesas e entregas) pedem-se a quem tem o módulo Financeiro; o servidor
  // exige também os totais financeiros (requireFinanceTotals) — um FORBIDDEN dá "Sem acesso".
  const seesFinance = can(user as any, "financeiro", "view");
  // ── Queries (dados reais da BD) ──
  // 20d: erro ≠ 0 — cada cartão diz "não carregou" e deixa tentar de novo.
  const expQ = trpc.expenses.stats.useQuery(scope, { enabled: seesFinance, retry: retryTransient });
  // B1–B3: as contagens são as das listas de Operações (todos os parques, com as compras por pagar).
  const bkQ = trpc.multipark.opsBookingCounts.useQuery(scope, { retry: retryTransient });
  // B4: entregas (saídas feitas) com IVA, nos parques que operamos — a leitura dos entregues da Faturação.
  const delQ = trpc.invoices.deliveries.useQuery(scope, { enabled: seesFinance, retry: retryTransient });
  const compQ = trpc.complaints.stats.useQuery(scope, { retry: retryTransient });
  const revQ = trpc.reviews.stats.useQuery(scope, { retry: retryTransient });
  // B8: o Geral só mostra as contagens — as horas do mês (a leitura do ponto) ficam para o RH e o Pessoas.
  const hrQ = trpc.rh.stats.useQuery({ ...scope, skipHours: true }, { retry: retryTransient });
  const { data: expStats, isLoading: expLoading } = expQ;
  const { data: bookingStats, isLoading: bkLoading } = bkQ;
  const { data: deliveries, isLoading: delLoading } = delQ;
  const { data: complaintStats, isLoading: compLoading } = compQ;
  const { data: reviewStats, isLoading: revLoading } = revQ;
  const { data: hrStats, isLoading: hrLoading } = hrQ;
  const failOf = (q: { error: unknown }) => (q.error ? (isForbidden(q.error) ? "forbidden" as const : "error" as const) : null);
  /** Sem o módulo Financeiro a consulta nem sai: "Sem acesso" (nunca "0 €"). */
  const financeFail = (q: { error: unknown }) => (seesFinance ? failOf(q) : "forbidden" as const);
  const bkFailed = failOf(bkQ);
  const retryBk = () => { bkQ.refetch(); };
  // 20d: atalhos só para o que a pessoa pode abrir (pela matriz).
  const modules = dashboardModules.filter((m) => can(user as any, m.module, "view"));
  const reservasMarketplace = bookingStats ? bookingStats.reservasHoje - bookingStats.reservasHojeNossos : 0;

  return (
    <div className="space-y-8">
      <OpsBriefingCard />
      {/* 10 KPI Cards - 2 rows of 5 */}
      <div className="space-y-3 sm:space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4">
        <KPI
          icon={CalendarCheck}
          iconColor="#6366F1"
          iconBg="#EEF2FF"
          label="Reservas criadas hoje"
          note={TODAY_ALL_PARKS}
          value={fmtNum(bookingStats?.reservasHoje ?? 0)}
          subtitle={`${fmtNum(bookingStats?.reservasHojeNossos ?? 0)} em parques nossos · ${fmtNum(reservasMarketplace)} em parques do Marketplace · este mês: ${fmtNum(bookingStats?.reservasMes ?? 0)}`}
          loading={bkLoading}
          failed={bkFailed}
          onRetry={retryBk}
        />
        <KPI
          icon={Car}
          iconColor="#10B981"
          iconBg="#D1FAE5"
          label="Entradas hoje"
          note={TODAY_ALL_PARKS}
          value={fmtNum(bookingStats?.checkinHoje ?? 0)}
          subtitle={`este mês: ${fmtNum(bookingStats?.checkinMes ?? 0)}`}
          loading={bkLoading}
          failed={bkFailed}
          onRetry={retryBk}
        />
        <KPI
          icon={CheckCircle2}
          iconColor="#3B82F6"
          iconBg="#DBEAFE"
          label="Saídas hoje"
          note={TODAY_ALL_PARKS}
          value={fmtNum(bookingStats?.checkoutHoje ?? 0)}
          subtitle={`este mês: ${fmtNum(bookingStats?.checkoutMes ?? 0)}`}
          loading={bkLoading}
          failed={bkFailed}
          onRetry={retryBk}
        />
        <KPI
          icon={AlertTriangle}
          iconColor="#EF4444"
          iconBg="#FEE2E2"
          label="Cancelados hoje"
          note={TODAY_ALL_PARKS}
          value={fmtNum(bookingStats?.canceladosHoje ?? 0)}
          subtitle={`este mês: ${fmtNum(bookingStats?.canceladosMes ?? 0)}`}
          loading={bkLoading}
          failed={bkFailed}
          onRetry={retryBk}
        />
        <KPI
          icon={Euro}
          iconColor="#059669"
          iconBg="#D1FAE5"
          label="Entregas hoje (c/ IVA)"
          note={TODAY_OPERATED_PARKS}
          value={fmtCurrency(deliveries?.today.gross ?? 0)}
          subtitle={`${fmtNum(deliveries?.today.count ?? 0)} carros · este mês: ${fmtCurrency(deliveries?.month.gross ?? 0)}`}
          loading={seesFinance && delLoading}
          failed={financeFail(delQ)}
          onRetry={() => { delQ.refetch(); }}
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4">
        <KPI
          icon={Euro}
          iconColor="#6366F1"
          iconBg="#EEF2FF"
          label="Despesas Mês"
          value={fmtCurrency(expStats?.monthly?.total ?? 0)}
          subtitle={`${expStats?.monthly?.count ?? 0} registos`}
          loading={seesFinance && expLoading}
          failed={financeFail(expQ)}
          onRetry={() => { expQ.refetch(); }}
        />
        <KPI
          icon={Clock}
          iconColor="#F59E0B"
          iconBg="#FEF3C7"
          label="Pendente"
          value={fmtCurrency(expStats?.pending?.total ?? 0)}
          subtitle={`${expStats?.pending?.count ?? 0} por pagar`}
          loading={seesFinance && expLoading}
          failed={financeFail(expQ)}
          onRetry={() => { expQ.refetch(); }}
        />
        <KPI
          icon={MessageSquareWarning}
          iconColor="#EF4444"
          iconBg="#FEE2E2"
          label="Reclamações abertas"
          value={fmtNum(complaintStats?.open ?? 0)}
          subtitle={`${fmtNum(complaintStats?.overdue ?? 0)} em atraso`}
          loading={compLoading}
          failed={failOf(compQ)}
          onRetry={() => { compQ.refetch(); }}
        />
        <KPI
          icon={Star}
          iconColor="#EC4899"
          iconBg="#FCE7F3"
          label="Média Google"
          value={`${reviewStats?.avg != null ? Number(reviewStats.avg).toFixed(1).replace(".", ",") : "—"} ★`}
          subtitle={`${reviewStats?.pending ?? 0} pendentes`}
          loading={revLoading}
          failed={failOf(revQ)}
          onRetry={() => { revQ.refetch(); }}
        />
        <KPI
          icon={UserCheck}
          iconColor="#8B5CF6"
          iconBg="#EDE9FE"
          label="Colaboradores"
          value={fmtNum(hrStats?.totalActive ?? 0)}
          subtitle={`${fmtNum(hrStats?.staff ?? 0)} funcionários · ${fmtNum(hrStats?.extras ?? 0)} extras${hrStats?.partners ? ` · ${fmtNum(hrStats.partners)} parceiros-empresa` : ""}`}
          loading={hrLoading}
          failed={failOf(hrQ)}
          onRetry={() => { hrQ.refetch(); }}
        />
      </div>
      </div>

      {/* Dashboards — cartões estilo v2 (barrinha azul + ícone em quadrado azul) */}
      <div>
        <div className="flex items-center gap-2.5 mb-3">
          <span className="w-1 h-4 rounded-sm bg-primary inline-block" />
          <h2 className="m-0 font-display text-xs font-bold tracking-[.12em] text-[#0c1f3f] uppercase">
            Dashboards
          </h2>
          <span className="text-xs text-muted-foreground">· {modules.length} atalhos</span>
        </div>
        <div className="grid grid-cols-2 md:[grid-template-columns:repeat(auto-fill,minmax(190px,1fr))] gap-3 md:gap-3.5">
          {modules.map((mod) => (
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
