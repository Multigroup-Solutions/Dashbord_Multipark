import { trpc } from "@/lib/trpc";
import { seesBeyondOwn } from "@shared/access";
import { openInMultipark } from "@/lib/multiparkLinks";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { toCsv } from "@shared/csv";
import { lisbonDayOf } from "@shared/lisbonDay";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useState, useMemo, useEffect } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import {
  AlertTriangle, Clock, User, Car, BarChart3, AlertCircle, CheckCircle2, ShieldAlert,
  MapPin, Download, ExternalLink, Search, Paperclip, Info, Lock, RefreshCw, Archive,
} from "lucide-react";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { AccidentConfirmPanel } from "@/components/AccidentConfirmPanel";

/**
 * Ocorrências = as da app Multipark, lidas AO VIVO da BD deles ("Occurrence",
 * server/multiparkDb/read.ts). Nada é importado nem copiado; quando são
 * resolvidas na app, aparecem resolvidas aqui. As antigas `incidents` do
 * dashboard já não aparecem nesta página (a tabela e os dados ficam).
 */

const PRIORITY: Record<string, { label: string; color: string }> = {
  LOW: { label: "Baixa", color: "bg-slate-100 text-slate-700" },
  MEDIUM: { label: "Média", color: "bg-blue-100 text-blue-700" },
  HIGH: { label: "Alta", color: "bg-orange-100 text-orange-700" },
};
const OPEN_BADGE = "bg-red-100 text-red-800";
const RESOLVED_BADGE = "bg-green-100 text-green-800";
const PAGE = 50;
const MAX_ROWS = 200;
/** Ainda não há endpoint da Multipark para resolver ocorrências (ver docs/multipark-db/plano-duas-bd.md, secção D). */
const RESOLVE_PENDING_HINT = "A aguardar endpoint da Multipark — por agora resolve na app Multipark.";

type MpOccurrence = {
  id: string; title: string; priority: "LOW" | "MEDIUM" | "HIGH" | null; resolved: boolean;
  createdAt: string | null; resolvedAt: string | null; createdByName: string | null; resolvedByName: string | null;
  remarks: string | null; lat: number | null; lng: number | null; attachment: string | null; attachmentUrl: string | null;
  bookingId: string | null; bookingCode: string | null; plate: string | null; parkName: string | null; parkCity: string | null;
};

const isAccident = (o: MpOccurrence) => /acidente|sinistro|colis[aã]o|colidiu|embat|bateu|choque|capot/i.test(`${o.title} ${o.remarks ?? ""}`);

/** Data/hora de Lisboa para o CSV (vazio quando não há). */
const csvDateTime = (v: string | null) => (v ? fmtPTDateTime(v) : "");

export default function IncidentsPage() {
  const { user } = useAuth();
  const globalFilters = useGlobalFilters();
  const [detailId, setDetailId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("mp") || null);
  // Ligações antigas (emails, perdidos convertidos) apontam para `?id=N` — uma
  // ocorrência antiga do dashboard. Abre só para leitura (16a).
  const [legacyId, setLegacyId] = useState<number | null>(() => {
    const n = Number(new URLSearchParams(window.location.search).get("id"));
    return Number.isInteger(n) && n > 0 ? n : null;
  });
  const [status, setStatus] = useState<"all" | "open" | "resolved">("all");
  const [priority, setPriority] = useState<"all" | "LOW" | "MEDIUM" | "HIGH">("all");
  const [park, setPark] = useState("all");
  const [type, setType] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => { const t = setTimeout(() => setSearch(searchInput.trim()), 350); return () => clearTimeout(t); }, [searchInput]);
  // Filtros novos → volta à 1.ª página.
  useEffect(() => { setLimit(PAGE); }, [globalFilters.projectId, status, priority, park, type, dateFrom, dateTo, search]);

  const canView = seesBeyondOwn(user, "ocorrencias");
  const input = useMemo(() => {
    const i: any = { limit };
    if (globalFilters.projectId !== undefined) i.projectId = globalFilters.projectId;
    if (status !== "all") i.resolved = status === "resolved";
    if (priority !== "all") i.priority = priority;
    if (park !== "all") i.parkId = park;
    if (type !== "all") i.type = type;
    if (dateFrom) i.dateFrom = dateFrom;
    if (dateTo) i.dateTo = dateTo;
    if (search) i.search = search.slice(0, 100);
    return i;
  }, [limit, globalFilters.projectId, status, priority, park, type, dateFrom, dateTo, search]);
  const q = trpc.incidents.multipark.useQuery(input, { enabled: canView, staleTime: 60_000, placeholderData: keepPreviousData });
  const data = q.data;
  const rows: MpOccurrence[] = data?.available ? (data.rows as MpOccurrence[]) : [];
  const confirmedAccidents = new Set<string>(data?.available ? data.accidentIds ?? [] : []);
  const stats = data?.available ? data.stats : null;
  /** Total com os filtros (das contagens); null se as contagens falharam. */
  const total = stats ? stats.total : null;
  const csvPartial = total != null && rows.length < total;

  // CSV: só as linhas carregadas (diz quantas de quantas), datas de Lisboa e
  // células protegidas contra fórmulas (csvCell).
  const exportCsv = () => {
    const headers = ["ID", "Data", "Tipo", "Estado", "Prioridade", "Matrícula", "Reserva", "Parque", "Cidade", "Criada por", "Notas", "Resolvida por", "Resolvida em"];
    const lines = rows.map(o => [
      o.id, csvDateTime(o.createdAt), o.title, o.resolved ? "Resolvida" : "Aberta", o.priority ? PRIORITY[o.priority]?.label : "",
      o.plate, o.bookingCode ?? o.bookingId, o.parkName, o.parkCity, o.createdByName, (o.remarks ?? "").replace(/[\n\r]+/g, " "), o.resolvedByName, csvDateTime(o.resolvedAt),
    ]);
    const blob = new Blob(["﻿" + toCsv(headers, lines)], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `ocorrencias_multipark_${lisbonDayOf(Date.now())}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  if (!canView) {
    return (
      <Card className="p-10 text-center">
        <Lock className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
        <p className="text-muted-foreground">As ocorrências vêm da app Multipark e só estão disponíveis para quem vê a cidade.</p>
      </Card>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <p className="text-muted-foreground">Ocorrências registadas na app Multipark (lidas em tempo real)</p>
          <Button variant="outline" disabled={rows.length === 0} onClick={exportCsv}
            title={csvPartial ? `Exporta as ${rows.length} ocorrências carregadas de ${total}. Carrega mais ou refina os filtros para levar o resto.` : "Exporta as ocorrências da lista"}>
            <Download className="w-4 h-4 mr-2" /> CSV{rows.length > 0 ? ` (${rows.length}${csvPartial ? ` de ${total}` : ""})` : ""}
          </Button>
        </div>

        <ParksHandledNote projectId={globalFilters.projectId} />

        {q.isError && (
          <QueryErrorNote error={q.error} what="as ocorrências" onRetry={() => q.refetch()} retrying={q.isFetching} />
        )}

        {data && !data.available && (
          <Card className="p-4 border-amber-300 bg-amber-50 text-amber-900">
            <div className="flex items-start gap-2 text-sm flex-wrap">
              <Info className="w-4 h-4 mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1"><span className="font-medium">Ocorrências indisponíveis de momento.</span> {data.reason}</span>
              <Button size="sm" variant="outline" className="h-7 text-xs" disabled={q.isFetching} onClick={() => q.refetch()}>
                <RefreshCw className={`w-3 h-3 mr-1 ${q.isFetching ? "animate-spin" : ""}`} /> Tentar de novo
              </Button>
            </div>
          </Card>
        )}

        {data?.available && !stats && (
          <div role="alert" className="flex items-start gap-2 flex-wrap rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">As contagens (total, abertas, por tipo e por parque) não responderam. A lista abaixo está certa.</span>
            <Button size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={q.isFetching} onClick={() => q.refetch()}>
              <RefreshCw className={`w-3 h-3 mr-1 ${q.isFetching ? "animate-spin" : ""}`} /> Tentar de novo
            </Button>
          </div>
        )}

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
              <div className="flex items-center gap-2"><ShieldAlert className="w-4 h-4 text-orange-600" /><span className="text-xs text-muted-foreground">Alta prioridade abertas</span></div>
              <p className="text-xl font-bold mt-1 text-orange-600">{stats.highOpen}</p>
            </Card>
          </div>
        )}

        {stats && stats.byType.length > 0 && (
          <Card>
            <CardHeader><CardTitle className="text-base">Por tipo</CardTitle></CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {stats.byType.map(g => (
                  <button key={g.key} type="button" onClick={() => setType(type === g.key ? "all" : g.key)}
                    className={`flex items-center justify-between p-2 rounded text-left ${type === g.key ? "bg-indigo-100" : "bg-muted hover:bg-muted/70"}`}>
                    <span className="text-sm">{g.label}</span>
                    <Badge variant="secondary">{g.count}</Badge>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Label>Estado:</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as any)}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="open">Abertas</SelectItem>
                <SelectItem value="resolved">Resolvidas</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Label>Prioridade:</Label>
            <Select value={priority} onValueChange={(v) => setPriority(v as any)}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas</SelectItem>
                {Object.entries(PRIORITY).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {stats && stats.byPark.length > 0 && (
            <div className="flex items-center gap-2">
              <Label>Parque:</Label>
              <Select value={park} onValueChange={setPark}>
                <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  {stats.byPark.map(g => (
                    <SelectItem key={g.key} value={g.key}>{g.label}{g.city ? ` (${g.city})` : ""} · {g.count}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="relative">
            <Search className="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-8 w-56" placeholder="Reserva ou matrícula…" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
          </div>
          <div className="flex items-center gap-1">
            <Label className="text-xs">De</Label>
            <Input type="date" className="w-36" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            <Label className="text-xs">a</Label>
            <Input type="date" className="w-36" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </div>
          {type !== "all" && <Button size="sm" variant="ghost" onClick={() => setType("all")}>Tipo: {type} ✕</Button>}
          {/* Sem contagens não há lista de parques: o filtro escolhido continua visível para se poder tirar. */}
          {park !== "all" && !(stats && stats.byPark.length > 0) && <Button size="sm" variant="ghost" onClick={() => setPark("all")}>Parque filtrado ✕</Button>}
        </div>

        {q.isLoading ? (
          <div className="flex justify-center py-20"><div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" /></div>
        ) : !data?.available ? null : rows.length === 0 ? (
          <Card className="p-10 text-center">
            <AlertTriangle className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
            <p className="text-muted-foreground">Sem ocorrências com estes filtros</p>
          </Card>
        ) : (
          <div className="space-y-2">
            {rows.map(o => <OccurrenceCard key={o.id} occ={o} accidentConfirmed={confirmedAccidents.has(o.id)} onOpen={() => setDetailId(o.id)} />)}
            {data.hasMore && (
              <div className="flex justify-center pt-2">
                <Button variant="outline" size="sm" disabled={q.isFetching || limit >= MAX_ROWS} onClick={() => setLimit(l => Math.min(l + PAGE, MAX_ROWS))}>
                  {limit >= MAX_ROWS ? `Máximo de ${MAX_ROWS} — refina os filtros` : q.isFetching ? "A carregar…" : "Carregar mais"}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {detailId && <OccurrenceDialog id={detailId} projectId={globalFilters.projectId} onClose={() => setDetailId(null)} />}
      {legacyId != null && <LegacyIncidentDialog id={legacyId} onClose={() => setLegacyId(null)} />}
    </>
  );
}

/** "Resolver" aqui → resolver lá: desligado até existir endpoint da Multipark. */
function ResolveButton({ size = "sm" }: { size?: "sm" | "default" }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* span: um botão desligado não dispara o tooltip */}
        <span tabIndex={0}><Button size={size} variant="outline" disabled>Resolver</Button></span>
      </TooltipTrigger>
      <TooltipContent>{RESOLVE_PENDING_HINT}</TooltipContent>
    </Tooltip>
  );
}

function OccurrenceCard({ occ, accidentConfirmed, onOpen }: { occ: MpOccurrence; accidentConfirmed?: boolean; onOpen: () => void }) {
  return (
    <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={onOpen}>
      <CardContent className="p-4">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4">
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium">{occ.title}</span>
              {accidentConfirmed ? <Badge className="bg-red-700 text-white">Acidente confirmado</Badge> : isAccident(occ) && <Badge className="bg-red-600 text-white">⚠ Acidente</Badge>}
              <Badge className={occ.resolved ? RESOLVED_BADGE : OPEN_BADGE}>{occ.resolved ? "Resolvida" : "Aberta"}</Badge>
              {occ.priority && <Badge className={PRIORITY[occ.priority]?.color}>{PRIORITY[occ.priority]?.label}</Badge>}
            </div>
            {occ.remarks && <p className="text-sm text-muted-foreground line-clamp-3 break-words">{occ.remarks}</p>}
            <div className="flex items-center gap-x-4 gap-y-1 flex-wrap text-xs text-muted-foreground">
              {occ.plate && <span className="flex items-center gap-1"><Car className="w-3 h-3" /> {occ.plate}</span>}
              {(occ.bookingCode || occ.bookingId) && <span>Reserva #{occ.bookingCode ?? occ.bookingId?.slice(-8)}</span>}
              {occ.parkName && <span>{occ.parkName}{occ.parkCity ? ` (${occ.parkCity})` : ""}</span>}
              {occ.createdByName && <span className="flex items-center gap-1"><User className="w-3 h-3" /> {occ.createdByName}</span>}
              {occ.createdAt && <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {fmtPTDateTime(occ.createdAt)}</span>}
              {occ.lat != null && occ.lng != null && (
                <a href={`https://www.google.com/maps?q=${occ.lat},${occ.lng}`} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()} className="flex items-center gap-1 text-blue-700 hover:underline">
                  <MapPin className="w-3 h-3" /> Ver no mapa
                </a>
              )}
              {occ.attachment && <span className="flex items-center gap-1"><Paperclip className="w-3 h-3" /> anexo</span>}
            </div>
            {occ.resolved && occ.resolvedByName && <p className="text-xs text-green-700 mt-1">Resolvida por {occ.resolvedByName}{occ.resolvedAt ? ` · ${fmtPTDateTime(occ.resolvedAt)}` : ""}</p>}
          </div>
          <div className="flex gap-1 flex-wrap sm:justify-end shrink-0" onClick={(e) => e.stopPropagation()}>
            {occ.bookingId && (
              <Button size="sm" variant="ghost" className="text-xs" onClick={() => openInMultipark(occ.bookingId)}>
                <ExternalLink className="w-3 h-3 mr-1" /> Ver na Multipark
              </Button>
            )}
            {!occ.resolved && <ResolveButton />}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function OccurrenceDialog({ id, projectId, onClose }: { id: string; projectId?: number; onClose: () => void }) {
  const { data, isLoading, error, refetch, isFetching } = trpc.incidents.multiparkById.useQuery(projectId !== undefined ? { id, projectId } : { id }, { retry: false });
  const occ: MpOccurrence | null = data?.available ? (data.occurrence as MpOccurrence | null) : null;
  return (
    <Dialog open onOpenChange={onClose}>
      {/* flex (não grid): com scroll, a grelha encolhia o título com etiquetas e sobrepunha as Notas */}
      <DialogContent className="sm:max-w-2xl flex flex-col [&>*]:shrink-0">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            {occ ? occ.title : "Ocorrência"}
            {occ && <Badge className={occ.resolved ? RESOLVED_BADGE : OPEN_BADGE}>{occ.resolved ? "Resolvida" : "Aberta"}</Badge>}
            {occ?.priority && <Badge className={PRIORITY[occ.priority]?.color}>{PRIORITY[occ.priority]?.label}</Badge>}
          </DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">A ler da BD da Multipark…</p>
        ) : error ? (
          <QueryErrorNote error={error} what="esta ocorrência" onRetry={() => refetch()} retrying={isFetching} />
        ) : data && !data.available ? (
          <div className="flex items-start gap-2 flex-wrap text-sm text-amber-800">
            <span className="min-w-0 flex-1">{data.reason}</span>
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={isFetching} onClick={() => refetch()}>
              <RefreshCw className={`w-3 h-3 mr-1 ${isFetching ? "animate-spin" : ""}`} /> Tentar de novo
            </Button>
          </div>
        ) : !occ ? (
          <p className="text-sm text-muted-foreground">Ocorrência não encontrada (ou fora da tua cidade).</p>
        ) : (
          <div className="space-y-4">
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Notas</p>
              <div className="max-h-[30vh] overflow-y-auto rounded bg-muted p-3 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{occ.remarks || "(sem notas)"}</div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-muted-foreground">
              <div>Criada: <span className="font-medium text-foreground">{occ.createdAt ? fmtPTDateTime(occ.createdAt) : "—"}</span></div>
              <div>Por: <span className="font-medium text-foreground">{occ.createdByName ?? "—"}</span></div>
              <div>Parque: <span className="font-medium text-foreground">{occ.parkName ?? "—"}{occ.parkCity ? ` (${occ.parkCity})` : ""}</span></div>
              <div>Matrícula: <span className="font-medium text-foreground">{occ.plate ?? "—"}</span></div>
              <div>Reserva: <span className="font-medium text-foreground">{occ.bookingCode ? `#${occ.bookingCode}` : occ.bookingId ?? "—"}</span></div>
              {occ.resolved && <div>Resolvida: <span className="font-medium text-foreground">{occ.resolvedAt ? fmtPTDateTime(occ.resolvedAt) : "—"}{occ.resolvedByName ? ` · ${occ.resolvedByName}` : ""}</span></div>}
              {occ.lat != null && occ.lng != null && (
                <a href={`https://www.google.com/maps?q=${occ.lat},${occ.lng}`} target="_blank" rel="noopener" className="text-blue-700 hover:underline"><MapPin className="w-3 h-3 inline mr-1" />Ver no mapa ({occ.lat.toFixed(5)}, {occ.lng.toFixed(5)})</a>
              )}
              {occ.attachmentUrl ? (
                <a href={occ.attachmentUrl} target="_blank" rel="noopener noreferrer" className="text-blue-700 hover:underline"><Paperclip className="w-3 h-3 inline mr-1" />Abrir anexo</a>
              ) : occ.attachment ? (
                <span><Paperclip className="w-3 h-3 inline mr-1" />Tem anexo — abrir na app Multipark</span>
              ) : null}
            </div>
            {!occ.resolved && (
              <div className="rounded border border-indigo-200 bg-indigo-50 p-3 text-xs text-indigo-900 flex items-start gap-2">
                <Lock className="w-4 h-4 shrink-0" />
                <span>Resolver aqui ainda não é possível: {RESOLVE_PENDING_HINT} Quando for resolvida lá, aparece resolvida aqui.</span>
              </div>
            )}
            {/* 22c (D15): acidente = −6000 na avaliação, depois de o TL confirmar quem conduzia */}
            <AccidentConfirmPanel occurrenceId={occ.id} />
          </div>
        )}
        <DialogFooter className="flex-wrap gap-2">
          {occ?.bookingId && (
            <Button size="sm" variant="outline" onClick={() => openInMultipark(occ.bookingId)}><ExternalLink className="w-4 h-4 mr-1" /> Ver reserva na Multipark</Button>
          )}
          {occ && !occ.resolved && <ResolveButton />}
          <Button size="sm" onClick={onClose}>Fechar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 23a (D16): os parques que as Ocorrências tratam e os que ficam de fora
 * ("Parques que a operação não faz", Definições). As Reclamações e as Críticas
 * vêm de todos os parques.
 */
function ParksHandledNote({ projectId }: { projectId?: number }) {
  const [open, setOpen] = useState(false);
  const q = trpc.incidents.parksHandled.useQuery(projectId !== undefined ? { projectId } : undefined, { staleTime: 10 * 60_000, retry: false });
  const d = q.data;
  if (q.isLoading || q.error || !d) return null;
  if (!d.available) return <p className="text-xs text-muted-foreground">Lista dos parques indisponível: {d.reason}</p>;
  const byCity = (list: typeof d.handled) => {
    const m = new Map<string, string[]>();
    for (const p of list) { const c = p.city ?? "Sem cidade"; m.set(c, [...(m.get(c) ?? []), p.name]); }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], "pt"));
  };
  return (
    <div className="text-xs text-muted-foreground">
      <button type="button" className="underline-offset-2 hover:underline text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {d.handled.length} parque{d.handled.length === 1 ? "" : "s"} tratado{d.handled.length === 1 ? "" : "s"}
        {d.excluded.length > 0 ? ` · ${d.excluded.length} fora (a operação não os faz)` : ""} — {open ? "esconder" : "ver lista"}
      </button>
      {open && (
        <div className="mt-2 grid gap-3 sm:grid-cols-2 rounded-md border p-3 text-foreground">
          <div className="min-w-0">
            <p className="font-medium mb-1">Tratados</p>
            {byCity(d.handled).map(([city, names]) => (
              <p key={city} className="break-words"><span className="text-muted-foreground">{city}:</span> {names.join(", ")}</p>
            ))}
          </div>
          <div className="min-w-0">
            <p className="font-medium mb-1">Fora (Definições → Parques que a operação não faz)</p>
            {d.excluded.length === 0 ? <p className="text-muted-foreground">Nenhum.</p> : byCity(d.excluded).map(([city, names]) => (
              <p key={city} className="break-words"><span className="text-muted-foreground">{city}:</span> {names.join(", ")}</p>
            ))}
            <p className="text-muted-foreground mt-2">As ocorrências destes parques não aparecem aqui nem nas contagens. As reclamações e as críticas vêm de todos.</p>
          </div>
        </div>
      )}
    </div>
  );
}

const LEGACY_TYPE: Record<string, string> = {
  vidro_aberto: "Vidro aberto", mal_estacionado: "Mal estacionado", dano: "Dano", chave_errada: "Chave errada",
  combustivel: "Combustível", limpeza: "Limpeza", documentos: "Documentos", outro: "Outro",
};
const LEGACY_STATUS: Record<string, string> = {
  open: "Aberta", investigating: "Em investigação", resolved: "Resolvida", dismissed: "Descartada", converted: "Convertida",
};
const LEGACY_SEVERITY: Record<string, string> = { low: "Baixa", medium: "Média", high: "Alta", critical: "Crítica" };

/**
 * Ocorrência antiga do dashboard (tabela `incidents`, antes da ligação à app
 * Multipark). Só leitura: não conta nos números desta página e não se altera
 * aqui. Os dados ficam guardados (nada é apagado).
 */
function LegacyIncidentDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const { data: inc, isLoading, error, refetch, isFetching } = trpc.incidents.getById.useQuery({ id }, { retry: false });
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            <Archive className="w-4 h-4 shrink-0" /> Ocorrência antiga #{id}
            {inc && <Badge variant="secondary">{LEGACY_STATUS[inc.status] ?? inc.status}</Badge>}
          </DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">Registada no dashboard antes da ligação à app Multipark. Só leitura: não entra nos números desta página.</p>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">A carregar…</p>
        ) : error ? (
          <QueryErrorNote error={error} what="esta ocorrência antiga" onRetry={() => refetch()} retrying={isFetching} />
        ) : inc ? (
          <div className="space-y-3">
            <div className="max-h-[30vh] overflow-y-auto rounded bg-muted p-3 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{inc.description || "(sem descrição)"}</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-muted-foreground">
              <div>Tipo: <span className="font-medium text-foreground">{LEGACY_TYPE[inc.incidentType] ?? inc.incidentType}</span></div>
              <div>Gravidade: <span className="font-medium text-foreground">{LEGACY_SEVERITY[inc.severity] ?? inc.severity}</span></div>
              <div>Criada: <span className="font-medium text-foreground">{fmtPTDateTime(inc.sourceEmailDate ?? inc.createdAt)}</span></div>
              <div>Matrícula: <span className="font-medium text-foreground">{inc.vehiclePlate ?? "—"}</span></div>
              {inc.resolvedAt && <div>Resolvida: <span className="font-medium text-foreground">{fmtPTDateTime(inc.resolvedAt)}</span></div>}
              {inc.convertedToType && <div>Convertida em: <span className="font-medium text-foreground">{inc.convertedToType === "complaint" ? "reclamação" : "perdido"} #{inc.convertedToId}</span></div>}
            </div>
            {inc.resolution && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">Notas / resolução</p>
                <div className="max-h-[20vh] overflow-y-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{inc.resolution}</div>
              </div>
            )}
          </div>
        ) : null}
        <DialogFooter>
          <Button size="sm" onClick={onClose}>Fechar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
