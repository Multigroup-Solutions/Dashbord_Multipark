// Página "Definições" (/definicoes) — admin+.
// Estado do sistema (crons), interruptores das automações, integrações,
// parâmetros (IVA/TSU, SLAs, emails, responsável das disponibilidades) com
// auditoria, e segurança (validade das API keys, terminar sessões).
import { useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { fmtPTDate, fmtPTDateTime } from "@/lib/lisbonTime";
import {
  Activity, AlertTriangle, Bell, CheckCircle2, Clock, KeyRound, Loader2, LogOut, Plug, Plus, RotateCcw,
  Mail, Save, ShieldCheck, SlidersHorizontal, Sparkles, ToggleLeft, Trash2, XCircle,
} from "lucide-react";
import { MailboxesSettings } from "@/components/mail/MailboxesSettings";
import { SharedCalendarsSettings } from "@/components/google/SharedCalendarsSettings";
import { GoogleContactsSettings } from "@/components/google/GoogleContactsSettings";
import { GoogleDriveSettings } from "@/components/google/GoogleDriveSettings";
import { WebAnalyticsSettings } from "@/components/marketing/WebAnalyticsSettings";
import { validateSetting, type RateEntry } from "@shared/appSettings";
import { SyncHealthPanel } from "@/components/operacoes/SyncHealthPanel";
import { NotificationRoutingCard } from "@/components/NotificationRoutingCard";

const TABS = ["estado", "automacoes", "integracoes", "comunicacao", "parametros", "notificacoes", "seguranca"] as const;
type Tab = (typeof TABS)[number];

function useStoredTab(): [Tab, (t: Tab) => void] {
  const [tab, setTab] = useState<Tab>(() => {
    try {
      const v = sessionStorage.getItem("mp.definicoes.tab");
      return (TABS as readonly string[]).includes(v ?? "") ? (v as Tab) : "estado";
    } catch { return "estado"; }
  });
  return [tab, (t) => { setTab(t); try { sessionStorage.setItem("mp.definicoes.tab", t); } catch { /* sem storage */ } }];
}

export default function DefinicoesPage() {
  const { user } = useAuth();
  const [tab, setTab] = useStoredTab();
  const isAdmin = !!user && ["admin", "super_admin"].includes(user.role);
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
        <TabsContent value="estado" className="space-y-4"><SystemStatusCard />{user.role === "super_admin" && <SchedulerCard />}<AiUsageCard /><SyncHealthPanel compact /></TabsContent>
        <TabsContent value="automacoes"><AutomationsCard /></TabsContent>
        <TabsContent value="integracoes" className="space-y-4"><IntegrationsCard /><WebAnalyticsSettings /></TabsContent>
        <TabsContent value="comunicacao" className="space-y-4"><MailboxesSettings /><SharedCalendarsSettings /><GoogleContactsSettings /><GoogleDriveSettings /></TabsContent>
        <TabsContent value="parametros"><ParametersCard /></TabsContent>
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
  const problems = crons.filter((c) => c.health === "failed" || c.health === "stale").length;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          Estado do sistema
          {q.isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : problems > 0
            ? <Badge variant="outline" className="bg-red-100 text-red-800 border-red-200">{problems} com problemas</Badge>
            : <Badge variant="outline" className="bg-emerald-100 text-emerald-800 border-emerald-200">Tudo a correr</Badge>}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Última corrida de cada cron (agendador /api/cron/tick, chamado pelo cron-job.org de 5 em 5 min; ou à mão). "Parado" = sem corridas há mais de 2× o intervalo esperado (mínimo 30 min).
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {q.error && <p className="text-sm text-destructive">{q.error.message}</p>}
        {crons.map((c) => {
          const h = HEALTH[c.health] ?? HEALTH.never;
          const bad = c.health === "failed" || c.health === "stale";
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
                  <div><span className="text-muted-foreground">Último OK: </span>{c.lastOkAt ? ago(c.lastOkAt, now) : "—"}</div>
                  <div><span className="text-muted-foreground">24 h: </span>{c.runs24h} corridas{c.failures24h ? <span className="text-red-700 font-semibold"> · {c.failures24h} falhas</span> : null}</div>
                </div>
                {c.last && c.last.ok === false && c.last.error && (
                  <p className="mt-2 text-xs text-red-700 dark:text-red-300 break-words"><XCircle className="inline h-3 w-3 mr-1" />{c.last.error}</p>
                )}
                {c.last && c.last.ok === true && c.last.error && (
                  <p className="mt-2 text-xs text-amber-800 dark:text-amber-300 break-words"><AlertTriangle className="inline h-3 w-3 mr-1" />{c.last.error}</p>
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
      </CardContent>
    </Card>
  );
}

// ─── Agendador (/api/cron/tick) — só super admin ────────────────────────────

const JOB_STATUS: Record<string, { label: string; cls: string }> = {
  ok: { label: "OK", cls: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  error: { label: "Erro", cls: "bg-red-100 text-red-800 border-red-200" },
  partial: { label: "A meio (retoma)", cls: "bg-blue-100 text-blue-800 border-blue-200" },
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
          {q.isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : errors > 0
            ? <Badge variant="outline" className="bg-red-100 text-red-800 border-red-200">{errors} com erro</Badge>
            : <Badge variant="outline" className="bg-emerald-100 text-emerald-800 border-emerald-200">Sem erros</Badge>}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          O cron-job.org chama /api/cron/tick de 5 em 5 min; cada tick corre, um a um, os trabalhos que estão na altura (hora de Lisboa). "A meio" = não coube no tempo e continua no tick seguinte. Só leitura.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {q.error && <p className="text-sm text-destructive">{q.error.message}</p>}
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
              {j.periodDone && <p className="mt-1 text-xs text-muted-foreground"><CheckCircle2 className="inline h-3 w-3 mr-1 text-emerald-600" />Feito neste período.</p>}
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
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {q.error && <p className="text-sm text-destructive">{q.error.message}</p>}
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

function AutomationsCard() {
  const utils = trpc.useUtils();
  const q = trpc.settings.flags.list.useQuery();
  const setFlag = trpc.settings.flags.set.useMutation({
    onSuccess: () => { utils.settings.flags.list.invalidate(); utils.settings.values.audit.invalidate(); toast.success("Guardado (aplica-se em até 30 s)."); },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Automações</CardTitle>
        <p className="text-xs text-muted-foreground">
          Ligar/desligar cada automação. O que se escolhe aqui sobrepõe-se à variável de ambiente; "Seguir env" volta ao valor do servidor.
        </p>
      </CardHeader>
      <CardContent className="divide-y">
        {q.isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
        {q.data?.map((f, i) => (
          <div key={f.name}>
          {f.group === "ia" && q.data?.[i - 1]?.group !== "ia" && (
            <div className="pt-4 pb-1 text-sm font-semibold flex items-center gap-1"><Sparkles className="h-4 w-4" />Inteligência artificial</div>
          )}
          <div className="py-3 flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold">{f.label}</div>
              <div className="text-xs text-muted-foreground">{f.description}</div>
              <div className="text-[11px] text-muted-foreground mt-1 font-mono break-all">
                {f.name} · env: {f.envValue == null ? "—" : f.envValue ? "ligado" : "desligado"}{!f.defaultEnabled && " · desligado por omissão"}
                {f.override != null && <> · <span className="text-primary font-semibold">definido aqui</span>{f.updatedByName ? ` por ${f.updatedByName}` : ""}{f.updatedAt ? ` em ${fmtPTDateTime(f.updatedAt)}` : ""}</>}
              </div>
            </div>
            <div className="flex flex-col items-end gap-1 shrink-0">
              <Switch
                checked={f.effective}
                disabled={setFlag.isPending}
                onCheckedChange={(v) => setFlag.mutate({ name: f.name, value: v })}
                aria-label={f.label}
              />
              {f.override != null && (
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={setFlag.isPending}
                  onClick={() => setFlag.mutate({ name: f.name, value: null })}>
                  <RotateCcw className="h-3 w-3 mr-1" />Seguir env
                </Button>
              )}
            </div>
          </div>
          </div>
        ))}
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
        {q.data && (
          <p>
            {configured} de {items.length} configuradas
            {problems.length > 0
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

const GROUP_LABEL: Record<string, string> = { financeiro: "Financeiro", sla: "Prazos (SLA)", emails: "Email (destinatários e Comunicação)", disponibilidade: "Disponibilidades", ia: "Inteligência artificial", extras: "Extras-dia (escala automática)" };

const CITY_FIELDS: { id: "lisbon" | "porto" | "faro"; label: string }[] = [
  { id: "lisbon", label: "Lisboa" },
  { id: "porto", label: "Porto" },
  { id: "faro", label: "Faro" },
];

type SettingItem = {
  key: string; group: string; label: string; description: string; wiring: "live" | "store";
  defaultValue: unknown; value: unknown; isSet: boolean; updatedAt: string | null; updatedByName: string | null;
};

function ParametersCard() {
  const utils = trpc.useUtils();
  const q = trpc.settings.values.list.useQuery();
  const code = trpc.settings.values.codeConstants.useQuery();
  const audit = trpc.settings.values.audit.useQuery({ limit: 30 });
  const save = trpc.settings.values.set.useMutation({
    onSuccess: (r) => { utils.settings.values.invalidate(); toast.success(r.changed ? "Guardado." : "Sem alterações."); },
    onError: (e) => toast.error(e.message),
  });
  const groups = useMemo(() => {
    const m = new Map<string, SettingItem[]>();
    for (const s of (q.data ?? []) as SettingItem[]) {
      if (s.group === "notificacoes") continue; // tem separador próprio (Notificações)
      if (s.key === "google.sharedCalendars" || s.key === "google.contacts" || s.key === "google.drive") continue; // cartões próprios (Comunicação)
      if (s.key === "marketing.webAnalytics") continue; // cartão próprio (Integrações → Web & SEO)
      if (s.key === "knowledge.config") continue; // cartão próprio (Formação → Base de conhecimento)
      if (!m.has(s.group)) m.set(s.group, []);
      m.get(s.group)!.push(s);
    }
    return Array.from(m.entries());
  }, [q.data]);

  return (
    <div className="space-y-4">
      {q.isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
      {groups.map(([group, items]) => (
        <Card key={group}>
          <CardHeader className="pb-2"><CardTitle className="text-base">{GROUP_LABEL[group] ?? group}</CardTitle></CardHeader>
          <CardContent className="space-y-5">
            {items.map((s) => (
              <SettingEditor key={s.key} item={s} saving={save.isPending}
                codeValue={s.key === "finance.vat" ? code.data?.vatRate : s.key === "finance.tsu" ? code.data?.tsuEmployerRate : undefined}
                onSave={(value) => save.mutate({ key: s.key, value })} />
            ))}
          </CardContent>
        </Card>
      ))}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Histórico de alterações</CardTitle></CardHeader>
        <CardContent>
          {audit.data?.length === 0 && <p className="text-sm text-muted-foreground">Ainda sem alterações.</p>}
          <div className="space-y-1.5">
            {audit.data?.map((a) => (
              <div key={a.id} className="text-xs border-b pb-1.5 last:border-0">
                <div><span className="font-semibold">{a.key}</span> · {a.changedByName ?? "—"} · {fmtPTDateTime(a.changedAt)}</div>
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

function SettingEditor({ item, saving, onSave, codeValue }: { item: SettingItem; saving: boolean; onSave: (v: unknown) => void; codeValue?: number }) {
  const current = item.isSet ? item.value : item.defaultValue;
  const isRate = item.key === "finance.vat" || item.key === "finance.tsu";
  const isEmails = item.key === "emails.handoverCc";
  const isNumber = typeof item.defaultValue === "number";
  const isBool = typeof item.defaultValue === "boolean";
  // Mapa por cidade (ex.: carros/hora por condutor, ponto de encontro).
  const isCityMap = !!item.defaultValue && typeof item.defaultValue === "object" && !Array.isArray(item.defaultValue)
    && CITY_FIELDS.every((c) => c.id in (item.defaultValue as Record<string, unknown>));
  const cityMapNumeric = isCityMap && typeof (item.defaultValue as Record<string, unknown>).lisbon === "number";
  const isTime = typeof item.defaultValue === "string" && /^\d{2}:\d{2}$/.test(item.defaultValue as string);
  const isJson = !!item.defaultValue && typeof item.defaultValue === "object" && !Array.isArray(item.defaultValue) && !isRate && !isEmails && !isCityMap;

  const [rates, setRates] = useState<{ pct: string; from: string }[]>([]);
  const [cityMap, setCityMap] = useState<Record<string, string>>({});
  const [bool, setBool] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    if (isRate) setRates(((current as RateEntry[]) ?? []).map((r) => ({ pct: pct(r.rate), from: r.from })));
    else if (isEmails) setText(((current as string[]) ?? []).join("\n"));
    else if (isCityMap) setCityMap(Object.fromEntries(CITY_FIELDS.map((c) => [c.id, String((current as Record<string, unknown>)?.[c.id] ?? "").replace(".", ",")])));
    else if (isBool) setBool(!!current);
    else if (isJson) setText(current && Object.keys(current as object).length ? JSON.stringify(current, null, 2) : "");
    else setText(current == null ? "" : String(current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(current)]);

  const build = (): unknown => {
    if (isRate) return rates.map((r) => ({ rate: Number(r.pct.replace(",", ".")) / 100, from: r.from.trim() }));
    if (isEmails) return text.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
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
          </div>
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

      {isRate ? (
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
        <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="um email por linha" />
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
        <Button size="sm" onClick={submit} disabled={saving}><Save className="h-4 w-4 mr-1" />Guardar</Button>
        {item.isSet && (
          <Button size="sm" variant="ghost" disabled={saving} onClick={() => onSave(null)}>
            <RotateCcw className="h-4 w-4 mr-1" />Repor omissão
          </Button>
        )}
      </div>
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
          <p className="text-xs text-muted-foreground">Chaves guardadas só como hash; aqui muda-se a data de expiração. Criar/apagar chaves: página API Keys.</p>
        </CardHeader>
        <CardContent className="space-y-2">
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
