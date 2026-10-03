import { describe, expect, it } from "vitest";
import { planBatch, type BookingRow, type ExistingClient } from "./plan";

const row = (id: string, p: Partial<BookingRow> = {}): BookingRow => ({
  externalId: id, firstName: "Marta", lastName: "Silva", email: "marta.silva@exemplo.pt", phone: "912000000", nif: null,
  plate: "AA-12-BB", brand: "Peugeot", model: "3008", color: "vermelho", vehicleType: "CAR",
  partnerId: null, partnerName: null, pro: false, origin: "API", seenAt: `2026-09-0${id.slice(-1)} 10:00:00`, ...p,
});

describe("crm — plano de um lote", () => {
  it("1.ª vez cria ficha; a 2.ª reserva do mesmo cliente no lote liga (email + telefone)", () => {
    const p = planBatch([row("b1"), row("b2")], new Set(), new Map(), []);
    expect(p.newClients).toHaveLength(1);
    expect(p.links.map((l) => l.rule)).toEqual(["new", "email+name"]);
    expect(p.links[0].clientId).toBe(p.links[1].clientId);
    expect(p.emails).toHaveLength(1);
    expect(p.vehicles[0]).toMatchObject({ plate: "AA12BB", plateDisplay: "AA-12-BB", color: "vermelho" });
  });

  it("mesmo email mas outra pessoa (nome, telefone e carro diferentes) → ficha nova", () => {
    const p = planBatch([row("b1"), row("b2", { firstName: "Rui", lastName: "Costa", phone: "936000000", plate: "45-TR-89" })], new Set(), new Map(), []);
    expect(p.newClients).toHaveLength(2);
  });

  it("liga a ficha existente e acrescenta o email novo", () => {
    const existing: ExistingClient = { id: 42, displayName: "Marta Silva", names: ["Marta Silva"], emails: ["marta.silva@exemplo.pt"], phones: ["+351912000000"], plates: [] };
    // 21c (regra do dono): o mesmo nome + o mesmo telefone liga, mesmo com outro email — e o email novo entra na ficha
    const p = planBatch([row("b3", { email: "marta.s@trabalho.pt" })], new Set(), new Map(), [existing]);
    expect(p.newClients).toHaveLength(0);
    expect(p.links[0]).toMatchObject({ clientId: 42, rule: "phone+name" });
    expect(p.emails).toEqual([expect.objectContaining({ clientId: 42, email: "marta.s@trabalho.pt" })]);
    const p2 = planBatch([row("b4")], new Set(), new Map(), [existing]);
    expect(p2.links[0]).toMatchObject({ clientId: 42, rule: "email+name" });
    expect(p2.vehicles[0].clientId).toBe(42);
    expect(p2.touched[0]).toMatchObject({ clientId: 42, displayName: "Marta Silva" });
  });

  it("reserva já ligada fica onde está", () => {
    const p = planBatch([row("b5")], new Set(), new Map([["b5", 7]]), []);
    expect(p.links[0]).toMatchObject({ clientId: 7, rule: "kept" });
    expect(p.newClients).toHaveLength(0);
  });

  it("email genérico (agregador) não liga e fica marcado; o telefone + nome liga", () => {
    const generic = new Set(["reservas@agregador.com"]);
    const p = planBatch([
      row("b1", { email: "reservas@agregador.com", partnerId: "p1", partnerName: "Parkos" }),
      row("b2", { email: "reservas@agregador.com", firstName: "Rui", lastName: "Costa", phone: "936000000", plate: "45TR89" }),
      row("b3", { email: "reservas@agregador.com" }),
    ], generic, new Map(), []);
    expect(p.newClients).toHaveLength(2);
    expect(p.newClients[0]).toMatchObject({ primaryEmail: null, originPartnerName: "Parkos" });
    expect(p.links[2].rule).toBe("phone+name");
    expect(p.emails.every((e) => e.generic)).toBe(true);
    expect(p.stats.genericEmails).toBe(3);
  });
});
