// Perfil → Google: que funcionalidades Google estão ativas para a pessoa,
// "Ativar Tarefas e Calendário" (autorização incremental — o Gmail já
// autorizado mantém-se) e o que sincronizar (Tarefas; Calendário: turnos,
// formação, prazos de tarefas, SLAs). O token nunca chega ao browser.
import type { ReactNode } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { AlertTriangle, CalendarDays, CheckCircle2, ListChecks, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { GOOGLE_FEATURE_LABELS, type GoogleFeature } from "@shared/mail";
import { DEFAULT_GOOGLE_SYNC_PREFS, type GoogleSyncPrefs } from "@shared/googleSync";
import { fmtPTDateTime } from "@/lib/lisbonTime";

/** Liga (ou acrescenta) funcionalidades Google — include_granted_scopes no servidor. */
export function googleFeaturesHref(features: GoogleFeature[], returnTo?: string): string {
  const back = returnTo ?? window.location.pathname;
  return `/api/google-account/oauth/start?features=${features.join(",")}&returnTo=${encodeURIComponent(back)}`;
}

const STATUS_LABEL: Record<string, string> = {
  ok: "Sincronizado", partial: "Em curso (continua na próxima corrida)", skipped: "Nada a sincronizar", reauth_required: "Conta por religar",
  scope_missing: "Falta autorizar", rate_limited: "Limite de pedidos da Google — continua daqui a pouco", error: "Erro",
};

type PrefKey = keyof GoogleSyncPrefs;
const CAL_PREFS: Array<{ key: PrefKey; label: string; hint: string }> = [
  { key: "calShifts", label: "Turnos", hint: "Turnos confirmados na escala (TL/supervisor: escala da cidade e passagens de turno só se o super admin as ligar em Definições)." },
  { key: "calTraining", label: "Formação", hint: "Prazos das formações atribuídas." },
  { key: "calTaskDue", label: "Prazos das tarefas", hint: "Um evento por prazo de tarefa atribuída." },
  { key: "calSla", label: "SLAs", hint: "Prazo (SLA) das reclamações atribuídas a ti." },
];

export function GoogleSyncCard({ returnTo = "/perfil" }: { returnTo?: string }) {
  const utils = trpc.useUtils();
  const q = trpc.googleAccount.sync.status.useQuery(undefined, { staleTime: 30_000 });
  const setPrefs = trpc.googleAccount.sync.setPrefs.useMutation({
    onSuccess: () => { utils.googleAccount.sync.status.invalidate(); toast.success("Preferências guardadas. A sincronização corre nos próximos minutos."); },
    onError: (e) => toast.error(e.message),
  });
  const syncNow = trpc.googleAccount.sync.syncNow.useMutation({
    onSuccess: (r) => {
      utils.googleAccount.sync.status.invalidate();
      if (r.status === "ok") toast.success("Sincronizado com o Google.");
      else if (r.status === "partial" || r.status === "rate_limited") toast.message("Sincronização a meio — continua automaticamente.");
      else toast.error(r.error || STATUS_LABEL[r.status] || "Não foi possível sincronizar.");
    },
    onError: (e) => toast.error(e.message),
  });
  const s = q.data;
  if (q.isLoading) return <div className="bg-card border border-border rounded-2xl p-4"><Loader2 className="h-4 w-4 animate-spin" /></div>;
  if (!s || !s.account.configured) return null;
  const connected = s.account.connected;
  const needsReauth = s.account.status === "reauth_required" || s.account.status === "error";
  const prefs = s.prefs ?? DEFAULT_GOOGLE_SYNC_PREFS;
  const missing: GoogleFeature[] = [];
  if (!s.tasksGranted) missing.push("tasks");
  if (!s.calendarGranted) missing.push("calendar");
  const toggle = (key: PrefKey, value: boolean) => setPrefs.mutate({ ...prefs, [key]: value });
  const shown: GoogleFeature[] = ["gmail", "tasks", "calendar"];

  return (
    <div className="bg-card border border-border rounded-2xl shadow-sm p-4 space-y-3">
      <div className="flex items-center gap-3">
        <span className="w-8 h-8 rounded-[9px] bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <CalendarDays className="w-4 h-4" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13.5px] font-semibold text-foreground">Google Tarefas & Calendário</div>
          <div className="text-[11.5px] text-muted-foreground">
            {connected ? "O que está ativo na tua conta Google e o que sincronizar." : "Liga primeiro a tua conta Google (acima)."}
          </div>
        </div>
      </div>

      {connected && (
        <div className="flex flex-wrap gap-1.5">
          {shown.map((f) => {
            const on = s.account.features.find((x) => x.id === f)?.granted ?? false;
            return (
              <Badge key={f} variant="outline" className={on ? "gap-1 border-emerald-500/40 text-emerald-700 dark:text-emerald-300" : "gap-1 text-muted-foreground"}>
                {on ? <CheckCircle2 className="h-3 w-3" /> : null}{GOOGLE_FEATURE_LABELS[f]}{on ? "" : " — inativo"}
              </Badge>
            );
          })}
        </div>
      )}

      {connected && !needsReauth && missing.length > 0 && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
          <p className="text-xs text-foreground">
            Autoriza {missing.map((f) => GOOGLE_FEATURE_LABELS[f]).join(" e ")} para veres as tuas tarefas no Google Tasks e os turnos, prazos e reuniões no teu Google Calendar
            (num calendário próprio "Multipark" — o teu calendário principal não é alterado). O que já autorizaste mantém-se.
          </p>
          <Button asChild size="sm">
            <a href={googleFeaturesHref(missing, returnTo)}><Sparkles className="h-4 w-4 mr-1" />Ativar {missing.length === 2 ? "Tarefas e Calendário" : GOOGLE_FEATURE_LABELS[missing[0]]}</a>
          </Button>
        </div>
      )}

      {connected && (
        <div className="space-y-2">
          <PrefRow icon={<ListChecks className="h-4 w-4 text-primary" />} label="Tarefas ↔ Google Tasks" disabled={!s.tasksGranted || setPrefs.isPending}
            hint={'As tarefas atribuídas a ti aparecem na lista "Multipark" do Google Tasks; o que concluíres ou criares lá volta ao dashboard.'}
            checked={prefs.tasks} onChange={(v) => toggle("tasks", v)} />
          <div className="text-[12px] font-semibold text-foreground pt-1">Calendário</div>
          {CAL_PREFS.map((p) => (
            <PrefRow key={p.key} label={p.label} hint={p.hint} disabled={!s.calendarGranted || setPrefs.isPending}
              checked={!!prefs[p.key]} onChange={(v) => toggle(p.key, v)} />
          ))}
        </div>
      )}

      {connected && (s.lastError || s.lastWarning) && (
        <p className={`text-xs ${s.lastError ? "text-red-700 dark:text-red-300" : "text-amber-800 dark:text-amber-200"}`}>
          <AlertTriangle className="inline h-3 w-3 mr-1" />{s.lastError ?? s.lastWarning}
        </p>
      )}
      {connected && (
        <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground">
          <span>{s.lastRunAt ? `Última sincronização: ${fmtPTDateTime(s.lastRunAt)}` : "Ainda não sincronizou."}</span>
          {s.lastStatus && <span>· {STATUS_LABEL[s.lastStatus] ?? s.lastStatus}</span>}
          {s.linkedTasks > 0 && <span>· {s.linkedTasks} tarefa(s) ligadas</span>}
          {s.rejectedTasks > 0 && <span>· {s.rejectedTasks} criada(s) no Google sem permissão (ficaram só no Google)</span>}
          <Button size="sm" variant="outline" className="ml-auto" disabled={syncNow.isPending || (!s.tasksGranted && !s.calendarGranted)} onClick={() => syncNow.mutate()}>
            {syncNow.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}Sincronizar agora
          </Button>
        </div>
      )}
    </div>
  );
}

function PrefRow({ label, hint, checked, disabled, onChange, icon }: { label: string; hint: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; icon?: ReactNode }) {
  return (
    <label className={`flex items-start gap-3 rounded-lg border px-3 py-2 min-h-[44px] ${disabled ? "opacity-60" : "cursor-pointer"}`}>
      {icon && <span className="mt-0.5">{icon}</span>}
      <span className="flex-1 min-w-0">
        <span className="block text-[13px] font-medium text-foreground">{label}</span>
        <span className="block text-[11.5px] text-muted-foreground">{hint}</span>
      </span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} className="mt-0.5" />
    </label>
  );
}
