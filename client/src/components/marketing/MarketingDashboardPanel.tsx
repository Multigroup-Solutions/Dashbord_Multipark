/**
 * Dashboard de Marketing (Jorge, 24 set 2026): os indicadores que o servidor
 * já calculava (marketing.dashboard → server/integrations/googleAds/marketingStats)
 * e que não se viam em lado nenhum, mais a QUALIDADE DA ATRIBUIÇÃO — se o gclid
 * não chega às reservas, o "via anúncios" e o ROAS real ficam a zero e enganam.
 *
 * Regras (as mesmas do servidor):
 *  - Gasto = custo importado do Google Ads; nunca orçamento.
 *  - Reservas pela data de criação, sem canceladas; "via anúncios" só com prova
 *    no link de origem (gclid/utm pago).
 *  - ROAS real (valor das reservas via anúncios / gasto) ≠ ROAS que a Google
 *    reporta (valor de conversão / gasto) — mostram-se lado a lado.
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
import { attributionHealth, type AttributionQuality } from "@shared/marketingAttribution";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

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

/** Todos os dias do intervalo (os que não têm dados ficam a zero, não desaparecem). */
function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (d <= end && out.length < 400) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

// Paleta validada (dataviz/validate_palette.js): claro #0055d2/#16a34a, escuro #4f8aec/#16a34a.
const SERIES = "[--mk-1:#0055d2] [--mk-2:#16a34a] dark:[--mk-1:#4f8aec]";
const AXIS = { fontSize: 11, fill: "var(--muted-foreground)" };
const TOOLTIP_STYLE = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--card-foreground)" };

function Kpi({ icon: Icon, label, value, hint }: { icon: any; label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className="w-3.5 h-3.5" /> {label}</div>
      <div className="text-2xl font-bold mt-1 tabular-nums">{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground mt-0.5">{hint}</div>}
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
    const books = new Map<string, { total: number; attributed: number }>((st.bookingsByDay ?? []).map((d: any) => [d.date, d]));
    return daysBetween(from, to).map((day) => ({
      day, label: shortDay(day),
      spend: spend.get(day) ?? 0,
      bookings: books.get(day)?.total ?? 0,
      viaAds: books.get(day)?.attributed ?? 0,
    }));
  }, [st, from, to]);

  const q: AttributionQuality = st?.attributionQuality ?? { siteBookings: 0, withOriginUrl: 0, withClickId: 0, attributed: 0 };
  const health = attributionHealth(q, st?.spend ?? 0);
  const HealthIcon = health.level === "ok" ? CheckCircle2 : health.level === "critical" ? CircleAlert : AlertTriangle;
  const healthCls = health.level === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200"
    : health.level === "critical" ? "border-rose-200 bg-rose-50 text-rose-900 dark:bg-rose-950/30 dark:text-rose-200"
    : health.level === "warning" ? "border-amber-200 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
    : "border-muted bg-muted/40 text-muted-foreground";
  const healthLabel = health.level === "ok" ? "Atribuição a funcionar" : health.level === "critical" ? "Atribuição partida" : health.level === "warning" ? "Atribuição incompleta" : "Sem dados";
  const totalMarketing = (st?.spend ?? 0) + (st?.mktExpenses ?? 0);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <p className="text-xs text-muted-foreground max-w-2xl">
          Gasto do Google Ads (API) e reservas reais da Multipark pela data de criação, sem canceladas. "Via anúncios" só conta reservas com prova no link de origem.
          O detalhe por marca e campanha está no separador <Link href="/marketing/google-ads" className="underline">Google Ads</Link>.
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
            <Kpi icon={Euro} label="Gasto Google Ads" value={eur(st.spend)} hint={`${num(st.clicks)} cliques · CPC ${eur(st.cpc, 2)}`} />
            <Kpi icon={ShoppingCart} label="Reservas" value={num(st.bookingsTotal)} hint={`${num(st.bookingsAttributed)} via anúncios (${pct(st.bookingsAttributed, st.bookingsTotal)})`} />
            <Kpi icon={Target} label="Custo por reserva via anúncios" value={eur(st.costPerAttributedBooking, 2)} hint={`global: ${eur(st.adCostPerBooking, 2)} de anúncios por reserva`} />
            <Kpi icon={TrendingUp} label="ROAS real" value={roas(st.roasAttributed)} hint={`a Google diz ${roas(st.roasGoogle)} · valor via anúncios ${eur(st.revenueAttributed)}`} />
            <Kpi icon={Receipt} label="Outras despesas de marketing" value={eur(st.mktExpenses)} hint="faturas (flyers, parcerias…)" />
            <Kpi icon={Euro} label="Custo total de marketing" value={eur(totalMarketing)} hint={`${eur(st.bookingsTotal > 0 ? totalMarketing / st.bookingsTotal : null, 2)} por reserva (todas)`} />
            <Kpi icon={MousePointerClick} label="Conversões (Google)" value={num(Math.round(st.conversionsGoogle ?? 0))} hint={`custo/conv. ${eur(st.costPerConversionGoogle, 2)} — números da Google`} />
            <Kpi icon={ShoppingCart} label="Valor das reservas" value={eur(st.revenueTotal)} hint="todas, pela data de criação" />
          </div>

          <div className={`rounded-md border px-3 py-2.5 text-sm space-y-1.5 ${healthCls}`} role="status">
            <div className="flex items-center gap-2 font-medium"><HealthIcon className="w-4 h-4" /> {healthLabel}</div>
            <p className="text-xs">{health.message}</p>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs tabular-nums">
              <span>Reservas feitas no site: <b>{num(q.siteBookings)}</b></span>
              <span>com link de origem: <b>{num(q.withOriginUrl)}</b> ({pct(q.withOriginUrl, q.siteBookings)})</span>
              <span>com clique do Google (gclid): <b>{num(q.withClickId)}</b> ({pct(q.withClickId, q.siteBookings)})</span>
              <span>atribuídas aos anúncios: <b>{num(q.attributed)}</b> ({pct(q.attributed, q.siteBookings)})</span>
            </div>
          </div>

          <div className={`grid grid-cols-1 lg:grid-cols-2 gap-4 ${SERIES}`}>
            <Card>
              <CardHeader className="pb-1"><CardTitle className="text-sm">Gasto Google Ads por dia</CardTitle></CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={series} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--border)" />
                    <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
                    <YAxis tick={AXIS} tickLine={false} axisLine={false} width={48} tickFormatter={(v) => `${v}€`} />
                    <Tooltip cursor={{ fill: "var(--muted)" }} contentStyle={TOOLTIP_STYLE} formatter={(v: any) => [eur(Number(v), 2), "Gasto"]} />
                    <Bar dataKey="spend" name="Gasto" fill="var(--mk-1)" radius={[4, 4, 0, 0]} maxBarSize={24} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1"><CardTitle className="text-sm">Reservas por dia</CardTitle></CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--border)" />
                    <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
                    <YAxis tick={AXIS} tickLine={false} axisLine={false} width={36} allowDecimals={false} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                    <Legend wrapperStyle={{ fontSize: 12, color: "var(--muted-foreground)" }} />
                    <Line type="monotone" dataKey="bookings" name="Todas" stroke="var(--mk-1)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                    <Line type="monotone" dataKey="viaAds" name="Via anúncios" stroke="var(--mk-2)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
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
                  <Table>
                    <TableHeader>
                      <TableRow><TableHead>Dia</TableHead><TableHead className="text-right">Gasto</TableHead><TableHead className="text-right">Reservas</TableHead><TableHead className="text-right">Via anúncios</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {series.map((r) => (
                        <TableRow key={r.day}>
                          <TableCell className="text-sm">{r.label}</TableCell>
                          <TableCell className="text-right tabular-nums">{eur(r.spend, 2)}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.bookings}</TableCell>
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
function AlertsCard({ alerts, windowFrom }: { alerts?: Array<{ level: "critical" | "warning"; code: string; title: string; detail: string; link?: string }>; windowFrom?: string }) {
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
            </div>
          );
          return a.link ? <Link key={`${a.code}-${i}`} href={a.link} className="block hover:opacity-90">{body}</Link> : <div key={`${a.code}-${i}`}>{body}</div>;
        })}
        {windowFrom && <p className="text-[11px] text-muted-foreground">Campanhas: últimos 14 dias (desde {windowFrom.slice(8, 10)}/{windowFrom.slice(5, 7)}). Ritmo: mês corrente vs mês passado.</p>}
      </CardContent>
    </Card>
  );
}
