import { describe, expect, it } from "vitest";
import { isSensitiveColumn, kindOf } from "./profile";

describe("perfil — colunas cujos valores nunca saem", () => {
  it("dados pessoais do cliente e segredos", () => {
    for (const [t, c] of [
      ["Client", "firstName"], ["Client", "lastName"], ["Client", "email"], ["Client", "phoneNumber"], ["Client", "nif"], ["Client", "iban"],
      ["BookingVehicle", "licensePlate"], ["Booking", "taxNumber"], ["Booking", "remarks"], ["Booking", "checkinSignature"], ["Booking", "checkinVideo"],
      ["ApiKey", "keyHash"], ["ApiKey", "keyPrefix"], ["ConnectionEndpoint", "secretEnc"], ["AgentInvite", "token"], ["History", "lat"], ["History", "lng"],
      ["History", "agentName"], ["AiEmailMessage", "bodyText"], ["ChatMessage", "content"], ["Driver", "name"], ["BookingReview", "clientName"],
      ["Occurrence", "remarks"], ["Cancellation", "cancellationObs"], ["Booking", "originUrl"],
    ]) {
      expect(isSensitiveColumn(t, c), `${t}.${c}`).toBe(true);
    }
  });
  it("categorias e catálogos de negócio podem mostrar valores", () => {
    for (const [t, c] of [
      ["Booking", "status"], ["Booking", "paymentMethod"], ["Booking", "deliveryType"], ["Booking", "origin"], ["History", "changeType"],
      ["Park", "name"], ["Partner", "name"], ["Campaign", "name"], ["ExtraService", "name"], ["BookingExtraService", "name"],
      ["Occurrence", "title"], ["Cancellation", "cancellationType"], ["History", "modifiedFields"], ["BookingPricing", "category"],
      ["EntityEmailLog", "emailType"], ["BookingPricing", "description"], ["AiEmailMessage", "category"], ["Agent", "role"],
    ]) {
      expect(isSensitiveColumn(t, c), `${t}.${c}`).toBe(false);
    }
  });
});

describe("perfil — tipo lógico", () => {
  it("mapeia os tipos do Postgres", () => {
    expect(kindOf({ dataType: "boolean", udt: "bool" })).toBe("bool");
    expect(kindOf({ dataType: "double precision", udt: "float8" })).toBe("num");
    expect(kindOf({ dataType: "timestamp without time zone", udt: "timestamp" })).toBe("time");
    expect(kindOf({ dataType: "USER-DEFINED", udt: "BookingStatus" })).toBe("enum");
    expect(kindOf({ dataType: "jsonb", udt: "jsonb" })).toBe("json");
    expect(kindOf({ dataType: "ARRAY", udt: "_text" })).toBe("array");
    expect(kindOf({ dataType: "text", udt: "text" })).toBe("text");
  });
});
