/**
 * Financeiro → Caixa (29c, Jorge 6 out 2026): "uma coisa é faturação, outra
 * coisa é caixa" — a Caixa saiu dos separadores da Faturação para o seu item
 * no menu, com permissão própria (módulo "caixa"; quem já tinha a Faturação
 * continua a ver). Separadores:
 *   - Por dia (29d): a caixa de cada dia por cidade — recebido por método,
 *     despesas do turno, esperado vs contado, quem entregou e quem fechou, e a
 *     correção do dia (certo / não certo, com motivo);
 *   - Resumo: recebido / por cobrar / no-shows pré-pagos no período;
 *   - Correção de caixa: casos, contagem por parque e dia, multibanco,
 *     externos (Stripe/Viva/InvoiceExpress), preços iniciais e era/é.
 * O alerta "Caixa: casos graves" abre /caixa?tab=correcao&case=N.
 */
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertTriangle, CalendarClock, Receipt, Wallet } from "lucide-react";
import CashCorrectionPanel from "@/components/cashCheck/CashCorrectionPanel";
import CashCasesPanel from "@/components/cashCheck/CashCasesPanel";
import CashCountPanel from "@/components/cashCheck/CashCountPanel";
import CashExternalPanel from "@/components/cashCheck/CashExternalPanel";
import { InitialPricesPanel } from "@/components/cashCheck/InitialPricesPanel";
import CashDayBoard from "@/components/cashCheck/CashDayBoard";
import FitAmount from "@/components/finance/FitAmount";
import { TABS_SCROLL } from "@/components/finance/layoutClasses";
import DateRangeNav, { type DateGran, rangeFor } from "@/components/DateRangeNav";
import { caixaTabFrom, type CaixaTab } from "@shared/caixaTabs";

const fmt = (v: number | string) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(Number.isFinite(n) ? n : 0);
};

/** Repete só falhas passageiras (BD lenta); sem permissão / pedido inválido mostra logo o erro. */
const retryTransient = (count: number, err: unknown) =>
  count < 2 && !["FORBIDDEN", "UNAUTHORIZED", "BAD_REQUEST"].includes(String((err as { data?: { code?: string } })?.data?.code ?? ""));


export default function CaixaPage() {
  const filters = useGlobalFilters();
  const initialMonth = rangeFor("month", new Date());
  const [from, setFrom] = useState(initialMonth.start);
  const [to, setTo] = useState(initialMonth.end);
  const [gran, setGran] = useState<DateGran>("month");
  const [tab, setTab] = useState<CaixaTab>(() => {
    try { return caixaTabFrom(window.location.search); } catch { return "dia"; }
  });
  const projectId = useMemo(() => {
    if (filters.brandId !== null) return filters.brandId;
    if (filters.cityId !== null) return filters.cityId;
    return undefined;
  }, [filters.cityId, filters.brandId]);

  const cashQ = trpc.invoices.cash.useQuery({ from, to, projectId }, { enabled: tab === "resumo", retry: retryTransient });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        O dinheiro que entrou (Multipark, só os parques que operamos) e a correção de caixa. A Faturação (receita, custos e margem) continua no seu item do menu.
      </p>
      <Tabs value={tab} onValueChange={(v) => setTab(v as CaixaTab)} className="space-y-4">
        <TabsList className={TABS_SCROLL}>
          <TabsTrigger value="dia">Por dia</TabsTrigger>
          <TabsTrigger value="resumo">Resumo</TabsTrigger>
          <TabsTrigger value="correcao">Correção de caixa</TabsTrigger>
        </TabsList>

        <TabsContent value="dia" className="space-y-4">
          {tab === "dia" && <CashDayBoard projectId={projectId} />}
        </TabsContent>

        <TabsContent value="resumo" className="space-y-4">
          <DateRangeNav start={from} end={to} gran={gran} onChange={(s, e, g) => { setFrom(s); setTo(e); setGran(g); }} />
          <CashSummary cash={cashQ.data} loading={cashQ.isLoading} error={cashQ.error?.message ?? null} onRetry={() => cashQ.refetch()} busy={cashQ.isFetching} />
        </TabsContent>

        <TabsContent value="correcao" className="space-y-4">
          {tab === "correcao" && (
            <div className="space-y-4">
              <CashCasesPanel projectId={projectId} />
              <CashCountPanel projectId={projectId} />
              <CashExternalPanel projectId={projectId} />
              <InitialPricesPanel projectId={projectId} />
              <CashCorrectionPanel projectId={projectId} />
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Kpi({ icon, label, amount, hint, color }: { icon: React.ReactNode; label: string; amount: number; hint?: string; color?: string }) {
  return (
    <Card className="p-4 gap-0 min-w-0">
      <div className="flex items-center gap-2 mb-1 min-w-0">{icon}<span className="text-xs text-muted-foreground truncate">{label}</span></div>
      <FitAmount value={amount} className={`text-lg sm:text-xl font-bold ${color ?? ""}`} />
      {hint && <p className="text-[11px] text-muted-foreground mt-1 break-words">{hint}</p>}
    </Card>
  );
}

function LoadError({ message, onRetry, busy }: { message: string; onRetry: () => void; busy?: boolean }) {
  return (
    <Card className="p-4 border-red-200 bg-red-50/50">
      <div className="flex items-start gap-2 text-sm text-red-800">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
        <div className="min-w-0">
          <p className="font-medium">Não foi possível carregar a caixa.</p>
          <p className="text-xs mt-0.5 break-words">{message}</p>
          <button type="button" onClick={onRetry} disabled={busy} className="mt-2 text-xs px-2.5 py-1 rounded border bg-background hover:bg-muted disabled:opacity-60">
            {busy ? "A tentar…" : "Tentar de novo"}
          </button>
        </div>
      </div>
    </Card>
  );
}

/** Caixa: o dinheiro (recebido / por cobrar / no-shows pré-pagos). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CashSummary({ cash, loading, error, onRetry, busy }: { cash: any; loading: boolean; error: string | null; onRetry: () => void; busy?: boolean }) {
  if (error && !cash) return <LoadError message={error} onRetry={onRetry} busy={busy} />;
  if (loading || !cash) return <p className="text-sm text-muted-foreground text-center py-6">A carregar…</p>;
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <Kpi icon={<Wallet className="w-4 h-4 text-emerald-600" />} label="Recebido" amount={cash.received.total} hint={`${cash.received.count} reservas entregues · data: ${cash.dateBasis}`} color="text-emerald-700" />
        <Kpi icon={<Receipt className="w-4 h-4 text-orange-600" />} label="Por cobrar" amount={cash.toCollect.total} hint={`${cash.toCollect.count} reservas entregues com valor em falta`} color="text-orange-700" />
        <Kpi icon={<CalendarClock className="w-4 h-4 text-sky-600" />} label="No-shows pré-pagos" amount={cash.prepaidNoShows.total} hint={`${cash.prepaidNoShows.count} reservas pagas com check-in passado que nunca entraram`} color="text-sky-700" />
        <Kpi icon={<AlertTriangle className="w-4 h-4 text-muted-foreground" />} label="Canceladas com pagamento" amount={cash.cancelledPaid.total} hint={`${cash.cancelledPaid.count} canceladas no período — informativo, NÃO é receita (sem dados de taxa/reembolso)`} />
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">Recebido por método de pagamento</CardTitle></CardHeader>
        <CardContent>
          {cash.received.byMethod.length === 0 ? <p className="text-sm text-muted-foreground text-center py-4">Sem recebimentos no período</p> : (
            <div className="space-y-1">
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              {cash.received.byMethod.map((m: any) => (
                <div key={m.method} className="flex justify-between gap-3 text-sm py-1 border-b last:border-0"><span className="min-w-0 break-words">{m.method} <span className="text-xs text-muted-foreground">({m.count})</span></span><span className="tabular-nums font-medium shrink-0">{fmt(m.total)}</span></div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <p className="text-[11px] text-muted-foreground">
        Dados que faltam na sincronização Multipark: {cash.missing.join(" · ")}. As taxas de cancelamento só entram como receita quando existirem na base de dados.
      </p>
    </>
  );
}
