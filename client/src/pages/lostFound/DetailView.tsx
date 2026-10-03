import { trpc } from "@/lib/trpc";
import { CommunicationsTimeline } from "@/components/mail/CommunicationsTimeline";
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
import { Link, useLocation } from "wouter";
import BookingSearchField from "@/components/BookingSearchField";
import ClientHistoryCard from "@/components/ClientHistoryCard";
import CaseAssignmentCard from "@/components/CaseAssignmentCard";
import LinkInboundEmailButton from "@/components/LinkInboundEmailButton";
import {
  Search, Plus, Clock, User, Car,
  ChevronRight, ChevronLeft, Send, Eye, Trash2, Upload, Pencil,
  BarChart3, AlertCircle, CheckCircle2, Hourglass, XCircle,
  Package, DollarSign, Smartphone, Shirt, FileText, Glasses,
  HelpCircle, TrendingUp, ShieldAlert, Flag, Mail, Download, Truck, GripVertical, MessageSquareWarning, ExternalLink, FileSearch } from "lucide-react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { STATUS_CONFIG, TYPE_CONFIG, PRIORITY_CONFIG, KANBAN_COLUMNS, BASE_PATH, CHANGE_TYPE_CONFIG } from "./config";
import { MarkReturnedDialog, ReturnPanel } from "./ReturnPanel";
import { lostAgeTone } from "@shared/caseRules";
import { MatchesPanel } from "./MatchesPanel";
import { CaseDriversPanel } from "./CaseDriversPanel";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { compressImage } from "@/lib/compressImage";
import { useConfirm } from "../training/shared";
import { Archive, ArchiveRestore } from "lucide-react";

// ─── DETAIL VIEW ──────────────────────────────────────────────────────────────

export function DetailView({ id, user, onBack }: { id: number; user: any; onBack: () => void }) {
  const itemQ = trpc.lostFound.getById.useQuery({ id });
  const { data: item, isLoading } = itemQ;
  // Quem só vê os próprios casos não lê a reserva, a viatura nem os condutores
  // (as rotas recusam): fica sem esses separadores em vez de erros (16c).
  const seesMore = seesBeyondOwn(user, "perdidos");
  const canEdit = can(user, "perdidos", "edit");
  const canManage = can(user, "perdidos", "manage");
  // D19: condutores não abrem reclamações — os números aparecem sem link.
  const complaintHref = (cid: number | null | undefined) => (cid != null && seesBeyondOwn(user, "reclamacoes") ? `/reclamacoes?id=${cid}` : undefined);
  const photosQ = trpc.lostFound.getPhotos.useQuery({ itemId: id });
  const { data: photos = [] } = photosQ;
  const messagesQ = trpc.lostFound.getMessages.useQuery({ itemId: id });
  const { data: messages = [] } = messagesQ;
  const vehicleAgentsQ = trpc.lostFound.vehicleAgents.useQuery(
    { plate: item?.vehiclePlate || "", currentBookingRef: item?.bookingRef || undefined },
    { enabled: seesMore && !!item?.vehiclePlate }
  );
  const { data: vehicleAgents = [] } = vehicleAgentsQ;
  const timelineQ = trpc.lostFound.bookingTimeline.useQuery(
    { bookingId: item?.bookingRef || "" },
    { enabled: seesMore && !!item?.bookingRef }
  );
  const { data: apiTimeline, isLoading: timelineLoading } = timelineQ;
  // Dossier completo da reserva ligada — automático, sem passos manuais.
  const dossierQ = trpc.lostFound.bookingDossier.useQuery(
    { reservationRef: item?.bookingRef || "" },
    { enabled: seesMore && !!item?.bookingRef }
  );
  const dossier = dossierQ.data;
  const [confirm, confirmUi] = useConfirm();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveReason, setArchiveReason] = useState("");
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
  const { data: lfProjects = [] } = trpc.projects.list.useQuery(undefined, { enabled: canEdit });
  const { data: lfEmployees = [] } = trpc.rh.list.useQuery(undefined, { enabled: canEdit });
  const updateMut = trpc.lostFound.update.useMutation();
  const uploadPhotoMut = trpc.lostFound.uploadPhoto.useMutation();
  const addMsgMut = trpc.lostFound.addMessage.useMutation();
  // "Eliminar" passou a arquivar (com motivo): nada se apaga, nem os ficheiros (16c).
  const archiveMut = trpc.lostFound.archive.useMutation({
    onSuccess: () => { toast.success("Caso arquivado"); setArchiveOpen(false); setArchiveReason(""); utils.lostFound.list.invalidate(); utils.lostFound.getById.invalidate({ id }); onBack(); },
    onError: (e) => toast.error(e.message || "Erro ao arquivar"),
  });
  const unarchiveMut = trpc.lostFound.unarchive.useMutation({
    onSuccess: () => { toast.success("Caso tirado do arquivo"); utils.lostFound.list.invalidate(); utils.lostFound.getById.invalidate({ id }); },
    onError: (e) => toast.error(e.message || "Erro ao tirar do arquivo"),
  });
  const convertMut = trpc.lostFound.convertToComplaint.useMutation({
    onSuccess: (r) => { toast.success(`Convertido na Reclamação #${r.newId} (este caso fica fechado e ligado)`); utils.lostFound.list.invalidate(); utils.lostFound.getById.invalidate({ id }); utils.complaints.list.invalidate(); },
    onError: (e) => toast.error(e.message || "Erro ao mover"),
  });
  const utils = trpc.useUtils();
  const canSeeDrivers = seesBeyondOwn(user, "perdidos") && can(user, "perdidos", "edit");

  const [newMsg, setNewMsg] = useState("");
  const [isInternal, setIsInternal] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  // D22: "Devolvido" pede como e quando (janela própria).
  const [returning, setReturning] = useState(false);
  const [editForm, setEditForm] = useState<any>(null);

  // Erro (sem acesso, não existe, falha) ≠ a carregar para sempre (16c).
  if (itemQ.isError) {
    return (
      <div className="space-y-4">
        <Button variant="outline" onClick={onBack}><ChevronLeft className="w-4 h-4 mr-1" /> Voltar</Button>
        <QueryErrorNote error={itemQ.error} what={`o caso #${id}`} onRetry={() => itemQ.refetch()} retrying={itemQ.isFetching} />
      </div>
    );
  }
  if (isLoading || !item) return <div className="flex justify-center py-20"><div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" /></div>;

  const TypeIcon = TYPE_CONFIG[item.itemType]?.icon || Package;
  const archived = !!(item as any).archivedAt;

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
      // Campos de contacto vazios limpam (antes ficavam como estavam) — 16c.
      await updateMut.mutateAsync({
        id,
        clientName: editForm.clientName || undefined,
        clientEmail: editForm.clientEmail.trim(),
        clientPhone: editForm.clientPhone.trim(),
        bookingRef: editForm.bookingRef.trim(),
        vehiclePlate: editForm.vehiclePlate.trim(),
        itemType: editForm.itemType || undefined,
        description: editForm.description || undefined,
        estimatedValue: editForm.estimatedValue === "" || editForm.estimatedValue == null ? 0 : Number(editForm.estimatedValue),
        priority: editForm.priority || undefined,
        clientNotes: editForm.clientNotes || null,
      });
      utils.lostFound.getById.invalidate({ id });
      utils.lostFound.list.invalidate();
      setIsEditing(false);
      toast.success("Registo atualizado");
    } catch (e: any) { toast.error(e?.message || "Erro ao atualizar"); }
  };

  // Mutações com erro visível (antes falhavam em silêncio) — 16c.
  const handleStatusChange = async (status: string) => {
    if (status === "returned" && item?.status !== "returned") { setReturning(true); return; }
    try {
      await updateMut.mutateAsync({ id, status: status as (typeof KANBAN_COLUMNS)[number] });
      utils.lostFound.getById.invalidate({ id });
      utils.lostFound.list.invalidate();
      toast.success("Estado atualizado");
    } catch (e: any) { toast.error(e?.message || "Erro ao mudar o estado"); }
  };

  const handleSendMsg = async () => {
    if (!newMsg.trim()) return;
    try {
      await addMsgMut.mutateAsync({ itemId: id, message: newMsg, isInternal });
      setNewMsg("");
      utils.lostFound.getMessages.invalidate({ itemId: id });
      toast.success("Mensagem guardada no caso");
    } catch (e: any) { toast.error(e?.message || "Erro ao guardar a mensagem"); }
  };

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const original = e.target.files?.[0];
    e.target.value = "";
    if (!original) return;
    try {
      // Fotos reduzidas antes de enviar (limite de ~4,5 MB por pedido); PDFs tal e qual.
      const file = original.type.startsWith("image/") ? await compressImage(original, 1600, 0.85) : original;
      const base64: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(",")[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      await uploadPhotoMut.mutateAsync({ itemId: id, base64, filename: file.name });
      utils.lostFound.getPhotos.invalidate({ itemId: id });
      toast.success("Foto carregada");
    } catch (err: any) { toast.error(err?.message || "Não foi possível carregar a foto"); }
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
              // D24: cor pelo prazo (Atribuição, senão Definições → sla.lostFoundDays).
              const age = lostAgeTone(item, Date.now(), item.slaDays);
              if (!age || age.days < 1) return null;
              const cls = age.tone === "late" ? "bg-red-100 text-red-700 border-red-200" : age.tone === "warn" ? "bg-amber-100 text-amber-700 border-amber-200" : "bg-slate-100 text-slate-600";
              return <Badge variant="outline" className={cls}>Parado há {age.days} {age.days === 1 ? "dia" : "dias"}</Badge>;
            })()}
          </div>
          <p className="text-sm text-muted-foreground">Caso #{item.id} — Criado em {fmtPTDate(item.createdAt)}</p>
          <div className="flex flex-wrap gap-2 mt-1">
            {item.projectId == null && <Badge variant="destructive">Sem cidade — atribui em "Atribuição & prazo"</Badge>}
            {item.status === "converted" && item.convertedToId && (
              <a href={item.convertedToType === "complaint" ? complaintHref(item.convertedToId) : undefined} className="text-xs underline text-violet-700">
                Convertido em {item.convertedToType === "complaint" ? "Reclamação" : item.convertedToType} #{item.convertedToId} (caso fechado)
              </a>
            )}
            {item.convertedFromType && item.convertedFromId && (
              <a
                href={item.convertedFromType === "complaint" ? complaintHref(item.convertedFromId) : item.convertedFromType === "incident" ? `/ocorrencias?id=${item.convertedFromId}` : undefined}
                className="text-xs underline text-muted-foreground"
              >
                Veio de {item.convertedFromType === "complaint" ? "Reclamação" : item.convertedFromType === "incident" ? "Ocorrência" : item.convertedFromType} #{item.convertedFromId}
              </a>
            )}
            {item.relatedComplaintId && (
              <a href={complaintHref(item.relatedComplaintId)} className="text-xs underline text-amber-700">
                Relacionado com reclamação #{item.relatedComplaintId}
              </a>
            )}
          </div>
        </div>
        {canEdit && !archived && <Button variant="outline" size="sm" onClick={startEditing}><Pencil className="w-4 h-4 mr-1" /> Editar</Button>}
        <Select value={item.status} onValueChange={handleStatusChange} disabled={!canEdit || archived || item.status === "converted"}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.entries(STATUS_CONFIG).filter(([k]) => k !== "converted" || item.status === "converted").map(([k, v]) => (
              <SelectItem key={k} value={k} disabled={k === "converted"}>{v.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {canManage && (
          <>
            {item.status !== "converted" && !archived && <Button
              variant="outline" size="sm"
              disabled={convertMut.isPending}
              title="Isto afinal é uma Reclamação — cria a reclamação e fecha este caso (ligados)"
              onClick={async () => {
                if (!(await confirm({ title: "Converter em Reclamação?", description: "A reclamação nova leva mensagens, fotos e condutores; este caso fica fechado como 'Convertido' e ligado a ela.", confirmLabel: "Converter" }))) return;
                convertMut.mutate({ id });
              }}
            >
              <MessageSquareWarning className="w-4 h-4 mr-1" /> {convertMut.isPending ? "A converter…" : "Converter em Reclamação"}
            </Button>}
            {archived ? (
              <Button variant="outline" size="sm" disabled={unarchiveMut.isPending} onClick={() => unarchiveMut.mutate({ id })}>
                <ArchiveRestore className="w-4 h-4 mr-1" /> {unarchiveMut.isPending ? "A tirar…" : "Tirar do arquivo"}
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setArchiveOpen(true)} title="Sai das listas e contadores; nada é apagado">
                <Archive className="w-4 h-4 mr-1" /> Arquivar
              </Button>
            )}
          </>
        )}
      </div>

      {archived && (
        <div role="status" className="rounded-md border border-slate-300 bg-slate-50 p-3 text-sm text-slate-800 dark:bg-slate-900/40 dark:text-slate-200">
          <Archive className="w-4 h-4 inline mr-1" /> Arquivado{(item as any).archivedAt ? ` em ${fmtPTDateTime((item as any).archivedAt)}` : ""}{(item as any).archiveReason ? ` — ${(item as any).archiveReason}` : ""}.
          {" "}Não entra nas listas, contadores, lembretes nem no cruzamento. Nada foi apagado.
        </div>
      )}

      <Dialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Arquivar o caso #{id}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">Sai das listas, dos contadores, dos lembretes e do cruzamento. O caso, as mensagens, as fotos e os ficheiros ficam guardados; os pontos ainda por confirmar são anulados. Pode voltar com "Tirar do arquivo".</p>
          <div>
            <Label>Porquê?</Label>
            <Input value={archiveReason} onChange={(e) => setArchiveReason(e.target.value)} placeholder="Ex.: duplicado do #123, teste" maxLength={255} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setArchiveOpen(false)}>Cancelar</Button>
            <Button disabled={archiveReason.trim().length < 3 || archiveMut.isPending} onClick={() => archiveMut.mutate({ id, reason: archiveReason.trim() })}>
              <Archive className="w-4 h-4 mr-1" /> {archiveMut.isPending ? "A arquivar…" : "Arquivar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {confirmUi}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Details */}
        <div className="lg:col-span-2 space-y-4">
          <Tabs defaultValue="details">
            <TabsList className="flex-wrap">
              <TabsTrigger value="details">Detalhes</TabsTrigger>
              <TabsTrigger value="messages">Mensagens{messagesQ.isError ? "" : ` (${messages.length})`}</TabsTrigger>
              <TabsTrigger value="photos">Fotos{photosQ.isError ? "" : ` (${photos.length})`}</TabsTrigger>
              {seesMore && item.vehiclePlate && <TabsTrigger value="vehicle">Viatura</TabsTrigger>}
              {seesMore && item.bookingRef && <TabsTrigger value="booking-history">Histórico{timelineQ.isError || (apiTimeline as any)?.error ? "" : ` (${timelineHist.length})`}</TabsTrigger>}
              {seesMore && <TabsTrigger value="comms">Comunicações</TabsTrigger>}
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
                <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-base">Dados da Reserva</CardTitle>
                  {!seesMore ? null : !item.bookingRef ? (canEdit && !archived &&
                    <Button
                      size="sm" variant="outline"
                      disabled={autoLinkMut.isPending}
                      onClick={() => autoLinkMut.mutate({ id: item.id })}
                    >
                      {autoLinkMut.isPending ? "A procurar…" : "Ligar reserva automaticamente"}
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" asChild title="Tudo sobre esta reserva, lido ao vivo da BD da Multipark">
                      <Link href={`/reserva/${encodeURIComponent((dossier?.booking as any)?.externalId || item.bookingRef!)}`}>
                        <FileSearch className="w-3.5 h-3.5 mr-1" /> Abrir ficha da reserva
                      </Link>
                    </Button>
                  )}
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {!item.bookingRef ? (
                    <p className="text-xs text-muted-foreground">Sem reserva ligada{canEdit ? " — usa o botão para procurar pela matrícula/contactos do cliente." : "."}</p>
                  ) : !seesMore ? (
                    <p className="text-xs text-muted-foreground">Ref. Reserva: {item.bookingRef}</p>
                  ) : dossierQ.isError ? (
                    <QueryErrorNote error={dossierQ.error} what="a reserva" onRetry={() => dossierQ.refetch()} retrying={dossierQ.isFetching} />
                  ) : dossier?.error ? (
                    // Multipark sem resposta ≠ "não corresponde a nenhuma reserva" (16c).
                    <QueryErrorNote error={{ message: dossier.error }} what="a reserva" onRetry={() => dossierQ.refetch()} retrying={dossierQ.isFetching} />
                  ) : !dossier ? (
                    <p className="text-xs text-muted-foreground animate-pulse">A ler a reserva da Multipark…</p>
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
                    <p className="text-xs text-muted-foreground">A ref. "{item.bookingRef}" não corresponde a nenhuma reserva na Multipark (nas tuas cidades).</p>
                  )}
                </CardContent>
              </Card>

              {seesMore && <ClientHistoryCard
                email={item.clientEmail}
                phone={item.clientPhone}
                plate={item.vehiclePlate}
                name={item.clientName}
                highlightRef={item.bookingRef}
              />}

              {canEdit && !archived && <LinkInboundEmailButton
                module="lostfound" alias="perdidos" caseId={item.id}
                defaultSearch={item.clientEmail || item.clientName}
                onLinked={() => utils.lostFound.getMessages.invalidate({ itemId: item.id })}
              />}

              {canEdit && !archived && <CaseAssignmentCard
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
                } as any, {
                  onSuccess: () => { utils.lostFound.getById.invalidate({ id: item.id }); toast.success("Atribuição guardada"); },
                  onError: (e) => toast.error(e.message || "Não foi possível guardar a atribuição"),
                })}
              />}

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

              {seesMore && <MatchesPanel item={item} canEdit={canEdit && !archived} />}

              {canSeeDrivers && <RepeatDriversCard itemId={item.id} />}

              <ReturnPanel item={item} canEdit={canEdit && !archived} />

              {seesMore && <CaseDriversPanel
                role={user?.role}
                canEdit={canEdit && !archived}
                itemId={item.id}
                agents={vehicleAgents as any[]}
                agentsFailed={vehicleAgentsQ.isError}
                employees={(lfEmployees as any[]).map(e => e.employee ?? e).map((e: any) => ({ id: e.id, fullName: e.fullName }))}
              />}
            </TabsContent>

            <TabsContent value="messages" className="space-y-4">
              <Card>
                <CardContent className="p-4 space-y-4">
                  {messagesQ.isError ? (
                    <QueryErrorNote error={messagesQ.error} what="as mensagens" onRetry={() => messagesQ.refetch()} retrying={messagesQ.isFetching} />
                  ) : <CaseMessageList
                    messages={(messages as any[]).map((m: any) => ({
                      id: m.id, author: m.userName, createdAt: m.createdAt,
                      message: m.message, isInternal: m.isInternal,
                    }))}
                  />}
                  {canEdit && !archived && <><Separator />
                  <div className="flex gap-2 flex-wrap">
                    <Input
                      placeholder="Escrever mensagem..."
                      value={newMsg}
                      onChange={e => setNewMsg(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && handleSendMsg()}
                      className="flex-1 min-w-0"
                    />
                    <label className="flex items-center gap-1 text-xs cursor-pointer">
                      <input type="checkbox" checked={isInternal} onChange={e => setIsInternal(e.target.checked)} />
                      Nota interna
                    </label>
                    <Button size="sm" onClick={handleSendMsg} disabled={!newMsg.trim() || addMsgMut.isPending} aria-label="Guardar mensagem">
                      <Send className="w-4 h-4" />
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">Fica no caso. Ao cliente só chega o que enviares com "Avisar cliente" (email).</p></>}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="photos" className="space-y-4">
              <Card>
                <CardContent className="p-4 space-y-4">
                  {canEdit && !archived && <div className="flex items-center gap-2">
                    <label className="cursor-pointer">
                      <input type="file" accept="image/*,application/pdf" className="hidden" onChange={handlePhotoUpload} />
                      <Button variant="outline" asChild disabled={uploadPhotoMut.isPending}><span><Upload className="w-4 h-4 mr-2" /> {uploadPhotoMut.isPending ? "A carregar…" : "Carregar Foto"}</span></Button>
                    </label>
                  </div>}
                  {photosQ.isError ? (
                    <QueryErrorNote error={photosQ.error} what="as fotos" onRetry={() => photosQ.refetch()} retrying={photosQ.isFetching} />
                  ) : photos.length === 0 ? (
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

            {seesMore && item.vehiclePlate && (
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
                    {vehicleAgentsQ.isError ? (
                      <QueryErrorNote error={vehicleAgentsQ.error} what="quem mexeu no carro" onRetry={() => vehicleAgentsQ.refetch()} retrying={vehicleAgentsQ.isFetching} />
                    ) : vehicleAgentsQ.isLoading ? (
                      <p className="text-sm text-muted-foreground animate-pulse">A ler da Multipark…</p>
                    ) : vehicleAgents.length === 0 ? (
                      <p className="text-sm text-muted-foreground">Sem ações de agentes da Multipark nesta matrícula.</p>
                    ) : (
                      <div className="space-y-2">
                        {vehicleAgents.map((a: any, i: number) => (
                          <div
                            key={i}
                            className={`flex flex-wrap items-center justify-between gap-2 text-sm p-3 rounded border ${
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

            {seesMore && <TabsContent value="comms" className="space-y-4">
              <CommunicationsTimeline type="lost_found" id={id} compact />
            </TabsContent>}

            {seesMore && item.bookingRef && (
              <TabsContent value="booking-history" className="space-y-4">
                <Card>
                  <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                    <CardTitle className="text-base flex flex-wrap items-center gap-2 min-w-0">
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
                    ) : timelineQ.isError ? (
                      <QueryErrorNote error={timelineQ.error} what="o histórico da reserva" onRetry={() => timelineQ.refetch()} retrying={timelineQ.isFetching} />
                    ) : (apiTimeline as any)?.error ? (
                      <QueryErrorNote error={{ message: (apiTimeline as any).error }} what="o histórico da reserva" onRetry={() => timelineQ.refetch()} retrying={timelineQ.isFetching} />
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

          {canEdit && !archived && item.status !== "converted" && <Card>
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
          </Card>}
        </div>
      </div>
      {returning && <MarkReturnedDialog item={item} onClose={() => setReturning(false)} />}
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
  const q = trpc.lostFound.caseRepeatDrivers.useQuery({ itemId }, { retry: false });
  const data = q.data ?? [];
  if (q.isError) return <QueryErrorNote error={q.error} what="os condutores que se repetem" onRetry={() => q.refetch()} retrying={q.isFetching} />;
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
