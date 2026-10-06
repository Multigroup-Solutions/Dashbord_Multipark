/**
 * P3 lote 30a — O dia da caixa (Jorge, 6 out 2026): "a caixa é para ser
 * fechada às 03 da manhã, quando acaba o turno da noite, ou seja, em n+1".
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CASH_DAY_CLOSE_HOUR, cashDayClosesAtLabel, cashDayRangeUtc, cashDayWindowLabel, currentCashDay, isCashDayClosed, lastClosedCashDay } from "../shared/cashDayWindow";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("30a — a caixa do dia D vai de D 03:00 a D+1 03:00 (Lisboa)", () => {
  it("fecha às 03:00", () => expect(CASH_DAY_CLOSE_HOUR).toBe(3));

  it("intervalo em UTC no verão, no inverno e na mudança da hora", () => {
    expect(cashDayRangeUtc("2026-10-06")).toMatchObject({ start: "2026-10-06 02:00:00", end: "2026-10-07 02:00:00" });
    expect(cashDayRangeUtc("2026-12-10")).toMatchObject({ start: "2026-12-10 03:00:00", end: "2026-12-11 03:00:00" });
    // 25 out 2026: a hora muda (02:00 → 01:00); a caixa de 24 tem 25 horas e fecha às 03:00 de relógio
    const r = cashDayRangeUtc("2026-10-24");
    expect(r).toMatchObject({ start: "2026-10-24 02:00:00", end: "2026-10-25 03:00:00" });
    expect((r.endMs - r.startMs) / 3_600_000).toBe(25);
  });

  it("às 01:30 de dia 7 ainda é a caixa de dia 6; às 03:00 já é a de dia 7", () => {
    const t0130 = Date.parse("2026-10-07T00:30:00Z"); // 01:30 em Lisboa
    const t0300 = Date.parse("2026-10-07T02:00:00Z"); // 03:00 em Lisboa
    expect(currentCashDay(t0130)).toBe("2026-10-06");
    expect(lastClosedCashDay(t0130)).toBe("2026-10-05");
    expect(currentCashDay(t0300)).toBe("2026-10-07");
    expect(lastClosedCashDay(t0300)).toBe("2026-10-06");
  });

  it("fechada só depois das 03:00 do dia seguinte", () => {
    expect(isCashDayClosed("2026-10-06", Date.parse("2026-10-07T01:59:59Z"))).toBe(false);
    expect(isCashDayClosed("2026-10-06", Date.parse("2026-10-07T02:00:00Z"))).toBe(true);
  });

  it("textos", () => {
    expect(cashDayWindowLabel("2026-10-06")).toBe("6/10 03:00 → 7/10 03:00");
    expect(cashDayClosesAtLabel("2026-10-31")).toBe("às 03:00 de 1/11");
  });
});

describe("30a — onde se aplica", () => {
  it("Caixa por dia, contagem do parque e multibanco do dia usam a janela da caixa", () => {
    expect(src("server/cashDay.ts")).toContain("const range = cashDayRangeUtc(day);");
    expect(src("server/cashCheck/caseQueries.ts")).toContain("const r = cashDayRangeUtc(day);");
    expect(src("server/cashExternal.ts")).toContain("const r = cashDayRangeUtc(day);");
    for (const f of ["server/cashDay.ts", "server/cashCheck/caseQueries.ts"]) expect(src(f)).not.toContain("lisbonDayRangeUtc(day)");
  });

  it("a correção do dia só depois de a caixa fechar (servidor e ecrã)", () => {
    expect(src("server/cashCheckRouter.ts")).toContain("if (!board.closed) throw new TRPCError({ code: \"BAD_REQUEST\"");
    const ui = src("client/src/components/cashCheck/CashDayBoard.tsx");
    expect(ui).toContain("useState(() => lastClosedCashDay())");
    expect(ui).toContain("disabled={review.isPending || !closed}");
    expect(src("client/src/components/cashCheck/CashCountPanel.tsx")).toContain("useState(() => currentCashDay())");
  });

  it("as despesas do turno já são do dia operacional (o turno da noite pertence ao dia em que começa)", () => {
    expect(src("server/shiftExpenses.ts")).toContain("`shift:${day}:${shift}:${city}`");
    expect(src("docs/ajuda/caixa.md")).toContain("O dia da caixa vai das 03:00 às 03:00 do dia seguinte");
  });
});
