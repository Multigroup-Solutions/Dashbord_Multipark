/**
 * 44e — Passagem de turno (Jorge, 7 out 2026):
 *  - "tirares estes pendentes todos daqui, que não são eles que vão tratar":
 *    os pendentes que se arrastam e o resumo da semana contam só PDAs e notas;
 *  - "em vez de pores as marcas no card, põe as garagens, para termos uma visão
 *    do que está mal arrumado".
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { detectRepeatedItems, handoverOnlyItems, HANDOVER_WEEK_NARRATIVE_FROM, aggregateHandoverWeek } from "./aiOps/handoverRepeats";
import { summarizeBySpotType, type LiveCar } from "./multiparkDb/shiftState";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

describe("44e — só os pendentes da passagem (PDAs e notas)", () => {
  const stored = JSON.stringify([
    { key: "occ:1", kind: "occurrence", text: "Ocorrência BV26QL — Outro — Redpark", resolved: false },
    { key: "cmp:2", kind: "complaint", text: "Reclamação #2", resolved: false },
    { key: "pda:3", kind: "pda", text: "PDA 7 ainda com check-in", resolved: false },
    { key: "note:4", kind: "note", text: "Chave do carro AA-00-BB no cofre", resolved: false },
  ]);

  it("as ocorrências e reclamações gravadas em passagens antigas não contam", () => {
    expect(handoverOnlyItems(stored).map((i) => i.kind)).toEqual(["pda", "note"]);
  });

  it("os que se arrastam são só PDAs e notas", () => {
    const snap = (date: string) => ({ date, shift: "morning", items: handoverOnlyItems(stored) });
    const rep = detectRepeatedItems([snap("2026-10-07"), snap("2026-10-06"), snap("2026-10-05")]);
    expect(rep.map((r) => r.kind).sort()).toEqual(["note", "pda"]);
    expect(rep.some((r) => /Ocorrência|Reclamação/.test(r.text))).toBe(false);
  });

  it("o resumo da semana conta só esses; os resumos antigos (com ocorrências) não se mostram", () => {
    const w = aggregateHandoverWeek({ city: "lisbon", from: "2026-10-05", to: "2026-10-11", shiftsWithScale: [], handovers: [{ date: "2026-10-07", shift: "morning", acked: true, items: handoverOnlyItems(stored) }], repeated: [] });
    expect(w.pendingOpen).toBe(2);
    expect(HANDOVER_WEEK_NARRATIVE_FROM).toBe("2026-10-05");
    expect(src("server/aiOps/router.ts")).toContain("AND weekStart >= ${HANDOVER_WEEK_NARRATIVE_FROM}");
    const repeats = src("server/aiOps/handoverRepeats.ts");
    expect(repeats).toContain("items: handoverOnlyItems(r.openItems)");
    expect(repeats).not.toMatch(/items: parseOpenItems\(r\.openItems\)/);
  });
});

describe("44e — cartões por tipo de lugar com as garagens", () => {
  it("em cada tipo, as garagens de cada parque (mais cheia primeiro)", () => {
    const car = (spotType: LiveCar["spotType"], parkName: string, garage: string | null) => ({ spotType, parkName, garage, phase: "in_park" }) as LiveCar;
    const out = summarizeBySpotType([
      car("covered", "Airpark - Lisboa", "COBERTO"), car("covered", "Airpark - Lisboa", "COBERTO"), car("covered", "Airpark - Lisboa", "PD"),
      car("covered", "Redpark - Lisboa", null), car("uncovered", "Airpark - Lisboa", "PD"),
    ]);
    const covered = out.find((t) => t.type === "covered")!;
    expect(covered.total).toBe(4);
    expect(covered.byParkGarage).toEqual([
      // respostas 7 out: cada garagem diz se serve para o tipo (shared/garageFit.ts)
      { parkName: "Airpark - Lisboa", total: 3, garages: [{ garage: "COBERTO", count: 2, fit: "ok" }, { garage: "PD", count: 1, fit: "warn" }] },
      { parkName: "Redpark - Lisboa", total: 1, garages: [{ garage: "Sem garagem", count: 1, fit: "unknown" }] },
    ]);
    const ui = src("client/src/components/ShiftHandoverLiveState.tsx");
    expect(ui).toContain("t.byParkGarage");
    expect(ui).not.toContain("t.byPark.map((p) => `${p.parkName} ${p.count}`)");
  });
});
