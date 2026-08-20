import { put, head, del } from "@vercel/blob";
import type { S3Client } from "@aws-sdk/client-s3";
import fs from "fs";
import path from "path";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");

// ── Backends ────────────────────────────────────────────────────────────────
// Precedência: S3 (as 4 envs AWS_* presentes) → Vercel Blob (BLOB_READ_WRITE_TOKEN)
// → filesystem local (só em dev; no Vercel falha alto).
// Sem as envs AWS_* o comportamento é EXATAMENTE o de antes — o SDK da AWS nem
// chega a ser carregado (imports dinâmicos), para não pagar cold start à toa.

type S3Env = {
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Base pública sem barra final, ex.: https://bucket.s3.eu-west-1.amazonaws.com */
  publicBaseUrl: string;
};

function isBlobConfigured(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

/**
 * Lê a configuração do S3. Devolve `null` se faltar QUALQUER uma das 4 envs
 * (já resolvidas) — meia configuração é configuração nenhuma (senão caíamos em
 * erros de credenciais em runtime, já depois do utilizador ter carregado o
 * ficheiro). Envs: AWS_S3_REGION, AWS_S3_BUCKET_NAME, AWS_S3_ACCESS_KEY,
 * AWS_S3_SECRET_ACCESS_KEY + `S3_PUBLIC_BASE_URL` opcional.
 */
function readS3Env(): S3Env | null {
  const region = process.env.AWS_S3_REGION;
  const bucket = process.env.AWS_S3_BUCKET_NAME;
  // As credenciais levam prefixo AWS_S3_ porque o Vercel RESERVA vários nomes
  // AWS_* (não deixa definir AWS_ACCESS_KEY & companhia). Os nomes antigos
  // ficam como fallback para os ambientes ainda por renomear — as apps
  // `multipark`/`be-multipark` mantêm de propósito a convenção antiga.
  const accessKeyId = process.env.AWS_S3_ACCESS_KEY || process.env.AWS_ACCESS_KEY;
  const secretAccessKey =
    process.env.AWS_S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
  if (!region || !bucket || !accessKeyId || !secretAccessKey) return null;

  const publicBaseUrl = (
    process.env.S3_PUBLIC_BASE_URL || `https://${bucket}.s3.${region}.amazonaws.com`
  ).replace(/\/+$/, "");

  return { region, bucket, accessKeyId, secretAccessKey, publicBaseUrl };
}

// O cliente é caro de construir; guarda-se um por (região + chave) para o caso
// raro de a config mudar em runtime (testes).
let s3ClientCache: { signature: string; client: S3Client } | null = null;

async function getS3Client(env: S3Env): Promise<S3Client> {
  const signature = `${env.region}|${env.accessKeyId}`;
  if (s3ClientCache && s3ClientCache.signature === signature) return s3ClientCache.client;

  const { S3Client: Client } = await import("@aws-sdk/client-s3");
  const client = new Client({
    region: env.region,
    credentials: { accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
  });
  s3ClientCache = { signature, client };
  return client;
}

/**
 * URL pública (GET não assinado) de uma key. Cada segmento é percent-encoded —
 * a key guardada na BD continua a ser a crua, só o link é que vai codificado.
 */
function s3PublicUrl(env: S3Env, key: string): string {
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return `${env.publicBaseUrl}/${encoded}`;
}

/**
 * Aceita uma URL pública do bucket OU uma key crua e devolve sempre a key.
 * (Mesma ideia do `S3StorageService.normalizeKey` do be-multipark.)
 * NÃO remove o prefixo "uploads/" — no S3 isso é uma pasta real (o /api/upload
 * grava lá), ao contrário do modo local em que "uploads/" é a raiz do disco.
 */
function s3NormalizeKey(input: string): string {
  if (!input) return input;
  if (input.startsWith("http://") || input.startsWith("https://")) {
    try {
      const raw = new URL(input).pathname.replace(/^\/+/, "");
      try {
        return decodeURIComponent(raw);
      } catch {
        // Key com "%" literal que não é um escape válido — fica como está.
        return raw;
      }
    } catch {
      return input.replace(/^\/+/, "");
    }
  }
  return input.replace(/^\/+/, "");
}

function ensureUploadsDir() {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  const key = relKey.replace(/^\/+/, "");
  const body = typeof data === "string" ? Buffer.from(data) : data;

  const s3 = readS3Env();
  if (s3) {
    const client = await getS3Client(s3);
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await client.send(
      new PutObjectCommand({
        Bucket: s3.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return { key, url: s3PublicUrl(s3, key) };
  }

  if (!isBlobConfigured()) {
    // No Vercel o filesystem é efémero/read-only e as URLs "/uploads/..."
    // nunca são servidas (rewrite → index.html) — gravar aqui seria lixo na
    // BD com links mortos. Falhar alto para o erro chegar ao utilizador.
    if (process.env.VERCEL) {
      throw new Error(
        "Storage não configurado (BLOB_READ_WRITE_TOKEN em falta no Vercel) — upload indisponível",
      );
    }
    ensureUploadsDir();
    const filePath = path.join(UPLOADS_DIR, key.replace(/\//g, path.sep));
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, body);
    const url = `/uploads/${key}`;
    return { key, url };
  }

  const blob = await put(key, body as Buffer, {
    access: "public",
    contentType,
    addRandomSuffix: false,
  });

  return { key, url: blob.url };
}

export async function storageGet(
  relKey: string
): Promise<{ key: string; url: string }> {
  const key = relKey.replace(/^\/+/, "");

  const s3 = readS3Env();
  if (s3) {
    // O utilizador IAM do upload não pode listar o bucket, mas pode fazer
    // HeadObject na própria key (s3:GetObject) — chega para distinguir
    // "existe" de "não existe" e manter a semântica de url vazia.
    try {
      const client = await getS3Client(s3);
      const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
      await client.send(new HeadObjectCommand({ Bucket: s3.bucket, Key: key }));
      return { key, url: s3PublicUrl(s3, key) };
    } catch {
      return { key, url: "" };
    }
  }

  if (!isBlobConfigured()) {
    const url = `/uploads/${key}`;
    return { key, url };
  }

  try {
    const blob = await head(key);
    return { key, url: blob.url };
  } catch {
    return { key, url: "" };
  }
}

/**
 * Apaga um ficheiro do storage. Aceita a URL pública (S3/Vercel) ou a key/path.
 * Best-effort: nunca lança (um ficheiro órfão não deve partir a operação).
 */
export async function storageDelete(keyOrUrl: string | null | undefined): Promise<void> {
  if (!keyOrUrl) return;
  try {
    const s3 = readS3Env();
    if (s3) {
      const key = s3NormalizeKey(keyOrUrl);
      if (!key) return;
      const client = await getS3Client(s3);
      const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
      await client.send(new DeleteObjectCommand({ Bucket: s3.bucket, Key: key }));
      return;
    }
    if (!isBlobConfigured()) {
      const key = keyOrUrl.replace(/^\/?uploads\//, "").replace(/^\/+/, "");
      const filePath = path.join(UPLOADS_DIR, key.replace(/\//g, path.sep));
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return;
    }
    // O Vercel Blob aceita a URL pública ou a pathname.
    await del(keyOrUrl);
  } catch (err: any) {
    console.warn("[storage] delete falhou:", String(err?.message ?? err).slice(0, 160));
  }
}

/**
 * True quando o upload direto do browser para o storage está disponível
 * (só o S3 o suporta).
 */
export function isPresignedUploadAvailable(): boolean {
  return readS3Env() !== null;
}

/**
 * Gera uma URL assinada de PUT para o browser gravar DIRETAMENTE no bucket,
 * sem passar pelo servidor. É a única via para ficheiros grandes (vídeo): as
 * funções do Vercel têm um teto de ~4.5MB de body e não podem servir de proxy.
 *
 * O cliente tem de fazer `PUT uploadUrl` com o MESMO `Content-Type` que foi
 * assinado (senão a AWS responde 403) e depois guardar a `key`/`url` na BD.
 * O CORS do bucket tem de permitir PUT à origem que faz o pedido.
 *
 * Exclusivo do S3 — sem as envs AWS_* lança, para o chamador poder cair no
 * upload normal (`storagePut`) em vez de gerar links partidos.
 */
export async function storagePresignPut(
  relKey: string,
  contentType = "application/octet-stream",
  expiresSeconds = 60
): Promise<{ key: string; uploadUrl: string; url: string; expiresIn: number }> {
  const s3 = readS3Env();
  if (!s3) {
    throw new Error(
      "Upload direto indisponível: S3 não configurado (faltam AWS_S3_REGION, AWS_S3_BUCKET_NAME, AWS_S3_ACCESS_KEY ou AWS_S3_SECRET_ACCESS_KEY)",
    );
  }

  const key = relKey.replace(/^\/+/, "");
  if (!key) throw new Error("Key inválida para upload direto");

  const expiresIn = Math.max(1, Math.min(Math.trunc(expiresSeconds) || 60, 3600));

  const client = await getS3Client(s3);
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");

  const uploadUrl = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: s3.bucket, Key: key, ContentType: contentType }),
    { expiresIn },
  );

  return { key, uploadUrl, url: s3PublicUrl(s3, key), expiresIn };
}
