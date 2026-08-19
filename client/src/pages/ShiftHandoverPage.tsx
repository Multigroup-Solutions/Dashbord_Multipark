import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { UniDateNav } from "@/components/DateRangeNav";
import { useAuth } from "@/_core/hooks/useAuth";
import { usePersistedState } from "@/hooks/usePersistedState";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { ClipboardCheck, History, BarChart3, Loader2, Sun, Moon, CheckCircle2, XCircle, AlertTriangle, Clock } from "lucide-react";
import { useTableSort, Th } from "@/components/SortableTable";
import { fmtPTDate } from "@/lib/lisbonTime";

// ─── PASSAGEM DE TURNO (pedido do Jorge, 2026-08-06) ─────────────────────────
// Os team leaders preenchem o checklist no fim do turno; o supervisor consulta
// o histórico e tem um dashboard do dia (condutores, carros, tempos, atrasos).

const ROLE_H: Record<string, number> = { user: 0, extra: 1, frontoffice: 2, backoffice: 3, team_leader: 4, supervisor: 5, admin: 6, super_admin: 7 };
const CITY_LABELS: Record<string, string> = { lisbon: "Lisboa", porto: "Porto", faro: "Faro" };

function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function ShiftHandoverPage() {
  const { user } = useAuth();
  const isSupervisor = (ROLE_H[user?.role ?? ""] ?? 0) >= ROLE_H["supervisor"];
  const [tab, setTab] = usePersistedState("handover.tab", "preencher");

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <p className="text-muted-foreground text-sm">Checklist de fim de turno (team leaders) e visão do dia (supervisão)</p>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="preencher"><ClipboardCheck className="w-4 h-4 mr-1" />Preencher</TabsTrigger>
          <TabsTrigger value="historico"><History className="w-4 h-4 mr-1" />Histórico</TabsTrigger>
          {isSupervisor && <TabsTrigger value="dashboard"><BarChart3 className="w-4 h-4 mr-1" />Dashboard do Dia</TabsTrigger>}
        </TabsList>
        <TabsContent value="preencher"><HandoverForm /></TabsContent>
        <TabsContent value="historico"><HandoverHistory /></TabsContent>
        {isSupervisor && <TabsContent value="dashboard"><SupervisorDashboard /></TabsContent>}
      </Tabs>
    </div>
  );
}

// ─── FORMULÁRIO ──────────────────────────────────────────────────────────────
function HandoverForm() {
  const utils = trpc.useUtils();
  const [date, setDate] = useState(todayISO());
  const [shift, setShift] = usePersistedState<"morning" | "night">("handover.shift", "morning");
  const [city, setCity] = usePersistedState<"lisbon" | "porto" | "faro">("handover.city", "lisbon");

  const empty = {
    carsForCovered: "", chargedUntilDate: "", cashClosedInSafe: null as boolean | null,
    checkoutCashDone: null as boolean | null, frontPouchValue: "", terminalPouchValue: "",
    ticketsExpensesPaid: "", mbRolls: "", mbRollsInPouch: "", pensInPouch: "",
    mbBattery: "", pdasCharged: null as boolean | null, uniformsCount: "", notes: "",
  };
  const [f, setF] = useState(empty);

  // Carrega o registo existente do (dia, turno, cidade) para editar
  const existingQ = trpc.shiftHandover.list.useQuery({ from: date, to: date, city });
  const existing = (existingQ.data ?? []).find((h: any) => h.shift === shift);
  useEffect(() => {
    if (existing) {
      setF({
        carsForCovered: existing.carsForCovered != null ? String(existing.carsForCovered) : "",
        chargedUntilDate: existing.chargedUntilDate ?? "",
        cashClosedInSafe: existing.cashClosedInSafe == null ? null : !!existing.cashClosedInSafe,
        checkoutCashDone: existing.checkoutCashDone == null ? null : !!existing.checkoutCashDone,
        frontPouchValue: existing.frontPouchValue != null ? String(existing.frontPouchValue) : "",
        terminalPouchValue: existing.terminalPouchValue != null ? String(existing.terminalPouchValue) : "",
        ticketsExpensesPaid: existing.ticketsExpensesPaid != null ? String(existing.ticketsExpensesPaid) : "",
        mbRolls: existing.mbRolls != null ? String(existing.mbRolls) : "",
        mbRollsInPouch: existing.mbRollsInPouch != null ? String(existing.mbRollsInPouch) : "",
        pensInPouch: existing.pensInPouch != null ? String(existing.pensInPouch) : "",
        mbBattery: existing.mbBattery != null ? String(existing.mbBattery) : "",
        pdasCharged: existing.pdasCharged == null ? null : !!existing.pdasCharged,
        uniformsCount: existing.uniformsCount != null ? String(existing.uniformsCount) : "",
        notes: existing.notes ?? "",
      });
    } else {
      setF(empty);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing?.id, date, shift, city]);

  const save = trpc.shiftHandover.save.useMutation({
    onSuccess: () => { utils.shiftHandover.list.invalidate(); toast.success("Passagem de turno guardada"); },
    onError: (e) => toast.error(e.message),
  });

  const num = (v: string) => (v.trim() === "" ? null : Number(v.replace(",", ".")));
  const intOrNull = (v: string) => (v.trim() === "" ? null : parseInt(v));

  const YesNo = ({ value, onChange, label }: { value: boolean | null; onChange: (v: boolean) => void; label: string }) => (
    <div className="flex items-center justify-between gap-2 border rounded-lg p-2.5">
      <span className="text-sm">{label}</span>
      <div className="flex gap-1">
        <Button type="button" size="sm" variant={value === true ? "default" : "outline"} className="h-7 px-2.5" onClick={() => onChange(true)}>Sim</Button>
        <Button type="button" size="sm" variant={value === false ? "destructive" : "outline"} className="h-7 px-2.5" onClick={() => onChange(false)}>Não</Button>
      </div>
    </div>
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-end gap-3">
          <div><Label className="text-xs mb-1 block">Dia</Label><UniDateNav date={date} onChange={setDate} /></div>
          <div>
            <Label className="text-xs mb-1 block">Turno</Label>
            <div className="flex gap-1">
              <Button type="button" size="sm" variant={shift === "morning" ? "default" : "outline"} onClick={() => setShift("morning")}><Sun className="w-3.5 h-3.5 mr-1" />Manhã</Button>
              <Button type="button" size="sm" variant={shift === "night" ? "default" : "outline"} onClick={() => setShift("night")}><Moon className="w-3.5 h-3.5 mr-1" />Noite</Button>
            </div>
          </div>
          <div>
            <Label className="text-xs mb-1 block">Cidade</Label>
            <Select value={city} onValueChange={(v) => setCity(v as any)}>
              <SelectTrigger className="w-32 h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="lisbon">📍 Lisboa</SelectItem>
                <SelectItem value="porto">📍 Porto</SelectItem>
                <SelectItem value="faro">📍 Faro</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {existing && <Badge variant="outline" className="mb-1">já preenchida por {existing.filledByName ?? "?"} — a editar</Badge>}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Operação */}
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Operação</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div><Label className="text-xs">Carros p/ coberto</Label><Input type="number" min={0} value={f.carsForCovered} onChange={(e) => setF({ ...f, carsForCovered: e.target.value })} /></div>
          <div><Label className="text-xs">Carregamentos feitos até (dia)</Label><Input type="date" value={f.chargedUntilDate} onChange={(e) => setF({ ...f, chargedUntilDate: e.target.value })} /></div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <YesNo label="Fecho de caixa no cofre" value={f.cashClosedInSafe} onChange={(v) => setF({ ...f, cashClosedInSafe: v })} />
          <YesNo label="Caixa de check-out feita" value={f.checkoutCashDone} onChange={(v) => setF({ ...f, checkoutCashDone: v })} />
        </div>

        {/* Valores */}
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Valores</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div><Label className="text-xs">Valor bolsa do front (€)</Label><Input type="number" step="0.01" min={0} value={f.frontPouchValue} onChange={(e) => setF({ ...f, frontPouchValue: e.target.value })} /></div>
          <div><Label className="text-xs">Valor bolsa terminal (€)</Label><Input type="number" step="0.01" min={0} value={f.terminalPouchValue} onChange={(e) => setF({ ...f, terminalPouchValue: e.target.value })} /></div>
          <div><Label className="text-xs">Tickets/despesas pagos no dia (€)</Label><Input type="number" step="0.01" min={0} value={f.ticketsExpensesPaid} onChange={(e) => setF({ ...f, ticketsExpensesPaid: e.target.value })} /></div>
        </div>

        {/* Material */}
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Material</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div><Label className="text-xs">Rolos de MB</Label><Input type="number" min={0} value={f.mbRolls} onChange={(e) => setF({ ...f, mbRolls: e.target.value })} /></div>
          <div><Label className="text-xs">Rolos MB na bolsa do terminal</Label><Input type="number" min={0} value={f.mbRollsInPouch} onChange={(e) => setF({ ...f, mbRollsInPouch: e.target.value })} /></div>
          <div><Label className="text-xs">Canetas na bolsa do terminal</Label><Input type="number" min={0} value={f.pensInPouch} onChange={(e) => setF({ ...f, pensInPouch: e.target.value })} /></div>
          <div><Label className="text-xs">Bateria do MB (%)</Label><Input type="number" min={0} max={100} value={f.mbBattery} onChange={(e) => setF({ ...f, mbBattery: e.target.value })} /></div>
          <div><Label className="text-xs">Número de fardas</Label><Input type="number" min={0} value={f.uniformsCount} onChange={(e) => setF({ ...f, uniformsCount: e.target.value })} /></div>
        </div>
        <YesNo label="PDAs carregados a 100%" value={f.pdasCharged} onChange={(v) => setF({ ...f, pdasCharged: v })} />

        {/* Notas */}
        <div>
          <Label className="text-xs">Observações / notas</Label>
          <Textarea rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Tudo o que o turno seguinte precisa de saber…" />
        </div>

        <Button
          className="w-full gap-2"
          disabled={save.isPending}
          onClick={() => save.mutate({
            handoverDate: date, shift, city,
            carsForCovered: intOrNull(f.carsForCovered),
            chargedUntilDate: f.chargedUntilDate || null,
            cashClosedInSafe: f.cashClosedInSafe,
            checkoutCashDone: f.checkoutCashDone,
            frontPouchValue: num(f.frontPouchValue),
            terminalPouchValue: num(f.terminalPouchValue),
            ticketsExpensesPaid: num(f.ticketsExpensesPaid),
            mbRolls: intOrNull(f.mbRolls),
            mbRollsInPouch: intOrNull(f.mbRollsInPouch),
            pensInPouch: intOrNull(f.pensInPouch),
            mbBattery: intOrNull(f.mbBattery),
            pdasCharged: f.pdasCharged,
            uniformsCount: intOrNull(f.uniformsCount),
            notes: f.notes || null,
          })}
        >
          {save.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
          {existing ? "Atualizar passagem de turno" : "Guardar passagem de turno"}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── HISTÓRICO ───────────────────────────────────────────────────────────────
function HandoverHistory() {
  const [days, setDays] = useState(14);
  const from = (() => { const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString().slice(0, 10); })();
  const { data = [], isLoading } = trpc.shiftHandover.list.useQuery({ from });
  const YN = ({ v }: { v: any }) => v == null ? <span className="text-muted-foreground">—</span> : v ? <CheckCircle2 className="w-4 h-4 text-green-600 inline" /> : <XCircle className="w-4 h-4 text-red-600 inline" />;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Label className="text-xs">Últimos</Label>
        <Select value={String(days)} onValueChange={(v) => setDays(parseInt(v))}>
          <SelectTrigger className="w-28 h-8"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[7, 14, 30, 60].map((n) => <SelectItem key={n} value={String(n)}>{n} dias</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {isLoading ? <p className="text-sm text-muted-foreground">A carregar…</p> : data.length === 0 ? (
        <Card><CardContent className="p-8 text-center text-muted-foreground">Sem passagens de turno registadas neste período</CardContent></Card>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[900px]">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="p-2">Dia</th>
                <th className="p-2">Turno</th>
                <th className="p-2">Cidade</th>
                <th className="p-2 text-right">Coberto</th>
                <th className="p-2 text-center">Cofre</th>
                <th className="p-2 text-center">Caixa CO</th>
                <th className="p-2 text-right">Bolsa front</th>
                <th className="p-2 text-right">Bolsa term.</th>
                <th className="p-2 text-right">Rolos</th>
                <th className="p-2 text-right">Bat. MB</th>
                <th className="p-2 text-center">PDAs 100%</th>
                <th className="p-2">Preenchido por</th>
                <th className="p-2">Notas</th>
              </tr>
            </thead>
            <tbody>
              {data.map((h: any) => (
                <tr key={h.id} className="border-b hover:bg-muted/30">
                  <td className="p-2 font-mono text-xs">{h.handoverDate}</td>
                  <td className="p-2">{h.shift === "morning" ? "☀️ Manhã" : "🌙 Noite"}</td>
                  <td className="p-2 text-xs">{CITY_LABELS[h.city] ?? h.city}</td>
                  <td className="p-2 text-right tabular-nums">{h.carsForCovered ?? "—"}</td>
                  <td className="p-2 text-center"><YN v={h.cashClosedInSafe} /></td>
                  <td className="p-2 text-center"><YN v={h.checkoutCashDone} /></td>
                  <td className="p-2 text-right tabular-nums">{h.frontPouchValue != null ? `${Number(h.frontPouchValue).toFixed(2)}€` : "—"}</td>
                  <td className="p-2 text-right tabular-nums">{h.terminalPouchValue != null ? `${Number(h.terminalPouchValue).toFixed(2)}€` : "—"}</td>
                  <td className="p-2 text-right tabular-nums">{h.mbRolls ?? "—"}{h.mbRollsInPouch != null ? ` (+${h.mbRollsInPouch})` : ""}</td>
                  <td className="p-2 text-right tabular-nums">{h.mbBattery != null ? `${h.mbBattery}%` : "—"}</td>
                  <td className="p-2 text-center"><YN v={h.pdasCharged} /></td>
                  <td className="p-2 text-xs">{h.filledByName ?? "—"}</td>
                  <td className="p-2 text-xs text-muted-foreground max-w-[200px] truncate" title={h.notes ?? ""}>{h.notes ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── DASHBOARD DO DIA (supervisor+) ─────────────────────────────────────────
function SupervisorDashboard() {
  const [date, setDate] = useState(todayISO());
  const { data, isLoading } = trpc.shiftHandover.supervisorDashboard.useQuery({ date });
  const peopleSort = useTableSort((data?.people ?? []) as any[]);

  const shiftOf = (employeeId: number | null, name: string) => {
    const a = (data?.shifts ?? []).find((s: any) =>
      (employeeId != null && s.employeeId === employeeId) ||
      s.personName?.toLowerCase() === name.toLowerCase());
    return a ? (a.shift === "morning" ? "☀️" : "🌙") : "";
  };

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2">
        <div><Label className="text-xs mb-1 block">Dia</Label><UniDateNav date={date} onChange={setDate} /></div>
      </div>
      {isLoading || !data ? <p className="text-sm text-muted-foreground">A carregar…</p> : (
        <>
          {/* KPIs do dia */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <Card className="p-3"><p className="text-xs text-muted-foreground">Recolhas</p><p className="text-xl font-bold text-emerald-700">{data.totals.checkins}</p></Card>
            <Card className="p-3"><p className="text-xs text-muted-foreground">Entregas</p><p className="text-xl font-bold text-blue-700">{data.totals.checkouts}</p></Card>
            <Card className="p-3">
              <p className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" />Pendente→Entrega</p>
              <p className="text-xl font-bold">{data.delivery.avgMins} min</p>
              <p className="text-[10px] text-muted-foreground">máx {data.delivery.maxMins} · {data.delivery.count} medidas</p>
            </Card>
            <Card className={`p-3 ${data.delivery.over30 > 0 ? "border-red-300 bg-red-50/50" : ""}`}>
              <p className="text-xs text-muted-foreground">Entregas &gt;15/&gt;30 min</p>
              <p className="text-xl font-bold"><span className="text-amber-700">{data.delivery.over15}</span> / <span className="text-red-700">{data.delivery.over30}</span></p>
            </Card>
            <Card className="p-3">
              <p className="text-xs text-muted-foreground">Recolhas atrasadas &gt;15min</p>
              <p className="text-xl font-bold text-amber-700">{data.pickup.over15}</p>
              <p className="text-[10px] text-muted-foreground">desvio médio {data.pickup.avgDelayMins} min</p>
            </Card>
            <Card className={`p-3 ${data.complaintsToday > 0 ? "border-amber-300 bg-amber-50/50" : ""}`}>
              <p className="text-xs text-muted-foreground flex items-center gap-1"><AlertTriangle className="w-3 h-3" />Reclamações hoje</p>
              <p className="text-xl font-bold">{data.complaintsToday}</p>
            </Card>
          </div>

          {/* Piores entregas */}
          {data.delivery.worst.length > 0 && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Entregas mais lentas do dia (pendente → entregue)</CardTitle></CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {data.delivery.worst.map((w: any) => (
                  <Badge key={w.booking} variant="outline" className={`text-xs ${w.mins > 30 ? "border-red-300 text-red-700" : w.mins > 15 ? "border-amber-300 text-amber-700" : ""}`}>
                    {w.mins} min{w.agent ? ` · ${w.agent}` : ""}
                  </Badge>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Condutores do dia */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Quem trabalhou — {fmtPTDate(date)}</CardTitle></CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <Th k="name" label="Pessoa" sortKey={peopleSort.sortKey} sortDir={peopleSort.sortDir} onToggle={peopleSort.toggle} />
                      <th className="p-2">Turno</th>
                      <Th k="checkins" label="Recolhas" align="right" sortKey={peopleSort.sortKey} sortDir={peopleSort.sortDir} onToggle={peopleSort.toggle} />
                      <Th k="checkouts" label="Entregas" align="right" sortKey={peopleSort.sortKey} sortDir={peopleSort.sortDir} onToggle={peopleSort.toggle} />
                      <Th k="movements" label="Movs" align="right" sortKey={peopleSort.sortKey} sortDir={peopleSort.sortDir} onToggle={peopleSort.toggle} />
                      <Th k="totalActions" label="Total" align="right" className="font-bold" sortKey={peopleSort.sortKey} sortDir={peopleSort.sortDir} onToggle={peopleSort.toggle} />
                      <Th k="totalKm" label="Km" align="right" sortKey={peopleSort.sortKey} sortDir={peopleSort.sortDir} onToggle={peopleSort.toggle} />
                    </tr>
                  </thead>
                  <tbody>
                    {(peopleSort.sorted as any[]).map((p) => (
                      <tr key={p.key} className="border-b hover:bg-muted/30">
                        <td className="p-2 font-medium">{p.kind === "parceiro" ? "🤝 " : p.kind === "por_ligar" ? "⚠ " : ""}{p.name}</td>
                        <td className="p-2">{shiftOf(p.employeeId, p.name)}</td>
                        <td className="p-2 text-right text-emerald-700 tabular-nums">{p.checkins || ""}</td>
                        <td className="p-2 text-right text-blue-700 tabular-nums">{p.checkouts || ""}</td>
                        <td className="p-2 text-right tabular-nums">{p.movements || ""}</td>
                        <td className="p-2 text-right font-bold tabular-nums">{p.totalActions || ""}</td>
                        <td className="p-2 text-right tabular-nums">{p.totalKm > 0 ? `${p.totalKm} km` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
