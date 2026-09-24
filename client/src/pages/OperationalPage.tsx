import React, { useState, useMemo, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { fmtPTDateTime, fmtPTTime } from "@/lib/lisbonTime";
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
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { useTableSort, Th } from "@/components/SortableTable";
import { ZelloLiveTab } from "@/components/ZelloLiveTab";
import { UniDateNav } from "@/components/DateRangeNav";
import { usePersistedState } from "@/hooks/usePersistedState";
import { lisbonToday } from "@shared/expensePeriods";
import { addDays } from "@shared/lisbonDay";
import {
  Plus, Trash2, Eye, Gauge, ArrowUpDown, Satellite, Users, Settings,
  History, Smartphone, Camera, LogOut, CalendarDays, Route, QrCode, Activity, RefreshCw,
} from "lucide-react";
import QRCodeLib from "qrcode";
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const ROLE_LEVEL: Record<string, number> = { user: 0, extra: 1, frontoffice: 2, backoffice: 3, team_leader: 4, supervisor: 5, admin: 6, super_admin: 7 };
function useRoleAtLeast(min: string): boolean {
  const { user } = useAuth();
  return (ROLE_LEVEL[String(user?.role ?? "")] ?? -1) >= (ROLE_LEVEL[min] ?? 99);
}

/** Recolha GPS: o cron diário corre às 03:30 UTC (≈ 04:30 de Lisboa no verão, 03:30 no inverno). */
const GPS_COLLECTION_TEXT = "de madrugada (≈ 04:30 em Lisboa no verão, 03:30 no inverno)";

type SpeedTarget = { employeeId?: number; zelloUsername?: string } | null;

const TABS = ["dia", "live", "history", "pdas"] as const;
type TabKey = (typeof TABS)[number];

export default function OperationalPage() {
  const [rawTab, setTab] = usePersistedState<string>("operacional.tab", "dia");
  const tab: TabKey = (TABS as readonly string[]).includes(rawTab) ? (rawTab as TabKey) : "dia";
  const [speedTarget, setSpeedTarget] = useState<SpeedTarget>(null);
  const openSpeedHistory = (t: SpeedTarget) => { setSpeedTarget(t); setTab("history"); };
  return (
    <div className="p-6 space-y-6">
      <div>
        <p className="text-muted-foreground">Quem fez o quê, km e velocidades, e os PDAs. As transcrições de rádio estão em Operações → Rádio.</p>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="dia"><Activity className="w-4 h-4 mr-1" />Atividade do Dia</TabsTrigger>
          <TabsTrigger value="live"><Satellite className="w-4 h-4 mr-1" />Ao Vivo</TabsTrigger>
          <TabsTrigger value="history"><Gauge className="w-4 h-4 mr-1" />Histórico Diário</TabsTrigger>
          <TabsTrigger value="pdas"><Smartphone className="w-4 h-4 mr-1" />PDAs</TabsTrigger>
        </TabsList>
        <TabsContent value="dia"><DayActivityTab onOpenSpeedHistory={openSpeedHistory} /></TabsContent>
        <TabsContent value="live">{tab === "live" && <ZelloLiveTab />}</TabsContent>
        <TabsContent value="history">{tab === "history" && <DriverHistoryTab speedTarget={speedTarget} onSpeedTarget={setSpeedTarget} />}</TabsContent>
        <TabsContent value="pdas">{tab === "pdas" && <PdasTab />}</TabsContent>
      </Tabs>
    </div>
  );
}

const fmtEur = (n: number) => n.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
const pct = (a: number, total: number) => (total > 0 ? `${Math.round((a / total) * 100)}%` : "—");

// ─── ATIVIDADE DO DIA (ecrã principal) ───────────────────────────────────────
// Por pessoa, num dia ou intervalo: ações nas reservas (dia do turno), no
// horário vs fora (escala extras-dia), custo dos extras (só quem vê totais),
// km/velocidades do GPS e ponto. Clicar numa pessoa abre o dia dela.
type Preset = "today" | "yesterday" | "last7" | "last30" | "month" | "custom";

function DayActivityTab({ onOpenSpeedHistory }: { onOpenSpeedHistory: (t: SpeedTarget) => void }) {
  const { projectId } = useGlobalFilters();
  const today = lisbonToday();
  const [preset, setPreset] = usePersistedState<Preset>("operacional.dia.preset", "today");
  const [custom, setCustom] = usePersistedState("operacional.dia.custom", { start: today, end: today });
  const { startDate, endDate } = useMemo(() => {
    switch (preset) {
      case "yesterday": return { startDate: addDays(today, -1), endDate: addDays(today, -1) };
      case "last7": return { startDate: addDays(today, -6), endDate: today };
      case "last30": return { startDate: addDays(today, -29), endDate: today };
      case "month": return { startDate: `${today.slice(0, 8)}01`, endDate: today };
      case "custom": return { startDate: custom.start, endDate: custom.end >= custom.start ? custom.end : custom.start };
      default: return { startDate: today, endDate: today };
    }
  }, [preset, custom, today]);
  const single = startDate === endDate;
  const { data, isLoading } = trpc.multipark.dayActivity.useQuery(
    { startDate, endDate, projectId },
    { enabled: !!startDate, refetchOnWindowFocus: false },
  );
  const totals = data?.totals;
  const people = (data?.people ?? []) as any[];
  const canSeeCost = !!data?.canSeeCost;
  const daySort = useTableSort(people);
  const dailySort = useTableSort((data?.daily ?? []) as any[]);
  const [drawer, setDrawer] = useState<{ key: string; name: string; employeeId: number | null; zello: string | null } | null>(null);

  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardContent className="p-4 flex flex-wrap items-end gap-2">
          {([
            ["today", "Hoje"], ["yesterday", "Ontem"], ["last7", "Últimos 7d"], ["last30", "Últimos 30d"], ["month", "Este mês"], ["custom", "Intervalo"],
          ] as const).map(([k, label]) => (
            <Button key={k} size="sm" variant={preset === k ? "default" : "outline"} onClick={() => setPreset(k)}>{label}</Button>
          ))}
          {preset === "custom" ? (
            <>
              <div><Label className="text-xs">De</Label><Input type="date" className="w-40" value={custom.start} max={today} onChange={(e) => setCustom({ ...custom, start: e.target.value })} /></div>
              <div><Label className="text-xs">Até</Label><Input type="date" className="w-40" value={custom.end} max={today} onChange={(e) => setCustom({ ...custom, end: e.target.value })} /></div>
            </>
          ) : single ? (
            <div>
              <Label className="text-xs mb-1 block">Dia</Label>
              <UniDateNav date={startDate} onChange={(d) => { setCustom({ start: d, end: d }); setPreset(d === today ? "today" : d === addDays(today, -1) ? "yesterday" : "custom"); }} />
            </div>
          ) : null}
          <div className="ml-auto text-xs text-muted-foreground">{single ? startDate : `${startDate} → ${endDate}`}</div>
        </CardContent>
      </Card>

      {data && data.gpsMissingDays.length > 0 && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          Ainda sem recolha GPS para {data.gpsMissingDays.length === 1 ? data.gpsMissingDays[0] : `${data.gpsMissingDays.length} dias`} — a recolha corre {GPS_COLLECTION_TEXT}.
          Os km desses dias vêm do check-out do ponto e aparecem como <b>provisório</b>. As ações estão em tempo quase-real.
        </p>
      )}

      {totals && (
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
          <Card className="p-3"><p className="text-xs text-muted-foreground">Recolhas</p><p className="text-xl font-bold text-emerald-700">{totals.checkins}</p></Card>
          <Card className="p-3"><p className="text-xs text-muted-foreground">Entregas</p><p className="text-xl font-bold text-blue-700">{totals.checkouts}</p></Card>
          <Card className="p-3"><p className="text-xs text-muted-foreground">Movimentações</p><p className="text-xl font-bold">{totals.movements}</p></Card>
          <Card className="p-3"><p className="text-xs text-muted-foreground">Cancelamentos</p><p className="text-xl font-bold text-red-700">{totals.cancels}</p></Card>
          <Card className="p-3">
            <p className="text-xs text-muted-foreground">No horário / fora</p>
            <p className="text-xl font-bold"><span className="text-emerald-700">{totals.inShift}</span> <span className="text-muted-foreground text-base">/</span> <span className="text-amber-700">{totals.outOfShift}</span></p>
            <p className="text-[10px] text-muted-foreground">{pct(totals.inShift, totals.inShift + totals.outOfShift)} no horário · {totals.scheduledPeople} escalados</p>
          </Card>
          <Card className="p-3"><p className="text-xs text-muted-foreground">Km GPS</p><p className="text-xl font-bold text-purple-700">{totals.totalKm} km</p><p className="text-[10px] text-muted-foreground">{totals.violations} excessos</p></Card>
          <Card className="p-3"><p className="text-xs text-muted-foreground">Pessoas ativas</p><p className="text-xl font-bold">{totals.activePeople}</p></Card>
          {canSeeCost && totals.totalCost != null && (
            <Card className="p-3">
              <p className="text-xs text-muted-foreground">Custo extras</p>
              <p className="text-xl font-bold">{fmtEur(totals.totalCost)}</p>
              <p className="text-[10px] text-muted-foreground">{totals.costPerAction != null ? `${fmtEur(totals.costPerAction)}/ação` : "—"}</p>
            </Card>
          )}
        </div>
      )}

      {data && !single && data.daily.length > 1 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Por dia</CardTitle></CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs uppercase text-muted-foreground">
                    <Th k="date" label="Dia" sortKey={dailySort.sortKey} sortDir={dailySort.sortDir} onToggle={dailySort.toggle} />
                    <Th k="actions" label="Ações" align="right" sortKey={dailySort.sortKey} sortDir={dailySort.sortDir} onToggle={dailySort.toggle} />
                    <Th k="inShift" label="No horário" align="right" className="text-emerald-700" sortKey={dailySort.sortKey} sortDir={dailySort.sortDir} onToggle={dailySort.toggle} />
                    <Th k="outOfShift" label="Fora horário" align="right" className="text-amber-700" sortKey={dailySort.sortKey} sortDir={dailySort.sortDir} onToggle={dailySort.toggle} />
                    <Th k="scheduled" label="Escalados" align="right" sortKey={dailySort.sortKey} sortDir={dailySort.sortDir} onToggle={dailySort.toggle} />
                    {canSeeCost && <Th k="cost" label="Custo" align="right" sortKey={dailySort.sortKey} sortDir={dailySort.sortDir} onToggle={dailySort.toggle} />}
                    <Th k="km" label="Km" align="right" sortKey={dailySort.sortKey} sortDir={dailySort.sortDir} onToggle={dailySort.toggle} />
                  </tr>
                </thead>
                <tbody>
                  {(dailySort.sorted as any[]).map((d) => (
                    <tr key={d.date} className="border-b hover:bg-muted/30">
                      <td className="py-1.5 px-2 font-mono">{d.date}{data.gpsMissingDays.includes(d.date) && <span className="ml-1 text-[10px] text-amber-700">(GPS provisório)</span>}</td>
                      <td className="py-1.5 px-2 text-right font-semibold tabular-nums">{d.actions}</td>
                      <td className="py-1.5 px-2 text-right text-emerald-700 tabular-nums">{d.inShift}</td>
                      <td className="py-1.5 px-2 text-right text-amber-700 tabular-nums">{d.outOfShift}</td>
                      <td className="py-1.5 px-2 text-right tabular-nums">{d.scheduled}</td>
                      {canSeeCost && <td className="py-1.5 px-2 text-right tabular-nums">{d.cost != null ? fmtEur(d.cost) : "—"}</td>}
                      <td className="py-1.5 px-2 text-right tabular-nums">{d.km > 0 ? `${d.km} km` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quem fez o quê — {single ? startDate : `${startDate} → ${endDate}`}</CardTitle>
          <p className="text-xs text-muted-foreground">
            Clica numa pessoa para ver o dia dela. As ações contam no dia do TURNO (a noite que passa a meia-noite fica no dia em que começou).
            O GPS de um PDA partilhado vai para quem o tinha em cada momento. 🤝 = parceiro/agência · ⚠ = agente por ligar (RH → Agentes) · 📡 = km do PDA sem ninguém com login.
          </p>
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
                    <Th k="inShift" label="No horário" align="right" className="text-emerald-700" sortKey={daySort.sortKey} sortDir={daySort.sortDir} onToggle={daySort.toggle} />
                    <Th k="outOfShift" label="Fora" align="right" className="text-amber-700" sortKey={daySort.sortKey} sortDir={daySort.sortDir} onToggle={daySort.toggle} />
                    {canSeeCost && <Th k="cost" label="Custo" align="right" sortKey={daySort.sortKey} sortDir={daySort.sortDir} onToggle={daySort.toggle} />}
                    {canSeeCost && <Th k="costPerAction" label="€/ação" align="right" sortKey={daySort.sortKey} sortDir={daySort.sortDir} onToggle={daySort.toggle} />}
                    <Th k="totalKm" label="Km" align="right" sortKey={daySort.sortKey} sortDir={daySort.sortDir} onToggle={daySort.toggle} />
                    <Th k="hoursWorked" label="H. movimento" align="right" sortKey={daySort.sortKey} sortDir={daySort.sortDir} onToggle={daySort.toggle} />
                    <Th k="maxSpeed" label="Vel. máx" align="right" sortKey={daySort.sortKey} sortDir={daySort.sortDir} onToggle={daySort.toggle} />
                    <Th k="violations" label="Excessos" align="right" sortKey={daySort.sortKey} sortDir={daySort.sortDir} onToggle={daySort.toggle} />
                    <Th k="pontoHours" label="Ponto" align="right" sortKey={daySort.sortKey} sortDir={daySort.sortDir} onToggle={daySort.toggle} />
                    <Th k="pdaNames" label="PDA" sortKey={daySort.sortKey} sortDir={daySort.sortDir} onToggle={daySort.toggle} />
                  </tr>
                </thead>
                <tbody>
                  {(daySort.sorted as any[]).map((pers) => (
                    <tr
                      key={pers.key}
                      className={`border-b hover:bg-muted/40 cursor-pointer ${pers.kind === "por_ligar" || pers.kind === "sem_login" ? "bg-amber-50/40" : ""}`}
                      onClick={() => setDrawer({ key: pers.key, name: pers.name, employeeId: pers.employeeId, zello: pers.kind === "sem_login" ? pers.key.slice(5) : null })}
                    >
                      <td className="p-2 font-medium">
                        {pers.kind === "parceiro" && "🤝 "}
                        {pers.kind === "por_ligar" && "⚠ "}
                        {pers.kind === "sem_login" && "📡 "}
                        {pers.name}
                        {pers.isTeamLeader && <Badge className="ml-1 bg-amber-100 text-amber-800 border-amber-300 text-[9px]">TL</Badge>}
                      </td>
                      <td className="p-2 text-right text-emerald-700 tabular-nums">{pers.checkins || ""}</td>
                      <td className="p-2 text-right text-blue-700 tabular-nums">{pers.checkouts || ""}</td>
                      <td className="p-2 text-right tabular-nums">{pers.movements || ""}</td>
                      <td className="p-2 text-right text-red-700 tabular-nums">{pers.cancels || ""}</td>
                      <td className="p-2 text-right font-bold tabular-nums">{pers.totalActions || ""}</td>
                      <td className="p-2 text-right text-emerald-700 tabular-nums">{pers.inShift ?? <span className="text-muted-foreground">—</span>}</td>
                      <td className="p-2 text-right text-amber-700 tabular-nums">{pers.outOfShift ?? <span className="text-muted-foreground">—</span>}</td>
                      {canSeeCost && <td className="p-2 text-right tabular-nums">{pers.cost ? fmtEur(pers.cost) : "—"}</td>}
                      {canSeeCost && <td className="p-2 text-right tabular-nums">{pers.costPerAction != null ? fmtEur(pers.costPerAction) : "—"}</td>}
                      <td className="p-2 text-right tabular-nums">
                        {pers.totalKm != null && pers.totalKm > 0 ? `${pers.totalKm} km` : "—"}
                        {pers.provisionalKm && <span className="block text-[10px] text-amber-700">provisório</span>}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {pers.hoursWorked != null && pers.hoursWorked > 0 ? `${pers.hoursWorked}h`
                          : pers.hoursOnline != null && pers.hoursOnline > 0 ? <span className="text-muted-foreground" title="Sem minutos em movimento guardados — tempo com o PDA">{pers.hoursOnline}h c/ PDA</span>
                          : "—"}
                      </td>
                      <td className="p-2 text-right tabular-nums">{pers.maxSpeed != null && pers.maxSpeed > 0 ? `${Math.round(pers.maxSpeed)} km/h` : "—"}</td>
                      <td className={`p-2 text-right tabular-nums ${pers.violations > 0 ? "text-red-700 font-semibold" : ""}`}>{pers.violations || ""}</td>
                      <td className="p-2 text-right tabular-nums">{pers.pontoHours != null ? `${pers.pontoHours}h` : "—"}</td>
                      <td className="p-2 text-xs text-muted-foreground">{pers.pdaNames ?? ""}</td>
                    </tr>
                  ))}
                  {people.length === 0 && <tr><td colSpan={16} className="p-6 text-center text-muted-foreground">Sem atividade registada neste período.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {drawer && (
        <PersonDayDrawer
          person={drawer}
          defaultDate={endDate}
          minDate={startDate}
          maxDate={endDate}
          onClose={() => setDrawer(null)}
          onOpenSpeedHistory={() => {
            const t = drawer.employeeId != null ? { employeeId: drawer.employeeId } : drawer.zello ? { zelloUsername: drawer.zello } : null;
            setDrawer(null);
            if (t) onOpenSpeedHistory(t);
          }}
        />
      )}
    </div>
  );
}

const CHANGE_LABEL: Record<string, string> = {
  CHECK_IN: "Recolha", CHECKIN: "Recolha", CHECK_OUT: "Entrega", CHECKOUT: "Entrega",
  MOVEMENT: "Movimento", CANCELLED: "Cancelamento", CANCELLATION: "Cancelamento", CREATED: "Criada", UPDATE: "Alteração",
};

// Gaveta com o dia de UMA pessoa: ações, GPS (trajeto), PDAs e ponto.
function PersonDayDrawer({ person, defaultDate, minDate, maxDate, onClose, onOpenSpeedHistory }: {
  person: { key: string; name: string; employeeId: number | null; zello: string | null };
  defaultDate: string; minDate: string; maxDate: string;
  onClose: () => void; onOpenSpeedHistory: () => void;
}) {
  const { projectId } = useGlobalFilters();
  const [date, setDate] = useState(defaultDate);
  const clamped = date < minDate ? minDate : date > maxDate ? maxDate : date;
  const { data, isLoading } = trpc.multipark.personDay.useQuery({ date: clamped, key: person.key, projectId }, { refetchOnWindowFocus: false });
  const d = data as any;
  const canSpeed = person.employeeId != null || !!person.zello;
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{person.name}</SheetTitle>
          <SheetDescription>O dia desta pessoa: ações nas reservas, GPS, PDAs e ponto.</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6 space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            {minDate !== maxDate
              ? <Input type="date" className="w-44" value={clamped} min={minDate} max={maxDate} onChange={(e) => setDate(e.target.value)} />
              : <span className="text-sm font-mono">{clamped}</span>}
            {canSpeed && (
              <Button size="sm" variant="outline" onClick={onOpenSpeedHistory}><Gauge className="w-4 h-4 mr-1" />Histórico de velocidade</Button>
            )}
          </div>
          {isLoading || !d ? <p className="text-sm text-muted-foreground">A carregar…</p> : (
            <>
              <section>
                <h3 className="text-sm font-semibold mb-1">Ações ({d.actions.length})</h3>
                {d.actions.length === 0 ? <p className="text-xs text-muted-foreground">Sem ações neste dia.</p> : (
                  <table className="w-full text-xs">
                    <thead><tr className="border-b text-left text-muted-foreground"><th className="p-1">Hora</th><th className="p-1">Ação</th><th className="p-1">Matrícula</th><th className="p-1">Reserva</th><th className="p-1">Parque</th></tr></thead>
                    <tbody>
                      {d.actions.map((a: any, i: number) => (
                        <tr key={i} className="border-b">
                          <td className="p-1 tabular-nums">{fmtPTTime(a.actionTime)}</td>
                          <td className="p-1">{CHANGE_LABEL[a.changeType] ?? a.changeType}</td>
                          <td className="p-1 font-mono">{a.licensePlate ?? ""}</td>
                          <td className="p-1 font-mono">{a.bookingNumber ?? a.bookingExternalId}</td>
                          <td className="p-1 text-muted-foreground">{a.parkName ?? ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
              <section>
                <h3 className="text-sm font-semibold mb-1">GPS</h3>
                {d.gps.length === 0 ? <p className="text-xs text-muted-foreground">Sem GPS recolhido para este dia (a recolha corre {GPS_COLLECTION_TEXT}).</p> : (
                  <table className="w-full text-xs">
                    <thead><tr className="border-b text-left text-muted-foreground"><th className="p-1">Zello</th><th className="p-1 text-right">Km</th><th className="p-1 text-right">Em movimento</th><th className="p-1 text-right">Com PDA</th><th className="p-1 text-right">Vel. máx</th><th className="p-1 text-right">Vel. média</th><th className="p-1 text-right">Excessos</th><th className="p-1">Trajeto</th></tr></thead>
                    <tbody>
                      {d.gps.map((g: any, i: number) => (
                        <tr key={i} className="border-b">
                          <td className="p-1">{g.zelloUsername}{g.src === "parte" && <span className="text-muted-foreground"> (parte do PDA)</span>}</td>
                          <td className="p-1 text-right tabular-nums">{g.km.toFixed(1)}</td>
                          <td className="p-1 text-right tabular-nums">{g.movingMinutes != null ? `${(g.movingMinutes / 60).toFixed(1)}h` : "—"}</td>
                          <td className="p-1 text-right tabular-nums">{g.minutes != null ? `${(g.minutes / 60).toFixed(1)}h` : "—"}</td>
                          <td className="p-1 text-right tabular-nums">{Math.round(g.maxSpeed)} km/h</td>
                          <td className="p-1 text-right tabular-nums">{g.avgSpeed.toFixed(0)} km/h</td>
                          <td className={`p-1 text-right tabular-nums ${g.violations > 0 ? "text-red-700 font-semibold" : ""}`}>{g.violations}</td>
                          <td className="p-1">{g.geoJsonUrl ? <a className="text-primary underline" href={g.geoJsonUrl} target="_blank" rel="noopener">GeoJSON</a> : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
              <section>
                <h3 className="text-sm font-semibold mb-1">PDAs</h3>
                {d.pda.length === 0 ? <p className="text-xs text-muted-foreground">Sem check-in em PDAs neste dia.</p> : (
                  <ul className="text-xs space-y-0.5">
                    {d.pda.map((p: any, i: number) => (
                      <li key={i}><b>{p.pdaName}</b>{p.employeeName ? ` — ${p.employeeName}` : ""}: {fmtPTDateTime(p.checkinAt)} → {p.checkoutAt ? fmtPTDateTime(p.checkoutAt) : "em uso"}</li>
                    ))}
                  </ul>
                )}
              </section>
              {person.employeeId != null && (
                <section>
                  <h3 className="text-sm font-semibold mb-1">Ponto</h3>
                  {d.ponto.length === 0 ? <p className="text-xs text-muted-foreground">Sem picagens neste dia.</p> : (
                    <ul className="text-xs space-y-0.5">
                      {d.ponto.map((t: any, i: number) => (
                        <li key={i} className={t.reviewStatus === "rejected" ? "line-through text-muted-foreground" : ""}>
                          {t.type === "check_in" ? "Entrada" : "Saída"} {fmtPTTime(t.recordedAt)}
                          {t.hoursWorked != null && ` · ${Number(t.hoursWorked).toFixed(2)}h`}
                          {t.zelloKm != null && ` · ${Number(t.zelloKm).toFixed(1)} km (Zello)`}
                          {t.reviewStatus && t.reviewStatus !== "ok" && <Badge variant="outline" className="ml-1 text-[9px]">{t.reviewStatus === "rejected" ? "rejeitado" : t.reviewStatus === "suspicious" ? "suspeito" : "aprovado"}</Badge>}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── HISTÓRICO DIÁRIO (GPS por dia + histórico de velocidade por pessoa) ─────

function DriverHistoryTab({ speedTarget, onSpeedTarget }: { speedTarget: SpeedTarget; onSpeedTarget: (t: SpeedTarget) => void }) {
  const { projectId } = useGlobalFilters();
  const isAdmin = useRoleAtLeast("admin");
  const [selectedDate, setSelectedDate] = usePersistedState("operacional.hist.date", addDays(lisbonToday(), -1));
  const utils = trpc.useUtils();

  const { data: history, isLoading } = trpc.operational.driverHistory.byDate.useQuery({ date: selectedDate, projectId });
  const histSort = useTableSort(((history ?? []) as any[]));
  const { data: stats } = trpc.operational.driverHistory.stats.useQuery({ date: selectedDate, projectId });
  const { data: peopleData } = trpc.operational.driverHistory.people.useQuery({ projectId });
  const threshold = peopleData?.threshold ?? null;

  const [running, setRunning] = useState<null | "collect" | "resplit">(null);
  const collectMut = trpc.operational.driverHistory.collectDay.useMutation();
  const run = async (mode: "collect" | "resplit") => {
    const msg = mode === "collect"
      ? `Recolher do Zello os dados de ${selectedDate}? (continua de onde parou; só faltam os que ainda não foram recolhidos)`
      : `Voltar a partir o GPS de ${selectedDate} por quem tinha cada PDA? Usa os check-ins de PDA atuais (depois de os corrigir). Os km/velocidades não mudam.`;
    if (!confirm(msg)) return;
    setRunning(mode);
    try {
      let afterId: number | undefined;
      let processed = 0;
      for (let round = 0; round < 10; round++) {
        const r = await collectMut.mutateAsync({ date: selectedDate, resplit: mode === "resplit", afterId });
        processed += r.driversProcessed;
        if (r.errors?.length) toast.warning(`${r.errors.length} erro(s): ${r.errors.slice(0, 2).join("; ")}`);
        if (r.done) {
          toast.success(mode === "collect" ? `Recolha concluída: ${processed} motoristas` : `Re-divisão concluída: ${processed} linhas`);
          break;
        }
        afterId = r.nextAfterId ?? undefined;
        toast.info(`Parcial (${processed} até agora) — a continuar…`);
        if (round === 9) toast.warning("Ficou a meio — carrega outra vez para continuar.");
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Erro na recolha");
    } finally {
      setRunning(null);
      utils.operational.driverHistory.invalidate();
      utils.multipark.dayActivity.invalidate();
    }
  };

  return (
    <div className="space-y-4 mt-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <CalendarDays className="w-4 h-4 text-muted-foreground" />
          <UniDateNav date={selectedDate} onChange={setSelectedDate} />
        </div>
        {isAdmin && (
          <>
            <Button variant="outline" onClick={() => run("collect")} disabled={!!running}>
              {running === "collect" ? "A recolher…" : "Recolher Dados"}
            </Button>
            <Button variant="outline" onClick={() => run("resplit")} disabled={!!running} title="Depois de corrigir check-ins de PDA">
              <RefreshCw className="w-4 h-4 mr-1" />{running === "resplit" ? "A dividir…" : "Forçar re-divisão"}
            </Button>
          </>
        )}
        <Button
          variant="outline"
          disabled={!history || history.length === 0}
          onClick={() => {
            if (!history) return;
            const headers = ["Pessoa", "Zello", "Km", "Km sem login", "Horas Mov.", "Horas Parado", "Vel. Méd.", "Vel. Máx.", "Excessos", "Bateria", "Pontos GPS", "Trajeto"];
            const rows = history.map((h: any) => [
              (h.employeeName || h.displayName || h.zelloUsername).replace(/;/g, ","),
              (h.displayName || h.zelloUsername).replace(/;/g, ","),
              parseFloat(h.totalKm || "0").toFixed(1),
              Number(h.leftoverKm ?? 0).toFixed(1),
              parseFloat(h.hoursWorked || "0").toFixed(1),
              parseFloat(h.hoursStopped || "0").toFixed(1),
              parseFloat(h.avgSpeed || "0").toFixed(1),
              parseFloat(h.maxSpeed || "0").toFixed(1),
              h.speedViolations || 0,
              h.avgBattery || 0,
              h.gpsPointsCount || 0,
              h.geoJsonUrl || "",
            ]);
            downloadCsv(`historico_${selectedDate}.csv`, [headers, ...rows]);
          }}
        >
          <ArrowUpDown className="w-4 h-4 mr-1" /> Export CSV
        </Button>
        <p className="text-sm text-muted-foreground">Recolha automática {GPS_COLLECTION_TEXT}, com os dados do dia anterior.</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-7 gap-3">
        <Card><CardContent className="pt-3 pb-2"><p className="text-xs text-muted-foreground">Zellos com GPS</p><p className="text-xl font-bold">{stats?.totalDrivers ?? 0}</p></CardContent></Card>
        <Card><CardContent className="pt-3 pb-2"><p className="text-xs text-muted-foreground">Km Total</p><p className="text-xl font-bold">{(stats?.totalKm ?? 0).toFixed(1)}</p></CardContent></Card>
        <Card><CardContent className="pt-3 pb-2"><p className="text-xs text-muted-foreground">Horas em movimento</p><p className="text-xl font-bold">{(stats?.totalHoursWorked ?? 0).toFixed(1)}h</p></CardContent></Card>
        <Card><CardContent className="pt-3 pb-2"><p className="text-xs text-muted-foreground">Horas Parado</p><p className="text-xl font-bold">{(stats?.totalHoursStopped ?? 0).toFixed(1)}h</p></CardContent></Card>
        <Card><CardContent className="pt-3 pb-2"><p className="text-xs text-muted-foreground">Vel. Máx</p><p className="text-xl font-bold text-red-600">{(stats?.maxSpeedOfDay ?? 0).toFixed(0)} km/h</p></CardContent></Card>
        <Card><CardContent className="pt-3 pb-2"><p className="text-xs text-muted-foreground">Bat. Média</p><p className="text-xl font-bold">{stats?.avgBattery ?? 0}%</p></CardContent></Card>
        <Card><CardContent className="pt-3 pb-2"><p className="text-xs text-muted-foreground">Excessos{threshold ? ` (> ${Math.round(threshold)} km/h)` : ""}</p><p className="text-xl font-bold text-amber-600">{stats?.totalViolations ?? 0}</p></CardContent></Card>
      </div>

      <SpeedHistoryCard target={speedTarget} onTarget={onSpeedTarget} people={peopleData} threshold={threshold} />

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <History className="w-5 h-5" />
            GPS de {selectedDate}
            {history && <Badge variant="outline">{history.length} registos</Badge>}
          </CardTitle>
          <p className="text-xs text-muted-foreground">Clica numa linha para ver o histórico de velocidade dessa pessoa. PDA partilhado: aparecem todas as pessoas que o tiveram e os km sem ninguém com login.</p>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-center text-muted-foreground py-8">A carregar...</p>
          ) : !history || history.length === 0 ? (
            <div className="text-center py-8">
              <History className="w-12 h-12 mx-auto text-muted-foreground/40 mb-3" />
              <p className="text-muted-foreground">Sem dados para esta data.</p>
              {isAdmin && <p className="text-sm text-muted-foreground mt-1">Usa o botão "Recolher Dados" para importar do Zello.</p>}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <Th k="employeeName" label="Pessoa" sortKey={histSort.sortKey} sortDir={histSort.sortDir} onToggle={histSort.toggle} />
                    <Th k="totalKm" label="Km" align="right" sortKey={histSort.sortKey} sortDir={histSort.sortDir} onToggle={histSort.toggle} />
                    <Th k="hoursWorked" label="H. movimento" align="right" sortKey={histSort.sortKey} sortDir={histSort.sortDir} onToggle={histSort.toggle} />
                    <Th k="hoursStopped" label="H. parado" align="right" sortKey={histSort.sortKey} sortDir={histSort.sortDir} onToggle={histSort.toggle} />
                    <Th k="avgSpeed" label="Vel. Média" align="right" sortKey={histSort.sortKey} sortDir={histSort.sortDir} onToggle={histSort.toggle} />
                    <Th k="maxSpeed" label="Vel. Máx" align="right" sortKey={histSort.sortKey} sortDir={histSort.sortDir} onToggle={histSort.toggle} />
                    <Th k="speedViolations" label="Excessos" align="right" sortKey={histSort.sortKey} sortDir={histSort.sortDir} onToggle={histSort.toggle} />
                    <Th k="avgBattery" label="Bateria" align="right" sortKey={histSort.sortKey} sortDir={histSort.sortDir} onToggle={histSort.toggle} />
                    <Th k="gpsPointsCount" label="Pontos GPS" align="right" sortKey={histSort.sortKey} sortDir={histSort.sortDir} onToggle={histSort.toggle} />
                    <th className="p-2">Trajeto</th>
                  </tr>
                </thead>
                <tbody>
                  {(histSort.sorted as any[]).map((h: any) => (
                    <tr
                      key={h.id}
                      className="border-b hover:bg-muted/50 cursor-pointer"
                      onClick={() => onSpeedTarget(h.resolvedEmployeeId != null ? { employeeId: h.resolvedEmployeeId } : { zelloUsername: h.zelloUsername })}
                    >
                      <td className="p-2 font-medium">
                        {h.employeeName || h.displayName || h.zelloUsername}
                        <p className="text-xs text-muted-foreground font-normal">
                          {h.displayName || h.zelloUsername}
                          {h.shares?.length > 1 && ` · ${h.shares.map((s: any) => `${s.name.split(" ")[0]} ${s.km.toFixed(1)} km`).join(", ")}`}
                          {h.leftoverKm > 0.05 && <span className="text-amber-700"> · {h.leftoverKm.toFixed(1)} km sem login</span>}
                        </p>
                      </td>
                      <td className="p-2 text-right font-mono">{parseFloat(h.totalKm || "0").toFixed(1)}</td>
                      <td className="p-2 text-right font-mono">{parseFloat(h.hoursWorked || "0").toFixed(1)}h</td>
                      <td className="p-2 text-right font-mono">{parseFloat(h.hoursStopped || "0").toFixed(1)}h</td>
                      <td className="p-2 text-right font-mono">{parseFloat(h.avgSpeed || "0").toFixed(1)}</td>
                      <td className="p-2 text-right font-mono">
                        <span className={threshold != null && parseFloat(h.maxSpeed || "0") > threshold ? "text-red-600 font-bold" : ""}>{parseFloat(h.maxSpeed || "0").toFixed(1)}</span>
                      </td>
                      <td className="p-2 text-right">{h.speedViolations > 0 ? <Badge variant="destructive">{h.speedViolations}</Badge> : <span className="text-green-600">0</span>}</td>
                      <td className="p-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <div className={`w-2 h-2 rounded-full ${(h.avgBattery || 0) > 50 ? "bg-green-500" : (h.avgBattery || 0) > 20 ? "bg-amber-500" : "bg-red-500"}`} />
                          {h.avgBattery || 0}%
                        </div>
                      </td>
                      <td className="p-2 text-right text-muted-foreground">{h.gpsPointsCount || 0}</td>
                      <td className="p-2" onClick={(e) => e.stopPropagation()}>
                        {h.geoJsonUrl && (
                          <Button size="sm" variant="outline" asChild>
                            <a href={h.geoJsonUrl} target="_blank" rel="noopener" title="Trajeto (GeoJSON)"><Route className="w-3 h-3" /></a>
                          </Button>
                        )}
                      </td>
                    </tr>
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

function downloadCsv(filename: string, rows: (string | number)[][]) {
  const csv = rows.map((r) => r.join(";")).join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// Histórico de velocidade de UMA pessoa: últimos 30/90 dias — gráfico da
// máxima e da média em movimento (com o limite dos excessos) + tabela.
function SpeedHistoryCard({ target, onTarget, people, threshold }: {
  target: SpeedTarget; onTarget: (t: SpeedTarget) => void;
  people: { employees: { id: number; name: string }[]; zellos: { zelloUsername: string; name: string }[] } | undefined;
  threshold: number | null;
}) {
  const { projectId } = useGlobalFilters();
  const [days, setDays] = usePersistedState<number>("operacional.hist.days", 30);
  const value = target?.employeeId != null ? `e:${target.employeeId}` : target?.zelloUsername ? `z:${target.zelloUsername}` : "";
  const options = useMemo(() => [
    ...(people?.employees ?? []).map((e) => ({ value: `e:${e.id}`, label: e.name })),
    ...(people?.zellos ?? []).map((z) => ({ value: `z:${z.zelloUsername}`, label: `📡 ${z.name} (sem login)` })),
  ], [people]);
  const { data, isLoading } = trpc.operational.driverHistory.personHistory.useQuery(
    { employeeId: target?.employeeId, zelloUsername: target?.zelloUsername, days, projectId },
    { enabled: !!target, refetchOnWindowFocus: false },
  );
  const rows = (data?.days ?? []) as any[];
  const chartData = useMemo(() => [...rows].reverse().map((r) => ({ date: r.date.slice(5), max: r.maxSpeed, avg: r.avgSpeed })), [rows]);
  const lim = data?.threshold ?? threshold;
  useEffect(() => {
    if (target) document.getElementById("speed-history-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [target]);

  return (
    <Card id="speed-history-card">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><Gauge className="w-4 h-4" />Histórico de velocidade por pessoa</CardTitle>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <SearchableSelect
            className="w-72"
            value={value}
            onChange={(v) => onTarget(!v ? null : v.startsWith("e:") ? { employeeId: Number(v.slice(2)) } : { zelloUsername: v.slice(2) })}
            options={options}
            placeholder="Escolher pessoa…"
            searchPlaceholder="Pesquisar por nome…"
            emptyText="Sem GPS nos últimos 90 dias"
          />
          {[30, 90].map((n) => (
            <Button key={n} size="sm" variant={days === n ? "default" : "outline"} onClick={() => setDays(n)}>{n} dias</Button>
          ))}
          {rows.length > 0 && (
            <Button size="sm" variant="outline" onClick={() => downloadCsv(`velocidade_${(data?.name ?? "pessoa").replace(/\s+/g, "_")}_${days}d.csv`, [
              ["Dia", "Km", "Vel. máx (km/h)", "Vel. média em movimento (km/h)", "Horas em movimento", "Excessos", "Trajetos"],
              ...rows.map((r) => [r.date, r.km.toFixed(1), r.maxSpeed, r.avgSpeed, r.hoursMoving ?? "", r.violations, r.tracks.join(" ")]),
            ])}>
              <ArrowUpDown className="w-4 h-4 mr-1" />CSV
            </Button>
          )}
          {lim != null && <span className="text-xs text-muted-foreground">Excesso = acima de {Math.round(lim)} km/h (limite padrão + tolerância)</span>}
        </div>
      </CardHeader>
      <CardContent>
        {!target ? (
          <p className="text-sm text-muted-foreground">Escolhe uma pessoa (ou clica numa linha da Atividade do Dia / da tabela abaixo) para ver como anda ao longo dos dias.</p>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">A carregar…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sem GPS para {data?.name ?? "esta pessoa"} nos últimos {days} dias.</p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm font-medium">{data?.name}</p>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 0, left: -8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
                  <YAxis unit=" km/h" tick={{ fontSize: 11 }} width={72} stroke="var(--muted-foreground)" />
                  <Tooltip formatter={(v: any, n: any) => [`${v} km/h`, n]} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {lim != null && <ReferenceLine y={Math.round(lim)} stroke="var(--muted-foreground)" strokeDasharray="4 4" label={{ value: `limite ${Math.round(lim)}`, position: "insideTopRight", fontSize: 11, fill: "var(--muted-foreground)" }} />}
                  <Line type="monotone" dataKey="max" name="Vel. máxima" stroke="var(--chart-1)" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                  <Line type="monotone" dataKey="avg" name="Média em movimento" stroke="#d97706" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="p-2">Dia</th><th className="p-2 text-right">Km</th><th className="p-2 text-right">Vel. máx</th><th className="p-2 text-right">Média em mov.</th>
                    <th className="p-2 text-right">H. movimento</th><th className="p-2 text-right">Excessos</th><th className="p-2">Trajeto</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.date} className="border-b">
                      <td className="p-2 font-mono">{r.date}</td>
                      <td className="p-2 text-right tabular-nums">{r.km.toFixed(1)}</td>
                      <td className={`p-2 text-right tabular-nums ${lim != null && r.maxSpeed > lim ? "text-red-600 font-semibold" : ""}`}>{Math.round(r.maxSpeed)} km/h</td>
                      <td className="p-2 text-right tabular-nums">{r.avgSpeed ? `${Math.round(r.avgSpeed)} km/h` : "—"}</td>
                      <td className="p-2 text-right tabular-nums">{r.hoursMoving != null ? `${r.hoursMoving}h` : "—"}</td>
                      <td className={`p-2 text-right tabular-nums ${r.violations > 0 ? "text-red-700 font-semibold" : ""}`}>{r.violations}</td>
                      <td className="p-2 text-xs">{r.tracks.map((t: string, i: number) => <a key={t} href={t} target="_blank" rel="noopener" className="text-primary underline mr-1">{r.tracks.length > 1 ? `#${i + 1}` : "GeoJSON"}</a>)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── PDAs TAB ───────────────────────────────────────────────────────────────

// "Este aparelho": regista o browser do próprio PDA — a partir daí, quem picar
// o ponto neste aparelho fica automaticamente ligado ao PDA/Zello (e a app
// troca sozinha quando entra outro). Pedido do Jorge 2026-08-06.
function ThisDeviceCard({ pdaList, canRegister }: { pdaList: any[]; canRegister: boolean }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem("mp.pda.deviceToken"));
  const [selPda, setSelPda] = useState("");
  const { data: deviceInfo, isLoading } = trpc.operational.pdas.deviceInfo.useQuery(
    { token: token ?? "" },
    { enabled: !!token }
  );
  const register = trpc.operational.pdas.registerDevice.useMutation({
    onSuccess: (d) => {
      localStorage.setItem("mp.pda.deviceToken", d.token);
      setToken(d.token);
      toast.success("Este aparelho ficou registado! A partir de agora, quem picar o ponto aqui fica logo com este PDA/Zello.");
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Card className={token && deviceInfo ? "border-green-300" : "border-dashed"}>
      <CardContent className="p-4">
        {token && deviceInfo ? (
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <Smartphone className="w-5 h-5 text-green-600" />
              <div>
                <p className="text-sm font-semibold">Este aparelho é o {deviceInfo.name}</p>
                <p className="text-xs text-muted-foreground">
                  {deviceInfo.zelloUsername ? `Zello: ${deviceInfo.zelloUsername} · ` : ""}
                  {deviceInfo.currentHolder ? `agora com: ${deviceInfo.currentHolder}` : "livre — o próximo check-in do ponto fica com ele"}
                </p>
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={() => { localStorage.removeItem("mp.pda.deviceToken"); setToken(null); toast.info("Aparelho desregistado neste browser."); }}>
              Desregistar
            </Button>
          </div>
        ) : token && !isLoading && !deviceInfo ? (
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-sm text-amber-700">O registo deste aparelho já não é válido (o PDA foi re-registado noutro browser?).</p>
            <Button size="sm" variant="outline" onClick={() => { localStorage.removeItem("mp.pda.deviceToken"); setToken(null); }}>Limpar</Button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Smartphone className="w-5 h-5 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">Registar um PDA: lê o QR colado no aparelho</p>
                <p className="text-xs text-muted-foreground">
                  Uma chefia lê o QR (botão <QrCode className="inline w-3 h-3" /> em cada PDA) <b>no próprio aparelho</b>, uma vez. Depois, quem entrar nele fica com o PDA/Zello.
                </p>
              </div>
            </div>
            {canRegister && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">Sem QR à mão? Registar este aparelho pela lista (recurso)</summary>
                <div className="flex items-center gap-2 mt-2">
                  <Select value={selPda} onValueChange={setSelPda}>
                    <SelectTrigger className="w-44"><SelectValue placeholder="Escolher PDA" /></SelectTrigger>
                    <SelectContent>
                      {pdaList.filter((p: any) => p.status === "active").map((p: any) => (
                        <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button size="sm" variant="outline" disabled={!selPda || register.isPending} onClick={() => register.mutate({ pdaId: Number(selPda) })}>
                    Registar este aparelho
                  </Button>
                </div>
              </details>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PdasTab() {
  // Escrita: criar/editar/QR = team_leader+ (como o servidor); eliminar = admin.
  const canManage = useRoleAtLeast("team_leader");
  const canDelete = useRoleAtLeast("admin");
  const [manualPda, setManualPda] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [showCheckin, setShowCheckin] = useState<number | null>(null);
  const [editPda, setEditPda] = useState<any | null>(null);
  const [viewPda, setViewPda] = useState<number | null>(null);
  const [qrPda, setQrPda] = useState<{ id: number; name: string } | null>(null);
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

      {canManage && (
        <div className="flex items-center gap-3">
          <Button onClick={() => setShowCreate(true)}><Plus className="w-4 h-4 mr-1" />Novo PDA</Button>
        </div>
      )}

      {/* Este aparelho: ponto→PDA automático (QR é o caminho principal) */}
      <ThisDeviceCard pdaList={pdaList || []} canRegister={canManage} />

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
                    {checkin && (
                      <CheckoutButton checkinId={checkin.id} pdaName={pda.name} />
                    )}
                    {canManage && (
                      <Button size="sm" variant="outline" title="Editar" onClick={() => setEditPda(pda)}>
                        <Settings className="w-3 h-3" />
                      </Button>
                    )}
                    {canManage && (
                      <Button size="sm" variant="outline" title="QR para colar no aparelho" onClick={() => setQrPda({ id: pda.id, name: pda.name })}>
                        <QrCode className="w-3 h-3" />
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => setViewPda(pda.id)}>
                      <Eye className="w-3 h-3" />
                    </Button>
                    {canDelete && (
                      <Button size="sm" variant="ghost" className="text-red-600" title="Eliminar" onClick={() => {
                        if (confirm(`Eliminar PDA ${pda.name}?`)) deleteMut.mutate({ id: pda.id });
                      }}>
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Check-in manual: só quando o login no PDA (QR) não funcionou */}
      {pdaList && pdaList.length > 0 && (
        <details className="rounded-lg border p-3 text-sm">
          <summary className="cursor-pointer font-medium">Check-in manual (recurso)</summary>
          <p className="text-xs text-muted-foreground mt-1">O normal é a pessoa entrar no PDA registado (fica logo com ele). Usa isto só quando isso falhou.</p>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <Select value={manualPda} onValueChange={setManualPda}>
              <SelectTrigger className="w-48"><SelectValue placeholder="Escolher PDA livre" /></SelectTrigger>
              <SelectContent>
                {pdaList.filter((p: any) => p.status === "active" && !checkinByPda.has(p.id)).map((p: any) => (
                  <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" disabled={!manualPda} onClick={() => setShowCheckin(Number(manualPda))}>
              <Camera className="w-3 h-3 mr-1" />Check-in manual
            </Button>
          </div>
        </details>
      )}

      {/* Dialogs */}
      {showCreate && <CreatePdaDialog onClose={() => setShowCreate(false)} />}
      {editPda && <EditPdaDialog pda={editPda} onClose={() => setEditPda(null)} />}
      {showCheckin !== null && <CheckinDialog pdaId={showCheckin} onClose={() => setShowCheckin(null)} />}
      {viewPda !== null && <PdaHistoryDialog pdaId={viewPda} onClose={() => setViewPda(null)} />}
      {qrPda && <PdaQrDialog pda={qrPda} onClose={() => setQrPda(null)} />}
    </div>
  );
}

// QR para imprimir e colar no PDA (Fase 2): lido no próprio aparelho, regista-o
// como este PDA; depois quem faz login nele fica com o PDA/Zello até sair.
function PdaQrDialog({ pda, onClose }: { pda: { id: number; name: string }; onClose: () => void }) {
  const { data, error } = trpc.operational.pdas.qrLink.useQuery({ pdaId: pda.id });
  const [img, setImg] = useState<string | null>(null);
  const url = data ? `${window.location.origin}${data.path}` : null;
  useEffect(() => {
    if (!url) return;
    QRCodeLib.toDataURL(url, { width: 320, margin: 2 }).then(setImg).catch(() => setImg(null));
  }, [url]);
  const print = () => {
    if (!img) return;
    const name = pda.name.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
    const w = window.open("", "_blank", "width=420,height=560");
    if (!w) return;
    w.document.write(`<html><head><title>${name}</title></head><body style="font-family:sans-serif;text-align:center;padding:24px">
      <h2 style="margin:0 0 8px">${name}</h2><img src="${img}" style="width:280px;height:280px"/>
      <p style="font-size:12px;color:#555">Ler com este aparelho para o registar como ${name}.</p></body></html>`);
    w.document.close();
    w.focus();
    w.print();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>QR do {pda.name}</DialogTitle></DialogHeader>
        <div className="text-center space-y-3">
          {error ? <p className="text-sm text-red-600">{error.message}</p> : img ? <img src={img} alt={`QR ${pda.name}`} className="mx-auto w-64 h-64" /> : <p className="text-sm text-muted-foreground">A gerar…</p>}
          <p className="text-xs text-muted-foreground">
            Imprime e cola no aparelho. Uma chefia lê o QR <b>no próprio PDA</b> (uma vez) e fica registado.
            Depois, quem fizer login nele fica com o PDA e o Zello até sair ou entrar outra pessoa.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Fechar</Button>
          <Button onClick={print} disabled={!img}>Imprimir</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  // Lista longa → combobox com pesquisa (mesmo componente do RH/Zello).
  const employeeOptions = useMemo(
    () => (employees || []).map((e: any) => ({ value: String(e.employee.id), label: e.employee.fullName })),
    [employees],
  );
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
            <SearchableSelect
              className="w-full"
              value={employeeId}
              onChange={setEmployeeId}
              options={employeeOptions}
              placeholder="Escolher funcionário..."
              searchPlaceholder="Pesquisar por nome…"
              emptyText="Nenhum funcionário com esse nome"
            />
            {!employeeId && <p className="text-xs text-muted-foreground mt-1">Obrigatório — o histórico de atividade fica associado a esta pessoa.</p>}
          </div>
          <div>
            <Label>Dados Móveis (MB no início)</Label>
            <Input type="number" value={mobileDataMbStart} onChange={e => setMobileDataMbStart(e.target.value)} placeholder="Ex: 2500" />
          </div>
          <div>
            <Label>Foto de Entrada *</Label>
            <div className="flex items-center gap-2">
              <label className="cursor-pointer">
                <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handlePhotoCapture} />
                <Button variant="outline" asChild><span><Camera className="w-4 h-4 mr-1" />{uploading ? "A carregar..." : photoEntryUrl ? "Repetir Foto" : "Tirar Foto"}</span></Button>
              </label>
              {photoEntryUrl && <Badge variant="outline" className="text-green-600">Foto OK</Badge>}
            </div>
            {/* Obrigatória (Jorge, 2026-09-09) — o servidor também recusa sem foto. */}
            {!photoEntryUrl && !uploading && <p className="text-xs text-muted-foreground mt-1">Obrigatório — fotografa o PDA para registar o estado à entrada.</p>}
          </div>
          <div>
            <Label>Notas</Label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Observações..." />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={checkinMut.isPending || uploading || !employeeId || employeeId === "none" || !photoEntryUrl} onClick={() => checkinMut.mutate({
            pdaId,
            zelloUsername: zelloUsername || undefined,
            employeeId: Number(employeeId),
            photoEntryUrl,
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

