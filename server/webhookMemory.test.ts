import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import {
  buildWebhookSnapshot, insertWebhookSnapshot, redactPayload, mapMemoryRow, webhookDeliveryId, REDACTED, listMemoryForBookings,
} from "./webhookMemory";
import { parseMultiparkWebhook } from "./multiparkWebhook";
import { MIGRATION_0240_STATEMENTS } from "./migrations/migration_0240";

const dialect = new MySqlDialect();
const render = (q: any) => dialect.sqlToQuery(q);

// O payload que a Multipark manda hoje (server/multiparkWebhook.ts).
const payload = {
  id: "dlv-1",
  event: "BOOKING_UPDATED",
  createdAt: "2026-09-28T10:00:05.000Z",
  data: {
    id: "bk-1", parkId: "park-1", status: "CHECKED_IN", licensePlate: "AA-00-BB",
    checkIn: "2026-09-27T08:00:00.000Z", checkOut: "2026-09-30T18:30:00.000Z",
    bookingPrice: 45.5, paymentMethod: "Dinheiro", createdAt: "2026-09-20T09:00:00.000Z", updatedAt: "2026-09-28T10:00:00.000Z",
  },
};
const at = new Date("2026-09-28T10:00:06.123Z");

describe("memória do webhook: payload → linha", () => {
  it("guarda os campos como vieram, sem matrícula no JSON", () => {
    const r = buildWebhookSnapshot(payload, { receivedAt: at, signatureValid: true })!;
    expect(r).toMatchObject({
      deliveryId: "dlv-1", bookingId: "bk-1", eventType: "BOOKING_UPDATED", receivedAt: "2026-09-28 10:00:06.123",
      signatureValid: true, parkId: "park-1", status: "CHECKED_IN", checkIn: "2026-09-27 08:00:00", checkOut: "2026-09-30 18:30:00",
      bookingPrice: 45.5, paymentMethod: "Dinheiro", sourceUpdatedAt: "2026-09-28 10:00:00", eventCreatedAt: "2026-09-28 10:00:05",
      originalBookingPrice: null, paidAmount: null, discountAmount: null, partnerId: null, pro: null,
    });
    expect(r.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.payloadJson).not.toContain("AA-00-BB");
    expect(JSON.parse(r.payloadJson).data.bookingPrice).toBe(45.5);
  });
  it("campos que o webhook ainda não manda ficam prontos (preço original, pago, desconto, parceiro, pro, caixa)", () => {
    const r = buildWebhookSnapshot({ ...payload, data: { ...payload.data, originalBookingPrice: "50", totalPaid: 20, discountAmount: 5, campaignId: "c1", partnerId: "p9", partnerAmountDue: 30, pro: true, cashierClosed: 1, paymentSource: "PARK" } }, { receivedAt: at, signatureValid: false })!;
    expect(r).toMatchObject({ originalBookingPrice: 50, paidAmount: 20, discountAmount: 5, campaignId: "c1", partnerId: "p9", partnerAmountDue: 30, pro: true, cashierClosed: true, paymentSource: "PARK", signatureValid: false });
  });
  it("mesmo deliveryId que a fila (também no fallback sem id)", () => {
    const noId = { event: "BOOKING_CREATED", data: { id: "bk-2", bookingPrice: 10 } };
    expect(webhookDeliveryId(noId)).toBe(parseMultiparkWebhook(noId)!.deliveryId);
    expect(webhookDeliveryId(payload)).toBe(parseMultiparkWebhook(payload)!.deliveryId);
  });
  it("guarda também eventos desconhecidos; sem id de reserva não há nada a guardar", () => {
    expect(buildWebhookSnapshot({ id: "x", event: "BOOKING_PAID", data: { id: "bk-3" } }, { receivedAt: at, signatureValid: true })?.eventType).toBe("BOOKING_PAID");
    expect(buildWebhookSnapshot({ id: "x", event: "BOOKING_UPDATED", data: {} }, { receivedAt: at, signatureValid: true })).toBeNull();
    expect(buildWebhookSnapshot("lixo", { receivedAt: at, signatureValid: true })).toBeNull();
  });
});

describe("memória do webhook: sem dados pessoais", () => {
  it("tira email, telefone, nomes, NIF, morada e matrícula; mantém nomes de negócio", () => {
    const out = redactPayload({
      data: {
        id: "bk", client: { firstName: "Ana", lastName: "Silva", email: "ana@x.pt", phoneNumber: "+351 912 345 678", nif: "123456789", address: "Rua" },
        taxNumber: "999999990", taxName: "Ana", vehicle: { licensePlate: "AA-00-BB", brand: "VW" }, partnerName: "Parkos", parkName: "Airpark",
        notes: "ligar para 912345678", contact: "x", remarks: "ana@x.pt", cashierClosedByName: "João", bookingPrice: 10,
      },
    }) as any;
    const s = JSON.stringify(out);
    for (const bad of ["Ana", "Silva", "ana@x.pt", "912 345 678", "123456789", "999999990", "Rua", "AA-00-BB", "João"]) expect(s).not.toContain(bad);
    expect(out.data.partnerName).toBe("Parkos");
    expect(out.data.parkName).toBe("Airpark");
    expect(out.data.vehicle.brand).toBe("VW");
    expect(out.data.remarks).toBe(REDACTED);
    expect(out.data.bookingPrice).toBe(10);
  });
});

describe("memória do webhook: só acréscimo", () => {
  const row = buildWebhookSnapshot(payload, { receivedAt: at, signatureValid: true })!;
  it("INSERT simples (sem ON DUPLICATE KEY UPDATE nem REPLACE)", async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }]);
    expect(await insertWebhookSnapshot({ execute }, row)).toBe("stored");
    const q = render(execute.mock.calls[0][0]);
    expect(q.sql).toMatch(/^INSERT INTO multipark_webhook_snapshots \(/);
    expect(q.sql).not.toMatch(/\b(UPDATE|REPLACE|DELETE)\b/i);
    expect(q.params).toContain("dlv-1");
    expect(q.params).toContain(45.5);
  });
  it("a mesma entrega repetida conta como duplicada e não reescreve", async () => {
    const dup = Object.assign(new Error("Duplicate entry"), { cause: { code: "ER_DUP_ENTRY", errno: 1062 } });
    const execute = vi.fn().mockRejectedValue(dup);
    expect(await insertWebhookSnapshot({ execute }, row)).toBe("duplicate");
    expect(execute).toHaveBeenCalledOnce();
  });
  it("outros erros sobem (o webhook responde 500 e a Multipark repete)", async () => {
    const execute = vi.fn().mockRejectedValue(Object.assign(new Error("gone"), { code: "PROTOCOL_CONNECTION_LOST" }));
    await expect(insertWebhookSnapshot({ execute }, row)).rejects.toThrow("gone");
  });
  it("leitura por reserva, ordenada, e mapeamento", async () => {
    const execute = vi.fn().mockResolvedValue([[{ id: 2, deliveryId: "d", bookingId: "bk-1", eventType: "BOOKING_UPDATED", receivedAt: "2026-09-28 10:00:06.123", bookingPrice: "45.50", pro: 1, checkOut: "2026-09-30 18:30:00" }]]);
    const m = await listMemoryForBookings(["bk-1", "bk-1"], { execute });
    const q = render(execute.mock.calls[0][0]);
    expect(q.sql).toMatch(/^SELECT .* FROM multipark_webhook_snapshots\s+WHERE bookingId IN \(\?\)/s);
    expect(q.sql).not.toContain("payloadJson");
    expect(m.get("bk-1")![0]).toMatchObject({ bookingPrice: 45.5, pro: true, checkOut: "2026-09-30T18:30:00.000Z", receivedAt: "2026-09-28T10:00:06.123Z" });
    expect(mapMemoryRow({ bookingPrice: null }).bookingPrice).toBeNull();
  });
});

// Guarda: em TODO o código do servidor não há UPDATE/DELETE/REPLACE/TRUNCATE/DROP
// sobre a memória, e o módulo da memória nem sequer tem essas palavras em SQL.
function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (f === "node_modules") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(f) && !/\.test\.tsx?$/.test(f)) out.push(p);
  }
  return out;
}

describe("guarda: memória nunca é reescrita nem apagada", () => {
  const root = join(__dirname);
  const files = walk(root);
  it("nenhum ficheiro do servidor altera ou apaga multipark_webhook_snapshots", () => {
    const bad = /(UPDATE\s+`?multipark_webhook_snapshots|DELETE\s+(\w+\s+)?FROM\s+`?multipark_webhook_snapshots|TRUNCATE\s+(TABLE\s+)?`?multipark_webhook_snapshots|REPLACE\s+INTO\s+`?multipark_webhook_snapshots|DROP\s+TABLE\s+(IF\s+EXISTS\s+)?`?multipark_webhook_snapshots|ALTER\s+TABLE\s+`?multipark_webhook_snapshots`?\s+DROP)/i;
    const offenders = files.filter((f) => bad.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
  it("o módulo da memória só tem INSERT e SELECT", () => {
    const src = readFileSync(join(root, "webhookMemory.ts"), "utf8");
    const sqlParts = [...src.matchAll(/sql`([^`]*)`/g)].map((m) => m[1]).join("\n");
    expect(sqlParts).toMatch(/INSERT INTO multipark_webhook_snapshots/);
    expect(sqlParts).not.toMatch(/\b(UPDATE|DELETE|REPLACE|TRUNCATE|DROP|ALTER)\b/i);
    expect(src).not.toMatch(/ON DUPLICATE KEY UPDATE|INSERT IGNORE|db\.update\(|db\.delete\(|conn\.update\(|conn\.delete\(/i);
  });
  it("nenhuma tabela Drizzle aponta para a memória (sem .update()/.delete() possíveis)", () => {
    const schema = readFileSync(join(root, "..", "drizzle", "schema.ts"), "utf8");
    expect(schema).not.toContain("multipark_webhook_snapshots");
  });
  it("a migração 0240 só cria a tabela, com deliveryId único, e está registada", () => {
    expect(MIGRATION_0240_STATEMENTS.every((s) => /^CREATE TABLE IF NOT EXISTS `multipark_webhook_snapshots`/.test(s))).toBe(true);
    expect(MIGRATION_0240_STATEMENTS.join()).toContain("UNIQUE KEY `uq_mp_webhook_snap_delivery` (`deliveryId`)");
    expect(readFileSync(join(root, "db.ts"), "utf8")).toContain('import("./migrations/migration_0240")');
  });
});
