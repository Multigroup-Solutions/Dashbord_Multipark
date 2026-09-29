import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openPriceExport, sealPriceExport } from "./priceExportEnvelope";
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const privateKey = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const files = { csv: '\uFEFF"reserva";"preço"\r\n"123";"45"\r\n', summary: { complete: true, bookings: 1 } };
describe("private price-export transport", () => {
  it("round-trips the CSV and summary without plaintext in the envelope", () => {
    const envelope = sealPriceExport(files, publicKey);
    expect(JSON.stringify(envelope)).not.toContain("reserva");
    expect(openPriceExport(envelope, privateKey)).toEqual(files);
    expect(sealPriceExport(files, publicKey).data).not.toBe(envelope.data);
  });
  it("rejects tampering", () => {
    const envelope = sealPriceExport(files, publicKey);
    const data = Buffer.from(envelope.data, "base64"); data[0] ^= 1;
    expect(() => openPriceExport({ ...envelope, data: data.toString("base64") }, privateKey)).toThrow();
  });
  it("rejects an unrelated recipient key and incomplete exports", () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(() => openPriceExport(sealPriceExport(files, publicKey), other)).toThrow();
    expect(() => sealPriceExport({ ...files, summary: { complete: false } }, publicKey)).toThrow("incompleta");
  });
});
