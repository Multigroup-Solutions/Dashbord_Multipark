/**
 * Reconhecer uma URL do Vercel Blob — e extrair a sua key.
 *
 * Isolado aqui, puro e testado, porque é o critério de segurança da migração
 * Blob → S3 (`scripts/migrate-blob-to-s3.ts`): é o que decide QUE URLs são
 * reescritas na base de dados. Um falso positivo reescreveria um link que não
 * é nosso — há colunas de URL que guardam endereços externos, como o
 * `training_videos.videoUrl` — e um falso negativo deixaria um ficheiro para
 * trás no Blob.
 *
 * A decisão é pelo HOST, nunca pelo formato do caminho: o pathname de um blob
 * (`invoices/5295/….pdf`) é indistinguível de uma key do S3, e foi exatamente
 * essa confusão que partiu a leitura dos comprovativos antigos (ver
 * `memory/storage-backends-s3.md`, changelog 2026-09-18).
 */

/** Sufixo do host das URLs públicas do Vercel Blob. */
export const BLOB_HOST_SUFFIX = ".public.blob.vercel-storage.com";

/** A URL é um blob público do Vercel? */
export function isVercelBlobUrl(value: string | null | undefined): value is string {
  if (!value || !/^https?:\/\//i.test(value)) return false;
  try {
    return new URL(value).host.toLowerCase().endsWith(BLOB_HOST_SUFFIX);
  } catch {
    return false;
  }
}

/**
 * A key de storage correspondente a uma URL do Blob: o pathname, sem a barra
 * inicial e descodificado.
 *
 * Reaproveitar a MESMA key no S3 mantém a coerência com o que está gravado nas
 * colunas `*Key` e faz uma linha migrada ficar indistinguível de um upload
 * novo. Lança para uma URL que não é do Blob — chamar isto sobre outra coisa é
 * um erro de programação, não um caso a tratar silenciosamente.
 */
export function keyFromBlobUrl(url: string): string {
  if (!isVercelBlobUrl(url)) throw new Error(`Não é uma URL do Vercel Blob: ${url}`);
  const raw = new URL(url).pathname.replace(/^\/+/, "");
  try {
    return decodeURIComponent(raw);
  } catch {
    // Key com "%" literal que não é um escape válido — fica como está.
    return raw;
  }
}
