import { describe, expect, it } from "vitest";
import { adResultsMeasure, attributionHealth } from "../shared/marketingAttribution";

describe("diagnóstico da atribuição aos anúncios", () => {
  it("sem reservas no site não há diagnóstico", () => {
    expect(attributionHealth({ siteBookings: 0, withOriginUrl: 0, withClickId: 0, attributed: 0 }, 500).level).toBe("none");
  });
  it("menos de metade com link de origem → incompleta", () => {
    expect(attributionHealth({ siteBookings: 100, withOriginUrl: 40, withClickId: 10, attributed: 10 }, 500).level).toBe("warning");
  });
  it("gasto em anúncios mas nenhum gclid nas reservas → partida", () => {
    expect(attributionHealth({ siteBookings: 100, withOriginUrl: 90, withClickId: 0, attributed: 0 }, 500).level).toBe("critical");
  });
  it("sem gasto, zero gclid é normal", () => {
    expect(attributionHealth({ siteBookings: 100, withOriginUrl: 90, withClickId: 0, attributed: 0 }, 0).level).toBe("ok");
  });
  it("links e cliques a chegar → a funcionar", () => {
    expect(attributionHealth({ siteBookings: 100, withOriginUrl: 95, withClickId: 22, attributed: 20 }, 500).level).toBe("ok");
  });

  it("a Google conta muito mais conversões do que as reservas que ligamos → incompleta", () => {
    const q = { siteBookings: 1348, withOriginUrl: 1300, withClickId: 120, attributed: 110 };
    const h = attributionHealth(q, 24760, 480);
    expect(h.level).toBe("warning");
    expect(h.message).toContain("480 conversões");
    expect(h.message).toContain("110 reservas");
    expect(attributionHealth(q, 24760, 130).level).toBe("ok");   // 110/130 = 85% — bate certo
    expect(attributionHealth(q, 24760, 8).level).toBe("ok");     // poucas conversões: sem comparação
  });
  it("medida dos resultados: a maior entre conversões Google e reservas ligadas", () => {
    expect(adResultsMeasure(110, 480)).toEqual({ value: 480, source: "google" });
    expect(adResultsMeasure(50, 40)).toEqual({ value: 50, source: "bookings" });
  });
});
