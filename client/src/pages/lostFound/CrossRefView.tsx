import { trpc } from "@/lib/trpc";
import { formatBookingHistoryDetails } from "@/lib/bookingHistoryFormat";
import { openInMultipark } from "@/lib/multiparkLinks";
import { fileHref } from "@/lib/fileHref";
import CaseMessageList from "@/components/CaseMessageList";
import { fmtPTDate, fmtPTDateTime } from "@/lib/lisbonTime";
import { filterBookingHistory } from "@/lib/bookingHistory";
import { REPLY_TEMPLATES } from "@/lib/replyTemplates";
import { useAuth } from "@/_core/hooks/useAuth";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import BookingSearchField from "@/components/BookingSearchField";
import ClientHistoryCard from "@/components/ClientHistoryCard";
import CaseAssignmentCard from "@/components/CaseAssignmentCard";
import LinkInboundEmailButton from "@/components/LinkInboundEmailButton";
import {
  Search, Plus, Clock, User, Car,
  ChevronRight, ChevronLeft, Send, Eye, Trash2, Upload, Pencil,
  BarChart3, AlertCircle, CheckCircle2, Hourglass, XCircle,
  Package, DollarSign, Smartphone, Shirt, FileText, Glasses,
  HelpCircle, TrendingUp, ShieldAlert, Flag, Mail, Download, Truck, GripVertical, MessageSquareWarning, RefreshCw, ExternalLink } from "lucide-react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { STATUS_CONFIG, TYPE_CONFIG, PRIORITY_CONFIG, KANBAN_COLUMNS, BASE_PATH, CHANGE_TYPE_CONFIG } from "./config";

/**
 * "Cruzamento de condutores" — o valor principal dos Perdidos: num período e
 * cidade, que condutores aparecem em MAIS casos distintos (anexados ao caso ou
 * com ações no histórico da reserva do caso), com as ocorrências e
 * reclamações deles no mesmo período e a % dos seus movimentos que acabaram
 * num caso vs a média da equipa. Clique num condutor → casos + movimentos
 * exatos. Team leader+ (informação sensível), sempre no âmbito da cidade.
 */
export function CrossRefView({ onBack }: { onBack: () => void }) {
  const globalFilters = useGlobalFilters();
  const fmtDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Europe/Lisbon" });
  const [crFrom, setCrFrom] = useState(() => fmtDay(new Date(Date.now() - 90 * 86_400_000)));
  const [crTo, setCrTo] = useState(() => fmtDay(new Date()));
  const [noProject, setNoProject] = useState(false);
  const [selKey, setSelKey] = useState<string | null>(null);
  const crInput = useMemo(() => ({
    from: crFrom, to: crTo,
    ...(noProject ? { noProject: true } : globalFilters.projectId !== undefined ? { projectId: globalFilters.projectId } : {}),
  }), [crFrom, crTo, noProject, globalFilters.projectId]);
  const crossQ = trpc.lostFound.crossRef.useQuery(crInput, { retry: false });
  const detailQ = trpc.lostFound.crossRefDetail.useQuery({ ...crInput, key: selKey ?? "" }, { enabled: !!selKey, retry: false });
  const cross = crossQ.data;
  const pct = (v: number | null | undefined) => v == null ? "—" : `${(v * 100).toLocaleString("pt-PT", { maximumFractionDigits: 1 })}%`;

  // "Movimentos por Condutor": escolher um condutor + período e ver tudo o que
  // ele mexeu (fonte: histórico Multipark sincronizado na BD local).
  const [agent, setAgent] = useState("");
  const [from, setFrom] = useState(() => fmtDay(new Date(Date.now() - 30 * 86_400_000)));
  const [to, setTo] = useState(() => fmtDay(new Date()));
  const { data: drivers = [] } = trpc.lostFound.driversForPeriod.useQuery({ from, to }, { retry: false });
  const movQ = trpc.lostFound.agentMovements.useQuery(
    { agentName: agent, from, to },
    { enabled: !!agent, retry: false },
  );
  const mov = movQ.data;

  if (crossQ.error?.data?.code === "FORBIDDEN") {
    return (
      <div className="space-y-4">
        <Button variant="outline" onClick={onBack}><ChevronLeft className="w-4 h-4 mr-1" /> Voltar</Button>
        <Card className="p-8 text-center text-muted-foreground">O Cruzamento de condutores é reservado a team leaders, supervisores e administração.</Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="outline" onClick={onBack}><ChevronLeft className="w-4 h-4 mr-1" /> Voltar</Button>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShieldAlert className="w-6 h-6 text-red-500" /> Cruzamento de condutores
          </h1>
          <p className="text-muted-foreground">Que condutores se repetem nos casos de perdidos (e nas ocorrências/reclamações)</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="w-5 h-5" /> Ranking por casos distintos
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Um condutor conta num caso se foi <b>anexado</b> ao caso ou se tem <b>ações no histórico da reserva</b> do caso.
            "% mov. em casos" = parte dos movimentos dele no período que foram em reservas com caso, comparada com a média da equipa.
          </p>
          <div className="flex flex-wrap items-end gap-2 pt-2">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Casos criados de</p>
              <Input type="date" value={crFrom} onChange={(e) => setCrFrom(e.target.value)} className="w-auto" />
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">até</p>
              <Input type="date" value={crTo} onChange={(e) => setCrTo(e.target.value)} className="w-auto" />
            </div>
            <label className="flex items-center gap-1 text-xs cursor-pointer pb-2">
              <input type="checkbox" checked={noProject} onChange={(e) => setNoProject(e.target.checked)} /> Só casos sem cidade
            </label>
            {cross && (
              <div className="flex gap-2 pb-1 text-xs">
                <Badge variant="outline">{cross.totalCases} casos com condutores</Badge>
                <Badge variant="outline">média da equipa: {pct(cross.teamRate)}</Badge>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {crossQ.isLoading ? (
            <div className="flex justify-center py-10"><div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" /></div>
          ) : !cross || cross.rows.length === 0 ? (
            <div className="text-center py-10">
              <Package className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
              <p className="text-muted-foreground">Sem casos com condutores ligados neste período.</p>
              <p className="text-xs text-muted-foreground mt-1">
                Os casos precisam de reserva ligada (histórico Multipark sincronizado) ou de condutores anexados.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="bg-muted/50 text-left">
                    <th className="p-2 w-10">#</th>
                    <th className="p-2">Condutor</th>
                    <th className="p-2 text-right">Casos</th>
                    <th className="p-2 text-right">Anexado / Reserva</th>
                    <th className="p-2 text-right">Ocorrências</th>
                    <th className="p-2 text-right">Reclamações</th>
                    <th className="p-2 text-right">Mov. no período</th>
                    <th className="p-2 text-right">% mov. em casos</th>
                    <th className="p-2 text-right">vs equipa</th>
                  </tr>
                </thead>
                <tbody>
                  {cross.rows.map((r, i) => (
                    <tr
                      key={r.key}
                      className={`border-t cursor-pointer ${selKey === r.key ? "bg-primary/10" : r.caseCount >= 3 ? "bg-red-50 dark:bg-red-950/30" : r.caseCount === 2 ? "bg-amber-50 dark:bg-amber-950/30" : "hover:bg-muted/30"}`}
                      onClick={() => setSelKey(selKey === r.key ? null : r.key)}
                    >
                      <td className="p-2 text-xs text-muted-foreground">{i + 1}</td>
                      <td className="p-2 font-medium">
                        {r.name}
                        {!r.employeeId && <Badge variant="outline" className="ml-2 text-[10px]">só nome Multipark</Badge>}
                      </td>
                      <td className="p-2 text-right"><Badge variant={r.caseCount >= 2 ? "destructive" : "outline"}>{r.caseCount}</Badge></td>
                      <td className="p-2 text-right text-xs text-muted-foreground">{r.attachedCases} / {r.movementCases}</td>
                      <td className="p-2 text-right">{r.incidents}</td>
                      <td className="p-2 text-right">{r.complaints}</td>
                      <td className="p-2 text-right text-muted-foreground">{r.totalMovements}</td>
                      <td className="p-2 text-right">{pct(r.caseRate)}</td>
                      <td className={`p-2 text-right font-medium ${r.vsTeam != null && r.vsTeam >= 2 ? "text-red-600" : ""}`}>
                        {r.vsTeam == null ? "—" : `${r.vsTeam.toLocaleString("pt-PT", { maximumFractionDigits: 1 })}×`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {selKey && (
            <div className="mt-4 border rounded-lg p-3 space-y-3">
              <div className="flex items-center justify-between">
                <p className="font-medium">Detalhe — {detailQ.data?.name ?? "…"}</p>
                <Button size="sm" variant="ghost" onClick={() => setSelKey(null)}>fechar</Button>
              </div>
              {detailQ.isLoading ? <p className="text-xs text-muted-foreground">A carregar…</p> : detailQ.data && (
                <>
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground">Casos</p>
                    {detailQ.data.cases.map((c) => (
                      <a key={c.id} href={`${BASE_PATH}/caso/${c.id}`} className="flex flex-wrap items-center gap-2 text-sm hover:underline">
                        <span className="font-mono">#{c.id}</span>
                        <Badge className={STATUS_CONFIG[c.status]?.color}>{STATUS_CONFIG[c.status]?.label ?? c.status}</Badge>
                        <span className="truncate max-w-[320px]">{c.description}</span>
                        {c.plate && <span className="font-mono text-xs">{c.plate}</span>}
                        <span className="text-xs text-muted-foreground">{fmtPTDate(c.createdAt)}</span>
                        {c.attached && <Badge variant="outline" className="text-[10px]">anexado</Badge>}
                        {c.movements > 0 && <Badge variant="outline" className="text-[10px]">{c.movements} ações na reserva</Badge>}
                      </a>
                    ))}
                  </div>
                  {detailQ.data.movements.length > 0 && (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[480px] text-xs">
                        <thead>
                          <tr className="bg-muted/50 text-left"><th className="p-1.5">Data/hora</th><th className="p-1.5">Ação</th><th className="p-1.5">Parque</th><th className="p-1.5">Caso</th></tr>
                        </thead>
                        <tbody>
                          {detailQ.data.movements.map((m, i) => (
                            <tr key={i} className="border-t">
                              <td className="p-1.5 whitespace-nowrap">{m.actionTime ? fmtPTDateTime(m.actionTime) : "—"}</td>
                              <td className="p-1.5">{CHANGE_TYPE_CONFIG[m.changeType ?? ""]?.label ?? m.changeType ?? "—"}</td>
                              <td className="p-1.5">{m.parkName ?? "—"}</td>
                              <td className="p-1.5 font-mono">#{m.caseId}</td>
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Truck className="w-5 h-5" /> Movimentos por Condutor
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Escolhe um condutor e um período para ver todos os carros em que mexeu.
            Linhas a vermelho = reserva/matrícula com caso aberto nos Perdidos &amp; Achados.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">De</p>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-auto" />
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Até</p>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-auto" />
            </div>
            <div className="space-y-1 min-w-[240px] flex-1 max-w-sm">
              <p className="text-xs text-muted-foreground">Condutor ({drivers.length} com atividade no período)</p>
              <SearchableSelect
                value={agent}
                onChange={setAgent}
                options={drivers.map((d: any) => ({ value: d.agentName, label: `${d.agentName} (${d.total})` }))}
                placeholder="Escolher condutor…"
              />
            </div>
          </div>

          {!agent ? (
            <p className="text-sm text-muted-foreground py-6 text-center">Escolhe um condutor para ver os movimentos.</p>
          ) : movQ.isLoading ? (
            <div className="flex justify-center py-10"><div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" /></div>
          ) : !mov || mov.movements.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">Sem movimentos deste condutor no período (a BD local só tem o histórico já sincronizado pelo cron).</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2 text-sm">
                <Badge variant="outline">{mov.totals.actions} ações</Badge>
                <Badge variant="outline" className="text-green-600">{mov.totals.checkins} check-ins</Badge>
                <Badge variant="outline" className="text-violet-600">{mov.totals.checkouts} check-outs</Badge>
                <Badge variant="outline" className="text-amber-600">{mov.totals.movements} movimentos</Badge>
                <Badge variant="outline">{mov.totals.plates} matrículas</Badge>
                {mov.totals.flaggedPlates > 0 && (
                  <Badge variant="destructive">{mov.totals.flaggedPlates} com caso aberto</Badge>
                )}
              </div>
              {mov.plates.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {mov.plates.slice(0, 30).map((p: any) => (
                    <Badge key={p.plate} variant={p.isCaseVehicle ? "destructive" : "secondary"} className="font-mono text-[11px]" title={`${p.actions} ações`}>
                      {p.plate}{p.isCaseVehicle ? " ⚠" : ""}
                    </Badge>
                  ))}
                  {mov.plates.length > 30 && <span className="text-xs text-muted-foreground">+{mov.plates.length - 30}</span>}
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="bg-muted/50 text-left">
                      <th className="p-2">Data/hora</th>
                      <th className="p-2">Ação</th>
                      <th className="p-2">Matrícula</th>
                      <th className="p-2">Parque</th>
                      <th className="p-2">Reserva</th>
                      <th className="p-2">Notas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mov.movements.map((m: any, i: number) => (
                      <tr key={i} className={`border-t ${m.flagged ? "bg-red-50 text-red-900" : "hover:bg-muted/30"}`}>
                        <td className="p-2 whitespace-nowrap">{m.actionTime ? fmtPTDateTime(m.actionTime) : "—"}</td>
                        <td className="p-2">{m.changeType ?? "—"}</td>
                        <td className="p-2 font-mono">{m.licensePlate ?? "—"}{m.flagged ? " ⚠" : ""}</td>
                        <td className="p-2">{m.parkName ?? "—"}{m.city ? ` · ${m.city}` : ""}</td>
                        <td className="p-2 font-mono text-xs">{m.bookingExternalId}</td>
                        <td className="p-2 text-xs text-muted-foreground max-w-[240px] truncate" title={m.remarks ?? undefined}>{m.remarks ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
