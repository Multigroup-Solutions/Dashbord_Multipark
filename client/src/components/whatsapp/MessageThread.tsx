import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Check, CheckCheck, ChevronDown, Clock, XCircle } from "lucide-react";
import { messageDisplayBody } from "@shared/whatsappTemplate";
import { isMediaPlaceholderBody } from "@shared/whatsappMedia";
import { daySeparatorLabel, localDayKey } from "@shared/whatsappInboxView";
import { CallTimelineEntry, type TimelineCall } from "@/components/whatsapp/WhatsAppCallsPanels";
import { fmtTime, timeline, type TimelineItem } from "@/components/whatsapp/inboxFormat";
import type { InboxMessage } from "@/components/whatsapp/inboxTypes";

/** Distância ao fundo (px) abaixo da qual se considera que a pessoa está "no fim" da conversa. */
const NEAR_BOTTOM_PX = 80;
/** Mensagens seguidas do mesmo lado, a menos disto, ficam agrupadas (sem espaço extra). */
const GROUP_GAP_MS = 5 * 60_000;

type Item = TimelineItem<InboxMessage, TimelineCall>;

function itemKey(i: Item): string {
  return i.kind === "call" ? `call-${i.call.id}` : `msg-${i.message.id}`;
}

/**
 * Mensagens da conversa aberta, estilo WhatsApp: separadores de dia, bolhas
 * compactas e o scroll sempre no fim.
 *
 * Regras do scroll (pedido 2026-10-01 — "a conversa abre no topo"):
 *  - ao abrir uma conversa (e quando as mensagens chegam) vai para o FIM;
 *  - mensagens novas (polling, envio) só puxam para baixo se a pessoa já
 *    estava no fim — quem subiu para ler o histórico não é arrastado; aparece
 *    o botão "↓" com o número de novas;
 *  - imagens/áudios que carregam depois (mudam a altura) mantêm o fim à vista
 *    (ResizeObserver no conteúdo);
 *  - `stickSignal` muda quando ESTE utilizador envia → volta sempre ao fim.
 */
export function MessageThread({
  conversationId,
  messages,
  calls,
  ready,
  isLoading,
  now,
  stickSignal,
}: {
  conversationId: number;
  messages: readonly InboxMessage[];
  calls: readonly TimelineCall[];
  /** A thread desta conversa já chegou (antes disso não há "fim" para onde ir). */
  ready: boolean;
  isLoading: boolean;
  now: number;
  stickSignal: number;
}) {
  const items = useMemo(() => timeline(messages, calls), [messages, calls]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Ref (e não estado) para o ResizeObserver e os efeitos lerem o valor atual sem re-render.
  const stickRef = useRef(true);
  const initialDoneRef = useRef(false);
  const lastKeyRef = useRef<string | null>(null);
  const countRef = useRef(0);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Conversa nova → recomeça no fim.
  useLayoutEffect(() => {
    stickRef.current = true;
    initialDoneRef.current = false;
    lastKeyRef.current = null;
    countRef.current = 0;
    setAtBottom(true);
    setUnseen(0);
  }, [conversationId]);

  const lastKey = items.length ? itemKey(items[items.length - 1]) : null;
  useLayoutEffect(() => {
    if (!ready || !items.length) return;
    if (!initialDoneRef.current) {
      // 1.ª pintura com mensagens: salto direto para o fim (sem animação).
      initialDoneRef.current = true;
      lastKeyRef.current = lastKey;
      countRef.current = items.length;
      stickRef.current = true;
      scrollToBottom();
      return;
    }
    if (lastKey === lastKeyRef.current) return;
    const added = Math.max(1, items.length - countRef.current);
    lastKeyRef.current = lastKey;
    countRef.current = items.length;
    if (stickRef.current) scrollToBottom();
    else setUnseen((u) => u + added);
  }, [ready, lastKey, items.length, scrollToBottom]);

  // Envio feito aqui → volta ao fim, mesmo que estivesse a ler mais acima.
  useEffect(() => {
    if (stickSignal === 0) return;
    stickRef.current = true;
    setUnseen(0);
    scrollToBottom();
  }, [stickSignal, scrollToBottom]);

  // Altura que muda depois da pintura (imagem/áudio carregado, composer a
  // crescer, resumo IA aberto): quem estava no fim continua no fim.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stickRef.current && initialDoneRef.current) scrollToBottom();
    });
    if (scrollRef.current) ro.observe(scrollRef.current);
    if (contentRef.current) ro.observe(contentRef.current);
    return () => ro.disconnect();
  }, [scrollToBottom]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    stickRef.current = near;
    setAtBottom(near);
    if (near) setUnseen(0);
  }

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto overscroll-contain bg-[#efeae2]/70 dark:bg-zinc-950"
        role="log"
        aria-label="Mensagens da conversa"
      >
        <div ref={contentRef} className="px-3 sm:px-[6%] py-3">
          {isLoading && <SystemPill>A carregar…</SystemPill>}
          {ready && items.length === 0 && <SystemPill>Sem mensagens.</SystemPill>}
          {items.map((item, idx) => {
            const prev = idx > 0 ? items[idx - 1] : null;
            const day = localDayKey(item.at);
            const newDay = !prev || localDayKey(prev.at) !== day;
            const groupStart =
              newDay ||
              item.kind === "call" ||
              prev?.kind !== "message" ||
              prev.message.direction !== item.message.direction ||
              item.at - prev.at > GROUP_GAP_MS;
            return (
              <Fragment key={itemKey(item)}>
                {newDay && (
                  <div className="flex justify-center my-2 first:mt-0">
                    <span className="rounded-md bg-white/90 dark:bg-zinc-800 px-2.5 py-0.5 text-[11px] font-medium text-zinc-600 dark:text-zinc-300 shadow-sm">
                      {daySeparatorLabel(item.at, now)}
                    </span>
                  </div>
                )}
                {item.kind === "call" ? (
                  <div className="my-1.5">
                    <CallTimelineEntry c={item.call} />
                  </div>
                ) : (
                  <MessageBubble m={item.message} groupStart={groupStart} />
                )}
              </Fragment>
            );
          })}
        </div>
      </div>
      {!atBottom && (
        <button
          type="button"
          onClick={() => {
            stickRef.current = true;
            setUnseen(0);
            scrollToBottom("smooth");
          }}
          className="absolute bottom-3 right-4 flex items-center gap-1 rounded-full border bg-background/95 px-2.5 h-8 text-xs shadow-md hover:bg-muted transition-colors"
          aria-label={unseen > 0 ? `${unseen} mensagem(ns) nova(s) — ir para o fim` : "Ir para a mensagem mais recente"}
          title="Ir para a mensagem mais recente"
        >
          {unseen > 0 && (
            <span className="font-medium text-green-700 dark:text-green-400">
              {unseen} nova{unseen > 1 ? "s" : ""}
            </span>
          )}
          <ChevronDown className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function SystemPill({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-center my-2">
      <span className="rounded-md bg-white/90 dark:bg-zinc-800 px-2.5 py-0.5 text-xs text-muted-foreground shadow-sm">{children}</span>
    </div>
  );
}

// ─── Ícone de status (só mensagens OUT) ─────────────────────────────────────

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "sent":
      return <Check className="h-3 w-3" aria-label="Enviado" />;
    case "delivered":
      return <CheckCheck className="h-3 w-3" aria-label="Entregue" />;
    case "read":
      return <CheckCheck className="h-3 w-3 text-sky-500" aria-label="Lido" />;
    case "failed":
      return <XCircle className="h-3 w-3 text-red-500" aria-label="Falhou" />;
    default:
      return <Clock className="h-3 w-3" aria-label="Pendente" />;
  }
}

// ─── Bolha ──────────────────────────────────────────────────────────────────

function MessageBubble({ m, groupStart }: { m: InboxMessage; groupStart: boolean }) {
  const out = m.direction === "out";
  // Com o ficheiro à vista, o marcador "[imagem]"/"[áudio]" é redundante; a
  // caption (quando existe) continua a aparecer por baixo.
  const showBody = !(m.mediaAvailable && isMediaPlaceholderBody(m.body));
  const failed = out && m.status === "failed";
  return (
    <div className={cn("flex flex-col", out ? "items-end" : "items-start", groupStart ? "mt-2" : "mt-0.5")}>
      <div
        className={cn(
          "relative max-w-[88%] sm:max-w-[70%] xl:max-w-[62%] rounded-lg px-2 pt-1 pb-1 text-[13px] leading-[1.4] shadow-sm",
          out
            ? "bg-[#d9fdd3] text-zinc-900 dark:bg-[#005c4b] dark:text-zinc-50"
            : "bg-white text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100",
          groupStart && (out ? "rounded-tr-none" : "rounded-tl-none"),
          failed && "ring-1 ring-red-300 dark:ring-red-800",
        )}
      >
        {m.type === "template" && (
          <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-0.5">
            Template{m.templateName ? ` · ${m.templateName}` : ""}
          </div>
        )}
        <InboundMedia m={m} />
        {showBody ? (
          // Envios feitos antes de 2026-08-20 não gravaram o conteúdo: dizem-no
          // em itálico em vez de aparecerem em branco.
          <div className={cn("whitespace-pre-wrap break-words [overflow-wrap:anywhere]", !m.body?.trim() && "italic opacity-80")}>
            {messageDisplayBody(m) || "—"}
            {/* Espaço reservado para a hora/estado na última linha (como no WhatsApp). */}
            <span aria-hidden className={cn("inline-block", out ? "w-[3.4rem]" : "w-[2.4rem]")} />
          </div>
        ) : (
          <div aria-hidden className="h-3" />
        )}
        <span
          className={cn(
            "absolute bottom-0.5 right-1.5 flex items-center gap-0.5 text-[10px] leading-none tabular-nums",
            out ? "text-zinc-500 dark:text-zinc-300/80" : "text-zinc-500 dark:text-zinc-400",
          )}
        >
          {fmtTime(m.waTimestamp ?? m.createdAt)}
          {out && <StatusIcon status={m.status} />}
        </span>
      </div>
      {failed && m.errorDetail && (
        <div className="max-w-[88%] sm:max-w-[70%] mt-0.5 text-[11px] text-red-700 dark:text-red-300 text-right">{m.errorDetail}</div>
      )}
    </div>
  );
}

// ─── Media recebida (imagem / áudio / vídeo / documento) ────────────────────
// O ficheiro é privado: o URL assinado (10 min) é pedido só quando a bolha
// aparece, e renovado antes de expirar.
function InboundMedia({ m }: { m: Pick<InboxMessage, "id" | "mediaType" | "mediaAvailable" | "mediaMime" | "body"> }) {
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
      <a href={url} target="_blank" rel="noreferrer" className="block mb-1 -mx-1 -mt-0.5" title="Abrir imagem">
        <img
          src={url}
          alt={m.body && !isMediaPlaceholderBody(m.body) ? m.body : "Imagem recebida"}
          loading="lazy"
          className="max-h-60 max-w-full rounded-md object-contain bg-black/5"
        />
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
      <video controls preload="metadata" className="max-h-60 max-w-full rounded-md mb-1">
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
