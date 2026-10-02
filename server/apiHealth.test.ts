import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

// O /api/health é servido pelo bundle Express (api/index.js, gerado a partir de
// server/_core/api-entry.ts). Testa-se o handler real, por HTTP.

type Handler = (req: any, res: any) => unknown;
const servers: Server[] = [];
let handler: Handler;

async function getHealth(h: Handler, headers: Record<string, string> = {}) {
  const server = createServer((req, res) => void h(req, res));
  servers.push(server);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/api/health`, { headers });
  return { status: res.status, text: await res.text() };
}

const loadHandler = async (): Promise<Handler> => (await import("./_core/api-entry")).default;
// Importar o api-entry carrega a app toda (rotas, routers, integrações): leva
// segundos, por isso não pode contar para o prazo de 5 s de cada teste.
const IMPORT_TIMEOUT = 60_000;

beforeAll(async () => {
  vi.stubEnv("CRON_SECRET", "cron-de-teste");
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "0123456789abcdef");
  // Inalcançável de propósito: o /api/health não pode precisar da BD.
  vi.stubEnv("DATABASE_URL", "mysql://teste:segredo-da-bd@127.0.0.1:1/nada");
  handler = await loadHandler();
}, IMPORT_TIMEOUT);

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((done, fail) => server.close(err => (err ? fail(err) : done())));
  }
  vi.restoreAllMocks();
});

afterAll(() => vi.unstubAllEnvs());

describe("/api/health — bundle Express", () => {
  it("api/ só tem o bundle: uma função própria ali sobrepõe-se ao rewrite /api/(.*) e é compilada sozinha (ESM — imports relativos sem extensão dão ERR_MODULE_NOT_FOUND)", () => {
    const functions = readdirSync(resolve(import.meta.dirname, "..", "api"))
      .filter(name => !name.startsWith("_") && !name.startsWith("."));
    expect(functions.sort()).toEqual(["index.js"]);
  });

  it("público: 200 com { ok, version } e mais nada", async () => {
    const r = await getHealth(handler);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ ok: true, version: "0123456" });
  });

  it("Bearer CRON_SECRET: 200 com a presença (booleana) das variáveis, nunca os valores", async () => {
    const r = await getHealth(handler, { Authorization: "Bearer cron-de-teste" });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toMatchObject({ ok: true, version: "0123456", env: { DATABASE_URL: true, CRON_SECRET: true } });
    expect(r.text).not.toContain("segredo-da-bd");
    expect(r.text).not.toContain("cron-de-teste");
  });

  it("Bearer errado ou cookie de sessão inválido: resposta pública", async () => {
    for (const headers of [{ Authorization: "Bearer errado" }, { Cookie: "app_session_id=lixo" }]) {
      const r = await getHealth(handler, headers);
      expect(r.status).toBe(200);
      expect(JSON.parse(r.text)).toEqual({ ok: true, version: "0123456" });
    }
  });

  it("arranque falhado: 503 com { ok: false } — mensagem e stack só no log, nunca na resposta", async () => {
    vi.resetModules();
    vi.doMock("./integrations/googleAds/routes", async (importOriginal) => ({
      ...(await importOriginal<object>()),
      registerGoogleAdsRoutes: () => { throw new Error("rebentou no arranque: segredo-do-stack"); },
    }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await getHealth(await loadHandler());
      expect(r.status).toBe(503);
      expect(JSON.parse(r.text)).toEqual({ ok: false, version: "0123456" });
      expect(r.text).not.toContain("segredo-do-stack");
      expect(log).toHaveBeenCalledWith("[API Init Error]", expect.stringContaining("segredo-do-stack"));
    } finally {
      vi.doUnmock("./integrations/googleAds/routes");
      vi.resetModules();
    }
  }, IMPORT_TIMEOUT);
});
