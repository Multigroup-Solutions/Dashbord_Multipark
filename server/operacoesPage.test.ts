import { describe, expect, it } from "vitest";
import { PARK_CONFIGS } from "./multipark";
import { isOwnBrand, originGroupOf, bookingCityKey } from "../shared/originGroup";
import { cohortCancelRate, joinOpsDaily, periodByCity, ratio } from "../shared/operationsDaily";
import { lisbonDaySql, lisbonOffsetSegments } from "../shared/lisbonDay";
import { legacyOverriddenByApi } from "./integrations/googleAds/adMetrics";
import { aggregateScan, enrichScanRow, type ScanRow } from "./operationsBookingsCore";
import { aggregateExtrasCost, countedExtrasCost } from "./finance/extrasCost";
import { scopeCityQuery } from "./cityAccess";

describe("grupo de origem (Lisboa / Porto / Faro / Marketplace)", () => {
  it("marcas próprias vão para a cidade; todas as outras (incl. Top Parking) para Marketplace", () => {
    for (const p of PARK_CONFIGS) {
      const g = originGroupOf({ parkName: p.name, city: p.city });
      if (["Airpark", "Redpark", "Skypark"].includes(p.name)) {
        expect(g).toBe(({ Lisboa: "lisboa", Porto: "porto", Faro: "faro" } as Record<string, string>)[p.city]);
      } else {
        expect(g, p.name).toBe("marketplace");
      }
    }
    expect(originGroupOf({ parkName: "Top Parking", city: "Porto" })).toBe("marketplace");
  });
  it("marca desconhecida deriva do nome; cidade do parkName quando falta city", () => {
    expect(isOwnBrand("Air Park Faro")).toBe(true);
    expect(originGroupOf({ parkName: "Air Park Faro", city: null })).toBe("faro");
    expect(originGroupOf({ parkName: "SkyPark", city: "Lisbon" })).toBe("lisboa");
    expect(originGroupOf({ parkName: "Novo Parque XPTO", city: "Lisboa" })).toBe("marketplace");
    expect(originGroupOf({ parkName: null, city: "Porto" })).toBe("marketplace");
    expect(originGroupOf({ parkName: "Redpark", city: "Vila Nova de Gaia" })).toBe("sem_cidade");
    expect(bookingCityKey({ parkName: "Readypark", city: "Faro" })).toBe("faro");
  });
});

describe("taxa de cancelamento por coorte", () => {
  it("canceladas das criadas ÷ criadas; sem criadas → null; nunca >100%", () => {
    expect(cohortCancelRate(200, 30)).toBeCloseTo(0.15);
    expect(cohortCancelRate(0, 5)).toBeNull();
    expect(cohortCancelRate(10, 20)).toBe(1);
  });
});

describe("série diária: reservas × publicidade × extras", () => {
  const days = joinOpsDaily({
    startDate: "2026-09-01", endDate: "2026-09-03",
    bookings: [
      { day: "2026-09-01", group: "lisboa", cityKey: "lisboa", count: 10, revenue: 500 },
      { day: "2026-09-01", group: "marketplace", cityKey: "lisboa", count: 5, revenue: 200 },
      { day: "2026-09-02", group: "porto", cityKey: "porto", count: 4, revenue: 160 },
      { day: "2026-08-31", group: "porto", cityKey: "porto", count: 99, revenue: 9 }, // fora do intervalo
    ],
    ads: [{ day: "2026-09-01", city: "lisboa", cost: 50 }, { day: "2026-09-02", city: "porto", cost: 20 }],
    extras: [{ day: "2026-09-01", city: "lisboa", cost: 150 }],
  });
  it("preenche todos os dias e junta por dia × cidade", () => {
    expect(days.map((d) => d.day)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(days[0].total).toBe(15);
    expect(days[0].byGroup.lisboa).toBe(10);
    expect(days[0].byCity.lisboa).toBe(15); // marketplace de Lisboa conta na cidade física
    expect(days[0].ads).toBe(50);
    expect(days[2].ads).toBe(0);
    expect(days[0].extras).toBe(150);
  });
  it("custo/reserva usa as marcas próprias; € extras/operação usa a cidade física", () => {
    const lx = periodByCity(days).find((c) => c.city === "lisboa")!;
    expect(lx.costPerBooking).toBe(5);       // 50 € ÷ 10 reservas próprias
    expect(lx.roas).toBe(10);                // 500 ÷ 50
    expect(lx.extrasPerOp).toBe(10);         // 150 ÷ 15 operações
    const fa = periodByCity(days).find((c) => c.city === "faro")!;
    expect(fa.costPerBooking).toBeNull();
  });
  it("sem permissão (null) as linhas de custo ficam null", () => {
    const d = joinOpsDaily({ startDate: "2026-09-01", endDate: "2026-09-01", bookings: [], ads: null, extras: null });
    expect(d[0].ads).toBeNull();
    expect(d[0].extras).toBeNull();
    expect(ratio(5, 0)).toBeNull();
  });
});

describe("dia de Lisboa no SQL", () => {
  it("sem mudança de hora: um só offset", () => {
    expect(lisbonOffsetSegments("2026-09-01", "2026-09-30")).toEqual([{ offsetHours: 1, untilUtc: null }]);
    expect(lisbonDaySql("c", "2026-09-01", "2026-09-30")).toBe("DATE(DATE_ADD(c, INTERVAL 1 HOUR))");
  });
  it("atravessa a mudança de outubro (01:00 UTC)", () => {
    expect(lisbonOffsetSegments("2026-10-20", "2026-10-31")).toEqual([
      { offsetHours: 1, untilUtc: "2026-10-25 01:00:00" },
      { offsetHours: 0, untilUtc: null },
    ]);
    expect(lisbonDaySql("c", "2026-10-20", "2026-10-31")).toContain("WHEN c < '2026-10-25 01:00:00' THEN 1 ELSE 0");
  });
  it("atravessa a de março", () => {
    expect(lisbonOffsetSegments("2026-03-01", "2026-04-05")).toEqual([
      { offsetHours: 0, untilUtc: "2026-03-29 01:00:00" },
      { offsetHours: 1, untilUtc: null },
    ]);
  });
});

describe("publicidade: legado vs API por plataforma", () => {
  const apiDays = new Set(["2026-09-01"]);
  it("Google legado cai nos dias com API; Meta conta sempre", () => {
    expect(legacyOverriddenByApi("google_ads", "2026-09-01", apiDays)).toBe(true);
    expect(legacyOverriddenByApi("google_ads", "2026-09-02", apiDays)).toBe(false);
    expect(legacyOverriddenByApi("meta_ads", "2026-09-01", apiDays)).toBe(false);
    expect(legacyOverriddenByApi("instagram", "2026-09-01", apiDays)).toBe(false);
  });
});

describe("folhas: filtros e totais no servidor", () => {
  const base = { originUrl: null, campaign: null, totalPrice: "10", remainingToPay: 0, totalPaid: 0, paymentMethod: null, day: "2026-09-01" };
  const rows: ScanRow[] = [
    { ...base, id: 1, status: "BOOKED", parkName: "Airpark", city: "Lisboa", origin: "MANUAL" },
    { ...base, id: 2, status: "CANCELLED", parkName: "Airpark", city: "Lisboa", origin: "GENERAL_FORM" },
    { ...base, id: 3, status: "BOOKED", parkName: "Top Parking", city: "Porto", origin: "MARKETPLACE" },
    { ...base, id: 4, status: "BOOKED", parkName: "Redpark", city: "Porto", origin: "API", originUrl: "https://redpark.pt", campaign: "parc" },
  ];
  const partners = new Map([["parc", { name: "Parceiro X", commissionRate: 10 }]]);
  const enriched = rows.map((r) => enrichScanRow(r, partners));
  it("criadas = todas; não canceladas à parte; origens por grupo com canal", () => {
    const a = aggregateScan(enriched, { action: "creation" });
    expect(a.total).toBe(4);
    expect(a.cancelled).toBe(1);
    expect(a.active).toBe(3);
    expect(a.summary.revenue).toBe(30);
    expect(a.summary.partnerTotal).toBe(1);
    const lx = a.origins.find((o) => o.group === "lisboa")!;
    expect(lx.count).toBe(2);
    expect(lx.channels.map((c) => c.channel).sort()).toEqual(["site", "telefone"]);
    expect(a.origins.find((o) => o.group === "porto")!.channels[0].channel).toBe("parceiro");
    expect(a.origins.some((o) => o.group === "sem_cidade")).toBe(false);
  });
  it("filtro de grupo/canal/estado muda a lista mas não o gráfico", () => {
    const a = aggregateScan(enriched, { action: "creation", group: "marketplace" });
    expect(a.total).toBe(1);
    expect(a.daily.reduce((s, d) => s + d.count, 0)).toBe(4);
    expect(aggregateScan(enriched, { action: "creation", channel: "telefone" }).total).toBe(1);
    expect(aggregateScan(enriched, { action: "creation", state: "cancelled" }).total).toBe(1);
  });
});

describe("custo dos extras (fonte única com o motor)", () => {
  const rates = { junior: 10, senior: 12 };
  const agg = aggregateExtrasCost({
    assignments: [
      { date: "2026-09-25", city: "porto", level: "junior", isTeamLeader: 0, startHour: 8, endHour: 16, sentHomeHour: null },
      { date: "2026-09-25", city: "porto", level: "senior", isTeamLeader: 1, startHour: 8, endHour: 16, sentHomeHour: null },
    ],
    ponto: [
      { recordedAt: "2026-09-20 17:00:00", hours: "8", level: 1, employeeId: 1, projectId: 10 },
      { recordedAt: "2026-09-20 18:00:00", hours: "4", level: 2, employeeId: 2, projectId: 20 },
    ],
  }, rates, { dayOfRecord: (v) => String(v).slice(0, 10), cityOfProject: (p) => (p === 10 ? "lisboa" : p === 20 ? "faro" : null) });
  it("real por cidade da ficha; previsto pela escala sem team leaders", () => {
    expect(agg.byDayCity.get("2026-09-20|lisboa")!.real).toBe(80);
    expect(agg.byDayCity.get("2026-09-20|faro")!.real).toBe(48);
    expect(agg.byDayCity.get("2026-09-25|porto")!.planned).toBe(80);
    expect(agg.teamLeaderShifts).toBe(1);
    expect(agg.realByDay.get("2026-09-20")).toBe(128);
  });
  it("conta o real até hoje e o previsto depois", () => {
    expect(countedExtrasCost("2026-09-20", "2026-09-24", 80, 999)).toBe(80);
    expect(countedExtrasCost("2026-09-25", "2026-09-24", 0, 80)).toBe(80);
  });
});

describe("âmbito de cidade", () => {
  it("as novas consultas e os Serviços recebem a cidade do utilizador", () => {
    const access = { all: false, defaultCityId: 7, cityIds: [7], projectIds: [7, 8], missingCostCenter: false, cityName: "Porto" };
    for (const path of ["multipark.extrasCostDaily", "multipark.adSpendDaily", "services.multiparkExtras", "multipark.localBookingsByAction"]) {
      expect((scopeCityQuery(path, access, { startDate: "2026-09-01" }) as any).projectId).toBe(7);
    }
  });
});
