// Saúde dos dados da sincronização Multipark: último webhook, último sync
// recente/futuro com sucesso, idade da fila, erros por código/parque,
// parques com erro na última corrida, reconciliação e alertas ativos.
// Usado na página Sincronização (completo) e em Definições → Estado (compacto).
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { AlertTriangle, CheckCircle2, HeartPulse, Loader2 } from "lucide-react";

function ago(ts: number | null | undefined, now: number): string {
  if (!ts) return "nunca";
  const m = Math.round((now - ts) / 60_000);
  if (m < 1) return "agora";
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `há ${h} h` : `há ${Math.round(h / 24)} dias`;
}

const CODE_HELP: Record<string, string> = {
  PARK_ACCESS_MISSING: "parque sem chave",
  PARK_NOT_MAPPED: "parque sem correspondência",
  PARK_CLOSED: "parque fechado (não repete)",
  DETAIL_INCOMPLETE: "detalhe ainda incompleto",
  HISTORY_INCOMPLETE: "histórico incompleto",
  TIMEOUT: "tempo esgotado",
  TOTAL_MISMATCH: "total ≠ lista",
};
const codeLabel = (c: string) => (CODE_HELP[c] ? `${c} · ${CODE_HELP[c]}` : c);
const ACTION_LABEL: Record<string, string> = { creation: "criações", checkin: "check-ins", checkout: "check-outs", cancelation: "cancelamentos" };

function Stat({ label, value, bad, hint }: { label: string; value: string; bad?: boolean; hint?: string }) {
  return (
    <div className={`rounded-lg border p-2 ${bad ? "border-red-300 bg-red-50/60 dark:bg-red-950/20" : ""}`}>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`text-sm font-semibold ${bad ? "text-red-700 dark:text-red-300" : ""}`}>{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function SyncHealthPanel({ compact = false }: { compact?: boolean }) {
  const q = trpc.multipark.dataHealth.useQuery(undefined, { refetchInterval: 60_000, retry: false });
  // Sem acesso (ex.: papel sem Sincronização) → não mostra nada.
  if (q.error?.data?.code === "FORBIDDEN") return null;
  const d = q.data;
  const now = d?.now ?? Date.now();
  const webhookStale = !!d && (d.lastWebhookAt == null || now - d.lastWebhookAt > d.webhookStaleHours * 3_600_000);
  const recentStale = !!d && (d.lastRecentOkAt == null || now - d.lastRecentOkAt > 3 * 3_600_000);
  const futureStale = !!d && (d.lastFutureOkAt == null || now - d.lastFutureOkAt > 6 * 3_600_000);
  const oldestMin = d?.queue.oldestOpenAt ? Math.round((now - d.queue.oldestOpenAt) / 60_000) : null;
  const activeAlerts = d?.alerts.filter((a) => a.active) ?? [];
  const parkErrors = d?.lastRecentRun?.parkErrors ?? [];
  const problems = (webhookStale ? 1 : 0) + (recentStale ? 1 : 0) + parkErrors.length + activeAlerts.length + (d?.queue.dead ? 1 : 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2 flex-wrap">
          <HeartPulse className="w-4 h-4" /> Saúde dos dados Multipark
          {q.isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : d && (problems > 0
            ? <Badge variant="outline" className="bg-red-100 text-red-800 border-red-200">{problems} a verificar</Badge>
            : <Badge variant="outline" className="bg-emerald-100 text-emerald-800 border-emerald-200">Tudo em dia</Badge>)}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {q.error && <p className="text-destructive text-xs">Não foi possível ler a saúde da sincronização.</p>}
        {d && <>
          {activeAlerts.map((a) => (
            <p key={a.key} className="text-xs text-red-700 dark:text-red-300">
              <AlertTriangle className="inline h-3 w-3 mr-1" />
              {a.key === "webhook_stale" ? "Alerta: sem notificações da Multipark" : a.key === "reconciliation_drift" ? "Alerta: reconciliação com diferenças" : a.key}
              {a.detail ? ` — ${a.detail}` : ""}{a.since ? ` (desde ${fmtPTDateTime(a.since)})` : ""}
            </p>
          ))}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Stat label="Último webhook" value={ago(d.lastWebhookAt, now)} bad={webhookStale}
              hint={`alerta > ${d.webhookStaleHours} h (${String(d.operatingHours.start).padStart(2, "0")}–${d.operatingHours.end} h)`} />
            <Stat label="Último sync recente OK" value={ago(d.lastRecentOkAt, now)} bad={recentStale} />
            <Stat label="Último sync futuro OK" value={ago(d.lastFutureOkAt, now)} bad={futureStale} />
            <Stat label="Trabalho mais antigo na fila" value={oldestMin == null ? "fila vazia" : oldestMin < 60 ? `${oldestMin} min` : `${Math.round(oldestMin / 60)} h`}
              bad={oldestMin != null && oldestMin > 120}
              hint={`${d.queue.pending} pend. · ${d.queue.failed} a repetir · ${d.queue.dead} dead`} />
          </div>

          {d.lastRecentRun && (
            parkErrors.length > 0
              ? <p className="text-xs text-red-700 dark:text-red-300"><AlertTriangle className="inline h-3 w-3 mr-1" />
                  Parques com erro no último sync recente ({d.lastRecentRun.at ? fmtPTDateTime(d.lastRecentRun.at) : "—"}): {parkErrors.map((p) => p.label).join(", ")}.
                  A janela destes parques alarga sozinha até recuperar (máx. 3 dias).</p>
              : <p className="text-xs text-muted-foreground"><CheckCircle2 className="inline h-3 w-3 mr-1 text-emerald-600" />
                  Último sync recente sem parques com erro{d.lastRecentRun.skippedJobs ? ` (parcial: ${d.lastRecentRun.skippedJobs} por fazer)` : ""}{d.lastRecentRun.totalMismatches ? ` · ${d.lastRecentRun.totalMismatches} report(s) com total ≠ lista` : ""}.</p>
          )}
          {d.lock && <p className="text-xs text-muted-foreground">Sincronização a correr agora ({d.lock.owner ?? "—"}).</p>}

          {!compact && (
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <div className="text-xs font-semibold mb-1">Fila: falhas por código</div>
                {d.queueErrors.length === 0 ? <p className="text-xs text-muted-foreground">Sem falhas.</p> : (
                  <table className="w-full text-xs"><tbody>
                    {d.queueErrors.map((r) => (
                      <tr key={`${r.state}-${r.code}`} className="border-t">
                        <td className="py-1">{codeLabel(r.code)}</td>
                        <td className="py-1 text-muted-foreground">{r.state === "dead" ? "dead-letter" : "a repetir"}</td>
                        <td className="py-1 text-right font-medium">{r.n}</td>
                      </tr>
                    ))}
                  </tbody></table>
                )}
              </div>
              <div>
                <div className="text-xs font-semibold mb-1">Detalhe / histórico: erros por código e parque</div>
                {d.bookingErrors.length === 0 ? <p className="text-xs text-muted-foreground">Sem erros.</p> : (
                  <div className="max-h-56 overflow-y-auto">
                    <table className="w-full text-xs"><tbody>
                      {d.bookingErrors.map((r) => (
                        <tr key={`${r.kind}-${r.code}-${r.park}`} className="border-t">
                          <td className="py-1">{r.kind === "detail" ? "detalhe" : "histórico"}</td>
                          <td className="py-1">{codeLabel(r.code)}</td>
                          <td className="py-1 text-muted-foreground">{r.park}</td>
                          <td className="py-1 text-right font-medium">{r.n}</td>
                        </tr>
                      ))}
                    </tbody></table>
                  </div>
                )}
              </div>
            </div>
          )}

          <div>
            <div className="text-xs font-semibold mb-1">
              Reconciliação diária (report D-1/D-2 vs BD){d.reconciliation.lastCheckedAt ? ` · ${fmtPTDateTime(d.reconciliation.lastCheckedAt)}` : ""}
            </div>
            {d.reconciliation.lastCheckedAt == null ? <p className="text-xs text-muted-foreground">Ainda não correu (corre no daily-ops).</p>
              : d.reconciliation.rows.length === 0 ? <p className="text-xs text-muted-foreground"><CheckCircle2 className="inline h-3 w-3 mr-1 text-emerald-600" />Sem diferenças nos últimos 7 dias.</p>
              : (
                <div className="max-h-56 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead><tr className="text-muted-foreground"><th className="text-left">Dia</th><th className="text-left">Parque</th><th className="text-left">Ação</th><th className="text-right">Report</th><th className="text-right">Na BD</th><th className="text-right">Em falta</th><th className="text-left pl-2">Nota</th></tr></thead>
                    <tbody>
                      {(compact ? d.reconciliation.rows.slice(0, 8) : d.reconciliation.rows).map((r) => (
                        <tr key={`${r.day}-${r.parkId}-${r.actionType}`} className="border-t">
                          <td className="py-1">{r.day}</td>
                          <td className="py-1">{r.label}</td>
                          <td className="py-1">{ACTION_LABEL[r.actionType] ?? r.actionType}</td>
                          <td className="py-1 text-right">{r.apiCount}{r.apiTotal != null && r.apiTotal !== r.apiCount ? ` (total ${r.apiTotal})` : ""}</td>
                          <td className="py-1 text-right">{r.dbFound}</td>
                          <td className={`py-1 text-right font-medium ${r.missing > 0 ? "text-red-700" : ""}`}>{r.missing}</td>
                          <td className="py-1 pl-2 text-muted-foreground">{r.status === "error" ? `erro ${r.errorCode ?? ""}` : r.errorCode ? codeLabel(r.errorCode) : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </div>
        </>}
      </CardContent>
    </Card>
  );
}
