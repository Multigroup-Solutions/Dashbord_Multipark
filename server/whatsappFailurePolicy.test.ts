import { describe, expect, it } from "vitest";
import {
  FORM_TOKEN_PLACEHOLDER,
  TEAM_RETRY_DELAY_MS,
  UNREACHABLE_AFTER,
  classifyFailure,
  fallbackChannelFor,
  nextUndeliverableState,
  parseSendPayload,
  planTeamRetry,
  shiftDateFromNote,
  shiftStartUtc,
  withFormToken,
} from "./whatsappFailurePolicy";
import { parseWebhookPayload } from "./whatsappInbound";
import { isTeamRetryTemplate } from "../shared/whatsappTemplate";

describe("classifyFailure", () => {
  it("só 131026 e 131049 têm política própria; o resto mantém o comportamento", () => {
    expect(classifyFailure(131026)).toBe("undeliverable");
    expect(classifyFailure(131049)).toBe("marketing_limit");
    expect(classifyFailure(131047)).toBe("other");
    expect(classifyFailure(null)).toBe("other");
  });
});

describe("nextUndeliverableState", () => {
  it("marca 'sem WhatsApp' uma só vez, ao 2.º 131026 seguido", () => {
    expect(UNREACHABLE_AFTER).toBe(2);
    expect(nextUndeliverableState({ undeliverableCount: 0, unreachableAt: null })).toEqual({ undeliverableCount: 1, markUnreachable: false });
    expect(nextUndeliverableState({ undeliverableCount: 1, unreachableAt: null })).toEqual({ undeliverableCount: 2, markUnreachable: true });
    expect(nextUndeliverableState({ undeliverableCount: 2, unreachableAt: "2026-10-01 10:00:00" })).toEqual({ undeliverableCount: 3, markUnreachable: false });
  });
});

describe("shiftDateFromNote / shiftStartUtc", () => {
  it("lê o dia do turno nas notas de equipa", () => {
    expect(shiftDateFromNote("Aviso de escala 2026-10-05")).toBe("2026-10-05");
    expect(shiftDateFromNote("Morada e regras (1.º turno) 2026-10-05")).toBe("2026-10-05");
    expect(shiftDateFromNote("Morada e regras (1.º turno)")).toBeNull();
    expect(shiftDateFromNote("Pedido automático de disponibilidade")).toBeNull();
    expect(shiftDateFromNote(null)).toBeNull();
  });
  it("hora de Lisboa → UTC (verão +1h, inverno +0h; noite passa das 24)", () => {
    expect(shiftStartUtc("2026-10-05", 8).toISOString()).toBe("2026-10-05T07:00:00.000Z");
    expect(shiftStartUtc("2026-12-05", 8).toISOString()).toBe("2026-12-05T08:00:00.000Z");
    expect(shiftStartUtc("2026-12-05", 25).toISOString()).toBe("2026-12-06T01:00:00.000Z");
  });
});

describe("planTeamRetry (131049)", () => {
  const base = {
    failure: "marketing_limit" as const,
    teamTemplate: true,
    employeeId: 7,
    isRetry: false,
    hasPayload: true,
    failedAt: new Date("2026-10-02T09:00:00Z"),
    shiftStartsAt: null as Date | null,
  };
  it("mensagem de equipa: uma nova tentativa 24 h depois", () => {
    expect(planTeamRetry(base)).toEqual({ kind: "schedule", retryAt: new Date(base.failedAt.getTime() + TEAM_RETRY_DELAY_MS) });
  });
  it("só se o turno ainda não tiver começado", () => {
    expect(planTeamRetry({ ...base, shiftStartsAt: new Date("2026-10-03T07:00:00Z") })).toMatchObject({ kind: "skip" });
    expect(planTeamRetry({ ...base, shiftStartsAt: new Date("2026-10-04T07:00:00Z") })).toMatchObject({ kind: "schedule" });
  });
  it("nunca uma segunda nova tentativa; sem dados guardados também não", () => {
    expect(planTeamRetry({ ...base, isRetry: true })).toMatchObject({ kind: "skip" });
    expect(planTeamRetry({ ...base, hasPayload: false })).toMatchObject({ kind: "skip" });
  });
  it("131026, templates que não são de equipa e números sem ficha: sem nova tentativa", () => {
    expect(planTeamRetry({ ...base, failure: "undeliverable" })).toEqual({ kind: "none" });
    expect(planTeamRetry({ ...base, teamTemplate: false })).toEqual({ kind: "none" });
    expect(planTeamRetry({ ...base, employeeId: null })).toEqual({ kind: "none" });
  });
  it("catálogo: equipa = disponibilidade, aviso de trabalho, morada e regras; recrutamento não", () => {
    expect(isTeamRetryTemplate("disponibilidade_extras")).toBe(true);
    expect(isTeamRetryTemplate("aviso_de_trabalho")).toBe(true);
    expect(isTeamRetryTemplate("morada_e_regras")).toBe(true);
    expect(isTeamRetryTemplate("seja_motorista")).toBe(false);
    expect(isTeamRetryTemplate("alerta_operacional")).toBe(false);
  });
});

describe("fallbackChannelFor", () => {
  it("aviso de escala → email da escala; pedido de disponibilidade → email do pedido; resto → sem equivalente", () => {
    expect(fallbackChannelFor({ templateName: "aviso_de_trabalho", note: "Aviso de escala 2026-10-05", employeeId: 1 })).toBe("schedule_email");
    expect(fallbackChannelFor({ templateName: "disponibilidade_extras", note: "Pedido automático de disponibilidade", employeeId: 1 })).toBe("availability_email");
    expect(fallbackChannelFor({ templateName: "morada_e_regras", note: "Morada e regras (1.º turno) 2026-10-05", employeeId: 1 })).toBe("none");
    expect(fallbackChannelFor({ templateName: "seja_motorista", note: "[LEADS] x", employeeId: null })).toBe("none");
    expect(fallbackChannelFor({ templateName: "aviso_de_trabalho", note: "Aviso de escala 2026-10-05", employeeId: null })).toBe("none");
  });
});

describe("payload da nova tentativa", () => {
  it("o token do formulário nunca é guardado: marcador trocado por um token novo", () => {
    const components = [
      { type: "body", parameters: [{ type: "text", parameter_name: "nome", text: "Ana" }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: FORM_TOKEN_PLACEHOLDER }] },
    ];
    const raw = JSON.stringify({ languageCode: "pt_BR", components, formWeekStart: "2026-10-05" });
    expect(raw).not.toMatch(/eyJ/); // sem JWT
    const p = parseSendPayload(raw)!;
    expect(p.formWeekStart).toBe("2026-10-05");
    const filled = withFormToken(p.components, "TOKEN-NOVO") as any[];
    expect(filled[1].parameters[0].text).toBe("TOKEN-NOVO");
    expect(filled[0].parameters[0].text).toBe("Ana");
  });
  it("JSON inválido ou sem língua → null", () => {
    expect(parseSendPayload(null)).toBeNull();
    expect(parseSendPayload("{")).toBeNull();
    expect(parseSendPayload(JSON.stringify({ components: [] }))).toBeNull();
  });
});

describe("parseWebhookPayload — erro estruturado (0375)", () => {
  it("failed traz código, título e categoria além do texto", () => {
    const out = parseWebhookPayload({
      object: "whatsapp_business_account",
      entry: [{ id: "W", changes: [{ field: "messages", value: { statuses: [{
        id: "wamid.F", status: "failed", timestamp: "1700000000",
        pricing: { category: "marketing" },
        errors: [{ code: 131049, title: "This message was not delivered to maintain healthy ecosystem engagement." }],
      }] } }] }],
    });
    expect(out.statuses[0]).toMatchObject({
      status: "failed",
      errorCode: 131049,
      errorTitle: "This message was not delivered to maintain healthy ecosystem engagement.",
      category: "MARKETING",
    });
    expect(out.statuses[0].errorDetail).toContain("131049");
  });
  it("sem errors nem pricing → nulls", () => {
    const out = parseWebhookPayload({ object: "whatsapp_business_account", entry: [{ changes: [{ value: { statuses: [{ id: "w", status: "delivered" }] } }] }] });
    expect(out.statuses[0]).toMatchObject({ errorCode: null, errorTitle: null, category: null });
  });
});
