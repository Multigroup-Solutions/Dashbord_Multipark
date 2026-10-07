/**
 * Lote 45 (Jorge, 7 out 2026): "quando a aplicação [da Vodafone] toca, dê
 * algum input aqui e também toque aqui". A consola só fala com a dashboard
 * por duas portas: a PESQUISA do número (quando a chamada entra, ou quando se
 * marca) e o registo da chamada no fim. O toque vem da pesquisa: cada uma fica
 * em `central_requests` com a nota `searchNote` ("pesquisa +351… → crm-12
 * Maria Silva"), na conta da consola de UMA pessoa — é essa pessoa que ouve.
 *
 * Regras PURAS partilhadas pelo servidor (`server/centralRing.ts`) e pelo
 * cliente (`CentralRingManager`).
 */
import { parseContactRef } from "./centralSugar";

/** Interruptor (Definições → Automações): desligado por omissão. */
export const CENTRAL_RING_FLAG = "CENTRAL_RING";
/** Stream do toque (mesma origem, cookie de sessão), igual ao das chamadas do WhatsApp. */
export const CENTRAL_RING_STREAM_PATH = "/api/central/ring/stream";
/** Uma pesquisa conta como "a tocar" durante este tempo. */
export const CENTRAL_RING_WINDOW_MS = 45_000;
/** O som pára sozinho ao fim disto (a chamada continua na consola). */
export const CENTRAL_RING_SOUND_MS = 25_000;
/** O aviso fecha sozinho ao fim disto. */
export const CENTRAL_RING_CARD_MS = 5 * 60_000;
/** A mesma pesquisa repetida (Contacts, Leads, Accounts…) dentro disto é a mesma chamada. */
export const CENTRAL_RING_SAME_CALL_MS = 15_000;
/**
 * A consola, ao entrar, volta a pesquisar as chamadas recentes de seguida
 * (39e): 3 ou mais números diferentes em 5 s não são uma chamada a tocar.
 */
export const CENTRAL_RING_BATCH_MS = 5_000;
export const CENTRAL_RING_BATCH_NUMBERS = 3;
/** Um clique num "Ligar" da dashboard para o mesmo número há menos disto → é a chamada que eu fiz (sem toque). */
export const CENTRAL_DIALED_MS = 90_000;

export interface RingNote { phone: string; ref: string; name: string }

/** Lê a nota de uma pesquisa por número ou extensão ("pesquisa X → ref nome"); outra nota → null. PURA. */
export function parseRingNote(note: unknown): RingNote | null {
  const m = /^pesquisa (\S+) → ((?:crm|ct|emp|tel|ext)-\d{1,20}) (.*)$/.exec(String(note ?? ""));
  if (!m || !parseContactRef(m[2])) return null;
  return { phone: m[1], ref: m[2], name: m[3].trim() || m[1] };
}

export interface RingRequestRow { id: number; atMs: number; note: unknown }
export interface RingPick extends RingNote { id: number; atMs: number }

/** Os últimos 9 dígitos (o que identifica um número português, com ou sem +351/00351). PURA. */
export function phoneTail(raw: unknown): string {
  const d = String(raw ?? "").replace(/\D/g, "");
  return d.length > 9 ? d.slice(-9) : d;
}

/**
 * A chamada a tocar para uma pessoa, a partir das pesquisas recentes da(s)
 * consola(s) dela (qualquer ordem). Devolve a mais recente, com o id da
 * PRIMEIRA pesquisa desse número nessa chamada (o id não muda quando a
 * consola pesquisa outra vez noutro módulo). Nada → null. PURA.
 */
export function pickRing(rows: readonly RingRequestRow[], now: number): RingPick | null {
  const hits = rows
    .map((r) => ({ id: Number(r.id), atMs: Number(r.atMs), n: parseRingNote(r.note) }))
    .filter((r): r is { id: number; atMs: number; n: RingNote } => !!r.n && Number.isFinite(r.atMs) && r.atMs <= now + 5_000)
    .sort((a, b) => a.atMs - b.atMs || a.id - b.id);
  if (!hits.length) return null;
  const last = hits[hits.length - 1];
  if (now - last.atMs > CENTRAL_RING_WINDOW_MS) return null;
  // A consola a reler o histórico: muitos números diferentes de seguida → não toca.
  const burst = new Set(hits.filter((h) => last.atMs - h.atMs <= CENTRAL_RING_BATCH_MS).map((h) => phoneTail(h.n.phone)));
  if (burst.size >= CENTRAL_RING_BATCH_NUMBERS) return null;
  // Primeira pesquisa deste número na mesma chamada (pesquisas seguidas com menos de 15 s entre elas).
  const tail = phoneTail(last.n.phone);
  let first = last;
  for (let i = hits.length - 2; i >= 0; i--) {
    const h = hits[i];
    if (phoneTail(h.n.phone) !== tail) continue;
    if (first.atMs - h.atMs > CENTRAL_RING_SAME_CALL_MS) break;
    first = h;
  }
  return { id: first.id, atMs: first.atMs, phone: last.n.phone, ref: last.n.ref, name: last.n.name };
}

/** Para onde leva o "Abrir ficha" do aviso (o mesmo destino que o contacto aberto na consola). PURA. */
export function ringContactHref(ref: string): string | null {
  const r = parseContactRef(ref);
  if (!r || r.kind === "ext") return null;
  if (r.kind === "crm") return `/clientes/${r.id}`;
  if (r.kind === "emp") return "/rh";
  if (r.kind === "tel") return `/clientes?q=${encodeURIComponent(`+${r.id}`)}`;
  return "/clientes";
}

/**
 * Fui eu que liguei? Um clique num "Ligar" (tel:) da dashboard para o mesmo
 * número há menos de 90 s → é a chamada que a pessoa fez, não toca. PURA.
 */
export function wasDialedByMe(dialed: ReadonlyArray<{ tail: string; atMs: number }>, phone: string, ringAtMs: number): boolean {
  const tail = phoneTail(phone);
  if (!tail) return false;
  return dialed.some((d) => d.tail === tail && ringAtMs - d.atMs <= CENTRAL_DIALED_MS && ringAtMs - d.atMs >= -5_000);
}

/** Um evento SSE do toque (só o id — quem liga vem pelo tRPC `central.myRing`). PURA. */
export function formatRingEvent(id: number): string {
  return `event: ring\ndata: ${JSON.stringify({ id })}\n\n`;
}
