/**
 * Links de leitura ASSINADOS para os ficheiros do bucket S3 — para o bucket
 * poder deixar de ser público sem partir nada (P1, 1 out 2026).
 *
 * A BD continua a guardar a URL pública "canónica" (é o identificador do
 * ficheiro, como sempre). Assina-se À SAÍDA:
 *  - `signStorageUrlsDeep(resposta)` troca cada URL deste bucket por um GET
 *    assinado — também dentro de texto (ex.: o corpo de uma notificação). O
 *    middleware de server/_core/trpc.ts aplica-o a TODOS os procedimentos: o
 *    link só chega a quem o procedimento já deixava ver a linha.
 *  - `canonicalStorageUrlsDeep(input)` faz o inverso à entrada: um formulário
 *    que devolve um link assinado (ex.: editar a ficha com a foto) volta a
 *    gravar a URL canónica, nunca um link que expira.
 *
 * O link é ESTÁVEL durante a hora (assinado com a hora arredondada, válido
 * 3 h → vale sempre pelo menos 2 h): a cache de imagens do browser funciona e
 * a mesma foto não se descarrega a cada pedido. A assinatura é local (sem ir à
 * AWS). URLs de outro sítio (Vercel Blob, links externos) e links que já vêm
 * assinados (ex.: documentos de RH, 10 min) ficam como estão. Sem S3
 * configurado, nada muda.
 */
import { getS3Client, isS3OwnedUrl, readS3Env, s3NormalizeKey, type S3Env } from "./storage";

/** Janela de assinatura: o link é o mesmo dentro dela. */
export const SIGN_WINDOW_MS = 60 * 60 * 1000;
/** Validade a contar do início da janela (≥ 2 h a contar de agora). */
export const SIGN_EXPIRES_S = 3 * 60 * 60;

const URL_IN_TEXT = /https?:\/\/[^\s"'<>()[\]{}\\]+/g;
const MAX_DEPTH = 40;
const CACHE_MAX = 5000;
const signedCache = new Map<string, string>();

/** Já é um link assinado (S3 SigV4)? */
export function isPresignedUrl(url: string): boolean {
  return /[?&]X-Amz-Signature=/i.test(url);
}

/** Pistas baratas de "pode ter uma URL deste bucket" (antes de qualquer regex). */
function hostHints(env: S3Env): string[] {
  const hints = [`${env.bucket.toLowerCase()}.s3.`];
  try { hints.push(new URL(env.publicBaseUrl).host.toLowerCase()); } catch { /* base malformada */ }
  return hints;
}

function mayContain(s: string, hints: string[]): boolean {
  if (s.length < 12 || !s.includes("://")) return false;
  const low = s.toLowerCase();
  return hints.some((h) => low.includes(h));
}

/** Pontuação no fim de uma URL dentro de texto ("…/folha.pdf.") não faz parte dela. */
function trimUrl(m: string): [string, string] {
  const t = m.match(/[.,;:!?]+$/);
  return t ? [m.slice(0, -t[0].length), t[0]] : [m, ""];
}

/** URLs deste bucket, por assinar, dentro de uma string (inteira ou no meio de texto). */
function ownUrlsIn(s: string, env: S3Env): string[] {
  const out: string[] = [];
  for (const m of s.match(URL_IN_TEXT) ?? []) {
    const [u] = trimUrl(m);
    if (!isPresignedUrl(u) && isS3OwnedUrl(env, u)) out.push(u);
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Percorre strings dentro de objetos simples e arrays (Date, Map, Buffer… ficam de fora). */
function collectStrings(v: unknown, visit: (s: string) => void, depth = 0, seen = new WeakSet<object>()): void {
  if (typeof v === "string") { visit(v); return; }
  if (depth > MAX_DEPTH || v === null || typeof v !== "object") return;
  if (seen.has(v as object)) return;
  if (Array.isArray(v)) {
    seen.add(v);
    for (const x of v) collectStrings(x, visit, depth + 1, seen);
  } else if (isPlainObject(v)) {
    seen.add(v);
    for (const k of Object.keys(v)) collectStrings(v[k], visit, depth + 1, seen);
  }
}

/** Cópia com as strings trocadas; devolve o MESMO objeto quando nada muda (sem cópias à toa). */
function mapStrings<T>(v: T, fn: (s: string) => string, depth = 0, seen = new WeakMap<object, unknown>()): T {
  if (typeof v === "string") return fn(v) as unknown as T;
  if (depth > MAX_DEPTH || v === null || typeof v !== "object") return v;
  if (seen.has(v as object)) return seen.get(v as object) as T;
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const y = mapStrings(x, fn, depth + 1, seen);
      if (y !== x) changed = true;
      return y;
    });
    const res = changed ? out : v;
    seen.set(v, res);
    return res as unknown as T;
  }
  if (isPlainObject(v)) {
    let changed = false;
    const out: Record<string, unknown> = Object.create(Object.getPrototypeOf(v));
    for (const k of Object.keys(v)) {
      const x = v[k];
      const y = mapStrings(x, fn, depth + 1, seen);
      if (y !== x) changed = true;
      out[k] = y;
    }
    const res = changed ? out : v;
    seen.set(v, res);
    return res as T;
  }
  return v;
}

/** GET assinado de uma key, estável dentro da janela. */
async function signKey(env: S3Env, key: string, nowMs: number): Promise<string> {
  const windowStart = Math.floor(nowMs / SIGN_WINDOW_MS) * SIGN_WINDOW_MS;
  const ck = `${env.bucket}|${key}|${windowStart}`;
  const hit = signedCache.get(ck);
  if (hit) return hit;
  const client = await getS3Client(env);
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: env.bucket, Key: key }), {
    expiresIn: SIGN_EXPIRES_S,
    signingDate: new Date(windowStart),
  });
  if (signedCache.size >= CACHE_MAX) signedCache.clear();
  signedCache.set(ck, url);
  return url;
}

/**
 * Troca as URLs deste bucket (por assinar) por links assinados, em qualquer
 * profundidade e também dentro de texto. Não altera o valor recebido. Nunca
 * lança: se a assinatura falhar, devolve o valor como estava.
 */
export interface SignOptions {
  nowMs?: number;
  /**
   * Quem vê pode receber o link desta key? Sem isto assina tudo (só para
   * canais já de confiança, ex.: API MCP). Nos procedimentos é OBRIGATÓRIO:
   * senão bastava colar a URL de um documento num campo de texto para a
   * receber assinada de volta.
   */
  canSign?: (key: string) => Promise<boolean>;
}

export async function signStorageUrlsDeep<T>(value: T, opts: SignOptions = {}): Promise<T> {
  const env = readS3Env();
  if (!env) return value;
  const nowMs = opts.nowMs ?? Date.now();
  const hints = hostHints(env);
  const urls = new Set<string>();
  collectStrings(value, (s) => {
    if (mayContain(s, hints)) for (const u of ownUrlsIn(s, env)) urls.add(u);
  });
  if (!urls.size) return value;
  try {
    const signed = new Map<string, string>();
    await Promise.all([...urls].map(async (u) => {
      const key = s3NormalizeKey(u.split(/[?#]/)[0]);
      if (!key) return;
      const allowed = opts.canSign ? await opts.canSign(key).catch(() => false) : true;
      // sem permissão fica a URL canónica: com o bucket privado não abre
      if (allowed) signed.set(u, await signKey(env, key, nowMs));
    }));
    return mapStrings(value, (s) => {
      if (!mayContain(s, hints)) return s;
      return s.replace(URL_IN_TEXT, (m) => {
        const [u, tail] = trimUrl(m);
        const sig = signed.get(u);
        return sig ? sig + tail : m;
      });
    });
  } catch (err: any) {
    console.warn("[storageSign] assinar falhou:", String(err?.message ?? err).slice(0, 160));
    return value;
  }
}

/** A URL canónica (sem os parâmetros da assinatura) de um link assinado deste bucket. */
export function canonicalStorageUrl(url: string, env: S3Env | null = readS3Env()): string {
  if (!env || !isPresignedUrl(url) || !isS3OwnedUrl(env, url)) return url;
  return url.split(/[?#]/)[0];
}

/**
 * À ENTRADA: links assinados deste bucket voltam à URL canónica (para nunca se
 * gravar na BD um link que expira). Síncrono e barato; devolve o mesmo valor
 * quando não há nada a mudar.
 */
export function canonicalStorageUrlsDeep<T>(value: T): T {
  const env = readS3Env();
  if (!env) return value;
  const hints = hostHints(env);
  return mapStrings(value, (s) => {
    if (!mayContain(s, hints) || !/X-Amz-Signature=/i.test(s)) return s;
    return s.replace(URL_IN_TEXT, (m) => {
      const [u, tail] = trimUrl(m);
      return canonicalStorageUrl(u, env) + tail;
    });
  });
}

/**
 * URL que o SERVIDOR pode descarregar: URL/key deste bucket → link assinado
 * (o bucket deixa de ser público); outra URL absoluta fica igual.
 */
export async function storageReadableUrl(keyOrUrl: string, nowMs: number = Date.now()): Promise<string> {
  const env = readS3Env();
  if (!env || !keyOrUrl || isPresignedUrl(keyOrUrl)) return keyOrUrl;
  const absolute = /^https?:\/\//i.test(keyOrUrl);
  if (absolute && !isS3OwnedUrl(env, keyOrUrl)) return keyOrUrl;
  const key = s3NormalizeKey(keyOrUrl.split(/[?#]/)[0]);
  return key ? signKey(env, key, nowMs) : keyOrUrl;
}

/** Só para testes. */
export function _resetSignCache(): void {
  signedCache.clear();
}
