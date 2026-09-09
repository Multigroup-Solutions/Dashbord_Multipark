import { trpc } from "@/lib/trpc";
import { ModuleCard } from "@/components/ModuleCard";
import { StatCard } from "@/components/StatCard";
import {
  Car,
  ArrowDownToLine,
  ArrowUpFromLine,
  ParkingSquare,
  FilePlus2,
  FolderSearch,
  Search,
  Coins,
  Users,
  UserCheck,
  GraduationCap,
  Trophy,
  BarChart3,
  Wrench,
  Megaphone,
  MessageSquareWarning,
  Star,
  AlertTriangle,
  Package,
  Receipt,
  FileText,
  ListTodo,
  Handshake,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState } from "react";

const fmtNum = (n: number) => n.toLocaleString("pt-PT");
const fmtCurrency = (n: number) =>
  n.toLocaleString("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-xs font-bold uppercase tracking-[0.15em] text-muted-foreground">
        {title}
      </h2>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {children}
      </div>
    </section>
  );
}

type TabKey = "menu" | "resumo" | "historico";

export default function DashboardPage() {
  const [tab, setTab] = useState<TabKey>("menu");

  // Contagens reais da BD — fallback 0 se carregar
  const { data: bookingStats } = trpc.multipark.bookingStats.useQuery();
  const { data: complaintStats } = trpc.complaints.stats.useQuery();
  const { data: expStats } = trpc.expenses.stats.useQuery();
  const { data: hrStats } = trpc.rh.stats.useQuery();
  const { data: reviewStats } = trpc.reviews.stats.useQuery();

  const recolhas = bookingStats?.checkinHoje ?? 0;
  const entregas = bookingStats?.checkoutHoje ?? 0;
  const movimentar = bookingStats?.reservasHoje ?? 0;
  const caixa = expStats?.monthly?.total ?? 0;

  return (
    <div className="space-y-6">
      {/* Tabs Menu / Resumo / Histórico */}
      <div className="flex flex-wrap items-center gap-2">
        <TabButton active={tab === "menu"} onClick={() => setTab("menu")}>
          Menu
        </TabButton>
        <TabButton active={tab === "resumo"} onClick={() => setTab("resumo")}>
          Resumo
        </TabButton>
        <TabButton active={tab === "historico"} onClick={() => setTab("historico")}>
          Histórico
        </TabButton>
      </div>

      {tab === "menu" && (
        <div className="space-y-8">
          <Section title="Operacional">
            <ModuleCard
              icon={Car}
              label="Recolhas"
              path="/multipark/entradas"
              count={recolhas}
            />
            <ModuleCard
              icon={ArrowUpFromLine}
              label="Entregas"
              path="/multipark/saidas"
              count={entregas}
            />
            <ModuleCard
              icon={ArrowDownToLine}
              label="Movimentar"
              path="/operacional"
              count={movimentar}
            />
            <ModuleCard
              icon={ParkingSquare}
              label="Lugares"
              path="/operacional"
            />
          </Section>

          <Section title="Backoffice">
            <ModuleCard
              icon={FilePlus2}
              label="Criar Reserva"
              path="/multipark/reservas"
            />
            <ModuleCard
              icon={FolderSearch}
              label="Reservas"
              path="/multipark/reservas"
              count={bookingStats?.reservasMes}
            />
            <ModuleCard
              icon={Search}
              label="Pesquisa Global"
              path="/multipark/reservas"
            />
            <ModuleCard
              icon={Coins}
              label="Caixa"
              path="/financeiro"
              value={fmtCurrency(caixa)}
            />
          </Section>

          <Section title="Pessoas">
            <ModuleCard
              icon={UserCheck}
              label="Recursos Humanos"
              path="/rh"
              count={hrStats?.totalActive}
            />
            <ModuleCard
              icon={Users}
              label="Utilizadores"
              path="/utilizadores"
            />
            <ModuleCard
              icon={GraduationCap}
              label="Formação"
              path="/formacao"
            />
            <ModuleCard
              icon={Trophy}
              label="Avaliação"
              path="/avaliacao"
            />
          </Section>

          <Section title="Gestão">
            <ModuleCard icon={BarChart3} label="Financeiro" path="/financeiro" />
            <ModuleCard icon={Wrench} label="Operações" path="/operacoes-dashboard" />
            <ModuleCard icon={Megaphone} label="Marketing" path="/marketing-dashboard" />
            <ModuleCard
              icon={MessageSquareWarning}
              label="Suporte"
              path="/suporte-dashboard"
              alertCount={complaintStats?.overdue}
            />
          </Section>

          <Section title="Suporte & Qualidade">
            <ModuleCard
              icon={MessageSquareWarning}
              label="Reclamações"
              path="/reclamacoes"
              count={complaintStats?.total}
            />
            <ModuleCard
              icon={Star}
              label="Críticas Google"
              path="/criticas"
              value={reviewStats?.avg != null ? `${Number(reviewStats.avg).toFixed(1)}★` : undefined}
            />
            <ModuleCard
              icon={AlertTriangle}
              label="Ocorrências"
              path="/ocorrencias"
            />
            <ModuleCard
              icon={Package}
              label="Perdidos e Achados"
              path="/perdidos-achados"
            />
          </Section>

          <Section title="Financeiro">
            <ModuleCard icon={Receipt} label="Despesas" path="/despesas" />
            <ModuleCard icon={FileText} label="Faturação" path="/faturacao" />
            <ModuleCard icon={Handshake} label="Parcerias" path="/parcerias" />
            <ModuleCard icon={ListTodo} label="Tarefas" path="/tarefas" />
          </Section>
        </div>
      )}

      {tab === "resumo" && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Reservas hoje" value={fmtNum(movimentar)} />
          <StatCard label="Check-ins hoje" value={fmtNum(recolhas)} tone="success" />
          <StatCard label="Check-outs hoje" value={fmtNum(entregas)} />
          <StatCard label="Despesas mês" value={fmtCurrency(caixa)} tone="warning" />
          <StatCard label="Reclamações" value={fmtNum(complaintStats?.total ?? 0)} tone="danger" />
          <StatCard label="Em atraso" value={fmtNum(complaintStats?.overdue ?? 0)} tone="danger" />
          <StatCard
            label="Média Google"
            value={reviewStats?.avg != null ? `${Number(reviewStats.avg).toFixed(1)}★` : "—"}
          />
          <StatCard label="Colaboradores" value={fmtNum(hrStats?.totalActive ?? 0)} />
        </div>
      )}

      {tab === "historico" && (
        <div className="rounded-2xl border bg-card p-8 text-center text-muted-foreground">
          Histórico de operações disponível em cada módulo.
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant={active ? "default" : "outline"}
      size="sm"
      onClick={onClick}
      className={
        active
          ? "rounded-lg shadow-sm"
          : "rounded-lg bg-card text-foreground"
      }
    >
      {children}
    </Button>
  );
}

