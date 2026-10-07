/**
 * Pauta do Rafael (7 out 2026), o que sobrou depois da outra sessão:
 * "cobertos" passam a TOLDOS nos ecrãs e o supervisor desativa extras
 * (como o back office e o admin) também nas Métricas dos extras.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PARKING_TYPE_LABELS } from "../shared/opsLists";
import { GARAGE_FIT_LABEL } from "../shared/garageFit";
import { LIVE_SPOT_TYPE_LABELS } from "./multiparkDb/shiftState";
import { canManageEmployee } from "./rhAccess";

const src = (p: string) => readFileSync(p, "utf8");

describe("Toldos em vez de cobertos", () => {
  it("o produto e o tipo de lugar chamam-se Toldo; o resto fica igual", () => {
    expect(PARKING_TYPE_LABELS).toMatchObject({ COVERED: "Toldo", UNCOVERED: "Descoberto", INDOOR: "Interior", VIP: "VIP" });
    expect(LIVE_SPOT_TYPE_LABELS.covered).toBe("Toldo");
    expect(GARAGE_FIT_LABEL.warn).toMatch(/^toldo numa garagem descoberta/);
  });
  it("nenhum ecrã das reservas/passagem mostra \"Coberto\" como tipo", () => {
    for (const f of [
      "client/src/lib/bookingHistoryFormat.ts",
      "client/src/components/ShiftHandoverLiveState.tsx",
      "client/src/components/ShiftHandoverDraftPanel.tsx",
      "client/src/pages/ShiftHandoverPage.tsx",
    ]) {
      expect(src(f), f).not.toMatch(/"Coberto"|>Coberto<|Coberto:|Carros p\/ coberto|lugar coberto/);
    }
    // o código vindo da Multipark (COVERED) passa pela etiqueta, não aparece em bruto
    expect(src("client/src/components/BookingDetailDialog.tsx")).toContain("PARKING_TYPE_LABELS[b.parkingType] ?? b.parkingType");
    expect(src("client/src/pages/BookingFilePage.tsx")).toContain("PARKING_TYPE_LABELS[l.allocation.parkingType] ?? l.allocation.parkingType");
  });
});

describe("Desativar extras: o supervisor também", () => {
  it("o botão das Métricas dos extras aparece ao supervisor e ao back office", () => {
    expect(src("client/src/components/ExtrasMetricsSection.tsx"))
      .toContain('const canDeactivate = ["admin", "super_admin", "supervisor", "backoffice"].includes(user?.role ?? "");');
  });
  it("o servidor deixa o supervisor só na sua cidade; o team leader nunca", () => {
    const extra = { id: 50, projectId: 7, role: "extra", position: "extra" };
    expect(canManageEmployee({ id: 1, role: "supervisor", employeeId: 2, scopeProjectIds: [7] }, extra)).toBe(true);
    expect(canManageEmployee({ id: 1, role: "supervisor", employeeId: 2, scopeProjectIds: [9] }, extra)).toBe(false);
    expect(canManageEmployee({ id: 1, role: "backoffice", employeeId: 2, scopeProjectIds: null }, extra)).toBe(true);
    expect(canManageEmployee({ id: 1, role: "team_leader", employeeId: 2, scopeProjectIds: [7] }, extra)).toBe(false);
  });
});
