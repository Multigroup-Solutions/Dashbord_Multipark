/**
 * Peças partilhadas da avaliação (individual, "A minha avaliação" e
 * operacional): linhas de pontuação por regra, legenda, detalhe (gaveta) com
 * os dias e métricas por trás de uma pontuação, ajustes e contestações.
 * As regras vêm de shared/evaluationRules.ts — o mesmo ficheiro do motor.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import EvaluationExplanation from "@/components/aiOps/EvaluationExplanation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChevronDown, ChevronRight, MessageSquareWarning, Pencil, Undo2 } from "lucide-react";
import {
  ADJUSTABLE_METRICS,
  DISPUTE_STATUS_LABELS,
  EVALUATION_POINTS,
  EVALUATION_RULES,
  METRIC_LABELS,
  type DayMetrics,
  type DisputeStatus,
  type MetricKey,
  type RuleLine,
} from "@shared/evaluationRules";

// ─── Formatação ──────────────────────────────────────────────────────────────

const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
export function fmtDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")} (${wd})`;
}
export const fmtNum = (n: number | null | undefined, digits = 1) =>
  n == null ? "—" : Number(n).toLocaleString("pt-PT", { maximumFractionDigits: digits });
export const fmtPts = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmtNum(Math.abs(n), 2)}`;
export const ptsClass = (n: number) => (n > 0 ? "text-green-700" : n < 0 ? "text-red-700" : "text-muted-foreground");

const SHIFT_LABEL: Record<string, string> = { morning: "Manhã", night: "Noite" };

// ─── Linhas por regra ────────────────────────────────────────────────────────

/** Uma linha por regra (contagem × pontos = subtotal) + total. */
export function RuleLinesTable({ lines, total, hideZero = false }: { lines: RuleLine[]; total: number; hideZero?: boolean }) {
  const shown = hideZero ? lines.filter((l) => l.count !== 0) : lines;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase text-muted-foreground border-b">
            <th className="text-left py-1 pr-2 font-medium">Regra</th>
            <th className="text-right py-1 px-2 font-medium">Qtd.</th>
            <th className="text-right py-1 px-2 font-medium">Pts</th>
            <th className="text-right py-1 pl-2 font-medium">Subtotal</th>
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 && (
            <tr><td colSpan={4} className="py-2 text-muted-foreground text-xs">Sem pontos neste período.</td></tr>
          )}
          {shown.map((l) => (
            <tr key={l.key} className="border-b last:border-0">
              <td className="py-1 pr-2">{l.label}</td>
              <td className="py-1 px-2 text-right tabular-nums">{fmtNum(l.count, 2)}</td>
              <td className="py-1 px-2 text-right tabular-nums text-muted-foreground">{l.key === "manual" ? "—" : fmtPts(l.points)}</td>
              <td className={`py-1 pl-2 text-right tabular-nums font-medium ${ptsClass(l.subtotal)}`}>{fmtPts(l.subtotal)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t">
            <td className="pt-2 font-semibold" colSpan={3}>Total</td>
            <td className={`pt-2 text-right tabular-nums font-bold ${ptsClass(total)}`}>{fmtPts(total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** Legenda das regras (a mesma nas duas páginas). */
export function RulesLegend() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
      {EVALUATION_RULES.map((r) => {
        const p = EVALUATION_POINTS[r.key];
        return (
          <div key={r.key} className="flex items-baseline justify-between gap-3 border-b border-dashed py-1">
            <span className="text-muted-foreground">
              {r.label}
              {r.key === "firstMoveAfterPickup" && <span className="block text-[11px]">substitui os {fmtPts(EVALUATION_POINTS.movement)} desse movimento</span>}
              {r.key === "delay" && <span className="block text-[11px]">entrada no ponto depois da escala ou entrega &gt; 15 min</span>}
            </span>
            <span className={`font-semibold tabular-nums ${ptsClass(p)}`}>{fmtPts(p)}</span>
          </div>
        );
      })}
      <p className="sm:col-span-2 text-[11px] text-muted-foreground pt-1">
        Os totais podem ser negativos. Ponto marcado [SUSPEITO] não conta horas. Dia operacional: 03h→03h (manhã 03h–15h, noite 15h–03h).
      </p>
    </div>
  );
}

// ─── Métricas ────────────────────────────────────────────────────────────────

const SHOWN_METRICS: MetricKey[] = [
  "hoursWorked", "scheduledHours", "suspiciousHours", "actions", "recolhas", "entregas", "movements", "parkingMoves",
  "weightedActions", "delays", "lateServices", "speedingEvents", "complaints", "accidents", "incidentsReported", "penaltyPoints", "cost",
];

export function MetricsGrid({ metrics, base, hideZero = false }: { metrics: DayMetrics; base?: DayMetrics; hideZero?: boolean }) {
  const keys = SHOWN_METRICS.filter((k) => !hideZero || metrics[k] !== 0 || (base && base[k] !== 0));
  if (keys.length === 0) return <p className="text-xs text-muted-foreground">Sem métricas.</p>;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      {keys.map((k) => {
        const changed = base && base[k] !== metrics[k];
        return (
          <div key={k} className="rounded-md border p-2">
            <div className="text-[11px] text-muted-foreground leading-tight">{METRIC_LABELS[k]}</div>
            <div className="font-semibold tabular-nums">
              {k === "cost" ? `${fmtNum(metrics[k], 2)} €` : fmtNum(metrics[k], 2)}
              {changed && <span className="ml-1 text-[11px] font-normal text-amber-700" title="Com ajuste manual">(calc. {fmtNum(base![k], 2)})</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function PerHourStrip({ perHour }: { perHour: { hours: number; actionsPerHour: number | null; weightedPerHour: number | null; pointsPerHour: number | null } }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
      <div className="rounded-md bg-muted/50 p-2"><div className="text-[11px] text-muted-foreground">Horas usadas</div><div className="font-semibold tabular-nums">{fmtNum(perHour.hours, 2)} h</div></div>
      <div className="rounded-md bg-muted/50 p-2"><div className="text-[11px] text-muted-foreground">Ações/h</div><div className="font-semibold tabular-nums">{fmtNum(perHour.actionsPerHour, 2)}</div></div>
      <div className="rounded-md bg-muted/50 p-2"><div className="text-[11px] text-muted-foreground">Pts ações/h</div><div className="font-semibold tabular-nums">{fmtNum(perHour.weightedPerHour, 2)}</div></div>
      <div className="rounded-md bg-muted/50 p-2"><div className="text-[11px] text-muted-foreground">Pontos/h</div><div className="font-semibold tabular-nums">{fmtNum(perHour.pointsPerHour, 2)}</div></div>
    </div>
  );
}

// ─── Detalhe de uma pessoa ───────────────────────────────────────────────────

type Detail = {
  days: any[];
  totals: { metrics: DayMetrics; score: { totalPoints: number; lines: RuleLine[] }; perHour: any; days: number } | null;
  disputes: any[];
};

/**
 * Dias, métricas e pontuação de uma pessoa num período. `mode="self"` =
 * "A minha avaliação" (pode contestar); `mode="manage"` + `canAdjust` =
 * gestor (ajustar/anular ajustes).
 */
export function EmployeeEvaluationDetail({
  employeeId, detail, mode, canAdjust = false, onChanged,
}: { employeeId: number; detail: Detail; mode: "self" | "manage"; canAdjust?: boolean; onChanged?: () => void }) {
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [adjustDay, setAdjustDay] = useState<string | null>(null);
  const [disputeDay, setDisputeDay] = useState<string | null>(null);
  const voidMut = trpc.evaluation.voidAdjustment.useMutation({
    onSuccess: () => { toast.success("Ajuste anulado"); onChanged?.(); },
    onError: (e) => toast.error(e.message),
  });
  const t = detail.totals;
  const days = [...detail.days].sort((a, b) => (a.day < b.day ? 1 : -1));

  return (
    <div className="space-y-5">
      {t && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Pontuação do período · {t.days} dia(s)</h3>
          <RuleLinesTable lines={t.score.lines} total={t.score.totalPoints} />
        </section>
      )}
      {t && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Por hora <span className="font-normal text-muted-foreground">(vista secundária — não entra na pontuação)</span></h3>
          <PerHourStrip perHour={t.perHour} />
        </section>
      )}
      {t && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Métricas</h3>
          <MetricsGrid metrics={t.metrics} hideZero />
        </section>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Dias</h3>
        {days.length === 0 && <p className="text-sm text-muted-foreground">Sem dias calculados neste período.</p>}
        <div className="divide-y rounded-md border">
          {days.map((d) => {
            const isOpen = openDay === d.day;
            const activeAdj = d.adjustments.filter((a: any) => !a.voidedAt).length;
            return (
              <div key={d.day}>
                <button type="button" className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/40" onClick={() => setOpenDay(isOpen ? null : d.day)}>
                  {isOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                  <span className="font-medium tabular-nums">{fmtDay(d.day)}</span>
                  {d.shift && <Badge variant="outline" className="text-[11px]">{SHIFT_LABEL[d.shift] ?? d.shift}</Badge>}
                  {activeAdj > 0 && <Badge variant="secondary" className="text-[11px] bg-amber-100 text-amber-800">ajustado</Badge>}
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums hidden sm:inline">{d.metrics.actions} ações · {fmtNum(d.metrics.hoursWorked)} h</span>
                  <span className={`w-16 text-right font-semibold tabular-nums ${ptsClass(d.score.totalPoints)}`}>{fmtPts(d.score.totalPoints)}</span>
                </button>
                {isOpen && (
                  <div className="px-3 pb-3 space-y-3">
                    <RuleLinesTable lines={d.score.lines} total={d.score.totalPoints} hideZero />
                    <MetricsGrid metrics={d.metrics} base={d.base} hideZero />
                    {Object.keys(d.actionsByType ?? {}).length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(d.actionsByType).map(([k, v]) => <Badge key={k} variant="outline" className="text-[11px]">{k}: {String(v)}</Badge>)}
                      </div>
                    )}
                    {d.adjustments.length > 0 && (
                      <div className="space-y-1">
                        <div className="text-xs font-semibold">Ajustes manuais</div>
                        {d.adjustments.map((a: any) => (
                          <div key={a.id} className={`flex items-start gap-2 text-xs rounded border p-2 ${a.voidedAt ? "opacity-60 line-through" : ""}`}>
                            <div className="flex-1 min-w-0">
                              <span className="font-medium">{METRIC_LABELS[a.metric as MetricKey] ?? a.metric} {a.delta > 0 ? "+" : ""}{fmtNum(a.delta, 2)}</span>
                              <span className="text-muted-foreground"> · {a.authorName ?? "—"} · {a.createdAt.slice(0, 16)}</span>
                              <div className="text-muted-foreground break-words">{a.reason}</div>
                              {a.voidedAt && <div className="no-underline">Anulado{a.voidReason ? `: ${a.voidReason}` : ""}</div>}
                            </div>
                            {mode === "manage" && canAdjust && !a.voidedAt && (
                              <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" title="Anular ajuste" disabled={voidMut.isPending}
                                onClick={() => { const reason = prompt("Motivo para anular (opcional)") ?? undefined; voidMut.mutate({ id: a.id, reason }); }}>
                                <Undo2 className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {mode === "manage" && canAdjust && (
                        <Button size="sm" variant="outline" onClick={() => setAdjustDay(d.day)}><Pencil className="h-3.5 w-3.5 mr-1" /> Ajustar</Button>
                      )}
                      {mode === "self" && (
                        <Button size="sm" variant="outline" onClick={() => setDisputeDay(d.day)}><MessageSquareWarning className="h-3.5 w-3.5 mr-1" /> Contestar</Button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {detail.disputes.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Contestações</h3>
          <DisputeList disputes={detail.disputes} />
        </section>
      )}

      {adjustDay && (
        <AdjustDialog employeeId={employeeId} day={adjustDay} onClose={() => setAdjustDay(null)} onDone={() => { setAdjustDay(null); onChanged?.(); }} />
      )}
      {disputeDay && (
        <DisputeDialog day={disputeDay} onClose={() => setDisputeDay(null)} onDone={() => { setDisputeDay(null); onChanged?.(); }} />
      )}
    </div>
  );
}

export function DisputeList({ disputes, onResolve }: { disputes: any[]; onResolve?: (d: any) => void }) {
  return (
    <div className="space-y-2">
      {disputes.map((d) => (
        <div key={d.id} className="rounded-md border p-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            {d.employeeName && onResolve && <span className="font-medium">{d.employeeName}</span>}
            <span className="tabular-nums">{fmtDay(d.day)}</span>
            {d.metric && <Badge variant="outline" className="text-[11px]">{METRIC_LABELS[d.metric as MetricKey] ?? d.metric}</Badge>}
            <Badge className={`text-[11px] ${d.status === "open" ? "bg-amber-100 text-amber-800" : d.status === "accepted" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`} variant="secondary">
              {DISPUTE_STATUS_LABELS[d.status as DisputeStatus] ?? d.status}
            </Badge>
            {onResolve && d.status === "open" && (
              <Button size="sm" variant="outline" className="ml-auto h-7" onClick={() => onResolve(d)}>Decidir</Button>
            )}
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words">{d.comment}</p>
          {d.resolution && (
            <p className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap break-words">
              Decisão ({d.resolvedByName ?? "—"}): {d.resolution}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Diálogos ────────────────────────────────────────────────────────────────

function MetricSelect({ value, onChange, keys, allowNone }: { value: string; onChange: (v: string) => void; keys: MetricKey[]; allowNone?: boolean }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full"><SelectValue placeholder="Escolhe a métrica" /></SelectTrigger>
      <SelectContent>
        {allowNone && <SelectItem value="none">O dia todo</SelectItem>}
        {keys.map((k) => <SelectItem key={k} value={k}>{METRIC_LABELS[k]}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function AdjustDialog({ employeeId, day, onClose, onDone }: { employeeId: number; day: string; onClose: () => void; onDone: () => void }) {
  const [metric, setMetric] = useState<string>("bonusPoints");
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const mut = trpc.evaluation.adjust.useMutation({
    onSuccess: () => { toast.success("Ajuste guardado"); onDone(); },
    onError: (e) => toast.error(e.message),
  });
  const n = Number(delta.replace(",", "."));
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Ajustar {fmtDay(day)}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">O ajuste soma-se ao valor calculado (que não muda) e fica registado com o teu nome e o motivo.</p>
          <div><Label className="text-xs">Métrica</Label><MetricSelect value={metric} onChange={setMetric} keys={ADJUSTABLE_METRICS} /></div>
          <div><Label className="text-xs">Diferença (ex.: −1, +2)</Label><Input inputMode="decimal" value={delta} onChange={(e) => setDelta(e.target.value)} placeholder="-1" /></div>
          <div><Label className="text-xs">Motivo</Label><Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Porquê este ajuste?" /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={mut.isPending || !Number.isFinite(n) || n === 0 || reason.trim().length < 3}
            onClick={() => mut.mutate({ employeeId, day, metric, delta: n, reason: reason.trim() })}>
            {mut.isPending ? "A guardar..." : "Guardar ajuste"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DisputeDialog({ day, onClose, onDone }: { day: string; onClose: () => void; onDone: () => void }) {
  const [metric, setMetric] = useState<string>("none");
  const [comment, setComment] = useState("");
  const mut = trpc.evaluation.disputes.create.useMutation({
    onSuccess: () => { toast.success("Contestação enviada"); onDone(); },
    onError: (e) => toast.error(e.message),
  });
  const keys: MetricKey[] = ["actions", "recolhas", "entregas", "movements", "parkingMoves", "hoursWorked", "delays", "speedingEvents", "complaints", "accidents"];
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Contestar {fmtDay(day)}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label className="text-xs">O que está errado?</Label><MetricSelect value={metric} onChange={setMetric} keys={keys} allowNone /></div>
          <div><Label className="text-xs">Comentário</Label><Textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Explica o que aconteceu (ex.: fiz 3 entregas, só aparecem 2)" /></div>
          <p className="text-xs text-muted-foreground">Um gestor vai analisar e aceitar (corrigindo o valor) ou recusar.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={mut.isPending || comment.trim().length < 5}
            onClick={() => mut.mutate({ day, metric: metric === "none" ? null : metric, comment: comment.trim() })}>
            {mut.isPending ? "A enviar..." : "Enviar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ResolveDisputeDialog({ dispute, onClose, onDone }: { dispute: any; onClose: () => void; onDone: () => void }) {
  const [resolution, setResolution] = useState("");
  const [metric, setMetric] = useState<string>(dispute.metric && (ADJUSTABLE_METRICS as string[]).includes(dispute.metric) ? dispute.metric : "none");
  const [delta, setDelta] = useState("");
  const mut = trpc.evaluation.disputes.resolve.useMutation({
    onSuccess: () => { toast.success("Contestação decidida"); onDone(); },
    onError: (e) => toast.error(e.message),
  });
  const n = Number(delta.replace(",", "."));
  const withAdj = metric !== "none" && delta.trim() !== "";
  const decide = (accept: boolean) => mut.mutate({
    id: dispute.id, accept, resolution: resolution.trim(),
    adjustment: accept && withAdj ? { metric, delta: n } : null,
  });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Contestação de {dispute.employeeName ?? "—"} · {fmtDay(dispute.day)}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-sm whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2">{dispute.comment}</p>
          <div><Label className="text-xs">Decisão / resposta</Label><Textarea value={resolution} onChange={(e) => setResolution(e.target.value)} /></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div><Label className="text-xs">Corrigir (se aceitar)</Label><MetricSelect value={metric} onChange={setMetric} keys={ADJUSTABLE_METRICS} allowNone /></div>
            <div><Label className="text-xs">Diferença</Label><Input inputMode="decimal" value={delta} onChange={(e) => setDelta(e.target.value)} disabled={metric === "none"} placeholder="+1" /></div>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button variant="destructive" disabled={mut.isPending || resolution.trim().length < 3} onClick={() => decide(false)}>Recusar</Button>
          <Button disabled={mut.isPending || resolution.trim().length < 3 || (withAdj && (!Number.isFinite(n) || n === 0))} onClick={() => decide(true)}>Aceitar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Gaveta ──────────────────────────────────────────────────────────────────

/** Gaveta com o detalhe de uma pessoa (clicar na pontuação). */
export function EvaluationDrawer({
  employeeId, employeeName, from, to, canAdjust, onOpenChange,
}: { employeeId: number | null; employeeName: string; from: string; to: string; canAdjust: boolean; onOpenChange: (open: boolean) => void }) {
  const utils = trpc.useUtils();
  const q = trpc.evaluation.employeeDays.useQuery(
    { employeeId: employeeId ?? 0, from, to },
    { enabled: employeeId != null && !!from && !!to },
  );
  const refresh = () => {
    utils.evaluation.employeeDays.invalidate();
    utils.evaluation.ranking.invalidate();
    utils.multipark.dayEvaluation.invalidate();
  };
  return (
    <Sheet open={employeeId != null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{employeeName}</SheetTitle>
          <SheetDescription>{from === to ? fmtDay(from) : `${fmtDay(from)} a ${fmtDay(to)}`} · de onde vem a pontuação</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          {q.isLoading && <p className="text-sm text-muted-foreground">A carregar...</p>}
          {q.error && <p className="text-sm text-red-700">{q.error.message}</p>}
          {q.data && employeeId != null && (
            <div className="space-y-4">
              <EvaluationExplanation employeeId={employeeId} from={from} to={to} />
              <EmployeeEvaluationDetail employeeId={employeeId} detail={q.data as any} mode="manage" canAdjust={canAdjust} onChanged={refresh} />
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
