// Definições → Integrações → Web & SEO (GA4, Search Console, PageSpeed):
//  - propriedades GA4 e da Search Console por marca, lidas pela conta de
//    serviço (adicionada como Leitor/utilizador em cada uma — sem delegação);
//  - páginas medidas na PageSpeed, hora da recolha diária, histórico inicial,
//    eventos do funil, limiares dos alertas e resumo semanal da IA;
//  - "Testar acesso": diz que propriedades a conta de serviço não consegue ler.
// Só quem gere o módulo Marketing edita (hoje: super admin); sem acesso ao
// Marketing o cartão não aparece.
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { CheckCircle2, CircleAlert, Copy, Globe, Loader2, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { WEB_BRAND_IDS, WEB_BRAND_LABELS, webAnalyticsConfigSchema, type WebAnalyticsConfig, type WebBrand } from "@shared/webAnalytics";
import { fmtPTDateTime } from "@/lib/lisbonTime";

function BrandSelect({ value, onChange, disabled }: { value: string; onChange: (v: "" | WebBrand) => void; disabled?: boolean }) {
  return (
    <Select value={value || "none"} onValueChange={(v) => onChange(v === "none" ? "" : (v as WebBrand))} disabled={disabled}>
      <SelectTrigger className="h-9 w-[140px]" aria-label="Marca"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="none">Sem marca</SelectItem>
        {WEB_BRAND_IDS.map((b) => <SelectItem key={b} value={b}>{WEB_BRAND_LABELS[b]}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

type CheckResult = { serviceAccountEmail: string | null; impersonating: string | null; ga: Array<{ id: string; label: string; ok: boolean; error: string | null }>; sc: Array<{ id: string; label: string; ok: boolean; permissionLevel: string | null; error: string | null }> };

export function WebAnalyticsSettings() {
  const utils = trpc.useUtils();
  const q = trpc.marketing.web.settings.get.useQuery(undefined, { retry: false });
  const [cfg, setCfg] = useState<WebAnalyticsConfig | null>(null);
  const [events, setEvents] = useState("");
  const [check, setCheck] = useState<CheckResult | null>(null);
  useEffect(() => { if (q.data) { setCfg(q.data.config); setEvents(q.data.config.funnelEvents.join(", ")); } }, [q.data]);
  const save = trpc.marketing.web.settings.save.useMutation({
    onSuccess: (r) => { toast.success(r.changed ? "Guardado." : "Sem alterações."); utils.marketing.web.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const test = trpc.marketing.web.settings.check.useMutation({ onSuccess: (r) => setCheck(r as CheckResult), onError: (e) => toast.error(e.message) });
  const runNow = trpc.marketing.web.settings.runNow.useMutation({
    onSuccess: (r) => {
      utils.marketing.web.invalidate();
      if (r.busy) toast.message("Já está a correr uma recolha.");
      else if (!r.configured) toast.message("Liga a recolha e guarda primeiro.");
      else if (r.errors.length) toast.error(r.errors[0]);
      else toast.success(`Feito: ${r.windows} bloco(s)${r.pagespeed.measured ? `, ${r.pagespeed.measured} medição(ões) PageSpeed` : ""}${r.done ? "" : " — continua na próxima corrida"}.`);
    },
    onError: (e) => toast.error(e.message),
  });
  if (q.error) return null;
  if (q.isLoading || !cfg || !q.data) return <Card><CardContent className="py-4"><Loader2 className="h-4 w-4 animate-spin" /></CardContent></Card>;
  const d = q.data;
  const canEdit = d.canEdit;
  const set = (patch: Partial<WebAnalyticsConfig>) => setCfg({ ...cfg, ...patch });
  const setAlert = (k: keyof WebAnalyticsConfig["alerts"], v: number | boolean) => setCfg({ ...cfg, alerts: { ...cfg.alerts, [k]: v } });
  const onSave = () => {
    const value = { ...cfg, funnelEvents: events.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean) };
    const r = webAnalyticsConfigSchema.safeParse(value);
    if (!r.success) { toast.error(r.error.issues.map((i) => i.message).join(" ")); return; }
    save.mutate(value as any);
  };
  const copyEmail = () => { if (d.serviceAccountEmail) navigator.clipboard?.writeText(d.serviceAccountEmail).then(() => toast.success("Email copiado."), () => undefined); };
  const numInput = (id: string, label: string, value: number, onChange: (n: number) => void, suffix?: string) => (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <div className="flex items-center gap-1">
        <Input id={id} type="number" inputMode="decimal" className="h-9 w-24" value={String(value)} disabled={!canEdit} onChange={(e) => onChange(Number(e.target.value))} />
        {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
      </div>
    </div>
  );
  const lastRun: any = d.lastRun;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          <Globe className="h-4 w-4 text-primary" /> Web & SEO — Google Analytics 4, Search Console e PageSpeed
          <Badge variant="outline" className={cfg.enabled ? "bg-emerald-100 text-emerald-800 border-emerald-200" : "bg-muted text-secondary-foreground"}>{cfg.enabled ? "Ligado" : "Desligado"}</Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Totais diários (sem dados de pessoas) para o <Link href="/marketing/web" className="underline">Marketing → Web & SEO</Link>: recolha 1×/dia a partir da hora indicada
          (1.ª vez: histórico dos últimos {cfg.backfillDays} dias), PageSpeed 1×/semana e alertas por notificação.
        </p>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {/* Conta de serviço */}
        <div className="rounded-lg border p-3 space-y-2">
          {!d.serviceAccount ? (
            <p className="text-xs text-amber-800 dark:text-amber-200">Conta de serviço em falta no servidor (GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON).</p>
          ) : (
            <div className="text-xs space-y-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-muted-foreground">Conta de serviço:</span>
                <span className="font-mono break-all">{d.serviceAccountEmail}</span>
                <Button variant="ghost" size="sm" className="h-7 px-2" onClick={copyEmail} aria-label="Copiar email"><Copy className="w-3.5 h-3.5" /></Button>
              </div>
              <p className="text-muted-foreground">
                Adiciona este email como <b>Leitor</b> em cada propriedade GA4 (Administração → Gestão de acesso à propriedade) e como utilizador <b>Restrito</b> em cada propriedade da
                Search Console (Definições → Utilizadores e autorizações). No Google Cloud do projeto da conta de serviço ativa "Google Analytics Data API", "Google Search Console API" e "PageSpeed Insights API".
              </p>
              <p className="text-muted-foreground">PageSpeed: {d.pagespeedKey ? "com chave (GOOGLE_PAGESPEED_API_KEY)." : "sem chave — funciona com quota baixa; recomenda-se GOOGLE_PAGESPEED_API_KEY."}</p>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={!canEdit || test.isPending || !d.serviceAccount} onClick={() => test.mutate()}>
              {test.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <ShieldCheck className="w-4 h-4 mr-1" />}Testar acesso
            </Button>
            <Button variant="outline" size="sm" disabled={!canEdit || runNow.isPending} onClick={() => runNow.mutate()}>
              {runNow.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1" />}Recolher agora
            </Button>
          </div>
          {check && (
            <ul className="text-xs space-y-1" aria-live="polite">
              {[...check.ga.map((x) => ({ ...x, kind: "GA4" })), ...check.sc.map((x) => ({ ...x, kind: "Search Console" }))].map((x) => (
                <li key={`${x.kind}:${x.id}`} className="flex items-start gap-1.5">
                  {x.ok ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" /> : <CircleAlert className="w-3.5 h-3.5 text-rose-600 shrink-0 mt-0.5" />}
                  <span><b>{x.kind}</b> {x.label || x.id}: {x.ok ? "acesso OK" : <>sem acesso — {x.error} <span className="text-muted-foreground">(adiciona {check.impersonating ?? check.serviceAccountEmail})</span></>}</span>
                </li>
              ))}
              {!check.ga.length && !check.sc.length && <li className="text-muted-foreground">Nenhuma propriedade configurada (guarda primeiro).</li>}
            </ul>
          )}
          {lastRun && (
            <p className="text-[11px] text-muted-foreground">
              Última corrida: {fmtPTDateTime(lastRun.at)} — {lastRun.ok ? (lastRun.done ? "OK" : "OK, a continuar") : `com erro: ${lastRun.errors?.[0] ?? ""}`}
              {lastRun.warnings?.length ? ` · ${lastRun.warnings[0]}` : ""}
            </p>
          )}
        </div>

        <label className="flex items-center gap-3 min-h-[44px]">
          <Switch checked={cfg.enabled} disabled={!canEdit} onCheckedChange={(v) => set({ enabled: v })} />
          <span>Recolha diária ligada</span>
        </label>

        {/* GA4 */}
        <div className="space-y-2">
          <div className="font-medium">Propriedades Google Analytics 4</div>
          <p className="text-[11px] text-muted-foreground">ID numérico da propriedade (GA4 → Administração → Detalhes da propriedade), ex.: 123456789.</p>
          {cfg.ga4Properties.map((p, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Input className="h-9 w-36 font-mono" placeholder="123456789" aria-label="ID da propriedade GA4" value={p.propertyId} disabled={!canEdit}
                onChange={(e) => set({ ga4Properties: cfg.ga4Properties.map((x, j) => (j === i ? { ...x, propertyId: e.target.value } : x)) })} />
              <Input className="h-9 w-48" placeholder="Nome (ex.: multipark.pt)" aria-label="Nome" value={p.label} disabled={!canEdit}
                onChange={(e) => set({ ga4Properties: cfg.ga4Properties.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
              <BrandSelect value={p.brand} disabled={!canEdit} onChange={(v) => set({ ga4Properties: cfg.ga4Properties.map((x, j) => (j === i ? { ...x, brand: v } : x)) })} />
              <label className="flex items-center gap-1.5 text-xs"><Switch checked={p.active} disabled={!canEdit} onCheckedChange={(v) => set({ ga4Properties: cfg.ga4Properties.map((x, j) => (j === i ? { ...x, active: v } : x)) })} />Ativa</label>
              <Button variant="ghost" size="sm" disabled={!canEdit} aria-label="Remover" onClick={() => set({ ga4Properties: cfg.ga4Properties.filter((_, j) => j !== i) })}><Trash2 className="w-4 h-4" /></Button>
            </div>
          ))}
          <Button variant="outline" size="sm" disabled={!canEdit || cfg.ga4Properties.length >= 20} onClick={() => set({ ga4Properties: [...cfg.ga4Properties, { propertyId: "", label: "", brand: "", active: true }] })}><Plus className="w-4 h-4 mr-1" />Adicionar propriedade GA4</Button>
        </div>

        {/* Search Console */}
        <div className="space-y-2">
          <div className="font-medium">Propriedades da Search Console</div>
          <p className="text-[11px] text-muted-foreground">Domínio (<span className="font-mono">sc-domain:multipark.pt</span>) ou prefixo de URL (<span className="font-mono">https://www.multipark.pt/</span>), exatamente como aparece na Search Console.</p>
          {cfg.searchConsoleSites.map((s, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Input className="h-9 w-64 font-mono" placeholder="sc-domain:multipark.pt" aria-label="Propriedade da Search Console" value={s.siteUrl} disabled={!canEdit}
                onChange={(e) => set({ searchConsoleSites: cfg.searchConsoleSites.map((x, j) => (j === i ? { ...x, siteUrl: e.target.value } : x)) })} />
              <Input className="h-9 w-40" placeholder="Nome" aria-label="Nome" value={s.label} disabled={!canEdit}
                onChange={(e) => set({ searchConsoleSites: cfg.searchConsoleSites.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
              <BrandSelect value={s.brand} disabled={!canEdit} onChange={(v) => set({ searchConsoleSites: cfg.searchConsoleSites.map((x, j) => (j === i ? { ...x, brand: v } : x)) })} />
              <label className="flex items-center gap-1.5 text-xs"><Switch checked={s.active} disabled={!canEdit} onCheckedChange={(v) => set({ searchConsoleSites: cfg.searchConsoleSites.map((x, j) => (j === i ? { ...x, active: v } : x)) })} />Ativa</label>
              <Button variant="ghost" size="sm" disabled={!canEdit} aria-label="Remover" onClick={() => set({ searchConsoleSites: cfg.searchConsoleSites.filter((_, j) => j !== i) })}><Trash2 className="w-4 h-4" /></Button>
            </div>
          ))}
          <Button variant="outline" size="sm" disabled={!canEdit || cfg.searchConsoleSites.length >= 20} onClick={() => set({ searchConsoleSites: [...cfg.searchConsoleSites, { siteUrl: "", label: "", brand: "", active: true }] })}><Plus className="w-4 h-4 mr-1" />Adicionar propriedade</Button>
        </div>

        {/* PageSpeed */}
        <div className="space-y-2">
          <label className="flex items-center gap-3 min-h-[44px] font-medium">
            <Switch checked={cfg.pagespeedEnabled} disabled={!canEdit} onCheckedChange={(v) => set({ pagespeedEnabled: v })} />
            <span>PageSpeed (1×/semana, móvel e computador)</span>
          </label>
          {cfg.pagespeedUrls.map((u, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Input className="h-9 w-72" placeholder="https://multipark.pt/" aria-label="Página" value={u.url} disabled={!canEdit}
                onChange={(e) => set({ pagespeedUrls: cfg.pagespeedUrls.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} />
              <Input className="h-9 w-48" placeholder="Nome" aria-label="Nome" value={u.label} disabled={!canEdit}
                onChange={(e) => set({ pagespeedUrls: cfg.pagespeedUrls.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
              <BrandSelect value={u.brand} disabled={!canEdit} onChange={(v) => set({ pagespeedUrls: cfg.pagespeedUrls.map((x, j) => (j === i ? { ...x, brand: v } : x)) })} />
              <Button variant="ghost" size="sm" disabled={!canEdit} aria-label="Remover" onClick={() => set({ pagespeedUrls: cfg.pagespeedUrls.filter((_, j) => j !== i) })}><Trash2 className="w-4 h-4" /></Button>
            </div>
          ))}
          <Button variant="outline" size="sm" disabled={!canEdit || cfg.pagespeedUrls.length >= 15} onClick={() => set({ pagespeedUrls: [...cfg.pagespeedUrls, { url: "", label: "", brand: "" }] })}><Plus className="w-4 h-4 mr-1" />Adicionar página</Button>
        </div>

        {/* Recolha */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1">
            <Label className="text-xs">Hora da atualização diária (Lisboa)</Label>
            <Select value={String(cfg.refreshHour)} onValueChange={(v) => set({ refreshHour: Number(v) })} disabled={!canEdit}>
              <SelectTrigger className="h-9 w-28" aria-label="Hora"><SelectValue /></SelectTrigger>
              <SelectContent>{Array.from({ length: 24 }, (_, h) => <SelectItem key={h} value={String(h)}>{String(h).padStart(2, "0")}:00</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {numInput("wa-backfill", "Histórico na 1.ª recolha", cfg.backfillDays, (n) => set({ backfillDays: n }), "dias")}
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="wa-events" className="text-xs">Eventos do funil (GA4, separados por vírgulas)</Label>
            <Input id="wa-events" className="h-9" value={events} disabled={!canEdit} onChange={(e) => setEvents(e.target.value)} placeholder="view_item, begin_checkout, add_payment_info, purchase" />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="wa-imp" className="text-xs">Conta a impersonar (opcional, delegação ao nível do domínio)</Label>
            <Input id="wa-imp" type="email" className="h-9" value={cfg.impersonateEmail} disabled={!canEdit} onChange={(e) => set({ impersonateEmail: e.target.value })} placeholder="vazio = a própria conta de serviço (recomendado)" />
          </div>
        </div>

        {/* Alertas */}
        <div className="rounded-lg border p-3 space-y-2">
          <label className="flex items-center gap-3 min-h-[44px] font-medium">
            <Switch checked={cfg.alerts.enabled} disabled={!canEdit} onCheckedChange={(v) => setAlert("enabled", v)} />
            <span>Alertas (notificação "Alertas Web & SEO", 1×/dia)</span>
          </label>
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
            {numInput("wa-a1", "Sessões: queda vs média 7 dias", cfg.alerts.sessionsDropPct, (n) => setAlert("sessionsDropPct", n), "%")}
            {numInput("wa-a2", "Cliques Google: queda semana", cfg.alerts.clicksDropPct, (n) => setAlert("clicksDropPct", n), "%")}
            {numInput("wa-a3", "PageSpeed móvel mínima", cfg.alerts.pagespeedMobileMin, (n) => setAlert("pagespeedMobileMin", n), "/100")}
            {numInput("wa-a4", "Posição: piorar mais de", cfg.alerts.positionDrop, (n) => setAlert("positionDrop", n), "lugares")}
            {numInput("wa-a5", "Pesquisas do top vigiadas", cfg.alerts.positionTopN, (n) => setAlert("positionTopN", n))}
            {numInput("wa-a6", "Sessões mínimas (base)", cfg.alerts.minSessions, (n) => setAlert("minSessions", n), "/dia")}
            {numInput("wa-a7", "Cliques mínimos (base)", cfg.alerts.minClicks, (n) => setAlert("minClicks", n), "/semana")}
          </div>
        </div>

        <label className="flex items-center gap-3 min-h-[44px]">
          <Switch checked={cfg.aiInsight} disabled={!canEdit} onCheckedChange={(v) => set({ aiInsight: v })} />
          <span>Resumo semanal com IA (lite; respeita o interruptor "IA: resumo semanal Web & SEO" e o orçamento — sem IA fica um texto automático)</span>
        </label>

        {canEdit ? (
          <Button onClick={onSave} disabled={save.isPending}>{save.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}Guardar</Button>
        ) : (
          <p className="text-xs text-muted-foreground">Só quem gere o Marketing pode alterar.</p>
        )}
        {d.lastSuccessAt && <p className="text-[11px] text-muted-foreground">Última recolha completa: {fmtPTDateTime(d.lastSuccessAt)}.</p>}
      </CardContent>
    </Card>
  );
}
