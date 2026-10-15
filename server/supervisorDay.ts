/**
 * Resumo do dia do supervisor (Passagem de turno → Resumo do dia): condutores
 * por turno, carros recolhidos/entregues, reclamações do dia e, por chefe de
 * turno, o que a equipa dele fez (12 out 2026).
 *
 * 15 out 2026 — os tempos novos (Fila, Trânsito, Cliente, Nosso e a meta; nas
 * recolhas o tempo no terminal, no P2, o cliente e as atrasadas no T2): da
 * tabela dos tempos; sem linhas para o dia, calculados agora com as mesmas
 * regras, sem GPS (server/serviceTimesRead.ts). O PORTÃO dos tempos com GPS
 * aplica-se aqui (server/serviceTimesAgg.ts): quem não é super admin não
 * recebe esses números enquanto ele estiver fechado. A hora marcada já não
 * entra em nenhum tempo.
 *
 * O "dia" é o dia OPERACIONAL de Lisboa: 03:00 → 03:00 do dia seguinte (manhã
 * + noite inteira), convertido para UTC (as colunas são UTC). Tudo dentro das
 * cidades do utilizador (ou da cidade pedida).
 *
 * Saiu de server/db.ts na auditoria do #389 (para os testes o poderem correr
 * pelo procedimento, com o papel de quem pede).
 */
import { and, eq, sql } from "drizzle-orm";
import { extrasDiaAssignments } from "../drizzle/schema";
import { cityNameScope, projectScope, scopedCityNamesLive } from "./cityScope";
import { getDayActivity, getDb } from "./db";
import { operationalDayWindowUtc } from "../shared/shiftHandover";
import { teamLines } from "../shared/shiftDayReview";

/**
 * PRAZO (auditoria do #389, ronda 2). A função da Vercel morre aos 60 s e a
 * pool da Multipark tem DUAS ligações por instância (5 s de espera por uma).
 * Leituras à Multipark neste pedido, por esta ordem:
 *  1. em PARALELO (uma ligação cada): os CHECK_OUT do dia (reclamações dos
 *     carros que saíram) e a Atividade do Dia (getDayActivity →
 *     loadActivityActions, ao vivo) — cada uma até 15 s + 2 s;
 *  2. DEPOIS, com a pool livre: os tempos — a tabela; sem linhas, o cálculo
 *     ao vivo (parques e garagens em paralelo, depois a History), com o prazo
 *     que sobra até SUPERVISOR_DAY_BUDGET_MS (no máximo 35 s, ver
 *     dayServiceRows).
 * Três leituras ao mesmo tempo deixavam o cálculo dos tempos à espera de
 * ligação (CONNECT_FAILED) e "Sem tempos deste dia" nos dias lentos. Pior
 * caso: ≈ 17 s + 31 s, mais as leituras da nossa BD (escala, reclamações,
 * nomes). Os tempos que não chegam a tempo vêm "indisponíveis" (só eles; o
 * resto do resumo vem sempre).
 */
export const SUPERVISOR_DAY_BUDGET_MS = 48_000;

export async function getSupervisorDayDashboard(date: string, opts: { isSuperAdmin?: boolean } = {}) {
  const t0 = Date.now();
  const db = await getDb();
  if (!db) return null;
  const { start, end } = operationalDayWindowUtc(date);

  // A Atividade do Dia começa já, em paralelo com os CHECK_OUT (antes vinha depois dos tempos e podia passar dos 60 s).
  // O erro fica guardado e só se lança quando se espera por ela (nunca uma rejeição sem dono).
  const activityP = getDayActivity(date).then((v) => ({ ok: true as const, v }), (err: unknown) => ({ ok: false as const, err }));

  // Movimentos AO VIVO da BD da Multipark ("History"; a cópia local está congelada desde o #141):
  // só para as reclamações dos carros que saíram — por isso só os CHECK_OUT do dia (15 out 2026: os
  // pendentes e as recolhas já não entram aqui; os tempos vêm da tabela dos tempos ou do cálculo ao vivo).
  const { readLiveHistory } = await import("./multiparkDb/historyLive");
  const HIST_LIMIT = 5000;
  type Hist = Awaited<ReturnType<typeof readLiveHistory>>;
  // a Multipark em baixo não leva o resumo inteiro: só as reclamações dos carros que saíram ficam por contar
  const histP: Promise<{ ok: true; rows: Hist } | { ok: false; error: string }> = readLiveHistory({ changeTypes: ["CHECK_OUT"], from: start, to: end, cities: scopedCityNamesLive(), limit: HIST_LIMIT, order: "asc" })
    .then((rows) => ({ ok: true as const, rows }), (err: any) => ({ ok: false as const, error: String(err?.cause?.message ?? err?.message ?? err).slice(0, 160) }));

  // Tempos (15 out 2026): a tabela; sem linhas, ao vivo (uma leitura por dia, partilhada e com
  // o prazo que sobra deste pedido). O portão no servidor.
  const { dayServiceRows, loadServiceViewSettings, scopedServiceCityKeys, employeeNames } = await import("./serviceTimesRead");
  const { dayTimesView, teamActs } = await import("./serviceTimesAgg");
  // 1.º as duas leituras em paralelo (as duas ligações da pool); 2.º os tempos, com a pool livre
  const [hist, activity, svcSettings] = await Promise.all([histP, activityP, loadServiceViewSettings()]);
  if (!activity.ok) throw activity.err;
  const svc = await dayServiceRows(date, { cityKeys: await scopedServiceCityKeys(), deadlineMs: SUPERVISOR_DAY_BUDGET_MS - (Date.now() - t0) });
  const gate = { gate: svcSettings.gate, isSuperAdmin: !!opts.isSuperAdmin };
  const timesView = dayTimesView(svc.rows, { targetMinutes: svcSettings.targetMinutes, gate });

  // Reclamações criadas no mesmo dia operacional (03h–03h), pela condição única
  // "conta como reclamação" (plano 64, E7): sem as arquivadas nem as convertidas.
  const { countableComplaintSql } = await import("./departedComplaints");
  const [[compl]] = await db.execute(sql`SELECT COUNT(*) n FROM complaints
    WHERE createdAt >= ${start} AND createdAt < ${end} AND ${countableComplaintSql("complaints")}
      AND ${projectScope(sql`complaints.projectId`)}`) as any;
  // 12 out 2026 (Jorge): reclamações dos carros que SAÍRAM neste dia (entrega feita
  // no dia operacional), seja qual for o dia em que chegaram — com o histórico já lido.
  let complaintsDeparted: { available: true; complaints: number; bookings: number; truncated: boolean } | { available: false; reason: string };
  if (!hist.ok) {
    console.warn("[resumo-dia] CHECK_OUT do dia:", hist.error);
    complaintsDeparted = { available: false, reason: "A BD da Multipark não respondeu: as reclamações dos carros que saíram ficam por contar." };
  } else {
    try {
      const { departedFromHistory, departedRefs } = await import("../shared/departedComplaints");
      const { countComplaintsForRefs } = await import("./departedComplaints");
      const left = departedFromHistory(hist.rows, start, end);
      complaintsDeparted = { available: true, complaints: await countComplaintsForRefs(departedRefs(left)), bookings: left.length, truncated: hist.rows.length >= HIST_LIMIT };
    } catch (err: any) {
      console.warn("[resumo-dia] reclamações dos carros que saíram:", String(err?.cause?.message ?? err?.message ?? err).slice(0, 160));
      complaintsDeparted = { available: false, reason: "Não foi possível contar as reclamações dos carros que saíram." };
    }
  }

  // Condutores por turno (escala extras-dia do dia + ações)
  const assignments = await db.select({
    personName: extrasDiaAssignments.personName,
    shift: extrasDiaAssignments.shift,
    city: extrasDiaAssignments.city,
    employeeId: extrasDiaAssignments.employeeId,
    startHour: extrasDiaAssignments.startHour,
    endHour: extrasDiaAssignments.endHour,
    sentHomeHour: extrasDiaAssignments.sentHomeHour,
    isTeamLeader: extrasDiaAssignments.isTeamLeader,
  }).from(extrasDiaAssignments).where(and(eq(extrasDiaAssignments.assignmentDate, date), cityNameScope(extrasDiaAssignments.city)));

  // Equipas por chefe de turno (regra 42c): a entrega é de quem marcou "em entrega" (o
  // condutor que leva o carro), dentro ou fora da meta pelo nosso tempo; a recolha é de quem
  // tirou o carro do terminal (só há atrasadas no T2). Com o portão fechado, sem medida (a
  // contagem fica). Cada ação vai com a ficha E o nome dela: a escala sem ficha ligada
  // (só o nome) também recebe as suas (auditoria do #389).
  const acts = teamActs(svc.rows, { targetMinutes: svcSettings.targetMinutes, gate });
  const names = await employeeNames([
    ...acts.deliveries.map((d) => d.employeeId), ...acts.pickups.map((p) => p.employeeId),
    ...timesView.deliveries.slowest.map((x) => x.driverEmployeeId), ...timesView.pickups.longest.map((x) => x.driverEmployeeId),
  ]);
  const actor = (employeeId: number | null) => ({ employeeId, name: employeeId != null ? names[employeeId] ?? null : null });
  const teams = teamLines(date, assignments.map((a) => ({ ...a, shift: a.shift as "morning" | "night" })), {
    deliveries: acts.deliveries.map((d) => ({ actor: actor(d.employeeId), at: d.at, ourMins: d.ourMins })),
    pickups: acts.pickups.map((p) => ({ actor: actor(p.employeeId), at: p.at, t2: p.t2, t2LateMins: p.t2LateMins })),
  }, { targetMinutes: svcSettings.targetMinutes });
  const listed = new Set([...timesView.deliveries.slowest.map((x) => x.driverEmployeeId), ...timesView.pickups.longest.map((x) => x.driverEmployeeId)]);
  const driverNames = Object.fromEntries(Object.entries(names).filter(([id]) => listed.has(Number(id))));

  const dayActivity = activity.v;

  return {
    date,
    window: { start, end },
    totals: dayActivity.totals,
    people: dayActivity.people,
    gpsMissingDays: dayActivity.gpsMissingDays,
    shifts: assignments,
    teams,
    /** Portão fechado: as equipas vêm sem "dentro/fora da meta" (o texto a pôr no lugar). */
    teamsHidden: acts.hidden,
    times: { ...timesView, source: svc.source, computedAt: svc.computedAt, truncated: svc.truncated, reason: svc.reason },
    driverNames,
    complaintsToday: Number((compl as any)?.n ?? 0),
    complaintsDeparted,
    // Movimentos cortados no limite: as reclamações dos carros que saíram são de uma parte do dia (o ecrã avisa).
    timingsTruncated: hist.ok && hist.rows.length >= HIST_LIMIT,
  };
}
