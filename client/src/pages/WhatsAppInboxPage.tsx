import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { useIsMobile } from "@/hooks/useMobile";
import { useOpenEmployee } from "@/hooks/useOpenEmployee";
import {
  MessageCircle,
  Send,
  Clock,
  Check,
  CheckCheck,
  XCircle,
  ArrowLeft,
  Hourglass,
  Lock,
  Search,
  X,
} from "lucide-react";
import {
  AVAILABILITY_TEMPLATE_NAME,
  DEFAULT_TEMPLATE_LANGUAGE,
  messageDisplayBody,
} from "@shared/whatsappTemplate";
import { matchesContactQuery } from "@shared/contactSearch";
import { isMediaPlaceholderBody } from "@shared/whatsappMedia";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Timestamp da BD (UTC wall-clock 'YYYY-MM-DD HH:MM:SS') → Date local, ou null. */
function parseDbTime(s: string | null): Date | null {
  if (!s) return null;
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const withZ = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + "Z";
  const d = new Date(withZ);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Timestamp da BD → hora local HH:MM (bolhas da thread). */
function fmtTime(s: string | null): string {
  const d = parseDbTime(s);
  return d ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}

/**
 * Timestamp da BD → HH:MM se for hoje, senão DD/MM (lista de conversas). A lista
 * está ordenada pela última mensagem e mostrar só a hora numa conversa de há
 * uma semana fazia parecer que era de hoje.
 */
function fmtListTime(s: string | null, now: number): string {
  const d = parseDbTime(s);
  if (!d) return "";
  const today = new Date(now);
  const sameDay =
    d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit" });
}

/** Countdown legível até windowExpiresAt (ISO), relativo a `now` (ms). */
function windowCountdown(expiresAt: string | null, now: number): string {
  if (!expiresAt) return "";
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return "a fechar";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Janela a fechar em menos de 2h — a linha ganha destaque na lista. */
function windowClosingSoon(expiresAt: string | null, now: number): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() - now < 2 * 3_600_000;
}

type WindowState = "awaiting_first_reply" | "open" | "expired";

// ─── Ícone de status (só mensagens OUT) ─────────────────────────────────────

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "sent":
      return <Check className="h-3 w-3 text-muted-foreground" aria-label="Enviado" />;
    case "delivered":
      return <CheckCheck className="h-3 w-3 text-muted-foreground" aria-label="Entregue" />;
    case "read":
      return <CheckCheck className="h-3 w-3 text-sky-500" aria-label="Lido" />;
    case "failed":
      return <XCircle className="h-3 w-3 text-red-500" aria-label="Falhou" />;
    default:
      return <Clock className="h-3 w-3 text-muted-foreground" aria-label="Pendente" />;
  }
}

// ─── Página ─────────────────────────────────────────────────────────────────

export default function WhatsAppInboxPage() {
  const isMobile = useIsMobile();
  const openEmployee = useOpenEmployee();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [tplOpen, setTplOpen] = useState(false);
  const [tplName, setTplName] = useState(AVAILABILITY_TEMPLATE_NAME);
  const [tplLang, setTplLang] = useState(DEFAULT_TEMPLATE_LANGUAGE);
  // {{2}} do body (o {{1}} e sempre o nome de quem recebe, resolvido no servidor).
  const [tplParam2, setTplParam2] = useState("");
  const [now, setNow] = useState(() => Date.now());
  // Pesquisa por nome ou número (filtro local — a lista já vem completa).
  const [search, setSearch] = useState("");

  // Tick para o countdown da janela (a cada 30s).
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const conversations = trpc.whatsapp.conversations.list.useQuery(undefined, { refetchInterval: 10_000 });
  const thread = trpc.whatsapp.messages.byConversation.useQuery(
    { conversationId: selectedId ?? 0 },
    { enabled: selectedId != null, refetchInterval: 10_000 },
  );

  const markRead = trpc.whatsapp.markRead.useMutation({
    onSuccess: () => conversations.refetch(),
  });
  const reply = trpc.whatsapp.reply.useMutation({
    onSuccess: () => {
      setText("");
      thread.refetch();
      conversations.refetch();
    },
    onError: (e) => toast.error(e.message),
  });
  const broadcast = trpc.whatsapp.sendBroadcast.useMutation({
    onSuccess: (r) => {
      if (r.sent) toast.success("Template enviado.");
      else toast.error(r.recipients[0]?.error || "Falha ao enviar template.");
      setTplOpen(false);
      thread.refetch();
      conversations.refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  function openConversation(id: number) {
    setSelectedId(id);
    setText("");
    markRead.mutate({ conversationId: id });
  }

  const allConversations = conversations.data ?? [];
  const hasSearch = search.trim().length > 0;
  const convList = hasSearch
    ? allConversations.filter((c) => matchesContactQuery(search, { name: c.name, phone: c.phoneE164 }))
    : allConversations;
  // A ordem vem do servidor (`sortConversations`): janela aberta primeiro, da
  // que fecha mais cedo para a que fecha mais tarde; depois as restantes pela
  // última mensagem. Aqui só se AGRUPA para o cabeçalho de cada bloco — o
  // filtro de pesquisa preserva a ordem, por isso a partição também.
  const openList = convList.filter((c) => c.windowState === "open");
  const closedList = convList.filter((c) => c.windowState !== "open");
  const t = thread.data;
  const windowState: WindowState | undefined = t?.windowState;

  function conversationRow(c: (typeof convList)[number]) {
    const isOpen = c.windowState === "open";
    return (
      <button
        key={c.id}
        onClick={() => openConversation(c.id)}
        className={`w-full text-left px-3 py-2.5 border-b hover:bg-muted/50 transition-colors ${
          selectedId === c.id ? "bg-muted" : ""
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="font-medium truncate flex-1">{c.name}</span>
          <span className="text-[11px] text-muted-foreground shrink-0">{fmtListTime(c.lastMessageAt, now)}</span>
          {c.unreadCount > 0 && (
            <Badge className="bg-green-600 text-white h-5 min-w-5 px-1.5 justify-center shrink-0">
              {c.unreadCount}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1 mt-0.5">
          {c.windowState === "awaiting_first_reply" && (
            <Hourglass className="h-3 w-3 text-amber-500 shrink-0" aria-label="A aguardar 1ª resposta" />
          )}
          {c.windowState === "expired" && (
            <Lock className="h-3 w-3 text-muted-foreground shrink-0" aria-label="Janela fechada" />
          )}
          <span className="text-xs text-muted-foreground truncate flex-1">
            {c.previewDirection === "out" ? "Tu: " : ""}
            {c.preview ?? "—"}
          </span>
          {isOpen && (
            // Critério de ordenação deste bloco, visível na própria linha.
            <span
              className={`text-[10px] shrink-0 tabular-nums ${
                windowClosingSoon(c.windowExpiresAt, now) ? "text-amber-600 dark:text-amber-400 font-medium" : "text-green-700 dark:text-green-400"
              }`}
              title="Tempo que resta para responder em texto livre"
            >
              fecha em {windowCountdown(c.windowExpiresAt, now)}
            </span>
          )}
        </div>
      </button>
    );
  }

  function groupHeader(label: string, count: number, tone: "open" | "closed") {
    return (
      <div
        className={`sticky top-0 z-10 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide border-b ${
          tone === "open"
            ? "bg-green-50 dark:bg-green-950/40 text-green-800 dark:text-green-300"
            : "bg-muted text-muted-foreground"
        }`}
      >
        {label} · {count}
      </div>
    );
  }

  // ── Coluna esquerda: lista de conversas ──
  const listColumn = (
    <div className="flex flex-col h-full border-r min-w-0">
      <div className="p-3 border-b flex items-center gap-2 shrink-0">
        <MessageCircle className="h-5 w-5 text-green-600" />
        <span className="font-semibold">Conversas</span>
        {conversations.isFetching && <Clock className="h-3.5 w-3.5 animate-spin text-muted-foreground ml-auto" />}
      </div>
      <div className="p-2 border-b shrink-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            type="text"
            placeholder="Pesquisar nome ou número…"
            aria-label="Pesquisar conversas por nome ou número"
            className="h-9 pl-8 pr-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {hasSearch && (
            <button
              type="button"
              aria-label="Limpar pesquisa"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setSearch("")}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {convList.length === 0 && (
          <div className="p-4 text-sm text-muted-foreground text-center">
            {conversations.isLoading
              ? "A carregar…"
              : hasSearch
                ? `Sem resultados para “${search.trim()}”.`
                : "Ainda sem conversas."}
          </div>
        )}
        {openList.length > 0 && groupHeader("Janela aberta — a fechar primeiro", openList.length, "open")}
        {openList.map(conversationRow)}
        {closedList.length > 0 && groupHeader("Fora da janela — última mensagem", closedList.length, "closed")}
        {closedList.map(conversationRow)}
      </div>
    </div>
  );

  // ── Banner + composer por estado de janela ──
  function windowBanner() {
    if (!t) return null;
    if (windowState === "awaiting_first_reply") {
      return (
        <div className="flex items-center gap-2 px-3 py-2 text-xs bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 border-t">
          <Hourglass className="h-4 w-4 shrink-0" />
          <span>
            <strong>Template enviado — a aguardar a primeira resposta.</strong> Só podes escrever texto livre
            depois de o contacto responder.
          </span>
        </div>
      );
    }
    if (windowState === "open") {
      return (
        <div className="flex items-center gap-2 px-3 py-2 text-xs bg-green-50 dark:bg-green-950/30 text-green-800 dark:text-green-300 border-t">
          <MessageCircle className="h-4 w-4 shrink-0" />
          <span>
            <strong>Janela aberta</strong> — fecha em {windowCountdown(t.windowExpiresAt, now)}.
          </span>
        </div>
      );
    }
    // expired
    return (
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs bg-muted text-muted-foreground border-t">
        <Lock className="h-4 w-4 shrink-0" />
        <span>
          <strong>Janela de 24h fechada</strong> — só é possível reiniciar com um template.
        </span>
        <Button size="sm" variant="outline" className="ml-auto h-7" onClick={() => { setTplName(""); setTplOpen(true); }}>
          <Send className="h-3.5 w-3.5 mr-1" /> Enviar template
        </Button>
      </div>
    );
  }

  function composer() {
    const disabled = windowState !== "open";
    return (
      <div className="p-3 border-t shrink-0">
        <div className="flex gap-2 items-end">
          <Textarea
            rows={1}
            className="resize-none min-h-[40px] max-h-32"
            placeholder={disabled ? "Composer desativado — janela fechada." : "Escreve uma mensagem…"}
            value={text}
            disabled={disabled || reply.isPending}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !disabled) {
                e.preventDefault();
                if (text.trim() && selectedId != null) reply.mutate({ conversationId: selectedId, text: text.trim() });
              }
            }}
          />
          <Button
            className="bg-green-600 hover:bg-green-700 text-white shrink-0"
            disabled={disabled || !text.trim() || reply.isPending || selectedId == null}
            onClick={() => selectedId != null && reply.mutate({ conversationId: selectedId, text: text.trim() })}
          >
            {reply.isPending ? <Clock className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    );
  }

  // ── Coluna direita: thread ──
  const threadColumn = (
    <div className="flex flex-col h-full min-w-0 flex-1">
      {selectedId == null ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          Escolhe uma conversa à esquerda.
        </div>
      ) : (
        <>
          <div className="p-3 border-b flex items-center gap-2 shrink-0">
            {isMobile && (
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setSelectedId(null)}>
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            <div className="min-w-0">
              {t?.employeeId ? (
                // Mesmo padrão das outras páginas (Extras-Dia, Avaliação): o nome
                // abre a ficha do colaborador em /rh via useOpenEmployee.
                <button
                  type="button"
                  className="block font-semibold truncate max-w-full text-left hover:underline"
                  title="Abrir ficha do funcionário"
                  onClick={() => openEmployee(t.employeeId)}
                >
                  {t.name}
                </button>
              ) : (
                <div className="font-semibold truncate" title={t ? "Número sem ficha de colaborador associada" : undefined}>
                  {t?.name ?? "…"}
                </div>
              )}
              {t && <div className="text-[11px] text-muted-foreground">{t.phoneE164}</div>}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-2 bg-muted/20">
            {thread.isLoading && <div className="text-sm text-muted-foreground text-center">A carregar…</div>}
            {t?.messages.length === 0 && (
              <div className="text-sm text-muted-foreground text-center">Sem mensagens.</div>
            )}
            {t?.messages.map((m) => (
              <div key={m.id} className={`flex ${m.direction === "out" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[75%] rounded-lg px-3 py-1.5 text-sm ${
                    m.direction === "out"
                      ? "bg-green-600 text-white rounded-br-sm"
                      : "bg-background border rounded-bl-sm"
                  }`}
                >
                  {m.type === "template" && (
                    <div
                      className={`text-[10px] uppercase tracking-wide mb-0.5 ${
                        m.direction === "out" ? "text-green-100" : "text-muted-foreground"
                      }`}
                    >
                      Template{m.templateName ? ` · ${m.templateName}` : ""}
                    </div>
                  )}
                  {/* Imagens e áudios enviados pela pessoa (2026-09-09). Com o
                      ficheiro à vista, o marcador "[imagem]"/"[áudio]" é redundante;
                      a caption (quando existe) continua a aparecer por baixo. */}
                  <InboundMedia m={m} />
                  {/* Envios feitos antes de 2026-08-20 não gravaram o conteúdo:
                      dizem-no em itálico em vez de aparecerem em branco. */}
                  {!(m.mediaUrl && isMediaPlaceholderBody(m.body)) && (
                    <div
                      className={`whitespace-pre-wrap break-words${m.body?.trim() ? "" : " italic opacity-80"}`}
                    >
                      {messageDisplayBody(m) || "—"}
                    </div>
                  )}
                  <div
                    className={`flex items-center gap-1 justify-end mt-0.5 text-[10px] ${
                      m.direction === "out" ? "text-green-100" : "text-muted-foreground"
                    }`}
                  >
                    <span>{fmtTime(m.waTimestamp ?? m.createdAt)}</span>
                    {m.direction === "out" && <StatusIcon status={m.status} />}
                  </div>
                  {m.direction === "out" && m.status === "failed" && m.errorDetail && (
                    <div className="text-[10px] text-red-200 mt-0.5">{m.errorDetail}</div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {windowBanner()}
          {composer()}
        </>
      )}
    </div>
  );

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <MessageCircle className="h-6 w-6 text-green-600" /> WhatsApp — Inbox
        </h1>
        <p className="text-sm text-muted-foreground">
          Respostas dos extras aos templates. Só é possível texto livre com a janela de 24h aberta.
        </p>
      </div>

      <Card className="overflow-hidden p-0">
        <div className="flex h-[calc(100vh-14rem)] min-h-[420px]">
          {isMobile ? (
            selectedId == null ? (
              <div className="flex-1 min-w-0">{listColumn}</div>
            ) : (
              threadColumn
            )
          ) : (
            <>
              <div className="w-80 shrink-0">{listColumn}</div>
              {threadColumn}
            </>
          )}
        </div>
      </Card>

      {/* Dialog para reiniciar com template (janela fechada) */}
      <Dialog open={tplOpen} onOpenChange={(open) => { if (!broadcast.isPending) setTplOpen(open); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="h-5 w-5 text-green-600" /> Reiniciar com template
            </DialogTitle>
            <DialogDescription>
              A janela de 24h está fechada. Envia um template aprovado para {t?.phoneE164} para reabrir a conversa.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Nome do template (WhatsApp Manager)</Label>
              <Input
                placeholder={AVAILABILITY_TEMPLATE_NAME}
                value={tplName}
                onChange={(e) => setTplName(e.target.value)}
              />
            </div>
            <div className="flex gap-3 flex-wrap">
              <div className="space-y-1 w-32">
                <Label className="text-xs">Língua</Label>
                <Input value={tplLang} onChange={(e) => setTplLang(e.target.value)} placeholder={DEFAULT_TEMPLATE_LANGUAGE} />
              </div>
              <div className="space-y-1 flex-1 min-w-[12rem]">
                <Label className="text-xs">Semana/dia (parâmetro 2)</Label>
                <Input
                  value={tplParam2}
                  onChange={(e) => setTplParam2(e.target.value)}
                  placeholder="ex: semana de 11 a 17 de agosto"
                />
                <p className="text-[11px] text-muted-foreground">
                  O {"{{1}}"} é preenchido com o nome do contacto.
                </p>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setTplOpen(false)} disabled={broadcast.isPending}>
              Cancelar
            </Button>
            <Button
              className="bg-green-600 hover:bg-green-700 text-white"
              disabled={!tplName.trim() || !t || broadcast.isPending}
              onClick={() =>
                t &&
                broadcast.mutate({
                  templateName: tplName.trim(),
                  languageCode: tplLang.trim() || undefined,
                  bodyParam2: tplParam2.trim() || null,
                  testPhone: t.phoneE164,
                })
              }
            >
              {broadcast.isPending ? <Clock className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
              Enviar template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Media recebida (imagem / áudio) ────────────────────────────────────────
function InboundMedia({ m }: { m: { mediaType: string | null; mediaUrl: string | null; mediaMime: string | null; body: string | null } }) {
  if (!m.mediaType) return null;
  if (!m.mediaUrl) {
    // Download falhou no webhook (token/rede/storage) — dizemos porquê em vez
    // de mostrar uma bolha vazia; o `mediaId` fica na BD para re-tentar.
    return (
      <div className="text-[11px] italic opacity-80 mb-1">
        {m.mediaType === "image" ? "Imagem" : m.mediaType === "audio" ? "Áudio" : "Ficheiro"} recebido, mas não foi possível descarregar.
      </div>
    );
  }
  if (m.mediaType === "image") {
    return (
      <a href={m.mediaUrl} target="_blank" rel="noreferrer" className="block mb-1" title="Abrir imagem">
        <img src={m.mediaUrl} alt={m.body && !isMediaPlaceholderBody(m.body) ? m.body : "Imagem recebida"} loading="lazy" className="max-h-64 max-w-full rounded-md object-contain bg-black/5" />
      </a>
    );
  }
  if (m.mediaType === "audio") {
    return (
      <audio controls preload="metadata" className="max-w-full mb-1 h-9">
        <source src={m.mediaUrl} type={m.mediaMime ?? undefined} />
        <a href={m.mediaUrl} target="_blank" rel="noreferrer">Ouvir áudio</a>
      </audio>
    );
  }
  return (
    <a href={m.mediaUrl} target="_blank" rel="noreferrer" className="underline text-[12px] block mb-1">Abrir ficheiro</a>
  );
}

