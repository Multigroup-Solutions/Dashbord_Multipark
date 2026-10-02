/**
 * P3 lote 19d — Integrações: hub só admin+, estado desconhecido ≠ verde,
 * ligar/desligar só super admin (com registo, confirmação e revogação),
 * testes só de leitura com a conta de quem testa, armazenamento com as 4
 * variáveis do S3, segredos fora dos alertas.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

vi.mock("./db", async (orig) => ({ ...(await orig<object>()), getDb: async () => null }));

import { can } from "../shared/access";
import { integrationStatusesFromEnv, listIntegrationStatusesFull, storageMissing } from "./integrationsStatus";
import { hubTestAllowed } from "./integrations/hubRouter";

const read = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const u = (role: string) => ({ id: 1, role, accessOverrides: {} }) as any;

describe("19d quem vê o hub", () => {
  it("só admin e super admin (ver, testar, gerir)", () => {
    for (const r of ["supervisor", "frontoffice", "backoffice", "team_leader", "extra"]) expect(can(u(r), "integracoes", "view")).toBe(false);
    expect(can(u("admin"), "integracoes", "edit")).toBe(true);
    expect(can(u("super_admin"), "integracoes", "manage")).toBe(true);
  });
  it("o ecrã usa can(user) (com as exceções por pessoa), não só o papel", () => {
    const c = read("client/src/pages/IntegrationsHubPage.tsx");
    expect(c).toMatch(/can\(user as any, "integracoes", "view"\)/);
    expect(c).not.toMatch(/can\(user\?\.role/);
  });
});

describe("19d estado honesto", () => {
  it("sem BD: devolve statusError (o hub mostra 'Estado desconhecido', nunca verde)", async () => {
    const r = await listIntegrationStatusesFull({});
    expect(r.statusError).toMatch(/Base de dados indisponível/);
    expect(r.items.length).toBeGreaterThan(5);
    const c = read("client/src/pages/IntegrationsHubPage.tsx");
    expect(c).toMatch(/statusUnknown\s*\n?\s*\? <Badge[^>]*>Estado desconhecido/);
    expect(read("server/integrations/hubRouter.ts")).toMatch(/return \{ now: Date\.now\(\), encryptionKey: encryptionKeyStatus\(\), items, statusError \}/);
  });
  it("armazenamento: Blob OU as 4 variáveis do S3 (antes bastava o bucket)", () => {
    expect(storageMissing({ AWS_S3_BUCKET_NAME: "b" })).toEqual(["AWS_S3_REGION", "AWS_S3_ACCESS_KEY ou AWS_ACCESS_KEY", "AWS_S3_SECRET_ACCESS_KEY ou AWS_SECRET_ACCESS_KEY"]);
    expect(storageMissing({ BLOB_READ_WRITE_TOKEN: "x" })).toEqual([]);
    expect(storageMissing({ AWS_S3_REGION: "eu-west-1", AWS_S3_BUCKET_NAME: "b", AWS_ACCESS_KEY: "k", AWS_SECRET_ACCESS_KEY: "s" })).toEqual([]);
    expect(integrationStatusesFromEnv({ AWS_S3_BUCKET_NAME: "b" }).find((s) => s.id === "storage")?.configured).toBe(false);
  });
  it("Google Business: última recolha = cron com sucesso (não lastCheckedAt); erro do desempenho no cartão; Meta 190 gravado", () => {
    const s = read("server/integrationsStatus.ts");
    expect(s).not.toMatch(/s\.lastSyncAt = s\.connection\.lastCheckedAt/);
    expect(s).toMatch(/stateKey = 'gbp:lastError'/);
    expect(s).toMatch(/await recordMetaTokenError\(/);
    expect(s).toMatch(/statusError = `Não foi possível ler o estado guardado/);
  });
  it("Google Business: token que não abre → reautorizar; invalid_client = configuração", () => {
    const o = read("server/integrations/googleBusiness/oauth.ts");
    expect(o).toMatch(/Não foi possível decifrar o token guardado/);
    expect(o).toMatch(/status: 'error', lastError: error\.message/);
    expect(o).toMatch(/GOOGLE_BUSINESS_CLIENT_ID\/SECRET configurado/);
  });
});

describe("19d ligar/desligar", () => {
  it("Google Business: só super admin, registado, com revogação e SEM limpar os perfis escolhidos", () => {
    const routes = read("server/integrations/googleBusiness/routes.ts");
    expect(routes).toMatch(/user\.role !== 'super_admin'/);
    expect(routes).toMatch(/action: 'connect'/);
    const router = read("server/integrations/googleBusiness/router.ts");
    expect(router).toMatch(/Só o super admin pode desligar o Google Business/);
    expect(router).toMatch(/action: 'disconnect'/);
    expect(router).toMatch(/action: 'map'/);
    const oauth = read("server/integrations/googleBusiness/oauth.ts");
    const disc = oauth.slice(oauth.indexOf("export async function disconnect"));
    expect(disc).toMatch(/oauth2\.googleapis\.com\/revoke/);
    expect(disc).not.toMatch(/selected = 0/);
    const card = read("client/src/components/GoogleBusinessConnection.tsx");
    expect(card).toMatch(/if \(confirm\('Desligar o Google Business\?/);
    expect(card).toMatch(/isSuper && <Button/);
  });
  it("crons com a verificação segura (tempo constante)", () => {
    expect(read("server/integrations/googleBusiness/routes.ts")).toMatch(/cronAuthOk\(req\.headers\.authorization\)/);
    expect(read("server/integrations/meta/routes.ts")).toMatch(/cronAuthOk\(req\.headers\["authorization"\]\)/);
  });
});

describe("19d Testar", () => {
  it("Drive, Tarefas/Calendário e Contactos testam com a conta de QUEM testa; o Drive só lê", () => {
    const drive = read("server/google/driveService.ts");
    const fn = drive.slice(drive.indexOf("export async function testGoogleDrive"), drive.indexOf("export async function testGoogleDrive") + 2500);
    expect(fn).toMatch(/getFile\("root"\)/);
    expect(fn).not.toMatch(/ensureUserFolder/);
    expect(read("server/google/syncService.ts")).toMatch(/Number\(r\.userId\) === testerUserId/);
    expect(read("server/google/contactsService.ts")).toMatch(/Number\(r\.userId\) === testerUserId/);
    expect(read("server/integrations/hubRouter.ts")).toMatch(/testIntegration\(input\.id, ctx\.user\.id\)/);
  });
  it("no máximo 10 testes por minuto por pessoa", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) expect(hubTestAllowed(77, t0 + i)).toBe(true);
    expect(hubTestAllowed(77, t0 + 20)).toBe(false);
    expect(hubTestAllowed(78, t0 + 20)).toBe(true);
    expect(hubTestAllowed(77, t0 + 61_000)).toBe(true);
  });
  it("os alertas por email não levam segredos", () => {
    expect(read("server/integrations/alerts.ts")).toMatch(/it\.detail = scrubSecrets\(it\.detail, process\.env, 300\)/);
  });
});
