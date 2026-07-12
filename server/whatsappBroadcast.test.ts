import { describe, expect, it } from "vitest";
import { resolveRecipients } from "./whatsappBroadcast";
import type { ActiveExtra } from "./extrasAvailability";

function extra(id: number, fullName: string, phone: string | null): ActiveExtra {
  return { id, fullName, email: null, phone, projectId: null };
}

const EXTRAS: ActiveExtra[] = [
  extra(1, "Ana Válida", "912345678"), // PT 9 díg → +351912345678
  extra(2, "Bruno E164", "+351911111111"), // já E.164
  extra(3, "Carlos Sem Número", null), // sem número
  extra(4, "Diana Inválida", "12"), // lixo → inválido
  extra(5, "Eva 00", "00351933333333"), // 00 → +351933333333
];

describe("resolveRecipients", () => {
  it("normaliza cada telefone e marca inválidos/ausentes com phoneE164 null", () => {
    const out = resolveRecipients(EXTRAS);
    expect(out).toHaveLength(5);
    const byId = new Map(out.map(r => [r.employeeId, r]));
    expect(byId.get(1)!.phoneE164).toBe("+351912345678");
    expect(byId.get(2)!.phoneE164).toBe("+351911111111");
    expect(byId.get(3)!.phoneE164).toBeNull(); // sem número
    expect(byId.get(3)!.phone).toBe(""); // raw normalizado para string vazia
    expect(byId.get(4)!.phoneE164).toBeNull(); // lixo
    expect(byId.get(5)!.phoneE164).toBe("+351933333333");
  });

  it("filtra pelo subset employeeIds quando fornecido", () => {
    const out = resolveRecipients(EXTRAS, [1, 5]);
    expect(out.map(r => r.employeeId)).toEqual([1, 5]);
    expect(out.every(r => r.phoneE164 !== null)).toBe(true);
  });

  it("devolve todos quando employeeIds é null ou vazio", () => {
    expect(resolveRecipients(EXTRAS, null)).toHaveLength(5);
    expect(resolveRecipients(EXTRAS, [])).toHaveLength(5);
  });

  it("preserva nome e id de cada extra", () => {
    const out = resolveRecipients(EXTRAS, [2]);
    expect(out[0]).toMatchObject({ employeeId: 2, name: "Bruno E164" });
  });

  it("um subset sem números válidos resolve para 0 válidos", () => {
    const out = resolveRecipients(EXTRAS, [3, 4]);
    expect(out.filter(r => r.phoneE164 !== null)).toHaveLength(0);
  });
});
