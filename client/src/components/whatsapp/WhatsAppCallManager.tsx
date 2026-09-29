/**
 * Chamadas de voz do WhatsApp em QUALQUER página do dashboard:
 *  - toque (aviso + som) das chamadas recebidas a tocar na(s) cidade(s) da
 *    pessoa — polling curto (3 s com o separador visível, 10 s escondido);
 *  - "Atender" (o primeiro ganha; os outros veem "atendida por X") / "Recusar";
 *  - painel da chamada em curso: nome, reserva, cronómetro, silenciar, desligar.
 * Só para quem tem o WhatsApp com "editar" (o servidor volta a verificar).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { Mic, MicOff, Phone, PhoneIncoming, PhoneOff, X, MessageCircle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { formatCallTimer } from "@shared/whatsappCalls";
import {
  answerIncoming, applyRemoteAnswer, dismissEnded, hangup, startRingtone, stopRingtone, syncFromServer, toggleMute, useActiveCall,
  type CallClient,
} from "@/lib/whatsappCall";

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

export function WhatsAppCallManager({ enabled, userId }: { enabled: boolean; userId: number | null }) {
  const visible = usePageVisible();
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const client = utils.client as unknown as CallClient;
  const active = useActiveCall();
  const [ignored, setIgnored] = useState<Set<number>>(() => new Set());
  const [busyId, setBusyId] = useState<number | null>(null);
  const seenRinging = useRef<Map<number, number>>(new Map());
  const [now, setNow] = useState(() => Date.now());

  const incoming = trpc.whatsapp.calls.incoming.useQuery(undefined, {
    enabled,
    refetchInterval: visible ? 3_000 : 10_000,
    refetchIntervalInBackground: true,
    retry: false,
    staleTime: 0,
  });

  const state = trpc.whatsapp.calls.state.useQuery(
    { id: active?.id ?? 0 },
    { enabled: enabled && !!active?.id && active.phase !== "ended", refetchInterval: 1_500, refetchIntervalInBackground: true, retry: false },
  );

  // Estado do servidor → chamada local (resposta SDP, ligado, terminado).
  useEffect(() => {
    const s = state.data;
    if (!s || !active || s.id !== active.id) return;
    if (s.sdpAnswer && active.direction === "out" && !active.remoteAnswerApplied) void applyRemoteAnswer(s.sdpAnswer);
    syncFromServer(s);
  }, [state.data, active]);

  // Cronómetro.
  useEffect(() => {
    if (!active || active.phase === "ended") return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [active]);

  // Painel de chamada terminada fecha sozinho.
  useEffect(() => {
    if (active?.phase !== "ended") return;
    const t = setTimeout(() => dismissEnded(), 6_000);
    return () => clearTimeout(t);
  }, [active?.phase]);

  const rows = incoming.data ?? [];
  const ringing = useMemo(
    () => rows.filter((c) => c.status === "ringing" && !ignored.has(c.id) && c.id !== active?.id),
    [rows, ignored, active?.id],
  );
  for (const c of ringing) if (!seenRinging.current.has(c.id)) seenRinging.current.set(c.id, Date.now());
  // Chamadas que eu vi a tocar e que outra pessoa atendeu/recusou.
  const takenByOthers = rows.filter(
    (c) => c.status !== "ringing" && seenRinging.current.has(c.id) && c.answeredByUserId != null && c.answeredByUserId !== userId && !ignored.has(c.id),
  );

  const shouldRing = ringing.length > 0 && !(active && active.phase !== "ended");
  useEffect(() => {
    if (shouldRing) startRingtone();
    else stopRingtone();
    return () => stopRingtone();
  }, [shouldRing]);

  // Título do separador pisca enquanto toca.
  useEffect(() => {
    if (!shouldRing) return;
    const original = document.title;
    let on = false;
    const t = setInterval(() => {
      on = !on;
      document.title = on ? `📞 ${ringing[0]?.name ?? "Chamada"} a ligar…` : original;
    }, 1_000);
    return () => {
      clearInterval(t);
      document.title = original;
    };
  }, [shouldRing, ringing[0]?.name]);

  if (!enabled) return null;

  const subtitleOf = (c: (typeof rows)[number]) =>
    c.bookingNumber ? `Reserva ${c.bookingNumber}${c.bookingClient ? ` · ${c.bookingClient}` : ""}` : c.phoneE164;

  async function onAnswer(c: (typeof rows)[number]) {
    setBusyId(c.id);
    stopRingtone();
    const err = await answerIncoming(client, { id: c.id, name: c.name, subtitle: subtitleOf(c), conversationId: c.conversationId });
    setBusyId(null);
    if (err) toast.error(err);
    void incoming.refetch();
  }

  async function onReject(c: (typeof rows)[number]) {
    setBusyId(c.id);
    try {
      await client.whatsapp.calls.reject.mutate({ id: c.id });
      toast.message("Chamada recusada.");
    } catch (e: any) {
      toast.error(String(e?.message ?? e));
    }
    setBusyId(null);
    setIgnored((s) => new Set(s).add(c.id));
    void incoming.refetch();
  }

  const ignore = (id: number) => setIgnored((s) => new Set(s).add(id));

  return (
    <div className="fixed z-[60] right-3 bottom-24 md:bottom-6 flex flex-col gap-2 w-[min(360px,calc(100vw-24px))]" aria-live="assertive">
      {ringing.map((c) => (
        <div key={c.id} role="alertdialog" aria-label={`Chamada de ${c.name}`} className="rounded-xl border bg-card shadow-2xl p-3 animate-in slide-in-from-bottom-2">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-full bg-green-600 text-white flex items-center justify-center shrink-0 animate-pulse">
              <PhoneIncoming className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] uppercase tracking-wide text-green-700 dark:text-green-400 font-semibold">Chamada WhatsApp</div>
              <div className="font-semibold truncate">{c.name}</div>
              <div className="text-xs text-muted-foreground truncate">{subtitleOf(c)}</div>
            </div>
            <button type="button" aria-label="Ignorar (deixa de tocar aqui)" title="Ignorar (deixa de tocar aqui)" className="opacity-60 hover:opacity-100" onClick={() => ignore(c.id)}>
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex gap-2 mt-3">
            <Button className="flex-1 bg-green-600 hover:bg-green-700 text-white" disabled={busyId != null || !!(active && active.phase !== "ended")} onClick={() => onAnswer(c)}>
              <Phone className="h-4 w-4 mr-1.5" /> Atender
            </Button>
            <Button variant="destructive" className="flex-1" disabled={busyId != null} onClick={() => onReject(c)}>
              <PhoneOff className="h-4 w-4 mr-1.5" /> Recusar
            </Button>
          </div>
        </div>
      ))}

      {takenByOthers.map((c) => (
        <div key={`t${c.id}`} className="rounded-xl border bg-card shadow p-2.5 flex items-center gap-2 text-sm">
          <Phone className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="flex-1 truncate">
            {c.name}: {c.status === "rejected" ? "recusada" : "atendida"} por <strong>{c.answeredByName ?? "outra pessoa"}</strong>
          </span>
          <button type="button" aria-label="Fechar" className="opacity-60 hover:opacity-100" onClick={() => ignore(c.id)}>
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}

      {active && (
        <div className="rounded-xl border bg-card shadow-2xl p-3" role="region" aria-label="Chamada em curso">
          <div className="flex items-start gap-3">
            <div className={`h-10 w-10 rounded-full flex items-center justify-center shrink-0 text-white ${active.phase === "ended" ? "bg-muted-foreground" : "bg-green-600"}`}>
              <Phone className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground">
                {active.phase === "connecting" ? (active.direction === "in" ? "A atender…" : "A preparar a chamada…")
                  : active.phase === "dialing" ? "A chamar…"
                    : active.phase === "ringing" ? "A tocar no cliente…"
                      : active.phase === "connected" ? `Em chamada · ${formatCallTimer(now - (active.connectedAt ?? now))}`
                        : "Chamada terminada"}
              </div>
              <div className="font-semibold truncate">{active.name}</div>
              {active.subtitle && <div className="text-xs text-muted-foreground truncate">{active.subtitle}</div>}
              {active.message && <div className="text-xs mt-1 text-amber-700 dark:text-amber-300">{active.message}</div>}
            </div>
            {active.phase === "ended" && (
              <button type="button" aria-label="Fechar" className="opacity-60 hover:opacity-100" onClick={() => dismissEnded()}>
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          {active.phase !== "ended" && (
            <div className="flex gap-2 mt-3">
              <Button variant="outline" className="flex-1" disabled={active.phase === "connecting"} onClick={() => toggleMute()} aria-pressed={active.muted}>
                {active.muted ? <MicOff className="h-4 w-4 mr-1.5" /> : <Mic className="h-4 w-4 mr-1.5" />}
                {active.muted ? "Ligar micro" : "Silenciar"}
              </Button>
              <Button
                variant="destructive"
                className="flex-1"
                onClick={async () => {
                  const err = await hangup(client);
                  if (err) toast.error(err);
                }}
              >
                <PhoneOff className="h-4 w-4 mr-1.5" /> Desligar
              </Button>
            </div>
          )}
          {active.conversationId != null && (
            <button type="button" className="mt-2 text-xs underline text-muted-foreground inline-flex items-center gap-1" onClick={() => setLocation(`/whatsapp?c=${active.conversationId}`)}>
              <MessageCircle className="h-3 w-3" /> Abrir conversa
            </button>
          )}
        </div>
      )}
    </div>
  );
}
