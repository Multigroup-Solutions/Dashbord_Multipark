/**
 * Dashboard de Marketing (Jorge, 24 set 2026): os indicadores que o servidor
 * já calculava (marketing.dashboard → server/integrations/googleAds/marketingStats)
 * e que não se viam em lado nenhum, mais a QUALIDADE DA ATRIBUIÇÃO — se o gclid
 * não chega às reservas, o "via anúncios" e o ROAS real ficam a zero e enganam.
 *
 * Regras (as mesmas do servidor):
 *  - Gasto = custo importado do Google Ads e da Meta (separados + total);
 *    nunca orçamento.
 *  - Reservas pela data de criação (dias de Lisboa), sem canceladas — a regra
 *    das Reservas & Operações; "via anúncios" só com prova no link de origem
 *    (gclid/fbclid/utm pago).
 *  - ROAS s/ IVA (receita ÷ 1,23 ÷ gasto) ≠ ROAS que a Google reporta (valor
 *    de conversão / gasto) — mostram-se lado a lado, com rótulos distintos.
 */
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import DateRangeNav from "@/components/DateRangeNav";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, CircleAlert, Euro, MousePointerClick, Receipt, RotateCcw, ShoppingCart, Target, TrendingUp, X } from "lucide-react";
import { usePersistedState } from "@/hooks/usePersistedState";
import { marketingAlertKey, splitHiddenAlerts } from "@shared/marketingAlerts";
import { attributionHealth, type AttributionQuality } from "@shared/marketingAttribution";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { STICKY_FIRST_COL } from "@/components/finance/layoutClasses";
import FitAmount from "@/components/finance/FitAmount";
import { eurAxis, eurCompact } from "@/lib/financeFormat";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { useAuth } from "@/_core/hooks/useAuth";
import { can } from "@shared/access";
import { MARKETPLACE_NOT_OPERATED_LABEL, MARKETPLACE_OPERATED_LABEL } from "@shared/marketplace";

function lisbonDay(d = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}
const eur = (v: number | null | undefined, digits = 0) =>
  v == null ? "—" : v.toLocaleString("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: digits, minimumFractionDigits: digits });
const num = (v: number | null | undefined) => (v == null ? "—" : Number(v).toLocaleString("pt-PT"));
const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—");
/** 8 out 2026: quantas ficaram fora do via net ("": nenhuma). */
const viaNetOutText = (x: { pending?: number; pro?: number; plan?: number } | null | undefined) => {
  const parts = [x?.pending ? `${x.pending} pendente(s)` : "", x?.pro ? `${x.pro} Pro` : "", x?.plan ? `${x.plan} de avença` : ""].filter(Boolean);
  return parts.length ? `: ${parts.join(", ")} fora` : "";
};
const roas = (v: number | null | undefined) => (v == null ? "—" : `${v.toFixed(2).replace(".", ",")}×`);
const shortDay = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const fmtDay = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** Todos os dias do intervalo (os que não têm dados ficam a zero, não desaparecem). */
function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (d <= end && out.length < 400) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

// Paleta validada (dataviz/validate_palette.js): claro #0055d2/#16a34a, escuro #4f8aec/#16a34a.
// + laranja para as conversões Google; "ligadas" a tracejado (codificação secundária — verde/laranja ficam perto para deuteranopia).
const SERIES = "[--mk-1:#0055d2] [--mk-2:#16a34a] [--mk-3:#c2410c] dark:[--mk-1:#4f8aec] dark:[--mk-3:#ea580c]";
const AXIS = { fontSize: 11, fill: "var(--muted-foreground)" };
const TOOLTIP_STYLE = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--card-foreground)" };

function Kpi({ icon: Icon, label, value, compact, hint, warn }: { icon: any; label: string; value: string; compact?: string; hint?: string; warn?: boolean }) {
  return (
    <div className="rounded-xl border bg-card p-3 min-w-0">
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className="w-3.5 h-3.5 shrink-0" /> {label}</div>
      <FitAmount full={value} compact={compact ?? value} className="text-xl sm:text-2xl font-bold mt-1" />
      {hint && <div className={`text-[11px] mt-0.5 ${warn ? "text-amber-700 dark:text-amber-400 flex items-center gap-1" : "text-muted-foreground"}`}>{warn && <AlertTriangle className="w-3 h-3 shrink-0" />}{hint}</div>}
    </div>
  );
}

export default function MarketingDashboardPanel() {
  const today = lisbonDay();
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [showTable, setShowTable] = useState(false);
  const { projectId } = useGlobalFilters();
  const dashQ = trpc.marketing.dashboard.useQuery({ from, to, projectId });
  const { data, isLoading, error } = dashQ;
  const alertsQ = trpc.marketing.alerts.useQuery({ projectId });
  const alertsData = alertsQ.data;
  const st: any = data;
  /** 19a: reservas da Multipark indisponíveis → "—" e aviso (nunca 0) */
  const noBookings = !!st?.bookingsError;

  const series = useMemo(() => {
    if (!st) return [];
    const spend = new Map<string, number>((st.byDay ?? []).map((d: any) => [d.date, Number(d.cost ?? 0)]));
    const conv = new Map<string, number>((st.byDay ?? []).map((d: any) => [d.date, Number(d.conversions ?? 0)]));
    const books = new Map<string, { total: number; attributed: number }>((st.bookingsByDay ?? []).map((d: any) => [d.date, d]));
    return daysBetween(from, to).map((day) => ({
      day, label: shortDay(day),
      spend: spend.get(day) ?? 0,
      bookings: books.get(day)?.total ?? 0,
      viaAds: books.get(day)?.attributed ?? 0,
      conversions: Math.round((conv.get(day) ?? 0) * 10) / 10,
    }));
  }, [st, from, to]);

  const q: AttributionQuality = st?.attributionQuality ?? { siteBookings: 0, withOriginUrl: 0, withClickId: 0, attributed: 0 };
  const hasAttribution = !!st?.attributionQuality;
  const health = attributionHealth(q, st?.spend ?? 0, st?.conversionsGoogle ?? null);
  // 28c (Jorge, 6 out): as duas medidas lado a lado — conversões que as plataformas contam (Google + Meta) e reservas reais "via net" (tudo o que não é parceiro).
  const platformConversions = st?.conversionsPlatforms ?? st?.conversionsGoogle ?? 0;
  const HealthIcon = health.level === "ok" ? CheckCircle2 : health.level === "critical" ? CircleAlert : AlertTriangle;
  const healthCls = health.level === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200"
    : health.level === "critical" ? "border-rose-200 bg-rose-50 text-rose-900 dark:bg-rose-950/30 dark:text-rose-200"
    : health.level === "warning" ? "border-amber-200 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
    : "border-muted bg-muted/40 text-muted-foreground";
  const healthLabel = health.level === "ok" ? "Atribuição a funcionar" : health.level === "critical" ? "Atribuição partida" : health.level === "warning" ? "Atribuição incompleta" : "Sem dados";
  const totalMarketing = (st?.spend ?? 0) + (st?.mktExpenses ?? 0);
  // Meta sem dados no período: avisa desde quando (nunca mostrar 0 € como se fosse real)
  const metaWarning: string | null = st && !st.meta?.hasDataInPeriod
    ? (st.meta?.lastDataDay ? `Sem dados Meta desde ${fmtDay(st.meta.lastDataDay)}` : "Sem dados Meta (integração por configurar)")
    : null;

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <p className="text-xs text-muted-foreground max-w-2xl">
          Gasto do Google Ads e da Meta (APIs) e reservas reais da Multipark pela data de criação (dias de Lisboa), sem canceladas. "Via anúncios" só conta reservas com prova no link de origem (gclid/fbclid/utm pago).
          O detalhe por marca e campanha está no separador <Link href="/marketing/google-ads" className="underline">Anúncios</Link>.
        </p>
        <DateRangeNav start={from} end={to} gran="month" showAll={false} onChange={(s, e) => { setFrom(s); setTo(e); }} />
      </div>

      {/* Jorge (7 out 2026): os alertas ficam de lado, pequenos e dispensáveis, como nas Reservas (no telemóvel, por cima e encolhíveis) */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
      <aside className="order-first min-w-0 lg:order-last lg:sticky lg:top-4">
        {alertsQ.error
          ? <QueryErrorNote error={alertsQ.error} onRetry={() => alertsQ.refetch()} retrying={alertsQ.isFetching} what="os alertas do marketing" />
          : <AlertsCard alerts={alertsData?.alerts} windowFrom={alertsData?.windowFrom} projectId={projectId} hiddenMap={alertsData?.hidden} hiddenError={alertsData?.hiddenError} month={alertsData?.month} />}
      </aside>
      <div className="min-w-0 space-y-4">
      {error && <QueryErrorNote error={error} onRetry={() => dashQ.refetch()} retrying={dashQ.isFetching} what="o dashboard de marketing" />}
      {isLoading && <div className="flex justify-center py-12"><div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" /></div>}

      {st && (
        <>
          {noBookings && (
            <div className="rounded-md border border-amber-200 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200 px-3 py-2 text-xs flex items-start gap-2" role="status">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span><b>Reservas da Multipark indisponíveis</b> — a base de dados da Multipark não respondeu. O gasto está completo; reservas, ROAS e custo por reserva aparecem como "—" até voltar. <button type="button" className="underline font-medium" onClick={() => dashQ.refetch()}>Tentar de novo</button></span>
            </div>
          )}
          {st.coverage && st.coverage.status !== "ok" && (
            <div className="rounded-md border border-amber-200 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200 px-3 py-2 text-xs" role="status">
              {st.coverage.status === "none" ? "Sem dados de anúncios no período." : st.coverage.status === "partial" ? `Dados de anúncios incompletos: ${st.coverage.missingDays} dia(s) sem recolha.` : "A recolha do Google Ads está parada há mais de um dia."}
              {" "}Última recolha: {st.coverage.lastSuccessfulSyncAt ? fmtPTDateTime(st.coverage.lastSuccessfulSyncAt) : "nunca"}.
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Kpi icon={Euro} label="Gasto Google Ads" value={eur(st.spendGoogle)} compact={eurCompact(st.spendGoogle)} hint={`${num(st.clicks)} cliques (todas as plataformas) · CPC ${eur(st.cpc, 2)}`} />
            <Kpi icon={Euro} label="Gasto Meta" value={eur(st.spendMeta)} compact={eurCompact(st.spendMeta)}
              hint={metaWarning ?? (st.spendOther > 0 ? `+ ${eur(st.spendOther)} de outras plataformas (importações antigas)` : "Facebook + Instagram")} warn={!!metaWarning} />
            <Kpi icon={Euro} label="Gasto total em anúncios" value={eur(st.spend)} compact={eurCompact(st.spend)} hint={st.budgetEstimate > 0 ? `orçamento Google × dias: ${eur(st.budgetEstimate)} (indicador, não gasto)` : "Google + Meta + outros"} />
            <Kpi icon={MousePointerClick} label="Conversões (Google + Meta)" value={num(Math.round(platformConversions))}
              hint={`contadas pelas plataformas · Google ${num(Math.round(st.conversionsGoogle ?? 0))} · Meta ${num(Math.round(st.conversionsMeta ?? 0))}`} />
            <Kpi icon={Target} label="Custo por conversão" value={eur(st.costPerConversionPlatforms, 2)}
              hint={noBookings ? "gasto ÷ conversões das plataformas · reservas indisponíveis" : `por reserva via net: ${eur(st.costPerWebBooking, 2)} · por reserva ligada: ${eur(st.costPerAttributedBooking, 2)}`} />
            <Kpi icon={ShoppingCart} label="Reservas via net" value={num(st.bookingsWeb)} warn={noBookings}
              hint={noBookings ? "indisponíveis (BD da Multipark)" : `tudo o que não é parceiro (sem pendentes, Pro nem avenças${viaNetOutText(st.viaNetExcluded)}) · ${eur(st.revenueWeb)} (terceiros pela nossa comissão) · com link de origem ${num(st.webWithLink)} (${pct(st.webWithLink, st.bookingsWeb)}) · ligadas aos anúncios ${num(st.bookingsAttributed)}`} />
            <Kpi icon={TrendingUp} label="ROAS (s/ IVA)" value={roas(st.roasAttributedNet)}
              hint={`reservas ligadas, receita sem IVA ÷ gasto · todas as reservas: ${roas(st.roasTotalNet)}`} />
            <Kpi icon={TrendingUp} label="ROAS Google (reportado)" value={roas(st.roasGoogle)} hint="valor de conversão que a Google reporta ÷ gasto do Google Ads" />
            <Kpi icon={Receipt} label="Outras despesas de marketing" value={eur(st.mktExpenses)} compact={eurCompact(st.mktExpenses)}
              hint={st.adInvoicesInExpenses > 0 ? `Despesas «Marketing» sem ${eur(st.adInvoicesInExpenses)} de faturas Google/Meta (já contam no gasto)` : "Despesas da categoria «Marketing» (sem faturas Google/Meta)"} />
            <Kpi icon={Euro} label="Custo total de marketing" value={eur(totalMarketing)} compact={eurCompact(totalMarketing)} hint={noBookings ? "anúncios + outras despesas · reservas indisponíveis" : `anúncios + outras despesas · ${eur(st.bookingsTotal > 0 ? totalMarketing / st.bookingsTotal : null, 2)} por reserva (todas)`} />
            <Kpi icon={ShoppingCart} label="Reservas" value={num(st.bookingsTotal)} hint={noBookings ? "indisponíveis (BD da Multipark)" : `todas as origens · ${num(st.bookingsGoogle)} Google · ${num(st.bookingsMeta)} Meta (ligadas)`} warn={noBookings} />
            <Kpi icon={ShoppingCart} label="Valor das reservas" value={eur(st.revenueTotal)} compact={st.revenueTotal == null ? "—" : eurCompact(st.revenueTotal)} hint="todas, c/ IVA, pela data de criação" />
          </div>
          {/* 8 out 2026: todas as reservas do Marketplace, de qualquer parque, com a etiqueta operado / não operado */}
          {!noBookings && st.marketplace && st.marketplace.bookings > 0 && (
            <p className="text-xs text-muted-foreground" role="status">
              <b>Marketplace</b> (todos os parques): {num(st.marketplace.bookings)} reserva(s), {eur(st.marketplace.revenue)} —{" "}
              {MARKETPLACE_OPERATED_LABEL.toLowerCase()} {num(st.marketplace.operated.bookings)}, {MARKETPLACE_NOT_OPERATED_LABEL.toLowerCase()} {num(st.marketplace.notOperated.bookings)}
              {st.marketplace.withoutCity.bookings > 0 && <> · <span className="text-amber-700 dark:text-amber-400">{num(st.marketplace.withoutCity.bookings)} de parques sem cidade (aviso em Anúncios)</span></>}.
            </p>
          )}

          {hasAttribution && <div className={`rounded-md border px-3 py-2.5 text-sm space-y-1.5 ${healthCls}`} role="status">
            <div className="flex items-center gap-2 font-medium"><HealthIcon className="w-4 h-4" /> {healthLabel}</div>
            <p className="text-xs">{health.message}</p>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs tabular-nums">
              <span>Reservas feitas no site: <b>{num(q.siteBookings)}</b></span>
              <span>com link de origem: <b>{num(q.withOriginUrl)}</b> ({pct(q.withOriginUrl, q.siteBookings)})</span>
              <span>com clique do Google (gclid): <b>{num(q.withClickId)}</b> ({pct(q.withClickId, q.siteBookings)})</span>
              <span>atribuídas aos anúncios: <b>{num(q.attributed)}</b> ({pct(q.attributed, q.siteBookings)})</span>
              <span>conversões contadas pela Google: <b>{num(Math.round(st.conversionsGoogle ?? 0))}</b> — ligámos {pct(q.attributed, Math.round(st.conversionsGoogle ?? 0))}</span>
            </div>
          </div>}

          <div className={`grid grid-cols-1 lg:grid-cols-2 gap-4 ${SERIES}`}>
            <Card>
              <CardHeader className="pb-1"><CardTitle className="text-sm">Gasto em anúncios por dia</CardTitle></CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={series} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--border)" />
                    <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
                    <YAxis tick={AXIS} tickLine={false} axisLine={false} width={64} tickFormatter={eurAxis} />
                    <Tooltip cursor={{ fill: "var(--muted)" }} contentStyle={TOOLTIP_STYLE} formatter={(v: any) => [eur(Number(v), 2), "Gasto"]} />
                    <Bar dataKey="spend" name="Gasto" fill="var(--mk-1)" radius={[4, 4, 0, 0]} maxBarSize={24} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1"><CardTitle className="text-sm">Reservas e conversões por dia</CardTitle></CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--border)" />
                    <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
                    <YAxis tick={AXIS} tickLine={false} axisLine={false} width={36} allowDecimals={false} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: "var(--card-foreground)" }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span className="text-foreground">{v}</span>} />
                    <Line type="monotone" dataKey="bookings" name="Todas" stroke="var(--mk-1)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                    <Line type="monotone" dataKey="conversions" name="Conversões Google" stroke="var(--mk-3)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                    <Line type="monotone" dataKey="viaAds" name="Ligadas por nós (gclid)" stroke="var(--mk-2)" strokeWidth={2} strokeDasharray="5 3" dot={false} activeDot={{ r: 4 }} />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>

          <div>
            <Button variant="ghost" size="sm" onClick={() => setShowTable((v) => !v)}>{showTable ? "Esconder tabela" : "Ver os números por dia"}</Button>
            {showTable && (
              <Card className="mt-2">
                <CardContent className="p-0 overflow-x-auto">
                  <Table className={`tabular-nums ${STICKY_FIRST_COL}`}>
                    <TableHeader>
                      <TableRow><TableHead>Dia</TableHead><TableHead className="text-right">Gasto</TableHead><TableHead className="text-right">Reservas</TableHead><TableHead className="text-right">Conversões Google</TableHead><TableHead className="text-right">Ligadas (gclid)</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {series.map((r) => (
                        <TableRow key={r.day}>
                          <TableCell className="text-sm">{r.label}</TableCell>
                          <TableCell className="text-right tabular-nums">{eur(r.spend, 2)}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.bookings}</TableCell>
                          <TableCell className="text-right tabular-nums">{num(r.conversions)}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.viaAds}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}
          </div>
        </>
      )}
      </div>
      </div>
    </div>
  );
}

/**
 * Alertas (independentes do período escolhido: últimos 14 dias e mês corrente). Nunca só cor: ícone + texto.
 * Jorge (7 out 2026, "põe de lado como o outro"): de lado, pequenos, encolhem com um clique e cada um sai da
 * lista com o X até ao fim do mês (volta em "Tirados → Repor"), como os das Reservas — e, como lá, para
 * TODA a gente (Jorge, 7 out 2026: "pode ser para todos"); fica guardado no servidor com quem e quando.
 */
const ALERTS_PAGE = 4;
export function AlertsCard({ alerts, windowFrom, projectId, hiddenMap: serverHidden, hiddenError, month: serverMonth }: {
  alerts?: Array<{ level: "critical" | "warning"; code: string; key?: string; title: string; detail: string; link?: string; linkLabel?: string; items?: string[] }>;
  windowFrom?: string; projectId?: number; hiddenMap?: Record<string, string>; hiddenError?: string | null; month?: string;
}) {
  const { user } = useAuth();
  // 19b: links para Integrações só para quem as abre (senão era um link morto)
  const canOpenIntegrations = can(user, "integracoes", "view");
  const [collapsed, setCollapsed] = usePersistedState("alerts.marketing.collapsed", false);
  const [all, setAll] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const month = serverMonth ?? lisbonDay().slice(0, 7);
  // Mudança local enquanto o servidor responde (o X sai logo da lista; um erro repõe-no).
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const utils = trpc.useUtils();
  const dismiss = trpc.marketing.dismissAlert.useMutation({
    onSettled: () => { utils.marketing.alerts.invalidate().finally(() => setPending({})); },
    onError: (e) => toast.error(e.message),
  });
  const hiddenMap: Record<string, string> = { ...(serverHidden ?? {}) };
  for (const [k, hide] of Object.entries(pending)) { if (hide) hiddenMap[k] = month; else delete hiddenMap[k]; }
  const setHidden = (key: string, hide: boolean) => {
    setPending((p) => ({ ...p, [key]: hide }));
    dismiss.mutate({ key, projectId, restore: !hide });
  };
  if (!alerts) return null;
  const { shown: list, hidden } = splitHiddenAlerts(alerts, hiddenMap, month);
  if (!list.length && !hidden.length) {
    return (
      <div className="rounded-md border border-emerald-200 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200 px-3 py-2 text-xs flex items-center gap-2" role="status">
        <CheckCircle2 className="w-4 h-4 shrink-0" /> Sem alertas: campanhas com resultados, ritmo do mês normal e todas as campanhas associadas.
      </div>
    );
  }
  const critical = list.filter((a) => a.level === "critical").length;
  const visible = all ? list : list.slice(0, ALERTS_PAGE);
  return (
    <Card className="space-y-2 border-amber-300 bg-amber-50/40 p-3 text-xs dark:bg-amber-950/10">
      <button type="button" className="flex w-full items-center gap-1.5 text-left" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed}>
        {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        <AlertTriangle className="h-3.5 w-3.5 text-amber-700" />
        <span className="text-sm font-semibold">Alertas</span>
        <span className="text-muted-foreground">{list.length}{critical ? ` · ${critical} crítico${critical > 1 ? "s" : ""}` : ""}</span>
      </button>
      {!collapsed && (
        <>
          <ul className="space-y-1.5">
            {visible.map((raw) => {
              const a = raw.link?.startsWith("/integracoes") && !canOpenIntegrations ? { ...raw, link: undefined, linkLabel: undefined } : raw;
              const isCritical = a.level === "critical";
              const Icon = isCritical ? CircleAlert : AlertTriangle;
              const k = marketingAlertKey(a);
              return (
                <li key={k} className="flex gap-1.5 break-words">
                  <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${isCritical ? "text-rose-700" : "text-amber-700"}`} />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium leading-snug"><span className="sr-only">{isCritical ? "Crítico:" : "Atenção:"}</span>
                      {a.link ? <Link href={a.link} className="hover:underline">{a.title}</Link> : a.title}
                    </div>
                    <div className="mt-0.5 leading-snug text-muted-foreground">{a.detail}</div>
                    {a.items && a.items.length > 0 && (
                      <ul className="mt-0.5 list-disc pl-4 text-muted-foreground">{a.items.slice(0, 5).map((it) => <li key={it}>{it}</li>)}{a.items.length > 5 && <li>…e mais {a.items.length - 5}</li>}</ul>
                    )}
                    {a.linkLabel && a.link && <Link href={a.link} className="mt-0.5 inline-flex font-semibold underline">{a.linkLabel}</Link>}
                  </div>
                  <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" title="Tirar da lista para todos até ao fim do mês (volta em Tirados → Repor)"
                    aria-label="Tirar da lista" onClick={() => setHidden(k, true)}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </li>
              );
            })}
            {!list.length && <li className="text-muted-foreground">Sem alertas na lista.</li>}
          </ul>
          <div className="flex flex-wrap items-center gap-1">
            {list.length > ALERTS_PAGE && (
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setAll((v) => !v)}>{all ? "Mostrar menos" : `Ver todos (${list.length})`}</Button>
            )}
            {hidden.length > 0 && (
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => setShowHidden((v) => !v)}>{showHidden ? "Esconder tirados" : `Tirados (${hidden.length})`}</Button>
            )}
          </div>
          {showHidden && hidden.length > 0 && (
            <ul className="space-y-1 border-t pt-1.5">
              {hidden.map((a) => (
                <li key={marketingAlertKey(a)} className="flex items-start gap-1.5 text-muted-foreground">
                  <span className="min-w-0 flex-1 break-words">{a.title}</span>
                  <Button variant="ghost" size="sm" className="h-6 shrink-0 px-1.5 text-xs" onClick={() => setHidden(marketingAlertKey(a), false)}>
                    <RotateCcw className="mr-1 h-3 w-3" />Repor
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {hiddenError && <p className="text-[11px] text-rose-700 dark:text-rose-300" role="alert">Não deu para ler os alertas tirados ({hiddenError}) — aparecem todos.</p>}
          {windowFrom && <p className="text-[11px] text-muted-foreground">Campanhas: últimos 14 dias (desde {windowFrom.slice(8, 10)}/{windowFrom.slice(5, 7)}). Ritmo: mês corrente até ontem vs mês passado.</p>}
        </>
      )}
    </Card>
  );
}
