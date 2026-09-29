/**
 * Formação → Base de conhecimento (admin / super_admin): documentos que o
 * tutor da formação, o assistente e a pesquisa global usam — pastas do Shared
 * Drive sincronizadas, ficheiros carregados (PDF, DOCX, TXT/MD) e a ajuda da
 * app. Estado de cada documento, visibilidade (todos / papéis / cidades),
 * voltar a sincronizar, pré-visualizar o texto extraído, perguntas de quiz
 * (rascunhos) e definições das pastas.
 */
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle, BookOpen, CheckCircle2, ChevronDown, Eye, FileUp, FolderSync, HelpCircle, Loader2, Plus, RefreshCw, Settings2, Shield,
  Sparkles, Trash2, Undo2, X,
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { can, ROLE_LABELS, ROLES } from "@shared/access";
import {
  KB_CITIES, KB_MAX_UPLOAD_BYTES, KB_SOURCE_LABELS, KB_STATUS_LABELS, KB_UPLOAD_ACCEPT, KB_VISIBILITY_ALL, visibilityLabel,
  type KbFolder, type KbSource, type KbStatus, type KbVisibility, type KnowledgeConfig,
} from "@shared/knowledge";

const STATUS_STYLE: Record<KbStatus, string> = {
  synced: "bg-green-100 text-green-800 border-green-200",
  pending: "bg-amber-100 text-amber-800 border-amber-200",
  processing: "bg-blue-100 text-blue-800 border-blue-200",
  error: "bg-red-100 text-red-800 border-red-200",
  skipped: "bg-gray-100 text-gray-700 border-gray-200",
};

const fmtWhen = (s: string | null | undefined) => {
  if (!s) return "—";
  const d = new Date(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString("pt-PT", { timeZone: "Europe/Lisbon", day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
};

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? "").split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Não foi possível ler o ficheiro."));
    r.readAsDataURL(file);
  });
}

/** Papéis + cidades (vazio = todos). */
function VisibilityEditor({ value, onChange }: { value: KbVisibility; onChange: (v: KbVisibility) => void }) {
  const toggle = <T extends string>(list: T[], item: T) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  return (
    <div className="space-y-3">
      <div>
        <Label className="text-xs">Papéis (nenhum marcado = todos)</Label>
        <div className="mt-1 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {ROLES.map((r) => (
            <label key={r} className="flex items-center gap-2 text-sm">
              <Checkbox checked={value.roles.includes(r)} onCheckedChange={() => onChange({ ...value, roles: toggle(value.roles, r) })} />
              {ROLE_LABELS[r]}
            </label>
          ))}
        </div>
      </div>
      <div>
        <Label className="text-xs">Cidades (nenhuma marcada = todas)</Label>
        <div className="mt-1 flex flex-wrap gap-3">
          {KB_CITIES.map((c) => (
            <label key={c} className="flex items-center gap-2 text-sm">
              <Checkbox checked={value.cities.includes(c)} onCheckedChange={() => onChange({ ...value, cities: toggle(value.cities, c) })} />
              {c}
            </label>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Quem não pode ver um documento não o encontra na pesquisa e o tutor/assistente nunca o usa nas respostas dessa pessoa.</p>
    </div>
  );
}

function SettingsCard({ config, onSaved }: { config: KnowledgeConfig; onSaved: () => void }) {
  const [draft, setDraft] = useState<KnowledgeConfig>(config);
  const [open, setOpen] = useState(false);
  const save = trpc.knowledge.saveConfig.useMutation({
    onSuccess: (r) => { toast.success(r.changed ? "Definições guardadas." : "Sem alterações."); onSaved(); },
    onError: (e) => toast.error(e.message),
  });
  const setFolder = (i: number, f: KbFolder) => setDraft({ ...draft, folders: draft.folders.map((x, j) => (j === i ? f : x)) });
  return (
    <Card>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CardHeader className="py-3">
          <CollapsibleTrigger className="flex w-full items-center justify-between text-left">
            <CardTitle className="flex items-center gap-2 text-base"><Settings2 className="h-4 w-4" /> Definições</CardTitle>
            <ChevronDown className={`h-4 w-4 transition ${open ? "rotate-180" : ""}`} />
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
                <span><b>Sincronizar pastas do Drive</b><br /><span className="text-xs text-muted-foreground">Com o botão «Sincronizar agora» (sem agenda automática).</span></span>
                <Switch checked={draft.driveEnabled} onCheckedChange={(v) => setDraft({ ...draft, driveEnabled: v })} />
              </label>
              <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
                <span><b>Índice por IA (embeddings)</b><br /><span className="text-xs text-muted-foreground">Desligado = só palavras-chave.</span></span>
                <Switch checked={draft.embeddings} onCheckedChange={(v) => setDraft({ ...draft, embeddings: v })} />
              </label>
              <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
                <span><b>Assistente usa a base</b></span>
                <Switch checked={draft.useInAssistant} onCheckedChange={(v) => setDraft({ ...draft, useInAssistant: v })} />
              </label>
              <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
                <span><b>Tutor da formação usa a base</b></span>
                <Switch checked={draft.useInTutor} onCheckedChange={(v) => setDraft({ ...draft, useInTutor: v })} />
              </label>
            </div>
            <div className="space-y-2">
              <Label>Pastas do Shared Drive (caminho a partir da raiz, ex.: Formação ou Procedimentos/Porto)</Label>
              {draft.folders.map((f, i) => (
                <div key={i} className="space-y-2 rounded-md border p-3">
                  <div className="flex gap-2">
                    <Input value={f.path} onChange={(e) => setFolder(i, { ...f, path: e.target.value })} placeholder="Formação" />
                    <Button variant="ghost" size="icon" onClick={() => setDraft({ ...draft, folders: draft.folders.filter((_, j) => j !== i) })} aria-label="Remover pasta">
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                  <VisibilityEditor value={f.visibility} onChange={(v) => setFolder(i, { ...f, visibility: v })} />
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={() => setDraft({ ...draft, folders: [...draft.folders, { path: "", visibility: KB_VISIBILITY_ALL }] })} disabled={draft.folders.length >= 20}>
                <Plus className="mr-1 h-4 w-4" /> Pasta
              </Button>
            </div>
            <div className="flex justify-end">
              <Button onClick={() => save.mutate({ ...draft, folders: draft.folders.filter((f) => f.path.trim()) })} disabled={save.isPending}>
                {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Guardar
              </Button>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

type Doc = {
  id: number; source: KbSource; title: string; folderPath: string | null; status: KbStatus; error: string | null; visibility: KbVisibility;
  visibilityCustom: boolean; chunkCount: number; charCount: number; embedded: boolean; syncedAt: string | null; webViewLink: string | null;
};

function PreviewDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const q = trpc.knowledge.get.useQuery({ id });
  const d = q.data;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader><DialogTitle>{d?.title ?? "Documento"}</DialogTitle></DialogHeader>
        {q.isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : !d ? <p className="text-sm text-muted-foreground">Não encontrado.</p> : (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span>{KB_SOURCE_LABELS[d.source]}</span>
              {d.folderPath && <span>· {d.folderPath}</span>}
              <span>· {d.charCount.toLocaleString("pt-PT")} caracteres · {d.chunkCount} trechos{d.embedded ? " (com índice IA)" : ""}</span>
              {d.webViewLink && /^https:/.test(d.webViewLink) && <a href={d.webViewLink} target="_blank" rel="noopener noreferrer" className="text-primary underline">Abrir no Drive</a>}
            </div>
            {d.error && <p className="rounded-md bg-red-50 p-2 text-red-800">{d.error}</p>}
            <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">{d.textContent || "(sem texto extraído)"}</pre>
            {d.textTruncated && <p className="text-xs text-muted-foreground">Mostram-se os primeiros 20 000 caracteres.</p>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function VisibilityDialog({ doc, onClose, onSaved }: { doc: Doc; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState<KbVisibility>(doc.visibility);
  const [follow, setFollow] = useState(doc.source === "drive" && !doc.visibilityCustom);
  const save = trpc.knowledge.updateVisibility.useMutation({ onSuccess: () => { toast.success("Visibilidade guardada."); onSaved(); onClose(); }, onError: (e) => toast.error(e.message) });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader><DialogTitle>Quem vê «{doc.title}»</DialogTitle></DialogHeader>
        <VisibilityEditor value={v} onChange={setV} />
        {doc.source === "drive" && (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={follow} onCheckedChange={(c) => setFollow(!!c)} />
            Seguir a visibilidade da pasta nas próximas sincronizações
          </label>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => save.mutate({ id: doc.id, visibility: v, followFolder: follow })} disabled={save.isPending}>Guardar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function QuizDialog({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const [count, setCount] = useState(5);
  const [categoryId, setCategoryId] = useState<string>("none");
  const cats = trpc.training.categories.useQuery();
  const gen = trpc.knowledge.generateQuiz.useMutation({
    onSuccess: (r) => {
      if (r.skipped) toast.error(r.reason ?? "IA indisponível.");
      else toast.success(`${r.created} perguntas criadas como rascunho — revê-as e publica-as em Formação → Quiz.`);
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Perguntas de quiz a partir de «{doc.title}»</DialogTitle></DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">A IA (modelo mais barato) propõe perguntas de escolha múltipla só com o texto do documento. Ficam como <b>rascunho</b>: um formador revê, corrige e publica.</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Quantas</Label>
              <Input type="number" min={1} max={15} value={count} onChange={(e) => setCount(Math.max(1, Math.min(15, Number(e.target.value) || 1)))} />
            </div>
            <div>
              <Label className="text-xs">Categoria</Label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Geral</SelectItem>
                  {(cats.data ?? []).map((c: any) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => gen.mutate({ id: doc.id, count, categoryId: categoryId === "none" ? null : Number(categoryId) })} disabled={gen.isPending}>
            {gen.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}Gerar rascunhos
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UploadDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [v, setV] = useState<KbVisibility>(KB_VISIBILITY_ALL);
  const up = trpc.knowledge.upload.useMutation({
    onSuccess: (r) => {
      if (r.status === "error") toast.error(`Carregado, mas não foi possível ler: ${r.error ?? "erro"}`);
      else toast.success("Documento carregado e indexado.");
      onDone();
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });
  const submit = async () => {
    if (!file) return;
    if (file.size > KB_MAX_UPLOAD_BYTES) { toast.error("Ficheiro demasiado grande (máx. 4 MB). Põe-no numa pasta do Drive sincronizada."); return; }
    try {
      up.mutate({ fileName: file.name, mimeType: file.type, fileBase64: await readAsBase64(file), title: title.trim() || undefined, visibility: v });
    } catch (e: any) { toast.error(e.message); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader><DialogTitle>Carregar documento</DialogTitle></DialogHeader>
        <div className="space-y-3 text-sm">
          <div>
            <Label className="text-xs">Ficheiro (PDF, DOCX, TXT ou MD — máx. 4 MB)</Label>
            <Input ref={fileRef} type="file" accept={KB_UPLOAD_ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </div>
          <div>
            <Label className="text-xs">Título (opcional)</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={file?.name.replace(/\.[a-z0-9]+$/i, "") ?? "Manual de receção"} />
          </div>
          <VisibilityEditor value={v} onChange={setV} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={submit} disabled={!file || up.isPending}>
            {up.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileUp className="mr-2 h-4 w-4" />}Carregar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function KnowledgeBasePage() {
  const { user } = useAuth();
  const allowed = !!user && can(user as any, "formacao", "manage");
  const utils = trpc.useUtils();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<KbStatus | "all">("all");
  const [source, setSource] = useState<KbSource | "all">("all");
  const [preview, setPreview] = useState<number | null>(null);
  const [visDoc, setVisDoc] = useState<Doc | null>(null);
  const [quizDoc, setQuizDoc] = useState<Doc | null>(null);
  const [uploading, setUploading] = useState(false);

  const st = trpc.knowledge.status.useQuery(undefined, { enabled: allowed });
  const list = trpc.knowledge.list.useQuery({ q: q.trim() || undefined, status: status === "all" ? undefined : status, source: source === "all" ? undefined : source }, { enabled: allowed });
  const refresh = () => { void utils.knowledge.list.invalidate(); void utils.knowledge.status.invalidate(); };
  const onErr = (e: { message: string }) => toast.error(e.message);
  const syncNow = trpc.knowledge.syncNow.useMutation({
    onSuccess: (r) => { toast.success(`Sincronização: ${r.processed} processados, ${r.failed} com erro${r.done ? "" : " (continua na próxima corrida)"}.`); refresh(); },
    onError: onErr,
  });
  const resync = trpc.knowledge.resync.useMutation({ onSuccess: (r) => { r.status === "error" ? toast.error(r.error ?? "Erro") : toast.success("Sincronizado."); refresh(); }, onError: onErr });
  const remove = trpc.knowledge.remove.useMutation({ onSuccess: (r) => { toast.success(r.excluded ? "Excluído do índice." : "Apagado."); refresh(); }, onError: onErr });
  const include = trpc.knowledge.include.useMutation({ onSuccess: () => { toast.success("Voltou ao índice."); refresh(); }, onError: onErr });

  const docs = (list.data ?? []) as Doc[];
  const counts = (st.data?.counts ?? {}) as Record<string, number>;
  const lastRun = st.data?.lastRun as null | { at: string; processed: number; failed: number; errors: string[]; pass: string };
  const roleLabels = ROLE_LABELS as Record<string, string>;
  const driveOk = !!(st.data?.drive.sharedEnabled && st.data?.drive.delegation);
  const total = useMemo(() => Object.values(counts).reduce((a, b) => a + b, 0), [counts]);

  if (!allowed) {
    return <div className="rounded-lg border p-6 text-sm text-muted-foreground">A base de conhecimento é gerida por administradores (Formação → gerir).</div>;
  }

  return (
    <div className="mx-auto max-w-[1300px] space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold"><BookOpen className="h-5 w-5" /> Base de conhecimento</h2>
          <p className="text-sm text-muted-foreground">Manuais e procedimentos que o tutor da formação, o assistente e a pesquisa global usam (sempre com a visibilidade de cada documento).</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => syncNow.mutate()} disabled={syncNow.isPending}>
            {syncNow.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FolderSync className="mr-2 h-4 w-4" />}Sincronizar agora
          </Button>
          <Button onClick={() => setUploading(true)}><FileUp className="mr-2 h-4 w-4" /> Carregar documento</Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Card>
          <CardContent className="space-y-1 p-4 text-sm">
            <p className="font-medium">Google Drive</p>
            {st.isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : driveOk ? (
              <p className="flex items-center gap-1 text-green-700"><CheckCircle2 className="h-4 w-4" /> Shared Drive «{st.data?.drive.sharedDriveName}»</p>
            ) : (
              <p className="flex items-start gap-1 text-amber-700"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> Shared Drive por configurar (Definições → Comunicação → Google Drive). Os ficheiros carregados funcionam na mesma.</p>
            )}
            <p className="text-xs text-muted-foreground">Pastas: {st.data?.config.driveEnabled ? (st.data.config.folders.map((f) => f.path).join(", ") || "nenhuma") : "sincronização desligada"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-1 p-4 text-sm">
            <p className="font-medium">Documentos ({total})</p>
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(KB_STATUS_LABELS) as KbStatus[]).filter((k) => counts[k]).map((k) => (
                <Badge key={k} variant="outline" className={STATUS_STYLE[k]}>{KB_STATUS_LABELS[k]}: {counts[k]}</Badge>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Índice IA: {st.data?.embeddingsActive ? "ligado" : "desligado (só palavras-chave)"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-1 p-4 text-sm">
            <p className="font-medium">Última sincronização</p>
            {lastRun ? (
              <>
                <p>{fmtWhen(lastRun.at)} · {lastRun.processed} processados · {lastRun.failed} com erro</p>
                {lastRun.errors?.length > 0 && <p className="line-clamp-3 text-xs text-red-700" title={lastRun.errors.join("\n")}>{lastRun.errors.join(" · ")}</p>}
              </>
            ) : <p className="text-muted-foreground">Ainda não correu.</p>}
          </CardContent>
        </Card>
      </div>

      {st.data && <SettingsCard key={JSON.stringify(st.data.config)} config={st.data.config} onSaved={refresh} />}

      <Card>
        <CardHeader className="py-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Procurar por título ou pasta…" className="h-9 sm:w-72" />
            <Select value={status} onValueChange={(v) => setStatus(v as any)}>
              <SelectTrigger className="h-9 sm:w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os estados</SelectItem>
                {(Object.keys(KB_STATUS_LABELS) as KbStatus[]).map((k) => <SelectItem key={k} value={k}>{KB_STATUS_LABELS[k]}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={source} onValueChange={(v) => setSource(v as any)}>
              <SelectTrigger className="h-9 sm:w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas as origens</SelectItem>
                {(Object.keys(KB_SOURCE_LABELS) as KbSource[]).map((k) => <SelectItem key={k} value={k}>{KB_SOURCE_LABELS[k]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {list.isLoading ? <div className="p-6"><Loader2 className="h-5 w-5 animate-spin" /></div> : docs.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">Sem documentos. Carrega um ficheiro ou liga a sincronização das pastas do Drive nas definições.</p>
          ) : (
            <ul className="divide-y">
              {docs.map((d) => (
                <li key={d.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium" title={d.title}>{d.title}</p>
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <span>{KB_SOURCE_LABELS[d.source]}</span>
                      {d.folderPath && <span>· {d.folderPath}</span>}
                      <span className="inline-flex items-center gap-1">· <Shield className="h-3 w-3" /> {visibilityLabel(d.visibility, roleLabels)}</span>
                      {d.status === "synced" && <span>· {d.chunkCount} trechos{d.embedded ? " · IA" : ""}</span>}
                      <span>· {fmtWhen(d.syncedAt)}</span>
                    </p>
                    {d.error && d.status !== "synced" && <p className="truncate text-xs text-red-700" title={d.error}>{d.error}</p>}
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <Badge variant="outline" className={STATUS_STYLE[d.status]}>{KB_STATUS_LABELS[d.status]}</Badge>
                    <Button variant="ghost" size="icon" title="Pré-visualizar o texto" onClick={() => setPreview(d.id)}><Eye className="h-4 w-4" /></Button>
                    {d.source !== "help" && (
                      <>
                        <Button variant="ghost" size="icon" title="Visibilidade" onClick={() => setVisDoc(d)}><Shield className="h-4 w-4" /></Button>
                        {d.status === "skipped" ? (
                          <Button variant="ghost" size="icon" title="Voltar a incluir" onClick={() => include.mutate({ id: d.id })}><Undo2 className="h-4 w-4" /></Button>
                        ) : (
                          <Button variant="ghost" size="icon" title="Voltar a sincronizar" disabled={resync.isPending} onClick={() => resync.mutate({ id: d.id })}><RefreshCw className="h-4 w-4" /></Button>
                        )}
                        {d.status === "synced" && (
                          <Button variant="ghost" size="icon" title="Perguntas de quiz (rascunhos)" onClick={() => setQuizDoc(d)}><Sparkles className="h-4 w-4" /></Button>
                        )}
                        <Button
                          variant="ghost" size="icon" title={d.source === "upload" ? "Apagar" : "Excluir do índice"}
                          onClick={() => { if (confirm(d.source === "upload" ? `Apagar «${d.title}»?` : `Excluir «${d.title}» do índice? (o ficheiro fica no Drive)`)) remove.mutate({ id: d.id }); }}
                        ><Trash2 className="h-4 w-4 text-red-600" /></Button>
                      </>
                    )}
                    {d.source === "help" && <span title="A ajuda da app atualiza-se sozinha com cada versão"><HelpCircle className="h-4 w-4 text-muted-foreground" /></span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {preview != null && <PreviewDialog id={preview} onClose={() => setPreview(null)} />}
      {visDoc && <VisibilityDialog doc={visDoc} onClose={() => setVisDoc(null)} onSaved={refresh} />}
      {quizDoc && <QuizDialog doc={quizDoc} onClose={() => setQuizDoc(null)} />}
      {uploading && <UploadDialog onClose={() => setUploading(false)} onDone={refresh} />}
    </div>
  );
}
