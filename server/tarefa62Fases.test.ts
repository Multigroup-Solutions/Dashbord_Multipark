/**
 * Tarefa 62 (Fase 1, P2c): as fases ao vivo pelo fluxo A (Jorge, 14 out 2026)
 * — o cliente liga → PENDING_CHECKOUT ("Na fila"); o condutor pega no carro →
 * CHECKING_OUT ("Em entrega"); "No terminal" só com um "Cheguei" deste ciclo
 * (quase nunca se usa); o cliente assina → CHECK_OUT. Nas recolhas, CHECKING_IN
 * = "Em recolha (cliente a caminho)". "À espera das malas" é uma etiqueta.
 * A mesma regra no estado ao vivo, no rascunho da passagem de turno e nas
 * Reservas do dia; os rótulos da ficha, das reclamações e dos perdidos.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BAGGAGE_WAITING_LABEL, LIVE_PHASE_LABELS, QUEUE_PHASES, baggageWaitingOf, livePhaseOf, livePhaseSince, livePhaseText } from "../shared/livePhases";
import { mapLiveCar, type LiveCar, type ShiftState } from "./multiparkDb/shiftState";
import { draftPartsFromLive } from "./shiftHandoverDraft";
import { phaseLabel, type DayBooking } from "../shared/reservasDoDia";

const src = (p: string) => readFileSync(resolve(import.meta.dirname, "..", p), "utf8");
const NOW = Date.parse("2026-11-02T18:00:00.000Z");

describe("livePhaseOf / rótulos (fluxo A)", () => {
  it("em recolha, na fila, em entrega, em movimento, no parque", () => {
    expect(livePhaseOf({ status: "CHECKING_IN" })).toBe("checking_in");
    expect(livePhaseOf({ status: "PENDING_CHECKOUT" })).toBe("pending_checkout");
    expect(livePhaseOf({ status: "CHECKING_OUT" })).toBe("checking_out");
    expect(livePhaseOf({ status: "MOVING" })).toBe("moving");
    expect(livePhaseOf({ status: "CHECKED_IN" })).toBe("in_park");
    expect(LIVE_PHASE_LABELS).toMatchObject({
      checking_in: "Em recolha (cliente a caminho)", pending_checkout: "Na fila", checking_out: "Em entrega", at_delivery: "No terminal",
    });
    expect(Object.values(LIVE_PHASE_LABELS)).not.toContain("A caminho");
  });
  it("fila com malas: a fase continua 'Na fila' e as malas são uma etiqueta (só deste pedido)", () => {
    const r = { status: "PENDING_CHECKOUT", pendingCheckoutAt: "2026-11-02T17:00:00.000Z", baggageWaitingAt: "2026-11-02T17:10:00.000Z" };
    expect(livePhaseOf(r)).toBe("pending_checkout");
    expect(baggageWaitingOf(r)).toBe(true);
    expect(livePhaseText(r)).toBe(`Na fila · ${BAGGAGE_WAITING_LABEL.toLowerCase()}`);
    expect(baggageWaitingOf({ ...r, baggageWaitingAt: "2026-11-01T17:10:00.000Z" })).toBe(false); // de outro pedido
    expect(baggageWaitingOf({ status: "PENDING_CHECKOUT", baggageWaitingAt: "2026-11-02T17:10:00.000Z" })).toBe(false); // sem pendente: não se sabe
  });
  it("'Cheguei' deste ciclo → 'No terminal'; de outro ciclo (mais velho do que o início da entrega) ignora-se", () => {
    const base = { status: "CHECKING_OUT", checkingOutAt: "2026-11-02T17:20:00.000Z" };
    expect(livePhaseOf({ ...base, arrivedAtDeliveryAt: "2026-11-02T17:35:00.000Z" })).toBe("at_delivery");
    expect(livePhaseOf({ ...base, arrivedAtDeliveryAt: "2026-10-20T10:00:00.000Z" })).toBe("checking_out");
    expect(livePhaseOf({ status: "CHECKING_OUT", arrivedAtDeliveryAt: "2026-11-02T17:35:00.000Z" })).toBe("checking_out"); // sem início: não se sabe o ciclo
    // um "Cheguei" com o carro ainda na fila não muda nada
    expect(livePhaseOf({ status: "PENDING_CHECKOUT", arrivedAtDeliveryAt: "2026-11-02T17:35:00.000Z" })).toBe("pending_checkout");
  });
  it("'desde': em recolha desde o checkingInAt; na fila desde o pendente; em entrega desde o início da entrega", () => {
    const r = { status: "x", checkingInAt: "A", pendingCheckoutAt: "B", checkingOutAt: "C", arrivedAtDeliveryAt: "D", movingAt: "E" };
    expect(livePhaseSince("checking_in", r)).toBe("A");
    expect(livePhaseSince("pending_checkout", r)).toBe("B");
    expect(livePhaseSince("checking_out", r)).toBe("C");
    expect(livePhaseSince("at_delivery", r)).toBe("D");
    expect(livePhaseSince("in_park", r)).toBeNull();
  });
  it("mapLiveCar: fase, 'desde' e a etiqueta das malas", () => {
    const c = mapLiveCar({ id: "b1", status: "CHECKING_OUT", park_id: "p1", pending_checkout_at: "2026-11-02 17:00:00", checking_out_at: "2026-11-02 17:20:00", arrived_at_delivery_at: "2026-10-20 10:00:00", baggage_waiting_at: "2026-11-02 17:05:00" }, undefined, NOW);
    expect(c).toMatchObject({ phase: "checking_out", phaseSince: "2026-11-02T17:20:00.000Z", baggageWaiting: true });
    const k = mapLiveCar({ id: "b2", status: "CHECKING_IN", park_id: "p1", checking_in_at: "2026-11-02 07:50:00" }, undefined, NOW);
    expect(k).toMatchObject({ phase: "checking_in", phaseSince: "2026-11-02T07:50:00.000Z", baggageWaiting: false });
  });
});

describe("rascunho da passagem de turno: pendentes = só os da fila", () => {
  const car = (id: string, status: string, extra: Record<string, unknown> = {}): LiveCar => mapLiveCar({ id, status, park_id: "p1", ...extra }, undefined, NOW);
  it("os que já saíram (em entrega, no terminal) e os em recolha não são pendentes", () => {
    const inProgress = [
      car("fila", "PENDING_CHECKOUT", { pending_checkout_at: "2026-11-02 17:00:00" }),
      car("malas", "PENDING_CHECKOUT", { pending_checkout_at: "2026-11-02 17:00:00", baggage_waiting_at: "2026-11-02 17:10:00" }),
      car("entrega", "CHECKING_OUT", { checking_out_at: "2026-11-02 17:20:00" }),
      car("terminal", "CHECKING_OUT", { checking_out_at: "2026-11-02 17:20:00", arrived_at_delivery_at: "2026-11-02 17:40:00" }),
      car("recolha", "CHECKING_IN", { checking_in_at: "2026-11-02 17:30:00" }),
    ];
    expect(inProgress.map((c) => c.phase)).toEqual(["pending_checkout", "pending_checkout", "checking_out", "at_delivery", "checking_in"]);
    const st = {
      upcoming: { checkins: [], checkouts: [], truncated: false }, inProgress,
      inPark: { total: 0, byPark: [], byType: [], cars: [], overdue: 0, truncated: false },
      occurrences: { list: [], truncated: false }, cash: { notCashierClosed: 0 }, blocks: null,
    } as unknown as ShiftState;
    expect(draftPartsFromLive(st).pendingDeliveries.map((p) => p.externalId)).toEqual(["fila", "malas"]);
    expect([...QUEUE_PHASES]).toEqual(["pending_checkout"]);
  });
});

describe("Reservas do dia: phaseLabel = a regra do estado ao vivo", () => {
  const b = (status: string, phases: Partial<DayBooking["phases"]>) => ({ status, phases: { checkingInAt: null, movingAt: null, pendingCheckoutAt: null, checkingOutAt: null, arrivedAtDeliveryAt: null, baggageWaitingAt: null, ...phases } }) as Pick<DayBooking, "status" | "phases">;
  it("o mesmo rótulo que o livePhaseOf em cada caso", () => {
    const cases: Array<[string, Partial<DayBooking["phases"]>]> = [
      ["CHECKING_IN", { checkingInAt: "2026-11-02T07:50:00.000Z" }],
      ["PENDING_CHECKOUT", { pendingCheckoutAt: "2026-11-02T17:00:00.000Z" }],
      ["PENDING_CHECKOUT", { pendingCheckoutAt: "2026-11-02T17:00:00.000Z", baggageWaitingAt: "2026-11-02T17:05:00.000Z" }],
      ["CHECKING_OUT", { checkingOutAt: "2026-11-02T17:20:00.000Z" }],
      ["CHECKING_OUT", { checkingOutAt: "2026-11-02T17:20:00.000Z", arrivedAtDeliveryAt: "2026-11-02T17:40:00.000Z" }],
      ["CHECKING_OUT", { checkingOutAt: "2026-11-02T17:20:00.000Z", arrivedAtDeliveryAt: "2026-10-01T17:40:00.000Z" }],
    ];
    for (const [status, phases] of cases) {
      const live = livePhaseText({ status, ...phases });
      expect(phaseLabel(b(status, phases))).toBe(live);
      expect(live.startsWith(LIVE_PHASE_LABELS[livePhaseOf({ status, ...phases })])).toBe(true);
    }
    expect(phaseLabel(b("CHECKED_IN", {}))).toBeNull();
    expect(phaseLabel(b("MOVING", { movingAt: "2026-11-02T17:00:00.000Z" }))).toBeNull();
  });
});

describe("rótulos nos outros ecrãs", () => {
  it("o cliente deixou de ter a sua cópia dos rótulos (vêm de shared/livePhases.ts)", () => {
    const c = src("client/src/components/ShiftHandoverLiveState.tsx");
    expect(c).toContain('from "@shared/livePhases"');
    expect(c).not.toMatch(/A fazer check-out|No local de entrega|Entrega pendente"|const PHASE_LABELS/);
  });
  it("ficha da reserva: em recolha, pendente, Cheguei (botão), em entrega", () => {
    const f = src("server/multiparkDb/bookingFile.ts");
    expect(f).toContain('["checkingInAt", "Em recolha (cliente ligou)"]');
    expect(f).toContain('["pendingCheckoutAt", "Pendente (cliente ligou)"]');
    expect(f).toContain('["arrivedAtDeliveryAt", "Cheguei (botão)"]');
    expect(f).toContain('["checkingOutAt", "Em entrega (a caminho)"]');
  });
  it("reclamações e perdidos: CHECKING_OUT = 'Em entrega'", () => {
    for (const p of ["client/src/pages/ComplaintsPage.tsx", "client/src/pages/lostFound/config.ts"]) {
      const s = src(p);
      expect(s).toContain('CHECKING_OUT: { label: "Em entrega"');
      expect(s).not.toContain("A fazer check-out");
    }
  });
});
