/**
 * P3 lote 32a — Rádio × GPS × Multipark (Jorge, 6 out 2026): "o utilizador
 * escolhe uma data e hora, um intervalo de tempo ou um utilizador e a app vai
 * buscar as gravações e/ou transcrições à API do Zello; depois cruza-se com as
 * localizações e velocidades do utilizador e com as movimentações e o
 * histórico da Multipark."
 *
 * Regras PURAS: intervalo (hora de relógio de Lisboa; "até" antes do "de" =
 * dia seguinte, como no turno da noite), mensagem do Zello, ponto GPS mais
 * perto da hora da mensagem, quem tinha o PDA nessa hora e as ações da
 * Multipark à volta da mensagem.
 */
import { addDays, lisbonWallTimeUtcMs } from "./lisbonDay";

/** Intervalo máximo de uma pesquisa (o Zello devolve as mensagens às páginas). */
export const RADIO_MAX_RANGE_MS = 24 * 3_600_000;
/** Ponto GPS conta se estiver até 5 min da mensagem. */
export const RADIO_GPS_MAX_GAP_MS = 5 * 60_000;
/** Ações da Multipark até 10 min antes/depois da mensagem. */
export const RADIO_ACTION_WINDOW_MS = 10 * 60_000;

const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Dia + "HH:MM" de/até (Lisboa) → instantes UTC. "Até" ≤ "de" = no dia
 * seguinte (22:00 → 02:00). PURA.
 */
export function radioRange(day: string, from: string, to: string): { fromMs: number; toMs: number } | { error: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { error: "Dia inválido." };
  const f = HM.exec(from), t = HM.exec(to);
  if (!f || !t) return { error: "Hora inválida (HH:MM)." };
  const fromMs = lisbonWallTimeUtcMs(day, Number(f[1]) + Number(f[2]) / 60);
  const toDay = to <= from ? addDays(day, 1) : day;
  // "até 23:59" inclui o minuto todo
  const toMs = lisbonWallTimeUtcMs(toDay, Number(t[1]) + Number(t[2]) / 60) + (to === "23:59" ? 60_000 : 0);
  if (toMs - fromMs > RADIO_MAX_RANGE_MS) return { error: "No máximo 24 horas de cada vez." };
  return { fromMs, toMs };
}

export interface RadioMessage {
  id: number;
  type: string;
  /** instante UTC (ms) */
  at: number;
  sender: string;
  senderName: string | null;
  recipient: string | null;
  recipientType: "user" | "channel" | "dispatch_call" | string | null;
  durationS: number | null;
  mediaKey: string | null;
  transcription: string | null;
  transcriptionInaccurate: boolean;
  text: string | null;
}

const str = (v: unknown) => (v == null || String(v).trim() === "" ? null : String(v).trim());

/** Mensagem do history/getmetadata → a nossa forma (null se não der). PURA. */
export function mapZelloMessage(m: Record<string, unknown>): RadioMessage | null {
  const id = Number(m.id), ts = Number(m.ts);
  const sender = str(m.sender);
  if (!Number.isFinite(id) || !Number.isFinite(ts) || ts <= 0 || !sender) return null;
  // ts em segundos (o Zello); se vier em ms, aceita
  const at = ts > 1e12 ? ts : ts * 1000;
  const dur = Number(m.duration);
  return {
    id, type: str(m.type) ?? "voice", at, sender, senderName: str(m.author_full_name),
    recipient: str(m.recipient), recipientType: str(m.recipient_type),
    durationS: Number.isFinite(dur) && dur > 0 ? Math.round(dur / 100) / 10 : null,
    mediaKey: str(m.media_key), transcription: str(m.transcription),
    transcriptionInaccurate: String(m.transcription_inaccurate ?? "").toLowerCase() === "yes",
    text: str(m.text),
  };
}

export interface GpsPoint { at: number; lat: number | null; lon: number | null; speed: number }

/** Ponto GPS mais perto da hora (até `maxGapMs`), com a distância em segundos. PURA. */
export function nearestPoint(points: readonly GpsPoint[], at: number, maxGapMs = RADIO_GPS_MAX_GAP_MS): (GpsPoint & { deltaS: number }) | null {
  let best: GpsPoint | null = null;
  for (const p of points) if (!best || Math.abs(p.at - at) < Math.abs(best.at - at)) best = p;
  if (!best || Math.abs(best.at - at) > maxGapMs) return null;
  return { ...best, deltaS: Math.round((best.at - at) / 1000) };
}

/** Quem tinha o PDA (conta do Zello) a essa hora: o check-in que cobre o instante. PURA. */
export function holderAt(intervals: ReadonlyArray<{ employeeId: number; start: number; end: number }> | undefined, at: number): number | null {
  if (!intervals?.length) return null;
  const hit = intervals.filter((i) => i.start <= at && at <= i.end).sort((a, b) => b.start - a.start)[0];
  return hit ? hit.employeeId : null;
}

export interface MpAction { userId: string; at: number; changeType: string; bookingCode: string | null; plate: string | null; park: string | null }

/** Ações da Multipark dos agentes da pessoa à volta da mensagem, as mais perto primeiro. PURA. */
export function actionsNear(actions: readonly MpAction[], agentIds: ReadonlySet<string>, at: number, windowMs = RADIO_ACTION_WINDOW_MS, max = 5): Array<MpAction & { deltaS: number }> {
  return actions
    .filter((a) => agentIds.has(a.userId) && Math.abs(a.at - at) <= windowMs)
    .map((a) => ({ ...a, deltaS: Math.round((a.at - at) / 1000) }))
    .sort((x, y) => Math.abs(x.deltaS) - Math.abs(y.deltaS))
    .slice(0, max);
}

const CHANGE_LABEL: Record<string, string> = {
  CHECK_IN: "Entrada (check-in)", CHECK_OUT: "Saída (check-out)", MOVEMENT: "Movimento", CHECKING_IN: "A entrar", CHECKING_OUT: "A sair",
};
/** "Saída (check-out)". PURA. */
export const changeLabel = (c: string) => CHANGE_LABEL[c] ?? c.replace(/_/g, " ").toLowerCase();

/** "+40 s" / "−3 min". PURA. */
export function fmtDelta(s: number): string {
  const sign = s > 0 ? "+" : s < 0 ? "−" : "";
  const a = Math.abs(s);
  return a < 90 ? `${sign}${a} s` : `${sign}${Math.round(a / 60)} min`;
}

// ─── 36a: o áudio vem pelo nosso servidor ───────────────────────────────────
/** Áudio de uma mensagem até isto (a resposta da Vercel tem limite). */
export const RADIO_AUDIO_MAX_BYTES = 3 * 1024 * 1024;

/**
 * Que áudio é isto, pelos primeiros bytes (o Zello nem sempre manda o tipo
 * certo). null = não é áudio (ex.: uma página de erro). PURA.
 */
export function sniffAudioMime(b: Uint8Array): string | null {
  if (b.length < 4) return null;
  const s4 = String.fromCharCode(b[0], b[1], b[2], b[3]);
  if (s4.startsWith("ID3")) return "audio/mpeg";
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return "audio/mpeg";
  if (s4 === "OggS") return "audio/ogg";
  if (s4 === "RIFF") return "audio/wav";
  if (s4 === "#!AM") return "audio/amr";
  if (b.length >= 8 && String.fromCharCode(b[4], b[5], b[6], b[7]) === "ftyp") return "audio/mp4";
  return null;
}

/** O browser consegue tocar isto? (AMR não; o resto sim nos browsers atuais). PURA. */
export const browserPlayable = (mime: string) => mime !== "audio/amr";

