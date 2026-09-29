/**
 * Velocidade (Web & SEO) — dados REAIS dos visitantes (Chrome UX Report, p75
 * de 28 dias por origem e por página, telemóvel/computador) ao lado dos
 * dados de laboratório da PageSpeed, e "o que corrigir primeiro" (as
 * oportunidades do Lighthouse da última medição, ordenadas pela poupança),
 * com explicação opcional em PT-PT pela IA (lite).
 */
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Loader2, Sparkles, Users, Wrench } from "lucide-react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { STICKY_FIRST_COL } from "@/components/finance/layoutClasses";
import { AXIS_TICK, CHART_TOOLTIP_ITEM, CHART_TOOLTIP_STYLE } from "@/lib/financeFormat";
import { CRUX_METRICS, cruxLevel, type CruxMetric, type PsLevel, type WebBrand } from "@shared/webAnalytics";
import { LEVEL_CLS, LEVEL_LABEL, fmtDay, num, shortDay } from "./webKpi";

const METRIC_LABEL: Record<CruxMetric, string> = { lcp: "LCP", inp: "INP", cls: "CLS", fcp: "FCP", ttfb: "TTFB" };
const METRIC_TITLE: Record<CruxMetric, string> = {
  lcp: "Largest Contentful Paint — quando aparece o conteúdo principal",
  inp: "Interaction to Next Paint — rapidez a responder a toques/cliques",
  cls: "Cumulative Layout Shift — a página salta enquanto carrega",
  fcp: "First Contentful Paint — primeiro conteúdo visível",
  ttfb: "Time to First Byte — resposta do servidor",
};
const fmtMetric = (m: CruxMetric, v: number | null) => (v == null ? "—" : m === "cls" ? v.toFixed(2).replace(".", ",") : m === "inp" || m === "ttfb" ? `${num(v)} ms` : `${(v / 1000).toFixed(1).replace(".", ",")} s`);

function CruxChip({ metric, value, dist }: { metric: CruxMetric; value: number | null; dist: { good: number; ni: number; poor: number } | null }) {
  const lvl: PsLevel | null = cruxLevel(metric, value);
  if (!lvl) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="inline-flex flex-col items-end gap-0.5">
      <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs tabular-nums ${LEVEL_CLS[lvl]}`} title={`${LEVEL_LABEL[lvl]}${dist ? ` — ${Math.round(dist.good * 100)}% bom, ${Math.round(dist.ni * 100)}% a melhorar, ${Math.round(dist.poor * 100)}% fraco` : ""}`}>
        {fmtMetric(metric, value)}<span className="sr-only"> ({LEVEL_LABEL[lvl]})</span>
      </span>
      {dist && (
        <span className="flex h-1.5 w-16 overflow-hidden rounded-full bg-muted" aria-hidden>
          <span className="bg-emerald-500" style={{ width: `${dist.good * 100}%` }} />
          <span className="bg-amber-500" style={{ width: `${dist.ni * 100}%` }} />
          <span className="bg-rose-500" style={{ width: `${dist.poor * 100}%` }} />
        </span>
      )}
    </div>
  );
}

export function CruxSection({ brand, enabled }: { brand: "" | WebBrand; enabled: boolean }) {
  const { data, isLoading, error } = trpc.marketing.web.crux.useQuery({ brand, weeks: 26 }, { enabled });
  const [sel, setSel] = useState<string | null>(null);
  const latest = useMemo(() => {
    const m = new Map<string, any>();
    for (const r of data?.rows ?? []) m.set(`${r.targetType}:${r.target}:${r.formFactor}`, r); // ordenado por periodEnd → fica o último
    return m;
  }, [data]);
  if (isLoading) return <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>;
  if (error) return <p role="alert" className="text-sm text-destructive">{error.message}</p>;
  if (!data) return null;
  if (!data.enabled) return <p className="text-xs text-muted-foreground">Dados reais (Chrome UX Report) desligados (Definições → Integrações → Web & SEO).</p>;
  const selected = sel ?? (data.targets[0] ? `${data.targets[0].type}:${data.targets[0].target}` : null);
  const trend = (data.rows ?? []).filter((r) => `${r.targetType}:${r.target}` === selected && r.formFactor === "PHONE").map((r) => ({ label: shortDay(r.periodEnd), lcp: r.lcpP75 != null ? r.lcpP75 / 1000 : null, inp: r.inpP75 }));
  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2"><Users className="w-4 h-4" />Visitantes reais (Chrome UX Report, 28 dias, p75)</CardTitle>
          {!data.hasKey && <p className="text-[11px] text-amber-800 dark:text-amber-200">Sem chave: define GOOGLE_PAGESPEED_API_KEY (ou GOOGLE_CRUX_API_KEY) e ativa a "Chrome UX Report API".</p>}
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table className={`tabular-nums ${STICKY_FIRST_COL}`}>
            <TableHeader>
              <TableRow>
                <TableHead>Página / site</TableHead><TableHead>Dispositivo</TableHead>
                {CRUX_METRICS.map((m) => <TableHead key={m} className="text-right" title={METRIC_TITLE[m]}>{METRIC_LABEL[m]}</TableHead>)}
                <TableHead className="text-right">Até</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.targets.flatMap((t) => (["PHONE", "DESKTOP"] as const).map((ff) => {
                const r = latest.get(`${t.type}:${t.target}:${ff}`);
                const key = `${t.type}:${t.target}`;
                return (
                  <TableRow key={`${key}:${ff}`} className={selected === key ? "bg-muted/40" : undefined} onClick={() => setSel(key)}>
                    <TableCell className="max-w-[260px]">
                      <button type="button" className="text-left truncate text-sm underline-offset-2 hover:underline" title={t.target}>{t.label}</button>
                      {t.type === "url" && t.keyUrl && <Badge variant="outline" className="ml-1 font-normal text-[10px]">chave</Badge>}
                    </TableCell>
                    <TableCell className="text-sm">{ff === "PHONE" ? "Telemóvel" : "Computador"}</TableCell>
                    {r ? (
                      <>
                        {CRUX_METRICS.map((m) => <TableCell key={m} className="text-right"><CruxChip metric={m} value={(r as any)[`${m}P75`]} dist={r.dist[m]} /></TableCell>)}
                        <TableCell className="text-right text-xs">{fmtDay(r.periodEnd)}</TableCell>
                      </>
                    ) : <TableCell colSpan={6} className="text-xs text-muted-foreground">Sem dados reais (visitas Chrome insuficientes ou ainda por consultar).</TableCell>}
                  </TableRow>
                );
              }))}
            </TableBody>
          </Table>
          <p className="text-[11px] text-muted-foreground px-4 py-2">
            Dados de quem visitou o site com o Chrome nos últimos 28 dias (75% das visitas foram melhores do que o valor). A barra mostra bom/a melhorar/fraco.
            Alerta nas páginas-chave acima de LCP {(data.thresholds.lcpMs / 1000).toFixed(1).replace(".", ",")} s, INP {data.thresholds.inpMs} ms ou CLS {String(data.thresholds.cls).replace(".", ",")}.
          </p>
        </CardContent>
      </Card>
      {trend.length > 1 && (
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-sm truncate">Evolução real no telemóvel — {data.targets.find((t) => `${t.type}:${t.target}` === selected)?.label}</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={trend} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--border)" />
                <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} />
                <YAxis yAxisId="l" tick={AXIS_TICK} tickLine={false} axisLine={false} width={36} tickFormatter={(v) => `${v}s`} />
                <YAxis yAxisId="i" orientation="right" tick={AXIS_TICK} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => `${v}ms`} />
                <Tooltip contentStyle={CHART_TOOLTIP_STYLE} itemStyle={CHART_TOOLTIP_ITEM} />
                <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span className="text-foreground">{v}</span>} />
                <Line yAxisId="l" type="monotone" dataKey="lcp" name="LCP (s)" stroke="var(--wb-1)" strokeWidth={2} dot={false} connectNulls />
                <Line yAxisId="i" type="monotone" dataKey="inp" name="INP (ms)" stroke="var(--wb-3)" strokeWidth={2} strokeDasharray="5 3" dot={false} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}
    </>
  );
}

export function FixFirstCard({ url, label, canEdit }: { url: string; label: string; canEdit: boolean }) {
  const [strategy, setStrategy] = useState<"mobile" | "desktop">("mobile");
  const { data, isLoading } = trpc.marketing.web.opportunities.useQuery({ url, strategy }, { retry: false });
  const [text, setText] = useState<string | null>(null);
  const explain = trpc.marketing.web.explainOpportunities.useMutation({
    onSuccess: (r) => { if (r?.text) setText(r.text); else toast.message(r?.skipped === "disabled" ? "IA desligada (interruptor \"IA: explicar o que corrigir na PageSpeed\")." : r?.skipped === "budget" ? "Orçamento da IA atingido este mês." : r?.skipped === "empty" ? "Nada para explicar." : "A IA não respondeu."); },
    onError: (e) => toast.error(e.message),
  });
  const audits = data?.audits ?? [];
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm flex items-center gap-2 min-w-0"><Wrench className="w-4 h-4 shrink-0" /><span className="truncate">O que corrigir primeiro — {label}</span></CardTitle>
          <div className="flex items-center gap-1">
            <Button variant={strategy === "mobile" ? "secondary" : "ghost"} size="sm" className="h-7" onClick={() => { setStrategy("mobile"); setText(null); }}>Móvel</Button>
            <Button variant={strategy === "desktop" ? "secondary" : "ghost"} size="sm" className="h-7" onClick={() => { setStrategy("desktop"); setText(null); }}>Computador</Button>
            {canEdit && audits.length > 0 && (
              <Button variant="outline" size="sm" className="h-7" disabled={explain.isPending} onClick={() => explain.mutate({ url, strategy })}>
                {explain.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 mr-1" />}Explicar
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
        {!isLoading && !audits.length && <p className="text-xs text-muted-foreground">Sem oportunidades guardadas (aparecem depois da próxima medição semanal).</p>}
        {audits.length > 0 && (
          <ol className="space-y-1 text-sm list-decimal pl-5">
            {audits.map((a) => (
              <li key={a.auditId}>
                <span>{a.title}</span>
                <span className="text-xs text-muted-foreground">
                  {a.savingsMs ? ` — poupa ~${(a.savingsMs / 1000).toFixed(1).replace(".", ",")} s` : ""}{a.savingsBytes ? ` · ${num(Math.round(a.savingsBytes / 1024))} KB` : ""}
                  {!a.savingsMs && !a.savingsBytes && a.displayValue ? ` — ${a.displayValue}` : ""}{a.kind === "diagnostic" ? " (diagnóstico)" : ""}
                </span>
              </li>
            ))}
          </ol>
        )}
        {audits[0] && <p className="text-[11px] text-muted-foreground">Medição de {fmtDay(audits[0].runDay)}. Ordenado pela poupança estimada do Lighthouse.</p>}
        {text && <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm whitespace-pre-line" aria-live="polite"><div className="text-[11px] text-muted-foreground mb-1">Explicação (IA)</div>{text}</div>}
      </CardContent>
    </Card>
  );
}
