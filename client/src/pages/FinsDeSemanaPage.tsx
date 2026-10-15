/**
 * RH → Fins de semana (plano 63, passo 10b; interruptor FINS_DE_SEMANA).
 * Cada funcionário tem o seu horário fixo e o fim de semana RODA: aqui
 * marca-se, por cidade, quem está de serviço em cada sábado e domingo (as
 * horas por omissão são as do horário da pessoa nesse dia; sem ele 09–18),
 * com a folga de compensação proposta no mesmo mês, os avisos (fim de semana
 * sem ninguém, 7 dias sem folga, folga noutro mês) e "Repetir a rotação".
 * Grava exceções por data (`rh.weekends`); nunca apaga nada.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { AlertTriangle, ArrowLeft, CalendarDays, Loader2, Plus, Repeat, UserX, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { usePersistedState } from "@/hooks/usePersistedState";
import { addDays, lisbonDayOf } from "@shared/lisbonDay";
import { dayLabelPt } from "@shared/weekendRotation";

type City = "lisbon" | "porto" | "faro";
const CITY_LABELS: Record<City, string> = { lisbon: "Lisboa", porto: "Porto", faro: "Faro" };
const WEEK_OPTIONS = [4, 8, 12, 26];
const STATUS_LABELS: Record<string, string> = {
  create: "marca", existing: "já tem exceção nesse dia", leave: "de férias/baixa", past: "dia passado", forbidden: "não podes marcar", inactive: "já não está na cidade", contract: "fora do contrato",
};

const weekendTitle = (sat: string) => {
  const sun = addDays(sat, 1);
  return `${dayLabelPt(sat)} – ${dayLabelPt(sun)}`;
};

export default function FinsDeSemanaPage() {
  const [, navigate] = useLocation();
  const today = useMemo(() => lisbonDayOf(Date.now()), []);
  const [city, setCity] = usePersistedState<City>("fds.city", "lisbon");
  const [from, setFrom] = usePersistedState<string>("fds.from", today);
  const [weeks, setWeeks] = usePersistedState<number>("fds.weeks", 8);
  const status = trpc.rh.weekends.status.useQuery();
  const board = trpc.rh.weekends.board.useQuery({ city, from: from || today, weeks }, { enabled: !!status.data?.canManage });
  const utils = trpc.useUtils();
  const refresh = () => { utils.rh.weekends.board.invalidate(); utils.rh.weekends.forEmployee.invalidate(); utils.rh.weekends.mine.invalidate(); };
  const [duty, setDuty] = useState<{ saturday: string } | null>(null);
  const [rotation, setRotation] = useState(false);

  const set = trpc.rh.weekends.set.useMutation({ onSuccess: () => { refresh(); toast.success("Folga marcada nesse dia."); }, onError: (e) => toast.error(e.message) });
  const cancel = trpc.rh.weekends.cancel.useMutation({
    onSuccess: (r) => {
      refresh();
      toast.success(`Cancelado: nesse dia volta o horário fixo.${r.compensationCancelled ? ` A folga de compensação de ${dayLabelPt(r.compensationCancelled)} também foi cancelada.` : ""}`);
    },
    onError: (e) => toast.error(e.message),
  });

  if (status.isLoading) return <div className="py-24 flex justify-center"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
  if (status.error) return <div className="p-4"><QueryErrorNote error={status.error} onRetry={() => status.refetch()} retrying={status.isFetching} what="os fins de semana" /></div>;
  if (!status.data?.enabled || !status.data.canManage) {
    return (
      <div className="max-w-xl mx-auto p-4 space-y-3">
        <Button variant="outline" size="sm" onClick={() => navigate("/rh")}><ArrowLeft className="w-4 h-4 mr-1" /> RH</Button>
        <div role="status" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
          {!status.data?.enabled
            ? <>Os fins de semana ainda estão desligados. O super admin liga-os em <strong>Definições → Automações → "RH: fins de semana e exceções por data"</strong>.</>
            : <>Os fins de semana marcam-nos o supervisor da cidade, o RH (back office) e os administradores.</>}
        </div>
      </div>
    );
  }

  const data = board.data;
  const people = data?.people ?? [];
  const editable = people.filter((p) => p.canEdit);

  return (
    <div className="space-y-4 max-w-6xl mx-auto w-full">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => navigate("/rh")}><ArrowLeft className="w-4 h-4 mr-1" /> RH</Button>
        <div className="min-w-0">
          <h1 className="text-xl font-bold flex items-center gap-2"><CalendarDays className="h-5 w-5 text-primary" /> Fins de semana</h1>
          <p className="text-sm text-muted-foreground">Quem está de serviço em cada sábado e domingo. O horário fixo de cada um fica; aqui marca-se a rotação, por data.</p>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">Cidade</div>
          <Select value={city} onValueChange={(v) => setCity(v as City)}>
            <SelectTrigger className="w-36" aria-label="Cidade"><SelectValue /></SelectTrigger>
            <SelectContent>{(Object.keys(CITY_LABELS) as City[]).map((c) => <SelectItem key={c} value={c}>{CITY_LABELS[c]}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">A partir de</div>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value || today)} className="w-40" aria-label="A partir de" />
        </div>
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">Fins de semana</div>
          <Select value={String(weeks)} onValueChange={(v) => setWeeks(Number(v))}>
            <SelectTrigger className="w-24" aria-label="Quantos fins de semana"><SelectValue /></SelectTrigger>
            <SelectContent>{WEEK_OPTIONS.map((w) => <SelectItem key={w} value={String(w)}>{w}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <Button size="sm" variant="outline" className="sm:ml-auto" disabled={!data || !editable.length} onClick={() => setRotation(true)}>
          <Repeat className="w-4 h-4 mr-1" /> Repetir a rotação
        </Button>
      </div>

      {board.error && <QueryErrorNote error={board.error} onRetry={() => board.refetch()} retrying={board.isFetching} what="os fins de semana" />}
      {board.isLoading && <div className="py-12 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>}

      {data && data.warnings.length > 0 && (
        <div role="status" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200 space-y-1">
          <div className="font-semibold flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> Avisos ({data.warnings.length})</div>
          <ul className="list-disc pl-5 space-y-0.5">
            {data.warnings.slice(0, 30).map((w, i) => <li key={i} className="[overflow-wrap:anywhere]">{w.text}</li>)}
          </ul>
          {data.warnings.length > 30 && <div className="text-xs">+ {data.warnings.length - 30} avisos</div>}
        </div>
      )}

      {data && people.length === 0 && (
        <p className="text-sm text-muted-foreground">Sem funcionários ativos em {CITY_LABELS[city]} (os extras escalam-se no Extras-Dia).</p>
      )}

      {data && people.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {data.weeks.map((w) => (
            <Card key={w.saturday}>
              <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2 space-y-0">
                <CardTitle className="text-sm">{weekendTitle(w.saturday)}</CardTitle>
                {editable.length > 0 && (
                  <Button size="sm" variant="outline" className="h-7" onClick={() => setDuty({ saturday: w.saturday })}>
                    <Plus className="w-3.5 h-3.5 mr-1" /> Pôr de serviço
                  </Button>
                )}
              </CardHeader>
              <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {w.days.map((d) => (
                  <div key={d.day} className="space-y-1.5 min-w-0">
                    <div className="text-xs font-semibold text-muted-foreground flex flex-wrap items-center gap-1">
                      {dayLabelPt(d.day)}
                      {d.holiday && <span className="rounded bg-violet-500/15 px-1.5 text-[11px] text-violet-800 dark:text-violet-200">feriado: {d.holiday}</span>}
                    </div>
                    {d.onDuty.length === 0 && <div className="text-xs font-medium text-destructive">Ninguém de serviço</div>}
                    {d.onDuty.map((p) => {
                      const canEdit = people.find((x) => x.employeeId === p.employeeId)?.canEdit;
                      return (
                        <div key={p.employeeId} className="rounded-lg border bg-primary/5 px-2 py-1.5 text-xs space-y-0.5">
                          <div className="flex items-center gap-1.5">
                            <span className="font-semibold truncate min-w-0">{p.name}</span>
                            <span className="text-primary font-semibold shrink-0">{p.startTime}–{p.endTime ?? "?"}</span>
                            {p.source === "fixed" && <span className="text-[11px] text-muted-foreground shrink-0">horário fixo</span>}
                            {canEdit && p.source === "override" && p.overrideId != null && (
                              <Button size="sm" variant="ghost" className="ml-auto h-6 w-6 p-0 text-destructive" aria-label={`Tirar ${p.name} de serviço`} disabled={cancel.isPending}
                                onClick={() => { if (confirm(`Tirar ${p.name} de serviço em ${dayLabelPt(d.day)}? Nesse dia volta o horário fixo${p.compensationDay ? ` e a folga de compensação de ${dayLabelPt(p.compensationDay)} também é cancelada` : ""}.`)) cancel.mutate({ id: p.overrideId! }); }}>
                                <X className="w-3.5 h-3.5" />
                              </Button>
                            )}
                            {canEdit && p.source === "fixed" && (
                              <Button size="sm" variant="ghost" className="ml-auto h-6 px-1.5 text-[11px]" disabled={set.isPending} title="Não é a vez: folga nesse dia"
                                onClick={() => set.mutate({ employeeId: p.employeeId, day: d.day, kind: "off", reason: "weekend", note: "Não é a vez (rotação)" })}>
                                <UserX className="w-3.5 h-3.5 mr-0.5" /> Folga
                              </Button>
                            )}
                          </div>
                          {p.needsCompensation && (
                            <div className={`text-[11px] ${p.compensationDay && p.compensationDay.slice(0, 7) !== d.day.slice(0, 7) ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}>
                              {p.compensationDay ? `Folga de compensação: ${dayLabelPt(p.compensationDay)}${p.compensationDay.slice(0, 7) !== d.day.slice(0, 7) ? " (noutro mês)" : ""}` : "Sem folga de compensação (paga-se como horas a mais)"}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {d.off.map((p) => {
                      const canEdit = people.find((x) => x.employeeId === p.employeeId)?.canEdit;
                      return (
                        <div key={`off-${p.employeeId}`} className="flex items-center gap-1.5 rounded-lg border border-dashed px-2 py-1 text-xs text-muted-foreground">
                          <span className="truncate min-w-0">{p.name}</span>
                          <span className="shrink-0">· folga{p.reason === "weekend" ? " (não é a vez)" : ""}</span>
                          {canEdit && p.overrideId != null && (
                            <Button size="sm" variant="ghost" className="ml-auto h-6 w-6 p-0" aria-label={`Cancelar a folga de ${p.name}`} disabled={cancel.isPending}
                              onClick={() => cancel.mutate({ id: p.overrideId! })}>
                              <X className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {duty && data && <DutyDialog saturday={duty.saturday} people={editable} onClose={() => setDuty(null)} onDone={refresh} />}
      {rotation && data && <RotationDialog city={city} saturdays={data.saturdays} weeks={data.weeks} onClose={() => setRotation(false)} onDone={refresh} />}
    </div>
  );
}

type PersonOpt = { employeeId: number; name: string; defaults: { sat: { startTime: string; endTime: string }; sun: { startTime: string; endTime: string } } };

function DutyDialog({ saturday, people, onClose, onDone }: { saturday: string; people: PersonOpt[]; onClose: () => void; onDone: () => void }) {
  const sunday = addDays(saturday, 1);
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [sat, setSat] = useState(true);
  const [sun, setSun] = useState(true);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("18:00");
  const [compensation, setCompensation] = useState(true);
  const [note, setNote] = useState("");
  const choose = (id: number) => {
    setEmployeeId(id);
    const p = people.find((x) => x.employeeId === id);
    const d = sat ? p?.defaults.sat : p?.defaults.sun;
    if (d) { setStartTime(d.startTime); setEndTime(d.endTime); }
  };
  const mark = trpc.rh.weekends.markDuty.useMutation({
    onSuccess: (r) => {
      onDone();
      const other = r.compensations.filter((c) => !c.sameMonth);
      const comp = r.compensations.length ? ` Folga de compensação: ${r.compensations.map((c) => dayLabelPt(c.day)).join(", ")}.` : "";
      toast.success(`De serviço marcado.${comp}`);
      if (other.length) toast.warning(`A folga de ${other.map((c) => dayLabelPt(c.forDay)).join(", ")} ficou noutro mês: o serviço paga-se como horas a mais e a folga não desconta.`);
      if (r.withoutCompensation.length) toast.message(`Sem dia útil para a folga de ${r.withoutCompensation.map(dayLabelPt).join(", ")} — marca-a na ficha, se for preciso.`);
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });
  const days = [sat ? saturday : null, sun ? sunday : null].filter((d): d is string => !!d);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Pôr de serviço — {weekendTitle(saturday)}</DialogTitle>
          <DialogDescription>As horas vêm do horário da pessoa nesse dia (sem ele, 09:00–18:00). Podes mudá-las.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Select value={employeeId != null ? String(employeeId) : ""} onValueChange={(v) => choose(Number(v))}>
            <SelectTrigger aria-label="Quem"><SelectValue placeholder="Quem fica de serviço?" /></SelectTrigger>
            <SelectContent>{people.map((p) => <SelectItem key={p.employeeId} value={String(p.employeeId)}>{p.name}</SelectItem>)}</SelectContent>
          </Select>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={sat ? "selected" : "outline"} onClick={() => setSat(!sat)}>{dayLabelPt(saturday)}</Button>
            <Button size="sm" variant={sun ? "selected" : "outline"} onClick={() => setSun(!sun)}>{dayLabelPt(sunday)}</Button>
          </div>
          <div className="flex items-center gap-2">
            <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="w-28" aria-label="Entrada" />
            <span className="text-muted-foreground">—</span>
            <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="w-28" aria-label="Saída" />
          </div>
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input type="checkbox" className="mt-1" checked={compensation} onChange={(e) => setCompensation(e.target.checked)} />
            <span>Marcar a folga de compensação no mesmo mês <span className="block text-xs text-muted-foreground">O dia útil mais perto em que a pessoa trabalha. Uma folga noutro mês não desconta (o serviço paga-se como horas a mais).</span></span>
          </label>
          <Input value={note} maxLength={255} onChange={(e) => setNote(e.target.value)} placeholder="Nota (opcional)" />
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button variant="selected" disabled={employeeId == null || !days.length || mark.isPending}
            onClick={() => mark.mutate({ employeeId: employeeId!, days, startTime, endTime, compensation, note: note || null })}>
            {mark.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />} Marcar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RotationDialog({ city, saturdays, weeks, onClose, onDone }: {
  city: City; saturdays: string[]; weeks: Array<{ saturday: string; days: Array<{ onDuty: Array<{ source: string }> }> }>; onClose: () => void; onDone: () => void;
}) {
  // modelo por omissão: do 1.º fim de semana com alguém marcado por data até ao último seguido
  const marked = weeks.map((w) => w.days.some((d) => d.onDuty.some((p) => p.source === "override")));
  const firstIdx = Math.max(0, marked.indexOf(true));
  let lastIdx = firstIdx;
  while (lastIdx + 1 < marked.length && marked[lastIdx + 1]) lastIdx++;
  const [patternFrom, setPatternFrom] = useState(saturdays[firstIdx] ?? saturdays[0]);
  const [patternTo, setPatternTo] = useState(saturdays[lastIdx] ?? saturdays[0]);
  const [count, setCount] = useState(8);
  const [compensation, setCompensation] = useState(true);
  const input = { city, patternFrom, patternTo, weeks: count, compensation };
  const [preview, setPreview] = useState<null | {
    items: Array<{ saturday: string; day: string; name: string; kind: string; startTime: string | null; endTime: string | null; status: string }>;
    counts: Record<string, number>;
    compensations: Array<{ name: string; forDay: string; day: string; sameMonth: boolean }>;
    withoutCompensation: Array<{ name: string; day: string }>;
  }>(null);
  const run = trpc.rh.weekends.repeatRotation.useMutation({ onError: (e) => toast.error(e.message) });
  const doPreview = () => run.mutate({ ...input, dryRun: true }, { onSuccess: (r) => setPreview(r) });
  const apply = () => run.mutate({ ...input, dryRun: false }, {
    onSuccess: (r) => {
      onDone();
      const other = r.compensations.filter((c) => !c.sameMonth).length;
      toast.success(`Rotação marcada: ${r.counts.create} dia(s).${r.compensations.length ? ` ${r.compensations.length} folga(s) de compensação.` : ""}`);
      if (other) toast.warning(`${other} folga(s) de compensação ficaram noutro mês (vê os avisos).`);
      onClose();
    },
  });
  const bySat = new Map<string, NonNullable<typeof preview>["items"]>();
  for (const i of preview?.items ?? []) bySat.set(i.saturday, [...(bySat.get(i.saturday) ?? []), i]);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Repetir a rotação</DialogTitle>
          <DialogDescription>Os fins de semana do modelo repetem-se pela mesma ordem nas semanas seguintes. Nunca mexe num dia que já tem exceção, em férias/baixas nem no passado.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Modelo: do fim de semana</div>
              <Select value={patternFrom} onValueChange={(v) => { setPatternFrom(v); if (patternTo < v) setPatternTo(v); setPreview(null); }}>
                <SelectTrigger aria-label="Início do modelo"><SelectValue /></SelectTrigger>
                <SelectContent>{saturdays.map((s) => <SelectItem key={s} value={s}>{weekendTitle(s)}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">até ao fim de semana</div>
              <Select value={patternTo} onValueChange={(v) => { setPatternTo(v); setPreview(null); }}>
                <SelectTrigger aria-label="Fim do modelo"><SelectValue /></SelectTrigger>
                <SelectContent>{saturdays.filter((s) => s >= patternFrom).map((s) => <SelectItem key={s} value={s}>{weekendTitle(s)}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            Repetir nas próximas
            <Input type="number" min={1} max={26} value={count} onChange={(e) => { setCount(Math.max(1, Math.min(26, Number(e.target.value) || 1))); setPreview(null); }} className="w-20" aria-label="Semanas" />
            semanas
          </div>
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input type="checkbox" className="mt-1" checked={compensation} onChange={(e) => { setCompensation(e.target.checked); setPreview(null); }} />
            <span>Marcar as folgas de compensação no mesmo mês</span>
          </label>
          {preview && (
            <div className="rounded-lg border p-2 space-y-2 text-xs">
              <div className="font-semibold">Marca {preview.counts.create ?? 0} dia(s){Object.entries(preview.counts).filter(([k, n]) => k !== "create" && n > 0).map(([k, n]) => ` · ${n} ${STATUS_LABELS[k]}`).join("")}</div>
              {[...bySat.entries()].map(([sat, items]) => (
                <div key={sat}>
                  <div className="font-medium text-muted-foreground">{weekendTitle(sat)}</div>
                  <ul className="pl-3">
                    {items.map((i, k) => (
                      <li key={k} className={i.status === "create" ? "" : "text-muted-foreground line-through"}>
                        {dayLabelPt(i.day)} · {i.name} · {i.kind === "work" ? `${i.startTime}–${i.endTime}` : "folga"}{i.status !== "create" ? ` (${STATUS_LABELS[i.status]})` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {preview.compensations.length > 0 && (
                <div>
                  <div className="font-medium text-muted-foreground">Folgas de compensação ({preview.compensations.length})</div>
                  <ul className="pl-3">
                    {preview.compensations.map((c, k) => (
                      <li key={k} className={c.sameMonth ? "" : "text-amber-700 dark:text-amber-300"}>
                        {c.name} · folga {dayLabelPt(c.day)} (serviço de {dayLabelPt(c.forDay)}){c.sameMonth ? "" : " — noutro mês"}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {preview.withoutCompensation.length > 0 && (
                <div className="text-muted-foreground">
                  Sem dia útil para a folga: {preview.withoutCompensation.map((w) => `${w.name} (${dayLabelPt(w.day)})`).join(", ")}
                </div>
              )}
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          {!preview ? (
            <Button variant="selected" disabled={run.isPending} onClick={doPreview}>{run.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />} Ver o que vai marcar</Button>
          ) : (
            <Button variant="selected" disabled={run.isPending || !(preview.counts.create > 0)} onClick={apply}>{run.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />} Marcar {preview.counts.create ?? 0}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
