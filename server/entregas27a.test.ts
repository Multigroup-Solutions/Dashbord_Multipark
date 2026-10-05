/**
 * P3 lote 27a — onde é cada serviço (Jorge, 5 out 2026): "Porto só há no
 * aeroporto; Faro a única exceção é a estação de comboios; Lisboa só Oriente,
 * Sete Rios, Rossio, Entrecampos — o resto, diga o que diga, é T1 ou T2."
 * Fora do aeroporto = "Outro" (60 min por reserva, nunca forma par).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyDeliveryType } from "./extrasDia";
import { pairTerminal } from "../shared/extrasSchedule";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("27a — tipo de entrega por cidade", () => {
  it("Lisboa: só Oriente, Sete Rios, Rossio e Entrecampos são fora; o resto é T1 ou T2", () => {
    for (const dt of ["Oriente", "Estação do Oriente", "Sete Rios", "Sete-Rios", "Rossio", "Entrecampos", "Entre Campos"]) {
      expect(classifyDeliveryType(dt, "lisbon"), dt).toBe("other");
    }
    expect(classifyDeliveryType("Terminal 2", "lisbon")).toBe("t2");
    expect(classifyDeliveryType("T2 - Partidas", "lisbon")).toBe("t2");
    for (const dt of ["Terminal 1", "Partidas", "Chegadas", "Aeroporto", "Parque", "Morada do cliente", "Qualquer coisa"]) {
      expect(classifyDeliveryType(dt, "lisbon"), dt).toBe("t1");
    }
    expect(classifyDeliveryType("VIP", "lisbon")).toBe("vip");
  });

  it("Porto: tudo no aeroporto", () => {
    for (const dt of ["Aeroporto do Porto", "Partidas", "Estação de Campanhã", "Terminal 2", "Outro"]) {
      expect(classifyDeliveryType(dt, "porto"), dt).toBe("t1");
    }
  });

  it("Faro: só a estação de comboios é fora", () => {
    for (const dt of ["Estação de Comboios", "Estação CP Faro", "comboio"]) expect(classifyDeliveryType(dt, "faro"), dt).toBe("other");
    for (const dt of ["Faro", "Aeroporto de Faro", "Partidas", "Chegadas"]) expect(classifyDeliveryType(dt, "faro"), dt).toBe("t1");
  });

  it("sem tipo → desconhecido (pesa como o T1 e emparelha como o T1)", () => {
    expect(classifyDeliveryType(null, "lisbon")).toBe("unknown");
    expect(classifyDeliveryType("  ", "faro")).toBe("unknown");
    expect(pairTerminal("unknown")).toBe("t1");
    expect(pairTerminal(classifyDeliveryType("Rossio", "lisbon"))).toBeNull();
  });

  it("a previsão e os pares usam a cidade; legenda e ajuda com as estações", () => {
    const dia = src("server/extrasDia.ts");
    expect(dia.match(/classifyDeliveryType\(deliveryType, city\)/g)?.length).toBe(2);
    expect(dia.match(/pairTerminal\(classifyDeliveryType\(r\.deliveryType, city\)\)/g)?.length).toBe(2);
    expect(src("client/src/pages/ExtrasDiaPage.tsx")).toContain("Lisboa: Oriente, Sete Rios, Rossio, Entrecampos; Faro: estação");
    expect(src("docs/ajuda/extras-dia.md")).toContain("**Porto:** nada; é tudo no aeroporto.");
  });
});
