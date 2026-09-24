import { trpc } from "@/lib/trpc";
import { can, roleRank, seesBeyondOwn } from "@shared/access";
import { openInMultipark } from "@/lib/multiparkLinks";
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
  RefreshCw, Loader2, Bot, MapPin, Download, ExternalLink,
} from "lucide-react";
import BookingSearchField from "@/components/BookingSearchField";
import CaseDashboardCard from "@/components/CaseDashboardCard";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { useLocation } from "wouter";


const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  open: { label: "Aberta", color: "bg-red-100 text-red-800" },
  investigating: { label: "Em Investigação", color: "bg-yellow-100 text-yellow-800" },
  resolved: { label: "Resolvida", color: "bg-green-100 text-green-800" },
  dismissed: { label: "Descartada", color: "bg-gray-100 text-gray-800" },
  converted: { label: "Convertida", color: "bg-violet-100 text-violet-800" },
};
type EditableStatus = "open" | "investigating" | "resolved" | "dismissed";
const isOpenStatus = (s: string) => s === "open" || s === "investigating";

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
  const [detailId, setDetailId] = useState<number | null>(() => Number(new URLSearchParams(window.location.search).get("id")) || null);
  const [noProject, setNoProject] = useState(false);
  const globalFilters = useGlobalFilters();
  const [, setLocation] = useLocation();
  const isLeader = roleRank(user?.role) >= roleRank("team_leader") && can(user, "ocorrencias", "edit");

  const scopeInput = useMemo(() => (
    noProject ? { noProject: true } : globalFilters.projectId !== undefined ? { projectId: globalFilters.projectId } : {}
  ), [noProject, globalFilters.projectId]);
  const queryInput = useMemo(() => {
    const input: any = { ...scopeInput };
    if (filterStatus !== "all") input.status = filterStatus;
    if (filterSeverity !== "all") input.severity = filterSeverity;
    return Object.keys(input).length > 0 ? input : undefined;
  }, [filterStatus, filterSeverity, scopeInput]);

  const { data: incidents = [], isLoading } = trpc.incidents.list.useQuery(queryInput);
  const { data: stats } = trpc.incidents.stats.useQuery(Object.keys(scopeInput).length ? scopeInput : undefined);
  const { data: dashboard } = trpc.incidents.dashboard.useQuery(Object.keys(scopeInput).length ? scopeInput : undefined);
  const { data: allProjects = [] } = trpc.projects.list.useQuery();
  const cities = useMemo(() => (allProjects as any[]).filter(p => p.level === "city").map(p => ({ id: p.id as number, name: p.name as string })), [allProjects]);
  const updateMut = trpc.incidents.update.useMutation();
  const deleteMut = trpc.incidents.delete.useMutation();
  const toComplaintMut = trpc.incidents.convertToComplaint.useMutation({
    onSuccess: (r) => { toast.success(`Convertida na Reclamação #${r.newId} (a ocorrência fica fechada e ligada)`); utils.incidents.list.invalidate(); utils.incidents.stats.invalidate(); utils.incidents.dashboard.invalidate(); utils.complaints.list.invalidate(); },
    onError: (e) => toast.error(e.message || "Erro ao mover"),
  });
  const toLostFoundMut = trpc.incidents.convertToLostFound.useMutation({
    onSuccess: (r) => { toast.success(`Convertida no Perdido #${r.newId} (a ocorrência fica fechada e ligada)`); utils.incidents.list.invalidate(); utils.incidents.stats.invalidate(); utils.incidents.dashboard.invalidate(); utils.lostFound.list.invalidate(); },
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

  // SLA: prazo guardado (dueAt, UTC). Sem prazo (legado) → 48h desde a criação.
  const isOverdue = (inc: any) => {
    if (!isOpenStatus(inc.status)) return false;
    const due = inc.dueAt ? utcMs(inc.dueAt) : utcMs(inc.createdAt) + 48 * 3_600_000;
    return Date.now() > due;
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
          <div className="flex gap-2 flex-wrap">
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
            {isLeader && (
              <Button variant="outline" onClick={() => setLocation("/perdidos-achados/cruzamento")}>
                <ShieldAlert className="w-4 h-4 mr-2" /> Cruzamento de condutores
              </Button>
            )}
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

        <CaseDashboardCard
          data={dashboard}
          onOpenCrossRef={isLeader ? () => setLocation("/perdidos-achados/cruzamento") : undefined}
          onShowNoCity={() => setNoProject(true)}
        />

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
          <label className="flex items-center gap-1 text-sm cursor-pointer">
            <input type="checkbox" checked={noProject} onChange={e => setNoProject(e.target.checked)} /> Sem cidade
          </label>
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
              <Badge variant="secondary" className="ml-1.5 text-[11px] px-1 tabular-nums">{tabCounts[t.id] ?? 0}</Badge>
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
              const overdue = isOverdue(inc);
              return (
                <Card
                  key={inc.id}
                  className={`cursor-pointer hover:shadow-md transition-shadow ${overdue ? "border-red-400 border-2" : ""}`}
                  onClick={() => setDetailId(inc.id)}
                >
                  <CardContent className="p-4">
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4">
                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium">{TYPE_CONFIG[inc.incidentType] || inc.incidentType}</span>
                          {categoryOf(inc) === "acidente" && <Badge className="bg-red-600 text-white">⚠ Acidente</Badge>}
                          {categoryOf(inc) === "reclamacao" && <Badge className="bg-amber-100 text-amber-800">Cliente reclamou</Badge>}
                          <Badge className={STATUS_CONFIG[inc.status]?.color}>{STATUS_CONFIG[inc.status]?.label}</Badge>
                          <Badge className={SEVERITY_CONFIG[inc.severity]?.color}>{SEVERITY_CONFIG[inc.severity]?.label}</Badge>
                          {overdue && <Badge className="bg-red-600 text-white">Fora do prazo</Badge>}
                          {inc.projectId == null && inc.status !== "converted" && <Badge variant="outline" className="text-red-600 border-red-300">Sem cidade</Badge>}
                          {inc.employeeId && !inc.driverConfirmed && inc.status !== "dismissed" && inc.status !== "converted" && (
                            <Badge variant="outline" className="text-amber-700 border-amber-300">Condutor por confirmar</Badge>
                          )}
                          {inc.status === "converted" && inc.convertedToId && (
                            <Badge variant="outline" className="text-violet-700 border-violet-300">→ {inc.convertedToType === "complaint" ? "Reclamação" : "Perdido"} #{inc.convertedToId}</Badge>
                          )}
                          {(inc as any).sourceEmailId && <Badge variant="outline" className="text-xs"><Bot className="w-3 h-3 mr-1" />Gmail</Badge>}
                        </div>
                        <p className="text-sm text-muted-foreground line-clamp-3 break-words">{inc.description}</p>
                        {(inc as any).aiClassification && (
                          <p className="text-xs text-blue-700 flex items-center gap-1"><Bot className="w-3 h-3 shrink-0" /> <span className="line-clamp-2 break-words">IA: {(inc as any).aiClassification}</span></p>
                        )}
                        <div className="flex items-center gap-x-4 gap-y-1 flex-wrap text-xs text-muted-foreground">
                          {inc.vehiclePlate && <span className="flex items-center gap-1"><Car className="w-3 h-3" /> {inc.vehiclePlate}</span>}
                          {inc.employeeId && <span className="flex items-center gap-1"><User className="w-3 h-3" /> {employeeMap.get(inc.employeeId) || `#${inc.employeeId}`}</span>}
                          <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {fmtPTDateTime(inc.createdAt)}</span>
                          {(inc as any).gpsLatitude && (inc as any).gpsLongitude && (
                            <a href={`https://www.google.com/maps?q=${(inc as any).gpsLatitude},${(inc as any).gpsLongitude}`} target="_blank" rel="noopener" className="flex items-center gap-1 text-blue-700 hover:underline">
                              <MapPin className="w-3 h-3" /> Ver no mapa
                            </a>
                          )}
                        </div>
                        {inc.resolution && <p className="text-xs text-green-700 mt-1">Resolução: {inc.resolution}</p>}
                      </div>
                      <div className="flex gap-1 flex-wrap sm:justify-end shrink-0" onClick={(e) => e.stopPropagation()}>
                        {inc.projectId == null && inc.status !== "converted" && cities.length > 0 && (
                          <AssignCitySelect incidentId={inc.id} cities={cities} />
                        )}
                        {inc.status !== "converted" && (
                          <Button size="sm" variant="ghost" onClick={() => setEditInc(inc)}>
                            <Pencil className="w-4 h-4" />
                          </Button>
                        )}
                        {(inc.status === "open" || inc.status === "investigating") && (
                          <Button size="sm" variant="outline" onClick={() => setSelectedId(inc.id)}>
                            Resolver
                          </Button>
                        )}
                        {["admin", "super_admin"].includes(user?.role ?? "") && inc.status !== "converted" && (
                          <>
                            <Button
                              size="sm" variant="outline" className="text-xs"
                              disabled={toComplaintMut.isPending}
                              title="Converte em Reclamação — vai buscar a reserva e os dados do cliente pela matrícula"
                              onClick={() => {
                                if (!confirm("Converter em Reclamação? A ocorrência fica fechada como 'Convertida' e ligada à reclamação nova (reserva/cliente ligados pela matrícula).")) return;
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
                                if (!confirm("Converter em caso de Perdidos? A ocorrência fica fechada como 'Convertida' e ligada ao caso novo.")) return;
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

      {showCreate && <CreateIncidentDialog employees={employees} canSetDriver={isLeader} onClose={() => setShowCreate(false)} />}
      {selectedId && <ResolveDialog id={selectedId} onResolve={handleResolve} onClose={() => setSelectedId(null)} />}
      {editInc && <EditIncidentDialog incident={editInc} employees={employees} canSetDriver={isLeader} onClose={() => setEditInc(null)} />}
      {detailId && (
        <IncidentDetailDialog
          id={detailId}
          user={user}
          cities={cities}
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
function IncidentDetailDialog({ id, user, cities, employeeMap, onClose, onEdit }: {
  id: number; user: any; cities: { id: number; name: string }[]; employeeMap: Map<number, string>; onClose: () => void; onEdit: (inc: any) => void;
}) {
  const { data: inc, isLoading } = trpc.incidents.getById.useQuery({ id });
  const { data: peek } = trpc.incidents.bookingPeek.useQuery({ id });
  const utils = trpc.useUtils();
  const [note, setNote] = useState("");

  const invalidate = () => {
    utils.incidents.getById.invalidate({ id });
    utils.incidents.list.invalidate();
    utils.incidents.stats.invalidate();
    utils.incidents.dashboard.invalidate();
  };
  const confirmDriverMut = trpc.incidents.confirmDriver.useMutation({
    onSuccess: (_r, v) => { toast.success(v.confirmed ? "Envolvimento confirmado — conta na avaliação" : "Envolvimento retirado — não conta pontos"); invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const updateMut = trpc.incidents.update.useMutation({ onSuccess: invalidate });
  const addNoteMut = trpc.incidents.addNote.useMutation({
    onSuccess: () => { setNote(""); toast.success("Nota adicionada"); invalidate(); },
    onError: (e) => toast.error(e.message || "Erro ao adicionar nota"),
  });
  const toComplaintMut = trpc.incidents.convertToComplaint.useMutation({
    onSuccess: (r) => { toast.success(`Convertida na Reclamação #${r.newId}`); invalidate(); utils.complaints.list.invalidate(); onClose(); },
    onError: (e) => toast.error(e.message || "Erro ao mover"),
  });
  const toLostFoundMut = trpc.incidents.convertToLostFound.useMutation({
    onSuccess: (r) => { toast.success(`Convertida no Perdido #${r.newId}`); invalidate(); utils.lostFound.list.invalidate(); onClose(); },
    onError: (e) => toast.error(e.message || "Erro ao mover"),
  });

  if (isLoading || !inc) return null;
  const isAdmin = ["admin", "super_admin"].includes(user?.role ?? "") && inc.status !== "converted";
  const isLeader = roleRank(user?.role) >= roleRank("team_leader") && can(user, "ocorrencias", "edit");
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
            {inc.employeeId && (
              <div className="col-span-2 flex flex-wrap items-center gap-2">
                <span><User className="w-3 h-3 inline mr-1" />Condutor: <span className="font-medium text-foreground">{employeeMap.get(inc.employeeId) || `#${inc.employeeId}`}</span></span>
                {inc.driverConfirmed
                  ? <Badge className="bg-red-100 text-red-800">Envolvimento confirmado — conta pontos</Badge>
                  : <Badge variant="outline" className="text-amber-700 border-amber-300">Por confirmar — não conta pontos</Badge>}
                {isLeader && inc.status !== "converted" && inc.status !== "dismissed" && (
                  <Button size="sm" variant="outline" className="h-6 text-xs" disabled={confirmDriverMut.isPending}
                    onClick={() => confirmDriverMut.mutate({ id, confirmed: !inc.driverConfirmed })}>
                    {inc.driverConfirmed ? "Retirar confirmação" : "Confirmar envolvimento"}
                  </Button>
                )}
              </div>
            )}
            <div><Clock className="w-3 h-3 inline mr-1" />Criada: <span className="font-medium text-foreground">{fmtPTDateTime(inc.createdAt)}</span></div>
            {inc.dueAt && isOpenStatus(inc.status) && <div>Prazo: <span className={`font-medium ${Date.now() > utcMs(inc.dueAt) ? "text-red-600" : "text-foreground"}`}>{fmtPTDateTime(inc.dueAt)}</span></div>}
            {inc.costAmount != null && <div>Custo: <span className="font-medium text-foreground">{Number(inc.costAmount).toLocaleString("pt-PT", { style: "currency", currency: "EUR" })}</span></div>}
            <div className="flex items-center gap-1">Cidade: {inc.projectId != null
              ? <span className="font-medium text-foreground">{cities.find(c => c.id === inc.projectId)?.name ?? `#${inc.projectId}`}</span>
              : cities.length > 0 && inc.status !== "converted" ? <AssignCitySelect incidentId={inc.id} cities={cities} /> : <span className="text-red-600">Sem cidade</span>}</div>
            {inc.status === "converted" && inc.convertedToId && (
              <a className="text-violet-700 underline" href={inc.convertedToType === "complaint" ? `/reclamacoes?id=${inc.convertedToId}` : `/perdidos-achados/caso/${inc.convertedToId}`}>
                Convertida em {inc.convertedToType === "complaint" ? "Reclamação" : "Perdido"} #{inc.convertedToId}
              </a>
            )}
            {(inc as any).sourceEmailDate && <div>Email original: <span className="font-medium text-foreground">{fmtPTDateTime((inc as any).sourceEmailDate)}</span></div>}
            {(inc as any).reservationLink && (
              <button
                type="button"
                onClick={() => openInMultipark((inc as any).reservationLink)}
                className="text-blue-600 hover:underline text-left"
              >
                <ExternalLink className="w-3 h-3 inline mr-1" />Ver na Multipark
              </button>
            )}
            {(inc as any).gpsLatitude && (inc as any).gpsLongitude && (
              <a href={`https://www.google.com/maps?q=${(inc as any).gpsLatitude},${(inc as any).gpsLongitude}`} target="_blank" rel="noopener" className="text-blue-700 hover:underline"><MapPin className="w-3 h-3 inline mr-1" />Ver no mapa</a>
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
              <p className="text-[11px] text-muted-foreground">Ao mover para Reclamações/Perdidos, esta reserva e o cliente são ligados automaticamente.</p>
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
          {inc.status !== "converted" && <Button variant="outline" size="sm" onClick={() => onEdit(inc)}><Pencil className="w-4 h-4 mr-1" /> Editar</Button>}
          {openStates && (
            <Button size="sm" variant="outline" disabled={updateMut.isPending} title="Não é ocorrência / sem fundamento — não conta pontos"
              onClick={() => updateMut.mutate({ id, status: "dismissed" }, { onSuccess: () => { toast.success("Ocorrência descartada"); onClose(); } })}>
              Descartar
            </Button>
          )}
          {openStates && (
            <Button
              size="sm" className="bg-green-700 hover:bg-green-800 text-white"
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
              <Button size="sm" variant="outline" disabled={toComplaintMut.isPending} onClick={() => { if (confirm("Converter em Reclamação? A ocorrência fica fechada e ligada.")) toComplaintMut.mutate({ id }); }}>
                → Reclamações
              </Button>
              <Button size="sm" variant="outline" disabled={toLostFoundMut.isPending} onClick={() => { if (confirm("Converter em caso de Perdidos? A ocorrência fica fechada e ligada.")) toLostFoundMut.mutate({ id }); }}>
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

function CreateIncidentDialog({ employees, canSetDriver, onClose }: { employees: any[]; canSetDriver: boolean; onClose: () => void }) {
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
        // A reserva escolhida define a cidade e fica ligada à ocorrência.
        bookingRef: form.bookingRef || undefined,
        employeeId: canSetDriver && form.employeeId && form.employeeId !== "none" ? parseInt(form.employeeId) : undefined,
        incidentType: form.incidentType,
        severity: form.severity,
        description: form.description,
      });
      utils.incidents.list.invalidate();
      utils.incidents.stats.invalidate();
      utils.incidents.dashboard.invalidate();
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
            {canSetDriver && (
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
            )}
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

function EditIncidentDialog({ incident, employees, canSetDriver, onClose }: { incident: any; employees: any[]; canSetDriver: boolean; onClose: () => void }) {
  const [form, setForm] = useState({
    incidentType: incident.incidentType || "outro",
    severity: incident.severity || "medium",
    description: incident.description || "",
    vehiclePlate: incident.vehiclePlate || "",
    employeeId: incident.employeeId ? String(incident.employeeId) : "",
    status: incident.status || "open",
    costAmount: incident.costAmount != null ? String(incident.costAmount) : "",
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
        // Só team leader+ mexe no condutor (null = retirar); os outros não enviam.
        ...(canSetDriver ? {
          employeeId: form.employeeId && form.employeeId !== "none" ? parseInt(form.employeeId) : null,
          costAmount: form.costAmount === "" ? null : Number(form.costAmount),
        } : {}),
        status: form.status as EditableStatus,
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
                  {Object.entries(STATUS_CONFIG).filter(([k]) => k !== "converted").map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Matrícula</Label>
              <Input value={form.vehiclePlate} onChange={e => setForm(f => ({ ...f, vehiclePlate: e.target.value.toUpperCase() }))} placeholder="AA-00-BB" />
            </div>
            {canSetDriver && (
              <div>
                <Label>Custo (€)</Label>
                <Input type="number" min={0} step="0.01" value={form.costAmount} onChange={e => setForm(f => ({ ...f, costAmount: e.target.value }))} placeholder="0" />
              </div>
            )}
            {canSetDriver && <div className="col-span-2">
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
            </div>}
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

function utcMs(s: string): number {
  const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0) : new Date(s).getTime();
}

/** "Atribuir cidade" rápido a uma ocorrência sem cidade. */
function AssignCitySelect({ incidentId, cities }: { incidentId: number; cities: { id: number; name: string }[] }) {
  const utils = trpc.useUtils();
  const mut = trpc.incidents.update.useMutation({
    onSuccess: () => {
      toast.success("Cidade atribuída");
      utils.incidents.list.invalidate();
      utils.incidents.getById.invalidate({ id: incidentId });
      utils.incidents.dashboard.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Select onValueChange={(v) => mut.mutate({ id: incidentId, projectId: Number(v) })} disabled={mut.isPending}>
      <SelectTrigger className="h-8 w-36 text-xs"><SelectValue placeholder="Atribuir cidade" /></SelectTrigger>
      <SelectContent>
        {cities.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
