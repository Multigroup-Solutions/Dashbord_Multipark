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
import { trpc } from "@/lib/trpc";
import DateRangeNav from "@/components/DateRangeNav";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCircle2, CircleAlert, Euro, MousePointerClick, Receipt, ShoppingCart, Target, TrendingUp } from "lucide-react";
import { adResultsMeasure, attributionHealth, type AttributionQuality } from "@shared/marketingAttribution";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { STICKY_FIRST_COL } from "@/components/finance/layoutClasses";
import FitAmount from "@/components/finance/FitAmount";
import { eurAxis, eurCompact } from "@/lib/financeFormat";

function lisbonDay(d = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}
const eur = (v: number | null | undefined, digits = 0) =>
  v == null ? "—" : v.toLocaleString("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: digits, minimumFractionDigits: digits });
const num = (v: number | null | undefined) => (v == null ? "—" : Number(v).toLocaleString("pt-PT"));
const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—");
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
  const { data, isLoading, error } = trpc.marketing.dashboard.useQuery({ from, to, projectId });
  const { data: alertsData } = trpc.marketing.alerts.useQuery({ projectId });
  const st: any = data;

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
  const health = attributionHealth(q, st?.spend ?? 0, st?.conversionsGoogle ?? null);
  // Resultados dos anúncios: as conversões da Google quando medem mais do que as reservas que conseguimos ligar.
  const results = adResultsMeasure(st?.bookingsAttributed ?? 0, st?.conversionsGoogle ?? 0);
  const costPerResult = results.value > 0 ? (st?.spend ?? 0) / results.value : null;
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

      <AlertsCard alerts={alertsData?.alerts} windowFrom={alertsData?.windowFrom} />

      {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
      {isLoading && <div className="flex justify-center py-12"><div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" /></div>}

      {st && (
        <>
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
            <Kpi icon={MousePointerClick} label="Conversões dos anúncios" value={num(Math.round(results.value))}
              hint={results.source === "google" ? `contadas pelas plataformas · só ligámos ${num(st.bookingsAttributed)} reservas (${pct(st.bookingsAttributed, Math.round(st.conversionsGoogle))})` : `reservas ligadas pelo link · as plataformas contam ${num(Math.round(st.conversionsGoogle))}`} />
            <Kpi icon={Target} label="Custo por conversão" value={eur(costPerResult, 2)} hint={`por reserva ligada: ${eur(st.costPerAttributedBooking, 2)} · global: ${eur(st.adCostPerBooking, 2)}/reserva`} />
            <Kpi icon={TrendingUp} label="ROAS (s/ IVA)" value={roas(st.roasAttributedNet)}
              hint={`reservas ligadas, receita sem IVA ÷ gasto · todas as reservas: ${roas(st.roasTotalNet)}`} />
            <Kpi icon={TrendingUp} label="ROAS Google (reportado)" value={roas(st.roasGoogle)} hint="valor de conversão que a plataforma reporta ÷ gasto" />
            <Kpi icon={Receipt} label="Outras despesas de marketing" value={eur(st.mktExpenses)} compact={eurCompact(st.mktExpenses)} hint="Despesas da categoria «Marketing» no período" />
            <Kpi icon={Euro} label="Custo total de marketing" value={eur(totalMarketing)} compact={eurCompact(totalMarketing)} hint={`${eur(st.bookingsTotal > 0 ? totalMarketing / st.bookingsTotal : null, 2)} por reserva (todas)`} />
            <Kpi icon={ShoppingCart} label="Reservas" value={num(st.bookingsTotal)} hint={`todas as origens · ${num(st.bookingsGoogle)} Google · ${num(st.bookingsMeta)} Meta (ligadas)`} />
            <Kpi icon={ShoppingCart} label="Valor das reservas" value={eur(st.revenueTotal)} compact={eurCompact(st.revenueTotal)} hint="todas, c/ IVA, pela data de criação" />
          </div>

          <div className={`rounded-md border px-3 py-2.5 text-sm space-y-1.5 ${healthCls}`} role="status">
            <div className="flex items-center gap-2 font-medium"><HealthIcon className="w-4 h-4" /> {healthLabel}</div>
            <p className="text-xs">{health.message}</p>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs tabular-nums">
              <span>Reservas feitas no site: <b>{num(q.siteBookings)}</b></span>
              <span>com link de origem: <b>{num(q.withOriginUrl)}</b> ({pct(q.withOriginUrl, q.siteBookings)})</span>
              <span>com clique do Google (gclid): <b>{num(q.withClickId)}</b> ({pct(q.withClickId, q.siteBookings)})</span>
              <span>atribuídas aos anúncios: <b>{num(q.attributed)}</b> ({pct(q.attributed, q.siteBookings)})</span>
              <span>conversões contadas pela Google: <b>{num(Math.round(st.conversionsGoogle ?? 0))}</b> — ligámos {pct(q.attributed, Math.round(st.conversionsGoogle ?? 0))}</span>
            </div>
          </div>

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
  );
}

/** Alertas (independentes do período escolhido: últimos 14 dias e mês corrente). Nunca só cor: ícone + texto. */
export function AlertsCard({ alerts, windowFrom }: { alerts?: Array<{ level: "critical" | "warning"; code: string; title: string; detail: string; link?: string; linkLabel?: string; items?: string[] }>; windowFrom?: string }) {
  if (!alerts) return null;
  if (!alerts.length) {
    return (
      <div className="rounded-md border border-emerald-200 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200 px-3 py-2 text-xs flex items-center gap-2" role="status">
        <CheckCircle2 className="w-4 h-4" /> Sem alertas: campanhas com resultados, ritmo do mês normal e todas as campanhas associadas.
      </div>
    );
  }
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-amber-600" /> Alertas ({alerts.length})</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {alerts.map((a, i) => {
          const critical = a.level === "critical";
          const Icon = critical ? CircleAlert : AlertTriangle;
          const body = (
            <div className={`rounded-md border px-3 py-2 text-sm ${critical ? "border-rose-200 bg-rose-50 text-rose-900 dark:bg-rose-950/30 dark:text-rose-200" : "border-amber-200 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200"}`}>
              <div className="flex items-center gap-2 font-medium"><Icon className="w-4 h-4 shrink-0" /><span className="sr-only">{critical ? "Crítico:" : "Atenção:"}</span>{a.title}</div>
              <p className="text-xs mt-0.5">{a.detail}</p>
              {a.items && a.items.length > 0 && (
                <ul className="text-xs mt-1 list-disc pl-5 space-y-0.5">{a.items.map((it) => <li key={it}>{it}</li>)}</ul>
              )}
              {a.linkLabel && a.link && (
                <Link href={a.link} className="inline-flex items-center gap-1 mt-1.5 text-xs font-semibold underline">{a.linkLabel}</Link>
              )}
            </div>
          );
          return a.link && !a.linkLabel ? <Link key={`${a.code}-${i}`} href={a.link} className="block hover:opacity-90">{body}</Link> : <div key={`${a.code}-${i}`}>{body}</div>;
        })}
        {windowFrom && <p className="text-[11px] text-muted-foreground">Campanhas: últimos 14 dias (desde {windowFrom.slice(8, 10)}/{windowFrom.slice(5, 7)}). Ritmo: mês corrente até ontem vs mês passado.</p>}
      </CardContent>
    </Card>
  );
}
