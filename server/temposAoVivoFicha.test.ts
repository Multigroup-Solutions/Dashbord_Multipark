/**
 * Tempos nos ecrãs (P10) — cronómetros do Ao vivo ("Na fila há X" com a cor
 * da meta; "Em entrega há Y" sem cor; "Em recolha há Z"), os pendentes da
 * Passagem de turno ("na fila há X") e a Ficha da reserva (cada tempo com a
 * fonte e o motivo; portão; âmbito de cidade; só leitura).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { elapsedMinutes, fmtElapsed, liveTimer, queueTone } from "../shared/liveTimers";
import { mapLiveCar, type LiveCar, type ShiftState } from "./multiparkDb/shiftState";
import { draftPartsFromLive } from "./shiftHandoverDraft";
import { bookingRowsLive, bookingTimesView, buildBookingScopeSql } from "./serviceTimesBooking";
import { buildServiceBookingHistorySql, buildServiceHistorySql, mapServiceHistoryRow } from "./multiparkDb/serviceRows";
import { assertReadOnlySql } from "./multiparkDb/client";
import { DEFAULT_GARAGE_ROLES, type ServiceEvent } from "../shared/serviceTimes";
import type { ServiceRow } from "./serviceTimesAgg";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
const MIN = 60_000;
const NOW = Date.parse("2026-11-02T17:30:00Z");

describe("P10 — cronómetros do Ao vivo", () => {
  it("minutos desde a fase (ISO ou texto UTC), nunca negativos", () => {
    expect(elapsedMinutes("2026-11-02T17:18:00.000Z", NOW)).toBe(12);
    expect(elapsedMinutes("2026-11-02 17:18:30", NOW)).toBe(11);
    expect(elapsedMinutes("2026-11-02T17:30:30Z", NOW)).toBe(0);
    expect(elapsedMinutes(null, NOW)).toBeNull();
    expect(elapsedMinutes("lixo", NOW)).toBeNull();
    expect([fmtElapsed(8), fmtElapsed(65), fmtElapsed(26 * 60 + 5)]).toEqual(["8 min", "1h05", "26h"]);
  });
  it("só \"Na fila\" tem a cor da meta: âmbar a partir da meta, vermelho a partir do dobro", () => {
    expect([queueTone(14, 15), queueTone(15, 15), queueTone(29, 15), queueTone(30, 15), queueTone(null, 15)]).toEqual([null, "warn", "warn", "late", null]);
    expect(liveTimer("pending_checkout", "2026-11-02T17:10:00Z", NOW, 15)).toEqual({ text: "Na fila há 20 min", mins: 20, tone: "warn" });
    // "Em entrega" não tem cor (inclui a espera pelo cliente, que não é nossa), mesmo com 2 h
    expect(liveTimer("checking_out", "2026-11-02T15:30:00Z", NOW, 15)).toEqual({ text: "Em entrega há 2h00", mins: 120, tone: null });
    expect(liveTimer("checking_in", "2026-11-02T17:22:00Z", NOW, 15)).toEqual({ text: "Em recolha há 8 min", mins: 8, tone: null });
    expect(liveTimer("in_park", null, NOW, 15)).toBeNull();
    expect(liveTimer("pending_checkout", null, NOW, 15)).toEqual({ text: "Na fila", mins: null, tone: null });
  });
  it("o ecrã usa o cronómetro, com a meta das Definições vinda do servidor", () => {
    const ui = src("client/src/components/ShiftHandoverLiveState.tsx");
    expect(ui).toContain("liveTimer(c.phase, c.phaseSince, now, target)");
    expect(ui).toContain("useNow(30_000)");
    expect(src("server/routers.ts")).toContain('return { available: true as const, ...r.data, targetMinutes };');
  });
});

describe("P10 — Passagem de turno: \"na fila há X\" nos pendentes", () => {
  const car = (id: string, status: string, extra: Record<string, unknown> = {}): LiveCar => mapLiveCar({ id, status, park_id: "p1", ...extra }, undefined, NOW);
  it("cada pendente leva desde quando está na fila (o ecrã conta os minutos)", () => {
    const st = {
      upcoming: { checkins: [], checkouts: [], truncated: false },
      inProgress: [car("fila", "PENDING_CHECKOUT", { pending_checkout_at: "2026-11-02 17:05:00" }), car("entrega", "CHECKING_OUT", { checking_out_at: "2026-11-02 17:20:00" })],
      inPark: { total: 0, byPark: [], byType: [], cars: [], overdue: 0, truncated: false },
      occurrences: { list: [], truncated: false }, cash: { notCashierClosed: 0 }, blocks: null,
    } as unknown as ShiftState;
    const p = draftPartsFromLive(st).pendingDeliveries;
    expect(p).toEqual([expect.objectContaining({ externalId: "fila", sinceAt: "2026-11-02T17:05:00.000Z" })]);
    expect(liveTimer("pending_checkout", p[0].sinceAt, NOW, 15)!.text).toBe("Na fila há 25 min");
    const ui = src("client/src/components/ShiftHandoverDraftPanel.tsx");
    expect(ui).toContain('liveTimer("pending_checkout", b.sinceAt, now, draft.targetMinutes ?? 15)');
    expect(ui).toContain("na fila há {fmtElapsed(t.mins)}");
  });
});

// ─── Ficha da reserva ───────────────────────────────────────────────────────

const T = (hhmm: string) => Date.parse(`2026-10-13T${hhmm}:00Z`);
let seq = 0;
const ev = (type: string, hhmm: string, agent = "uA", extra: Partial<ServiceEvent> = {}): ServiceEvent => ({ id: `h${++seq}`, bookingId: "bk1", type, at: T(hhmm), agentUserId: agent, agentName: null, platform: "MOBILE", lat: null, lng: null, ...extra });

describe("P10 — Ficha da reserva: cada tempo com a fonte e o motivo", () => {
  const events: ServiceEvent[] = [
    ev("CHECKING_IN", "06:00", "uOff"), ev("CHECK_IN", "06:20"), ev("MOVEMENT", "06:27", "uA", { moveKind: "inicio" }), ev("MOVEMENT", "06:45", "uA", { moveKind: "arrumar", garageTo: "P2" }),
    ev("MOVEMENT", "09:00", "uC", { moveKind: "inicio" }), ev("MOVEMENT", "09:10", "uC", { moveKind: "parques", garageFrom: "P2", garageTo: "CENTRAL" }),
    ev("PENDING_CHECKOUT", "16:00", "uOff"), ev("CHECKING_OUT", "16:10"), ev("CHECK_OUT", "16:40", "uTL"),
  ];
  const rows = bookingRowsLive(events, { roles: DEFAULT_GARAGE_ROLES, now: T("20:00"), cityKey: "lisboa", terminalClass: "t1" });
  it("ao vivo (sem a tabela): Fila desde o pendente, Total, Cliente da recolha e P2; os tempos com GPS ficam \"GPS por recolher\"", () => {
    const d = rows.find((r) => r.kind === "entrega")!, p = rows.find((r) => r.kind === "recolha")!;
    expect(d).toMatchObject({ queueMs: 10 * MIN, startSource: "pendente", totalMs: 40 * MIN, transitStatus: "gps_por_recolher", transitMs: null, customerMs: null });
    expect(p).toMatchObject({ customerMs: 20 * MIN, startSource: "em_recolha", terminalStatus: "gps_por_recolher", p2Ms: 145 * MIN, p2Status: "medido", parkedGarage: "CENTRAL", t2Status: "nao_aplicavel" });
  });
  it("portão fechado: quem não é super admin não recebe os tempos com GPS (nem a hora da chegada)", () => {
    const withGps: ServiceRow[] = rows.map((r) => (r.kind === "entrega" ? { ...r, transitMs: 12 * MIN, transitStatus: "medido", arrivedSource: "gps_zona", arrivedAt: T("16:22"), customerMs: 18 * MIN, customerStatus: "medido", ourMs: 22 * MIN, ourStatus: "medido" } : r));
    const v = bookingTimesView(withGps, { gate: { visible: false, minCoveragePct: 60, minN: 20 }, isSuperAdmin: false });
    const d = v.entries.find((e) => e.kind === "entrega")!;
    for (const k of ["transito", "cliente", "nosso"]) expect(d.times.find((t) => t.key === k)).toMatchObject({ ms: null, status: null, source: null, hidden: "Em calibração" });
    expect(d.times.find((t) => t.key === "fila")).toMatchObject({ ms: 10 * MIN, status: "medido", source: "pendente", hidden: null });
    expect(d.at.arrived).toBeNull();
    expect(JSON.stringify(v)).not.toMatch(new RegExp(`"ms":(${12 * MIN}|${18 * MIN}|${22 * MIN})\\b`));
    expect(JSON.stringify(v)).not.toContain(`"arrived":${T("16:22")}`);
    // super admin: vê, marcado em calibração
    const s = bookingTimesView(withGps, { gate: { visible: false, minCoveragePct: 60, minN: 20 }, isSuperAdmin: true });
    expect(s.entries.find((e) => e.kind === "entrega")!.times.find((t) => t.key === "transito")).toMatchObject({ ms: 12 * MIN, source: "gps_zona" });
    expect(s.gpsNote).toBe("em calibração");
    // portão aberto mas a cidade sem cobertura nesse dia: sem dados suficientes
    const o = bookingTimesView(withGps, { gate: { visible: true, minCoveragePct: 60, minN: 20 }, isSuperAdmin: false, open: () => false });
    expect(o.entries.find((e) => e.kind === "entrega")!.times.find((t) => t.key === "transito")!.hidden).toBe("Sem dados suficientes nesta cidade e dia");
    const ok = bookingTimesView(withGps, { gate: { visible: true, minCoveragePct: 60, minN: 20 }, isSuperAdmin: false, open: () => true });
    expect(ok.entries.find((e) => e.kind === "entrega")!.times.find((t) => t.key === "transito")!.ms).toBe(12 * MIN);
  });
  it("sem medição mostra o motivo, nunca 0", () => {
    const v = bookingTimesView(rows, { gate: { visible: false, minCoveragePct: 60, minN: 20 }, isSuperAdmin: true });
    const p = v.entries.find((e) => e.kind === "recolha")!;
    expect(p.times.find((t) => t.key === "terminal")).toMatchObject({ ms: null, status: "gps_por_recolher" });
  });
  it("a leitura de uma reserva: as mesmas colunas da leitura da noite, só leitura, com o âmbito de cidade", () => {
    const one = buildServiceBookingHistorySql("bk1");
    assertReadOnlySql(one.sql);
    expect(one.sql).toContain('WHERE h."bookingId" = $1');
    expect(one.params[0]).toBe("bk1");
    const night = buildServiceHistorySql({ fromUtc: "2026-10-13 00:00:00", toUtc: "2026-10-14 00:00:00" });
    expect(one.sql.split("FROM")[0]).toBe(night.sql.split("FROM")[0]);
    expect(mapServiceHistoryRow({ id: "h", booking_id: "bk1", change_type: "CHECK_OUT", action_time: "2026-10-13 16:40:00.000" })).toMatchObject({ type: "CHECK_OUT", at: T("16:40") });
    const scope = buildBookingScopeSql("bk1", ["Lisboa"]);
    assertReadOnlySql(scope.sql);
    expect(scope.sql).toMatch(/lower\(trim\(sp\."city"\)\) IN/);
    expect(buildBookingScopeSql("bk1", undefined).sql).not.toMatch(/sp\."city"/);
  });
  it("o procedimento pede o acesso das reservas e passa o papel; a ficha abre a secção só quando se carrega", () => {
    const r = src("server/bookingFileRouter.ts");
    expect(r).toMatch(/times: protectedProcedure\.input\(idInput\)\.query\(async \(\{ ctx, input \}\) => \{\n\s+requireAccess\(ctx\.user, "reservas_operacoes", "view"\);/);
    expect(r).toContain('getBookingTimes({ bookingId: input.id, cities: scopedCityNames(), isSuperAdmin: ctx.user.role === "super_admin" })');
    const page = src("client/src/pages/BookingFilePage.tsx");
    expect(page).toContain('<Section title="Tempos" icon={<Timer className="w-4 h-4" />} lazy');
    expect(page).toContain("<TimesSection id={id} scope={scope} />");
  });
});
