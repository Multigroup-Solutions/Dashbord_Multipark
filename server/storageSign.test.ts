import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SIGN_EXPIRES_S,
  _resetSignCache,
  canonicalStorageUrl,
  canonicalStorageUrlsDeep,
  signStorageUrlsDeep,
  storageReadableUrl,
} from "./storageSign";

// Assinatura REAL do SDK da AWS com credenciais falsas (é local, sem rede):
// confirma a key, a validade e que o link é estável dentro da hora.
const BUCKET = "dashboard-multipark-bucket";
const REGION = "eu-west-1";
const BASE = `https://${BUCKET}.s3.${REGION}.amazonaws.com`;
const PHOTO = `${BASE}/employees/7/photo-1700000000.jpg`;
const BLOB = "https://abc123.public.blob.vercel-storage.com/uploads/999-zz.pdf";
const T0 = Date.UTC(2026, 9, 1, 10, 20, 0); // 10:20 UTC

const ENV = {
  AWS_S3_REGION: REGION,
  AWS_S3_BUCKET_NAME: BUCKET,
  AWS_S3_ACCESS_KEY: "AKIAFAKEFAKEFAKE",
  AWS_S3_SECRET_ACCESS_KEY: "fakesecretfakesecretfakesecret",
};
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  saved.S3_PUBLIC_BASE_URL = process.env.S3_PUBLIC_BASE_URL;
  delete process.env.S3_PUBLIC_BASE_URL;
  _resetSignCache();
});
afterEach(() => {
  for (const k of [...Object.keys(ENV), "S3_PUBLIC_BASE_URL"]) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

describe("signStorageUrlsDeep (à saída)", () => {
  it("assina a URL deste bucket com a mesma key e validade de 3 h a contar da hora", async () => {
    const out = await signStorageUrlsDeep({ employee: { photoUrl: PHOTO } }, { nowMs: T0 });
    const u = new URL(out.employee.photoUrl);
    expect(u.host).toBe(`${BUCKET}.s3.${REGION}.amazonaws.com`);
    expect(decodeURIComponent(u.pathname)).toBe("/employees/7/photo-1700000000.jpg");
    expect(u.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(u.searchParams.get("X-Amz-Expires")).toBe(String(SIGN_EXPIRES_S));
    expect(u.searchParams.get("X-Amz-Date")).toBe("20261001T100000Z"); // hora arredondada
  });

  it("dá o MESMO link dentro da hora e outro na hora seguinte", async () => {
    const a = await signStorageUrlsDeep(PHOTO, { nowMs: T0 });
    _resetSignCache();
    const b = await signStorageUrlsDeep(PHOTO, { nowMs: T0 + 30 * 60_000 });
    const c = await signStorageUrlsDeep(PHOTO, { nowMs: T0 + 50 * 60_000 });
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });

  it("deixa iguais as URLs do Blob, as externas e os links já assinados", async () => {
    const already = `${BASE}/employees/7/docs/cc.pdf?X-Amz-Signature=abc&X-Amz-Expires=600`;
    const input = { a: BLOB, b: "https://example.com/x.jpg", c: already, d: "texto", e: 42, f: null };
    const out = await signStorageUrlsDeep(input, { nowMs: T0 });
    expect(out).toBe(input); // nada mudou → o mesmo objeto
  });

  it("assina uma URL no meio de texto e mantém a pontuação final", async () => {
    const body = `A folha foi gerada.\n\nLink do PDF: ${BASE}/payroll/folha_2026_9.pdf.`;
    const out = await signStorageUrlsDeep({ body }, { nowMs: T0 });
    expect(out.body.startsWith(`A folha foi gerada.\n\nLink do PDF: ${BASE}/payroll/folha_2026_9.pdf?`)).toBe(true);
    expect(out.body).toMatch(/X-Amz-Signature=[0-9a-f]+/);
    expect(out.body.endsWith(".")).toBe(true);
    expect(out.body.endsWith(".pdf.")).toBe(false);
  });

  it("não altera o objeto recebido (pode estar em cache) e mantém Date e números", async () => {
    const when = new Date(T0);
    const row = { id: 1, photoUrl: PHOTO, createdAt: when, tags: ["a", PHOTO] };
    const out = await signStorageUrlsDeep([row], { nowMs: T0 });
    expect(row.photoUrl).toBe(PHOTO);
    expect(row.tags[1]).toBe(PHOTO);
    expect(out[0]).not.toBe(row);
    expect(out[0].createdAt).toBe(when);
    expect(out[0].id).toBe(1);
    expect(out[0].tags[1]).toBe(out[0].photoUrl);
    expect(out[0].photoUrl).toContain("X-Amz-Signature=");
  });

  it("sem S3 configurado não mexe em nada", async () => {
    delete process.env.AWS_S3_BUCKET_NAME;
    const input = { photoUrl: PHOTO };
    expect(await signStorageUrlsDeep(input, { nowMs: T0 })).toBe(input);
  });

  it("reconhece a base pública configurada (CDN à frente do bucket)", async () => {
    process.env.S3_PUBLIC_BASE_URL = "https://files.multipark.pt";
    const out = await signStorageUrlsDeep({ u: "https://files.multipark.pt/crm/5/photo-1.jpg" }, { nowMs: T0 });
    expect(out.u).toContain("X-Amz-Signature=");
    expect(decodeURIComponent(new URL(out.u).pathname)).toBe("/crm/5/photo-1.jpg");
  });
});

describe("canonicalStorageUrlsDeep (à entrada)", () => {
  it("um link assinado deste bucket volta à URL canónica; o resto fica igual", async () => {
    const signed = await signStorageUrlsDeep(PHOTO, { nowMs: T0 });
    const input = { id: 7, photoUrl: signed, other: "https://example.com/a?X-Amz-Signature=zzz", blob: BLOB };
    const out = canonicalStorageUrlsDeep(input);
    expect(out.photoUrl).toBe(PHOTO);
    expect(out.other).toBe(input.other);
    expect(out.blob).toBe(BLOB);
    expect(input.photoUrl).toBe(signed);
  });

  it("sem links assinados devolve o mesmo valor", () => {
    const input = { photoUrl: PHOTO, n: 1 };
    expect(canonicalStorageUrlsDeep(input)).toBe(input);
    expect(canonicalStorageUrl(BLOB)).toBe(BLOB);
  });
});

describe("storageReadableUrl (leituras do servidor)", () => {
  it("assina URLs e keys deste bucket; deixa as outras", async () => {
    expect(await storageReadableUrl(PHOTO, T0)).toContain("X-Amz-Signature=");
    expect(await storageReadableUrl("driver-history/2026-10-01/joao.geojson", T0)).toContain("/driver-history/2026-10-01/joao.geojson?");
    expect(await storageReadableUrl(BLOB, T0)).toBe(BLOB);
    expect(await storageReadableUrl("https://example.com/a.mp3", T0)).toBe("https://example.com/a.mp3");
  });
});
