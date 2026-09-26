/**
 * Assistente da equipa: botão flutuante em todas as páginas (DashboardLayout)
 * que abre um painel — folha de baixo no telemóvel, painel lateral no
 * computador. A lógica (IA, ferramentas, histórico) está no servidor
 * (`assistant.*`, server/assistant + server/_core/ai/chat).
 */
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Streamdown } from "streamdown";
import { History, Loader2, MessageCircleQuestion, Plus, Send, Sparkles, Trash2, User } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useIsMobile } from "@/hooks/useMobile";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { ASSISTANT_DEFAULT_MAX_INPUT } from "@shared/assistant";

type Msg = { key: string; role: "user" | "assistant" | "notice"; content: string; tools?: string[] };

const TOOL_LABELS: Record<string, string> = {
  abrir_ajuda: "ajuda",
  reservas_resumo: "reservas",
  extras_escala: "Extras-Dia",
  casos_abertos: "casos em aberto",
  whatsapp_pendentes: "WhatsApp",
  minha_avaliacao: "a tua avaliação",
  minhas_tarefas: "as tuas tarefas",
  financeiro_totais: "totais financeiros",
};

/** Evento para abrir o assistente com uma pergunta (ex.: "Perguntar à IA" na pesquisa global). */
export const ASSISTANT_ASK_EVENT = "mp:assistant-ask";
export function openAssistantWith(question: string) {
  window.dispatchEvent(new CustomEvent(ASSISTANT_ASK_EVENT, { detail: { question } }));
}

const fmtWhen = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("pt-PT", { timeZone: "Europe/Lisbon", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};

export function AssistantWidget() {
  const [location] = useLocation();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [fresh, setFresh] = useState(false); // "Nova conversa" pedida, ainda sem mensagens
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const utils = trpc.useUtils();
  // Pergunta vinda de fora (pesquisa global): envia quando o estado estiver carregado.
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    const onAsk = (e: Event) => {
      const q = String((e as CustomEvent<{ question?: string }>).detail?.question ?? "").trim();
      if (!q) return;
      setOpen(true);
      setPending(q);
    };
    window.addEventListener(ASSISTANT_ASK_EVENT, onAsk);
    return () => window.removeEventListener(ASSISTANT_ASK_EVENT, onAsk);
  }, []);

  const status = trpc.assistant.status.useQuery({ path: location }, { enabled: open, staleTime: 60_000 });
  const history = trpc.assistant.messages.useQuery(conversationId ? { conversationId } : undefined, {
    enabled: open && !fresh,
    staleTime: 30_000,
  });
  const conversations = trpc.assistant.conversations.useQuery(undefined, { enabled: open, staleTime: 30_000 });

  // Carrega o histórico guardado quando o painel abre (ou muda de conversa).
  useEffect(() => {
    if (!history.data || fresh) return;
    setConversationId(history.data.conversationId);
    setMessages(history.data.messages.map((m) => ({ key: `db-${m.id}`, role: m.role, content: m.content, tools: m.tools })));
  }, [history.data, fresh]);

  const ask = trpc.assistant.ask.useMutation({
    onSuccess: (r) => {
      if (r.ok) {
        setConversationId(r.conversationId);
        setFresh(false);
        setMessages((prev) => [...prev, { key: `a-${Date.now()}`, role: "assistant", content: r.answer, tools: r.toolsUsed }]);
        void utils.assistant.conversations.invalidate();
      } else {
        setMessages((prev) => [...prev, { key: `n-${Date.now()}`, role: "notice", content: r.message }]);
      }
    },
    onError: (err) => {
      setMessages((prev) => [...prev, { key: `n-${Date.now()}`, role: "notice", content: err.message || "Não foi possível falar com o assistente. Tenta outra vez." }]);
    },
  });

  const del = trpc.assistant.deleteConversation.useMutation({
    onSuccess: () => {
      startNew();
      void utils.assistant.conversations.invalidate();
    },
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, ask.isPending, open]);

  const maxChars = status.data?.maxInputChars ?? ASSISTANT_DEFAULT_MAX_INPUT;
  const unavailable = status.error ? status.error.message : status.data && !status.data.available ? status.data.message : null;
  const suggestions = status.data?.suggestions ?? [];
  const tooLong = input.trim().length > maxChars;

  function startNew() {
    setFresh(true);
    setConversationId(null);
    setMessages([]);
  }

  function openConversation(id: number) {
    setFresh(false);
    setConversationId(id);
    setMessages([]);
  }

  function send(text: string) {
    const q = text.trim();
    if (!q || ask.isPending || q.length > maxChars) return;
    setMessages((prev) => [...prev, { key: `u-${Date.now()}`, role: "user", content: q }]);
    setInput("");
    ask.mutate({ question: q, conversationId: conversationId ?? undefined, newConversation: fresh || !conversationId ? true : undefined, path: location });
  }

  useEffect(() => {
    if (!pending || !open || !status.data) return;
    const q = pending;
    setPending(null);
    if (status.data.available && q.length <= maxChars && !ask.isPending) send(q);
    else setInput(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, open, status.data]);

  const shown = messages;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Abrir o assistente"
        title="Assistente — perguntas e ajuda"
        className={cn(
          "fixed right-4 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition hover:scale-105 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2",
          "bottom-24 md:bottom-6",
        )}
      >
        <MessageCircleQuestion className="h-6 w-6" />
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side={isMobile ? "bottom" : "right"}
          className={cn("flex flex-col gap-0 p-0", isMobile ? "h-[88dvh] max-h-[88dvh] rounded-t-2xl" : "w-full sm:max-w-md")}
        >
          <SheetHeader className="border-b px-4 py-3 pr-12">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <SheetTitle className="flex items-center gap-2 text-base">
                  <Sparkles className="h-4 w-4 text-primary" /> Assistente
                </SheetTitle>
                <SheetDescription className="text-xs">Pergunta como se usa a aplicação ou pede números do teu trabalho.</SheetDescription>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Conversas anteriores" title="Conversas anteriores">
                      <History className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-72">
                    <DropdownMenuLabel className="text-xs">Últimos 30 dias</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {(conversations.data ?? []).length === 0 ? (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">Ainda sem conversas.</div>
                    ) : (
                      (conversations.data ?? []).map((c) => (
                        <DropdownMenuItem key={c.id} onClick={() => openConversation(c.id)} className="flex flex-col items-start gap-0.5">
                          <span className={cn("line-clamp-1 text-sm", c.id === conversationId && "font-semibold")}>{c.title ?? "Conversa"}</span>
                          <span className="text-[11px] text-muted-foreground">{fmtWhen(c.updatedAt)}</span>
                        </DropdownMenuItem>
                      ))
                    )}
                    {conversationId && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-red-600" onClick={() => del.mutate({ conversationId })}>
                          <Trash2 className="mr-2 h-4 w-4" /> Apagar esta conversa
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={startNew} aria-label="Nova conversa" title="Nova conversa">
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-4 py-3">
            {unavailable && (
              <div role="status" className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                {unavailable}
              </div>
            )}

            {shown.length === 0 && !history.isLoading && (
              <div className="flex flex-col items-center gap-4 py-6 text-center">
                <Sparkles className="h-10 w-10 text-primary/30" />
                <p className="text-sm text-muted-foreground">Olá! Em que posso ajudar?</p>
                {suggestions.length > 0 && !unavailable && (
                  <div className="flex w-full flex-col gap-2">
                    {suggestions.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => send(s)}
                        disabled={ask.isPending}
                        className="rounded-lg border bg-card px-3 py-2 text-left text-sm transition-colors hover:bg-accent disabled:opacity-50"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {history.isLoading && shown.length === 0 && (
              <div className="flex justify-center py-6 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
            )}

            <div className="flex flex-col gap-3">
              {shown.map((m) =>
                m.role === "notice" ? (
                  <div key={m.key} role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
                    {m.content}
                  </div>
                ) : (
                  <div key={m.key} className={cn("flex items-start gap-2", m.role === "user" ? "justify-end" : "justify-start")}>
                    {m.role === "assistant" && (
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10">
                        <Sparkles className="h-3.5 w-3.5 text-primary" />
                      </div>
                    )}
                    <div className={cn("max-w-[85%] rounded-2xl px-3 py-2 text-sm", m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground")}>
                      {m.role === "assistant" ? (
                        <>
                          <div className="prose prose-sm max-w-none dark:prose-invert [&_p]:my-1 [&_ul]:my-1">
                            <Streamdown>{m.content}</Streamdown>
                          </div>
                          {m.tools && m.tools.length > 0 && (
                            <div className="mt-1 text-[11px] text-muted-foreground">
                              Consultei: {m.tools.map((t) => TOOL_LABELS[t] ?? t).join(", ")}
                            </div>
                          )}
                        </>
                      ) : (
                        <p className="whitespace-pre-wrap">{m.content}</p>
                      )}
                    </div>
                    {m.role === "user" && (
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-secondary">
                        <User className="h-3.5 w-3.5 text-secondary-foreground" />
                      </div>
                    )}
                  </div>
                ),
              )}
              {ask.isPending && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> A pensar…
                </div>
              )}
              <div ref={endRef} />
            </div>
          </div>

          <form
            className="border-t p-3"
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
          >
            <div className="flex items-end gap-2">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send(input);
                  }
                }}
                placeholder="Escreve a tua pergunta…"
                rows={1}
                className="max-h-32 min-h-10 flex-1 resize-none text-sm"
                aria-label="Pergunta ao assistente"
                disabled={!!unavailable}
              />
              <Button type="submit" size="icon" className="h-10 w-10 shrink-0" disabled={!input.trim() || ask.isPending || tooLong || !!unavailable} aria-label="Enviar">
                {ask.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
            <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
              <span>Só leitura: não altera nada. Confirma sempre os números importantes.</span>
              {input.length > maxChars * 0.8 && <span className={cn(tooLong && "text-red-600")}>{input.trim().length}/{maxChars}</span>}
            </div>
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}

export default AssistantWidget;
