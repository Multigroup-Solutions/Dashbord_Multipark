/**
 * Tutor da Formação (IA) — painel dentro das páginas da Formação (manual,
 * vídeo, percurso e quiz). Responde só com o conteúdo dos manuais; respostas
 * curtas (boas para ouvir) e "Explicar melhor" para a versão longa.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { fmtPTDate } from "@/lib/lisbonTime";
import { toast } from "sonner";
import { BookOpen, ChevronDown, ChevronUp, Flame, GraduationCap, Lightbulb, Send, Sparkles, Trash2, Volume2 } from "lucide-react";
import { TUTOR_MAX_INPUT_CHARS, type TutorContext } from "@shared/trainingTutor";

type Msg = {
  role: "user" | "assistant";
  content: string;
  outOfContent?: boolean;
  sources?: Array<{ manualId: number; manualTitle: string; heading: string }>;
  question?: string;
};

/** Lê em voz alta (pt-PT) com a voz do navegador — sem custo. */
function speak(text: string) {
  try {
    const synth = window.speechSynthesis;
    if (!synth) { toast.error("O teu navegador não lê texto em voz alta."); return; }
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/[«»*#_`]/g, ""));
    u.lang = "pt-PT";
    const v = synth.getVoices().find((x) => x.lang?.toLowerCase().startsWith("pt-pt")) ?? synth.getVoices().find((x) => x.lang?.toLowerCase().startsWith("pt"));
    if (v) u.voice = v;
    synth.speak(u);
  } catch {
    toast.error("Não foi possível ler em voz alta.");
  }
}

export function TutorPanel({ context, defaultOpen = true, title }: { context: TutorContext; defaultOpen?: boolean; title?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  const [text, setText] = useState("");
  const [local, setLocal] = useState<Msg[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const key = `${context.type}:${context.id}`;
  useEffect(() => { setLocal([]); setText(""); }, [key]);

  const overview = trpc.training.tutor.overview.useQuery({ context }, { enabled: open, staleTime: 60_000 });
  // O histórico só é lido ao abrir; as mensagens novas ficam em `local` e o
  // histórico é invalidado ao sair (evita duplicados).
  const history = trpc.training.tutor.history.useQuery({ context }, { enabled: open, staleTime: Infinity, refetchOnWindowFocus: false });
  const utils = trpc.useUtils();
  useEffect(() => () => { void utils.training.tutor.history.invalidate({ context }); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const ask = trpc.training.tutor.ask.useMutation({
    onSuccess: (r, vars) => {
      setLocal((m) => [...m, { role: "assistant", content: r.answer, outOfContent: r.outOfContent, sources: r.sources, question: vars.detail ? undefined : vars.question }]);
    },
    onError: (e) => {
      setLocal((m) => m.slice(0, -1));
      toast.error(e.message);
    },
  });
  const clear = trpc.training.tutor.clearHistory.useMutation({
    onSuccess: () => { setLocal([]); void utils.training.tutor.history.invalidate({ context }); },
    onError: (e) => toast.error(e.message),
  });

  const messages: Msg[] = useMemo(() => [
    ...((history.data ?? []) as Msg[]).map((h) => ({ role: h.role, content: h.content, outOfContent: h.outOfContent })),
    ...local,
  ], [history.data, local]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "nearest" }); }, [messages.length, ask.isPending]);

  const o = overview.data;
  const available = o?.available ?? false;
  const send = (question: string, detail = false) => {
    const q = question.trim();
    if (!q || ask.isPending) return;
    if (!detail) setLocal((m) => [...m, { role: "user", content: q }]);
    else setLocal((m) => [...m, { role: "user", content: "Explica melhor, por favor." }]);
    ask.mutate({ context, question: q, detail });
    if (!detail) setText("");
  };
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");

  return (
    <Card className="border-primary/30">
      <CardHeader className="py-3 cursor-pointer select-none" onClick={() => setOpen((v) => !v)}>
        <CardTitle className="text-base flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 min-w-0"><GraduationCap className="w-5 h-5 shrink-0 text-primary" /><span className="truncate">{title ?? "Tutor da formação"}</span></span>
          <span className="flex items-center gap-2 shrink-0">
            {o && o.streak >= 2 && <Badge className="bg-orange-100 text-orange-800"><Flame className="w-3 h-3 mr-1" />{o.streak} dias</Badge>}
            {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </span>
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent className="space-y-3 pt-0">
          {overview.isLoading && <p className="text-sm text-muted-foreground">A preparar o tutor…</p>}
          {o && (
            <div className="rounded-lg bg-primary/5 p-3 text-sm space-y-2">
              <p>{o.greeting}</p>
              {o.modulesTotal > 0 && (
                <div className="flex items-center gap-2">
                  <div className="h-1.5 flex-1 rounded bg-muted overflow-hidden"><div className="h-full bg-primary" style={{ width: `${Math.round((o.modulesDone / o.modulesTotal) * 100)}%` }} /></div>
                  <span className="text-xs text-muted-foreground">{o.modulesDone}/{o.modulesTotal}</span>
                </div>
              )}
              {o.tips.length > 0 && (
                <ul className="space-y-1">
                  {o.tips.map((t, i) => <li key={i} className="flex gap-2 text-xs"><Lightbulb className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />{t}</li>)}
                </ul>
              )}
            </div>
          )}

          {messages.length > 0 && (
            <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
              {messages.map((m, i) => (
                <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className={`rounded-lg px-3 py-2 text-sm max-w-[90%] whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${m.role === "user" ? "bg-primary text-primary-foreground" : m.outOfContent ? "bg-amber-50 border border-amber-200" : "bg-muted"}`}>
                    {m.content}
                    {m.role === "assistant" && (
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {(m.sources ?? []).slice(0, 3).map((s, j) => (
                          <Badge key={j} variant="outline" className="text-[11px] font-normal whitespace-normal text-left max-w-full"><BookOpen className="w-3 h-3 mr-1 shrink-0" />{s.heading && s.heading !== s.manualTitle ? `${s.manualTitle} · ${s.heading}` : s.manualTitle}</Badge>
                        ))}
                        <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs" title="Ouvir" aria-label="Ouvir resposta" onClick={() => speak(m.content)}><Volume2 className="w-3.5 h-3.5" /></Button>
                        {m === lastAssistant && m.question && !m.outOfContent && available && (
                          <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs" disabled={ask.isPending} onClick={() => send(m.question!, true)}>
                            <Sparkles className="w-3.5 h-3.5 mr-1" />Explicar melhor
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {ask.isPending && <p className="text-xs text-muted-foreground">O tutor está a pensar…</p>}
              <div ref={endRef} />
            </div>
          )}

          {o && !available ? (
            <p className="text-sm text-muted-foreground">O tutor está desligado de momento. Pergunta {o.trainerName ? `ao teu formador, ${o.trainerName}` : "ao teu formador"}.</p>
          ) : o && (
            <div className="space-y-1">
              <div className="flex gap-2 items-end">
                <Textarea
                  rows={2} value={text} maxLength={TUTOR_MAX_INPUT_CHARS} placeholder="Escreve a tua dúvida sobre esta formação…"
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); } }}
                />
                <Button size="icon" disabled={!text.trim() || ask.isPending} onClick={() => send(text)} title="Enviar"><Send className="w-4 h-4" /></Button>
              </div>
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>Respondo só com o que está nos manuais. Não escrevas dados pessoais.</span>
                <span className="flex items-center gap-2">
                  {text.length > 0 && <span>{text.length}/{TUTOR_MAX_INPUT_CHARS}</span>}
                  {messages.length > 0 && (
                    <button className="inline-flex items-center gap-1 hover:text-destructive" disabled={clear.isPending} onClick={() => clear.mutate({ context })}><Trash2 className="w-3 h-3" />Limpar</button>
                  )}
                </span>
              </div>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

/** Depois do quiz: o tutor explica as respostas erradas com o trecho do manual. */
export function QuizTutorReview({ sessionId, answers }: { sessionId: number; answers: Array<{ questionId: number; answer: "A" | "B" | "C" | "D" }> }) {
  const explain = trpc.training.tutor.explainQuiz.useMutation({ onError: (e) => toast.error(e.message) });
  const r = explain.data;
  return (
    <Card className="border-primary/30 text-left">
      <CardHeader className="py-3">
        <CardTitle className="text-base flex items-center gap-2"><GraduationCap className="w-5 h-5 text-primary" />O tutor explica os teus erros</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {!r && (
          <Button disabled={explain.isPending} onClick={() => explain.mutate({ sessionId, answers })}>
            <Sparkles className="w-4 h-4 mr-1" />{explain.isPending ? "A preparar…" : "Explicar as respostas erradas"}
          </Button>
        )}
        {r && (
          <>
            <p className="text-sm font-medium">{r.encouragement}</p>
            {r.fallback === "disabled" && <p className="text-xs text-muted-foreground">O tutor (IA) está desligado — mostramos a explicação do formador e o trecho do manual.</p>}
            {r.fallback && r.fallback !== "disabled" && <p className="text-xs text-muted-foreground">O tutor não conseguiu responder agora — mostramos a explicação do formador e o trecho do manual.</p>}
            {r.items.map((it) => (
              <div key={it.questionId} className="rounded-lg border p-3 space-y-1.5 text-sm">
                <p className="font-medium">{it.question}</p>
                <p className="text-xs"><span className="text-red-700">A tua: {it.yourAnswer ?? "sem resposta"}</span> · <span className="text-green-700">Certa: {it.correctAnswer}</span></p>
                <p>{it.explanation}</p>
                {it.quote && (
                  <blockquote className="border-l-4 border-primary/40 pl-3 text-xs text-muted-foreground italic">
                    «{it.quote.text}»<span className="not-italic"> — {it.quote.manualTitle}{it.quote.heading && it.quote.heading !== it.quote.manualTitle ? `, ${it.quote.heading}` : ""}</span>
                  </blockquote>
                )}
                {it.review && <p className="text-xs flex items-center gap-1"><BookOpen className="w-3.5 h-3.5 text-primary" />{it.review}</p>}
                <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs" onClick={() => speak(`${it.explanation} ${it.review ?? ""}`)}><Volume2 className="w-3.5 h-3.5 mr-1" />Ouvir</Button>
              </div>
            ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Formadores: o que os formandos perguntam mais ao tutor, por módulo. */
export function TutorQuestionsCard() {
  const [days, setDays] = useState(90);
  const { data = [], isLoading, error } = trpc.training.tutor.trainerQuestions.useQuery({ days });
  const [expanded, setExpanded] = useState<string | null>(null);
  const labels: Record<string, string> = { manual: "Manual", video: "Vídeo", path: "Percurso", quiz: "Quiz" };
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="text-base flex items-center gap-2"><GraduationCap className="w-5 h-5 text-primary" />Perguntas ao tutor</CardTitle>
        <div className="flex gap-1">
          {[30, 90, 365].map((d) => <Button key={d} size="sm" variant={days === d ? "default" : "outline"} onClick={() => setDays(d)}>{d} dias</Button>)}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">O que os formandos perguntam mais, por módulo (anónimo, sem dados pessoais). "Sem resposta" = não estava nos manuais — bom sítio para melhorar o conteúdo.</p>
        {isLoading && <p className="text-sm text-muted-foreground">A carregar…</p>}
        {error && <p className="text-sm text-destructive">{error.message}</p>}
        {!isLoading && !error && data.length === 0 && <p className="text-sm text-muted-foreground">Ainda não há perguntas neste período.</p>}
        {data.map((m) => {
          const k = `${m.contextType}:${m.contextId}`;
          return (
            <div key={k} className="rounded-lg border">
              <button className="w-full flex flex-wrap items-center justify-between gap-2 p-2 text-left hover:bg-accent/40" onClick={() => setExpanded(expanded === k ? null : k)}>
                <span className="text-sm"><Badge variant="outline" className="mr-2">{labels[m.contextType] ?? m.contextType}</Badge><b>{m.title}</b></span>
                <span className="flex items-center gap-2 text-xs">
                  <Badge variant="secondary">{m.asks} perguntas</Badge>
                  {m.unanswered > 0 && <Badge className="bg-amber-100 text-amber-800">{m.unanswered} sem resposta</Badge>}
                </span>
              </button>
              {expanded === k && (
                <div className="border-t p-2 space-y-1">
                  {m.questions.map((q, i) => (
                    <div key={i} className="flex items-start justify-between gap-2 text-sm">
                      <span className="min-w-0 break-words">{q.text}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{q.count}×{q.unanswered > 0 ? ` · ${q.unanswered} s/ resp.` : ""} · {fmtPTDate(q.lastAskedAt)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
