import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { fmtPTTime } from "@/lib/lisbonTime";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { ClipboardList, Download, RefreshCw, ChevronDown, ChevronRight, Pencil, Check, X } from "lucide-react";

const fmtHour = (h: number) => {
  if (h < 24) return `${String(h).padStart(2, "0")}h`;
  return `${String(h - 24).padStart(2, "0")}h+1`;
};

function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "Gelson Manuel Leão Sousa" → "Gelson Sousa" */
function deriveShortName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return fullName.trim();
  return `${parts[0]} ${parts[parts.length - 1]}`;
}

const fmtEur = (n: number) => n.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });

export default function AvaliacaoOperacionalPage() {
  const [date, setDate] = useState(todayISO());

  const assignmentsQ = trpc.extrasDia.assignments.useQuery({ date });
  const assignments = assignmentsQ.data ?? [];
  const evaluationQ = trpc.multipark.dayEvaluation.useQuery({ date });
  const evaluation = evaluationQ.data;

  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ClipboardList className="h-6 w-6 text-purple-600" />
            Avaliação Operacional
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Cruza extras escalados em /extras-dia com actividade real registada na API Multipark.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="date" className="text-xs">Dia</Label>
            <Input
              id="date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-44"
            />
          </div>
          {evaluation && evaluation.totals.people > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const headers = ["Turno","Nome","TL","Nível","Horas pagas","Custo","Ações","€/Acção","Por tipo"];
                const rows: string[][] = [];
                for (const s of evaluation.shifts) {
                  const shiftLabel = s.shift === "morning" ? "Manhã" : "Noite";
                  if (s.tl) {
                    const tlA = assignments.find(a => a.id === s.tl!.assignmentId);
                    rows.push([
                      shiftLabel,
                      tlA?.personName ?? "",
                      "TL",
                      "—",
                      String(tlA?.hoursBilled ?? 0),
                      (tlA?.cost ?? 0).toFixed(2),
                      String(s.tl.totalActions),
                      s.tl.totalActions > 0 ? s.tl.costPerAction.toFixed(2) : "—",
                      Object.entries(s.tl.byType).map(([k, v]) => `${k}:${v}`).join("|"),
                    ]);
                  }
                  for (const m of s.members) {
                    const a = assignments.find(x => x.id === m.assignmentId);
                    if (!a) continue;
                    rows.push([
                      shiftLabel,
                      a.personName,
                      "",
                      a.level ?? "",
                      String(a.hoursBilled),
                      a.cost.toFixed(2),
                      String(m.totalActions),
                      m.totalActions > 0 ? m.costPerAction.toFixed(2) : "—",
                      Object.entries(m.byType).map(([k, v]) => `${k}:${v}`).join("|"),
                    ]);
                  }
                }
                const csv = [headers.join(";"), ...rows.map(r => r.join(";"))].join("\n");
                const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url; a.download = `avaliacao_operacional_${date}.csv`; a.click();
                URL.revokeObjectURL(url);
              }}
            >
              <Download className="w-4 h-4 mr-1" /> CSV
            </Button>
          )}
        </div>
      </div>

      {assignmentsQ.isLoading && (
        <p className="text-sm text-muted-foreground">A carregar equipa...</p>
      )}

      {!assignmentsQ.isLoading && assignments.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            Sem extras escalados para {date}. Vai a /extras-dia, escolhe este dia e adiciona equipa.
          </CardContent>
        </Card>
      )}

      {/* Totais do dia */}
      {evaluation && evaluation.totals.people > 0 && (
        <Card className="bg-gradient-to-br from-purple-50 to-blue-50 border-purple-200">
          <CardHeader>
            <CardTitle className="text-base">Equipa do dia · {evaluation.totals.people} pessoas</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <div className="text-xs text-muted-foreground">Acções totais</div>
                <div className="text-xl md:text-2xl font-bold truncate">{evaluation.totals.totalActions}</div>
                <div className="text-[10px] text-muted-foreground mt-0.5 flex flex-wrap gap-1">
                  {Object.entries(evaluation.totals.byType).map(([k, v]) => (
                    <span key={k}>{k}: {v}</span>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Custo total</div>
                <div className="text-xl md:text-2xl font-bold truncate">{fmtEur(evaluation.totals.totalCost)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">€/acção</div>
                <div className="text-xl md:text-2xl font-bold truncate">
                  {evaluation.totals.totalActions > 0 ? fmtEur(evaluation.totals.costPerAction) : "—"}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Acções média/pessoa</div>
                <div className="text-xl md:text-2xl font-bold truncate">
                  {evaluation.totals.people > 0
                    ? (evaluation.totals.totalActions / evaluation.totals.people).toFixed(1)
                    : "—"}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {assignments.length > 0 && (
        <BulkActions
          date={date}
          agents={assignments.map(a => a.multiparkAgentName || deriveShortName(a.personName))}
        />
      )}

      {/* Totais por turno + TL + drivers */}
      {evaluation?.shifts.map(s => (
        s.drivers > 0 ? (
          <ShiftSection key={s.shift} shiftEval={s} date={date} assignments={assignments} />
        ) : null
      ))}
    </div>
  );
}

function ShiftSection({
  shiftEval,
  date,
  assignments,
}: {
  shiftEval: any;
  date: string;
  assignments: any[];
}) {
  const shiftLabel = shiftEval.shift === "morning" ? "Manhã (03–15)" : "Noite (15–03)";

  return (
    <div className="space-y-2">
      <Card className={shiftEval.shift === "morning" ? "border-blue-200" : "border-indigo-200"}>
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h2 className="font-semibold text-sm">{shiftLabel}</h2>
              <div className="text-xs text-muted-foreground">
                {shiftEval.drivers} pessoas · {shiftEval.totalActions} acções · {fmtEur(shiftEval.totalCost)}
                {shiftEval.totalActions > 0 && (
                  <span> · {fmtEur(shiftEval.costPerAction)}/acção</span>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-1 text-[10px]">
              {Object.entries(shiftEval.byType).map(([k, v]: any) => (
                <Badge key={k} variant="secondary" className="text-[10px]">{k}: {v}</Badge>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* TL em destaque */}
      {shiftEval.tl && (() => {
        const tlAssignment = assignments.find(a => a.id === shiftEval.tl.assignmentId);
        return tlAssignment ? (
          <AgentCard
            key={shiftEval.tl.assignmentId}
            assignment={tlAssignment}
            date={date}
            metrics={shiftEval.tl}
          />
        ) : null;
      })()}

      {/* Drivers do turno */}
      {shiftEval.members.map((m: any) => {
        const a = assignments.find(x => x.id === m.assignmentId);
        return a ? (
          <AgentCard key={m.assignmentId} assignment={a} date={date} metrics={m} />
        ) : null;
      })}
    </div>
  );
}

function BulkActions({ date, agents }: { date: string; agents: string[] }) {
  const fetchMut = trpc.multipark.fetchAgentHistory.useMutation();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  const runAll = async () => {
    if (agents.length > 10 && !confirm(`Vai chamar a API Multipark ${agents.length} vezes (uma por agente, em todos os parques). Pode demorar vários minutos. Continuar?`)) {
      return;
    }
    setRunning(true);
    setProgress({ done: 0, total: agents.length });
    let total = 0;
    for (const name of agents) {
      try {
        const r = await fetchMut.mutateAsync({ agentName: name, date });
        total += r.totalEntries;
      } catch {}
      setProgress((p) => ({ ...p, done: p.done + 1 }));
    }
    setRunning(false);
    toast.success(`Concluído. Total de ${total} entries para ${agents.length} agentes.`);
  };

  return (
    <Card className="bg-purple-50/40 border-purple-200">
      <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <div className="font-medium">Buscar histórico de TODOS</div>
          <p className="text-xs text-muted-foreground">
            Chama /agent/history na Multipark para cada nome, em todos os parques configurados.
          </p>
          {running && progress.total > 0 && (
            <p className="text-xs text-purple-700 mt-1">
              {progress.done}/{progress.total} agentes processados...
            </p>
          )}
        </div>
        <Button onClick={runAll} disabled={running}>
          {running ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Download className="w-4 h-4 mr-2" />}
          Buscar todos ({agents.length})
        </Button>
      </CardContent>
    </Card>
  );
}

function AgentCard({ assignment, date, metrics }: { assignment: any; date: string; metrics?: any }) {
  const utils = trpc.useUtils();
  const [expanded, setExpanded] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [editValue, setEditValue] = useState("");

  const resolvedShortName: string =
    assignment.multiparkAgentName || deriveShortName(assignment.personName);

  const fetchMut = trpc.multipark.fetchAgentHistory.useMutation();
  const setMappingMut = trpc.multipark.setMultiparkAgentMapping.useMutation({
    onSuccess: () => {
      utils.extrasDia.assignments.invalidate();
      toast.success("Nome guardado");
      setEditingName(false);
    },
    onError: (e) => toast.error(e.message),
  });
  const summaryQ = trpc.multipark.agentHistorySummary.useQuery(
    { agentName: resolvedShortName, date },
    { enabled: expanded },
  );

  const handleFetch = async () => {
    try {
      const r = await fetchMut.mutateAsync({
        agentName: resolvedShortName,
        date,
      });
      toast.success(
        `${resolvedShortName}: ${r.totalEntries} entries em ${r.parks} parques`,
      );
      summaryQ.refetch();
    } catch (e: any) {
      toast.error(e.message ?? "Erro");
    }
  };

  const startEdit = () => {
    setEditValue(resolvedShortName);
    setEditingName(true);
  };
  const saveEdit = () => {
    if (!assignment.employeeId) {
      toast.error("Este extra não está associado a um empregado RH — não dá para guardar override.");
      return;
    }
    setMappingMut.mutate({
      employeeId: assignment.employeeId,
      multiparkAgentName: editValue.trim() || null,
    });
  };

  return (
    <Card className={assignment.isTeamLeader ? "border-amber-200 bg-amber-50/30" : ""}>
      <CardContent className="p-4 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              onClick={() => setExpanded(v => !v)}
            >
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </Button>
            <div className="min-w-0">
              <div className="font-semibold flex flex-wrap items-center gap-2">
                <span className="truncate">{assignment.personName}</span>
                {assignment.isTeamLeader && (
                  <Badge className="bg-amber-100 text-amber-800 border-amber-300 text-[10px]">TL</Badge>
                )}
                {assignment.shift && (
                  <Badge variant="outline" className="text-[10px]">
                    {assignment.shift === "morning" ? "Manhã" : "Noite"}
                  </Badge>
                )}
                {!assignment.isTeamLeader && assignment.level && (
                  <Badge variant="secondary" className="text-[10px]">{assignment.level}</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {fmtHour(assignment.startHour)}–{fmtHour(assignment.sentHomeHour ?? assignment.endHour)}
                {" · "}{assignment.hoursBilled}h pagas
                {" · "}€{assignment.cost.toFixed(2)}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
                <span className="text-muted-foreground">API:</span>
                {editingName ? (
                  <>
                    <Input
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      className="h-6 text-xs w-40"
                      autoFocus
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0"
                      onClick={saveEdit}
                      disabled={setMappingMut.isPending}
                    >
                      <Check className="h-3 w-3 text-emerald-600" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0"
                      onClick={() => setEditingName(false)}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="font-mono">{resolvedShortName}</span>
                    {assignment.multiparkAgentName ? (
                      <Badge variant="outline" className="text-[9px]">manual</Badge>
                    ) : (
                      <Badge variant="outline" className="text-[9px] text-muted-foreground">auto</Badge>
                    )}
                    {assignment.employeeId && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-5 w-5 p-0"
                        onClick={startEdit}
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {metrics && (
              <div className="text-right">
                <div className="text-xl font-bold leading-none">{metrics.totalActions}</div>
                <div className="text-[10px] text-muted-foreground">acções</div>
                {metrics.totalActions > 0 && (
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    {fmtEur(metrics.costPerAction)}/acção
                  </div>
                )}
              </div>
            )}
            <Button size="sm" variant="outline" onClick={handleFetch} disabled={fetchMut.isPending}>
              {fetchMut.isPending ? (
                <RefreshCw className="w-3 h-3 mr-1 animate-spin" />
              ) : (
                <Download className="w-3 h-3 mr-1" />
              )}
              Buscar
            </Button>
          </div>
        </div>

        {/* Breakdown métrico */}
        {metrics && metrics.totalActions > 0 && (
          <div className="text-xs flex flex-wrap gap-1 pl-9">
            {Object.entries(metrics.byType).map(([k, v]: any) => (
              <Badge key={k} variant="outline" className="text-[10px]">
                {k}: {v}
              </Badge>
            ))}
          </div>
        )}

        {/* TL: score da equipa */}
        {assignment.isTeamLeader && metrics?.teamAggregate && metrics.teamAggregate.drivers > 0 && (
          <div className="ml-9 mt-2 rounded-md border border-amber-300 bg-amber-100/40 p-2 text-xs">
            <div className="font-semibold text-amber-900 mb-1">
              Score da equipa ({metrics.teamAggregate.drivers} condutores)
            </div>
            <div className="flex flex-wrap gap-3">
              <span><strong>{metrics.teamAggregate.totalActions}</strong> acções</span>
              <span>custo {fmtEur(metrics.teamAggregate.totalCost)}</span>
              {metrics.teamAggregate.totalActions > 0 && (
                <span>{fmtEur(metrics.teamAggregate.costPerAction)}/acção</span>
              )}
            </div>
            <div className="flex flex-wrap gap-1 mt-1">
              {Object.entries(metrics.teamAggregate.byType).map(([k, v]: any) => (
                <Badge key={k} variant="secondary" className="text-[10px] bg-amber-200/60">
                  {k}: {v}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {expanded && (
          <div className="border-t pt-2 mt-2 text-xs">
            {summaryQ.isLoading && <p className="text-muted-foreground">A carregar...</p>}
            {summaryQ.data && (
              <>
                <div className="flex flex-wrap gap-2 mb-2">
                  <Badge variant="outline">{summaryQ.data.total} entradas</Badge>
                  {Object.entries(summaryQ.data.byType).map(([k, v]) => (
                    <Badge key={k} variant="secondary">{k}: {v}</Badge>
                  ))}
                </div>
                {summaryQ.data.total === 0 ? (
                  <p className="text-muted-foreground">
                    Sem registos. Clica "Buscar histórico" para ir buscar à API.
                  </p>
                ) : (
                  <div className="overflow-x-auto max-h-96 overflow-y-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="text-[10px] uppercase text-muted-foreground border-b">
                          <th className="text-left py-1 px-2">Hora</th>
                          <th className="text-left py-1 px-2">Acção</th>
                          <th className="text-left py-1 px-2">Reserva</th>
                          <th className="text-left py-1 px-2">Notas</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summaryQ.data.items.map((it: any) => (
                          <tr key={it.id} className="border-b hover:bg-muted/40">
                            <td className="py-1 px-2 font-mono">
                              {fmtPTTime(it.actionTime)}
                            </td>
                            <td className="py-1 px-2">
                              <Badge variant="outline" className="text-[10px]">{it.changeType ?? "?"}</Badge>
                            </td>
                            <td className="py-1 px-2 font-mono text-[10px] text-muted-foreground">
                              {it.bookingExternalId.slice(0, 16)}…
                            </td>
                            <td className="py-1 px-2 text-muted-foreground">
                              <span className="line-clamp-2 max-w-[320px] block">{it.remarks ?? "—"}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
