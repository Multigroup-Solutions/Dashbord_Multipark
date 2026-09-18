import { describe, expect, it } from "vitest";
import { isVercelBlobUrl, keyFromBlobUrl } from "../shared/blobUrls";

/** O caso real que motivou tudo — uma fatura de despesa presa no Blob. */
const REAL =
  "https://sauimqsqlry60luh.public.blob.vercel-storage.com/invoices/5295/1781282012132-3yl20z-GIBRIL%20BALDE%20Recibo%2001.03%20a%2015.03%20413%2C02%20euros.pdf";

describe("isVercelBlobUrl", () => {
  it("reconhece um blob público", () => {
    expect(isVercelBlobUrl(REAL)).toBe(true);
    expect(isVercelBlobUrl("https://abc123.public.blob.vercel-storage.com/uploads/x.pdf")).toBe(true);
  });

  it("recusa o que não é nosso — a migração nunca pode reescrever isto", () => {
    // `training_videos.videoUrl` e afins guardam endereços externos.
    expect(isVercelBlobUrl("https://www.youtube.com/watch?v=abc")).toBe(false);
    expect(isVercelBlobUrl("https://exemplo.pt/ficheiro.pdf")).toBe(false);
    // Já no S3: migrar de novo seria duplicar.
    expect(isVercelBlobUrl("https://dashboard-multipark-bucket.s3.eu-west-1.amazonaws.com/uploads/x.pdf")).toBe(false);
  });

  it("recusa keys cruas, caminhos locais e vazios", () => {
    expect(isVercelBlobUrl("uploads/x.pdf")).toBe(false);
    expect(isVercelBlobUrl("/uploads/x.pdf")).toBe(false);
    expect(isVercelBlobUrl("")).toBe(false);
    expect(isVercelBlobUrl(null)).toBe(false);
    expect(isVercelBlobUrl(undefined)).toBe(false);
  });

  it("não se deixa enganar por um host que apenas CONTÉM o sufixo", () => {
    // O sufixo tem de FECHAR o host, senão um domínio atacante passava.
    expect(isVercelBlobUrl("https://x.public.blob.vercel-storage.com.evil.pt/a.pdf")).toBe(false);
  });

  it("aceita maiúsculas no host", () => {
    expect(isVercelBlobUrl("https://ABC.PUBLIC.BLOB.VERCEL-STORAGE.COM/uploads/x.pdf")).toBe(true);
  });
});

describe("keyFromBlobUrl", () => {
  it("descodifica o pathname, incluindo espaços e vírgulas", () => {
    expect(keyFromBlobUrl(REAL)).toBe(
      "invoices/5295/1781282012132-3yl20z-GIBRIL BALDE Recibo 01.03 a 15.03 413,02 euros.pdf",
    );
  });

  it("tira a barra inicial e ignora a query string", () => {
    expect(keyFromBlobUrl("https://a.public.blob.vercel-storage.com/uploads/x.pdf?v=2")).toBe("uploads/x.pdf");
  });

  it("aguenta um % literal que não é um escape válido", () => {
    // `decodeURIComponent` lança nestes casos; a key fica como está em vez de
    // rebentar a migração a meio.
    const url = "https://a.public.blob.vercel-storage.com/uploads/100%-feito.pdf";
    expect(() => keyFromBlobUrl(url)).not.toThrow();
    expect(keyFromBlobUrl(url)).toContain("uploads/");
  });

  it("lança para uma URL que não é do Blob", () => {
    expect(() => keyFromBlobUrl("https://exemplo.pt/a.pdf")).toThrow();
  });
});
