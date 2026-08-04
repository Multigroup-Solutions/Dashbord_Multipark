import { put, head, del } from "@vercel/blob";
import fs from "fs";
import path from "path";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");

function isBlobConfigured(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
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
 * Apaga um ficheiro do storage. Aceita a URL do blob (Vercel) ou a key/path.
 * Best-effort: nunca lança (um ficheiro órfão não deve partir a operação).
 */
export async function storageDelete(keyOrUrl: string | null | undefined): Promise<void> {
  if (!keyOrUrl) return;
  try {
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
