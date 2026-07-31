import { describe, expect, it } from "vitest";
import { normalizeEmail, sameEmail, isPlausibleEmail } from "../shared/email";
import { normalizePhoneE164, isValidPhone, normalizePhoneForStorage } from "../shared/phone";
import { isPlaceholderLogin } from "./identity";
import { planMerge, type DuplicateCandidate } from "./mergeDuplicateExtras";

// ─── Email = chave de identidade ────────────────────────────────────────────

describe("normalizeEmail", () => {
  it("apara espaços e passa a minúsculas", () => {
    expect(normalizeEmail("  Joao.Silva@Gmail.COM ")).toBe("joao.silva@gmail.com");
  });

  it("tolera null/undefined/não-string", () => {
    expect(normalizeEmail(null)).toBe("");
    expect(normalizeEmail(undefined)).toBe("");
    expect(normalizeEmail(42 as unknown as string)).toBe("");
  });

  it("sameEmail compara pela forma canónica e nunca casa vazios", () => {
    expect(sameEmail("A@B.PT", " a@b.pt ")).toBe(true);
    expect(sameEmail("", "")).toBe(false);
    expect(sameEmail(null, null)).toBe(false);
    expect(sameEmail("a@b.pt", "c@b.pt")).toBe(false);
  });

  it("isPlausibleEmail rejeita lixo", () => {
    expect(isPlausibleEmail("joao@multipark.pt")).toBe(true);
    expect(isPlausibleEmail("joao@localhost")).toBe(false);
    expect(isPlausibleEmail("sem-arroba.pt")).toBe(false);
    expect(isPlausibleEmail("  ")).toBe(false);
  });
});

// ─── Telefone: casos reais que antes bloqueavam o envio ─────────────────────

describe("normalizePhoneE164 — tolerância a texto livre", () => {
  it("aceita anotações à volta do número", () => {
    expect(normalizePhoneE164("912345678 (pessoal)")).toBe("+351912345678");
    expect(normalizePhoneE164("tlm 912 345 678")).toBe("+351912345678");
    expect(normalizePhoneE164("912345678 - casa")).toBe("+351912345678");
  });

  it("com dois números no mesmo campo usa o primeiro válido", () => {
    expect(normalizePhoneE164("912345678 / 913000000")).toBe("+351912345678");
    expect(normalizePhoneE164("912345678, 913000000")).toBe("+351912345678");
    expect(normalizePhoneE164("912345678 ou 913000000")).toBe("+351912345678");
    // primeiro inválido → cai para o segundo em vez de devolver null
    expect(normalizePhoneE164("sem número / +351913000000")).toBe("+351913000000");
  });

  it("limpa caracteres invisíveis e traços unicode de copy-paste", () => {
    expect(normalizePhoneE164("‎+351 912–345–678")).toBe("+351912345678");
    expect(normalizePhoneE164("﻿912345678")).toBe("+351912345678");
  });

  it("aceita o prefixo de rede escrito à mão (0 + 9 dígitos)", () => {
    expect(normalizePhoneE164("0912345678")).toBe("+351912345678");
  });

  it("mantém as regras conservadoras de indicativo", () => {
    expect(normalizePhoneE164("+351912345678")).toBe("+351912345678");
    expect(normalizePhoneE164("00351912345678")).toBe("+351912345678");
    expect(normalizePhoneE164("351912345678")).toBe("+351912345678");
    expect(normalizePhoneE164("912345678")).toBe("+351912345678");
    // sem forma segura de inferir país → null (não inventamos)
    expect(normalizePhoneE164("11912345678")).toBeNull();
    expect(normalizePhoneE164("91234567")).toBeNull();
    expect(normalizePhoneE164("abc")).toBeNull();
    expect(normalizePhoneE164("+351abc")).toBeNull();
  });

  it("isValidPhone segue normalizePhoneE164 e tolera null", () => {
    expect(isValidPhone("912345678")).toBe(true);
    expect(isValidPhone("abc")).toBe(false);
    expect(isValidPhone(null)).toBe(false);
  });
});

describe("normalizePhoneForStorage", () => {
  it("grava E.164 quando dá para normalizar", () => {
    expect(normalizePhoneForStorage(" 912 345 678 ")).toBe("+351912345678");
  });

  it("preserva o que a pessoa escreveu quando não dá", () => {
    expect(normalizePhoneForStorage("ext. 2205")).toBe("ext. 2205");
    expect(normalizePhoneForStorage("   ")).toBeNull();
    expect(normalizePhoneForStorage(null)).toBeNull();
  });

  it("respeita o limite da coluna (varchar 32)", () => {
    expect(normalizePhoneForStorage("x".repeat(60))!.length).toBe(32);
  });
});

// ─── Contas placeholder criadas pelo backoffice ─────────────────────────────

describe("isPlaceholderLogin", () => {
  it("reconhece contas criadas à mão e ainda não usadas", () => {
    expect(isPlaceholderLogin({ openId: "manual_123_abc", loginMethod: "manual" })).toBe(true);
    expect(isPlaceholderLogin({ openId: "manual_123_abc", loginMethod: null })).toBe(true);
  });

  it("não toca em contas Google já ativas nem em contas já fundidas", () => {
    expect(isPlaceholderLogin({ openId: "google_123", loginMethod: "google" })).toBe(false);
    expect(isPlaceholderLogin({ openId: "google_123", loginMethod: "merged_into_7" })).toBe(false);
  });

  it("conta manual JÁ FUNDIDA nunca volta a ser placeholder (senão cada login re-desativa a conta real)", () => {
    // Após o merge a linha mantém o openId `manual_...` mas ganha
    // loginMethod `merged_into_<id>` — não pode voltar a entrar no merge.
    expect(isPlaceholderLogin({ openId: "manual_123_abc", loginMethod: "merged_into_45" })).toBe(false);
  });
});

// ─── Plano de fusão de extras duplicados ────────────────────────────────────

function candidate(over: Partial<DuplicateCandidate> & { id: number }): DuplicateCandidate {
  return {
    fullName: `Extra ${over.id}`,
    email: "joao@multipark.pt",
    phone: null,
    nif: null,
    position: "extra",
    isActive: 1,
    userId: null,
    autoCreated: false,
    assignments: 0,
    timeRecords: 0,
    leaves: 0,
    penalties: 0,
    availabilityDays: 0,
    ...over,
  };
}

describe("planMerge", () => {
  const email = "joao@multipark.pt";

  it("não faz nada com uma só ficha", () => {
    expect(planMerge(email, [candidate({ id: 1 })])).toBeNull();
  });

  it("não funde duas fichas criadas por pessoas", () => {
    expect(planMerge(email, [candidate({ id: 1 }), candidate({ id: 2 })])).toBeNull();
  });

  it("elege a ficha humana como sobrevivente e funde a auto-criada", () => {
    const plan = planMerge(email, [
      candidate({ id: 8, autoCreated: true, availabilityDays: 5 }),
      candidate({ id: 3 }),
    ]);
    expect(plan).not.toBeNull();
    expect(plan!.survivorId).toBe(3);
    expect(plan!.loserIds).toEqual([8]);
    expect(plan!.blocked).toEqual([]);
  });

  it("bloqueia o duplicado que já tem vida operacional", () => {
    const plan = planMerge(email, [
      candidate({ id: 3 }),
      candidate({ id: 8, autoCreated: true, timeRecords: 2 }),
    ]);
    expect(plan!.loserIds).toEqual([]);
    expect(plan!.blocked).toHaveLength(1);
    expect(plan!.blocked[0].id).toBe(8);
    expect(plan!.blocked[0].reason).toContain("picagem");
  });

  it("entre duas auto-criadas mantém a que tem histórico e funde a outra", () => {
    const plan = planMerge(email, [
      candidate({ id: 9, autoCreated: true }),
      candidate({ id: 5, autoCreated: true, assignments: 3 }),
    ]);
    expect(plan!.survivorId).toBe(5);
    // o sobrevivente tem escalas; o perdedor (sem rastos) pode ser fundido
    expect(plan!.loserIds).toEqual([9]);
  });

  it("prefere a ficha ativa e, em empate, a mais antiga", () => {
    const plan = planMerge(email, [
      candidate({ id: 4, isActive: 0 }),
      candidate({ id: 6, isActive: 1 }),
      candidate({ id: 11, autoCreated: true }),
    ]);
    expect(plan!.survivorId).toBe(6);
    expect(plan!.loserIds).toEqual([11]);
    // a ficha humana inativa NÃO é fundida automaticamente
    expect(plan!.blocked.map(b => b.id)).toEqual([4]);
  });
});
