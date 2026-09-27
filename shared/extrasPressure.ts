/**
 * "Pressão" do Extras-Dia — quando é que a operação aperta. PARTILHADO entre
 * servidor (trabalho `extras-pressure`, server/extrasPressure.ts) e cliente
 * (separador "Pressão" e a dica "hora apertada" na escala). PURO.
 *
 * Base: os últimos 60 dias da BD da Multipark, por grupo de parques
 * (marca + cidade, ou a cidade toda, ou o Marketplace) × dia da semana ×
 * hora de Lisboa. Métricas por (dia da semana, hora):
 *   - volume: check-ins/check-outs começados e concluídos nessa hora (total
 *     da janela; a média por dia = total ÷ `days`);
 *   - concorrência: carros a ser tratados ao mesmo tempo (média e máximo);
 *   - tempo de entrega: pedido do cliente → carro entregue (mediana, p75, p90);
 *   - tempo de recolha: chegada/chamada do cliente → check-in feito (mediana, p75).
 * E a relação carga (carros nessa hora) × tempo de entrega, separada por
 * horas de ponta (07–10h e 17–20h) e resto do dia — tabela, sem modelos.
 *
 * Isto é a base do futuro algoritmo dos extras — por agora só se mostra.
 */

export const PRESSURE_WINDOW_DAYS = 60;

/** Horas de ponta (proxy do trânsito): [início, fim) em horas de Lisboa. */
export const RUSH_HOURS: ReadonlyArray<readonly [number, number]> = [[7, 10], [17, 20]];

export function isRushHour(hour: number): boolean {
  return RUSH_HOURS.some(([a, b]) => hour >= a && hour < b);
}

/**
 * Escalões de carga (carros tratados nessa hora do dia: check-ins + check-outs
 * concluídos). `min` inclusive; o último não tem teto.
 */
export const LOAD_BUCKETS: ReadonlyArray<{ id: number; min: number; label: string }> = [
  { id: 1, min: 1, label: "1–3" },
  { id: 2, min: 4, label: "4–6" },
  { id: 3, min: 7, label: "7–10" },
  { id: 4, min: 11, label: "11–15" },
  { id: 5, min: 16, label: "16+" },
];

/** Escalão de uma carga (0 = sem carga). PURA. */
export function loadBucketOf(load: number): number {
  let id = 0;
  for (const b of LOAD_BUCKETS) if (load >= b.min) id = b.id;
  return id;
}

/** Limites de validade das durações (minutos): fora disto é lixo de dados. */
export const MAX_DELIVERY_MINUTES = 240;
export const MAX_PICKUP_MINUTES = 180;

/** Dias da semana ISO: 1 = segunda … 7 = domingo. */
export const WEEKDAY_LABELS: Record<number, string> = {
  1: "segunda", 2: "terça", 3: "quarta", 4: "quinta", 5: "sexta", 6: "sábado", 7: "domingo",
};
export const WEEKDAY_SHORT: Record<number, string> = {
  1: "Seg", 2: "Ter", 3: "Qua", 4: "Qui", 5: "Sex", 6: "Sáb", 7: "Dom",
};
/** Plural para o resumo ("sextas", "sábados"). */
export const WEEKDAY_PLURAL: Record<number, string> = {
  1: "segundas", 2: "terças", 3: "quartas", 4: "quintas", 5: "sextas", 6: "sábados", 7: "domingos",
};

// ─── Grupos ─────────────────────────────────────────────────────────────────

/** Chave do agregado de uma cidade (todas as marcas nossas): "cidade_lisboa". */
export const cityGroupKey = (city: string) => `cidade_${city}`;

/** Cidade do Extras-Dia (lisbon/porto/faro) → chave do agregado da cidade. */
export function extraCityGroupKey(city: "lisbon" | "porto" | "faro"): string {
  return cityGroupKey(city === "lisbon" ? "lisboa" : city);
}

/**
 * O grupo cabe no âmbito de cidade do utilizador? `cityKeys` null = todas as
 * cidades (vê tudo, incluindo o Marketplace). PURA.
 */
export function groupAllowedForCities(key: string, cityKeys: readonly string[] | null): boolean {
  if (cityKeys == null) return true;
  return cityKeys.some((c) => key.endsWith(`_${c}`));
}

// ─── Linhas guardadas (ops_pressure_stats) ──────────────────────────────────

export interface PressureSlot {
  group: string;
  /** 1 = segunda … 7 = domingo. */
  weekday: number;
  /** 0–23 (Lisboa). */
  hour: number;
  /** Quantas vezes este dia da semana aparece na janela (divisor das médias). */
  days: number;
  checkinsDone: number;
  checkoutsDone: number;
  checkinsStarted: number;
  checkoutsStarted: number;
  concurrencyAvg: number | null;
  concurrencyMax: number | null;
  deliveryN: number;
  deliveryP50: number | null;
  deliveryP75: number | null;
  deliveryP90: number | null;
  pickupN: number;
  pickupP50: number | null;
  pickupP75: number | null;
}

export interface PressureLoadRow {
  group: string;
  /** Id do escalão (LOAD_BUCKETS). */
  loadBucket: number;
  rush: boolean;
  deliveryN: number;
  deliveryP50: number | null;
  deliveryP75: number | null;
  deliveryP90: number | null;
}

/** Carros por hora (média por dia) de uma célula: check-ins + check-outs concluídos. PURA. */
export function slotLoadPerDay(s: Pick<PressureSlot, "days" | "checkinsDone" | "checkoutsDone">): number {
  return s.days > 0 ? (s.checkinsDone + s.checkoutsDone) / s.days : 0;
}

/** Amostra mínima para confiar num percentil de uma célula. */
export const MIN_SAMPLE = 5;

/** Percentil (0–1) de uma lista de números, interpolado (igual ao percentile_cont). PURA. */
export function percentile(values: number[], p: number): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const idx = (v.length - 1) * Math.min(Math.max(p, 0), 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return v[lo] + (v[hi] - v[lo]) * (idx - lo);
}

// ─── Horas apertadas (top 20 %) ─────────────────────────────────────────────

export const TIGHT_TOP_SHARE = 0.2;

export interface TightThresholds {
  /** Carga (carros/hora, média por dia) a partir da qual a hora está no top 20 %. */
  load: number | null;
  /** p75 da entrega (min) a partir do qual a hora está no top 20 %. */
  deliveryP75: number | null;
}

/**
 * Limiares do top 20 % de um grupo: sobre as células com movimento (carga > 0)
 * e, para o p75, só as com amostra suficiente. PURA.
 */
export function tightThresholds(slots: PressureSlot[], share = TIGHT_TOP_SHARE): TightThresholds {
  const loads = slots.map(slotLoadPerDay).filter((x) => x > 0);
  const p75s = slots.filter((s) => s.deliveryN >= MIN_SAMPLE && s.deliveryP75 != null).map((s) => s.deliveryP75 as number);
  return {
    load: loads.length ? percentile(loads, 1 - share) : null,
    deliveryP75: p75s.length ? percentile(p75s, 1 - share) : null,
  };
}

export interface TightReason { load: boolean; delivery: boolean }

/** A célula está no top 20 % (volume OU p75 da entrega)? null = não. PURA. */
export function tightReason(s: PressureSlot | undefined, t: TightThresholds): TightReason | null {
  if (!s) return null;
  const load = slotLoadPerDay(s);
  const byLoad = t.load != null && load > 0 && load >= t.load;
  const byDelivery = t.deliveryP75 != null && s.deliveryN >= MIN_SAMPLE && s.deliveryP75 != null && s.deliveryP75 >= t.deliveryP75;
  return byLoad || byDelivery ? { load: byLoad, delivery: byDelivery } : null;
}

/** Dia da semana ISO (1–7) de um dia "AAAA-MM-DD". PURA. */
export function isoWeekday(day: string): number {
  return new Date(`${day}T12:00:00Z`).getUTCDay() || 7;
}

/**
 * Horas apertadas da escala de um dia (horas 0–26 do Extras-Dia: 24–26 são
 * 00–02h do dia seguinte). Devolve hora → motivo. PURA.
 */
export function tightHoursForDay(slots: PressureSlot[], targetDay: string, hours: number[]): Map<number, TightReason> {
  const t = tightThresholds(slots);
  const byKey = new Map(slots.map((s) => [`${s.weekday}:${s.hour}`, s]));
  const wd = isoWeekday(targetDay);
  const out = new Map<number, TightReason>();
  for (const h of hours) {
    const weekday = h >= 24 ? (wd % 7) + 1 : wd;
    const r = tightReason(byKey.get(`${weekday}:${h % 24}`), t);
    if (r) out.set(h, r);
  }
  return out;
}

// ─── Resumo em português ────────────────────────────────────────────────────

export interface TightBlock {
  weekday: number;
  fromHour: number;
  /** Exclusivo. */
  toHour: number;
  /** Saídas (check-outs concluídos) por hora, média por dia. */
  checkoutsPerHour: number;
  /** Chegadas (check-ins concluídos) por hora, média por dia. */
  checkinsPerHour: number;
  /** p75 da entrega (média ponderada pela amostra), min. */
  deliveryP75: number | null;
  /** Para ordenar: carga média × (1 + p75/60). */
  score: number;
}

/**
 * Blocos apertados (horas seguidas do mesmo dia da semana no top 20 %),
 * ordenados do mais apertado para o menos. PURA.
 */
export function tightBlocks(slots: PressureSlot[], limit = 3): TightBlock[] {
  const t = tightThresholds(slots);
  const byKey = new Map(slots.map((s) => [`${s.weekday}:${s.hour}`, s]));
  const blocks: TightBlock[] = [];
  for (let wd = 1; wd <= 7; wd++) {
    let cur: PressureSlot[] = [];
    const flush = (endHour: number) => {
      if (!cur.length) return;
      const days = Math.max(1, cur[0].days);
      const hrs = cur.length;
      const co = cur.reduce((a, s) => a + s.checkoutsDone, 0) / days / hrs;
      const ci = cur.reduce((a, s) => a + s.checkinsDone, 0) / days / hrs;
      const withP = cur.filter((s) => s.deliveryP75 != null && s.deliveryN > 0);
      const n = withP.reduce((a, s) => a + s.deliveryN, 0);
      const p75 = n > 0 ? withP.reduce((a, s) => a + (s.deliveryP75 as number) * s.deliveryN, 0) / n : null;
      blocks.push({ weekday: wd, fromHour: cur[0].hour, toHour: endHour, checkoutsPerHour: co, checkinsPerHour: ci, deliveryP75: p75, score: (co + ci) * (1 + (p75 ?? 0) / 60) });
      cur = [];
    };
    for (let h = 0; h < 24; h++) {
      const s = byKey.get(`${wd}:${h}`);
      if (s && tightReason(s, t)) cur.push(s);
      else flush(h);
    }
    flush(24);
  }
  return blocks.sort((a, b) => b.score - a.score).slice(0, Math.max(0, limit));
}

const round = (n: number) => Math.round(n);
const hh = (h: number) => String(h).padStart(2, "0");

/** "sextas 17–20h em Lisboa: 42 saídas/h, entrega p75 28 min". PURA. */
export function describeTightBlock(b: TightBlock, where: string): string {
  const parts = [`${round(b.checkoutsPerHour)} saída${round(b.checkoutsPerHour) === 1 ? "" : "s"}/h`, `${round(b.checkinsPerHour)} chegada${round(b.checkinsPerHour) === 1 ? "" : "s"}/h`];
  if (b.deliveryP75 != null) parts.push(`entrega p75 ${round(b.deliveryP75)} min`);
  return `${WEEKDAY_PLURAL[b.weekday]} ${hh(b.fromHour)}–${hh(b.toHour)}h${where ? ` em ${where}` : ""}: ${parts.join(", ")}`;
}

/** Resumo curto (até 3 frases) das horas mais apertadas de um grupo. PURA. */
export function pressureSummary(slots: PressureSlot[], where: string, limit = 3): string[] {
  return tightBlocks(slots, limit).map((b) => describeTightBlock(b, where));
}

// ─── Carga × tempo de entrega ───────────────────────────────────────────────

export interface LoadComparisonRow {
  loadBucket: number;
  label: string;
  rush: PressureLoadRow | null;
  rest: PressureLoadRow | null;
}

/** Tabela carga × (ponta / resto) de um grupo, pela ordem dos escalões. PURA. */
export function loadComparison(rows: PressureLoadRow[]): LoadComparisonRow[] {
  return LOAD_BUCKETS.map((b) => ({
    loadBucket: b.id,
    label: b.label,
    rush: rows.find((r) => r.loadBucket === b.id && r.rush) ?? null,
    rest: rows.find((r) => r.loadBucket === b.id && !r.rush) ?? null,
  }));
}

/**
 * Leitura em português da tabela carga × entrega: quanto sobe o p75 do escalão
 * mais leve para o mais pesado (com amostra) e o efeito das horas de ponta. PURA.
 */
export function describeLoadEffect(rows: PressureLoadRow[]): string[] {
  const out: string[] = [];
  const ok = (r: PressureLoadRow | null | undefined) => !!r && r.deliveryN >= MIN_SAMPLE && r.deliveryP75 != null;
  const merged = LOAD_BUCKETS.map((b) => {
    const rs = rows.filter((r) => r.loadBucket === b.id && ok(r));
    const n = rs.reduce((a, r) => a + r.deliveryN, 0);
    return { b, n, p75: n ? rs.reduce((a, r) => a + (r.deliveryP75 as number) * r.deliveryN, 0) / n : null };
  }).filter((x) => x.p75 != null);
  if (merged.length >= 2) {
    const lo = merged[0];
    const hi = merged[merged.length - 1];
    out.push(`Com ${lo.b.label} carros/h a entrega fica em p75 ${round(lo.p75!)} min; com ${hi.b.label} carros/h sobe para ${round(hi.p75!)} min.`);
  }
  const side = (rush: boolean) => {
    const rs = rows.filter((r) => r.rush === rush && ok(r));
    const n = rs.reduce((a, r) => a + r.deliveryN, 0);
    return n ? rs.reduce((a, r) => a + (r.deliveryP75 as number) * r.deliveryN, 0) / n : null;
  };
  const rush = side(true);
  const rest = side(false);
  if (rush != null && rest != null) {
    const d = round(rush - rest);
    out.push(`Horas de ponta (07–10h e 17–20h): p75 ${round(rush)} min contra ${round(rest)} min no resto do dia (${d >= 0 ? "+" : ""}${d} min).`);
  }
  return out;
}
