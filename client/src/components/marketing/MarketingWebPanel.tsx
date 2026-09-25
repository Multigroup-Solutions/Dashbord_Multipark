/**
 * Marketing → Web & SEO (set 2026): Google Analytics 4, Search Console e
 * PageSpeed, a partir dos agregados diários recolhidos pelo cron
 * /api/cron/web-analytics (server/webAnalytics). Só leitura, só totais.
 *
 *  - KPIs com comparação (período anterior ou mesmo período do ano passado);
 *  - Tráfego: sessões por dia, canais, dispositivos, funil, páginas de
 *    entrada e geografia (tabelas grandes paginadas no servidor);
 *  - Pesquisa: cliques/impressões/posição, pesquisas (com variação de
 *    posição) e páginas a perder cliques;
 *  - Velocidade: PageSpeed móvel/computador com verde/âmbar/vermelho;
 *  - Negócio: reservas feitas no site ÷ sessões, receita por sessão e gasto
 *    dos anúncios por sessão (mesmas reservas das Reservas & Operações).
 */
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { keepPreviousData } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import DateRangeNav from "@/components/DateRangeNav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, CheckCircle2, ChevronLeft, ChevronRight, CircleAlert, Gauge, Globe, Loader2, MousePointerClick,
  RefreshCw, Search, Settings, ShoppingCart, Sparkles, TrendingUp, Users,
} from "lucide-react";
import { Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { STICKY_FIRST_COL, TABS_SCROLL } from "@/components/finance/layoutClasses";
import { StatValue } from "@/components/StatValue";
import { AXIS_TICK, CHART_TOOLTIP_ITEM, CHART_TOOLTIP_STYLE, eurCompact } from "@/lib/financeFormat";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { WEB_BRAND_LABELS, psLevel, type CompareMode, type PsLevel, type PsMetric, type WebBrand } from "@shared/webAnalytics";

function lisbonDay(d = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}
const num = (v: number | null | undefined, digits = 0) => (v == null ? "—" : Number(v).toLocaleString("pt-PT", { maximumFractionDigits: digits }));
const eur = (v: number | null | undefined, digits = 0) =>
  v == null ? "—" : v.toLocaleString("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: digits, minimumFractionDigits: digits });
const pctOf = (v: number | null | undefined, digits = 1) => (v == null ? "—" : `${(v * 100).toLocaleString("pt-PT", { maximumFractionDigits: digits, minimumFractionDigits: digits })}%`);
const posFmt = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("pt-PT", { maximumFractionDigits: 1, minimumFractionDigits: 1 }));
const shortDay = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const fmtDay = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "—");
const change = (cur: number | null | undefined, prev: number | null | undefined) => (cur == null || prev == null || prev === 0 ? null : (cur - prev) / Math.abs(prev));

// Paleta: atual = Royal Blue (#0055D2 / escuro #4f8aec); comparação = cinzento a tracejado; posição = laranja.
const SERIES = "[--wb-1:#0055d2] [--wb-2:#16a34a] [--wb-3:#c2410c] dark:[--wb-1:#4f8aec] dark:[--wb-3:#ea580c]";

/** Variação com seta + texto (nunca só cor). `invert`: descer é bom (posição). */
function Delta({ cur, prev, invert, abs }: { cur: number | null | undefined; prev: number | null | undefined; invert?: boolean; abs?: (d: number) => string }) {
  if (cur == null || prev == null) return <span className="text-muted-foreground">sem comparação</span>;
  const d = abs ? cur - prev : change(cur, prev);
  if (d == null || !Number.isFinite(d)) return <span className="text-muted-foreground">sem base</span>;
  if (Math.abs(d) < (abs ? 0.05 : 0.005)) return <span className="text-muted-foreground">= estável</span>;
  const up = d > 0;
  const good = invert ? !up : up;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center gap-0.5 ${good ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-400"}`}>
      <Icon className="w-3 h-3" aria-hidden />
      <span className="sr-only">{up ? "subiu" : "desceu"}</span>
      {abs ? abs(d) : `${up ? "+" : "−"}${Math.round(Math.abs(d) * 100)}%`}
    </span>
  );
}

function Kpi({ icon: Icon, label, value, cur, prev, invert, hint, abs }: { icon: any; label: string; value: string; cur?: number | null; prev?: number | null; invert?: boolean; hint?: string; abs?: (d: number) => string }) {
  return (
    <div className="rounded-xl border bg-card p-3 min-w-0">
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className="w-3.5 h-3.5 shrink-0" /> <span className="truncate">{label}</span></div>
      <StatValue value={value} className="mt-1" max={26} />
      <div className="text-[11px] mt-0.5 flex flex-wrap gap-x-2">
        {cur !== undefined && <Delta cur={cur} prev={prev} invert={invert} abs={abs} />}
        {hint && <span className="text-muted-foreground">{hint}</span>}
      </div>
    </div>
  );
}

const LEVEL_CLS: Record<PsLevel, string> = {
  good: "bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200",
  needs_improvement: "bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-950/40 dark:text-amber-200",
  poor: "bg-rose-100 text-rose-900 border-rose-200 dark:bg-rose-950/40 dark:text-rose-200",
};
const LEVEL_LABEL: Record<PsLevel, string> = { good: "Bom", needs_improvement: "A melhorar", poor: "Fraco" };

function PsChip({ metric, value, text }: { metric: PsMetric; value: number | null | undefined; text: string }) {
  const lvl = psLevel(metric, value);
  if (!lvl) return <span className="text-muted-foreground">—</span>;
  return <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs tabular-nums ${LEVEL_CLS[lvl]}`} title={LEVEL_LABEL[lvl]}>{text}<span className="sr-only"> ({LEVEL_LABEL[lvl]})</span></span>;
}

type Common = { from: string; to: string; brand: "" | WebBrand; compare: CompareMode };

// ─── Tabela paginada (servidor) ─────────────────────────────────────────────

type GaCol = "sessions" | "users" | "engaged" | "keyEvents" | "revenue";
type ScCol = "clicks" | "impressions" | "ctr" | "position";

function DimTable({ common, source, dim, title, firstCol, sorts, defaultSort, search, cols, pageSize = 25 }: {
  common: Common; source: "ga" | "sc"; dim: string; title: string; firstCol: string;
  sorts: Array<{ value: string; label: string }>; defaultSort: string; search?: boolean;
  cols: Array<GaCol | ScCol>; pageSize?: number;
}) {
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState(defaultSort);
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const input = { ...common, source, dim, sort, page, pageSize, ...(term ? { search: term } : {}) } as any;
  const { data, isLoading, isFetching, error } = trpc.marketing.web.list.useQuery(input, { placeholderData: keepPreviousData });
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const head: Record<GaCol | ScCol, string> = { sessions: "Sessões", users: "Utilizadores", engaged: "Envolvimento", keyEvents: "Conversões", revenue: "Receita", clicks: "Cliques", impressions: "Impressões", ctr: "CTR", position: "Posição" };
  const cell = (r: any, c: GaCol | ScCol) => {
    switch (c) {
      case "sessions": return <><div>{num(r.cur.sessions)}</div><div className="text-[11px]"><Delta cur={r.cur.sessions} prev={r.prev.sessions} /></div></>;
      case "users": return num(r.cur.users);
      case "engaged": return pctOf(r.cur.sessions ? r.cur.engaged / r.cur.sessions : null, 0);
      case "keyEvents": return num(r.cur.keyEvents, 1);
      case "revenue": return eur(r.cur.revenue);
      case "clicks": return <><div>{num(r.cur.clicks)}</div><div className="text-[11px]"><Delta cur={r.cur.clicks} prev={r.prev.clicks} /></div></>;
      case "impressions": return num(r.cur.impressions);
      case "ctr": return pctOf(r.cur.impressions ? r.cur.clicks / r.cur.impressions : null);
      case "position": return <><div>{posFmt(r.position)}</div><div className="text-[11px]"><Delta cur={r.position} prev={r.prevPosition} invert abs={(d) => `${d > 0 ? "+" : "−"}${posFmt(Math.abs(d))}`} /></div></>;
    }
  };
  return (
    <Card>
      <CardHeader className="pb-2 space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm">{title}</CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
            {search && (
              <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); setTerm(q.trim()); setPage(1); }}>
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Procurar…" className="h-8 w-40" aria-label={`Procurar em ${title}`} />
                <Button type="submit" variant="outline" size="sm" className="h-8" aria-label="Procurar"><Search className="w-3.5 h-3.5" /></Button>
              </form>
            )}
            {sorts.length > 1 && (
              <Select value={sort} onValueChange={(v) => { setSort(v); setPage(1); }}>
                <SelectTrigger className="h-8 w-[190px]" aria-label="Ordenar"><SelectValue /></SelectTrigger>
                <SelectContent>{sorts.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
              </Select>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        {error && <p role="alert" className="text-sm text-destructive px-4 py-2">{error.message}</p>}
        <Table className={`tabular-nums ${STICKY_FIRST_COL}`}>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[180px]">{firstCol}</TableHead>
              {cols.map((c) => <TableHead key={c} className="text-right">{head[c]}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && <TableRow><TableCell colSpan={cols.length + 1} className="text-center py-6"><Loader2 className="w-4 h-4 animate-spin inline" /></TableCell></TableRow>}
            {!isLoading && !data?.rows.length && <TableRow><TableCell colSpan={cols.length + 1} className="text-center py-6 text-muted-foreground">Sem dados no período.</TableCell></TableRow>}
            {data?.rows.map((r: any) => (
              <TableRow key={r.key}>
                <TableCell className="max-w-[320px]">
                  <div className="truncate text-sm" title={r.value}>{r.value || "(sem valor)"}</div>
                  {r.sourceLabel && <div className="text-[11px] text-muted-foreground truncate">{r.sourceLabel}</div>}
                </TableCell>
                {cols.map((c) => <TableCell key={c} className="text-right align-top">{cell(r, c)}</TableCell>)}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="flex items-center justify-between gap-2 px-4 py-2 text-xs text-muted-foreground">
          <span>{total ? `${num((page - 1) * pageSize + 1)}–${num(Math.min(page * pageSize, total))} de ${num(total)}` : ""}{isFetching && !isLoading ? " · a carregar…" : ""}</span>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" className="h-8" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="Página anterior"><ChevronLeft className="w-4 h-4" /></Button>
            <span className="px-1">{page} / {pages}</span>
            <Button variant="outline" size="sm" className="h-8" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} aria-label="Página seguinte"><ChevronRight className="w-4 h-4" /></Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Painel ─────────────────────────────────────────────────────────────────

export default function MarketingWebPanel() {
  const today = lisbonDay();
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [compare, setCompare] = useState<CompareMode>("previous");
  const [brand, setBrand] = useState<"" | WebBrand>("");
  const [section, setSection] = useState("trafego");
  const [geoDim, setGeoDim] = useState<"country" | "city">("country");
  const common: Common = { from, to, brand, compare };
  const utils = trpc.useUtils();
  const { data, isLoading, error } = trpc.marketing.web.overview.useQuery(common, { placeholderData: keepPreviousData });
  const settings = trpc.marketing.web.settings.get.useQuery(undefined, { retry: false, staleTime: 60_000 });
  const ps = trpc.marketing.web.pagespeed.useQuery({ brand, weeks: 26 }, { enabled: section === "velocidade" });
  const runNow = trpc.marketing.web.settings.runNow.useMutation({
    onSuccess: (r) => {
      utils.marketing.web.invalidate();
      if (r.busy) toast.message("Já está a correr uma recolha — tenta daqui a um minuto.");
      else if (!r.configured) toast.message("A recolha Web & SEO está desligada ou sem propriedades (Definições → Integrações).");
      else if (r.errors.length) toast.error(r.errors[0]);
      else toast.success(`Recolha feita (${r.windows} bloco(s))${r.done ? "" : " — continua na próxima corrida"}.`);
    },
    onError: (e) => toast.error(e.message),
  });
  const refreshInsight = trpc.marketing.web.settings.refreshInsight.useMutation({
    onSuccess: (r) => { utils.marketing.web.overview.invalidate(); toast.success(r.created ? (r.ai ? "Resumo gerado pela IA." : "Resumo gerado (texto fixo — IA desligada ou sem orçamento).") : "Sem dados suficientes para o resumo."); },
    onError: (e) => toast.error(e.message),
  });
  const canEdit = !!settings.data?.canEdit;

  const series = useMemo(() => (data?.series ?? []).map((r) => ({ ...r, label: shortDay(r.day) })), [data]);
  const compareLabel = compare === "yoy" ? "mesmo período do ano passado" : "período anterior";
  const g = data?.ga, s = data?.sc, b = data?.business;
  const channelTotal = (data?.channels ?? []).reduce((t, c) => t + (c.cur.sessions ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <p className="text-xs text-muted-foreground max-w-2xl">
          Google Analytics 4 e Search Console (totais por dia, recolhidos 1×/dia) e PageSpeed (1×/semana). A Search Console chega com ~2–3 dias de atraso.
          Reservas pela data de criação, sem canceladas; "no site" = feitas nos sites das marcas.
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={brand || "all"} onValueChange={(v) => setBrand(v === "all" ? "" : (v as WebBrand))}>
            <SelectTrigger className="h-9 w-[150px]" aria-label="Marca"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas as marcas</SelectItem>
              {(data?.brands ?? []).map((x) => <SelectItem key={x} value={x}>{WEB_BRAND_LABELS[x as WebBrand] ?? x}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={compare} onValueChange={(v) => setCompare(v as CompareMode)}>
            <SelectTrigger className="h-9 w-[200px]" aria-label="Comparar com"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="previous">vs período anterior</SelectItem>
              <SelectItem value="yoy">vs ano passado</SelectItem>
            </SelectContent>
          </Select>
          <DateRangeNav start={from} end={to} gran="month" showAll={false} onChange={(st, en) => { if (st && en) { setFrom(st); setTo(en); } }} />
        </div>
      </div>

      {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
      {isLoading && <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>}

      {data && !data.configured && (
        <Card>
          <CardContent className="py-4 text-sm space-y-2">
            <p className="font-medium">Web & SEO por configurar.</p>
            <p className="text-muted-foreground text-xs">
              Liga a recolha e indica as propriedades GA4 e da Search Console em <Link href="/definicoes" className="underline">Definições → Integrações → Web & SEO</Link>. A conta de serviço tem de ser adicionada como Leitor em cada propriedade (ver a ajuda).
            </p>
          </CardContent>
        </Card>
      )}

      {data && (
        <>
          {/* Estado da recolha */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>Última recolha completa: {data.lastSuccessAt ? fmtPTDateTime(data.lastSuccessAt) : "nunca"}</span>
            <span>Comparação: {fmtDay(data.prevRange.from)} – {fmtDay(data.prevRange.to)} ({compareLabel})</span>
            {canEdit && (
              <>
                <Button variant="ghost" size="sm" className="h-7 px-2" disabled={runNow.isPending} onClick={() => runNow.mutate()}>
                  {runNow.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 mr-1" />}Atualizar agora
                </Button>
                <Link href="/definicoes" className="inline-flex items-center gap-1 underline"><Settings className="w-3.5 h-3.5" />Configurar</Link>
              </>
            )}
          </div>
          {data.sources.filter((x) => x.error).map((x) => (
            <div key={`${x.source}:${x.id}`} role="alert" className="rounded-md border border-amber-200 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200 px-3 py-2 text-xs flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span><b>{x.source === "ga" ? "GA4" : "Search Console"} — {x.label}:</b> {x.error}</span>
            </div>
          ))}
          {data.lastRun && !data.lastRun.ok && data.lastRun.errors[0] && (
            <div role="alert" className="rounded-md border border-rose-300 bg-rose-50 text-rose-900 dark:bg-rose-950/40 dark:text-rose-200 px-3 py-2 text-xs flex items-start gap-2">
              <CircleAlert className="w-4 h-4 shrink-0 mt-0.5" /><span><b>Última recolha com erro:</b> {data.lastRun.errors[0]}</span>
            </div>
          )}

          {/* Resumo semanal e alertas */}
          {(data.insight || canEdit) && (
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-sm flex items-center gap-2 flex-wrap">
                  <Sparkles className="w-4 h-4 text-primary" /> O que mudou esta semana
                  {data.insight && <Badge variant="outline" className="font-normal">{data.insight.ai ? "IA" : "texto automático"} · {fmtDay(data.insight.from)} – {fmtDay(data.insight.to)}</Badge>}
                  {canEdit && (
                    <Button variant="ghost" size="sm" className="h-7 px-2 ml-auto" disabled={refreshInsight.isPending} onClick={() => refreshInsight.mutate()}>
                      {refreshInsight.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 mr-1" />}Gerar de novo
                    </Button>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                {data.insight ? <p className="leading-relaxed">{data.insight.text}</p> : <p className="text-muted-foreground text-xs">Ainda sem resumo — é gerado à segunda-feira depois da recolha do dia.</p>}
                <p className="text-[11px] text-muted-foreground mt-1">Só a partir dos totais da última semana completa vs a anterior (sem dados de pessoas).</p>
              </CardContent>
            </Card>
          )}
          {data.alerts && (data.alerts.alerts.length ? (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-amber-600" /> Alertas de {fmtDay(data.alerts.day)} ({data.alerts.alerts.length})</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {data.alerts.alerts.map((a) => {
                  const critical = a.level === "critical";
                  const Icon = critical ? CircleAlert : AlertTriangle;
                  return (
                    <div key={a.key} className={`rounded-md border px-3 py-2 text-sm ${critical ? "border-rose-200 bg-rose-50 text-rose-900 dark:bg-rose-950/30 dark:text-rose-200" : "border-amber-200 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200"}`}>
                      <div className="flex items-center gap-2 font-medium"><Icon className="w-4 h-4 shrink-0" /><span className="sr-only">{critical ? "Crítico:" : "Atenção:"}</span>{a.title}</div>
                      <p className="text-xs mt-0.5">{a.detail}</p>
                      {a.items?.length ? <ul className="text-xs mt-1 list-disc pl-5 space-y-0.5">{a.items.map((it) => <li key={it}>{it}</li>)}</ul> : null}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          ) : (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200 px-3 py-2 text-xs flex items-center gap-2" role="status">
              <CheckCircle2 className="w-4 h-4" /> Sem alertas Web & SEO em {fmtDay(data.alerts.day)}.
            </div>
          ))}

          {/* KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Kpi icon={Users} label="Sessões (GA4)" value={num(g?.cur.sessions)} cur={g?.cur.sessions} prev={g?.prev.sessions} hint={g?.hasData ? undefined : "sem dados"} />
            <Kpi icon={Users} label="Utilizadores" value={num(g?.cur.totalUsers)} cur={g?.cur.totalUsers} prev={g?.prev.totalUsers} hint={`${num(g?.cur.newUsers)} novos`} />
            <Kpi icon={TrendingUp} label="Taxa de envolvimento" value={pctOf(g && g.cur.sessions ? g.cur.engagedSessions / g.cur.sessions : null, 0)}
              cur={g && g.cur.sessions ? g.cur.engagedSessions / g.cur.sessions : null} prev={g && g.prev.sessions ? g.prev.engagedSessions / g.prev.sessions : null} />
            <Kpi icon={ShoppingCart} label="Conversões (eventos-chave)" value={num(g?.cur.keyEvents, 0)} cur={g?.cur.keyEvents} prev={g?.prev.keyEvents} hint={g?.cur.revenue ? `receita GA4 ${eurCompact(g.cur.revenue)}` : undefined} />
            <Kpi icon={MousePointerClick} label="Cliques Google (orgânico)" value={num(s?.cur.clicks)} cur={s?.cur.clicks} prev={s?.prev.clicks} hint={s?.hasData ? undefined : "sem dados"} />
            <Kpi icon={Globe} label="Impressões" value={num(s?.cur.impressions)} cur={s?.cur.impressions} prev={s?.prev.impressions} hint={`CTR ${pctOf(s?.cur.ctr)}`} />
            <Kpi icon={Search} label="Posição média" value={posFmt(s?.cur.position)} cur={s?.cur.position} prev={s?.prev.position} invert abs={(d) => `${d > 0 ? "+" : "−"}${posFmt(Math.abs(d))}`} hint="menor é melhor" />
            <Kpi icon={ShoppingCart} label="Conversão web → reserva" value={pctOf(b?.totals.conversionRate, 2)} cur={b?.totals.conversionRate} prev={b?.prevTotals.conversionRate}
              hint={`${num(b?.totals.siteBookings)} reservas no site`} />
          </div>

          <Tabs value={section} onValueChange={setSection}>
            <TabsList className={TABS_SCROLL}>
              <TabsTrigger value="trafego"><Users className="w-4 h-4 mr-1" />Tráfego</TabsTrigger>
              <TabsTrigger value="pesquisa"><Search className="w-4 h-4 mr-1" />Pesquisa Google</TabsTrigger>
              <TabsTrigger value="velocidade"><Gauge className="w-4 h-4 mr-1" />Velocidade</TabsTrigger>
              <TabsTrigger value="negocio"><ShoppingCart className="w-4 h-4 mr-1" />Negócio</TabsTrigger>
            </TabsList>

            {/* ── Tráfego ── */}
            <TabsContent value="trafego" className={`mt-4 space-y-4 ${SERIES}`}>
              <Card>
                <CardHeader className="pb-1"><CardTitle className="text-sm">Sessões por dia</CardTitle></CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={230}>
                    <LineChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid vertical={false} stroke="var(--border)" />
                      <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
                      <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={44} allowDecimals={false} />
                      <Tooltip contentStyle={CHART_TOOLTIP_STYLE} itemStyle={CHART_TOOLTIP_ITEM} />
                      <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span className="text-foreground">{v}</span>} />
                      <Line type="monotone" dataKey="sessions" name="Sessões" stroke="var(--wb-1)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                      <Line type="monotone" dataKey="prevSessions" name={`Sessões (${compareLabel})`} stroke="var(--muted-foreground)" strokeWidth={1.5} strokeDasharray="5 3" dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">Canais (GA4)</CardTitle></CardHeader>
                  <CardContent className="p-0 overflow-x-auto">
                    <Table className={`tabular-nums ${STICKY_FIRST_COL}`}>
                      <TableHeader><TableRow><TableHead>Canal</TableHead><TableHead className="text-right">Sessões</TableHead><TableHead className="text-right">Quota</TableHead><TableHead className="text-right">Conversões</TableHead><TableHead className="text-right">Receita</TableHead></TableRow></TableHeader>
                      <TableBody>
                        {!data.channels.length && <TableRow><TableCell colSpan={5} className="text-center py-6 text-muted-foreground">Sem dados.</TableCell></TableRow>}
                        {data.channels.map((c) => (
                          <TableRow key={c.key}>
                            <TableCell className="text-sm">{c.value || "(sem canal)"}</TableCell>
                            <TableCell className="text-right"><div>{num(c.cur.sessions)}</div><div className="text-[11px]"><Delta cur={c.cur.sessions} prev={c.prev.sessions} /></div></TableCell>
                            <TableCell className="text-right">{pctOf(channelTotal ? (c.cur.sessions ?? 0) / channelTotal : null, 0)}</TableCell>
                            <TableCell className="text-right">{num(c.cur.keyEvents, 1)}</TableCell>
                            <TableCell className="text-right">{eur(c.cur.revenue)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">Dispositivos</CardTitle></CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    {[{ label: "Sessões (GA4)", rows: data.devices.ga, key: "sessions" }, { label: "Cliques Google", rows: data.devices.sc, key: "clicks" }].map((grp) => {
                      const tot = grp.rows.reduce((t: number, r: any) => t + (r.cur[grp.key] ?? 0), 0);
                      return (
                        <div key={grp.label}>
                          <div className="text-xs text-muted-foreground mb-1">{grp.label}</div>
                          {!grp.rows.length && <div className="text-xs text-muted-foreground">Sem dados.</div>}
                          {grp.rows.map((r: any) => {
                            const v = r.cur[grp.key] ?? 0;
                            const w = tot > 0 ? Math.max(v > 0 ? 2 : 0, Math.round((v / tot) * 100)) : 0;
                            return (
                              <div key={r.key} className="flex items-center gap-2 py-0.5">
                                <span className="w-24 truncate capitalize">{String(r.value).toLowerCase()}</span>
                                <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden"><div className="h-full rounded-full bg-primary" style={{ width: `${w}%` }} /></div>
                                <span className="w-24 text-right tabular-nums text-xs">{num(v)} · {pctOf(tot ? v / tot : null, 0)}</span>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>
              </div>

              {data.funnel.length > 0 && (
                <Card>
                  <CardHeader className="pb-1"><CardTitle className="text-sm">Funil de reserva (eventos GA4)</CardTitle></CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={Math.max(120, data.funnel.length * 44)}>
                      <BarChart data={data.funnel} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
                        <CartesianGrid horizontal={false} stroke="var(--border)" />
                        <XAxis type="number" tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
                        <YAxis type="category" dataKey="event" tick={AXIS_TICK} tickLine={false} axisLine={false} width={120} />
                        <Tooltip contentStyle={CHART_TOOLTIP_STYLE} itemStyle={CHART_TOOLTIP_ITEM} cursor={{ fill: "var(--muted)" }} />
                        <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span className="text-foreground">{v}</span>} />
                        <Bar dataKey="count" name="Eventos" fill="var(--wb-1)" radius={[0, 4, 4, 0]} maxBarSize={22} />
                        <Bar dataKey="prevCount" name={`Eventos (${compareLabel})`} fill="var(--muted-foreground)" fillOpacity={0.45} radius={[0, 4, 4, 0]} maxBarSize={22} />
                      </BarChart>
                    </ResponsiveContainer>
                    <p className="text-[11px] text-muted-foreground">Eventos definidos em Definições → Integrações → Web & SEO (só aparecem os que existem na GA4).</p>
                  </CardContent>
                </Card>
              )}

              <DimTable common={common} source="ga" dim="landing" title="Páginas de entrada" firstCol="Página"
                sorts={[{ value: "sessions", label: "Mais sessões" }, { value: "keyEvents", label: "Mais conversões" }, { value: "losing", label: "A perder sessões" }, { value: "gaining", label: "A ganhar sessões" }]}
                defaultSort="sessions" search cols={["sessions", "engaged", "keyEvents", "revenue"]} />

              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Button variant={geoDim === "country" ? "secondary" : "ghost"} size="sm" onClick={() => setGeoDim("country")}>Países</Button>
                  <Button variant={geoDim === "city" ? "secondary" : "ghost"} size="sm" onClick={() => setGeoDim("city")}>Cidades</Button>
                </div>
                <DimTable key={geoDim} common={common} source="ga" dim={geoDim} title={geoDim === "country" ? "Países (GA4)" : "Cidades (GA4)"} firstCol={geoDim === "country" ? "País" : "Cidade"}
                  sorts={[{ value: "sessions", label: "Mais sessões" }]} defaultSort="sessions" cols={["sessions", "users", "keyEvents"]} pageSize={10} />
              </div>
            </TabsContent>

            {/* ── Pesquisa Google ── */}
            <TabsContent value="pesquisa" className={`mt-4 space-y-4 ${SERIES}`}>
              <Card>
                <CardHeader className="pb-1"><CardTitle className="text-sm">Cliques e posição média por dia</CardTitle></CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={240}>
                    <ComposedChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid vertical={false} stroke="var(--border)" />
                      <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
                      <YAxis yAxisId="c" tick={AXIS_TICK} tickLine={false} axisLine={false} width={44} allowDecimals={false} />
                      <YAxis yAxisId="p" orientation="right" reversed tick={AXIS_TICK} tickLine={false} axisLine={false} width={36} domain={["auto", "auto"]} tickFormatter={(v) => posFmt(Number(v))} />
                      <Tooltip contentStyle={CHART_TOOLTIP_STYLE} itemStyle={CHART_TOOLTIP_ITEM} formatter={(v: any, n: any) => [n === "Posição média" ? posFmt(Number(v)) : num(Number(v)), n]} />
                      <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span className="text-foreground">{v}</span>} />
                      <Bar yAxisId="c" dataKey="clicks" name="Cliques" fill="var(--wb-1)" radius={[4, 4, 0, 0]} maxBarSize={20} />
                      <Line yAxisId="c" type="monotone" dataKey="prevClicks" name={`Cliques (${compareLabel})`} stroke="var(--muted-foreground)" strokeDasharray="5 3" dot={false} />
                      <Line yAxisId="p" type="monotone" dataKey="position" name="Posição média" stroke="var(--wb-3)" strokeWidth={2} dot={false} connectNulls />
                    </ComposedChart>
                  </ResponsiveContainer>
                  <p className="text-[11px] text-muted-foreground">Posição: eixo da direita invertido (mais acima = melhor). Os últimos 2–3 dias ainda não têm dados da Search Console.</p>
                </CardContent>
              </Card>

              <DimTable common={common} source="sc" dim="query" title="Pesquisas" firstCol="Pesquisa"
                sorts={[{ value: "clicks", label: "Mais cliques" }, { value: "impressions", label: "Mais impressões" }, { value: "position", label: "Melhor posição" }, { value: "positionWorse", label: "Posição a piorar" }, { value: "losing", label: "A perder cliques" }, { value: "gaining", label: "A ganhar cliques" }]}
                defaultSort="clicks" search cols={["clicks", "impressions", "ctr", "position"]} />
              <DimTable common={common} source="sc" dim="page" title="Páginas a perder cliques" firstCol="Página"
                sorts={[{ value: "losing", label: "A perder cliques" }, { value: "clicks", label: "Mais cliques" }, { value: "gaining", label: "A ganhar cliques" }, { value: "positionWorse", label: "Posição a piorar" }]}
                defaultSort="losing" search cols={["clicks", "impressions", "ctr", "position"]} />
              <DimTable common={common} source="sc" dim="country" title="Países (pesquisa Google)" firstCol="País (código)"
                sorts={[{ value: "clicks", label: "Mais cliques" }]} defaultSort="clicks" cols={["clicks", "impressions", "ctr", "position"]} pageSize={10} />
              <p className="text-[11px] text-muted-foreground">Pesquisas e páginas: as 250 com mais cliques de cada dia (a Search Console esconde as pesquisas raras) — os totais por pesquisa são aproximados.</p>
            </TabsContent>

            {/* ── Velocidade ── */}
            <TabsContent value="velocidade" className={`mt-4 space-y-4 ${SERIES}`}>
              <PagespeedSection data={ps.data} loading={ps.isLoading} />
            </TabsContent>

            {/* ── Negócio ── */}
            <TabsContent value="negocio" className={`mt-4 space-y-4 ${SERIES}`}>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <Kpi icon={ShoppingCart} label="Reservas feitas no site" value={num(b?.totals.siteBookings)} cur={b?.totals.siteBookings} prev={b?.prevTotals.siteBookings} hint={`de ${num(b?.totals.bookings)} no total`} />
                <Kpi icon={TrendingUp} label="Conversão web → reserva" value={pctOf(b?.totals.conversionRate, 2)} cur={b?.totals.conversionRate} prev={b?.prevTotals.conversionRate} hint="reservas no site ÷ sessões" />
                <Kpi icon={TrendingUp} label="Receita por sessão" value={eur(b?.totals.revenuePerSession, 2)} cur={b?.totals.revenuePerSession} prev={b?.prevTotals.revenuePerSession} hint="reservas do site (c/ IVA) ÷ sessões" />
                <Kpi icon={MousePointerClick} label="Gasto em anúncios por sessão" value={eur(b?.totals.spendPerSession, 2)} cur={b?.totals.spendPerSession} prev={b?.prevTotals.spendPerSession} invert
                  hint={b?.adSpendAvailable ? `${eurCompact(b?.totals.spend ?? 0)} gastos · ${eur(b?.totals.spendPerSiteBooking, 2)}/reserva no site` : "sem dados de anúncios no período"} />
              </div>
              <Card>
                <CardHeader className="pb-1"><CardTitle className="text-sm">Sessões, reservas no site e conversão por dia</CardTitle></CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={240}>
                    <ComposedChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid vertical={false} stroke="var(--border)" />
                      <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
                      <YAxis yAxisId="s" tick={AXIS_TICK} tickLine={false} axisLine={false} width={44} allowDecimals={false} />
                      <YAxis yAxisId="r" orientation="right" tick={AXIS_TICK} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => pctOf(Number(v), 1)} />
                      <Tooltip contentStyle={CHART_TOOLTIP_STYLE} itemStyle={CHART_TOOLTIP_ITEM} formatter={(v: any, n: any) => [n === "Conversão" ? pctOf(Number(v), 2) : num(Number(v)), n]} />
                      <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span className="text-foreground">{v}</span>} />
                      <Bar yAxisId="s" dataKey="sessions" name="Sessões" fill="var(--wb-1)" fillOpacity={0.35} radius={[4, 4, 0, 0]} maxBarSize={20} />
                      <Line yAxisId="s" type="monotone" dataKey="siteBookings" name="Reservas no site" stroke="var(--wb-2)" strokeWidth={2} dot={false} />
                      <Line yAxisId="r" type="monotone" dataKey="conversionRate" name="Conversão" stroke="var(--wb-3)" strokeWidth={2} strokeDasharray="5 3" dot={false} connectNulls />
                    </ComposedChart>
                  </ResponsiveContainer>
                  <p className="text-[11px] text-muted-foreground">
                    Indicador, não atribuição: compara as sessões da GA4 com as reservas feitas nos sites (origem API/formulário) no mesmo dia e marca.
                    O detalhe por canal pago está em <Link href="/marketing" className="underline">Dashboard</Link> e <Link href="/marketing/canais" className="underline">Canais e clientes</Link>.
                  </p>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}

function PagespeedSection({ data, loading }: { data: any; loading: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  if (loading) return <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;
  if (!data) return null;
  if (!data.enabled) return <p className="text-sm text-muted-foreground">A PageSpeed está desligada (Definições → Integrações → Web & SEO).</p>;
  const urls: Array<{ url: string; label: string }> = data.urls;
  const runs: any[] = data.runs;
  const latest = (u: string, strategy: string) => runs.filter((r) => r.url === u && r.strategy === strategy && r.score != null).slice(-1)[0] ?? null;
  const sel = url ?? urls[0]?.url ?? null;
  const history = (() => {
    const byDay = new Map<string, any>();
    for (const r of runs.filter((x) => x.url === sel && x.score != null)) {
      const e = byDay.get(r.runDay) ?? { day: r.runDay, label: shortDay(r.runDay) };
      e[r.strategy] = r.score;
      byDay.set(r.runDay, e);
    }
    return Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
  })();
  if (!urls.length) return <p className="text-sm text-muted-foreground">Sem páginas configuradas.</p>;
  return (
    <>
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Última medição (1×/semana)</CardTitle></CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table className={`tabular-nums ${STICKY_FIRST_COL}`}>
            <TableHeader>
              <TableRow>
                <TableHead>Página</TableHead><TableHead>Estratégia</TableHead><TableHead className="text-right">Pontuação</TableHead>
                <TableHead className="text-right" title="Largest Contentful Paint (laboratório)">LCP</TableHead>
                <TableHead className="text-right" title="Cumulative Layout Shift (laboratório)">CLS</TableHead>
                <TableHead className="text-right" title="Interaction to Next Paint (dados reais, CrUX)">INP</TableHead>
                <TableHead className="text-right" title="Total Blocking Time (laboratório)">TBT</TableHead>
                <TableHead className="text-right" title="First Contentful Paint (laboratório)">FCP</TableHead>
                <TableHead className="text-right">Medido</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {urls.flatMap((u) => (["mobile", "desktop"] as const).map((st) => {
                const r = latest(u.url, st);
                return (
                  <TableRow key={`${u.url}-${st}`} className={sel === u.url ? "bg-muted/40" : undefined} onClick={() => setUrl(u.url)}>
                    <TableCell className="max-w-[260px]"><button type="button" className="text-left truncate text-sm underline-offset-2 hover:underline" title={u.url}>{u.label || u.url}</button></TableCell>
                    <TableCell className="text-sm">{st === "mobile" ? "Móvel" : "Computador"}</TableCell>
                    {r ? (
                      <>
                        <TableCell className="text-right"><PsChip metric="score" value={r.score} text={`${r.score}`} /></TableCell>
                        <TableCell className="text-right"><PsChip metric="lcpMs" value={r.lcpMs} text={r.lcpMs == null ? "—" : `${(r.lcpMs / 1000).toFixed(1).replace(".", ",")} s`} /></TableCell>
                        <TableCell className="text-right"><PsChip metric="cls" value={r.cls} text={r.cls == null ? "—" : r.cls.toFixed(2).replace(".", ",")} /></TableCell>
                        <TableCell className="text-right"><PsChip metric="inpMs" value={r.inpMs} text={r.inpMs == null ? "—" : `${r.inpMs} ms`} /></TableCell>
                        <TableCell className="text-right"><PsChip metric="tbtMs" value={r.tbtMs} text={r.tbtMs == null ? "—" : `${r.tbtMs} ms`} /></TableCell>
                        <TableCell className="text-right"><PsChip metric="fcpMs" value={r.fcpMs} text={r.fcpMs == null ? "—" : `${(r.fcpMs / 1000).toFixed(1).replace(".", ",")} s`} /></TableCell>
                        <TableCell className="text-right text-xs">{fmtDay(r.runDay)}</TableCell>
                      </>
                    ) : <TableCell colSpan={7} className="text-xs text-muted-foreground">Ainda sem medição.</TableCell>}
                  </TableRow>
                );
              }))}
            </TableBody>
          </Table>
          <p className="text-[11px] text-muted-foreground px-4 py-2">
            Verde = bom, âmbar = a melhorar, vermelho = fraco (limiares Google: pontuação ≥ 90 / ≥ 50; LCP ≤ 2,5 s / ≤ 4 s; CLS ≤ 0,1 / ≤ 0,25; INP ≤ 200 / ≤ 500 ms). Alerta abaixo de {data.thresholdMobile} no móvel.
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-1"><CardTitle className="text-sm truncate">Histórico da pontuação — {urls.find((u) => u.url === sel)?.label || sel}</CardTitle></CardHeader>
        <CardContent>
          {history.length === 0 ? <p className="text-xs text-muted-foreground">Sem histórico.</p> : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={history} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--border)" />
                <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} />
                <YAxis domain={[0, 100]} tick={AXIS_TICK} tickLine={false} axisLine={false} width={32} />
                <Tooltip contentStyle={CHART_TOOLTIP_STYLE} itemStyle={CHART_TOOLTIP_ITEM} />
                <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span className="text-foreground">{v}</span>} />
                <Line type="monotone" dataKey="mobile" name="Móvel" stroke="var(--wb-1)" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                <Line type="monotone" dataKey="desktop" name="Computador" stroke="var(--wb-2)" strokeWidth={2} strokeDasharray="5 3" dot={{ r: 3 }} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </>
  );
}
