import { useState, useEffect, useMemo, useRef } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
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
  Check,
  CheckCheck,
  XCircle,
  ArrowLeft,
  Hourglass,
  Lock,
  MailOpen,
  Search,
  X,
  BellOff,
  AlarmClock,
  AlertTriangle,
  UserRound,
  Link2,
  Sparkles,
  Zap,
  Settings2,
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
  type AssigneeFilter,
  type ConversationStatus,
  type StatusFilter,
} from "@shared/whatsappConversation";
import { WHATSAPP_INTENTS, WHATSAPP_INTENT_LABELS, isWhatsappIntent } from "@shared/commsAi";
import { WhatsAppContextSheet } from "@/components/whatsapp/WhatsAppContextSheet";
import { QuickRepliesDialog } from "@/components/whatsapp/QuickRepliesDialog";
import {
  DEFAULT_WHATSAPP_TEMPLATE_ID,
  WHATSAPP_TEMPLATES,
  findWhatsAppTemplate,
  messageDisplayBody,
  previewTemplateBody,
  resolveBodyParamRoles,
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

/** Badge de opt-out (pediu STOP). */
function OptedOutBadge() {
  return (
    <Badge variant="outline" className="h-5 px-1.5 text-[11px] gap-1 border-red-300 text-red-700 dark:border-red-800 dark:text-red-300 shrink-0">
      <BellOff className="h-3 w-3" /> Não quer mensagens
    </Badge>
  );
}

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
  // Template escolhido do CATÁLOGO (shared/whatsappTemplate.ts) — nunca nome/língua à mão.
  const [tplId, setTplId] = useState(DEFAULT_WHATSAPP_TEMPLATE_ID);
  // {{2}} do body (o {{1}} é sempre o nome de quem recebe, resolvido no servidor).
  const [tplParam2, setTplParam2] = useState("");
  // Semana do link do formulário (só templates de semana com botão de link).
  const [tplWeekStart, setTplWeekStart] = useState("");
  const pageVisible = usePageVisible();
  const [now, setNow] = useState(() => Date.now());
  // Pesquisa por nome ou número (filtro local — a lista já vem completa).
  const [search, setSearch] = useState("");
  // Só conversas com mensagens por ler (filtro local, compõe em AND com a
  // pesquisa). A conversa ABERTA fica sempre à vista: abrir marca como lida e
  // sem isto a linha desaparecia debaixo do clique.
  const [onlyUnread, setOnlyUnread] = useState(false);
  // Estado + atribuição (0097): filtros locais, em AND com os de cima.
  const { user } = useAuth();
  const [assigneeFilter, setAssigneeFilter] = useState<AssigneeFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  // Só conversas com alerta (sem resposta há +SLA ou janela a fechar).
  const [onlyAlerts, setOnlyAlerts] = useState(false);
  // Etiquetas da triagem por IA (intenção + urgência).
  const [intentFilter, setIntentFilter] = useState<string>("all");
  const [onlyUrgent, setOnlyUrgent] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // Tick para o countdown da janela (a cada 30s).
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const conversations = trpc.whatsapp.conversations.list.useQuery(undefined, {
    refetchInterval: pageVisible ? POLL_MS : false,
  });
  const thread = trpc.whatsapp.messages.byConversation.useQuery(
    { conversationId: selectedId ?? 0 },
    { enabled: selectedId != null, refetchInterval: pageVisible ? POLL_MS : false },
  );

  const utils = trpc.useUtils();
  const meta = trpc.whatsapp.inboxMeta.useQuery(undefined, { staleTime: 10 * 60_000 });
  const slaMinutes = meta.data?.slaMinutes ?? 15;
  const assignees = trpc.whatsapp.assignees.useQuery(undefined, { staleTime: 10 * 60_000 });
  const quickReplies = trpc.whatsapp.quickReplies.list.useQuery(undefined, { staleTime: 60_000 });
  /** Depois de qualquer mudança: lista, conversa aberta e badge do menu. */
  function refreshAll() {
    conversations.refetch();
    if (selectedId != null) thread.refetch();
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
      if (v.mode === "summary") setAiSummary(r.text);
      else {
        setText(r.text);
        setTimeout(() => composerRef.current?.focus(), 0);
        toast.success("Sugestão no composer — revê antes de enviar.");
      }
    },
    onError: (e) => toast.error(e.message),
  });
  // "Marcar como não lida": fecha a thread (abrir volta a marcar como lida) e
  // a conversa regressa ao filtro "Não lidas" com o badge verde.
  const markUnread = trpc.whatsapp.markUnread.useMutation({
    onSuccess: () => {
      setSelectedId(null);
      setText("");
      conversations.refetch();
      utils.whatsapp.badge.invalidate();
      toast.success("Conversa marcada como não lida.");
    },
    onError: (e) => toast.error(e.message),
  });
  const reply = trpc.whatsapp.reply.useMutation({
    onSuccess: () => {
      setText("");
      refreshAll();
    },
    onError: (e) => toast.error(e.message),
  });
  const sendTemplate = trpc.whatsapp.sendTemplate.useMutation({
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
    setAiSummary(null);
    markRead.mutate({ conversationId: id });
  }

  const allConversations = conversations.data ?? [];
  const hasSearch = search.trim().length > 0;
  // Alertas (SLA / janela) calculados com as MESMAS regras do servidor.
  const alertsById = useMemo(() => {
    const m = new Map<number, ReturnType<typeof conversationAlerts>>();
    for (const c of allConversations) m.set(c.id, conversationAlerts(c, now, slaMinutes));
    return m;
  }, [allConversations, now, slaMinutes]);
  const scoped = allConversations.filter((c) =>
    matchesInboxFilters(c, { assignee: assigneeFilter, status: statusFilter, userId: user?.id }),
  );
  const unreadTotal = scoped.filter((c) => c.unreadCount > 0).length;
  const overdueTotal = scoped.filter((c) => alertsById.get(c.id)?.overdue).length;
  const closingTotal = scoped.filter((c) => alertsById.get(c.id)?.windowClosing).length;
  const urgentTotal = scoped.filter((c) => c.aiUrgency === "urgente" && c.status !== "resolvido").length;
  const mineTotal = allConversations.filter((c) => c.assignedUserId != null && c.assignedUserId === user?.id && c.status !== "resolvido").length;
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
      (!onlyUnread || c.unreadCount > 0 || c.id === selectedId) &&
      (!onlyAlerts || a?.overdue || a?.windowClosing || c.id === selectedId) &&
      (intentFilter === "all" || c.aiIntent === intentFilter || c.id === selectedId) &&
      (!onlyUrgent || c.aiUrgency === "urgente" || c.id === selectedId)
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
      if (e.key === "Escape" && !typing && selectedId != null && !tplOpen && !contextOpen && !quickOpen) {
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
  const windowState: WindowState | undefined = t?.windowState;
  const threadAlerts = t ? conversationAlerts(t, now, slaMinutes) : null;
  const aiConfigured = meta.data?.aiConfigured === true;

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
    setTplOpen(true);
  }

  function submitReply() {
    if (!text.trim() || selectedId == null) return;
    // Contacto que pediu STOP: texto livre só depois de confirmar (ex.: responder a uma dúvida dele).
    if (t?.optedOut) {
      const ok = window.confirm(
        "Este contacto pediu para não receber mensagens (STOP). Enviar mesmo assim esta resposta?",
      );
      if (!ok) return;
      reply.mutate({ conversationId: selectedId, text: text.trim(), confirmOptedOut: true });
      return;
    }
    reply.mutate({ conversationId: selectedId, text: text.trim() });
  }

  function conversationRow(c: (typeof convList)[number]) {
    const isOpen = c.windowState === "open";
    const a = alertsById.get(c.id);
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
          {c.optedOut && <BellOff className="h-3.5 w-3.5 text-red-500 shrink-0" aria-label="Não quer mensagens" />}
          <span className="text-[11px] text-muted-foreground shrink-0">{fmtListTime(c.lastMessageAt, now)}</span>
          {c.unreadCount > 0 && (
            <Badge className="bg-green-700 text-white h-5 min-w-5 px-1.5 justify-center shrink-0">
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
              className={`text-[11px] shrink-0 tabular-nums ${
                windowClosingSoon(c.windowExpiresAt, now) ? "text-amber-600 dark:text-amber-400 font-medium" : "text-green-700 dark:text-green-400"
              }`}
              title="Tempo que resta para responder em texto livre"
            >
              fecha em {windowCountdown(c.windowExpiresAt, now)}
            </span>
          )}
        </div>
        {(a?.overdue || a?.windowClosing || c.status !== "aberto" || c.assignedName || c.aiIntent || c.aiUrgency === "urgente") && (
          <div className="flex flex-wrap items-center gap-1 mt-1">
            {c.aiUrgency === "urgente" && c.status !== "resolvido" && (
              <Badge className="h-5 px-1.5 text-[11px] gap-1 bg-orange-600 text-white" title="Urgente (IA) — entra mais cedo no aviso de SLA">
                <Zap className="h-3 w-3" /> Urgente
              </Badge>
            )}
            {isWhatsappIntent(c.aiIntent) && (
              <Badge variant="outline" className="h-5 px-1.5 text-[11px] border-violet-300 text-violet-800 dark:border-violet-800 dark:text-violet-300" title="Intenção (IA)">
                {WHATSAPP_INTENT_LABELS[c.aiIntent]}
              </Badge>
            )}
            {a?.overdue && (
              <Badge className="h-5 px-1.5 text-[11px] gap-1 bg-red-600 text-white" title={`Sem resposta há mais de ${slaMinutes} min`}>
                <AlarmClock className="h-3 w-3" /> {formatWaiting(a.waitingMinutes)}
              </Badge>
            )}
            {a?.windowClosing && (
              <Badge variant="outline" className="h-5 px-1.5 text-[11px] gap-1 border-amber-400 text-amber-700 dark:text-amber-300" title="Janela de 24h a fechar">
                <AlertTriangle className="h-3 w-3" /> Janela a fechar
              </Badge>
            )}
            {c.status !== "aberto" && (
              <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">{CONVERSATION_STATUS_LABELS[c.status]}</Badge>
            )}
            {c.assignedName && (
              <span className="text-[11px] text-muted-foreground inline-flex items-center gap-0.5 truncate max-w-[45%]" title={`Responsável: ${c.assignedName}`}>
                <UserRound className="h-3 w-3 shrink-0" /> {c.assignedName}
              </span>
            )}
          </div>
        )}
      </button>
    );
  }

  function groupHeader(label: string, count: number, tone: "open" | "closed") {
    return (
      <div
        className={`sticky top-0 z-10 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide border-b ${
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
      <div className="p-2 border-b shrink-0 space-y-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            ref={searchRef}
            type="text"
            placeholder="Pesquisar nome, número ou texto… ( / )"
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
        <div className="flex items-center gap-1" role="group" aria-label="Filtrar por responsável">
          {([
            ["all", "Todas"],
            ["mine", `Minhas${mineTotal ? ` · ${mineTotal}` : ""}`],
            ["unassigned", "Sem atribuição"],
          ] as [AssigneeFilter, string][]).map(([v, label]) => (
            <Button
              key={v}
              type="button"
              size="sm"
              variant={assigneeFilter === v ? "default" : "outline"}
              className="h-7 px-2 text-xs flex-1"
              aria-pressed={assigneeFilter === v}
              onClick={() => setAssigneeFilter(v)}
            >
              {label}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
            <SelectTrigger className="h-7 w-[150px] text-xs" aria-label="Filtrar por estado">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Ativas</SelectItem>
              <SelectItem value="aberto">Abertas</SelectItem>
              <SelectItem value="pendente">Pendentes</SelectItem>
              <SelectItem value="resolvido">Resolvidas</SelectItem>
              <SelectItem value="all">Todos os estados</SelectItem>
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            variant={onlyUnread ? "default" : "outline"}
            className="h-7 text-xs"
            aria-pressed={onlyUnread}
            title="Mostrar só conversas com mensagens por ler"
            onClick={() => setOnlyUnread((v) => !v)}
          >
            <MessageCircle className="h-3.5 w-3.5 mr-1" />
            Não lidas
            <span className="ml-1 opacity-70 tabular-nums">{unreadTotal}</span>
          </Button>
          {onlyUnread && (
            <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setOnlyUnread(false)}>
              <X className="h-3.5 w-3.5 mr-1" /> Todas
            </Button>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Select value={intentFilter} onValueChange={setIntentFilter}>
            <SelectTrigger className="h-7 w-[170px] text-xs" aria-label="Filtrar por intenção (IA)">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas as intenções</SelectItem>
              {WHATSAPP_INTENTS.map((i) => (
                <SelectItem key={i} value={i}>{WHATSAPP_INTENT_LABELS[i]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            variant={onlyUrgent ? "default" : "outline"}
            className="h-7 text-xs"
            aria-pressed={onlyUrgent}
            title="Mostrar só conversas marcadas como urgentes pela IA"
            onClick={() => setOnlyUrgent((v) => !v)}
          >
            <Zap className="h-3.5 w-3.5 mr-1" />
            Urgentes
            <span className="ml-1 opacity-70 tabular-nums">{urgentTotal}</span>
          </Button>
        </div>
      </div>
      {(overdueTotal > 0 || closingTotal > 0 || onlyAlerts) && (
        <button
          type="button"
          onClick={() => setOnlyAlerts((v) => !v)}
          aria-pressed={onlyAlerts}
          className={`shrink-0 flex items-center gap-2 px-3 py-1.5 text-xs border-b text-left ${
            overdueTotal > 0
              ? "bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300"
              : "bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300"
          }`}
          title={onlyAlerts ? "Mostrar todas" : "Mostrar só as conversas com alerta"}
        >
          <AlarmClock className="h-4 w-4 shrink-0" />
          <span className="flex-1">
            {overdueTotal > 0 && <><strong>{overdueTotal}</strong> sem resposta há +{formatWaiting(slaMinutes)}</>}
            {overdueTotal > 0 && closingTotal > 0 && " · "}
            {closingTotal > 0 && <><strong>{closingTotal}</strong> com a janela de 24h a fechar</>}
            {overdueTotal === 0 && closingTotal === 0 && "Sem alertas"}
          </span>
          <span className="underline shrink-0">{onlyAlerts ? "Ver todas" : "Ver"}</span>
        </button>
      )}
      <div className="flex-1 overflow-y-auto">
        {convList.length === 0 && (
          <div className="p-4 text-sm text-muted-foreground text-center">
            {conversations.isLoading
              ? "A carregar…"
              : hasSearch
                ? `Sem resultados para “${search.trim()}”${onlyUnread ? " entre as não lidas" : ""}.`
                : onlyUnread
                  ? "Sem mensagens por ler."
                  : onlyAlerts
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

  // ── Banner + composer por estado de janela ──
  function templateButton() {
    if (!t) return null;
    return (
      <Button
        size="sm"
        variant="outline"
        className="ml-auto h-7"
        disabled={t.optedOut}
        title={t.optedOut ? "Este contacto pediu para não receber mensagens" : "Enviar um template aprovado"}
        onClick={openTemplateDialog}
      >
        <Send className="h-3.5 w-3.5 mr-1" /> Enviar template
      </Button>
    );
  }

  function windowBanner() {
    if (!t) return null;
    const optOutNote = t.optedOut ? (
      <div className="flex items-center gap-2 px-3 py-2 text-xs bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300 border-t">
        <BellOff className="h-4 w-4 shrink-0" />
        <span>
          <strong>Não quer mensagens</strong> — pediu para parar. Templates bloqueados; texto livre só com confirmação.
          Volta a receber se responder INICIAR.
        </span>
      </div>
    ) : null;
    if (windowState === "awaiting_first_reply") {
      return (
        <>
          {optOutNote}
          <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 border-t">
            <Hourglass className="h-4 w-4 shrink-0" />
            <span>
              <strong>A aguardar a primeira resposta.</strong> Só podes escrever texto livre depois de o contacto
              responder — até lá, só templates.
            </span>
            {templateButton()}
          </div>
        </>
      );
    }
    if (windowState === "open") {
      return (
        <>
          {optOutNote}
          <div
            className={`flex items-center gap-2 px-3 py-2 text-xs border-t ${
              threadAlerts?.windowClosing
                ? "bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300"
                : "bg-green-50 dark:bg-green-950/30 text-green-800 dark:text-green-300"
            }`}
          >
            <MessageCircle className="h-4 w-4 shrink-0" />
            <span>
              <strong>Janela aberta</strong> — fecha em {windowCountdown(t.windowExpiresAt, now)}.
              {threadAlerts?.windowClosing && " Responde antes que feche — depois só com template."}
            </span>
          </div>
        </>
      );
    }
    // expired
    return (
      <>
        {optOutNote}
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs bg-muted text-muted-foreground border-t">
          <Lock className="h-4 w-4 shrink-0" />
          <span>
            <strong>Janela de 24h fechada</strong> — só é possível reiniciar com um template.
          </span>
          {templateButton()}
        </div>
      </>
    );
  }

  function composer() {
    const disabled = windowState !== "open";
    return (
      <div className="p-3 border-t shrink-0">
        <div className="flex gap-2 items-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-10 w-10 shrink-0"
                disabled={disabled}
                title="Respostas rápidas"
                aria-label="Respostas rápidas"
              >
                <Zap className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" className="w-72 max-h-80 overflow-y-auto">
              <DropdownMenuLabel className="text-xs">Respostas rápidas</DropdownMenuLabel>
              {(quickReplies.data ?? []).length === 0 && (
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
              variant="outline"
              size="icon"
              className="h-10 w-10 shrink-0"
              disabled={disabled || aiAssist.isPending || selectedId == null}
              title="Sugerir resposta com IA (fica no composer para rever)"
              aria-label="Sugerir resposta com IA"
              onClick={() => selectedId != null && aiAssist.mutate({ conversationId: selectedId, mode: "reply" })}
            >
              {aiAssist.isPending && aiAssist.variables?.mode === "reply" ? (
                <Clock className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
            </Button>
          )}
          <Textarea
            ref={composerRef}
            rows={1}
            className="resize-none min-h-[40px] max-h-32"
            placeholder={disabled ? "Composer desativado — janela fechada." : "Escreve uma mensagem…"}
            value={text}
            disabled={disabled || reply.isPending}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !disabled) {
                e.preventDefault();
                submitReply();
              }
            }}
          />
          <Button
            className="bg-green-700 hover:bg-green-800 text-white shrink-0"
            disabled={disabled || !text.trim() || reply.isPending || selectedId == null}
            onClick={submitReply}
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
              {t && (
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span>{t.phoneE164}</span>
                  {t.optedOut && <OptedOutBadge />}
                </div>
              )}
            </div>
            {t && threadAlerts?.overdue && (
              <Badge className="ml-auto h-6 px-2 text-[11px] gap-1 bg-red-600 text-white shrink-0" title={`Sem resposta há mais de ${slaMinutes} min`}>
                <AlarmClock className="h-3.5 w-3.5" /> Sem resposta · {formatWaiting(threadAlerts.waitingMinutes)}
              </Badge>
            )}
          </div>

          {t && (
            <div className="px-3 py-2 border-b flex flex-wrap items-center gap-1.5 shrink-0 bg-muted/10">
              <Select
                value={t.status}
                onValueChange={(v) => setStatus.mutate({ conversationId: t.conversationId, status: v as ConversationStatus })}
                disabled={setStatus.isPending}
              >
                <SelectTrigger className="h-8 w-[118px] text-xs" aria-label="Estado da conversa">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="aberto">Aberta</SelectItem>
                  <SelectItem value="pendente">Pendente</SelectItem>
                  <SelectItem value="resolvido">Resolvida</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={t.assignedUserId != null ? String(t.assignedUserId) : "none"}
                onValueChange={(v) => assign.mutate({ conversationId: t.conversationId, userId: v === "none" ? null : Number(v) })}
                disabled={assign.isPending}
              >
                <SelectTrigger className="h-8 w-[180px] max-w-full text-xs" aria-label="Responsável">
                  <UserRound className="h-3.5 w-3.5 mr-1 shrink-0" />
                  <SelectValue placeholder="Responsável" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sem responsável</SelectItem>
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
              {t.status !== "resolvido" && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  disabled={setStatus.isPending}
                  title="Marcar como resolvida (volta a abrir se o contacto escrever)"
                  onClick={() => setStatus.mutate({ conversationId: t.conversationId, status: "resolvido" })}
                >
                  <CheckCheck className="h-3.5 w-3.5 mr-1" /> Resolver
                </Button>
              )}
              <Button
                size="sm"
                variant={t.linkedBookingId || t.linkedClientEmail ? "secondary" : "outline"}
                className="h-8 text-xs"
                title="Reservas, reclamações e perdidos deste número; ligar a uma reserva ou cliente"
                onClick={() => setContextOpen(true)}
              >
                <Link2 className="h-3.5 w-3.5 mr-1" />
                {t.linkedBookingId ? "Reserva ligada" : t.linkedClientEmail ? "Cliente ligado" : "Contexto"}
              </Button>
              {aiConfigured && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  disabled={aiAssist.isPending || !t.messages.length}
                  title="Resumo da conversa com IA"
                  onClick={() => aiAssist.mutate({ conversationId: t.conversationId, mode: "summary" })}
                >
                  {aiAssist.isPending && aiAssist.variables?.mode === "summary" ? (
                    <Clock className="h-3.5 w-3.5 mr-1 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5 mr-1" />
                  )}
                  Resumo
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs ml-auto"
                title="Volta a pôr esta conversa em “Não lidas” para retomar mais tarde"
                disabled={markUnread.isPending}
                onClick={() => markUnread.mutate({ conversationId: t.conversationId })}
              >
                <MailOpen className="h-3.5 w-3.5 mr-1" />
                {isMobile ? "Não lida" : "Marcar como não lida"}
              </Button>
            </div>
          )}

          {aiSummary && (
            <div className="px-3 py-2 border-b text-xs bg-violet-50 dark:bg-violet-950/30 text-violet-900 dark:text-violet-200 shrink-0 flex gap-2">
              <Sparkles className="h-4 w-4 shrink-0 mt-0.5" />
              <div className="whitespace-pre-wrap flex-1 max-h-40 overflow-y-auto">{aiSummary}</div>
              <button type="button" aria-label="Fechar resumo" className="shrink-0 opacity-70 hover:opacity-100" onClick={() => setAiSummary(null)}>
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

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
                      ? "bg-green-700 text-white rounded-br-sm"
                      : "bg-background border rounded-bl-sm"
                  }`}
                >
                  {m.type === "template" && (
                    <div
                      className={`text-[11px] uppercase tracking-wide mb-0.5 ${
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
                  {!(m.mediaAvailable && isMediaPlaceholderBody(m.body)) && (
                    <div
                      className={`whitespace-pre-wrap break-words [overflow-wrap:anywhere]${m.body?.trim() ? "" : " italic opacity-80"}`}
                    >
                      {messageDisplayBody(m) || "—"}
                    </div>
                  )}
                  <div
                    className={`flex items-center gap-1 justify-end mt-0.5 text-[11px] ${
                      m.direction === "out" ? "text-green-100" : "text-muted-foreground"
                    }`}
                  >
                    <span>{fmtTime(m.waTimestamp ?? m.createdAt)}</span>
                    {m.direction === "out" && <StatusIcon status={m.status} />}
                  </div>
                  {m.direction === "out" && m.status === "failed" && m.errorDetail && (
                    <div className="text-[11px] text-red-200 mt-0.5">{m.errorDetail}</div>
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
          Respostas de extras, leads e contactos. Só é possível texto livre com a janela de 24h aberta.
          {!isMobile && <span className="ml-1 opacity-70">Atalhos: / pesquisar · Alt+↑/↓ mudar de conversa · Esc fechar.</span>}
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

      <WhatsAppContextSheet
        conversationId={selectedId}
        contactName={t?.name ?? "contacto"}
        open={contextOpen && selectedId != null}
        onOpenChange={setContextOpen}
        onLinked={refreshAll}
      />
      <QuickRepliesDialog open={quickOpen} onOpenChange={setQuickOpen} />

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
                : `A janela de 24h está fechada. Um template aprovado reabre a conversa com ${t?.name ?? "este contacto"}.`}
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
                <div className="rounded-md bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-900 p-3 text-sm whitespace-pre-wrap">
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

// ─── Media recebida (imagem / áudio / vídeo / documento) ────────────────────
// O ficheiro é privado: o URL assinado (10 min) é pedido só quando a bolha
// aparece, e renovado antes de expirar.
function InboundMedia({ m }: { m: { id: number; mediaType: string | null; mediaAvailable: boolean; mediaMime: string | null; body: string | null } }) {
  const signed = trpc.whatsapp.mediaUrl.useQuery(
    { messageId: m.id },
    { enabled: !!m.mediaType && m.mediaAvailable, staleTime: 8 * 60_000, refetchInterval: 8 * 60_000, retry: 1 },
  );
  if (!m.mediaType) return null;
  const label =
    m.mediaType === "image" ? "Imagem" : m.mediaType === "audio" ? "Áudio" : m.mediaType === "video" ? "Vídeo" : m.mediaType === "document" ? "Documento" : "Ficheiro";
  if (!m.mediaAvailable) {
    // Download falhou (token/rede/storage/tamanho) — dizemos porquê em vez de
    // mostrar uma bolha vazia; o cron horário re-tenta com o `mediaId`.
    return <div className="text-[11px] italic opacity-80 mb-1">{label} recebido, mas ainda não foi possível descarregar.</div>;
  }
  const url = signed.data?.url;
  if (!url) {
    return <div className="text-[11px] italic opacity-80 mb-1">{signed.isError ? `${label} indisponível.` : `A carregar ${label.toLowerCase()}…`}</div>;
  }
  if (m.mediaType === "image") {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block mb-1" title="Abrir imagem">
        <img src={url} alt={m.body && !isMediaPlaceholderBody(m.body) ? m.body : "Imagem recebida"} loading="lazy" className="max-h-64 max-w-full rounded-md object-contain bg-black/5" />
      </a>
    );
  }
  if (m.mediaType === "audio") {
    return (
      <audio controls preload="metadata" className="max-w-full mb-1 h-9">
        <source src={url} type={m.mediaMime ?? undefined} />
        <a href={url} target="_blank" rel="noreferrer">Ouvir áudio</a>
      </audio>
    );
  }
  if (m.mediaType === "video") {
    return (
      <video controls preload="metadata" className="max-h-64 max-w-full rounded-md mb-1">
        <source src={url} type={m.mediaMime ?? undefined} />
      </video>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" className="underline text-[12px] block mb-1">
      Abrir {label.toLowerCase()}
    </a>
  );
}
