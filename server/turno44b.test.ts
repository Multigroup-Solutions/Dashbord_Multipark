/**
 * Lote 44b — Passagem de turno só com PDAs e notas; Estado do parque ao vivo
 * por tipo de lugar; Resumo do dia com horas, km e tempo parado.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HANDOVER_ITEM_KINDS, buildHandoverEmail, draftKeyLines, isHandoverItem, mergeCarryOver, mergeStoredOpenItems, openItemKey, type OpenItem } from "../shared/shiftHandoverAuto";
import { draftOpenItems } from "./shiftHandoverDraft";
import { LIVE_SPOT_TYPE_LABELS, liveSpotTypeOf, summarizeBySpotType, type LiveCar } from "./multiparkDb/shiftState";
import { fmtHours, stoppedHours, workedHours } from "../shared/dayWorkSummary";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
const item = (kind: OpenItem["kind"], ref: string | number, extra: Partial<OpenItem> = {}): OpenItem => ({ key: openItemKey(kind, ref), kind, refId: ref, text: `${kind} ${ref}`, resolved: false, since: "2026-10-06 night", ...extra });

describe("44b — pendentes: só PDAs e notas passam de turno", () => {
  it("tipos que passam", () => {
    expect([...HANDOVER_ITEM_KINDS]).toEqual(["note", "pda"]);
    expect(isHandoverItem({ kind: "pda" })).toBe(true);
    expect(isHandoverItem({ kind: "complaint" })).toBe(false);
  });
  it("o rascunho só propõe os PDAs com check-in", () => {
    const items = draftOpenItems({ pdas: [{ id: 4, pdaName: "PDA 4", employeeName: "Rui" }] }, "2026-10-07 morning");
    expect(items).toEqual([expect.objectContaining({ kind: "pda", refId: 4, text: "PDA 4 com check-in de Rui" })]);
  });
  it("herdados de outros tipos não passam (nem se dão como resolvidos pelo sistema)", () => {
    const out = mergeCarryOver({
      previous: [item("complaint", 1), item("incident", "abc"), item("lost_found", 2), item("delivery", "x"), item("pda", 4), item("note", "chave do carro na gaveta")],
      draft: [item("pda", 4), item("complaint", 9)],
      draftKinds: ["complaint", "lost_found", "pda", "incident", "delivery"],
    });
    expect(out.map((i) => i.kind).sort()).toEqual(["note", "pda"]);
    expect(out.every((i) => !i.resolved)).toBe(true);
  });
  it("ao gravar, os de outros tipos que já estavam na BD ficam como estavam (não se apagam)", () => {
    const stored = [item("complaint", 1), item("pda", 4)];
    const out = mergeStoredOpenItems(stored, [item("pda", 4, { resolved: true })]);
    expect(out).toEqual([expect.objectContaining({ kind: "pda", resolved: true }), expect.objectContaining({ kind: "complaint", resolved: false })]);
  });
  it("email e números-chave sem reclamações, perdidos nem ocorrências", () => {
    const lines = draftKeyLines({ checkinsNext: 1, checkoutsNext: 2, pendingDeliveries: 0, complaintsNew: 3, complaintsOpen: 4, lostFoundOpen: 5, incidentsOpen: 6, whatsappUnread: 0, pdasCheckedIn: 1, clockInsOpen: 0, speedAlerts: 0, gpsAlerts: 0, toCollectEur: 0 });
    expect(lines.join("\n")).not.toMatch(/Reclamações|Perdidos|Ocorrências/);
    const mail = buildHandoverEmail({ city: "lisbon", shift: { date: "2026-10-07", shift: "morning" }, authorName: null, aiSummary: "ok", counts: null, notes: null, openItems: [item("complaint", 1), item("pda", 4)], link: "https://x" } as any);
    expect(mail.text).toContain("[PDA]");
    expect(mail.text).not.toContain("[Reclamação]");
  });
  it("o ecrã deixa de mostrar reclamações, perdidos e ocorrências", () => {
    const panel = src("client/src/components/ShiftHandoverDraftPanel.tsx");
    expect(panel).not.toContain('title="Perdidos e achados abertos"');
    expect(panel).not.toContain('title="Ocorrências abertas"');
    expect(panel).not.toContain("Reclamações (novas no turno");
    const live = src("client/src/components/ShiftHandoverLiveState.tsx");
    expect(live).not.toContain('label="Ocorrências por resolver"');
    const page = src("client/src/pages/ShiftHandoverPage.tsx");
    expect(page).toContain("((existing?.openItems ?? []) as OpenItem[]).filter(isHandoverItem)");
  });
});

describe("44b — Estado do parque ao vivo por tipo de lugar", () => {
  it("o lugar onde está manda; sem lugar, o produto reservado", () => {
    expect(liveSpotTypeOf("UNCOVERED", "15001")).toBe("covered");
    expect(liveSpotTypeOf("COVERED", "10001")).toBe("uncovered");
    expect(liveSpotTypeOf("VIP", null)).toBe("vip");
    expect(liveSpotTypeOf("indoor", "abc")).toBe("indoor");
    expect(liveSpotTypeOf(null, null)).toBe("unknown");
    expect(LIVE_SPOT_TYPE_LABELS.uncovered).toBe("Descoberto");
  });
  it("conta só os carros parados, por tipo e, dentro, por parque", () => {
    const car = (spotType: LiveCar["spotType"], parkName: string, phase: LiveCar["phase"] = "in_park") => ({ spotType, parkName, phase }) as LiveCar;
    const out = summarizeBySpotType([car("uncovered", "Airpark"), car("uncovered", "Airpark"), car("uncovered", "Redpark"), car("covered", "Airpark"), car("covered", "Airpark", "moving")]);
    expect(out).toMatchObject([
      { type: "uncovered", label: "Descoberto", total: 3, byPark: [{ parkName: "Airpark", count: 2 }, { parkName: "Redpark", count: 1 }] },
      { type: "covered", label: "Toldo", total: 1, byPark: [{ parkName: "Airpark", count: 1 }] },
    ]);
  });
  it("o ecrã mostra por tipo (e por parque/garagem só a pedido)", () => {
    const live = src("client/src/components/ShiftHandoverLiveState.tsx");
    expect(live).toContain("Carros no parque por tipo de lugar");
    expect(live).toContain("Ver por parque e garagem");
  });
});

describe("44b — Resumo do dia: horas, km e tempo parado", () => {
  it("horas: as do ponto; sem picagens, o Zello ligado", () => {
    expect(workedHours({ pontoHours: 8.04, hoursOnline: 9, hoursWorked: 3 })).toEqual({ hours: 8, source: "ponto" });
    expect(workedHours({ pontoHours: null, hoursOnline: 7.26, hoursWorked: 3 })).toEqual({ hours: 7.3, source: "zello" });
    expect(workedHours({ pontoHours: 0, hoursOnline: null, hoursWorked: null })).toEqual({ hours: null, source: null });
  });
  it("parado = Zello ligado sem andar", () => {
    expect(stoppedHours({ pontoHours: null, hoursOnline: 9, hoursWorked: 3.5 })).toBe(5.5);
    expect(stoppedHours({ pontoHours: 8, hoursOnline: null, hoursWorked: null })).toBeNull();
    expect(stoppedHours({ pontoHours: null, hoursOnline: 2, hoursWorked: 3 })).toBe(0);
    expect(fmtHours(0.5)).toBe("30 min");
    expect(fmtHours(7.5)).toBe("7,5 h");
    expect(fmtHours(null)).toBe("—");
  });
  it("a tabela tem as colunas Horas, Km e Parado (ordenáveis)", () => {
    const page = src("client/src/pages/ShiftHandoverPage.tsx");
    expect(page).toContain('<Th k="workedH" label="Horas"');
    expect(page).toContain('<Th k="stoppedH" label="Parado"');
  });
});
