/**
 * Avaliação → separador "Dia" (antiga Avaliação operacional).
 *
 * Escala do /extras-dia × movimentos lidos AO VIVO da BD da Multipark (quem
 * mexeu em que reserva, quando e em que fase), com as mesmas regras e números
 * do separador "4 semanas". O GPS (onde deixaram os carros / por onde
 * andaram) continua a vir do Zello, na nossa BD. Tudo é calculado ao abrir o
 * dia — não há nada para ir buscar à mão.
 */
import { useState } from "react";
import { Link } from "wouter";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { trpc } from "@/lib/trpc";
import { UniDateNav } from "@/components/DateRangeNav";
import { fmtPTTime } from "@/lib/lisbonTime";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { AlertTriangle, ChevronDown, ChevronRight, Download, MapPin, Pencil, Check, X } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { operationalDayOf } from "@shared/lisbonDay";
import { MOVEMENT_PHASE_LABELS, movementLabel, movementPhase } from "@shared/multiparkMovements";
import {
  EvaluationDrawer,
  PerHourStrip,
  RuleLinesTable,
  RulesLegend,
  fmtDay,
  fmtNum,
  fmtPts,
  ptsClass,
} from "@/components/evaluation/EvaluationBreakdown";

const fmtHour = (h: number) => {
  if (h < 24) return `${String(h).padStart(2, "0")}h`;
  return `${String(h - 24).padStart(2, "0")}h+1`;
};

type ScoreTarget = { employeeId: number | null; name: string; person: any };

/** "Gelson Manuel Leão Sousa" → "Gelson Sousa" */
function deriveShortName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return fullName.trim();
  return `${parts[0]} ${parts[parts.length - 1]}`;
}

const fmtEur = (n: number) => n.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });

/** Aviso quando os movimentos não vieram da BD da Multipark. */
export function MovementSourceNotice({ notice }: { notice: string | null | undefined }) {
  if (!notice) return null;
  return (
    <Card className="border-amber-300 bg-amber-50">
      <CardContent className="p-3 text-sm text-amber-900 flex gap-2 items-start">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
        <span>{notice}</span>
      </CardContent>
    </Card>
  );
}

export default function DayEvaluationTab({ initialDate }: { initialDate?: string }) {
  const { projectId } = useGlobalFilters();
  const { user } = useAuth();
  const isSupervisor = !!user?.role && ["supervisor", "admin", "super_admin"].includes(user.role);
  const [date, setDate] = useState(initialDate && /^\d{4}-\d{2}-\d{2}$/.test(initialDate) ? initialDate : operationalDayOf(Date.now()));
  const [scoreOf, setScoreOf] = useState<ScoreTarget | null>(null);

  const assignmentsQ = trpc.extrasDia.assignments.useQuery({ date, projectId });
  const assignments = assignmentsQ.data ?? [];
  const evaluationQ = trpc.multipark.dayEvaluation.useQuery({ date, projectId });
  const evaluation = evaluationQ.data;

  const exportCsv = () => {
    if (!evaluation) return;
    const headers = ["Turno", "Nome", "TL", "Nível", "Horas pagas", "Horas ponto", "Custo", "Ações", "Pts ações", "Pontos", "€/Acção", "Reservas", "1.ª ação", "Última ação", "Por tipo"];
    const rows: string[][] = [];
    for (const s of evaluation.shifts) {
      const shiftLabel = s.shift === "morning" ? "Manhã" : "Noite";
      const people = [...(s.tl ? [s.tl] : []), ...s.members];
      for (const m of people) {
        const a = assignments.find((x) => x.id === m.assignmentId);
        if (!a) continue;
        rows.push([
          shiftLabel, a.personName, m === s.tl ? "TL" : "", m === s.tl ? "—" : a.level ?? "",
          String(a.hoursBilled), String(m.hoursWorked), m.cost.toFixed(2), String(m.totalActions), String(m.weightedActions),
          String(m.totalPoints), m.totalActions > 0 ? m.costPerAction.toFixed(2) : "—",
          String(m.live?.bookings ?? ""), m.live?.firstAt ? fmtPTTime(m.live.firstAt) : "", m.live?.lastAt ? fmtPTTime(m.live.lastAt) : "",
          Object.entries(m.byType).map(([k, v]) => `${k}:${v}`).join("|"),
        ]);
      }
    }
    const csv = [headers.join(";"), ...rows.map((r) => r.map((v) => String(v).replace(/;/g, ",")).join(";"))].join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const el = document.createElement("a");
    el.href = url; el.download = `avaliacao_dia_${date}.csv`; el.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <p className="text-sm text-muted-foreground max-w-3xl">
          Escala do Extras Dia × movimentos lidos em tempo real da BD da Multipark (quem mexeu em que reserva, quando e em que fase).
          O GPS vem do Zello. Manhã 03h–15h · noite 15h–03h (Lisboa). Clica nos pontos de alguém para ver o detalhe.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label className="text-xs">Dia</Label>
            <UniDateNav date={date} onChange={setDate} />
          </div>
          {evaluation && evaluation.totals.people > 0 && (
            <Button variant="outline" size="sm" onClick={exportCsv}>
              <Download className="w-4 h-4 mr-1" /> CSV
            </Button>
          )}
        </div>
      </div>

      <MovementSourceNotice notice={evaluation?.notice} />

      {(assignmentsQ.isLoading || evaluationQ.isLoading) && (
        <p className="text-sm text-muted-foreground">A calcular o dia...</p>
      )}
      {evaluationQ.error && <Card className="p-4 text-sm text-red-700">{evaluationQ.error.message}</Card>}

      {!assignmentsQ.isLoading && assignments.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            Sem extras escalados para {fmtDay(date)}. Vai ao Extras Dia, escolhe este dia e adiciona equipa.
          </CardContent>
        </Card>
      )}

      {evaluation && evaluation.totals.people > 0 && (
        <Card className="bg-gradient-to-br from-purple-50 to-blue-50 border-purple-200">
          <CardHeader>
            <CardTitle className="text-base">Equipa do dia · {evaluation.totals.people} pessoas</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">Ações ponderadas (pts)</div>
                <div className="text-xl md:text-2xl font-bold tabular-nums truncate">{fmtNum(evaluation.totals.weightedActions, 1)}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">movimento +2 · recolha/entrega +3 · levar ao parque +5</div>
              </div>
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">Ações totais</div>
                <div className="text-xl md:text-2xl font-bold tabular-nums truncate">{evaluation.totals.totalActions}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5 flex flex-wrap gap-1">
                  {Object.entries(evaluation.totals.byType).map(([k, v]) => (
                    <span key={k}>{movementLabel(k)}: {v}</span>
                  ))}
                </div>
              </div>
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">Custo total</div>
                <div className="text-xl md:text-2xl font-bold tabular-nums truncate">{fmtEur(evaluation.totals.totalCost)}</div>
              </div>
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">€/ação</div>
                <div className="text-xl md:text-2xl font-bold tabular-nums truncate">
                  {evaluation.totals.totalActions > 0 ? fmtEur(evaluation.totals.costPerAction) : "—"}
                </div>
              </div>
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">Ações média/pessoa</div>
                <div className="text-xl md:text-2xl font-bold tabular-nums truncate">
                  {evaluation.totals.people > 0 ? (evaluation.totals.totalActions / evaluation.totals.people).toFixed(1) : "—"}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {evaluation?.shifts.map((s) => (
        s.drivers > 0 ? (
          <ShiftSection key={s.shift} shiftEval={s} date={date} assignments={assignments} onScore={setScoreOf} />
        ) : null
      ))}

      {evaluation && evaluation.totals.people > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Sistema de pontos</CardTitle></CardHeader>
          <CardContent><RulesLegend /></CardContent>
        </Card>
      )}

      {/* Detalhe: com ficha → o mesmo detalhe das 4 semanas; sem ficha → só as ações */}
      <EvaluationDrawer
        employeeId={scoreOf?.employeeId ?? null}
        employeeName={scoreOf?.name ?? ""}
        from={date}
        to={date}
        canAdjust={isSupervisor}
        onOpenChange={(o) => !o && setScoreOf(null)}
      />
      <Sheet open={!!scoreOf && scoreOf.employeeId == null} onOpenChange={(o) => !o && setScoreOf(null)}>
        <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{scoreOf?.name}</SheetTitle>
            <SheetDescription>{fmtDay(date)} · sem ficha de colaborador: só as ações do agente "{scoreOf?.person?.resolvedAgentName}"</SheetDescription>
          </SheetHeader>
          {scoreOf?.person && (
            <div className="px-4 pb-6 space-y-4">
              <RuleLinesTable lines={scoreOf.person.lines} total={scoreOf.person.totalPoints} />
              <PerHourStrip perHour={{ hours: scoreOf.person.hoursWorked || scoreOf.person.hoursPaid, actionsPerHour: scoreOf.person.actionsPerHour, weightedPerHour: scoreOf.person.weightedPerHour, pointsPerHour: null }} />
              <p className="text-xs text-muted-foreground">Liga esta pessoa a uma ficha (RH) para contar o ponto, atrasos, reclamações e ocorrências.</p>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function ShiftSection({ shiftEval, date, assignments, onScore }: {
  shiftEval: any; date: string; assignments: any[]; onScore: (t: ScoreTarget) => void;
}) {
  const shiftLabel = shiftEval.shift === "morning" ? "Manhã (03–15)" : "Noite (15–03)";
  const tlAssignment = shiftEval.tl ? assignments.find((a) => a.id === shiftEval.tl.assignmentId) : null;
  return (
    <div className="space-y-2">
      <Card className={shiftEval.shift === "morning" ? "border-blue-200" : "border-indigo-200"}>
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h2 className="font-semibold text-sm">{shiftLabel}</h2>
              <div className="text-xs text-muted-foreground">
                {shiftEval.drivers} pessoas · {shiftEval.totalActions} ações · {fmtNum(shiftEval.weightedActions)} pts ações · {fmtEur(shiftEval.totalCost)}
                {shiftEval.totalActions > 0 && <span> · {fmtEur(shiftEval.costPerAction)}/ação</span>}
              </div>
            </div>
            <div className="flex flex-wrap gap-1 text-[11px]">
              {Object.entries(shiftEval.byType).map(([k, v]: any) => (
                <Badge key={k} variant="secondary" className="text-[11px]">{movementLabel(k)}: {v}</Badge>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
      {tlAssignment && <AgentCard assignment={tlAssignment} date={date} metrics={shiftEval.tl} onScore={onScore} />}
      {shiftEval.members.map((m: any) => {
        const a = assignments.find((x) => x.id === m.assignmentId);
        return a ? <AgentCard key={m.assignmentId} assignment={a} date={date} metrics={m} onScore={onScore} /> : null;
      })}
    </div>
  );
}

function LiveSummary({ live }: { live: any }) {
  if (!live) return null;
  const items: Array<[string, string]> = [
    ["Reservas", String(live.bookings)],
    ["1.ª / última ação", `${live.firstAt ? fmtPTTime(live.firstAt) : "—"} → ${live.lastAt ? fmtPTTime(live.lastAt) : "—"}`],
    ["Check-ins / check-outs assinados", `${live.checkInsSigned} / ${live.checkOutsSigned}`],
    ["Ocorrências criadas / resolvidas", `${live.occurrencesCreated} / ${live.occurrencesResolved}`],
  ];
  if (live.spotChanges > 0) items.push(["Mudanças de lugar", String(live.spotChanges)]);
  if (live.reviews > 0) items.push(["Avaliações dos clientes", `${live.reviews} · média ${fmtNum(live.reviewAvg, 1)}${live.reviewsLow > 0 ? ` · ${live.reviewsLow} ≤ 3` : ""}`]);
  if (live.platforms?.length) items.push(["Plataforma", live.platforms.join(", ")]);
  return (
    <div className="text-[11px] text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5">
      {items.map(([k, v]) => <span key={k}>{k}: <span className="text-foreground tabular-nums">{v}</span></span>)}
    </div>
  );
}

function AgentCard({ assignment, date, metrics, onScore }: { assignment: any; date: string; metrics?: any; onScore: (t: ScoreTarget) => void }) {
  const utils = trpc.useUtils();
  const [expanded, setExpanded] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [editValue, setEditValue] = useState("");

  const resolvedShortName: string = assignment.multiparkAgentName || deriveShortName(assignment.personName);
  const agentUserIds: string[] = metrics?.live?.agentUserIds ?? [];

  const setMappingMut = trpc.multipark.setMultiparkAgentMapping.useMutation({
    onSuccess: () => {
      utils.extrasDia.assignments.invalidate();
      utils.multipark.dayEvaluation.invalidate();
      toast.success("Nome guardado");
      setEditingName(false);
    },
    onError: (e) => toast.error(e.message),
  });

  const startEdit = () => { setEditValue(resolvedShortName); setEditingName(true); };
  const saveEdit = () => {
    if (!assignment.employeeId) {
      toast.error("Este extra não está associado a um colaborador do RH — não dá para guardar o nome.");
      return;
    }
    setMappingMut.mutate({ employeeId: assignment.employeeId, multiparkAgentName: editValue.trim() || null });
  };

  return (
    <Card className={assignment.isTeamLeader ? "border-amber-200 bg-amber-50/30" : ""}>
      <CardContent className="p-4 space-y-2">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 shrink-0" aria-label={expanded ? "Esconder movimentos" : "Ver movimentos"} onClick={() => setExpanded((v) => !v)}>
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </Button>
            <div className="min-w-0">
              <div className="font-semibold flex flex-wrap items-center gap-2">
                <span className="truncate" title={assignment.personName}>{assignment.personName}</span>
                {assignment.isTeamLeader && <Badge className="bg-amber-100 text-amber-800 border-amber-300 text-[11px]">TL</Badge>}
                {assignment.shift && <Badge variant="outline" className="text-[11px]">{assignment.shift === "morning" ? "Manhã" : "Noite"}</Badge>}
                {!assignment.isTeamLeader && assignment.level && <Badge variant="secondary" className="text-[11px]">{assignment.level}</Badge>}
              </div>
              <p className="text-xs text-muted-foreground">
                {fmtHour(assignment.startHour)}–{fmtHour(assignment.sentHomeHour ?? assignment.endHour)}
                {" · "}{assignment.hoursBilled}h pagas
                {metrics && metrics.hoursSource === "ponto" && <>{" · "}{fmtNum(metrics.hoursWorked)}h ponto</>}
                {metrics && metrics.suspiciousHours > 0 && <span className="text-red-700">{" · "}{fmtNum(metrics.suspiciousHours)}h [SUSPEITO] fora</span>}
                {" · "}€{assignment.cost.toFixed(2)}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
                <span className="text-muted-foreground">Agente:</span>
                {editingName ? (
                  <>
                    <Input value={editValue} onChange={(e) => setEditValue(e.target.value)} className="h-6 text-xs w-40" autoFocus />
                    <Button size="sm" variant="ghost" className="h-6 w-6 p-0" aria-label="Guardar" onClick={saveEdit} disabled={setMappingMut.isPending}>
                      <Check className="h-3 w-3 text-emerald-600" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-6 w-6 p-0" aria-label="Cancelar" onClick={() => setEditingName(false)}>
                      <X className="h-3 w-3" />
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="font-mono">{metrics?.live?.agentName ?? resolvedShortName}</span>
                    {assignment.multiparkAgentName
                      ? <Badge variant="outline" className="text-[11px]">manual</Badge>
                      : <Badge variant="outline" className="text-[11px] text-muted-foreground">auto</Badge>}
                    {assignment.employeeId && (
                      <Button size="sm" variant="ghost" className="h-5 w-5 p-0" aria-label="Editar nome do agente" onClick={startEdit}>
                        <Pencil className="h-3 w-3" />
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 shrink-0 pl-10 sm:pl-0">
            {metrics && (
              <div className="text-right">
                <div className="text-xl font-bold leading-none tabular-nums">{metrics.totalActions}</div>
                <div className="text-[11px] text-muted-foreground">ações · {fmtNum(metrics.weightedActions)} pts</div>
                {metrics.totalActions > 0 && (
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    {fmtEur(metrics.costPerAction)}/ação
                    {metrics.actionsPerHour != null && <> · {fmtNum(metrics.actionsPerHour, 2)}/h</>}
                  </div>
                )}
              </div>
            )}
            {metrics && (
              <button
                type="button"
                title="Ver de onde vem a pontuação"
                className={`rounded-md border px-2 py-1 text-right hover:bg-muted/50 ${ptsClass(metrics.totalPoints)}`}
                onClick={() => onScore({ employeeId: metrics.employeeId ?? null, name: assignment.personName, person: metrics })}
              >
                <div className="text-lg font-bold leading-none tabular-nums">{fmtPts(metrics.totalPoints)}</div>
                <div className="text-[11px] text-muted-foreground">pontos{metrics.hasAdjustments ? " · ajust." : ""}</div>
              </button>
            )}
          </div>
        </div>

        {metrics && metrics.totalActions > 0 && (
          <div className="text-xs flex flex-wrap gap-1 pl-9">
            {Object.entries(metrics.byType).map(([k, v]: any) => (
              <Badge key={k} variant="outline" className="text-[11px]">{movementLabel(k)}: {v}</Badge>
            ))}
          </div>
        )}
        {metrics?.live && <div className="pl-9"><LiveSummary live={metrics.live} /></div>}

        {assignment.isTeamLeader && metrics?.teamAggregate && metrics.teamAggregate.drivers > 0 && (
          <div className="ml-9 mt-2 rounded-md border border-amber-300 bg-amber-100/40 p-2 text-xs">
            <div className="font-semibold text-amber-900 mb-1">Equipa ({metrics.teamAggregate.drivers} condutores)</div>
            <div className="flex flex-wrap gap-3">
              <span><strong>{metrics.teamAggregate.totalActions}</strong> ações</span>
              <span>custo {fmtEur(metrics.teamAggregate.totalCost)}</span>
              {metrics.teamAggregate.totalActions > 0 && <span>{fmtEur(metrics.teamAggregate.costPerAction)}/ação</span>}
            </div>
            <div className="flex flex-wrap gap-1 mt-1">
              {Object.entries(metrics.teamAggregate.byType).map(([k, v]: any) => (
                <Badge key={k} variant="secondary" className="text-[11px] bg-amber-200/60">{movementLabel(k)}: {v}</Badge>
              ))}
            </div>
          </div>
        )}

        {expanded && (
          <div className="border-t pt-2 mt-2 text-xs space-y-3">
            <MovementsList date={date} agentUserIds={agentUserIds} agentName={resolvedShortName} />
            {assignment.employeeId != null && <ZelloGps date={date} employeeId={assignment.employeeId} />}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Movimentos do agente no dia, lidos AO VIVO da BD da Multipark ("History"). */
function MovementsList({ date, agentUserIds, agentName }: { date: string; agentUserIds: string[]; agentName: string }) {
  const { projectId } = useGlobalFilters();
  const q = trpc.multipark.agentHistorySummary.useQuery(
    { date, agentUserIds: agentUserIds.length ? agentUserIds : undefined, agentName: agentUserIds.length ? undefined : agentName, projectId },
    { refetchOnWindowFocus: false },
  );
  if (q.isLoading) return <p className="text-muted-foreground">A ler os movimentos da BD da Multipark...</p>;
  if (q.error) return <p className="text-red-700">{q.error.message}</p>;
  const d = q.data;
  if (!d) return null;
  if (!d.available) return <p className="text-amber-800">Movimentos indisponíveis: {d.reason}</p>;
  return (
    <section>
      <div className="flex flex-wrap gap-2 mb-2">
        <Badge variant="outline">{d.total}{d.truncated ? "+" : ""} movimentos</Badge>
        {Object.entries(d.byType).map(([k, v]) => <Badge key={k} variant="secondary">{movementLabel(k)}: {v}</Badge>)}
      </div>
      {d.total === 0 ? (
        <p className="text-muted-foreground">Sem movimentos deste agente neste dia na BD da Multipark.</p>
      ) : (
        <div className="overflow-x-auto max-h-96 overflow-y-auto">
          <table className="w-full min-w-[560px]">
            <thead>
              <tr className="text-[11px] uppercase text-muted-foreground border-b">
                <th className="text-left py-1 px-2">Hora</th>
                <th className="text-left py-1 px-2">Fase</th>
                <th className="text-left py-1 px-2">Ação</th>
                <th className="text-left py-1 px-2">Reserva</th>
                <th className="text-left py-1 px-2">Matrícula</th>
                <th className="text-left py-1 px-2">Parque</th>
                <th className="text-left py-1 px-2">O que mudou</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((it) => (
                <tr key={it.id} className="border-b hover:bg-muted/40 align-top">
                  <td className="py-1 px-2 font-mono">{it.actionTime ? fmtPTTime(it.actionTime) : "—"}</td>
                  <td className="py-1 px-2 text-muted-foreground">{MOVEMENT_PHASE_LABELS[movementPhase(it.changeType)]}</td>
                  <td className="py-1 px-2"><Badge variant="outline" className="text-[11px]">{movementLabel(it.changeType)}</Badge></td>
                  <td className="py-1 px-2 font-mono">
                    {it.bookingCode || it.bookingId
                      ? <Link className="text-primary underline" href={`/reserva/${encodeURIComponent(it.bookingCode ?? it.bookingId ?? "")}`}>{it.bookingCode ?? `${String(it.bookingId).slice(0, 10)}…`}</Link>
                      : "—"}
                  </td>
                  <td className="py-1 px-2 font-mono">{it.plate ?? ""}</td>
                  <td className="py-1 px-2 text-muted-foreground">{it.parkName ?? ""}</td>
                  <td className="py-1 px-2 text-muted-foreground">
                    <span className="line-clamp-2 max-w-[280px] block" title={[it.modifiedFields, it.remarks].filter(Boolean).join(" · ")}>
                      {[it.changeType === "UPDATE" ? it.modifiedFields : null, it.remarks].filter(Boolean).join(" · ") || "—"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** GPS do dia (Zello, a nossa BD): km, tempo em movimento, velocidades e o trajeto. */
function ZelloGps({ date, employeeId }: { date: string; employeeId: number }) {
  const { projectId } = useGlobalFilters();
  const q = trpc.multipark.personDay.useQuery({ date, key: `emp:${employeeId}`, projectId }, { refetchOnWindowFocus: false, retry: false });
  const gps = ((q.data as any)?.gps ?? []) as any[];
  return (
    <section>
      <h3 className="text-xs font-semibold mb-1 flex items-center gap-1"><MapPin className="w-3 h-3" /> GPS (Zello)</h3>
      {q.isLoading ? <p className="text-muted-foreground">A carregar...</p>
        : q.error ? <p className="text-muted-foreground">Sem acesso ao GPS aqui — vê em <Link className="text-primary underline" href="/operacional">Atividade Diária</Link>.</p>
        : gps.length === 0 ? <p className="text-muted-foreground">Sem GPS do Zello para este dia.</p>
        : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px]">
              <thead><tr className="border-b text-left text-muted-foreground"><th className="p-1">Zello</th><th className="p-1 text-right">Km</th><th className="p-1 text-right">Em movimento</th><th className="p-1 text-right">Vel. máx</th><th className="p-1 text-right">Excessos</th><th className="p-1">Trajeto</th></tr></thead>
              <tbody>
                {gps.map((g, i) => (
                  <tr key={i} className="border-b">
                    <td className="p-1">{g.zelloUsername}</td>
                    <td className="p-1 text-right tabular-nums">{Number(g.km ?? 0).toFixed(1)}</td>
                    <td className="p-1 text-right tabular-nums">{g.movingMinutes != null ? `${(g.movingMinutes / 60).toFixed(1)}h` : "—"}</td>
                    <td className="p-1 text-right tabular-nums">{Math.round(Number(g.maxSpeed ?? 0))} km/h</td>
                    <td className={`p-1 text-right tabular-nums ${g.violations > 0 ? "text-red-700 font-semibold" : ""}`}>{g.violations ?? 0}</td>
                    <td className="p-1">{g.geoJsonUrl ? <a className="text-primary underline" href={g.geoJsonUrl} target="_blank" rel="noopener">Mapa (GeoJSON)</a> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}
