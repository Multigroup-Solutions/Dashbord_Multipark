import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { trpc } from "@/lib/trpc";
import { fmtPTDate, fmtPTDateTime } from "@/lib/lisbonTime";
import { toast } from "sonner";
import { useState, useMemo, useEffect, useRef } from "react";
import { Play, BookOpen, HelpCircle, Gamepad2, GraduationCap, Plus, Trash2, Trophy, CheckCircle, XCircle, Clock, Star, ChevronRight, FileText, Newspaper, RefreshCw } from "lucide-react";
import { Streamdown } from "streamdown";

const ROLE_HIERARCHY: Record<string, number> = { user: 0, extra: 1, frontoffice: 2, backoffice: 3, team_leader: 4, supervisor: 5, admin: 6, super_admin: 7 };

export default function TrainingPage() {
  const { user } = useAuth();
  const isAdmin = user && ROLE_HIERARCHY[user.role] >= ROLE_HIERARCHY["admin"];

  return (
    <>
      <div className="p-6 space-y-6">
        <div>
          <p className="text-muted-foreground">Vídeos, manuais, FAQs, quiz interativo e exames de carreira</p>
        </div>
        <Tabs defaultValue="videos" className="space-y-4">
          <TabsList className="grid grid-cols-5 w-full max-w-2xl">
            <TabsTrigger value="videos"><Play className="w-4 h-4 mr-1" />Vídeos</TabsTrigger>
            <TabsTrigger value="manuals"><BookOpen className="w-4 h-4 mr-1" />Manuais</TabsTrigger>
            <TabsTrigger value="faqs"><HelpCircle className="w-4 h-4 mr-1" />FAQs</TabsTrigger>
            <TabsTrigger value="quiz"><Gamepad2 className="w-4 h-4 mr-1" />Quiz</TabsTrigger>
            <TabsTrigger value="career"><GraduationCap className="w-4 h-4 mr-1" />Carreira</TabsTrigger>
          </TabsList>

          <TabsContent value="videos"><VideosTab isAdmin={!!isAdmin} /></TabsContent>
          <TabsContent value="manuals"><ManualsTab isAdmin={!!isAdmin} /></TabsContent>
          <TabsContent value="faqs"><FAQsTab isAdmin={!!isAdmin} /></TabsContent>
          <TabsContent value="quiz"><QuizTab /></TabsContent>
          <TabsContent value="career"><CareerTab isAdmin={!!isAdmin} /></TabsContent>
        </Tabs>
      </div>
    </>
  );
}

// ─── VIDEOS TAB ─────────────────────────────────────────────────────────────
function VideosTab({ isAdmin }: { isAdmin: boolean }) {
  const [selectedCat, setSelectedCat] = useState<string>("all");
  const [showCreate, setShowCreate] = useState(false);
  const [showCreateCat, setShowCreateCat] = useState(false);
  const [form, setForm] = useState({ categoryId: "", title: "", description: "", videoUrl: "", durationMinutes: "" });
  const [catForm, setCatForm] = useState({ name: "", description: "", icon: "" });

  const { data: categories = [] } = trpc.training.categories.useQuery();
  const { data: videos = [], refetch } = trpc.training.videos.useQuery({ categoryId: selectedCat !== "all" ? Number(selectedCat) : undefined });
  const createVideo = trpc.training.createVideo.useMutation({ onSuccess: () => { refetch(); setShowCreate(false); toast.success("Vídeo adicionado"); } });
  const deleteVideo = trpc.training.deleteVideo.useMutation({ onSuccess: () => { refetch(); toast.success("Vídeo eliminado"); } });
  const createCat = trpc.training.createCategory.useMutation({ onSuccess: () => { trpc.useUtils().training.categories.invalidate(); setShowCreateCat(false); toast.success("Categoria criada"); } });
  const utils = trpc.useUtils();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Select value={selectedCat} onValueChange={setSelectedCat}>
            <SelectTrigger className="w-[200px]"><SelectValue placeholder="Categoria" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas</SelectItem>
              {categories.map((c: any) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
          {isAdmin && <Button variant="outline" size="sm" onClick={() => setShowCreateCat(true)}><Plus className="w-4 h-4 mr-1" />Categoria</Button>}
        </div>
        {isAdmin && <Button onClick={() => setShowCreate(true)}><Plus className="w-4 h-4 mr-1" />Novo Vídeo</Button>}
      </div>

      {videos.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-muted-foreground">Nenhum vídeo nesta categoria</CardContent></Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {videos.map((v: any) => (
            <Card key={v.id} className="overflow-hidden">
              <div className="aspect-video bg-muted flex items-center justify-center relative cursor-pointer" onClick={() => window.open(v.videoUrl, "_blank")}>
                {v.thumbnailUrl ? <img src={v.thumbnailUrl} alt={v.title} className="w-full h-full object-cover" /> : <Play className="w-12 h-12 text-muted-foreground" />}
                <div className="absolute inset-0 bg-black/30 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity">
                  <Play className="w-16 h-16 text-white" />
                </div>
              </div>
              <CardContent className="p-4">
                <h3 className="font-semibold">{v.title}</h3>
                {v.description && <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{v.description}</p>}
                <div className="flex items-center justify-between mt-2">
                  {v.durationMinutes && <Badge variant="secondary"><Clock className="w-3 h-3 mr-1" />{v.durationMinutes} min</Badge>}
                  {isAdmin && <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => deleteVideo.mutate({ id: v.id })}><Trash2 className="w-4 h-4" /></Button>}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader><DialogTitle>Novo Vídeo</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Categoria</Label>
              <Select value={form.categoryId} onValueChange={v => setForm(p => ({ ...p, categoryId: v }))}>
                <SelectTrigger><SelectValue placeholder="Selecionar" /></SelectTrigger>
                <SelectContent>{categories.map((c: any) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div><Label>Título</Label><Input value={form.title} onChange={e => setForm(p => ({ ...p, title: e.target.value }))} /></div>
            <div><Label>URL do Vídeo (YouTube, Vimeo, etc.)</Label><Input value={form.videoUrl} onChange={e => setForm(p => ({ ...p, videoUrl: e.target.value }))} placeholder="https://..." /></div>
            <div><Label>Descrição</Label><Textarea value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} /></div>
            <div><Label>Duração (min)</Label><Input type="number" value={form.durationMinutes} onChange={e => setForm(p => ({ ...p, durationMinutes: e.target.value }))} /></div>
            <Button className="w-full" disabled={!form.categoryId || !form.title || !form.videoUrl} onClick={() => createVideo.mutate({ categoryId: Number(form.categoryId), title: form.title, description: form.description || undefined, videoUrl: form.videoUrl, durationMinutes: form.durationMinutes ? Number(form.durationMinutes) : undefined })}>Guardar</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showCreateCat} onOpenChange={setShowCreateCat}>
        <DialogContent>
          <DialogHeader><DialogTitle>Nova Categoria</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Nome</Label><Input value={catForm.name} onChange={e => setCatForm(p => ({ ...p, name: e.target.value }))} /></div>
            <div><Label>Descrição</Label><Input value={catForm.description} onChange={e => setCatForm(p => ({ ...p, description: e.target.value }))} /></div>
            <Button className="w-full" disabled={!catForm.name} onClick={() => { createCat.mutate({ name: catForm.name, description: catForm.description || undefined }); utils.training.categories.invalidate(); }}>Criar</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── MANUALS TAB ────────────────────────────────────────────────────────────
function ManualsTab({ isAdmin }: { isAdmin: boolean }) {
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [showCreate, setShowCreate] = useState(false);
  const [selectedManual, setSelectedManual] = useState<any>(null);
  const [form, setForm] = useState({ title: "", content: "", type: "manual" as "manual" | "update" | "news" | "procedure" });
  const [uploadedFile, setUploadedFile] = useState<{ url: string; key: string; fileName: string; mimeType: string } | null>(null);
  const [uploading, setUploading] = useState(false);

  const { data: manuals = [], refetch } = trpc.training.manuals.useQuery({ type: typeFilter !== "all" ? typeFilter : undefined });
  const createManual = trpc.training.createManual.useMutation({ onSuccess: () => { refetch(); setShowCreate(false); setForm({ title: "", content: "", type: "manual" }); setUploadedFile(null); toast.success("Conteúdo criado"); } });
  const deleteManual = trpc.training.deleteManual.useMutation({ onSuccess: () => { refetch(); toast.success("Eliminado"); } });
  const uploadFile = trpc.training.uploadManualFile.useMutation();

  const typeLabels: Record<string, string> = { manual: "Manual", update: "Atualização", news: "Notícia", procedure: "Procedimento" };
  const typeIcons: Record<string, any> = { manual: BookOpen, update: RefreshCw, news: Newspaper, procedure: FileText };
  const typeColors: Record<string, string> = { manual: "bg-blue-100 text-blue-800", update: "bg-amber-100 text-amber-800", news: "bg-purple-100 text-purple-800", procedure: "bg-emerald-100 text-emerald-800" };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { toast.error("Ficheiro demasiado grande (máx 10MB)"); return; }
    setUploading(true);
    // O try/catch tem de envolver o await DENTRO do onload — um erro do upload
    // (rede, permissões, S3) deixava o spinner preso para sempre e o manual
    // gravava-se sem ficheiro, sem qualquer mensagem.
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const base64 = (reader.result as string).split(",")[1];
        const result = await uploadFile.mutateAsync({ fileName: file.name, fileBase64: base64, mimeType: file.type });
        setUploadedFile(result);
        toast.success("Ficheiro carregado");
      } catch (err: any) {
        toast.error(`Erro no upload: ${err?.message ?? "falha desconhecida"}`);
      } finally {
        setUploading(false);
      }
    };
    reader.onerror = () => { toast.error("Não foi possível ler o ficheiro"); setUploading(false); };
    reader.readAsDataURL(file);
  };

  const handleCreate = () => {
    createManual.mutate({
      ...form,
      ...(uploadedFile ? { fileUrl: uploadedFile.url, fileKey: uploadedFile.key, fileName: uploadedFile.fileName, fileMimeType: uploadedFile.mimeType } : {}),
    });
  };

  if (selectedManual) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => setSelectedManual(null)}>← Voltar</Button>
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <Badge className={typeColors[selectedManual.type] || "bg-gray-100 text-gray-800"}>{typeLabels[selectedManual.type] || selectedManual.type}</Badge>
              <CardTitle>{selectedManual.title}</CardTitle>
            </div>
            <p className="text-sm text-muted-foreground">{fmtPTDate(selectedManual.createdAt)}</p>
          </CardHeader>
          <CardContent className="space-y-4">
            {selectedManual.fileUrl && (
              <div className="border rounded-lg p-4 bg-muted/30">
                <div className="flex items-center gap-3">
                  <FileText className="w-8 h-8 text-primary" />
                  <div className="flex-1">
                    <p className="font-medium">{selectedManual.fileName || "Ficheiro anexo"}</p>
                    <p className="text-sm text-muted-foreground">{selectedManual.fileMimeType}</p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => window.open(selectedManual.fileUrl, "_blank")}>Abrir</Button>
                </div>
                {selectedManual.fileMimeType === "application/pdf" && (
                  <iframe src={selectedManual.fileUrl} className="w-full h-[500px] mt-3 rounded border" />
                )}
              </div>
            )}
            <div className="prose max-w-none">
              <Streamdown>{selectedManual.content}</Streamdown>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-[200px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            <SelectItem value="manual">Manuais</SelectItem>
            <SelectItem value="procedure">Procedimentos</SelectItem>
            <SelectItem value="update">Atualizações</SelectItem>
            <SelectItem value="news">Notícias</SelectItem>
          </SelectContent>
        </Select>
        {isAdmin && <Button onClick={() => setShowCreate(true)}><Plus className="w-4 h-4 mr-1" />Novo</Button>}
      </div>

      {manuals.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-muted-foreground">Nenhum conteúdo disponível</CardContent></Card>
      ) : (
        <div className="space-y-3">
          {manuals.map((m: any) => {
            const Icon = typeIcons[m.type] || FileText;
            return (
              <Card key={m.id} className="cursor-pointer hover:bg-accent/50 transition-colors" onClick={() => setSelectedManual(m)}>
                <CardContent className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Icon className="w-5 h-5 text-primary" />
                    <div>
                      <h3 className="font-semibold">{m.title}</h3>
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <span>{fmtPTDate(m.createdAt)}</span>
                        <Badge variant="outline" className="text-xs">{typeLabels[m.type] || m.type}</Badge>
                        {m.fileUrl && <Badge variant="secondary" className="text-xs">📎 Ficheiro</Badge>}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {isAdmin && <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={(e) => { e.stopPropagation(); deleteManual.mutate({ id: m.id }); }}><Trash2 className="w-4 h-4" /></Button>}
                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={showCreate} onOpenChange={(o) => { setShowCreate(o); if (!o) { setForm({ title: "", content: "", type: "manual" }); setUploadedFile(null); } }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Novo Conteúdo</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Tipo</Label>
              <Select value={form.type} onValueChange={v => setForm(p => ({ ...p, type: v as any }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">Manual</SelectItem>
                  <SelectItem value="procedure">Procedimento</SelectItem>
                  <SelectItem value="update">Atualização</SelectItem>
                  <SelectItem value="news">Notícia</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div><Label>Título</Label><Input value={form.title} onChange={e => setForm(p => ({ ...p, title: e.target.value }))} /></div>
            <div>
              <Label>Ficheiro (PDF, PPT, DOC — opcional)</Label>
              <Input type="file" accept=".pdf,.ppt,.pptx,.doc,.docx,.xls,.xlsx" onChange={handleFileUpload} disabled={uploading} />
              {uploading && <p className="text-sm text-muted-foreground mt-1">A carregar...</p>}
              {uploadedFile && (
                <div className="flex items-center gap-2 mt-2 p-2 bg-muted rounded">
                  <FileText className="w-4 h-4" />
                  <span className="text-sm">{uploadedFile.fileName}</span>
                  <Button variant="ghost" size="icon" className="h-6 w-6 ml-auto" onClick={() => setUploadedFile(null)}><XCircle className="w-4 h-4" /></Button>
                </div>
              )}
            </div>
            <div><Label>Conteúdo / Descrição (Markdown)</Label><Textarea rows={8} value={form.content} onChange={e => setForm(p => ({ ...p, content: e.target.value }))} placeholder="Escreve em Markdown..." /></div>
            <Button className="w-full" disabled={!form.title || (!form.content && !uploadedFile) || createManual.isPending} onClick={handleCreate}>
              {createManual.isPending ? "A publicar..." : "Publicar"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── FAQS TAB ───────────────────────────────────────────────────────────────
function FAQsTab({ isAdmin }: { isAdmin: boolean }) {
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ question: "", answer: "" });
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data: faqsList = [], refetch } = trpc.training.faqs.useQuery({});
  const createFAQMut = trpc.training.createFAQ.useMutation({ onSuccess: () => { refetch(); setShowCreate(false); setForm({ question: "", answer: "" }); toast.success("FAQ adicionada"); } });
  const deleteFAQMut = trpc.training.deleteFAQ.useMutation({ onSuccess: () => { refetch(); toast.success("FAQ eliminada"); } });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        {isAdmin && <Button onClick={() => setShowCreate(true)}><Plus className="w-4 h-4 mr-1" />Nova FAQ</Button>}
      </div>

      {faqsList.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-muted-foreground">Nenhuma FAQ disponível</CardContent></Card>
      ) : (
        <div className="space-y-2">
          {faqsList.map((f: any) => (
            <Card key={f.id} className="overflow-hidden">
              <CardContent className="p-0">
                <button className="w-full p-4 text-left flex items-center justify-between hover:bg-accent/50 transition-colors" onClick={() => setExpandedId(expandedId === f.id ? null : f.id)}>
                  <span className="font-medium flex items-center gap-2"><HelpCircle className="w-4 h-4 text-primary" />{f.question}</span>
                  <ChevronRight className={`w-4 h-4 transition-transform ${expandedId === f.id ? "rotate-90" : ""}`} />
                </button>
                {expandedId === f.id && (
                  <div className="px-4 pb-4 border-t">
                    <div className="pt-3 prose max-w-none text-sm"><Streamdown>{f.answer}</Streamdown></div>
                    {isAdmin && <Button variant="ghost" size="sm" className="mt-2 text-destructive" onClick={() => deleteFAQMut.mutate({ id: f.id })}><Trash2 className="w-3 h-3 mr-1" />Eliminar</Button>}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader><DialogTitle>Nova FAQ</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Pergunta</Label><Input value={form.question} onChange={e => setForm(p => ({ ...p, question: e.target.value }))} /></div>
            <div><Label>Resposta (Markdown)</Label><Textarea rows={6} value={form.answer} onChange={e => setForm(p => ({ ...p, answer: e.target.value }))} /></div>
            <Button className="w-full" disabled={!form.question || !form.answer} onClick={() => createFAQMut.mutate(form)}>Guardar</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── QUIZ TAB ───────────────────────────────────────────────────────────────
function QuizTab() {
  const { user } = useAuth();
  const isAdmin = user && ROLE_HIERARCHY[user.role] >= ROLE_HIERARCHY["admin"];
  const [playing, setPlaying] = useState(false);
  const [currentQ, setCurrentQ] = useState(0);
  const [answers, setAnswers] = useState<{ questionId: number; answer: "A" | "B" | "C" | "D" }[]>([]);
  // Snapshot baralhado das perguntas, congelado quando arranca o quiz —
  // evita re-shuffle se a query refetches a meio.
  const [shuffledQuestions, setShuffledQuestions] = useState<any[]>([]);
  const [result, setResult] = useState<any>(null);
  const [startTime, setStartTime] = useState<number>(() => Date.now());
  const [showCreate, setShowCreate] = useState(false);
  const [qForm, setQForm] = useState({ question: "", optionA: "", optionB: "", optionC: "", optionD: "", correctOption: "A" as "A" | "B" | "C" | "D", explanation: "", difficulty: "medium" as "easy" | "medium" | "hard", points: "10" });

  // Admin precisa de ver correctOption; jogador usa o endpoint que omite a resposta.
  const { data: adminQuestions = [], refetch: refetchAdmin } = trpc.training.quizQuestions.useQuery({}, { enabled: !!isAdmin });
  const { data: playerQuestions = [] } = trpc.training.quizQuestionsForPlayer.useQuery({});
  const questions = isAdmin ? adminQuestions : playerQuestions;
  const { data: ranking = [] } = trpc.training.quizRanking.useQuery();
  const { data: employees = [] } = trpc.rh.list.useQuery();
  const submitQuiz = trpc.training.submitQuiz.useMutation({ onSuccess: (data) => { setResult(data); setPlaying(false); } });
  const createQ = trpc.training.createQuizQuestion.useMutation({ onSuccess: () => { refetchAdmin(); setShowCreate(false); toast.success("Pergunta adicionada"); } });
  const deleteQ = trpc.training.deleteQuizQuestion.useMutation({ onSuccess: () => { refetchAdmin(); toast.success("Pergunta eliminada"); } });

  const employeeMap = useMemo(() => {
    const m = new Map<number, string>();
    employees.forEach((e: any) => {
      if (e.employee?.id) m.set(e.employee.id, e.employee.fullName);
    });
    return m;
  }, [employees]);

  const startQuiz = () => {
    if (playerQuestions.length === 0) return;
    const shuffled = [...playerQuestions].sort(() => Math.random() - 0.5).slice(0, 10);
    setShuffledQuestions(shuffled);
    setCurrentQ(0);
    setAnswers([]);
    setResult(null);
    setStartTime(Date.now());
    setPlaying(true);
  };

  if (result) {
    const pct = result.total > 0 ? Math.round((result.correct / result.total) * 100) : 0;
    return (
      <div className="max-w-lg mx-auto space-y-6">
        <Card>
          <CardContent className="p-8 text-center space-y-4">
            <Trophy className="w-16 h-16 mx-auto text-amber-500" />
            <h2 className="text-2xl font-bold">Resultado do Quiz</h2>
            <div className="text-4xl font-bold text-primary">{pct}%</div>
            <p className="text-muted-foreground">{result.correct} de {result.total} corretas · {result.score} pontos</p>
            <Progress value={pct} className="h-3" />
            <Button onClick={() => { setResult(null); setAnswers([]); setCurrentQ(0); }}>Tentar Novamente</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (playing && shuffledQuestions.length > 0) {
    const q = shuffledQuestions[currentQ];
    if (!q) return null;
    const options = [
      { key: "A" as const, text: q.optionA },
      { key: "B" as const, text: q.optionB },
      { key: "C" as const, text: q.optionC },
      { key: "D" as const, text: q.optionD },
    ];
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <Badge variant="secondary">Pergunta {currentQ + 1} de {shuffledQuestions.length}</Badge>
          <Badge variant="outline">{q.difficulty === "easy" ? "Fácil" : q.difficulty === "medium" ? "Médio" : "Difícil"} · {q.points} pts</Badge>
        </div>
        <Progress value={((currentQ) / shuffledQuestions.length) * 100} className="h-2" />
        <Card>
          <CardContent className="p-6 space-y-4">
            <h3 className="text-lg font-semibold">{q.question}</h3>
            <div className="grid grid-cols-1 gap-3">
              {options.map(o => (
                <Button key={o.key} variant="outline" className="justify-start text-left h-auto py-3 px-4" onClick={() => {
                  const newAnswers = [...answers, { questionId: q.id, answer: o.key }];
                  setAnswers(newAnswers);
                  if (currentQ + 1 < shuffledQuestions.length) {
                    setCurrentQ(currentQ + 1);
                  } else {
                    submitQuiz.mutate({ answers: newAnswers, timeSpentSeconds: Math.round((Date.now() - startTime) / 1000) });
                  }
                }}>
                  <span className="font-bold mr-3 text-primary">{o.key}.</span> {o.text}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardContent className="p-8 text-center space-y-4">
            <Gamepad2 className="w-16 h-16 mx-auto text-primary" />
            <h2 className="text-xl font-bold">Quiz Interativo</h2>
            <p className="text-muted-foreground">{playerQuestions.length} perguntas disponíveis. Responde a 10 perguntas aleatórias e ganha pontos!</p>
            <Button size="lg" disabled={playerQuestions.length === 0} onClick={startQuiz}>
              <Play className="w-4 h-4 mr-2" />Jogar
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Trophy className="w-5 h-5 text-amber-500" />Ranking</CardTitle></CardHeader>
          <CardContent>
            {ranking.length === 0 ? <p className="text-muted-foreground text-center py-4">Nenhuma tentativa ainda</p> : (
              <div className="space-y-2">
                {ranking.slice(0, 10).map((r: any, i: number) => (
                  <div key={r.employeeId} className="flex items-center justify-between p-2 rounded-lg bg-accent/30">
                    <div className="flex items-center gap-3">
                      <span className={`font-bold text-lg ${i === 0 ? "text-amber-500" : i === 1 ? "text-gray-400" : i === 2 ? "text-amber-700" : "text-muted-foreground"}`}>#{i + 1}</span>
                      <span className="font-medium">{employeeMap.get(r.employeeId) || `#${r.employeeId}`}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge variant="secondary">{r.totalScore} pts</Badge>
                      <span className="text-sm text-muted-foreground">{r.totalAttempts} jogos</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {isAdmin && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Gerir Perguntas ({questions.length})</CardTitle>
            <Button size="sm" onClick={() => setShowCreate(true)}><Plus className="w-4 h-4 mr-1" />Nova Pergunta</Button>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {questions.map((q: any) => (
                <div key={q.id} className="flex items-center justify-between p-3 border rounded-lg">
                  <div>
                    <p className="font-medium text-sm">{q.question}</p>
                    <div className="flex gap-2 mt-1">
                      <Badge variant="outline">{q.difficulty === "easy" ? "Fácil" : q.difficulty === "medium" ? "Médio" : "Difícil"}</Badge>
                      <Badge variant="secondary">{q.points} pts</Badge>
                      <Badge className="bg-green-100 text-green-800">Resp: {q.correctOption}</Badge>
                    </div>
                  </div>
                  <Button variant="ghost" size="icon" className="text-destructive" onClick={() => deleteQ.mutate({ id: q.id })}><Trash2 className="w-4 h-4" /></Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Nova Pergunta</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Pergunta</Label><Input value={qForm.question} onChange={e => setQForm(p => ({ ...p, question: e.target.value }))} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Opção A</Label><Input value={qForm.optionA} onChange={e => setQForm(p => ({ ...p, optionA: e.target.value }))} /></div>
              <div><Label>Opção B</Label><Input value={qForm.optionB} onChange={e => setQForm(p => ({ ...p, optionB: e.target.value }))} /></div>
              <div><Label>Opção C</Label><Input value={qForm.optionC} onChange={e => setQForm(p => ({ ...p, optionC: e.target.value }))} /></div>
              <div><Label>Opção D</Label><Input value={qForm.optionD} onChange={e => setQForm(p => ({ ...p, optionD: e.target.value }))} /></div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div><Label>Resposta Correta</Label>
                <Select value={qForm.correctOption} onValueChange={v => setQForm(p => ({ ...p, correctOption: v as any }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="A">A</SelectItem><SelectItem value="B">B</SelectItem><SelectItem value="C">C</SelectItem><SelectItem value="D">D</SelectItem></SelectContent>
                </Select>
              </div>
              <div><Label>Dificuldade</Label>
                <Select value={qForm.difficulty} onValueChange={v => setQForm(p => ({ ...p, difficulty: v as any }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="easy">Fácil</SelectItem><SelectItem value="medium">Médio</SelectItem><SelectItem value="hard">Difícil</SelectItem></SelectContent>
                </Select>
              </div>
              <div><Label>Pontos</Label><Input type="number" value={qForm.points} onChange={e => setQForm(p => ({ ...p, points: e.target.value }))} /></div>
            </div>
            <div><Label>Explicação (opcional)</Label><Textarea value={qForm.explanation} onChange={e => setQForm(p => ({ ...p, explanation: e.target.value }))} /></div>
            <Button className="w-full" disabled={!qForm.question || !qForm.optionA || !qForm.optionB || !qForm.optionC || !qForm.optionD} onClick={() => createQ.mutate({ ...qForm, points: Number(qForm.points) || 10, explanation: qForm.explanation || undefined })}>Guardar</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── CAREER TAB ─────────────────────────────────────────────────────────────
function CareerTab({ isAdmin }: { isAdmin: boolean }) {
  const [selectedExam, setSelectedExam] = useState<any>(null);
  const [taking, setTaking] = useState(false);
  const [currentQ, setCurrentQ] = useState(0);
  const [answers, setAnswers] = useState<{ questionId: number; answer: "A" | "B" | "C" | "D" }[]>([]);
  const [examResult, setExamResult] = useState<any>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showAddQ, setShowAddQ] = useState(false);
  const [startTime, setStartTime] = useState(Date.now());
  const [examForm, setExamForm] = useState({ level: "extra" as any, title: "", description: "", passingScore: "70", timeLimitMinutes: "30" });
  const [qForm, setQForm] = useState({ question: "", optionA: "", optionB: "", optionC: "", optionD: "", correctOption: "A" as "A" | "B" | "C" | "D", explanation: "" });
  const { user } = useAuth();
  const isAdminLocal = user && ROLE_HIERARCHY[user.role] >= ROLE_HIERARCHY["admin"];

  // Snapshot das perguntas do exame em curso (evita refetch a meio)
  const [examQuestionsSnapshot, setExamQuestionsSnapshot] = useState<any[]>([]);
  // Countdown em segundos (null = sem limite)
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const timeoutFiredRef = useRef(false);

  const { data: exams = [], refetch } = trpc.training.careerExams.useQuery();
  // Admin vê correctOption (para gerir); jogador usa endpoint que omite
  const { data: examQuestionsAdmin = [], refetch: refetchQ } = trpc.training.careerExamQuestions.useQuery(
    { examId: selectedExam?.id || 0 },
    { enabled: !!selectedExam && !!isAdminLocal },
  );
  const { data: examQuestionsPlayer = [] } = trpc.training.careerExamQuestionsForPlayer.useQuery(
    { examId: selectedExam?.id || 0 },
    { enabled: !!selectedExam },
  );
  const examQuestions = isAdminLocal ? examQuestionsAdmin : examQuestionsPlayer;
  const { data: myAttempts = [] } = trpc.training.myCareerExamAttempts.useQuery();
  const createExam = trpc.training.createCareerExam.useMutation({ onSuccess: () => { refetch(); setShowCreate(false); toast.success("Exame criado"); } });
  const createExamQ = trpc.training.createCareerExamQuestion.useMutation({ onSuccess: () => { refetchQ(); setShowAddQ(false); toast.success("Pergunta adicionada"); } });
  const submitExam = trpc.training.submitCareerExam.useMutation({ onSuccess: (data) => { setExamResult(data); setTaking(false); setRemainingSeconds(null); } });
  const deleteExam = trpc.training.deleteCareerExam.useMutation({ onSuccess: () => { refetch(); setSelectedExam(null); toast.success("Exame eliminado"); } });

  // Tick do countdown
  useEffect(() => {
    if (!taking || remainingSeconds == null) return;
    if (remainingSeconds <= 0) {
      if (!timeoutFiredRef.current) {
        timeoutFiredRef.current = true;
        toast.error("Tempo esgotado — a submeter respostas dadas");
        submitExam.mutate({
          examId: selectedExam.id,
          answers,
          timeSpentSeconds: Math.round((Date.now() - startTime) / 1000),
        });
      }
      return;
    }
    const t = setTimeout(() => setRemainingSeconds(remainingSeconds - 1), 1000);
    return () => clearTimeout(t);
  }, [taking, remainingSeconds]);

  const startExam = () => {
    if (examQuestionsPlayer.length === 0) return;
    setExamQuestionsSnapshot(examQuestionsPlayer);
    setTaking(true);
    setCurrentQ(0);
    setAnswers([]);
    setStartTime(Date.now());
    timeoutFiredRef.current = false;
    if (selectedExam?.timeLimitMinutes) {
      setRemainingSeconds(selectedExam.timeLimitMinutes * 60);
    } else {
      setRemainingSeconds(null);
    }
  };

  const levelLabels: Record<string, string> = { extra: "Extra", condutor: "Condutor", senior: "Sénior", team_leader: "Team Leader", supervisor: "Supervisor" };
  const levelColors: Record<string, string> = { extra: "bg-gray-100 text-gray-800", condutor: "bg-blue-100 text-blue-800", senior: "bg-green-100 text-green-800", team_leader: "bg-purple-100 text-purple-800", supervisor: "bg-amber-100 text-amber-800" };

  if (examResult) {
    return (
      <div className="max-w-lg mx-auto space-y-6">
        <Card>
          <CardContent className="p-8 text-center space-y-4">
            {examResult.passed ? <CheckCircle className="w-16 h-16 mx-auto text-green-500" /> : <XCircle className="w-16 h-16 mx-auto text-red-500" />}
            <h2 className="text-2xl font-bold">{examResult.passed ? "Aprovado!" : "Reprovado"}</h2>
            <div className="text-4xl font-bold">{examResult.score}%</div>
            <p className="text-muted-foreground">{examResult.correct} de {examResult.total} corretas · Mínimo: {examResult.passingScore}%</p>
            <Progress value={examResult.score} className="h-3" />
            {examResult.passed ? <p className="text-green-600 font-medium">Parabéns! Estás pronto para avançar na carreira.</p> : <p className="text-red-600">Não desistas! Estuda mais e tenta novamente.</p>}
            <Button onClick={() => { setExamResult(null); setSelectedExam(null); }}>Voltar</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (taking && examQuestionsSnapshot.length > 0) {
    const q = examQuestionsSnapshot[currentQ];
    if (!q) return null;
    const options = [
      { key: "A" as const, text: q.optionA },
      { key: "B" as const, text: q.optionB },
      { key: "C" as const, text: q.optionC },
      { key: "D" as const, text: q.optionD },
    ];
    const timerColor = remainingSeconds == null
      ? "bg-gray-100 text-gray-800"
      : remainingSeconds <= 60
        ? "bg-red-100 text-red-700"
        : remainingSeconds <= 300
          ? "bg-amber-100 text-amber-700"
          : "bg-blue-100 text-blue-700";
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Badge className={levelColors[selectedExam?.level] || ""}>{levelLabels[selectedExam?.level] || ""}</Badge>
            <Badge variant="secondary">Pergunta {currentQ + 1} de {examQuestionsSnapshot.length}</Badge>
          </div>
          {remainingSeconds != null && (
            <Badge className={timerColor}>
              <Clock className="w-3 h-3 mr-1" />
              {Math.floor(remainingSeconds / 60)}:{String(remainingSeconds % 60).padStart(2, "0")}
            </Badge>
          )}
        </div>
        <Progress value={((currentQ) / examQuestionsSnapshot.length) * 100} className="h-2" />
        <Card>
          <CardContent className="p-6 space-y-4">
            <h3 className="text-lg font-semibold">{q.question}</h3>
            <div className="grid grid-cols-1 gap-3">
              {options.map(o => (
                <Button key={o.key} variant="outline" className="justify-start text-left h-auto py-3 px-4" onClick={() => {
                  const newAnswers = [...answers, { questionId: q.id, answer: o.key }];
                  setAnswers(newAnswers);
                  if (currentQ + 1 < examQuestionsSnapshot.length) {
                    setCurrentQ(currentQ + 1);
                  } else {
                    submitExam.mutate({ examId: selectedExam.id, answers: newAnswers, timeSpentSeconds: Math.round((Date.now() - startTime) / 1000) });
                  }
                }}>
                  <span className="font-bold mr-3 text-primary">{o.key}.</span> {o.text}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (selectedExam) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => setSelectedExam(null)}>← Voltar</Button>
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Badge className={levelColors[selectedExam.level] || ""}>{levelLabels[selectedExam.level] || selectedExam.level}</Badge>
                <CardTitle>{selectedExam.title}</CardTitle>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline">Mínimo: {selectedExam.passingScore}%</Badge>
                {selectedExam.timeLimitMinutes && <Badge variant="outline"><Clock className="w-3 h-3 mr-1" />{selectedExam.timeLimitMinutes} min</Badge>}
              </div>
            </div>
            {selectedExam.description && <p className="text-muted-foreground mt-2">{selectedExam.description}</p>}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3 flex-wrap">
              <Button size="lg" disabled={examQuestionsPlayer.length === 0} onClick={startExam}>
                <GraduationCap className="w-4 h-4 mr-2" />Iniciar Exame ({examQuestionsPlayer.length} perguntas)
              </Button>
              {isAdmin && <Button variant="outline" onClick={() => setShowAddQ(true)}><Plus className="w-4 h-4 mr-1" />Adicionar Pergunta</Button>}
              {isAdmin && <Button variant="destructive" size="sm" onClick={() => deleteExam.mutate({ id: selectedExam.id })}><Trash2 className="w-4 h-4 mr-1" />Eliminar Exame</Button>}
            </div>

            {/* Histórico das minhas tentativas neste exame */}
            {(() => {
              const minhas = myAttempts.filter((a: any) => a.examId === selectedExam.id);
              if (minhas.length === 0) return null;
              return (
                <div className="border rounded-md p-3 bg-muted/30">
                  <p className="text-xs text-muted-foreground mb-2">As tuas tentativas anteriores</p>
                  <div className="flex flex-wrap gap-2">
                    {minhas.slice(0, 5).map((a: any) => (
                      <Badge key={a.id} className={a.passed ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}>
                        {a.score}% {a.passed ? "✓" : "✗"} · {fmtPTDate(a.createdAt)}
                      </Badge>
                    ))}
                  </div>
                </div>
              );
            })()}
            {isAdmin && examQuestions.length > 0 && (
              <div className="space-y-2 mt-4">
                <h4 className="font-semibold text-sm text-muted-foreground">Perguntas ({examQuestions.length})</h4>
                {examQuestions.map((q: any, i: number) => (
                  <div key={q.id} className="p-3 border rounded-lg text-sm">
                    <span className="font-medium">{i + 1}. {q.question}</span>
                    <div className="flex gap-2 mt-1">
                      <Badge variant="outline" className="text-xs">A: {q.optionA}</Badge>
                      <Badge variant="outline" className="text-xs">B: {q.optionB}</Badge>
                      <Badge variant="outline" className="text-xs">C: {q.optionC}</Badge>
                      <Badge variant="outline" className="text-xs">D: {q.optionD}</Badge>
                      <Badge className="bg-green-100 text-green-800 text-xs">✓ {q.correctOption}</Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Dialog open={showAddQ} onOpenChange={setShowAddQ}>
          <DialogContent className="max-w-2xl">
            <DialogHeader><DialogTitle>Nova Pergunta do Exame</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>Pergunta</Label><Input value={qForm.question} onChange={e => setQForm(p => ({ ...p, question: e.target.value }))} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Opção A</Label><Input value={qForm.optionA} onChange={e => setQForm(p => ({ ...p, optionA: e.target.value }))} /></div>
                <div><Label>Opção B</Label><Input value={qForm.optionB} onChange={e => setQForm(p => ({ ...p, optionB: e.target.value }))} /></div>
                <div><Label>Opção C</Label><Input value={qForm.optionC} onChange={e => setQForm(p => ({ ...p, optionC: e.target.value }))} /></div>
                <div><Label>Opção D</Label><Input value={qForm.optionD} onChange={e => setQForm(p => ({ ...p, optionD: e.target.value }))} /></div>
              </div>
              <div><Label>Resposta Correta</Label>
                <Select value={qForm.correctOption} onValueChange={v => setQForm(p => ({ ...p, correctOption: v as any }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="A">A</SelectItem><SelectItem value="B">B</SelectItem><SelectItem value="C">C</SelectItem><SelectItem value="D">D</SelectItem></SelectContent>
                </Select>
              </div>
              <div><Label>Explicação (opcional)</Label><Textarea value={qForm.explanation} onChange={e => setQForm(p => ({ ...p, explanation: e.target.value }))} /></div>
              <Button className="w-full" disabled={!qForm.question || !qForm.optionA || !qForm.optionB || !qForm.optionC || !qForm.optionD} onClick={() => createExamQ.mutate({ examId: selectedExam.id, ...qForm, explanation: qForm.explanation || undefined })}>Guardar</Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2"><GraduationCap className="w-5 h-5" />Evolução de Carreira</h2>
          <p className="text-muted-foreground">Passa os exames para avançar na tua carreira</p>
        </div>
        {isAdmin && <Button onClick={() => setShowCreate(true)}><Plus className="w-4 h-4 mr-1" />Novo Exame</Button>}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {["extra", "condutor", "senior", "team_leader", "supervisor"].map(level => {
          const levelExams = exams.filter((e: any) => e.level === level);
          return (
            <Card key={level} className="overflow-hidden">
              <div className={`h-2 ${level === "extra" ? "bg-gray-400" : level === "condutor" ? "bg-blue-500" : level === "senior" ? "bg-green-500" : level === "team_leader" ? "bg-purple-500" : "bg-amber-500"}`} />
              <CardContent className="p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-lg">{levelLabels[level]}</h3>
                  <Badge variant="outline">{level === "extra" || level === "condutor" ? "≥70%" : level === "senior" ? "≥80%" : "≥90%"}</Badge>
                </div>
                {levelExams.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nenhum exame configurado</p>
                ) : (
                  levelExams.map((e: any) => (
                    <Button key={e.id} variant="outline" className="w-full justify-start" onClick={() => setSelectedExam(e)}>
                      <Star className="w-4 h-4 mr-2" />{e.title}
                    </Button>
                  ))
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader><DialogTitle>Novo Exame de Carreira</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Nível</Label>
              <Select value={examForm.level} onValueChange={v => setExamForm(p => ({ ...p, level: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="extra">Extra</SelectItem>
                  <SelectItem value="condutor">Condutor</SelectItem>
                  <SelectItem value="senior">Sénior</SelectItem>
                  <SelectItem value="team_leader">Team Leader</SelectItem>
                  <SelectItem value="supervisor">Supervisor</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div><Label>Título</Label><Input value={examForm.title} onChange={e => setExamForm(p => ({ ...p, title: e.target.value }))} /></div>
            <div><Label>Descrição</Label><Textarea value={examForm.description} onChange={e => setExamForm(p => ({ ...p, description: e.target.value }))} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Nota Mínima (%)</Label><Input type="number" value={examForm.passingScore} onChange={e => setExamForm(p => ({ ...p, passingScore: e.target.value }))} /></div>
              <div><Label>Tempo Limite (min)</Label><Input type="number" value={examForm.timeLimitMinutes} onChange={e => setExamForm(p => ({ ...p, timeLimitMinutes: e.target.value }))} /></div>
            </div>
            <Button className="w-full" disabled={!examForm.title} onClick={() => createExam.mutate({ ...examForm, passingScore: Number(examForm.passingScore) || 70, timeLimitMinutes: Number(examForm.timeLimitMinutes) || 30 })}>Criar Exame</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
