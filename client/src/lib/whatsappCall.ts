/**
 * Chamada de voz do WhatsApp no browser (WebRTC nativo, sem dependências).
 *
 * Estado GLOBAL (fora do React): a ligação de áudio sobrevive à navegação entre
 * páginas. Só há uma chamada de cada vez por separador.
 *
 *  - atender: oferta SDP da Meta → getUserMedia (microfone) → resposta SDP
 *    (com os candidatos ICE todos — a Meta não aceita "trickle ICE") →
 *    servidor faz pre_accept + accept;
 *  - ligar: getUserMedia → oferta SDP → servidor faz `connect` → a resposta SDP
 *    chega pelo webhook e vem no polling do estado → setRemoteDescription.
 *
 * STUN público da Google. Sem TURN: redes muito fechadas (NAT simétrico /
 * firewall que bloqueia UDP) podem não ter áudio — ver docs/ajuda/whatsapp-chamadas.md.
 */
import { useSyncExternalStore } from "react";

export type CallPhase = "connecting" | "dialing" | "ringing" | "connected" | "ended";

export interface ActiveCall {
  id: number | null;
  direction: "in" | "out";
  conversationId: number | null;
  name: string;
  subtitle: string | null;
  phase: CallPhase;
  connectedAt: number | null;
  muted: boolean;
  message: string | null;
  remoteAnswerApplied: boolean;
}

interface Session {
  pc: RTCPeerConnection;
  stream: MediaStream;
  audio: HTMLAudioElement;
}

let active: ActiveCall | null = null;
let session: Session | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function set(patch: Partial<ActiveCall> | null) {
  active = patch === null ? null : active ? { ...active, ...patch } : null;
  emit();
}

export function getActiveCall(): ActiveCall | null {
  return active;
}

export function useActiveCall(): ActiveCall | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => active,
    () => null,
  );
}

export const ICE_SERVERS: RTCIceServer[] = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];

/** Espera o fim da recolha de candidatos ICE (a Meta quer o SDP completo). */
function waitIceComplete(pc: RTCPeerConnection, ms = 3000): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", check);
      clearTimeout(t);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const t = setTimeout(done, ms);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

export function webrtcSupported(): boolean {
  return typeof window !== "undefined" && typeof RTCPeerConnection !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

async function openSession(): Promise<Session> {
  if (!webrtcSupported()) throw new Error("Este browser não suporta chamadas (WebRTC).");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  } catch {
    throw new Error("Sem acesso ao microfone. Autoriza o microfone no browser para atender/ligar.");
  }
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
  const audio = new Audio();
  audio.autoplay = true;
  pc.ontrack = (ev) => {
    audio.srcObject = ev.streams[0] ?? new MediaStream([ev.track]);
    void audio.play().catch(() => undefined);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" && active && active.phase !== "ended") {
      set({ message: "Ligação de áudio falhou (rede/firewall)." });
    }
  };
  return { pc, stream, audio };
}

function closeSession() {
  const s = session;
  session = null;
  if (!s) return;
  try { s.stream.getTracks().forEach((t) => t.stop()); } catch { /* segue */ }
  try { s.pc.close(); } catch { /* segue */ }
  try { s.audio.srcObject = null; } catch { /* segue */ }
}

/** Cliente tRPC mínimo que as ações usam (vem de `trpc.useUtils().client`). */
export interface CallClient {
  whatsapp: {
    calls: {
      claim: { mutate(i: { id: number }): Promise<{ ok: true; sdpOffer: string; conversationId: number | null } | { ok: false; message: string; answeredByName: string | null }> };
      release: { mutate(i: { id: number }): Promise<unknown> };
      answer: { mutate(i: { id: number; sdp: string }): Promise<unknown> };
      reject: { mutate(i: { id: number }): Promise<unknown> };
      hangup: { mutate(i: { id: number }): Promise<unknown> };
      start: { mutate(i: { conversationId: number; sdp: string }): Promise<{ id: number; warning: string | null }> };
    };
  };
}

/** "Atender": ganha a chamada, cria a resposta SDP e aceita. Devolve a mensagem de erro, se houver. */
export async function answerIncoming(client: CallClient, call: { id: number; name: string; subtitle: string | null; conversationId: number | null }): Promise<string | null> {
  if (active && active.phase !== "ended") return "Já estás numa chamada.";
  const claim = await client.whatsapp.calls.claim.mutate({ id: call.id });
  if (!claim.ok) return claim.message;
  active = { id: call.id, direction: "in", conversationId: claim.conversationId ?? call.conversationId, name: call.name, subtitle: call.subtitle, phase: "connecting", connectedAt: null, muted: false, message: null, remoteAnswerApplied: true };
  emit();
  let s: Session;
  try {
    s = await openSession();
  } catch (e: any) {
    await client.whatsapp.calls.release.mutate({ id: call.id }).catch(() => undefined);
    set(null);
    return String(e?.message ?? e);
  }
  session = s;
  try {
    await s.pc.setRemoteDescription({ type: "offer", sdp: claim.sdpOffer });
    const answer = await s.pc.createAnswer();
    await s.pc.setLocalDescription(answer);
    await waitIceComplete(s.pc);
    const sdp = s.pc.localDescription?.sdp ?? answer.sdp ?? "";
    await client.whatsapp.calls.answer.mutate({ id: call.id, sdp });
    set({ phase: "connected", connectedAt: Date.now() });
    return null;
  } catch (e: any) {
    closeSession();
    set({ phase: "ended", message: String(e?.message ?? "Não foi possível atender.") });
    return String(e?.message ?? "Não foi possível atender.");
  }
}

/** "Ligar": oferta SDP → connect. A resposta SDP chega pelo polling do estado (applyRemoteAnswer). */
export async function startOutbound(client: CallClient, conv: { conversationId: number; name: string; subtitle: string | null }): Promise<{ error: string | null; warning: string | null }> {
  if (active && active.phase !== "ended") return { error: "Já estás numa chamada.", warning: null };
  active = { id: null, direction: "out", conversationId: conv.conversationId, name: conv.name, subtitle: conv.subtitle, phase: "connecting", connectedAt: null, muted: false, message: null, remoteAnswerApplied: false };
  emit();
  try {
    const s = await openSession();
    session = s;
    const offer = await s.pc.createOffer({ offerToReceiveAudio: true });
    await s.pc.setLocalDescription(offer);
    await waitIceComplete(s.pc);
    const sdp = s.pc.localDescription?.sdp ?? offer.sdp ?? "";
    const r = await client.whatsapp.calls.start.mutate({ conversationId: conv.conversationId, sdp });
    set({ id: r.id, phase: "dialing" });
    return { error: null, warning: r.warning };
  } catch (e: any) {
    closeSession();
    const msg = String(e?.message ?? "Não foi possível ligar.");
    set(null);
    return { error: msg, warning: null };
  }
}

/** Resposta SDP da Meta (chamada nossa) — aplicada 1×. */
export async function applyRemoteAnswer(sdp: string): Promise<void> {
  if (!session || !active || active.remoteAnswerApplied) return;
  active = { ...active, remoteAnswerApplied: true };
  try {
    await session.pc.setRemoteDescription({ type: "answer", sdp });
  } catch {
    set({ message: "Resposta de áudio inválida da Meta." });
  }
  emit();
}

/** Estado vindo do servidor (polling). */
export function syncFromServer(s: { status: string; answeredAt: string | null } | null) {
  if (!active || !s) return;
  if (s.status === "connected" && active.phase !== "connected") set({ phase: "connected", connectedAt: active.connectedAt ?? Date.now() });
  else if (s.status === "ringing" && active.direction === "out" && active.phase === "dialing") set({ phase: "ringing" });
  else if (["ended", "missed", "rejected", "failed"].includes(s.status) && active.phase !== "ended") {
    const message =
      s.status === "rejected" ? (active.direction === "out" ? "O cliente recusou a chamada." : "Chamada recusada.")
        : s.status === "missed" ? (active.direction === "out" ? "O cliente não atendeu." : "Chamada perdida.")
          : s.status === "failed" ? "A chamada falhou." : "Chamada terminada.";
    endLocal(message);
  }
}

/** Termina localmente (áudio fechado; o painel mostra a mensagem até fechar). */
export function endLocal(message: string | null = null) {
  closeSession();
  if (active) set({ phase: "ended", message: message ?? active.message });
}

export async function hangup(client: CallClient): Promise<string | null> {
  const id = active?.id;
  endLocal("Chamada terminada.");
  if (!id) return null;
  try {
    await client.whatsapp.calls.hangup.mutate({ id });
    return null;
  } catch (e: any) {
    return String(e?.message ?? e);
  }
}

export function toggleMute() {
  if (!active || !session) return;
  const muted = !active.muted;
  for (const t of session.stream.getAudioTracks()) t.enabled = !muted;
  set({ muted });
}

export function dismissEnded() {
  if (active?.phase === "ended") set(null);
}

// ─── Toque (Web Audio, sem ficheiros) ───────────────────────────────────────

let ringCtx: AudioContext | null = null;
let ringTimer: ReturnType<typeof setInterval> | null = null;

function ringBurst() {
  if (!ringCtx) return;
  const t0 = ringCtx.currentTime;
  for (const [offset, freq] of [[0, 440], [0, 480], [0.5, 440], [0.5, 480]] as const) {
    const osc = ringCtx.createOscillator();
    const gain = ringCtx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + offset);
    gain.gain.exponentialRampToValueAtTime(0.08, t0 + offset + 0.03);
    gain.gain.setValueAtTime(0.08, t0 + offset + 0.35);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.42);
    osc.connect(gain).connect(ringCtx.destination);
    osc.start(t0 + offset);
    osc.stop(t0 + offset + 0.45);
  }
}

export function startRingtone() {
  if (ringTimer) return;
  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    ringCtx = ringCtx ?? new Ctx();
    void ringCtx!.resume().catch(() => undefined);
    ringBurst();
    ringTimer = setInterval(ringBurst, 3000);
  } catch { /* sem som — o aviso visual continua */ }
}

export function stopRingtone() {
  if (ringTimer) clearInterval(ringTimer);
  ringTimer = null;
}
