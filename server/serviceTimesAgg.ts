/**
 * Tempos de entrega e de recolha — as CONTAS dos ecrãs (Resumo do dia, dia
 * do condutor, Pressão, Semana, cartão da cobertura). PURO: recebe as linhas
 * (da tabela `service_times` ou calculadas ao vivo com as mesmas regras) e
 * devolve médias e percentis, a cobertura e a meta, já com o PORTÃO dos tempos
 * com GPS aplicado (§8.1): quem não é super admin não recebe Trânsito,
 * Cliente das entregas, Nosso, % na meta, No terminal, Até à 1.ª garagem nem
 * Atrasadas no T2 enquanto o portão estiver fechado — nem os números, nem as
 * listas com eles. O super admin vê sempre, com "em calibração".
 *
 * Percentis = os do `percentile_cont` do Postgres (interpolação linear entre
 * as duas posições vizinhas). "Sem medição" nunca é 0: um tempo sem casos
 * medidos vem `null`, e a cobertura (% medidos) vem sempre ao lado.
 */
import {
  DEFAULT_GPS_GATE, DRIVER_METRICS, gpsTimesVisible, withinTarget,
  type DriverMetric, type DriverRowLike, type GpsGate,
} from "../shared/serviceTimes";

// ─── Linha ──────────────────────────────────────────────────────────────────

/** Uma linha de tempos (a da tabela `service_times`, com os instantes em ms UTC). */
export interface ServiceRow extends DriverRowLike {
  bookingId: string;
  bookingCode?: string | null;
  refHour?: number | null;
  startSource?: string | null;
  callAt?: number | null;
  requestAt?: number | null;
  startedAt?: number | null;
  arrivedAt?: number | null;
  arrivedSource?: string | null;
  deliveredAt?: number | null;
  totalMs?: number | null;
  checkInAt?: number | null;
  terminalExitAt?: number | null;
  terminalExitSource?: string | null;
  firstGarage?: string | null;
  firstGarageRole?: string | null;
  parkedGarage?: string | null;
  flags?: string | null;
  gpsPass?: string | null;
  calcVersion?: number | null;
  paramsHash?: string | null;
  computedAt?: string | null;
}

// ─── Percentis (iguais ao percentile_cont) ──────────────────────────────────

/**
 * Percentil contínuo (0–1), igual ao `percentile_cont(q) WITHIN GROUP (ORDER BY x)`
 * do Postgres: posição (n − 1) × q e interpolação linear. Sem valores → null. PURA.
 */
export function percentileCont(values: readonly number[], q: number): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * Math.min(Math.max(q, 0), 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

export interface TimeStats { n: number; meanMs: number | null; p50Ms: number | null; p75Ms: number | null; p90Ms: number | null }

/** n, média e p50/p75/p90 (ms, arredondados ao ms). PURA. */
export function timeStats(values: readonly number[]): TimeStats {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return { n: 0, meanMs: null, p50Ms: null, p75Ms: null, p90Ms: null };
  const r = (x: number | null) => (x == null ? null : Math.round(x));
  return { n: v.length, meanMs: Math.round(v.reduce((a, b) => a + b, 0) / v.length), p50Ms: r(percentileCont(v, 0.5)), p75Ms: r(percentileCont(v, 0.75)), p90Ms: r(percentileCont(v, 0.9)) };
}

// ─── Os tempos de cada ecrã ─────────────────────────────────────────────────

export type TimeMetric = "fila" | "transito" | "nosso" | "cliente" | "total" | "cliente_recolha" | "terminal" | "ate_garagem" | "p2" | "ate_arrumado";
export const DELIVERY_METRICS = ["fila", "transito", "nosso", "cliente", "total"] as const satisfies readonly TimeMetric[];
export const PICKUP_METRICS = ["terminal", "p2", "cliente_recolha", "ate_arrumado", "ate_garagem"] as const satisfies readonly TimeMetric[];

export interface TimeMetricDef { kind: "entrega" | "recolha"; label: string; short: string; gps: boolean }

/** O que cada tempo é (rótulos dos ecrãs). `gps` = atrás do portão (§8.1). */
export const TIME_METRICS: Record<TimeMetric, TimeMetricDef> = {
  fila: { kind: "entrega", label: "Fila", short: "chamada ou pendente → pegou no carro", gps: false },
  transito: { kind: "entrega", label: "Trânsito", short: "pegou no carro → chegou ao terminal", gps: true },
  nosso: { kind: "entrega", label: "Nosso", short: "Fila + Trânsito", gps: true },
  cliente: { kind: "entrega", label: "Cliente", short: "chegou ao terminal → assinatura", gps: true },
  total: { kind: "entrega", label: "Total", short: "chamada ou pendente → assinatura", gps: false },
  cliente_recolha: { kind: "recolha", label: "Cliente", short: "chamada ou \"em recolha\" → check-in", gps: false },
  terminal: { kind: "recolha", label: "No terminal", short: "check-in → o carro sai do terminal", gps: true },
  ate_garagem: { kind: "recolha", label: "Até à 1.ª garagem", short: "saída do terminal → 1.ª garagem", gps: true },
  p2: { kind: "recolha", label: "No P2", short: "chegou ao P2 → saiu para um parque", gps: false },
  ate_arrumado: { kind: "recolha", label: "Até arrumado", short: "check-in → no parque certo", gps: false },
};

/** O tempo de uma métrica nesta linha (ms), só quando medido. O Total com o limite do ecrã. PURA. */
export function metricValue(r: ServiceRow, m: TimeMetric, o: { totalMaxMin?: number } = {}): number | null {
  if (m === "total") {
    const v = r.totalMs;
    if (v == null || !Number.isFinite(v) || v < 0) return null;
    return o.totalMaxMin != null && v > o.totalMaxMin * 60_000 ? null : v;
  }
  const v = DRIVER_METRICS[m as DriverMetric].value(r);
  return v != null && Number.isFinite(v) ? v : null;
}

/** A linha conta (do tipo, não anulada, não cancelada). PURA. */
export const rowCounts = (r: ServiceRow, kind: "entrega" | "recolha") => r.kind === kind && !r.voidedAt && r.outcome !== "cancelado";

// ─── Portão (§8.1) por cidade ───────────────────────────────────────────────

export interface GateCtx { gate: GpsGate | null | undefined; isSuperAdmin: boolean }

/**
 * As cidades em que um tempo com GPS pode ir para o ecrã neste período: em
 * cada cidade, cobertura = % das linhas com o tempo medido, n = quantas. As
 * cidades fechadas saem das contas (como na série por condutor). PURA.
 */
export function visibleCities(rows: readonly ServiceRow[], m: TimeMetric, g: GateCtx, o: { totalMaxMin?: number } = {}): { cities: Set<string>; hidden: string | null; note: string | null } {
  const def = TIME_METRICS[m];
  const byCity = new Map<string, { total: number; n: number }>();
  for (const r of rows) {
    if (!rowCounts(r, def.kind)) continue;
    const k = r.cityKey ?? "";
    const c = byCity.get(k) ?? { total: 0, n: 0 };
    c.total++;
    if (metricValue(r, m, o) != null) c.n++;
    byCity.set(k, c);
  }
  const cities = new Set<string>();
  let hidden: string | null = null, note: string | null = null;
  for (const [city, c] of byCity) {
    if (!def.gps) { cities.add(city); continue; }
    const v = gpsTimesVisible({ coveragePct: c.total ? (c.n / c.total) * 100 : 0, n: c.n, gate: g.gate ?? DEFAULT_GPS_GATE, isSuperAdmin: g.isSuperAdmin });
    if (v.visible) { cities.add(city); note ??= v.label; } else hidden ??= v.label;
  }
  if (cities.size) hidden = null;
  else if (def.gps && !byCity.size) ({ hidden, note } = emptyGate(g));
  return { cities, hidden, note };
}

/** Sem linhas nenhumas: com o portão fechado, quem não é super admin vê "Em calibração" (nunca "sem casos"). PURA. */
function emptyGate(g: GateCtx): { hidden: string | null; note: string | null } {
  const gate = g.gate ?? DEFAULT_GPS_GATE;
  if (gate.visible) return { hidden: null, note: null };
  return g.isSuperAdmin ? { hidden: null, note: "em calibração" } : { hidden: "Em calibração", note: null };
}

// ─── Um tempo num conjunto de linhas ────────────────────────────────────────

export interface MetricView {
  metric: TimeMetric;
  label: string;
  short: string;
  gps: boolean;
  /** Linhas que contam (não canceladas). */
  n: number;
  /** Com este tempo medido. */
  measured: number;
  /** % medidos (sempre visível, também com o portão fechado). */
  coveragePct: number | null;
  /** Os números (null: sem casos medidos, ou escondidos pelo portão). */
  stats: TimeStats | null;
  /** Portão fechado: o texto no lugar dos números ("Em calibração", "Sem dados suficientes (…)"). */
  hidden: string | null;
  /** Super admin com o portão fechado: "em calibração" (provisório). */
  note: string | null;
}

/** Um tempo (estatística, cobertura e portão). PURA. */
export function metricView(rows: readonly ServiceRow[], m: TimeMetric, g: GateCtx, o: { totalMaxMin?: number } = {}): MetricView {
  const def = TIME_METRICS[m];
  const mine = rows.filter((r) => rowCounts(r, def.kind));
  const vals = mine.map((r) => metricValue(r, m, o));
  const measured = vals.filter((v) => v != null).length;
  const vis = visibleCities(mine, m, g, o);
  const shown = def.gps ? mine.map((r, i) => (vis.cities.has(r.cityKey ?? "") ? vals[i] : null)) : vals;
  const nums = shown.filter((v): v is number => v != null);
  return {
    metric: m, label: def.label, short: def.short, gps: def.gps, n: mine.length, measured,
    coveragePct: mine.length ? Math.round((measured / mine.length) * 1000) / 10 : null,
    stats: vis.hidden || !nums.length ? null : timeStats(nums),
    hidden: vis.hidden, note: vis.hidden ? null : vis.note,
  };
}

/** % na meta (Nosso ≤ meta), só com o Nosso medido; atrás do portão. PURA. */
export function inTargetView(rows: readonly ServiceRow[], targetMinutes: number, g: GateCtx): { measured: number; within: number | null; pct: number | null; hidden: string | null; note: string | null } {
  const mine = rows.filter((r) => rowCounts(r, "entrega"));
  const vis = visibleCities(mine, "nosso", g);
  if (vis.hidden) return { measured: mine.filter((r) => metricValue(r, "nosso") != null).length, within: null, pct: null, hidden: vis.hidden, note: null };
  let measured = 0, within = 0;
  for (const r of mine) {
    if (!vis.cities.has(r.cityKey ?? "")) continue;
    const w = withinTarget({ ourMs: r.ourMs ?? null, ourStatus: r.ourStatus ?? "" }, targetMinutes);
    if (w == null) continue;
    measured++;
    if (w) within++;
  }
  return { measured, within, pct: measured ? Math.round((within / measured) * 1000) / 10 : null, hidden: null, note: vis.note };
}

/** Atrasadas no T2 (só recolhas T2 com a chegada medida); atrás do portão. PURA. */
export function t2View(rows: readonly ServiceRow[], g: GateCtx): { n: number; measured: number; late: number | null; hidden: string | null; note: string | null } {
  const t2 = rows.filter((r) => rowCounts(r, "recolha") && r.terminalClass === "t2");
  const isMeasured = (r: ServiceRow) => r.t2Status === "medido" && r.t2LateMs != null;
  const measured = t2.filter(isMeasured).length;
  const byCity = new Map<string, { total: number; n: number }>();
  for (const r of t2) { const c = byCity.get(r.cityKey ?? "") ?? { total: 0, n: 0 }; c.total++; if (isMeasured(r)) c.n++; byCity.set(r.cityKey ?? "", c); }
  let hidden: string | null = null, note: string | null = null;
  const open = new Set<string>();
  for (const [city, c] of byCity) {
    const v = gpsTimesVisible({ coveragePct: c.total ? (c.n / c.total) * 100 : 0, n: c.n, gate: g.gate ?? DEFAULT_GPS_GATE, isSuperAdmin: g.isSuperAdmin });
    if (v.visible) { open.add(city); note ??= v.label; } else hidden ??= v.label;
  }
  if (open.size) hidden = null;
  else if (!byCity.size) ({ hidden, note } = emptyGate(g));
  if (hidden) return { n: t2.length, measured, late: null, hidden, note: null };
  const late = t2.filter((r) => open.has(r.cityKey ?? "") && isMeasured(r) && (r.t2LateMs ?? 0) > 0).length;
  return { n: t2.length, measured, late, hidden: null, note };
}

// ─── Cobertura (sempre visível) ─────────────────────────────────────────────

export interface DeliveryCoverage {
  n: number;
  /** Início da Fila: a chamada do cliente, o pendente, ou só o "em entrega". */
  withCall: number; fromPending: number; noRequest: number;
  /** Chegada ao terminal: pelo GPS, pelo "Cheguei" (recurso) ou sem medição. */
  gps: number; button: number; unmeasured: number;
  /** Motivos do Trânsito sem medição (estado → quantas). */
  reasons: Record<string, number>;
}
export interface PickupCoverage {
  n: number;
  withCall: number; fromPickup: number; noRequest: number;
  /** Saída do terminal: pelo GPS, pelo início do movimento na app, ou sem medição. */
  gps: number; app: number; unmeasured: number;
  reasons: Record<string, number>;
}

const bump = (o: Record<string, number>, k: string | null | undefined) => { if (k) o[k] = (o[k] ?? 0) + 1; };

/** Cobertura das entregas e das recolhas (contagens, nada pessoal). PURA. */
export function coverageOf(rows: readonly ServiceRow[]): { deliveries: DeliveryCoverage; pickups: PickupCoverage } {
  const d: DeliveryCoverage = { n: 0, withCall: 0, fromPending: 0, noRequest: 0, gps: 0, button: 0, unmeasured: 0, reasons: {} };
  const p: PickupCoverage = { n: 0, withCall: 0, fromPickup: 0, noRequest: 0, gps: 0, app: 0, unmeasured: 0, reasons: {} };
  for (const r of rows) {
    if (rowCounts(r, "entrega")) {
      d.n++;
      if (r.startSource === "chamada") d.withCall++; else if (r.startSource === "pendente") d.fromPending++; else d.noRequest++;
      if (r.transitStatus === "medido" && r.arrivedSource === "botao") d.button++;
      else if (r.transitStatus === "medido" && String(r.arrivedSource ?? "").startsWith("gps")) d.gps++;
      else { d.unmeasured++; if (r.transitStatus !== "medido") bump(d.reasons, r.transitStatus); }
    } else if (rowCounts(r, "recolha")) {
      p.n++;
      if (r.startSource === "chamada") p.withCall++; else if (r.startSource === "em_recolha") p.fromPickup++; else p.noRequest++;
      if (r.terminalStatus === "medido" && r.terminalExitSource === "gps") p.gps++;
      else if (r.terminalStatus === "medido" && r.terminalExitSource === "app_inicio_movimento") p.app++;
      else { p.unmeasured++; if (r.terminalStatus !== "medido") bump(p.reasons, r.terminalStatus); }
    }
  }
  return { deliveries: d, pickups: p };
}

// ─── Resumo de um dia (P8) ──────────────────────────────────────────────────

/** Uma entrega da lista das mais lentas (os tempos com GPS só com o portão aberto). */
export interface SlowDeliveryItem {
  bookingId: string;
  bookingCode: string | null;
  cityKey: string | null;
  terminalClass: string | null;
  /** UTC "YYYY-MM-DD HH:MM:SS" (o "o que se passava nesse horário" lê-os). */
  pendingAt: string | null;
  deliveredAt: string | null;
  queueMs: number | null;
  transitMs: number | null;
  customerMs: number | null;
  ourMs: number | null;
  totalMs: number | null;
  /** O condutor do Trânsito (quem pegou no carro). */
  driverEmployeeId: number | null;
}
export interface LongPickupItem {
  bookingId: string;
  bookingCode: string | null;
  cityKey: string | null;
  terminalClass: string | null;
  checkInAt: string | null;
  terminalMs: number | null;
  p2Ms: number | null;
  firstGarage: string | null;
  parkedGarage: string | null;
  driverEmployeeId: number | null;
}

export interface DayTimesView {
  targetMinutes: number;
  deliveries: { n: number; cancelled: number; metrics: Record<(typeof DELIVERY_METRICS)[number], MetricView>; inTarget: ReturnType<typeof inTargetView>; coverage: DeliveryCoverage; slowest: SlowDeliveryItem[]; slowestBy: "nosso" | "fila" };
  pickups: { n: number; cancelled: number; metrics: Record<(typeof PICKUP_METRICS)[number], MetricView>; t2: ReturnType<typeof t2View>; coverage: PickupCoverage; longest: LongPickupItem[] };
  /** Algum tempo com GPS veio só porque é super admin (portão fechado). */
  provisional: boolean;
}

const utcText = (ms: number | null | undefined) => (ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString().slice(0, 19).replace("T", " "));

/** Total no Resumo do dia: até 600 min (o mesmo limite de sempre dos cartões). */
export const DAY_TOTAL_MAX_MIN = 600;

/**
 * O Resumo do dia (entregas da tarde e recolhas da manhã): cada tempo com a
 * cobertura, a % na meta, as atrasadas no T2, as entregas mais lentas (pelo
 * Nosso; com o portão fechado, pela Fila) e as recolhas que ficaram mais tempo
 * no terminal ou no P2. O portão aplica-se aqui: com ele fechado, quem não é
 * super admin não recebe nenhum tempo com GPS (nem nas listas). PURA.
 */
export function dayTimesView(rows: readonly ServiceRow[], o: { targetMinutes: number; gate: GateCtx; limit?: number }): DayTimesView {
  const g = o.gate;
  const opt = { totalMaxMin: DAY_TOTAL_MAX_MIN };
  const limit = o.limit ?? 8;
  const del = rows.filter((r) => r.kind === "entrega" && !r.voidedAt);
  const pick = rows.filter((r) => r.kind === "recolha" && !r.voidedAt);
  const dm = Object.fromEntries(DELIVERY_METRICS.map((m) => [m, metricView(del, m, g, opt)])) as DayTimesView["deliveries"]["metrics"];
  const pm = Object.fromEntries(PICKUP_METRICS.map((m) => [m, metricView(pick, m, g, opt)])) as DayTimesView["pickups"]["metrics"];
  const visTransit = visibleCities(del, "transito", g).cities, visCustomer = visibleCities(del, "cliente", g).cities, visOur = visibleCities(del, "nosso", g).cities;
  const visTerminal = visibleCities(pick, "terminal", g).cities;
  const ourOpen = !dm.nosso.hidden && dm.nosso.measured > 0;
  const by: "nosso" | "fila" = ourOpen ? "nosso" : "fila";
  const slowest = del.filter((r) => rowCounts(r, "entrega") && metricValue(r, by) != null && (by === "fila" || visOur.has(r.cityKey ?? "")))
    .sort((a, b) => metricValue(b, by)! - metricValue(a, by)! || a.bookingId.localeCompare(b.bookingId))
    .slice(0, limit)
    .map((r): SlowDeliveryItem => {
      const city = r.cityKey ?? "";
      return {
        bookingId: r.bookingId, bookingCode: r.bookingCode ?? null, cityKey: r.cityKey ?? null, terminalClass: r.terminalClass ?? null,
        pendingAt: utcText(r.requestAt), deliveredAt: utcText(r.deliveredAt),
        queueMs: metricValue(r, "fila"),
        transitMs: visTransit.has(city) ? metricValue(r, "transito") : null,
        customerMs: visCustomer.has(city) ? metricValue(r, "cliente") : null,
        ourMs: visOur.has(city) ? metricValue(r, "nosso") : null,
        totalMs: metricValue(r, "total", opt),
        driverEmployeeId: r.startEmployeeId ?? null,
      };
    });
  const pickupKey = (r: ServiceRow) => Math.max(visTerminal.has(r.cityKey ?? "") ? metricValue(r, "terminal") ?? 0 : 0, metricValue(r, "p2") ?? 0);
  const longest = pick.filter((r) => rowCounts(r, "recolha") && pickupKey(r) > 0)
    .sort((a, b) => pickupKey(b) - pickupKey(a) || a.bookingId.localeCompare(b.bookingId))
    .slice(0, limit)
    .map((r): LongPickupItem => ({
      bookingId: r.bookingId, bookingCode: r.bookingCode ?? null, cityKey: r.cityKey ?? null, terminalClass: r.terminalClass ?? null,
      checkInAt: utcText(r.checkInAt),
      terminalMs: visTerminal.has(r.cityKey ?? "") ? metricValue(r, "terminal") : null,
      p2Ms: metricValue(r, "p2"), firstGarage: r.firstGarage ?? null, parkedGarage: r.parkedGarage ?? null,
      driverEmployeeId: r.driverEmployeeId ?? null,
    }));
  const cov = coverageOf(rows);
  const inTarget = inTargetView(del, o.targetMinutes, g);
  const t2 = t2View(pick, g);
  const provisional = [...Object.values(dm), ...Object.values(pm)].some((m) => m.note != null) || inTarget.note != null || t2.note != null;
  return {
    targetMinutes: o.targetMinutes,
    deliveries: { n: del.filter((r) => rowCounts(r, "entrega")).length, cancelled: del.filter((r) => r.outcome === "cancelado").length, metrics: dm, inTarget, coverage: cov.deliveries, slowest, slowestBy: by },
    pickups: { n: pick.filter((r) => rowCounts(r, "recolha")).length, cancelled: pick.filter((r) => r.outcome === "cancelado").length, metrics: pm, t2, coverage: cov.pickups, longest },
    provisional,
  };
}

// ─── Equipas dos TL (P8) ────────────────────────────────────────────────────

/**
 * O que cada entrega e recolha leva para as equipas dos TL: a entrega é do
 * condutor do Trânsito (quem pegou no carro) e conta "dentro da meta" pelo
 * Nosso; a recolha é de quem tirou o carro do terminal e só conta atrasada no
 * T2. Com o portão fechado (na cidade da linha) vai sem medida — a contagem
 * fica, os tempos não. PURA.
 */
export function teamActs(rows: readonly ServiceRow[], o: { targetMinutes: number; gate: GateCtx }): {
  deliveries: Array<{ employeeId: number | null; at: number; ourMins: number | null }>;
  pickups: Array<{ employeeId: number | null; at: number; t2: boolean; t2LateMins: number | null }>;
  hidden: string | null;
} {
  const del = rows.filter((r) => rowCounts(r, "entrega"));
  const pick = rows.filter((r) => rowCounts(r, "recolha"));
  const visOur = visibleCities(del, "nosso", o.gate);
  const t2 = t2View(pick, o.gate);
  const t2Open = new Set<string>();
  if (!t2.hidden) for (const r of pick) if (r.terminalClass === "t2") t2Open.add(r.cityKey ?? "");
  return {
    deliveries: del.map((r) => ({
      employeeId: r.startEmployeeId ?? null,
      at: r.startedAt ?? r.deliveredAt ?? r.requestAt ?? 0,
      ourMins: visOur.cities.has(r.cityKey ?? "") && metricValue(r, "nosso") != null ? metricValue(r, "nosso")! / 60_000 : null,
    })),
    pickups: pick.map((r) => ({
      employeeId: r.driverEmployeeId ?? r.checkInEmployeeId ?? null,
      at: r.terminalExitAt ?? r.checkInAt ?? 0,
      t2: r.terminalClass === "t2",
      t2LateMins: r.terminalClass === "t2" && t2Open.has(r.cityKey ?? "") && r.t2Status === "medido" && r.t2LateMs != null ? r.t2LateMs / 60_000 : null,
    })),
    hidden: visOur.hidden,
  };
}

// ─── O dia de um condutor (P8) ──────────────────────────────────────────────

export interface DriverDeliveryTime {
  bookingId: string;
  bookingCode: string | null;
  requestAt: number | null;
  startedAt: number | null;
  deliveredAt: number | null;
  queueMs: number | null;
  queueStatus: string | null;
  /** Os com GPS: null com o portão fechado (ver `gpsHidden`) ou sem medição (ver o estado). */
  transitMs: number | null;
  customerMs: number | null;
  ourMs: number | null;
  /** O estado do Trânsito (o motivo, quando não há medição) — só com o portão aberto. */
  transitStatus: string | null;
  /** A janela do Trânsito (para a velocidade máxima "no Trânsito"), só com o portão aberto. */
  transitWindow: { startMs: number; endMs: number } | null;
  totalMs: number | null;
}
export interface DriverPickupTime {
  bookingId: string;
  bookingCode: string | null;
  checkInAt: number | null;
  terminalMs: number | null;
  terminalStatus: string | null;
  firstGarage: string | null;
  p2Ms: number | null;
  p2Status: string | null;
  parkedGarage: string | null;
}

/**
 * O dia de UM condutor: cada entrega que ele COMEÇOU (pegou no carro: Fila,
 * Trânsito, Cliente, Nosso, Total) e cada recolha que ele TIROU do terminal
 * (terminal, destino, P2). Sem médias aqui (as médias por condutor estão em
 * Condutores e agentes). O portão aplica-se pela cobertura da cidade no dia
 * (`dayRows` = todas as linhas do dia no âmbito). PURA.
 */
export function driverDayTimes(dayRows: readonly ServiceRow[], employeeId: number, o: { gate: GateCtx }): { deliveries: DriverDeliveryTime[]; pickups: DriverPickupTime[]; gpsHidden: string | null; gpsNote: string | null } {
  const del = dayRows.filter((r) => rowCounts(r, "entrega"));
  const pick = dayRows.filter((r) => rowCounts(r, "recolha"));
  const vT = visibleCities(del, "transito", o.gate), vC = visibleCities(del, "cliente", o.gate), vO = visibleCities(del, "nosso", o.gate), vX = visibleCities(pick, "terminal", o.gate);
  // a entrega é de quem pegou no carro (quem só despachou não conta: DRIVER_METRICS.fila.employee)
  const deliveries = del.filter((r) => DRIVER_METRICS.fila.employee(r) === employeeId)
    .sort((a, b) => (a.startedAt ?? a.deliveredAt ?? 0) - (b.startedAt ?? b.deliveredAt ?? 0))
    .map((r): DriverDeliveryTime => {
      const c = r.cityKey ?? "";
      const tOpen = vT.cities.has(c);
      return {
        bookingId: r.bookingId, bookingCode: r.bookingCode ?? null, requestAt: r.requestAt ?? null, startedAt: r.startedAt ?? null, deliveredAt: r.deliveredAt ?? null,
        queueMs: metricValue(r, "fila"), queueStatus: r.queueStatus ?? null,
        transitMs: tOpen ? metricValue(r, "transito") : null,
        customerMs: vC.cities.has(c) ? metricValue(r, "cliente") : null,
        ourMs: vO.cities.has(c) ? metricValue(r, "nosso") : null,
        transitStatus: tOpen ? r.transitStatus ?? null : null,
        transitWindow: tOpen && r.transitStatus === "medido" && r.startedAt != null && r.arrivedAt != null && r.arrivedAt > r.startedAt ? { startMs: r.startedAt, endMs: r.arrivedAt } : null,
        totalMs: metricValue(r, "total", { totalMaxMin: DAY_TOTAL_MAX_MIN }),
      };
    });
  const pickups = pick.filter((r) => r.driverEmployeeId === employeeId)
    .sort((a, b) => (a.checkInAt ?? 0) - (b.checkInAt ?? 0))
    .map((r): DriverPickupTime => {
      const open = vX.cities.has(r.cityKey ?? "");
      return {
        bookingId: r.bookingId, bookingCode: r.bookingCode ?? null, checkInAt: r.checkInAt ?? null,
        terminalMs: open ? metricValue(r, "terminal") : null, terminalStatus: open ? r.terminalStatus ?? null : null,
        firstGarage: r.firstGarage ?? null, p2Ms: metricValue(r, "p2"), p2Status: r.p2Status ?? null, parkedGarage: r.parkedGarage ?? null,
      };
    });
  const hidden = vT.hidden ?? vX.hidden;
  return { deliveries, pickups, gpsHidden: deliveries.length || pickups.length ? hidden : null, gpsNote: vT.note ?? vX.note };
}

// ─── Grelhas (P9): Pressão (dia da semana × hora) e Semana (dia × hora) ─────

/** Amostra mínima de uma célula (a mesma da Pressão: shared/extrasPressure.ts → MIN_SAMPLE). */
export const GRID_MIN_SAMPLE = 5;
/** Total na Pressão e na Semana: até 240 min (o limite das entregas da Pressão). */
export const GRID_TOTAL_MAX_MIN = 240;

export interface CellStat { n: number; p50Ms: number; p75Ms: number; meanMs: number }
export interface GridCell {
  deliveries: number;
  pickups: number;
  /** Só os tempos com amostra (≥ mínimo) e com o portão aberto. */
  m: Partial<Record<TimeMetric, CellStat>>;
  /** % na meta (nosso tempo ≤ meta), com amostra. */
  inTarget?: { n: number; pct: number };
  /** % de recolhas T2 atrasadas, com amostra. */
  t2Late?: { n: number; pct: number };
}
export interface TimesGrid {
  cells: Record<string, GridCell>;
  /** Por tempo: o texto do portão (escondido em todas as células) e a nota do super admin. */
  hidden: Partial<Record<TimeMetric | "meta" | "t2", string>>;
  notes: Partial<Record<TimeMetric | "meta" | "t2", string>>;
  /** Cobertura (% medidos) de cada tempo no período inteiro — sempre visível. */
  coverage: Partial<Record<TimeMetric, number | null>>;
  deliveries: number;
  pickups: number;
}

/**
 * Agrega as linhas por célula (`keyOf`; null = fora) com o portão aplicado
 * por cidade ao PERÍODO inteiro (o do ecrã) e o mínimo de casos por célula.
 * Percentis iguais ao percentile_cont. PURA.
 */
export function timesGrid(rows: readonly ServiceRow[], keyOf: (r: ServiceRow) => string | null, o: { gate: GateCtx; targetMinutes: number; totalMaxMin?: number; minSample?: number; metrics?: readonly TimeMetric[] }): TimesGrid {
  const metrics = o.metrics ?? [...DELIVERY_METRICS, ...PICKUP_METRICS];
  const minN = o.minSample ?? GRID_MIN_SAMPLE;
  const opt = { totalMaxMin: o.totalMaxMin ?? GRID_TOTAL_MAX_MIN };
  const vis = new Map<TimeMetric, ReturnType<typeof visibleCities>>();
  const hidden: TimesGrid["hidden"] = {}, notes: TimesGrid["notes"] = {}, coverage: TimesGrid["coverage"] = {};
  for (const m of metrics) {
    const v = visibleCities(rows, m, o.gate, opt);
    vis.set(m, v);
    if (v.hidden) hidden[m] = v.hidden;
    if (v.note) notes[m] = v.note;
    coverage[m] = metricView(rows, m, { gate: { visible: true, minCoveragePct: 0, minN: 1 }, isSuperAdmin: true }, opt).coveragePct;
  }
  const meta = inTargetView(rows, o.targetMinutes, o.gate);
  if (meta.hidden) hidden.meta = meta.hidden;
  if (meta.note) notes.meta = meta.note;
  const t2 = t2View(rows, o.gate);
  if (t2.hidden) hidden.t2 = t2.hidden;
  if (t2.note) notes.t2 = t2.note;
  const nossoOpen = vis.get("nosso")?.cities ?? visibleCities(rows, "nosso", o.gate).cities;

  type Acc = { d: number; p: number; v: Map<TimeMetric, number[]>; meta: { n: number; ok: number }; t2: { n: number; late: number } };
  const acc = new Map<string, Acc>();
  let deliveries = 0, pickups = 0;
  for (const r of rows) {
    const isD = rowCounts(r, "entrega"), isP = rowCounts(r, "recolha");
    if (!isD && !isP) continue;
    if (isD) deliveries++; else pickups++;
    const k = keyOf(r);
    if (k == null) continue;
    let a = acc.get(k);
    if (!a) { a = { d: 0, p: 0, v: new Map(), meta: { n: 0, ok: 0 }, t2: { n: 0, late: 0 } }; acc.set(k, a); }
    if (isD) a.d++; else a.p++;
    const city = r.cityKey ?? "";
    for (const m of metrics) {
      if (TIME_METRICS[m].kind !== r.kind || !vis.get(m)!.cities.has(city)) continue;
      const val = metricValue(r, m, opt);
      if (val == null) continue;
      const l = a.v.get(m) ?? [];
      l.push(val);
      a.v.set(m, l);
    }
    if (isD && !meta.hidden && nossoOpen.has(city)) {
      const w = withinTarget({ ourMs: r.ourMs ?? null, ourStatus: r.ourStatus ?? "" }, o.targetMinutes);
      if (w != null) { a.meta.n++; if (w) a.meta.ok++; }
    }
    if (isP && !t2.hidden && r.terminalClass === "t2" && r.t2Status === "medido" && r.t2LateMs != null) { a.t2.n++; if (r.t2LateMs > 0) a.t2.late++; }
  }
  const cells: Record<string, GridCell> = {};
  for (const [k, a] of acc) {
    const m: GridCell["m"] = {};
    for (const [metric, vals] of a.v) {
      if (vals.length < minN) continue;
      const s = timeStats(vals);
      m[metric] = { n: s.n, p50Ms: s.p50Ms!, p75Ms: s.p75Ms!, meanMs: s.meanMs! };
    }
    cells[k] = {
      deliveries: a.d, pickups: a.p, m,
      ...(a.meta.n >= minN ? { inTarget: { n: a.meta.n, pct: Math.round((a.meta.ok / a.meta.n) * 1000) / 10 } } : {}),
      ...(a.t2.n >= minN ? { t2Late: { n: a.t2.n, pct: Math.round((a.t2.late / a.t2.n) * 1000) / 10 } } : {}),
    };
  }
  return { cells, hidden, notes, coverage, deliveries, pickups };
}

/** (dia operacional, hora de Lisboa) → dia da semana ISO do dia de CALENDÁRIO dessa hora (00–02h = dia seguinte). PURA. */
export function calendarWeekdayOf(opDay: string, hour: number): number {
  const d = new Date(`${opDay}T12:00:00Z`);
  if (hour < 3) d.setUTCDate(d.getUTCDate() + 1);
  return d.getUTCDay() || 7;
}

/** Célula da Pressão ("dia da semana:hora") de uma linha (sem hora → fora). PURA. */
export const pressureCellKey = (r: ServiceRow): string | null => (r.refHour == null ? null : `${calendarWeekdayOf(r.opDay, r.refHour)}:${r.refHour}`);
/** Célula da Semana ("dia operacional|hora"). PURA. */
export const weekCellKey = (r: ServiceRow): string | null => (r.refHour == null ? null : `${r.opDay}|${r.refHour}`);

/**
 * A Fila por célula da Pressão para a "hora apertada" (extras.tightUsesQueue):
 * p75 em MINUTOS e n, e se a cobertura da Fila no grupo chega (≥ 60 %). PURA.
 */
export function queueCellsOf(grid: TimesGrid, minCoveragePct = 60): { ok: boolean; coveragePct: number | null; cells: Record<string, { n: number; p75: number | null }> } {
  const cov = grid.coverage.fila ?? null;
  const cells: Record<string, { n: number; p75: number | null }> = {};
  for (const [k, c] of Object.entries(grid.cells)) {
    const f = c.m.fila;
    if (f) cells[k] = { n: f.n, p75: Math.round((f.p75Ms / 60_000) * 10) / 10 };
  }
  return { ok: cov != null && cov >= minCoveragePct && Object.keys(cells).length > 0, coveragePct: cov, cells };
}
