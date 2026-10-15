/**
 * "Os tempos estão péssimos — é verdade?" (plano MPV §7, F8) — a verificação
 * dos tempos antes de o Multis os explicar, só para o super admin. A parte
 * PURA (servidor e browser): os tipos do relatório, a amostra, as duas
 * comparações de cada entrega, as medianas por condutor e a exportação
 * (Markdown e CSV) para anexar ao go/no-go.
 *
 *  1. Cobertura do GPS por cidade e semana (o "De onde vêm os tempos" da
 *     Pressão) com o PORTÃO (§8.1): com esta cobertura, abria ou não?
 *  2. Uma amostra de 30 entregas (sempre a mesma para o mesmo período,
 *     repartida pelas cidades) comparada com a FICHA da reserva (a History
 *     da reserva lida outra vez, com as mesmas regras) e com o ZELLO (os
 *     pontos do GPS do condutor entre pegar no carro e entregar).
 *  3. As medianas por condutor (Fila, Trânsito, Nosso, Cliente) com o n de
 *     cada uma, ao lado das da cidade.
 * Só leitura: nada se grava. A BD da Multipark é só de leitura.
 */
import { DRIVER_METRICS, DRIVER_STATS_MIN_N, type DriverMetric, type DriverRowLike } from "./serviceTimes";
import { toCsv } from "./csv";

export const VERIFY_SAMPLE_SIZE = 30;
/** A amostra vem destes dias (até D-3: o GPS já é o "final"). */
export const VERIFY_SAMPLE_DAYS = 14;
export const VERIFY_SAMPLE_END_OFFSET_DAYS = 3;
export const VERIFY_COVERAGE_WEEKS = 8;
export const VERIFY_DRIVER_DAYS = 28;
/** Diferença até à qual a tabela "bate" com a ficha (minutos). */
export const VERIFY_BOOKING_MATCH_MIN = 1;
/** Uma entrega da ficha é a mesma da tabela se a entrega (assinatura) estiver a menos disto (minutos). */
export const VERIFY_BOOKING_PAIR_MIN = 30;
/** O Zello "bate": ≥ 3 pontos na viagem, sem buracos acima de 10 min, a cobrir o início e a chegada (±2 min). */
export const VERIFY_ZELLO_MIN_POINTS = 3;
export const VERIFY_ZELLO_MAX_GAP_S = 600;
export const VERIFY_ZELLO_EDGE_S = 120;
/** Com a chegada pelo GPS: um ponto do Zello a menos de 2 min da chegada. */
export const VERIFY_ZELLO_ARRIVAL_S = 120;
/** Mínimo de entregas de cada cidade na amostra (se as houver). */
export const VERIFY_MIN_PER_CITY = 5;

export const VERIFY_CITY_LABELS: Record<string, string> = { lisboa: "Lisboa", porto: "Porto", faro: "Faro" };
export const VERIFY_METRICS = ["fila", "transito", "nosso", "cliente"] as const satisfies readonly DriverMetric[];
export type TvMetric = (typeof VERIFY_METRICS)[number];

// ─── Tipos do relatório ─────────────────────────────────────────────────────

export interface TvGate { visible: boolean; minCoveragePct: number; minN: number }

export interface TvCoverageRow {
  city: string;
  /** Segunda-feira da semana. */
  week: string;
  deliveries: number;
  gps: number;
  button: number;
  unmeasured: number;
  /** % das entregas com a chegada pelo GPS. */
  gpsPct: number | null;
  /** % com o Trânsito medido (GPS ou botão) — a cobertura que o portão usa. */
  measuredPct: number | null;
  /** Com esta cobertura e este n, o portão deixava ver os tempos com GPS (se estivesse aberto)? */
  gateWouldOpen: boolean;
  pickups: number;
  terminalGpsPct: number | null;
  noZello: number;
  missingZones: number;
  gpsPending: number;
  /** Os motivos sem medição mais frequentes. */
  topReasons: Array<{ reason: string; n: number }>;
}

/** Uma entrega da amostra (instantes em ms UTC). */
export interface TvSampleSource {
  bookingId: string;
  bookingCode: string | null;
  cityKey: string | null;
  opDay: string;
  terminalClass: string | null;
  startSource: string | null;
  requestAt: number | null;
  startedAt: number | null;
  arrivedAt: number | null;
  arrivedSource: string | null;
  deliveredAt: number | null;
  queueMs: number | null; queueStatus: string | null;
  transitMs: number | null; transitStatus: string | null;
  customerMs: number | null; customerStatus: string | null;
  totalMs: number | null;
  startEmployeeId: number | null;
  zelloUsername: string | null;
  gpsPoints: number | null;
  gpsMaxGapS: number | null;
  gpsPass: string | null;
  anchorKey: string;
}

export type TvBookingStatus = "bate" | "difere" | "sem_ciclo" | "falhou";
export interface TvBookingCheck {
  status: TvBookingStatus;
  requestDeltaMin: number | null;
  startDeltaMin: number | null;
  deliveredDeltaMin: number | null;
  note: string | null;
}

export type TvZelloStatus = "bate" | "gps_fraco" | "sem_ficheiro" | "sem_zello" | "falhou" | "nao_lido";
export interface TvZelloCheck {
  status: TvZelloStatus;
  points: number | null;
  maxGapS: number | null;
  /** Segundos entre a chegada da tabela e o ponto do Zello mais perto (só com a chegada pelo GPS). */
  nearestArrivalS: number | null;
  note: string | null;
}

export interface TvSampleItem extends TvSampleSource {
  driverName: string | null;
  booking: TvBookingCheck;
  zello: TvZelloCheck;
}

export interface TvMetricStat { n: number; p50Ms: number | null }
export interface TvDriverRow {
  city: string;
  employeeId: number;
  name: string | null;
  metrics: Record<TvMetric, TvMetricStat>;
  /** n ≥ DRIVER_STATS_MIN_N em pelo menos um tempo. */
  enough: boolean;
}

export interface TimesVerificationReport {
  generatedAt: string;
  today: string;
  gate: TvGate;
  coverage: { fromDay: string; toDay: string; rows: TvCoverageRow[]; truncated: boolean };
  sample: {
    fromDay: string; toDay: string; size: number; available: number;
    items: TvSampleItem[];
    bookingCounts: Record<TvBookingStatus, number>;
    zelloCounts: Record<TvZelloStatus, number>;
    /** A History não respondeu (a comparação com a ficha ficou por fazer). */
    bookingReadFailed: string | null;
  };
  drivers: { fromDay: string; toDay: string; minN: number; rows: TvDriverRow[]; cities: Array<{ city: string; metrics: Record<TvMetric, TvMetricStat> }>; truncated: boolean };
}

// ─── A amostra ──────────────────────────────────────────────────────────────

/** FNV-1a de 32 bits (a amostra é sempre a mesma para a mesma semente). PURA. */
export function tvHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/**
 * `size` entregas, repartidas pelas cidades na proporção das entregas (pelo
 * menos VERIFY_MIN_PER_CITY de cada uma, se as houver), escolhidas por um hash
 * fixo (semente + entrega) — o mesmo período dá sempre a mesma amostra. PURA.
 */
export function pickVerificationSample<T extends { anchorKey: string; cityKey: string | null }>(rows: readonly T[], size: number, seed: string): T[] {
  if (size <= 0 || !rows.length) return [];
  const byCity = new Map<string, T[]>();
  for (const r of rows) {
    const k = r.cityKey ?? "?";
    if (!byCity.has(k)) byCity.set(k, []);
    byCity.get(k)!.push(r);
  }
  const cities = [...byCity.keys()].sort();
  for (const c of cities) byCity.get(c)!.sort((a, b) => tvHash(`${seed}|${a.anchorKey}`) - tvHash(`${seed}|${b.anchorKey}`) || a.anchorKey.localeCompare(b.anchorKey));
  const total = Math.min(size, rows.length);
  const quota = new Map<string, number>();
  for (const c of cities) quota.set(c, Math.min(byCity.get(c)!.length, VERIFY_MIN_PER_CITY));
  let used = [...quota.values()].reduce((a, b) => a + b, 0);
  // Se o mínimo por cidade já passa do tamanho, corta-se pelas maiores.
  while (used > total) {
    const c = [...cities].sort((a, b) => (quota.get(b)! - quota.get(a)!) || a.localeCompare(b))[0];
    quota.set(c, quota.get(c)! - 1);
    used--;
  }
  // O resto, na proporção das entregas de cada cidade (a mais atrás da sua parte primeiro), sem passar do que há.
  while (used < total) {
    let best: string | null = null;
    let bestGap = -Infinity;
    for (const c of cities) {
      const have = byCity.get(c)!.length;
      if (quota.get(c)! >= have) continue;
      const gap = (total * have) / rows.length - quota.get(c)!;
      if (gap > bestGap) { bestGap = gap; best = c; }
    }
    if (!best) break;
    quota.set(best, quota.get(best)! + 1);
    used++;
  }
  return cities.flatMap((c) => byCity.get(c)!.slice(0, quota.get(c)!));
}

// ─── As comparações ─────────────────────────────────────────────────────────

const minutesBetween = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null ? null : Math.round(((a - b) / 60_000) * 10) / 10);

/**
 * A tabela × a ficha da reserva: das entregas que a History desta reserva dá
 * (recalculadas com as mesmas regras), a que tem a assinatura mais perto;
 * diferenças em minutos (pendente, pegar no carro, entrega). "bate" = todas
 * ≤ 1 min. PURA.
 */
export function compareWithBooking(
  s: Pick<TvSampleSource, "requestAt" | "startedAt" | "deliveredAt">,
  live: ReadonlyArray<{ kind: string; requestAt?: number | null; startedAt?: number | null; deliveredAt?: number | null }> | null,
): TvBookingCheck {
  if (live == null) return { status: "falhou", requestDeltaMin: null, startDeltaMin: null, deliveredDeltaMin: null, note: "Não deu para ler a ficha da reserva." };
  const cands = live.filter((r) => r.kind === "entrega" && r.deliveredAt != null && s.deliveredAt != null)
    .map((r) => ({ r, d: Math.abs((r.deliveredAt as number) - (s.deliveredAt as number)) }))
    .sort((a, b) => a.d - b.d);
  const best = cands[0];
  if (!best || best.d > VERIFY_BOOKING_PAIR_MIN * 60_000) {
    return { status: "sem_ciclo", requestDeltaMin: null, startDeltaMin: null, deliveredDeltaMin: null, note: "A ficha não tem uma entrega com esta assinatura (±30 min)." };
  }
  const requestDeltaMin = minutesBetween(s.requestAt, best.r.requestAt);
  const startDeltaMin = minutesBetween(s.startedAt, best.r.startedAt);
  const deliveredDeltaMin = minutesBetween(s.deliveredAt, best.r.deliveredAt);
  const off: string[] = [];
  if (requestDeltaMin != null && Math.abs(requestDeltaMin) > VERIFY_BOOKING_MATCH_MIN) off.push(`pendente ${requestDeltaMin > 0 ? "+" : ""}${requestDeltaMin} min`);
  if (startDeltaMin != null && Math.abs(startDeltaMin) > VERIFY_BOOKING_MATCH_MIN) off.push(`pegou no carro ${startDeltaMin > 0 ? "+" : ""}${startDeltaMin} min`);
  if (deliveredDeltaMin != null && Math.abs(deliveredDeltaMin) > VERIFY_BOOKING_MATCH_MIN) off.push(`entrega ${deliveredDeltaMin > 0 ? "+" : ""}${deliveredDeltaMin} min`);
  if ((s.requestAt == null) !== (best.r.requestAt == null)) off.push(s.requestAt == null ? "a ficha tem pendente e a tabela não" : "a tabela tem pendente e a ficha não");
  if ((s.startedAt == null) !== (best.r.startedAt == null)) off.push(s.startedAt == null ? "a ficha tem \"em entrega\" e a tabela não" : "a tabela tem \"em entrega\" e a ficha não");
  return { status: off.length ? "difere" : "bate", requestDeltaMin, startDeltaMin, deliveredDeltaMin, note: off.length ? off.join("; ") : null };
}

export interface TvGpsPoint { ts: number; lat: number | null; lon: number | null; accurate: boolean }

/**
 * A tabela × o Zello: os pontos do GPS do condutor entre pegar no carro (−5
 * min) e a entrega (+5 min) — quantos, o maior buraco, se cobrem o início e
 * a chegada e, com a chegada pelo GPS, o ponto mais perto dela. PURA.
 */
export function compareWithZello(
  s: Pick<TvSampleSource, "zelloUsername" | "startedAt" | "arrivedAt" | "arrivedSource" | "deliveredAt">,
  file: { status: "ok"; points: readonly TvGpsPoint[] } | { status: "missing" } | { status: "failed"; reason?: string } | null | undefined,
): TvZelloCheck {
  const none = { points: null, maxGapS: null, nearestArrivalS: null };
  if (!s.zelloUsername) return { status: "sem_zello", ...none, note: "Sem Zello ligado ao condutor nesse dia." };
  if (!file) return { status: "nao_lido", ...none, note: "O ficheiro do GPS não foi lido (sem tempo)." };
  if (file.status === "missing") return { status: "sem_ficheiro", ...none, note: "Não há ficheiro do GPS desse Zello nesse dia." };
  if (file.status === "failed") return { status: "falhou", ...none, note: file.reason === "prazo" ? "O ficheiro do GPS não foi lido (sem tempo)." : "Não deu para ler o ficheiro do GPS." };
  if (s.startedAt == null || s.deliveredAt == null) return { status: "gps_fraco", ...none, note: "A entrega não tem início ou fim." };
  const from = s.startedAt - 5 * 60_000, to = s.deliveredAt + 5 * 60_000;
  const pts = file.points.filter((p) => p.accurate && p.lat != null && p.lon != null).map((p) => p.ts * 1000).filter((t) => t >= from && t <= to).sort((a, b) => a - b);
  let maxGap = 0;
  for (let i = 1; i < pts.length; i++) maxGap = Math.max(maxGap, (pts[i] - pts[i - 1]) / 1000);
  const end = s.arrivedAt ?? s.deliveredAt;
  const coversStart = pts.length > 0 && pts[0] <= s.startedAt + VERIFY_ZELLO_EDGE_S * 1000;
  const coversEnd = pts.length > 0 && pts[pts.length - 1] >= end - VERIFY_ZELLO_EDGE_S * 1000;
  const gpsArrival = String(s.arrivedSource ?? "").startsWith("gps") && s.arrivedAt != null;
  const nearest = gpsArrival && pts.length ? Math.round(Math.min(...pts.map((t) => Math.abs(t - (s.arrivedAt as number)))) / 1000) : null;
  const off: string[] = [];
  if (pts.length < VERIFY_ZELLO_MIN_POINTS) off.push(`só ${pts.length} ponto(s) na viagem`);
  if (pts.length >= 2 && maxGap > VERIFY_ZELLO_MAX_GAP_S) off.push(`buraco de ${Math.round(maxGap / 60)} min`);
  if (pts.length && !coversStart) off.push("não apanha o início");
  if (pts.length && !coversEnd) off.push("não chega à chegada");
  if (nearest != null && nearest > VERIFY_ZELLO_ARRIVAL_S) off.push(`ponto mais perto da chegada a ${Math.round(nearest / 60)} min`);
  return {
    status: off.length ? "gps_fraco" : "bate", points: pts.length, maxGapS: pts.length >= 2 ? Math.round(maxGap) : null, nearestArrivalS: nearest,
    note: off.length ? off.join("; ") : null,
  };
}

// ─── Medianas por condutor ──────────────────────────────────────────────────

function median(v: number[]): number | null {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const pos = (s.length - 1) / 2, lo = Math.floor(pos), hi = Math.ceil(pos);
  return Math.round(s[lo] + (s[hi] - s[lo]) * (pos - lo));
}
const emptyMetrics = (): Record<TvMetric, number[]> => ({ fila: [], transito: [], nosso: [], cliente: [] });
const statsOf = (m: Record<TvMetric, number[]>) => Object.fromEntries(VERIFY_METRICS.map((k) => [k, { n: m[k].length, p50Ms: median(m[k]) }])) as Record<TvMetric, TvMetricStat>;

/**
 * Mediana e n de cada tempo (Fila, Trânsito, Nosso, Cliente) por cidade e
 * condutor — a quem o tempo pertence (DRIVER_METRICS: quem pegou no carro;
 * no Cliente, quem entregou) — e as da cidade. Só as entregas não canceladas.
 * Ordem: cidade, depois mais entregas. PURA.
 */
export function driverMedians(rows: ReadonlyArray<DriverRowLike>, names: ReadonlyMap<number, string>, o: { minN?: number; max?: number } = {}): { rows: TvDriverRow[]; cities: Array<{ city: string; metrics: Record<TvMetric, TvMetricStat> }> } {
  const minN = o.minN ?? DRIVER_STATS_MIN_N;
  const per = new Map<string, Record<TvMetric, number[]>>();
  const city = new Map<string, Record<TvMetric, number[]>>();
  for (const r of rows) {
    if (r.kind !== "entrega" || r.outcome === "cancelado") continue;
    const c = r.cityKey ?? "?";
    for (const m of VERIFY_METRICS) {
      const def = DRIVER_METRICS[m];
      const v = def.value(r);
      if (v == null || !Number.isFinite(v)) continue;
      if (!city.has(c)) city.set(c, emptyMetrics());
      city.get(c)![m].push(v);
      const emp = def.employee(r);
      if (emp == null) continue;
      const k = `${c}|${emp}`;
      if (!per.has(k)) per.set(k, emptyMetrics());
      per.get(k)![m].push(v);
    }
  }
  const out: TvDriverRow[] = [...per.entries()].map(([k, m]) => {
    const [c, e] = k.split("|");
    const metrics = statsOf(m);
    return { city: c, employeeId: Number(e), name: names.get(Number(e)) ?? null, metrics, enough: VERIFY_METRICS.some((x) => metrics[x].n >= minN) };
  });
  const most = (x: TvDriverRow) => Math.max(...VERIFY_METRICS.map((m) => x.metrics[m].n));
  out.sort((a, b) => a.city.localeCompare(b.city) || most(b) - most(a) || a.employeeId - b.employeeId);
  return {
    rows: out.slice(0, o.max ?? 300),
    cities: [...city.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([c, m]) => ({ city: c, metrics: statsOf(m) })),
  };
}

// ─── Exportação ─────────────────────────────────────────────────────────────

const cityLabel = (c: string | null) => VERIFY_CITY_LABELS[c ?? ""] ?? c ?? "—";
const mins = (ms: number | null | undefined) => (ms == null ? "—" : `${(ms / 60_000).toFixed(1).replace(".", ",")}`);
const pctText = (v: number | null) => (v == null ? "—" : `${Math.round(v)} %`);
/** Hora de Lisboa "HH:MM" de um instante. */
export const lisbonHm = (ms: number | null | undefined): string => (ms == null ? "—" : new Intl.DateTimeFormat("pt-PT", { timeZone: "Europe/Lisbon", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms)));
const md = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

export const BOOKING_STATUS_LABELS: Record<TvBookingStatus, string> = { bate: "bate", difere: "difere", sem_ciclo: "sem entrega na ficha", falhou: "não deu para ler" };
export const ZELLO_STATUS_LABELS: Record<TvZelloStatus, string> = { bate: "bate", gps_fraco: "GPS fraco", sem_ficheiro: "sem ficheiro", sem_zello: "sem Zello", falhou: "não deu para ler", nao_lido: "por ler" };

/** O relatório em Markdown (para anexar ao go/no-go); `probeSummary` = o "Copiar resumo" do Diagnóstico dos tempos, se correu. PURA. */
export function timesVerificationMarkdown(r: TimesVerificationReport, o: { probeSummary?: string | null } = {}): string {
  const L: string[] = [];
  L.push("# Verificação dos tempos — \"os tempos estão péssimos: é verdade?\"");
  L.push("");
  L.push(`Gerado a ${r.generatedAt} (dia operacional ${r.today}). Só leitura. Portão dos tempos com GPS: **${r.gate.visible ? "aberto" : "fechado (em calibração)"}** — abre por cidade com ≥ ${r.gate.minCoveragePct} % de cobertura e n ≥ ${r.gate.minN}.`);
  L.push("");
  const s = r.sample;
  const withGps = s.items.filter((x) => x.zello.status !== "sem_zello").length;
  L.push("## Conclusão da amostra");
  L.push(`- ${s.items.length} entregas (${s.fromDay} a ${s.toDay}, de ${s.available} possíveis): **${s.bookingCounts.bate}** batem com a ficha da reserva, ${s.bookingCounts.difere} diferem, ${s.bookingCounts.sem_ciclo} sem entrega na ficha, ${s.bookingCounts.falhou} por ler.`);
  L.push(`- Zello: **${s.zelloCounts.bate}** de ${withGps} com Zello batem; ${s.zelloCounts.gps_fraco} com GPS fraco, ${s.zelloCounts.sem_ficheiro} sem ficheiro, ${s.zelloCounts.falhou + s.zelloCounts.nao_lido} por ler; ${s.zelloCounts.sem_zello} sem Zello.`);
  if (s.bookingReadFailed) L.push(`- A ficha das reservas não respondeu: ${s.bookingReadFailed}`);
  L.push("");
  L.push(`## 1. Cobertura do GPS por cidade e semana (${r.coverage.fromDay} a ${r.coverage.toDay})`);
  if (r.coverage.truncated) L.push("_A leitura chegou ao teto: ficam as semanas mais recentes._");
  L.push("");
  L.push("| Semana | Cidade | Entregas | GPS | Botão | Sem medição | Cobertura do portão | Abria? | Recolhas | Saída GPS | Zello não bate | Zonas em falta | Motivos |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const c of r.coverage.rows) {
    L.push(`| ${c.week} | ${cityLabel(c.city)} | ${c.deliveries} | ${pctText(c.gpsPct)} | ${c.button} | ${c.unmeasured} | ${pctText(c.measuredPct)} | ${c.gateWouldOpen ? "sim" : "não"} | ${c.pickups} | ${pctText(c.terminalGpsPct)} | ${c.noZello} | ${c.missingZones} | ${md(c.topReasons.map((x) => `${x.reason} ${x.n}`).join(", ") || "—")} |`);
  }
  L.push("");
  L.push(`## 2. Amostra de ${s.items.length} entregas: tabela × ficha da reserva × Zello`);
  L.push("Horas de Lisboa; tempos em minutos. Ficha = a History da reserva lida outra vez com as mesmas regras (Δ = tabela − ficha). Zello = os pontos do GPS do condutor entre pegar no carro e entregar.");
  L.push("");
  L.push("| Reserva | Cidade | Dia | Condutor | Pendente | Pegou | Chegou (fonte) | Entregou | Fila | Trânsito | Cliente | Total | Ficha | Zello |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const x of s.items) {
    const b = `${BOOKING_STATUS_LABELS[x.booking.status]}${x.booking.note ? ` (${x.booking.note})` : ""}`;
    const z = `${ZELLO_STATUS_LABELS[x.zello.status]}${x.zello.points != null ? `, ${x.zello.points} pts` : ""}${x.zello.note ? ` (${x.zello.note})` : ""}`;
    L.push(`| ${md(x.bookingCode ?? x.bookingId)} | ${cityLabel(x.cityKey)} | ${x.opDay} | ${md(x.driverName ?? (x.startEmployeeId ? `#${x.startEmployeeId}` : "—"))} | ${lisbonHm(x.requestAt)} | ${lisbonHm(x.startedAt)} | ${lisbonHm(x.arrivedAt)}${x.arrivedSource ? ` (${x.arrivedSource})` : ""} | ${lisbonHm(x.deliveredAt)} | ${mins(x.queueMs)} | ${mins(x.transitMs)} | ${mins(x.customerMs)} | ${mins(x.totalMs)} | ${md(b)} | ${md(z)} |`);
  }
  L.push("");
  L.push(`## 3. Medianas por condutor (${r.drivers.fromDay} a ${r.drivers.toDay}, minutos, com n)`);
  L.push(`Abaixo de n = ${r.drivers.minN} a mediana diz pouco (marcado com *).`);
  if (r.drivers.truncated) L.push("_A leitura chegou ao teto: ficam os dias mais recentes._");
  L.push("");
  L.push("| Cidade | Condutor | Fila | Trânsito | Nosso | Cliente |");
  L.push("|---|---|---|---|---|---|");
  const cell = (m: TvMetricStat) => (m.n ? `${mins(m.p50Ms)} (n=${m.n})${m.n < r.drivers.minN ? "*" : ""}` : "—");
  for (const c of r.drivers.cities) L.push(`| ${cityLabel(c.city)} | **toda a cidade** | ${cell(c.metrics.fila)} | ${cell(c.metrics.transito)} | ${cell(c.metrics.nosso)} | ${cell(c.metrics.cliente)} |`);
  for (const d of r.drivers.rows) L.push(`| ${cityLabel(d.city)} | ${md(d.name ?? `#${d.employeeId}`)} | ${cell(d.metrics.fila)} | ${cell(d.metrics.transito)} | ${cell(d.metrics.nosso)} | ${cell(d.metrics.cliente)} |`);
  L.push("");
  L.push("## Diagnóstico dos tempos (calibração)");
  L.push(o.probeSummary?.trim() ? o.probeSummary.trim() : "Não foi corrido nesta página. Para a calibração (paragem, terminal, chamadas), corre o **Diagnóstico dos tempos** em Extras Dia → Pressão para os dias da amostra e junta o \"Copiar resumo\".");
  L.push("");
  return L.join("\n");
}

/** As três tabelas em CSV (separador ";", à prova de fórmulas). PURA. */
export function timesVerificationCsv(r: TimesVerificationReport, which: "cobertura" | "amostra" | "condutores"): string {
  if (which === "cobertura") {
    return toCsv(
      ["semana", "cidade", "entregas", "gps", "botao", "sem_medicao", "gps_pct", "cobertura_portao_pct", "portao_abria", "recolhas", "saida_gps_pct", "zello_nao_bate", "zonas_em_falta", "gps_por_recolher", "motivos"],
      r.coverage.rows.map((c) => [c.week, cityLabel(c.city), c.deliveries, c.gps, c.button, c.unmeasured, c.gpsPct ?? "", c.measuredPct ?? "", c.gateWouldOpen ? "sim" : "não", c.pickups, c.terminalGpsPct ?? "", c.noZello, c.missingZones, c.gpsPending, c.topReasons.map((x) => `${x.reason} ${x.n}`).join(", ")]),
    );
  }
  if (which === "amostra") {
    const m = (v: number | null) => (v == null ? "" : (v / 60_000).toFixed(1));
    return toCsv(
      ["reserva", "cidade", "dia", "condutor", "pendente", "pegou", "chegou", "fonte_chegada", "entregou", "fila_min", "transito_min", "cliente_min", "total_min", "ficha", "ficha_delta_pendente_min", "ficha_delta_pegou_min", "ficha_delta_entrega_min", "ficha_nota", "zello", "zello_pontos", "zello_maior_buraco_s", "zello_ponto_mais_perto_da_chegada_s", "zello_nota"],
      r.sample.items.map((x) => [
        x.bookingCode ?? x.bookingId, cityLabel(x.cityKey), x.opDay, x.driverName ?? (x.startEmployeeId ? `#${x.startEmployeeId}` : ""),
        lisbonHm(x.requestAt), lisbonHm(x.startedAt), lisbonHm(x.arrivedAt), x.arrivedSource ?? "", lisbonHm(x.deliveredAt),
        m(x.queueMs), m(x.transitMs), m(x.customerMs), m(x.totalMs),
        BOOKING_STATUS_LABELS[x.booking.status], x.booking.requestDeltaMin ?? "", x.booking.startDeltaMin ?? "", x.booking.deliveredDeltaMin ?? "", x.booking.note ?? "",
        ZELLO_STATUS_LABELS[x.zello.status], x.zello.points ?? "", x.zello.maxGapS ?? "", x.zello.nearestArrivalS ?? "", x.zello.note ?? "",
      ]),
    );
  }
  const m = (s: TvMetricStat) => (s.p50Ms == null ? "" : (s.p50Ms / 60_000).toFixed(1));
  return toCsv(
    ["cidade", "condutor", "fila_p50_min", "fila_n", "transito_p50_min", "transito_n", "nosso_p50_min", "nosso_n", "cliente_p50_min", "cliente_n"],
    [
      ...r.drivers.cities.map((c) => [cityLabel(c.city), "toda a cidade", m(c.metrics.fila), c.metrics.fila.n, m(c.metrics.transito), c.metrics.transito.n, m(c.metrics.nosso), c.metrics.nosso.n, m(c.metrics.cliente), c.metrics.cliente.n]),
      ...r.drivers.rows.map((d) => [cityLabel(d.city), d.name ?? `#${d.employeeId}`, m(d.metrics.fila), d.metrics.fila.n, m(d.metrics.transito), d.metrics.transito.n, m(d.metrics.nosso), d.metrics.nosso.n, m(d.metrics.cliente), d.metrics.cliente.n]),
    ],
  );
}
