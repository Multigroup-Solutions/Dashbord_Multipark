import { describe, expect, it } from "vitest";
import { planAutofill, validDate, validIban, validNif } from "./documentAutofill";

const blank = { nif: null, birthDate: null, nationality: null, address: null, nib: null };

describe("documentAutofill", () => {
  it("valida NIF pelo dígito de controlo", () => {
    expect(validNif("123 456 789")).toBe("123456789");
    expect(validNif("123456780")).toBeNull();
    expect(validNif("12345")).toBeNull();
  });

  it("valida IBAN pelo mod 97", () => {
    expect(validIban("pt50 0002 0123 1234 5678 9015 4")).toBe("PT50000201231234567890154");
    expect(validIban("PT50000201231234567890155")).toBeNull();
  });

  it("aceita datas ISO e DD/MM/AAAA e rejeita datas impossíveis", () => {
    expect(validDate("1990-05-17")).toBe("1990-05-17");
    expect(validDate("17/05/1990")).toBe("1990-05-17");
    expect(validDate("31/02/1990")).toBeNull();
    expect(validDate("ontem")).toBeNull();
  });

  it("só preenche campos vazios e com valores válidos", () => {
    const x = { nif: "123456789", birthDate: "17/05/1990", nationality: "Portuguesa", address: "Rua das Flores 1, 1000-001 Lisboa", iban: "PT50000201231234567890154" };
    const p = planAutofill({ ...blank, nif: "999999990" }, "id_card", x);
    expect(p.patch).toEqual({ birthDate: "1990-05-17", nationality: "Portuguesa", address: "Rua das Flores 1, 1000-001 Lisboa" });
    expect(p.filled).toContain("data de nascimento");
  });

  it("o IBAN só vem do comprovativo de IBAN e a morada não vem dele", () => {
    const x = { iban: "PT50000201231234567890154", address: "Rua das Flores 1, 1000-001 Lisboa" };
    expect(planAutofill(blank, "id_card", x).patch.nib).toBeUndefined();
    expect(planAutofill(blank, "nib_proof", x).patch).toEqual({ nib: "PT50000201231234567890154" });
    expect(planAutofill(blank, "address_proof", { ...x, nif: "123456789" }).patch).toEqual({ address: "Rua das Flores 1, 1000-001 Lisboa" });
  });
});
