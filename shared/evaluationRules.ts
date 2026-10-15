/**
 * REGRAS da avaliação (individual e operacional) — o ÚNICO sítio com pontos.
 *
 * Regras definidas pelo dono (24 set 2026):
 *   +2   por cada movimento entre parques
 *   +3   por cada recolha ou entrega
 *   +5   pelo 1.º movimento depois de uma recolha (levar o carro ao parque) —
 *        SUBSTITUI os +2 desse movimento, não soma
 *   −10  por cada excesso de velocidade
 *   −5   por cada atraso ao trabalho: entrada no ponto 5 min ou mais depois
 *        da hora da escala ou do horário fixo do RH (máx. 1 por dia — Jorge,
 *        14 out 2026; ≥ 5 min e para todos os que têm horário desde a tarefa 62)
 *   +1   por cada mudança de lugar (mesma garagem; não é movimento — 14 out 2026)
 *   −20  por cada reclamação confirmada
 *   −6000 por cada acidente (D15, Jorge 3 out: era −600) — ocorrência da app
 *        Multipark que um team leader (ou acima) confirmou como acidente e
 *        disse quem conduzia (server/evaluationAccidents.ts). Só a partir de
 *        ACCIDENTS_FROM_DAY: os acidentes antigos não contam (Jorge, 3 out)
 * A "entrega atrasada" (−5) saiu na tarefa 62 (D5): os tempos das entregas e
 * das recolhas são da organização, não de cada pessoa.
 * Os totais podem ser negativos. A normalização por hora é uma vista
 * secundária (não entra na pontuação).
 *
 * Mudar um número aqui muda as duas páginas e o recálculo diário (os dias
 * guardados atualizam-se no recálculo seguinte — o cron refaz o último mês).
 * ATENÇÃO (fecho mensal, shared/evaluationClose.ts): a pontuação calcula-se ao
 * ler, por isso, depois do 1.º mês fechado, uma mudança aqui tem de dizer a
 * partir de que dia vale (como o withAccidentCutoff) — senão muda meses pagos.
 *
 * Tudo PURO (sem BD): usado no servidor (motor + routers) e no cliente
 * (legenda, rótulos, detalhe). Testado em server/evaluationRules.test.ts.
 */

// ─── Pontos (configuráveis) ──────────────────────────────────────────────────

export const EVALUATION_POINTS = {
  /** Movimento entre parques (MOVEMENT com garagem de origem ≠ destino — shared/multiparkMovements.ts). */
  movement: 2,
  /** Mudança de lugar: MOVEMENT na mesma garagem (Jorge, 14 out 2026: "só conta como mudança de lugar"). */
  spotChange: 1,
  /** Recolha (CHECK_IN) ou entrega (CHECK_OUT). */
  pickupOrDelivery: 3,
  /** 1.º movimento depois de uma recolha, na mesma reserva (substitui `movement`). */
  firstMoveAfterPickup: 5,
  /** Excesso de velocidade (speed_alerts do colaborador + penalização RH "velocidade" confirmada). */
  speeding: -10,
  /**
   * Atraso ao trabalho: entrada no ponto LATE_ARRIVAL_FROM_MINUTES ou mais depois da hora da
   * escala (Extras-Dia) ou do horário fixo (RH) — no máximo MAX_LATE_ARRIVALS_PER_DAY por dia.
   */
  delay: -5,
  /** Reclamação confirmada (com pontos aplicados) em que o colaborador foi associado. */
  confirmedComplaint: -20,
  /** Acidente confirmado pelo TL (ocorrência Multipark), a partir de ACCIDENTS_FROM_DAY. D15: −6000. */
  accidentOrDamage: -6000,
} as const;

/**
 * Os acidentes só contam a partir deste dia operacional (Jorge, 3 out 2026:
 * "os acidentes antigos não contam, só a partir de agora"). Antes dele a
 * métrica `accidents` fica a 0 — também nos ajustes e nos dias já guardados.
 */
export const ACCIDENTS_FROM_DAY = "2026-10-03";

/** Métricas de um dia com a regra dos acidentes antigos aplicada. PURA. */
export function withAccidentCutoff<M extends { accidents: number }>(day: string, m: M): M {
  return day < ACCIDENTS_FROM_DAY && m.accidents !== 0 ? { ...m, accidents: 0 } : m;
}

/**
 * Atraso ao trabalho (tarefa 62, D4): conta a partir de 5 minutos INTEIROS
 * depois da hora da escala — floor((entrada − hora) / 60 s) ≥ 5: 03:04:59
 * numa escala das 03:00 não é atraso; 03:05:00 já é (−5); 03:10 também.
 * Substitui a antiga tolerância de 0 min.
 */
export const LATE_ARRIVAL_FROM_MINUTES = 5;

/** Atrasos ao trabalho que contam por pessoa e dia operacional (Jorge, 14 out 2026: "no máximo 1 por dia"). */
export const MAX_LATE_ARRIVALS_PER_DAY = 1;

/**
 * Versão das regras com que um dia foi calculado (employee_day_metrics.rulesVersion, 0670).
 * 1 = antes de 14 out 2026 (inícios de movimento contados, entregas pelo pedido + 15 min, atrasos à entrada sem limite por dia);
 * 2 = regras de 14 out 2026;
 * 3 = tarefa 62: atraso ao trabalho só a partir de 5 min e sem a "entrega atrasada".
 * Dias com versão menor mostram o aviso "calculados com as regras antigas — Recalcular".
 */
export const EVALUATION_RULES_VERSION = 3;

/**
 * Métricas de regras retiradas (tarefa 62): as colunas ficam (nunca se apagam
 * dados), a 0 nos dias novos; já não se ajustam nem se contestam e os ajustes
 * antigos ficam guardados, sem efeito na pontuação.
 */
export const RETIRED_METRICS: readonly MetricKey[] = ["lateServices", "deliveriesWithoutSchedule"];
export const isRetiredMetric = (k: string | null | undefined): boolean => !!k && (RETIRED_METRICS as readonly string[]).includes(k);

/** Tipos de ocorrência (incidents.incidentType) que contam como acidente/dano/risco. */
export const DAMAGE_INCIDENT_TYPES: readonly string[] = ["dano"];

/**
 * Ocorrência da app Multipark que PARECE um acidente (tipo ou notas). Só serve
 * para destacar o pedido de confirmação ao TL — o que conta é a confirmação. PURA.
 */
export function looksLikeAccident(o: { title?: string | null; remarks?: string | null }): boolean {
  return /acidente|sinistro|colis[aã]o|colidiu|embat|bateu|choque|capot|amolgad|risco|riscad|dano/i.test(`${o.title ?? ""} ${o.remarks ?? ""}`);
}

/** Posições que entram no ranking individual (como até aqui). */
export const RANKING_POSITIONS = ["driver", "senior_driver", "extra"] as const;

/** Dias recalculados todos os dias pelo cron: o último mês (42a, Jorge: "um mês em vez de 4 semanas"). */
export const RECOMPUTE_WINDOW_DAYS = 31;

// ─── Métricas de um dia ──────────────────────────────────────────────────────

/** Categoria de uma ação pelo changeType (recolha = CHECK_IN, entrega = CHECK_OUT). */
export type ActionCategory = "recolhas" | "entregas" | "movements" | "cancels" | "otherActions";
const ACTION_CATEGORY: Record<string, ActionCategory> = {
  CHECK_IN: "recolhas", CHECKIN: "recolhas",
  CHECK_OUT: "entregas", CHECKOUT: "entregas",
  MOVEMENT: "movements", MOVE: "movements",
  CANCELLATION: "cancels", CANCEL: "cancels", CANCELLED: "cancels",
};
export function actionCategory(changeType: string | null | undefined): ActionCategory {
  return ACTION_CATEGORY[String(changeType ?? "").trim().toUpperCase()] ?? "otherActions";
}

/** Métricas numéricas de um colaborador num dia operacional (03h→03h Lisboa). */
export interface DayMetrics {
  /** Horas do ponto que contam (ok/aprovado) — os [SUSPEITO] ficam de fora. */
  hoursWorked: number;
  /** Horas de ponto excluídas (suspeitas/rejeitadas, por rever). */
  suspiciousHours: number;
  /** Horas da escala (extras-dia). */
  scheduledHours: number;
  /** Registos de ponto (entradas + saídas) do dia. */
  pontoEvents: number;
  cost: number;
  actions: number;
  actionsMorning: number;
  actionsNight: number;
  recolhas: number;
  entregas: number;
  /** Todos os movimentos (inclui os `parkingMoves`). */
  movements: number;
  /** Movimentos que foram o 1.º depois de uma recolha (levar ao parque). */
  parkingMoves: number;
  /** Mudanças de lugar (MOVEMENT na mesma garagem) — NÃO entram em `movements`. */
  spotChanges: number;
  cancels: number;
  otherActions: number;
  /** Pontos das ações (movimentos + recolhas/entregas + levar ao parque). */
  weightedActions: number;
  speedingEvents: number;
  /**
   * Atrasos. Desde a tarefa 62 só os atrasos ao trabalho (entrada no ponto
   * ≥ 5 min depois da hora da escala, máx. 1 por dia). Nos dias antigos ainda
   * incluem as entregas atrasadas: os atrasos ao trabalho são SEMPRE
   * `lateArrivalsOf` (delays − lateServices) — nunca mostrar o `delays` em bruto.
   */
  delays: number;
  /** Regra retirada (tarefa 62): parte dos `delays` que eram entregas atrasadas (só nos dias antigos; 0 nos novos). */
  lateServices: number;
  /** Regra retirada (tarefa 62): entregas sem hora marcada legível (só nos dias antigos; 0 nos novos). */
  deliveriesWithoutSchedule: number;
  complaints: number;
  accidents: number;
  /** Informativo (não pontua): ocorrências reportadas pelo colaborador. */
  incidentsReported: number;
  /** Informativo (não pontua): ocorrências atribuídas com envolvimento confirmado. */
  incidentsAgainst: number;
  /** Informativo (não pontua): pontos de penalização RH confirmados. */
  penaltyPoints: number;
  /** Pontos dados/tirados diretamente por ajuste manual (0 no cálculo). */
  bonusPoints: number;
}

export type MetricKey = keyof DayMetrics;

export const METRIC_KEYS: MetricKey[] = [
  "hoursWorked", "suspiciousHours", "scheduledHours", "pontoEvents", "cost",
  "actions", "actionsMorning", "actionsNight", "recolhas", "entregas", "movements", "parkingMoves", "spotChanges", "cancels", "otherActions",
  "weightedActions", "speedingEvents", "delays", "lateServices", "deliveriesWithoutSchedule", "complaints", "accidents",
  "incidentsReported", "incidentsAgainst", "penaltyPoints", "bonusPoints",
];

/** Rótulos PT-PT (UI, ajustes e contestações). */
export const METRIC_LABELS: Record<MetricKey, string> = {
  hoursWorked: "Horas (ponto)",
  suspiciousHours: "Horas suspeitas (excluídas)",
  scheduledHours: "Horas escaladas",
  pontoEvents: "Registos de ponto",
  cost: "Custo",
  actions: "Ações",
  actionsMorning: "Ações manhã (03h–15h)",
  actionsNight: "Ações noite (15h–03h)",
  recolhas: "Recolhas",
  entregas: "Entregas",
  movements: "Movimentos (levar ao parque + entre parques)",
  parkingMoves: "Levar ao parque (1.º movimento após recolha)",
  spotChanges: "Mudanças de lugar (mesma garagem)",
  cancels: "Cancelamentos",
  otherActions: "Outras ações",
  weightedActions: "Pontos das ações",
  speedingEvents: "Excessos de velocidade",
  delays: "Atrasos ao trabalho",
  lateServices: "Entregas atrasadas (regra antiga)",
  deliveriesWithoutSchedule: "Entregas sem hora marcada (regra antiga)",
  complaints: "Reclamações confirmadas",
  accidents: "Acidentes / danos",
  incidentsReported: "Ocorrências que registou",
  incidentsAgainst: "Ocorrências atribuídas",
  penaltyPoints: "Pontos de penalização (RH)",
  bonusPoints: "Pontos (ajuste direto)",
};

/** Métricas que um gestor pode ajustar à mão (as derivadas recalculam-se). */
export const ADJUSTABLE_METRICS: MetricKey[] = [
  "bonusPoints", "recolhas", "entregas", "movements", "parkingMoves", "spotChanges",
  "speedingEvents", "delays", "complaints", "accidents", "hoursWorked",
];

export function emptyDayMetrics(): DayMetrics {
  const m = {} as DayMetrics;
  for (const k of METRIC_KEYS) (m as any)[k] = 0;
  return m;
}

export function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

// ─── Pontuação ───────────────────────────────────────────────────────────────

export type RuleKey = "movement" | "spotChange" | "pickupOrDelivery" | "firstMoveAfterPickup" | "speeding" | "delay" | "confirmedComplaint" | "accidentOrDamage" | "manual";

export interface RuleLine {
  key: RuleKey;
  label: string;
  /** pontos por unidade */
  points: number;
  count: number;
  subtotal: number;
}

/** Regras, pela ordem da legenda. `count` lê as métricas do dia (ou da soma). */
export const EVALUATION_RULES: Array<{ key: Exclude<RuleKey, "manual">; label: string; count: (m: DayMetrics) => number }> = [
  { key: "movement", label: "Movimento entre parques", count: (m) => Math.max(0, m.movements - m.parkingMoves) },
  { key: "spotChange", label: "Mudança de lugar (mesma garagem)", count: (m) => m.spotChanges ?? 0 },
  { key: "pickupOrDelivery", label: "Recolha ou entrega", count: (m) => m.recolhas + m.entregas },
  { key: "firstMoveAfterPickup", label: "1.º movimento após recolha (levar ao parque)", count: (m) => m.parkingMoves },
  { key: "speeding", label: "Excesso de velocidade", count: (m) => m.speedingEvents },
  { key: "delay", label: "Atraso ao trabalho (≥ 5 min)", count: (m) => lateArrivalsOf(m) },
  { key: "confirmedComplaint", label: "Reclamação confirmada", count: (m) => m.complaints },
  { key: "accidentOrDamage", label: "Acidente ou dano/risco", count: (m) => m.accidents },
];

/**
 * Atrasos ao trabalho de um dia (ou soma): todos os atrasos menos as entregas
 * atrasadas (que só existem nos dias antigos). É o número a mostrar em todo o
 * lado (ecrã, CSV, Sheets, assistente, Desempenho). PURA.
 */
export function lateArrivalsOf(m: Pick<DayMetrics, "delays" | "lateServices">): number {
  return Math.max(0, round2(m.delays - m.lateServices));
}

/** Pontos das ações (a "ação ponderada" do operacional). */
export function actionPoints(m: Pick<DayMetrics, "movements" | "parkingMoves" | "recolhas" | "entregas"> & { spotChanges?: number }): number {
  const p = EVALUATION_POINTS;
  const plainMoves = Math.max(0, m.movements - m.parkingMoves);
  return round2(plainMoves * p.movement + (m.spotChanges ?? 0) * p.spotChange + m.parkingMoves * p.firstMoveAfterPickup + (m.recolhas + m.entregas) * p.pickupOrDelivery);
}

export interface Score {
  positivePoints: number;
  negativePoints: number;
  totalPoints: number;
  lines: RuleLine[];
}

/** Pontuação de um dia (ou de uma soma de dias — é linear), com a linha de cada regra. */
export function scoreOf(m: DayMetrics): Score {
  const lines: RuleLine[] = EVALUATION_RULES.map((r) => {
    const count = round2(r.count(m));
    const points = EVALUATION_POINTS[r.key];
    return { key: r.key, label: r.label, points, count, subtotal: round2(count * points) };
  });
  if (m.bonusPoints) lines.push({ key: "manual", label: "Ajuste manual de pontos", points: 1, count: round2(m.bonusPoints), subtotal: round2(m.bonusPoints) });
  let positivePoints = 0, negativePoints = 0;
  for (const l of lines) {
    if (l.subtotal >= 0) positivePoints += l.subtotal; else negativePoints += -l.subtotal;
  }
  positivePoints = round2(positivePoints);
  negativePoints = round2(negativePoints);
  return { positivePoints, negativePoints, totalPoints: round2(positivePoints - negativePoints), lines };
}

// ─── Normalização por hora (vista secundária) ────────────────────────────────

/** Valor por hora trabalhada (null quando não há horas — não é zero). */
export function perHour(value: number, hours: number): number | null {
  return hours > 0 ? round2(value / hours) : null;
}

/** Horas usadas na normalização: ponto; sem ponto, as da escala. */
export function normalisationHours(m: Pick<DayMetrics, "hoursWorked" | "scheduledHours">): number {
  return m.hoursWorked > 0 ? m.hoursWorked : m.scheduledHours;
}

export interface PerHourMetrics {
  hours: number;
  actionsPerHour: number | null;
  weightedPerHour: number | null;
  pointsPerHour: number | null;
}

export function perHourMetrics(m: DayMetrics, score: Pick<Score, "totalPoints"> = scoreOf(m)): PerHourMetrics {
  const hours = normalisationHours(m);
  return {
    hours: round2(hours),
    actionsPerHour: perHour(m.actions, hours),
    weightedPerHour: perHour(m.weightedActions, hours),
    pointsPerHour: perHour(score.totalPoints, hours),
  };
}

// ─── Ajustes manuais ─────────────────────────────────────────────────────────

export interface AdjustmentLike { metric: string; delta: number | string; voidedAt?: string | null }

const NON_NEGATIVE = new Set<MetricKey>(METRIC_KEYS.filter((k) => k !== "bonusPoints"));
const ACTION_PARTS: MetricKey[] = ["recolhas", "entregas", "movements", "cancels", "otherActions"];

/**
 * Aplica ajustes (deltas) sobre as métricas CALCULADAS, sem as alterar:
 * devolve uma cópia. Ajustes anulados e métricas desconhecidas são
 * ignorados. Ajustar uma parte das ações acerta o total; os pontos das ações
 * recalculam-se. "Levar ao parque" nunca passa o nº de movimentos. Só os
 * pontos diretos (`bonusPoints`) podem ficar negativos.
 */
export function applyAdjustments(base: DayMetrics, adjustments: AdjustmentLike[]): DayMetrics {
  const out: DayMetrics = { ...base };
  let touchedActions = false;
  for (const a of adjustments) {
    if (a.voidedAt) continue;
    const key = a.metric as MetricKey;
    if (!METRIC_KEYS.includes(key)) continue;
    const delta = Number(a.delta);
    if (!Number.isFinite(delta) || delta === 0) continue;
    // as entregas atrasadas fazem parte do total dos atrasos: o ajuste nunca passa abaixo de 0 entregas,
    // para não apagar atrasos à entrada (delays − lateServices fica igual). Tarefa 62: a regra saiu e
    // `lateServices` já não se ajusta; este ramo só trata os ajustes antigos (sem efeito na pontuação).
    const d = key === "lateServices" ? Math.max(delta, -out.lateServices) : delta;
    out[key] = round2(out[key] + d);
    if (ACTION_PARTS.includes(key)) out.actions = round2(out.actions + d);
    if (key === "lateServices") out.delays = round2(out.delays + d);
    if (ACTION_PARTS.includes(key) || key === "parkingMoves" || key === "spotChanges") touchedActions = true;
  }
  for (const k of NON_NEGATIVE) if (out[k] < 0) out[k] = 0;
  if (out.parkingMoves > out.movements) out.parkingMoves = out.movements;
  if (out.lateServices > out.delays) out.lateServices = out.delays;
  if (touchedActions) out.weightedActions = actionPoints(out);
  return out;
}

/** Soma de vários dias (métricas já ajustadas). */
export function sumMetrics(days: DayMetrics[]): DayMetrics {
  const out = emptyDayMetrics();
  for (const d of days) for (const k of METRIC_KEYS) out[k] = round2(out[k] + (Number(d[k]) || 0));
  return out;
}

// ─── Contestações ────────────────────────────────────────────────────────────

export const DISPUTE_STATUSES = ["open", "accepted", "rejected"] as const;
export type DisputeStatus = typeof DISPUTE_STATUSES[number];
export const DISPUTE_STATUS_LABELS: Record<DisputeStatus, string> = {
  open: "Em análise",
  accepted: "Aceite",
  rejected: "Recusada",
};
