/**
 * Passagem de turno → Resumo do dia (Jorge, 12 out 2026): linhas clicáveis,
 * velocidade e excessos por condutor, parado limitado ao turno, entregas
 * lentas com o que havia no mesmo horário e passagens por chefe de turno.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  dayTimings, deliveryBand, deliveryContext, deliveryPairs, gpsWindowStats, mergeGpsStats, shiftWindowsFor, teamLines,
  type DayHistRow, type RosterEntry, type WindowPoint,
} from "../shared/shiftDayReview";
import { stoppedForDisplay, stoppedHours } from "../shared/dayWorkSummary";
import { leftoverFromShares } from "./activityHelpers";
import { daysOfWindows, holderAtFn } from "./shiftGps";
import { lisbonLocalTimeUtcMs, operationalDayWindowUtc } from "../shared/shiftHandover";
import { MAX_PLAUSIBLE_KMH, STOPPED_SPEED_KMH } from "./zelloGps";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
const DAY = "2026-10-08"; // quinta-feira, hora de verão (UTC+1)
const w = { start: "2026-10-08 02:00:00", end: "2026-10-09 02:00:00", checkoutEnd: "2026-10-09 12:00:00" };
const row = (b: string, ct: string, t: string, o: Partial<DayHistRow> = {}): DayHistRow => ({ bookingExternalId: b, changeType: ct, actionTime: t, agentName: "Rui", agentUserId: "u-rui", city: "Lisboa", bookingCode: `MP-${b}`, ...o });

describe("Resumo do dia — entregas e recolhas (as regras dos cartões)", () => {
  const rows = [
    row("a", "PENDING_CHECKOUT", "2026-10-08 10:00:00"), row("a", "CHECK_OUT", "2026-10-08 10:25:00", { licensePlate: "AA-00-BB", parkName: "Airpark" }),
    row("b", "PENDING_CHECKOUT", "2026-10-08 10:00:00"), row("b", "CHECK_OUT", "2026-10-08 22:00:00"), // > 10 h: sem medida
    row("c", "CHECK_OUT", "2026-10-08 11:00:00", { agentName: "Ana", agentUserId: "u-ana" }), // sem pendente
    row("d", "CHECK_IN", "2026-10-08 08:20:00", { checkIn: "2026-10-08 08:00:00" }),
    row("d", "CHECK_IN", "2026-10-08 09:00:00", { checkIn: "2026-10-08 08:00:00" }), // conta o 1.º
    row("e", "CHECK_IN", "2026-10-08 12:00:00", { checkIn: null }), // sem previsão: conta, sem medida
  ];
  it("pendente→entregue e a reserva de cada entrega; nas recolhas a hora marcada já não entra", () => {
    const t = dayTimings(rows, w);
    expect(t.deliveries.map((d) => ({ booking: d.booking, mins: d.mins, agent: d.agent }))).toEqual([{ booking: "a", mins: 25, agent: "Rui" }]);
    expect(t.deliveries).toEqual([expect.objectContaining({ booking: "a", bookingCode: "MP-a", plate: "AA-00-BB", parkName: "Airpark", pendingAt: "2026-10-08 10:00:00", deliveredAt: "2026-10-08 10:25:00", mins: 25, agentUserId: "u-rui" })]);
    expect(t.unmeasured.map((u) => u.booking).sort()).toEqual(["b", "c"]);
    expect(t.pickups.map((p) => [p.booking, p.at])).toEqual([["d", "2026-10-08 08:20:00"], ["e", "2026-10-08 12:00:00"]]);
    for (const p of t.pickups) { expect(p).not.toHaveProperty("delayMins"); expect(p).not.toHaveProperty("planned"); }
  });
  it("cor da entrega: >15 atrasada, >30 muito atrasada", () => {
    expect([deliveryBand(15), deliveryBand(16), deliveryBand(31), deliveryBand(null)]).toEqual(["ok", "late", "very_late", null]);
  });
});

describe("Resumo do dia — passagens por chefe de turno (equipa = regra 42c)", () => {
  const roster: RosterEntry[] = [
    { employeeId: 1, personName: "Teresa TL", shift: "morning", city: "lisbon", isTeamLeader: 1, startHour: 7, endHour: 15 },
    { employeeId: 2, personName: "Rui", shift: "morning", city: "lisbon", isTeamLeader: 0, startHour: 7, endHour: 15 },
    { employeeId: null, personName: "Zé Sem Ficha", shift: "morning", city: "lisbon", isTeamLeader: 0, startHour: 8, endHour: 14 },
    { employeeId: 3, personName: "Nuno TL", shift: "night", city: "lisbon", isTeamLeader: 1, startHour: 15, endHour: 27 },
    { employeeId: 4, personName: "Paula TL", shift: "night", city: "lisbon", isTeamLeader: 1, startHour: 15, endHour: 27 },
    { employeeId: 5, personName: "Ana", shift: "night", city: "lisbon", isTeamLeader: 0, startHour: 15, endHour: 27, sentHomeHour: 23 },
    // a Ana faz também a manhã (dois turnos no mesmo dia: conta o que abriga a hora)
    { employeeId: 5, personName: "Ana", shift: "morning", city: "lisbon", isTeamLeader: 0, startHour: 7, endHour: 11 },
  ];
  const at = (h: number) => new Date(lisbonLocalTimeUtcMs(DAY, h)).toISOString().slice(0, 19).replace("T", " ");
  // 15 out 2026: a entrega é do condutor do Trânsito e conta pelo nosso tempo (meta 15); a recolha é de quem a tirou do terminal (atrasadas só no T2)
  const lines = teamLines(DAY, roster, {
    deliveries: [
      { actor: { employeeId: 2, name: "Rui" }, at: at(9), ourMins: 10 },
      { actor: { employeeId: 2, name: "Rui" }, at: at(10), ourMins: 20 },
      { actor: { employeeId: null, name: "Zé  sem ficha" }, at: at(11), ourMins: 40 },
      { actor: { employeeId: 1, name: "Teresa TL" }, at: at(12), ourMins: 5 }, // o TL: fica de fora da equipa
      { actor: { employeeId: 5, name: "Ana" }, at: at(9), ourMins: 12 },  // manhã da Ana
      { actor: { employeeId: 5, name: "Ana" }, at: at(20), ourMins: 33 }, // noite da Ana
      { actor: { employeeId: 5, name: "Ana" }, at: at(21), ourMins: null }, // sem chegada pelo GPS: conta, sem medida
      { actor: { employeeId: 99, name: "Fora da escala" }, at: at(10), ourMins: 50 }, // não conta
    ],
    pickups: [
      { actor: { employeeId: 2, name: "Rui" }, at: at(8), t2: true, t2LateMins: 0 },
      { actor: { employeeId: 2, name: "Rui" }, at: at(8.5), t2: true, t2LateMins: 4 },
      { actor: { employeeId: 2, name: "Rui" }, at: at(9), t2: false, t2LateMins: null }, // T1: nunca atrasada
      { actor: { employeeId: 5, name: "Ana" }, at: at(25), t2: true, t2LateMins: null },
    ],
  }, { targetMinutes: 15 });
  it("uma linha por TL; dois TL no mesmo turno → duas linhas com a mesma equipa", () => {
    expect(lines.map((l) => [l.shift, l.tl?.name])).toEqual([["morning", "Teresa TL"], ["night", "Nuno TL"], ["night", "Paula TL"]]);
    const night = lines.filter((l) => l.shift === "night");
    expect(night[0].deliveries).toEqual(night[1].deliveries);
    expect(night[0].members).toEqual(["Ana"]);
  });
  it("entregas dentro / fora da meta pelo nosso tempo; recolhas atrasadas só no T2", () => {
    const m = lines[0];
    expect(m.members).toEqual(["Ana", "Rui", "Zé Sem Ficha"]);
    expect(m.deliveries).toEqual({ count: 4, measured: 4, onTime: 2, late: 2 }); // Rui 10, Rui 20, Zé 40, Ana 12
    expect(m.pickups).toEqual({ count: 3, t2: 2, measured: 2, onTime: 1, late: 1 });
    expect(m.tlOwn).toEqual({ deliveries: 1, pickups: 0 });
    const n = lines[1];
    expect(n.deliveries).toEqual({ count: 2, measured: 1, onTime: 0, late: 1 }); // Ana 33 + uma sem medida
    expect(n.pickups).toEqual({ count: 1, t2: 1, measured: 0, onTime: 0, late: 0 });
    // a meta vem da definição: com 35 min, os 33 da Ana ficam dentro
    const wide = teamLines(DAY, roster, { deliveries: [{ actor: { employeeId: 5, name: "Ana" }, at: at(20), ourMins: 33 }], pickups: [] }, { targetMinutes: 35 });
    expect(wide.find((l) => l.shift === "night")!.deliveries).toEqual({ count: 1, measured: 1, onTime: 1, late: 0 });
  });
  it("turno sem TL na escala: uma linha sem chefe", () => {
    const l = teamLines(DAY, [{ employeeId: 7, personName: "Só Extra", shift: "morning", city: "porto", isTeamLeader: 0, startHour: 7, endHour: 15 }], { deliveries: [], pickups: [] }, { targetMinutes: 15 });
    expect(l).toEqual([expect.objectContaining({ tl: null, members: ["Só Extra"], city: "porto" })]);
  });
});

describe("Resumo do dia — o que havia no mesmo horário de uma entrega lenta", () => {
  const rows: DayHistRow[] = [
    row("x", "PENDING_CHECKOUT", "2026-10-08 09:40:00", { agentName: "Cliente" }),          // já à espera
    row("t", "PENDING_CHECKOUT", "2026-10-08 10:00:00", { agentName: "Cliente" }),          // a entrega lenta
    row("y", "PENDING_CHECKOUT", "2026-10-08 10:10:00"),                                      // pedido durante
    row("x", "CHECKING_OUT", "2026-10-08 10:20:00", { agentName: "Ana" }),
    row("x", "CHECK_OUT", "2026-10-08 10:30:00", { agentName: "Ana" }),
    row("t", "CHECKING_OUT", "2026-10-08 10:35:00", { agentName: "Rui" }),
    row("y", "CHECK_OUT", "2026-10-08 10:50:00", { agentName: "Ana" }),
    row("t", "CHECK_OUT", "2026-10-08 10:55:00", { agentName: "Rui" }),
    row("z", "PENDING_CHECKOUT", "2026-10-08 10:40:00", { city: "Porto" }),                  // outra cidade: fora
    row("w", "PENDING_CHECKOUT", "2026-10-08 08:00:00"), row("w", "CHECK_OUT", "2026-10-08 09:00:00"), // antes: fora
    row("v", "PENDING_CHECKOUT", "2026-10-08 10:45:00"),                                      // ainda por entregar
    row("s", "CHECK_OUT", "2026-10-08 10:15:00", { agentName: "Rui" }),                      // entrega sem pedido registado
  ];
  it("pedidos: pendente → pegou → entregue, por reserva", () => {
    const t = deliveryPairs(rows).find((p) => p.booking === "t")!;
    expect(t).toMatchObject({ pendingAt: "2026-10-08 10:00:00", pendingBy: "Cliente", takenAt: "2026-10-08 10:35:00", takenBy: "Rui", deliveredAt: "2026-10-08 10:55:00", deliveredBy: "Rui", mins: 55, bookingCode: "MP-t" });
    expect(deliveryPairs(rows).find((p) => p.booking === "s")).toMatchObject({ pendingAt: null, deliveredAt: "2026-10-08 10:15:00", mins: null });
  });
  it("outros pedidos da mesma cidade à espera, o pico e quem entregou entretanto", () => {
    const c = deliveryContext(deliveryPairs(rows), { booking: "t", pendingAt: "2026-10-08 10:00:00", deliveredAt: "2026-10-08 10:55:00" });
    expect(c.target?.booking).toBe("t");
    expect(c.others.map((o) => [o.booking, o.waitingBefore])).toEqual([["x", true], ["y", false], ["v", false]]);
    expect(c.waitingWhenRequested).toBe(1);
    expect(c.peakWaiting).toBe(3); // t + y + v às 10:45 (x já entregue às 10:30)
    expect(c.deliveredMeanwhile).toBe(3); // x, s, y
    expect(c.byDriver).toEqual([{ name: "Ana", count: 2 }, { name: "Rui", count: 1 }]);
  });
  it("reserva que não está na leitura (outra cidade / fora do acesso): nada", () => {
    expect(deliveryContext(deliveryPairs(rows), { booking: "nope", pendingAt: "2026-10-08 10:00:00", deliveredAt: "2026-10-08 10:55:00" }).target).toBeNull();
  });
});

describe("Resumo do dia — GPS dentro de uma janela (regras da recolha)", () => {
  const t0 = Math.floor(Date.UTC(2026, 9, 8, 6, 0, 0) / 1000); // 07:00 de Lisboa
  const pts = (spec: Array<[number, number, boolean?]>): WindowPoint[] => spec.map(([min, speed, acc]) => ({ ts: t0 + min * 60, speed, accurate: acc ?? true }));
  const win = (fromMin: number, toMin: number) => ({ startMs: (t0 + fromMin * 60) * 1000, endMs: (t0 + toMin * 60) * 1000 });
  it("parado e em movimento só dentro da janela; buracos de mais de 1 h não contam", () => {
    const p = pts([[0, 0], [10, 0], [20, 30], [30, 40], [40, 0], [200, 0], [210, 0], [400, 0]]);
    const s = gpsWindowStats(p, [win(0, 300)], { threshold: null });
    // 0→10 parado, 10→20 parado, 20→30 anda, 30→40 anda, 40→200 buraco (>1 h), 200→210 parado
    expect(s).toMatchObject({ stoppedMinutes: 30, movingMinutes: 20, minutes: 50, maxSpeed: 40, points: 7 });
    expect(gpsWindowStats(p, [win(15, 35)], { threshold: null })).toMatchObject({ stoppedMinutes: 0, movingMinutes: 10, points: 2 });
  });
  it("velocidade máxima e excessos numa entrega: sem o impreciso nem o pico falso; pontos seguidos = UM excesso (14 out 2026)", () => {
    // 3 s depois do 70 um "200" e 3 s depois 64: salto isolado (pico falso do GPS)
    const p = pts([[0, 20], [5, 95, false], [6, 70], [6.05, 200], [6.1, 64], [8, 62], [30, 90]]);
    const s = gpsWindowStats(p, [win(0, 10)], { threshold: 60 });
    expect(s.maxSpeed).toBe(70);
    expect(s.maxAt).toBe(t0 + 6 * 60);
    expect(s.violations).toBe(1); // 70, 64 e 62 seguidos acima de 60 = 1 excesso (o impreciso e o pico não contam)
    // acima de 150 já não se deita fora sem mais: 70 → 160 → 62 em minutos é possível e conta
    const real = gpsWindowStats(pts([[0, 20], [6, 70], [7, MAX_PLAUSIBLE_KMH + 10], [8, 62]]), [win(0, 10)], { threshold: 60 });
    expect(real.maxSpeed).toBe(MAX_PLAUSIBLE_KMH + 10);
    expect(real.violations).toBe(1);
    // um ponto sozinho acima do limite (sem posição para o confirmar) não é excesso nem é a máxima
    const lone = gpsWindowStats(pts([[0, 20], [6, 40], [7, 75], [8, 42]]), [win(0, 10)], { threshold: 60 });
    expect(lone).toMatchObject({ violations: 0, maxSpeed: 42 });
    expect(gpsWindowStats(pts([[0, 20], [6, 40], [7, 75], [8, 42]]), [win(0, 10)], { threshold: 60, minPoints: 1 })).toMatchObject({ violations: 1, maxSpeed: 75 });
  });
  it("PDA partilhado: só os pontos de quem o tinha (o troço na troca não conta)", () => {
    const p = pts([[0, 0], [10, 0], [20, 0], [30, 0]]);
    const holder = holderAtFn([{ employeeId: 1, start: (t0) * 1000, end: (t0 + 15 * 60) * 1000 }], 2);
    expect(gpsWindowStats(p, [win(0, 60)], { threshold: null, mine: (ts) => holder(ts) === 1 })).toMatchObject({ stoppedMinutes: 10, points: 2 });
    expect(gpsWindowStats(p, [win(0, 60)], { threshold: null, mine: (ts) => holder(ts) === 2 })).toMatchObject({ stoppedMinutes: 10, points: 2 });
    expect(STOPPED_SPEED_KMH).toBe(2);
  });
  it("vários ficheiros (PDA + telemóvel, dia seguinte) somam-se", () => {
    const a = { minutes: 10, movingMinutes: 4, stoppedMinutes: 6, maxSpeed: 50, maxAt: 1, violations: 1, points: 5 };
    const b = { minutes: 5, movingMinutes: 5, stoppedMinutes: 0, maxSpeed: 70, maxAt: 2, violations: 0, points: 3 };
    expect(mergeGpsStats([a, b])).toEqual({ minutes: 15, movingMinutes: 9, stoppedMinutes: 6, maxSpeed: 70, maxAt: 2, violations: 1, points: 8 });
  });
  it("dias tocados por uma janela (a noite passa para o dia seguinte)", () => {
    const night = { startMs: lisbonLocalTimeUtcMs(DAY, 15), endMs: lisbonLocalTimeUtcMs(DAY, 27) };
    expect(daysOfWindows([night])).toEqual([DAY, "2026-10-09"]);
    expect(daysOfWindows([{ startMs: lisbonLocalTimeUtcMs(DAY, 7), endMs: lisbonLocalTimeUtcMs(DAY, 15) }])).toEqual([DAY]);
  });
});

describe("Resumo do dia — parado limitado ao turno", () => {
  const op = operationalDayWindowUtc(DAY);
  const L = (h: number) => lisbonLocalTimeUtcMs(DAY, h);
  it("picagens: entrada → saída; entrada sem saída até agora (máx. 16 h); rejeitadas não contam", () => {
    const r = shiftWindowsFor({ opStartMs: op.startMs, opEndMs: op.endMs, nowMs: L(40), roster: [], ponto: [
      { type: "check_in", atMs: L(6.9) }, { type: "check_out", atMs: L(15.1) },
      { type: "check_in", atMs: L(16), rejected: true },
      { type: "check_in", atMs: L(18) },
    ] });
    expect(r.source).toBe("ponto");
    expect(r.windows).toEqual([{ startMs: L(6.9), endMs: L(15.1) }, { startMs: L(18), endMs: L(18) + 16 * 3_600_000 }]);
  });
  it("a saída da noite anterior (03:10) e uma entrada já do dia seguinte não contam", () => {
    const r = shiftWindowsFor({ opStartMs: op.startMs, opEndMs: op.endMs, nowMs: L(40), roster: [], ponto: [
      { type: "check_in", atMs: L(-9) }, { type: "check_out", atMs: L(3.2) },
      { type: "check_in", atMs: L(26.5) },
    ] });
    expect(r).toEqual({ windows: [], source: null });
  });
  it("sem picagens: a escala (até ser mandado para casa); sem escala: nenhuma (fica o dia, com ~)", () => {
    const r = shiftWindowsFor({ opStartMs: op.startMs, opEndMs: op.endMs, nowMs: L(40), ponto: [], roster: [{ date: DAY, startHour: 15, endHour: 27, sentHomeHour: 24 }] });
    expect(r).toEqual({ windows: [{ startMs: L(15), endMs: L(24) }], source: "escala" });
  });
  it("o caso do Maxwell: 10 h de ponto e o Zello ligado o dia todo — o parado fica dentro das 10 h", () => {
    // Zello ligado das 01:00 às 23:00, a reportar de 5 em 5 min, quase sempre parado; anda 1 h no turno.
    const start = Math.floor(L(1) / 1000);
    const points: WindowPoint[] = [];
    for (let m = 0; m <= 22 * 60; m += 5) points.push({ ts: start + m * 60, speed: m >= 8 * 60 && m < 9 * 60 ? 35 : 0, accurate: true });
    const day = gpsWindowStats(points, [{ startMs: L(0), endMs: L(24) }], { threshold: null });
    expect(day.stoppedMinutes / 60).toBeCloseTo(21, 0); // o dia inteiro: ~21 h "parado"
    const turno = shiftWindowsFor({ opStartMs: op.startMs, opEndMs: op.endMs, nowMs: L(40), roster: [], ponto: [{ type: "check_in", atMs: L(7) }, { type: "check_out", atMs: L(17) }] });
    const s = gpsWindowStats(points, turno.windows, { threshold: null });
    expect(s.movingMinutes).toBe(60);
    expect(s.stoppedMinutes).toBe(9 * 60 - 5); // 10 h de turno − 1 h a andar − o último troço que sai da janela
    expect(s.stoppedMinutes / 60).toBeLessThanOrEqual(10);
  });
  it("o que o ecrã mostra: o do turno; sem turno, o do dia com ~ (regra do Histórico Diário)", () => {
    expect(stoppedForDisplay({ pontoHours: 10, hoursOnline: 20, hoursWorked: 1.3, hoursStopped: 12 }, { stoppedHours: 7.44, source: "ponto" })).toEqual({ hours: 7.4, source: "ponto" });
    expect(stoppedForDisplay({ pontoHours: null, hoursOnline: 20, hoursWorked: 1.3, hoursStopped: 12 }, { stoppedHours: null, source: null })).toEqual({ hours: 12, source: "dia" });
    expect(stoppedForDisplay({ pontoHours: null, hoursOnline: null, hoursWorked: null, hoursStopped: null }, null)).toEqual({ hours: null, source: null });
    // a regra do dia é a soma dos troços parados (o Zello desligado não conta), já não online − em movimento
    expect(stoppedHours({ pontoHours: null, hoursOnline: 20, hoursWorked: 1.3, hoursStopped: 12 })).toBe(12);
    expect(stoppedHours({ pontoHours: null, hoursOnline: 9, hoursWorked: 3.5 })).toBe(5.5); // linhas sem a coluna
  });
  it("o resto de um PDA partilhado leva também as horas paradas", () => {
    const rest = leftoverFromShares(
      { km: 30, hoursMoving: 3, hoursOnline: 8, maxSpeed: 90, violations: 4, hoursStopped: 4 },
      [{ km: 12, minutes: 180, movingMinutes: 60, maxSpeed: 60, violations: 1 }],
    );
    expect(rest?.hoursStopped).toBe(2);
  });
});

describe("Resumo do dia — o ecrã", () => {
  // 12 out 2026: o Resumo do dia passou para a Atividade diária (o mesmo componente, sem perder nada).
  const page = src("client/src/components/shiftDay/DaySummaryTab.tsx");
  const comp = src("client/src/components/shiftDay/ShiftDayReview.tsx");
  it("Quem trabalhou: nome abre a ficha, a linha abre o dia; colunas Vel. máx. e Excessos", () => {
    expect(page).toContain("openEmployee(p.employeeId)");
    expect(page).toContain("setDriver(");
    expect(page).toContain('<Th k="maxSpeed" label="Vel. máx."');
    expect(page).toContain('<Th k="violations" label="Excessos"');
    expect(page).toContain('<Th k="stoppedH" label="Parado"');
  });
  it("cartões novos, entregas lentas clicáveis e passagens por chefe de turno", () => {
    expect(page).toContain("DayTimesSection");
    expect(page).toContain("Km da equipa");
    expect(page).toContain("Excesso de velocidade");
    expect(page).toContain("Horas paradas");
    expect(comp).toContain("SlowDeliveryDialog");
    expect(comp).toContain("DriverDaySheet");
    expect(comp).toContain("Sem passagem de turno");
    expect(comp).toContain("/reserva/");
  });
  it("o servidor tem as três leituras novas com a permissão do Resumo do dia", () => {
    const r = src("server/routers.ts");
    for (const p of ["peopleShiftGps", "driverDay", "deliveryContext"]) expect(r).toContain(`${p}: protectedProcedure`);
    expect(r.match(/requireAccess\(ctx\.user, "passagem_resumo_dia", "view"\)/g)!.length).toBeGreaterThanOrEqual(5);
  });
});
