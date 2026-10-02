/**
 * Cifra dos segredos de integração guardados em BD (refresh token do Google
 * Ads). AES-256-GCM com chave de `INTEGRATIONS_ENCRYPTION_KEY` (32 bytes em
 * base64). Sem essa env, deriva-se uma chave do JWT_SECRET para a app não
 * ficar bloqueada — mas fica assinalado no estado da integração.
 */
import crypto from "crypto";

const PREFIX = "enc:v1:";

export function encryptionKeyInfo(): { key: Buffer | null; source: "env" | "derived" | "none" } {
  const raw = process.env.INTEGRATIONS_ENCRYPTION_KEY;
  if (raw) {
    const buf = Buffer.from(raw, "base64");
    if (buf.length === 32) return { key: buf, source: "env" };
    throw new Error("INTEGRATIONS_ENCRYPTION_KEY tem de ser 32 bytes em base64 (openssl rand -base64 32)");
  }
  const jwt = process.env.JWT_SECRET;
  if (jwt) return { key: crypto.createHash("sha256").update(`${jwt}:integrations:v1`).digest(), source: "derived" };
  return { key: null, source: "none" };
}

export function encryptSecret(plain: string, key?: Buffer): string {
  const k = key ?? encryptionKeyInfo().key;
  if (!k) throw new Error("Sem chave de cifra (INTEGRATIONS_ENCRYPTION_KEY ou JWT_SECRET)");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

function decryptWith(stored: string, k: Buffer): string {
  if (!stored.startsWith(PREFIX)) throw new Error("Segredo em formato desconhecido");
  const buf = Buffer.from(stored.slice(PREFIX.length), "base64");
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", k, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

/** Chave antiga (derivada do JWT_SECRET) — o que se usava antes de existir INTEGRATIONS_ENCRYPTION_KEY. */
function derivedKey(): Buffer | null {
  const jwt = process.env.JWT_SECRET;
  return jwt ? crypto.createHash("sha256").update(`${jwt}:integrations:v1`).digest() : null;
}

/**
 * Decifra e diz se foi preciso a chave ANTIGA (19b). Quando se define
 * INTEGRATIONS_ENCRYPTION_KEY depois de já haver segredos guardados com a
 * chave derivada do JWT_SECRET, esses deixavam de abrir (e a ligação ficava
 * "a funcionar" até à primeira recolha). Agora tenta a antiga; quem chama
 * deve voltar a cifrar com a atual (`legacyKey: true`).
 */
export function decryptSecretInfo(stored: string): { plain: string; legacyKey: boolean } {
  const info = encryptionKeyInfo();
  if (!info.key) throw new Error("Sem chave de cifra (INTEGRATIONS_ENCRYPTION_KEY ou JWT_SECRET)");
  if (!stored.startsWith(PREFIX)) throw new Error("Segredo em formato desconhecido");
  try {
    return { plain: decryptWith(stored, info.key), legacyKey: false };
  } catch (err) {
    const old = info.source === "env" ? derivedKey() : null;
    if (old) {
      try { return { plain: decryptWith(stored, old), legacyKey: true }; } catch { /* nem com a antiga */ }
    }
    throw new Error("Não foi possível decifrar o segredo guardado: a chave de cifra mudou (INTEGRATIONS_ENCRYPTION_KEY/JWT_SECRET). Volta a ligar a integração.", { cause: err });
  }
}

export function decryptSecret(stored: string, key?: Buffer): string {
  if (key) return decryptWith(stored, key);
  return decryptSecretInfo(stored).plain;
}

/** Mascara um segredo para logs/UI ("ya29.a0…" → "ya29…"). */
export function maskSecret(s: string | null | undefined): string {
  if (!s) return "";
  return s.length <= 8 ? "••••" : `${s.slice(0, 4)}…${s.slice(-2)}`;
}
