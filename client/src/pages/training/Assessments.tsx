import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { trpc } from "@/lib/trpc";
import { fmtPTDate } from "@/lib/lisbonTime";
import { toast } from "sonner";
import { Award, BookOpen, CheckCircle, Clock, Download, Eye, Gamepad2, GraduationCap, Pencil, Play, Plus, Settings, Star, Trash2, Trophy, XCircle } from "lucide-react";
import {
  ALL_CAREER_LEVELS, AnswerReview, CAREER_LEVEL_COLORS, CAREER_LEVEL_LABELS, CAREER_TRACKS, QuestionDialog, emptyQuestion,
  questionFrom, useConfirm, useOpenManualFile, type QuestionFormValue,
} from "./shared";
import { QuizTutorReview, TutorPanel } from "./TutorPanel";

type Answer = { questionId: number; answer: "A" | "B" | "C" | "D" };
type Session = { sessionId: number; questions: any[]; timeLimitSeconds: number | null; attemptsLeft: number };

/** Jogo de perguntas (quiz ou exame): uma pergunta de cada vez, submete no fim. */
function QuestionRunner({ session, header, pending, onSubmit, remainingSeconds }: {
  session: Session; header?: React.ReactNode; pending: boolean; remainingSeconds: number | null;
  onSubmit: (answers: Answer[]) => void;
}) {
  const [currentQ, setCurrentQ] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const q = session.questions[currentQ];
  if (!q) return null;
  const options = (["A", "B", "C", "D"] as const).map((k) => ({ key: k, text: q[`option${k}`] }));
  const timerColor = remainingSeconds == null ? "" : remainingSeconds <= 60 ? "bg-red-100 text-red-700" : remainingSeconds <= 300 ? "bg-amber-100 text-amber-700" : "bg-blue-100 text-blue-700";
  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          {header}
          <Badge variant="secondary">Pergunta {currentQ + 1} de {session.questions.length}</Badge>
          {q.difficulty && <Badge variant="outline">{q.difficulty === "easy" ? "Fácil" : q.difficulty === "medium" ? "Médio" : "Difícil"} · {q.points} pts</Badge>}
        </div>
        {remainingSeconds != null && (
          <Badge className={timerColor}><Clock className="w-3 h-3 mr-1" />{Math.floor(remainingSeconds / 60)}:{String(remainingSeconds % 60).padStart(2, "0")}</Badge>
        )}
      </div>
      <Progress value={(currentQ / session.questions.length) * 100} className="h-2" />
      <Card>
        <CardContent className="p-6 space-y-4">
          <h3 className="text-lg font-semibold">{q.question}</h3>
          <div className="grid grid-cols-1 gap-3">
            {options.map((o) => (
              <Button key={o.key} disabled={pending || remainingSeconds === 0} variant="outline" className="justify-start text-left h-auto whitespace-normal break-words py-3 px-4" onClick={() => {
                const next = [...answers.filter((a) => a.questionId !== q.id), { questionId: q.id, answer: o.key }];
                setAnswers(next);
                answersRef.set(session.sessionId, next);
                if (currentQ + 1 < session.questions.length) setCurrentQ(currentQ + 1);
                else onSubmit(next);
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
/** Respostas dadas até agora (para a submissão automática quando o tempo acaba). */
const answersRef = new Map<number, Answer[]>();

// ─── QUIZ ──────────────────────────────────────────────────────────────────

export function QuizTab({ isAdmin }: { isAdmin: boolean }) {
  const utils = trpc.useUtils();
  const [session, setSession] = useState<Session | null>(null);
  const [result, setResult] = useState<any>(null);
  const [editing, setEditing] = useState<{ id: number | null; value: QuestionFormValue } | null>(null);
  const [onlyDrafts, setOnlyDrafts] = useState(false);
  const [confirm, confirmUi] = useConfirm();

  const { data: info, isLoading: infoLoading, error: infoError } = trpc.training.quizInfo.useQuery({});
  const { data: ranking = [] } = trpc.training.quizRanking.useQuery();
  const rankedIds = useMemo(() => (ranking as any[]).slice(0, 10).map((r) => r.employeeId), [ranking]);
  const { data: names = [] } = trpc.training.rankingNames.useQuery({ employeeIds: rankedIds }, { enabled: rankedIds.length > 0 });
  const nameMap = useMemo(() => new Map((names as any[]).map((n) => [n.id, n.name])), [names]);
  const { data: adminQuestions = [], refetch: refetchAdmin } = trpc.training.quizQuestions.useQuery({}, { enabled: isAdmin });
  const onErr = (e: { message: string }) => toast.error(e.message);
  const start = trpc.training.startQuiz.useMutation({ onSuccess: (s) => { setResult(null); setSession(s); }, onError: onErr });
  const submit = trpc.training.submitQuiz.useMutation({
    onSuccess: (r, vars) => { setResult({ ...r, sessionId: vars.sessionId, answers: vars.answers }); setSession(null); void utils.training.quizRanking.invalidate(); void utils.training.myTraining.invalidate(); },
    onError: onErr,
  });
  const afterSave = () => { refetchAdmin(); setEditing(null); void utils.training.quizInfo.invalidate(); };
  const createQ = trpc.training.createQuizQuestion.useMutation({ onSuccess: () => { afterSave(); toast.success("Pergunta adicionada"); }, onError: onErr });
  const updateQ = trpc.training.updateQuizQuestion.useMutation({ onSuccess: () => { afterSave(); toast.success("Pergunta atualizada"); }, onError: onErr });
  const deleteQ = trpc.training.deleteQuizQuestion.useMutation({ onSuccess: () => { afterSave(); toast.success("Pergunta eliminada"); }, onError: onErr });

  const questions = (adminQuestions as any[]).filter((q) => !onlyDrafts || q.published === 0);
  const drafts = (adminQuestions as any[]).filter((q) => q.published === 0).length;

  if (result) {
    const pct = result.percentage ?? 0;
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <Card>
          <CardContent className="p-8 text-center space-y-4">
            <Trophy className="w-16 h-16 mx-auto text-amber-500" />
            <h2 className="text-2xl font-bold">Resultado do Quiz</h2>
            <div className="text-4xl font-bold text-primary">{pct}%</div>
            <p className="text-muted-foreground">{result.correct} de {result.total} corretas · {result.score} pontos</p>
            <Progress value={pct} className="h-3" />
            <div className="flex justify-center gap-2">
              <Button variant="outline" onClick={() => setResult(null)}>Voltar</Button>
              <Button disabled={start.isPending} onClick={() => start.mutate({})}><Play className="w-4 h-4 mr-1" />Tentar novamente</Button>
            </div>
          </CardContent>
        </Card>
        {result.correct < result.total && <QuizTutorReview sessionId={result.sessionId} answers={result.answers} />}
        <AnswerReview review={result.review} />
        <TutorPanel context={{ type: "quiz", id: 0 }} defaultOpen={false} />
      </div>
    );
  }

  if (session) {
    return <QuestionRunner key={session.sessionId} session={session} pending={submit.isPending} remainingSeconds={null} onSubmit={(answers) => submit.mutate({ sessionId: session.sessionId, answers })} />;
  }

  return (
    <div className="space-y-6">
      {confirmUi}
      <TutorPanel context={{ type: "quiz", id: 0 }} title="Tutor — dicas antes do quiz" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardContent className="p-8 text-center space-y-4">
            <Gamepad2 className="w-16 h-16 mx-auto text-primary" />
            <h2 className="text-xl font-bold">Quiz Interativo</h2>
            <p className="text-muted-foreground">{info?.published ?? 0} perguntas disponíveis. Responde a {info?.perGame ?? 10} perguntas aleatórias e ganha pontos! (máx. {info?.maxPerDay ?? 5} jogos por dia)</p>
            {infoLoading && <p>A carregar perguntas…</p>}
            {infoError && <p className="text-destructive">Não foi possível carregar as perguntas. Tenta atualizar a página.</p>}
            <Button size="lg" disabled={infoLoading || !!infoError || !info?.published || start.isPending} onClick={() => start.mutate({})}>
              <Play className="w-4 h-4 mr-2" />Jogar
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Trophy className="w-5 h-5 text-amber-500" />Ranking (melhor pontuação)</CardTitle></CardHeader>
          <CardContent>
            {ranking.length === 0 ? <p className="text-muted-foreground text-center py-4">Nenhuma tentativa ainda</p> : (
              <div className="space-y-2">
                {(ranking as any[]).slice(0, 10).map((r, i) => (
                  <div key={r.employeeId} className="flex items-center justify-between p-2 rounded-lg bg-accent/30 gap-2">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className={`font-bold text-lg ${i === 0 ? "text-amber-500" : i === 1 ? "text-gray-400" : i === 2 ? "text-amber-700" : "text-muted-foreground"}`}>#{i + 1}</span>
                      <span className="font-medium truncate">{nameMap.get(r.employeeId) ?? r.name ?? "—"}</span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <Badge variant="secondary">{r.bestScore} pts</Badge>
                      <span className="text-sm text-muted-foreground">{r.attempts} jogos</span>
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
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle>Gerir perguntas ({adminQuestions.length}{drafts ? ` · ${drafts} rascunho(s)` : ""})</CardTitle>
            <div className="flex gap-2">
              {drafts > 0 && <Button size="sm" variant={onlyDrafts ? "default" : "outline"} onClick={() => setOnlyDrafts((v) => !v)}>Só rascunhos</Button>}
              <Button size="sm" onClick={() => setEditing({ id: null, value: emptyQuestion() })}><Plus className="w-4 h-4 mr-1" />Nova pergunta</Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-[32rem] overflow-y-auto">
              {questions.map((q) => (
                <div key={q.id} className={`flex items-center justify-between gap-2 p-3 border rounded-lg ${q.published === 0 ? "border-dashed bg-amber-50/40" : ""}`}>
                  <div className="min-w-0">
                    <p className="font-medium text-sm">{q.question}</p>
                    <div className="flex flex-wrap gap-2 mt-1">
                      {q.published === 0 && <Badge className="bg-amber-100 text-amber-800">Rascunho{q.sourceManualId ? " (IA)" : ""}</Badge>}
                      <Badge variant="outline">{q.difficulty === "easy" ? "Fácil" : q.difficulty === "medium" ? "Médio" : "Difícil"}</Badge>
                      <Badge variant="secondary">{q.points} pts</Badge>
                      <Badge className="bg-green-100 text-green-800">Resp: {q.correctOption}</Badge>
                    </div>
                  </div>
                  <div className="flex shrink-0">
                    {q.published === 0 && <Button size="sm" variant="outline" disabled={updateQ.isPending} onClick={() => updateQ.mutate({ id: q.id, published: true })}><Eye className="w-4 h-4 mr-1" />Publicar</Button>}
                    <Button variant="ghost" size="icon" title="Editar" onClick={() => setEditing({ id: q.id, value: questionFrom(q) })}><Pencil className="w-4 h-4" /></Button>
                    <Button variant="ghost" size="icon" className="text-destructive" title="Eliminar" onClick={async () => {
                      if (await confirm({ title: "Eliminar esta pergunta?", description: q.question, confirmLabel: "Eliminar", destructive: true })) deleteQ.mutate({ id: q.id });
                    }}><Trash2 className="w-4 h-4" /></Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <QuestionDialog
        open={!!editing} onOpenChange={(o) => !o && setEditing(null)} withDifficulty
        title={editing?.id ? "Editar pergunta" : "Nova pergunta"} initial={editing?.value ?? emptyQuestion()} pending={createQ.isPending || updateQ.isPending}
        onSave={(v) => {
          const payload = { question: v.question, optionA: v.optionA, optionB: v.optionB, optionC: v.optionC, optionD: v.optionD, correctOption: v.correctOption, difficulty: v.difficulty ?? "medium", points: Number(v.points) || 10 };
          if (editing?.id) updateQ.mutate({ id: editing.id, ...payload, explanation: v.explanation || null });
          else createQ.mutate({ ...payload, explanation: v.explanation || undefined });
        }}
      />
    </div>
  );
}

// ─── CARREIRA ──────────────────────────────────────────────────────────────

export function CareerTab({ isAdmin, isSuperAdmin, certificates }: { isAdmin: boolean; isSuperAdmin: boolean; certificates: any[] }) {
  const utils = trpc.useUtils();
  const [selectedExam, setSelectedExam] = useState<any>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [examResult, setExamResult] = useState<any>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [settings, setSettings] = useState<any>(null);
  const [editingQ, setEditingQ] = useState<{ id: number | null; value: QuestionFormValue } | null>(null);
  const [examForm, setExamForm] = useState({ level: "condutor_1" as string, title: "", description: "", passingScore: "70", timeLimitMinutes: "30", validityMonths: "12", maxAttemptsPerDay: "3" });
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const deadlineRef = useRef<number | null>(null);
  const timeoutFiredRef = useRef(false);
  const [confirm, confirmUi] = useConfirm();
  const openManual = useOpenManualFile();

  const { data: exams = [], refetch, isLoading: examsLoading, error: examsError } = trpc.training.careerExams.useQuery();
  const { data: examQuestionsAdmin = [], refetch: refetchQ } = trpc.training.careerExamQuestions.useQuery({ examId: selectedExam?.id || 0 }, { enabled: !!selectedExam && isAdmin });
  const { data: myAttempts = [] } = trpc.training.myCareerExamAttempts.useQuery();
  const onErr = (e: { message: string }) => toast.error(e.message);
  const createExam = trpc.training.createCareerExam.useMutation({ onSuccess: () => { refetch(); setShowCreate(false); toast.success("Exame criado"); }, onError: onErr });
  const updateExam = trpc.training.updateCareerExam.useMutation({ onSuccess: () => { refetch(); setSettings(null); toast.success("Exame atualizado"); }, onError: onErr });
  const afterQ = () => { refetchQ(); refetch(); setEditingQ(null); };
  const createExamQ = trpc.training.createCareerExamQuestion.useMutation({ onSuccess: () => { afterQ(); toast.success("Pergunta adicionada"); }, onError: onErr });
  const updateExamQ = trpc.training.updateCareerExamQuestion.useMutation({ onSuccess: () => { afterQ(); toast.success("Pergunta atualizada"); }, onError: onErr });
  const deleteExamQ = trpc.training.deleteCareerExamQuestion.useMutation({ onSuccess: () => { afterQ(); toast.success("Pergunta eliminada"); }, onError: onErr });
  const deleteExam = trpc.training.deleteCareerExam.useMutation({ onSuccess: () => { refetch(); setSelectedExam(null); toast.success("Exame arquivado; resultados preservados"); }, onError: onErr });
  const certUrl = trpc.training.certificateUrl.useMutation({ onError: onErr });
  const start = trpc.training.startCareerExam.useMutation({
    onSuccess: (s) => {
      answersRef.delete(s.sessionId);
      timeoutFiredRef.current = false;
      deadlineRef.current = s.timeLimitSeconds ? Date.now() + s.timeLimitSeconds * 1000 : null;
      setRemainingSeconds(s.timeLimitSeconds ?? null);
      setSession(s);
    },
    onError: onErr,
  });
  const submit = trpc.training.submitCareerExam.useMutation({
    onSuccess: (r) => {
      setExamResult(r); setSession(null); setRemainingSeconds(null); deadlineRef.current = null;
      void utils.training.myCareerExamAttempts.invalidate(); void utils.training.myTraining.invalidate();
    },
    onError: onErr,
  });

  // Countdown (o servidor é que manda: prazo + 30s de tolerância)
  useEffect(() => {
    if (!session || deadlineRef.current == null) return;
    const t = setInterval(() => {
      const left = Math.max(0, Math.round((deadlineRef.current! - Date.now()) / 1000));
      setRemainingSeconds(left);
      if (left <= 0 && !timeoutFiredRef.current) {
        timeoutFiredRef.current = true;
        toast.error("Tempo esgotado — a submeter as respostas dadas");
        submit.mutate({ sessionId: session.sessionId, answers: answersRef.get(session.sessionId) ?? [] });
      }
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.sessionId]);

  // Módulos do nível (manuais/vídeos etiquetados com o careerLevel do exame)
  const { data: allManuals = [] } = trpc.training.manuals.useQuery({}, { enabled: !!selectedExam });
  const { data: allVideos = [] } = trpc.training.videos.useQuery({}, { enabled: !!selectedExam });
  const levelModules = useMemo(() => {
    if (!selectedExam) return { manuals: [] as any[], videos: [] as any[] };
    return {
      manuals: (allManuals as any[]).filter((m) => m.careerLevel === selectedExam.level && m.published !== 0),
      videos: (allVideos as any[]).filter((v) => v.careerLevel === selectedExam.level),
    };
  }, [selectedExam, allManuals, allVideos]);

  const downloadCert = async (id: number) => {
    const w = window.open("about:blank", "_blank");
    try { const { url } = await certUrl.mutateAsync({ id }); if (w) w.location.href = url; else window.location.href = url; } catch { w?.close(); }
  };

  if (examsLoading) return <p className="text-muted-foreground">A carregar avaliações…</p>;
  if (examsError) return <div className="space-y-3"><p className="text-destructive">Não foi possível carregar as avaliações.</p><Button onClick={() => refetch()}>Tentar novamente</Button></div>;

  if (examResult) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <Card>
          <CardContent className="p-8 text-center space-y-4">
            {examResult.passed ? <CheckCircle className="w-16 h-16 mx-auto text-green-500" /> : <XCircle className="w-16 h-16 mx-auto text-red-500" />}
            <h2 className="text-2xl font-bold">{examResult.passed ? "Aprovado!" : examResult.expired ? "Tempo esgotado" : "Reprovado"}</h2>
            <div className="text-4xl font-bold">{examResult.score}%</div>
            <p className="text-muted-foreground">{examResult.correct} de {examResult.total} corretas · Mínimo: {examResult.passingScore}%</p>
            <Progress value={examResult.score} className="h-3" />
            {examResult.timedOut && <p className="text-amber-600 text-sm">O tempo acabou — as perguntas sem resposta contaram como erradas.</p>}
            {examResult.passed
              ? <p className="text-green-600 font-medium">Exame aprovado. A promoção fica pendente de aprovação da supervisão; o certificado aparece aqui quando for aprovada.</p>
              : <p className="text-red-600">Não desistas! Estuda os módulos do nível e tenta novamente.</p>}
            <Button onClick={() => { setExamResult(null); setSelectedExam(null); }}>Voltar</Button>
          </CardContent>
        </Card>
        <AnswerReview review={examResult.review} />
      </div>
    );
  }

  if (session && selectedExam) {
    return (
      <div className="space-y-3">
        {submit.isError && <div className="max-w-2xl mx-auto"><Button disabled={submit.isPending} onClick={() => submit.mutate({ sessionId: session.sessionId, answers: answersRef.get(session.sessionId) ?? [] })}>Voltar a enviar respostas</Button></div>}
        <QuestionRunner
          key={session.sessionId}
          session={session} pending={submit.isPending} remainingSeconds={remainingSeconds}
          header={<Badge className={CAREER_LEVEL_COLORS[selectedExam.level] || ""}>{CAREER_LEVEL_LABELS[selectedExam.level] || ""}</Badge>}
          onSubmit={(answers) => submit.mutate({ sessionId: session.sessionId, answers })}
        />
      </div>
    );
  }

  const examDialogs = (
    <>
      <QuestionDialog
        open={!!editingQ} onOpenChange={(o) => !o && setEditingQ(null)} title={editingQ?.id ? "Editar pergunta do exame" : "Nova pergunta do exame"}
        initial={editingQ?.value ?? emptyQuestion()} pending={createExamQ.isPending || updateExamQ.isPending}
        onSave={(v) => {
          const payload = { question: v.question, optionA: v.optionA, optionB: v.optionB, optionC: v.optionC, optionD: v.optionD, correctOption: v.correctOption, points: Number(v.points) || 10 };
          if (editingQ?.id) updateExamQ.mutate({ id: editingQ.id, ...payload, explanation: v.explanation || null });
          else createExamQ.mutate({ examId: selectedExam.id, ...payload, explanation: v.explanation || undefined });
        }}
      />
      <Dialog open={!!settings} onOpenChange={(o) => !o && setSettings(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Definições do exame</DialogTitle></DialogHeader>
          {settings && (
            <div className="space-y-3">
              <div><Label>Título</Label><Input value={settings.title} onChange={(e) => setSettings((p: any) => ({ ...p, title: e.target.value }))} /></div>
              <div><Label>Descrição</Label><Textarea value={settings.description} onChange={(e) => setSettings((p: any) => ({ ...p, description: e.target.value }))} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Nota mínima (%)</Label><Input type="number" value={settings.passingScore} onChange={(e) => setSettings((p: any) => ({ ...p, passingScore: e.target.value }))} /></div>
                <div><Label>Tempo limite (min)</Label><Input type="number" value={settings.timeLimitMinutes} onChange={(e) => setSettings((p: any) => ({ ...p, timeLimitMinutes: e.target.value }))} /></div>
                <div><Label>Validade do certificado (meses, 0 = sem prazo)</Label><Input type="number" value={settings.validityMonths} onChange={(e) => setSettings((p: any) => ({ ...p, validityMonths: e.target.value }))} /></div>
                <div><Label>Tentativas por dia</Label><Input type="number" value={settings.maxAttemptsPerDay} onChange={(e) => setSettings((p: any) => ({ ...p, maxAttemptsPerDay: e.target.value }))} /></div>
              </div>
              <Button className="w-full" disabled={!settings.title || updateExam.isPending} onClick={() => updateExam.mutate({
                id: settings.id, title: settings.title, description: settings.description || null, passingScore: Math.max(1, Math.min(100, Number(settings.passingScore) || 70)),
                timeLimitMinutes: Number(settings.timeLimitMinutes) || null, validityMonths: Math.max(0, Number(settings.validityMonths) || 0), maxAttemptsPerDay: Math.max(1, Number(settings.maxAttemptsPerDay) || 3),
              })}>Guardar</Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );

  if (selectedExam) {
    const exam = (exams as any[]).find((e) => e.id === selectedExam.id) ?? selectedExam;
    const mine = (myAttempts as any[]).filter((a) => a.examId === exam.id);
    return (
      <div className="space-y-4">
        {confirmUi}{examDialogs}
        <Button variant="ghost" onClick={() => setSelectedExam(null)}>← Voltar</Button>
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-3">
                <Badge className={CAREER_LEVEL_COLORS[exam.level] || ""}>{CAREER_LEVEL_LABELS[exam.level] || exam.level}</Badge>
                <CardTitle>{exam.title}</CardTitle>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">Mínimo: {exam.passingScore}%</Badge>
                {exam.timeLimitMinutes && <Badge variant="outline"><Clock className="w-3 h-3 mr-1" />{exam.timeLimitMinutes} min</Badge>}
                <Badge variant="outline">{exam.maxAttemptsPerDay ?? 3} tentativas/dia</Badge>
                <Badge variant="outline">Certificado: {exam.validityMonths ? `${exam.validityMonths} meses` : "sem prazo"}</Badge>
              </div>
            </div>
            {exam.description && <p className="text-muted-foreground mt-2">{exam.description}</p>}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3 flex-wrap">
              <Button size="lg" disabled={!exam.questionCount || start.isPending} onClick={() => start.mutate({ examId: exam.id })}>
                <GraduationCap className="w-4 h-4 mr-2" />Iniciar exame ({exam.questionCount ?? 0} perguntas)
              </Button>
              {isAdmin && <Button variant="outline" onClick={() => setEditingQ({ id: null, value: emptyQuestion() })}><Plus className="w-4 h-4 mr-1" />Adicionar pergunta</Button>}
              {isAdmin && <Button variant="outline" onClick={() => setSettings({ id: exam.id, title: exam.title, description: exam.description ?? "", passingScore: String(exam.passingScore), timeLimitMinutes: String(exam.timeLimitMinutes ?? ""), validityMonths: String(exam.validityMonths ?? 12), maxAttemptsPerDay: String(exam.maxAttemptsPerDay ?? 3) })}><Settings className="w-4 h-4 mr-1" />Definições</Button>}
              {isSuperAdmin && <Button variant="outline" size="sm" disabled={deleteExam.isPending} onClick={async () => {
                if (await confirm({ title: `Arquivar o exame "${exam.title}"?`, description: "Os resultados e certificados ficam preservados.", confirmLabel: "Arquivar", destructive: true })) deleteExam.mutate({ id: exam.id });
              }}><Trash2 className="w-4 h-4 mr-1" />Arquivar exame</Button>}
            </div>
            {exam.timeLimitMinutes ? <p className="text-xs text-muted-foreground">O tempo conta a partir do início e é controlado pelo servidor. Tens de responder a todas as perguntas.</p> : null}

            {(levelModules.manuals.length > 0 || levelModules.videos.length > 0) && (
              <div className="border rounded-md p-3 bg-blue-50/40 border-blue-200">
                <p className="text-xs font-semibold text-blue-800 mb-2 flex items-center gap-1.5"><BookOpen className="w-3.5 h-3.5" /> Módulos de estudo deste nível — lê antes do exame</p>
                <div className="flex flex-wrap gap-2">
                  {levelModules.manuals.map((m: any) => (
                    <Badge key={`m-${m.id}`} variant="outline" className="cursor-pointer hover:bg-blue-100 bg-white" onClick={() => { if (m.type === "link" && m.fileUrl) window.open(m.fileUrl, "_blank", "noopener"); else void openManual(m.id); }}>📖 {m.title}</Badge>
                  ))}
                  {levelModules.videos.map((v: any) => (
                    <Badge key={`v-${v.id}`} variant="outline" className="cursor-pointer hover:bg-blue-100 bg-white" onClick={() => window.open(v.videoUrl, "_blank", "noopener")}>▶ {v.title}</Badge>
                  ))}
                </div>
              </div>
            )}

            {mine.length > 0 && (
              <div className="border rounded-md p-3 bg-muted/30">
                <p className="text-xs text-muted-foreground mb-2">As tuas tentativas anteriores</p>
                <div className="flex flex-wrap gap-2">
                  {mine.slice(0, 5).map((a: any) => (
                    <Badge key={a.id} className={a.passed ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}>{a.score}% {a.passed ? "✓" : "✗"} · {fmtPTDate(a.createdAt)}</Badge>
                  ))}
                </div>
              </div>
            )}
            {isAdmin && examQuestionsAdmin.length > 0 && (
              <div className="space-y-2 mt-4">
                <h4 className="font-semibold text-sm text-muted-foreground">Perguntas ({examQuestionsAdmin.length})</h4>
                {(examQuestionsAdmin as any[]).map((q, i) => (
                  <div key={q.id} className="p-3 border rounded-lg text-sm flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-medium">{i + 1}. {q.question}</span>
                      <div className="flex flex-wrap gap-2 mt-1">
                        {(["A", "B", "C", "D"] as const).map((k) => <Badge key={k} variant="outline" className="text-xs">{k}: {q[`option${k}`]}</Badge>)}
                        <Badge className="bg-green-100 text-green-800 text-xs">✓ {q.correctOption}</Badge>
                      </div>
                    </div>
                    <div className="flex shrink-0">
                      <Button variant="ghost" size="icon" title="Editar" onClick={() => setEditingQ({ id: q.id, value: questionFrom(q) })}><Pencil className="w-4 h-4" /></Button>
                      <Button variant="ghost" size="icon" className="text-destructive" title="Eliminar" onClick={async () => {
                        if (await confirm({ title: "Eliminar esta pergunta do exame?", description: q.question, confirmLabel: "Eliminar", destructive: true })) deleteExamQ.mutate({ id: q.id });
                      }}><Trash2 className="w-4 h-4" /></Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {confirmUi}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2"><GraduationCap className="w-5 h-5" />Evolução de Carreira</h2>
          <p className="text-muted-foreground">Passa os exames para avançar na tua carreira</p>
        </div>
        {isAdmin && <Button onClick={() => setShowCreate(true)}><Plus className="w-4 h-4 mr-1" />Novo Exame</Button>}
      </div>

      {certificates.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Award className="w-5 h-5 text-amber-500" />Os meus certificados</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {certificates.map((c: any) => (
              <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 p-2 border rounded-lg">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className={CAREER_LEVEL_COLORS[c.level] || ""}>{CAREER_LEVEL_LABELS[c.level] ?? c.level}</Badge>
                  <span className="text-sm">{c.examTitle}</span>
                  <span className="text-xs text-muted-foreground">{fmtPTDate(c.issuedAt)}{c.validUntil ? ` · válido até ${fmtPTDate(c.validUntil)}` : ""}</span>
                  {c.state === "expired" && <Badge className="bg-red-100 text-red-700">Expirado</Badge>}
                  {c.state === "expiring" && <Badge className="bg-amber-100 text-amber-800">Expira em breve</Badge>}
                </div>
                <Button size="sm" variant="outline" disabled={certUrl.isPending} onClick={() => void downloadCert(c.id)}><Download className="w-4 h-4 mr-1" />PDF</Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {CAREER_TRACKS.map((track) => (
          <Card key={track.key} className="overflow-hidden">
            <div className={`h-2 ${track.barColor}`} />
            <CardContent className="p-5 space-y-3">
              <h3 className="font-bold text-lg">{track.label}</h3>
              {track.levels.map((level) => {
                const levelExams = (exams as any[]).filter((e) => e.level === level);
                return (
                  <div key={level} className="space-y-1.5">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{CAREER_LEVEL_LABELS[level]}</p>
                    {levelExams.length === 0 ? <p className="text-xs text-muted-foreground/60 pl-1">Sem exame configurado</p> : levelExams.map((e) => (
                      <Button key={e.id} variant="outline" size="sm" className="w-full justify-start" onClick={() => setSelectedExam(e)}><Star className="w-3.5 h-3.5 mr-2" />{e.title}</Button>
                    ))}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader><DialogTitle>Novo Exame de Carreira</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Nível</Label>
              <Select value={examForm.level} onValueChange={(v) => setExamForm((p) => ({ ...p, level: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{ALL_CAREER_LEVELS.map((l) => <SelectItem key={l} value={l}>{CAREER_LEVEL_LABELS[l]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div><Label>Título</Label><Input value={examForm.title} onChange={(e) => setExamForm((p) => ({ ...p, title: e.target.value }))} /></div>
            <div><Label>Descrição</Label><Textarea value={examForm.description} onChange={(e) => setExamForm((p) => ({ ...p, description: e.target.value }))} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Nota mínima (%)</Label><Input type="number" value={examForm.passingScore} onChange={(e) => setExamForm((p) => ({ ...p, passingScore: e.target.value }))} /></div>
              <div><Label>Tempo limite (min)</Label><Input type="number" value={examForm.timeLimitMinutes} onChange={(e) => setExamForm((p) => ({ ...p, timeLimitMinutes: e.target.value }))} /></div>
              <div><Label>Validade do certificado (meses)</Label><Input type="number" value={examForm.validityMonths} onChange={(e) => setExamForm((p) => ({ ...p, validityMonths: e.target.value }))} /></div>
              <div><Label>Tentativas por dia</Label><Input type="number" value={examForm.maxAttemptsPerDay} onChange={(e) => setExamForm((p) => ({ ...p, maxAttemptsPerDay: e.target.value }))} /></div>
            </div>
            <Button className="w-full" disabled={!examForm.title || createExam.isPending} onClick={() => createExam.mutate({
              level: examForm.level as any, title: examForm.title, description: examForm.description || undefined,
              passingScore: Math.max(1, Math.min(100, Number(examForm.passingScore) || 70)), timeLimitMinutes: Number(examForm.timeLimitMinutes) || 30,
              validityMonths: Math.max(0, Number(examForm.validityMonths) || 0), maxAttemptsPerDay: Math.max(1, Number(examForm.maxAttemptsPerDay) || 3),
            })}>Criar Exame</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
