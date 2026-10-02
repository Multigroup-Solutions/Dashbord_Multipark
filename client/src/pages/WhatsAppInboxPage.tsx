import { useState, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
  CheckCheck,
  ArrowLeft,
  Hourglass,
  Lock,
  MailOpen,
  X,
  BellOff,
  AlarmClock,
  UserRound,
  Link2,
  Sparkles,
  Zap,
  Settings2,
  Phone,
  MoreVertical,
  Timer,
  Inbox,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CONVERSATION_STATUS_LABELS,
  conversationAlerts,
  fillQuickReply,
  formatWaiting,
  matchesInboxFilters,
  type ConversationStatus,
} from "@shared/whatsappConversation";
import { withDraft, type WhatsAppDrafts } from "@shared/whatsappDrafts";
import { DEFAULT_INBOX_FILTERS, INBOX_LIST_LIMIT, matchesBoxFilter, type InboxListFilters } from "@shared/whatsappInboxView";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { WhatsAppContextSheet } from "@/components/whatsapp/WhatsAppContextSheet";
import { QuickRepliesDialog } from "@/components/whatsapp/QuickRepliesDialog";
import { CallContactDialog, PendingCallbacksDialog, type TimelineCall } from "@/components/whatsapp/WhatsAppCallsPanels";
import { ContactAvatar } from "@/components/whatsapp/ContactAvatar";
import { ConversationListItem } from "@/components/whatsapp/ConversationListItem";
import { InboxListHeader } from "@/components/whatsapp/InboxListHeader";
import { MessageThread } from "@/components/whatsapp/MessageThread";
import { windowCountdown } from "@/components/whatsapp/inboxFormat";
import type { InboxMessage } from "@/components/whatsapp/inboxTypes";
import { can } from "@shared/access";
import {
  DEFAULT_WHATSAPP_TEMPLATE_ID,
  WHATSAPP_TEMPLATES,
  findWhatsAppTemplate,
  previewTemplateBody,
  resolveBodyParamRoles,
} from "@shared/whatsappTemplate";
import { matchesContactQuery } from "@shared/contactSearch";

// ─── Helpers ────────────────────────────────────────────────────────────────

type WindowState = "awaiting_first_reply" | "open" | "expired";

/**
 * A página está visível? Com o separador escondido o polling pára (não há
 * ninguém a ler e cada pedido custa uma query à BD).
 */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

/** Intervalo de atualização da lista e da conversa aberta. */
const POLL_MS = 20_000;
/** Altura máxima do composer (px) — a partir daqui ganha scroll próprio. */
const COMPOSER_MAX_PX = 160;
/** O browser cresce a textarea sozinho (`field-sizing: content`)? Senão, faz-se à mão. */
const SUPPORTS_FIELD_SIZING = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("field-sizing", "content");
// Referências estáveis para a thread não recalcular a linha do tempo a cada render.
const EMPTY_MESSAGES: InboxMessage[] = [];
const EMPTY_CALLS: TimelineCall[] = [];

/** Código único de um envio (17a): repetir o mesmo pedido nunca reenvia. */
function newRequestId(): string {
  const c = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Ecrã tátil (telemóvel/tablet): Enter muda de linha, só o botão envia. */
const COARSE_POINTER = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

/** Badge de opt-out (pediu STOP). */
function OptedOutBadge() {
  return (
    <Badge variant="outline" className="h-4 px-1 text-[10px] gap-0.5 border-red-300 text-red-700 dark:border-red-800 dark:text-red-300 shrink-0">
      <BellOff className="h-2.5 w-2.5" /> Não quer mensagens
    </Badge>
  );
}

// ─── Página ─────────────────────────────────────────────────────────────────

export default function WhatsAppInboxPage() {
  const isMobile = useIsMobile();
  const openEmployee = useOpenEmployee();
  // ?c=<id> (pesquisa global) abre logo a conversa.
  const [selectedId, setSelectedId] = useState<number | null>(() => Number(new URLSearchParams(window.location.search).get("c")) || null);
  // Um rascunho por conversa (F11): a sugestão da IA e o "limpar" depois de
  // enviar vão para a conversa a que pertencem, mesmo que já se esteja noutra.
  const [drafts, setDrafts] = useState<WhatsAppDrafts>({});
  const setDraft = (id: number, v: string | ((prev: string) => string)) => setDrafts((d) => withDraft(d, id, v));
  const text = selectedId != null ? drafts[selectedId] ?? "" : "";
  const setText = (v: string | ((prev: string) => string)) => { if (selectedId != null) setDraft(selectedId, v); };
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const [tplOpen, setTplOpen] = useState(false);
  // Template escolhido do CATÁLOGO (shared/whatsappTemplate.ts) — nunca nome/língua à mão.
  const [tplId, setTplId] = useState(DEFAULT_WHATSAPP_TEMPLATE_ID);
  // {{2}} do body (o {{1}} é sempre o nome de quem recebe, resolvido no servidor).
  const [tplParam2, setTplParam2] = useState("");
  // Semana do link do formulário (só templates de semana com botão de link).
  const [tplWeekStart, setTplWeekStart] = useState("");
  const pageVisible = usePageVisible();
  const [now, setNow] = useState(() => Date.now());
  // Pesquisa por nome ou número: filtra já o que está na lista e vai ao
  // servidor (17a) — a lista só traz as INBOX_LIST_LIMIT conversas mais recentes.
  const [search, setSearch] = useState(() => (new URLSearchParams(window.location.search).get("q") ?? "").slice(0, 120));
  const [serverSearch, setServerSearch] = useState(() => search.trim());
  useEffect(() => {
    const t = setTimeout(() => setServerSearch(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);
  // Código do envio em curso por conversa: repetir com o MESMO texto (rede que
  // falhou) reutiliza-o — o servidor não manda a mensagem duas vezes.
  const replyReqIds = useRef(new Map<number, { text: string; id: string }>());
  const [tplReqId, setTplReqId] = useState(() => newRequestId());
  // Filtros locais, todos em AND com a pesquisa: responsável + estado (0097),
  // só não lidas, só com alerta (SLA / janela a fechar), intenção e urgência
  // (triagem IA). A conversa ABERTA fica sempre à vista: abrir marca como lida
  // e sem isto a linha desaparecia debaixo do clique.
  const { user } = useAuth();
  const [filters, setFilters] = useState<InboxListFilters>(DEFAULT_INBOX_FILTERS);
  const patchFilters = (patch: Partial<InboxListFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const [contextOpen, setContextOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [aiSummaryOf, setAiSummary] = useState<{ conversationId: number; text: string } | null>(null);
  const aiSummary = aiSummaryOf && aiSummaryOf.conversationId === selectedId ? aiSummaryOf.text : null;
  // Chamadas de voz (WhatsApp Calling API): "Ligar" e "Por devolver" (?chamadas=1 abre a lista).
  const [callOpen, setCallOpen] = useState(false);
  const [callbacksOpen, setCallbacksOpen] = useState(() => new URLSearchParams(window.location.search).get("chamadas") === "1");
  // Muda quando ESTE utilizador envia → a conversa volta ao fim mesmo que estivesse a ler acima.
  const [stickSignal, setStickSignal] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // Tick para o countdown da janela (a cada 30s).
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const conversations = trpc.whatsapp.conversations.list.useQuery(serverSearch ? { search: serverSearch } : undefined, {
    refetchInterval: pageVisible ? POLL_MS : false,
    placeholderData: (prev) => prev,
  });
  const thread = trpc.whatsapp.messages.byConversation.useQuery(
    { conversationId: selectedId ?? 0 },
    { enabled: selectedId != null, refetchInterval: pageVisible ? POLL_MS : false },
  );

  const utils = trpc.useUtils();
  const canEditWa = !!user && can(user as any, "whatsapp", "edit");
  // Interruptor WHATSAPP_CALLS (desligado por omissão): sem ele não aparece "Ligar".
  const callsFlag = trpc.whatsapp.calls.enabled.useQuery(undefined, { enabled: canEditWa, staleTime: 5 * 60_000, retry: false });
  const callsOn = !!callsFlag.data?.enabled;
  const convCalls = trpc.whatsapp.calls.byConversation.useQuery(
    { conversationId: selectedId ?? 0 },
    { enabled: selectedId != null, refetchInterval: pageVisible ? POLL_MS : false, retry: false },
  );
  const pendingCallbacks = trpc.whatsapp.calls.pendingCallbacks.useQuery(undefined, {
    refetchInterval: pageVisible ? 60_000 : false,
    retry: false,
  });
  const meta = trpc.whatsapp.inboxMeta.useQuery(undefined, { staleTime: 10 * 60_000 });
  const slaMinutes = meta.data?.slaMinutes ?? 15;
  // Responsáveis possíveis PARA ESTA conversa: quem responde e vê a cidade dela (17a).
  const assignees = trpc.whatsapp.assignees.useQuery(
    { conversationId: selectedId ?? undefined },
    { enabled: selectedId != null, staleTime: 5 * 60_000 },
  );
  const quickReplies = trpc.whatsapp.quickReplies.list.useQuery(undefined, { staleTime: 60_000 });
  // Caixas por tema (17f): filtro da lista e "Mover para…".
  const boxes = trpc.whatsapp.conversations.boxes.useQuery(undefined, { staleTime: 5 * 60_000 });
  const boxLabels = new Map((boxes.data ?? []).map((b) => [b.key, b.label]));
  const setBox = trpc.whatsapp.conversations.setBox.useMutation({
    onSuccess: () => { toast.success("Conversa movida."); refreshAll(); },
    onError: (e) => toast.error(e.message),
  });
  /** Depois de qualquer mudança: lista, conversa aberta e badge do menu. */
  function refreshAll() {
    conversations.refetch();
    if (selectedId != null) thread.refetch();
    if (selectedId != null) convCalls.refetch();
    utils.whatsapp.badge.invalidate();
  }

  const markRead = trpc.whatsapp.markRead.useMutation({
    onSuccess: () => {
      conversations.refetch();
      utils.whatsapp.badge.invalidate();
    },
  });
  const setStatus = trpc.whatsapp.setStatus.useMutation({
    onSuccess: (_r, v) => {
      toast.success(`Conversa marcada como ${CONVERSATION_STATUS_LABELS[v.status].toLowerCase()}.`);
      refreshAll();
    },
    onError: (e) => toast.error(e.message),
  });
  const assign = trpc.whatsapp.assign.useMutation({
    onSuccess: () => refreshAll(),
    onError: (e) => toast.error(e.message),
  });
  const aiAssist = trpc.whatsapp.aiAssist.useMutation({
    onSuccess: (r, v) => {
      const here = selectedRef.current === v.conversationId;
      if (v.mode === "summary") { if (here) setAiSummary({ conversationId: v.conversationId, text: r.text }); }
      else {
        setDraft(v.conversationId, r.text);
        if (here) {
          setTimeout(() => composerRef.current?.focus(), 0);
          toast.success("Sugestão no composer — revê antes de enviar.");
        } else toast.success("Sugestão da IA pronta — fica no composer da conversa onde a pediste.");
      }
    },
    onError: (e) => toast.error(e.message),
  });
  // "Marcar como não lida": fecha a thread (abrir volta a marcar como lida) e
  // a conversa regressa ao filtro "Não lidas" com o badge verde.
  const markUnread = trpc.whatsapp.markUnread.useMutation({
    onSuccess: (_r, v) => {
      setSelectedId(null);
      setDraft(v.conversationId, "");
      conversations.refetch();
      utils.whatsapp.badge.invalidate();
      toast.success("Conversa marcada como não lida.");
    },
    onError: (e) => toast.error(e.message),
  });
  const reply = trpc.whatsapp.reply.useMutation({
    onSuccess: (r, v) => {
      // Enviada ou "sem confirmação": o texto sai do composer (a mensagem já
      // está na conversa) — voltar a carregar em Enter não a reenvia.
      replyReqIds.current.delete(v.conversationId);
      setDraft(v.conversationId, "");
      setStickSignal((n) => n + 1);
      refreshAll();
      if (!r.ok && r.uncertain) toast.warning(r.error || "Sem confirmação da Meta: a mensagem pode ter chegado. Confirma antes de enviar outra vez.", { duration: 10_000 });
    },
    // Falhou de certeza (ou a rede caiu): o texto fica; tentar outra vez com o
    // mesmo texto usa o mesmo código e o servidor não duplica.
    onError: (e) => toast.error(e.message),
  });
  const sendTemplate = trpc.whatsapp.sendTemplate.useMutation({
    onSuccess: (r) => {
      if (r.sent) toast.success("Template enviado.");
      else toast.error(r.recipients[0]?.error || "Falha ao enviar template.");
      setTplReqId(newRequestId());
      setTplOpen(false);
      setStickSignal((n) => n + 1);
      thread.refetch();
      conversations.refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  function openConversation(id: number) {
    setSelectedId(id);
    setAiSummary(null);
    markRead.mutate({ conversationId: id });
  }
  // Aberta por link (?c=, pesquisa global): também conta como lida (17a).
  useEffect(() => {
    if (selectedId != null) markRead.mutate({ conversationId: selectedId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allConversations = conversations.data ?? [];
  const hasSearch = search.trim().length > 0;
  // Alertas (SLA / janela) calculados com as MESMAS regras do servidor.
  const alertsById = useMemo(() => {
    const m = new Map<number, ReturnType<typeof conversationAlerts>>();
    for (const c of allConversations) m.set(c.id, conversationAlerts(c, now, slaMinutes));
    return m;
  }, [allConversations, now, slaMinutes]);
  const scoped = allConversations.filter((c) =>
    matchesInboxFilters(c, { assignee: filters.assignee, status: filters.status, userId: user?.id }),
  );
  const counts = {
    unread: scoped.filter((c) => c.unreadCount > 0).length,
    overdue: scoped.filter((c) => alertsById.get(c.id)?.overdue).length,
    closing: scoped.filter((c) => alertsById.get(c.id)?.windowClosing).length,
    urgent: scoped.filter((c) => c.aiUrgency === "urgente" && c.status !== "resolvido").length,
    mine: allConversations.filter((c) => c.assignedUserId != null && c.assignedUserId === user?.id && c.status !== "resolvido").length,
  };
  const searchLower = search.trim().toLowerCase();
  // A conversa ABERTA fica sempre à vista (ex.: acabou de ser resolvida).
  const scopedIds = new Set(scoped.map((c) => c.id));
  const convList = allConversations.filter((c) => {
    const a = alertsById.get(c.id);
    return (
      (scopedIds.has(c.id) || c.id === selectedId) &&
      (!hasSearch ||
        matchesContactQuery(search, { name: c.name, phone: c.phoneE164 }) ||
        (c.assignedName ?? "").toLowerCase().includes(searchLower) ||
        (c.preview ?? "").toLowerCase().includes(searchLower)) &&
      (!filters.onlyUnread || c.unreadCount > 0 || c.id === selectedId) &&
      (!filters.onlyAlerts || a?.overdue || a?.windowClosing || c.id === selectedId) &&
      (filters.intent === "all" || c.aiIntent === filters.intent || c.id === selectedId) &&
      (matchesBoxFilter(c.boxKey, filters.box) || c.id === selectedId) &&
      (!filters.onlyUrgent || c.aiUrgency === "urgente" || c.id === selectedId)
    );
  });

  // Atalhos: "/" pesquisa · Esc fecha a conversa · Alt+↑/↓ conversa anterior/seguinte.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      // `defaultPrevented`: o Esc já fechou um popover/menu/select (Radix) — não fecha também a conversa.
      if (e.key === "Escape" && !e.defaultPrevented && !typing && selectedId != null && !tplOpen && !contextOpen && !quickOpen) {
        setSelectedId(null);
        return;
      }
      if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        const ordered = [...convList.filter((c) => c.windowState === "open"), ...convList.filter((c) => c.windowState !== "open")];
        if (!ordered.length) return;
        e.preventDefault();
        const idx = ordered.findIndex((c) => c.id === selectedId);
        const next = e.key === "ArrowDown" ? Math.min(ordered.length - 1, idx + 1) : Math.max(0, idx < 0 ? 0 : idx - 1);
        if (ordered[next] && ordered[next].id !== selectedId) openConversation(ordered[next].id);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // A ordem vem do servidor (`sortConversations`): janela aberta primeiro, da
  // que fecha mais cedo para a que fecha mais tarde; depois as restantes pela
  // última mensagem. Aqui só se AGRUPA para o cabeçalho de cada bloco — o
  // filtro de pesquisa preserva a ordem, por isso a partição também.
  const openList = convList.filter((c) => c.windowState === "open");
  const closedList = convList.filter((c) => c.windowState !== "open");
  const t = thread.data;
  // Enquanto a thread carrega, o cabeçalho usa a linha da lista (nome + foto já conhecidos).
  const selectedRow = selectedId != null ? allConversations.find((c) => c.id === selectedId) : undefined;
  const headerName = t?.name ?? selectedRow?.name ?? "…";
  const headerPhoto = t?.photoUrl ?? selectedRow?.photoUrl ?? null;
  const windowState: WindowState | undefined = t?.windowState;
  const threadAlerts = t ? conversationAlerts(t, now, slaMinutes) : null;
  const aiConfigured = meta.data?.aiConfigured === true;

  // Composer cresce com o texto até COMPOSER_MAX_PX (fallback para browsers sem `field-sizing`).
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el || SUPPORTS_FIELD_SIZING) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_PX)}px`;
  }, [text, selectedId]);

  function insertQuickReply(body: string) {
    const filled = fillQuickReply(body, t?.recipientFirstName);
    setText((prev) => (prev.trim() ? `${prev.replace(/\s+$/, "")}\n${filled}` : filled));
    setTimeout(() => composerRef.current?.focus(), 0);
  }

  // ── Template: catálogo + pré-visualização com o nome REAL do contacto ──
  const tplDef = findWhatsAppTemplate(tplId) ?? WHATSAPP_TEMPLATES[0];
  const templatePreview = trpc.whatsapp.templatePreview.useQuery(
    { templateName: tplDef.name, languageCode: tplDef.language },
    { enabled: tplOpen, staleTime: 5 * 60_000, retry: false },
  );
  const tplRecipientName = t?.recipientFirstName ?? "colega";
  const tplPreviewText = useMemo(() => {
    const p = templatePreview.data;
    if (!p?.ok) return null;
    // MESMOS papéis que o envio usa — o preview não pode contar outra história.
    const slots = resolveBodyParamRoles(p.paramNames, p.paramCount, tplDef.roles);
    return previewTemplateBody(p.bodyText, slots, { recipient: tplRecipientName, shared: tplParam2 });
  }, [templatePreview.data, tplDef, tplRecipientName, tplParam2]);
  const tplNeedsWeek = !!(templatePreview.data?.ok && templatePreview.data.hasDynamicUrlButton);
  const tplMissing =
    (!!tplDef.sharedParam && !tplParam2.trim()) || (tplNeedsWeek && !/^\d{4}-\d{2}-\d{2}$/.test(tplWeekStart));

  function openTemplateDialog() {
    setTplParam2("");
    setTplWeekStart("");
    setTplReqId(newRequestId());
    setTplOpen(true);
  }

  function submitReply() {
    if (!text.trim() || selectedId == null || reply.isPending) return;
    const body = text.trim();
    const prev = replyReqIds.current.get(selectedId);
    const clientRequestId = prev && prev.text === body ? prev.id : newRequestId();
    replyReqIds.current.set(selectedId, { text: body, id: clientRequestId });
    // Contacto que pediu STOP: texto livre só depois de confirmar (ex.: responder a uma dúvida dele).
    if (t?.optedOut) {
      const ok = window.confirm(
        "Este contacto pediu para não receber mensagens (STOP). Enviar mesmo assim esta resposta?",
      );
      if (!ok) return;
      reply.mutate({ conversationId: selectedId, text: body, confirmOptedOut: true, clientRequestId });
      return;
    }
    reply.mutate({ conversationId: selectedId, text: body, clientRequestId });
  }

  function groupHeader(label: string, count: number, tone: "open" | "closed") {
    return (
      <div
        className={cn(
          "sticky top-0 z-10 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide border-b backdrop-blur",
          tone === "open"
            ? "bg-green-50/95 dark:bg-green-950/80 text-green-800 dark:text-green-300"
            : "bg-muted/95 text-muted-foreground",
        )}
      >
        {label} · {count}
      </div>
    );
  }

  const conversationRow = (c: (typeof convList)[number]) => (
    <ConversationListItem
      key={c.id}
      c={c}
      alerts={alertsById.get(c.id)}
      selected={selectedId === c.id}
      boxLabel={c.boxKey ? boxLabels.get(c.boxKey) ?? null : null}
      now={now}
      slaMinutes={slaMinutes}
      onOpen={openConversation}
    />
  );

  // ── Coluna esquerda: lista de conversas ──
  const listColumn = (
    <div className="flex flex-col h-full border-r min-w-0">
      <InboxListHeader
        search={search}
        onSearchChange={setSearch}
        searchRef={searchRef}
        filters={filters}
        onFiltersChange={patchFilters}
        onClearFilters={() => setFilters(DEFAULT_INBOX_FILTERS)}
        counts={counts}
        slaMinutes={slaMinutes}
        shownCount={convList.length}
        isFetching={conversations.isFetching}
        showShortcuts={!isMobile}
        pendingCallbacks={pendingCallbacks.data?.length ?? 0}
        pendingCallbacksError={callsOn && !!pendingCallbacks.error}
        onOpenCallbacks={() => setCallbacksOpen(true)}
        boxes={boxes.data ?? []}
      />
      <div className="flex-1 overflow-y-auto overscroll-contain">
        {conversations.error && (
          <div className="p-2">
            <QueryErrorNote error={conversations.error} onRetry={() => conversations.refetch()} retrying={conversations.isFetching} what="as conversas" />
          </div>
        )}
        {allConversations.some((c) => c.partial) && (
          <div className="mx-2 mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
            Leitura parcial: o estado, o responsável e as ligações das conversas não estão disponíveis agora.
          </div>
        )}
        {!serverSearch && allConversations.length >= INBOX_LIST_LIMIT && (
          <div className="mx-2 mt-2 text-[11px] text-muted-foreground">
            Mostra as {INBOX_LIST_LIMIT} conversas mais recentes. Para uma mais antiga, pesquisa pelo nome ou número.
          </div>
        )}
        {convList.length === 0 && !conversations.error && (
          <div className="p-4 text-sm text-muted-foreground text-center">
            {conversations.isLoading
              ? "A carregar…"
              : hasSearch
                ? `Sem resultados para “${search.trim()}”${filters.onlyUnread ? " entre as não lidas" : ""}.`
                : filters.onlyUnread
                  ? "Sem mensagens por ler."
                  : filters.onlyAlerts
                    ? "Sem conversas com alerta."
                    : allConversations.length
                      ? "Nenhuma conversa com estes filtros."
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

  // ── Banner (uma linha) + composer por estado de janela ──
  function templateButton() {
    if (!t) return null;
    return (
      <Button
        size="sm"
        variant="outline"
        className="ml-auto h-6 px-2 text-[11px] shrink-0 bg-background"
        disabled={t.optedOut}
        title={t.optedOut ? "Este contacto pediu para não receber mensagens" : "Enviar um template aprovado"}
        onClick={openTemplateDialog}
      >
        <Send className="h-3 w-3 mr-1" /> Enviar template
      </Button>
    );
  }

  function windowBanner() {
    if (!t) return null;
    const optOutNote = t.optedOut ? (
      <div
        className="flex items-center gap-1.5 px-3 py-1 text-[11px] bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300 border-t"
        title="Pediu para parar. Templates bloqueados; texto livre só com confirmação. Volta a receber se responder INICIAR."
      >
        <BellOff className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0">
          <strong>Não quer mensagens</strong> — templates bloqueados; texto livre só com confirmação. Volta se responder INICIAR.
        </span>
      </div>
    ) : null;
    if (windowState === "awaiting_first_reply") {
      return (
        <>
          {optOutNote}
          <div className="flex items-center gap-1.5 px-3 py-1 text-[11px] bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 border-t">
            <Hourglass className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0">
              <strong>A aguardar a 1.ª resposta</strong> — só templates até o contacto responder.
            </span>
            {templateButton()}
          </div>
        </>
      );
    }
    if (windowState === "open") {
      const closing = !!threadAlerts?.windowClosing;
      return (
        <>
          {optOutNote}
          <div
            className={cn(
              "flex items-center gap-1.5 px-3 py-1 text-[11px] border-t",
              closing
                ? "bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300"
                : "bg-green-50/70 dark:bg-green-950/20 text-green-800 dark:text-green-300",
            )}
          >
            <Timer className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0">
              <strong>Janela aberta</strong> — fecha em {windowCountdown(t.windowExpiresAt, now)}.
              {closing && " Responde antes que feche — depois só com template."}
            </span>
          </div>
        </>
      );
    }
    // expired
    return (
      <>
        {optOutNote}
        <div className="flex items-center gap-1.5 px-3 py-1 text-[11px] bg-muted text-muted-foreground border-t">
          <Lock className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">
            <strong>Janela de 24h fechada</strong> — só é possível reiniciar com um template.
          </span>
          {templateButton()}
        </div>
      </>
    );
  }

  function composer() {
    // Leitura da conversa falhou: não se sabe a janela — não se fala de "janela fechada".
    const threadFailed = !!thread.error && !t;
    const disabled = windowState !== "open";
    return (
      <div className="px-2 py-2 border-t shrink-0 bg-muted/30">
        <div className="flex gap-1.5 items-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-9 w-9 shrink-0 text-muted-foreground"
                disabled={disabled}
                title="Respostas rápidas"
                aria-label="Respostas rápidas"
              >
                <Zap className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" className="w-72 max-h-80 overflow-y-auto">
              <DropdownMenuLabel className="text-xs">Respostas rápidas</DropdownMenuLabel>
              {quickReplies.error ? (
                <div className="px-2 py-1.5 text-xs text-red-700 dark:text-red-300">Não foi possível carregar as respostas rápidas.</div>
              ) : (quickReplies.data ?? []).length === 0 && !quickReplies.isLoading && (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">Ainda não há respostas rápidas.</div>
              )}
              {(quickReplies.data ?? []).map((r) => (
                <DropdownMenuItem key={r.id} onSelect={() => insertQuickReply(r.body)} className="flex-col items-start gap-0">
                  <span className="text-sm font-medium truncate max-w-full">{r.title}</span>
                  <span className="text-[11px] text-muted-foreground line-clamp-1 max-w-full">{fillQuickReply(r.body, t?.recipientFirstName)}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setQuickOpen(true)}>
                <Settings2 className="h-3.5 w-3.5 mr-2" /> Gerir respostas rápidas…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {aiConfigured && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0 text-muted-foreground"
              disabled={disabled || aiAssist.isPending || selectedId == null}
              title="Sugerir resposta com IA (fica no composer para rever)"
              aria-label="Sugerir resposta com IA"
              onClick={() => selectedId != null && aiAssist.mutate({ conversationId: selectedId, mode: "reply" })}
            >
              {aiAssist.isPending && aiAssist.variables?.mode === "reply" && aiAssist.variables.conversationId === selectedId ? (
                <Clock className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
            </Button>
          )}
          <Textarea
            ref={composerRef}
            rows={1}
            aria-label="Mensagem"
            className="resize-none min-h-9 max-h-40 overflow-y-auto py-2 leading-5 bg-background"
            placeholder={
              threadFailed
                ? "Não foi possível carregar a conversa."
                : disabled
                  ? "Composer desativado — janela fechada."
                  : isMobile || COARSE_POINTER
                    ? "Escreve uma mensagem…"
                    : "Escreve uma mensagem… (Shift+Enter muda de linha)"
            }
            value={text}
            disabled={disabled || reply.isPending}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // No telemóvel não há Shift+Enter: Enter muda de linha e só o botão envia (17a).
              if (isMobile || COARSE_POINTER) return;
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !disabled) {
                e.preventDefault();
                submitReply();
              }
            }}
          />
          <Button
            size="icon"
            className="h-9 w-9 rounded-full bg-green-700 hover:bg-green-800 text-white shrink-0"
            disabled={disabled || !text.trim() || reply.isPending || selectedId == null}
            onClick={submitReply}
            aria-label="Enviar mensagem"
            title="Enviar (Enter)"
          >
            {reply.isPending ? <Clock className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    );
  }

  // ── Cabeçalho da conversa: identidade + ações numa linha ──
  const statusSelect = t && (
    <Select
      value={t.status}
      onValueChange={(v) => setStatus.mutate({ conversationId: t.conversationId, status: v as ConversationStatus })}
      disabled={setStatus.isPending}
    >
      <SelectTrigger size="sm" className="w-[108px] text-xs" aria-label="Estado da conversa">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="aberto">Aberta</SelectItem>
        <SelectItem value="pendente">Pendente</SelectItem>
        <SelectItem value="resolvido">Resolvida</SelectItem>
      </SelectContent>
    </Select>
  );

  const assigneeSelect = t && (
    <Select
      value={t.assignedUserId != null ? String(t.assignedUserId) : "none"}
      onValueChange={(v) => assign.mutate({ conversationId: t.conversationId, userId: v === "none" ? null : Number(v) })}
      disabled={assign.isPending}
    >
      <SelectTrigger size="sm" className="w-[150px] min-w-0 text-xs" aria-label="Responsável" title="Responsável">
        <UserRound className="h-3.5 w-3.5 shrink-0" />
        <SelectValue placeholder="Responsável" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">Sem responsável</SelectItem>
        {assignees.error && <div className="px-2 py-1.5 text-xs text-red-700">Não foi possível carregar a lista.</div>}
        {(assignees.data ?? []).map((u) => (
          <SelectItem key={u.id} value={String(u.id)}>
            {u.id === user?.id ? `${u.name} (eu)` : u.name}
          </SelectItem>
        ))}
        {t.assignedUserId != null && !(assignees.data ?? []).some((u) => u.id === t.assignedUserId) && (
          <SelectItem value={String(t.assignedUserId)}>Utilizador #{t.assignedUserId}</SelectItem>
        )}
      </SelectContent>
    </Select>
  );

  const boxSelect = t && (boxes.data?.length ?? 0) > 0 && (
    <Select
      value={selectedRow?.boxKey ?? "geral"}
      onValueChange={(v) => setBox.mutate({ conversationId: t.conversationId, boxKey: v === "geral" ? null : v })}
      disabled={setBox.isPending}
    >
      <SelectTrigger size="sm" className="w-[130px] min-w-0 text-xs" aria-label="Caixa" title="Caixa (tema) — mudar move a conversa">
        <Inbox className="h-3.5 w-3.5 shrink-0" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="geral">Geral</SelectItem>
        {(boxes.data ?? []).map((b) => <SelectItem key={b.key} value={b.key}>{b.label}</SelectItem>)}
        {selectedRow?.boxKey && !boxLabels.has(selectedRow.boxKey) && <SelectItem value={selectedRow.boxKey}>{selectedRow.boxKey}</SelectItem>}
      </SelectContent>
    </Select>
  );

  const resolveButton = t && t.status !== "resolvido" && (
    <Button
      size="sm"
      variant="outline"
      className="h-8 px-2 text-xs shrink-0"
      disabled={setStatus.isPending}
      title="Marcar como resolvida (volta a abrir se o contacto escrever)"
      aria-label="Resolver"
      onClick={() => setStatus.mutate({ conversationId: t.conversationId, status: "resolvido" })}
    >
      <CheckCheck className="h-3.5 w-3.5" />
      <span className="hidden xl:inline ml-1">Resolver</span>
    </Button>
  );

  const linked = !!(t?.linkedBookingRef || t?.linkedClientEmail);
  const contextButton = t && (
    <Button
      size="sm"
      variant={linked ? "secondary" : "ghost"}
      className="h-8 px-2 text-xs shrink-0"
      title={
        t.linkedBookingRef
          ? `Reserva ligada${t.linkedBookingLabel ? `: ${t.linkedBookingLabel}` : ""} — reservas, reclamações e perdidos deste número`
          : t.linkedClientEmail
            ? `Cliente ligado: ${t.linkedClientEmail} — reservas, reclamações e perdidos deste número`
            : "Reservas, reclamações e perdidos deste número; ligar a uma reserva ou cliente"
      }
      aria-label="Contexto"
      onClick={() => setContextOpen(true)}
    >
      <Link2 className="h-3.5 w-3.5" />
      <span className={cn("ml-1", linked ? "hidden lg:inline" : "hidden xl:inline")}>
        {t.linkedBookingRef ? "Reserva ligada" : t.linkedClientEmail ? "Cliente ligado" : "Contexto"}
      </span>
    </Button>
  );

  const callButton = t && canEditWa && callsOn && (
    <Button
      size="icon"
      variant="ghost"
      className="h-8 w-8 shrink-0 text-green-700 hover:text-green-800 dark:text-green-400"
      title="Chamada de voz pelo WhatsApp (pede autorização ao cliente se for preciso)"
      aria-label="Ligar"
      onClick={() => setCallOpen(true)}
    >
      <Phone className="h-4 w-4" />
    </Button>
  );

  const moreMenu = t && (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label="Mais ações" title="Mais ações">
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {aiConfigured && (
          <DropdownMenuItem
            disabled={aiAssist.isPending || !t.messages.length}
            onSelect={() => aiAssist.mutate({ conversationId: t.conversationId, mode: "summary" })}
          >
            {aiAssist.isPending && aiAssist.variables?.mode === "summary" && aiAssist.variables.conversationId === selectedId ? (
              <Clock className="h-3.5 w-3.5 mr-2 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5 mr-2" />
            )}
            Resumo da conversa (IA)
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => setContextOpen(true)}>
          <Link2 className="h-3.5 w-3.5 mr-2" /> Contexto e ligações…
        </DropdownMenuItem>
        {t.employeeId != null && (
          <DropdownMenuItem onSelect={() => openEmployee(t.employeeId!)}>
            <UserRound className="h-3.5 w-3.5 mr-2" /> Abrir ficha do colaborador
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={markUnread.isPending}
          onSelect={() => markUnread.mutate({ conversationId: t.conversationId })}
          title="Volta a pôr esta conversa em “Não lidas” para retomar mais tarde"
        >
          <MailOpen className="h-3.5 w-3.5 mr-2" /> Marcar como não lida
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // ── Coluna direita: thread ──
  const threadColumn = (
    <div className="flex flex-col h-full min-w-0 flex-1">
      {selectedId == null ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground text-sm bg-[#efeae2]/40 dark:bg-zinc-950">
          <MessageCircle className="h-10 w-10 text-green-600/50" />
          Escolhe uma conversa à esquerda.
        </div>
      ) : (
        <>
          <div className="px-2 sm:px-3 py-2 border-b flex items-center gap-2 shrink-0 min-h-14">
            {isMobile && (
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label="Voltar às conversas" onClick={() => setSelectedId(null)}>
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            <ContactAvatar name={headerName} photoUrl={headerPhoto} className="h-9 w-9 text-sm" />
            <div className="min-w-0 flex-1">
              {t?.employeeId ? (
                // Mesmo padrão das outras páginas (Extras-Dia, Avaliação): o nome
                // abre a ficha do colaborador em /rh via useOpenEmployee.
                <button
                  type="button"
                  className="block font-semibold text-sm truncate max-w-full text-left hover:underline"
                  title="Abrir ficha do funcionário"
                  onClick={() => openEmployee(t.employeeId)}
                >
                  {headerName}
                </button>
              ) : (
                <div className="font-semibold text-sm truncate" title={t ? "Número sem ficha de colaborador associada" : undefined}>
                  {headerName}
                </div>
              )}
              {(t || selectedRow) && (
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground min-w-0">
                  <span className="truncate tabular-nums">{t?.phoneE164 ?? selectedRow?.phoneE164}</span>
                  {t?.optedOut && <OptedOutBadge />}
                  {threadAlerts?.overdue && (
                    <span
                      className="inline-flex items-center gap-0.5 text-red-600 dark:text-red-400 font-medium shrink-0"
                      title={`Sem resposta há mais de ${slaMinutes} min`}
                    >
                      <AlarmClock className="h-3 w-3" /> Sem resposta · {formatWaiting(threadAlerts.waitingMinutes)}
                    </span>
                  )}
                </div>
              )}
            </div>
            {t && (
              <div className="flex items-center gap-1 shrink-0">
                {!isMobile && boxSelect}
                {!isMobile && statusSelect}
                {!isMobile && assigneeSelect}
                {!isMobile && resolveButton}
                {callButton}
                {contextButton}
                {moreMenu}
              </div>
            )}
          </div>

          {/* Telemóvel: estado + responsável numa 2.ª linha (não cabem ao lado do nome). */}
          {isMobile && t && (
            <div className="px-2 py-1.5 border-b flex flex-wrap items-center gap-1.5 shrink-0">
              {boxSelect && <div className="w-full [&>button]:w-full">{boxSelect}</div>}
              {statusSelect}
              <div className="flex-1 min-w-0 [&>button]:w-full">{assigneeSelect}</div>
              {resolveButton}
            </div>
          )}

          {aiSummary && (
            <div className="px-3 py-2 border-b text-xs bg-violet-50 dark:bg-violet-950/30 text-violet-900 dark:text-violet-200 shrink-0 flex gap-2">
              <Sparkles className="h-4 w-4 shrink-0 mt-0.5" />
              <div className="whitespace-pre-wrap flex-1 max-h-32 overflow-y-auto">{aiSummary}</div>
              <button type="button" aria-label="Fechar resumo" className="shrink-0 opacity-70 hover:opacity-100" onClick={() => setAiSummary(null)}>
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {thread.error && (
            <div className="px-3 py-2 border-b shrink-0">
              <QueryErrorNote error={thread.error} onRetry={() => thread.refetch()} retrying={thread.isFetching} what="esta conversa" />
            </div>
          )}
          {callsOn && convCalls.error && !thread.error && (
            <div className="px-3 py-2 border-b shrink-0">
              <QueryErrorNote error={convCalls.error} onRetry={() => convCalls.refetch()} retrying={convCalls.isFetching} what="as chamadas desta conversa" />
            </div>
          )}

          <MessageThread
            conversationId={selectedId}
            messages={t?.messages ?? EMPTY_MESSAGES}
            calls={convCalls.data ?? EMPTY_CALLS}
            ready={t?.conversationId === selectedId}
            isLoading={thread.isLoading}
            now={now}
            stickSignal={stickSignal}
          />

          {windowBanner()}
          {composer()}
        </>
      )}
    </div>
  );

  return (
    <div className="space-y-3">
      <Card className="overflow-hidden p-0 gap-0">
        {/* Altura: ecrã inteiro menos a barra de topo (4rem) e o padding do layout;
            no telemóvel também a tab bar e o botão do assistente. */}
        <div className="flex h-[calc(100dvh-14rem)] md:h-[calc(100dvh-9.5rem)] min-h-[420px]">
          {isMobile ? (
            selectedId == null ? (
              <div className="flex-1 min-w-0">{listColumn}</div>
            ) : (
              threadColumn
            )
          ) : (
            <>
              <div className="w-[340px] xl:w-[380px] shrink-0">{listColumn}</div>
              {threadColumn}
            </>
          )}
        </div>
      </Card>

      <WhatsAppContextSheet
        conversationId={selectedId}
        contactName={t?.name ?? "contacto"}
        open={contextOpen && selectedId != null}
        onOpenChange={setContextOpen}
        onLinked={refreshAll}
      />
      <QuickRepliesDialog open={quickOpen} onOpenChange={setQuickOpen} />
      {t && selectedId != null && (
        <CallContactDialog
          open={callOpen}
          onOpenChange={setCallOpen}
          conversationId={t.conversationId}
          name={t.name}
          subtitle={t.phoneE164}
        />
      )}
      <PendingCallbacksDialog
        open={callbacksOpen}
        onOpenChange={(v) => { setCallbacksOpen(v); if (!v) void pendingCallbacks.refetch(); }}
        onOpenConversation={openConversation}
        canEdit={canEditWa}
        isSuperAdmin={user?.role === "super_admin"}
      />

      {/* Dialog de template (janela fechada ou ainda sem resposta) */}
      <Dialog open={tplOpen} onOpenChange={(open) => { if (!sendTemplate.isPending) setTplOpen(open); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="h-5 w-5 text-green-600" /> Enviar template
            </DialogTitle>
            <DialogDescription>
              {windowState === "awaiting_first_reply"
                ? `Ainda sem resposta de ${t?.name ?? "este contacto"} — só é possível escrever com um template aprovado.`
                : `A janela de 24h está fechada. Com um template aprovado podes voltar a contactar ${t?.name ?? "este contacto"}; o texto livre só volta quando ele responder.`}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Template</Label>
              <Select value={tplDef.id} onValueChange={(v) => { setTplId(v); setTplParam2(""); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {WHATSAPP_TEMPLATES.map((d) => (
                    <SelectItem key={d.id} value={d.id}>{d.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">{tplDef.description}</p>
            </div>
            {tplDef.sharedParam && (
              <div className="space-y-1">
                <Label className="text-xs">{tplDef.sharedParam.label}</Label>
                <Input
                  value={tplParam2}
                  onChange={(e) => setTplParam2(e.target.value)}
                  placeholder={tplDef.sharedParam.placeholder}
                />
              </div>
            )}
            {tplNeedsWeek && (
              <div className="space-y-1">
                <Label className="text-xs">Semana do formulário (segunda-feira)</Label>
                <Input type="date" value={tplWeekStart} onChange={(e) => setTplWeekStart(e.target.value)} />
                <p className="text-[11px] text-muted-foreground">O botão do template leva o link pessoal do formulário desta semana.</p>
              </div>
            )}
            <div className="space-y-1">
              <Label className="text-xs">Pré-visualização (para {tplRecipientName})</Label>
              {templatePreview.isLoading ? (
                <p className="text-xs text-muted-foreground">A ler o template na Meta…</p>
              ) : tplPreviewText ? (
                <div className="rounded-md bg-[#d9fdd3] dark:bg-[#005c4b] text-zinc-900 dark:text-zinc-50 p-2.5 text-[13px] leading-[1.4] whitespace-pre-wrap max-h-64 overflow-y-auto">
                  {tplPreviewText}
                </div>
              ) : (
                <p className="text-xs text-amber-600">
                  {templatePreview.data && !templatePreview.data.ok
                    ? templatePreview.data.reason
                    : "Pré-visualização indisponível — o envio continua a funcionar."}
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setTplOpen(false)} disabled={sendTemplate.isPending}>
              Cancelar
            </Button>
            <Button
              className="bg-green-700 hover:bg-green-800 text-white"
              disabled={!t || t.optedOut || tplMissing || sendTemplate.isPending}
              onClick={() =>
                t &&
                sendTemplate.mutate({
                  conversationId: t.conversationId,
                  templateId: tplDef.id,
                  bodyParam2: tplDef.sharedParam ? tplParam2.trim() || null : null,
                  weekStart: tplNeedsWeek ? tplWeekStart : null,
                  clientRequestId: tplReqId,
                })
              }
            >
              {sendTemplate.isPending ? <Clock className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
              Enviar template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
