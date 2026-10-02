import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { AlarmClock, BellOff, Hourglass, Lock, Timer, UserRound, Zap } from "lucide-react";
import { CONVERSATION_STATUS_LABELS, formatWaiting, type ConversationAlerts } from "@shared/whatsappConversation";
import { WHATSAPP_INTENT_LABELS, isWhatsappIntent } from "@shared/commsAi";
import { ContactAvatar } from "@/components/whatsapp/ContactAvatar";
import { fmtListTime, windowClosingSoon, windowCountdown } from "@/components/whatsapp/inboxFormat";
import type { InboxConversation } from "@/components/whatsapp/inboxTypes";

/** Etiqueta pequena da 3.ª linha (uma só linha, sem quebrar). */
function Tag({ className, title, children }: { className: string; title?: string; children: ReactNode }) {
  return (
    <span
      title={title}
      className={cn("inline-flex items-center gap-0.5 h-4 px-1 rounded text-[10px] font-medium leading-none whitespace-nowrap shrink-0", className)}
    >
      {children}
    </span>
  );
}

/**
 * Linha da lista de conversas, estilo WhatsApp (2026-10-01):
 *  1. avatar · nome · hora da última mensagem
 *  2. pré-visualização · tempo que resta na janela · não lidas
 *  3. (só se houver) etiquetas compactas numa linha: urgente, sem resposta há X,
 *     intenção, estado, responsável.
 * O "fecha em 30m" e o antigo badge "Janela a fechar" eram o MESMO sinal —
 * ficou só o contador, a âmbar quando faltam <2h.
 */
export function ConversationListItem({
  c,
  alerts,
  selected,
  now,
  slaMinutes,
  onOpen,
  boxLabel = null,
}: {
  c: InboxConversation;
  /** Caixa por tema (17f) — nome a mostrar. */
  boxLabel?: string | null;
  alerts: ConversationAlerts | undefined;
  selected: boolean;
  now: number;
  slaMinutes: number;
  onOpen: (id: number) => void;
}) {
  const unread = c.unreadCount > 0;
  const isOpen = c.windowState === "open";
  const closing = isOpen && (alerts?.windowClosing || windowClosingSoon(c.windowExpiresAt, now));
  const urgent = c.aiUrgency === "urgente" && c.status !== "resolvido";
  const intent = isWhatsappIntent(c.aiIntent) ? WHATSAPP_INTENT_LABELS[c.aiIntent] : null;
  const hasTags = urgent || !!alerts?.overdue || !!intent || !!boxLabel || c.status !== "aberto" || !!c.assignedName;

  return (
    <button
      type="button"
      onClick={() => onOpen(c.id)}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "w-full text-left flex items-start gap-2.5 pl-3 pr-2.5 py-2 border-b border-border/60 transition-colors outline-none focus-visible:bg-muted/70",
        selected ? "bg-muted" : "hover:bg-muted/50",
      )}
    >
      <ContactAvatar name={c.name} photoUrl={c.photoUrl} className="h-10 w-10 text-sm mt-0.5" />
      <div className="min-w-0 flex-1">
        {/* 1 · nome + hora */}
        <div className="flex items-center gap-1.5">
          <span className={cn("truncate flex-1 text-sm", unread ? "font-semibold" : "font-medium")}>{c.name}</span>
          {c.optedOut && <BellOff className="h-3.5 w-3.5 text-red-500 shrink-0" aria-label="Não quer mensagens" />}
          <span
            className={cn(
              "text-[11px] shrink-0 tabular-nums",
              unread ? "text-green-700 dark:text-green-400 font-medium" : "text-muted-foreground",
            )}
          >
            {fmtListTime(c.lastMessageAt, now)}
          </span>
        </div>

        {/* 2 · pré-visualização + janela + não lidas */}
        <div className="flex items-center gap-1 mt-0.5">
          {c.windowState === "awaiting_first_reply" && (
            <Hourglass className="h-3 w-3 text-amber-500 shrink-0" aria-label="A aguardar 1ª resposta" />
          )}
          {c.windowState === "expired" && <Lock className="h-3 w-3 text-muted-foreground shrink-0" aria-label="Janela fechada" />}
          <span className={cn("text-xs truncate flex-1", unread ? "text-foreground" : "text-muted-foreground")}>
            {c.previewDirection === "out" ? "Tu: " : ""}
            {c.preview ?? "—"}
          </span>
          {isOpen && (
            // Critério de ordenação do bloco "Janela aberta", visível na linha.
            <span
              className={cn(
                "inline-flex items-center gap-0.5 text-[11px] shrink-0 tabular-nums",
                closing ? "text-amber-600 dark:text-amber-400 font-medium" : "text-green-700 dark:text-green-400",
              )}
              title={
                closing
                  ? `Janela de 24h a fechar — fecha em ${windowCountdown(c.windowExpiresAt, now)}`
                  : `Tempo que resta para responder em texto livre: ${windowCountdown(c.windowExpiresAt, now)}`
              }
            >
              <Timer className="h-3 w-3" />
              {windowCountdown(c.windowExpiresAt, now)}
            </span>
          )}
          {unread && (
            <span
              className="ml-0.5 inline-flex items-center justify-center h-[18px] min-w-[18px] px-1 rounded-full bg-green-600 text-white text-[10px] font-semibold tabular-nums shrink-0"
              aria-label={`${c.unreadCount} por ler`}
            >
              {c.unreadCount > 99 ? "99+" : c.unreadCount}
            </span>
          )}
        </div>

        {/* 3 · etiquetas (uma linha, o que não couber fica escondido) */}
        {hasTags && (
          <div className="flex items-center gap-1 mt-1 overflow-hidden">
            {urgent && (
              <Tag className="bg-orange-600 text-white" title="Urgente (IA) — entra mais cedo no aviso de SLA">
                <Zap className="h-2.5 w-2.5" /> Urgente
              </Tag>
            )}
            {alerts?.overdue && (
              <Tag className="bg-red-600 text-white" title={`Sem resposta há mais de ${slaMinutes} min`}>
                <AlarmClock className="h-2.5 w-2.5" /> {formatWaiting(alerts.waitingMinutes)}
              </Tag>
            )}
            {boxLabel && (
              <Tag className="bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300" title="Caixa">
                {boxLabel}
              </Tag>
            )}
            {intent && (
              <Tag className="bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-300" title="Intenção (IA)">
                {intent}
              </Tag>
            )}
            {c.status !== "aberto" && (
              <Tag className="bg-secondary text-secondary-foreground">{CONVERSATION_STATUS_LABELS[c.status]}</Tag>
            )}
            {c.assignedName && (
              <span
                className="ml-auto inline-flex items-center gap-0.5 text-[10px] text-muted-foreground min-w-0 truncate"
                title={`Responsável: ${c.assignedName}`}
              >
                <UserRound className="h-2.5 w-2.5 shrink-0" />
                <span className="truncate">{c.assignedName}</span>
              </span>
            )}
          </div>
        )}
      </div>
    </button>
  );
}
