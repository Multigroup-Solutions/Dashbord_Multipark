/**
 * Respostas do Jorge (7 out 2026): garagens × tipo de lugar a vermelho, X dos
 * alertas do Marketing para todos, ligar agente da Multipark a um parceiro.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { garageFit, garageKind } from "../shared/garageFit";
import { summarizeBySpotType, type LiveCar } from "./multiparkDb/shiftState";

const src = (p: string) => readFileSync(p, "utf8");

describe("garagens: o que está mal arrumado", () => {
  it("tipos das garagens como o Jorge disse", () => {
    expect(garageKind("PD")).toBe("uncovered");
    expect(garageKind("PD Fora")).toBe("uncovered");
    expect(garageKind("Central")).toBe("uncovered");
    expect(garageKind("Coberto")).toBe("covered");
    expect(garageKind("CENTRAL COBERTO")).toBe("covered");
    expect(garageKind("Central  Descoberto")).toBe("uncovered");
    expect(garageKind("Garagem 3")).toBe("unknown");
    expect(garageKind(null)).toBe("unknown");
  });
  it("indoor fora da coberta e descoberto na coberta = vermelho; coberto na descoberta = aviso", () => {
    expect(garageFit("indoor", "PD")).toBe("bad");
    expect(garageFit("indoor", "Central")).toBe("bad");
    expect(garageFit("uncovered", "Coberto")).toBe("bad");
    expect(garageFit("uncovered", "Central Coberto")).toBe("bad");
    expect(garageFit("covered", "PD Fora")).toBe("warn");
    expect(garageFit("covered", "Coberto")).toBe("ok");
    expect(garageFit("indoor", "Central Coberto")).toBe("ok");
    expect(garageFit("uncovered", "PD")).toBe("ok");
    expect(garageFit("unknown", "PD")).toBe("unknown");
    expect(garageFit("indoor", "Garagem 3")).toBe("unknown");
  });
  it("o resumo por tipo marca cada garagem e conta os mal arrumados", () => {
    const car = (id: string, spotType: LiveCar["spotType"], garage: string | null): LiveCar => ({
      id, code: id, status: "PARKED", phase: "in_park", phaseSince: null, parkId: "p1", parkName: "Multipark - Lisboa", garage, spot: null,
      plate: null, clientName: null, checkIn: null, checkOut: null, covered: spotType !== "uncovered", spotType, movingAt: null,
      returnFlight: null, returnFlightEta: null, overdue: false,
    });
    const r = summarizeBySpotType([car("a", "indoor", "PD"), car("b", "indoor", "Coberto"), car("c", "covered", "PD Fora"), car("d", "uncovered", "Coberto"), car("e", "uncovered", null)]);
    const indoor = r.find((t) => t.type === "indoor")!;
    expect(indoor.misplaced).toBe(1);
    expect(indoor.byParkGarage[0].garages.find((g) => g.garage === "PD")?.fit).toBe("bad");
    expect(r.find((t) => t.type === "covered")!.warned).toBe(1);
    const unc = r.find((t) => t.type === "uncovered")!;
    expect(unc.misplaced).toBe(1);
    expect(unc.byParkGarage[0].garages.find((g) => g.garage === "Sem garagem")?.fit).toBe("unknown");
  });
  it("o ecrã pinta e lista os mal arrumados (com ícone e texto, não só cor)", () => {
    const ui = src("client/src/components/ShiftHandoverLiveState.tsx");
    expect(ui).toMatch(/function MisplacedCars/);
    expect(ui).toMatch(/g\.fit === "bad" \? "⚠ "/);
    expect(ui).toMatch(/mal arrumado/);
  });
});

describe("X dos alertas do Marketing para todos", () => {
  it("guardado no servidor, com quem e quando, e Repor sem apagar", () => {
    const mig = src("server/migrations/migration_0515.ts");
    expect(mig).toMatch(/CREATE TABLE IF NOT EXISTS \\?`alert_dismissals/);
    expect(mig).toMatch(/restoredAt/);
    expect(src("server/migrations/index.ts")).toMatch(/\["0515"/);
    const svc = src("server/alertDismissals.ts");
    expect(svc).not.toMatch(/DELETE FROM/);
    expect(svc).toMatch(/SET restoredById = .*restoredAt = /);
    const routers = src("server/routers.ts");
    const block = routers.split("dismissAlert: protectedProcedure")[1]?.slice(0, 900) ?? "";
    expect(block).toMatch(/requireAccess\(ctx\.user, "marketing", "view"\)/);
    expect(block).toMatch(/logActivity/);
    expect(routers).toMatch(/hiddenAlerts\("marketing", input\?\.projectId, month\)/);
  });
  it("o cartão já não usa o localStorage", () => {
    const ui = src("client/src/components/marketing/MarketingDashboardPanel.tsx");
    expect(ui).not.toMatch(/mp\.marketing\.alerts\.hidden/);
    expect(ui).toMatch(/trpc\.marketing\.dismissAlert\.useMutation/);
    expect(ui).toMatch(/Não deu para ler os alertas tirados/);
  });
});

describe("ligar agente da Multipark a um parceiro", () => {
  it("ver = Parcerias (ver); procurar/ligar = Parcerias (gerir)", () => {
    const routers = src("server/routers.ts");
    const list = routers.split("partnerAgents: protectedProcedure")[1]?.slice(0, 500) ?? "";
    expect(list).toMatch(/requireAccess\(ctx\.user, "parcerias", "view"\)/);
    const search = routers.split("searchAgentsForPartner: protectedProcedure")[1]?.slice(0, 500) ?? "";
    expect(search).toMatch(/requireAccess\(ctx\.user, "parcerias", "manage"\)/);
    const set = routers.split("setAgentPartner: protectedProcedure")[1]?.slice(0, 400) ?? "";
    expect(set).toMatch(/requireAccess\(ctx\.user, "parcerias", "manage"\)/);
  });
  it("a ficha do parceiro tem o cartão com Ligar agente", () => {
    expect(src("client/src/pages/CrmPartnerPage.tsx")).toMatch(/<PartnerAgentsCard /);
    const card = src("client/src/components/crm/PartnerAgentsCard.tsx");
    expect(card).toMatch(/Ligar agente/);
    expect(card).toMatch(/trpc\.multipark\.setAgentPartner\.useMutation/);
  });
});

describe("back office gere o RH a nível nacional, sem ordenados", async () => {
  const { can } = await import("../shared/access");
  const { canManageEmployee, contractEditError, createEmployeeError } = await import("./rhAccess");
  const bo = { id: 5, role: "backoffice", employeeId: 50, scopeProjectIds: null };
  it("matriz: rh gerir nacional; ordenados não; front office continua sem gerir", () => {
    expect(can({ id: 1, role: "backoffice" } as any, "rh", "manage")).toBe(true);
    expect(can({ id: 1, role: "backoffice" } as any, "rh_salarios", "view")).toBe(false);
    expect(can({ id: 1, role: "frontoffice" } as any, "rh", "manage")).toBe(false);
  });
  it("gere fichas de qualquer cidade abaixo do supervisor; nunca a dele nem a de um supervisor", () => {
    expect(canManageEmployee(bo, { id: 7, projectId: 99, role: "condutor", position: "driver" })).toBe(true);
    expect(canManageEmployee(bo, { id: 8, projectId: null, role: null, position: "extra" })).toBe(true);
    expect(canManageEmployee(bo, { id: 9, projectId: 99, role: "supervisor", position: "supervisor" })).toBe(false);
    expect(canManageEmployee(bo, { id: 50, projectId: 99, role: "backoffice", position: "backoffice" })).toBe(false);
  });
  it("contrato e criar: sem salário nem conta, postos abaixo do supervisor, qualquer centro", () => {
    const e = { id: 7, projectId: 99, role: "condutor", position: "driver" };
    expect(contractEditError(bo, e, { position: "team_leader", projectId: 123 })).toBeNull();
    expect(contractEditError(bo, e, { monthlySalary: 900 })).toMatch(/salário/);
    expect(contractEditError(bo, e, { position: "supervisor" })).toMatch(/abaixo do supervisor/);
    expect(createEmployeeError(bo, { position: "extra", projectId: 123 })).toBeNull();
    expect(createEmployeeError(bo, { position: "extra", projectId: 123, monthlySalary: 800 })).toMatch(/salário/);
    expect(createEmployeeError({ ...bo, role: "frontoffice" }, { position: "extra", projectId: 123 })).toMatch(/back office/);
  });
});
