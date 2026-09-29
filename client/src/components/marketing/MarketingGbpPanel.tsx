/**
 * Marketing → Web & SEO → Google Business (set 2026): desempenho dos perfis
 * Google (Performance API — impressões no Maps/Pesquisa, chamadas, pedidos de
 * direções, cliques no site), pesquisas mensais, críticas (média, volume,
 * taxa e tempo de resposta) e, para quem gere o Marketing, horários
 * (normal e especiais/feriados, em vários perfis de uma vez) e publicações.
 *
 * Tudo o que escreve no Google pede confirmação e fica no registo de
 * atividade. Os números vêm dos agregados diários recolhidos pelo cron
 * /api/cron/google-business (server/integrations/googleBusiness/insights.ts).
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { keepPreviousData } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import {
  AlertTriangle, CalendarClock, ChevronLeft, ChevronRight, CircleAlert, Clock, ExternalLink, Eye, Loader2, MapPin, Megaphone, MousePointerClick,
  Navigation, Phone, Plug, Plus, RefreshCw, Reply, Search, Settings, Sparkles, Star, Trash2,
} from "lucide-react";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { STICKY_FIRST_COL } from "@/components/finance/layoutClasses";
import { AXIS_TICK, CHART_TOOLTIP_ITEM, CHART_TOOLTIP_STYLE } from "@/lib/financeFormat";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { CITY_KEYS, CITY_LABELS, type CityKey } from "@shared/city";
import {
  GBP_BRAND_LABELS, POST_CTAS, POST_CTA_LABELS, POST_SUMMARY_MAX, POST_TOPICS, POST_TOPIC_LABELS, WEEKDAYS, WEEKDAY_LABELS, gbpImpressions,
  gbpConfigSchema, type DayHours, type GbpConfig, type PostTopic, type SpecialDay,
} from "@shared/googleBusinessProfile";
import type { CompareMode } from "@shared/webAnalytics";
import { Delta, Kpi, SERIES, fmtDay, lisbonDay, num, pctOf, shortDay } from "./webKpi";

type Range = { from: string; to: string; compare: CompareMode };
const stars = (v: number | null | undefined) => (v == null ? "—" : `${v.toLocaleString("pt-PT", { maximumFractionDigits: 2, minimumFractionDigits: 1 })}★`);
const hoursFmt = (h: number | null | undefined) => (h == null ? "—" : h < 48 ? `${num(h, 1)} h` : `${num(h / 24, 1)} dias`);
const SOURCE_LABEL: Record<string, string> = { manual: "definido", project: "parque associado", auto: "adivinhado", none: "sem cidade" };

function StatusBadges({ l }: { l: any }) {
  const out: Array<{ text: string; cls: string }> = [];
  if (l.hasVoiceOfMerchant === false) out.push({ text: "Sem controlo (verificação/suspensão)", cls: "border-rose-300 text-rose-800 dark:text-rose-200" });
  if (l.openStatus === "CLOSED_PERMANENTLY") out.push({ text: "Fechado definitivamente", cls: "border-rose-300 text-rose-800 dark:text-rose-200" });
  if (l.openStatus === "CLOSED_TEMPORARILY") out.push({ text: "Fechado temporariamente", cls: "border-amber-300 text-amber-800 dark:text-amber-200" });
  if (l.hasGoogleUpdated) out.push({ text: "Alterado pela Google", cls: "border-amber-300 text-amber-800 dark:text-amber-200" });
  if (l.hasPendingEdits) out.push({ text: "Edições pendentes", cls: "border-amber-300 text-amber-800 dark:text-amber-200" });
  if (!out.length) return l.hasVoiceOfMerchant ? <Badge variant="outline" className="font-normal border-emerald-300 text-emerald-800 dark:text-emerald-200">Verificado</Badge> : null;
  return <div className="flex flex-wrap gap-1">{out.map((b) => <Badge key={b.text} variant="outline" className={`font-normal ${b.cls}`}>{b.text}</Badge>)}</div>;
}

// ─── Secção principal ───────────────────────────────────────────────────────

export function GbpSection({ range }: { range: Range }) {
  const [city, setCity] = useState<"" | CityKey>("");
  const [locationId, setLocationId] = useState<number>(0);
  const [hoursFor, setHoursFor] = useState<number | null>(null);
  const [postsFor, setPostsFor] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const utils = trpc.useUtils();
  const input = { ...range, city, ...(locationId ? { locationId } : {}) };
  const { data, isLoading, error } = trpc.marketing.gbp.overview.useQuery(input, { placeholderData: keepPreviousData });
  const runNow = trpc.marketing.gbp.settings.runNow.useMutation({
    onSuccess: (r) => {
      utils.marketing.gbp.invalidate();
      if (r.busy) toast.message("Já está a correr uma recolha — tenta daqui a um minuto.");
      else if (r.skipped) toast.message(r.skipped === "disabled" ? "A recolha está desligada (Configurar)." : "Google Business Profile não está ligado (Críticas).");
      else if (r.blocked) toast.error(r.blocked);
      else if (r.errors.length) toast.error(r.errors[0]);
      else toast.success(`Recolha feita (${r.windows} bloco(s), ${r.keywordMonths} mês(es) de pesquisas)${r.done ? "" : " — continua na próxima corrida"}.`);
    },
    onError: (e) => toast.error(e.message),
  });
  const test = trpc.integrations.hub.test.useMutation({ onSuccess: (r) => setTestResult(r), onError: (e) => toast.error(e.message) });

  const series = useMemo(() => (data?.series ?? []).map((r) => ({ ...r, label: shortDay(r.day) })), [data]);
  const weeks = useMemo(() => (data?.reviews.byWeek ?? []).map((w) => ({ ...w, label: shortDay(w.week) })), [data]);
  if (isLoading) return <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;
  if (error) return <p role="alert" className="text-sm text-destructive">{error.message}</p>;
  if (!data) return null;
  const t = data.totals, rv = data.reviews;
  const canEdit = data.canEdit;
  const connected = data.connection.status === "connected";
  const problem = data.lastError || data.lastRun?.blocked || data.connection.lastError;
  const compareLabel = range.compare === "yoy" ? "ano passado" : "período anterior";
  const locOptions = data.allLocations.filter((l) => !city || l.city === city);

  return (
    <div className={`space-y-4 ${SERIES}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1"><Plug className="w-3.5 h-3.5" />
          {connected ? <>Ligado como <b className="text-foreground">{data.connection.accountEmail ?? "?"}</b></> : data.connection.status === "reauth_required" ? "Precisa de ser religado (Críticas)" : "Não ligado — liga em Críticas"}
        </span>
        <span>Última recolha completa: {data.lastSuccessAt ? fmtPTDateTime(data.lastSuccessAt) : "nunca"}</span>
        <span>Dados de {fmtDay(data.coverage.from)} a {fmtDay(data.coverage.to)}</span>
        <Link href="/criticas" className="underline inline-flex items-center gap-1"><Star className="w-3.5 h-3.5" />Críticas</Link>
        {canEdit && (
          <>
            <Button variant="ghost" size="sm" className="h-7 px-2" disabled={runNow.isPending || !connected} onClick={() => runNow.mutate()}>
              {runNow.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 mr-1" />}Atualizar agora
            </Button>
            <Button variant="ghost" size="sm" className="h-7 px-2" disabled={test.isPending} onClick={() => test.mutate({ id: "google_business" })}>
              {test.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Plug className="w-3.5 h-3.5 mr-1" />}Testar APIs
            </Button>
            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setSettingsOpen(true)}><Settings className="w-3.5 h-3.5 mr-1" />Configurar</Button>
          </>
        )}
      </div>
      {testResult && (
        <div role="status" className={`rounded-md border px-3 py-2 text-xs whitespace-pre-line ${testResult.ok ? "border-emerald-200 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200" : "border-rose-300 bg-rose-50 text-rose-900 dark:bg-rose-950/40 dark:text-rose-200"}`}>
          {testResult.message}
        </div>
      )}
      {problem && (
        <div role="alert" className="rounded-md border border-rose-300 bg-rose-50 text-rose-900 dark:bg-rose-950/40 dark:text-rose-200 px-3 py-2 text-xs flex items-start gap-2">
          <CircleAlert className="w-4 h-4 shrink-0 mt-0.5" /><span className="whitespace-pre-line"><b>Google Business Profile:</b> {problem} <span className="text-muted-foreground">(passo a passo: pergunta ao Assistente "Google Business Profile")</span></span>
        </div>
      )}
      {!data.enabled && <p className="text-xs text-muted-foreground">A recolha do desempenho está desligada (Configurar).</p>}

      <div className="flex flex-wrap items-center gap-2">
        <Select value={city || "all"} onValueChange={(v) => { setCity(v === "all" ? "" : (v as CityKey)); setLocationId(0); }}>
          <SelectTrigger className="h-9 w-[150px]" aria-label="Cidade"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas as cidades</SelectItem>
            {data.cities.map((c) => <SelectItem key={c} value={c}>{CITY_LABELS[c]}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={String(locationId || "all")} onValueChange={(v) => setLocationId(v === "all" ? 0 : Number(v))}>
          <SelectTrigger className="h-9 w-[240px]" aria-label="Perfil"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os perfis ({locOptions.filter((l) => l.active).length})</SelectItem>
            {locOptions.map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.title}{l.active ? "" : " (desligado)"}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {data.alerts?.alerts?.length ? (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-amber-600" /> Alertas de {fmtDay(data.alerts.day)} ({data.alerts.alerts.length})</CardTitle></CardHeader>
          <CardContent className="space-y-1.5">
            {data.alerts.alerts.slice(0, 10).map((a: any) => (
              <div key={a.key} className={`rounded-md border px-3 py-1.5 text-xs ${a.level === "critical" ? "border-rose-200 bg-rose-50 text-rose-900 dark:bg-rose-950/30 dark:text-rose-200" : "border-amber-200 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200"}`}>
                <b>{a.level === "critical" ? "Crítico: " : "Atenção: "}{a.title}</b> — {a.detail}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Kpi icon={Eye} label="Impressões (Pesquisa + Maps)" value={num(gbpImpressions(t.cur))} cur={gbpImpressions(t.cur)} prev={gbpImpressions(t.prev)}
          hint={`Maps ${num(t.cur.impDesktopMaps + t.cur.impMobileMaps)} · Pesquisa ${num(t.cur.impDesktopSearch + t.cur.impMobileSearch)}`} />
        <Kpi icon={Phone} label="Chamadas" value={num(t.cur.callClicks)} cur={t.cur.callClicks} prev={t.prev.callClicks} />
        <Kpi icon={Navigation} label="Pedidos de direções" value={num(t.cur.directionRequests)} cur={t.cur.directionRequests} prev={t.prev.directionRequests} />
        <Kpi icon={MousePointerClick} label="Cliques no site" value={num(t.cur.websiteClicks)} cur={t.cur.websiteClicks} prev={t.prev.websiteClicks}
          hint={t.cur.conversations || t.cur.bookings ? `${num(t.cur.conversations)} conversas · ${num(t.cur.bookings)} marcações` : undefined} />
        <Kpi icon={Star} label="Média das críticas" value={stars(rv.cur.avgRating)} cur={rv.cur.avgRating} prev={rv.prev.avgRating} abs={(d) => `${d > 0 ? "+" : "−"}${num(Math.abs(d), 2)}★`} hint={`${num(rv.cur.count)} críticas`} />
        <Kpi icon={Star} label="Críticas novas" value={num(rv.cur.count)} cur={rv.cur.count} prev={rv.prev.count} />
        <Kpi icon={Reply} label="Taxa de resposta" value={pctOf(rv.cur.responseRate, 0)} cur={rv.cur.responseRate} prev={rv.prev.responseRate} />
        <Kpi icon={Clock} label="Tempo de resposta (mediana)" value={hoursFmt(rv.cur.medianResponseHours)} cur={rv.cur.medianResponseHours} prev={rv.prev.medianResponseHours} invert />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-sm">Impressões por dia</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={230}>
              <ComposedChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--border)" />
                <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
                <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={44} allowDecimals={false} />
                <Tooltip contentStyle={CHART_TOOLTIP_STYLE} itemStyle={CHART_TOOLTIP_ITEM} />
                <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span className="text-foreground">{v}</span>} />
                <Bar dataKey="impSearch" name="Pesquisa" stackId="i" fill="var(--wb-1)" maxBarSize={20} />
                <Bar dataKey="impMaps" name="Maps" stackId="i" fill="var(--wb-2)" radius={[4, 4, 0, 0]} maxBarSize={20} />
                <Line type="monotone" dataKey="prevImpressions" name={`Total (${compareLabel})`} stroke="var(--muted-foreground)" strokeDasharray="5 3" dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-sm">Chamadas, direções e cliques no site por dia</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={230}>
              <ComposedChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--border)" />
                <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
                <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={36} allowDecimals={false} />
                <Tooltip contentStyle={CHART_TOOLTIP_STYLE} itemStyle={CHART_TOOLTIP_ITEM} />
                <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span className="text-foreground">{v}</span>} />
                <Line type="monotone" dataKey="calls" name="Chamadas" stroke="var(--wb-1)" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="directions" name="Direções" stroke="var(--wb-2)" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="website" name="Site" stroke="var(--wb-3)" strokeWidth={2} strokeDasharray="5 3" dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
            <p className="text-[11px] text-muted-foreground">Os últimos 2–3 dias ainda podem acertar (a Google atualiza com atraso).</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Perfis ({data.locations.length})</CardTitle></CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table className={`tabular-nums ${STICKY_FIRST_COL}`}>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[200px]">Perfil</TableHead>
                <TableHead className="text-right">Impressões</TableHead>
                <TableHead className="text-right">Chamadas</TableHead>
                <TableHead className="text-right">Direções</TableHead>
                <TableHead className="text-right">Site</TableHead>
                <TableHead className="text-right">Críticas</TableHead>
                <TableHead>Estado</TableHead>
                {canEdit && <TableHead className="text-right">Gerir</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {!data.locations.length && <TableRow><TableCell colSpan={8} className="text-center py-6 text-muted-foreground">{connected ? "Sem perfis — carrega em \"Atualizar perfis\" nas Críticas ou verifica a associação (Configurar)." : "Liga o Google Business Profile nas Críticas."}</TableCell></TableRow>}
              {data.locations.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="max-w-[280px]">
                    <div className="text-sm truncate" title={l.title}>{l.title}</div>
                    <div className="text-[11px] text-muted-foreground truncate">
                      {l.city ? CITY_LABELS[l.city as CityKey] : "sem cidade"}{l.brand ? ` · ${GBP_BRAND_LABELS[l.brand as keyof typeof GBP_BRAND_LABELS]}` : ""} · {SOURCE_LABEL[l.mappingSource] ?? l.mappingSource}
                      {l.mapsUri && <> · <a href={l.mapsUri} target="_blank" rel="noreferrer" className="underline inline-flex items-center gap-0.5"><MapPin className="w-3 h-3" />Maps</a></>}
                    </div>
                  </TableCell>
                  <TableCell className="text-right"><div>{num(gbpImpressions(l.cur))}</div><div className="text-[11px]"><Delta cur={gbpImpressions(l.cur)} prev={gbpImpressions(l.prev)} /></div></TableCell>
                  <TableCell className="text-right"><div>{num(l.cur.callClicks)}</div><div className="text-[11px]"><Delta cur={l.cur.callClicks} prev={l.prev.callClicks} /></div></TableCell>
                  <TableCell className="text-right"><div>{num(l.cur.directionRequests)}</div><div className="text-[11px]"><Delta cur={l.cur.directionRequests} prev={l.prev.directionRequests} /></div></TableCell>
                  <TableCell className="text-right">{num(l.cur.websiteClicks)}</TableCell>
                  <TableCell className="text-right text-xs">
                    <div>{stars(l.reviews.avgRating)} · {num(l.reviews.count)}</div>
                    <div className="text-muted-foreground">resp. {pctOf(l.reviews.responseRate, 0)}{l.unanswered?.count ? <span className="text-rose-700 dark:text-rose-300"> · {l.unanswered.count} sem resposta</span> : null}</div>
                  </TableCell>
                  <TableCell><StatusBadges l={l} /></TableCell>
                  {canEdit && (
                    <TableCell className="text-right whitespace-nowrap">
                      <Button variant="ghost" size="sm" className="h-8" onClick={() => setHoursFor(l.id)} aria-label={`Horário de ${l.title}`}><CalendarClock className="w-4 h-4" /></Button>
                      <Button variant="ghost" size="sm" className="h-8" onClick={() => setPostsFor(l.id)} aria-label={`Publicações de ${l.title}`}><Megaphone className="w-4 h-4" /></Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-[11px] text-muted-foreground px-4 py-2">
            Críticas: média, volume e taxa de resposta das críticas do período (as vindas por email contam no perfil do mesmo parque). Responder é em <Link href="/criticas" className="underline">Críticas</Link>.
          </p>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-sm">Críticas por semana</CardTitle></CardHeader>
          <CardContent>
            {!weeks.length ? <p className="text-xs text-muted-foreground">Sem críticas no período.</p> : (
              <ResponsiveContainer width="100%" height={210}>
                <ComposedChart data={weeks} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--border)" />
                  <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} />
                  <YAxis yAxisId="c" tick={AXIS_TICK} tickLine={false} axisLine={false} width={32} allowDecimals={false} />
                  <YAxis yAxisId="a" orientation="right" domain={[1, 5]} tick={AXIS_TICK} tickLine={false} axisLine={false} width={28} />
                  <Tooltip contentStyle={CHART_TOOLTIP_STYLE} itemStyle={CHART_TOOLTIP_ITEM} />
                  <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span className="text-foreground">{v}</span>} />
                  <Bar yAxisId="c" dataKey="count" name="Críticas" fill="var(--wb-1)" fillOpacity={0.4} radius={[4, 4, 0, 0]} maxBarSize={22} />
                  <Line yAxisId="a" type="monotone" dataKey="avg" name="Média ★" stroke="var(--wb-3)" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
            )}
            <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground mt-1">
              {([5, 4, 3, 2, 1] as const).map((s) => <span key={s}>{s}★ {num(rv.cur.distribution[s])}</span>)}
            </div>
          </CardContent>
        </Card>
        <KeywordsTable range={range} city={city} locationId={locationId} />
      </div>

      {hoursFor != null && <HoursDialog locationId={hoursFor} locations={data.allLocations} onClose={() => setHoursFor(null)} />}
      {postsFor != null && <PostsDialog locationId={postsFor} locations={data.allLocations} onClose={() => setPostsFor(null)} />}
      {settingsOpen && <GbpSettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

// ─── Pesquisas ──────────────────────────────────────────────────────────────

function KeywordsTable({ range, city, locationId }: { range: Range; city: string; locationId: number }) {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => setPage(1), [range.from, range.to, city, locationId]);
  const pageSize = 15;
  const { data, isLoading, isFetching } = trpc.marketing.gbp.keywords.useQuery(
    { from: range.from, to: range.to, city: city as any, ...(locationId ? { locationId } : {}), page, pageSize, ...(term ? { search: term } : {}) },
    { placeholderData: keepPreviousData });
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <Card>
      <CardHeader className="pb-2 space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm">Pesquisas que mostraram os perfis</CardTitle>
          <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); setTerm(q.trim()); setPage(1); }}>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Procurar…" className="h-8 w-36" aria-label="Procurar pesquisas" />
            <Button type="submit" variant="outline" size="sm" className="h-8" aria-label="Procurar"><Search className="w-3.5 h-3.5" /></Button>
          </form>
        </div>
        {data && <p className="text-[11px] text-muted-foreground">Meses completos {data.fromMonth === data.toMonth ? data.fromMonth : `${data.fromMonth} a ${data.toMonth}`} (a Google dá as pesquisas por mês).</p>}
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <Table className="tabular-nums">
          <TableHeader><TableRow><TableHead>Pesquisa</TableHead><TableHead className="text-right">Impressões</TableHead></TableRow></TableHeader>
          <TableBody>
            {isLoading && <TableRow><TableCell colSpan={2} className="text-center py-6"><Loader2 className="w-4 h-4 animate-spin inline" /></TableCell></TableRow>}
            {!isLoading && !data?.rows.length && <TableRow><TableCell colSpan={2} className="text-center py-6 text-muted-foreground">Sem pesquisas nos meses do período.</TableCell></TableRow>}
            {data?.rows.map((r) => (
              <TableRow key={r.keyword}>
                <TableCell className="text-sm max-w-[260px] truncate" title={r.keyword}>{r.keyword}</TableCell>
                <TableCell className="text-right text-sm">{r.impressions ? num(r.impressions) : ""}{r.hidden ? <span className="text-muted-foreground">{r.impressions ? " + " : ""}&lt; 15{r.hidden > 1 ? ` ×${r.hidden}` : ""}</span> : null}</TableCell>
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

// ─── Escolher perfis (aplicar a vários) ─────────────────────────────────────

function LocationPicker({ locations, selected, onChange }: { locations: Array<{ id: number; title: string; city: string | null; active: boolean }>; selected: number[]; onChange: (ids: number[]) => void }) {
  const toggle = (id: number, on: boolean) => onChange(on ? Array.from(new Set([...selected, id])) : selected.filter((x) => x !== id));
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-medium">Aplicar a {selected.length} perfil(is)</span>
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={() => onChange(locations.filter((l) => l.active).map((l) => l.id))}>Todos</Button>
        {CITY_KEYS.filter((c) => locations.some((l) => l.city === c)).map((c) => (
          <Button key={c} type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={() => onChange(locations.filter((l) => l.active && l.city === c).map((l) => l.id))}>{CITY_LABELS[c]}</Button>
        ))}
      </div>
      <div className="max-h-32 overflow-y-auto rounded border p-2 grid sm:grid-cols-2 gap-1">
        {locations.map((l) => (
          <label key={l.id} className="flex items-center gap-2 text-xs min-h-[28px]">
            <Checkbox checked={selected.includes(l.id)} onCheckedChange={(v) => toggle(l.id, !!v)} aria-label={l.title} />
            <span className="truncate">{l.title}{l.city ? ` · ${CITY_LABELS[l.city as CityKey]}` : ""}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function ResultsList({ results }: { results: Array<{ locationId: number; title: string; ok: boolean; error: string | null }> }) {
  return (
    <ul className="text-xs space-y-1" aria-live="polite">
      {results.map((r) => (
        <li key={r.locationId} className={r.ok ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300 whitespace-pre-line"}>{r.ok ? "✓" : "✗"} {r.title}{r.error ? ` — ${r.error}` : ""}</li>
      ))}
    </ul>
  );
}

// ─── Horários ───────────────────────────────────────────────────────────────

function IntervalsEditor({ intervals, onChange, label }: { intervals: Array<{ open: string; close: string }>; onChange: (v: Array<{ open: string; close: string }>) => void; label: string }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {intervals.map((iv, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          <Input type="time" className="h-8 w-[104px]" value={iv.open} aria-label={`${label}: abre`} onChange={(e) => onChange(intervals.map((x, j) => (j === i ? { ...x, open: e.target.value } : x)))} />
          <span className="text-xs">–</span>
          <Input type="time" className="h-8 w-[104px]" value={iv.close === "24:00" ? "23:59" : iv.close} aria-label={`${label}: fecha`} onChange={(e) => onChange(intervals.map((x, j) => (j === i ? { ...x, close: e.target.value === "23:59" ? "24:00" : e.target.value } : x)))} />
          <Button type="button" variant="ghost" size="sm" className="h-8 px-1" aria-label="Remover intervalo" onClick={() => onChange(intervals.filter((_, j) => j !== i))}><Trash2 className="w-3.5 h-3.5" /></Button>
        </span>
      ))}
      {intervals.length < 6 && <Button type="button" variant="outline" size="sm" className="h-8 px-2" onClick={() => onChange([...intervals, { open: "09:00", close: "18:00" }])}><Plus className="w-3.5 h-3.5" /></Button>}
    </div>
  );
}

function HoursDialog({ locationId, locations, onClose }: { locationId: number; locations: Array<{ id: number; title: string; city: string | null; active: boolean }>; onClose: () => void }) {
  const loc = locations.find((l) => l.id === locationId);
  const q = trpc.marketing.gbp.hours.get.useQuery({ locationId }, { retry: false });
  const utils = trpc.useUtils();
  const [regular, setRegular] = useState<DayHours[] | null>(null);
  const [special, setSpecial] = useState<SpecialDay[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [applyRegular, setApplyRegular] = useState(false);
  const [targets, setTargets] = useState<number[]>([locationId]);
  const [confirm, setConfirm] = useState(false);
  const today = lisbonDay();
  useEffect(() => { if (q.data) { setRegular(q.data.regular); setSpecial(q.data.special.filter((d) => d.date >= today)); } }, [q.data, today]);
  const apply = trpc.marketing.gbp.hours.save.useMutation({
    onSuccess: (r) => { r.ok ? toast.success("Horário atualizado no Google.") : toast.error("Alguns perfis falharam — ver a lista."); utils.marketing.gbp.hours.get.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const original = new Set((q.data?.special ?? []).map((d) => d.date));
  const changedSpecial = special.filter((d) => {
    const o = q.data?.special.find((x) => x.date === d.date);
    return !o || JSON.stringify(o) !== JSON.stringify(d) || targets.length > 1;
  });
  const setDay = (i: number, patch: Partial<DayHours>) => setRegular((w) => (w ? w.map((d, j) => (j === i ? { ...d, ...patch } : d)) : w));
  const nothing = !applyRegular && !changedSpecial.length && !removed.length;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><CalendarClock className="w-4 h-4" />Horário — {loc?.title}</DialogTitle>
          <DialogDescription>Lido agora do Google. As alterações vão diretamente para o perfil (a Google pode demorar a mostrar e às vezes pede revisão).</DialogDescription>
        </DialogHeader>
        {q.isLoading && <Loader2 className="w-5 h-5 animate-spin" />}
        {q.error && <p role="alert" className="text-sm text-destructive whitespace-pre-line">{q.error.message}</p>}
        {q.data && regular && (
          <div className="space-y-4 text-sm">
            {(q.data.hasPendingEdits || q.data.hasGoogleUpdated) && (
              <p className="text-xs rounded border border-amber-200 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200 px-2 py-1">
                {q.data.hasPendingEdits ? "Há edições pendentes de aprovação da Google. " : ""}{q.data.hasGoogleUpdated ? "A Google alterou dados deste perfil — revê em business.google.com." : ""}
              </p>
            )}
            <div className="space-y-2">
              <label className="flex items-center gap-2 font-medium"><Switch checked={applyRegular} onCheckedChange={setApplyRegular} />Alterar o horário normal</label>
              <div className={`space-y-1 ${applyRegular ? "" : "opacity-60 pointer-events-none"}`} aria-disabled={!applyRegular}>
                {regular.map((d, i) => (
                  <div key={d.day} className="flex flex-wrap items-center gap-2">
                    <span className="w-16 text-xs">{WEEKDAY_LABELS[d.day]}</span>
                    <Select value={d.mode} onValueChange={(v) => setDay(i, { mode: v as DayHours["mode"], intervals: v === "intervals" && !d.intervals.length ? [{ open: "09:00", close: "18:00" }] : d.intervals })}>
                      <SelectTrigger className="h-8 w-[130px]" aria-label={`${WEEKDAY_LABELS[d.day]}: tipo`}><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="intervals">Aberto</SelectItem><SelectItem value="open24">24 horas</SelectItem><SelectItem value="closed">Fechado</SelectItem></SelectContent>
                    </Select>
                    {d.mode === "intervals" && <IntervalsEditor intervals={d.intervals} label={WEEKDAY_LABELS[d.day]} onChange={(v) => setDay(i, { intervals: v })} />}
                  </div>
                ))}
                <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setRegular(WEEKDAYS.map((day) => ({ day, mode: "open24", intervals: [] })))}>Todos os dias 24 horas</Button>
              </div>
            </div>
            <div className="space-y-2">
              <div className="font-medium">Horários especiais (feriados, fechos)</div>
              <p className="text-[11px] text-muted-foreground">Só os dias indicados mudam; os outros horários especiais de cada perfil ficam. Datas passadas desaparecem sozinhas.</p>
              {special.map((d, i) => (
                <div key={d.date + i} className="flex flex-wrap items-center gap-2">
                  <Input type="date" className="h-8 w-[150px]" min={today} value={d.date} aria-label="Data" onChange={(e) => setSpecial(special.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))} />
                  <label className="flex items-center gap-1 text-xs"><Switch checked={d.closed} onCheckedChange={(v) => setSpecial(special.map((x, j) => (j === i ? { ...x, closed: v, intervals: v ? [] : x.intervals.length ? x.intervals : [{ open: "09:00", close: "18:00" }] } : x)))} />Fechado</label>
                  {!d.closed && <IntervalsEditor intervals={d.intervals} label={d.date} onChange={(v) => setSpecial(special.map((x, j) => (j === i ? { ...x, intervals: v } : x)))} />}
                  <Button type="button" variant="ghost" size="sm" className="h-8 px-1" aria-label="Retirar este dia" onClick={() => { if (original.has(d.date)) setRemoved([...removed, d.date]); setSpecial(special.filter((_, j) => j !== i)); }}><Trash2 className="w-3.5 h-3.5" /></Button>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={() => setSpecial([...special, { date: today, closed: true, intervals: [] }])}><Plus className="w-4 h-4 mr-1" />Adicionar dia</Button>
              {removed.length > 0 && <p className="text-[11px] text-muted-foreground">A retirar: {removed.join(", ")}</p>}
            </div>
            <LocationPicker locations={locations} selected={targets} onChange={(ids) => setTargets(ids.length ? ids : [locationId])} />
            {apply.data && <ResultsList results={apply.data.results} />}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Fechar</Button>
          <Button disabled={!q.data || nothing || apply.isPending} onClick={() => setConfirm(true)}>{apply.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}Aplicar no Google…</Button>
        </DialogFooter>
      </DialogContent>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Alterar o horário em {targets.length} perfil(is) Google?</AlertDialogTitle>
            <AlertDialogDescription>
              {applyRegular ? "O horário normal é substituído pelo que definiste. " : ""}
              {changedSpecial.length ? `Horários especiais: ${changedSpecial.map((d) => d.date).join(", ")}. ` : ""}
              {removed.length ? `A retirar: ${removed.join(", ")}. ` : ""}
              Os clientes veem a mudança no Google Maps e na Pesquisa. Fica no registo de atividade.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => apply.mutate({ locationIds: targets, regular: applyRegular ? regular : null, special: changedSpecial, removeSpecial: removed })}>Aplicar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

// ─── Publicações ────────────────────────────────────────────────────────────

const EMPTY_POST = { topicType: "STANDARD" as PostTopic, summary: "", ctaType: "" as "" | (typeof POST_CTAS)[number], ctaUrl: "", imageUrl: "", eventTitle: "", startDate: "", endDate: "", startTime: "", endTime: "", couponCode: "", redeemUrl: "", terms: "" };

function PostsDialog({ locationId, locations, onClose }: { locationId: number; locations: Array<{ id: number; title: string; city: string | null; active: boolean }>; onClose: () => void }) {
  const loc = locations.find((l) => l.id === locationId);
  const utils = trpc.useUtils();
  const list = trpc.marketing.gbp.posts.list.useQuery({ locationId }, { retry: false });
  const [post, setPost] = useState({ ...EMPTY_POST });
  const [targets, setTargets] = useState<number[]>([locationId]);
  const [topic, setTopic] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [toDelete, setToDelete] = useState<string | null>(null);
  const create = trpc.marketing.gbp.posts.create.useMutation({
    onSuccess: (r) => { if (r.ok) { toast.success("Publicado no Google."); setPost({ ...EMPTY_POST }); } else toast.error("Alguns perfis falharam — ver a lista."); utils.marketing.gbp.posts.list.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.marketing.gbp.posts.remove.useMutation({
    onSuccess: () => { toast.success("Publicação apagada."); utils.marketing.gbp.posts.list.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const draft = trpc.marketing.gbp.posts.draft.useMutation({
    onSuccess: (r) => { if (r.text) setPost((p) => ({ ...p, summary: r.text! })); else toast.message(r.skipped === "disabled" ? "IA desligada (interruptor \"IA: rascunho de publicações\" ou Configurar)." : r.skipped === "budget" ? "Orçamento da IA atingido este mês." : "A IA não respondeu — escreve o texto à mão."); },
    onError: (e) => toast.error(e.message),
  });
  const set = (patch: Partial<typeof post>) => setPost((p) => ({ ...p, ...patch }));
  const needsEvent = post.topicType !== "STANDARD";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Megaphone className="w-4 h-4" />Publicações — {loc?.title}</DialogTitle>
          <DialogDescription>Novidades, ofertas e eventos que aparecem no perfil Google. Publicar pede confirmação e fica no registo de atividade.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="space-y-1">
            <div className="font-medium">Publicadas neste perfil</div>
            {list.isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
            {list.error && <p role="alert" className="text-xs text-destructive whitespace-pre-line">{list.error.message}</p>}
            {list.data && !list.data.posts.length && <p className="text-xs text-muted-foreground">Nenhuma publicação.</p>}
            <ul className="space-y-1">
              {list.data?.posts.map((p) => (
                <li key={p.name} className="rounded border px-2 py-1 text-xs flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap gap-1 items-center">
                      <Badge variant="outline" className="font-normal">{POST_TOPIC_LABELS[p.topicType as PostTopic] ?? p.topicType}</Badge>
                      {p.state && p.state !== "LIVE" && <Badge variant="outline" className="font-normal">{p.state === "PROCESSING" ? "Em processamento" : p.state === "REJECTED" ? "Recusada" : p.state}</Badge>}
                      <span className="text-muted-foreground">{p.createTime ? fmtPTDateTime(p.createTime) : ""}</span>
                      {p.searchUrl && <a href={p.searchUrl} target="_blank" rel="noreferrer" className="underline inline-flex items-center gap-0.5">ver <ExternalLink className="w-3 h-3" /></a>}
                    </div>
                    <p className="line-clamp-2">{p.summary}</p>
                  </div>
                  <Button variant="ghost" size="sm" className="h-7 px-1" aria-label="Apagar publicação" onClick={() => setToDelete(p.name)}><Trash2 className="w-3.5 h-3.5" /></Button>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-lg border p-3 space-y-3">
            <div className="font-medium">Nova publicação</div>
            <div className="flex flex-wrap gap-2">
              <Select value={post.topicType} onValueChange={(v) => set({ topicType: v as PostTopic })}>
                <SelectTrigger className="h-9 w-[140px]" aria-label="Tipo"><SelectValue /></SelectTrigger>
                <SelectContent>{POST_TOPICS.map((t) => <SelectItem key={t} value={t}>{POST_TOPIC_LABELS[t]}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={post.ctaType || "none"} onValueChange={(v) => set({ ctaType: v === "none" ? "" : (v as any), ...(v === "CALL" ? { ctaUrl: "" } : {}) })}>
                <SelectTrigger className="h-9 w-[150px]" aria-label="Botão"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sem botão</SelectItem>
                  {POST_CTAS.map((c) => <SelectItem key={c} value={c}>{POST_CTA_LABELS[c]}</SelectItem>)}
                </SelectContent>
              </Select>
              {post.ctaType && post.ctaType !== "CALL" && <Input className="h-9 flex-1 min-w-[220px]" placeholder="https://… (página do botão)" aria-label="Endereço do botão" value={post.ctaUrl} onChange={(e) => set({ ctaUrl: e.target.value })} />}
            </div>
            <div className="flex flex-wrap gap-2 items-end">
              <div className="flex-1 min-w-[220px] space-y-1">
                <Label htmlFor="gbp-topic" className="text-xs">Tema para a IA (opcional)</Label>
                <Input id="gbp-topic" className="h-9" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="ex.: parque coberto aberto 24h no Natal, reserve já" />
              </div>
              <Button variant="outline" size="sm" className="h-9" disabled={topic.trim().length < 3 || draft.isPending} onClick={() => draft.mutate({ topic, topicType: post.topicType, cta: post.ctaType, locationId })}>
                {draft.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Sparkles className="w-4 h-4 mr-1" />}Rascunho IA
              </Button>
            </div>
            <div className="space-y-1">
              <Label htmlFor="gbp-summary" className="text-xs">Texto ({post.summary.length}/{POST_SUMMARY_MAX})</Label>
              <Textarea id="gbp-summary" rows={4} maxLength={POST_SUMMARY_MAX} value={post.summary} onChange={(e) => set({ summary: e.target.value })} />
            </div>
            <Input className="h-9" placeholder="Imagem (opcional): https://…jpg" aria-label="Endereço da imagem" value={post.imageUrl} onChange={(e) => set({ imageUrl: e.target.value })} />
            {needsEvent && (
              <div className="grid gap-2 sm:grid-cols-2">
                <Input className="h-9 sm:col-span-2" placeholder="Título (obrigatório)" aria-label="Título do evento/oferta" maxLength={58} value={post.eventTitle} onChange={(e) => set({ eventTitle: e.target.value })} />
                <label className="text-xs space-y-1">Início<Input type="date" className="h-9" value={post.startDate} onChange={(e) => set({ startDate: e.target.value })} /></label>
                <label className="text-xs space-y-1">Fim<Input type="date" className="h-9" value={post.endDate} onChange={(e) => set({ endDate: e.target.value })} /></label>
                {post.topicType === "EVENT" && (
                  <>
                    <label className="text-xs space-y-1">Hora de início (opcional)<Input type="time" className="h-9" value={post.startTime} onChange={(e) => set({ startTime: e.target.value })} /></label>
                    <label className="text-xs space-y-1">Hora de fim<Input type="time" className="h-9" value={post.endTime} onChange={(e) => set({ endTime: e.target.value })} /></label>
                  </>
                )}
                {post.topicType === "OFFER" && (
                  <>
                    <Input className="h-9" placeholder="Código (opcional)" aria-label="Código da oferta" maxLength={58} value={post.couponCode} onChange={(e) => set({ couponCode: e.target.value })} />
                    <Input className="h-9" placeholder="Resgatar em https://… (opcional)" aria-label="Endereço para resgatar" value={post.redeemUrl} onChange={(e) => set({ redeemUrl: e.target.value })} />
                    <Textarea className="sm:col-span-2" rows={2} placeholder="Termos e condições (opcional)" aria-label="Termos e condições" value={post.terms} onChange={(e) => set({ terms: e.target.value })} />
                  </>
                )}
              </div>
            )}
            <LocationPicker locations={locations} selected={targets} onChange={(ids) => setTargets(ids.length ? ids : [locationId])} />
            {create.data && <ResultsList results={create.data.results} />}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Fechar</Button>
          <Button disabled={!post.summary.trim() || create.isPending} onClick={() => setConfirm(true)}>{create.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}Publicar…</Button>
        </DialogFooter>
      </DialogContent>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publicar em {targets.length} perfil(is) Google?</AlertDialogTitle>
            <AlertDialogDescription>A publicação ({POST_TOPIC_LABELS[post.topicType]}) fica visível no Google Maps e na Pesquisa depois da revisão da Google.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => create.mutate({ locationIds: targets, post })}>Publicar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apagar esta publicação do Google?</AlertDialogTitle>
            <AlertDialogDescription>Deixa de aparecer no perfil. Não se pode desfazer.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (toDelete) remove.mutate({ locationId, name: toDelete }); setToDelete(null); }}>Apagar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

// ─── Definições (associação dos perfis e alertas) ──────────────────────────

function GbpSettingsDialog({ onClose }: { onClose: () => void }) {
  const q = trpc.marketing.gbp.settings.get.useQuery();
  const utils = trpc.useUtils();
  const [cfg, setCfg] = useState<GbpConfig | null>(null);
  useEffect(() => { if (q.data) setCfg(q.data.config); }, [q.data]);
  const save = trpc.marketing.gbp.settings.save.useMutation({
    onSuccess: (r) => { toast.success(r.changed ? "Guardado." : "Sem alterações."); utils.marketing.gbp.invalidate(); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  const setAlert = (k: keyof GbpConfig["alerts"], v: number | boolean) => cfg && setCfg({ ...cfg, alerts: { ...cfg.alerts, [k]: v } });
  const entry = (name: string) => cfg?.locationMap.find((e) => e.locationName === name);
  const setEntry = (name: string, patch: { city?: string; brand?: string; active?: boolean }) => {
    if (!cfg) return;
    const cur = entry(name) ?? { locationName: name, city: "", brand: "", active: true };
    const next = { ...cur, ...patch } as GbpConfig["locationMap"][number];
    const rest = cfg.locationMap.filter((e) => e.locationName !== name);
    setCfg({ ...cfg, locationMap: !next.city && !next.brand && next.active ? rest : [...rest, next] });
  };
  const numIn = (id: string, label: string, v: number, k: keyof GbpConfig["alerts"], suffix?: string) => (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <div className="flex items-center gap-1"><Input id={id} type="number" inputMode="decimal" className="h-9 w-24" value={String(v)} onChange={(e) => setAlert(k, Number(e.target.value))} />{suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}</div>
    </div>
  );
  const onSave = () => {
    if (!cfg) return;
    const r = gbpConfigSchema.safeParse(cfg);
    if (!r.success) { toast.error(r.error.issues.map((i) => i.message).join(" ")); return; }
    save.mutate(cfg as any);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Google Business — definições</DialogTitle>
          <DialogDescription>Cidade/marca de cada perfil (vazio = adivinhado pelo parque associado nas Críticas, pela morada ou pelo título), recolha e alertas.</DialogDescription>
        </DialogHeader>
        {!cfg || !q.data ? <Loader2 className="w-5 h-5 animate-spin" /> : (
          <div className="space-y-4 text-sm">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex items-center gap-2 min-h-[44px]"><Switch checked={cfg.enabled} onCheckedChange={(v) => setCfg({ ...cfg, enabled: v })} />Recolha diária do desempenho</label>
              <label className="flex items-center gap-2 min-h-[44px]"><Switch checked={cfg.keywords} onCheckedChange={(v) => setCfg({ ...cfg, keywords: v })} />Pesquisas mensais</label>
              <label className="flex items-center gap-2 min-h-[44px]"><Switch checked={cfg.aiPostDrafts} onCheckedChange={(v) => setCfg({ ...cfg, aiPostDrafts: v })} />Rascunho de publicações com IA</label>
              <div className="flex items-center gap-2">
                <Label htmlFor="gbp-back" className="text-xs">Histórico na 1.ª recolha</Label>
                <Input id="gbp-back" type="number" className="h-9 w-24" value={String(cfg.backfillDays)} onChange={(e) => setCfg({ ...cfg, backfillDays: Number(e.target.value) })} /><span className="text-xs text-muted-foreground">dias</span>
              </div>
            </div>
            <div className="space-y-1">
              <div className="font-medium">Perfis</div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow><TableHead>Perfil</TableHead><TableHead>Cidade</TableHead><TableHead>Marca</TableHead><TableHead>Ativo</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {q.data.locations.map((l) => {
                      const e = entry(l.locationName);
                      return (
                        <TableRow key={l.id}>
                          <TableCell className="max-w-[240px]"><div className="truncate text-xs" title={l.address ?? ""}>{l.title}</div><div className="text-[11px] text-muted-foreground">{e?.city || e?.brand ? "definido" : `${l.city ? CITY_LABELS[l.city as CityKey] : "—"} (${SOURCE_LABEL[l.mappingSource] ?? l.mappingSource})`}{l.available ? "" : " · indisponível"}</div></TableCell>
                          <TableCell>
                            <Select value={e?.city || "auto"} onValueChange={(v) => setEntry(l.locationName, { city: v === "auto" ? "" : v })}>
                              <SelectTrigger className="h-8 w-[120px]" aria-label={`Cidade de ${l.title}`}><SelectValue /></SelectTrigger>
                              <SelectContent><SelectItem value="auto">Automático</SelectItem>{CITY_KEYS.map((c) => <SelectItem key={c} value={c}>{CITY_LABELS[c]}</SelectItem>)}</SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell>
                            <Select value={e?.brand || "auto"} onValueChange={(v) => setEntry(l.locationName, { brand: v === "auto" ? "" : v })}>
                              <SelectTrigger className="h-8 w-[130px]" aria-label={`Marca de ${l.title}`}><SelectValue /></SelectTrigger>
                              <SelectContent><SelectItem value="auto">Automático</SelectItem>{Object.entries(GBP_BRAND_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell><Switch checked={e ? e.active : true} onCheckedChange={(v) => setEntry(l.locationName, { active: v })} aria-label={`${l.title} ativo`} /></TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>
            <div className="rounded-lg border p-3 space-y-2">
              <label className="flex items-center gap-2 font-medium min-h-[44px]"><Switch checked={cfg.alerts.enabled} onCheckedChange={(v) => setAlert("enabled", v)} />Alertas (1×/dia)</label>
              <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
                {numIn("gbp-a1", "Estrelas: queda (7 dias)", cfg.alerts.ratingDrop, "ratingDrop", "★")}
                {numIn("gbp-a2", "Críticas mínimas (7 dias)", cfg.alerts.ratingMinReviews, "ratingMinReviews")}
                {numIn("gbp-a3", "Sem resposta há mais de", cfg.alerts.unansweredHours, "unansweredHours", "h")}
                {numIn("gbp-a4", "Impressões: queda semanal", cfg.alerts.impressionsDropPct, "impressionsDropPct", "%")}
                {numIn("gbp-a5", "Chamadas: queda semanal", cfg.alerts.callsDropPct, "callsDropPct", "%")}
                {numIn("gbp-a6", "Impressões mínimas (base)", cfg.alerts.minImpressions, "minImpressions", "/sem.")}
                {numIn("gbp-a7", "Chamadas mínimas (base)", cfg.alerts.minCalls, "minCalls", "/sem.")}
              </div>
              <label className="flex items-center gap-2 text-xs min-h-[44px]"><Switch checked={cfg.alerts.profileStatus} onCheckedChange={(v) => setAlert("profileStatus", v)} />Perfil suspenso/sem verificação, fechado, alterado pela Google ou com edições pendentes</label>
              <p className="text-[11px] text-muted-foreground">Estrelas e críticas sem resposta vão para quem gere as Críticas da cidade do perfil ("Críticas Google: alertas"); impressões, chamadas e estado do perfil para o Marketing ("Alertas Google Business").</p>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={!cfg || save.isPending || !q.data?.canEdit} onClick={onSave}>{save.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}Guardar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Negócio: chamadas e direções vs reservas por cidade ───────────────────

export function GbpBusinessCard({ from, to }: { from: string; to: string }) {
  const { data, isLoading } = trpc.marketing.gbp.business.useQuery({ from, to }, { placeholderData: keepPreviousData, retry: false });
  const [city, setCity] = useState<CityKey | null>(null);
  const sel = data?.cities.find((c) => c.city === city) ?? data?.cities[0] ?? null;
  const rows = useMemo(() => (sel?.rows ?? []).map((r) => ({ ...r, label: shortDay(r.day), actions: r.calls + r.directions })), [sel]);
  if (isLoading) return null;
  if (!data || !data.cities.length || data.cities.every((c) => !c.calls && !c.directions)) {
    return <p className="text-[11px] text-muted-foreground">Google Business: sem chamadas/direções no período (liga o Google Business Profile e associa cada perfil a uma cidade).</p>;
  }
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Phone className="w-4 h-4" />Google Business: chamadas e direções vs reservas por cidade</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="overflow-x-auto">
          <Table className="tabular-nums">
            <TableHeader><TableRow><TableHead>Cidade</TableHead><TableHead className="text-right">Chamadas</TableHead><TableHead className="text-right">Direções</TableHead><TableHead className="text-right">Cliques no site</TableHead><TableHead className="text-right">Reservas</TableHead><TableHead className="text-right">(Chamadas + direções) / reserva</TableHead></TableRow></TableHeader>
            <TableBody>
              {data.cities.map((c) => (
                <TableRow key={c.city} className={sel?.city === c.city ? "bg-muted/40" : undefined} onClick={() => setCity(c.city)}>
                  <TableCell><button type="button" className="underline-offset-2 hover:underline">{CITY_LABELS[c.city]}</button></TableCell>
                  <TableCell className="text-right">{num(c.calls)}</TableCell>
                  <TableCell className="text-right">{num(c.directions)}</TableCell>
                  <TableCell className="text-right">{num(c.website)}</TableCell>
                  <TableCell className="text-right">{num(c.bookings)}</TableCell>
                  <TableCell className="text-right">{c.actionsPerBooking == null ? "—" : num(c.actionsPerBooking, 2)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {sel && (
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
              <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={40} allowDecimals={false} />
              <Tooltip contentStyle={CHART_TOOLTIP_STYLE} itemStyle={CHART_TOOLTIP_ITEM} />
              <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span className="text-foreground">{v}</span>} />
              <Bar dataKey="bookings" name={`Reservas (${CITY_LABELS[sel.city]})`} fill="var(--wb-1)" fillOpacity={0.35} radius={[4, 4, 0, 0]} maxBarSize={20} />
              <Line type="monotone" dataKey="calls" name="Chamadas" stroke="var(--wb-2)" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="directions" name="Direções" stroke="var(--wb-3)" strokeWidth={2} strokeDasharray="5 3" dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        )}
        <p className="text-[11px] text-muted-foreground">
          Indicador, não atribuição: ações nos perfis Google (pela cidade de cada perfil) ao lado de todas as reservas criadas no mesmo dia e cidade.
          {data.unmapped ? ` ${data.unmapped} perfil(is) sem cidade ficam de fora (Google Business → Configurar).` : ""}
        </p>
      </CardContent>
    </Card>
  );
}

