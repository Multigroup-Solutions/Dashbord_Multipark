// Página "Definições" (/definicoes) — admin+.
// Estado do sistema (crons), interruptores das automações, integrações,
// parâmetros (IVA/TSU, SLAs, emails, responsável das disponibilidades) com
// auditoria, e segurança (validade das API keys, terminar sessões).
import { useEffect, useMemo, useState } from "react";
import { Link, useSearch } from "wouter";
import { trpc } from "@/lib/trpc";
import { can } from "@shared/access";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { fmtPTDate, fmtPTDateTime } from "@/lib/lisbonTime";
import {
  Activity, AlertTriangle, Bell, CheckCircle2, Clock, KeyRound, Loader2, LogOut, Plug, Plus, RotateCcw,
  Mail, Save, ShieldCheck, SlidersHorizontal, Sparkles, ToggleLeft, Trash2, X, XCircle,
} from "lucide-react";
import { MailboxesSettings } from "@/components/mail/MailboxesSettings";
import { SharedCalendarsSettings } from "@/components/google/SharedCalendarsSettings";
import { GooglePushSettings } from "@/components/google/GooglePushSettings";
import { GoogleContactsSettings } from "@/components/google/GoogleContactsSettings";
import { GoogleDriveSettings } from "@/components/google/GoogleDriveSettings";
import { WebAnalyticsSettings } from "@/components/marketing/WebAnalyticsSettings";
import { AUTOMATION_FLAGS, CRON_SKIP_PROBLEM_DAYS, EXCLUDED_PARKS_SETTING_KEY, FLAG_SETTING_PREFIX, PRESENCE_FICHA_PREFIX, SETTINGS, TERMINAL_AIRPORTS_SETTING_KEY, presenceFichaId, validateSetting, type RateEntry } from "@shared/appSettings";
import { AIRPORT_LABELS, type AirportCityId } from "@shared/pontoTerminal";
import { isMultisAdmin } from "@shared/assistantMemory";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { NotificationRoutingCard } from "@/components/NotificationRoutingCard";
import { ServiceTasksSettings } from "@/components/ServiceTasksSettings";

const TABS = ["estado", "automacoes", "integracoes", "comunicacao", "parametros", "notificacoes", "seguranca"] as const;
type Tab = (typeof TABS)[number];

function useStoredTab(): [Tab, (t: Tab) => void] {
  const search = useSearch();
  const [tab, setTab] = useState<Tab>(() => {
    try {
      // Link direto (?tab=estado — p. ex. os alertas da sincronização) antes do guardado.
      const v = new URLSearchParams(window.location.search).get("tab") ?? sessionStorage.getItem("mp.definicoes.tab");
      return (TABS as readonly string[]).includes(v ?? "") ? (v as Tab) : "estado";
    } catch { return "estado"; }
  });
  // 20b: um link ?tab=… com a página já aberta (ex.: o sino) também muda de separador.
  useEffect(() => {
    const v = new URLSearchParams(search).get("tab");
    if (v && (TABS as readonly string[]).includes(v)) setTab(v as Tab);
  }, [search]);
  return [tab, (t) => { setTab(t); try { sessionStorage.setItem("mp.definicoes.tab", t); } catch { /* sem storage */ } }];
}

export default function DefinicoesPage() {
  const { user } = useAuth();
  const [tab, setTab] = useStoredTab();
  // 20b: pela matriz (módulo "definicoes", com as exceções por pessoa), como o servidor.
  const isAdmin = !!user && can(user as any, "definicoes", "view");
  if (!user) return null;
  if (!isAdmin) {
    return <div className="p-6 text-sm text-muted-foreground">Sem acesso às Definições.</div>;
  }
  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold flex items-center gap-2"><SlidersHorizontal className="h-5 w-5" /> Definições</h1>
        <p className="text-sm text-muted-foreground">Estado do sistema, automações, integrações, caixas de email, parâmetros, notificações e segurança.</p>
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <div className="overflow-x-auto -mx-3 px-3 sm:mx-0 sm:px-0">
          <TabsList className="w-max">
            <TabsTrigger value="estado"><Activity className="h-4 w-4 mr-1" />Estado</TabsTrigger>
            <TabsTrigger value="automacoes"><ToggleLeft className="h-4 w-4 mr-1" />Automações</TabsTrigger>
            <TabsTrigger value="integracoes"><Plug className="h-4 w-4 mr-1" />Integrações</TabsTrigger>
            <TabsTrigger value="comunicacao"><Mail className="h-4 w-4 mr-1" />Comunicação</TabsTrigger>
            <TabsTrigger value="parametros"><SlidersHorizontal className="h-4 w-4 mr-1" />Parâmetros</TabsTrigger>
            <TabsTrigger value="notificacoes"><Bell className="h-4 w-4 mr-1" />Notificações</TabsTrigger>
            <TabsTrigger value="seguranca"><ShieldCheck className="h-4 w-4 mr-1" />Segurança</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="estado" className="space-y-4"><SystemStatusCard />{user.role === "super_admin" && <SchedulerCard />}<AiUsageCard /></TabsContent>
        <TabsContent value="automacoes"><AutomationsCard /></TabsContent>
        <TabsContent value="integracoes" className="space-y-4"><IntegrationsCard /><WebAnalyticsSettings /></TabsContent>
        <TabsContent value="comunicacao" className="space-y-4"><MailboxesSettings /><SharedCalendarsSettings /><GooglePushSettings /><GoogleContactsSettings /><GoogleDriveSettings /></TabsContent>
        <TabsContent value="parametros" className="space-y-4"><ServiceTasksSettings /><ParametersCard /></TabsContent>
        <TabsContent value="notificacoes"><NotificationRoutingCard /></TabsContent>
        <TabsContent value="seguranca"><SecurityCard isSuperAdmin={user.role === "super_admin"} /></TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Estado do sistema ──────────────────────────────────────────────────────

const HEALTH: Record<string, { label: string; cls: string }> = {
  ok: { label: "OK", cls: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  failed: { label: "Falhou", cls: "bg-red-100 text-red-800 border-red-200" },
  stale: { label: "Parado", cls: "bg-amber-100 text-amber-900 border-amber-200" },
  skipping: { label: "Salta há dias", cls: "bg-amber-100 text-amber-900 border-amber-200" },
  never: { label: "Sem registo", cls: "bg-muted text-secondary-foreground" },
  running: { label: "A correr", cls: "bg-blue-100 text-blue-800 border-blue-200" },
  unscheduled: { label: "Sem agenda", cls: "bg-muted text-secondary-foreground" },
};

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1).replace(".", ",")} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}
function fmtInterval(min: number | null): string {
  if (min == null) return "sem agenda";
  if (min < 60) return `a cada ${min} min`;
  if (min < 1440) return min === 60 ? "de hora a hora" : `a cada ${min / 60} h`;
  return "diário";
}
function ago(ts: number | null | undefined, now: number): string {
  if (!ts) return "—";
  const m = Math.round((now - ts) / 60_000);
  if (m < 1) return "agora";
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `há ${h} h` : `há ${Math.round(h / 24)} dias`;
}

function SystemStatusCard() {
  const q = trpc.settings.systemStatus.useQuery(undefined, { refetchInterval: 60_000 });
  const [open, setOpen] = useState<string | null>(null);
  const crons = q.data?.crons ?? [];
  const now = q.data?.now ?? Date.now();
  const problems = crons.filter((c) => c.health === "failed" || c.health === "stale" || c.health === "skipping").length;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          Estado do sistema
          {/* 20b: sem leitura não há "Tudo a correr" */}
          {q.isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : !q.data
            ? <Badge variant="outline" className="bg-amber-100 text-amber-900 border-amber-200">Estado desconhecido</Badge>
            : problems > 0
              ? <Badge variant="outline" className="bg-red-100 text-red-800 border-red-200">{problems} com problemas</Badge>
              : <Badge variant="outline" className="bg-emerald-100 text-emerald-800 border-emerald-200">Tudo a correr</Badge>}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Última corrida de cada cron (agendador /api/cron/tick, chamado pelo cron-job.org de 5 em 5 min; ou à mão). "Parado" = sem corridas há mais de 2× o intervalo esperado (mínimo 30 min). "Salta há dias" = corre mas salta há mais de {CRON_SKIP_PROBLEM_DAYS} dias por falta de configuração ou ligação (interruptor desligado não conta).
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {q.error && <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="o estado dos crons" />}
        {crons.map((c) => {
          const h = HEALTH[c.health] ?? HEALTH.never;
          const bad = c.health === "failed" || c.health === "stale" || c.health === "skipping";
          return (
            <div key={c.name} className={`rounded-lg border p-3 ${bad ? "border-red-300 bg-red-50/60 dark:bg-red-950/20" : "border-border"}`}>
              <button type="button" className="w-full text-left" onClick={() => setOpen(open === c.name ? null : c.name)}>
                <div className="flex items-start gap-2 flex-wrap">
                  <div className="flex-1 min-w-[12rem]">
                    <div className="font-semibold text-sm">{c.label}</div>
                    <div className="text-xs text-muted-foreground font-mono">{c.name} · {fmtInterval(c.intervalMinutes)}</div>
                  </div>
                  <Badge variant="outline" className={h.cls}>{h.label}</Badge>
                </div>
                <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1 text-xs">
                  <div><span className="text-muted-foreground">Última: </span>{c.last ? `${fmtPTDateTime(c.last.startedAt)} (${ago(c.last.startedAt, now)})` : "—"}</div>
                  <div><span className="text-muted-foreground">Duração: </span>{fmtDuration(c.last?.durationMs)}</div>
                  <div><span className="text-muted-foreground">Último OK: </span>{c.lastOkAt ? ago(c.lastOkAt, now) : "—"}<span className="sr-only"> (corridas saltadas não contam)</span></div>
                  <div><span className="text-muted-foreground">24 h: </span>{c.runs24h} corridas{c.failures24h ? <span className="text-red-700 font-semibold"> · {c.failures24h} falhas</span> : null}</div>
                </div>
                {c.last && c.last.ok === false && c.last.error && (
                  <p className="mt-2 text-xs text-red-700 dark:text-red-300 break-words"><XCircle className="inline h-3 w-3 mr-1" />{c.last.error}</p>
                )}
                {c.last && c.last.ok === true && c.last.error && (
                  <p className="mt-2 text-xs text-amber-800 dark:text-amber-300 break-words"><AlertTriangle className="inline h-3 w-3 mr-1" />{c.last.error}</p>
                )}
                {c.health === "skipping" && (
                  <p className="mt-2 text-xs text-amber-800 dark:text-amber-300"><AlertTriangle className="inline h-3 w-3 mr-1" />Corre mas não faz o trabalho há mais de {CRON_SKIP_PROBLEM_DAYS} dias: falta configuração ou ligação (ver a nota acima). Ligar ou configurar resolve; se for de propósito, desliga o interruptor.</p>
                )}
                {c.health === "stale" && (
                  <p className="mt-2 text-xs text-amber-800 dark:text-amber-300"><AlertTriangle className="inline h-3 w-3 mr-1" />Sem corridas há mais de {c.staleAfterMinutes} min — {c.workflow === "tick" || c.workflow === "cron-job.org" ? "verificar o agendador (cron-job.org → /api/cron/tick; ver Ajuda → Agendador)" : `corre só à mão (${c.workflow})`}.</p>
                )}
              </button>
              {open === c.name && (
                <div className="mt-3 border-t pt-2 space-y-1">
                  <div className="text-xs font-semibold">Últimas corridas</div>
                  {c.recent.length === 0 && <p className="text-xs text-muted-foreground">Sem registo.</p>}
                  {c.recent.map((r) => (
                    <div key={r.id} className="text-xs flex flex-wrap gap-x-3">
                      <span>{r.ok === true ? <CheckCircle2 className="inline h-3 w-3 text-emerald-600" /> : r.ok === false ? <XCircle className="inline h-3 w-3 text-red-600" /> : <Clock className="inline h-3 w-3 text-muted-foreground" />}</span>
                      <span>{fmtPTDateTime(r.startedAt)}</span>
                      <span className="text-muted-foreground">{fmtDuration(r.durationMs)}{r.httpStatus ? ` · HTTP ${r.httpStatus}` : ""}{r.meta ? ` · ${r.meta}` : ""}</span>
                      {r.ok === null && <span className="text-muted-foreground">{r.finishedAt ? "" : "sem resposta"}</span>}
                      {r.error && (r.ok === true
                        ? <span className="text-muted-foreground break-all w-full">Nota: {r.error}</span>
                        : <span className="text-red-700 dark:text-red-300 break-all w-full">{r.error}</span>)}
                    </div>
                  ))}
                  {c.lastFailure && c.lastFailure.id !== c.last?.id && (
                    <p className="text-xs text-muted-foreground pt-1">Última falha: {fmtPTDateTime(c.lastFailure.startedAt)} — {c.lastFailure.error ?? "sem detalhe"}</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
              {(q.data?.retired?.length ?? 0) > 0 && (
          <p className="text-[11px] text-muted-foreground">
            Retirados (já não correm; histórico guardado, fora da lista e dos alertas): {q.data!.retired.join(", ")}.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Agendador (/api/cron/tick) — só super admin ────────────────────────────

const JOB_STATUS: Record<string, { label: string; cls: string }> = {
  ok: { label: "OK", cls: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  error: { label: "Erro", cls: "bg-red-100 text-red-800 border-red-200" },
  partial: { label: "A meio (retoma)", cls: "bg-blue-100 text-blue-800 border-blue-200" },
  // 20b: saiu sem fazer o trabalho (interruptor desligado, sem configuração…) — não é "OK".
  skipped: { label: "Saltado", cls: "bg-amber-100 text-amber-900 border-amber-200" },
};

function until(ts: number | null | undefined, now: number): string {
  if (ts == null) return "—";
  if (ts <= now + 30_000) return "agora";
  const m = Math.round((ts - now) / 60_000);
  if (m < 60) return `daqui a ${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `daqui a ${h} h` : `daqui a ${Math.round(h / 24)} dias`;
}

function SchedulerCard() {
  const q = trpc.settings.scheduler.useQuery(undefined, { refetchInterval: 60_000 });
  const jobs = q.data?.jobs ?? [];
  const now = q.data?.now ?? Date.now();
  const errors = jobs.filter((j) => j.lastStatus === "error" || j.abandoned).length;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          <Clock className="h-4 w-4" /> Agendador
          {q.isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : !q.data
            ? <Badge variant="outline" className="bg-amber-100 text-amber-900 border-amber-200">Estado desconhecido</Badge>
            : errors > 0
              ? <Badge variant="outline" className="bg-red-100 text-red-800 border-red-200">{errors} com erro</Badge>
              : <Badge variant="outline" className="bg-emerald-100 text-emerald-800 border-emerald-200">Sem erros</Badge>}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          O cron-job.org chama /api/cron/tick de 5 em 5 min; cada tick corre, um a um, os trabalhos que estão na altura (hora de Lisboa). "A meio" = não coube no tempo e continua no tick seguinte. "Saltado" = correu mas não fez o trabalho (ex.: interruptor desligado) — não conta como "Último OK". Só leitura.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {q.error && <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="o agendador" />}
        {jobs.map((j) => {
          const st = j.lastStatus ? JOB_STATUS[j.lastStatus] : null;
          const bad = j.lastStatus === "error" || j.abandoned;
          return (
            <div key={j.key} className={`rounded-lg border p-3 ${bad ? "border-red-300 bg-red-50/60 dark:bg-red-950/20" : "border-border"}`}>
              <div className="flex items-start gap-2 flex-wrap">
                <div className="flex-1 min-w-[12rem]">
                  <div className="font-semibold text-sm">{j.label}</div>
                  <div className="text-xs text-muted-foreground"><span className="font-mono">{j.key}</span> · {j.cadence}</div>
                </div>
                {j.running && <Badge variant="outline" className="bg-blue-100 text-blue-800 border-blue-200">A correr</Badge>}
                {st
                  ? <Badge variant="outline" className={st.cls}>{st.label}</Badge>
                  : <Badge variant="outline" className="bg-muted text-secondary-foreground">Ainda não correu</Badge>}
              </div>
              <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1 text-xs">
                <div><span className="text-muted-foreground">Última: </span>{j.lastStartedAt ? `${fmtPTDateTime(j.lastStartedAt)} (${ago(j.lastStartedAt, now)})` : "—"}</div>
                <div><span className="text-muted-foreground">Duração: </span>{fmtDuration(j.lastDurationMs)}</div>
                <div><span className="text-muted-foreground">Último OK: </span>{j.lastOkAt ? ago(j.lastOkAt, now) : "—"}</div>
                <div><span className="text-muted-foreground">Próxima: </span>{j.dueNow ? "no próximo tick" : `${until(j.nextDueAt, now)}${j.nextDueAt ? ` (${fmtPTDateTime(j.nextDueAt)})` : ""}`}</div>
              </div>
              {j.periodDone && j.lastStatus !== "skipped" && <p className="mt-1 text-xs text-muted-foreground"><CheckCircle2 className="inline h-3 w-3 mr-1 text-emerald-600" />Feito neste período.</p>}
              {j.periodDone && j.lastStatus === "skipped" && <p className="mt-1 text-xs text-amber-800 dark:text-amber-300"><AlertTriangle className="inline h-3 w-3 mr-1" />Saltado neste período (não volta a tentar até ao seguinte).</p>}
              {j.attempts > 0 && <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">{j.attempts} tentativa(s) falhada(s) neste período (máx. 3, de 30 em 30 min).</p>}
              {j.abandoned && <p className="mt-1 text-xs text-red-700 dark:text-red-300"><XCircle className="inline h-3 w-3 mr-1" />A última corrida não terminou (a função foi terminada a meio).</p>}
              {j.lastError && (
                <p className={`mt-1 text-xs break-words ${j.lastStatus === "error" ? "text-red-700 dark:text-red-300" : "text-muted-foreground"}`}>
                  {j.lastStatus === "error" && <XCircle className="inline h-3 w-3 mr-1" />}{j.lastError}
                </p>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// ─── IA: custo do mês ───────────────────────────────────────────────────────

function eur(v: number): string {
  return `${v.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: v < 1 ? 4 : 2 })} €`;
}

function AiUsageCard() {
  const { user } = useAuth();
  const isAdminRole = isMultisAdmin(user?.role);
  const q = trpc.settings.aiUsage.useQuery(undefined, { refetchInterval: 5 * 60_000 });
  const d = q.data;
  const pct = d?.pct ?? null;
  const barCls = pct == null ? "bg-primary" : pct >= 100 ? "bg-red-600" : pct >= 80 ? "bg-amber-500" : "bg-emerald-600";
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          <Sparkles className="h-4 w-4" /> IA — custo do mês
          {q.isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
          {d && (d.provider == null
            ? <Badge variant="outline" className="bg-muted text-secondary-foreground">Não configurada</Badge>
            : d.blocked
              ? <Badge variant="outline" className="bg-red-100 text-red-800 border-red-200">Orçamento atingido</Badge>
              : <Badge variant="outline" className="bg-emerald-100 text-emerald-800 border-emerald-200">{d.mode === "vertex" ? "Gemini (Vertex AI)" : d.mode === "studio" ? "Gemini" : "Fornecedor antigo"}</Badge>)}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Estimativa pelo registo de cada chamada (tokens × preço do modelo), mês civil {d?.month ?? ""} (UTC). Orçamento e preços em Parâmetros; interruptores em Automações.
          {isAdminRole && <> <Link href="/multis/falhas" className="text-primary underline">Multis: perguntas que falharam →</Link></>}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {q.error && <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="o custo da IA" />}
        {d && (
          <>
            <div className="space-y-1">
              <div className="flex items-baseline gap-2 flex-wrap text-sm">
                <span className="font-semibold text-lg">{eur(d.spentEur)}</span>
                <span className="text-muted-foreground">{d.budgetEur > 0 ? `de ${eur(d.budgetEur)} (${String(pct ?? 0).replace(".", ",")}%)` : "sem limite mensal"}</span>
              </div>
              {d.budgetEur > 0 && (
                <div className="h-2 w-full rounded bg-muted overflow-hidden" aria-hidden>
                  <div className={`h-full ${barCls}`} style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
                </div>
              )}
            </div>
            {d.models && (
              <div className="text-[11px] text-muted-foreground font-mono break-all">
                lite: {d.models.lite} · fast: {d.models.fast} · smart: {d.models.smart} · áudio: {d.models.stt}
              </div>
            )}
            {d.warnings.map((w, i) => (
              <p key={i} className="text-xs text-amber-800 dark:text-amber-300"><AlertTriangle className="inline h-3 w-3 mr-1" />{w}</p>
            ))}
            {d.features.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sem chamadas à IA este mês.</p>
            ) : (
              <div className="overflow-x-auto -mx-1">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b">
                      <th className="py-1 px-1 font-medium">Funcionalidade</th>
                      <th className="py-1 px-1 font-medium text-right">Chamadas</th>
                      <th className="py-1 px-1 font-medium text-right hidden sm:table-cell">Tokens (entrada/saída)</th>
                      <th className="py-1 px-1 font-medium text-right">Custo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.features.map((f) => (
                      <tr key={f.feature} className="border-b last:border-0">
                        <td className="py-1 px-1">
                          {f.label}
                          {(f.errors > 0 || f.blocked > 0) && (
                            <span className="text-muted-foreground"> · {f.errors ? `${f.errors} erro(s)` : ""}{f.errors && f.blocked ? ", " : ""}{f.blocked ? `${f.blocked} bloqueada(s)` : ""}</span>
                          )}
                        </td>
                        <td className="py-1 px-1 text-right tabular-nums">{f.calls.toLocaleString("pt-PT")}</td>
                        <td className="py-1 px-1 text-right tabular-nums hidden sm:table-cell">{f.inputTokens.toLocaleString("pt-PT")} / {f.outputTokens.toLocaleString("pt-PT")}</td>
                        <td className="py-1 px-1 text-right tabular-nums">{eur(f.costEur)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Automações ─────────────────────────────────────────────────────────────

/** De onde vem o estado atual de um interruptor (20b). PURA. */
function flagSource(f: { override: boolean | null; envValue: boolean | null; followsFlag?: string }, followedLabel?: string): string {
  if (f.override != null) return "definido aqui";
  if (f.envValue != null) return "pela variável do servidor";
  // D30: sem valor próprio, segue outro interruptor.
  if (f.followsFlag) return `segue "${followedLabel ?? f.followsFlag}"`;
  return "por omissão";
}

function AutomationsCard() {
  const utils = trpc.useUtils();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "super_admin";
  const isAdminRole = isMultisAdmin(user?.role);
  const canEdit = can(user as any, "definicoes", "edit");
  const q = trpc.settings.flags.list.useQuery();
  const setFlag = trpc.settings.flags.set.useMutation({
    onSuccess: () => { utils.settings.flags.list.invalidate(); utils.settings.values.audit.invalidate(); toast.success("Guardado (aplica-se em até 30 s)."); },
    onError: (e) => {
      toast.error(e.message);
      // 20b: outra pessoa mudou entretanto → mostra já o valor novo.
      if (e.data?.code === "CONFLICT") utils.settings.flags.list.invalidate();
    },
  });
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Automações</CardTitle>
        <p className="text-xs text-muted-foreground">
          Ligar/desligar cada automação. O que se escolhe aqui sobrepõe-se à variável do servidor; "Seguir o servidor" volta ao valor da variável (ou à omissão, se não houver).
        </p>
      </CardHeader>
      <CardContent className="divide-y">
        {q.isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
        {q.error && <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="as automações" />}
        {q.data?.map((f, i) => {
          const locked = !canEdit || (!!f.superAdminOnly && !isSuperAdmin);
          const send = (value: boolean | null) => setFlag.mutate({ name: f.name, value, expectedUpdatedAt: f.updatedAt ?? null });
          return (
          <div key={f.name}>
          {f.group === "ia" && q.data?.[i - 1]?.group !== "ia" && (
            <div className="pt-4 pb-1 flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold flex items-center gap-1"><Sparkles className="h-4 w-4" />Inteligência artificial</span>
              {isAdminRole && <Link href="/multis/falhas" className="text-xs text-primary underline">Multis: perguntas que falharam →</Link>}
            </div>
          )}
          <div className="py-3 flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold">{f.label}</div>
              <div className="text-xs text-muted-foreground">{f.description}</div>
              <div className="text-xs mt-1">
                Agora: <b>{f.effective ? "ligado" : "desligado"}</b> <span className="text-muted-foreground">({flagSource(f, f.followsFlag ? q.data?.find((x) => x.name === f.followsFlag)?.label : undefined)})</span>
                {f.superAdminOnly && <span className="text-muted-foreground"> · só o super admin muda</span>}
              </div>
              {f.euVertex && (
                <p className={`text-xs mt-1 ${f.euVertex.ok ? "text-emerald-700 dark:text-emerald-300" : "text-amber-800 dark:text-amber-300"}`}>
                  {f.euVertex.ok ? <CheckCircle2 className="inline h-3 w-3 mr-1" /> : <AlertTriangle className="inline h-3 w-3 mr-1" />}{f.euVertex.text}
                </p>
              )}
              <div className="text-[11px] text-muted-foreground mt-0.5 font-mono break-all">
                {f.name} · variável: {f.envValue == null ? "—" : f.envValue ? "ligado" : "desligado"}{!f.defaultEnabled && " · desligado por omissão"}
                {f.override != null && <> · <span className="text-primary font-semibold">definido aqui</span>{f.updatedByName ? ` por ${f.updatedByName}` : ""}{f.updatedAt ? ` em ${fmtPTDateTime(f.updatedAt)}` : ""}</>}
              </div>
              {f.override != null && (
                <Button variant="ghost" size="sm" className="h-7 px-2 -ml-2 mt-1 text-xs" disabled={setFlag.isPending || locked}
                  onClick={() => send(null)}>
                  <RotateCcw className="h-3 w-3 mr-1" />Seguir o servidor
                </Button>
              )}
            </div>
            <div className="shrink-0 pt-0.5">
              <Switch
                checked={f.effective}
                disabled={setFlag.isPending || locked}
                onCheckedChange={(v) => send(v)}
                aria-label={f.label}
              />
            </div>
          </div>
          </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// ─── Integrações ────────────────────────────────────────────────────────────

/** Resumo: as integrações vivem no hub /integracoes (estado, testes, gestão). */
function IntegrationsCard() {
  const q = trpc.integrations.hub.list.useQuery();
  const items = (q.data?.items ?? []).filter((i) => i.group === "main");
  const configured = items.filter((i) => i.configured).length;
  const problems = items.filter((i) => i.configured && (i.connection?.status === "reauth_required" || i.connection?.status === "error" || !!i.lastError));
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Integrações</CardTitle>
        <p className="text-xs text-muted-foreground">O estado, os testes e a gestão de cada ligação passaram para a página Integrações.</p>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {q.isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
        {/* 19d: erro ≠ "sem problemas" */}
        {q.error && <p className="text-sm text-red-700" role="alert">Não foi possível ler o estado das integrações: {q.error.message} <button type="button" className="underline" onClick={() => q.refetch()}>Tentar de novo</button></p>}
        {q.data?.statusError && <p className="text-xs text-amber-800" role="alert"><AlertTriangle className="inline h-3 w-3 mr-1" />{q.data.statusError}</p>}
        {q.data && (
          <p>
            {configured} de {items.length} configuradas
            {q.data.statusError ? <span className="text-muted-foreground"> · estado desconhecido</span> : problems.length > 0
              ? <span className="text-red-700"> · com problemas: {problems.map((p) => p.label).join(", ")}</span>
              : <span className="text-emerald-700"> · sem problemas conhecidos</span>}
          </p>
        )}
        {q.data?.encryptionKey?.warning && (
          <p className="text-xs text-amber-800"><AlertTriangle className="inline h-3 w-3 mr-1" />{q.data.encryptionKey.warning}</p>
        )}
        <Button asChild size="sm" variant="outline"><a href="/integracoes"><Plug className="h-4 w-4 mr-1" />Abrir Integrações</a></Button>
      </CardContent>
    </Card>
  );
}

// ─── Parâmetros ─────────────────────────────────────────────────────────────

const GROUP_LABEL: Record<string, string> = { financeiro: "Financeiro", sla: "Prazos (SLA)", emails: "Email (destinatários e Comunicação)", disponibilidade: "Disponibilidades", ia: "Inteligência artificial", extras: "Extras-dia (escala automática)", operacao: "Operação (GPS / Zello / parques)", pessoas: "Pessoas (desempenho)" };

const CITY_FIELDS: { id: "lisbon" | "porto" | "faro"; label: string }[] = [
  { id: "lisbon", label: "Lisboa" },
  { id: "porto", label: "Porto" },
  { id: "faro", label: "Faro" },
];

type SettingItem = {
  key: string; group: string; label: string; description: string; wiring: "live" | "store";
  defaultValue: unknown; value: unknown; isSet: boolean; updatedAt: string | null; updatedByName: string | null;
  invalid?: boolean; superAdminOnly?: boolean;
};

/** Nome legível de uma chave do histórico (definição ou interruptor). */
function auditKeyLabel(key: string): string {
  if (key.startsWith(FLAG_SETTING_PREFIX)) {
    const name = key.slice(FLAG_SETTING_PREFIX.length);
    return AUTOMATION_FLAGS.find((f) => f.name === name)?.label ?? name;
  }
  return (SETTINGS as Record<string, { label: string }>)[key]?.label ?? key;
}
const AUDIT_ALL = "__all__";
const AUDIT_KEYS: { value: string; label: string }[] = [
  ...Object.keys(SETTINGS).map((k) => ({ value: k, label: auditKeyLabel(k) })),
  ...AUTOMATION_FLAGS.map((f) => ({ value: FLAG_SETTING_PREFIX + f.name, label: `Automação: ${f.label}` })),
].sort((a, b) => a.label.localeCompare(b.label, "pt"));

function ParametersCard() {
  const utils = trpc.useUtils();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "super_admin";
  const canEdit = can(user as any, "definicoes", "edit");
  const q = trpc.settings.values.list.useQuery();
  const code = trpc.settings.values.codeConstants.useQuery();
  const [auditKey, setAuditKey] = useState<string>(AUDIT_ALL);
  const audit = trpc.settings.values.audit.useQuery({ limit: 50, key: auditKey === AUDIT_ALL ? null : auditKey });
  const save = trpc.settings.values.set.useMutation({
    onSuccess: (r) => { utils.settings.values.invalidate(); toast.success(r.changed ? "Guardado." : "Sem alterações."); },
    onError: (e) => {
      toast.error(e.message);
      // 20b: outra pessoa gravou entretanto → recarrega para se ver o valor novo.
      if (e.data?.code === "CONFLICT") utils.settings.values.invalidate();
    },
  });
  const groups = useMemo(() => {
    const m = new Map<string, SettingItem[]>();
    for (const s of (q.data ?? []) as SettingItem[]) {
      if (s.group === "notificacoes") continue; // tem separador próprio (Notificações)
      if (s.key === "google.sharedCalendars" || s.key === "google.contacts" || s.key === "google.drive") continue; // cartões próprios (Comunicação)
      if (s.key === "marketing.webAnalytics") continue; // cartão próprio (Integrações → Web & SEO)
      if (s.key === "knowledge.config") continue; // cartão próprio (Formação → Base de conhecimento)
      if (s.key === "services.taskRules") continue; // cartão próprio (Serviços → tarefas, acima)
      if (!m.has(s.group)) m.set(s.group, []);
      m.get(s.group)!.push(s);
    }
    return Array.from(m.entries());
  }, [q.data]);

  return (
    <div className="space-y-4">
      {q.isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
      {q.error && <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="os parâmetros" />}
      {code.error && <QueryErrorNote error={code.error} onRetry={() => code.refetch()} retrying={code.isFetching} what="o IVA/TSU em vigor nos cálculos" />}
      {groups.map(([group, items]) => (
        <Card key={group}>
          <CardHeader className="pb-2"><CardTitle className="text-base">{GROUP_LABEL[group] ?? group}</CardTitle></CardHeader>
          <CardContent className="space-y-5">
            {items.map((s) => (
              <SettingEditor key={s.key} item={s} saving={save.isPending}
                locked={!canEdit || (!!s.superAdminOnly && !isSuperAdmin)}
                codeValue={s.key === "finance.vat" ? code.data?.vatRate : s.key === "finance.tsu" ? code.data?.tsuEmployerRate : undefined}
                onSave={(value) => save.mutate({ key: s.key, value, expectedUpdatedAt: s.updatedAt ?? null })} />
            ))}
          </CardContent>
        </Card>
      ))}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Histórico de alterações</CardTitle>
          <div className="pt-1 max-w-sm">
            <Select value={auditKey} onValueChange={setAuditKey}>
              <SelectTrigger className="h-8 text-xs" aria-label="Filtrar o histórico"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={AUDIT_ALL}>Todas as alterações</SelectItem>
                {AUDIT_KEYS.map((k) => <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {audit.error && <QueryErrorNote error={audit.error} onRetry={() => audit.refetch()} retrying={audit.isFetching} what="o histórico" />}
          {audit.data?.length === 0 && <p className="text-sm text-muted-foreground">{auditKey === AUDIT_ALL ? "Ainda sem alterações." : "Sem alterações nesta definição."}</p>}
          <div className="space-y-1.5">
            {audit.data?.map((a) => (
              <div key={a.id} className="text-xs border-b pb-1.5 last:border-0">
                <div><span className="font-semibold">{auditKeyLabel(a.key)}</span> <span className="font-mono text-muted-foreground">({a.key})</span> · {a.changedByName ?? "—"} · {fmtPTDateTime(a.changedAt)}</div>
                <div className="text-muted-foreground break-all font-mono">{JSON.stringify(a.oldValue)} → {JSON.stringify(a.newValue)}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function pct(rate: number): string {
  return String(Math.round(rate * 10000) / 100).replace(".", ",");
}

/** Telefones dos alertas sem PDA/Zello: por cidade + cópia (20b: antes o editor genérico estragava a lista). */
const PRESENCE_PHONE_FIELDS: { id: "lisbon" | "porto" | "faro" | "copy"; label: string }[] = [
  { id: "lisbon", label: "Lisboa" },
  { id: "porto", label: "Porto" },
  { id: "faro", label: "Faro" },
  { id: "copy", label: "Cópia (todas as cidades)" },
];

function SettingEditor({ item, saving, onSave, codeValue, locked }: { item: SettingItem; saving: boolean; onSave: (v: unknown) => void; codeValue?: number; locked?: boolean }) {
  const current = item.isSet ? item.value : item.defaultValue;
  const isPhones = item.key === "ops.presencePhones";
  // Aeroportos do terminal no ponto: lat/lng/raio por cidade (o editor por cidade genérico só tem um campo).
  const isAirports = item.key === TERMINAL_AIRPORTS_SETTING_KEY;
  const isRate = item.key === "finance.vat" || item.key === "finance.tsu";
  const isZelloList = item.key === "zello.gpsExcludedUsers";
  const isEmails = item.key === "emails.handoverCc" || isZelloList;
  const isParkList = item.key === EXCLUDED_PARKS_SETTING_KEY;
  const isNumber = typeof item.defaultValue === "number";
  const isBool = typeof item.defaultValue === "boolean";
  // Mapa por cidade (ex.: carros/hora por condutor, ponto de encontro).
  const isCityMap = !isPhones && !isAirports && !!item.defaultValue && typeof item.defaultValue === "object" && !Array.isArray(item.defaultValue)
    && CITY_FIELDS.every((c) => c.id in (item.defaultValue as Record<string, unknown>));
  const cityMapNumeric = isCityMap && typeof (item.defaultValue as Record<string, unknown>).lisbon === "number";
  // 38a: ligado/desligado por cidade → interruptores (antes eram caixas de texto e "true" escrito não gravava)
  const cityMapBool = isCityMap && typeof (item.defaultValue as Record<string, unknown>).lisbon === "boolean";
  const isTime = typeof item.defaultValue === "string" && /^\d{2}:\d{2}$/.test(item.defaultValue as string);
  const isJson = !isPhones && !isAirports && !!item.defaultValue && typeof item.defaultValue === "object" && !Array.isArray(item.defaultValue) && !isRate && !isEmails && !isCityMap;

  const [rates, setRates] = useState<{ pct: string; from: string }[]>([]);
  const [cityMap, setCityMap] = useState<Record<string, string>>({});
  const [cityBools, setCityBools] = useState<Record<string, boolean>>({});
  // 38a: alertas sem PDA/Zello — pessoas do RH por cidade (o telefone vem da ficha)
  const [fichaSel, setFichaSel] = useState<Record<string, number[]>>({});
  const people = trpc.settings.values.presencePeople.useQuery(undefined, { enabled: isPhones, staleTime: 60_000 });
  const personById = useMemo(() => new Map((people.data ?? []).map((p) => [p.id, p])), [people.data]);
  const [airports, setAirports] = useState<Record<string, { lat: string; lng: string; radiusM: string }>>({});
  const [bool, setBool] = useState(false);
  const [text, setText] = useState("");
  const [parkSel, setParkSel] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    if (isPhones) {
      const of = (id: string) => (((current as Record<string, unknown>)?.[id] as string[] | undefined) ?? []);
      setFichaSel(Object.fromEntries(PRESENCE_PHONE_FIELDS.map((c) => [c.id, of(c.id).map(presenceFichaId).filter((x): x is number => x != null)])));
      setCityMap(Object.fromEntries(PRESENCE_PHONE_FIELDS.map((c) => [c.id, of(c.id).filter((x) => presenceFichaId(x) == null).join("\n")])));
    }
    else if (isAirports) {
      const cur = (current ?? {}) as Record<string, { lat?: number; lng?: number; radiusM?: number } | undefined>;
      const txt = (v: number | undefined) => (v == null ? "" : String(v).replace(".", ","));
      setAirports(Object.fromEntries(CITY_FIELDS.map((c) => [c.id, { lat: txt(cur[c.id]?.lat), lng: txt(cur[c.id]?.lng), radiusM: txt(cur[c.id]?.radiusM) }])));
    }
    else if (isRate) setRates(((current as RateEntry[]) ?? []).map((r) => ({ pct: pct(r.rate), from: r.from })));
    else if (isEmails) setText(((current as string[]) ?? []).join("\n"));
    else if (isParkList) setParkSel([...((current as string[]) ?? [])]);
    else if (cityMapBool) setCityBools(Object.fromEntries(CITY_FIELDS.map((c) => [c.id, (current as Record<string, unknown>)?.[c.id] === true])));
    else if (isCityMap) setCityMap(Object.fromEntries(CITY_FIELDS.map((c) => [c.id, String((current as Record<string, unknown>)?.[c.id] ?? "").replace(".", ",")])));
    else if (isBool) setBool(!!current);
    else if (isJson) setText(current && Object.keys(current as object).length ? JSON.stringify(current, null, 2) : "");
    else setText(current == null ? "" : String(current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(current)]);

  const build = (): unknown => {
    if (isPhones) return Object.fromEntries(PRESENCE_PHONE_FIELDS.map((c) => [c.id, [
      ...(fichaSel[c.id] ?? []).map((id) => `${PRESENCE_FICHA_PREFIX}${id}`),
      ...(cityMap[c.id] ?? "").split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean),
    ]]));
    if (isAirports) {
      const n = (v: string | undefined) => { const t = String(v ?? "").trim().replace(",", "."); return t === "" ? NaN : Number(t); };
      return Object.fromEntries(CITY_FIELDS.map((c) => [c.id, { lat: n(airports[c.id]?.lat), lng: n(airports[c.id]?.lng), radiusM: n(airports[c.id]?.radiusM) }]));
    }
    if (isRate) return rates.map((r) => ({ rate: Number(r.pct.replace(",", ".")) / 100, from: r.from.trim() }));
    if (isEmails) return text.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
    if (isParkList) return parkSel;
    if (cityMapBool) return Object.fromEntries(CITY_FIELDS.map((c) => [c.id, cityBools[c.id] === true]));
    if (isCityMap) return Object.fromEntries(CITY_FIELDS.map((c) => {
      const raw = (cityMap[c.id] ?? "").trim();
      return [c.id, cityMapNumeric ? (raw === "" ? NaN : Number(raw.replace(",", "."))) : raw];
    }));
    if (isBool) return bool;
    if (isJson) {
      if (!text.trim()) return {};
      try { return JSON.parse(text); } catch { return "__json_invalido__"; }
    }
    if (isNumber) return text.trim() === "" ? NaN : Number(text.replace(",", "."));
    return text.trim();
  };
  const submit = () => {
    const v = build();
    const r = validateSetting(item.key, v);
    if (!r.ok) { setError(r.error); return; }
    setError(null);
    onSave(r.value);
  };

  const today = new Date().toISOString().slice(0, 10);
  const inForce = isRate ? [...((current as RateEntry[]) ?? [])].filter((r) => r.from <= today).sort((a, b) => b.from.localeCompare(a.from))[0] : null;

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2 flex-wrap">
        <div className="flex-1 min-w-[12rem]">
          <div className="text-sm font-semibold">{item.label}</div>
          <div className="text-xs text-muted-foreground">{item.description}</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            {item.wiring === "live" ? "Em uso pela aplicação." : "Só registado (não altera cálculos)."}
            {item.isSet ? ` Alterado${item.updatedByName ? ` por ${item.updatedByName}` : ""}${item.updatedAt ? ` em ${fmtPTDateTime(item.updatedAt)}` : ""}.` : " A usar o valor por omissão."}
            {item.superAdminOnly && " Só o super admin muda."}
          </div>
          {item.invalid && (
            <div className="text-[11px] mt-0.5 text-amber-800 dark:text-amber-300"><AlertTriangle className="inline h-3 w-3 mr-1" />O valor gravado já não é válido — a aplicação está a usar a omissão. Grava de novo para corrigir.</div>
          )}
          {isRate && inForce && (
            <div className="text-[11px] mt-0.5">
              Em vigor hoje: <b>{pct(inForce.rate)}%</b>
              {codeValue != null && Math.abs(codeValue - inForce.rate) > 1e-9 && (
                <span className="text-amber-700"> — atenção: os cálculos usam hoje {pct(codeValue)}%</span>
              )}
            </div>
          )}
        </div>
      </div>

      {isPhones ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-3xl">
          {people.isError && <p className="sm:col-span-2 text-xs text-destructive">Não foi possível carregar as pessoas do RH. <button type="button" className="underline" onClick={() => people.refetch()}>Tentar de novo</button></p>}
          {PRESENCE_PHONE_FIELDS.map((c) => {
            const chosen = fichaSel[c.id] ?? [];
            const options = (people.data ?? []).filter((p) => p.active && !chosen.includes(p.id))
              .map((p) => ({ value: String(p.id), label: `${p.name}${p.phoneTail ? ` · ••• ${p.phoneTail}` : " · sem telefone"}` }));
            return (
              <div key={c.id} className="rounded-md border p-2 space-y-2">
                <div className="text-xs font-medium">{c.label}</div>
                {chosen.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {chosen.map((id) => {
                      const p = personById.get(id);
                      const warn = !p ? null : !p.active ? "ficha inativa — não recebe" : p.noAutoWhatsapp ? "tem \"Não enviar\" — não recebe" : !p.phoneTail ? "sem telefone na ficha — não recebe" : null;
                      return (
                        <span key={id} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${warn ? "border-amber-400 text-amber-800 dark:text-amber-300" : ""}`}>
                          {p?.name ?? `Ficha ${id}`}
                          <span className="text-muted-foreground">{warn ?? (p?.phoneTail ? `••• ${p.phoneTail}` : "")}</span>
                          <button type="button" className="ml-0.5 rounded hover:bg-muted" aria-label={`Tirar ${p?.name ?? `ficha ${id}`}`} disabled={locked}
                            onClick={() => setFichaSel((prev) => ({ ...prev, [c.id]: (prev[c.id] ?? []).filter((x) => x !== id) }))}><X className="h-3 w-3" /></button>
                        </span>
                      );
                    })}
                  </div>
                )}
                <SearchableSelect value="" options={options} disabled={locked || people.isLoading} className="w-full h-8 text-xs"
                  placeholder={people.isLoading ? "A carregar o RH…" : "+ Juntar pessoa do RH"} searchPlaceholder="Procurar pelo nome…" emptyText="Ninguém com esse nome"
                  onChange={(v) => { const id = Number(v); if (id) setFichaSel((prev) => ({ ...prev, [c.id]: [...(prev[c.id] ?? []).filter((x) => x !== id), id] })); }} />
                <Textarea rows={1} value={cityMap[c.id] ?? ""} aria-label={`Outros números — ${c.label}`} placeholder="Outros números, fora do RH (um por linha)"
                  disabled={locked} className="text-xs" onChange={(e) => setCityMap((p) => ({ ...p, [c.id]: e.target.value }))} />
              </div>
            );
          })}
        </div>
      ) : isAirports ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 max-w-3xl">
          {CITY_FIELDS.map((c) => (
            <div key={c.id} className="rounded-md border p-2 space-y-1.5">
              <div className="text-xs font-medium">{AIRPORT_LABELS[c.id as AirportCityId] ?? c.label}</div>
              {(["lat", "lng", "radiusM"] as const).map((f) => (
                <label key={f} className="flex items-center gap-2 text-xs">
                  <span className="w-16 text-muted-foreground">{f === "lat" ? "Latitude" : f === "lng" ? "Longitude" : "Raio (m)"}</span>
                  <Input className="h-8 text-xs" inputMode="decimal" disabled={locked} aria-label={`${c.label} — ${f === "lat" ? "latitude" : f === "lng" ? "longitude" : "raio em metros"}`}
                    value={airports[c.id]?.[f] ?? ""}
                    onChange={(e) => setAirports((p) => ({ ...p, [c.id]: { ...(p[c.id] ?? { lat: "", lng: "", radiusM: "" }), [f]: e.target.value } }))} />
                </label>
              ))}
            </div>
          ))}
        </div>
      ) : isRate ? (
        <div className="space-y-2">
          {rates.map((r, i) => (
            <div key={i} className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1">
                <Input className="w-24" inputMode="decimal" value={r.pct} aria-label="Taxa (%)"
                  onChange={(e) => setRates((p) => p.map((x, j) => j === i ? { ...x, pct: e.target.value } : x))} />
                <span className="text-sm">%</span>
              </div>
              <span className="text-xs text-muted-foreground">desde</span>
              <Input type="date" className="w-40" value={r.from} aria-label="Data de efeito"
                onChange={(e) => setRates((p) => p.map((x, j) => j === i ? { ...x, from: e.target.value } : x))} />
              <Button variant="ghost" size="icon" aria-label="Remover" disabled={rates.length <= 1}
                onClick={() => setRates((p) => p.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => setRates((p) => [...p, { pct: p[p.length - 1]?.pct ?? "", from: today }])}>
            <Plus className="h-4 w-4 mr-1" />Nova taxa com data de efeito
          </Button>
        </div>
      ) : isEmails ? (
        <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={isZelloList ? "um utilizador Zello por linha (vazio = ninguém excluído)" : "um email por linha"} />
      ) : isParkList ? (
        <ParkPicker selected={parkSel} onChange={setParkSel} />
      ) : cityMapBool ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 max-w-2xl">
          {CITY_FIELDS.map((c) => (
            <label key={c.id} className="flex items-center gap-2 text-sm rounded-md border px-3 py-2">
              <Switch checked={cityBools[c.id] === true} disabled={locked} aria-label={`${item.label} — ${c.label}`}
                onCheckedChange={(v) => setCityBools((p) => ({ ...p, [c.id]: v }))} />
              <span className="font-medium">{c.label}</span>
              <span className="text-xs text-muted-foreground ml-auto">{cityBools[c.id] ? "Ligado" : "Desligado"}</span>
            </label>
          ))}
        </div>
      ) : isCityMap ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 max-w-2xl">
          {CITY_FIELDS.map((c) => (
            <label key={c.id} className="text-xs space-y-1">
              <span className="text-muted-foreground">{c.label}</span>
              <Input inputMode={cityMapNumeric ? "decimal" : "text"} value={cityMap[c.id] ?? ""} aria-label={c.label}
                placeholder={cityMapNumeric ? String((item.defaultValue as Record<string, unknown>)[c.id]) : "ex.: Parque P1, portão principal"}
                onChange={(e) => setCityMap((p) => ({ ...p, [c.id]: e.target.value }))} />
            </label>
          ))}
        </div>
      ) : isBool ? (
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={bool} onCheckedChange={setBool} aria-label={item.label} />
          {bool ? "Ligado" : "Desligado"}
        </label>
      ) : isTime ? (
        <Input type="time" className="w-32" value={text} onChange={(e) => setText(e.target.value)} aria-label={item.label} />
      ) : isJson ? (
        <Textarea rows={4} className="font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} placeholder="{}" />
      ) : (
        <Input className="max-w-sm" inputMode={isNumber ? "numeric" : "email"} value={text} onChange={(e) => setText(e.target.value)}
          placeholder={isNumber ? String(item.defaultValue) : "nome@multipark.pt"} />
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2 flex-wrap">
        <Button size="sm" onClick={submit} disabled={saving || locked}><Save className="h-4 w-4 mr-1" />Guardar</Button>
        {item.isSet && (
          <Button size="sm" variant="ghost" disabled={saving || locked} onClick={() => onSave(null)}>
            <RotateCcw className="h-4 w-4 mr-1" />Repor omissão
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Escolha de parques da BD da Multipark (lidos ao vivo): marcas nossas por
 * marca + cidade primeiro, depois os outros por nome. Ids gravados que já não
 * existem na BD continuam na lista (para se poderem tirar).
 */
function ParkPicker({ selected, onChange }: { selected: string[]; onChange: (ids: string[]) => void }) {
  const q = trpc.settings.values.multiparkParks.useQuery(undefined, { staleTime: 5 * 60_000 });
  const [filter, setFilter] = useState("");
  const parks = q.data?.available ? q.data.parks : [];
  const known = new Set(parks.map((p) => p.id));
  const sel = new Set(selected);
  const f = filter.trim().toLowerCase();
  const rows = [...parks]
    .sort((a, b) => a.groupOrder - b.groupOrder || a.groupLabel.localeCompare(b.groupLabel, "pt") || a.name.localeCompare(b.name, "pt"))
    .filter((p) => !f || `${p.name} ${p.cityName ?? ""} ${p.groupLabel}`.toLowerCase().includes(f));
  const missing = selected.filter((id) => !known.has(id));
  const byName = parks.filter((p) => p.notOperated).length;
  const unmatched = q.data?.available ? q.data.unmatchedNotOperated : [];
  const toggle = (id: string, on: boolean) => onChange(on ? [...selected.filter((x) => x !== id), id] : selected.filter((x) => x !== id));
  return (
    <div className="space-y-2 max-w-2xl">
      {q.isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
      {q.data && !q.data.available && <p className="text-xs text-amber-800"><AlertTriangle className="inline h-3 w-3 mr-1" />Parques indisponíveis: {q.data.reason}</p>}
      {q.error && <p className="text-xs text-destructive">Erro a ler os parques: {q.error.message}</p>}
      {parks.length > 0 && (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <Input className="max-w-xs h-8" placeholder="Filtrar parques" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filtrar parques" />
            <span className="text-xs text-muted-foreground">{selected.length} {selected.length === 1 ? "parque escolhido" : "parques escolhidos"} de {parks.length}{byName > 0 ? ` · mais ${byName} fora pela lista dos que não operamos` : ""}</span>
          </div>
          <div className="border rounded-md max-h-72 overflow-y-auto divide-y">
            {rows.map((p) => (
              <label key={p.id} className={`flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-muted/40 ${p.notOperated ? "opacity-70" : "cursor-pointer"}`}>
                <Checkbox checked={p.notOperated || sel.has(p.id)} disabled={p.notOperated} onCheckedChange={(v) => toggle(p.id, v === true)} aria-label={p.name} />
                <span className="min-w-0 flex-1 truncate">{p.name}{p.cityName && !p.name.toLowerCase().includes(p.cityName.toLowerCase()) ? ` · ${p.cityName}` : ""}</span>
                {p.ours && <Badge variant="outline" className="text-[10px]">{p.groupLabel}</Badge>}
                {p.notOperated && <Badge variant="secondary" className="text-[10px]" title="Na lista dos parques que não operamos (fica sempre fora)">não operado</Badge>}
                {p.status && p.status !== "ACTIVE" && <span className="text-[11px] text-muted-foreground">{p.status === "INACTIVE" ? "inativo" : p.status === "PENDING" ? "pendente" : p.status}</span>}
              </label>
            ))}
            {rows.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">Nenhum parque com este filtro.</p>}
          </div>
        </>
      )}
      {unmatched.length > 0 && (
        <p className="text-xs text-amber-800">
          <AlertTriangle className="inline h-3 w-3 mr-1" />Da lista dos que não operamos, sem parque com este nome na BD da Multipark: {unmatched.join(", ")}.
        </p>
      )}
      {missing.length > 0 && (
        <div className="text-xs space-y-1">
          <span className="text-muted-foreground">Gravados mas não encontrados na BD da Multipark:</span>
          {missing.map((id) => (
            <label key={id} className="flex items-center gap-2 font-mono">
              <Checkbox checked onCheckedChange={() => toggle(id, false)} aria-label={id} />{id}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Segurança ──────────────────────────────────────────────────────────────

function SecurityCard({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const utils = trpc.useUtils();
  const keys = trpc.settings.security.apiKeys.useQuery();
  const setExpiry = trpc.settings.security.setApiKeyExpiry.useMutation({
    onSuccess: () => { utils.settings.security.apiKeys.invalidate(); toast.success("Validade atualizada."); },
    onError: (e) => toast.error(e.message),
  });
  const endMine = trpc.settings.security.endMySessions.useMutation({
    onSuccess: () => toast.success("Sessões terminadas nos outros dispositivos."),
    onError: (e) => toast.error(e.message),
  });
  const endAll = trpc.settings.security.endAllSessions.useMutation({
    onSuccess: (r) => toast.success(`Sessões terminadas (${r.affected} contas). Este dispositivo continua ligado.`),
    onError: (e) => toast.error(e.message),
  });
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const now = Date.now();

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2"><LogOut className="h-4 w-4" />Sessões</CardTitle>
          <p className="text-xs text-muted-foreground">Terminar as sessões invalida os cookies já emitidos: quem estiver ligado noutro dispositivo tem de voltar a entrar. Este dispositivo continua ligado.</p>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <ConfirmButton
            label="Terminar as minhas outras sessões" pending={endMine.isPending}
            title="Terminar as tuas sessões?" description="Todos os outros dispositivos onde tens sessão iniciada vão pedir login outra vez."
            onConfirm={() => endMine.mutate()} />
          {isSuperAdmin && (
            <ConfirmButton
              destructive label="Terminar todas as sessões (todas as contas)" pending={endAll.isPending}
              title="Terminar as sessões de TODAS as pessoas?" description="Toda a gente (incluindo PDAs com sessão) terá de voltar a entrar. Usar em caso de suspeita de acesso indevido."
              onConfirm={() => endAll.mutate()} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2"><KeyRound className="h-4 w-4" />Validade das API keys</CardTitle>
          <p className="text-xs text-muted-foreground">Chaves guardadas só como hash; aqui muda-se a data de expiração (a chave funciona até ao fim desse dia, hora de Lisboa). Criar, mudar capacidades ou revogar: página API Keys.</p>
        </CardHeader>
        <CardContent className="space-y-2">
          {keys.error && <QueryErrorNote error={keys.error} onRetry={() => keys.refetch()} retrying={keys.isFetching} what="as API keys" />}
          {keys.data && !keys.data.visible && <p className="text-sm text-muted-foreground">Só o super admin gere as API keys.</p>}
          {keys.data?.visible && keys.data.keys.length === 0 && <p className="text-sm text-muted-foreground">Sem API keys.</p>}
          {keys.data?.visible && keys.data.keys.map((k) => {
            const exp = k.expiresAt ? new Date(`${String(k.expiresAt).replace(" ", "T")}Z`).getTime() : null;
            const expired = exp != null && exp <= now;
            const soon = exp != null && !expired && exp - now < 14 * 86_400_000;
            const draft = drafts[k.id] ?? (k.expiresAt ? String(k.expiresAt).slice(0, 10) : "");
            return (
              <div key={k.id} className="rounded-lg border p-3 flex flex-wrap items-center gap-2">
                <div className="flex-1 min-w-[12rem]">
                  <div className="text-sm font-semibold flex items-center gap-2 flex-wrap">
                    {k.name}
                    <span className="font-mono text-xs text-muted-foreground">{k.keyPrefix ?? "—"}…</span>
                    {!k.active && <Badge variant="outline">Desativada</Badge>}
                    {expired && <Badge variant="outline" className="bg-red-100 text-red-800 border-red-200">Expirou</Badge>}
                    {soon && <Badge variant="outline" className="bg-amber-100 text-amber-900 border-amber-200">Expira em breve</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {k.expiresAt ? `Expira: ${fmtPTDate(k.expiresAt)}` : "Sem expiração"} · Último uso: {k.lastUsedAt ? fmtPTDateTime(k.lastUsedAt) : "nunca"}
                  </div>
                </div>
                <Input type="date" className="w-40" value={draft} aria-label="Nova data de expiração"
                  onChange={(e) => setDrafts((p) => ({ ...p, [k.id]: e.target.value }))} />
                <Button size="sm" variant="outline" disabled={setExpiry.isPending || !draft}
                  onClick={() => setExpiry.mutate({ id: k.id, expiresOn: draft })}>Guardar</Button>
                {k.expiresAt && (
                  <Button size="sm" variant="ghost" disabled={setExpiry.isPending}
                    onClick={() => { setDrafts((p) => ({ ...p, [k.id]: "" })); setExpiry.mutate({ id: k.id, expiresOn: null }); }}>Sem expiração</Button>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}

function ConfirmButton(props: { label: string; title: string; description: string; pending: boolean; destructive?: boolean; onConfirm: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant={props.destructive ? "destructive" : "outline"} disabled={props.pending} className="max-w-full h-auto min-h-9 whitespace-normal text-left">
          {props.pending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <LogOut className="h-4 w-4 mr-1" />}{props.label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{props.title}</AlertDialogTitle>
          <AlertDialogDescription>{props.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={props.onConfirm}>Confirmar</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
