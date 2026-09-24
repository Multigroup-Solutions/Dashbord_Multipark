import { describe, expect, it } from "vitest";
import { attributionHealth } from "../shared/marketingAttribution";

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
});
