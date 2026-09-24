import { describe, expect, it } from "vitest";
import { computeStats, computeVipThreshold, frequencyDaysOf, isPartner, isShared, normalizeCity, plateKey, segmentsOf, stripTotals, toClientRow } from "./clientsCrm";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const agg = (o: Partial<Parameters<typeof toClientRow>[0]> & { email: string }) => ({
  bookings: 1, cancelled: 0, completed: 1, upcoming: 0, visitDays: o.completed ?? 1, partnerBookings: 0, distinctNames: 1, totalSpent: 50, firstCheckIn: daysAgo(3), lastCheckIn: daysAgo(3), nextCheckIn: null, cities: [] as string[], ...o,
});

describe("clientsCrm — regras de cliente", () => {
  it("média, frequência e segmentos de um recorrente VIP", () => {
    const r = toClientRow(agg({ email: "ana@x.pt", bookings: 5, cancelled: 1, completed: 4, totalSpent: 400, firstCheckIn: daysAgo(400), lastCheckIn: daysAgo(40), cities: ["Lisboa", "Porto"] }), 300, { name: "Ana Silva", phone: "9", lastPark: "Airpark" });
    expect(r.name).toBe("Ana Silva");
    expect(r.avgSpend).toBe(100);
    expect(r.frequencyDays).toBe(120);             // 360 dias / 3 intervalos
    expect(r.segments).toEqual(["recurring", "vip"]);
  });

  it("novo = 1 reserva; em risco = recorrente sem vir há 12 meses e sem reserva futura", () => {
    expect(segmentsOf(agg({ email: "n@x.pt" }), Infinity)).toEqual(["new"]);
    expect(frequencyDaysOf(agg({ email: "n@x.pt" }))).toBeNull();
    const risco = agg({ email: "r@x.pt", bookings: 3, completed: 3, totalSpent: 90, firstCheckIn: daysAgo(900), lastCheckIn: daysAgo(400) });
    expect(segmentsOf(risco, Infinity)).toEqual(["recurring", "at_risk"]);
    expect(segmentsOf({ ...risco, nextCheckIn: inDays(10) }, Infinity)).toEqual(["recurring"]);
  });

  it("parceiro = maioria das reservas via parceiro/Pro; nunca VIP e fora do limiar", () => {
    const agencia = agg({ email: "ag@x.pt", bookings: 200, completed: 190, partnerBookings: 180, totalSpent: 50_000 });
    expect(isPartner(agencia)).toBe(true);
    expect(segmentsOf(agencia, 100)).toEqual(["partner", "recurring"]);
    const particulares = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((v, i) => agg({ email: `p${i}@x.pt`, bookings: 2, completed: 2, totalSpent: v }));
    expect(computeVipThreshold([agencia, ...particulares])).toBe(900);   // percentil 90 de 10 → índice 1
    expect(computeVipThreshold([agencia])).toBe(Infinity);
  });

  it("email genérico de balcão = muitas pessoas no mesmo email; nunca VIP", () => {
    const balcao = agg({ email: "info@email.com", bookings: 2221, completed: 1900, distinctNames: 44, totalSpent: 48_995 });
    expect(isShared(balcao)).toBe(true);
    expect(segmentsOf(balcao, 197)).toEqual(["shared", "recurring"]);
    expect(isShared(agg({ email: "casal@x.pt", bookings: 12, completed: 12, distinctNames: 2 }))).toBe(false);
    expect(computeVipThreshold([balcao])).toBe(Infinity);
  });

  it("stats contam segmentos, novos a 30 dias e reservas futuras", () => {
    const all = [
      agg({ email: "a@x.pt", firstCheckIn: daysAgo(5), lastCheckIn: daysAgo(5) }),
      agg({ email: "b@x.pt", bookings: 4, completed: 4, totalSpent: 1000, firstCheckIn: daysAgo(500), lastCheckIn: daysAgo(30), nextCheckIn: inDays(5) }),
      agg({ email: "c@x.pt", bookings: 3, completed: 3, totalSpent: 10, firstCheckIn: daysAgo(900), lastCheckIn: daysAgo(400) }),
    ];
    const s = computeStats(all);
    expect(s.clients).toBe(3); expect(s.recurring).toBe(2); expect(s.atRisk).toBe(1); expect(s.newLast30d).toBe(1); expect(s.upcoming).toBe(1); expect(s.partners).toBe(0);
  });

  it("normaliza cidades e esconde totais", () => {
    expect(normalizeCity("lisbon")).toBe("Lisboa"); expect(normalizeCity(" Lisboa ")).toBe("Lisboa");
    expect(normalizeCity("porto")).toBe("Porto"); expect(normalizeCity("FARO")).toBe("Faro"); expect(normalizeCity("")).toBeNull();
    const s = stripTotals(toClientRow(agg({ email: "a@x.pt", totalSpent: 9999 }), Infinity));
    expect(s.totalSpent).toBeNull(); expect(s.avgSpend).toBeNull(); expect(s.bookings).toBe(1);
    // VIP = top 10% em gasto: também é informação financeira
    const vip = stripTotals(toClientRow(agg({ email: "v@x.pt", bookings: 3, completed: 3, totalSpent: 9999 }), 100));
    expect(vip.segments).toEqual(["recurring"]);
  });

  it("frequência só com estadias, por dias distintos (reservas futuras não contam)", () => {
    // 2 estadias passadas (há 100 e há 40 dias) + 1 reserva futura
    const a = agg({ email: "f@x.pt", bookings: 3, completed: 2, visitDays: 2, upcoming: 1, firstCheckIn: daysAgo(100), lastCheckIn: daysAgo(40), nextCheckIn: inDays(10) });
    expect(frequencyDaysOf(a)).toBe(60);
    // duas reservas no mesmo dia (dois carros) = um só dia de estadia
    expect(frequencyDaysOf(agg({ email: "g@x.pt", bookings: 2, completed: 2, visitDays: 1 }))).toBeNull();
  });

  it("novo ignora canceladas; só com reserva futura não tem estadias", () => {
    expect(segmentsOf(agg({ email: "c@x.pt", bookings: 1, cancelled: 1, completed: 0, visitDays: 0, totalSpent: null }), Infinity)).toEqual([]);
    expect(segmentsOf(agg({ email: "d@x.pt", bookings: 2, cancelled: 1, completed: 1 }), Infinity)).toEqual(["new"]);
    const futuro = toClientRow(agg({ email: "e@x.pt", completed: 0, visitDays: 0, upcoming: 1, totalSpent: null, firstCheckIn: null, lastCheckIn: null, nextCheckIn: inDays(20) }), Infinity);
    expect(futuro.firstCheckIn).toBeNull(); expect(futuro.avgSpend).toBeNull(); expect(futuro.upcoming).toBe(1);
  });

  it("matrícula comparável ignora espaços, hífens e maiúsculas", () => {
    expect(plateKey(" aa-00 bb ")).toBe("AA00BB");
    expect(plateKey(null)).toBe("");
  });
});
