import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regressão do AccessDenied ao abrir comprovativos ANTIGOS.
 *
 * Os ficheiros anteriores ao S3 nunca foram migrados: continuam no Vercel Blob
 * com a URL absoluta gravada em `*Url` e a key CRUA em `*Key`. Como os
 * chamadores preferem a key, o `storagePresignGet` assinava-a contra o bucket
 * do S3 — onde nunca esteve. E como o utilizador IAM não tem `s3:ListBucket`
 * (deliberado, ver `scripts/provision-s3-bucket.ps1`), a AWS responde a um
 * objeto inexistente com **403 AccessDenied em vez de 404**, pelo que o
 * utilizador recebia o XML de erro da AWS em vez do documento.
 */

const BUCKET = 'dashboard-multipark-bucket';
const REGION = 'eu-west-1';
const BLOB_URL = 'https://abc123.public.blob.vercel-storage.com/uploads/999-zz.pdf';

/** Controla o que o HeadObject de existência devolve em cada teste. */
let objectExists = true;
const signedUrls: string[] = [];

vi.mock('@aws-sdk/client-s3', () => {
  class NotFound extends Error {
    $metadata = { httpStatusCode: 403 }; // sem ListBucket, um objeto ausente dá 403
  }
  return {
    S3Client: class {
      async send(cmd: any) {
        if (cmd?.__type === 'head' && !objectExists) throw new NotFound('AccessDenied');
        return {};
      }
    },
    HeadObjectCommand: class {
      __type = 'head';
      constructor(public input: any) {}
    },
    GetObjectCommand: class {
      __type = 'get';
      constructor(public input: any) {}
    },
    PutObjectCommand: class {
      constructor(public input: any) {}
    },
    DeleteObjectCommand: class {
      constructor(public input: any) {}
    },
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async (_client: unknown, cmd: any) => {
    const url = `https://${BUCKET}.s3.${REGION}.amazonaws.com/${cmd.input.Key}?X-Amz-Signature=fake`;
    signedUrls.push(url);
    return url;
  }),
}));

const ENV_KEYS = [
  'AWS_S3_REGION',
  'AWS_S3_BUCKET_NAME',
  'AWS_S3_ACCESS_KEY',
  'AWS_S3_SECRET_ACCESS_KEY',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.AWS_S3_REGION = REGION;
  process.env.AWS_S3_BUCKET_NAME = BUCKET;
  process.env.AWS_S3_ACCESS_KEY = 'AKIAFAKE';
  process.env.AWS_S3_SECRET_ACCESS_KEY = 'secret';
  objectExists = true;
  signedUrls.length = 0;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  vi.resetModules();
});

async function presign(keyOrUrl: string, opts?: { fallbackUrl?: string | null }) {
  const { storagePresignGet } = await import('./storage');
  return storagePresignGet(keyOrUrl, opts);
}

describe('storagePresignGet — ficheiros de outro backend', () => {
  it('assina uma key que existe no bucket', async () => {
    const r = await presign('uploads/123-ab.pdf');
    expect(r.signed).toBe(true);
    expect(r.url).toContain('uploads/123-ab.pdf');
    expect(r.expiresIn).toBeGreaterThan(0);
  });

  it('devolve a URL do Blob tal e qual, sem a assinar', async () => {
    // O bug original: o pathname do Blob virava uma key do S3.
    const r = await presign(BLOB_URL);
    expect(r.url).toBe(BLOB_URL);
    expect(r.signed).toBe(false);
    expect(signedUrls).toHaveLength(0);
  });

  it('recupera o ficheiro antigo pela URL quando a key não está no S3', async () => {
    // O caso real: a linha da era Blob tem key crua + URL do Blob, e o
    // chamador prefere a key. Sem o fallback, isto era o AccessDenied.
    objectExists = false;
    const r = await presign('uploads/999-zz.pdf', { fallbackUrl: BLOB_URL });
    expect(r.url).toBe(BLOB_URL);
    expect(r.signed).toBe(false);
  });

  it('não assina uma key ausente mesmo sem fallback — devolve vazio', async () => {
    // URL vazia mantém a semântica do `storageGet` ("não existe") e faz o
    // chamador responder "sem documento" em vez de reencaminhar para a AWS.
    objectExists = false;
    const r = await presign('uploads/sumiu.pdf');
    expect(r.url).toBe('');
    expect(r.signed).toBe(false);
    expect(signedUrls).toHaveLength(0);
  });

  it('ignora um fallback que aponta para o próprio bucket', async () => {
    // Reencaminhar para a URL pública do S3 daria o mesmo 403 — não é fallback.
    objectExists = false;
    const r = await presign('uploads/sumiu.pdf', {
      fallbackUrl: `https://${BUCKET}.s3.${REGION}.amazonaws.com/uploads/sumiu.pdf`,
    });
    expect(r.url).toBe('');
  });

  it('assina uma URL pública do próprio bucket', async () => {
    const r = await presign(`https://${BUCKET}.s3.${REGION}.amazonaws.com/uploads/123-ab.pdf`);
    expect(r.signed).toBe(true);
    expect(r.url).toContain('X-Amz-Signature');
  });
});
