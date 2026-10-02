/**
 * Fotos de perfil (P3 lote 19c). Antes o `mimeType` era texto livre e o
 * ficheiro não tinha limite: uma conta qualquer gravava `photo-….html` como
 * "foto" (abria como página no bucket; em modo local, na própria app).
 *
 *  - só JPEG, PNG ou WebP, confirmado pelos PRIMEIROS BYTES (não pelo que o
 *    browser diz);
 *  - até 4 MB (o Perfil já reduz para ≤ 1280 px em JPEG antes de enviar);
 *  - a extensão e o Content-Type saem da lista, nunca do texto recebido.
 * PURA (sem BD nem S3).
 */
export const PHOTO_MAX_BYTES = 4 * 1024 * 1024;
/** base64 de 4 MB ≈ 5,6 M caracteres (+ folga para o cabeçalho data:). */
export const PHOTO_MAX_BASE64_CHARS = Math.ceil((PHOTO_MAX_BYTES * 4) / 3) + 1024;

const KINDS = [
  { mime: "image/jpeg", ext: "jpg", test: (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/png", ext: "png", test: (b: Buffer) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/webp", ext: "webp", test: (b: Buffer) => b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
] as const;

export type PhotoCheck = { ok: true; buffer: Buffer; mime: string; ext: string } | { ok: false; error: string };

export function checkProfilePhoto(fileBase64: string): PhotoCheck {
  const raw = String(fileBase64 ?? "").replace(/^data:[^,]*,/, "");
  if (!raw) return { ok: false, error: "A foto chegou vazia — tenta de novo." };
  if (raw.length > PHOTO_MAX_BASE64_CHARS) return { ok: false, error: "A foto é demasiado grande (máximo 4 MB)." };
  const buffer = Buffer.from(raw, "base64");
  if (buffer.length > PHOTO_MAX_BYTES) return { ok: false, error: "A foto é demasiado grande (máximo 4 MB)." };
  const kind = KINDS.find((k) => k.test(buffer));
  if (!kind) return { ok: false, error: "Formato não aceite: usa uma foto JPEG, PNG ou WebP." };
  return { ok: true, buffer, mime: kind.mime, ext: kind.ext };
}
