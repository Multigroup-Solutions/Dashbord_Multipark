import { trpc } from "@/lib/trpc";
import { fileHref } from "@/lib/fileHref";
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
  HelpCircle, TrendingUp, ShieldAlert, Flag, Mail, Download, Truck, GripVertical,
} from "lucide-react";
import { SearchableSelect } from "@/components/ui/searchable-select";

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: any }> = {
  new: { label: "Novo", color: "bg-blue-100 text-blue-800 border-blue-200", icon: AlertCircle },
  investigating: { label: "Em Investigação", color: "bg-yellow-100 text-yellow-800 border-yellow-200", icon: Hourglass },
  found: { label: "Encontrado", color: "bg-emerald-100 text-emerald-800 border-emerald-200", icon: CheckCircle2 },
  returned: { label: "Devolvido", color: "bg-green-100 text-green-800 border-green-200", icon: CheckCircle2 },
  closed: { label: "Fechado", color: "bg-gray-100 text-gray-800 border-gray-200", icon: XCircle },
};

const TYPE_CONFIG: Record<string, { label: string; icon: any }> = {
  money: { label: "Dinheiro", icon: DollarSign },
  electronics: { label: "Eletrónica", icon: Smartphone },
  clothing: { label: "Roupa", icon: Shirt },
  documents: { label: "Documentos", icon: FileText },
  accessories: { label: "Acessórios", icon: Glasses },
  other: { label: "Outro", icon: HelpCircle },
};

const PRIORITY_CONFIG: Record<string, { label: string; color: string }> = {
  low: { label: "Baixa", color: "bg-slate-100 text-slate-700" },
  medium: { label: "Média", color: "bg-blue-100 text-blue-700" },
  high: { label: "Alta", color: "bg-red-100 text-red-700" },
};

const KANBAN_COLUMNS = ["new", "investigating", "found", "returned", "closed"] as const;

const BASE_PATH = "/perdidos-achados";

export default function LostFoundPage() {
  const { user } = useAuth();
  const [location, setLocation] = useLocation();
  const [showCreate, setShowCreate] = useState(false);
  const [filterType, setFilterType] = useState<string>("all");
  const [searchTerm, setSearchTerm] = useState("");

  // Deriva a view do URL — assim clicar no sidebar (que faz setLocation
  // para o path base) volta sempre ao kanban e o botão back do browser
  // funciona.
  const { view, selectedId } = useMemo(() => {
    const tail = location.startsWith(BASE_PATH) ? location.slice(BASE_PATH.length).replace(/^\//, "") : "";
    const [section, sub] = tail.split("/");
    if (section === "historico") return { view: "history" as const, selectedId: null };
    if (section === "cruzamento") return { view: "ranking" as const, selectedId: null };
    if (section === "caso" && sub) {
      const id = parseInt(sub, 10);
      if (!isNaN(id)) return { view: "detail" as const, selectedId: id };
    }
    return { view: "kanban" as const, selectedId: null };
  }, [location]);

  const goKanban = () => setLocation(BASE_PATH);
  const goHistory = () => setLocation(`${BASE_PATH}/historico`);
  const goRanking = () => setLocation(`${BASE_PATH}/cruzamento`);
  const goDetail = (id: number) => setLocation(`${BASE_PATH}/caso/${id}`);

  return (
    <>
      {view === "kanban" ? (
        <KanbanView
          user={user}
          filterType={filterType}
          setFilterType={setFilterType}
          searchTerm={searchTerm}
          setSearchTerm={setSearchTerm}
          onSelect={goDetail}
          onNew={() => setShowCreate(true)}
          onShowRanking={goRanking}
          onShowHistory={goHistory}
        />
      ) : view === "ranking" ? (
        <DriverRankingView onBack={goKanban} />
      ) : view === "history" ? (
        <BookingHistoryView onBack={goKanban} />
      ) : selectedId ? (
        <DetailView
          id={selectedId}
          user={user}
          onBack={goKanban}
        />
      ) : null}
      {showCreate && <CreateDialog user={user} onClose={() => setShowCreate(false)} />}
    </>
  );
}

// ─── KANBAN VIEW ──────────────────────────────────────────────────────────────

function KanbanView({ user, filterType, setFilterType, searchTerm, setSearchTerm, onSelect, onNew, onShowRanking, onShowHistory }: any) {
  const globalFilters = useGlobalFilters();
  const queryInput = useMemo(() => {
    const input: any = {};
    if (filterType !== "all") input.itemType = filterType;
    if (searchTerm.trim()) input.search = searchTerm.trim();
    if (globalFilters.projectId !== undefined) input.projectId = globalFilters.projectId;
    return input;
  }, [filterType, searchTerm, globalFilters.projectId]);

  const { data: items = [], isLoading } = trpc.lostFound.list.useQuery(queryInput);
  const updateMut = trpc.lostFound.update.useMutation();
  const utils = trpc.useUtils();

  const grouped = useMemo(() => {
    const map: Record<string, any[]> = {};
    KANBAN_COLUMNS.forEach(s => map[s] = []);
    items.forEach((c: any) => {
      if (map[c.status]) map[c.status].push(c);
    });
    return map;
  }, [items]);

  const stats = useMemo(() => {
    const s = { total: items.length, new: 0, investigating: 0, found: 0, returned: 0, closed: 0, highPriority: 0 };
    items.forEach((i: any) => {
      if (s[i.status as keyof typeof s] !== undefined) (s as any)[i.status]++;
      if (i.priority === "high") s.highPriority++;
    });
    return s;
  }, [items]);

  // Optimistic: o cartão muda de coluna imediatamente; rollback se o servidor
  // recusar (mesmo padrão do kanban das Tarefas).
  const moveCard = async (id: number, newStatus: string) => {
    await utils.lostFound.list.cancel(queryInput);
    const prev = utils.lostFound.list.getData(queryInput);
    utils.lostFound.list.setData(queryInput, (old: any) =>
      old?.map((i: any) => (i.id === id ? { ...i, status: newStatus } : i)),
    );
    try {
      await updateMut.mutateAsync({ id, status: newStatus });
      toast.success("Estado atualizado");
    } catch {
      utils.lostFound.list.setData(queryInput, prev);
      toast.error("Erro ao mover");
    } finally {
      utils.lostFound.list.invalidate();
    }
  };

  // Drag & drop nativo: arrastar um cartão para QUALQUER coluna (as setas nos
  // cartões ficam como alternativa para touch, onde o drag nativo não existe).
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-muted-foreground">Gestão de objetos perdidos e achados nos veículos</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={items.length === 0}
            onClick={() => {
              const headers = ["ID","Criado","Tipo","Estado","Prioridade","Cliente","Email","Telefone","Matrícula","Ref.Reserva","Valor est.","Descrição","Resolução"];
              const rows = (items as any[]).map(i => [
                i.id,
                i.createdAt ? new Date(i.createdAt).toISOString().slice(0, 16) : "",
                i.itemType ?? "",
                i.status ?? "",
                i.priority ?? "",
                (i.clientName ?? "").replace(/;/g, ","),
                (i.clientEmail ?? "").replace(/;/g, ","),
                i.clientPhone ?? "",
                i.vehiclePlate ?? "",
                i.bookingRef ?? "",
                i.estimatedValue ?? "",
                (i.description ?? "").replace(/[;\n\r]/g, " "),
                (i.resolution ?? "").replace(/[;\n\r]/g, " "),
              ]);
              const csv = [headers.join(";"), ...rows.map(r => r.join(";"))].join("\n");
              const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url; a.download = `perdidos_achados_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
              URL.revokeObjectURL(url);
            }}
          >
            <Download className="w-4 h-4 mr-2" /> CSV
          </Button>
          <Button variant="outline" onClick={onShowHistory}>
            <Clock className="w-4 h-4 mr-2" /> Histórico Reservas
          </Button>
          <Button variant="outline" onClick={onShowRanking}>
            <ShieldAlert className="w-4 h-4 mr-2" /> Cruzamento de Dados
          </Button>
          <Button onClick={onNew}><Plus className="w-4 h-4 mr-2" /> Novo Registo</Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-7 gap-3">
        {[
          { label: "Total", value: stats.total, icon: BarChart3, color: "text-foreground" },
          { label: "Novos", value: stats.new, icon: AlertCircle, color: "text-blue-600" },
          { label: "Investigação", value: stats.investigating, icon: Hourglass, color: "text-yellow-600" },
          { label: "Encontrados", value: stats.found, icon: Search, color: "text-emerald-600" },
          { label: "Devolvidos", value: stats.returned, icon: CheckCircle2, color: "text-green-600" },
          { label: "Fechados", value: stats.closed, icon: XCircle, color: "text-gray-600" },
          { label: "Alta Prioridade", value: stats.highPriority, icon: AlertCircle, color: "text-red-600" },
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

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Label>Tipo:</Label>
          <Select value={filterType} onValueChange={setFilterType}>
            <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              {Object.entries(TYPE_CONFIG).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2 flex-1 max-w-sm">
          <Search className="w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Pesquisar por nome, descrição, matrícula..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
          />
        </div>
      </div>

      {/* Kanban Board */}
      {isLoading ? (
        <div className="flex justify-center py-20"><div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" /></div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
          {KANBAN_COLUMNS.map(status => {
            const cfg = STATUS_CONFIG[status];
            const colItems = grouped[status] || [];
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
                  <Badge variant="secondary" className="ml-auto text-xs">{colItems.length}</Badge>
                </div>
                <ScrollArea className="max-h-[60vh]">
                  <div className="space-y-2 pr-2">
                    {colItems.map((item: any) => (
                      <ItemCard
                        key={item.id}
                        item={item}
                        onSelect={() => onSelect(item.id)}
                        onMove={moveCard}
                        currentStatus={status}
                      />
                    ))}
                    {colItems.length === 0 && (
                      <p className="text-xs text-muted-foreground text-center py-8">Sem registos</p>
                    )}
                  </div>
                </ScrollArea>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ItemCard({ item, onSelect, onMove, currentStatus }: any) {
  const colIdx = KANBAN_COLUMNS.indexOf(currentStatus);
  const canMoveLeft = colIdx > 0;
  const canMoveRight = colIdx < KANBAN_COLUMNS.length - 1;
  const TypeIcon = TYPE_CONFIG[item.itemType]?.icon || Package;

  const ageDays = (item.status !== "returned" && item.status !== "closed")
    ? Math.floor((Date.now() - new Date(String(item.createdAt).replace(" ", "T") + "Z").getTime()) / 86400000)
    : 0;
  const stale = ageDays >= 7;

  return (
    <Card
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", String(item.id));
        e.dataTransfer.effectAllowed = "move";
        if (e.currentTarget instanceof HTMLElement) e.currentTarget.style.opacity = "0.5";
      }}
      onDragEnd={(e) => {
        if (e.currentTarget instanceof HTMLElement) e.currentTarget.style.opacity = "1";
      }}
      onClick={onSelect}
      className={`cursor-grab active:cursor-grabbing hover:shadow-md transition-shadow ${stale ? "border-red-400 border-2" : ""}`}
    >
      <CardContent className="p-3 space-y-2">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-1.5 min-w-0" onClick={onSelect}>
            <GripVertical className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
            <TypeIcon className="w-4 h-4 text-amber-600" />
            <span className="font-medium text-sm line-clamp-1">{item.description}</span>
          </div>
          <Badge className={`text-[10px] ${PRIORITY_CONFIG[item.priority]?.color}`}>
            {PRIORITY_CONFIG[item.priority]?.label}
          </Badge>
        </div>
        {ageDays >= 3 && (
          <div className={`flex items-center gap-1 text-xs font-medium ${stale ? "text-red-600" : "text-amber-600"}`}>
            <Clock className="w-3 h-3" /> Parado há {ageDays} dias
          </div>
        )}

        {item.vehiclePlate && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Car className="w-3 h-3" /> {item.vehiclePlate}
          </div>
        )}

        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <User className="w-3 h-3" /> <span className="truncate">{item.clientName}</span>
        </div>

        {item.estimatedValue && (
          <div className="flex items-center gap-1 text-xs text-amber-600 font-medium">
            <DollarSign className="w-3 h-3" /> ~{item.estimatedValue}€
          </div>
        )}

        <div className="text-[10px] text-muted-foreground">
          {fmtPTDate(item.createdAt)}
        </div>

        <div className="flex items-center justify-between pt-1">
          <span className="text-[10px] text-muted-foreground">#{item.id}</span>
          <div className="flex gap-1">
            {canMoveLeft && (
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={(e) => { e.stopPropagation(); onMove(item.id, KANBAN_COLUMNS[colIdx - 1]); }}>
                <ChevronLeft className="w-3 h-3" />
              </Button>
            )}
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onSelect}>
              <Eye className="w-3 h-3" />
            </Button>
            {canMoveRight && (
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={(e) => { e.stopPropagation(); onMove(item.id, KANBAN_COLUMNS[colIdx + 1]); }}>
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

function DetailView({ id, user, onBack }: { id: number; user: any; onBack: () => void }) {
  const { data: item, isLoading } = trpc.lostFound.getById.useQuery({ id });
  const { data: photos = [] } = trpc.lostFound.getPhotos.useQuery({ itemId: id });
  const { data: messages = [] } = trpc.lostFound.getMessages.useQuery({ itemId: id });
  const { data: vehicleAgents = [] } = trpc.lostFound.vehicleAgents.useQuery(
    { plate: item?.vehiclePlate || "", currentBookingRef: item?.bookingRef || undefined },
    { enabled: !!item?.vehiclePlate }
  );
  const { data: apiTimeline, isLoading: timelineLoading } = trpc.lostFound.bookingTimeline.useQuery(
    { bookingId: item?.bookingRef || "" },
    { enabled: !!item?.bookingRef }
  );
  // Dossier completo da reserva ligada — automático, sem passos manuais.
  const { data: dossier } = trpc.lostFound.bookingDossier.useQuery(
    { reservationRef: item?.bookingRef || "" },
    { enabled: !!item?.bookingRef }
  );
  const autoLinkMut = trpc.lostFound.autoLink.useMutation({
    onSuccess: (r) => {
      if (r.linked) {
        toast.success(r.alreadyLinked ? "Dados completados a partir da reserva" : `Reserva ligada (${r.matchedBy.join(", ")})`);
        utils.lostFound.getById.invalidate({ id });
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
    // Roubos: mantém quem mexeu no carro; esconde só recolha-pendente/caixa.
    const filtered = showAllHist ? mapped : filterBookingHistory(mapped, "theft");
    return filtered
      .sort((a: any, b: any) => new Date(b.actionDate || 0).getTime() - new Date(a.actionDate || 0).getTime());
  }, [apiTimeline, showAllHist]);
  const { data: lfProjects = [] } = trpc.projects.list.useQuery();
  const { data: lfEmployees = [] } = trpc.rh.list.useQuery();
  const updateMut = trpc.lostFound.update.useMutation();
  const uploadPhotoMut = trpc.lostFound.uploadPhoto.useMutation();
  const addMsgMut = trpc.lostFound.addMessage.useMutation();
  const deleteMut = trpc.lostFound.delete.useMutation();
  const utils = trpc.useUtils();

  const [newMsg, setNewMsg] = useState("");
  const [isInternal, setIsInternal] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState<any>(null);

  if (isLoading || !item) return <div className="flex justify-center py-20"><div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" /></div>;

  const TypeIcon = TYPE_CONFIG[item.itemType]?.icon || Package;

  const startEditing = () => {
    setEditForm({
      clientName: item.clientName || "",
      clientEmail: item.clientEmail || "",
      clientPhone: item.clientPhone || "",
      bookingRef: item.bookingRef || "",
      vehiclePlate: item.vehiclePlate || "",
      itemType: item.itemType || "other",
      description: item.description || "",
      estimatedValue: item.estimatedValue || 0,
      priority: item.priority || "medium",
      clientNotes: item.clientNotes || "",
    });
    setIsEditing(true);
  };

  const handleSaveEdit = async () => {
    try {
      await updateMut.mutateAsync({
        id,
        clientName: editForm.clientName || undefined,
        clientEmail: editForm.clientEmail || undefined,
        clientPhone: editForm.clientPhone || undefined,
        bookingRef: editForm.bookingRef || undefined,
        vehiclePlate: editForm.vehiclePlate || undefined,
        itemType: editForm.itemType || undefined,
        description: editForm.description || undefined,
        estimatedValue: editForm.estimatedValue ? Number(editForm.estimatedValue) : undefined,
        priority: editForm.priority || undefined,
        clientNotes: editForm.clientNotes || null,
      });
      utils.lostFound.getById.invalidate({ id });
      utils.lostFound.list.invalidate();
      setIsEditing(false);
      toast.success("Registo atualizado");
    } catch { toast.error("Erro ao atualizar"); }
  };

  const handleStatusChange = async (status: string) => {
    await updateMut.mutateAsync({ id, status });
    utils.lostFound.getById.invalidate({ id });
    utils.lostFound.list.invalidate();
    toast.success("Estado atualizado");
  };

  const handleSendMsg = async () => {
    if (!newMsg.trim()) return;
    await addMsgMut.mutateAsync({ itemId: id, message: newMsg, isInternal });
    setNewMsg("");
    utils.lostFound.getMessages.invalidate({ itemId: id });
    toast.success("Mensagem adicionada");
  };

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = (reader.result as string).split(",")[1];
      await uploadPhotoMut.mutateAsync({ itemId: id, base64, filename: file.name });
      utils.lostFound.getPhotos.invalidate({ itemId: id });
      toast.success("Foto carregada");
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const handleDelete = async () => {
    if (!confirm("Tens a certeza que queres eliminar este registo?")) return;
    await deleteMut.mutateAsync({ id });
    utils.lostFound.list.invalidate();
    toast.success("Registo eliminado");
    onBack();
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="outline" onClick={onBack}><ChevronLeft className="w-4 h-4 mr-1" /> Voltar</Button>
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <TypeIcon className="w-5 h-5 text-amber-600" />
            <h1 className="text-xl font-bold line-clamp-2 break-words">{item.description}</h1>
            <Badge className={STATUS_CONFIG[item.status]?.color}>{STATUS_CONFIG[item.status]?.label}</Badge>
            <Badge className={PRIORITY_CONFIG[item.priority]?.color}>{PRIORITY_CONFIG[item.priority]?.label}</Badge>
            {(() => {
              if (item.status === "returned" || item.status === "closed") return null;
              const days = Math.floor((Date.now() - new Date(String(item.createdAt).replace(" ", "T") + "Z").getTime()) / 86400000);
              if (days < 1) return null;
              const cls = days >= 7 ? "bg-red-100 text-red-700 border-red-200" : days >= 3 ? "bg-amber-100 text-amber-700 border-amber-200" : "bg-slate-100 text-slate-600";
              return <Badge variant="outline" className={cls}>Parado há {days} {days === 1 ? "dia" : "dias"}</Badge>;
            })()}
          </div>
          <p className="text-sm text-muted-foreground">Caso #{item.id} — Criado em {fmtPTDate(item.createdAt)}</p>
        </div>
        <Button variant="outline" size="sm" onClick={startEditing}><Pencil className="w-4 h-4 mr-1" /> Editar</Button>
        <Select value={item.status} onValueChange={handleStatusChange}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.entries(STATUS_CONFIG).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(user?.role === "super_admin" || user?.role === "admin") && (
          <Button variant="destructive" size="sm" onClick={handleDelete}><Trash2 className="w-4 h-4" /></Button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Details */}
        <div className="lg:col-span-2 space-y-4">
          <Tabs defaultValue="details">
            <TabsList className="flex-wrap">
              <TabsTrigger value="details">Detalhes</TabsTrigger>
              <TabsTrigger value="messages">Mensagens ({messages.length})</TabsTrigger>
              <TabsTrigger value="photos">Fotos ({photos.length})</TabsTrigger>
              {item.vehiclePlate && <TabsTrigger value="vehicle">Viatura</TabsTrigger>}
              {item.bookingRef && <TabsTrigger value="booking-history">Histórico ({timelineHist.length})</TabsTrigger>}
            </TabsList>

            <TabsContent value="details" className="space-y-4">
              <Card>
                <CardHeader><CardTitle className="text-base">Informação do Item</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-muted-foreground">Tipo:</span>
                      <p className="font-medium flex items-center gap-1"><TypeIcon className="w-4 h-4" /> {TYPE_CONFIG[item.itemType]?.label}</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Valor Estimado:</span>
                      <p className="font-medium">{item.estimatedValue ? `${item.estimatedValue}€` : "N/A"}</p>
                    </div>
                    <div className="sm:col-span-2">
                      <span className="text-muted-foreground">Descrição:</span>
                      <p className="font-medium">{item.description}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle className="text-base">Dados do Cliente</CardTitle></CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <span className="text-muted-foreground">Nome:</span>
                      <p className="font-medium">{item.clientName}</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Email:</span>
                      <p className="font-medium break-all">{item.clientEmail || "N/A"}</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Telefone:</span>
                      <p className="font-medium">{item.clientPhone || "N/A"}</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Ref. Reserva:</span>
                      <p className="font-medium">{item.bookingRef || "N/A"}</p>
                    </div>
                  </div>
                  {item.clientNotes && (
                    <div className="text-xs bg-muted/50 rounded p-2 whitespace-pre-wrap mt-2"><span className="text-muted-foreground">Notas: </span>{item.clientNotes}</div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <CardTitle className="text-base">Dados da Reserva</CardTitle>
                  {!item.bookingRef && (
                    <Button
                      size="sm" variant="outline"
                      disabled={autoLinkMut.isPending}
                      onClick={() => autoLinkMut.mutate({ id: item.id })}
                    >
                      {autoLinkMut.isPending ? "A procurar…" : "Ligar reserva automaticamente"}
                    </Button>
                  )}
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {!item.bookingRef ? (
                    <p className="text-xs text-muted-foreground">Sem reserva ligada — usa o botão para procurar pela matrícula/contactos do cliente.</p>
                  ) : dossier?.booking ? (() => {
                    const b: any = dossier.booking;
                    const eur = (v: any) => v != null ? Number(v).toLocaleString("pt-PT", { style: "currency", currency: b.currency || "EUR" }) : "—";
                    return (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div><span className="text-muted-foreground">Nº Reserva:</span> <span className="font-medium">#{b.bookingNumber || "—"}</span></div>
                        <div><span className="text-muted-foreground">Estado:</span> <span className="font-medium">{b.status || "—"}</span></div>
                        <div><span className="text-muted-foreground">Reservada em:</span> <span className="font-medium">{b.bookingCreatedAt ? fmtPTDateTime(b.bookingCreatedAt) : "—"}</span></div>
                        <div><span className="text-muted-foreground">Canal:</span> <span className="font-medium">{[b.origin, b.partnerName && b.partnerName !== "Unknown User" ? b.partnerName : null, b.campaignName].filter(Boolean).join(" · ") || "—"}</span></div>
                        <div><span className="text-muted-foreground">Parque:</span> <span className="font-medium">{b.parkName || "—"}{b.city ? ` (${b.city})` : ""}</span></div>
                        <div><span className="text-muted-foreground">Lugar:</span> <span className="font-medium">{[b.currentGarage, b.currentSpot].filter(Boolean).join(" / ") || "—"}</span></div>
                        <div><span className="text-muted-foreground">Entrada:</span> <span className="font-medium">{b.checkIn ? fmtPTDate(b.checkIn) : "—"}{b.checkInTime ? ` ${b.checkInTime}` : ""}{b.checkinAgentName ? ` · ${b.checkinAgentName}` : ""}</span></div>
                        <div><span className="text-muted-foreground">Saída:</span> <span className="font-medium">{b.checkOut ? fmtPTDate(b.checkOut) : "—"}{b.checkOutTime ? ` ${b.checkOutTime}` : ""}{b.checkoutAgentName ? ` · ${b.checkoutAgentName}` : ""}</span></div>
                        <div><span className="text-muted-foreground">Pagamento:</span> <span className="font-medium">{b.paymentMethod || "—"} · {eur(b.totalPrice)}</span></div>
                        {(b.vehicleBrand || b.vehicleModel) && (
                          <div><span className="text-muted-foreground">Veículo:</span> <span className="font-medium">{[b.vehicleBrand, b.vehicleModel, b.vehicleColor].filter(Boolean).join(" ")}</span></div>
                        )}
                        {(b.deliveryType || b.deliveryAddress) && (
                          <div className="sm:col-span-2"><span className="text-muted-foreground">Entrega:</span> <span className="font-medium">{[b.deliveryType, b.deliveryAddress].filter(Boolean).join(" · ")}</span></div>
                        )}
                        {b.remarks && (
                          <div className="sm:col-span-2 text-xs bg-muted/50 rounded p-2 whitespace-pre-wrap"><span className="text-muted-foreground">Observações: </span>{b.remarks}</div>
                        )}
                      </div>
                    );
                  })() : (
                    <p className="text-xs text-muted-foreground">A ref. "{item.bookingRef}" não corresponde a nenhuma reserva na base de dados.</p>
                  )}
                </CardContent>
              </Card>

              <ClientHistoryCard
                email={item.clientEmail}
                phone={item.clientPhone}
                plate={item.vehiclePlate}
                name={item.clientName}
                highlightRef={item.bookingRef}
              />

              <LinkInboundEmailButton
                module="lostfound" alias="perdidos" caseId={item.id}
                defaultSearch={item.clientEmail || item.clientName}
                onLinked={() => utils.lostFound.getMessages.invalidate({ itemId: item.id })}
              />

              <CaseAssignmentCard
                projectId={item.projectId}
                assigneeId={item.assignedTo}
                dueDate={item.dueDate}
                closedAt={item.closedAt}
                projects={(lfProjects as any[]).map(p => ({ id: p.id, name: p.name }))}
                people={(lfEmployees as any[]).map(e => e.employee ?? e).map((e: any) => ({ id: e.id, fullName: e.fullName }))}
                saving={updateMut.isPending}
                onSave={(patch) => updateMut.mutate({
                  id: item.id, projectId: patch.projectId, assignedTo: patch.assigneeId,
                  investigatedById: patch.assigneeId, dueDate: patch.dueDate,
                } as any, { onSuccess: () => { utils.lostFound.getById.invalidate({ id: item.id }); toast.success("Atribuição guardada"); } })}
              />

              {item.vehiclePlate && (
                <Card>
                  <CardHeader><CardTitle className="text-base">Viatura Associada</CardTitle></CardHeader>
                  <CardContent className="text-sm">
                    <div className="flex items-center gap-2">
                      <Car className="w-5 h-5 text-muted-foreground" />
                      <span className="font-medium text-lg">{item.vehiclePlate}</span>
                    </div>
                  </CardContent>
                </Card>
              )}

              {item.resolution && (
                <Card>
                  <CardHeader><CardTitle className="text-base">Resolução</CardTitle></CardHeader>
                  <CardContent>
                    <p className="text-sm">{item.resolution}</p>
                  </CardContent>
                </Card>
              )}

              <ReturnPanel item={item} />

              <CaseDriversPanel
                itemId={item.id}
                agents={vehicleAgents as any[]}
                employees={(lfEmployees as any[]).map(e => e.employee ?? e).map((e: any) => ({ id: e.id, fullName: e.fullName }))}
              />
            </TabsContent>

            <TabsContent value="messages" className="space-y-4">
              <Card>
                <CardContent className="p-4 space-y-4">
                  <ScrollArea className="max-h-[50vh]">
                    <div className="space-y-3">
                      {messages.length === 0 && (
                        <p className="text-sm text-muted-foreground text-center py-8">Sem mensagens</p>
                      )}
                      {messages.map((m: any) => (
                        <div key={m.id} className={`p-3 rounded-lg text-sm ${m.isInternal ? "bg-amber-50 border border-amber-200" : "bg-muted"}`}>
                          <div className="flex items-center justify-between mb-1">
                            <span className="font-medium">{m.userName}</span>
                            <div className="flex items-center gap-2">
                              {m.isInternal && <Badge variant="outline" className="text-[10px]">Interna</Badge>}
                              <span className="text-[10px] text-muted-foreground">{fmtPTDateTime(m.createdAt)}</span>
                            </div>
                          </div>
                          <p>{m.message}</p>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                  <Separator />
                  <div className="flex gap-2">
                    <Input
                      placeholder="Escrever mensagem..."
                      value={newMsg}
                      onChange={e => setNewMsg(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && handleSendMsg()}
                      className="flex-1"
                    />
                    <label className="flex items-center gap-1 text-xs cursor-pointer">
                      <input type="checkbox" checked={isInternal} onChange={e => setIsInternal(e.target.checked)} />
                      Interna
                    </label>
                    <Button size="sm" onClick={handleSendMsg} disabled={!newMsg.trim()}>
                      <Send className="w-4 h-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="photos" className="space-y-4">
              <Card>
                <CardContent className="p-4 space-y-4">
                  <div className="flex items-center gap-2">
                    <label className="cursor-pointer">
                      <input type="file" accept="image/*" className="hidden" onChange={handlePhotoUpload} />
                      <Button variant="outline" asChild><span><Upload className="w-4 h-4 mr-2" /> Carregar Foto</span></Button>
                    </label>
                  </div>
                  {photos.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">Sem fotos</p>
                  ) : (
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                      {photos.map((p: any) => (
                        <div key={p.id} className="relative group">
                          <img src={fileHref(p.url, p.key) ?? undefined} alt={p.caption || "Foto"} className="rounded-lg w-full h-32 object-cover" />
                          {p.caption && <p className="text-xs text-muted-foreground mt-1">{p.caption}</p>}
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {item.vehiclePlate && (
              <TabsContent value="vehicle" className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Car className="w-5 h-5" /> Condutores Multipark — {item.vehiclePlate}
                    </CardTitle>
                    <p className="text-xs text-muted-foreground">
                      Quem mexeu nesta viatura em todas as reservas. Condutores que tocaram especificamente na reserva
                      <span className="font-mono"> {item.bookingRef ? item.bookingRef.slice(-12) : "—"}</span> aparecem sinalizados.
                    </p>
                  </CardHeader>
                  <CardContent>
                    {vehicleAgents.length === 0 ? (
                      <p className="text-sm text-muted-foreground">Sem registos no histórico Multipark para esta matrícula.</p>
                    ) : (
                      <div className="space-y-2">
                        {vehicleAgents.map((a: any, i: number) => (
                          <div
                            key={i}
                            className={`flex items-center justify-between text-sm p-3 rounded border ${
                              a.flagged
                                ? "bg-red-50 border-red-300 dark:bg-red-950/30"
                                : "bg-muted border-transparent"
                            }`}
                          >
                            <div className="flex items-center gap-2 flex-wrap">
                              <User className={`w-4 h-4 ${a.flagged ? "text-red-600" : "text-muted-foreground"}`} />
                              <span className="font-medium">{a.agentName}</span>
                              {a.flagged === 1 && (
                                <Badge className="bg-red-500 text-white text-[10px]">
                                  <Flag className="w-3 h-3 mr-1" /> Envolvido no caso
                                </Badge>
                              )}
                              {a.agentEmail && (
                                <span className="text-xs text-muted-foreground flex items-center gap-1">
                                  <Mail className="w-3 h-3" /> {a.agentEmail}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-3 text-xs">
                              <span className="text-green-600 font-medium">{a.checkins} in</span>
                              <span className="text-violet-600 font-medium">{a.checkouts} out</span>
                              <span className="text-amber-600 font-medium">{a.movements} mov</span>
                              <span className="text-muted-foreground">
                                {a.lastActionAt ? fmtPTDate(a.lastActionAt) : ""}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
            )}

            {item.bookingRef && (
              <TabsContent value="booking-history" className="space-y-4">
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Clock className="w-5 h-5" /> Histórico da Reserva — {item.bookingRef.slice(-12)}
                    </CardTitle>
                    <Button size="sm" variant={showAllHist ? "default" : "outline"} onClick={() => setShowAllHist(v => !v)}>
                      {showAllHist ? "A mostrar tudo" : "Mostrar tudo"}
                    </Button>
                  </CardHeader>
                  <CardContent>
                    {timelineLoading ? (
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
                                  {h.remarks && <p className="text-xs text-muted-foreground mt-1">{h.remarks}</p>}
                                  {h.parkName && <p className="text-xs text-muted-foreground">Parque: {h.parkName}</p>}
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
            )}
          </Tabs>
        </div>

        {/* Right: Quick Info */}
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-sm">Resumo</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Estado</span>
                <Badge className={STATUS_CONFIG[item.status]?.color}>{STATUS_CONFIG[item.status]?.label}</Badge>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">Prioridade</span>
                <Badge className={PRIORITY_CONFIG[item.priority]?.color}>{PRIORITY_CONFIG[item.priority]?.label}</Badge>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tipo</span>
                <span>{TYPE_CONFIG[item.itemType]?.label}</span>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">Criado</span>
                <span>{fmtPTDate(item.createdAt)}</span>
              </div>
              {item.estimatedValue && (
                <>
                  <Separator />
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Valor</span>
                    <span className="font-medium text-amber-600">{item.estimatedValue}€</span>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-sm">Ações Rápidas</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {item.status === "new" && (
                <Button className="w-full" size="sm" onClick={() => handleStatusChange("investigating")}>
                  Iniciar Investigação
                </Button>
              )}
              {item.status === "investigating" && (
                <Button className="w-full" size="sm" onClick={() => handleStatusChange("found")}>
                  Marcar como Encontrado
                </Button>
              )}
              {item.status === "found" && (
                <Button className="w-full" size="sm" onClick={() => handleStatusChange("returned")}>
                  Marcar como Devolvido
                </Button>
              )}
              {(item.status === "returned" || item.status === "found") && (
                <Button className="w-full" size="sm" variant="outline" onClick={() => handleStatusChange("closed")}>
                  Fechar Caso
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
      {/* Edit Dialog */}
      <Dialog open={isEditing} onOpenChange={setIsEditing}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Editar Perdido/Achado</DialogTitle></DialogHeader>
          {editForm && (
            <div className="space-y-4">
              <div><Label>Nome do Cliente</Label><Input value={editForm.clientName} onChange={e => setEditForm((f: any) => ({ ...f, clientName: e.target.value }))} /></div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div><Label>Email</Label><Input value={editForm.clientEmail} onChange={e => setEditForm((f: any) => ({ ...f, clientEmail: e.target.value }))} /></div>
                <div><Label>Telefone</Label><Input value={editForm.clientPhone} onChange={e => setEditForm((f: any) => ({ ...f, clientPhone: e.target.value }))} /></div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div><Label>Ref. Reserva</Label><Input value={editForm.bookingRef} onChange={e => setEditForm((f: any) => ({ ...f, bookingRef: e.target.value }))} /></div>
                <div><Label>Matrícula</Label><Input value={editForm.vehiclePlate} onChange={e => setEditForm((f: any) => ({ ...f, vehiclePlate: e.target.value.toUpperCase() }))} /></div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label>Tipo de Item</Label>
                  <Select value={editForm.itemType} onValueChange={v => setEditForm((f: any) => ({ ...f, itemType: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(TYPE_CONFIG).map(([k, v]) => (
                        <SelectItem key={k} value={k}>{v.label}</SelectItem>
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
              <div><Label>Valor Estimado (€)</Label><Input type="number" value={editForm.estimatedValue} onChange={e => setEditForm((f: any) => ({ ...f, estimatedValue: e.target.value }))} /></div>
              <div><Label>Descrição</Label><Textarea value={editForm.description} onChange={e => setEditForm((f: any) => ({ ...f, description: e.target.value }))} rows={3} /></div>
              <div><Label>Notas / dados adicionais do cliente</Label><Textarea value={editForm.clientNotes} onChange={e => setEditForm((f: any) => ({ ...f, clientNotes: e.target.value }))} rows={3} placeholder="Ex: 2º contacto, NIF, morada, indicações…" /></div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditing(false)}>Cancelar</Button>
            <Button onClick={handleSaveEdit} disabled={updateMut.isPending}>Guardar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── DRIVER RANKING VIEW ──────────────────────────────────────────────────────

function DriverRankingView({ onBack }: { onBack: () => void }) {
  const { data: crossRef = [], isLoading } = trpc.lostFound.bookingHistoryCrossRef.useQuery();

  // "Movimentos por Condutor": escolher um condutor + período e ver tudo o que
  // ele mexeu (fonte: histórico Multipark sincronizado na BD local).
  const fmtDay = (d: Date) => d.toISOString().slice(0, 10);
  const [agent, setAgent] = useState("");
  const [from, setFrom] = useState(() => fmtDay(new Date(Date.now() - 30 * 86_400_000)));
  const [to, setTo] = useState(() => fmtDay(new Date()));
  const { data: drivers = [] } = trpc.lostFound.driversForPeriod.useQuery({ from, to });
  const movQ = trpc.lostFound.agentMovements.useQuery(
    { agentName: agent, from, to },
    { enabled: !!agent },
  );
  const mov = movQ.data;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="outline" onClick={onBack}><ChevronLeft className="w-4 h-4 mr-1" /> Voltar</Button>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShieldAlert className="w-6 h-6 text-red-500" /> Cruzamento de Dados
          </h1>
          <p className="text-muted-foreground">Condutores envolvidos em reservas com casos de perdidos/achados</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="w-5 h-5" /> Ranking por Casos Associados
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Condutores Multipark ordenados pelo número de casos de perdidos/achados em que estiveram envolvidos
            (cruzamento ao vivo entre <span className="font-mono">lost_found_items.bookingRef</span> e o
            histórico Multipark sincronizado).
          </p>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-10"><div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" /></div>
          ) : crossRef.length === 0 ? (
            <div className="text-center py-10">
              <Package className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
              <p className="text-muted-foreground">Sem dados suficientes para cruzamento.</p>
              <p className="text-xs text-muted-foreground mt-1">
                Necessário ter registos de perdidos/achados com Ref. de Reserva preenchida e o cron job de sincronização
                Multipark já ter corrido para essas reservas.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="bg-muted/50 text-left">
                    <th className="p-2 w-10">#</th>
                    <th className="p-2">Condutor</th>
                    <th className="p-2 text-right">Casos</th>
                    <th className="p-2 text-right">Matrículas</th>
                    <th className="p-2 text-right">Check-ins</th>
                    <th className="p-2 text-right">Check-outs</th>
                    <th className="p-2 text-right">Movimentos</th>
                    <th className="p-2 text-right">Total Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {crossRef.map((r: any, i: number) => (
                    <tr key={r.userName} className={`border-t ${i === 0 ? "bg-red-50" : i < 3 ? "bg-amber-50" : "hover:bg-muted/30"}`}>
                      <td className="p-2">
                        <span className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${i === 0 ? "bg-red-500 text-white" : i < 3 ? "bg-amber-500 text-white" : "bg-gray-200 text-gray-700"}`}>
                          {i + 1}
                        </span>
                      </td>
                      <td className="p-2 font-medium">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            className="underline-offset-2 hover:underline text-left"
                            title="Ver movimentos deste condutor"
                            onClick={() => setAgent(r.userName)}
                          >
                            {r.userName}
                          </button>
                          <Badge className="bg-red-500 text-white text-[10px]">
                            <Flag className="w-3 h-3 mr-1" /> Envolvido
                          </Badge>
                        </div>
                      </td>
                      <td className="p-2 text-right">
                        <Badge variant={r.caseCount > 2 ? "destructive" : "outline"}>{r.caseCount}</Badge>
                      </td>
                      <td className="p-2 text-right text-muted-foreground" title={(r.plates || []).join(", ")}>
                        {(r.plates || []).length}
                      </td>
                      <td className="p-2 text-right text-green-600">{r.checkins || 0}</td>
                      <td className="p-2 text-right text-violet-600">{r.checkouts || 0}</td>
                      <td className="p-2 text-right text-amber-600">{r.movements || 0}</td>
                      <td className="p-2 text-right font-medium">{r.totalActions || 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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

// ─── CREATE DIALOG ────────────────────────────────────────────────────────────

// ─── RESERVATION PREVIEW (auto-fetches timeline from API) ────────────────────

function LostFoundReservationPreview({ bookingId }: { bookingId: string }) {
  const { data, isLoading } = trpc.lostFound.bookingTimeline.useQuery(
    { bookingId },
    { enabled: bookingId.length >= 4 }
  );

  if (!bookingId || bookingId.length < 4) return null;
  if (isLoading) return <p className="text-xs text-muted-foreground mt-2 animate-pulse">A carregar histórico da API...</p>;

  const history = data?.history || [];
  if (history.length === 0) return <p className="text-xs text-amber-600 mt-2">Nenhum histórico encontrado para este ID.</p>;

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

function CreateDialog({ user, onClose }: { user: any; onClose: () => void }) {
  const [form, setForm] = useState({
    clientName: "",
    clientEmail: "",
    clientPhone: "",
    bookingRef: "",
    vehiclePlate: "",
    itemType: "other" as const,
    description: "",
    estimatedValue: "",
    priority: "medium" as const,
  });
  const createMut = trpc.lostFound.create.useMutation();
  const utils = trpc.useUtils();

  const handleSubmit = async () => {
    if (!form.clientName.trim() || !form.description.trim()) {
      toast.error("Nome do cliente e descrição são obrigatórios");
      return;
    }
    if (!form.bookingRef.trim()) {
      toast.error("ID da reserva é obrigatório");
      return;
    }
    try {
      await createMut.mutateAsync({
        clientName: form.clientName,
        clientEmail: form.clientEmail || undefined,
        clientPhone: form.clientPhone || undefined,
        bookingRef: form.bookingRef || undefined,
        vehiclePlate: form.vehiclePlate || undefined,
        itemType: form.itemType,
        description: form.description,
        estimatedValue: form.estimatedValue ? parseInt(form.estimatedValue) : undefined,
        priority: form.priority,
      });
      utils.lostFound.list.invalidate();
      toast.success("Registo criado com sucesso");
      onClose();
    } catch (e: any) {
      toast.error(e.message || "Erro ao criar registo");
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="w-5 h-5 text-amber-500" /> Novo Perdido/Achado
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pr-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <Label>Nome do Cliente *</Label>
              <Input value={form.clientName} onChange={e => setForm(f => ({ ...f, clientName: e.target.value }))} placeholder="Nome completo" />
            </div>
            <div>
              <Label>Email</Label>
              <Input value={form.clientEmail} onChange={e => setForm(f => ({ ...f, clientEmail: e.target.value }))} placeholder="email@exemplo.com" />
            </div>
            <div>
              <Label>Telefone</Label>
              <Input value={form.clientPhone} onChange={e => setForm(f => ({ ...f, clientPhone: e.target.value }))} placeholder="+351 ..." />
            </div>
            <div className="sm:col-span-2">
              <BookingSearchField
                accent="emerald"
                label="Buscar reserva (nº reserva, matrícula, email, nome) *"
                hint="Escolhe uma reserva e os dados do cliente / matrícula são preenchidos automaticamente"
                onSelect={(b, details) => {
                  const ref = b.externalId || b.bookingNumber || "";
                  const client = details?.customer || details?.client;
                  setForm(f => ({
                    ...f,
                    bookingRef: ref,
                    clientName: f.clientName || [client?.firstName, client?.lastName, b.clientFirstName, b.clientLastName].filter(Boolean).slice(0, 2).join(" "),
                    clientEmail: f.clientEmail || client?.email || b.clientEmail || "",
                    clientPhone: f.clientPhone || client?.phoneNumber || b.clientPhone || "",
                    vehiclePlate: f.vehiclePlate || details?.vehicle?.licensePlate || b.licensePlate || "",
                  }));
                }}
              />
              {form.bookingRef && (
                <div className="mt-2 p-2 rounded border bg-muted text-xs flex items-center justify-between">
                  <span className="font-mono">Reserva: {form.bookingRef}</span>
                  <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setForm(f => ({ ...f, bookingRef: "" }))}>limpar</button>
                </div>
              )}
              {form.bookingRef && <LostFoundReservationPreview bookingId={form.bookingRef} />}
            </div>
            <div>
              <Label>Matrícula</Label>
              <Input value={form.vehiclePlate} onChange={e => setForm(f => ({ ...f, vehiclePlate: e.target.value.toUpperCase() }))} placeholder="AA-00-BB" />
            </div>
          </div>
          <Separator />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Tipo de Item *</Label>
              <Select value={form.itemType} onValueChange={(v: any) => setForm(f => ({ ...f, itemType: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(TYPE_CONFIG).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Prioridade</Label>
              <Select value={form.priority} onValueChange={(v: any) => setForm(f => ({ ...f, priority: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(PRIORITY_CONFIG).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Valor Estimado (€)</Label>
              <Input type="number" value={form.estimatedValue} onChange={e => setForm(f => ({ ...f, estimatedValue: e.target.value }))} placeholder="0" />
            </div>
          </div>
          <div>
            <Label>Descrição *</Label>
            <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Descrever o item perdido/achado..." rows={3} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={handleSubmit} disabled={createMut.isPending}>
            {createMut.isPending ? "A criar..." : "Criar Registo"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── BOOKING HISTORY VIEW ────────────────────────────────────────────────────

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

function BookingHistoryView({ onBack }: { onBack: () => void }) {
  const [searchTerm, setSearchTerm] = useState("");
  const [activeSearch, setActiveSearch] = useState("");

  const { data: history = [], isLoading } = trpc.lostFound.bookingHistory.useQuery(
    { search: activeSearch || undefined },
    { enabled: !!activeSearch }
  );
  const { data: driverStats = [] } = trpc.lostFound.bookingHistoryDriverStats.useQuery();

  const handleSearch = () => setActiveSearch(searchTerm.trim());

  const fmtDate = (d: string | null) => d ? fmtPTDateTime(d) : "—";

  // Conta totais flagged
  const flaggedDrivers = driverStats.filter((d: any) => d.flagged).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Clock className="w-6 h-6 text-indigo-500" /> Histórico de Reservas
            </h1>
            <p className="text-muted-foreground">
              Histórico Multipark sincronizado (cron 15min). Condutores envolvidos em casos de perdidos/achados
              aparecem sinalizados.
            </p>
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="flex gap-2">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-muted-foreground" />
          <Input
            placeholder="Pesquisar por ID reserva, matrícula ou condutor..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            className="pl-8"
          />
        </div>
        <Button onClick={handleSearch} disabled={isLoading}>
          {isLoading ? "A procurar..." : "Pesquisar"}
        </Button>
      </div>

      {/* Driver stats summary */}
      {driverStats.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              Actividade por Condutor (histórico total)
              {flaggedDrivers > 0 && (
                <Badge className="bg-red-500 text-white text-[10px]">
                  <Flag className="w-3 h-3 mr-1" /> {flaggedDrivers} envolvidos em casos
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="bg-muted/50 text-left">
                    <th className="p-2">Condutor</th>
                    <th className="p-2 text-right">Casos</th>
                    <th className="p-2 text-right">Total</th>
                    <th className="p-2 text-right">Check-ins</th>
                    <th className="p-2 text-right">Check-outs</th>
                    <th className="p-2 text-right">Movimentos</th>
                  </tr>
                </thead>
                <tbody>
                  {driverStats.filter((d: any) => d.userName).map((d: any) => (
                    <tr
                      key={d.userName}
                      className={`border-t cursor-pointer ${d.flagged ? "bg-red-50 hover:bg-red-100" : "hover:bg-muted/30"}`}
                      onClick={() => { setSearchTerm(d.userName); setActiveSearch(d.userName); }}
                    >
                      <td className="p-2 font-medium">
                        <div className="flex items-center gap-2">
                          <span>{d.userName}</span>
                          {d.flagged === 1 && (
                            <Badge className="bg-red-500 text-white text-[10px]">
                              <Flag className="w-3 h-3 mr-1" /> Envolvido
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="p-2 text-right">
                        {d.caseCount > 0 ? (
                          <Badge variant={d.caseCount > 2 ? "destructive" : "outline"}>{d.caseCount}</Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="p-2 text-right">{d.total}</td>
                      <td className="p-2 text-right text-green-600">{d.checkins}</td>
                      <td className="p-2 text-right text-violet-600">{d.checkouts}</td>
                      <td className="p-2 text-right text-amber-600">{d.movements}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Results */}
      {activeSearch && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              Resultados para "{activeSearch}" — {history.length} registos
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {history.length === 0 ? (
              <p className="p-4 text-center text-muted-foreground">
                Sem resultados. Confirma que a reserva já foi sincronizada pela API Multipark.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="bg-muted/50 text-left">
                      <th className="p-2">Data</th>
                      <th className="p-2">Tipo</th>
                      <th className="p-2">Condutor</th>
                      <th className="p-2">ID Reserva</th>
                      <th className="p-2">Matrícula</th>
                      <th className="p-2">Observações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h: any) => {
                      const cfg = CHANGE_TYPE_CONFIG[h.changeType] || { label: h.changeType, color: "bg-gray-100 text-gray-800" };
                      return (
                        <tr
                          key={h.id}
                          className={`border-t ${h.flagged ? "bg-red-50 hover:bg-red-100" : "hover:bg-muted/30"}`}
                        >
                          <td className="p-2 text-xs whitespace-nowrap">{fmtDate(h.actionDate)}</td>
                          <td className="p-2">
                            <Badge className={cfg.color}>{cfg.label}</Badge>
                          </td>
                          <td className="p-2 font-medium">
                            <div className="flex items-center gap-1">
                              <span>{[h.userName, h.userLastName].filter(Boolean).join(" ") || "—"}</span>
                              {h.flagged === 1 && (
                                <Flag className="w-3 h-3 text-red-500" />
                              )}
                            </div>
                          </td>
                          <td className="p-2 font-mono text-xs">{h.bookingId?.slice(-12)}</td>
                          <td className="p-2 font-mono">{h.licensePlate || "—"}</td>
                          <td className="p-2 text-xs text-muted-foreground">{h.remarks || "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Devolução estruturada + email ao cliente ────────────────────────────────
function ReturnPanel({ item }: { item: any }) {
  const utils = trpc.useUtils();
  const [form, setForm] = useState({
    foundLocation: item.foundLocation || "",
    foundByName: item.foundByName || "",
    returnMethod: item.returnMethod || "",
    returnedAt: item.returnedAt ? String(item.returnedAt).slice(0, 10) : "",
  });
  const [emailOpen, setEmailOpen] = useState(false);
  const save = trpc.lostFound.update.useMutation({
    onSuccess: () => { utils.lostFound.getById.invalidate({ id: item.id }); toast.success("Devolução guardada"); },
    onError: (e) => toast.error(e.message),
  });
  const uploadReturn = trpc.lostFound.uploadReturnPhoto.useMutation({
    onSuccess: () => { utils.lostFound.getById.invalidate({ id: item.id }); toast.success("Foto da entrega guardada"); },
    onError: (e) => toast.error(e.message),
  });
  const onPhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => uploadReturn.mutate({ itemId: item.id, base64: String(r.result).split(",")[1], filename: f.name });
    r.readAsDataURL(f);
    e.target.value = "";
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center justify-between gap-2">
          <span>Devolução ao cliente</span>
          {item.clientEmail && (
            <Button size="sm" variant="outline" onClick={() => setEmailOpen(true)}>
              <Mail className="w-4 h-4 mr-1" /> Avisar cliente
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div><Label className="text-xs">Onde foi encontrado</Label>
            <Input value={form.foundLocation} onChange={e => setForm(f => ({ ...f, foundLocation: e.target.value }))} placeholder="Ex: porta-luvas, lugar A12" /></div>
          <div><Label className="text-xs">Quem encontrou</Label>
            <Input value={form.foundByName} onChange={e => setForm(f => ({ ...f, foundByName: e.target.value }))} placeholder="Condutor / agente" /></div>
          <div><Label className="text-xs">Como foi devolvido</Label>
            <Select value={form.returnMethod || "none"} onValueChange={v => setForm(f => ({ ...f, returnMethod: v === "none" ? "" : v }))}>
              <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">—</SelectItem>
                <SelectItem value="em_maos">Em mãos (no parque)</SelectItem>
                <SelectItem value="correio">Correio / transportadora</SelectItem>
                <SelectItem value="entrega">Entrega ao domicílio</SelectItem>
                <SelectItem value="outro">Outro</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div><Label className="text-xs">Data da devolução</Label>
            <Input type="date" value={form.returnedAt} onChange={e => setForm(f => ({ ...f, returnedAt: e.target.value }))} /></div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <Button size="sm" disabled={save.isPending} onClick={() => save.mutate({
            id: item.id,
            foundLocation: form.foundLocation || null,
            foundByName: form.foundByName || null,
            returnMethod: form.returnMethod || null,
            returnedAt: form.returnedAt ? form.returnedAt + " 00:00:00" : null,
          })}>
            <CheckCircle2 className="w-4 h-4 mr-1" /> Guardar devolução
          </Button>
          <label className="text-xs text-blue-600 cursor-pointer inline-flex items-center gap-1">
            <Upload className="w-3 h-3" /> Foto/assinatura da entrega
            <input type="file" accept="image/*" className="hidden" onChange={onPhoto} />
          </label>
          {(item.returnPhotoUrl || item.returnPhotoKey) && <a href={fileHref(item.returnPhotoUrl, item.returnPhotoKey) ?? undefined} target="_blank" rel="noreferrer" className="text-xs underline">ver foto</a>}
        </div>
        {item.clientEmailSentAt && (
          <p className="text-xs text-muted-foreground">Cliente avisado por email em {fmtPTDateTime(item.clientEmailSentAt)}</p>
        )}
      </CardContent>
      {emailOpen && <ReturnEmailDialog item={item} onClose={() => setEmailOpen(false)} />}
    </Card>
  );
}

function ReturnEmailDialog({ item, onClose }: { item: any; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [subject, setSubject] = useState(`Multipark — objeto encontrado`);
  const [body, setBody] = useState(
    `Informamos que foi encontrado um objeto associado à sua reserva${item.bookingRef ? ` ${item.bookingRef}` : ""}: ${item.description}.\n\n` +
    `Pode levantá-lo no parque ou responder a este email para combinarmos a devolução.\n\nObrigado.`
  );
  const send = trpc.lostFound.sendEmailToClient.useMutation({
    onSuccess: () => {
      utils.lostFound.getById.invalidate({ id: item.id });
      utils.lostFound.getMessages.invalidate({ itemId: item.id });
      toast.success("Email enviado ao cliente (e registado nas mensagens)");
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Avisar cliente — {item.clientEmail}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Assunto</Label><Input value={subject} onChange={e => setSubject(e.target.value)} /></div>
          <div><Label>Modelo</Label>
            <Select onValueChange={(k) => { const t = REPLY_TEMPLATES.find(x => x.key === k); if (t) setBody(t.body); }}>
              <SelectTrigger><SelectValue placeholder="Escolher modelo…" /></SelectTrigger>
              <SelectContent>
                {REPLY_TEMPLATES.map(t => <SelectItem key={t.key} value={t.key}>{t.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div><Label>Mensagem</Label><Textarea rows={6} value={body} onChange={e => setBody(e.target.value)} /></div>
          <p className="text-xs text-muted-foreground">Sai de perdidos@multipark.pt. A saudação ("Olá {"{nome}"}") é adicionada automaticamente.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={send.isPending || !subject || !body} onClick={() => send.mutate({ itemId: item.id, subject, body })}>
            <Mail className="w-4 h-4 mr-2" /> {send.isPending ? "A enviar…" : "Enviar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Condutores do caso (roubos): anexar quem mexeu no carro ──────────────────
function CaseDriversPanel({ itemId, agents, employees }: {
  itemId: number;
  agents: any[];
  employees: { id: number; fullName: string }[];
}) {
  const utils = trpc.useUtils();
  const { data: attached = [] } = trpc.lostFound.attachedDrivers.useQuery({ itemId });
  const attach = trpc.lostFound.attachDriver.useMutation({
    onSuccess: () => { utils.lostFound.attachedDrivers.invalidate({ itemId }); toast.success("Condutor anexado"); },
    onError: (e) => toast.error(e.message),
  });
  const detach = trpc.lostFound.detachDriver.useMutation({
    onSuccess: () => { utils.lostFound.attachedDrivers.invalidate({ itemId }); toast.success("Removido"); },
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
            <div className="min-w-0">
              <span className="font-medium">{a.driverName}</span>
              {a.movementDate && <span className="text-xs text-muted-foreground ml-2">{a.movementDate}</span>}
              {a.source === "history" && <Badge variant="outline" className="ml-2 text-[10px]">do carro</Badge>}
              {a.movementsSummary && <p className="text-xs text-muted-foreground">{a.movementsSummary}</p>}
              {a.notes && <p className="text-xs">{a.notes}</p>}
            </div>
            <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" onClick={() => detach.mutate({ id: a.id })}><Trash2 className="w-3 h-3" /></Button>
          </div>
        )) : <p className="text-xs text-muted-foreground">Nenhum condutor anexado a este caso.</p>}

        {agents.length > 0 && (
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

        <div className="border-t pt-2 space-y-2">
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
        </div>
      </CardContent>
    </Card>
  );
}
