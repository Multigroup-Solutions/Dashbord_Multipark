/**
 * Referências a ficheiros (key ou URL) que vêm do CLIENTE. Sem validação, quem
 * gere a Formação apontava um manual para a key de um documento de RH e o
 * `training.manualFileUrl` assinava-o para todos; o mesmo com a foto da ficha.
 * Só interessam as referências ao NOSSO bucket (ou ao disco local): URLs do
 * Vercel Blob e links externos já são públicos e não dão acesso a nada.
 */
import { isS3OwnedUrl, readS3Env, s3NormalizeKey, type S3Env } from "./storage";

/** Key do storage a que a referência aponta; null se não é nossa (Blob, externa) ou vazia. PURA (recebe o env). */
export function storageKeyOf(ref: string | null | undefined, env: S3Env | null): string | null {
  const v = String(ref ?? "").trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) {
    return env && isS3OwnedUrl(env, v) ? s3NormalizeKey(v.split(/[?#]/)[0]) : null;
  }
  // URL relativa do modo local ("/uploads/<key>") ou key crua
  if (v.startsWith("/uploads/")) return v.slice("/uploads/".length);
  return v.replace(/^\/+/, "");
}

/** Todas as referências (as que são nossas) começam por um dos prefixos? */
export function uploadRefsAllowed(refs: Array<string | null | undefined>, prefixes: readonly string[], env: S3Env | null = readS3Env()): boolean {
  return refs.every((r) => {
    const key = storageKeyOf(r, env);
    return key === null || prefixes.some((p) => key.startsWith(p));
  });
}
