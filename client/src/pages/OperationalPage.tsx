import React, { useState, useMemo, useRef, useEffect } from "react";
import { MapView } from "@/components/Map";
import { trpc } from "@/lib/trpc";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { useAuth } from "@/_core/hooks/useAuth";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { useTableSort, Th } from "@/components/SortableTable";
import { ZelloLiveTab } from "@/components/ZelloLiveTab";
import { usePersistedState } from "@/hooks/usePersistedState";
import {
  Car, AlertTriangle, Radio, Activity, Plus, Trash2, Eye, Check,
  MapPin, Gauge, ArrowUpDown, Clock, Wrench, XCircle, Satellite, Shield, Users, Settings,
  History, Smartphone, Bell, Battery, Upload, Camera, LogOut, ChevronDown, ChevronUp,
  CalendarDays, Route, Zap, Link as LinkIcon,
} from "lucide-react";

const STATUS_LABELS: Record<string, string> = { active: "Ativa", maintenance: "Manutenção", inactive: "Inativa" };
const STATUS_COLORS: Record<string, string> = { active: "bg-green-100 text-green-800", maintenance: "bg-amber-100 text-amber-800", inactive: "bg-red-100 text-red-800" };

export default function OperationalPage() {
  const [tab, setTab] = useState("dashboard");
  return (
    <>
      <div className="p-6 space-y-6">
        <div>
          <p className="text-muted-foreground">Viaturas, movimentos, velocidade e rádio</p>
        </div>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="flex-wrap">
            <TabsTrigger value="dashboard"><Activity className="w-4 h-4 mr-1" />Dashboard</TabsTrigger>
            <TabsTrigger value="live"><Satellite className="w-4 h-4 mr-1" />Ao Vivo</TabsTrigger>
            <TabsTrigger value="dia"><History className="w-4 h-4 mr-1" />Atividade do Dia</TabsTrigger>
            <TabsTrigger value="agents"><Users className="w-4 h-4 mr-1" />Por Colaborador</TabsTrigger>
            <TabsTrigger value="history"><History className="w-4 h-4 mr-1" />Histórico Diário</TabsTrigger>
            <TabsTrigger value="pdas"><Smartphone className="w-4 h-4 mr-1" />PDAs</TabsTrigger>
            <TabsTrigger value="radio"><Radio className="w-4 h-4 mr-1" />Rádio</TabsTrigger>
          </TabsList>
          <TabsContent value="dashboard"><DashboardTab /></TabsContent>
          <TabsContent value="live">{tab === "live" && <ZelloLiveTab />}</TabsContent>
          <TabsContent value="dia"><DayActivityTab /></TabsContent>
          <TabsContent value="agents"><AgentActivityTab /></TabsContent>
          <TabsContent value="history"><DriverHistoryTab /></TabsContent>
          <TabsContent value="pdas"><PdasTab /></TabsContent>
          <TabsContent value="radio"><RadioTab /></TabsContent>
        </Tabs>
      </div>
    </>
  );
}

// ─── DASHBOARD ───────────────────────────────────────────────────────────────

// Posições que devem estar no terreno (excluídos: backoffice, supervisor, director)
const FIELD_POSITIONS = ["driver", "senior_driver", "extra", "frontoffice", "team_leader"];

// Novo DashboardTab: range de datas + KPIs + per-driver in-shift vs out-of-shift
function DashboardTab() {
  const [preset, setPreset] = useState<"today" | "yesterday" | "last7" | "last30" | "month" | "custom">("today");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");

  const { startDate, endDate } = useMemo(() => {
    const today = new Date();
    const fmt = (d: Date) => {
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    if (preset === "custom") return { startDate: customStart, endDate: customEnd };
    if (preset === "today") return { startDate: fmt(today), endDate: fmt(today) };
    if (preset === "yesterday") {
      const y = new Date(today); y.setDate(y.getDate() - 1);
      return { startDate: fmt(y), endDate: fmt(y) };
    }
    if (preset === "last7") {
      const s = new Date(today); s.setDate(s.getDate() - 6);
      return { startDate: fmt(s), endDate: fmt(today) };
    }
    if (preset === "last30") {
      const s = new Date(today); s.setDate(s.getDate() - 29);
      return { startDate: fmt(s), endDate: fmt(today) };
    }
    // month
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    return { startDate: fmt(first), endDate: fmt(today) };
  }, [preset, customStart, customEnd]);

  const { data, isLoading } = trpc.multipark.dashboardRange.useQuery(
    { startDate, endDate },
    { enabled: !!startDate && !!endDate },
  );
  const dailySort = useTableSort(((data?.daily ?? []) as any[]));
  const personSort = useTableSort(((data?.byPerson ?? []) as any[]));

  const fmtEur = (n: number) => n.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });

  return (
    <div className="space-y-4 mt-4">
      {/* Date range picker */}
      <Card>
        <CardContent className="p-4 flex flex-wrap items-end gap-2">
          {([
            ["today", "Hoje"],
            ["yesterday", "Ontem"],
            ["last7", "Últimos 7d"],
            ["last30", "Últimos 30d"],
            ["month", "Este mês"],
            ["custom", "Personalizado"],
          ] as const).map(([k, label]) => (
            <Button
              key={k}
              size="sm"
              variant={preset === k ? "default" : "outline"}
              onClick={() => setPreset(k)}
            >
              {label}
            </Button>
          ))}
          {preset === "custom" && (
            <>
              <div>
                <Label className="text-xs">De</Label>
                <Input
                  type="date"
                  value={customStart}
                  onChange={(e) => setCustomStart(e.target.value)}
                  className="w-40"
                />
              </div>
              <div>
                <Label className="text-xs">Até</Label>
                <Input
                  type="date"
                  value={customEnd}
                  onChange={(e) => setCustomEnd(e.target.value)}
                  className="w-40"
                />
              </div>
            </>
          )}
          <div className="ml-auto text-xs text-muted-foreground">
            {startDate} → {endDate}
          </div>
        </CardContent>
      </Card>

      {isLoading && <p className="text-sm text-muted-foreground">A carregar...</p>}

      {data && (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground">Custo total</div>
                <div className="text-2xl font-bold">{fmtEur(data.totals.totalCost)}</div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  {data.totals.days} dias · {data.totals.drivers} pessoas
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground">Acções totais</div>
                <div className="text-2xl font-bold">{data.totals.totalActions}</div>
                <div className="text-[10px] text-muted-foreground mt-0.5 flex flex-wrap gap-1">
                  {Object.entries(data.totals.byType).map(([k, v]) => (
                    <span key={k}>{k}: {v}</span>
                  ))}
                </div>
              </CardContent>
            </Card>
            <Card className="border-emerald-200">
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground">No horário</div>
                <div className="text-2xl font-bold text-emerald-700">{data.totals.inShift}</div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  {data.totals.totalActions > 0
                    ? `${((data.totals.inShift / data.totals.totalActions) * 100).toFixed(0)}%`
                    : "—"}
                </div>
              </CardContent>
            </Card>
            <Card className="border-amber-200">
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground">Fora do horário</div>
                <div className="text-2xl font-bold text-amber-700">{data.totals.outOfShift}</div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  {data.totals.totalActions > 0
                    ? `${((data.totals.outOfShift / data.totals.totalActions) * 100).toFixed(0)}%`
                    : "—"}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground">€/acção</div>
                <div className="text-2xl font-bold">
                  {data.totals.totalActions > 0 ? fmtEur(data.totals.costPerAction) : "—"}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Daily breakdown */}
          {data.daily.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Por dia</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-xs uppercase text-muted-foreground">
                        <Th k="date" label="Dia" sortKey={dailySort.sortKey} sortDir={dailySort.sortDir} onToggle={dailySort.toggle} />
                        <Th k="drivers" label="Pessoas" align="right" sortKey={dailySort.sortKey} sortDir={dailySort.sortDir} onToggle={dailySort.toggle} />
                        <Th k="totalCost" label="Custo" align="right" sortKey={dailySort.sortKey} sortDir={dailySort.sortDir} onToggle={dailySort.toggle} />
                        <Th k="totalActions" label="Acções" align="right" sortKey={dailySort.sortKey} sortDir={dailySort.sortDir} onToggle={dailySort.toggle} />
                        <Th k="inShift" label="No horário" align="right" className="text-emerald-700" sortKey={dailySort.sortKey} sortDir={dailySort.sortDir} onToggle={dailySort.toggle} />
                        <Th k="outOfShift" label="Fora horário" align="right" className="text-amber-700" sortKey={dailySort.sortKey} sortDir={dailySort.sortDir} onToggle={dailySort.toggle} />
                      </tr>
                    </thead>
                    <tbody>
                      {(dailySort.sorted as any[]).map((d) => (
                        <tr key={d.date} className="border-b hover:bg-muted/30">
                          <td className="py-1.5 px-2 font-mono">{d.date}</td>
                          <td className="py-1.5 px-2 text-right">{d.drivers}</td>
                          <td className="py-1.5 px-2 text-right">{fmtEur(d.totalCost)}</td>
                          <td className="py-1.5 px-2 text-right font-semibold">{d.totalActions}</td>
                          <td className="py-1.5 px-2 text-right text-emerald-700">{d.inShift}</td>
                          <td className="py-1.5 px-2 text-right text-amber-700">{d.outOfShift}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Por pessoa */}
          {data.byPerson.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Por pessoa</CardTitle>
                <p className="text-xs text-muted-foreground">Ordenado por nº de acções totais</p>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-xs uppercase text-muted-foreground">
                        <Th k="personName" label="Pessoa" sortKey={personSort.sortKey} sortDir={personSort.sortDir} onToggle={personSort.toggle} />
                        <Th k="daysWorked" label="Dias" align="right" sortKey={personSort.sortKey} sortDir={personSort.sortDir} onToggle={personSort.toggle} />
                        <Th k="hoursPaid" label="Horas" align="right" sortKey={personSort.sortKey} sortDir={personSort.sortDir} onToggle={personSort.toggle} />
                        <Th k="cost" label="Custo" align="right" sortKey={personSort.sortKey} sortDir={personSort.sortDir} onToggle={personSort.toggle} />
                        <Th k="totalActions" label="Acções" align="right" sortKey={personSort.sortKey} sortDir={personSort.sortDir} onToggle={personSort.toggle} />
                        <Th k="inShift" label="No horário" align="right" className="text-emerald-700" sortKey={personSort.sortKey} sortDir={personSort.sortDir} onToggle={personSort.toggle} />
                        <Th k="outOfShift" label="Fora horário" align="right" className="text-amber-700" sortKey={personSort.sortKey} sortDir={personSort.sortDir} onToggle={personSort.toggle} />
                        <Th k="costPerAction" label="€/acção" align="right" sortKey={personSort.sortKey} sortDir={personSort.sortDir} onToggle={personSort.toggle} />
                      </tr>
                    </thead>
                    <tbody>
                      {(personSort.sorted as any[]).map((p) => (
                        <tr key={p.personName} className="border-b hover:bg-muted/30">
                          <td className="py-1.5 px-2">
                            <div className="flex items-center gap-1.5">
                              {p.personName}
                              {p.isTeamLeader && (
                                <Badge className="bg-amber-100 text-amber-800 border-amber-300 text-[9px]">TL</Badge>
                              )}
                            </div>
                            <div className="text-[10px] text-muted-foreground font-mono">{p.resolvedAgentName}</div>
                          </td>
                          <td className="py-1.5 px-2 text-right">{p.daysWorked}</td>
                          <td className="py-1.5 px-2 text-right">{p.hoursPaid}</td>
                          <td className="py-1.5 px-2 text-right">{fmtEur(p.totalCost)}</td>
                          <td className="py-1.5 px-2 text-right font-semibold">{p.totalActions}</td>
                          <td className="py-1.5 px-2 text-right text-emerald-700">{p.inShiftActions}</td>
                          <td className="py-1.5 px-2 text-right text-amber-700">{p.outOfShiftActions}</td>
                          <td className="py-1.5 px-2 text-right">
                            {p.totalActions > 0 ? fmtEur(p.costPerAction) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}



// ─── ATIVIDADE DO DIA (visão do Jorge: tudo do dia num sítio) ────────────────
// Por pessoa: recolhas/entregas/movimentos/cancelamentos (ações Multipark) +
// km e horas do GPS Zello. O GPS de um dia é recolhido às 2h da manhã
// SEGUINTE — para "hoje" só há ações; os km chegam amanhã.
function DayActivityTab() {
  const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); const pad = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; })();
  const [date, setDate] = usePersistedState("operacional.dia.date", yesterday);
  const { data, isLoading } = trpc.multipark.dayActivity.useQuery({ date }, { refetchOnWindowFocus: false });
  const totals = data?.totals;
  const people = data?.people ?? [];
  const daySort = useTableSort(people as any[]);
  const todayStr = (() => { const d = new Date(); const pad = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; })();

  return (
    <div className="space-y-4 mt-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label className="text-xs mb-1 block">Dia</Label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-44" />
        </div>
        {date === todayStr && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-0.5">
            Hoje ainda sem km — o GPS do dia é recolhido às 2h da manhã seguinte. As ações estão em tempo quase-real.
          </p>
        )}
      </div>

      {totals && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <Card className="p-3"><p className="text-xs text-muted-foreground">Recolhas</p><p className="text-xl font-bold text-emerald-700">{totals.checkins}</p></Card>
          <Card className="p-3"><p className="text-xs text-muted-foreground">Entregas</p><p className="text-xl font-bold text-blue-700">{totals.checkouts}</p></Card>
          <Card className="p-3"><p className="text-xs text-muted-foreground">Movimentações</p><p className="text-xl font-bold">{totals.movements}</p></Card>
          <Card className="p-3"><p className="text-xs text-muted-foreground">Cancelamentos</p><p className="text-xl font-bold text-red-700">{totals.cancels}</p></Card>
          <Card className="p-3"><p className="text-xs text-muted-foreground">Km GPS</p><p className="text-xl font-bold text-purple-700">{totals.totalKm} km</p></Card>
          <Card className="p-3"><p className="text-xs text-muted-foreground">Pessoas ativas</p><p className="text-xl font-bold">{totals.activePeople}</p></Card>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quem fez o quê — {date}</CardTitle>
          <p className="text-xs text-muted-foreground">Ações das reservas + GPS por pessoa. 🤝 = agente que é um parceiro/agência; ⚠ = agente por ligar (aba Por Colaborador).</p>
        </CardHeader>
        <CardContent>
          {isLoading ? <p className="text-sm text-muted-foreground">A carregar…</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <Th k="name" label="Pessoa / Agente" sortKey={daySort.sortKey} sortDir={daySort.sortDir} onToggle={daySort.toggle} />
                    <Th k="checkins" label="Recolhas" align="right" sortKey={daySort.sortKey} sortDir={daySort.sortDir} onToggle={daySort.toggle} />
                    <Th k="checkouts" label="Entregas" align="right" sortKey={daySort.sortKey} sortDir={daySort.sortDir} onToggle={daySort.toggle} />
                    <Th k="movements" label="Movs" align="right" sortKey={daySort.sortKey} sortDir={daySort.sortDir} onToggle={daySort.toggle} />
                    <Th k="cancels" label="Canc." align="right" sortKey={daySort.sortKey} sortDir={daySort.sortDir} onToggle={daySort.toggle} />
                    <Th k="totalActions" label="Total" align="right" className="font-bold" sortKey={daySort.sortKey} sortDir={daySort.sortDir} onToggle={daySort.toggle} />
                    <Th k="totalKm" label="Km" align="right" sortKey={daySort.sortKey} sortDir={daySort.sortDir} onToggle={daySort.toggle} />
                    <Th k="hoursWorked" label="H. movimento" align="right" sortKey={daySort.sortKey} sortDir={daySort.sortDir} onToggle={daySort.toggle} />
                    <Th k="hoursOnline" label="H. online" align="right" sortKey={daySort.sortKey} sortDir={daySort.sortDir} onToggle={daySort.toggle} />
                  </tr>
                </thead>
                <tbody>
                  {(daySort.sorted as any[]).map((pers) => (
                    <tr key={pers.key} className={`border-b hover:bg-muted/40 ${pers.kind === "por_ligar" ? "bg-amber-50/40" : ""}`}>
                      <td className="p-2 font-medium">
                        {pers.kind === "parceiro" && "🤝 "}
                        {pers.kind === "por_ligar" && "⚠ "}
                        {pers.name}
                      </td>
                      <td className="p-2 text-right text-emerald-700 tabular-nums">{pers.checkins || ""}</td>
                      <td className="p-2 text-right text-blue-700 tabular-nums">{pers.checkouts || ""}</td>
                      <td className="p-2 text-right tabular-nums">{pers.movements || ""}</td>
                      <td className="p-2 text-right text-red-700 tabular-nums">{pers.cancels || ""}</td>
                      <td className="p-2 text-right font-bold tabular-nums">{pers.totalActions || ""}</td>
                      <td className="p-2 text-right tabular-nums">{pers.totalKm != null && pers.totalKm > 0 ? `${pers.totalKm} km` : "—"}</td>
                      <td className="p-2 text-right tabular-nums">{pers.hoursWorked != null && pers.hoursWorked > 0 ? `${pers.hoursWorked}h` : "—"}</td>
                      <td className="p-2 text-right tabular-nums">{pers.hoursOnline != null && pers.hoursOnline > 0 ? `${pers.hoursOnline}h` : "—"}</td>
                    </tr>
                  ))}
                  {people.length === 0 && <tr><td colSpan={9} className="p-6 text-center text-muted-foreground">Sem atividade registada neste dia.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── DRIVER HISTORY TAB ─────────────────────────────────────────────────────

function DriverHistoryTab() {
  const [selectedDate, setSelectedDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 1); // default to yesterday
    return d.toISOString().split("T")[0];
  });
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const { data: history, isLoading } = trpc.operational.driverHistory.byDate.useQuery({ date: selectedDate });
  const histSort = useTableSort(((history ?? []) as any[]));
  const { data: stats } = trpc.operational.driverHistory.stats.useQuery({ date: selectedDate });
  const { data: speedLimits = [] } = trpc.operational.speedMonitoring.limits.list.useQuery();
  const defaultLimit = useMemo(() => {
    const d = (speedLimits as any[]).find(l => l.isDefault) ?? (speedLimits as any[])[0];
    const max = d ? Number(d.maxSpeed) : 50;
    const tol = d ? Number(d.tolerancePercent ?? 0) : 0;
    return max * (1 + tol / 100);
  }, [speedLimits]);
  const collectMut = trpc.operational.driverHistory.collectDay.useMutation({
    onSuccess: (data) => {
      utils.operational.driverHistory.byDate.invalidate();
      utils.operational.driverHistory.stats.invalidate();
      if (data.success) {
        toast.success(`Recolha concluída: ${data.driversProcessed} motoristas processados`);
      } else {
        toast.error("Erro na recolha");
      }
    },
    onError: (e) => toast.error(e.message),
  });

  const { data: userHistory } = trpc.operational.driverHistory.byUser.useQuery(
    { username: expandedUser || "", limit: 14 },
    { enabled: !!expandedUser }
  );

  return (
    <div className="space-y-4 mt-4">
      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <CalendarDays className="w-4 h-4 text-muted-foreground" />
          <Input
            type="date"
            value={selectedDate}
            onChange={e => setSelectedDate(e.target.value)}
            className="w-[180px]"
          />
        </div>
        <Button
          variant="outline"
          onClick={() => {
            if (!confirm(`Recolher dados de ${selectedDate} a partir do Zello?`)) return;
            collectMut.mutate({ date: selectedDate });
          }}
          disabled={collectMut.isPending}
        >
          {collectMut.isPending ? "A recolher..." : "Recolher Dados"}
        </Button>
        <Button
          variant="outline"
          disabled={!history || history.length === 0}
          onClick={() => {
            if (!history) return;
            const headers = ["Motorista","Zello","Km","Horas Trab.","Horas Parado","Vel. Méd.","Vel. Máx.","Infrações","Bateria","Pontos GPS"];
            const rows = history.map((h: any) => [
              (h.employeeName || h.displayName || h.zelloUsername).replace(/;/g, ","),
              (h.displayName || h.zelloUsername).replace(/;/g, ","),
              parseFloat(h.totalKm || "0").toFixed(1),
              parseFloat(h.hoursWorked || "0").toFixed(1),
              parseFloat(h.hoursStopped || "0").toFixed(1),
              parseFloat(h.avgSpeed || "0").toFixed(1),
              parseFloat(h.maxSpeed || "0").toFixed(1),
              h.speedViolations || 0,
              h.avgBattery || 0,
              h.gpsPointsCount || 0,
            ]);
            const csv = [headers.join(";"), ...rows.map(r => r.join(";"))].join("\n");
            const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = `historico_${selectedDate}.csv`; a.click();
            URL.revokeObjectURL(url);
          }}
        >
          <ArrowUpDown className="w-4 h-4 mr-1" /> Export CSV
        </Button>
        <p className="text-sm text-muted-foreground">
          Recolha automática: todos os dias às 2:00 (dados do dia anterior)
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-7 gap-3">
        <Card>
          <CardContent className="pt-3 pb-2">
            <p className="text-xs text-muted-foreground">Motoristas</p>
            <p className="text-xl font-bold">{stats?.totalDrivers ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-2">
            <p className="text-xs text-muted-foreground">Km Total</p>
            <p className="text-xl font-bold">{(stats?.totalKm ?? 0).toFixed(1)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-2">
            <p className="text-xs text-muted-foreground">Horas Trabalho</p>
            <p className="text-xl font-bold">{(stats?.totalHoursWorked ?? 0).toFixed(1)}h</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-2">
            <p className="text-xs text-muted-foreground">Horas Parado</p>
            <p className="text-xl font-bold">{(stats?.totalHoursStopped ?? 0).toFixed(1)}h</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-2">
            <p className="text-xs text-muted-foreground">Vel. Máx</p>
            <p className="text-xl font-bold text-red-600">{(stats?.maxSpeedOfDay ?? 0).toFixed(0)} km/h</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-2">
            <p className="text-xs text-muted-foreground">Bat. Média</p>
            <p className="text-xl font-bold">{stats?.avgBattery ?? 0}%</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-2">
            <p className="text-xs text-muted-foreground">Infrações</p>
            <p className="text-xl font-bold text-amber-600">{stats?.totalViolations ?? 0}</p>
          </CardContent>
        </Card>
      </div>

      {/* History table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <History className="w-5 h-5" />
            Histórico de {selectedDate}
            {history && <Badge variant="outline">{history.length} registos</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-center text-muted-foreground py-8">A carregar...</p>
          ) : !history || history.length === 0 ? (
            <div className="text-center py-8">
              <History className="w-12 h-12 mx-auto text-muted-foreground/40 mb-3" />
              <p className="text-muted-foreground">Sem dados para esta data.</p>
              <p className="text-sm text-muted-foreground mt-1">Usa o botão "Recolher Dados" para importar dados do Zello.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <Th k="employeeName" label="Motorista" sortKey={histSort.sortKey} sortDir={histSort.sortDir} onToggle={histSort.toggle} />
                    <Th k="totalKm" label="Km" align="right" sortKey={histSort.sortKey} sortDir={histSort.sortDir} onToggle={histSort.toggle} />
                    <Th k="hoursWorked" label="Horas Trab." align="right" sortKey={histSort.sortKey} sortDir={histSort.sortDir} onToggle={histSort.toggle} />
                    <Th k="hoursIdle" label="Horas Parado" align="right" sortKey={histSort.sortKey} sortDir={histSort.sortDir} onToggle={histSort.toggle} />
                    <Th k="avgSpeed" label="Vel. Média" align="right" sortKey={histSort.sortKey} sortDir={histSort.sortDir} onToggle={histSort.toggle} />
                    <Th k="maxSpeed" label="Vel. Máx" align="right" sortKey={histSort.sortKey} sortDir={histSort.sortDir} onToggle={histSort.toggle} />
                    <Th k="violations" label="Infrações" align="right" sortKey={histSort.sortKey} sortDir={histSort.sortDir} onToggle={histSort.toggle} />
                    <Th k="batteryLevel" label="Bateria" align="right" sortKey={histSort.sortKey} sortDir={histSort.sortDir} onToggle={histSort.toggle} />
                    <Th k="gpsPoints" label="Pontos GPS" align="right" sortKey={histSort.sortKey} sortDir={histSort.sortDir} onToggle={histSort.toggle} />
                    <th className="p-2">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {(histSort.sorted as any[]).map((h: any) => (
                    <React.Fragment key={h.id}>
                      <tr key={h.id} className="border-b hover:bg-muted/50 cursor-pointer" onClick={() => setExpandedUser(expandedUser === h.zelloUsername ? null : h.zelloUsername)}>
                        <td className="p-2 font-medium">
                          <div className="flex items-center gap-1">
                            {expandedUser === h.zelloUsername ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                            {h.employeeName || h.displayName || h.zelloUsername}
                          </div>
                          {h.employeeName && (
                            <p className="text-xs text-muted-foreground font-normal pl-4">{h.displayName || h.zelloUsername}</p>
                          )}
                        </td>
                        <td className="p-2 text-right font-mono">{parseFloat(h.totalKm || "0").toFixed(1)}</td>
                        <td className="p-2 text-right font-mono">{parseFloat(h.hoursWorked || "0").toFixed(1)}h</td>
                        <td className="p-2 text-right font-mono">{parseFloat(h.hoursStopped || "0").toFixed(1)}h</td>
                        <td className="p-2 text-right font-mono">{parseFloat(h.avgSpeed || "0").toFixed(1)}</td>
                        <td className="p-2 text-right font-mono">
                          <span className={parseFloat(h.maxSpeed || "0") > defaultLimit ? "text-red-600 font-bold" : ""}>
                            {parseFloat(h.maxSpeed || "0").toFixed(1)}
                          </span>
                        </td>
                        <td className="p-2 text-right">
                          {h.speedViolations > 0 ? (
                            <Badge variant="destructive">{h.speedViolations}</Badge>
                          ) : (
                            <span className="text-green-600">0</span>
                          )}
                        </td>
                        <td className="p-2 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <div className={`w-2 h-2 rounded-full ${(h.avgBattery || 0) > 50 ? "bg-green-500" : (h.avgBattery || 0) > 20 ? "bg-amber-500" : "bg-red-500"}`} />
                            {h.avgBattery || 0}%
                          </div>
                        </td>
                        <td className="p-2 text-right text-muted-foreground">{h.gpsPointsCount || 0}</td>
                        <td className="p-2">
                          {h.geoJsonUrl && (
                            <Button size="sm" variant="outline" asChild>
                              <a href={h.geoJsonUrl} target="_blank" rel="noopener"><Route className="w-3 h-3" /></a>
                            </Button>
                          )}
                        </td>
                      </tr>
                      {expandedUser === h.zelloUsername && userHistory && (
                        <tr key={`${h.id}-history`}>
                          <td colSpan={10} className="p-0">
                            <div className="bg-muted/30 p-3 border-b">
                              <p className="text-xs font-medium mb-2">Últimos 14 dias — {h.employeeName || h.displayName || h.zelloUsername}</p>
                              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-7 gap-1">
                                {userHistory.map((uh: any) => (
                                  <div key={uh.id} className="text-center text-xs border rounded p-1 bg-background">
                                    <p className="font-medium">{new Date(uh.date).toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit" })}</p>
                                    <p className="text-muted-foreground">{parseFloat(uh.totalKm || "0").toFixed(0)}km</p>
                                    <p className="text-muted-foreground">{parseFloat(uh.hoursWorked || "0").toFixed(1)}h</p>
                                    {uh.speedViolations > 0 && <Badge variant="destructive" className="text-[10px] px-1">{uh.speedViolations}</Badge>}
                                  </div>
                                ))}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── PDAs TAB ───────────────────────────────────────────────────────────────

function PdasTab() {
  const [showCreate, setShowCreate] = useState(false);
  const [showCheckin, setShowCheckin] = useState<number | null>(null);
  const [editPda, setEditPda] = useState<any | null>(null);
  const [viewPda, setViewPda] = useState<number | null>(null);
  const utils = trpc.useUtils();

  const { data: pdaList, isLoading } = trpc.operational.pdas.list.useQuery();
  const { data: activeCheckins } = trpc.operational.pdas.checkins.active.useQuery();
  const deleteMut = trpc.operational.pdas.delete.useMutation({
    onSuccess: () => { utils.operational.pdas.list.invalidate(); toast.success("PDA eliminado"); },
    onError: (e) => toast.error(e.message),
  });

  const PDA_STATUS_LABELS: Record<string, string> = { active: "Ativo", inactive: "Inativo", maintenance: "Manutenção", lost: "Perdido" };
  const PDA_STATUS_COLORS: Record<string, string> = { active: "bg-green-100 text-green-800", inactive: "bg-gray-100 text-gray-800", maintenance: "bg-amber-100 text-amber-800", lost: "bg-red-100 text-red-800" };

  // Map active checkins to PDA IDs
  const checkinByPda = useMemo(() => {
    const m = new Map<number, any>();
    (activeCheckins || []).forEach((c: any) => m.set(c.pdaId, c));
    return m;
  }, [activeCheckins]);

  return (
    <div className="space-y-4 mt-4">
      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-3 pb-2">
            <p className="text-xs text-muted-foreground">Total PDAs</p>
            <p className="text-xl font-bold">{pdaList?.length ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-2">
            <p className="text-xs text-muted-foreground">Ativos</p>
            <p className="text-xl font-bold text-green-600">{(pdaList || []).filter((p: any) => p.status === "active").length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-2">
            <p className="text-xs text-muted-foreground">Em Uso (Check-in)</p>
            <p className="text-xl font-bold text-blue-600">{activeCheckins?.length ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-2">
            <p className="text-xs text-muted-foreground">Manutenção/Perdido</p>
            <p className="text-xl font-bold text-amber-600">{(pdaList || []).filter((p: any) => p.status === "maintenance" || p.status === "lost").length}</p>
          </CardContent>
        </Card>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <Button onClick={() => setShowCreate(true)}><Plus className="w-4 h-4 mr-1" />Novo PDA</Button>
      </div>

      {/* PDA Cards */}
      {isLoading ? (
        <p className="text-center text-muted-foreground py-8">A carregar...</p>
      ) : !pdaList || pdaList.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            <Smartphone className="w-12 h-12 mx-auto text-muted-foreground/40 mb-3" />
            <p>Sem PDAs registados. Adiciona o primeiro dispositivo.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {pdaList.map((pda: any) => {
            const checkin = checkinByPda.get(pda.id);
            return (
              <Card key={pda.id} className={checkin ? "border-blue-300 dark:border-blue-700" : ""}>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <Smartphone className="w-5 h-5 text-primary" />
                      <span className="font-bold truncate">{pda.name}</span>
                    </div>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${PDA_STATUS_COLORS[pda.status]}`}>
                      {PDA_STATUS_LABELS[pda.status]}
                    </span>
                  </div>

                  <div className="text-sm space-y-1 text-muted-foreground">
                    {pda.model && <p>Modelo: {pda.model}</p>}
                    {pda.phoneNumber && <p>Nº: {pda.phoneNumber}</p>}
                    {pda.simDataPlan && <p>Plano: {pda.simDataPlan}</p>}
                    {pda.imei && <p className="text-xs">IMEI: {pda.imei}</p>}
                  </div>

                  {checkin && (
                    <div className="bg-blue-50 dark:bg-blue-950/30 rounded-lg p-2 text-sm">
                      <p className="font-medium text-blue-700 dark:text-blue-300 flex items-center gap-1">
                        <Users className="w-3 h-3" /> Em uso
                      </p>
                      {checkin.employeeName && <p className="text-xs font-medium">{checkin.employeeName}</p>}
                      {checkin.zelloUsername && <p className="text-xs">Zello: {checkin.zelloUsername}</p>}
                      <p className="text-xs text-muted-foreground">
                        Desde {fmtPTDateTime(checkin.checkinAt)}
                      </p>
                    </div>
                  )}

                  <div className="flex gap-1 flex-wrap">
                    {!checkin && pda.status === "active" && (
                      <Button size="sm" variant="default" onClick={() => setShowCheckin(pda.id)}>
                        <Camera className="w-3 h-3 mr-1" />Check-in
                      </Button>
                    )}
                    {checkin && (
                      <CheckoutButton checkinId={checkin.id} pdaName={pda.name} />
                    )}
                    <Button size="sm" variant="outline" onClick={() => setEditPda(pda)}>
                      <Settings className="w-3 h-3" />
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setViewPda(pda.id)}>
                      <Eye className="w-3 h-3" />
                    </Button>
                    <Button size="sm" variant="ghost" className="text-red-600" onClick={() => {
                      if (confirm(`Eliminar PDA ${pda.name}?`)) deleteMut.mutate({ id: pda.id });
                    }}>
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Dialogs */}
      {showCreate && <CreatePdaDialog onClose={() => setShowCreate(false)} />}
      {editPda && <EditPdaDialog pda={editPda} onClose={() => setEditPda(null)} />}
      {showCheckin !== null && <CheckinDialog pdaId={showCheckin} onClose={() => setShowCheckin(null)} />}
      {viewPda !== null && <PdaHistoryDialog pdaId={viewPda} onClose={() => setViewPda(null)} />}
    </div>
  );
}

function CheckoutButton({ checkinId, pdaName }: { checkinId: number; pdaName: string }) {
  const utils = trpc.useUtils();
  const checkoutMut = trpc.operational.pdas.checkins.checkout.useMutation({
    onSuccess: () => {
      utils.operational.pdas.checkins.active.invalidate();
      toast.success(`Check-out ${pdaName} concluído`);
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Button size="sm" variant="secondary" onClick={() => checkoutMut.mutate({ id: checkinId })} disabled={checkoutMut.isPending}>
      <LogOut className="w-3 h-3 mr-1" />{checkoutMut.isPending ? "..." : "Check-out"}
    </Button>
  );
}

function CreatePdaDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [imei, setImei] = useState("");
  const [model, setModel] = useState("");
  const [zelloUsername, setZelloUsername] = useState("");
  const [simDataPlan, setSimDataPlan] = useState("");
  const [notes, setNotes] = useState("");
  const utils = trpc.useUtils();

  const createMut = trpc.operational.pdas.create.useMutation({
    onSuccess: () => { utils.operational.pdas.list.invalidate(); toast.success("PDA criado"); onClose(); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader><DialogTitle>Novo PDA</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Nome *</Label><Input value={name} onChange={e => setName(e.target.value)} placeholder="Ex: PDA-001" /></div>
          <div><Label>Modelo</Label><Input value={model} onChange={e => setModel(e.target.value)} placeholder="Ex: Samsung Galaxy XCover" /></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><Label>Nº Telemóvel</Label><Input value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)} placeholder="Ex: 912345678" /></div>
            <div><Label>IMEI</Label><Input value={imei} onChange={e => setImei(e.target.value)} placeholder="IMEI do dispositivo" /></div>
          </div>
          <div>
            <Label>Utilizador Zello (instalado neste PDA)</Label>
            <Input value={zelloUsername} onChange={e => setZelloUsername(e.target.value)} placeholder="Ex: pda01" />
            <p className="text-xs text-muted-foreground mt-1">Só aparece aqui — na atividade/GPS mostra-se o funcionário com check-in no PDA.</p>
          </div>
          <div><Label>Plano de Dados</Label><Input value={simDataPlan} onChange={e => setSimDataPlan(e.target.value)} placeholder="Ex: 5GB NOS" /></div>
          <div><Label>Notas</Label><Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Observações..." /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={!name || createMut.isPending} onClick={() => createMut.mutate({
            name, phoneNumber: phoneNumber || undefined, imei: imei || undefined,
            model: model || undefined, zelloUsername: zelloUsername || undefined,
            simDataPlan: simDataPlan || undefined, notes: notes || undefined,
          })}>{createMut.isPending ? "A criar..." : "Criar PDA"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditPdaDialog({ pda, onClose }: { pda: any; onClose: () => void }) {
  const [name, setName] = useState(pda.name);
  const [phoneNumber, setPhoneNumber] = useState(pda.phoneNumber || "");
  const [imei, setImei] = useState(pda.imei || "");
  const [model, setModel] = useState(pda.model || "");
  const [zelloUsername, setZelloUsername] = useState(pda.zelloUsername || "");
  const [simDataPlan, setSimDataPlan] = useState(pda.simDataPlan || "");
  const [status, setStatus] = useState(pda.status);
  const [notes, setNotes] = useState(pda.notes || "");
  const utils = trpc.useUtils();

  const updateMut = trpc.operational.pdas.update.useMutation({
    onSuccess: () => { utils.operational.pdas.list.invalidate(); toast.success("PDA atualizado"); onClose(); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader><DialogTitle>Editar PDA — {pda.name}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Nome</Label><Input value={name} onChange={e => setName(e.target.value)} /></div>
          <div><Label>Modelo</Label><Input value={model} onChange={e => setModel(e.target.value)} /></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><Label>Nº Telemóvel</Label><Input value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)} /></div>
            <div><Label>IMEI</Label><Input value={imei} onChange={e => setImei(e.target.value)} /></div>
          </div>
          <div><Label>Utilizador Zello (instalado neste PDA)</Label><Input value={zelloUsername} onChange={e => setZelloUsername(e.target.value)} placeholder="Ex: pda01" /></div>
          <div><Label>Plano de Dados</Label><Input value={simDataPlan} onChange={e => setSimDataPlan(e.target.value)} /></div>
          <div>
            <Label>Estado</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Ativo</SelectItem>
                <SelectItem value="inactive">Inativo</SelectItem>
                <SelectItem value="maintenance">Manutenção</SelectItem>
                <SelectItem value="lost">Perdido</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div><Label>Notas</Label><Textarea value={notes} onChange={e => setNotes(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={updateMut.isPending} onClick={() => updateMut.mutate({
            id: pda.id,
            data: { name, phoneNumber: phoneNumber || null, imei: imei || null, model: model || null, zelloUsername: zelloUsername || null, simDataPlan: simDataPlan || null, status: status as any, notes: notes || null },
          })}>{updateMut.isPending ? "A guardar..." : "Guardar"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CheckinDialog({ pdaId, onClose }: { pdaId: number; onClose: () => void }) {
  const [zelloUsername, setZelloUsername] = useState("");
  const [mobileDataMbStart, setMobileDataMbStart] = useState("");
  const [notes, setNotes] = useState("");
  const [photoEntryUrl, setPhotoEntryUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const utils = trpc.useUtils();

  const { data: zelloUsers } = trpc.operational.zello.users.useQuery();
  const { data: employees } = trpc.rh.list.useQuery();
  const [employeeId, setEmployeeId] = useState("");
  // Pré-preenche com o utilizador Zello registado no próprio PDA.
  const { data: pdaRecord } = trpc.operational.pdas.get.useQuery({ id: pdaId });
  useEffect(() => {
    if (pdaRecord?.zelloUsername && !zelloUsername) setZelloUsername(pdaRecord.zelloUsername);
  }, [pdaRecord]);

  const checkinMut = trpc.operational.pdas.checkins.checkin.useMutation({
    onSuccess: () => {
      utils.operational.pdas.checkins.active.invalidate();
      toast.success("Check-in registado!");
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  const handlePhotoCapture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      // Fotos de PDA vêm com 8-12MB e o Vercel limita o body a ~4.5MB —
      // redimensiona para 1600px/JPEG antes de enviar (também acelera no 4G).
      const resized = await resizeImageFile(file, 1600, 0.85);
      const formData = new FormData();
      formData.append("file", resized, "checkin.jpg");
      const resp = await fetch("/api/upload", { method: "POST", body: formData });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const { url, error } = await resp.json();
      if (!url) throw new Error(error || "sem URL");
      setPhotoEntryUrl(url);
      toast.success("Foto carregada!");
    } catch (err: any) {
      toast.error(`Erro ao carregar foto: ${err?.message ?? "falha"}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader><DialogTitle>Check-in PDA #{pdaId}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Utilizador Zello</Label>
            <Select value={zelloUsername} onValueChange={setZelloUsername}>
              <SelectTrigger><SelectValue placeholder="Selecionar utilizador..." /></SelectTrigger>
              <SelectContent>
                {(zelloUsers || []).filter((u: any) => !u.admin).map((u: any) => (
                  <SelectItem key={u.name} value={u.name}>{u.fullName || u.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Funcionário *</Label>
            <Select value={employeeId} onValueChange={setEmployeeId}>
              <SelectTrigger><SelectValue placeholder="Escolher funcionário..." /></SelectTrigger>
              <SelectContent>
                {(employees || []).map((e: any) => (
                  <SelectItem key={e.employee.id} value={String(e.employee.id)}>{e.employee.fullName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!employeeId && <p className="text-xs text-muted-foreground mt-1">Obrigatório — o histórico de atividade fica associado a esta pessoa.</p>}
          </div>
          <div>
            <Label>Dados Móveis (MB no início)</Label>
            <Input type="number" value={mobileDataMbStart} onChange={e => setMobileDataMbStart(e.target.value)} placeholder="Ex: 2500" />
          </div>
          <div>
            <Label>Foto de Entrada</Label>
            <div className="flex items-center gap-2">
              <label className="cursor-pointer">
                <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handlePhotoCapture} />
                <Button variant="outline" asChild><span><Camera className="w-4 h-4 mr-1" />{uploading ? "A carregar..." : "Tirar Foto"}</span></Button>
              </label>
              {photoEntryUrl && <Badge variant="outline" className="text-green-600">Foto OK</Badge>}
            </div>
          </div>
          <div>
            <Label>Notas</Label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Observações..." />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={checkinMut.isPending || uploading || !employeeId || employeeId === "none"} onClick={() => checkinMut.mutate({
            pdaId,
            zelloUsername: zelloUsername || undefined,
            employeeId: Number(employeeId),
            photoEntryUrl: photoEntryUrl || undefined,
            mobileDataMbStart: mobileDataMbStart ? Number(mobileDataMbStart) : undefined,
            notes: notes || undefined,
          })}>{checkinMut.isPending ? "A registar..." : "Registar Check-in"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PdaHistoryDialog({ pdaId, onClose }: { pdaId: number; onClose: () => void }) {
  const { data: checkins, isLoading } = trpc.operational.pdas.checkins.byPda.useQuery({ pdaId });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader><DialogTitle>Histórico PDA #{pdaId}</DialogTitle></DialogHeader>
        {isLoading ? (
          <p className="text-center py-4 text-muted-foreground">A carregar...</p>
        ) : !checkins || checkins.length === 0 ? (
          <p className="text-center py-4 text-muted-foreground">Sem registos de check-in.</p>
        ) : (
          <div className="max-h-[400px] overflow-y-auto overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="p-2">Utilizador</th>
                  <th className="p-2">Check-in</th>
                  <th className="p-2">Check-out</th>
                  <th className="p-2">Dados</th>
                  <th className="p-2">Estado</th>
                </tr>
              </thead>
              <tbody>
                {checkins.map((c: any) => (
                  <tr key={c.id} className="border-b">
                    <td className="p-2 font-medium">
                      {c.employeeName || c.zelloUsername || `Emp #${c.employeeId}`}
                      {c.employeeName && c.zelloUsername && (
                        <p className="text-xs text-muted-foreground font-normal">{c.zelloUsername}</p>
                      )}
                    </td>
                    <td className="p-2 text-muted-foreground">{fmtPTDateTime(c.checkinAt)}</td>
                    <td className="p-2 text-muted-foreground">{c.checkoutAt ? fmtPTDateTime(c.checkoutAt) : "-"}</td>
                    <td className="p-2 text-xs">
                      {c.mobileDataMbStart != null && c.mobileDataMbEnd != null
                        ? `${c.mobileDataMbEnd - c.mobileDataMbStart} MB`
                        : c.mobileDataMbStart != null ? `Início: ${c.mobileDataMbStart} MB` : "-"}
                    </td>
                    <td className="p-2">
                      <Badge variant={c.status === "checked_in" ? "default" : "secondary"}>
                        {c.status === "checked_in" ? "Em uso" : "Devolvido"}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Fechar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RadioTab() {
  const [showTranscribe, setShowTranscribe] = useState(false);
  const { data: transcriptions } = trpc.operational.radio.list.useQuery();
  const { data: employees } = trpc.rh.list.useQuery();
  const { data: vehiclesList } = trpc.operational.vehicles.list.useQuery();

  const empMap = useMemo(() => {
    const m = new Map<number, string>();
    (employees || []).forEach((e: any) => m.set(e.employee.id, e.employee.fullName));
    return m;
  }, [employees]);
  const vehMap = useMemo(() => {
    const m = new Map<number, string>();
    (vehiclesList || []).forEach((v: any) => m.set(v.id, v.plate));
    return m;
  }, [vehiclesList]);

  return (
    <div className="space-y-4 mt-4">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground">Transcrições de comunicações rádio</p>
        <Button onClick={() => setShowTranscribe(true)}><Plus className="w-4 h-4 mr-1" />Nova Transcrição</Button>
      </div>

      <div className="grid gap-4">
        {(!transcriptions || transcriptions.length === 0) ? (
          <Card><CardContent className="py-8 text-center text-muted-foreground">Sem transcrições. Carrega um áudio para começar.</CardContent></Card>
        ) : transcriptions.map((t: any) => (
          <Card key={t.id}>
            <CardContent className="p-4 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Radio className="w-4 h-4 text-primary" />
                  <span className="text-sm text-muted-foreground">{fmtPTDateTime(t.createdAt)}</span>
                  {t.employeeId && <Badge variant="outline">{empMap.get(t.employeeId) || `#${t.employeeId}`}</Badge>}
                  {t.vehicleId && <Badge variant="secondary">{vehMap.get(t.vehicleId) || `#${t.vehicleId}`}</Badge>}
                  {t.duration && <span className="text-xs text-muted-foreground">{Math.floor(t.duration / 60)}:{String(t.duration % 60).padStart(2, "0")}</span>}
                </div>
                {t.audioUrl && <a href={t.audioUrl} target="_blank" rel="noopener"><Button size="sm" variant="outline"><Eye className="w-4 h-4 mr-1" />Áudio</Button></a>}
              </div>
              {t.summary && <p className="text-sm font-medium bg-muted/50 p-2 rounded">{t.summary}</p>}
              {t.transcription && <p className="text-sm text-muted-foreground whitespace-pre-wrap">{t.transcription}</p>}
            </CardContent>
          </Card>
        ))}
      </div>

      {showTranscribe && <TranscribeDialog employees={employees || []} vehicles={vehiclesList || []} onClose={() => setShowTranscribe(false)} />}
    </div>
  );
}

function TranscribeDialog({ employees, vehicles, onClose }: { employees: any[]; vehicles: any[]; onClose: () => void }) {
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [employeeId, setEmployeeId] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [uploading, setUploading] = useState(false);
  const utils = trpc.useUtils();
  const transcribeMut = trpc.operational.radio.transcribe.useMutation({
    onSuccess: (data) => { utils.operational.radio.list.invalidate(); toast.success("Transcrição concluída!"); onClose(); },
    onError: (e) => toast.error(e.message),
  });

  const handleSubmit = async () => {
    if (!audioFile) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", audioFile);
      const resp = await fetch("/api/upload", { method: "POST", body: formData });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const { url } = await resp.json();
      if (!url) throw new Error("upload sem URL");
      transcribeMut.mutate({
        audioUrl: url,
        employeeId: employeeId && employeeId !== "none" ? Number(employeeId) : undefined,
        vehicleId: vehicleId && vehicleId !== "none" ? Number(vehicleId) : undefined,
        duration: undefined,
      });
    } catch {
      toast.error("Erro ao carregar áudio");
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader><DialogTitle>Transcrever Áudio de Rádio</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Ficheiro Áudio *</Label>
            <Input type="file" accept="audio/*,.webm,.mp3,.wav,.ogg,.m4a" onChange={e => setAudioFile(e.target.files?.[0] || null)} />
          </div>
          <div><Label>Condutor</Label>
            <Select value={employeeId} onValueChange={setEmployeeId}>
              <SelectTrigger><SelectValue placeholder="Opcional" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">N/A</SelectItem>
                {employees.map((e: any) => <SelectItem key={e.employee.id} value={String(e.employee.id)}>{e.employee.fullName}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div><Label>Viatura</Label>
            <Select value={vehicleId} onValueChange={setVehicleId}>
              <SelectTrigger><SelectValue placeholder="Opcional" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">N/A</SelectItem>
                {vehicles.map((v: any) => <SelectItem key={v.id} value={String(v.id)}>{v.plate} - {v.brand} {v.model}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={!audioFile || uploading || transcribeMut.isPending} onClick={handleSubmit}>
            {uploading || transcribeMut.isPending ? "A processar..." : "Transcrever"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── ATIVIDADE POR COLABORADOR (todos os agentes + mapeamento) ────────────────
function AgentActivityTab() {
  const utils = trpc.useUtils();
  const todayStr = new Date().toISOString().slice(0, 10);
  const monthStartStr = todayStr.slice(0, 8) + "01";
  const [from, setFrom] = useState(monthStartStr);
  const [to, setTo] = useState(todayStr);
  const [onlyUnmapped, setOnlyUnmapped] = useState(false);
  const { data: agents = [], isLoading } = trpc.multipark.agentActivity.useQuery({ from, to });
  const { data: employees = [] } = trpc.multipark.employeesForMapping.useQuery();
  const { data: agentPartners = [] } = trpc.multipark.agentPartners.useQuery();
  const { data: partnershipsList = [] } = trpc.partnerships.list.useQuery({} as any);
  const partnerByAgent = useMemo(() => new Map((agentPartners as any[]).map((x) => [x.agentName.trim().toLowerCase(), x])), [agentPartners]);
  const setPartnerMut = trpc.multipark.setAgentPartner.useMutation({
    onSuccess: () => { utils.multipark.agentPartners.invalidate(); toast.success("Agente ligado ao parceiro"); },
    onError: (e) => toast.error(e.message),
  });
  const mapMut = trpc.multipark.mapAgentToEmployee.useMutation({
    onSuccess: () => { utils.multipark.agentActivity.invalidate(); utils.multipark.employeesForMapping.invalidate(); toast.success("Ligação guardada"); },
    onError: (e) => toast.error(e.message),
  });

  const rowsUnsorted = (agents as any[]).filter((a) => !onlyUnmapped || (!a.employeeId && !partnerByAgent.has(String(a.agentName ?? "").trim().toLowerCase())));
  const agentSort = useTableSort(rowsUnsorted);
  const rows = agentSort.sorted as any[];
  const mappedCount = (agents as any[]).filter((a) => a.employeeId).length;
  const totalActions = (agents as any[]).reduce((s, a) => s + a.total, 0);

  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardContent className="p-4 flex flex-wrap items-end gap-3">
          <div><Label className="text-xs">De</Label><Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><Label className="text-xs">Até</Label><Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <label className="flex items-center gap-1.5 text-sm cursor-pointer self-center select-none">
            <input type="checkbox" checked={onlyUnmapped} onChange={(e) => setOnlyUnmapped(e.target.checked)} className="h-4 w-4" /> só por ligar
          </label>
          <AutoLinkAgentsButton />
          <div className="ml-auto text-xs text-muted-foreground self-center">
            {(agents as any[]).length} agentes · {mappedCount} ligados · {totalActions} ações
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Atividade por agente Multipark</CardTitle>
          <p className="text-xs text-muted-foreground">Liga cada nome de agente ao colaborador (os nomes na Multipark diferem dos do RH). Fica guardado para sempre.</p>
        </CardHeader>
        <CardContent>
          {isLoading && <p className="text-sm text-muted-foreground">A carregar...</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <Th k="agentName" label="Agente (Multipark)" sortKey={agentSort.sortKey} sortDir={agentSort.sortDir} onToggle={agentSort.toggle} />
                  <Th k="total" label="Ações" sortKey={agentSort.sortKey} sortDir={agentSort.sortDir} onToggle={agentSort.toggle} />
                  <Th k="checkin" label="In" sortKey={agentSort.sortKey} sortDir={agentSort.sortDir} onToggle={agentSort.toggle} />
                  <Th k="checkout" label="Out" sortKey={agentSort.sortKey} sortDir={agentSort.sortDir} onToggle={agentSort.toggle} />
                  <Th k="movement" label="Mov." sortKey={agentSort.sortKey} sortDir={agentSort.sortDir} onToggle={agentSort.toggle} />
                  <th className="p-2">Colaborador</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.agentName} className={`border-b ${!a.employeeId ? "bg-amber-50/40" : ""}`}>
                    <td className="p-2 font-medium max-w-[200px] truncate">{a.agentName}</td>
                    <td className="p-2 font-semibold">{a.total}</td>
                    <td className="p-2 text-emerald-700">{a.checkin}</td>
                    <td className="p-2 text-blue-700">{a.checkout}</td>
                    <td className="p-2 text-muted-foreground">{a.movement}</td>
                    <td className="p-2">
                      <SearchableSelect
                        className="h-8 w-64"
                        value={a.employeeId ? String(a.employeeId) : ""}
                        onChange={(v) => mapMut.mutate({ agentName: a.agentName, employeeId: v ? Number(v) : null })}
                        placeholder="— ligar a colaborador —"
                        options={[{ value: "", label: "— sem ligação —" }, ...(employees as any[]).map((e) => ({ value: String(e.id), label: e.fullName }))]}
                      />
                      {/* Ou é uma AGÊNCIA/parceiro que marca pelo portal de agentes */}
                      {(() => {
                        const link = partnerByAgent.get(String(a.agentName ?? "").trim().toLowerCase());
                        return (
                          <div className="mt-1 flex items-center gap-1.5">
                            <span className="text-[10px] text-muted-foreground">ou parceiro:</span>
                            <SearchableSelect
                              className="h-7 w-56 text-xs"
                              value={link ? String(link.partnershipId) : ""}
                              onChange={(v) => setPartnerMut.mutate({ agentName: a.agentName, partnershipId: v ? Number(v) : null })}
                              placeholder="— agência/agregador —"
                              options={[{ value: "", label: "— sem parceiro —" }, ...((partnershipsList as any[]) ?? []).map((pp: any) => ({ value: String(pp.id ?? pp.partnership?.id), label: pp.name ?? pp.partnership?.name ?? `#${pp.id}` }))]}
                            />
                            {link && <Badge variant="outline" className="text-[9px] border-rose-200 text-rose-700">🤝 {link.partnerName}</Badge>}
                          </div>
                        );
                      })()}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && !isLoading && <tr><td colSpan={6} className="p-4 text-center text-muted-foreground">Sem atividade no período.</td></tr>}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── AUTO-LIGAÇÃO DE AGENTES ─────────────────────────────────────────────────
// Liga por nome (normalizado) os agentes Multipark aos colaboradores; só faz
// matches ÚNICOS — os ambíguos/sem match continuam na fila manual.
function AutoLinkAgentsButton() {
  const utils = trpc.useUtils();
  const mut = trpc.multipark.autoLinkAgents.useMutation({
    onSuccess: (r) => {
      utils.multipark.agentActivity.invalidate();
      utils.multipark.employeesForMapping.invalidate();
      const parts = [`${r.linked.length} ligados automaticamente`];
      if (r.ambiguous.length) parts.push(`${r.ambiguous.length} ambíguos (ligar à mão)`);
      if (r.unmatched.length) parts.push(`${r.unmatched.length} sem colaborador correspondente`);
      toast.success(parts.join(" · "));
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Button variant="outline" size="sm" className="self-center" onClick={() => mut.mutate()} disabled={mut.isPending}>
      <LinkIcon className="w-4 h-4 mr-1" />
      {mut.isPending ? "A ligar…" : "Ligar automáticos"}
    </Button>
  );
}

// Redimensiona uma imagem no browser (máx `maxPx` no lado maior, JPEG).
// Necessário porque o Vercel limita o corpo do pedido a ~4.5MB.
async function resizeImageFile(file: File, maxPx: number, quality: number): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) throw new Error("resize falhou");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

