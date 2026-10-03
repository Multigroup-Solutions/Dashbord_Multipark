import { describe, expect, it } from "vitest";
import {
  decideLink, emailKey, isGenericEmail, nameKey, namesMatch, nameSimilarity, nifKey, phoneKey, plateKey, scoreSuggestion,
  type Candidate, type Observation,
} from "../../shared/crmIdentity";

const obs = (p: Partial<Observation> = {}): Observation => ({
  email: "marta.silva@exemplo.pt", emailGeneric: false, phone: "+351912000000", plate: "AA12BB", name: "Marta Silva", ...p,
});
const cand = (p: Partial<Candidate> = {}): Candidate => ({
  id: 1, names: ["Marta Silva"], emails: ["marta.silva@exemplo.pt"], phones: ["+351912000000"], plates: ["AA12BB"], ...p,
});

describe("crm — normalização", () => {
  it("email, telefone, matrícula e NIF", () => {
    expect(emailKey("  Marta.Silva@Exemplo.PT ")).toBe("marta.silva@exemplo.pt");
    expect(emailKey("sem-arroba")).toBe("");
    expect(phoneKey("912 000 000")).toBe("+351912000000");
    expect(phoneKey("")).toBe("");
    expect(plateKey("aa-12-bb")).toBe("AA12BB");
    expect(plateKey("x")).toBe("");
    expect(nifKey("PT 123 456 789")).toBe("123456789");
    expect(nifKey("000000000")).toBe("");
  });
  it("nomes: acentos, partículas, iniciais", () => {
    expect(nameKey("José da Silva Gonçalves")).toBe("jose goncalves");
    expect(namesMatch("Marta Silva", "MARTA  SILVA")).toBe(true);
    expect(namesMatch("Marta Silva", "M. Silva")).toBe(true);
    expect(namesMatch("Marta Sofia Silva", "Marta Silva")).toBe(true);
    expect(namesMatch("Marta Silva", "Rui Silva")).toBe(false);
    expect(namesMatch("Marta", "Marta Silva")).toBe(false);
    expect(nameSimilarity("Marta Silva", "Marta Silva")).toBe(1);
    expect(nameSimilarity("Marta Silva", "Rui Costa")).toBe(0);
  });
  it("emails genéricos: domínios da casa e muitos nomes", () => {
    expect(isGenericEmail("reservas@airpark.pt")).toBe(true);
    expect(isGenericEmail("balcao@exemplo.pt", { distinctNames: 12 })).toBe(true);
    expect(isGenericEmail("marta@exemplo.pt", { distinctNames: 2 })).toBe(false);
    expect(isGenericEmail("")).toBe(true);
  });
});

describe("crm — ligar sozinho (regras do dono, 21c)", () => {
  it("mesmo nome + email, telefone ou matrícula ligam", () => {
    expect(decideLink(obs(), [cand()])).toEqual({ clientId: 1, rule: "email+name" });
    expect(decideLink(obs({ email: "" }), [cand()]).rule).toBe("phone+name");
    expect(decideLink(obs({ email: "", phone: "" }), [cand()]).rule).toBe("plate+name");
  });
  it("nome diferente: só com o mesmo email E o mesmo telefone", () => {
    expect(decideLink(obs({ name: "Alice Costa" }), [cand()]).rule).toBe("email+phone");
    expect(decideLink(obs({ name: "Alice Costa", phone: "" }), [cand()]).clientId).toBeNull();
    expect(decideLink(obs({ name: "Alice Costa", email: "" }), [cand()]).clientId).toBeNull();
  });
  it("o email sozinho não chega", () => {
    expect(decideLink(obs({ phone: "+351936000000", plate: "ZZ99ZZ", name: "Rui Costa" }), [cand()]).clientId).toBeNull();
  });
  it("nunca liga só pelo nome", () => {
    expect(decideLink(obs({ email: "", phone: "", plate: "" }), [cand()]).clientId).toBeNull();
  });
  it("email genérico não conta; telefone + nome liga, telefone + matrícula com outro nome não", () => {
    const o = obs({ email: "reservas@agregador.com", emailGeneric: true });
    expect(decideLink(o, [cand({ emails: ["reservas@agregador.com"] })]).rule).toBe("phone+name");
    expect(decideLink(obs({ email: "", name: "Outro Nome" }), [cand()]).clientId).toBeNull();
  });
  it("com outro email próprio, o mesmo nome + telefone liga (regra do dono)", () => {
    expect(decideLink(obs({ email: "outra@exemplo.pt" }), [cand()]).rule).toBe("phone+name");
  });
  it("várias candidatas: mais sinais iguais, depois a mais recente", () => {
    const a = cand({ id: 1, plates: [], lastSeen: "2026-01-01" });
    const b = cand({ id: 2, lastSeen: "2025-01-01" });
    expect(decideLink(obs(), [a, b]).clientId).toBe(2);
    const c = cand({ id: 3, lastSeen: "2026-09-01" });
    expect(decideLink(obs(), [b, c]).clientId).toBe(3);
  });
});

describe("crm — sugestões", () => {
  const side = (id: number, p: Partial<Parameters<typeof scoreSuggestion>[0]> = {}) => ({
    id, name: "Marta Silva", emails: [] as string[], phones: [] as string[], plates: [] as string[], nif: null as string | null, ...p,
  });
  it("mesma matrícula + mesmo telefone + nome parecido pontua alto", () => {
    const r = scoreSuggestion(side(1, { phones: ["+351912000000"], plates: ["AA12BB"] }), side(2, { name: "M. Silva", phones: ["+351912000000"], plates: ["AA12BB"] }));
    expect(r?.reasons).toEqual(["same_phone", "same_plate", "similar_name"]);
    expect(r!.score).toBeGreaterThanOrEqual(90);
  });
  it("só o nome parecido não é sugestão", () => {
    expect(scoreSuggestion(side(1), side(2))).toBeNull();
  });
  it("nomes sem nada em comum baixam a pontuação (família, empresa)", () => {
    const same = scoreSuggestion(side(1, { plates: ["AA12BB"] }), side(2, { plates: ["AA12BB"] }))!;
    const diff = scoreSuggestion(side(1, { plates: ["AA12BB"] }), side(2, { name: "Rui Costa", plates: ["AA12BB"] }))!;
    expect(diff.score).toBeLessThan(same.score);
  });
});
