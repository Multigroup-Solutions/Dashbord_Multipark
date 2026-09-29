/**
 * FECHO DO MÊS DE PARCEIROS — como uma caixa (decisão do dono, 29 set 2026):
 * no fim do mês compara-se, parceiro a parceiro, o que a Multipark tem agora
 * com o que a NOSSA memória do webhook guardou (o último retrato de cada
 * reserva), só as reservas CONCLUÍDAS com SAÍDA no mês:
 *   - número de reservas, valor (o que o parceiro recebeu), o NOSSO (devido)
 *     e as faturas (na Multipark);
 *   - reserva a reserva, o que não bate.
 * A memória do webhook começa a 28/09/2026 19:23: antes disso não há nada
 * nosso para comparar (não conta como diferença). PURO.
 */

/** Início da memória do webhook (UTC). */
export const MEMORY_START_UTC = "2026-09-28 18:23:00";
export const CLOSE_TOLERANCE = 0.01;

export interface CloseMpBooking {
  id: string; code: string | null; partnerKey: string; partnerName: string | null;
  value: number; ours: number | null; dueMissing: boolean; checkOut: string | null; invoices: number;
  /** preço da reserva agora (para comparar com o preço inicial do histórico) */
  price?: number | null;
}
/** Histórico carregado (booking_initial_prices): o preço com que a reserva nasceu. */
export interface CloseHistory { initialPrice: number | null }
export interface CloseOurSnap {
  bookingId: string; status: string | null; checkOut: string | null; partnerId: string | null;
  value: number | null; ours: number | null; receivedAt: string | null;
}
export interface CloseMpState { status: string | null; checkOut: string | null; partnerId: string | null }

export type CloseDiffCode =
  | "falta_na_copia"      // a Multipark tem a saída; a nossa memória não tem a reserva
  | "saida_nao_recebida"  // temos a reserva, mas o último retrato não é esta saída
  | "falta_na_multipark"  // a nossa memória dá saída no mês; a Multipark não (cancelada, outro mês…)
  | "parceiro_diferente"
  | "valor_diferente"
  | "devido_diferente"
  | "sem_devido"          // a Multipark não tem o devido gravado
  | "preco_alterado";     // o preço de agora ≠ o preço com que nasceu (histórico)

export const CLOSE_DIFF_LABELS: Record<CloseDiffCode, string> = {
  falta_na_copia: "Não chegou pelo webhook",
  saida_nao_recebida: "Saída não chegou pelo webhook",
  falta_na_multipark: "Na nossa cópia saiu, na Multipark não",
  parceiro_diferente: "Parceiro diferente",
  valor_diferente: "Valor diferente",
  devido_diferente: "Nosso (devido) diferente",
  sem_devido: "Sem devido gravado na Multipark",
  preco_alterado: "Preço mudou depois de criada",
};

export interface CloseDiff { bookingId: string; code: string | null; codes: CloseDiffCode[]; detail: string }
export interface PartnerCloseRow {
  partnerKey: string;
  partnerName: string | null;
  mp: { bookings: number; value: number; ours: number; invoices: number; noInvoice: number; noDue: number };
  /** nossa: memória do webhook (desde 28/09) + histórico carregado (antes). O devido só existe na memória. */
  copy: { bookings: number; value: number; ours: number; fromHistory: number };
  /** reservas sem nada nosso (nem memória nem histórico) antes da memória do webhook */
  beforeMemory: number;
  diffs: CloseDiff[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const eur = (n: number | null | undefined) => (n == null ? "—" : `${n.toFixed(2).replace(".", ",")} €`);
const inRange = (t: string | null, start: string, end: string) => !!t && t >= start && t < end;
const done = (s: string | null | undefined) => String(s ?? "").toUpperCase() === "CHECKED_OUT";

/**
 * Compara o mês. `partnerOf` traduz o "Partner".id (que a memória guarda) na
 * empresa (userId); `mpState` = estado atual na Multipark das reservas que só
 * a nossa memória dá como do mês. `start`/`end` = limites do mês em UTC. PURA.
 */
export function comparePartnerMonth(input: {
  mp: readonly CloseMpBooking[];
  ours: ReadonlyMap<string, CloseOurSnap>;
  partnerOf: ReadonlyMap<string, { key: string; name: string | null }>;
  mpState: ReadonlyMap<string, CloseMpState>;
  /** histórico carregado (preço inicial) das reservas, para as de antes da memória */
  history?: ReadonlyMap<string, CloseHistory>;
  /** faturas mensais (sem reserva) por empresa parceira */
  monthlyInvoices?: ReadonlyMap<string, number>;
  start: string; end: string;
}): PartnerCloseRow[] {
  const rows = new Map<string, PartnerCloseRow>();
  const row = (key: string, name: string | null) => {
    let r = rows.get(key);
    if (!r) {
      r = { partnerKey: key, partnerName: name, mp: { bookings: 0, value: 0, ours: 0, invoices: 0, noInvoice: 0, noDue: 0 }, copy: { bookings: 0, value: 0, ours: 0, fromHistory: 0 }, beforeMemory: 0, diffs: [] };
      rows.set(key, r);
    }
    if (!r.partnerName && name) r.partnerName = name;
    return r;
  };
  const ourInMonth = (s: CloseOurSnap | undefined) => !!s && done(s.status) && inRange(s.checkOut, input.start, input.end) && !!s.partnerId;
  const seen = new Set<string>();

  for (const b of input.mp) {
    seen.add(b.id);
    const r = row(b.partnerKey, b.partnerName);
    r.mp.bookings++; r.mp.value = r2(r.mp.value + b.value); r.mp.ours = r2(r.mp.ours + (b.ours ?? 0));
    r.mp.invoices += b.invoices;
    if (b.dueMissing) r.mp.noDue++;
    const s = input.ours.get(b.id);
    const codes: CloseDiffCode[] = [];
    const notes: string[] = [];
    if (b.dueMissing) codes.push("sem_devido");
    const h = input.history?.get(b.id);
    if (!s && h) {
      // antes da memória: o nosso lado é o histórico carregado (preço com que nasceu)
      r.copy.bookings++; r.copy.fromHistory++; r.copy.value = r2(r.copy.value + (h.initialPrice ?? 0));
      const now = b.price ?? null;
      if (h.initialPrice != null && now != null && Math.abs(h.initialPrice - now) > CLOSE_TOLERANCE) {
        codes.push("preco_alterado"); notes.push(`preço inicial ${eur(h.initialPrice)} → agora ${eur(now)}`);
      }
    } else if (!s) {
      if (b.checkOut && b.checkOut < MEMORY_START_UTC) { r.beforeMemory++; }
      else { codes.push("falta_na_copia"); }
    } else if (!ourInMonth(s)) {
      codes.push("saida_nao_recebida");
      notes.push(`último retrato: ${s.status ?? "?"}${s.checkOut ? ` · saída ${s.checkOut}` : ""}`);
    } else {
      const sp = s.partnerId ? input.partnerOf.get(s.partnerId)?.key ?? s.partnerId : null;
      r.copy.bookings++; r.copy.value = r2(r.copy.value + (s.value ?? 0)); r.copy.ours = r2(r.copy.ours + (s.ours ?? 0));
      if (sp !== b.partnerKey) { codes.push("parceiro_diferente"); notes.push(`nossa cópia: ${input.partnerOf.get(s.partnerId ?? "")?.name ?? s.partnerId}`); }
      if (s.value != null && Math.abs(s.value - b.value) > CLOSE_TOLERANCE) { codes.push("valor_diferente"); notes.push(`valor ${eur(s.value)} → ${eur(b.value)}`); }
      if (Math.abs((s.ours ?? 0) - (b.ours ?? 0)) > CLOSE_TOLERANCE) { codes.push("devido_diferente"); notes.push(`nosso ${eur(s.ours)} → ${eur(b.ours)}`); }
    }
    if (codes.length) r.diffs.push({ bookingId: b.id, code: b.code, codes, detail: notes.join(" · ") });
  }

  // o que só a NOSSA memória dá como saída de parceiro no mês
  for (const [id, s] of input.ours) {
    if (seen.has(id) || !ourInMonth(s)) continue;
    const p = input.partnerOf.get(s.partnerId ?? "");
    const r = row(p?.key ?? s.partnerId ?? "?", p?.name ?? null);
    r.copy.bookings++; r.copy.value = r2(r.copy.value + (s.value ?? 0)); r.copy.ours = r2(r.copy.ours + (s.ours ?? 0));
    const now = input.mpState.get(id);
    const why = !now ? "não encontrada na Multipark" : !done(now.status) ? `na Multipark está ${now.status ?? "?"}` : !inRange(now.checkOut, input.start, input.end) ? `na Multipark saiu ${now.checkOut ?? "?"}` : !now.partnerId ? "na Multipark já não é de parceiro" : "outro parque";
    r.diffs.push({ bookingId: id, code: null, codes: ["falta_na_multipark"], detail: why });
  }

  for (const [key, n] of input.monthlyInvoices ?? []) {
    const r = rows.get(key);
    if (r) r.mp.invoices += n;
  }
  return [...rows.values()].sort((a, b) => b.diffs.length - a.diffs.length || b.mp.ours - a.mp.ours || String(a.partnerName ?? "").localeCompare(String(b.partnerName ?? ""), "pt"));
}

/** As diferenças que contam para fechar (sem devido também conta: é coisa a resolver). PURA. */
export function diffCount(r: Pick<PartnerCloseRow, "diffs">): number {
  return r.diffs.length;
}

/** Mês "AAAA-MM" → limites em UTC (hora de Lisboa). PURA. */
export function monthRangeLisbon(month: string, lisbonDayRangeUtc: (a: string, b: string) => { start: string; end: string }): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const r = lisbonDayRangeUtc(`${month}-01`, `${month}-${String(last).padStart(2, "0")}`);
  return { start: r.start, end: r.end };
}

/** Fechar: com diferenças, a explicação é obrigatória (≥ 10 letras). PURA. */
export function canClose(diffs: number, note: string | null | undefined): string | null {
  if (diffs > 0 && String(note ?? "").replace(/\s+/g, " ").trim().length < 10) return "Há diferenças: escreve porque fechas assim (mínimo 10 letras).";
  return null;
}
