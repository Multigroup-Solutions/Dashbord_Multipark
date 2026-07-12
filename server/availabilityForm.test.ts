import { describe, expect, it } from "vitest";
import {
  signFormToken,
  verifyFormTokenSignature,
  evaluateTokenRow,
  extractAffectedRows,
} from "./availabilityFormToken";
import { submitDaysSchema, buildFormContext, tokenErrorResponse } from "./availabilityForm";
import type { MyWeek } from "./extrasAvailability";

const secret = new TextEncoder().encode("test-form-secret-min-32-chars-long!!");
const otherSecret = new TextEncoder().encode("another-secret-min-32-chars-long-xyz");

// ─── Token: assinatura ──────────────────────────────────────────────────────

describe("signFormToken / verifyFormTokenSignature", () => {
  it("roundtrip válido devolve employeeId/weekStart/jti", async () => {
    const token = await signFormToken(42, "2026-07-13", "jti-abc", secret);
    const r = await verifyFormTokenSignature(token, secret);
    expect(r).toEqual({ ok: true, employeeId: 42, weekStart: "2026-07-13", jti: "jti-abc" });
  });

  it("token expirado → reason 'expired'", async () => {
    const token = await signFormToken(42, "2026-07-13", "jti-exp", secret, -1000); // já expirado
    const r = await verifyFormTokenSignature(token, secret);
    expect(r).toEqual({ ok: false, reason: "expired" });
  });

  it("assinatura com secret errado → reason 'invalid'", async () => {
    const token = await signFormToken(42, "2026-07-13", "jti-x", secret);
    const r = await verifyFormTokenSignature(token, otherSecret);
    expect(r).toEqual({ ok: false, reason: "invalid" });
  });

  it("token malformado → reason 'invalid'", async () => {
    expect(await verifyFormTokenSignature("não-é-um-jwt", secret)).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyFormTokenSignature("", secret)).toEqual({ ok: false, reason: "invalid" });
  });
});

// ─── Token: estado do jti persistido + single-use ───────────────────────────

describe("evaluateTokenRow (jti desconhecido / consumido)", () => {
  it("linha ausente → unknown", () => {
    expect(evaluateTokenRow(undefined)).toBe("unknown");
    expect(evaluateTokenRow(null)).toBe("unknown");
  });
  it("usedAt preenchido → used", () => {
    expect(evaluateTokenRow({ usedAt: "2026-07-09 10:00:00" })).toBe("used");
  });
  it("usedAt null → ok", () => {
    expect(evaluateTokenRow({ usedAt: null })).toBe("ok");
  });
});

describe("extractAffectedRows (single-use à prova de duplo-submit)", () => {
  it("UPDATE que marcou 1 linha → 1 (consumo bem-sucedido)", () => {
    expect(extractAffectedRows([{ affectedRows: 1 }])).toBe(1);
    expect(extractAffectedRows({ affectedRows: 1 })).toBe(1);
  });
  it("segunda submissão (WHERE usedAt IS NULL) afeta 0 linhas → 0 (rejeitado)", () => {
    expect(extractAffectedRows([{ affectedRows: 0 }])).toBe(0);
    expect(extractAffectedRows(undefined)).toBe(0);
  });
});

// ─── Mapeamento de erros de token → HTTP distinguível ───────────────────────

describe("tokenErrorResponse", () => {
  it("expired → 410 token_expired", () => {
    expect(tokenErrorResponse("expired")).toMatchObject({ status: 410, code: "token_expired" });
  });
  it("used → 410 token_already_used", () => {
    expect(tokenErrorResponse("used")).toMatchObject({ status: 410, code: "token_already_used" });
  });
  it("invalid → 401 token_invalid", () => {
    expect(tokenErrorResponse("invalid")).toMatchObject({ status: 401, code: "token_invalid" });
  });
});

// ─── Validação zod do submit ────────────────────────────────────────────────

describe("submitDaysSchema", () => {
  it("aceita dias válidos", () => {
    const r = submitDaysSchema.safeParse([
      { day: "2026-07-13", morning: true, night: false, fromHour: 8, toHour: 20, note: "ok" },
      { day: "2026-07-14" },
    ]);
    expect(r.success).toBe(true);
  });
  it("rejeita formato de dia inválido", () => {
    expect(submitDaysSchema.safeParse([{ day: "13/07/2026" }]).success).toBe(false);
  });
  it("rejeita horas fora de 0-23", () => {
    expect(submitDaysSchema.safeParse([{ day: "2026-07-13", fromHour: 24 }]).success).toBe(false);
    expect(submitDaysSchema.safeParse([{ day: "2026-07-13", toHour: -1 }]).success).toBe(false);
  });
  it("rejeita mais de 7 dias", () => {
    const days = Array.from({ length: 8 }, (_, i) => ({ day: `2026-07-1${i}` }));
    expect(submitDaysSchema.safeParse(days).success).toBe(false);
  });
});

// ─── Context builder: shape mínimo (sem campos sensíveis) ───────────────────

describe("buildFormContext", () => {
  const myWeek: MyWeek = {
    weekStart: "2026-07-13",
    weekEnd: "2026-07-19",
    submitted: false,
    days: [
      { day: "2026-07-13", label: "Segunda 13/07", morning: false, night: false, fromHour: null, toHour: null, note: null },
    ],
  };

  it("devolve só primeiro nome + a semana; sem email/telefone/id", () => {
    const ctx = buildFormContext("João Manuel Silva", myWeek);
    expect(ctx.firstName).toBe("João");
    expect(Object.keys(ctx).sort()).toEqual(["days", "firstName", "submitted", "weekEnd", "weekStart"]);
    // Garante ausência de campos sensíveis
    const json = JSON.stringify(ctx);
    expect(json).not.toMatch(/email/i);
    expect(json).not.toMatch(/phone|telefone/i);
    expect(json).not.toMatch(/employeeId|"id"/);
  });

  it("nome vazio → firstName vazio (sem crashar)", () => {
    expect(buildFormContext(null, myWeek).firstName).toBe("");
  });
});
