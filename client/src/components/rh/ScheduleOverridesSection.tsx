/**
 * Ficha → Horário → "Exceções por data" (plano 63, passo 10b; interruptor
 * FINS_DE_SEMANA). Um dia diferente do horário fixo: "trabalha das HH:MM às
 * HH:MM" (fim de semana de serviço, feriado de serviço, troca) ou "folga"
 * (compensação, não é a vez). Ganha ao horário fixo nesse dia no atraso e nas
 * possíveis faltas. Uma por dia; cancelar não apaga. Desligado: não aparece.
 */
import { useMemo, useState } from "react";
import { CalendarClock, Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { OVERRIDE_REASONS, OVERRIDE_REASON_LABELS, type OverrideReason } from "@shared/workSchedule";
import { dayLabelPt, isWeekendDay } from "@shared/weekendRotation";
import { lisbonDayOf } from "@shared/lisbonDay";

const suggestReason = (day: string, kind: "work" | "off"): OverrideReason =>
  kind === "off" ? "compensation" : day && isWeekendDay(day) ? "weekend" : "other";

export function ScheduleOverridesSection({ employeeId }: { employeeId: number }) {
  const utils = trpc.useUtils();
  const [showCancelled, setShowCancelled] = useState(false);
  const q = trpc.rh.weekends.forEmployee.useQuery({ employeeId, includeCancelled: showCancelled });
  const today = useMemo(() => lisbonDayOf(Date.now()), []);
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState("");
  const [kind, setKind] = useState<"work" | "off">("work");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("18:00");
  const [reason, setReason] = useState<OverrideReason>("other");
  const [reasonTouched, setReasonTouched] = useState(false);
  const [note, setNote] = useState("");

  const refresh = () => { utils.rh.weekends.forEmployee.invalidate({ employeeId }); utils.rh.weekends.mine.invalidate(); };
  const set = trpc.rh.weekends.set.useMutation({
    onSuccess: (r) => {
      refresh();
      const comp = r.compensationCancelled ? ` A folga de compensação de ${dayLabelPt(r.compensationCancelled)} também foi cancelada.` : "";
      toast.success(r.unchanged ? "Já estava assim." : `${r.replaced ? "Exceção substituída (a anterior ficou cancelada)." : "Exceção marcada."}${comp}`);
      setOpen(false); setNote("");
    },
    onError: (e) => toast.error(e.message),
  });
  const cancel = trpc.rh.weekends.cancel.useMutation({
    onSuccess: (r) => { refresh(); toast.success(`Exceção cancelada: nesse dia volta o horário fixo.${r.compensationCancelled ? ` A folga de compensação de ${dayLabelPt(r.compensationCancelled)} também foi cancelada.` : ""}`); },
    onError: (e) => toast.error(e.message),
  });

  if (q.error) return <div className="mt-4"><QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="as exceções por data" /></div>;
  if (!q.data || !q.data.enabled) return null;
  const { items, canEdit } = q.data;
  const chooseKind = (k: "work" | "off") => { setKind(k); if (!reasonTouched) setReason(suggestReason(day, k)); };
  const chooseDay = (d: string) => { setDay(d); if (!reasonTouched) setReason(suggestReason(d, kind)); };

  return (
    <Card className="mt-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><CalendarClock className="w-4 h-4 text-primary" /> Exceções por data</CardTitle>
        <CardDescription>
          Um dia diferente do horário fixo: fim de semana de serviço, feriado de serviço, troca ou folga. Nesse dia ganha ao horário fixo (atraso e possíveis faltas). Uma por dia; cancelar não apaga.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sem exceções{showCancelled ? "" : " ativas"} — vale o horário fixo.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border">
            {items.map((o) => (
              <li key={o.id} className={`flex flex-wrap items-center gap-x-3 gap-y-1 p-2.5 text-sm ${!o.active || o.day < today ? "opacity-60" : ""}`}>
                <span className="w-28 shrink-0 font-medium">{dayLabelPt(o.day)} {o.day.slice(0, 4)}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${o.kind === "work" ? "bg-primary/10 text-primary" : "bg-amber-500/15 text-amber-800 dark:text-amber-200"}`}>
                  {o.kind === "work" ? `Trabalha ${o.startTime}–${o.endTime}` : "Folga"}
                </span>
                <span className="text-xs text-muted-foreground">{OVERRIDE_REASON_LABELS[o.reason as OverrideReason] ?? o.reason}</span>
                {o.note && <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">· {o.note}</span>}
                {!o.active && <span className="text-xs text-muted-foreground">· cancelada</span>}
                {canEdit && o.active && (
                  <Button size="sm" variant="ghost" className="ml-auto h-7 px-2 text-destructive" disabled={cancel.isPending}
                    aria-label={`Cancelar a exceção de ${dayLabelPt(o.day)}`}
                    onClick={() => { if (confirm(`Cancelar a exceção de ${dayLabelPt(o.day)}? Nesse dia volta o horário fixo.`)) cancel.mutate({ id: o.id }); }}>
                    <X className="w-3.5 h-3.5" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {canEdit && !open && (
            <Button size="sm" variant="outline" onClick={() => { setOpen(true); if (!day) chooseDay(today); }}>
              <Plus className="w-3.5 h-3.5 mr-1" /> Marcar exceção
            </Button>
          )}
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} /> Ver as canceladas
          </label>
        </div>
        {canEdit && open && (
          <div className="rounded-lg border p-3 space-y-3 bg-muted/20">
            <div className="flex flex-wrap items-center gap-2">
              <Input type="date" value={day} onChange={(e) => chooseDay(e.target.value)} className="w-40" aria-label="Data" />
              <Button size="sm" variant={kind === "work" ? "selected" : "outline"} onClick={() => chooseKind("work")}>Trabalha</Button>
              <Button size="sm" variant={kind === "off" ? "selected" : "outline"} onClick={() => chooseKind("off")}>Folga</Button>
              {kind === "work" && (
                <>
                  <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="w-28" aria-label="Entrada" />
                  <span className="text-muted-foreground">—</span>
                  <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="w-28" aria-label="Saída" />
                </>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={reason} onValueChange={(v) => { setReason(v as OverrideReason); setReasonTouched(true); }}>
                <SelectTrigger className="w-full sm:w-56" aria-label="Motivo"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {OVERRIDE_REASONS.map((r) => <SelectItem key={r} value={r}>{OVERRIDE_REASON_LABELS[r]}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input value={note} maxLength={255} onChange={(e) => setNote(e.target.value)} placeholder="Nota (opcional)" className="flex-1 min-w-[160px]" />
            </div>
            {kind === "work" && endTime <= startTime && startTime !== endTime && (
              <p className="text-xs text-muted-foreground">A saída é no dia seguinte (turno da noite).</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="selected" disabled={!day || set.isPending}
                onClick={() => set.mutate({ employeeId, day, kind, startTime: kind === "work" ? startTime : null, endTime: kind === "work" ? endTime : null, reason, note: note || null })}>
                {set.isPending && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />} Guardar
              </Button>
              <Button size="sm" variant="outline" onClick={() => setOpen(false)}>Fechar</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
