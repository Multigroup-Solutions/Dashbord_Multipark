import { trpc } from "@/lib/trpc";
import { fmtPTDate, fmtPTDateTime } from "@/lib/lisbonTime";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { useState, useMemo } from "react";
import {
  AlertTriangle, Plus, Clock, User, Car, Trash2, Pencil,
  BarChart3, AlertCircle, CheckCircle2, ShieldAlert,
  RefreshCw, Loader2, Bot, MapPin, Download,
} from "lucide-react";
import BookingSearchField from "@/components/BookingSearchField";

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  open: { label: "Aberta", color: "bg-red-100 text-red-800" },
  investigating: { label: "Em Investigação", color: "bg-yellow-100 text-yellow-800" },
  resolved: { label: "Resolvida", color: "bg-green-100 text-green-800" },
  dismissed: { label: "Descartada", color: "bg-gray-100 text-gray-800" },
};

const SEVERITY_CONFIG: Record<string, { label: string; color: string }> = {
  low: { label: "Baixa", color: "bg-slate-100 text-slate-700" },
  medium: { label: "Média", color: "bg-blue-100 text-blue-700" },
  high: { label: "Alta", color: "bg-orange-100 text-orange-700" },
  critical: { label: "Crítica", color: "bg-red-100 text-red-700" },
};

const TYPE_CONFIG: Record<string, string> = {
  vidro_aberto: "Vidro Aberto",
  mal_estacionado: "Mal Estacionado",
  dano: "Dano",
  chave_errada: "Chave Errada",
  combustivel: "Combustível",
  limpeza: "Limpeza",
  documentos: "Documentos",
  outro: "Outro",
};

/**
 * Categoria de triagem: pelo TEXTO, deteta ocorrências que são na verdade
 * ACIDENTES (a aba mais grave) ou RECLAMAÇÕES de cliente ("cliente reclamou
 * no terminal…") — essas ficam em abas próprias para análise/conversão.
 */
function categoryOf(inc: any): string {
  const txt = `${inc.description ?? ""} ${inc.aiClassification ?? ""}`;
  if (/acidente|sinistro|colis[aã]o|colidiu|embat|bateu|choque|capot/i.test(txt)) return "acidente";
  if (/reclam|queixa|queixou/i.test(txt)) return "reclamacao";
  return inc.incidentType || "outro";
}

const CATEGORY_TABS: Array<{ id: string; label: string; className?: string }> = [
  { id: "all", label: "Todas" },
  { id: "acidente", label: "⚠ Acidentes", className: "data-[state=active]:bg-red-600 data-[state=active]:text-white" },
  { id: "reclamacao", label: "Reclamações" },
  ...Object.entries(TYPE_CONFIG).map(([id, label]) => ({ id, label })),
];

export default function IncidentsPage() {
  const { user } = useAuth();
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editInc, setEditInc] = useState<any>(null);
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterSeverity, setFilterSeverity] = useState("all");
  const [activeTab, setActiveTab] = useState("all");
  const [detailId, setDetailId] = useState<number | null>(null);

  const queryInput = useMemo(() => {
    const input: any = {};
    if (filterStatus !== "all") input.status = filterStatus;
    if (filterSeverity !== "all") input.severity = filterSeverity;
    return Object.keys(input).length > 0 ? input : undefined;
  }, [filterStatus, filterSeverity]);

  const { data: incidents = [], isLoading } = trpc.incidents.list.useQuery(queryInput);
  const { data: stats } = trpc.incidents.stats.useQuery(undefined);
  const updateMut = trpc.incidents.update.useMutation();
  const deleteMut = trpc.incidents.delete.useMutation();
  const toComplaintMut = trpc.incidents.convertToComplaint.useMutation({
    onSuccess: (r) => { toast.success(`Movida para as Reclamações (#${r.newId}) — reserva e cliente ligados automaticamente se a matrícula bater`); utils.incidents.list.invalidate(); utils.incidents.stats.invalidate(); utils.complaints.list.invalidate(); },
    onError: (e) => toast.error(e.message || "Erro ao mover"),
  });
  const toLostFoundMut = trpc.incidents.convertToLostFound.useMutation({
    onSuccess: (r) => { toast.success(`Movida para os Perdidos & Achados (#${r.newId})`); utils.incidents.list.invalidate(); utils.incidents.stats.invalidate(); utils.lostFound.list.invalidate(); },
    onError: (e) => toast.error(e.message || "Erro ao mover"),
  });
  const utils = trpc.useUtils();

  // Contagens por categoria de triagem + lista filtrada pela aba ativa.
  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = { all: incidents.length };
    for (const inc of incidents as any[]) {
      const cat = categoryOf(inc);
      counts[cat] = (counts[cat] ?? 0) + 1;
    }
    return counts;
  }, [incidents]);
  const visibleIncidents = useMemo(
    () => activeTab === "all" ? incidents : (incidents as any[]).filter(inc => categoryOf(inc) === activeTab),
    [incidents, activeTab],
  );
  const { data: employees = [] } = trpc.rh.list.useQuery();

  const employeeMap = useMemo(() => {
    const map = new Map<number, string>();
    employees.forEach((row: any) => {
      const emp = row.employee ?? row;
      if (emp?.id != null) map.set(emp.id, emp.fullName);
    });
    return map;
  }, [employees]);

  const is48hOverdue = (createdAt: string, status: string) => {
    if (status === "resolved" || status === "dismissed") return false;
    const created = new Date(createdAt);
    const now = new Date();
    return (now.getTime() - created.getTime()) > 48 * 60 * 60 * 1000;
  };

  const handleResolve = async (id: number, resolution: string) => {
    await updateMut.mutateAsync({ id, status: "resolved", resolution });
    utils.incidents.list.invalidate();
    utils.incidents.stats.invalidate();
    toast.success("Ocorrência resolvida");
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Eliminar esta ocorrência?")) return;
    await deleteMut.mutateAsync({ id });
    utils.incidents.list.invalidate();
    utils.incidents.stats.invalidate();
    toast.success("Ocorrência eliminada");
  };

  const syncMultipark = trpc.incidents.syncFromMultipark.useMutation({
    onSuccess: (data: any) => {
      utils.incidents.list.invalidate();
      utils.incidents.stats.invalidate();
      if (data.imported === 0 && data.scanned === 0) {
        toast.info("Sem novas ocorrências para importar");
      } else {
        toast.success(`${data.imported} ocorrências importadas (${data.skipped} já existiam, ${data.scanned} analisadas)`);
      }
    },
    onError: (err) => toast.error("Erro no sync: " + err.message),
  });

  return (
    <>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <p className="text-muted-foreground">Gestão e análise de ocorrências reportadas</p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={incidents.length === 0}
              onClick={() => {
                const headers = ["ID","Data","Tipo","Estado","Gravidade","Matrícula","Condutor","Descrição","Resolução","Resolvido"];
                const rows = (incidents as any[]).map(i => [
                  i.id,
                  i.createdAt ? new Date(i.createdAt).toISOString().slice(0, 16) : "",
                  TYPE_CONFIG[i.incidentType] ?? i.incidentType,
                  STATUS_CONFIG[i.status]?.label ?? i.status,
                  SEVERITY_CONFIG[i.severity]?.label ?? i.severity,
                  i.vehiclePlate ?? "",
                  i.employeeId ? (employeeMap.get(i.employeeId) ?? `#${i.employeeId}`) : "",
                  (i.description ?? "").replace(/[;\n\r]/g, " "),
                  (i.resolution ?? "").replace(/[;\n\r]/g, " "),
                  i.resolvedAt ? new Date(i.resolvedAt).toISOString().slice(0, 16) : "",
                ]);
                const csv = [headers.join(";"), ...rows.map(r => r.join(";"))].join("\n");
                const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url; a.download = `ocorrencias_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
                URL.revokeObjectURL(url);
              }}
            >
              <Download className="w-4 h-4 mr-2" /> CSV
            </Button>
            <Button variant="outline" onClick={() => syncMultipark.mutate(undefined)} disabled={syncMultipark.isPending}>
              {syncMultipark.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
              {syncMultipark.isPending ? "A sincronizar..." : "Sincronizar Multipark"}
            </Button>
            <Button onClick={() => setShowCreate(true)}><Plus className="w-4 h-4 mr-2" /> Nova Ocorrência</Button>
          </div>
        </div>

        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card className="p-3">
              <div className="flex items-center gap-2"><BarChart3 className="w-4 h-4" /><span className="text-xs text-muted-foreground">Total</span></div>
              <p className="text-xl font-bold mt-1">{stats.total}</p>
            </Card>
            <Card className="p-3">
              <div className="flex items-center gap-2"><AlertCircle className="w-4 h-4 text-red-600" /><span className="text-xs text-muted-foreground">Abertas</span></div>
              <p className="text-xl font-bold mt-1 text-red-600">{stats.open}</p>
            </Card>
            <Card className="p-3">
              <div className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-green-600" /><span className="text-xs text-muted-foreground">Resolvidas</span></div>
              <p className="text-xl font-bold mt-1 text-green-600">{stats.resolved}</p>
            </Card>
            <Card className="p-3">
              <div className="flex items-center gap-2"><ShieldAlert className="w-4 h-4 text-red-600" /><span className="text-xs text-muted-foreground">Críticas</span></div>
              <p className="text-xl font-bold mt-1 text-red-600">{stats.critical}</p>
            </Card>
          </div>
        )}

        {/* By Type Chart */}
        {stats && Object.keys(stats.byType).length > 0 && (
          <Card>
            <CardHeader><CardTitle className="text-base">Por Tipo de Ocorrência</CardTitle></CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {Object.entries(stats.byType).sort(([,a],[,b]) => (b as number) - (a as number)).map(([type, count]) => (
                  <div key={type} className="flex items-center justify-between p-2 rounded bg-muted">
                    <span className="text-sm">{TYPE_CONFIG[type] || type}</span>
                    <Badge variant="secondary">{count as number}</Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Filters */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Label>Estado:</Label>
            <Select value={filterStatus} onValueChange={setFilterStatus}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                {Object.entries(STATUS_CONFIG).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Label>Gravidade:</Label>
            <Select value={filterSeverity} onValueChange={setFilterSeverity}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas</SelectItem>
                {Object.entries(SEVERITY_CONFIG).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Abas por tipo (Acidentes e Reclamações detetadas pelo texto) */}
        <div className="flex flex-wrap gap-1.5">
          {CATEGORY_TABS.map(t => (
            <Button
              key={t.id}
              size="sm"
              variant={activeTab === t.id ? "default" : "outline"}
              className={`text-xs ${t.id === "acidente" && activeTab === t.id ? "bg-red-600 hover:bg-red-700" : t.id === "acidente" ? "text-red-700 border-red-300" : ""}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
              <Badge variant="secondary" className="ml-1.5 text-[10px] px-1">{tabCounts[t.id] ?? 0}</Badge>
            </Button>
          ))}
        </div>

        {/* List */}
        {isLoading ? (
          <div className="flex justify-center py-20"><div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" /></div>
        ) : visibleIncidents.length === 0 ? (
          <Card className="p-10 text-center">
            <AlertTriangle className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
            <p className="text-muted-foreground">Sem ocorrências {activeTab === "all" ? "registadas" : "nesta categoria"}</p>
          </Card>
        ) : (
          <div className="space-y-2">
            {visibleIncidents.map((inc: any) => {
              const overdue = is48hOverdue(inc.createdAt, inc.status);
              return (
                <Card
                  key={inc.id}
                  className={`cursor-pointer hover:shadow-md transition-shadow ${overdue ? "border-red-400 border-2" : ""}`}
                  onClick={() => setDetailId(inc.id)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium">{TYPE_CONFIG[inc.incidentType] || inc.incidentType}</span>
                          {categoryOf(inc) === "acidente" && <Badge className="bg-red-600 text-white">⚠ Acidente</Badge>}
                          {categoryOf(inc) === "reclamacao" && <Badge className="bg-amber-100 text-amber-800">Cliente reclamou</Badge>}
                          <Badge className={STATUS_CONFIG[inc.status]?.color}>{STATUS_CONFIG[inc.status]?.label}</Badge>
                          <Badge className={SEVERITY_CONFIG[inc.severity]?.color}>{SEVERITY_CONFIG[inc.severity]?.label}</Badge>
                          {overdue && <Badge className="bg-red-500 text-white">+48h sem resolução</Badge>}
                          {(inc as any).sourceEmailId && <Badge variant="outline" className="text-xs"><Bot className="w-3 h-3 mr-1" />Gmail</Badge>}
                        </div>
                        <p className="text-sm text-muted-foreground">{inc.description}</p>
                        {(inc as any).aiClassification && (
                          <p className="text-xs text-blue-600 flex items-center gap-1"><Bot className="w-3 h-3" /> IA: {(inc as any).aiClassification}</p>
                        )}
                        <div className="flex items-center gap-4 text-xs text-muted-foreground">
                          {inc.vehiclePlate && <span className="flex items-center gap-1"><Car className="w-3 h-3" /> {inc.vehiclePlate}</span>}
                          {inc.employeeId && <span className="flex items-center gap-1"><User className="w-3 h-3" /> {employeeMap.get(inc.employeeId) || `#${inc.employeeId}`}</span>}
                          <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {fmtPTDateTime(inc.createdAt)}</span>
                          {(inc as any).gpsLatitude && (inc as any).gpsLongitude && (
                            <a href={`https://www.google.com/maps?q=${(inc as any).gpsLatitude},${(inc as any).gpsLongitude}`} target="_blank" rel="noopener" className="flex items-center gap-1 text-blue-500 hover:underline">
                              <MapPin className="w-3 h-3" /> Ver no mapa
                            </a>
                          )}
                        </div>
                        {inc.resolution && <p className="text-xs text-green-700 mt-1">Resolução: {inc.resolution}</p>}
                      </div>
                      <div className="flex gap-1 flex-wrap justify-end" onClick={(e) => e.stopPropagation()}>
                        <Button size="sm" variant="ghost" onClick={() => setEditInc(inc)}>
                          <Pencil className="w-4 h-4" />
                        </Button>
                        {(inc.status === "open" || inc.status === "investigating") && (
                          <Button size="sm" variant="outline" onClick={() => setSelectedId(inc.id)}>
                            Resolver
                          </Button>
                        )}
                        {["admin", "super_admin"].includes(user?.role ?? "") && (
                          <>
                            <Button
                              size="sm" variant="outline" className="text-xs"
                              disabled={toComplaintMut.isPending}
                              title="Converte em Reclamação — vai buscar a reserva e os dados do cliente pela matrícula"
                              onClick={() => {
                                if (!confirm("Mover esta ocorrência para as Reclamações? A reserva/cliente serão ligados automaticamente pela matrícula.")) return;
                                toComplaintMut.mutate({ id: inc.id });
                              }}
                            >
                              → Reclamações
                            </Button>
                            <Button
                              size="sm" variant="outline" className="text-xs"
                              disabled={toLostFoundMut.isPending}
                              title="Converte em caso de Perdidos & Achados"
                              onClick={() => {
                                if (!confirm("Mover esta ocorrência para os Perdidos & Achados?")) return;
                                toLostFoundMut.mutate({ id: inc.id });
                              }}
                            >
                              → Perdidos
                            </Button>
                          </>
                        )}
                        {user?.role === "super_admin" && (
                          <Button size="sm" variant="ghost" onClick={() => handleDelete(inc.id)}>
                            <Trash2 className="w-4 h-4 text-red-500" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {showCreate && <CreateIncidentDialog employees={employees} onClose={() => setShowCreate(false)} />}
      {selectedId && <ResolveDialog id={selectedId} onResolve={handleResolve} onClose={() => setSelectedId(null)} />}
      {editInc && <EditIncidentDialog incident={editInc} employees={employees} onClose={() => setEditInc(null)} />}
      {detailId && (
        <IncidentDetailDialog
          id={detailId}
          user={user}
          employeeMap={employeeMap}
          onClose={() => setDetailId(null)}
          onEdit={(inc) => { setDetailId(null); setEditInc(inc); }}
        />
      )}
    </>
  );
}

/**
 * Detalhe da ocorrência — a "pré-reclamação": conteúdo completo, reserva
 * relacionada pela matrícula, notas datadas, aceitar/resolver num clique e
 * conversão para Reclamações/Perdidos.
 */
function IncidentDetailDialog({ id, user, employeeMap, onClose, onEdit }: {
  id: number; user: any; employeeMap: Map<number, string>; onClose: () => void; onEdit: (inc: any) => void;
}) {
  const { data: inc, isLoading } = trpc.incidents.getById.useQuery({ id });
  const { data: peek } = trpc.incidents.bookingPeek.useQuery({ id });
  const utils = trpc.useUtils();
  const [note, setNote] = useState("");

  const invalidate = () => {
    utils.incidents.getById.invalidate({ id });
    utils.incidents.list.invalidate();
    utils.incidents.stats.invalidate();
  };
  const updateMut = trpc.incidents.update.useMutation({ onSuccess: invalidate });
  const addNoteMut = trpc.incidents.addNote.useMutation({
    onSuccess: () => { setNote(""); toast.success("Nota adicionada"); invalidate(); },
    onError: (e) => toast.error(e.message || "Erro ao adicionar nota"),
  });
  const toComplaintMut = trpc.incidents.convertToComplaint.useMutation({
    onSuccess: (r) => { toast.success(`Movida para as Reclamações (#${r.newId})`); invalidate(); utils.complaints.list.invalidate(); onClose(); },
    onError: (e) => toast.error(e.message || "Erro ao mover"),
  });
  const toLostFoundMut = trpc.incidents.convertToLostFound.useMutation({
    onSuccess: (r) => { toast.success(`Movida para os Perdidos & Achados (#${r.newId})`); invalidate(); utils.lostFound.list.invalidate(); onClose(); },
    onError: (e) => toast.error(e.message || "Erro ao mover"),
  });

  if (isLoading || !inc) return null;
  const isAdmin = ["admin", "super_admin"].includes(user?.role ?? "");
  const openStates = inc.status === "open" || inc.status === "investigating";

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            Ocorrência #{inc.id} — {TYPE_CONFIG[inc.incidentType] || inc.incidentType}
            {categoryOf(inc) === "acidente" && <Badge className="bg-red-600 text-white">⚠ Acidente</Badge>}
            {categoryOf(inc) === "reclamacao" && <Badge className="bg-amber-100 text-amber-800">Cliente reclamou</Badge>}
            <Badge className={STATUS_CONFIG[inc.status]?.color}>{STATUS_CONFIG[inc.status]?.label}</Badge>
            <Badge className={SEVERITY_CONFIG[inc.severity]?.color}>{SEVERITY_CONFIG[inc.severity]?.label}</Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">Descrição completa</p>
            <div className="max-h-[30vh] overflow-y-auto rounded bg-muted p-3 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
              {inc.description || "(sem descrição)"}
            </div>
            {(inc as any).aiClassification && (
              <p className="text-xs text-blue-600 mt-1 flex items-center gap-1"><Bot className="w-3 h-3" /> IA: {(inc as any).aiClassification}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
            {inc.vehiclePlate && <div><Car className="w-3 h-3 inline mr-1" />Matrícula: <span className="font-medium text-foreground">{inc.vehiclePlate}</span></div>}
            {inc.employeeId && <div><User className="w-3 h-3 inline mr-1" />Colaborador: <span className="font-medium text-foreground">{employeeMap.get(inc.employeeId) || `#${inc.employeeId}`}</span></div>}
            <div><Clock className="w-3 h-3 inline mr-1" />Criada: <span className="font-medium text-foreground">{fmtPTDateTime(inc.createdAt)}</span></div>
            {(inc as any).sourceEmailDate && <div>Email original: <span className="font-medium text-foreground">{fmtPTDateTime((inc as any).sourceEmailDate)}</span></div>}
            {(inc as any).gpsLatitude && (inc as any).gpsLongitude && (
              <a href={`https://www.google.com/maps?q=${(inc as any).gpsLatitude},${(inc as any).gpsLongitude}`} target="_blank" rel="noopener" className="text-blue-500 hover:underline"><MapPin className="w-3 h-3 inline mr-1" />Ver no mapa</a>
            )}
          </div>

          {peek && (
            <div className="rounded-lg border p-3 text-sm space-y-1 bg-blue-50/50">
              <p className="text-xs font-medium text-muted-foreground">Reserva relacionada (pela matrícula, à data da ocorrência)</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                <div>Reserva: <span className="font-medium">#{peek.bookingNumber || peek.externalId.slice(-8)}</span> · {peek.status}</div>
                <div>Parque: <span className="font-medium">{peek.parkName}{peek.city ? ` (${peek.city})` : ""}</span></div>
                <div>Cliente: <span className="font-medium">{peek.clientName || "—"}</span></div>
                <div>Estadia: <span className="font-medium">{peek.checkIn ? fmtPTDate(peek.checkIn) : "—"} → {peek.checkOut ? fmtPTDate(peek.checkOut) : "—"}</span></div>
              </div>
              <p className="text-[10px] text-muted-foreground">Ao mover para Reclamações/Perdidos, esta reserva e o cliente são ligados automaticamente.</p>
            </div>
          )}

          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">Notas / Resolução</p>
            {inc.resolution ? (
              <div className="max-h-[20vh] overflow-y-auto rounded bg-green-50 border border-green-200 p-3 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{inc.resolution}</div>
            ) : (
              <p className="text-xs text-muted-foreground">Sem notas.</p>
            )}
            <div className="flex gap-2 mt-2">
              <Input placeholder="Adicionar nota…" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && note.trim()) addNoteMut.mutate({ id, note }); }} />
              <Button size="sm" disabled={!note.trim() || addNoteMut.isPending} onClick={() => addNoteMut.mutate({ id, note })}>Adicionar</Button>
            </div>
          </div>
        </div>

        <DialogFooter className="flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => onEdit(inc)}><Pencil className="w-4 h-4 mr-1" /> Editar</Button>
          {openStates && (
            <Button
              size="sm" className="bg-green-600 hover:bg-green-700 text-white"
              disabled={updateMut.isPending}
              title="Ocorrência vista e aceite — fica resolvida"
              onClick={() => updateMut.mutate({ id, status: "resolved", resolution: inc.resolution ? undefined : "Aceite" }, { onSuccess: () => { toast.success("Ocorrência aceite e resolvida"); onClose(); } })}
            >
              <CheckCircle2 className="w-4 h-4 mr-1" /> Aceitar e resolver
            </Button>
          )}
          {openStates && inc.status !== "investigating" && (
            <Button size="sm" variant="outline" disabled={updateMut.isPending} onClick={() => updateMut.mutate({ id, status: "investigating" })}>
              Investigar
            </Button>
          )}
          {isAdmin && (
            <>
              <Button size="sm" variant="outline" disabled={toComplaintMut.isPending} onClick={() => { if (confirm("Mover para as Reclamações?")) toComplaintMut.mutate({ id }); }}>
                → Reclamações
              </Button>
              <Button size="sm" variant="outline" disabled={toLostFoundMut.isPending} onClick={() => { if (confirm("Mover para os Perdidos & Achados?")) toLostFoundMut.mutate({ id }); }}>
                → Perdidos
              </Button>
            </>
          )}
          <Button variant="outline" size="sm" onClick={onClose}>Fechar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResolveDialog({ id, onResolve, onClose }: { id: number; onResolve: (id: number, resolution: string) => void; onClose: () => void }) {
  const [resolution, setResolution] = useState("");
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader><DialogTitle>Resolver Ocorrência #{id}</DialogTitle></DialogHeader>
        <div>
          <Label>Resolução</Label>
          <Textarea value={resolution} onChange={e => setResolution(e.target.value)} placeholder="Descrever como foi resolvida..." rows={3} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => { onResolve(id, resolution); onClose(); }} disabled={!resolution.trim()}>Resolver</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateIncidentDialog({ employees, onClose }: { employees: any[]; onClose: () => void }) {
  const [form, setForm] = useState({
    vehiclePlate: "",
    employeeId: "",
    incidentType: "outro" as const,
    severity: "medium" as const,
    description: "",
    bookingRef: "",
  });
  const createMut = trpc.incidents.create.useMutation();
  const utils = trpc.useUtils();

  const handleSubmit = async () => {
    if (!form.description.trim()) { toast.error("Descrição obrigatória"); return; }
    try {
      await createMut.mutateAsync({
        vehiclePlate: form.vehiclePlate || undefined,
        employeeId: form.employeeId && form.employeeId !== "none" ? parseInt(form.employeeId) : undefined,
        incidentType: form.incidentType,
        severity: form.severity,
        description: form.description,
      });
      utils.incidents.list.invalidate();
      utils.incidents.stats.invalidate();
      toast.success("Ocorrência criada");
      onClose();
    } catch (e: any) { toast.error(e.message || "Erro"); }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Nova Ocorrência</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <BookingSearchField
            accent="amber"
            hint="Opcional — escolhe a reserva e a matrícula é preenchida automaticamente"
            onSelect={(b, _details) => {
              setForm(f => ({
                ...f,
                bookingRef: b.externalId || b.bookingNumber || f.bookingRef,
                vehiclePlate: f.vehiclePlate || b.licensePlate || "",
              }));
            }}
          />
          {form.bookingRef && (
            <div className="p-2 rounded border bg-muted text-xs flex items-center justify-between">
              <span className="font-mono">Reserva: {form.bookingRef}</span>
              <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setForm(f => ({ ...f, bookingRef: "" }))}>limpar</button>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Tipo</Label>
              <Select value={form.incidentType} onValueChange={(v: any) => setForm(f => ({ ...f, incidentType: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(TYPE_CONFIG).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Gravidade</Label>
              <Select value={form.severity} onValueChange={(v: any) => setForm(f => ({ ...f, severity: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(SEVERITY_CONFIG).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Matrícula</Label>
              <Input value={form.vehiclePlate} onChange={e => setForm(f => ({ ...f, vehiclePlate: e.target.value.toUpperCase() }))} placeholder="AA-00-BB" />
            </div>
            <div>
              <Label>Condutor Responsável</Label>
              <Select value={form.employeeId} onValueChange={v => setForm(f => ({ ...f, employeeId: v }))}>
                <SelectTrigger><SelectValue placeholder="Selecionar..." /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Nenhum</SelectItem>
                  {employees.map((row: any) => {
                    const e = row.employee ?? row;
                    return <SelectItem key={e.id} value={String(e.id)}>{e.fullName}</SelectItem>;
                  })}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label>Descrição *</Label>
            <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Descrever a ocorrência..." rows={3} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={handleSubmit} disabled={createMut.isPending}>{createMut.isPending ? "A criar..." : "Criar"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditIncidentDialog({ incident, employees, onClose }: { incident: any; employees: any[]; onClose: () => void }) {
  const [form, setForm] = useState({
    incidentType: incident.incidentType || "outro",
    severity: incident.severity || "medium",
    description: incident.description || "",
    vehiclePlate: incident.vehiclePlate || "",
    employeeId: incident.employeeId ? String(incident.employeeId) : "",
    status: incident.status || "open",
  });
  const updateMut = trpc.incidents.update.useMutation();
  const utils = trpc.useUtils();

  const handleSubmit = async () => {
    try {
      await updateMut.mutateAsync({
        id: incident.id,
        incidentType: form.incidentType as any,
        severity: form.severity as any,
        description: form.description || undefined,
        vehiclePlate: form.vehiclePlate || undefined,
        employeeId: form.employeeId && form.employeeId !== "none" ? parseInt(form.employeeId) : undefined,
        status: form.status as any,
      });
      utils.incidents.list.invalidate();
      utils.incidents.stats.invalidate();
      toast.success("Ocorrência atualizada");
      onClose();
    } catch (e: any) { toast.error(e.message || "Erro ao atualizar"); }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Editar Ocorrência #{incident.id}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Tipo</Label>
              <Select value={form.incidentType} onValueChange={(v: any) => setForm(f => ({ ...f, incidentType: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(TYPE_CONFIG).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Gravidade</Label>
              <Select value={form.severity} onValueChange={(v: any) => setForm(f => ({ ...f, severity: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(SEVERITY_CONFIG).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Estado</Label>
              <Select value={form.status} onValueChange={(v: any) => setForm(f => ({ ...f, status: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(STATUS_CONFIG).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Matrícula</Label>
              <Input value={form.vehiclePlate} onChange={e => setForm(f => ({ ...f, vehiclePlate: e.target.value.toUpperCase() }))} placeholder="AA-00-BB" />
            </div>
            <div className="col-span-2">
              <Label>Condutor Responsável</Label>
              <Select value={form.employeeId} onValueChange={v => setForm(f => ({ ...f, employeeId: v }))}>
                <SelectTrigger><SelectValue placeholder="Selecionar..." /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Nenhum</SelectItem>
                  {employees.map((row: any) => {
                    const e = row.employee ?? row;
                    return <SelectItem key={e.id} value={String(e.id)}>{e.fullName}</SelectItem>;
                  })}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label>Descrição</Label>
            <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={3} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={handleSubmit} disabled={updateMut.isPending}>Guardar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
