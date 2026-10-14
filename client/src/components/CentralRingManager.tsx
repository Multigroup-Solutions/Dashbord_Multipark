/**
 * Lote 45 — a Central Vodafone toca no dashboard (Jorge: "quando a aplicação
 * toca, dê algum input aqui e também toque aqui"). Em qualquer página, para
 * quem tem um acesso da consola e o interruptor CENTRAL_RING ligado:
 *  - stream SSE (`/api/central/ring/stream`) + polling como rede de segurança,
 *    como o toque do WhatsApp;
 *  - aviso com quem liga (nome, cliente/equipa, reservas) e "Abrir ficha";
 *  - som durante 12 s no máximo (CENTRAL_RING_SOUND_MS; "Sem som neste browser"
 *    fica guardado neste browser);
 *  - as chamadas feitas pelos botões "Ligar" da dashboard não tocam (só avisam).
 * Atender e desligar continua a ser na consola. Jorge (14 out 2026): quem atende
 * na consola não pode ficar a ouvir o dashboard — o ícone do telefone é um botão
 * grande "Já atendi" (pára logo o som e, se houver endereço da consola, abre-a),
 * e qualquer clique no aviso também silencia. Quando a API da Vodafone disser
 * "atendida", o stream manda `answered` e o som pára sozinho.
 */
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Bell, PhoneIncoming, PhoneOutgoing, Volume2, VolumeX, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { fmtPhone } from "@/components/crm/crmUi";
import { CALL_STREAM_REOPEN_MS } from "@shared/whatsappCallSignal";
import {
  CENTRAL_CONSOLE_URL, CENTRAL_CONSOLE_WINDOW, CENTRAL_DIALED_MS, CENTRAL_RING_ANSWERED_EVENT, CENTRAL_RING_CARD_MS, CENTRAL_RING_SOUND_MS,
  CENTRAL_RING_STREAM_PATH, parseRingEventId, phoneTail, wasDialedByMe,
} from "@shared/centralRing";

const MUTE_KEY = "central-ring-muted";
const readMuted = (): boolean => {
  try { return localStorage.getItem(MUTE_KEY) === "1"; } catch { return false; }
};
const writeMuted = (v: boolean) => {
  try { localStorage.setItem(MUTE_KEY, v ? "1" : "0"); } catch { /* sem armazenamento: só nesta sessão */ }
};

// Toque europeu (425 Hz, 1 s ligado / 2 s desligado) — diferente do toque do WhatsApp.
let ctx: AudioContext | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
function burst() {
  if (!ctx) return;
  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = 425;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(0.08, t0 + 0.03);
  gain.gain.setValueAtTime(0.08, t0 + 0.95);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + 1.05);
}
function startRing() {
  if (timer) return;
  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    ctx = ctx ?? new Ctx();
    void ctx!.resume().catch(() => undefined);
    burst();
    timer = setInterval(burst, 3000);
  } catch { /* sem som — o aviso continua */ }
}
function stopRing() {
  if (timer) clearInterval(timer);
  timer = null;
  // Corta também o toque que está a meio (senão ainda se ouve até 1 s).
  if (ctx && ctx.state === "running") void ctx.suspend().catch(() => undefined);
}

/** Traz a consola da Vodafone para a frente, se tivermos um endereço para ela (por agora não há: só silencia). */
function focusConsole() {
  if (!CENTRAL_CONSOLE_URL) return;
  try {
    // Nome fixo: se o separador já estiver aberto, o browser reutiliza-o (e foca-o).
    const w = window.open(CENTRAL_CONSOLE_URL, CENTRAL_CONSOLE_WINDOW);
    w?.focus();
  } catch { /* bloqueado pelo browser — fica só o silêncio */ }
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

/**
 * SSE do toque: cada `ring` chama `onSignal`; `answered` (quando a API da
 * Vodafone o mandar) chama `onAnswered` com o id. Recusado/fechado de vez →
 * nova tentativa em 30 s.
 */
function useRingStream(enabled: boolean, onSignal: () => void, onAnswered: (id: number) => void): boolean {
  const [connected, setConnected] = useState(false);
  const signal = useRef(onSignal);
  signal.current = onSignal;
  const answered = useRef(onAnswered);
  answered.current = onAnswered;
  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    let es: EventSource | null = null;
    let reopen: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const open = () => {
      es = new EventSource(CENTRAL_RING_STREAM_PATH);
      es.onopen = () => { setConnected(true); signal.current(); };
      es.addEventListener("ring", () => signal.current());
      es.addEventListener(CENTRAL_RING_ANSWERED_EVENT, (ev) => {
        const id = parseRingEventId((ev as MessageEvent).data);
        if (id != null) answered.current(id);
      });
      es.onerror = () => {
        setConnected(false);
        if (es && es.readyState === EventSource.CLOSED && !stopped) {
          es = null;
          reopen = setTimeout(open, CALL_STREAM_REOPEN_MS);
        }
      };
    };
    open();
    return () => {
      stopped = true;
      if (reopen) clearTimeout(reopen);
      es?.close();
      setConnected(false);
    };
  }, [enabled]);
  return connected;
}

export function CentralRingManager({ enabled }: { enabled: boolean }) {
  const [, setLocation] = useLocation();
  const visible = usePageVisible();
  const utils = trpc.useUtils();
  const setup = trpc.central.ringSetup.useQuery(undefined, { enabled, staleTime: 5 * 60_000, retry: false });
  const on = enabled && !!setup.data?.enabled;
  const [silencedId, setSilencedId] = useState<number | null>(null);
  const streamConnected = useRingStream(on, () => { void utils.central.myRing.invalidate(); }, (id) => setSilencedId(id));
  const ringQ = trpc.central.myRing.useQuery(undefined, {
    enabled: on,
    refetchInterval: streamConnected ? 15_000 : visible ? 4_000 : 10_000,
    refetchIntervalInBackground: true,
    retry: false,
    staleTime: 0,
  });

  // Os "Ligar" (tel:) carregados aqui: a pesquisa da consola que vem a seguir é a chamada que eu fiz.
  const dialed = useRef<Array<{ tail: string; atMs: number }>>([]);
  useEffect(() => {
    if (!on) return;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href^="tel:"]') as HTMLAnchorElement | null;
      if (!a) return;
      const tail = phoneTail(a.getAttribute("href")?.slice(4));
      if (!tail) return;
      const now = Date.now();
      dialed.current = [...dialed.current.filter((d) => now - d.atMs <= CENTRAL_DIALED_MS), { tail, atMs: now }];
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [on]);

  const [muted, setMuted] = useState(readMuted);
  const [closedId, setClosedId] = useState<number | null>(null);
  const [card, setCard] = useState<{ ring: NonNullable<typeof ringQ.data>; mine: boolean; shownAt: number } | null>(null);

  // Nova chamada → novo aviso (o aviso fica mesmo depois de a pesquisa sair da janela do toque).
  const ring = ringQ.data ?? null;
  useEffect(() => {
    if (!ring || ring.id === closedId || ring.id === card?.ring.id) return;
    const mine = wasDialedByMe(dialed.current, ring.phone, Date.parse(ring.at));
    setCard({ ring, mine, shownAt: Date.now() });
    if (!mine && typeof document !== "undefined" && document.visibilityState === "hidden" && typeof Notification !== "undefined" && Notification.permission === "granted") {
      try { new Notification(`Central: ${ring.name}`, { body: [ring.title, fmtPhone(ring.phone)].filter(Boolean).join(" · "), tag: `central-${ring.id}` }); } catch { /* sem aviso do sistema */ }
    }
  }, [ring, closedId, card?.ring.id]);

  // Fecha sozinho.
  useEffect(() => {
    if (!card) return;
    const t = setTimeout(() => setCard(null), Math.max(0, card.shownAt + CENTRAL_RING_CARD_MS - Date.now()));
    return () => clearTimeout(t);
  }, [card]);

  // Som: só chamadas recebidas, até CENTRAL_RING_SOUND_MS (12 s), nunca silenciado.
  const [soundOver, setSoundOver] = useState(false);
  useEffect(() => {
    setSoundOver(false);
    if (!card) return;
    const t = setTimeout(() => setSoundOver(true), Math.max(0, card.shownAt + CENTRAL_RING_SOUND_MS - Date.now()));
    return () => clearTimeout(t);
  }, [card]);
  const ringing = !!card && !card.mine && !muted && !soundOver && silencedId !== card.ring.id;
  useEffect(() => {
    if (ringing) startRing();
    else stopRing();
    return () => stopRing();
  }, [ringing]);

  if (!on || !card) return null;
  const { ring: r, mine } = card;
  const close = () => { setClosedId(r.id); setCard(null); };
  const silence = () => { if (silencedId !== r.id) setSilencedId(r.id); };
  const answered = () => { silence(); focusConsole(); };
  const answerLabel = CENTRAL_CONSOLE_URL ? "Atender na consola" : "Já atendi";
  const silenced = silencedId === r.id;
  const canAskOsAlerts = typeof Notification !== "undefined" && Notification.permission === "default";
  // Ao meio, em cima (Jorge: "pop-up ao meio"), para se ver logo onde quer que se esteja.
  // Qualquer clique no aviso silencia (quem está ao telefone não tem de procurar o botão).
  return (
    <div className="fixed z-[60] left-1/2 -translate-x-1/2 top-16 w-[min(400px,calc(100vw-24px))]" aria-live="assertive">
      <div className="rounded-xl border bg-background shadow-lg p-3 space-y-2" role="alert" onClick={silence}>
        <div className="flex items-start gap-3">
          {mine ? (
            <div className="mt-0.5 rounded-full p-2 bg-muted text-muted-foreground"><PhoneOutgoing className="h-4 w-4" /></div>
          ) : (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); answered(); }}
              className={`flex w-[72px] shrink-0 flex-col items-center gap-1 rounded-xl px-1 py-2 text-[11px] font-semibold leading-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                silenced || !ringing ? "bg-muted text-muted-foreground hover:bg-muted/80" : "bg-primary text-primary-foreground hover:bg-primary/90"}`}
              aria-label={CENTRAL_CONSOLE_URL ? "Atender na consola (pára o som)" : "Já atendi na consola (pára o som)"}
              title={CENTRAL_CONSOLE_URL ? "Pára o som e abre a consola da Vodafone" : "Pára o som (atende na consola da Vodafone)"}
            >
              <span className={`rounded-full p-2 ${silenced || !ringing ? "bg-background/60" : "bg-primary-foreground/15"}`}>
                <PhoneIncoming className={`h-6 w-6 ${ringing ? "animate-pulse" : ""}`} />
              </span>
              {silenced ? "Silenciado" : answerLabel}
            </button>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{mine ? "Central · a ligar" : "Central · chamada"}</div>
            <div className="font-semibold truncate">{r.name}</div>
            <div className="text-xs text-muted-foreground truncate">{[r.title, r.internal ? r.phone : fmtPhone(r.phone)].filter(Boolean).join(" · ")}</div>
          </div>
          <button type="button" onClick={(e) => { e.stopPropagation(); close(); }} className="text-muted-foreground hover:text-foreground" aria-label="Fechar o aviso da chamada"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {r.href && (
            <Button size="sm" onClick={() => { setSilencedId(r.id); setLocation(r.href!); }}>Abrir ficha</Button>
          )}
          {!mine && (
            <Button size="sm" variant="ghost" onClick={() => { const v = !muted; setMuted(v); writeMuted(v); }} title={muted ? "Voltar a tocar nas próximas chamadas" : "O aviso continua a aparecer, sem som"}>
              {muted ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}{muted ? "Ligar o som" : "Sem som neste browser"}
            </Button>
          )}
          {canAskOsAlerts && !mine && (
            <Button size="sm" variant="ghost" onClick={() => { void Notification.requestPermission().catch(() => undefined); }} title="Mostra a chamada também quando o separador do dashboard está escondido">
              <Bell className="h-4 w-4" />Avisar fora do separador
            </Button>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">Atende e desliga na consola. Um clique aqui pára o som; a chamada fica registada quando a consola a envia no fim.</p>
      </div>
    </div>
  );
}
