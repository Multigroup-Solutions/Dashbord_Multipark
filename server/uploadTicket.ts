/**
 * Recibo de upload (P3 lote 17d): o /api/upload devolve, com a key, um
 * `ticket` = HMAC(utilizador, key). Quem anexa um ficheiro a um email prova
 * que foi ELE que o carregou — antes bastava conhecer a key de um ficheiro de
 * outra pessoa (ex.: um documento de RH) para o mandar por email. PURA (só
 * lê JWT_SECRET).
 */
import crypto from "node:crypto";

const secret = () => `upload-ticket:${process.env.JWT_SECRET ?? ""}`;

export function uploadTicket(userId: number, key: string): string {
  return crypto.createHmac("sha256", secret()).update(`${userId}:${key}`).digest("base64url").slice(0, 32);
}

export function verifyUploadTicket(userId: number, key: string, ticket: unknown): boolean {
  if (typeof ticket !== "string" || ticket.length !== 32) return false;
  const want = Buffer.from(uploadTicket(userId, key));
  const got = Buffer.from(ticket);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
