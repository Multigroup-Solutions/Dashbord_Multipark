/**
 * Resumo do marketing para o Dashboard Financeiro (Jorge, 24 set 2026): os
 * números principais do Marketing → Dashboard, com os filtros do Financeiro
 * (período, cidade/marca). Mesma fonte (marketing.dashboard) e mesmas regras:
 * conversões Google como medida dos anúncios quando medem mais do que as
 * reservas que ligamos pelo gclid.
 */
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { adResultsMeasure, attributionHealth } from "@shared/marketingAttribution";
import { AlertTriangle, CheckCircle2, CircleAlert, Loader2, Megaphone } from "lucide-react";

const eur = (v: number | null | undefined, digits = 0) =>
  v == null ? "—" : v.toLocaleString("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: digits, minimumFractionDigits: digits });
const num = (v: number | null | undefined) => (v == null ? "—" : Math.round(Number(v)).toLocaleString("pt-PT"));
const roas = (v: number | null | undefined) => (v == null ? "—" : `${v.toFixed(2).replace(".", ",")}×`);

function Cell({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-bold tabular-nums">{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground truncate" title={hint}>{hint}</div>}
    </div>
  );
}

export default function MarketingSummaryCard({ from, to, projectId }: { from: string; to: string; projectId?: number }) {
  const { data: st, isLoading, error } = trpc.marketing.dashboard.useQuery({ from, to, projectId });
  const { data: alertsData } = trpc.marketing.alerts.useQuery({ projectId });

  if (error) return null;   // sem acesso ao marketing (ou erro): o Financeiro segue sem este cartão
  const s: any = st;
  const results = s ? adResultsMeasure(s.bookingsAttributed ?? 0, s.conversionsGoogle ?? 0) : null;
  const totalMarketing = s ? (s.spend ?? 0) + (s.mktExpenses ?? 0) : 0;
  const health = s ? attributionHealth(s.attributionQuality, s.spend ?? 0, s.conversionsGoogle ?? null) : null;
  const critical = (alertsData?.alerts ?? []).filter((a) => a.level === "critical").length;
  const warnings = (alertsData?.alerts ?? []).length - critical;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold flex items-center gap-2 flex-wrap">
          <Megaphone className="h-4 w-4 text-primary" /> Marketing
          <Link href="/marketing" className="ml-auto text-xs font-normal text-primary underline">Ver marketing</Link>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading || !s || !results ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
              <Cell label="Gasto em anúncios" value={eur(s.spend)} hint={`Google ${eur(s.spendGoogle)} · Meta ${eur(s.spendMeta)}`} />
              <Cell label="Outras despesas de marketing" value={eur(s.mktExpenses)} />
              <Cell label="Custo total de marketing" value={eur(totalMarketing)} hint={s.bookingsTotal > 0 ? `${eur(totalMarketing / s.bookingsTotal, 2)} por reserva` : undefined} />
              <Cell label="Conversões dos anúncios" value={num(results.value)} hint={results.source === "google" ? `plataformas · ligámos ${num(s.bookingsAttributed)}` : "reservas ligadas (link)"} />
              <Cell label="Custo por conversão" value={eur(results.value > 0 ? s.spend / results.value : null, 2)} />
              <Cell label="ROAS (s/ IVA)" value={roas(s.roasAttributedNet)} hint={`Google reporta ${roas(s.roasGoogle)}`} />
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              {health && health.level !== "none" && (
                <span className={`flex items-center gap-1 ${health.level === "ok" ? "text-emerald-700 dark:text-emerald-400" : health.level === "critical" ? "text-rose-700 dark:text-rose-400" : "text-amber-700 dark:text-amber-400"}`}>
                  {health.level === "ok" ? <CheckCircle2 className="w-3.5 h-3.5" /> : health.level === "critical" ? <CircleAlert className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                  {health.level === "ok" ? "Atribuição a funcionar" : health.level === "critical" ? "Atribuição partida" : "Atribuição incompleta"}
                </span>
              )}
              {alertsData && (critical + warnings > 0) && (
                <Link href="/marketing" className="flex items-center gap-1 text-amber-700 dark:text-amber-400 underline">
                  <AlertTriangle className="w-3.5 h-3.5" /> {critical > 0 ? `${critical} alerta(s) crítico(s)` : ""}{critical > 0 && warnings > 0 ? " · " : ""}{warnings > 0 ? `${warnings} aviso(s)` : ""}
                </Link>
              )}
              <span className="text-muted-foreground">O gasto em anúncios entra nas contas pela fatura, nas Despesas (não é somado duas vezes).</span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
