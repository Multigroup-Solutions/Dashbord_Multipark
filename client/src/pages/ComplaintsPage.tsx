import { trpc } from "@/lib/trpc";
import { openInMultipark } from "@/lib/multiparkLinks";
import { formatBookingHistoryDetails } from "@/lib/bookingHistoryFormat";
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
import ClientHistoryCard from "@/components/ClientHistoryCard";
import CaseAssignmentCard from "@/components/CaseAssignmentCard";
import LinkInboundEmailButton from "@/components/LinkInboundEmailButton";
import { useState, useMemo } from "react";
import {
  AlertTriangle, Plus, MessageSquare, Camera, Clock, User, Car,
  ChevronRight, ChevronLeft, Send, Eye, Trash2, Upload, Shield,
  BarChart3, AlertCircle, CheckCircle2, Hourglass, XCircle, Pencil,
  Mail, UserPlus, LinkIcon, X as XIcon, Download, RefreshCw, GripVertical, Package,
  ExternalLink,
} from "lucide-react";

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: any }> = {
  new: { label: "Novo", color: "bg-blue-100 text-blue-800 border-blue-200", icon: AlertCircle },
  analyzing: { label: "Em Análise", color: "bg-yellow-100 text-yellow-800 border-yellow-200", icon: Hourglass },
  waiting_client: { label: "Aguarda Cliente", color: "bg-purple-100 text-purple-800 border-purple-200", icon: Clock },
  resolved: { label: "Resolvido", color: "bg-green-100 text-green-800 border-green-200", icon: CheckCircle2 },
  closed: { label: "Fechado", color: "bg-gray-100 text-gray-800 border-gray-200", icon: XCircle },
};

const TYPE_CONFIG: Record<string, { label: string; emoji: string }> = {
  damage: { label: "Danos", emoji: "💥" },
  dirt: { label: "Sujidade", emoji: "🧽" },
  delay: { label: "Atraso", emoji: "⏰" },
  overcharge: { label: "Valor Incorreto", emoji: "💰" },
  staff: { label: "Funcionário", emoji: "👤" },
  other: { label: "Outro", emoji: "📋" },
};

const PRIORITY_CONFIG: Record<string, { label: string; color: string }> = {
  low: { label: "Baixa", color: "bg-slate-100 text-slate-700" },
  medium: { label: "Média", color: "bg-blue-100 text-blue-700" },
  high: { label: "Alta", color: "bg-orange-100 text-orange-700" },
  urgent: { label: "Urgente", color: "bg-red-100 text-red-700" },
};

const KANBAN_COLUMNS = ["new", "analyzing", "waiting_client", "resolved", "closed"] as const;

// driversInvolved é texto livre na BD; pode não ser JSON válido. Nunca deixar
// um parse rebentar a vista de detalhe inteira.
function parseDriversInvolved(raw: string | null | undefined): any[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Texto solto (ex.: "João, Maria") — mostra como um único nome.
    return raw.trim() ? [{ name: raw.trim() }] : [];
  }
}

export default function ComplaintsPage() {
  const { user } = useAuth();
  const [view, setView] = useState<"kanban" | "detail">("kanban");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [, setFilterProject] = useState<string>("all");
  const [showCreate, setShowCreate] = useState(false);
  const [filterType, setFilterType] = useState<string>("all");

  return (
    <>
      {view === "kanban" ? (
        <KanbanView
          user={user}
          filterType={filterType}
          setFilterType={setFilterType}
          onSelect={(id: number) => { setSelectedId(id); setView("detail"); }}
          onNew={() => setShowCreate(true)}
        />
      ) : selectedId ? (
        <DetailView
          id={selectedId}
          user={user}
          onBack={() => { setView("kanban"); setSelectedId(null); }}
        />
      ) : null}
      {showCreate && <CreateDialog user={user} onClose={() => setShowCreate(false)} />}
    </>
  );
}

// ─── KANBAN VIEW ──────────────────────────────────────────────────────────────

function KanbanView({ user, filterType, setFilterType, onSelect, onNew }: any) {
  const globalFilters = useGlobalFilters();
  const complaintsQueryInput = useMemo(() => {
    const input: any = {};
    if (filterType !== "all") input.type = filterType;
    if (globalFilters.projectId !== undefined) input.projectId = globalFilters.projectId;
    return input;
  }, [filterType, globalFilters.projectId]);
  const { data: complaints = [], isLoading } = trpc.complaints.list.useQuery(complaintsQueryInput);
  const { data: stats } = trpc.complaints.stats.useQuery(
    globalFilters.projectId !== undefined ? { projectId: globalFilters.projectId } : undefined
  );
  const updateMut = trpc.complaints.update.useMutation();
  const utils = trpc.useUtils();

  const grouped = useMemo(() => {
    const map: Record<string, any[]> = {};
    KANBAN_COLUMNS.forEach(s => map[s] = []);
    complaints.forEach((c: any) => {
      if (map[c.complaintStatus]) map[c.complaintStatus].push(c);
    });
    return map;
  }, [complaints]);

  // Optimistic: o cartão muda de coluna imediatamente; rollback se o servidor
  // recusar (mesmo padrão do kanban das Tarefas).
  const moveCard = async (id: number, newStatus: string) => {
    await utils.complaints.list.cancel(complaintsQueryInput);
    const prev = utils.complaints.list.getData(complaintsQueryInput);
    utils.complaints.list.setData(complaintsQueryInput, (old: any) =>
      old?.map((c: any) => (c.id === id ? { ...c, complaintStatus: newStatus } : c)),
    );
    try {
      await updateMut.mutateAsync({ id, status: newStatus as any });
      toast.success("Estado atualizado");
    } catch {
      utils.complaints.list.setData(complaintsQueryInput, prev);
      toast.error("Erro ao mover");
    } finally {
      utils.complaints.list.invalidate();
      utils.complaints.stats.invalidate();
    }
  };

  // Drag & drop nativo: arrastar um cartão para QUALQUER coluna (as setas nos
  // cartões ficam como alternativa para touch, onde o drag nativo não existe).
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap gap-2 items-center justify-between">
        <div>
          <p className="text-muted-foreground">Gestão de tickets e reclamações de clientes</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={complaints.length === 0}
            onClick={() => {
              const headers = ["ID","Título","Tipo","Estado","Prioridade","Cliente","Email","Telefone","Matrícula","Ref.Reserva","Criado","Resolvido","SLA","Atribuída a"];
              const rows = (complaints as any[]).map(c => [
                c.id,
                (c.title || "").replace(/;/g, ","),
                TYPE_CONFIG[c.complaintType]?.label ?? c.complaintType,
                STATUS_CONFIG[c.complaintStatus]?.label ?? c.complaintStatus,
                PRIORITY_CONFIG[c.complaintPriority]?.label ?? c.complaintPriority,
                (c.clientName ?? "").replace(/;/g, ","),
                (c.clientEmail ?? "").replace(/;/g, ","),
                c.clientPhone ?? "",
                c.vehiclePlate ?? "",
                c.reservationRef ?? "",
                c.createdAt ? new Date(c.createdAt).toISOString().slice(0, 10) : "",
                c.resolvedAt ? new Date(c.resolvedAt).toISOString().slice(0, 10) : "",
                c.slaDeadline ? new Date(c.slaDeadline).toISOString().slice(0, 10) : "",
                c.assignedToName ?? "",
              ]);
              const csv = [headers.join(";"), ...rows.map(r => r.join(";"))].join("\n");
              const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url; a.download = `reclamacoes_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
              URL.revokeObjectURL(url);
            }}
          >
            <Download className="w-4 h-4 mr-2" /> CSV
          </Button>
          <SyncEmailsButton />
          <Button onClick={onNew}><Plus className="w-4 h-4 mr-2" /> Nova Reclamação</Button>
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-7 gap-3">
          {[
            { label: "Total", value: stats.total, icon: BarChart3, color: "text-foreground" },
            { label: "Novos", value: stats.new, icon: AlertCircle, color: "text-blue-600" },
            { label: "Em Análise", value: stats.analyzing, icon: Hourglass, color: "text-yellow-600" },
            { label: "Aguarda Cliente", value: stats.waitingClient, icon: Clock, color: "text-purple-600" },
            { label: "Resolvidos", value: stats.resolved, icon: CheckCircle2, color: "text-green-600" },
            { label: "Fechados", value: stats.closed, icon: XCircle, color: "text-gray-600" },
            { label: "Em Atraso", value: stats.overdue, icon: AlertTriangle, color: "text-red-600" },
          ].map(s => (
            <Card key={s.label} className="p-3">
              <div className="flex items-center gap-2">
                <s.icon className={`w-4 h-4 ${s.color}`} />
                <span className="text-xs text-muted-foreground">{s.label}</span>
              </div>
              <p className={`text-xl font-bold mt-1 ${s.color}`}>{s.value}</p>
            </Card>
          ))}
        </div>
      )}

      {/* Type Tabs */}
      <div className="flex items-center gap-2 flex-wrap">
        <Button
          variant={filterType === "all" ? "default" : "outline"}
          size="sm"
          onClick={() => setFilterType("all")}
        >
          Todos
        </Button>
        {Object.entries(TYPE_CONFIG).map(([k, v]) => (
          <Button
            key={k}
            variant={filterType === k ? "default" : "outline"}
            size="sm"
            onClick={() => setFilterType(k)}
          >
            {v.emoji} {v.label}
          </Button>
        ))}
      </div>

      {/* Kanban Board */}
      {isLoading ? (
        <div className="flex justify-center py-20"><div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" /></div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
          {KANBAN_COLUMNS.map(status => {
            const cfg = STATUS_CONFIG[status];
            const items = grouped[status] || [];
            return (
              <div
                key={status}
                className={`space-y-3 rounded-lg transition-colors ${dragOverCol === status ? "ring-2 ring-primary/60 bg-primary/5" : ""}`}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dragOverCol !== status) setDragOverCol(status); }}
                onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverCol(null); }}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOverCol(null);
                  const id = Number(e.dataTransfer.getData("text/plain"));
                  if (id) moveCard(id, status);
                }}
              >
                <div className={`flex items-center gap-2 p-2 rounded-lg ${cfg.color} border`}>
                  <cfg.icon className="w-4 h-4" />
                  <span className="font-medium text-sm">{cfg.label}</span>
                  <Badge variant="secondary" className="ml-auto text-xs">{items.length}</Badge>
                </div>
                {/* div nativo: o ScrollArea (Radix) com max-h corta em vez de scrollar */}
                <div className="max-h-[60vh] overflow-y-auto">
                  <div className="space-y-2 pr-2">
                    {items.map((c: any) => (
                      <ComplaintCard
                        key={c.id}
                        complaint={c}
                        onSelect={() => onSelect(c.id)}
                        onMove={moveCard}
                        currentStatus={status}
                      />
                    ))}
                    {items.length === 0 && (
                      <p className="text-xs text-muted-foreground text-center py-8">Sem tickets</p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ComplaintCard({ complaint: c, onSelect, onMove, currentStatus }: any) {
  const isOverdue = c.slaDeadline && new Date(c.slaDeadline) < new Date() && c.complaintStatus !== "resolved" && c.complaintStatus !== "closed";
  const colIdx = KANBAN_COLUMNS.indexOf(currentStatus);
  const canMoveLeft = colIdx > 0;
  const canMoveRight = colIdx < KANBAN_COLUMNS.length - 1;

  return (
    <Card
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", String(c.id));
        e.dataTransfer.effectAllowed = "move";
        if (e.currentTarget instanceof HTMLElement) e.currentTarget.style.opacity = "0.5";
      }}
      onDragEnd={(e) => {
        if (e.currentTarget instanceof HTMLElement) e.currentTarget.style.opacity = "1";
      }}
      onClick={onSelect}
      className={`cursor-grab active:cursor-grabbing hover:shadow-md transition-shadow ${isOverdue ? "border-red-400 border-2" : ""}`}
    >
      <CardContent className="p-3 space-y-2">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-1.5 min-w-0">
            <GripVertical className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
            <span className="text-sm">{TYPE_CONFIG[c.complaintType]?.emoji}</span>
            <span className="font-medium text-sm line-clamp-1" onClick={onSelect}>{c.title}</span>
          </div>
          <Badge className={`text-[10px] ${PRIORITY_CONFIG[c.complaintPriority]?.color}`}>
            {PRIORITY_CONFIG[c.complaintPriority]?.label}
          </Badge>
        </div>

        {c.vehiclePlate && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Car className="w-3 h-3" /> {c.vehiclePlate}
          </div>
        )}

        {c.clientName && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground min-w-0">
            <User className="w-3 h-3 shrink-0" /> <span className="truncate">{c.clientName}</span>
          </div>
        )}

        {c.assignedToName && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground min-w-0">
            <UserPlus className="w-3 h-3 shrink-0" /> <span className="truncate">{c.assignedToName}</span>
          </div>
        )}

        {isOverdue && (
          <div className="flex items-center gap-1 text-xs text-red-600 font-medium">
            <AlertTriangle className="w-3 h-3" /> SLA ultrapassado
          </div>
        )}

        {c.slaDeadline && !isOverdue && c.complaintStatus !== "resolved" && c.complaintStatus !== "closed" && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="w-3 h-3" /> Prazo: {fmtPTDate(c.slaDeadline)}
          </div>
        )}

        <div className="flex items-center justify-between pt-1">
          <span className="text-[10px] text-muted-foreground">#{c.id}</span>
          <div className="flex gap-1">
            {canMoveLeft && (
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={(e) => { e.stopPropagation(); onMove(c.id, KANBAN_COLUMNS[colIdx - 1]); }}>
                <ChevronLeft className="w-3 h-3" />
              </Button>
            )}
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onSelect}>
              <Eye className="w-3 h-3" />
            </Button>
            {canMoveRight && (
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={(e) => { e.stopPropagation(); onMove(c.id, KANBAN_COLUMNS[colIdx + 1]); }}>
                <ChevronRight className="w-3 h-3" />
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── DETAIL VIEW ──────────────────────────────────────────────────────────────

const CHANGE_TYPE_CONFIG: Record<string, { label: string; color: string }> = {
  CREATED: { label: "Criada", color: "bg-blue-100 text-blue-800" },
  CHECKING_IN: { label: "A fazer check-in", color: "bg-cyan-100 text-cyan-800" },
  CHECK_IN: { label: "Check-in", color: "bg-green-100 text-green-800" },
  MOVEMENT: { label: "Movimento", color: "bg-amber-100 text-amber-800" },
  PENDING_CHECKOUT: { label: "Pend. Check-out", color: "bg-purple-100 text-purple-800" },
  CHECKING_OUT: { label: "A fazer check-out", color: "bg-indigo-100 text-indigo-800" },
  CHECK_OUT: { label: "Check-out", color: "bg-violet-100 text-violet-800" },
  ocorrencia: { label: "Ocorrência", color: "bg-red-100 text-red-800" },
};

function DetailView({ id, user, onBack }: { id: number; user: any; onBack: () => void }) {
  const { data, isLoading } = trpc.complaints.getById.useQuery({ id });
  const { data: vehicleHistory } = trpc.complaints.vehicleHistory.useQuery(
    { vehicleId: data?.complaint?.vehicleId ?? 0 },
    { enabled: !!data?.complaint?.vehicleId }
  );
  const { data: apiTimeline, isLoading: timelineLoading } = trpc.complaints.bookingTimeline.useQuery(
    { bookingId: data?.complaint?.reservationRef || "" },
    { enabled: !!data?.complaint?.reservationRef }
  );
  // Dossier completo da reserva ligada (detalhe + extras) — automático, sem
  // passos manuais.
  const { data: dossier } = trpc.complaints.bookingDossier.useQuery(
    { reservationRef: data?.complaint?.reservationRef || "" },
    { enabled: !!data?.complaint?.reservationRef }
  );
  const { data: vehicleAgents } = trpc.complaints.vehicleAgents.useQuery(
    { plate: data?.complaint?.vehiclePlate || "", currentBookingRef: data?.complaint?.reservationRef || undefined },
    { enabled: !!data?.complaint?.vehiclePlate && (data?.complaint?.vehiclePlate?.length ?? 0) >= 2 }
  );
  const refreshBookingMut = trpc.complaints.refreshBookingData.useMutation({
    onSuccess: (r) => {
      if (r.ok) {
        toast.success(r.detail);
        utils.complaints.bookingDossier.invalidate();
        utils.complaints.bookingTimeline.invalidate();
        utils.complaints.vehicleAgents.invalidate();
        utils.complaints.getById.invalidate({ id });
      } else {
        toast.error(r.detail);
      }
    },
    onError: () => toast.error("Erro ao contactar a API Multipark"),
  });
  const autoLinkMut = trpc.complaints.autoLink.useMutation({
    onSuccess: (r) => {
      if (r.linked) {
        toast.success(r.alreadyLinked ? "Dados completados a partir da reserva" : `Reserva ligada (${r.matchedBy.join(", ")})`);
        utils.complaints.getById.invalidate({ id });
      } else {
        toast.info("Nenhuma reserva encontrada com os dados do cliente");
      }
    },
    onError: () => toast.error("Erro ao procurar a reserva"),
  });
  const [showAllHist, setShowAllHist] = useState(false);
  const timelineHist = useMemo(() => {
    const mapped = (apiTimeline?.history || []).map((h: any) => ({
      id: h.id,
      changeType: h.changeType,
      actionDate: h.actionTime,
      userName: h.user?.firstName || h.agentName,
      userLastName: h.user?.lastName || "",
      parkName: h.booking?.parkName || "",
      remarks: h.remarks || h.modifiedFields || "",
    }));
    // Reclamações: por omissão esconde ações administrativas; "mostrar tudo"
    // revela também alterações de reserva/validações.
    const filtered = showAllHist ? mapped : filterBookingHistory(mapped, "complaint");
    return filtered
      .sort((a: any, b: any) => new Date(b.actionDate || 0).getTime() - new Date(a.actionDate || 0).getTime());
  }, [apiTimeline, showAllHist]);
  const { data: vehicles = [] } = trpc.operational.vehicles.list.useQuery();
  const { data: employees = [] } = trpc.rh.list.useQuery();
  const { data: projectsList = [] } = trpc.projects.list.useQuery();
  const updateMut = trpc.complaints.update.useMutation();
  const addMsgMut = trpc.complaints.addMessage.useMutation();
  const uploadPhotoMut = trpc.complaints.uploadPhoto.useMutation();
  const deletePhotoMut = trpc.complaints.deletePhoto.useMutation();
  const deleteMut = trpc.complaints.delete.useMutation({
    onSuccess: () => { toast.success("Reclamação eliminada"); utils.complaints.list.invalidate(); utils.complaints.stats.invalidate(); onBack(); },
    onError: (e) => toast.error(e.message || "Erro ao eliminar"),
  });
  const convertMut = trpc.complaints.convertToLostFound.useMutation({
    onSuccess: (r) => { toast.success(`Movida para os Perdidos & Achados (caso #${r.newId})`); utils.complaints.list.invalidate(); utils.lostFound.list.invalidate(); onBack(); },
    onError: (e) => toast.error(e.message || "Erro ao mover"),
  });
  const utils = trpc.useUtils();

  const [newMsg, setNewMsg] = useState("");
  const [isInternal, setIsInternal] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState<any>(null);

  if (isLoading || !data) return <div className="flex justify-center py-20"><div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" /></div>;

  const c = data.complaint;
  const isOverdue = c.slaDeadline && new Date(c.slaDeadline) < new Date() && c.complaintStatus !== "resolved" && c.complaintStatus !== "closed";
  const drivers = parseDriversInvolved(c.driversInvolved);

  const startEditing = () => {
    setEditForm({
      title: c.title || "",
      description: c.description || "",
      type: c.complaintType || "damage",
      priority: c.complaintPriority || "medium",
      clientName: c.clientName || "",
      clientEmail: c.clientEmail || "",
      clientPhone: c.clientPhone || "",
      vehiclePlate: c.vehiclePlate || "",
      reservationRef: c.reservationRef || "",
      clientNotes: c.clientNotes || "",
    });
    setIsEditing(true);
  };

  const handleSaveEdit = async () => {
    try {
      await updateMut.mutateAsync({
        id,
        title: editForm.title,
        description: editForm.description || undefined,
        type: editForm.type as any,
        priority: editForm.priority as any,
        clientName: editForm.clientName || undefined,
        clientEmail: editForm.clientEmail || undefined,
        clientPhone: editForm.clientPhone || undefined,
        vehiclePlate: editForm.vehiclePlate || null,
        reservationRef: editForm.reservationRef || null,
        clientNotes: editForm.clientNotes || null,
      });
      utils.complaints.getById.invalidate({ id });
      utils.complaints.list.invalidate();
      setIsEditing(false);
      toast.success("Reclamação atualizada");
    } catch { toast.error("Erro ao atualizar"); }
  };

  const handleStatusChange = async (status: string) => {
    await updateMut.mutateAsync({ id, status: status as any });
    utils.complaints.getById.invalidate({ id });
    utils.complaints.list.invalidate();
    utils.complaints.stats.invalidate();
    toast.success("Estado atualizado");
  };

  const handleSendMsg = async () => {
    if (!newMsg.trim()) return;
    await addMsgMut.mutateAsync({ complaintId: id, message: newMsg, isInternal });
    setNewMsg("");
    utils.complaints.getById.invalidate({ id });
    toast.success("Mensagem adicionada");
  };

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = (reader.result as string).split(",")[1];
      await uploadPhotoMut.mutateAsync({ complaintId: id, base64, filename: file.name });
      utils.complaints.getById.invalidate({ id });
      toast.success("Foto carregada");
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={onBack}><ChevronLeft className="w-4 h-4 mr-1" /> Voltar</Button>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-lg">{TYPE_CONFIG[c.complaintType]?.emoji}</span>
            <h1 className="text-xl font-bold break-words">{c.title}</h1>
            <Badge className={STATUS_CONFIG[c.complaintStatus]?.color}>{STATUS_CONFIG[c.complaintStatus]?.label}</Badge>
            <Badge className={PRIORITY_CONFIG[c.complaintPriority]?.color}>{PRIORITY_CONFIG[c.complaintPriority]?.label}</Badge>
            {isOverdue && <Badge className="bg-red-100 text-red-800">SLA Ultrapassado</Badge>}
            {(() => {
              // Nº de contactos do cliente = mensagens vindas de email (📧).
              const n = data.messages.filter((m: any) => typeof m.message === "string" && m.message.startsWith("📧")).length;
              return n > 1 ? <Badge className="bg-amber-100 text-amber-800">Cliente já contactou {n}×</Badge> : null;
            })()}
          </div>
          <p className="text-sm text-muted-foreground">
            Ticket #{c.id} — Criado em {fmtPTDate(c.createdAt)}
            {c.assignedToName ? ` — Atribuída a: ${c.assignedToName}` : " — Por atribuir"}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={startEditing}><Pencil className="w-4 h-4 mr-1" /> Editar</Button>
        <Select value={c.complaintStatus} onValueChange={handleStatusChange}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.entries(STATUS_CONFIG).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {["admin", "super_admin"].includes(user?.role) && (
          <>
            <Button
              variant="outline" size="sm"
              disabled={convertMut.isPending}
              title="Isto afinal é um Perdido/Achado — move o caso inteiro"
              onClick={() => {
                if (!confirm("Mover esta reclamação (com mensagens e fotos) para os Perdidos & Achados?")) return;
                convertMut.mutate({ id });
              }}
            >
              <Package className="w-4 h-4 mr-1" /> {convertMut.isPending ? "A mover…" : "Mover p/ Perdidos"}
            </Button>
            <Button
              variant="destructive" size="sm"
              disabled={deleteMut.isPending}
              onClick={() => {
                if (!confirm("Eliminar esta reclamação definitivamente?")) return;
                deleteMut.mutate({ id });
              }}
            >
              <Trash2 className="w-4 h-4 mr-1" /> Eliminar
            </Button>
          </>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Details */}
        <div className="lg:col-span-2 space-y-4">
          <Tabs defaultValue="details">
            <TabsList className="flex-wrap">
              <TabsTrigger value="details">Detalhes</TabsTrigger>
              <TabsTrigger value="messages">Mensagens ({data.messages.length})</TabsTrigger>
              <TabsTrigger value="photos">Fotos ({data.photos.length})</TabsTrigger>
              {(c.vehiclePlate || c.vehicleId) && <TabsTrigger value="vehicle">Viatura</TabsTrigger>}
              <TabsTrigger value="duty">Em serviço</TabsTrigger>
              <TabsTrigger value="booking-history">Histórico ({timelineHist.length})</TabsTrigger>
            </TabsList>

            <TabsContent value="details" className="space-y-4 mt-4">
              {c.description && (
                <Card>
                  <CardHeader><CardTitle className="text-sm">Descrição</CardTitle></CardHeader>
                  <CardContent><p className="text-sm whitespace-pre-wrap">{c.description}</p></CardContent>
                </Card>
              )}
              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <CardTitle className="text-sm">Dados da Reserva</CardTitle>
                  {!c.reservationRef ? (
                    <Button
                      size="sm" variant="outline"
                      disabled={autoLinkMut.isPending}
                      onClick={() => autoLinkMut.mutate({ id })}
                    >
                      <LinkIcon className="w-3.5 h-3.5 mr-1" />
                      {autoLinkMut.isPending ? "A procurar…" : "Ligar reserva automaticamente"}
                    </Button>
                  ) : (
                    <Button
                      size="sm" variant="outline"
                      disabled={refreshBookingMut.isPending}
                      title="Vai buscar à API Multipark a reserva completa e o histórico de condutores desta reserva"
                      onClick={() => refreshBookingMut.mutate({ reservationRef: c.reservationRef! })}
                    >
                      <RefreshCw className={`w-3.5 h-3.5 mr-1 ${refreshBookingMut.isPending ? "animate-spin" : ""}`} />
                      {refreshBookingMut.isPending ? "A atualizar…" : "Atualizar da API"}
                    </Button>
                  )}
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div><span className="text-muted-foreground">Ref. Reserva:</span> <span className="font-medium break-all">{c.reservationRef || "—"}</span></div>
                    <div><span className="text-muted-foreground">Matrícula:</span> <span className="font-medium">{c.vehiclePlate || "—"}</span></div>
                    <div><span className="text-muted-foreground">Início:</span> <span className="font-medium">{c.reservationStart ? fmtPTDate(c.reservationStart) : "—"}</span></div>
                    <div><span className="text-muted-foreground">Fim:</span> <span className="font-medium">{c.reservationEnd ? fmtPTDate(c.reservationEnd) : "—"}</span></div>
                  </div>
                  {dossier?.booking && (() => {
                    const b: any = dossier.booking;
                    const eur = (v: any) => v != null ? Number(v).toLocaleString("pt-PT", { style: "currency", currency: b.currency || "EUR" }) : "—";
                    return (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 border-t pt-3">
                        {b.externalId && (
                          <div className="sm:col-span-2">
                            <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => openInMultipark(b.bookingNumber || b.externalId)}>
                              Ver na Multipark <ExternalLink className="w-3 h-3" />
                            </Button>
                          </div>
                        )}
                        <div><span className="text-muted-foreground">Nº Reserva:</span> <span className="font-medium">#{b.bookingNumber || "—"}</span></div>
                        <div><span className="text-muted-foreground">Estado:</span> <span className="font-medium">{b.status || "—"}</span></div>
                        <div><span className="text-muted-foreground">Reservada em:</span> <span className="font-medium">{b.bookingCreatedAt ? fmtPTDateTime(b.bookingCreatedAt) : "—"}</span></div>
                        <div><span className="text-muted-foreground">Canal:</span> <span className="font-medium">{[b.origin, b.partnerName && b.partnerName !== "Unknown User" ? b.partnerName : null, b.campaignName].filter(Boolean).join(" · ") || "—"}</span></div>
                        <div><span className="text-muted-foreground">Parque:</span> <span className="font-medium">{b.parkName || "—"}{b.city ? ` (${b.city})` : ""}</span></div>
                        <div><span className="text-muted-foreground">Lugar:</span> <span className="font-medium">{[b.currentGarage, b.currentSpot].filter(Boolean).join(" / ") || "—"}</span></div>
                        <div><span className="text-muted-foreground">Entrada:</span> <span className="font-medium">{b.checkIn ? fmtPTDate(b.checkIn) : "—"}{b.checkInTime ? ` ${b.checkInTime}` : ""}{b.checkinAgentName ? ` · ${b.checkinAgentName}` : ""}</span></div>
                        <div><span className="text-muted-foreground">Saída:</span> <span className="font-medium">{b.checkOut ? fmtPTDate(b.checkOut) : "—"}{b.checkOutTime ? ` ${b.checkOutTime}` : ""}{b.checkoutAgentName ? ` · ${b.checkoutAgentName}` : ""}</span></div>
                        <div><span className="text-muted-foreground">Pagamento:</span> <span className="font-medium">{b.paymentMethod || "—"} · {eur(b.totalPrice)}{b.totalPaid != null ? ` (pago ${eur(b.totalPaid)})` : ""}</span></div>
                        <div><span className="text-muted-foreground">Por pagar:</span> <span className="font-medium">{b.remainingToPay != null && Number(b.remainingToPay) > 0 ? eur(b.remainingToPay) : "—"}</span></div>
                        {(b.deliveryType || b.deliveryAddress) && (
                          <div className="sm:col-span-2"><span className="text-muted-foreground">Entrega:</span> <span className="font-medium">{[b.deliveryType, b.deliveryAddress].filter(Boolean).join(" · ")}</span></div>
                        )}
                        {(b.arrivalFlight || b.departureFlight || b.returnFlight) && (
                          <div className="sm:col-span-2"><span className="text-muted-foreground">Voos:</span> <span className="font-medium">{[b.arrivalFlight, b.departureFlight, b.returnFlight].filter(Boolean).join(" · ")}</span></div>
                        )}
                        {(b.vehicleBrand || b.vehicleModel) && (
                          <div><span className="text-muted-foreground">Veículo:</span> <span className="font-medium">{[b.vehicleBrand, b.vehicleModel, b.vehicleColor].filter(Boolean).join(" ")}</span></div>
                        )}
                        {b.cancelledAt && (
                          <div className="sm:col-span-2 text-red-600"><span>Cancelada em {fmtPTDateTime(b.cancelledAt)}</span>{b.cancelReason ? ` — ${b.cancelReason}` : ""}</div>
                        )}
                        {b.remarks && (
                          <div className="sm:col-span-2 text-xs bg-muted/50 rounded p-2 whitespace-pre-wrap"><span className="text-muted-foreground">Observações: </span>{b.remarks}</div>
                        )}
                        {dossier.extras.length > 0 && (
                          <div className="sm:col-span-2">
                            <span className="text-muted-foreground">Extras:</span>{" "}
                            <span className="font-medium">{dossier.extras.map((e: any) => `${e.name}${e.price != null ? ` (${eur(e.price)})` : ""}`).join(", ")}</span>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                  {c.reservationRef && dossier && !dossier.booking && (
                    <p className="text-xs text-muted-foreground border-t pt-3">A ref. "{c.reservationRef}" não corresponde a nenhuma reserva na base de dados.</p>
                  )}
                </CardContent>
              </Card>
              {drivers.length > 0 && (
                <Card>
                  <CardHeader><CardTitle className="text-sm">Condutores Envolvidos</CardTitle></CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      {drivers.map((d: any, i: number) => (
                        <div key={i} className="flex items-center gap-2 text-sm p-2 bg-muted rounded">
                          <User className="w-4 h-4" />
                          <span className="font-medium">{d.name}</span>
                          {d.date && <span className="text-muted-foreground">— {d.date}</span>}
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            <TabsContent value="messages" className="mt-4">
              <Card>
                <CardContent className="p-4 space-y-4">
                  <CaseMessageList
                    messages={data.messages.map((m: any) => ({
                      id: m.id, author: m.authorName, createdAt: m.createdAt,
                      message: m.message, isInternal: m.isInternal,
                    }))}
                  />
                  <Separator />
                  <div className="space-y-2">
                    <Textarea placeholder="Escrever mensagem..." value={newMsg} onChange={e => setNewMsg(e.target.value)} rows={3} />
                    <div className="flex items-center justify-between">
                      <label className="flex items-center gap-2 text-sm cursor-pointer">
                        <input type="checkbox" checked={isInternal} onChange={e => setIsInternal(e.target.checked)} className="rounded" />
                        <Shield className="w-4 h-4 text-amber-600" /> Nota interna (não visível ao cliente)
                      </label>
                      <Button onClick={handleSendMsg} disabled={!newMsg.trim() || addMsgMut.isPending}>
                        <Send className="w-4 h-4 mr-2" /> Enviar
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="photos" className="mt-4">
              <Card>
                <CardContent className="p-4 space-y-4">
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {data.photos.map((p: any) => (
                      <div key={p.id} className="relative group">
                        <img src={fileHref(p.url, p.key) ?? undefined} alt={p.label || "Foto"} className="w-full h-40 object-cover rounded-lg" />
                        {p.label && <span className="absolute bottom-1 left-1 bg-black/60 text-white text-[10px] px-2 py-0.5 rounded">{p.label}</span>}
                        <Button
                          variant="destructive" size="icon"
                          className="absolute top-1 right-1 h-6 w-6 opacity-60 group-hover:opacity-100 transition-opacity"
                          onClick={async () => {
                            await deletePhotoMut.mutateAsync({ id: p.id });
                            utils.complaints.getById.invalidate({ id });
                            toast.success("Foto eliminada");
                          }}
                        ><Trash2 className="w-3 h-3" /></Button>
                      </div>
                    ))}
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Button variant="outline" asChild><span><Upload className="w-4 h-4 mr-2" /> Carregar Foto</span></Button>
                    <input type="file" accept="image/*" className="hidden" onChange={handlePhotoUpload} />
                  </label>
                </CardContent>
              </Card>
            </TabsContent>

            {(c.vehiclePlate || c.vehicleId) && (
              <TabsContent value="vehicle" className="mt-4 space-y-4">
                {c.vehiclePlate && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-sm">Quem mexeu no carro — {c.vehiclePlate}</CardTitle>
                      <p className="text-xs text-muted-foreground">Agentes Multipark com ações em reservas desta matrícula. Destacados os que tocaram na reserva desta reclamação.</p>
                    </CardHeader>
                    <CardContent>
                      {!vehicleAgents ? (
                        <div className="flex justify-center py-4"><div className="animate-spin w-5 h-5 border-2 border-primary border-t-transparent rounded-full" /></div>
                      ) : vehicleAgents.length === 0 ? (
                        <p className="text-sm text-muted-foreground">Sem histórico de agentes para esta matrícula na BD local.</p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full min-w-[520px] text-sm">
                            <thead>
                              <tr className="bg-muted/50 text-left">
                                <th className="p-2">Agente</th>
                                <th className="p-2 text-right">Ações</th>
                                <th className="p-2 text-right">Check-ins</th>
                                <th className="p-2 text-right">Check-outs</th>
                                <th className="p-2 text-right">Movimentos</th>
                                <th className="p-2">Última ação</th>
                              </tr>
                            </thead>
                            <tbody>
                              {vehicleAgents.map((a: any) => (
                                <tr key={a.agentName} className={`border-t ${a.flagged ? "bg-red-50 font-medium" : ""}`}>
                                  <td className="p-2">{a.agentName}{a.flagged ? " ⚑" : ""}</td>
                                  <td className="p-2 text-right">{a.actions}</td>
                                  <td className="p-2 text-right text-green-600">{a.checkins}</td>
                                  <td className="p-2 text-right text-violet-600">{a.checkouts}</td>
                                  <td className="p-2 text-right text-amber-600">{a.movements}</td>
                                  <td className="p-2 text-xs text-muted-foreground">{a.lastActionAt ? fmtPTDateTime(a.lastActionAt) : "—"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )}
                {c.vehicleId ? (
                <Card>
                  <CardHeader><CardTitle className="text-sm">Histórico da Viatura (frota interna)</CardTitle></CardHeader>
                  <CardContent>
                    {vehicleHistory && vehicleHistory.length > 0 ? (
                      <div className="space-y-2">
                        {vehicleHistory.map((h: any, i: number) => (
                          <div key={i} className="flex items-center gap-3 text-sm p-2 bg-muted rounded">
                            <Car className="w-4 h-4 text-muted-foreground" />
                            <span className="font-medium">{h.driverName || "Desconhecido"}</span>
                            <span className="text-muted-foreground">
                              {fmtPTDateTime(h.startTime)}
                              {h.endTime && ` → ${fmtPTDateTime(h.endTime)}`}
                            </span>
                            {h.startKm && <span className="text-xs text-muted-foreground ml-auto">{h.startKm} km</span>}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-muted-foreground text-sm">Sem histórico de movimentos para esta viatura.</p>
                    )}
                  </CardContent>
                </Card>
                ) : null}
              </TabsContent>
            )}

            <TabsContent value="duty" className="mt-4">
              <DutyDriversPanel complaintId={id} penaltyPoints={c.penaltyPoints ?? 0} onPenaltyChange={async (v) => {
                await updateMut.mutateAsync({ id, penaltyPoints: v });
                utils.complaints.getById.invalidate({ id });
              }} />
            </TabsContent>

            <TabsContent value="booking-history" className="mt-4">
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Clock className="w-4 h-4" /> Histórico da Reserva {c.reservationRef ? `— ${c.reservationRef}` : ""}
                    </CardTitle>
                    <Button size="sm" variant={showAllHist ? "default" : "outline"} onClick={() => setShowAllHist(v => !v)}>
                      {showAllHist ? "A mostrar tudo" : "Mostrar tudo"}
                    </Button>
                  </CardHeader>
                  <CardContent>
                    {!c.reservationRef ? (
                      <p className="text-sm text-muted-foreground">Sem ID de reserva associado a esta reclamação.</p>
                    ) : timelineLoading ? (
                      <div className="flex justify-center py-6"><div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" /></div>
                    ) : timelineHist.length === 0 ? (
                      <p className="text-sm text-muted-foreground">Sem histórico para esta reserva{showAllHist ? "" : " (experimenta \"Mostrar tudo\")"}.</p>
                    ) : (
                      <div className="relative pl-6 space-y-0">
                        {timelineHist.map((h: any, i: number) => {
                          const cfg = CHANGE_TYPE_CONFIG[h.changeType] || { label: h.changeType, color: "bg-gray-100 text-gray-800" };
                          return (
                            <div key={h.id} className="relative pb-4">
                              {i < timelineHist.length - 1 && (
                                <div className="absolute left-[-16px] top-3 bottom-0 w-px bg-border" />
                              )}
                              <div className="absolute left-[-20px] top-1.5 w-2 h-2 rounded-full bg-primary ring-2 ring-background" />
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <Badge className={cfg.color}>{cfg.label}</Badge>
                                    <span className="font-medium text-sm">{h.userName ? `${h.userName} ${h.userLastName || ""}`.trim() : "Sistema"}</span>
                                  </div>
                                  {h.parkName && <p className="text-xs text-muted-foreground mt-1">Parque: {h.parkName}</p>}
                                  {(() => {
                                    const lines = formatBookingHistoryDetails(h.remarks);
                                    if (!lines.length) return null;
                                    return (
                                      <ul className="text-xs text-muted-foreground mt-0.5 space-y-0.5">
                                        {lines.map((l: string, li: number) => <li key={li}>{l}</li>)}
                                      </ul>
                                    );
                                  })()}
                                </div>
                                <span className="text-xs text-muted-foreground whitespace-nowrap">
                                  {h.actionDate ? fmtPTDateTime(h.actionDate) : "—"}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
          </Tabs>
        </div>

        {/* Right: Client + SLA info */}
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-sm">Cliente</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="break-words"><span className="text-muted-foreground">Nome:</span> <span className="font-medium">{c.clientName || "—"}</span></div>
              <div className="break-all"><span className="text-muted-foreground">Email:</span> <span className="font-medium">{c.clientEmail || "—"}</span></div>
              <div className="break-words"><span className="text-muted-foreground">Telefone:</span> <span className="font-medium">{c.clientPhone || "—"}</span></div>
              {c.clientNotes && (
                <div className="text-xs bg-muted/50 rounded p-2 whitespace-pre-wrap"><span className="text-muted-foreground">Notas: </span>{c.clientNotes}</div>
              )}
              <SendClientEmailButton
                complaintId={id}
                clientEmail={c.clientEmail}
                clientName={c.clientName}
                complaintTitle={c.title}
                lastSentAt={c.clientEmailSentAt}
              />
              <LinkInboundEmailButton
                module="complaint" alias="reclamacoes" caseId={id}
                defaultSearch={c.clientEmail || c.clientName}
                onLinked={() => utils.complaints.getById.invalidate({ id })}
              />
            </CardContent>
          </Card>

          <CaseAssignmentCard
            projectId={c.projectId}
            assigneeId={c.assignedToId}
            dueDate={c.dueDate}
            closedAt={c.closedAt}
            projects={(projectsList as any[]).map(p => ({ id: p.id, name: p.name }))}
            people={(employees as any[]).map(e => e.employee ?? e).map((e: any) => ({ id: e.id, fullName: e.fullName }))}
            saving={updateMut.isPending}
            onSave={(patch) => updateMut.mutate({
              id, projectId: patch.projectId, assignedToId: patch.assigneeId,
              investigatedById: patch.assigneeId, dueDate: patch.dueDate,
            } as any, { onSuccess: () => { utils.complaints.getById.invalidate({ id }); toast.success("Atribuição guardada"); } })}
          />

          <ClientHistoryCard
            email={c.clientEmail}
            phone={c.clientPhone}
            plate={c.vehiclePlate}
            name={c.clientName}
            highlightRef={c.reservationRef}
          />

          {/* Edit Dialog */}
          <Dialog open={isEditing} onOpenChange={setIsEditing}>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader><DialogTitle>Editar Reclamação</DialogTitle></DialogHeader>
              {editForm && (
                <div className="space-y-4">
                  <div><Label>Título</Label><Input value={editForm.title} onChange={e => setEditForm((f: any) => ({ ...f, title: e.target.value }))} /></div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <Label>Tipo</Label>
                      <Select value={editForm.type} onValueChange={v => setEditForm((f: any) => ({ ...f, type: v }))}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {Object.entries(TYPE_CONFIG).map(([k, v]) => (
                            <SelectItem key={k} value={k}>{v.emoji} {v.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label>Prioridade</Label>
                      <Select value={editForm.priority} onValueChange={v => setEditForm((f: any) => ({ ...f, priority: v }))}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {Object.entries(PRIORITY_CONFIG).map(([k, v]) => (
                            <SelectItem key={k} value={k}>{v.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div><Label>Descrição</Label><Textarea value={editForm.description} onChange={e => setEditForm((f: any) => ({ ...f, description: e.target.value }))} rows={3} /></div>
                  <Separator />
                  <div><Label>Nome do Cliente</Label><Input value={editForm.clientName} onChange={e => setEditForm((f: any) => ({ ...f, clientName: e.target.value }))} /></div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div><Label>Email</Label><Input value={editForm.clientEmail} onChange={e => setEditForm((f: any) => ({ ...f, clientEmail: e.target.value }))} /></div>
                    <div><Label>Telefone</Label><Input value={editForm.clientPhone} onChange={e => setEditForm((f: any) => ({ ...f, clientPhone: e.target.value }))} /></div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div><Label>Matrícula</Label><Input value={editForm.vehiclePlate} onChange={e => setEditForm((f: any) => ({ ...f, vehiclePlate: e.target.value }))} /></div>
                    <div><Label>Ref. Reserva</Label><Input value={editForm.reservationRef} onChange={e => setEditForm((f: any) => ({ ...f, reservationRef: e.target.value }))} /></div>
                  </div>
                  <EditBookingPicker
                    onPick={(b: any) => setEditForm((f: any) => ({
                      ...f,
                      reservationRef: b.externalId || b.bookingNumber || f.reservationRef,
                      vehiclePlate: b.licensePlate || f.vehiclePlate,
                      clientName: f.clientName || [b.clientFirstName, b.clientLastName].filter(Boolean).join(" "),
                      clientEmail: f.clientEmail || b.clientEmail || "",
                      clientPhone: f.clientPhone || b.clientPhone || "",
                    }))}
                  />
                  <div><Label>Notas / dados adicionais do cliente</Label><Textarea value={editForm.clientNotes} onChange={e => setEditForm((f: any) => ({ ...f, clientNotes: e.target.value }))} rows={3} placeholder="Ex: 2º contacto, NIF, morada, indicações do cliente…" /></div>
                </div>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsEditing(false)}>Cancelar</Button>
                <Button onClick={handleSaveEdit} disabled={updateMut.isPending}>Guardar</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Card>
            <CardHeader><CardTitle className="text-sm">SLA</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              {c.slaDeadline ? (
                <>
                  <div className={`flex items-center gap-2 ${isOverdue ? "text-red-600 font-bold" : "text-foreground"}`}>
                    <Clock className="w-4 h-4" />
                    Prazo: {fmtPTDateTime(c.slaDeadline)}
                  </div>
                  {isOverdue && <p className="text-red-600 text-xs">O prazo de resposta foi ultrapassado!</p>}
                </>
              ) : (
                <p className="text-muted-foreground">Sem prazo definido</p>
              )}
              {c.resolvedAt && (
                <div className="flex items-center gap-2 text-green-600">
                  <CheckCircle2 className="w-4 h-4" />
                  Resolvido em: {fmtPTDateTime(c.resolvedAt)}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-sm">Tipo</CardTitle></CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <span className="text-2xl">{TYPE_CONFIG[c.complaintType]?.emoji}</span>
                <span className="font-medium">{TYPE_CONFIG[c.complaintType]?.label}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ─── RESERVATION PREVIEW (auto-fetches timeline from API) ────────────────────

function ReservationPreview({ bookingId }: { bookingId: string }) {
  const { data, isLoading } = trpc.complaints.bookingTimeline.useQuery(
    { bookingId },
    { enabled: bookingId.length >= 4 }
  );

  if (!bookingId || bookingId.length < 4) return null;

  if (isLoading) {
    return <p className="text-xs text-muted-foreground mt-2 animate-pulse">A carregar histórico da API...</p>;
  }

  const history = data?.history || [];

  if (history.length === 0) {
    return <p className="text-xs text-amber-600 mt-2">Nenhum histórico encontrado para este ID.</p>;
  }

  return (
    <div className="mt-2 max-h-40 overflow-y-auto space-y-1 border rounded p-2 bg-white dark:bg-gray-900">
      <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">{history.length} eventos encontrados</p>
      {history.slice(0, 10).map((h: any) => {
        const cfg = CHANGE_TYPE_CONFIG[h.changeType] || { label: h.changeType, color: "bg-gray-100 text-gray-800" };
        return (
          <div key={h.id} className="flex items-center justify-between text-xs p-1.5 rounded bg-muted">
            <div className="flex items-center gap-1.5">
              <Badge className={`${cfg.color} text-[10px] px-1`}>{cfg.label}</Badge>
              <span>{h.user?.firstName || h.agentName || "Sistema"} {h.user?.lastName || ""}</span>
            </div>
            <span className="text-muted-foreground">{h.actionTime ? fmtPTDateTime(h.actionTime) : "—"}</span>
          </div>
        );
      })}
      {history.length > 10 && <p className="text-xs text-muted-foreground">... e mais {history.length - 10} eventos</p>}
    </div>
  );
}

// ─── CREATE DIALOG ────────────────────────────────────────────────────────────

function CreateDialog({ user, onClose }: { user: any; onClose: () => void }) {
  const { data: vehicles = [] } = trpc.operational.vehicles.list.useQuery();
  const { data: emps = [] } = trpc.rh.list.useQuery();
  const { data: projs = [] } = trpc.projects.list.useQuery();
  const createMut = trpc.complaints.create.useMutation();
  const utils = trpc.useUtils();
  const [form, setForm] = useState({
    title: "", description: "", type: "damage" as string, priority: "medium" as string,
    clientName: "", clientEmail: "", clientPhone: "", reservationRef: "",
    reservationStart: "", reservationEnd: "",
    vehicleId: "", vehiclePlate: "", slaHours: "48",
    projectId: "", assignedToId: "",
  });

  // Booking search
  const [bookingSearch, setBookingSearch] = useState("");
  const [loadingDetails, setLoadingDetails] = useState(false);
  const { data: foundBookings = [] } = trpc.complaints.searchBooking.useQuery(
    { search: bookingSearch },
    { enabled: bookingSearch.length >= 2 }
  );
  const detailsQuery = trpc.complaints.fetchBookingDetails;

  const fillFromBooking = async (b: any) => {
    // First fill what we have from local DB
    setForm(f => ({
      ...f,
      reservationRef: b.externalId || b.bookingNumber || f.reservationRef,
      reservationStart: b.checkIn ? b.checkIn.slice(0, 10) : f.reservationStart,
      reservationEnd: b.checkOut ? b.checkOut.slice(0, 10) : f.reservationEnd,
      projectId: b.projectId ? String(b.projectId) : f.projectId,
      clientName: [b.clientFirstName, b.clientLastName].filter(Boolean).join(" ") || f.clientName,
      clientEmail: b.clientEmail || f.clientEmail,
      clientPhone: b.clientPhone || f.clientPhone,
      vehiclePlate: b.licensePlate || f.vehiclePlate,
    }));

    // Then try to fetch full details from API (has client data + vehicle)
    if (b.externalId) {
      setLoadingDetails(true);
      try {
        const details = await utils.complaints.fetchBookingDetails.fetch({ externalId: b.externalId });
        if (details) {
          const client = details.customer || details.client;
          setForm(f => ({
            ...f,
            clientName: [client?.firstName, client?.lastName].filter(Boolean).join(" ") || f.clientName,
            clientEmail: client?.email || f.clientEmail,
            clientPhone: client?.phoneNumber || f.clientPhone,
            vehiclePlate: details.vehicle?.licensePlate || f.vehiclePlate,
            title: f.title || `Reclamação — ${details.vehicle?.licensePlate || ""} — ${b.bookingNumber || ""}`.trim(),
          }));
        }
      } catch { /* API might not return details for all bookings */ }
      setLoadingDetails(false);
    }

    toast.success("Dados da reserva preenchidos");
  };

  // Email upload parser
  const handleEmailUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();

    // Parse email headers and body
    const fromMatch = text.match(/^From:\s*(.+)$/im);
    const subjectMatch = text.match(/^Subject:\s*(.+)$/im);
    const dateMatch = text.match(/^Date:\s*(.+)$/im);

    // Extract email address from From header
    const emailMatch = fromMatch?.[1]?.match(/<([^>]+)>/) || fromMatch?.[1]?.match(/([\w.+-]+@[\w.-]+)/);
    const nameMatch = fromMatch?.[1]?.match(/^"?([^"<]+)"?\s*</);

    // Extract body (after empty line separating headers from body)
    const bodyStart = text.indexOf("\n\n");
    let body = bodyStart > 0 ? text.slice(bodyStart + 2).trim() : "";
    // Strip HTML if present
    if (body.includes("<html") || body.includes("<HTML")) {
      body = body.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    }
    // Truncate long bodies
    if (body.length > 2000) body = body.slice(0, 2000) + "...";

    // Look for plate patterns in body (AA-00-BB, AA00BB, 00-AA-00)
    const plateMatch = body.match(/\b([A-Z]{2}[-\s]?\d{2}[-\s]?[A-Z]{2}|\d{2}[-\s]?[A-Z]{2}[-\s]?\d{2}|[A-Z]{2}[-\s]?\d{2}[-\s]?\d{2})\b/i);
    // Look for booking number patterns
    const bookingMatch = body.match(/(?:reserva|booking|nº|ref)[:\s#]*(\d{4,6})/i);

    setForm(f => ({
      ...f,
      clientEmail: emailMatch?.[1] || f.clientEmail,
      clientName: nameMatch?.[1]?.trim() || f.clientName,
      title: f.title || subjectMatch?.[1]?.trim() || "",
      description: body ? (f.description ? f.description + "\n\n--- Email ---\n" + body : body) : f.description,
      vehiclePlate: plateMatch?.[1]?.toUpperCase() || f.vehiclePlate,
      reservationRef: bookingMatch?.[1] || f.reservationRef,
    }));

    // If we found a booking number, also search for it
    if (bookingMatch?.[1]) {
      setBookingSearch(bookingMatch[1]);
    }

    toast.success("Email importado — verifica os dados");
    e.target.value = "";
  };

  const employees = emps.map((e: any) => e.employee ?? e);

  const handleVehicleChange = (val: string) => {
    const v = vehicles.find((v: any) => String(v.id) === val);
    setForm(f => ({ ...f, vehicleId: val, vehiclePlate: v?.plate || "" }));
  };

  const handleSubmit = async () => {
    if (!form.title) { toast.error("Título obrigatório"); return; }
    // ID da reserva deixou de ser obrigatório: com matrícula/email/telefone/
    // nome o servidor liga a reserva automaticamente ao criar.
    if (!form.reservationRef && !form.vehiclePlate && !form.clientEmail && !form.clientPhone && !form.clientName) {
      toast.error("Indica pelo menos um dado do cliente (reserva, matrícula, email, telefone ou nome)");
      return;
    }
    try {
      await createMut.mutateAsync({
        title: form.title,
        description: form.description || undefined,
        type: form.type as any,
        priority: form.priority as any,
        clientName: form.clientName || undefined,
        clientEmail: form.clientEmail || undefined,
        clientPhone: form.clientPhone || undefined,
        reservationRef: form.reservationRef || undefined,
        reservationStart: form.reservationStart || undefined,
        reservationEnd: form.reservationEnd || undefined,
        vehicleId: form.vehicleId ? Number(form.vehicleId) : undefined,
        vehiclePlate: form.vehiclePlate || undefined,
        slaHours: form.slaHours ? Number(form.slaHours) : undefined,
        projectId: form.projectId ? Number(form.projectId) : undefined,
        assignedToId: form.assignedToId ? Number(form.assignedToId) : undefined,
      });
      utils.complaints.list.invalidate();
      utils.complaints.stats.invalidate();
      toast.success("Reclamação criada");
      onClose();
    } catch { toast.error("Erro ao criar reclamação"); }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Nova Reclamação</DialogTitle></DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Email import */}
          <div className="col-span-2 p-3 bg-amber-50 dark:bg-amber-950/30 rounded-lg border border-amber-200">
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-amber-700 dark:text-amber-300 font-medium">Importar email do cliente</Label>
                <p className="text-xs text-muted-foreground">Carrega o ficheiro .eml ou .txt — preenche automaticamente nome, email, assunto, matrícula e nº reserva</p>
              </div>
              <label>
                <input type="file" accept=".eml,.txt,.msg" className="hidden" onChange={handleEmailUpload} />
                <Button variant="outline" size="sm" asChild><span><Upload className="w-4 h-4 mr-1" />Carregar Email</span></Button>
              </label>
            </div>
          </div>

          {/* Booking search */}
          <div className="col-span-2 p-3 bg-blue-50 dark:bg-blue-950/30 rounded-lg border border-blue-200">
            <Label className="text-blue-700 dark:text-blue-300 font-medium">Buscar reserva (nº reserva, matrícula, email, nome)</Label>
            <div className="flex items-center gap-2 mt-1">
              <Input
                placeholder="Ex: 15413 ou AA-00-BB ou nome..."
                value={bookingSearch}
                onChange={e => setBookingSearch(e.target.value)}
                className="flex-1"
              />
              {loadingDetails && <span className="text-xs text-muted-foreground animate-pulse">A carregar detalhes...</span>}
            </div>
            {foundBookings.length > 0 && (
              <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
                {foundBookings.map((b: any) => (
                  <div
                    key={b.id}
                    className="flex items-center justify-between p-2 bg-white dark:bg-gray-900 rounded border cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/30"
                    onClick={() => fillFromBooking(b)}
                  >
                    <div className="text-sm">
                      <span className="font-mono font-medium">#{b.bookingNumber}</span>
                      {b.licensePlate && <span className="font-mono ml-2">{b.licensePlate}</span>}
                      {(b.clientFirstName || b.clientLastName) && <span className="text-muted-foreground ml-2">{b.clientFirstName} {b.clientLastName}</span>}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {b.parkName} {b.city && !b.parkName?.includes(b.city) ? b.city : ""}
                      {b.checkIn && <span className="ml-2">{fmtPTDate(b.checkIn)}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {bookingSearch.length >= 2 && foundBookings.length === 0 && (
              <p className="text-xs text-muted-foreground mt-1">Nenhuma reserva encontrada</p>
            )}
          </div>

          <div className="col-span-2">
            <Label>Título *</Label>
            <Input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="Descrição breve da reclamação" />
          </div>
          <div>
            <Label>Tipo</Label>
            <Select value={form.type} onValueChange={v => setForm(f => ({ ...f, type: v }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(TYPE_CONFIG).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v.emoji} {v.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Prioridade</Label>
            <Select value={form.priority} onValueChange={v => setForm(f => ({ ...f, priority: v }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(PRIORITY_CONFIG).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-2">
            <Label>Descrição</Label>
            <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={3} />
          </div>
          <Separator className="col-span-2" />
          {/* Reservation ID — highlighted */}
          <div className="col-span-2 p-3 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg border border-emerald-200">
            <Label className="text-emerald-700 dark:text-emerald-300 font-medium">ID da Reserva (Multipark) *</Label>
            <p className="text-xs text-muted-foreground mb-1">O histórico completo é carregado automaticamente da API</p>
            <Input
              value={form.reservationRef}
              onChange={e => setForm(f => ({ ...f, reservationRef: e.target.value }))}
              placeholder="Ex: 6789abc..."
              className="font-mono"
            />
            <ReservationPreview bookingId={form.reservationRef} />
          </div>
          <div><Label>Nome do Cliente</Label><Input value={form.clientName} onChange={e => setForm(f => ({ ...f, clientName: e.target.value }))} /></div>
          <div><Label>Email</Label><Input type="email" value={form.clientEmail} onChange={e => setForm(f => ({ ...f, clientEmail: e.target.value }))} /></div>
          <div><Label>Telefone</Label><Input value={form.clientPhone} onChange={e => setForm(f => ({ ...f, clientPhone: e.target.value }))} /></div>
          <div><Label>Matrícula</Label><Input value={form.vehiclePlate} onChange={e => setForm(f => ({ ...f, vehiclePlate: e.target.value }))} /></div>
          <div><Label>Início Reserva</Label><Input type="date" value={form.reservationStart} onChange={e => setForm(f => ({ ...f, reservationStart: e.target.value }))} /></div>
          <div><Label>Fim Reserva</Label><Input type="date" value={form.reservationEnd} onChange={e => setForm(f => ({ ...f, reservationEnd: e.target.value }))} /></div>
          <Separator className="col-span-2" />
          <div>
            <Label>Viatura (interna)</Label>
            <Select value={form.vehicleId} onValueChange={handleVehicleChange}>
              <SelectTrigger><SelectValue placeholder="Opcional" /></SelectTrigger>
              <SelectContent>
                {vehicles.map((v: any) => (
                  <SelectItem key={v.id} value={String(v.id)}>{v.plate} — {v.brand} {v.model}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Projeto</Label>
            <Select value={form.projectId} onValueChange={v => setForm(f => ({ ...f, projectId: v }))}>
              <SelectTrigger><SelectValue placeholder="Selecionar projeto" /></SelectTrigger>
              <SelectContent>
                {projs.map((p: any) => (
                  <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Atribuir a</Label>
            <Select value={form.assignedToId} onValueChange={v => setForm(f => ({ ...f, assignedToId: v }))}>
              <SelectTrigger><SelectValue placeholder="Selecionar responsável" /></SelectTrigger>
              <SelectContent>
                {employees.map((e: any) => (
                  <SelectItem key={e.id} value={String(e.id)}>{e.fullName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Prazo SLA (horas)</Label>
            <Input type="number" value={form.slaHours} onChange={e => setForm(f => ({ ...f, slaHours: e.target.value }))} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={handleSubmit} disabled={createMut.isPending}>
            {createMut.isPending ? "A criar..." : "Criar Reclamação"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Panel: Condutores em serviço (Duty) ───────────────────────────────────
function DutyDriversPanel({
  complaintId,
  penaltyPoints,
  onPenaltyChange,
}: {
  complaintId: number;
  penaltyPoints: number;
  onPenaltyChange: (v: number) => Promise<void>;
}) {
  const utils = trpc.useUtils();
  const candidatesQ = trpc.complaints.findDriversOnDuty.useQuery({ complaintId });
  const attachedQ = trpc.complaints.listAttachedDrivers.useQuery({ complaintId });
  const penaltyConfigQ = trpc.complaints.listPenaltyConfig.useQuery();
  const attachMut = trpc.complaints.attachDriver.useMutation({
    onSuccess: () => {
      utils.complaints.listAttachedDrivers.invalidate({ complaintId });
      utils.complaints.findDriversOnDuty.invalidate({ complaintId });
      toast.success("Condutor associado");
    },
  });
  const detachMut = trpc.complaints.detachDriver.useMutation({
    onSuccess: () => {
      utils.complaints.listAttachedDrivers.invalidate({ complaintId });
      utils.complaints.findDriversOnDuty.invalidate({ complaintId });
    },
  });

  const [pendingPenalty, setPendingPenalty] = useState<number>(penaltyPoints);
  const [savingPenalty, setSavingPenalty] = useState(false);

  const handleAttach = (d: any) => {
    attachMut.mutate({
      complaintId,
      employeeId: d.employeeId,
      employeeName: d.employeeName,
      roleAtTime: d.roleAtTime,
      source: d.source,
      notes: d.notes,
    });
  };

  const handleSavePenalty = async () => {
    setSavingPenalty(true);
    try {
      await onPenaltyChange(pendingPenalty);
      toast.success("Pontos atualizados");
    } catch { toast.error("Erro ao guardar"); }
    finally { setSavingPenalty(false); }
  };

  return (
    <div className="space-y-4">
      {/* Pontos de penalização */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" /> Pontos de penalização
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Label className="text-xs">Pontos aplicados a esta reclamação</Label>
              <Input
                type="number"
                value={pendingPenalty}
                onChange={(e) => setPendingPenalty(Number(e.target.value))}
              />
            </div>
            <Button onClick={handleSavePenalty} disabled={savingPenalty}>
              {savingPenalty ? "A guardar..." : "Guardar"}
            </Button>
          </div>
          {penaltyConfigQ.data && penaltyConfigQ.data.length > 0 && (
            <div className="text-xs text-muted-foreground">
              <p className="font-medium mb-1">Tabela base por tipo:</p>
              <div className="flex flex-wrap gap-1">
                {penaltyConfigQ.data.map((p: any) => (
                  <Badge key={p.id} variant="outline" className="text-[10px]">
                    {p.complaintType}: {p.basePoints}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Condutores associados */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <LinkIcon className="w-4 h-4" /> Associados à reclamação ({attachedQ.data?.length ?? 0})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {attachedQ.isLoading ? (
            <p className="text-xs text-muted-foreground">A carregar...</p>
          ) : (attachedQ.data?.length ?? 0) === 0 ? (
            <p className="text-xs text-muted-foreground">Nenhum condutor associado ainda.</p>
          ) : (
            <div className="space-y-2">
              {attachedQ.data!.map((d: any) => (
                <div key={d.id} className="flex items-center gap-2 text-sm p-2 bg-muted rounded min-w-0">
                  <User className="w-4 h-4 shrink-0" />
                  <span className="font-medium truncate">{d.employeeName}</span>
                  {d.roleAtTime && <Badge variant="outline" className="text-[10px]">{d.roleAtTime}</Badge>}
                  <Badge variant="outline" className="text-[10px]">{d.source}</Badge>
                  {d.notes && <span className="text-xs text-muted-foreground">— {d.notes}</span>}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="ml-auto h-6 w-6"
                    onClick={() => detachMut.mutate({ id: d.id })}
                  >
                    <XIcon className="w-3 h-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Candidatos sugeridos (cruzamento) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <UserPlus className="w-4 h-4" /> Sugeridos por cruzamento
          </CardTitle>
        </CardHeader>
        <CardContent>
          {candidatesQ.isLoading ? (
            <p className="text-xs text-muted-foreground">A pesquisar...</p>
          ) : (candidatesQ.data?.length ?? 0) === 0 ? (
            <p className="text-xs text-muted-foreground">
              Sem candidatos. (Necessita de Ref. de reserva ou datas de reserva.)
            </p>
          ) : (
            <div className="space-y-2">
              {candidatesQ.data!.map((d: any, i: number) => (
                <div key={i} className="flex items-center gap-2 text-sm p-2 border rounded">
                  <User className="w-4 h-4" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{d.employeeName}</span>
                      <Badge variant="outline" className="text-[10px]">
                        {d.source === "history" ? "histórico API" : "escalado"}
                      </Badge>
                      {d.roleAtTime && <Badge variant="outline" className="text-[10px]">{d.roleAtTime}</Badge>}
                    </div>
                    {d.notes && <p className="text-xs text-muted-foreground truncate">{d.notes}</p>}
                  </div>
                  {d.alreadyLinked ? (
                    <Badge className="bg-green-100 text-green-800 text-[10px]">Associado</Badge>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => handleAttach(d)} disabled={attachMut.isPending}>
                      <Plus className="w-3 h-3 mr-1" /> Associar
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Botão + Dialog: Enviar email ao cliente ───────────────────────────────
function SendClientEmailButton({
  complaintId,
  clientEmail,
  clientName,
  complaintTitle,
  lastSentAt,
}: {
  complaintId: number;
  clientEmail: string | null | undefined;
  clientName: string | null | undefined;
  complaintTitle: string | null | undefined;
  lastSentAt: string | Date | null | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState(
    complaintTitle ? `Re: ${complaintTitle}` : "Atualização da sua reclamação"
  );
  const [body, setBody] = useState(
    "Estamos a tratar da sua reclamação e queríamos atualizá-lo(a) sobre o seguinte:\n\n",
  );
  const sendMut = trpc.complaints.sendEmailToClient.useMutation();
  const utils = trpc.useUtils();

  const disabled = !clientEmail;

  const handleSend = async () => {
    if (!subject.trim() || !body.trim()) {
      toast.error("Preencha o assunto e a mensagem");
      return;
    }
    try {
      const r = await sendMut.mutateAsync({ complaintId, subject, body });
      if (r.ok) {
        toast.success("Email enviado ao cliente");
        utils.complaints.getById.invalidate({ id: complaintId });
        setOpen(false);
      } else {
        toast.error(r.error || "Falha ao enviar");
      }
    } catch {
      toast.error("Erro ao enviar email");
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="w-full mt-2"
        onClick={() => setOpen(true)}
        disabled={disabled}
        title={disabled ? "Cliente sem email registado" : "Enviar email ao cliente"}
      >
        <Mail className="w-4 h-4 mr-2" /> Enviar email
      </Button>
      {lastSentAt && (
        <p className="text-[10px] text-muted-foreground">
          Último envio: {fmtPTDateTime(lastSentAt)}
        </p>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Enviar email ao cliente</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Para</Label>
              <Input value={clientEmail ?? ""} disabled />
            </div>
            <div>
              <Label className="text-xs">Assunto</Label>
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">Modelo</Label>
              <Select onValueChange={(k) => { const t = REPLY_TEMPLATES.find(x => x.key === k); if (t) setBody(t.body); }}>
                <SelectTrigger><SelectValue placeholder="Escolher modelo de resposta…" /></SelectTrigger>
                <SelectContent>
                  {REPLY_TEMPLATES.map(t => <SelectItem key={t.key} value={t.key}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Mensagem</Label>
              <Textarea
                rows={10}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                A saudação “Olá {clientName || "cliente"},” é adicionada automaticamente.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button onClick={handleSend} disabled={sendMut.isPending}>
              <Send className="w-4 h-4 mr-2" />
              {sendMut.isPending ? "A enviar..." : "Enviar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── SYNC EMAILS (manual) ─────────────────────────────────────────────────────
// Corre o leitor IMAP on-demand — o cron horário continua, isto é o "já".
function SyncEmailsButton() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const syncMut = trpc.admin.runEmailInbound.useMutation({
    onSuccess: (r: any) => {
      utils.complaints.invalidate();
      toast.success(`Emails sincronizados: ${r.created} novos, ${r.skipped} ignorados${r.errors?.length ? `, ${r.errors.length} erros` : ""}`);
    },
    onError: (e) => toast.error(e.message),
  });
  const role = (user as any)?.role ?? "user";
  if (!["backoffice", "team_leader", "supervisor", "admin", "super_admin"].includes(role)) return null;
  return (
    <Button variant="outline" onClick={() => syncMut.mutate()} disabled={syncMut.isPending}>
      <RefreshCw className={`w-4 h-4 mr-2 ${syncMut.isPending ? "animate-spin" : ""}`} />
      {syncMut.isPending ? "A sincronizar…" : "Sincronizar emails"}
    </Button>
  );
}

// ─── PICKER DE RESERVA (diálogo Editar) ──────────────────────────────────────
// Procura na NOSSA BD por matrícula / email / telefone / nome / nº de reserva
// e preenche a ref (externalId) — liga logo o histórico e os condutores.
function EditBookingPicker({ onPick }: { onPick: (b: any) => void }) {
  const [q, setQ] = useState("");
  const { data: results = [], isFetching } = trpc.complaints.searchBooking.useQuery(
    { search: q },
    { enabled: q.trim().length >= 2 },
  );
  return (
    <div className="space-y-2 rounded-md border p-3 bg-muted/30">
      <Label className="text-xs">Associar reserva (procura por matrícula, email, telefone, nome ou nº)</Label>
      <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Ex: BF21SA, joao@mail.com, 912…, Celia" />
      {isFetching && <p className="text-xs text-muted-foreground animate-pulse">A procurar…</p>}
      {q.trim().length >= 2 && !isFetching && results.length === 0 && (
        <p className="text-xs text-muted-foreground">Nenhuma reserva encontrada na nossa base de dados.</p>
      )}
      {results.length > 0 && (
        <div className="max-h-40 overflow-y-auto space-y-1">
          {results.map((b: any) => (
            <button
              key={b.externalId}
              type="button"
              className="w-full text-left text-xs rounded border bg-background px-2 py-1.5 hover:bg-accent"
              onClick={() => { onPick(b); setQ(""); }}
            >
              <span className="font-medium">{[b.clientFirstName, b.clientLastName].filter(Boolean).join(" ") || "(sem nome)"}</span>
              {" · "}{b.licensePlate || "—"}{" · "}{b.parkName || "—"}
              {" · "}{b.checkIn ? String(b.checkIn).slice(0, 10) : "—"}
              {" · "}<span className="uppercase text-muted-foreground">{b.status}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
