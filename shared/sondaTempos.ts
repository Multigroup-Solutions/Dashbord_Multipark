/**
 * Plano 62, P0 — "Diagnóstico dos tempos (calibração)": a sonda dentro da app.
 *
 * Esta parte é PURA e serve o servidor e o browser:
 *  - o formato do resultado de UM dia e UMA cidade (`SondaResult`), feito só
 *    de agregados: contagens (`n`), histogramas com caixas FIXAS (`h`) e
 *    contagens por rótulo de um vocabulário fechado (`l`: plataformas,
 *    papéis, motivos, sequências de estados, nomes de garagens);
 *  - juntar dias e cidades (`mergeSondaResults`): somam-se as contagens e as
 *    caixas, por isso juntar 14 dias dá exatamente o mesmo que um período com
 *    os 14 dias; os percentis calculam-se no FIM, sobre as caixas;
 *  - o relatório (secções do §11.0, cada uma presa ao parâmetro que calibra),
 *    o texto do "Copiar resumo" e as linhas `[sonda62 n/N]` do log (≤ 2 KB).
 *
 * Privacidade (§11.0): nunca ids de reserva, telefones, nomes, agentes,
 * utilizadores Zello, matrículas nem coordenadas — as posições só entram como
 * distâncias (m) em caixas. Os nomes das garagens são da operação e entram.
 */

// ─── Cidades ────────────────────────────────────────────────────────────────

export const PROBE_CITIES = ["lisbon", "porto", "faro"] as const;
export type ProbeCity = (typeof PROBE_CITIES)[number];
export const PROBE_CITY_LABELS: Record<ProbeCity, string> = { lisbon: "Lisboa", porto: "Porto", faro: "Faro" };

/** Dias para trás que o ecrã pede (o 1.º é D-3: o GPS já é o "final"). */
export const PROBE_DEFAULT_OFFSET_DAYS = 3;
export const PROBE_DAY_CHOICES = [1, 7, 14] as const;

// ─── Parâmetros que a sonda experimenta (§11.0, itens 3 e 11) ────────────────

/** Item 3: velocidades (km/h) × duração mínima (s) × raio (m) da paragem à volta do CHECK_OUT. */
export const STOP_SPEEDS_KMH = [2, 3, 5, 7] as const;
export const STOP_MIN_SECONDS = [60, 120, 180] as const;
export const STOP_RADII_M = [150, 200, 300] as const;
/** Item 11: velocidade "de carro" (km/h) × margem (m) para a saída do terminal. */
export const EXIT_CAR_SPEEDS_KMH = [5, 10, 15] as const;
export const EXIT_MARGINS_M = [150, 300] as const;
/** Raio provisório da zona T1/T2 (§11.1): o centro é a posição da linha CHECK_IN/CHECK_OUT. */
export const PROBE_TERMINAL_RADIUS_M = 200;
/** Janela da chamada (§5.1, provisória): de 60 min antes a 5 min depois do pendente / "em recolha". */
export const CALL_WINDOW_BEFORE_MIN = 60;
export const CALL_WINDOW_AFTER_MIN = 5;
/** Janela larga para o histograma C − R (−180 a +60 min). */
export const CALL_HIST_BEFORE_MIN = 180;
export const CALL_HIST_AFTER_MIN = 60;
/** "Pedido antes da chamada": a 1.ª chamada que bate vem mais de 15 min depois do pendente. */
export const CALL_LATE_AFTER_MIN = 15;
/** Um número em ≥ 3 reservas com pedido no mesmo dia = partilhado (agência, hotel). */
export const SHARED_PHONE_MIN_BOOKINGS = 3;
/** Velocidade que separa "a andar" de "parado" no intervalo entre pontos. */
export const GAP_MOVING_KMH = 10;
/** Velocidade "a pé" (§4.4) para a chegada à zona T2. */
export const WALK_KMH = 7;
/** Movimentos depois do check-in que contam para a recolha (§3.1). */
export const PICKUP_TRACK_MAX_HOURS = 48;
/** Raio do parque (§4.6, D_PARK_OK provisório) e "longe do parque" (D_MISMATCH). */
export const PARK_OK_M = 500;
export const PARK_FAR_M = 1000;
/** "Em recolha" muito perto do check-in (§3.3). */
export const QUICK_PICKUP_MIN = 2;
/** Até onde se lê o GPS de uma recolha depois do check-in (item 1 e 11). */
export const PICKUP_GPS_WINDOW_MIN = 60;

// ─── Histogramas com caixas fixas ───────────────────────────────────────────

/**
 * Caixas: c[0] = abaixo de e[0]; c[i] = [e[i−1], e[i]); c[n] = a partir de
 * e[n−1] (n = e.length). Mesmas arestas → somam-se sem erro.
 */
export interface Hist { e: number[]; c: number[] }

/** As arestas de cada tipo de histograma (constantes: o auditor lê-as aqui). */
export const HIST_EDGES = {
  /** intervalo entre pontos GPS, em segundos (inclui as caixas do §11.0, item 1) */
  gapS: [0, 10, 20, 30, 45, 60, 90, 120, 150, 180, 210, 240, 300, 360, 420, 480, 600, 720, 900, 1200, 1800],
  /** durações em minutos (R → S, S → E, K → I, …) */
  min: [0, 1, 2, 3, 5, 7, 8, 10, 15, 20, 25, 30, 40, 45, 60, 90, 120, 180, 240],
  /** início da paragem → CHECK_OUT, em minutos */
  stopMin: [0, 1, 2, 3, 5, 10, 15, 20, 30, 40, 60],
  /** chamada − pedido, em minutos (com sinal) */
  callMin: [-180, -120, -90, -60, -45, -30, -20, -15, -10, -5, -2, 0, 2, 5, 10, 15, 30, 60],
  /** distâncias em metros */
  distM: [0, 25, 50, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000],
  /** horas (tempo numa garagem até ao movimento seguinte) */
  hours: [0, 0.25, 0.5, 1, 2, 3, 4, 6, 8, 12, 24, 36, 48],
  /** atraso do registo da consola, em segundos */
  regS: [0, 1, 5, 15, 30, 60, 120, 300, 900, 3600],
  /** 1.º/último ponto do ficheiro face à meia-noite de Lisboa, em horas (com sinal) */
  midnightH: [-6, -3, -2, -1, -0.5, 0, 0.5, 1, 2, 3, 6, 12, 18, 24],
  /** desvio do relógio, em minutos (com sinal) */
  clockMin: [-10, -5, -3, -2, -1, -0.5, 0, 0.5, 1, 2, 3, 5, 10],
} as const;
export type HistKind = keyof typeof HIST_EDGES;

export function newHist(kind: HistKind): Hist {
  const e = [...HIST_EDGES[kind]];
  return { e, c: new Array(e.length + 1).fill(0) };
}

/** Índice da caixa de `v`. PURA. */
export function boxOf(e: readonly number[], v: number): number {
  let i = 0;
  while (i < e.length && v >= e[i]) i++;
  return i;
}

export function histAdd(h: Hist, v: number, n = 1): void {
  if (!Number.isFinite(v)) return;
  h.c[boxOf(h.e, v)] += n;
}

export const histTotal = (h: Hist | undefined): number => (h ? h.c.reduce((s, x) => s + x, 0) : 0);

const sameEdges = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Soma `b` em `a` (as mesmas arestas; senão não junta). PURA (muda `a`). */
export function histMergeInto(a: Hist, b: Hist): boolean {
  if (!sameEdges(a.e, b.e) || a.c.length !== b.c.length) return false;
  for (let i = 0; i < a.c.length; i++) a.c[i] += b.c[i] ?? 0;
  return true;
}

export interface HistPercentile { value: number; below?: boolean; above?: boolean }

/**
 * Percentil (q entre 0 e 1) a partir das caixas, com interpolação linear
 * dentro da caixa. Abaixo da 1.ª aresta → `below`; na última caixa (aberta)
 * → a aresta com `above` ("mais de X"). Sem casos → null. PURA.
 */
export function histPercentile(h: Hist | undefined, q: number): HistPercentile | null {
  const total = histTotal(h);
  if (!h || total <= 0) return null;
  const target = Math.min(Math.max(q, 0), 1) * total;
  let cum = 0;
  for (let i = 0; i < h.c.length; i++) {
    const n = h.c[i];
    if (n <= 0) continue;
    if (cum + n >= target) {
      if (i === 0) return { value: h.e[0], below: true };
      if (i === h.c.length - 1) return { value: h.e[h.e.length - 1], above: true };
      const lo = h.e[i - 1], hi = h.e[i];
      const frac = n > 0 ? Math.min(Math.max((target - cum) / n, 0), 1) : 0;
      return { value: lo + (hi - lo) * frac };
    }
    cum += n;
  }
  return { value: h.e[h.e.length - 1], above: true };
}

/** Fração dos casos com valor ≥ x (x tem de ser uma aresta; senão conta a caixa que o contém). PURA. */
export function histShareAtLeast(h: Hist | undefined, x: number): number | null {
  const total = histTotal(h);
  if (!h || total <= 0) return null;
  const i = boxOf(h.e, x);
  let n = 0;
  for (let k = i; k < h.c.length; k++) n += h.c[k];
  return n / total;
}

/** Fração dos casos com valor < x. PURA. */
export function histShareBelow(h: Hist | undefined, x: number): number | null {
  const s = histShareAtLeast(h, x);
  return s == null ? null : 1 - s;
}

/** Fração dos casos em [a, b) (a e b arestas). PURA. */
export function histShareBetween(h: Hist | undefined, a: number, b: number): number | null {
  const sa = histShareAtLeast(h, a), sb = histShareAtLeast(h, b);
  return sa == null || sb == null ? null : sa - sb;
}

// ─── O resultado de um dia (e de vários, juntos) ────────────────────────────

/** Uma zona de terminal das Definições, sem coordenadas (item 15). */
export interface ProbeZoneInfo { label: "T1" | "T2" | "outro" | "sem_rotulo"; radiusM: number }

/** O que não se soma entre dias (o mais recente ganha). Sem coordenadas. */
export interface SondaStatic {
  /** Definições → "Aeroportos (terminal no ponto)": raio do aeroporto e as zonas (rótulo + raio). */
  airportRadiusM: number | null;
  zones: ProbeZoneInfo[];
  /** Interruptor "Central Vodafone: receber as chamadas da consola". */
  centralSugarOn: boolean | null;
  /** Parques que a operação não faz (quantos). */
  excludedParks: number;
  /** Parques operados desta cidade que entraram (quantos). */
  parks: number;
  /** Garagens dos parques da cidade: nome, tipo de lugar e se o link do mapa tem coordenadas. */
  garages: Array<{ name: string; parkingType: string | null; mapHasCoords: boolean }>;
  /** now() do Postgres da Multipark − hora do servidor (ms), no momento da leitura. */
  pgClockOffsetMs: number | null;
}

export interface SondaResult {
  v: 1;
  city: ProbeCity;
  /** dias operacionais (AAAA-MM-DD) que entram neste resultado */
  days: string[];
  /** contagens */
  n: Record<string, number>;
  /** histogramas */
  h: Record<string, Hist>;
  /** contagens por rótulo (vocabulário fechado) */
  l: Record<string, Record<string, number>>;
  s: SondaStatic | null;
  /** algo não coube (prazo, limite de ficheiros ou de linhas) */
  truncated: boolean;
  /** "falhou: motivo" — texto fixo, sem dados pessoais */
  failures: string[];
}

export function emptySondaResult(city: ProbeCity, days: string[] = []): SondaResult {
  return { v: 1, city, days: [...days], n: {}, h: {}, l: {}, s: null, truncated: false, failures: [] };
}

/** Acumulador pequeno (o servidor usa-o para encher um SondaResult). */
export class SondaAcc {
  constructor(readonly r: SondaResult) {}
  inc(key: string, by = 1): void { this.r.n[key] = (this.r.n[key] ?? 0) + by; }
  hist(key: string, kind: HistKind, v: number | null | undefined): void {
    if (v == null || !Number.isFinite(v)) return;
    const h = this.r.h[key] ?? (this.r.h[key] = newHist(kind));
    histAdd(h, v);
  }
  label(group: string, label: string, by = 1): void {
    const g = this.r.l[group] ?? (this.r.l[group] = {});
    g[label] = (g[label] ?? 0) + by;
  }
}

const cloneHist = (h: Hist): Hist => ({ e: [...h.e], c: [...h.c] });

/**
 * Junta resultados (dias e/ou cidades). Contagens, caixas e rótulos somam-se;
 * o `s` é o do dia mais recente (com várias cidades não há um só: fica nulo,
 * porque as zonas e as garagens são de cada cidade). PURA (não muda os de entrada).
 */
export function mergeSondaResults(list: readonly SondaResult[], city?: ProbeCity): SondaResult {
  const out = emptySondaResult(city ?? list[0]?.city ?? "lisbon");
  let latest = "";
  const days = new Set<string>();
  const cities = new Set<string>();
  for (const r of list) {
    if (!r || r.v !== 1) continue;
    cities.add(r.city);
    for (const d of r.days) days.add(d);
    for (const [k, v] of Object.entries(r.n)) out.n[k] = (out.n[k] ?? 0) + (Number(v) || 0);
    for (const [k, h] of Object.entries(r.h)) {
      const cur = out.h[k];
      if (!cur) out.h[k] = cloneHist(h);
      else histMergeInto(cur, h);
    }
    for (const [g, m] of Object.entries(r.l)) {
      const cur = out.l[g] ?? (out.l[g] = {});
      for (const [k, v] of Object.entries(m)) cur[k] = (cur[k] ?? 0) + (Number(v) || 0);
    }
    const last = [...r.days].sort().pop() ?? "";
    if (r.s && last >= latest) { out.s = r.s; latest = last; }
    out.truncated = out.truncated || r.truncated;
    for (const f of r.failures) if (!out.failures.includes(f)) out.failures.push(f);
  }
  out.days = [...days].sort();
  if (cities.size > 1) out.s = null;
  return out;
}

// ─── Formatação (PT-PT) ─────────────────────────────────────────────────────

const dec = (x: number, d = 1) => {
  const f = 10 ** d;
  return String(Math.round(x * f) / f).replace(".", ",");
};
export const fmtPct = (x: number | null | undefined, d = 0): string => (x == null || !Number.isFinite(x) ? "—" : `${dec(x * 100, d)} %`);
export const pctOf = (part: number, total: number): number | null => (total > 0 ? part / total : null);
const fmtP = (p: HistPercentile | null, unit: string, scale = 1, d = 1): string => {
  if (!p) return "—";
  const v = `${dec(p.value * scale, d)} ${unit}`;
  return p.above ? `mais de ${v}` : p.below ? `menos de ${v}` : v;
};
const fmtN = (n: number) => String(Math.round(n));

/** p50 / p90 / p99 de uma caixa em minutos (ou noutra unidade). */
function pctLine(h: Hist | undefined, unit: string, scale = 1, qs: readonly number[] = [0.5, 0.9]): string {
  const n = histTotal(h);
  if (!n) return "sem casos";
  return `${qs.map((q) => `p${Math.round(q * 100)} ${fmtP(histPercentile(h, q), unit, scale)}`).join(" · ")} (n=${n})`;
}

// ─── Relatório ──────────────────────────────────────────────────────────────

export interface ReportRow { label: string; value: string; hint?: string }
export interface ReportSection {
  id: string;
  /** item do §11.0 (0 = leitura rápida) */
  item: number;
  title: string;
  /** os parâmetros que este item fecha */
  closes: string;
  rows: ReportRow[];
  table?: { head: string[]; rows: string[][] };
}

const n0 = (r: SondaResult, k: string) => r.n[k] ?? 0;
const sumPrefix = (r: SondaResult, prefix: string) => Object.entries(r.n).filter(([k]) => k.startsWith(prefix)).reduce((s, [, v]) => s + v, 0);
const mergedHist = (r: SondaResult, keys: string[]): Hist | undefined => {
  let out: Hist | undefined;
  for (const k of keys) {
    const h = r.h[k];
    if (!h) continue;
    if (!out) out = cloneHist(h);
    else histMergeInto(out, h);
  }
  return out;
};
const topLabels = (m: Record<string, number> | undefined, max = 10): Array<[string, number]> =>
  Object.entries(m ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "pt")).slice(0, max);
const labelsLine = (m: Record<string, number> | undefined, max = 8): string => {
  const total = Object.values(m ?? {}).reduce((s, x) => s + x, 0);
  if (!total) return "sem casos";
  return topLabels(m, max).map(([k, v]) => `${k} ${fmtPct(v / total)}`).join(" · ") + ` (n=${total})`;
};

/** Motivos da cobertura GPS (item 2), pela ordem da cadeia. */
export const GPS_REASONS: Array<{ key: string; label: string }> = [
  { key: "com_gps", label: "Com GPS (≥ 2 pontos)" },
  { key: "sem_inicio", label: "Sem início (ninguém pegou no carro na app)" },
  { key: "agente_sistema", label: "Agente de sistema / API" },
  { key: "parceiro", label: "Agente de parceiro" },
  { key: "sem_ficha", label: "Agente sem ficha" },
  { key: "sem_linha", label: "Sem Zello nesse dia (nenhuma linha do Histórico Diário)" },
  { key: "sem_ficheiro", label: "Linha sem ficheiro GPS" },
  { key: "por_ler", label: "Ficheiro por ler (prazo ou limite)" },
  { key: "sem_pontos", label: "Ficheiro sem pontos na janela" },
];

export const CALL_REASONS: Array<{ key: string; label: string }> = [
  { key: "na_janela", label: "Com chamada na janela (−60 a +5 min)" },
  { key: "fora_da_janela", label: "Chamada só fora da janela (−180 a +60 min)" },
  { key: "sem_chamada", label: "Sem chamada que bata" },
  { key: "partilhado", label: "Só com número partilhado (≥ 3 reservas)" },
  { key: "sem_telefone", label: "Reserva sem telefone" },
];

const stopKey = (v: number, t: number, r: number) => `v${v}_t${t}_r${r}`;
export const stopComboKey = stopKey;
export const exitComboKey = (v: number, m: number) => `v${v}_m${m}`;

/** A combinação de paragem com mais entregas com paragem e p50 início → CHECK_OUT entre 2 e 20 min (§11.0). */
export function bestStopCombo(r: SondaResult): { key: string; share: number; p50: number | null } | null {
  const base = n0(r, "paragem.base");
  if (!base) return null;
  let best: { key: string; share: number; p50: number | null } | null = null;
  for (const v of STOP_SPEEDS_KMH) for (const t of STOP_MIN_SECONDS) for (const rad of STOP_RADII_M) {
    const key = stopKey(v, t, rad);
    const share = n0(r, `paragem.${key}.com`) / base;
    const p = histPercentile(r.h[`paragem.${key}.antes`], 0.5);
    const coherent = p != null && !p.above && !p.below && p.value >= 2 && p.value <= 20;
    if (!coherent) continue;
    if (!best || share > best.share) best = { key, share, p50: p?.value ?? null };
  }
  return best;
}

/** O que cada critério do §11.0 diz com os números de agora (leitura rápida). PURA. */
export function criteriaRows(r: SondaResult): ReportRow[] {
  const rows: ReportRow[] = [];
  // Intervalo
  const gapDel = mergedHist(r, ["gps.intervalo.entregas.andar", "gps.intervalo.entregas.parado"]);
  const p90 = histPercentile(gapDel, 0.9), p50 = histPercentile(gapDel, 0.5);
  if (!p90 || !p50) rows.push({ label: "Intervalo entre pontos (entregas)", value: "sem dados" });
  else {
    const p50m = p50.value / 60, p90m = p90.value / 60;
    const verdict = p50m > 6 || p50.above ? "p50 > 6 min → o Trânsito não se mostra (volta ao Jorge)"
      : p90m <= 6 && !p90.above ? "p90 ≤ 6 min → parâmetros como propostos"
      : p90m <= 10 && !p90.above ? "p90 entre 6 e 10 min → G_GOOD 8 e G_WEAK 20"
      : "p90 > 10 min → rever com o auditor";
    rows.push({ label: "Intervalo entre pontos (entregas)", value: `p50 ${fmtP(p50, "min", 1 / 60)} · p90 ${fmtP(p90, "min", 1 / 60)}`, hint: verdict });
  }
  // Paragem
  const best = bestStopCombo(r);
  rows.push(best
    ? { label: "Melhor combinação de paragem", value: `${best.key} · ${fmtPct(best.share)} com paragem · p50 ${best.p50 == null ? "—" : dec(best.p50)} min antes do CHECK_OUT`, hint: best.share >= 0.7 ? "≥ 70 % → fecha V_STOP, V_WALK, T_STOP_MIN e o raio" : "< 70 % → aceitar \"1 ponto dentro + o seguinte a ≤ 10 km/h\" e voltar ao auditor" }
    : { label: "Melhor combinação de paragem", value: "sem dados (nenhuma com p50 entre 2 e 20 min)" });
  // Cobertura GPS
  const del = sumPrefix(r, "gps.cobertura.entregas.");
  const cov = pctOf(n0(r, "gps.cobertura.entregas.com_gps"), del);
  rows.push({ label: "Cobertura GPS das entregas", value: cov == null ? "sem dados" : `${fmtPct(cov)} (n=${del})`, hint: cov == null ? undefined : cov >= 0.6 ? "≥ 60 % → o portão pode abrir nesta cidade" : cov < 0.3 ? "< 30 % → portão fechado; prioridade: ligar PDA/Zello às fichas" : "entre 30 e 60 % → portão fechado por agora" });
  // Chamadas
  const dc = n0(r, "chamadas.entregas.com_pedido");
  const inWin = pctOf(n0(r, "chamadas.entregas.na_janela"), dc);
  rows.push({ label: "Entregas com chamada na janela", value: inWin == null ? "sem dados" : `${fmtPct(inWin)} (n=${dc})`, hint: inWin != null && inWin < 0.2 ? "< 20 % → a Fila fica a do pendente (sem mudar código)" : undefined });
  const cr = histPercentile(r.h["chamadas.entregas.c_menos_r"], 0.9);
  if (cr) rows.push({ label: "C − R (p90)", value: fmtP(cr, "min"), hint: Math.abs(cr.value) > 30 ? "|p90| > 30 min → rever a janela com o Jorge" : undefined });
  const late = pctOf(n0(r, "chamadas.entregas.pedido_antes_da_chamada"), n0(r, "chamadas.entregas.com_pedido"));
  if (late != null) rows.push({ label: "Pendente antes da chamada (> 15 min)", value: fmtPct(late), hint: late > 0.1 ? "> 10 % → pergunta Q11 ao Jorge" : undefined });
  // Em recolha
  const withK = n0(r, "recolhas.com_em_recolha");
  const quickSame = pctOf(n0(r, "recolhas.k_i_rapido.mesmo_agente"), withK);
  rows.push({ label: "\"Em recolha\" < 2 min pelo mesmo agente do check-in", value: quickSame == null ? "sem dados" : `${fmtPct(quickSame)} (n=${withK})`, hint: quickSame != null && quickSame >= 0.5 ? "≥ 50 % → o Cliente das recolhas só com chamada (volta ao auditor)" : undefined });
  // P2
  const p2 = n0(r, "p2.na_tabela") + n0(r, "p2.nos_movimentos");
  rows.push({ label: "Há uma garagem \"P2\"?", value: p2 > 0 ? `sim (tabela ${n0(r, "p2.na_tabela") > 0 ? "sim" : "não"}, movimentos ${n0(r, "p2.nos_movimentos")})` : "não", hint: p2 > 0 ? undefined : "sem P2 nas garagens → ramo \"P2 sem garagem\" (§3.2) ou fica fora até o Jorge decidir (Q5)" });
  return rows;
}

/** O relatório (secções do §11.0). PURA. */
export function buildSondaReport(r: SondaResult, perCity?: Partial<Record<ProbeCity, SondaResult>>): ReportSection[] {
  const out: ReportSection[] = [];
  out.push({ id: "leitura", item: 0, title: "Leitura rápida (critérios do §11.0)", closes: "PR dos parâmetros (P3b)", rows: criteriaRows(r) });

  // 1. Intervalo entre pontos
  {
    const rows: ReportRow[] = [];
    for (const [ctx, label] of [["dia", "No dia"], ["entregas", "Dentro das entregas [S, E]"], ["recolhas", "Recolhas [I, I + 60 min]"]] as const) {
      const all = mergedHist(r, [`gps.intervalo.${ctx}.andar`, `gps.intervalo.${ctx}.parado`]);
      const over6 = histShareAtLeast(all, 360);
      rows.push({ label, value: `${pctLine(all, "min", 1 / 60, [0.5, 0.9, 0.99])} · > 6 min ${fmtPct(over6)}` });
      for (const [mv, mvl] of [["andar", "a andar (> 10 km/h)"], ["parado", "parado"]] as const) {
        const h = r.h[`gps.intervalo.${ctx}.${mv}`];
        rows.push({ label: `  ${mvl}`, value: `${pctLine(h, "min", 1 / 60, [0.5, 0.9, 0.99])} · > 6 min ${fmtPct(histShareAtLeast(h, 360))}` });
      }
    }
    out.push({ id: "intervalo", item: 1, title: "Intervalo entre pontos GPS", closes: "T_STOP_MIN, T_CONFIRM, G_GOOD, G_WEAK", rows });
  }

  // 2. Cobertura GPS
  {
    const rows: ReportRow[] = [];
    const table: string[][] = [];
    for (const kind of ["entregas", "recolhas"] as const) {
      const total = sumPrefix(r, `gps.cobertura.${kind}.`);
      rows.push({ label: kind === "entregas" ? "Entregas" : "Recolhas", value: total ? `${fmtPct(pctOf(n0(r, `gps.cobertura.${kind}.com_gps`), total))} com GPS (n=${total})` : "sem casos" });
      for (const g of GPS_REASONS) {
        const v = n0(r, `gps.cobertura.${kind}.${g.key}`);
        if (v) table.push([kind, g.label, fmtN(v), fmtPct(pctOf(v, total))]);
      }
      const dev = r.l[`gps.aparelho.${kind}`];
      if (dev) rows.push({ label: "  Com GPS, por aparelho", value: labelsLine(dev) });
    }
    if (perCity) {
      for (const c of PROBE_CITIES) {
        const cr = perCity[c];
        if (!cr) continue;
        const t = sumPrefix(cr, "gps.cobertura.entregas.");
        rows.push({ label: `  ${PROBE_CITY_LABELS[c]} (entregas)`, value: t ? `${fmtPct(pctOf(n0(cr, "gps.cobertura.entregas.com_gps"), t))} (n=${t})` : "sem casos" });
      }
    }
    out.push({ id: "cobertura", item: 2, title: "Cobertura de GPS por entrega e por recolha", closes: "Portão (§8.1), R18", rows, table: { head: ["Tipo", "Motivo", "N", "%"], rows: table } });
  }

  // 3. Paragem antes do CHECK_OUT
  {
    const base = n0(r, "paragem.base");
    const table: string[][] = [];
    for (const v of STOP_SPEEDS_KMH) for (const t of STOP_MIN_SECONDS) for (const rad of STOP_RADII_M) {
      const key = stopKey(v, t, rad);
      const h = r.h[`paragem.${key}.antes`];
      table.push([`${v} km/h`, `${t} s`, `${rad} m`, fmtPct(pctOf(n0(r, `paragem.${key}.com`), base)), fmtP(histPercentile(h, 0.5), "min"), fmtP(histPercentile(h, 0.9), "min"), fmtPct(pctOf(n0(r, `paragem.${key}.ate_e`), n0(r, `paragem.${key}.com`)))]);
    }
    out.push({
      id: "paragem", item: 3, title: "Paragem no terminal antes do CHECK_OUT", closes: "V_STOP, V_WALK, raio T1/T2, R_SIGNATURE",
      rows: [
        { label: "Entregas com GPS e posição da assinatura", value: fmtN(base), hint: "zona = círculo à volta da posição da linha CHECK_OUT" },
        { label: "Sem posição na linha CHECK_OUT", value: fmtN(n0(r, "paragem.sem_posicao_e")) },
      ],
      table: { head: ["Velocidade", "Mínimo", "Raio", "% com paragem", "p50 antes", "p90 antes", "% até ao CHECK_OUT"], rows: table },
    });
  }

  // 4. Distâncias do CHECK_OUT às zonas
  {
    const rows: ReportRow[] = [];
    for (const cls of ["t1", "t2", "vip", "other", "unknown"] as const) {
      const ha = r.h[`distancia.checkout.${cls}.aeroporto`];
      const hz = r.h[`distancia.checkout.${cls}.zona`];
      if (!histTotal(ha) && !histTotal(hz)) continue;
      rows.push({ label: `${CLASS_LABELS[cls]}: ao centro do aeroporto`, value: pctLine(ha, "m", 1, [0.5, 0.9]) });
      if (histTotal(hz)) rows.push({ label: `${CLASS_LABELS[cls]}: à zona mais perto`, value: `${pctLine(hz, "m", 1, [0.5, 0.9])} · ${labelsLine(r.l[`distancia.checkout.${cls}.zona_mais_perto`])}` });
    }
    rows.push({ label: "Recolhas: CHECK_IN à zona mais perto", value: pctLine(r.h["distancia.checkin.zona"], "m", 1, [0.5, 0.9]) });
    out.push({ id: "distancias", item: 4, title: "Distância da assinatura (CHECK_OUT) às zonas do terminal", closes: "Raio das zonas; zonas em falta", rows });
  }

  // 5. Chamadas
  {
    const rows: ReportRow[] = [];
    const table: string[][] = [];
    for (const kind of ["entregas", "recolhas"] as const) {
      const total = n0(r, `chamadas.${kind}.com_pedido`);
      const letter = kind === "entregas" ? "R" : "K";
      rows.push({ label: kind === "entregas" ? "Entregas com pendente (R)" : "Recolhas com \"em recolha\" (K)", value: fmtN(total) });
      rows.push({ label: `  com chamada nos 60 min antes de ${letter}`, value: fmtPct(pctOf(n0(r, `chamadas.${kind}.antes_60`), total)) });
      for (const c of CALL_REASONS) {
        const v = n0(r, `chamadas.${kind}.${c.key}`);
        if (v) table.push([kind, c.label, fmtN(v), fmtPct(pctOf(v, total))]);
      }
      rows.push({ label: `  C − ${letter}`, value: pctLine(r.h[`chamadas.${kind}.c_menos_r`], "min", 1, [0.1, 0.5, 0.9]) });
      rows.push({ label: "  Fonte e estado (na janela)", value: labelsLine(r.l[`chamadas.${kind}.fonte`]) });
      if (kind === "entregas") {
        rows.push({ label: "  Pendente antes da chamada (> 15 min)", value: fmtPct(pctOf(n0(r, "chamadas.entregas.pedido_antes_da_chamada"), total)) });
        const noR = n0(r, "chamadas.entregas_sem_pendente");
        rows.push({ label: "  Sem pendente: com chamada nos 60 min antes do início", value: `${fmtPct(pctOf(n0(r, "chamadas.entregas_sem_pendente.com_chamada"), noR))} (n=${noR})` });
      }
    }
    const inbound = n0(r, "chamadas.central.recebidas");
    rows.push({ label: "Chamadas recebidas no dia (consola)", value: `${fmtN(inbound)} · sem número ${fmtPct(pctOf(n0(r, "chamadas.central.sem_numero"), inbound))} · WhatsApp recebidas ${fmtN(n0(r, "chamadas.whatsapp.recebidas"))}` });
    rows.push({ label: "Atraso do registo da consola", value: pctLine(r.h["chamadas.central.atraso_registo"], "s", 1, [0.5, 0.9, 0.99]) });
    out.push({ id: "chamadas", item: 5, title: "Chamadas (cobertura da Fila)", closes: "CALL_WINDOW_*, Q1, Q2, Q11, R2", rows, table: { head: ["Tipo", "Motivo", "N", "%"], rows: table } });
  }

  // 6. "Cheguei" e malas
  {
    const cyc = n0(r, "entregas.entregues");
    const rows: ReportRow[] = [
      { label: "Entregas com \"Cheguei\" deste ciclo", value: `${fmtPct(pctOf(n0(r, "cheguei.deste_ciclo"), cyc))} (${fmtN(n0(r, "cheguei.deste_ciclo"))} de ${fmtN(cyc)})` },
      { label: "  Quando", value: labelsLine(r.l["cheguei.quando"]) },
      { label: "  Estado da reserva nesse momento", value: labelsLine(r.l["cheguei.estado"]) },
      { label: "Entregas com \"À espera das malas\" deste ciclo", value: `${fmtPct(pctOf(n0(r, "malas.deste_ciclo"), cyc))}` },
      { label: "  Quando", value: labelsLine(r.l["malas.quando"]) },
      { label: "Linhas sem retrato (snapshot)", value: fmtPct(pctOf(n0(r, "eventos.sem_snapshot"), n0(r, "eventos.do_dia"))) },
    ];
    out.push({ id: "cheguei", item: 6, title: "\"Cheguei\" e \"À espera das malas\"", closes: "D9, §2.4, Q11", rows });
  }

  // 7. Quem marca
  {
    const rows: ReportRow[] = [];
    for (const t of ["PENDING_CHECKOUT", "CHECKING_OUT", "CHECKING_IN", "CHECK_IN"]) {
      rows.push({ label: `${STATE_LABELS[t] ?? t}: plataforma`, value: labelsLine(r.l[`quem.${t}.plataforma`]) });
      rows.push({ label: `${STATE_LABELS[t] ?? t}: papel`, value: `${labelsLine(r.l[`quem.${t}.papel`])} · papel de outro parque ${fmtN(n0(r, `quem.${t}.outro_parque`))}` });
    }
    out.push({ id: "quem", item: 7, title: "Quem marca cada estado", closes: "Despachante; \"em recolha\" pelo cliente?", rows });
  }

  // 8. Entregas
  {
    const n = n0(r, "entregas.entregues");
    const rows: ReportRow[] = [
      { label: "Entregas do dia (com CHECK_OUT)", value: `${fmtN(n)} · canceladas a meio ${fmtN(n0(r, "entregas.canceladas"))} · abertas ${fmtN(n0(r, "entregas.abertas"))}` },
      { label: "Sem pendente / sem início / início antes do pendente", value: `${fmtN(n0(r, "entregas.sem_pedido"))} / ${fmtN(n0(r, "entregas.sem_inicio"))} / ${fmtN(n0(r, "entregas.inicio_antes_do_pedido"))}` },
      { label: "Pendente → em entrega (R → S)", value: pctLine(r.h["entregas.r_s"], "min", 1, [0.5, 0.75, 0.9]) },
      { label: "Em entrega → assinatura (S → E)", value: `${pctLine(r.h["entregas.s_e"], "min", 1, [0.5, 0.75, 0.9])} · < 2 min ${fmtPct(histShareBelow(r.h["entregas.s_e"], 2))}` },
      { label: "Linha CHECKING_OUT a > 1 km do parque", value: fmtPct(pctOf(n0(r, "entregas.s_longe_do_parque"), n0(r, "entregas.s_com_posicao"))) },
      { label: "Posição da linha CHECKING_OUT", value: labelsLine(r.l["posicao.CHECKING_OUT"]) },
      { label: "GPS em S → parque", value: pctLine(r.h["entregas.gps_s_parque"], "m", 1, [0.5, 0.9]) },
      { label: "Entre inícios seguidos do mesmo agente", value: `${pctLine(r.h["entregas.entre_inicios"], "min", 1, [0.1, 0.5])} · < 8 min ${fmtPct(histShareBelow(r.h["entregas.entre_inicios"], 8))}` },
      { label: "CHECK_OUT repetidos / reaberturas / fechos repetidos", value: `${fmtN(n0(r, "ciclos.checkout_repetido"))} / ${fmtN(n0(r, "ciclos.reaberturas"))} / ${fmtN(n0(r, "ciclos.fecho_repetido"))}` },
      { label: "Pendentes repetidos (> 1 no ciclo)", value: fmtN(n0(r, "entregas.pedido_repetido")) },
    ];
    out.push({ id: "entregas", item: 8, title: "Entregas", closes: "inicio_no_terminal, D_PARK_OK, D_MISMATCH, DISPATCH_MIN_MINUTES", rows });
  }

  // 9. Recolhas
  {
    const n = n0(r, "recolhas.recebidas");
    const withK = n0(r, "recolhas.com_em_recolha");
    const quick = n0(r, "recolhas.k_i_rapido");
    const seq = topLabels(r.l["recolhas.sequencia"], 10);
    const seqTotal = Object.values(r.l["recolhas.sequencia"] ?? {}).reduce((s, x) => s + x, 0);
    const rows: ReportRow[] = [
      { label: "Recolhas do dia (com CHECK_IN)", value: `${fmtN(n)} · canceladas ${fmtN(n0(r, "recolhas.canceladas"))} · abertas ${fmtN(n0(r, "recolhas.abertas"))} · reiniciadas ${fmtN(n0(r, "ciclos.recolha_reiniciada"))}` },
      { label: "Com \"em recolha\" (CHECKING_IN) antes", value: fmtPct(pctOf(withK, n)) },
      { label: "Em recolha → check-in (K → I)", value: pctLine(r.h["recolhas.k_i"], "min", 1, [0.25, 0.5, 0.75, 0.9]) },
      { label: "K → I < 2 min", value: `${fmtPct(pctOf(quick, withK))} · desses: mesmo agente ${fmtPct(pctOf(n0(r, "recolhas.k_i_rapido.mesmo_agente"), quick))} · K no terminal ${fmtPct(pctOf(n0(r, "recolhas.k_i_rapido.k_no_terminal"), quick))}` },
      { label: "\"Em recolha\" marcado onde", value: labelsLine(r.l["posicao.CHECKING_IN"]) },
      { label: "Check-in marcado onde", value: labelsLine(r.l["posicao.CHECK_IN"]) },
      { label: "Check-in → início do 1.º movimento", value: pctLine(r.h["recolhas.i_inicio_mov"], "min", 1, [0.5, 0.75, 0.9]) },
      { label: "Check-in → fim do 1.º movimento", value: pctLine(r.h["recolhas.i_fim_mov"], "min", 1, [0.5, 0.75, 0.9]) },
      { label: "Sem movimento em 48 h", value: fmtPct(pctOf(n0(r, "recolhas.sem_movimento"), n)) },
    ];
    out.push({
      id: "recolhas", item: 9, title: "Recolhas: estados e sequências", closes: "\"Em recolha\" = CHECKING_IN, em_recolha_tardio, PICKUP_TRACK_MAX_HOURS", rows,
      table: { head: ["Sequência (até 6 passos)", "N", "%"], rows: seq.map(([k, v]) => [k, fmtN(v), fmtPct(pctOf(v, seqTotal))]) },
    });
  }

  // 10. Garagens
  {
    const dest = topLabels(r.l["garagens.destino"], 15);
    const destTotal = Object.values(r.l["garagens.destino"] ?? {}).reduce((s, x) => s + x, 0);
    const table = dest.map(([g, v]) => [g, fmtN(v), fmtPct(pctOf(v, destTotal)), pctLine(r.h[`garagens.ate_seguinte.${g}`], "h", 1, [0.5, 0.9])]);
    const rows: ReportRow[] = [
      { label: "Garagens na tabela (parques da cidade)", value: (r.s?.garages ?? []).map((g) => `${g.name}${g.parkingType ? ` (${g.parkingType})` : ""}${g.mapHasCoords ? " · mapa com coordenadas" : ""}`).join(" · ") || "—" },
      { label: "1.ª garagem depois do check-in", value: labelsLine(r.l["garagens.primeira"], 10) },
      { label: "De → para (todos os movimentos)", value: labelsLine(r.l["garagens.de_para"], 10) },
      { label: "Há \"P2\"?", value: `tabela ${n0(r, "p2.na_tabela") > 0 ? "sim" : "não"} · movimentos que acabam no P2 ${fmtN(n0(r, "p2.nos_movimentos"))}` },
      { label: "  Fim no P2 → zona T1 / T2 / aeroporto", value: `${pctLine(r.h["p2.distancia.T1"], "m", 1, [0.5])} / ${pctLine(r.h["p2.distancia.T2"], "m", 1, [0.5])} / ${pctLine(r.h["p2.distancia.aeroporto"], "m", 1, [0.5])}` },
      { label: "Garagens que não estão na tabela", value: fmtN(n0(r, "garagens.fora_da_tabela")) },
    ];
    out.push({ id: "garagens", item: 10, title: "Garagens (destino dos movimentos) e P2", closes: "Q5, operations.garageRoles, ramo \"P2 sem garagem\", §5.2", rows, table: { head: ["Garagem de destino", "N", "%", "Até ao movimento seguinte"], rows: table } });
  }

  // 11. Saída do terminal
  {
    const base = n0(r, "saida.base");
    const table: string[][] = [];
    for (const v of EXIT_CAR_SPEEDS_KMH) for (const m of EXIT_MARGINS_M) {
      const key = exitComboKey(v, m);
      table.push([`${v} km/h`, `${m} m`, fmtPct(pctOf(n0(r, `saida.${key}.com`), base)), pctLine(r.h[`saida.${key}.i_x`], "min", 1, [0.5, 0.9])]);
    }
    out.push({
      id: "saida", item: 11, title: "Saída do terminal (recolhas)", closes: "V_CAR, D_EXIT_MARGIN",
      rows: [
        { label: "Recolhas com GPS e posição do check-in", value: fmtN(base), hint: `zona = ${PROBE_TERMINAL_RADIUS_M} m à volta da linha CHECK_IN` },
        { label: "Com o recurso da app (início do movimento dentro da zona)", value: fmtPct(pctOf(n0(r, "saida.recurso_app"), n0(r, "recolhas.recebidas"))) },
      ],
      table: { head: ["Velocidade de carro", "Margem", "% com saída", "Check-in → saída"], rows: table },
    });
  }

  // 12. T2
  {
    const t2 = n0(r, "t2.recolhas");
    out.push({
      id: "t2", item: 12, title: "Recolhas no T2: chegada do condutor", closes: "pickupT2TargetMinutes, Q4",
      rows: [
        { label: "Recolhas T2", value: `${fmtN(t2)} · sem zona T2 com rótulo ${fmtN(n0(r, "t2.sem_zona_t2"))} · sem GPS ${fmtN(n0(r, "t2.sem_gps"))} · sem chegada ${fmtN(n0(r, "t2.sem_chegada"))}` },
        { label: "Chegada à zona T2 − K0", value: pctLine(r.h["t2.chegada_menos_k0"], "min", 1, [0.5, 0.75, 0.9]) },
        { label: "Já lá antes de K0", value: fmtPct(pctOf(n0(r, "t2.ja_la"), n0(r, "t2.com_chegada"))) },
      ],
    });
  }

  // 13. Ficheiros GPS
  {
    out.push({
      id: "ficheiros", item: 13, title: "Ficheiros GPS", closes: "§4.1",
      rows: [
        { label: "Linhas do Histórico Diário do dia", value: labelsLine(r.l["ficheiros.passagem"]) },
        { label: "Ficheiros do dia lidos / ficheiros por ler na corrida", value: `${fmtN(n0(r, "ficheiros.lidos"))} / ${fmtN(n0(r, "ficheiros.por_ler"))}` },
        { label: "1.º ponto − meia-noite de Lisboa", value: pctLine(r.h["ficheiros.primeiro_ponto"], "h", 1, [0.1, 0.5, 0.9]) },
        { label: "Último ponto − meia-noite seguinte", value: pctLine(r.h["ficheiros.ultimo_ponto"], "h", 1, [0.1, 0.5, 0.9]) },
      ],
    });
  }

  // 14. Relógio
  {
    const off = r.s?.pgClockOffsetMs;
    out.push({
      id: "relogio", item: 14, title: "Relógio", closes: "§4.7",
      rows: [
        { label: "now() do Postgres − hora do servidor", value: off == null ? "—" : `${dec(off / 1000, 2)} s` },
        { label: "CHECK_OUT: ponto GPS mais perto no espaço − hora da linha", value: pctLine(r.h["relogio.checkout_gps"], "min", 1, [0.1, 0.5, 0.9]) },
      ],
    });
  }

  // 15. Definições
  {
    const s = r.s;
    out.push({
      id: "definicoes", item: 15, title: "Definições", closes: "§11.3, §4.3",
      rows: [
        { label: "Aeroporto: raio", value: s?.airportRadiusM == null ? "—" : `${fmtN(s.airportRadiusM)} m` },
        { label: "Zonas do terminal", value: s?.zones.length ? s.zones.map((z) => `${z.label} (${fmtN(z.radiusM)} m)`).join(" · ") : "nenhuma (só o círculo do aeroporto)" },
        { label: "Central Vodafone (consola) ligada", value: s?.centralSugarOn == null ? "—" : s.centralSugarOn ? "sim" : "não" },
        { label: "Parques operados / fora pela lista", value: s ? `${fmtN(s.parks)} / ${fmtN(s.excludedParks)}` : "—" },
      ],
    });
  }
  return out;
}

export const CLASS_LABELS: Record<string, string> = { t1: "T1", t2: "T2", vip: "VIP", other: "Outro", unknown: "Sem tipo" };
export const STATE_LABELS: Record<string, string> = {
  PENDING_CHECKOUT: "Pendente (PENDING_CHECKOUT)",
  CHECKING_OUT: "Em entrega (CHECKING_OUT)",
  CHECKING_IN: "Em recolha (CHECKING_IN)",
  CHECK_IN: "Check-in (CHECK_IN)",
};

/** Texto do "Copiar resumo". PURA. */
export function sondaReportText(r: SondaResult, sections: ReportSection[], o: { cities: string; ranAt?: string } = { cities: "" }): string {
  const days = r.days.length ? (r.days.length === 1 ? r.days[0] : `${r.days[0]} a ${r.days[r.days.length - 1]} (${r.days.length} dias)`) : "—";
  const lines: string[] = [
    `Diagnóstico dos tempos (P0, plano 62) — ${o.cities || PROBE_CITY_LABELS[r.city]} · ${days}${o.ranAt ? ` · corrido ${o.ranAt}` : ""}`,
  ];
  if (r.truncated) lines.push("Atenção: há dias com leitura parcial (prazo ou limite de ficheiros).");
  for (const f of r.failures) lines.push(f);
  for (const s of sections) {
    lines.push("");
    lines.push(`${s.item ? `${s.item}. ` : ""}${s.title} — fecha: ${s.closes}`);
    for (const row of s.rows) lines.push(`- ${row.label.trim()}: ${row.value}${row.hint ? ` (${row.hint})` : ""}`);
    if (s.table?.rows.length) {
      lines.push(`  ${s.table.head.join(" | ")}`);
      for (const tr of s.table.rows) lines.push(`  ${tr.join(" | ")}`);
    }
  }
  return lines.join("\n");
}

// ─── Linhas do log ──────────────────────────────────────────────────────────

/** Tamanho máximo de cada linha `[sonda62 n/N]` (o registo da Vercel corta linhas grandes). */
export const LOG_LINE_MAX_BYTES = 2000;

const byteLen = (s: string) => new TextEncoder().encode(s).length;
/** Caixas sem os zeros do fim (as arestas estão em HIST_EDGES; o tipo vai no nome). */
const trimZeros = (c: number[]) => { let k = c.length; while (k > 0 && c[k - 1] === 0) k--; return c.slice(0, k); };

/**
 * Linhas `[sonda62 n/N] {…}` com os MESMOS agregados (contagens, caixas sem
 * os zeros do fim e rótulos), cada uma ≤ 2 KB. Cada linha leva o dia e a
 * cidade, para se juntarem dias a partir do log. PURA.
 */
export function sondaLogLines(r: SondaResult, maxBytes = LOG_LINE_MAX_BYTES): string[] {
  const head = { d: r.days.join(","), c: r.city, tr: r.truncated ? 1 : 0 };
  const parts: Array<[string, unknown]> = [];
  if (r.failures.length) parts.push(["f", r.failures.map((f) => f.slice(0, 160))]);
  if (r.s) parts.push(["s", r.s]);
  for (const [k, v] of Object.entries(r.n).sort()) parts.push([`n.${k}`, v]);
  for (const [k, h] of Object.entries(r.h).sort()) parts.push([`h.${k}`, trimZeros(h.c)]);
  for (const [g, m] of Object.entries(r.l).sort()) parts.push([`l.${g}`, m]);
  const lines: Array<Record<string, unknown>> = [];
  let cur: Record<string, unknown> = { ...head };
  const budget = maxBytes - 40; // o prefixo "[sonda62 nn/NN] "
  for (const [k, v] of parts) {
    const next = { ...cur, [k]: v };
    if (byteLen(JSON.stringify(next)) > budget && Object.keys(cur).length > Object.keys(head).length) {
      lines.push(cur);
      cur = { ...head, [k]: v };
    } else cur = next;
    // um só pedaço maior do que a linha (ex.: lista de garagens enorme): corta-se o texto
    if (byteLen(JSON.stringify(cur)) > budget) {
      const s = JSON.stringify(v);
      cur = { ...head, [k]: `${s.slice(0, Math.max(0, budget - 200))}…` };
    }
  }
  lines.push(cur);
  return lines.map((o, i) => `[sonda62 ${i + 1}/${lines.length}] ${JSON.stringify(o)}`);
}
