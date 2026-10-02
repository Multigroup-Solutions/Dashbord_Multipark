/**
 * Canal de toque das chamadas do WhatsApp (SSE) — regras PURAS partilhadas
 * entre o servidor (`server/whatsappCallStream.ts`) e o cliente
 * (`WhatsAppCallManager`).
 *
 * O stream não leva dados pessoais: só diz "esta chamada começou a tocar" ou
 * "esta chamada deixou de tocar". O cliente volta a pedir
 * `whatsapp.calls.incoming` (tRPC, com as verificações de sempre) para saber
 * quem liga. Assim o stream nunca mostra mais do que a query já mostra.
 */

/** Rota do stream (mesma origem; sessão por cookie). */
export const CALL_STREAM_PATH = "/api/whatsapp/calls/stream";
/** O browser volta a tentar este tempo depois de o stream ser recusado ou falhar de vez. */
export const CALL_STREAM_REOPEN_MS = 30_000;
/** Uma ligação SSE dura no máximo isto (a função do Vercel tem maxDuration 60 s). */
export const CALL_STREAM_MAX_MS = 50_000;
/**
 * Intervalo entre verificações dentro do stream. 2 s (17e — era 1 s): a Meta
 * dá 30–60 s para atender; e a leitura é partilhada por processo
 * (`anyIncomingCallCached`), não uma por separador.
 */
export const CALL_STREAM_TICK_MS = 2_000;
/** Validade da leitura partilhada "há alguma chamada a tocar?" (por processo). */
export const RING_PROBE_TTL_MS = 2_000;
/** Comentário SSE para manter a ligação viva nos proxies. */
export const CALL_STREAM_PING_MS = 15_000;
/** O browser volta a ligar-se este tempo depois de o servidor fechar o stream. */
export const CALL_STREAM_RETRY_MS = 1_000;
/** Erros seguidos da BD antes de o stream fechar (o browser volta a ligar-se). */
export const CALL_STREAM_MAX_DB_ERRORS = 3;

export type RingEvent = { type: "ring" | "ring-cleared"; id: number };

export interface RingRow {
  id: number;
  status: string;
}

/** Ids das chamadas a tocar numa lista do `incoming`. PURA. */
export function ringingIds(rows: readonly RingRow[]): Set<number> {
  const out = new Set<number>();
  for (const r of rows) if (r.status === "ringing") out.add(r.id);
  return out;
}

/**
 * Diferença entre duas leituras: chamadas que passaram a tocar (`ring`) e
 * chamadas que deixaram de tocar (`ring-cleared`: atendida por alguém,
 * recusada, perdida ou terminada). Ordenado por id para ser determinístico.
 * PURA.
 */
export function diffRinging(prev: ReadonlySet<number>, next: ReadonlySet<number>): RingEvent[] {
  const out: RingEvent[] = [];
  for (const id of Array.from(next).sort((a, b) => a - b)) if (!prev.has(id)) out.push({ type: "ring", id });
  for (const id of Array.from(prev).sort((a, b) => a - b)) if (!next.has(id)) out.push({ type: "ring-cleared", id });
  return out;
}

/** Um evento no formato text/event-stream. PURA. */
export function formatSseEvent(ev: RingEvent): string {
  return `event: ${ev.type}\ndata: ${JSON.stringify({ id: ev.id })}\n\n`;
}

/**
 * Intervalo do polling do toque. O polling fica SEMPRE como rede de
 * segurança; com o stream ligado passa a 15 s (o toque chega pelo stream em
 * ~1 s e o polling só serve para o caso de o stream parar sem erro). Sem
 * stream fica como antes (3 s visível, 10 s escondido). PURA.
 */
export function ringPollIntervalMs(visible: boolean, streamConnected: boolean): number {
  if (streamConnected) return 15_000;
  return visible ? 3_000 : 10_000;
}
