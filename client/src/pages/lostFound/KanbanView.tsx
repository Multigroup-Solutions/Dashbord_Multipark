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
import { lostAgeTone } from "@shared/caseRules";
import { MarkReturnedDialog } from "./ReturnPanel";
import BookingSearchField from "@/components/BookingSearchField";
import ClientHistoryCard from "@/components/ClientHistoryCard";
import CaseAssignmentCard from "@/components/CaseAssignmentCard";
import LinkInboundEmailButton from "@/components/LinkInboundEmailButton";
import {
  Search, Plus, Clock, User, Car,
  ChevronRight, ChevronLeft, Send, Eye, Trash2, Upload, Pencil,
  BarChart3, AlertCircle, CheckCircle2, Hourglass, XCircle,
  Package, Euro, Smartphone, Shirt, FileText, Glasses,
  HelpCircle, TrendingUp, ShieldAlert, Flag, Mail, Download, Truck, GripVertical, MessageSquareWarning, RefreshCw, ExternalLink } from "lucide-react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { STATUS_CONFIG, TYPE_CONFIG, PRIORITY_CONFIG, KANBAN_COLUMNS, BASE_PATH, CHANGE_TYPE_CONFIG } from "./config";
import CaseDashboardCard from "@/components/CaseDashboardCard";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { toCsv } from "@shared/csv";
import { lisbonDayOf } from "@shared/lisbonDay";
import { Archive } from "lucide-react";

// ─── KANBAN VIEW ──────────────────────────────────────────────────────────────

export function KanbanView({ user, filterType, setFilterType, searchTerm, setSearchTerm, onSelect, onNew, onShowRanking, onShowHistory }: any) {
  const globalFilters = useGlobalFilters();
  // "Sem cidade": casos sem projeto (só quem vê todas as cidades os tem).
  const [noProject, setNoProject] = useState(false);
  const canCrossRef = seesBeyondOwn(user, "perdidos") && can(user, "perdidos", "edit");
  const canEdit = can(user, "perdidos", "edit");
  const canManage = can(user, "perdidos", "manage");
  const [showArchived, setShowArchived] = useState(false);
  const queryInput = useMemo(() => {
    const input: any = {};
    if (filterType !== "all") input.itemType = filterType;
    if (searchTerm.trim()) input.search = searchTerm.trim();
    if (noProject) input.noProject = true;
    else if (globalFilters.projectId !== undefined) input.projectId = globalFilters.projectId;
    if (showArchived) input.archived = true;
    return input;
  }, [filterType, searchTerm, globalFilters.projectId, noProject, showArchived]);

  const listQ = trpc.lostFound.list.useQuery(queryInput);
  const { data: items = [], isLoading } = listQ;
  // O painel (envelhecimento, por tipo, condutores repetidos) é da cidade: quem só
  // vê os próprios casos não o pede (o servidor recusa) — 16c.
  const dashboardQ = trpc.lostFound.dashboard.useQuery(
    noProject ? { noProject: true } : globalFilters.projectId !== undefined ? { projectId: globalFilters.projectId } : undefined,
    { enabled: seesBeyondOwn(user, "perdidos") },
  );
  const dashboard = dashboardQ.data;
  const updateMut = trpc.lostFound.update.useMutation();
  const utils = trpc.useUtils();
  // D24: prazo das Definições (cor do "Parado há N dias"); sem resposta → 7.
  const slaQ = trpc.lostFound.slaDays.useQuery(undefined, { staleTime: 10 * 60_000 });
  const slaDays = slaQ.data?.days ?? 7;
  // D22: "Devolvido" abre a janela do método e da data em vez de mover logo.
  const [returning, setReturning] = useState<any | null>(null);

  const grouped = useMemo(() => {
    const map: Record<string, any[]> = {};
    KANBAN_COLUMNS.forEach(s => map[s] = []);
    items.forEach((c: any) => {
      // Convertidos (fechados e ligados ao registo novo) ficam na coluna Fechado.
      const col = c.status === "converted" ? "closed" : c.status;
      if (map[col]) map[col].push(c);
    });
    return map;
  }, [items]);

  const stats = useMemo(() => {
    const s = { total: items.length, new: 0, investigating: 0, found: 0, returned: 0, closed: 0, highPriority: 0 };
    items.forEach((i: any) => {
      // Convertidos contam em Fechados, como na coluna (16c).
      const st = i.status === "converted" ? "closed" : i.status;
      if (s[st as keyof typeof s] !== undefined) (s as any)[st]++;
      if (i.priority === "high") s.highPriority++;
    });
    return s;
  }, [items]);

  // Optimistic: o cartão muda de coluna imediatamente; rollback se o servidor
  // recusar (mesmo padrão do kanban das Tarefas).
  const moveCard = async (id: number, newStatus: string) => {
    if (newStatus === "returned") {
      const card = (items as any[]).find((x) => x.id === id);
      if (card && card.status !== "returned") { setReturning(card); return; }
    }
    await utils.lostFound.list.cancel(queryInput);
    const prev = utils.lostFound.list.getData(queryInput);
    utils.lostFound.list.setData(queryInput, (old: any) =>
      old?.map((i: any) => (i.id === id ? { ...i, status: newStatus } : i)),
    );
    try {
      await updateMut.mutateAsync({ id, status: newStatus as (typeof KANBAN_COLUMNS)[number] });
      toast.success("Estado atualizado");
    } catch (e: any) {
      utils.lostFound.list.setData(queryInput, prev);
      toast.error(e?.message || "Erro ao mover");
    } finally {
      utils.lostFound.list.invalidate();
    }
  };

  // Drag & drop nativo: arrastar um cartão para QUALQUER coluna (as setas nos
  // cartões ficam como alternativa para touch, onde o drag nativo não existe).
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      {returning && <MarkReturnedDialog item={returning} onClose={() => setReturning(null)} />}
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-muted-foreground">Gestão de objetos perdidos e achados nos veículos</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* CSV leva contactos do cliente: só quem pode exportar (matriz) — 16c. */}
          {can(user, "perdidos", "export") && (
            <Button
              variant="outline"
              disabled={items.length === 0}
              onClick={() => {
                const headers = ["ID","Criado","Tipo","Estado","Prioridade","Cliente","Email","Telefone","Matrícula","Ref.Reserva","Valor est.","Descrição","Resolução"];
                const rows = (items as any[]).map(i => [
                  i.id, i.createdAt ? fmtPTDateTime(i.createdAt) : "",
                  TYPE_CONFIG[i.itemType]?.label ?? i.itemType ?? "", STATUS_CONFIG[i.status]?.label ?? i.status ?? "", PRIORITY_CONFIG[i.priority]?.label ?? i.priority ?? "",
                  i.clientName ?? "", i.clientEmail ?? "", i.clientPhone ?? "", i.vehiclePlate ?? "", i.bookingRef ?? "", i.estimatedValue ?? "",
                  (i.description ?? "").replace(/[\n\r]+/g, " "), (i.resolution ?? "").replace(/[\n\r]+/g, " "),
                ]);
                const blob = new Blob(["\ufeff" + toCsv(headers, rows)], { type: "text/csv;charset=utf-8;" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url; a.download = `perdidos_achados_${lisbonDayOf(Date.now())}.csv`; a.click();
                URL.revokeObjectURL(url);
              }}
            >
              <Download className="w-4 h-4 mr-2" /> CSV
            </Button>
          )}
          {canManage && (
            <Button variant={showArchived ? "selected" : "outline"} onClick={() => setShowArchived((v) => !v)}>
              <Archive className="w-4 h-4 mr-2" /> {showArchived ? "A ver arquivados" : "Arquivados"}
            </Button>
          )}
          <Button variant="outline" onClick={onShowHistory}>
            <Clock className="w-4 h-4 mr-2" /> Histórico Reservas
          </Button>
          {canCrossRef && (
            <Button variant="outline" onClick={onShowRanking}>
              <ShieldAlert className="w-4 h-4 mr-2" /> Cruzamento de condutores
            </Button>
          )}
          {canEdit && <Button onClick={onNew}><Plus className="w-4 h-4 mr-2" /> Novo Registo</Button>}
        </div>
      </div>

      {listQ.isError && <QueryErrorNote error={listQ.error} what="os casos" onRetry={() => listQ.refetch()} retrying={listQ.isFetching} />}
      {showArchived && !listQ.isError && (
        <p className="text-xs text-muted-foreground">Casos arquivados: não entram nos contadores, lembretes nem no cruzamento. Abre um para o tirar do arquivo.</p>
      )}

      {/* Stats (contadas da lista do quadro) — escondidas quando a lista falha (nunca 0 por erro) */}
      {!listQ.isError && !isLoading && !showArchived && <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-7 gap-3">
        {[
          { label: "Total", value: stats.total, icon: BarChart3, color: "text-foreground" },
          { label: "Novos", value: stats.new, icon: AlertCircle, color: "text-blue-600" },
          { label: "Investigação", value: stats.investigating, icon: Hourglass, color: "text-yellow-700" },
          { label: "Encontrados", value: stats.found, icon: Search, color: "text-emerald-700" },
          { label: "Devolvidos", value: stats.returned, icon: CheckCircle2, color: "text-green-700" },
          { label: "Fechados", value: stats.closed, icon: XCircle, color: "text-gray-600" },
          { label: "Alta Prioridade", value: stats.highPriority, icon: AlertCircle, color: "text-red-600" },
        ].map(s => (
          <Card key={s.label} className="p-3 gap-1 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <s.icon className={`w-4 h-4 shrink-0 ${s.color}`} />
              <span className="text-xs text-muted-foreground truncate">{s.label}</span>
            </div>
            <p className={`text-xl font-bold tabular-nums truncate ${s.color}`}>{s.value}</p>
          </Card>
        ))}
      </div>}

      {dashboardQ.isError && <QueryErrorNote error={dashboardQ.error} what="o painel dos perdidos" onRetry={() => dashboardQ.refetch()} retrying={dashboardQ.isFetching} />}
      <CaseDashboardCard
        data={dashboard}
        resolveLabel="Tempo médio p/ fechar"
        onOpenCrossRef={canCrossRef ? onShowRanking : undefined}
        onShowNoCity={() => setNoProject(true)}
      />

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <label className="flex items-center gap-1 text-sm cursor-pointer">
          <input type="checkbox" checked={noProject} onChange={e => setNoProject(e.target.checked)} /> Sem cidade
        </label>
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
      ) : listQ.isError ? null : showArchived ? (
        <div className="space-y-2">
          {(items as any[]).length === 0 && <p className="text-sm text-muted-foreground text-center py-8">Sem casos arquivados.</p>}
          {(items as any[]).map((i: any) => (
            <Card key={i.id} className="cursor-pointer hover:shadow-md" onClick={() => onSelect(i.id)}>
              <CardContent className="p-3 flex flex-wrap items-center gap-2 text-sm">
                <span className="text-xs text-muted-foreground tabular-nums">#{i.id}</span>
                <span className="font-medium min-w-0 break-words">{i.description}</span>
                <Badge variant="secondary">Arquivado</Badge>
                {i.archiveReason && <span className="text-xs text-muted-foreground break-words">— {i.archiveReason}</span>}
                {i.archivedAt && <span className="text-xs text-muted-foreground ml-auto">{fmtPTDate(i.archivedAt)}</span>}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
          {KANBAN_COLUMNS.map(status => {
            const cfg = STATUS_CONFIG[status];
            const colItems = grouped[status] || [];
            return (
              <div
                key={status}
                className={`space-y-3 rounded-lg transition-colors ${dragOverCol === status ? "ring-2 ring-primary/60 bg-primary/5" : ""}`}
                onDragOver={(e) => { if (!canEdit) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dragOverCol !== status) setDragOverCol(status); }}
                onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverCol(null); }}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOverCol(null);
                  const id = Number(e.dataTransfer.getData("text/plain"));
                  const card = (items as any[]).find((x) => x.id === id);
                  if (id && canEdit && card?.status !== "converted") moveCard(id, status);
                }}
              >
                <div className={`flex items-center gap-2 p-2 rounded-lg ${cfg.color} border`}>
                  <cfg.icon className="w-4 h-4 shrink-0" />
                  <span className="font-medium text-sm truncate">{cfg.label}</span>
                  <Badge variant="secondary" className="ml-auto text-xs shrink-0 tabular-nums">{colItems.length}</Badge>
                </div>
                {/* div nativo: o ScrollArea (Radix) com max-h corta em vez de scrollar */}
                <div className="max-h-[60vh] overflow-y-auto">
                  <div className="space-y-2 pr-2">
                    {colItems.map((item: any) => (
                      <ItemCard
                        key={item.id}
                        item={item}
                        onSelect={() => onSelect(item.id)}
                        onMove={moveCard}
                        slaDays={slaDays}
                        currentStatus={status}
                        // Convertidos não se movem (o servidor recusa); sem edição, só se vê.
                        canMove={canEdit && item.status !== "converted"}
                      />
                    ))}
                    {colItems.length === 0 && (
                      <p className="text-xs text-muted-foreground text-center py-8">Sem registos</p>
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

export function ItemCard({ item, onSelect, onMove, currentStatus, canMove, slaDays = 7 }: any) {
  const colIdx = KANBAN_COLUMNS.indexOf(currentStatus);
  const canMoveLeft = canMove && colIdx > 0;
  const canMoveRight = canMove && colIdx < KANBAN_COLUMNS.length - 1;
  const TypeIcon = TYPE_CONFIG[item.itemType]?.icon || Package;

  // D24: atraso pelo prazo (Atribuição, senão Definições → sla.lostFoundDays).
  const age = lostAgeTone(item, Date.now(), slaDays);
  const ageDays = age?.days ?? 0;
  const stale = age?.tone === "late";

  return (
    <Card
      draggable={!!canMove}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", String(item.id));
        e.dataTransfer.effectAllowed = "move";
        if (e.currentTarget instanceof HTMLElement) e.currentTarget.style.opacity = "0.5";
      }}
      onDragEnd={(e) => {
        if (e.currentTarget instanceof HTMLElement) e.currentTarget.style.opacity = "1";
      }}
      onClick={onSelect}
      className={`${canMove ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"} hover:shadow-md transition-shadow ${stale ? "border-red-400 border-2" : ""}`}
    >
      <CardContent className="p-3 space-y-2">
        <div className="flex items-start gap-2">
          <div className="flex items-start gap-1.5 min-w-0" onClick={onSelect}>
            <GripVertical className="h-3.5 w-3.5 mt-0.5 text-muted-foreground/40 shrink-0" />
            <TypeIcon className="w-4 h-4 shrink-0 text-amber-700" />
            <span className="font-medium text-sm leading-snug line-clamp-2 break-words" title={item.description ?? undefined}>{item.description}</span>
          </div>
        </div>
        {age && age.tone !== "ok" && (
          <div className={`flex items-center gap-1 text-xs font-medium ${stale ? "text-red-600" : "text-amber-700"}`}>
            <Clock className="w-3 h-3 shrink-0" /> Parado há {ageDays} dias
          </div>
        )}

        {item.vehiclePlate && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Car className="w-3 h-3 shrink-0" /> {item.vehiclePlate}
          </div>
        )}
        {item.status === "converted" && (
          <Badge variant="outline" className="text-[11px] text-violet-700 border-violet-300">
            → {item.convertedToType === "complaint" ? "Reclamação" : item.convertedToType} #{item.convertedToId}
          </Badge>
        )}
        {item.projectId == null && <Badge variant="outline" className="text-[11px] text-red-600 border-red-300">Sem cidade</Badge>}
        {item.relatedComplaintId && <Badge variant="outline" className="text-[11px]">Reclamação #{item.relatedComplaintId}</Badge>}

        <div className="flex items-center gap-1 text-xs text-muted-foreground min-w-0">
          <User className="w-3 h-3 shrink-0" /> <span className="truncate" title={item.clientName ?? undefined}>{item.clientName}</span>
        </div>

        {item.estimatedValue && (
          <div className="flex items-center gap-1 text-xs text-amber-800 font-medium tabular-nums min-w-0">
            <Euro className="w-3 h-3 shrink-0" /> <span className="truncate">~{Number(item.estimatedValue).toLocaleString("pt-PT")} €</span>
          </div>
        )}

        <div className="text-[11px] text-muted-foreground">
          {fmtPTDate(item.createdAt)}
        </div>

        <div className="flex items-center justify-between pt-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-[11px] text-muted-foreground tabular-nums">#{item.id}</span>
            <Badge className={`text-[11px] ${PRIORITY_CONFIG[item.priority]?.color}`}>
              {PRIORITY_CONFIG[item.priority]?.label}
            </Badge>
          </div>
          <div className="flex gap-1">
            {canMoveLeft && (
              <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Mover para a coluna anterior" onClick={(e) => { e.stopPropagation(); onMove(item.id, KANBAN_COLUMNS[colIdx - 1]); }}>
                <ChevronLeft className="w-3 h-3" />
              </Button>
            )}
            <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Ver detalhe" onClick={onSelect}>
              <Eye className="w-3 h-3" />
            </Button>
            {canMoveRight && (
              <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Mover para a coluna seguinte" onClick={(e) => { e.stopPropagation(); onMove(item.id, KANBAN_COLUMNS[colIdx + 1]); }}>
                <ChevronRight className="w-3 h-3" />
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
