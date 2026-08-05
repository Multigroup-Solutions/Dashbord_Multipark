import { useState, useMemo } from "react";
import { usePersistedState } from "@/hooks/usePersistedState";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  LayoutDashboard, CalendarCheck, ArrowDownToLine, ArrowUpFromLine,
  XCircle, Wrench, Euro, Activity, MapPin, Building2, PieChart as PieIcon,
} from "lucide-react";
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend } from "recharts";
import { QuickRangeBar, thisMonthRange, previousPeriod } from "@/components/QuickRangeBar";
import MultiparkPage from "./MultiparkPage";
import ServicesPage from "./ServicesPage";

const PIE_COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16", "#f97316", "#14b8a6"];

function aggBy(bookings: any[], key: "city" | "parkName", topN = 8): Array<{ name: string; value: number }> {
  const m = new Map<string, number>();
  for (const b of bookings) {
    const raw = (b?.[key] ?? "").toString().trim();
    const name = raw || "Desconhecido";
    m.set(name, (m.get(name) ?? 0) + 1);
  }
  const arr = [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  if (arr.length <= topN) return arr;
  const top = arr.slice(0, topN);
  const rest = arr.slice(topN).reduce((s, x) => s + x.value, 0);
  if (rest > 0) top.push({ name: "Outros", value: rest });
  return top;
}

function MiniPie({ title, icon, data }: { title: string; icon?: React.ReactNode; data: Array<{ name: string; value: number }> }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-sm flex items-center gap-2">{icon}{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-12">Sem dados</p>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="45%" outerRadius={70}>
                {data.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
              </Pie>
              <Tooltip formatter={(v: any, n: any) => [`${v} (${total > 0 ? ((Number(v) / total) * 100).toFixed(0) : 0}%)`, n]} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
            </PieChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

const fmtEur = (v: number | string | null | undefined) => {
  const n = typeof v === "string" ? parseFloat(v) : (v ?? 0);
  return n.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
};

export default function OperacoesPage() {
  // A aba ativa persiste à navegação — voltar às Operações mantém onde estavas
  const [tab, setTab] = usePersistedState("operacoes.tab", "dashboard");
  return (
    <div className="p-4 md:p-6 space-y-6 max-w-[1400px] mx-auto">
      <div>
        <p className="text-sm text-muted-foreground">
          Reservas, recolhas, entregas, cancelamentos e serviços extras
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="dashboard"><LayoutDashboard className="w-4 h-4 mr-1" />Dashboard</TabsTrigger>
          <TabsTrigger value="reservas"><CalendarCheck className="w-4 h-4 mr-1" />Reservas</TabsTrigger>
          <TabsTrigger value="entradas"><ArrowDownToLine className="w-4 h-4 mr-1" />Recolhas</TabsTrigger>
          <TabsTrigger value="saidas"><ArrowUpFromLine className="w-4 h-4 mr-1" />Entregas</TabsTrigger>
          <TabsTrigger value="cancelados"><XCircle className="w-4 h-4 mr-1" />Cancelados</TabsTrigger>
          <TabsTrigger value="servicos"><Wrench className="w-4 h-4 mr-1" />Serviços</TabsTrigger>
        </TabsList>

        <TabsContent value="dashboard" className="mt-4">
          <OperacoesDashboard onJump={setTab} />
        </TabsContent>
        <TabsContent value="reservas" className="mt-4">
          <MultiparkPage sectionProp="reservas" />
        </TabsContent>
        <TabsContent value="entradas" className="mt-4">
          <MultiparkPage sectionProp="entradas" />
        </TabsContent>
        <TabsContent value="saidas" className="mt-4">
          <MultiparkPage sectionProp="saidas" />
        </TabsContent>
        <TabsContent value="cancelados" className="mt-4">
          <MultiparkPage sectionProp="cancelados" />
        </TabsContent>
        <TabsContent value="servicos" className="mt-4">
          <ServicesPage />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Dashboard simples ───────────────────────────────────────────────────────

function OperacoesDashboard({ onJump }: { onJump: (tab: string) => void }) {
  const [defFrom, defTo] = thisMonthRange();
  const [from, setFrom] = useState(defFrom);
  const [to, setTo] = useState(defTo);
  const [activeRange, setActiveRange] = useState<string>("thisMonth");
  const [compare, setCompare] = useState(false);
  const [dim, setDim] = useState<"city" | "parkName">("city");

  const opts = { refetchOnWindowFocus: false } as const;
  const queries = {
    creation: trpc.multipark.localBookingsByAction.useQuery({ startDate: from, endDate: to, actionType: "creation" as const }, opts),
    checkin: trpc.multipark.localBookingsByAction.useQuery({ startDate: from, endDate: to, actionType: "checkin" as const }, opts),
    checkout: trpc.multipark.localBookingsByAction.useQuery({ startDate: from, endDate: to, actionType: "checkout" as const }, opts),
    cancelation: trpc.multipark.localBookingsByAction.useQuery({ startDate: from, endDate: to, actionType: "cancelation" as const }, opts),
  };

  // Período anterior (mesma duração) — só corre quando "comparar" está ligado
  const [pf, pt] = previousPeriod(from, to);
  const prevOpts = { refetchOnWindowFocus: false, enabled: compare } as const;
  const prev = {
    creation: trpc.multipark.localBookingsByAction.useQuery({ startDate: pf, endDate: pt, actionType: "creation" as const }, prevOpts),
    checkin: trpc.multipark.localBookingsByAction.useQuery({ startDate: pf, endDate: pt, actionType: "checkin" as const }, prevOpts),
    checkout: trpc.multipark.localBookingsByAction.useQuery({ startDate: pf, endDate: pt, actionType: "checkout" as const }, prevOpts),
    cancelation: trpc.multipark.localBookingsByAction.useQuery({ startDate: pf, endDate: pt, actionType: "cancelation" as const }, prevOpts),
  };

  const reservas = queries.creation.data?.bookings ?? [];
  const recolhas = queries.checkin.data?.bookings ?? [];
  const entregas = queries.checkout.data?.bookings ?? [];
  const cancelados = queries.cancelation.data?.bookings ?? [];

  const stats = useMemo(() => {
    const sum = (b: any[]) => b.reduce((s, x) => s + (parseFloat(x.totalPrice) || 0), 0);
    return {
      reservas: reservas.length, reservasReceita: sum(reservas),
      recolhas: recolhas.length,
      entregas: entregas.length, entregasReceita: sum(entregas),
      cancelados: cancelados.length, canceladosReceita: sum(cancelados),
    };
  }, [reservas, recolhas, entregas, cancelados]);

  const prevStats = useMemo(() => ({
    reservas: prev.creation.data?.bookings?.length ?? 0,
    recolhas: prev.checkin.data?.bookings?.length ?? 0,
    entregas: prev.checkout.data?.bookings?.length ?? 0,
    cancelados: prev.cancelation.data?.bookings?.length ?? 0,
  }), [prev.creation.data, prev.checkin.data, prev.checkout.data, prev.cancelation.data]);

  const pies = useMemo(() => ({
    reservas: aggBy(reservas, dim),
    recolhas: aggBy(recolhas, dim),
    entregas: aggBy(entregas, dim),
  }), [reservas, recolhas, entregas, dim]);

  const isLoading = queries.creation.isLoading || queries.checkin.isLoading || queries.checkout.isLoading || queries.cancelation.isLoading;
  const dimLabel = dim === "city" ? "cidade" : "parque";

  return (
    <div className="space-y-6">
      {/* Filtros */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <QuickRangeBar
            active={activeRange}
            onPick={(f, t, id) => { setFrom(f); setTo(t); setActiveRange(id); }}
          />
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label className="text-xs mb-1 block">De</Label>
              <Input type="date" value={from} onChange={e => { setFrom(e.target.value); setActiveRange(""); }} className="w-40" />
            </div>
            <div>
              <Label className="text-xs mb-1 block">Até</Label>
              <Input type="date" value={to} onChange={e => { setTo(e.target.value); setActiveRange(""); }} className="w-40" />
            </div>
            <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none ml-1 mb-2">
              <input type="checkbox" checked={compare} onChange={e => setCompare(e.target.checked)} />
              Comparar com período anterior
            </label>
            <div className="text-xs text-muted-foreground ml-auto mb-2">
              {isLoading ? "A carregar..." : `${from} → ${to}`}
              {compare && <span className="block">vs {pf} → {pt}</span>}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* KPIs clicáveis */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          icon={<CalendarCheck className="w-5 h-5 text-blue-600" />}
          label="Reservas criadas"
          value={stats.reservas}
          extra={fmtEur(stats.reservasReceita)}
          compareValue={compare ? prevStats.reservas : undefined}
          onClick={() => onJump("reservas")}
        />
        <KpiCard
          icon={<ArrowDownToLine className="w-5 h-5 text-emerald-600" />}
          label="Recolhas"
          value={stats.recolhas}
          compareValue={compare ? prevStats.recolhas : undefined}
          onClick={() => onJump("entradas")}
        />
        <KpiCard
          icon={<ArrowUpFromLine className="w-5 h-5 text-amber-600" />}
          label="Entregas"
          value={stats.entregas}
          extra={fmtEur(stats.entregasReceita)}
          compareValue={compare ? prevStats.entregas : undefined}
          onClick={() => onJump("saidas")}
        />
        <KpiCard
          icon={<XCircle className="w-5 h-5 text-red-600" />}
          label="Cancelados"
          value={stats.cancelados}
          extra={fmtEur(stats.canceladosReceita)}
          compareValue={compare ? prevStats.cancelados : undefined}
          invertDelta
          onClick={() => onJump("cancelados")}
        />
      </div>

      {/* Ratios */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Receita média / entrega</p>
            <p className="text-xl font-bold text-emerald-700">
              {stats.entregas > 0 ? fmtEur(stats.entregasReceita / stats.entregas) : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Taxa de cancelamento</p>
            <p className="text-xl font-bold text-red-700">
              {stats.reservas > 0 ? `${((stats.cancelados / stats.reservas) * 100).toFixed(1)}%` : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Conversão recolha → entrega</p>
            <p className="text-xl font-bold text-blue-700">
              {stats.recolhas > 0 ? `${((stats.entregas / stats.recolhas) * 100).toFixed(1)}%` : "—"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Gráficos por cidade / parque */}
      <div className="space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm font-medium flex items-center gap-2">
            <PieIcon className="w-4 h-4" /> Distribuição por {dimLabel}
          </p>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => setDim("city")}
              className={"text-xs px-2.5 py-1 rounded border transition-colors flex items-center gap-1 " + (dim === "city" ? "bg-primary text-primary-foreground border-primary" : "bg-muted/40 hover:bg-muted")}
            >
              <MapPin className="w-3 h-3" /> Cidade
            </button>
            <button
              type="button"
              onClick={() => setDim("parkName")}
              className={"text-xs px-2.5 py-1 rounded border transition-colors flex items-center gap-1 " + (dim === "parkName" ? "bg-primary text-primary-foreground border-primary" : "bg-muted/40 hover:bg-muted")}
            >
              <Building2 className="w-3 h-3" /> Parque
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <MiniPie title={`Reservas por ${dimLabel}`} icon={<CalendarCheck className="w-3.5 h-3.5 text-blue-600" />} data={pies.reservas} />
          <MiniPie title={`Recolhas por ${dimLabel}`} icon={<ArrowDownToLine className="w-3.5 h-3.5 text-emerald-600" />} data={pies.recolhas} />
          <MiniPie title={`Entregas por ${dimLabel}`} icon={<ArrowUpFromLine className="w-3.5 h-3.5 text-amber-600" />} data={pies.entregas} />
        </div>
      </div>

      <p className="text-xs text-muted-foreground flex items-center gap-1">
        <Activity className="w-3 h-3" />
        Clica num cartão para ir directo à tabela da secção
      </p>
    </div>
  );
}

function KpiCard({
  icon, label, value, extra, onClick, compareValue, invertDelta,
}: { icon: React.ReactNode; label: string; value: number; extra?: string; onClick?: () => void; compareValue?: number; invertDelta?: boolean }) {
  const delta = compareValue != null ? value - compareValue : null;
  const pct = compareValue != null && compareValue > 0 ? (delta! / compareValue) * 100 : null;
  // Para cancelados, subir é mau (invertDelta) → cor invertida.
  const positive = delta == null ? false : (invertDelta ? delta < 0 : delta > 0);
  const negative = delta == null ? false : (invertDelta ? delta > 0 : delta < 0);
  return (
    <Card
      className={onClick ? "cursor-pointer hover:shadow-md transition-shadow" : ""}
      onClick={onClick}
    >
      <CardContent className="p-4 flex items-center gap-3">
        <div className="p-2 rounded-lg bg-muted">{icon}</div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground truncate">{label}</p>
          <p className="text-2xl font-bold">{value}</p>
          {extra && <p className="text-xs text-muted-foreground truncate"><Euro className="w-3 h-3 inline" /> {extra}</p>}
          {delta != null && (
            <p className={"text-[11px] font-medium " + (positive ? "text-emerald-600" : negative ? "text-red-600" : "text-muted-foreground")}>
              {delta >= 0 ? "+" : ""}{delta}{pct != null && <> ({delta >= 0 ? "+" : ""}{pct.toFixed(0)}%)</>} <span className="text-muted-foreground font-normal">vs ant.</span>
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
