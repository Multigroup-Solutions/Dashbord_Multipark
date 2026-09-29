import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc";
import { fmtPTDate } from "@/lib/lisbonTime";
import { useIsMobile } from "@/hooks/useMobile";
import { toast } from "sonner";
import { Streamdown } from "streamdown";
import {
  BookOpen, CheckCircle, ChevronRight, Clock, ExternalLink, EyeOff, FileText, HelpCircle, Newspaper, Pencil, Play, Plus,
  RefreshCw, Sparkles, Trash2, XCircle,
} from "lucide-react";
import {
  ALL_CAREER_LEVELS, CAREER_LEVEL_LABELS, isDirectVideo, useConfirm, useOpenManualFile, useUploadTrainingFile, videoEmbedUrl,
} from "./shared";
import { TutorPanel } from "./TutorPanel";

/** Conjunto "tipo:id" dos itens concluídos pelo próprio (vem de myTraining). */
export type DoneSet = Set<string>;

function useMarkItem() {
  const utils = trpc.useUtils();
  return trpc.training.markItem.useMutation({
    onSuccess: () => { void utils.training.myTraining.invalidate(); },
    // Abrir (visto) é silencioso; só a confirmação explícita mostra erro.
    onError: (e, vars) => { if (vars.completed) toast.error(e.message); },
  });
}

// ─── VÍDEOS ────────────────────────────────────────────────────────────────

type VideoForm = { categoryId: string; title: string; description: string; videoUrl: string; durationMinutes: string; careerLevel: string };
const emptyVideo: VideoForm = { categoryId: "", title: "", description: "", videoUrl: "", durationMinutes: "", careerLevel: "" };

export function VideosTab({ isAdmin, isSuperAdmin, done }: { isAdmin: boolean; isSuperAdmin: boolean; done: DoneSet }) {
  const [selectedCat, setSelectedCat] = useState<string>("all");
  const [editing, setEditing] = useState<{ id: number | null; form: VideoForm } | null>(null);
  const [showCreateCat, setShowCreateCat] = useState(false);
  const [playingVideo, setPlayingVideo] = useState<any>(null);
  const [catForm, setCatForm] = useState({ name: "", description: "" });
  const [confirm, confirmUi] = useConfirm();

  const utils = trpc.useUtils();
  const { data: categories = [] } = trpc.training.categories.useQuery();
  const { data: videos = [], refetch } = trpc.training.videos.useQuery({ categoryId: selectedCat !== "all" ? Number(selectedCat) : undefined });
  const onErr = (e: { message: string }) => toast.error(e.message);
  const createVideo = trpc.training.createVideo.useMutation({ onSuccess: () => { refetch(); setEditing(null); toast.success("Vídeo adicionado"); }, onError: onErr });
  const updateVideo = trpc.training.updateVideo.useMutation({ onSuccess: () => { refetch(); setEditing(null); toast.success("Vídeo atualizado"); }, onError: onErr });
  const deleteVideo = trpc.training.deleteVideo.useMutation({ onSuccess: () => { refetch(); toast.success("Vídeo eliminado"); }, onError: onErr });
  const createCat = trpc.training.createCategory.useMutation({
    onSuccess: () => { utils.training.categories.invalidate(); setShowCreateCat(false); setCatForm({ name: "", description: "" }); toast.success("Categoria criada"); },
    onError: onErr,
  });
  const deleteCat = trpc.training.deleteCategory.useMutation({
    onSuccess: () => { utils.training.categories.invalidate(); setSelectedCat("all"); toast.success("Categoria eliminada"); },
    onError: onErr,
  });

  const askDeleteCategory = async () => {
    const cat = categories.find((c: any) => String(c.id) === selectedCat);
    let usage: { total: number; videos: number; manuals: number; faqs: number; questions: number } | null = null;
    try { usage = await utils.training.categoryUsage.fetch({ id: Number(selectedCat) }); } catch { /* segue: o servidor recusa na mesma */ }
    if (usage && usage.total > 0) {
      toast.error(`Não é possível apagar "${cat?.name}": tem ${usage.total} conteúdo(s) (${usage.videos} vídeos, ${usage.manuals} manuais, ${usage.faqs} FAQs, ${usage.questions} perguntas). Move-os primeiro para outra categoria.`);
      return;
    }
    if (await confirm({ title: `Eliminar a categoria "${cat?.name}"?`, description: "A categoria está vazia. Esta ação não se pode desfazer.", confirmLabel: "Eliminar", destructive: true })) {
      deleteCat.mutate({ id: Number(selectedCat) });
    }
  };

  const save = () => {
    if (!editing) return;
    const f = editing.form;
    const payload = { categoryId: Number(f.categoryId), title: f.title, description: f.description || undefined, videoUrl: f.videoUrl, durationMinutes: f.durationMinutes ? Number(f.durationMinutes) : undefined, careerLevel: f.careerLevel || undefined };
    if (editing.id) updateVideo.mutate({ id: editing.id, ...payload, description: f.description || null, durationMinutes: f.durationMinutes ? Number(f.durationMinutes) : null, careerLevel: f.careerLevel || null });
    else createVideo.mutate(payload);
  };
  const setF = (k: keyof VideoForm, v: string) => setEditing((p) => p && ({ ...p, form: { ...p.form, [k]: v } }));

  return (
    <div className="space-y-4">
      {confirmUi}
      <div className="flex flex-wrap gap-2 items-center justify-between">
        <div className="flex flex-wrap gap-2 items-center">
          <Select value={selectedCat} onValueChange={setSelectedCat}>
            <SelectTrigger className="w-[200px]"><SelectValue placeholder="Categoria" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas</SelectItem>
              {categories.map((c: any) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
          {isAdmin && <Button variant="outline" size="sm" onClick={() => setShowCreateCat(true)}><Plus className="w-4 h-4 mr-1" />Categoria</Button>}
          {isSuperAdmin && selectedCat !== "all" && (
            <Button variant="outline" size="sm" className="text-destructive" disabled={deleteCat.isPending} onClick={askDeleteCategory}>
              <Trash2 className="w-4 h-4 mr-1" />Eliminar categoria
            </Button>
          )}
        </div>
        {isAdmin && <Button onClick={() => setEditing({ id: null, form: { ...emptyVideo, categoryId: selectedCat !== "all" ? selectedCat : "" } })}><Plus className="w-4 h-4 mr-1" />Novo Vídeo</Button>}
      </div>

      {videos.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-muted-foreground">Nenhum vídeo nesta categoria</CardContent></Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {videos.map((v: any) => (
            <Card key={v.id} className="overflow-hidden">
              <div className="aspect-video bg-muted flex items-center justify-center relative cursor-pointer" onClick={() => setPlayingVideo(v)}>
                {v.thumbnailUrl ? <img src={v.thumbnailUrl} alt={v.title} className="w-full h-full object-cover" /> : <Play className="w-12 h-12 text-muted-foreground" />}
                <div className="absolute inset-0 bg-black/30 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity"><Play className="w-16 h-16 text-white" /></div>
                {done.has(`video:${v.id}`) && <Badge className="absolute top-2 left-2 bg-green-600 text-white"><CheckCircle className="w-3 h-3 mr-1" />Visto</Badge>}
              </div>
              <CardContent className="p-4">
                <h3 className="font-semibold">{v.title}</h3>
                {v.description && <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{v.description}</p>}
                <div className="flex items-center justify-between mt-2 gap-2">
                  <div className="flex flex-wrap gap-1">
                    {v.durationMinutes ? <Badge variant="secondary"><Clock className="w-3 h-3 mr-1" />{v.durationMinutes} min</Badge> : null}
                    {v.careerLevel && <Badge variant="outline">{CAREER_LEVEL_LABELS[v.careerLevel] ?? v.careerLevel}</Badge>}
                  </div>
                  {isAdmin && (
                    <div className="flex">
                      <Button variant="ghost" size="icon" className="h-8 w-8" title="Editar" onClick={() => setEditing({ id: v.id, form: { categoryId: String(v.categoryId), title: v.title, description: v.description ?? "", videoUrl: v.videoUrl, durationMinutes: v.durationMinutes ? String(v.durationMinutes) : "", careerLevel: v.careerLevel ?? "" } })}><Pencil className="w-4 h-4" /></Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" title="Eliminar" onClick={async () => {
                        if (await confirm({ title: `Eliminar o vídeo "${v.title}"?`, description: "Sai também dos percursos onde estiver.", confirmLabel: "Eliminar", destructive: true })) deleteVideo.mutate({ id: v.id });
                      }}><Trash2 className="w-4 h-4" /></Button>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <VideoPlayerDialog video={playingVideo} done={playingVideo ? done.has(`video:${playingVideo.id}`) : false} onClose={() => setPlayingVideo(null)} />

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editing?.id ? "Editar vídeo" : "Novo vídeo"}</DialogTitle></DialogHeader>
          {editing && (
            <div className="space-y-3">
              <div><Label>Categoria</Label>
                <Select value={editing.form.categoryId} onValueChange={(v) => setF("categoryId", v)}>
                  <SelectTrigger><SelectValue placeholder="Selecionar" /></SelectTrigger>
                  <SelectContent>{categories.map((c: any) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div><Label>Título</Label><Input value={editing.form.title} onChange={(e) => setF("title", e.target.value)} /></div>
              <div><Label>URL do vídeo (YouTube, Vimeo ou ficheiro .mp4)</Label><Input value={editing.form.videoUrl} onChange={(e) => setF("videoUrl", e.target.value)} placeholder="https://..." /></div>
              <div><Label>Descrição</Label><Textarea value={editing.form.description} onChange={(e) => setF("description", e.target.value)} /></div>
              <div><Label>Duração (min)</Label><Input type="number" value={editing.form.durationMinutes} onChange={(e) => setF("durationMinutes", e.target.value)} /></div>
              <div><Label>Nível de carreira (opcional — torna-o módulo desse nível)</Label>
                <Select value={editing.form.careerLevel || "none"} onValueChange={(v) => setF("careerLevel", v === "none" ? "" : v)}>
                  <SelectTrigger><SelectValue placeholder="Nenhum" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Nenhum (vídeo geral)</SelectItem>
                    {ALL_CAREER_LEVELS.map((l) => <SelectItem key={l} value={l}>{CAREER_LEVEL_LABELS[l]}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <Button className="w-full" disabled={!editing.form.categoryId || !editing.form.title || !editing.form.videoUrl || createVideo.isPending || updateVideo.isPending} onClick={save}>Guardar</Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={showCreateCat} onOpenChange={setShowCreateCat}>
        <DialogContent>
          <DialogHeader><DialogTitle>Nova Categoria</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Nome</Label><Input value={catForm.name} onChange={(e) => setCatForm((p) => ({ ...p, name: e.target.value }))} /></div>
            <div><Label>Descrição</Label><Input value={catForm.description} onChange={(e) => setCatForm((p) => ({ ...p, description: e.target.value }))} /></div>
            <Button className="w-full" disabled={!catForm.name || createCat.isPending} onClick={() => createCat.mutate({ name: catForm.name, description: catForm.description || undefined })}>Criar</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Player: ficheiro direto → <video> com eventos (≥80% visto = concluído);
 * YouTube/Vimeo/outros → abrir + botão "Marcar como visto".
 */
export function VideoPlayerDialog({ video, done, onClose }: { video: any | null; done: boolean; onClose: () => void }) {
  const mark = useMarkItem();
  const maxPos = useRef(0);
  const completedRef = useRef(false);
  const openedAt = useRef(Date.now());
  useEffect(() => {
    if (!video) return;
    maxPos.current = 0; completedRef.current = false; openedAt.current = Date.now();
    mark.mutate({ itemType: "video", itemId: video.id, completed: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video?.id]);
  if (!video) return null;
  const embed = videoEmbedUrl(video.videoUrl);
  const direct = !embed && isDirectVideo(video.videoUrl);
  const complete = (seconds?: number) => {
    if (completedRef.current || done) return;
    completedRef.current = true;
    mark.mutate({ itemType: "video", itemId: video.id, completed: true, seconds: seconds ?? Math.round((Date.now() - openedAt.current) / 1000) }, { onSuccess: () => toast.success("Vídeo marcado como visto") });
  };
  return (
    <Dialog open={!!video} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl w-[calc(100vw-2rem)] p-0 max-h-[95vh] overflow-y-auto">
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle className="flex items-center gap-2"><Play className="w-4 h-4 text-primary" />{video.title}</DialogTitle>
        </DialogHeader>
        {embed ? (
          <div className="aspect-video w-full">
            <iframe src={embed} className="w-full h-full" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowFullScreen title={video.title} />
          </div>
        ) : direct ? (
          <video
            src={video.videoUrl} controls className="w-full max-h-[70vh] bg-black"
            onTimeUpdate={(e) => {
              const el = e.currentTarget;
              maxPos.current = Math.max(maxPos.current, el.currentTime);
              if (el.duration > 0 && maxPos.current / el.duration >= 0.8) complete(Math.round(maxPos.current));
            }}
          />
        ) : (
          <div className="p-6 text-center space-y-3">
            <p className="text-sm text-muted-foreground">Este vídeo abre fora da aplicação.</p>
            <Button onClick={() => window.open(video.videoUrl, "_blank", "noopener")}><ExternalLink className="w-4 h-4 mr-1" />Abrir vídeo</Button>
          </div>
        )}
        <div className="px-4 pb-4 space-y-2">
          {video.description && <p className="text-sm text-muted-foreground">{video.description}</p>}
          <div className="flex flex-wrap items-center justify-between gap-2">
            {direct && <p className="text-xs text-muted-foreground">Fica marcado como visto a partir de 80% do vídeo.</p>}
            {done ? <Badge className="bg-green-100 text-green-800"><CheckCircle className="w-3 h-3 mr-1" />Visto</Badge> : (
              !direct && <Button size="sm" variant="secondary" disabled={mark.isPending} onClick={() => complete()}><CheckCircle className="w-4 h-4 mr-1" />Marcar como visto</Button>
            )}
          </div>
          <TutorPanel context={{ type: "video", id: video.id }} defaultOpen={false} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── MANUAIS ───────────────────────────────────────────────────────────────

type ManualType = "manual" | "update" | "news" | "procedure" | "link";
type ManualForm = { title: string; content: string; type: ManualType; linkUrl: string; careerLevel: string; categoryId: string; published: boolean };
const emptyManual: ManualForm = { title: "", content: "", type: "manual", linkUrl: "", careerLevel: "", categoryId: "", published: true };
type UploadedFile = { url: string; key: string; fileName: string; mimeType: string };

export const MANUAL_TYPE_LABELS: Record<string, string> = { manual: "Manual", update: "Atualização", news: "Notícia", procedure: "Procedimento", link: "Link interativo" };
const typeIcons: Record<string, any> = { manual: BookOpen, update: RefreshCw, news: Newspaper, procedure: FileText, link: Play };
const typeColors: Record<string, string> = { manual: "bg-blue-100 text-blue-800", update: "bg-amber-100 text-amber-800", news: "bg-purple-100 text-purple-800", procedure: "bg-emerald-100 text-emerald-800", link: "bg-cyan-100 text-cyan-800" };

export function ManualsTab({ isAdmin, done, openId, onOpened }: { isAdmin: boolean; done: DoneSet; openId?: number | null; onOpened?: () => void }) {
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [editing, setEditing] = useState<{ id: number | null; form: ManualForm; file: UploadedFile | null; removeFile: boolean } | null>(null);
  const [selectedManual, setSelectedManual] = useState<any>(null);
  const [uploading, setUploading] = useState(false);
  const [aiFor, setAiFor] = useState<any>(null);
  const [aiCount, setAiCount] = useState("5");
  const [confirm, confirmUi] = useConfirm();
  const upload = useUploadTrainingFile();

  const utils = trpc.useUtils();
  const { data: categories = [] } = trpc.training.categories.useQuery();
  const { data: manuals = [], refetch } = trpc.training.manuals.useQuery({ type: typeFilter !== "all" ? typeFilter : undefined });
  const { data: llm } = trpc.training.llmStatus.useQuery(undefined, { enabled: isAdmin });
  const onErr = (e: { message: string }) => toast.error(e.message);
  const done_ = () => { refetch(); setEditing(null); };
  const createManual = trpc.training.createManual.useMutation({ onSuccess: () => { done_(); toast.success("Conteúdo criado"); }, onError: onErr });
  const updateManual = trpc.training.updateManual.useMutation({ onSuccess: () => { done_(); toast.success("Conteúdo atualizado"); }, onError: onErr });
  const deleteManual = trpc.training.deleteManual.useMutation({ onSuccess: () => { refetch(); setSelectedManual(null); toast.success("Eliminado"); }, onError: onErr });
  const genAi = trpc.training.generateQuizDrafts.useMutation({
    onSuccess: (r) => {
      setAiFor(null);
      if (r.skipped) toast.warning(r.reason ?? "IA indisponível");
      else { toast.success(`${r.created} pergunta(s) criadas como rascunho — revê e publica no separador Quiz.`); void utils.training.quizQuestions.invalidate(); }
    },
    onError: onErr,
  });

  // Abrir diretamente (vindo de "A minha formação")
  useEffect(() => {
    if (openId == null) return;
    const m = (manuals as any[]).find((x) => x.id === openId);
    if (m) { setSelectedManual(m); onOpened?.(); }
  }, [openId, manuals, onOpened]);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      const f = await upload(file);
      setEditing((p) => p && ({ ...p, file: f, removeFile: false }));
      toast.success("Ficheiro carregado");
    } catch (err: any) {
      toast.error(`Erro no upload: ${err?.message ?? "falha desconhecida"}`);
    } finally { setUploading(false); }
  };

  const save = () => {
    if (!editing) return;
    const { form, file, removeFile, id } = editing;
    const isLink = form.type === "link";
    const fileFields = isLink
      ? { fileUrl: form.linkUrl, fileKey: null, fileMimeType: "text/x-interactive-link", fileName: form.linkUrl.replace(/^https?:\/\//, "").slice(0, 80) }
      : file ? { fileUrl: file.url, fileKey: file.key, fileName: file.fileName, fileMimeType: file.mimeType }
        : removeFile ? { fileUrl: null, fileKey: null, fileName: null, fileMimeType: null } : {};
    const content = form.content || (isLink ? form.linkUrl : "");
    if (id) {
      updateManual.mutate({ id, title: form.title, content, type: form.type, published: form.published, careerLevel: form.careerLevel || null, categoryId: form.categoryId ? Number(form.categoryId) : null, ...fileFields });
    } else {
      const f = fileFields as any;
      createManual.mutate({
        title: form.title, content, type: form.type, careerLevel: form.careerLevel || undefined, categoryId: form.categoryId ? Number(form.categoryId) : undefined,
        ...(f.fileUrl ? { fileUrl: f.fileUrl, fileKey: f.fileKey ?? undefined, fileName: f.fileName, fileMimeType: f.fileMimeType } : {}),
      });
    }
  };
  const setF = <K extends keyof ManualForm>(k: K, v: ManualForm[K]) => setEditing((p) => p && ({ ...p, form: { ...p.form, [k]: v } }));
  const startEdit = (m: any) => setEditing({
    id: m.id, file: null, removeFile: false,
    form: { title: m.title, content: m.content ?? "", type: m.type, linkUrl: m.type === "link" ? m.fileUrl ?? "" : "", careerLevel: m.careerLevel ?? "", categoryId: m.categoryId ? String(m.categoryId) : "", published: m.published !== 0 },
  });
  const askDelete = async (m: any) => {
    if (await confirm({ title: `Eliminar "${m.title}"?`, description: "Sai também dos percursos onde estiver. Não se pode desfazer.", confirmLabel: "Eliminar", destructive: true })) deleteManual.mutate({ id: m.id });
  };

  const editDialog = (
    <Dialog open={!!editing} onOpenChange={(o) => { if (!o) setEditing(null); }}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{editing?.id ? "Editar conteúdo" : "Novo conteúdo"}</DialogTitle></DialogHeader>
        {editing && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div><Label>Tipo</Label>
                <Select value={editing.form.type} onValueChange={(v) => setF("type", v as ManualType)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">Manual</SelectItem>
                    <SelectItem value="procedure">Procedimento</SelectItem>
                    <SelectItem value="update">Atualização</SelectItem>
                    <SelectItem value="news">Notícia</SelectItem>
                    <SelectItem value="link">Link interativo (Genially, Slides, Forms…)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div><Label>Categoria (opcional)</Label>
                <Select value={editing.form.categoryId || "none"} onValueChange={(v) => setF("categoryId", v === "none" ? "" : v)}>
                  <SelectTrigger><SelectValue placeholder="Sem categoria" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Sem categoria</SelectItem>
                    {categories.map((c: any) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div><Label>Título</Label><Input value={editing.form.title} onChange={(e) => setF("title", e.target.value)} /></div>
            <div><Label>Nível de carreira (opcional — torna-o módulo desse nível)</Label>
              <Select value={editing.form.careerLevel || "none"} onValueChange={(v) => setF("careerLevel", v === "none" ? "" : v)}>
                <SelectTrigger><SelectValue placeholder="Nenhum" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Nenhum (conteúdo geral)</SelectItem>
                  {ALL_CAREER_LEVELS.map((l) => <SelectItem key={l} value={l}>{CAREER_LEVEL_LABELS[l]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {editing.form.type === "link" ? (
              <div><Label>URL da página interativa</Label><Input value={editing.form.linkUrl} onChange={(e) => setF("linkUrl", e.target.value)} placeholder="https://view.genially.com/…" /></div>
            ) : (
              <div>
                <Label>Ficheiro (PDF, PPT, DOC — opcional, máx 4MB)</Label>
                <Input type="file" accept=".pdf,.ppt,.pptx,.doc,.docx,.xls,.xlsx" onChange={handleFile} disabled={uploading} />
                {uploading && <p className="text-sm text-muted-foreground mt-1">A carregar...</p>}
                {editing.file ? (
                  <div className="flex items-center gap-2 mt-2 p-2 bg-muted rounded">
                    <FileText className="w-4 h-4" /><span className="text-sm truncate">{editing.file.fileName}</span>
                    <Button variant="ghost" size="icon" className="h-6 w-6 ml-auto" onClick={() => setEditing((p) => p && ({ ...p, file: null }))}><XCircle className="w-4 h-4" /></Button>
                  </div>
                ) : editing.id && !editing.removeFile && (manuals as any[]).find((m) => m.id === editing.id)?.fileName ? (
                  <div className="flex items-center gap-2 mt-2 p-2 bg-muted rounded">
                    <FileText className="w-4 h-4" /><span className="text-sm truncate">Atual: {(manuals as any[]).find((m) => m.id === editing.id)?.fileName}</span>
                    <Button variant="ghost" size="sm" className="ml-auto text-destructive" onClick={() => setEditing((p) => p && ({ ...p, removeFile: true }))}>Remover</Button>
                  </div>
                ) : null}
              </div>
            )}
            <div><Label>Conteúdo / descrição (Markdown)</Label><Textarea rows={8} value={editing.form.content} onChange={(e) => setF("content", e.target.value)} placeholder="Escreve em Markdown..." /></div>
            <div className="flex items-center gap-2"><Switch checked={editing.form.published} onCheckedChange={(v) => setF("published", v)} id="man-pub" /><Label htmlFor="man-pub">Publicado (visível para todos)</Label></div>
            <Button className="w-full" disabled={!editing.form.title || (editing.form.type === "link" ? !editing.form.linkUrl : false) || createManual.isPending || updateManual.isPending || uploading} onClick={save}>
              {createManual.isPending || updateManual.isPending ? "A guardar..." : "Guardar"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );

  const aiDialog = (
    <Dialog open={!!aiFor} onOpenChange={(o) => !o && setAiFor(null)}>
      <DialogContent>
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Sparkles className="w-4 h-4" />Gerar perguntas com IA</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">A IA lê "{aiFor?.title}" (texto{aiFor?.fileMimeType?.includes("pdf") ? " e PDF" : ""}) e cria perguntas A–D com explicação, em PT-PT. Ficam como <b>rascunho</b> no Quiz até as publicares.</p>
          <div><Label>Número de perguntas</Label><Input type="number" min={1} max={20} value={aiCount} onChange={(e) => setAiCount(e.target.value)} /></div>
          <Button className="w-full" disabled={genAi.isPending} onClick={() => genAi.mutate({ manualId: aiFor.id, count: Math.max(1, Math.min(20, Number(aiCount) || 5)) })}>
            {genAi.isPending ? "A gerar…" : "Gerar rascunhos"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );

  if (selectedManual) {
    const fresh = (manuals as any[]).find((m) => m.id === selectedManual.id) ?? selectedManual;
    return (
      <>
        {confirmUi}{editDialog}{aiDialog}
        <ManualDetail manual={fresh} done={done.has(`manual:${fresh.id}`)} isAdmin={isAdmin} llmConfigured={!!llm?.configured}
          onBack={() => setSelectedManual(null)} onEdit={() => startEdit(fresh)} onDelete={() => askDelete(fresh)} onAi={() => setAiFor(fresh)} />
      </>
    );
  }

  return (
    <div className="space-y-4">
      {confirmUi}{editDialog}{aiDialog}
      <div className="flex flex-wrap gap-2 items-center justify-between">
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-[200px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            <SelectItem value="manual">Manuais</SelectItem>
            <SelectItem value="procedure">Procedimentos</SelectItem>
            <SelectItem value="update">Atualizações</SelectItem>
            <SelectItem value="news">Notícias</SelectItem>
            <SelectItem value="link">Links interativos</SelectItem>
          </SelectContent>
        </Select>
        {isAdmin && <Button onClick={() => setEditing({ id: null, form: emptyManual, file: null, removeFile: false })}><Plus className="w-4 h-4 mr-1" />Novo</Button>}
      </div>

      {manuals.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-muted-foreground">Nenhum conteúdo disponível</CardContent></Card>
      ) : (
        <div className="space-y-3">
          {(manuals as any[]).map((m) => {
            const Icon = typeIcons[m.type] || FileText;
            return (
              <Card key={m.id} className={`cursor-pointer hover:bg-accent/50 transition-colors ${m.published === 0 ? "border-dashed opacity-80" : ""}`} onClick={() => setSelectedManual(m)}>
                <CardContent className="p-4 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-3 min-w-0">
                    <Icon className="w-5 h-5 text-primary shrink-0" />
                    <div className="min-w-0">
                      <h3 className="font-semibold truncate">{m.title}</h3>
                      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                        <span>{fmtPTDate(m.createdAt)}</span>
                        <Badge variant="outline" className="text-xs">{MANUAL_TYPE_LABELS[m.type] || m.type}</Badge>
                        {m.published === 0 && <Badge className="text-xs bg-amber-100 text-amber-800"><EyeOff className="w-3 h-3 mr-1" />Não publicado</Badge>}
                        {done.has(`manual:${m.id}`) && <Badge className="text-xs bg-green-100 text-green-800"><CheckCircle className="w-3 h-3 mr-1" />Lido</Badge>}
                        {m.fileName && m.type !== "link" && <Badge variant="secondary" className="text-xs">📎 {m.fileName.slice(0, 30)}</Badge>}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {isAdmin && <Button variant="ghost" size="icon" className="h-8 w-8" title="Editar" onClick={(e) => { e.stopPropagation(); startEdit(m); }}><Pencil className="w-4 h-4" /></Button>}
                    {isAdmin && <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" title="Eliminar" onClick={(e) => { e.stopPropagation(); void askDelete(m); }}><Trash2 className="w-4 h-4" /></Button>}
                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ManualDetail({ manual, done, isAdmin, llmConfigured, onBack, onEdit, onDelete, onAi }: {
  manual: any; done: boolean; isAdmin: boolean; llmConfigured: boolean; onBack: () => void; onEdit: () => void; onDelete: () => void; onAi: () => void;
}) {
  const isMobile = useIsMobile();
  const mark = useMarkItem();
  const openFile = useOpenManualFile();
  const isLink = manual.type === "link" && !!manual.fileUrl;
  const hasFile = !isLink && !!(manual.fileKey || manual.fileUrl);
  const isPdf = hasFile && (manual.fileMimeType === "application/pdf" || /\.pdf$/i.test(manual.fileName ?? ""));
  // URL assinada só para o visualizador inline (desktop)
  const { data: signed } = trpc.training.manualFileUrl.useQuery({ id: manual.id }, { enabled: isPdf && !isMobile, staleTime: 10 * 60_000 });
  const openedAt = useRef(Date.now());
  useEffect(() => {
    openedAt.current = Date.now();
    mark.mutate({ itemType: "manual", itemId: manual.id, completed: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manual.id]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" onClick={onBack}>← Voltar</Button>
        {isAdmin && (
          <div className="flex flex-wrap gap-2">
            {llmConfigured && <Button variant="outline" size="sm" onClick={onAi}><Sparkles className="w-4 h-4 mr-1" />Gerar perguntas (IA)</Button>}
            <Button variant="outline" size="sm" onClick={onEdit}><Pencil className="w-4 h-4 mr-1" />Editar</Button>
            <Button variant="outline" size="sm" className="text-destructive" onClick={onDelete}><Trash2 className="w-4 h-4 mr-1" />Eliminar</Button>
          </div>
        )}
      </div>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <Badge className={typeColors[manual.type] || "bg-gray-100 text-gray-800"}>{MANUAL_TYPE_LABELS[manual.type] || manual.type}</Badge>
            {manual.published === 0 && <Badge className="bg-amber-100 text-amber-800"><EyeOff className="w-3 h-3 mr-1" />Não publicado</Badge>}
            <CardTitle>{manual.title}</CardTitle>
          </div>
          <p className="text-sm text-muted-foreground">{fmtPTDate(manual.createdAt)}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLink && (
            <div className="border rounded-lg overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 p-2 bg-muted/40">
                <p className="text-xs text-muted-foreground truncate min-w-0 flex-1">{manual.fileUrl}</p>
                <Button variant="outline" size="sm" onClick={() => window.open(manual.fileUrl, "_blank", "noopener")}><ExternalLink className="w-4 h-4 mr-1" />Abrir em nova janela</Button>
              </div>
              {/* Alguns sites bloqueiam embed (X-Frame-Options) — o botão acima é o recurso */}
              {!isMobile && <iframe src={manual.fileUrl} className="w-full h-[70vh]" allow="fullscreen" title={manual.title} />}
            </div>
          )}
          {hasFile && (
            <div className="border rounded-lg p-4 bg-muted/30">
              <div className="flex flex-wrap items-center gap-3">
                <FileText className="w-8 h-8 text-primary" />
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{manual.fileName || "Ficheiro anexo"}</p>
                  <p className="text-sm text-muted-foreground">{manual.fileMimeType}</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => void openFile(manual.id)}><ExternalLink className="w-4 h-4 mr-1" />{isPdf ? "Abrir PDF em nova janela" : "Abrir"}</Button>
              </div>
              {isPdf && !isMobile && signed?.url && <iframe src={signed.url} className="w-full h-[600px] mt-3 rounded border" title={manual.fileName ?? manual.title} />}
            </div>
          )}
          {manual.content && !(isLink && manual.content === manual.fileUrl) && (
            <div className="prose max-w-none"><Streamdown>{manual.content}</Streamdown></div>
          )}
          <div className="flex justify-end border-t pt-3">
            {done ? <Badge className="bg-green-100 text-green-800"><CheckCircle className="w-3 h-3 mr-1" />Lido</Badge> : (
              <Button disabled={mark.isPending} onClick={() => mark.mutate({ itemType: "manual", itemId: manual.id, completed: true, seconds: Math.round((Date.now() - openedAt.current) / 1000) }, { onSuccess: () => toast.success("Marcado como lido") })}>
                <CheckCircle className="w-4 h-4 mr-1" />Li
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
      <TutorPanel context={{ type: "manual", id: manual.id }} />
    </div>
  );
}

// ─── FAQs ──────────────────────────────────────────────────────────────────

export function FAQsTab({ isAdmin }: { isAdmin: boolean }) {
  const [editing, setEditing] = useState<{ id: number | null; question: string; answer: string } | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [confirm, confirmUi] = useConfirm();
  const { data: faqsList = [], refetch } = trpc.training.faqs.useQuery({});
  const onErr = (e: { message: string }) => toast.error(e.message);
  const createFAQ = trpc.training.createFAQ.useMutation({ onSuccess: () => { refetch(); setEditing(null); toast.success("FAQ adicionada"); }, onError: onErr });
  const updateFAQ = trpc.training.updateFAQ.useMutation({ onSuccess: () => { refetch(); setEditing(null); toast.success("FAQ atualizada"); }, onError: onErr });
  const deleteFAQ = trpc.training.deleteFAQ.useMutation({ onSuccess: () => { refetch(); toast.success("FAQ eliminada"); }, onError: onErr });

  return (
    <div className="space-y-4">
      {confirmUi}
      <div className="flex justify-end">
        {isAdmin && <Button onClick={() => setEditing({ id: null, question: "", answer: "" })}><Plus className="w-4 h-4 mr-1" />Nova FAQ</Button>}
      </div>
      {faqsList.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-muted-foreground">Nenhuma FAQ disponível</CardContent></Card>
      ) : (
        <div className="space-y-2">
          {faqsList.map((f: any) => (
            <Card key={f.id} className="overflow-hidden">
              <CardContent className="p-0">
                <button className="w-full p-4 text-left flex items-center justify-between gap-2 hover:bg-accent/50 transition-colors" onClick={() => setExpandedId(expandedId === f.id ? null : f.id)}>
                  <span className="font-medium flex items-center gap-2 min-w-0"><HelpCircle className="w-4 h-4 text-primary shrink-0" /><span className="truncate">{f.question}</span></span>
                  <ChevronRight className={`w-4 h-4 shrink-0 transition-transform ${expandedId === f.id ? "rotate-90" : ""}`} />
                </button>
                {expandedId === f.id && (
                  <div className="px-4 pb-4 border-t">
                    <div className="pt-3 prose max-w-none text-sm"><Streamdown>{f.answer}</Streamdown></div>
                    {isAdmin && (
                      <div className="flex gap-2 mt-2">
                        <Button variant="ghost" size="sm" onClick={() => setEditing({ id: f.id, question: f.question, answer: f.answer })}><Pencil className="w-3 h-3 mr-1" />Editar</Button>
                        <Button variant="ghost" size="sm" className="text-destructive" onClick={async () => {
                          if (await confirm({ title: "Eliminar esta FAQ?", description: f.question, confirmLabel: "Eliminar", destructive: true })) deleteFAQ.mutate({ id: f.id });
                        }}><Trash2 className="w-3 h-3 mr-1" />Eliminar</Button>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editing?.id ? "Editar FAQ" : "Nova FAQ"}</DialogTitle></DialogHeader>
          {editing && (
            <div className="space-y-3">
              <div><Label>Pergunta</Label><Input value={editing.question} onChange={(e) => setEditing((p) => p && ({ ...p, question: e.target.value }))} /></div>
              <div><Label>Resposta (Markdown)</Label><Textarea rows={6} value={editing.answer} onChange={(e) => setEditing((p) => p && ({ ...p, answer: e.target.value }))} /></div>
              <Button className="w-full" disabled={!editing.question || !editing.answer || createFAQ.isPending || updateFAQ.isPending} onClick={() => {
                if (editing.id) updateFAQ.mutate({ id: editing.id, question: editing.question, answer: editing.answer });
                else createFAQ.mutate({ question: editing.question, answer: editing.answer });
              }}>Guardar</Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function useDoneSet(progress: Array<{ itemType: string; itemId: number; completedAt: string | null }> | undefined): DoneSet {
  return useMemo(() => new Set((progress ?? []).filter((p) => p.completedAt).map((p) => `${p.itemType}:${p.itemId}`)), [progress]);
}
