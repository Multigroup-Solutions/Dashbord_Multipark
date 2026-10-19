import { describe, expect, it } from "vitest";
import {
  applicationSendKey,
  contactPhoneProblem,
  decideRequestCity,
  recipientOutcome,
} from "./applicationAvailabilityRequest";
import { availabilityRangeError, availabilityRangeLabel, currentWeekRangeLisbon } from "../shared/availabilityWeek";
import { fmtWeek } from "./extrasAutomation";
import { citySendKey } from "./whatsappBroadcast";

describe("Pedido de disponibilidade ao aprovar: intervalo", () => {
  it("por defeito = semana de HOJE em Lisboa, segunda a domingo", () => {
    // quarta 14 out 2026, 10h UTC
    expect(currentWeekRangeLisbon(Date.UTC(2026, 9, 14, 10))).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    // domingo 23:30 UTC = segunda 00:30 em Lisboa → já é a semana seguinte
    expect(currentWeekRangeLisbon(Date.UTC(2026, 9, 18, 23, 30))).toEqual({ from: "2026-10-19", to: "2026-10-25" });
  });
  it("aceita a semana inteira, parte dela e um só dia", () => {
    expect(availabilityRangeError("2026-10-12", "2026-10-18")).toBeNull();
    expect(availabilityRangeError("2026-10-14", "2026-10-18")).toBeNull();
    expect(availabilityRangeError("2026-10-15", "2026-10-15")).toBeNull();
  });
  it("recusa início depois do fim, datas inválidas e intervalos que atravessam semanas", () => {
    expect(availabilityRangeError("2026-10-18", "2026-10-12")).toMatch(/anterior/);
    expect(availabilityRangeError("", "2026-10-18")).toMatch(/datas/);
    expect(availabilityRangeError("2026-02-30", "2026-03-01")).toMatch(/datas/);
    expect(availabilityRangeError("2026-10-17", "2026-10-20")).toMatch(/mesma semana/);
    expect(availabilityRangeError("2026-10-01", "2026-10-31")).toMatch(/mesma semana/);
  });
  it("texto do {{semana}} igual ao do pedido automático", () => {
    expect(availabilityRangeLabel("2026-10-12", "2026-10-18")).toBe("semana de 12/10 a 18/10");
    expect(availabilityRangeLabel("2026-10-14", "2026-10-18")).toBe("semana de 14/10 a 18/10");
    expect(fmtWeek("2026-10-12")).toBe(availabilityRangeLabel("2026-10-12", "2026-10-18"));
  });
});

describe("Pedido de disponibilidade ao aprovar: cidade do template", () => {
  it("usa a cidade escolhida no diálogo (nunca Lisboa por omissão)", () => {
    expect(decideRequestCity("porto", "porto")).toEqual({ ok: true, city: "PORTO" });
    expect(decideRequestCity(null, "faro")).toEqual({ ok: true, city: "FARO" });
    expect(decideRequestCity("lisboa", "lisboa")).toEqual({ ok: true, city: "LISBOA" });
  });
  it("ficha que ficou noutra cidade (não foi movida) → não envia, diz porquê", () => {
    const d = decideRequestCity("porto", "lisboa");
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/ficou em Porto/);
  });
});

describe("Pedido de disponibilidade ao aprovar: telemóvel e resultado", () => {
  it("sem telemóvel ou com lixo → motivo claro; número válido → sem problema", () => {
    expect(contactPhoneProblem({ phone: null })).toMatch(/não tem telemóvel/);
    expect(contactPhoneProblem({ phone: "   " })).toMatch(/não tem telemóvel/);
    expect(contactPhoneProblem({ phone: "abc" })).toMatch(/não é um número válido/);
    expect(contactPhoneProblem({ phone: "912 345 678" })).toBeNull();
  });
  it("resultado do destinatário → enviado ou o motivo do envio", () => {
    const base = { employeeId: 1, name: "Ana", phone: "912345678", phoneE164: "+351912345678" };
    expect(recipientOutcome({ ...base, status: "sent" })).toEqual({ sent: true, reason: null });
    expect(recipientOutcome({ ...base, status: "opted_out", error: "Pediu para não receber mensagens (STOP)." })).toEqual({
      sent: false,
      reason: "Pediu para não receber mensagens (STOP).",
    });
    expect(recipientOutcome({ ...base, status: "invalid_phone" }).reason).toMatch(/não é válido/);
    expect(recipientOutcome({ ...base, status: "failed" }).sent).toBe(false);
    expect(recipientOutcome(undefined).sent).toBe(false);
  });
  it("código do envio cabe no sendKey por cidade e é estável (repetir retoma, não duplica)", () => {
    const key = applicationSendKey(1234567, { from: "2026-10-12", to: "2026-10-18" });
    expect(key).toBe("apv1234567:2026-10-12:2026-10-18");
    expect(key.length).toBeLessThanOrEqual(33);
    expect(citySendKey(key, "LISBOA")).toBe(`${key}:LISBOA`);
  });
});
