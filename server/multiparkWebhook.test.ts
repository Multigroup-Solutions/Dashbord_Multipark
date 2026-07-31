import { describe, expect, it } from "vitest";
import crypto from "crypto";
import {
  verifyMultiparkSignature,
  parseMultiparkWebhook,
  isoToMysql,
  cityToSyncForm,
} from "./multiparkWebhook";

const SECRET = "test-secret-key-for-multipark-webhook";

function sign(body: string, ts: string, secret = SECRET): string {
  const v1 = crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return `t=${ts},v1=${v1}`;
}

describe("verifyMultiparkSignature", () => {
  const body = JSON.stringify({ id: "d1", event: "BOOKING_CREATED", data: { id: "b1" } });
  const ts = "1785400000000";

  it("aceita assinatura válida", () => {
    expect(verifyMultiparkSignature(Buffer.from(body), sign(body, ts), SECRET)).toBe(true);
  });

  it("rejeita segredo errado", () => {
    expect(verifyMultiparkSignature(Buffer.from(body), sign(body, ts, "outro"), SECRET)).toBe(false);
  });

  it("rejeita body adulterado", () => {
    expect(verifyMultiparkSignature(Buffer.from(body + "x"), sign(body, ts), SECRET)).toBe(false);
  });

  it("rejeita timestamp adulterado (assinatura cobre o ts)", () => {
    const sig = sign(body, ts).replace(`t=${ts}`, "t=999");
    expect(verifyMultiparkSignature(Buffer.from(body), sig, SECRET)).toBe(false);
  });

  it("rejeita header ausente ou malformado e segredo ausente", () => {
    expect(verifyMultiparkSignature(Buffer.from(body), undefined, SECRET)).toBe(false);
    expect(verifyMultiparkSignature(Buffer.from(body), "lixo", SECRET)).toBe(false);
    expect(verifyMultiparkSignature(Buffer.from(body), "t=1,v1=zz", SECRET)).toBe(false);
    expect(verifyMultiparkSignature(Buffer.from(body), sign(body, ts), undefined)).toBe(false);
  });
});

describe("parseMultiparkWebhook", () => {
  const full = {
    id: "delivery-123",
    event: "BOOKING_CREATED",
    createdAt: "2026-07-31T10:00:00.000Z",
    data: {
      id: "cm123",
      parkId: "cmpark1",
      status: "BOOKED",
      licensePlate: "AA00BB",
      checkIn: "2026-08-01T09:00:00.000Z",
      checkOut: "2026-08-05T18:00:00.000Z",
      bookingPrice: 57.6,
      paymentMethod: "Online",
    },
  };

  it("extrai o evento completo", () => {
    const ev = parseMultiparkWebhook(full)!;
    expect(ev.deliveryId).toBe("delivery-123");
    expect(ev.event).toBe("BOOKING_CREATED");
    expect(ev.bookingId).toBe("cm123");
    expect(ev.status).toBe("BOOKED");
    expect(ev.licensePlate).toBe("AA00BB");
    expect(ev.bookingPrice).toBe(57.6);
  });

  it("aceita os 3 tipos de evento e rejeita desconhecidos", () => {
    for (const e of ["BOOKING_CREATED", "BOOKING_UPDATED", "BOOKING_CANCELLED"]) {
      expect(parseMultiparkWebhook({ ...full, event: e })?.event).toBe(e);
    }
    expect(parseMultiparkWebhook({ ...full, event: "PING" })).toBeNull();
  });

  it("rejeita sem data.id, body nulo e tipos errados", () => {
    expect(parseMultiparkWebhook({ ...full, data: {} })).toBeNull();
    expect(parseMultiparkWebhook(null)).toBeNull();
    expect(parseMultiparkWebhook("string")).toBeNull();
  });

  it("gera deliveryId de recurso quando o id da entrega falta", () => {
    const ev = parseMultiparkWebhook({ ...full, id: undefined })!;
    expect(ev.deliveryId).toContain("cm123");
    expect(ev.deliveryId).toContain("BOOKING_CREATED");
  });

  it("campos opcionais ausentes ficam null", () => {
    const ev = parseMultiparkWebhook({ id: "d", event: "BOOKING_CANCELLED", data: { id: "b" } })!;
    expect(ev.status).toBeNull();
    expect(ev.checkIn).toBeNull();
    expect(ev.bookingPrice).toBeNull();
  });
});

describe("isoToMysql", () => {
  it("converte ISO UTC para wall-clock MySQL", () => {
    expect(isoToMysql("2026-07-31T10:05:30.000Z")).toBe("2026-07-31 10:05:30");
  });
  it("normaliza offsets para UTC", () => {
    expect(isoToMysql("2026-07-31T11:05:30+01:00")).toBe("2026-07-31 10:05:30");
  });
  it("devolve undefined para nulos e lixo", () => {
    expect(isoToMysql(null)).toBeUndefined();
    expect(isoToMysql(undefined)).toBeUndefined();
    expect(isoToMysql("not-a-date")).toBeUndefined();
  });
});

describe("cityToSyncForm", () => {
  it("mapeia cidades da config para a forma do sync", () => {
    expect(cityToSyncForm("Lisboa")).toBe("lisbon");
    expect(cityToSyncForm("Porto")).toBe("porto");
    expect(cityToSyncForm("Faro")).toBe("faro");
  });
  it("desconhecidas passam a lowercase", () => {
    expect(cityToSyncForm("Madrid")).toBe("madrid");
  });
});
