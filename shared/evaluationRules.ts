/**
 * REGRAS da avaliação (individual e operacional) — o ÚNICO sítio com pontos.
 *
 * Regras definidas pelo dono (24 set 2026):
 *   +2   por cada movimento entre parques
 *   +3   por cada recolha ou entrega
 *   +5   pelo 1.º movimento depois de uma recolha (levar o carro ao parque) —
 *        SUBSTITUI os +2 desse movimento, não soma
 *   −10  por cada excesso de velocidade
 *   −5   por cada atraso
 *   −20  por cada reclamação confirmada
 *   −600 por cada acidente ou dano/risco
 * Os totais podem ser negativos. A normalização por hora é uma vista
 * secundária (não entra na pontuação).
 *
 * Mudar um número aqui muda as duas páginas e o recálculo diário (os dias
 * guardados atualizam-se no recálculo seguinte — o cron refaz 4 semanas).
 *
 * Tudo PURO (sem BD): usado no servidor (motor + routers) e no cliente
 * (legenda, rótulos, detalhe). Testado em server/evaluationRules.test.ts.
 */

// ─── Pontos (configuráveis) ──────────────────────────────────────────────────

export const EVALUATION_POINTS = {
  /** Movimento entre parques (changeType MOVEMENT). */
  movement: 2,
  /** Recolha (CHECK_IN) ou entrega (CHECK_OUT). */
  pickupOrDelivery: 3,
  /** 1.º movimento depois de uma recolha, na mesma reserva (substitui `movement`). */
  firstMoveAfterPickup: 5,
  /** Excesso de velocidade (speed_alerts do colaborador + penalização RH "velocidade" confirmada). */
  speeding: -10,
  /** Atraso: entrada no ponto depois da hora da escala OU entrega atrasada (serviço). */
  delay: -5,
  /** Reclamação confirmada (com pontos aplicados) em que o colaborador foi associado. */
  confirmedComplaint: -20,
  /** Acidente ou dano/risco (ocorrência com envolvimento confirmado). */
  accidentOrDamage: -600,
} as const;

/** Minutos de tolerância antes de uma entrada contar como atraso (0 = qualquer minuto). */
export const DELAY_TOLERANCE_MINUTES = 0;

/**
 * Serviço atrasado: entrega (CHECK_OUT) feita mais de X minutos depois de o
 * cliente a pedir (PENDING_CHECKOUT), na mesma reserva — a mesma medida do
 * resumo do supervisor ("> 15 min"). Acima de LATE_SERVICE_MAX_MINUTES não é
 * o mesmo pedido (dados incoerentes) e não conta. As recolhas não contam: o
 * atraso aí é quase sempre do voo/cliente, não do condutor.
 */
export const LATE_SERVICE_MINUTES = 15;
export const LATE_SERVICE_MAX_MINUTES = 600;

/** Tipos de ocorrência (incidents.incidentType) que contam como acidente/dano/risco. */
export const DAMAGE_INCIDENT_TYPES: readonly string[] = ["dano"];

/** Posições que entram no ranking individual (como até aqui). */
export const RANKING_POSITIONS = ["driver", "senior_driver", "extra"] as const;

/** Dias recalculados todos os dias pelo cron (4 semanas). */
export const RECOMPUTE_WINDOW_DAYS = 28;

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
  cancels: number;
  otherActions: number;
  /** Pontos das ações (movimentos + recolhas/entregas + levar ao parque). */
  weightedActions: number;
  speedingEvents: number;
  /** Atrasos que pontuam: entradas tardias no ponto + serviços atrasados. */
  delays: number;
  /** Parte dos `delays` que são serviços (entregas) atrasados. */
  lateServices: number;
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
  "actions", "actionsMorning", "actionsNight", "recolhas", "entregas", "movements", "parkingMoves", "cancels", "otherActions",
  "weightedActions", "speedingEvents", "delays", "lateServices", "complaints", "accidents",
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
  movements: "Movimentos",
  parkingMoves: "Levar ao parque (1.º movimento após recolha)",
  cancels: "Cancelamentos",
  otherActions: "Outras ações",
  weightedActions: "Pontos das ações",
  speedingEvents: "Excessos de velocidade",
  delays: "Atrasos (ponto + serviço)",
  lateServices: "Entregas atrasadas (> 15 min)",
  complaints: "Reclamações confirmadas",
  accidents: "Acidentes / danos",
  incidentsReported: "Ocorrências reportadas",
  incidentsAgainst: "Ocorrências atribuídas",
  penaltyPoints: "Pontos de penalização (RH)",
  bonusPoints: "Pontos (ajuste direto)",
};

/** Métricas que um gestor pode ajustar à mão (as derivadas recalculam-se). */
export const ADJUSTABLE_METRICS: MetricKey[] = [
  "bonusPoints", "recolhas", "entregas", "movements", "parkingMoves",
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

export type RuleKey = "movement" | "pickupOrDelivery" | "firstMoveAfterPickup" | "speeding" | "delay" | "confirmedComplaint" | "accidentOrDamage" | "manual";

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
  { key: "pickupOrDelivery", label: "Recolha ou entrega", count: (m) => m.recolhas + m.entregas },
  { key: "firstMoveAfterPickup", label: "1.º movimento após recolha (levar ao parque)", count: (m) => m.parkingMoves },
  { key: "speeding", label: "Excesso de velocidade", count: (m) => m.speedingEvents },
  { key: "delay", label: "Atraso", count: (m) => m.delays },
  { key: "confirmedComplaint", label: "Reclamação confirmada", count: (m) => m.complaints },
  { key: "accidentOrDamage", label: "Acidente ou dano/risco", count: (m) => m.accidents },
];

/** Pontos das ações (a "ação ponderada" do operacional). */
export function actionPoints(m: Pick<DayMetrics, "movements" | "parkingMoves" | "recolhas" | "entregas">): number {
  const p = EVALUATION_POINTS;
  const plainMoves = Math.max(0, m.movements - m.parkingMoves);
  return round2(plainMoves * p.movement + m.parkingMoves * p.firstMoveAfterPickup + (m.recolhas + m.entregas) * p.pickupOrDelivery);
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
    out[key] = round2(out[key] + delta);
    if (ACTION_PARTS.includes(key)) out.actions = round2(out.actions + delta);
    if (ACTION_PARTS.includes(key) || key === "parkingMoves") touchedActions = true;
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
