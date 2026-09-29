/** Encrypted transport for operational CSVs from a public-repository workflow. */
import { constants, createCipheriv, createDecipheriv, createPublicKey, privateDecrypt, publicEncrypt, randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

export interface PriceExportFiles { csv: string; summary: Record<string, unknown> }
export interface PriceExportEnvelope { version: 1; algorithm: "RSA-OAEP-SHA256+AES-256-GCM"; key: string; iv: string; tag: string; data: string }

export function sealPriceExport(files: PriceExportFiles, publicKeyDerBase64: string): PriceExportEnvelope {
  const publicKey = createPublicKey({ key: Buffer.from(publicKeyDerBase64, "base64"), format: "der", type: "spki" });
  if (publicKey.asymmetricKeyType !== "rsa" || (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error("Chave pública RSA inválida.");
  if (files.summary.complete !== true) throw new Error("A exportação está incompleta.");
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(files)))), cipher.final()]);
  return {
    version: 1, algorithm: "RSA-OAEP-SHA256+AES-256-GCM",
    key: publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key).toString("base64"),
    iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64"),
  };
}

export function openPriceExport(envelope: PriceExportEnvelope, privateKeyPem: string): PriceExportFiles {
  if (envelope.version !== 1 || envelope.algorithm !== "RSA-OAEP-SHA256+AES-256-GCM") throw new Error("Formato cifrado desconhecido.");
  const key = privateDecrypt({ key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(envelope.key, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const clear = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]);
  const files = JSON.parse(gunzipSync(clear, { maxOutputLength: 512 * 1024 * 1024 }).toString("utf8"));
  if (typeof files.csv !== "string" || files.summary?.complete !== true) throw new Error("Exportação inválida ou incompleta.");
  return files;
}
