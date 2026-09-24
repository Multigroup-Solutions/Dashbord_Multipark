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

// ─── Condutores do caso (roubos): anexar quem mexeu no carro ──────────────────
export function CaseDriversPanel({ itemId, agents, employees, role }: {
  itemId: number;
  agents: any[];
  employees: { id: number; fullName: string }[];
  role?: string;
}) {
  // Ligar suspeitos e propor pontos: team leader+. Confirmar pontos: supervisor+.
  const isLeader = ["team_leader", "supervisor", "admin", "super_admin"].includes(role ?? "");
  const isSupervisor = ["supervisor", "admin", "super_admin"].includes(role ?? "");
  const utils = trpc.useUtils();
  const { data: attached = [] } = trpc.lostFound.attachedDrivers.useQuery({ itemId });
  const attach = trpc.lostFound.attachDriver.useMutation({
    onSuccess: () => { utils.lostFound.attachedDrivers.invalidate({ itemId }); toast.success("Condutor anexado"); },
    onError: (e) => toast.error(e.message),
  });
  const detach = trpc.lostFound.detachDriver.useMutation({
    onSuccess: () => { utils.lostFound.attachedDrivers.invalidate({ itemId }); toast.success("Removido"); },
    onError: (e) => toast.error(e.message),
  });
  const acct = trpc.lostFound.setDriverAccountability.useMutation({
    onSuccess: () => { utils.lostFound.attachedDrivers.invalidate({ itemId }); toast.success("Guardado — pontos ficam pendentes até um supervisor confirmar"); },
    onError: (e) => toast.error(e.message),
  });
  const review = trpc.lostFound.reviewDriverPoints.useMutation({
    onSuccess: () => { utils.lostFound.attachedDrivers.invalidate({ itemId }); toast.success("Revisão guardada"); },
    onError: (e) => toast.error(e.message),
  });
  const [empId, setEmpId] = useState("none");
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const attachedNames = new Set((attached as any[]).map(a => (a.driverName || "").toLowerCase()));

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <User className="w-4 h-4 text-primary" /> Condutores do caso
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {(attached as any[]).length > 0 ? (attached as any[]).map(a => (
          <div key={a.id} className="flex items-start justify-between border-b last:border-0 py-1 gap-2">
            <div className="min-w-0 flex-1">
              <span className="font-medium">{a.driverName}</span>
              {a.movementDate && <span className="text-xs text-muted-foreground ml-2">{a.movementDate}</span>}
              {a.source === "history" && <Badge variant="outline" className="ml-2 text-[10px]">do carro</Badge>}
              {a.points > 0 && (
                <Badge variant="outline" className={`ml-2 text-[10px] ${a.pointsConfirmed ? "text-red-700 border-red-300" : "text-amber-700 border-amber-300"}`}>
                  {a.points} pts {a.pointsConfirmed ? "confirmados" : "pendentes"}
                </Badge>
              )}
              {a.costAmount != null && <Badge variant="outline" className="ml-2 text-[10px]">custo {Number(a.costAmount).toLocaleString("pt-PT", { style: "currency", currency: "EUR" })}</Badge>}
              {a.movementsSummary && <p className="text-xs text-muted-foreground">{a.movementsSummary}</p>}
              {a.notes && <p className="text-xs">{a.notes}</p>}
              {isLeader && (
                <AccountabilityRow
                  link={a}
                  saving={acct.isPending}
                  onSave={(costAmount, points) => acct.mutate({ linkId: a.id, costAmount, points })}
                />
              )}
              {isSupervisor && a.points > 0 && a.penaltyId && !a.pointsConfirmed && (
                <div className="flex gap-1 mt-1">
                  <Button size="sm" variant="outline" className="h-6 text-xs" disabled={review.isPending} onClick={() => review.mutate({ linkId: a.id, decision: "confirmed" })}>Confirmar pontos</Button>
                  <Button size="sm" variant="ghost" className="h-6 text-xs" disabled={review.isPending} onClick={() => review.mutate({ linkId: a.id, decision: "dismissed" })}>Anular</Button>
                </div>
              )}
            </div>
            {isLeader && <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" onClick={() => detach.mutate({ id: a.id })}><Trash2 className="w-3 h-3" /></Button>}
          </div>
        )) : <p className="text-xs text-muted-foreground">Nenhum condutor anexado a este caso.</p>}

        {isLeader && agents.length > 0 && (
          <div className="border-t pt-2">
            <p className="text-xs font-medium text-muted-foreground mb-1">Quem mexeu no carro (1 clique p/ anexar)</p>
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {agents.map((ag, i) => {
                const summary = `${ag.actions} ações · ${ag.checkins} entr. / ${ag.checkouts} saí. / ${ag.movements} mov.`;
                const linked = attachedNames.has((ag.agentName || "").toLowerCase());
                return (
                  <div key={i} className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs">
                      <span className="font-medium">{ag.agentName}</span> · {summary}
                      {ag.flagged ? <Badge variant="outline" className="ml-1 text-[10px] text-red-600 border-red-300">tocou nesta reserva</Badge> : null}
                    </span>
                    <Button size="sm" variant="outline" className="h-7 shrink-0" disabled={linked || attach.isPending}
                      onClick={() => attach.mutate({ itemId, driverName: ag.agentName, source: "history", movementDate: ag.lastActionAt ? String(ag.lastActionAt).slice(0, 10) : null, movementsSummary: summary })}>
                      {linked ? "anexado" : "Anexar"}
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {!isLeader && <p className="text-[11px] text-muted-foreground">Ligar condutores a um caso é reservado a team leaders+.</p>}
        {isLeader && <div className="border-t pt-2 space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Anexar manualmente (qualquer colaborador)</p>
          <div className="flex gap-2 items-end flex-wrap">
            <div className="flex-1 min-w-[150px]">
              <Label className="text-xs">Colaborador</Label>
              <Select value={empId} onValueChange={setEmpId}>
                <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">—</SelectItem>
                  {employees.map(e => <SelectItem key={e.id} value={String(e.id)}>{e.fullName}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div><Label className="text-xs">Data</Label><Input type="date" className="w-36" value={date} onChange={e => setDate(e.target.value)} /></div>
          </div>
          <Input placeholder="Nota (opcional)" value={note} onChange={e => setNote(e.target.value)} />
          <Button size="sm" disabled={empId === "none" || attach.isPending} onClick={() => {
            const emp = employees.find(e => String(e.id) === empId); if (!emp) return;
            attach.mutate({ itemId, employeeId: emp.id, driverName: emp.fullName, source: "manual", movementDate: date || null, notes: note || null });
            setEmpId("none"); setDate(""); setNote("");
          }}>Anexar colaborador</Button>
        </div>}
      </CardContent>
    </Card>
  );
}

/** Custo para recuperar + pontos propostos (penalização RH pendente). */
function AccountabilityRow({ link, onSave, saving }: { link: any; onSave: (costAmount: number | null, points: number) => void; saving: boolean }) {
  const [cost, setCost] = useState(link.costAmount != null ? String(link.costAmount) : "");
  const [points, setPoints] = useState(String(link.points ?? 0));
  const locked = !!link.pointsConfirmed;
  return (
    <div className="flex flex-wrap items-end gap-2 mt-1">
      <div><Label className="text-[10px]">Custo (€)</Label><Input className="h-7 w-24" type="number" min={0} step="0.01" value={cost} onChange={e => setCost(e.target.value)} /></div>
      <div><Label className="text-[10px]">Pontos</Label><Input className="h-7 w-16" type="number" min={0} max={20} value={points} disabled={locked} onChange={e => setPoints(e.target.value)} /></div>
      <Button size="sm" variant="outline" className="h-7 text-xs" disabled={saving} onClick={() => onSave(cost === "" ? null : Number(cost), Math.max(0, Math.trunc(Number(points) || 0)))}>Guardar</Button>
    </div>
  );
}
