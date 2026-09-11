import { describe, expect, it } from "vitest";
import {
  DEACTIVATION_NOTES_MAX,
  DEACTIVATION_REASONS,
  DEACTIVATION_REASON_CODES,
  DEACTIVATION_REASON_LABELS,
  DEACTIVATION_REASON_OTHER_MAX,
  DEFAULT_DEACTIVATION_REASON,
  deactivationReasonLabel,
  isDeactivationReason,
  resolveDeactivation,
} from "../shared/deactivationReasons";

describe("vocabulário dos motivos de desativação", () => {
  it("o motivo por defeito é Inatividade e vem primeiro na lista", () => {
    expect(DEFAULT_DEACTIVATION_REASON).toBe("inatividade");
    expect(DEACTIVATION_REASONS[0]).toEqual({ code: "inatividade", label: "Inatividade" });
  });

  it("todos os códigos têm etiqueta e não há repetidos", () => {
    expect(DEACTIVATION_REASONS).toHaveLength(DEACTIVATION_REASON_CODES.length);
    expect(new Set(DEACTIVATION_REASON_CODES).size).toBe(DEACTIVATION_REASON_CODES.length);
    for (const code of DEACTIVATION_REASON_CODES) {
      expect(DEACTIVATION_REASON_LABELS[code]).toBeTruthy();
    }
  });

  it("os motivos pedidos pelo Jorge existem", () => {
    expect(DEACTIVATION_REASON_LABELS.fora_do_pais).toBe("Está fora do país");
    expect(DEACTIVATION_REASON_LABELS.trabalha_mal).toBe("Trabalha mal");
    expect(DEACTIVATION_REASON_LABELS.roubou).toBe("Roubou");
    expect(DEACTIVATION_REASON_LABELS.outro).toBe("Outro");
  });

  it("isDeactivationReason só aceita códigos da lista", () => {
    expect(isDeactivationReason("roubou")).toBe(true);
    expect(isDeactivationReason("qualquer-coisa")).toBe(false);
    expect(isDeactivationReason(null)).toBe(false);
  });
});

describe("deactivationReasonLabel", () => {
  it("sem motivo devolve vazio", () => {
    expect(deactivationReasonLabel(null)).toBe("");
    expect(deactivationReasonLabel(undefined)).toBe("");
  });

  it("outro mostra o texto livre; sem texto mostra Outro", () => {
    expect(deactivationReasonLabel("outro", "Mudou-se para o Brasil")).toBe("Mudou-se para o Brasil");
    expect(deactivationReasonLabel("outro", "   ")).toBe("Outro");
  });

  it("um código desconhecido devolve-se tal e qual (nunca deixa a UI em branco)", () => {
    expect(deactivationReasonLabel("motivo_antigo")).toBe("motivo_antigo");
  });
});

describe("resolveDeactivation", () => {
  it("sem motivo nem notas assume Inatividade", () => {
    const r = resolveDeactivation();
    expect(r.reason).toBe("inatividade");
    expect(r.reasonOther).toBeNull();
    expect(r.notes).toBeNull();
    expect(r.label).toBe("Inatividade");
    expect(r.summary).toBe("Inatividade");
  });

  it("motivo vazio conta como ausente", () => {
    expect(resolveDeactivation({ reason: "   ", notes: "" }).reason).toBe("inatividade");
  });

  it("guarda o motivo e as notas, com o resumo para o histórico", () => {
    const r = resolveDeactivation({ reason: "roubou", notes: "  Faltou dinheiro na caixa  " });
    expect(r.reason).toBe("roubou");
    expect(r.notes).toBe("Faltou dinheiro na caixa");
    expect(r.summary).toBe("Roubou · Notas: Faltou dinheiro na caixa");
  });

  it("recusa um motivo fora da lista", () => {
    expect(() => resolveDeactivation({ reason: "porque_sim" })).toThrow(/inválido/);
  });

  it("com Outro exige o texto livre", () => {
    expect(() => resolveDeactivation({ reason: "outro" })).toThrow(/"Outro"/);
    expect(() => resolveDeactivation({ reason: "outro", reasonOther: "  " })).toThrow(/"Outro"/);
    const r = resolveDeactivation({ reason: "outro", reasonOther: " Foi para a concorrência " });
    expect(r.reasonOther).toBe("Foi para a concorrência");
    expect(r.label).toBe("Foi para a concorrência");
  });

  it("descarta o texto livre quando o motivo não é Outro", () => {
    const r = resolveDeactivation({ reason: "faltas", reasonOther: "sobra de outro motivo" });
    expect(r.reasonOther).toBeNull();
  });

  it("recusa texto livre e notas acima do limite das colunas", () => {
    expect(() => resolveDeactivation({ reason: "outro", reasonOther: "x".repeat(DEACTIVATION_REASON_OTHER_MAX + 1) })).toThrow(/máximo/);
    expect(() => resolveDeactivation({ notes: "x".repeat(DEACTIVATION_NOTES_MAX + 1) })).toThrow(/máximo/);
    expect(resolveDeactivation({ notes: "x".repeat(DEACTIVATION_NOTES_MAX) }).notes).toHaveLength(DEACTIVATION_NOTES_MAX);
  });
});
