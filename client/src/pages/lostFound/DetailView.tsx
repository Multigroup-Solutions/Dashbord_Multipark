import { trpc } from "@/lib/trpc";
import { can, roleRank, seesBeyondOwn } from "@shared/access";
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
import { ReturnPanel } from "./ReturnPanel";
import { MatchesPanel } from "./MatchesPanel";
import { CaseDriversPanel } from "./CaseDriversPanel";

// ─── DETAIL VIEW ──────────────────────────────────────────────────────────────

export function DetailView({ id, user, onBack }: { id: number; user: any; onBack: () => void }) {
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
  const refreshBookingMut = trpc.lostFound.refreshBookingData.useMutation({
    onSuccess: (r) => {
      if (r.ok) {
        toast.success(r.detail);
        utils.lostFound.bookingDossier.invalidate();
        utils.lostFound.bookingTimeline.invalidate();
        utils.lostFound.vehicleAgents.invalidate();
        utils.lostFound.getById.invalidate({ id });
      } else {
        toast.error(r.detail);
      }
    },
    onError: () => toast.error("Erro ao contactar a API Multipark"),
  });
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
  const convertMut = trpc.lostFound.convertToComplaint.useMutation({
    onSuccess: (r) => { toast.success(`Convertido na Reclamação #${r.newId} (este caso fica fechado e ligado)`); utils.lostFound.list.invalidate(); utils.lostFound.getById.invalidate({ id }); utils.complaints.list.invalidate(); },
    onError: (e) => toast.error(e.message || "Erro ao mover"),
  });
  const utils = trpc.useUtils();
  const canSeeDrivers = seesBeyondOwn(user, "perdidos") && can(user, "perdidos", "edit");

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
    await updateMut.mutateAsync({ id, status: status as (typeof KANBAN_COLUMNS)[number] });
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
        <div className="w-full sm:w-auto sm:flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <TypeIcon className="w-5 h-5 shrink-0 text-amber-700" />
            <h1 className="text-xl font-bold line-clamp-2 break-words">{item.description}</h1>
            <Badge className={STATUS_CONFIG[item.status]?.color}>{STATUS_CONFIG[item.status]?.label}</Badge>
            <Badge className={PRIORITY_CONFIG[item.priority]?.color}>{PRIORITY_CONFIG[item.priority]?.label}</Badge>
            {(() => {
              if (item.status === "returned" || item.status === "closed" || item.status === "converted") return null;
              const days = Math.floor((Date.now() - new Date(String(item.createdAt).replace(" ", "T") + "Z").getTime()) / 86400000);
              if (days < 1) return null;
              const cls = days >= 7 ? "bg-red-100 text-red-700 border-red-200" : days >= 3 ? "bg-amber-100 text-amber-700 border-amber-200" : "bg-slate-100 text-slate-600";
              return <Badge variant="outline" className={cls}>Parado há {days} {days === 1 ? "dia" : "dias"}</Badge>;
            })()}
          </div>
          <p className="text-sm text-muted-foreground">Caso #{item.id} — Criado em {fmtPTDate(item.createdAt)}</p>
          <div className="flex flex-wrap gap-2 mt-1">
            {item.projectId == null && <Badge variant="destructive">Sem cidade — atribui em "Atribuição & prazo"</Badge>}
            {item.status === "converted" && item.convertedToId && (
              <a href={item.convertedToType === "complaint" ? `/reclamacoes?id=${item.convertedToId}` : "#"} className="text-xs underline text-violet-700">
                Convertido em {item.convertedToType === "complaint" ? "Reclamação" : item.convertedToType} #{item.convertedToId} (caso fechado)
              </a>
            )}
            {item.convertedFromType && item.convertedFromId && (
              <a
                href={item.convertedFromType === "complaint" ? `/reclamacoes?id=${item.convertedFromId}` : item.convertedFromType === "incident" ? `/ocorrencias?id=${item.convertedFromId}` : "#"}
                className="text-xs underline text-muted-foreground"
              >
                Veio de {item.convertedFromType === "complaint" ? "Reclamação" : item.convertedFromType === "incident" ? "Ocorrência" : item.convertedFromType} #{item.convertedFromId}
              </a>
            )}
            {item.relatedComplaintId && (
              <a href={`/reclamacoes?id=${item.relatedComplaintId}`} className="text-xs underline text-amber-700">
                Relacionado com reclamação #{item.relatedComplaintId}
              </a>
            )}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={startEditing}><Pencil className="w-4 h-4 mr-1" /> Editar</Button>
        <Select value={item.status} onValueChange={handleStatusChange} disabled={item.status === "converted"}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.entries(STATUS_CONFIG).filter(([k]) => k !== "converted" || item.status === "converted").map(([k, v]) => (
              <SelectItem key={k} value={k} disabled={k === "converted"}>{v.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {can(user, "perdidos", "manage") && item.status !== "converted" && (
          <>
            <Button
              variant="outline" size="sm"
              disabled={convertMut.isPending}
              title="Isto afinal é uma Reclamação — cria a reclamação e fecha este caso (ligados)"
              onClick={() => {
                if (!confirm("Converter em Reclamação? A reclamação nova leva mensagens, fotos e condutores; este caso fica fechado como 'Convertido' e ligado a ela.")) return;
                convertMut.mutate({ id });
              }}
            >
              <MessageSquareWarning className="w-4 h-4 mr-1" /> {convertMut.isPending ? "A converter…" : "Converter em Reclamação"}
            </Button>
            <Button variant="destructive" size="sm" onClick={handleDelete}><Trash2 className="w-4 h-4" /></Button>
          </>
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
                      <p className="font-medium tabular-nums">{item.estimatedValue ? `${Number(item.estimatedValue).toLocaleString("pt-PT")} €` : "N/A"}</p>
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
                  {!item.bookingRef ? (
                    <Button
                      size="sm" variant="outline"
                      disabled={autoLinkMut.isPending}
                      onClick={() => autoLinkMut.mutate({ id: item.id })}
                    >
                      {autoLinkMut.isPending ? "A procurar…" : "Ligar reserva automaticamente"}
                    </Button>
                  ) : (
                    <Button
                      size="sm" variant="outline"
                      disabled={refreshBookingMut.isPending}
                      title="Vai buscar à API Multipark a reserva completa e o histórico de condutores desta reserva"
                      onClick={() => refreshBookingMut.mutate({ reservationRef: item.bookingRef! })}
                    >
                      <RefreshCw className={`w-3.5 h-3.5 mr-1 ${refreshBookingMut.isPending ? "animate-spin" : ""}`} />
                      {refreshBookingMut.isPending ? "A atualizar…" : "Atualizar da API"}
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

              <MatchesPanel item={item} canEdit={can(user, "perdidos", "edit")} />

              {canSeeDrivers && <RepeatDriversCard itemId={item.id} />}

              <ReturnPanel item={item} />

              <CaseDriversPanel
                role={user?.role}
                itemId={item.id}
                agents={vehicleAgents as any[]}
                employees={(lfEmployees as any[]).map(e => e.employee ?? e).map((e: any) => ({ id: e.id, fullName: e.fullName }))}
              />
            </TabsContent>

            <TabsContent value="messages" className="space-y-4">
              <Card>
                <CardContent className="p-4 space-y-4">
                  <CaseMessageList
                    messages={(messages as any[]).map((m: any) => ({
                      id: m.id, author: m.userName, createdAt: m.createdAt,
                      message: m.message, isInternal: m.isInternal,
                    }))}
                  />
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
                      <input type="file" accept="image/*,application/pdf" className="hidden" onChange={handlePhotoUpload} />
                      <Button variant="outline" asChild><span><Upload className="w-4 h-4 mr-2" /> Carregar Foto</span></Button>
                    </label>
                  </div>
                  {photos.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">Sem fotos</p>
                  ) : (
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                      {photos.map((p: any) => (
                        <div key={p.id} className="relative group">
                          {p.isPdf ? (
                            <a href={p.url} target="_blank" rel="noreferrer" className="flex h-32 items-center justify-center rounded-lg border bg-muted text-sm underline">
                              <FileText className="w-5 h-5 mr-1" /> Abrir PDF
                            </a>
                          ) : (
                            <a href={p.url} target="_blank" rel="noreferrer">
                              <img src={p.url || fileHref(null, p.fileKey) || undefined} alt={p.caption || "Foto"} className="rounded-lg w-full h-32 object-cover" />
                            </a>
                          )}
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
                                <Badge className="bg-red-600 text-white text-[11px]">
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
                      {item.bookingRef && item.bookingRef.length >= 20 && (
                        <Button size="sm" variant="outline" className="h-7 text-xs gap-1 ml-2" onClick={() => openInMultipark(item.bookingRef)}>
                          Ver na Multipark <ExternalLink className="w-3 h-3" />
                        </Button>
                      )}
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
                                  {(() => {
                                    const lines = formatBookingHistoryDetails(h.remarks);
                                    if (!lines.length) return null;
                                    return (
                                      <ul className="text-xs text-muted-foreground mt-1 space-y-0.5">
                                        {lines.map((l: string, li: number) => <li key={li}>{l}</li>)}
                                      </ul>
                                    );
                                  })()}
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
                    <span className="font-medium text-amber-800 tabular-nums">{Number(item.estimatedValue).toLocaleString("pt-PT")} €</span>
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

/**
 * Condutores deste caso que aparecem noutros casos abertos/recentes — o sinal
 * mais útil do Cruzamento, mostrado onde se investiga. Team leader+.
 */
function RepeatDriversCard({ itemId }: { itemId: number }) {
  const { data = [] } = trpc.lostFound.caseRepeatDrivers.useQuery({ itemId }, { retry: false });
  if (!data.length) return null;
  return (
    <Card className="border-red-300 bg-red-50/60 dark:bg-red-950/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2 text-red-700">
          <ShieldAlert className="w-4 h-4" /> Condutores que se repetem
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        {data.map((d) => (
          <div key={d.key} className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{d.name}</span>
            <Badge variant="destructive">aparece em {d.otherCaseIds.length} {d.otherCaseIds.length === 1 ? "outro caso" : "outros casos"}</Badge>
            <span className="text-xs text-muted-foreground">
              {d.otherCaseIds.slice(0, 8).map((cid) => (
                <a key={cid} href={`${BASE_PATH}/caso/${cid}`} className="underline mr-1">#{cid}</a>
              ))}
            </span>
          </div>
        ))}
        <p className="text-[11px] text-muted-foreground">Casos abertos ou dos últimos 180 dias, pela reserva (quem mexeu) e pelos condutores anexados.</p>
      </CardContent>
    </Card>
  );
}
