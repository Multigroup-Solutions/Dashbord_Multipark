import { trpc } from "@/lib/trpc";
import { fmtPTDate, fmtPTDateTime } from "@/lib/lisbonTime";
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
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { useMemo, useState } from "react";
import { groupReviewsByPark, isReviewPending, NO_PARK_KEY } from "@shared/reviewParks";
import {
  Star, Plus, MessageSquare, Bot, CheckCircle2, AlertTriangle,
  Search, ExternalLink, Sparkles, ThumbsUp, ThumbsDown, Eye,
  BarChart3, TrendingUp, Clock, XCircle, Edit, Mail, RefreshCw, Loader2,
  Car, Users, Calendar, Download,
} from "lucide-react";
import BookingSearchField from "@/components/BookingSearchField";
import ClientHistoryCard from "@/components/ClientHistoryCard";
import GoogleBusinessConnection from "@/components/GoogleBusinessConnection";

const RATING_COLORS: Record<number, string> = {
  1: "text-red-500",
  2: "text-orange-500",
  3: "text-yellow-500",
  4: "text-lime-500",
  5: "text-green-500",
};

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  pending_response: { label: "Pendente", color: "bg-yellow-100 text-yellow-800" },
  ai_responded: { label: "Rascunho IA (por enviar)", color: "bg-blue-100 text-blue-800" },
  manually_responded: { label: "Respondido", color: "bg-green-100 text-green-800" },
  converted_complaint: { label: "Reclamação", color: "bg-red-100 text-red-800" },
  dismissed: { label: "Dispensado", color: "bg-gray-100 text-gray-800" },
};

const SENTIMENT: Record<string, { label: string; cls: string }> = {
  positivo: { label: "Positivo", cls: "bg-emerald-100 text-emerald-800" },
  neutro: { label: "Neutro", cls: "bg-slate-100 text-slate-700" },
  negativo: { label: "Negativo", cls: "bg-red-100 text-red-800" },
};

function SentimentBadge({ value }: { value: string }) {
  const s = SENTIMENT[value];
  if (!s) return null;
  return <Badge className={`${s.cls} text-[11px]`} title="Sentimento (IA)">{s.label}</Badge>;
}

function Stars({ rating, size = "w-4 h-4" }: { rating: number; size?: string }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map(i => (
        <Star key={i} className={`${size} ${i <= rating ? "fill-amber-400 text-amber-400" : "text-gray-300"}`} />
      ))}
    </div>
  );
}

export default function GoogleReviewsPage() {
  const [tab, setTab] = useState("dashboard");
  const [showCreate, setShowCreate] = useState(false);
  // ?id=N abre logo a crítica (links a partir da ficha do cliente no CRM).
  const [selectedId, setSelectedId] = useState<number | null>(() => Number(new URLSearchParams(window.location.search).get("id")) || null);
  const [syncResult, setSyncResult] = useState<any>(null);
  const utils = trpc.useUtils();
  const syncGmail = trpc.reviews.syncFromGmail.useMutation({
    onSuccess: (data: any) => {
      setSyncResult(data);
      utils.reviews.list.invalidate();
      utils.reviews.stats.invalidate();
      if (data.message) {
        toast.info(data.message);
      } else {
        toast.success(`Sync concluído: ${data.reviewsImported} reviews, ${data.incidentsImported} ocorrências importadas`);
      }
    },
    onError: (err) => toast.error("Erro no sync: " + err.message),
  });

  return (
    <>
      <div className="space-y-6">
        <GoogleBusinessConnection />
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="text-muted-foreground">Gestão de avaliações e respostas automáticas</p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button variant="outline" onClick={() => syncGmail.mutate()} disabled={syncGmail.isPending}>
              {syncGmail.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Mail className="w-4 h-4 mr-2" />}
              {syncGmail.isPending ? "A sincronizar..." : "Sincronizar Gmail"}
            </Button>
            <Button onClick={() => setShowCreate(true)}><Plus className="w-4 h-4 mr-2" /> Importar Review</Button>
          </div>
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="max-w-full justify-start overflow-x-auto">
            <TabsTrigger value="dashboard"><BarChart3 className="w-4 h-4 mr-1" /> Dashboard</TabsTrigger>
            <TabsTrigger value="list"><MessageSquare className="w-4 h-4 mr-1" /> Reviews</TabsTrigger>
            <TabsTrigger value="drivers"><Car className="w-4 h-4 mr-1" /> Condutores</TabsTrigger>
            <TabsTrigger value="agents"><Users className="w-4 h-4 mr-1" /> Agentes</TabsTrigger>
          </TabsList>

          <TabsContent value="dashboard" className="mt-4"><ReviewsDashboard /></TabsContent>
          <TabsContent value="list" className="mt-4">
            <ReviewsList onSelect={setSelectedId} />
          </TabsContent>
          <TabsContent value="drivers" className="mt-4"><CheckoutDriversPanel /></TabsContent>
          <TabsContent value="agents" className="mt-4"><AgentPerformancePanel /></TabsContent>
        </Tabs>
      </div>

      {showCreate && <CreateReviewDialog onClose={() => setShowCreate(false)} />}
      {selectedId && <ReviewDetailDialog id={selectedId} onClose={() => setSelectedId(null)} />}
      {syncResult && <GmailSyncResultDialog result={syncResult} onClose={() => setSyncResult(null)} />}
    </>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

// Quadro por parque: a empresa toda em cima (KPIs), cada parque em baixo.
function ParkBreakdown({ onOpenPark }: { onOpenPark?: (key: string) => void }) {
  const { projectId } = useGlobalFilters();
  const { data: reviews = [] } = trpc.reviews.list.useQuery(projectId !== undefined ? { projectId } : undefined);
  const { data: projs = [] } = trpc.projects.list.useQuery();
  const groups = useMemo(() => groupReviewsByPark(reviews as any[], projs as any[]), [reviews, projs]);
  if (groups.length === 0) return null;
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Por parque</CardTitle></CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Parque</th>
                <th className="text-right px-4 py-2 font-medium">Avaliações</th>
                <th className="text-right px-4 py-2 font-medium">Média</th>
                <th className="text-right px-4 py-2 font-medium">Por responder</th>
                <th className="text-right px-4 py-2 font-medium">Respondidas</th>
                <th className="text-right px-4 py-2 font-medium">Reclamações</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(g => (
                <tr key={g.key} className={`border-b last:border-0 ${onOpenPark ? "cursor-pointer hover:bg-muted/50" : ""}`} onClick={() => onOpenPark?.(g.key)}>
                  <td className="px-4 py-2 font-medium">{g.name}</td>
                  <td className="px-4 py-2 text-right">{g.total}</td>
                  <td className="px-4 py-2 text-right">{g.avg != null ? g.avg : "—"}</td>
                  <td className={`px-4 py-2 text-right font-semibold ${g.pending > 0 ? "text-yellow-700" : "text-muted-foreground"}`}>{g.pending}</td>
                  <td className="px-4 py-2 text-right text-green-700">{g.responded}</td>
                  <td className="px-4 py-2 text-right text-red-700">{g.complaints}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function ReviewsDashboard() {
  const { projectId } = useGlobalFilters();
  const { data: stats } = trpc.reviews.stats.useQuery({ projectId });
  if (!stats) return <div className="flex justify-center py-12"><div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" /></div>;

  const starData = [
    { stars: 5, count: stats.star5, color: "bg-green-500" },
    { stars: 4, count: stats.star4, color: "bg-lime-500" },
    { stars: 3, count: stats.star3, color: "bg-yellow-500" },
    { stars: 2, count: stats.star2, color: "bg-orange-500" },
    { stars: 1, count: stats.star1, color: "bg-red-500" },
  ];
  const maxCount = Math.max(...starData.map(d => d.count), 1);

  return (
    <div className="space-y-6">
      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
        <Card className="p-4 gap-1 min-w-0">
          <div className="flex items-center gap-2 text-muted-foreground text-sm"><Star className="w-4 h-4" /> Média</div>
          <p className="text-3xl font-bold mt-1 tabular-nums truncate">{stats.avg}<span className="text-lg text-muted-foreground">/5</span></p>
          <Stars rating={Math.round(stats.avg)} />
        </Card>
        <Card className="p-4 gap-1 min-w-0">
          <div className="flex items-center gap-2 text-muted-foreground text-sm"><MessageSquare className="w-4 h-4" /> Total</div>
          <p className="text-3xl font-bold mt-1 tabular-nums truncate" title={String(stats.total)}>{stats.total}</p>
          <p className="text-xs text-muted-foreground">avaliações{(stats as any).unrated ? ` · ${(stats as any).unrated} sem estrelas` : ""}</p>
        </Card>
        <Card className="p-4 gap-1 min-w-0">
          <div className="flex items-center gap-2 text-muted-foreground text-sm"><CheckCircle2 className="w-4 h-4" /> Respondidas</div>
          <p className="text-3xl font-bold mt-1 tabular-nums truncate text-green-700" title={String(stats.responded)}>{stats.responded}</p>
          <p className="text-xs text-muted-foreground">resposta enviada</p>
        </Card>
        <Card className="p-4 gap-1 min-w-0">
          <div className="flex items-center gap-2 text-muted-foreground text-sm"><Clock className="w-4 h-4" /> Por responder</div>
          <p className="text-3xl font-bold mt-1 tabular-nums truncate text-yellow-700" title={String(stats.pending)}>{stats.pending}</p>
          <p className="text-xs text-muted-foreground">inclui rascunhos IA por enviar</p>
        </Card>
        <Card className="p-4 gap-1 min-w-0">
          <div className="flex items-center gap-2 text-muted-foreground text-sm"><AlertTriangle className="w-4 h-4" /> Reclamações</div>
          <p className="text-3xl font-bold mt-1 tabular-nums truncate text-red-600" title={String(stats.complaints)}>{stats.complaints}</p>
          <p className="text-xs text-muted-foreground">convertidas</p>
        </Card>
      </div>

      {/* Por parque (Jorge, 16 set 2026: empresa toda em cima, parques em baixo) */}
      <ParkBreakdown />

      {/* Star Distribution */}
      <Card>
        <CardHeader><CardTitle className="text-sm">Distribuição de Estrelas</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {starData.map(d => (
            <div key={d.stars} className="flex items-center gap-3">
              <div className="flex items-center gap-1 w-16">
                <span className="text-sm font-medium">{d.stars}</span>
                <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
              </div>
              <div className="flex-1 h-6 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full ${d.color} rounded-full transition-all duration-500`}
                  style={{ width: `${(d.count / maxCount) * 100}%` }}
                />
              </div>
              <span className="text-sm font-medium min-w-10 text-right tabular-nums">{d.count}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Quick stats */}
      <div className="grid grid-cols-2 gap-4">
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <ThumbsUp className="w-5 h-5 text-green-500" />
            <span className="font-medium">Positivas (4-5★)</span>
          </div>
          <p className="text-2xl font-bold tabular-nums">{stats.star4 + stats.star5}</p>
          <p className="text-xs text-muted-foreground">{stats.total > 0 ? Math.round(((stats.star4 + stats.star5) / stats.total) * 100) : 0}% do total</p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <ThumbsDown className="w-5 h-5 text-red-500" />
            <span className="font-medium">Negativas (1-3★)</span>
          </div>
          <p className="text-2xl font-bold tabular-nums">{stats.star1 + stats.star2 + stats.star3}</p>
          <p className="text-xs text-muted-foreground">{stats.total > 0 ? Math.round(((stats.star1 + stats.star2 + stats.star3) / stats.total) * 100) : 0}% do total</p>
        </Card>
      </div>
    </div>
  );
}

// ─── REVIEWS LIST ─────────────────────────────────────────────────────────────

function ReviewsList({ onSelect }: { onSelect: (id: number) => void }) {
  const globalFilters = useGlobalFilters();
  const [filterRating, setFilterRating] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  // Separação por PARQUE (Jorge, 16 set 2026): "Todas" mostra a empresa
  // inteira agrupada por parque; um parque mostra só o dele.
  const [park, setPark] = useState<string>("all");

  const queryInput: any = {
    ...(filterRating !== "all" ? { rating: Number(filterRating) } : {}),
    ...(filterStatus !== "all" ? { status: filterStatus } : {}),
    ...(globalFilters.projectId !== undefined ? { projectId: globalFilters.projectId } : {}),
  };
  const { data: reviews = [], isLoading } = trpc.reviews.list.useQuery(
    Object.keys(queryInput).length > 0 ? queryInput : undefined
  );
  const { data: projs = [] } = trpc.projects.list.useQuery();
  const groups = useMemo(() => groupReviewsByPark(reviews as any[], projs as any[]), [reviews, projs]);
  const parkName = useMemo(() => new Map(groups.map(g => [g.key, g.name])), [groups]);
  const visibleGroups = park === "all" ? groups : groups.filter(g => g.key === park);
  const totalPending = groups.reduce((s, g) => s + g.pending, 0);
  const visibleReviews = visibleGroups.flatMap(g => g.reviews);

  return (
    <div className="space-y-4">
      {/* Parques: a empresa toda, e depois cada parque */}
      {groups.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" variant={park === "all" ? "default" : "outline"} onClick={() => setPark("all")}>
            Todas <span className="ml-1 opacity-80">{reviews.length}</span>
            {totalPending > 0 && <Badge className="ml-2 bg-yellow-100 text-yellow-800 text-[11px]">{totalPending} por responder</Badge>}
          </Button>
          {groups.map(g => (
            <Button key={g.key} size="sm" variant={park === g.key ? "default" : "outline"} onClick={() => setPark(park === g.key ? "all" : g.key)}>
              {g.name} <span className="ml-1 opacity-80">{g.total}</span>
              {g.pending > 0 && <Badge className="ml-2 bg-yellow-100 text-yellow-800 text-[11px]">{g.pending}</Badge>}
            </Button>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Label className="text-sm">Estrelas:</Label>
          <Select value={filterRating} onValueChange={setFilterRating}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas</SelectItem>
              {[5, 4, 3, 2, 1].map(r => (
                <SelectItem key={r} value={String(r)}>{r} ★</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-sm">Estado:</Label>
          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              {Object.entries(STATUS_LABELS).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={visibleReviews.length === 0}
          onClick={() => {
            const headers = ["ID","Parque","Data","Nome","Email","Estrelas","Estado","Texto","Resposta IA","Matrícula","Reclamação"];
            const rows = (visibleReviews as any[]).map(r => [
              r.id,
              (parkName.get(r.projectId != null && projs.some((p: any) => p.id === r.projectId) ? String(r.projectId) : NO_PARK_KEY) || "").replace(/;/g, ","),
              r.reviewDate ? new Date(r.reviewDate).toISOString().slice(0, 10) : "",
              (r.reviewerName || "").replace(/[;\n\r]/g, " "),
              (r.reviewerEmail || "").replace(/;/g, ","),
              r.rating,
              STATUS_LABELS[r.status]?.label ?? r.status,
              (r.reviewText || "").replace(/[;\n\r]/g, " "),
              (r.aiResponse || "").replace(/[;\n\r]/g, " "),
              r.vehiclePlate || "",
              r.complaintId || "",
            ]);
            const csv = [headers.join(";"), ...rows.map(r => r.join(";"))].join("\n");
            const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = `reviews_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
            URL.revokeObjectURL(url);
          }}
        >
          <Download className="w-4 h-4 mr-1" /> CSV
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" /></div>
      ) : reviews.length === 0 ? (
        <Card className="p-12 text-center">
          <Star className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
          <p className="text-muted-foreground">Sem avaliações. Importa a primeira!</p>
        </Card>
      ) : (
        <div className="space-y-6">
          {visibleGroups.map(g => (
            <div key={g.key} className="space-y-3">
              {/* Cabeçalho do parque: nome, total, média, por responder */}
              <div className="flex items-center gap-3 flex-wrap border-b pb-2">
                <h3 className="font-semibold">{g.name}</h3>
                <span className="text-sm text-muted-foreground">{g.total} {g.total === 1 ? "avaliação" : "avaliações"}</span>
                {g.avg != null && (
                  <span className="flex items-center gap-1 text-sm text-muted-foreground">
                    <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" /> {g.avg}
                  </span>
                )}
                {g.pending > 0 ? (
                  <Badge className="bg-yellow-100 text-yellow-800">{g.pending} por responder</Badge>
                ) : (
                  <Badge className="bg-green-100 text-green-800">tudo respondido</Badge>
                )}
              </div>
              {g.reviews.map((r: any) => (
                <Card key={r.id} className={`hover:shadow-md transition-shadow cursor-pointer ${isReviewPending(r) ? "border-yellow-200" : ""}`} onClick={() => onSelect(r.id)}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-1 flex-wrap">
                          <span className="font-medium">{r.reviewerName}</span>
                          <Stars rating={r.rating} size="w-3.5 h-3.5" />
                          <Badge className={STATUS_LABELS[r.status]?.color || ""}>{STATUS_LABELS[r.status]?.label}</Badge>
                          {r.googleReply && <Badge className="bg-green-100 text-green-700 text-[11px]">no Google</Badge>}
                          {!r.googleReply && r.aiResponse && !r.aiResponseApproved && <Badge className="bg-amber-100 text-amber-800 text-[11px]">rascunho por aprovar</Badge>}
                          {(r as any).aiSentiment && <SentimentBadge value={(r as any).aiSentiment} />}
                          {r.complaintId && (
                            <Badge variant="outline" className="text-red-600 border-red-200">
                              <AlertTriangle className="w-3 h-3 mr-1" /> Reclamação #{r.complaintId}
                            </Badge>
                          )}
                        </div>
                        {r.reviewText && <p className="text-sm text-muted-foreground line-clamp-2 mt-1">"{r.reviewText}"</p>}
                        <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                          {r.reviewDate && <span>{fmtPTDate(r.reviewDate)}</span>}
                          {r.vehiclePlate && <span>🚗 {r.vehiclePlate}</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {r.aiResponse && <Bot className="w-4 h-4 text-blue-500" />}
                        <Button variant="ghost" size="icon" className="h-8 w-8"><Eye className="w-4 h-4" /></Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── CREATE REVIEW DIALOG ─────────────────────────────────────────────────────

function CreateReviewDialog({ onClose }: { onClose: () => void }) {
  const { data: projs = [] } = trpc.projects.list.useQuery();
  const createMut = trpc.reviews.create.useMutation();
  const utils = trpc.useUtils();

  const [form, setForm] = useState({
    reviewerName: "", reviewerEmail: "", rating: 5,
    reviewText: "", reviewDate: "", projectId: "", vehiclePlate: "",
    bookingRef: "",
  });

  const handleSubmit = async () => {
    if (!form.reviewerName) { toast.error("Nome do reviewer obrigatório"); return; }
    try {
      await createMut.mutateAsync({
        reviewerName: form.reviewerName,
        reviewerEmail: form.reviewerEmail || undefined,
        rating: form.rating,
        reviewText: form.reviewText || undefined,
        reviewDate: form.reviewDate || undefined,
        projectId: form.projectId ? Number(form.projectId) : undefined,
        vehiclePlate: form.vehiclePlate || undefined,
      });
      utils.reviews.list.invalidate();
      utils.reviews.stats.invalidate();
      if (form.rating >= 4) {
        toast.success("Review importada! Resposta IA gerada automaticamente.");
      } else {
        toast.success("Review importada! Reclamação criada automaticamente.");
      }
      onClose();
    } catch { toast.error("Erro ao importar review"); }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Importar Avaliação Google</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <BookingSearchField
            accent="violet"
            hint="Opcional — escolhe a reserva e o nome/email/matrícula são preenchidos automaticamente"
            onSelect={(b, details) => {
              const client = details?.customer || details?.client;
              const fullName = [client?.firstName, client?.lastName, b.clientFirstName, b.clientLastName].filter(Boolean).slice(0, 2).join(" ");
              setForm(f => ({
                ...f,
                bookingRef: b.externalId || b.bookingNumber || f.bookingRef,
                reviewerName: f.reviewerName || fullName,
                reviewerEmail: f.reviewerEmail || client?.email || b.clientEmail || "",
                vehiclePlate: f.vehiclePlate || details?.vehicle?.licensePlate || b.licensePlate || "",
                projectId: f.projectId || (b.projectId ? String(b.projectId) : ""),
              }));
            }}
          />
          {form.bookingRef && (
            <div className="p-2 rounded border bg-muted text-xs flex items-center justify-between">
              <span className="font-mono">Reserva: {form.bookingRef}</span>
              <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setForm(f => ({ ...f, bookingRef: "" }))}>limpar</button>
            </div>
          )}
          <div>
            <Label>Nome do Reviewer *</Label>
            <Input value={form.reviewerName} onChange={e => setForm(f => ({ ...f, reviewerName: e.target.value }))} />
          </div>
          <div>
            <Label>Email (opcional)</Label>
            <Input type="email" value={form.reviewerEmail} onChange={e => setForm(f => ({ ...f, reviewerEmail: e.target.value }))} />
          </div>
          <div>
            <Label>Classificação *</Label>
            <div className="flex gap-2 mt-1">
              {[1, 2, 3, 4, 5].map(r => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setForm(f => ({ ...f, rating: r }))}
                  className="p-1 transition-transform hover:scale-110"
                >
                  <Star className={`w-8 h-8 ${r <= form.rating ? "fill-amber-400 text-amber-400" : "text-gray-300"}`} />
                </button>
              ))}
            </div>
            {form.rating >= 4 && (
              <p className="text-xs text-green-600 mt-1 flex items-center gap-1">
                <Bot className="w-3 h-3" /> Resposta automática IA será gerada
              </p>
            )}
            {form.rating <= 3 && (
              <p className="text-xs text-red-600 mt-1 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> Será convertida em reclamação automaticamente
              </p>
            )}
          </div>
          <div>
            <Label>Texto da Avaliação</Label>
            <Textarea value={form.reviewText} onChange={e => setForm(f => ({ ...f, reviewText: e.target.value }))} rows={3} placeholder="O que o cliente escreveu..." />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Data</Label>
              <Input type="date" value={form.reviewDate} onChange={e => setForm(f => ({ ...f, reviewDate: e.target.value }))} />
            </div>
            <div>
              <Label>Matrícula</Label>
              <Input value={form.vehiclePlate} onChange={e => setForm(f => ({ ...f, vehiclePlate: e.target.value }))} placeholder="XX-XX-XX" />
            </div>
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
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={handleSubmit} disabled={createMut.isPending}>
            {createMut.isPending ? "A processar..." : "Importar Review"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── REVIEW DETAIL DIALOG ─────────────────────────────────────────────────────

function ReviewDetailDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const { data: review, isLoading } = trpc.reviews.getById.useQuery({ id });
  const { data: clientHistory } = trpc.reviews.searchClient.useQuery(
    { name: review?.reviewerName, email: review?.reviewerEmail || undefined, plate: review?.vehiclePlate || undefined },
    { enabled: !!review }
  );
  const generateMut = trpc.reviews.generateResponse.useMutation();
  const approveMut = trpc.reviews.approveResponse.useMutation();
  const updateMut = trpc.reviews.update.useMutation();
  const publishMut = trpc.reviews.publishReply.useMutation({
    onSuccess: () => {
      utils.reviews.getById.invalidate({ id });
      utils.reviews.list.invalidate();
      toast.success("Resposta publicada no Google!");
    },
    onError: (e) => toast.error(e.message || "Não foi possível publicar no Google"),
  });
  const convertMut = trpc.reviews.convertToComplaint.useMutation({
    onSuccess: (r) => {
      toast.success(r.alreadyConverted ? `Já estava convertida (reclamação #${r.complaintId})` : `Reclamação #${r.complaintId} criada`);
      utils.reviews.getById.invalidate({ id });
      utils.reviews.list.invalidate();
      utils.complaints.list.invalidate();
    },
    onError: (e) => toast.error(e.message || "Erro ao converter"),
  });
  const utils = trpc.useUtils();

  const [editingResponse, setEditingResponse] = useState(false);
  const [responseText, setResponseText] = useState("");

  if (isLoading || !review) return null;

  const handleGenerate = async () => {
    const result = await generateMut.mutateAsync({ id });
    setResponseText(result.response);
    utils.reviews.getById.invalidate({ id });
    utils.reviews.list.invalidate();
    toast.success("Resposta IA gerada!");
  };

  const handleApprove = async () => {
    await approveMut.mutateAsync({ id });
    utils.reviews.getById.invalidate({ id });
    utils.reviews.list.invalidate();
    toast.success("Resposta aprovada!");
  };

  // Publicar é público e irreversível no Google: pede confirmação. A resposta
  // publicada fica aprovada (aiResponseApproved = 1) pelo publishReply.
  const handleApproveAndPublish = (text: string) => {
    const t = text.trim();
    if (!t) { toast.error("Escreve a resposta antes de publicar."); return; }
    if (!confirm("Publicar esta resposta no Google? Fica visível para todos.")) return;
    publishMut.mutate({ id, comment: t }, { onSuccess: () => setEditingResponse(false) });
  };

  const handleSaveResponse = async () => {
    await updateMut.mutateAsync({ id, aiResponse: responseText, status: "manually_responded" });
    setEditingResponse(false);
    utils.reviews.getById.invalidate({ id });
    utils.reviews.list.invalidate();
    toast.success("Resposta guardada!");
  };

  const handleDismiss = async () => {
    await updateMut.mutateAsync({ id, status: "dismissed" });
    utils.reviews.getById.invalidate({ id });
    utils.reviews.list.invalidate();
    toast.success("Review dispensada");
    onClose();
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <Stars rating={review.rating} size="w-5 h-5" />
            <span>{review.reviewerName}</span>
            <Badge className={STATUS_LABELS[review.status]?.color}>{STATUS_LABELS[review.status]?.label}</Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Review text */}
          {review.reviewText && (
            <Card>
              <CardContent className="p-4">
                <p className="text-sm italic">"{review.reviewText}"</p>
                <div className="flex gap-4 mt-2 text-xs text-muted-foreground">
                  {review.reviewDate && <span>📅 {fmtPTDate(review.reviewDate)}</span>}
                  {review.vehiclePlate && <span>🚗 {review.vehiclePlate}</span>}
                  {review.reviewerEmail && <span>📧 {review.reviewerEmail}</span>}
                </div>
              </CardContent>
            </Card>
          )}

          <ClientHistoryCard
            email={review.reviewerEmail}
            plate={review.vehiclePlate}
            name={review.reviewerName}
          />

          {/* Resposta pública já no Google (vinda da API) */}
          {review.googleReply && (
            <Card className="border-green-200">
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-green-600" /> Publicada no Google
                  {review.respondedAt && <span className="text-xs font-normal text-muted-foreground">{fmtPTDateTime(review.respondedAt)}</span>}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm bg-green-50 p-3 rounded-lg border border-green-100">{review.googleReply}</p>
              </CardContent>
            </Card>
          )}

          {/* AI Response */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Bot className="w-4 h-4 text-blue-500" /> Resposta
                {review.aiResponseApproved ? <Badge className="bg-green-100 text-green-700 text-[11px]">Aprovada</Badge>
                  : review.aiResponse && !review.googleReply ? <Badge className="bg-amber-100 text-amber-800 text-[11px]">Rascunho IA — por aprovar</Badge> : null}
                {(review as any).aiSentiment && <SentimentBadge value={(review as any).aiSentiment} />}
                {!review.googleReviewName && (
                  <span className="text-xs font-normal text-muted-foreground ml-auto flex items-center gap-1" title="Esta crítica veio por email e não está ligada ao Google. Para publicar a resposta, usa o perfil Google, ou espera que a importação pela API a associe.">
                    <Mail className="w-3 h-3" /> só local (veio por email)
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {editingResponse ? (
                <>
                  <Textarea value={responseText} onChange={e => setResponseText(e.target.value)} rows={5} />
                  <div className="flex gap-2 flex-wrap">
                    {review.googleReviewName && (
                      <Button size="sm" onClick={() => handleApproveAndPublish(responseText)} disabled={publishMut.isPending || !responseText.trim()}>
                        <ExternalLink className="w-4 h-4 mr-1" /> {publishMut.isPending ? "A publicar..." : "Aprovar e publicar"}
                      </Button>
                    )}
                    <Button size="sm" variant={review.googleReviewName ? "outline" : "default"} onClick={handleSaveResponse} disabled={updateMut.isPending}>Guardar</Button>
                    <Button size="sm" variant="outline" onClick={() => setEditingResponse(false)}>Cancelar</Button>
                  </div>
                </>
              ) : review.aiResponse ? (
                <>
                  <p className="text-sm bg-blue-50 p-3 rounded-lg border border-blue-100">{review.aiResponse}</p>
                  <div className="flex gap-2 flex-wrap">
                    {review.googleReviewName && review.googleReply !== review.aiResponse && (
                      <Button size="sm" onClick={() => handleApproveAndPublish(review.aiResponse || "")} disabled={publishMut.isPending}>
                        <ExternalLink className="w-4 h-4 mr-1" /> {publishMut.isPending ? "A publicar..." : review.googleReply ? "Aprovar e substituir no Google" : "Aprovar e publicar"}
                      </Button>
                    )}
                    {!review.googleReviewName && !review.aiResponseApproved && (
                      <Button size="sm" onClick={handleApprove} disabled={approveMut.isPending} title="Esta crítica veio por email: depois de aprovar, publica a resposta no perfil Google.">
                        <CheckCircle2 className="w-4 h-4 mr-1" /> Aprovar
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => { setResponseText(review.aiResponse || ""); setEditingResponse(true); }}>
                      <Edit className="w-4 h-4 mr-1" /> Editar
                    </Button>
                    <Button size="sm" variant="outline" onClick={handleGenerate} disabled={generateMut.isPending}>
                      <Sparkles className="w-4 h-4 mr-1" /> Regenerar
                    </Button>
                  </div>
                </>
              ) : (
                <div className="text-center py-4">
                  <p className="text-sm text-muted-foreground mb-3">Sem resposta gerada</p>
                  <div className="flex gap-2 justify-center">
                    <Button size="sm" onClick={handleGenerate} disabled={generateMut.isPending}>
                      <Sparkles className="w-4 h-4 mr-1" /> {generateMut.isPending ? "A gerar..." : "Gerar com IA"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => { setResponseText(""); setEditingResponse(true); }}>
                      <Edit className="w-4 h-4 mr-1" /> Escrever Manual
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Complaint link */}
          {review.complaintId && (
            <Card className="border-red-200">
              <CardContent className="p-4 flex items-center gap-3">
                <AlertTriangle className="w-5 h-5 text-red-500" />
                <div>
                  <p className="font-medium text-sm">Convertida em Reclamação #{review.complaintId}</p>
                  <p className="text-xs text-muted-foreground">Esta avaliação negativa gerou automaticamente um ticket de reclamação.</p>
                </div>
                <Button size="sm" variant="outline" className="ml-auto" onClick={() => { onClose(); window.location.href = "/reclamacoes"; }}>
                  <ExternalLink className="w-4 h-4 mr-1" /> Ver Reclamação
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Client History */}
          {clientHistory && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <Search className="w-4 h-4" /> Histórico do Cliente
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {clientHistory.complaints.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Reclamações anteriores ({clientHistory.complaints.length})</p>
                    {clientHistory.complaints.slice(0, 5).map((c: any) => (
                      <div key={c.id} className="text-sm p-2 bg-muted rounded mb-1 flex items-center gap-2">
                        <AlertTriangle className="w-3 h-3 text-orange-500" />
                        <span>{c.title}</span>
                        <Badge variant="outline" className="text-[11px] ml-auto">{c.complaintStatus}</Badge>
                      </div>
                    ))}
                  </div>
                )}
                {clientHistory.movements.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Movimentos de viatura ({clientHistory.movements.length})</p>
                    {clientHistory.movements.slice(0, 5).map((m: any) => (
                      <div key={m.id} className="text-sm p-2 bg-muted rounded mb-1">
                        {m.movementType} — {fmtPTDate(m.createdAt)}
                      </div>
                    ))}
                  </div>
                )}
                {clientHistory.reviews.length > 1 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Avaliações anteriores ({clientHistory.reviews.length - 1})</p>
                    {clientHistory.reviews.filter((r: any) => r.id !== id).slice(0, 5).map((r: any) => (
                      <div key={r.id} className="text-sm p-2 bg-muted rounded mb-1 flex items-center gap-2">
                        <Stars rating={r.rating} size="w-3 h-3" />
                        <span className="line-clamp-1">{r.reviewText || "Sem texto"}</span>
                      </div>
                    ))}
                  </div>
                )}
                {clientHistory.complaints.length === 0 && clientHistory.movements.length === 0 && clientHistory.reviews.length <= 1 && (
                  <p className="text-sm text-muted-foreground text-center py-4">Sem histórico encontrado para este cliente.</p>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <DialogFooter>
          {review.status !== "dismissed" && review.status !== "converted_complaint" && (
            <Button variant="ghost" onClick={handleDismiss} className="text-muted-foreground">
              <XCircle className="w-4 h-4 mr-1" /> Dispensar
            </Button>
          )}
          {review.rating <= 2 && review.status !== "converted_complaint" && (
            <Button
              variant="outline"
              className="text-red-700 border-red-300"
              disabled={convertMut.isPending}
              title="Cria uma Reclamação a partir desta crítica para ser tratada com prazo e responsável"
              onClick={() => {
                if (!confirm(`Transformar esta crítica de ${review.rating}★ numa Reclamação?`)) return;
                convertMut.mutate({ id });
              }}
            >
              {convertMut.isPending ? "A converter…" : "→ Criar Reclamação"}
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>Fechar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


// ─── GMAIL SYNC RESULT DIALOG ────────────────────────────────────────────────
function GmailSyncResultDialog({ result, onClose }: { result: any; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="w-5 h-5" /> Resultado da Sincronização Gmail
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Card>
              <CardContent className="p-4 text-center">
                <div className="text-2xl font-bold text-green-500">{result.reviewsImported}</div>
                <div className="text-sm text-muted-foreground">Reviews importadas</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <div className="text-2xl font-bold text-blue-500">{result.incidentsImported}</div>
                <div className="text-sm text-muted-foreground">Ocorrências importadas</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <div className="text-2xl font-bold text-muted-foreground">{result.reviewsSkipped}</div>
                <div className="text-sm text-muted-foreground">Reviews ignoradas (dup)</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <div className="text-2xl font-bold text-muted-foreground">{result.incidentsSkipped}</div>
                <div className="text-sm text-muted-foreground">Ocorrências ignoradas (dup)</div>
              </CardContent>
            </Card>
          </div>
          {result.details?.length > 0 && (
            <div>
              <h4 className="font-medium mb-2">Detalhes:</h4>
              <div className="max-h-40 overflow-y-auto space-y-1">
                {result.details.map((d: string, i: number) => (
                  <div key={i} className="text-sm flex items-center gap-2">
                    <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0" /> {d}
                  </div>
                ))}
              </div>
            </div>
          )}
          {result.errors?.length > 0 && (
            <div>
              <h4 className="font-medium mb-2 text-red-500">Erros:</h4>
              <div className="max-h-40 overflow-y-auto space-y-1">
                {result.errors.map((e: string, i: number) => (
                  <div key={i} className="text-sm flex items-center gap-2 text-red-500">
                    <XCircle className="w-3 h-3 shrink-0" /> {e}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Fechar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── CHECKOUT DRIVERS PANEL ──────────────────────────────────────────────────

function CheckoutDriversPanel() {
  const today = new Date();
  const [startDate, setStartDate] = useState(new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState(today.toISOString().slice(0, 10));

  const { data, isLoading } = trpc.reviews.checkoutDrivers.useQuery(
    { startDate, endDate },
    { enabled: !!startDate && !!endDate }
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Car className="w-5 h-5" /> Ranking de Condutores (Checkout)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-4 mb-4">
            <div>
              <Label className="text-xs">De</Label>
              <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="w-40" />
            </div>
            <div>
              <Label className="text-xs">Até</Label>
              <Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="w-40" />
            </div>
          </div>
          {isLoading ? (
            <div className="flex justify-center py-8"><div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" /></div>
          ) : !data?.drivers?.length ? (
            <p className="text-sm text-muted-foreground">Sem dados para o período selecionado.</p>
          ) : (
            <div className="space-y-2">
              <div className="grid grid-cols-[1fr_auto] gap-2 text-xs font-medium text-muted-foreground border-b pb-1">
                <span>Condutor</span>
                <span className="text-right">Entregas</span>
              </div>
              {data.drivers.map((d: any, i: number) => (
                <div key={d.userId || i} className="grid grid-cols-[1fr_auto] gap-2 items-center py-1.5 border-b border-border/50">
                  <div className="flex items-center gap-2">
                    <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${i < 3 ? "bg-amber-100 text-amber-800" : "bg-muted text-muted-foreground"}`}>
                      {i + 1}
                    </span>
                    <span className="font-medium text-sm">{d.name}</span>
                  </div>
                  <span className="font-semibold text-sm text-right">{d.count}</span>
                </div>
              ))}
              <p className="text-xs text-muted-foreground mt-2">Total: {data.total} entregas no período</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── AGENT PERFORMANCE PANEL ─────────────────────────────────────────────────

function AgentPerformancePanel() {
  const today = new Date();
  const [startDate, setStartDate] = useState(new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState(today.toISOString().slice(0, 10));
  const [agentName, setAgentName] = useState("");
  const [searchAgent, setSearchAgent] = useState("");

  const { data, isLoading } = trpc.reviews.agentHistory.useQuery(
    { startDate, endDate, agentName: searchAgent || undefined },
    { enabled: !!startDate && !!endDate && !!searchAgent }
  );

  const handleSearch = () => {
    if (!agentName.trim()) return;
    setSearchAgent(agentName.trim());
  };

  const actionStats = (data?.history || []).reduce((acc: Record<string, number>, h: any) => {
    acc[h.changeType] = (acc[h.changeType] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="w-5 h-5" /> Performance de Agentes
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-4 mb-4 flex-wrap">
            <div>
              <Label className="text-xs">De</Label>
              <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="w-40" />
            </div>
            <div>
              <Label className="text-xs">Até</Label>
              <Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="w-40" />
            </div>
            <div className="flex-1 min-w-[200px]">
              <Label className="text-xs">Nome do Agente</Label>
              <div className="flex gap-2">
                <Input value={agentName} onChange={e => setAgentName(e.target.value)} placeholder="Ex: João Silva" onKeyDown={e => e.key === "Enter" && handleSearch()} />
                <Button onClick={handleSearch} disabled={isLoading || !agentName.trim()}>
                  {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                </Button>
              </div>
            </div>
          </div>

          {!searchAgent ? (
            <p className="text-sm text-muted-foreground">Introduz o nome de um agente para ver a performance.</p>
          ) : isLoading ? (
            <div className="flex justify-center py-8"><div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" /></div>
          ) : !data?.history?.length ? (
            <p className="text-sm text-muted-foreground">Sem ações encontradas para "{searchAgent}" no período.</p>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {Object.entries(actionStats).map(([type, count]) => (
                  <Card key={type}>
                    <CardContent className="p-3 text-center">
                      <p className="text-2xl font-bold">{count as number}</p>
                      <p className="text-xs text-muted-foreground">{type.replace(/_/g, " ")}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
              <p className="text-sm font-medium">Total: {data.total} ações</p>
              <div className="max-h-96 overflow-y-auto space-y-1">
                {data.history.map((h: any) => (
                  <div key={h.id} className="flex items-center justify-between text-sm p-2 rounded bg-muted">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">{h.changeType}</Badge>
                      <span>{h.booking?.licensePlate || "—"}</span>
                      <span className="text-muted-foreground">{h.booking?.parkName || ""}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">{h.actionTime ? fmtPTDateTime(h.actionTime) : "—"}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
