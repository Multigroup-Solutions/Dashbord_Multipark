/**
 * Google Workspace real (dono, 27 set 2026): domínios alternativos no
 * encaminhamento por alias (reclamacoes@skypark.pt = reclamacoes@multipark.pt)
 * e o passo de dados da migração 0210 (caixas info@/reservas@). Sem BD.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  brandOfAddress, classifyMessage, DEFAULT_BRAND_DOMAINS, DEFAULT_MAIL_ALIAS_DOMAINS, domainAliasVariants, mailboxConfigSchema, resolveAlias,
  workspaceDomainsOf, type MailboxConfig,
} from "../shared/mail";
import { SETTINGS } from "../shared/appSettings";
import { DATA_0210_ID, faroCityIdOf, mergeMailboxes0210, MIGRATION_0210_STATEMENTS, type MailboxRow0210 } from "./migrations/migration_0210";

const root = resolve(import.meta.dirname, "..");
const ws = workspaceDomainsOf(DEFAULT_MAIL_ALIAS_DOMAINS);

const mb = (over: Partial<MailboxConfig>): MailboxConfig => mailboxConfigSchema.parse({
  key: "x", label: "X", addresses: [{ address: "x@multipark.pt", brand: "multipark" }], sourceKind: "dwd",
  sourceEmail: "reservas@multipark.pt", module: "comunicacao", ...over,
});

const reservasBoxes: MailboxConfig[] = [
  mb({
    key: "reservas", label: "Reservas", module: "reservas_operacoes", catchAll: true,
    addresses: [{ address: "reservas@multipark.pt", brand: "multipark", destination: "reservas" }] as any,
  }),
  mb({
    key: "reclamacoes", label: "Reclamações", module: "reclamacoes", pipeline: "reclamacoes",
    addresses: [{ address: "reclamacoes@multipark.pt", brand: "multipark", owner: "role:backoffice", tag: "Reclamações" }] as any,
  }),
  mb({
    key: "perdidos", label: "Perdidos", module: "perdidos", pipeline: "perdidos",
    addresses: [
      { address: "perdidos@multipark.pt", brand: "multipark" },
      { address: "perdidos@redpark.pt", brand: "redpark", tag: "Perdidos Redpark (exato)" },
      { address: "perdidos@multibags.pt", brand: "multibags", active: false },
    ] as any,
  }),
];
const account = ["reservas@multipark.pt"];

describe("domínios alternativos do Workspace", () => {
  it("lista de domínios e variantes (principal primeiro; fora do Workspace → nada)", () => {
    expect(ws[0]).toBe("multipark.pt");
    expect(ws).toEqual(["multipark.pt", "skypark.pt", "redpark.pt", "multibags.pt", "multivalet.pt", "multibags.app", "multipark.app"]);
    expect(workspaceDomainsOf(["SkyPark.pt", "@redpark.pt", "skypark.pt"])).toEqual(["multipark.pt", "skypark.pt", "redpark.pt"]);
    expect(domainAliasVariants("Reclamacoes@SkyPark.pt", ws)[0]).toBe("reclamacoes@multipark.pt");
    expect(domainAliasVariants("reclamacoes@airpark.pt", ws)).toEqual([]);
    expect(domainAliasVariants("reclamacoes@skypark.pt", [])).toEqual([]);
  });

  it("reclamacoes@skypark.pt → alias reclamacoes (caixa, destino, responsável), marca Skypark", () => {
    const r = resolveAlias({ deliveredTo: ["reservas@multipark.pt"], to: ["reclamacoes@skypark.pt"] }, reservasBoxes, { accountEmails: account, workspaceDomains: ws });
    expect(r).toMatchObject({ mailboxKey: "reclamacoes", matchedAddress: "reclamacoes@skypark.pt", via: "to", domainAliasOf: "reclamacoes@multipark.pt" });
    expect(r.alias).toMatchObject({ address: "reclamacoes@multipark.pt", brand: "skypark", owner: "role:backoffice", tag: "Reclamações" });
    const c = classifyMessage({ deliveredTo: ["reservas@multipark.pt"], to: ["reclamacoes@skypark.pt"] }, reservasBoxes, { accountEmails: account, workspaceDomains: ws });
    expect(c).toMatchObject({ mailboxKey: "reclamacoes", brand: "skypark", triage: false });
    // A linha da tabela não é alterada (a marca é só desta mensagem).
    expect(reservasBoxes[1].addresses[0].brand).toBe("multipark");
  });

  it("reservas@multivalet.pt → alias reservas (marca Multipark: multivalet.pt é da Multipark)", () => {
    const c = classifyMessage({ to: ["reservas@multivalet.pt"] }, reservasBoxes, { accountEmails: account, workspaceDomains: ws });
    expect(c).toMatchObject({ mailboxKey: "reservas", brand: "multipark", triage: false, matchedAddress: "reservas@multivalet.pt" });
    expect(c.alias?.destination).toBe("reservas");
    expect(classifyMessage({ to: ["info@multibags.app"] }, [mb({ key: "info", addresses: [{ address: "info@multipark.pt", brand: "multipark" }] as any })], { workspaceDomains: ws }))
      .toMatchObject({ mailboxKey: "info", brand: "multibags" });
  });

  it("marca: domínio sem marca configurada → a do alias", () => {
    const domains = { ...DEFAULT_BRAND_DOMAINS, skypark: [] };
    const c = classifyMessage({ to: ["reclamacoes@skypark.pt"] }, reservasBoxes, { workspaceDomains: ws, brandDomains: domains });
    expect(c).toMatchObject({ mailboxKey: "reclamacoes", brand: "multipark" });
  });

  it("a correspondência exata ganha sempre (mesmo cabeçalho e mesmo endereço noutra linha)", () => {
    const exact = resolveAlias({ to: ["perdidos@redpark.pt"] }, reservasBoxes, { workspaceDomains: ws });
    expect(exact).toMatchObject({ mailboxKey: "perdidos", domainAliasOf: null });
    expect(exact.alias?.tag).toBe("Perdidos Redpark (exato)");
    // No mesmo cabeçalho, o exato (2.º) ganha ao equivalente por domínio (1.º).
    expect(resolveAlias({ to: ["reclamacoes@skypark.pt", "perdidos@multipark.pt"] }, reservasBoxes, { workspaceDomains: ws }))
      .toMatchObject({ mailboxKey: "perdidos", matchedAddress: "perdidos@multipark.pt" });
  });

  it("alias desligado de propósito não volta a encaminhar pelo domínio alternativo", () => {
    expect(classifyMessage({ deliveredTo: ["reservas@multipark.pt"], to: ["perdidos@multibags.pt"] }, reservasBoxes, { accountEmails: account, workspaceDomains: ws }))
      .toMatchObject({ triage: true, alias: null });
  });

  it("nome local desconhecido → comportamento antigo (Por classificar, marca pelo domínio)", () => {
    const c = classifyMessage({ deliveredTo: ["reservas@multipark.pt"], to: ["geral@skypark.pt"] }, reservasBoxes, { accountEmails: account, workspaceDomains: ws });
    expect(c).toMatchObject({ triage: true, alias: null, brand: "skypark", mailboxKey: "reservas" });
    // Domínio fora do Workspace (airpark.pt ainda não entrou) → também Por classificar.
    expect(classifyMessage({ to: ["reclamacoes@airpark.pt"] }, reservasBoxes, { workspaceDomains: ws })).toMatchObject({ triage: true, alias: null });
  });

  it("sem domínios do Workspace (lista vazia) → só correspondências exatas, como antes", () => {
    expect(classifyMessage({ to: ["reclamacoes@skypark.pt"] }, reservasBoxes, { workspaceDomains: [] })).toMatchObject({ triage: true, alias: null });
    expect(classifyMessage({ to: ["reclamacoes@skypark.pt"] }, reservasBoxes)).toMatchObject({ triage: true, alias: null });
  });

  it("a própria conta num domínio alternativo no Delivered-To é saltada (o alias vem do To)", () => {
    expect(resolveAlias({ deliveredTo: ["reservas@skypark.pt"], to: ["reclamacoes@redpark.pt"] }, reservasBoxes, { accountEmails: account, workspaceDomains: ws }))
      .toMatchObject({ mailboxKey: "reclamacoes", via: "to", alias: { brand: "redpark" } });
  });

  it("enviadas pelo From num domínio alternativo", () => {
    expect(classifyMessage({ from: "reclamacoes@redpark.pt", to: ["c@gmail.com"] }, reservasBoxes, { outbound: true, workspaceDomains: ws }))
      .toMatchObject({ mailboxKey: "reclamacoes", brand: "redpark", triage: false });
  });

  it("domínios por marca: multipark.app, multibags.app, multivalet.pt (sem marca Multivalet)", () => {
    expect(brandOfAddress("a@multipark.app")).toBe("multipark");
    expect(brandOfAddress("a@multibags.app")).toBe("multibags");
    expect(brandOfAddress("a@multivalet.pt")).toBe("multipark");
    expect(brandOfAddress("a@airpark.pt")).toBe("airpark");
    expect(brandOfAddress("a@multidriver.pt")).toBe("multidriver");
    expect(Object.keys(DEFAULT_BRAND_DOMAINS)).not.toContain("multivalet");
  });

  it("parâmetro mail.aliasDomains (omissão = os 6 domínios; valida domínios)", () => {
    const s = (SETTINGS as any)["mail.aliasDomains"];
    expect(s.defaultValue).toEqual([...DEFAULT_MAIL_ALIAS_DOMAINS]);
    expect(s.schema.safeParse(["skypark.pt"]).success).toBe(true);
    expect(s.schema.safeParse(["não é domínio"]).success).toBe(false);
    expect(s.schema.safeParse([]).success).toBe(true);
  });

  it("a sincronização passa os domínios do Workspace à classificação", () => {
    expect(readFileSync(resolve(root, "server/mail/sync.ts"), "utf8")).toMatch(/workspaceDomains: opts\.workspaceDomains/);
    expect(readFileSync(resolve(root, "server/mail/service.ts"), "utf8")).toMatch(/loadWorkspaceDomains\(\)/);
  });
});

// ─── Migração 0210 (passo de dados) ─────────────────────────────────────────

const seed = (key: string, address: string, extra: Partial<MailboxRow0210> = {}): MailboxRow0210 => ({
  mailboxKey: key, sourceKind: "dwd", sourceEmail: "reservas@multipark.pt", addresses: [{ address, brand: "multipark" }], ...extra,
});
// As caixas como a 0145 as semeou.
const seeded = (): MailboxRow0210[] => [
  seed("reclamacoes", "reclamacoes@multipark.pt"), seed("perdidos", "perdidos@multipark.pt"), seed("criticas", "criticas@multipark.pt"),
  seed("ocorrencias", "ocorrencias@multipark.pt"), seed("rh", "recursos-humanos@multipark.pt"), seed("campanhas", "campanhas@multipark.pt"),
  seed("info", "info@multipark.pt"), seed("comercial", "comercial@multipark.pt"), seed("admin", "admin@multipark.pt"),
  seed("reservas", "reservas@multipark.pt"),
];
const byKey = (ps: ReturnType<typeof mergeMailboxes0210>) => Object.fromEntries(ps.map((p) => [p.mailboxKey, p]));

describe("migração 0210 — caixas do Workspace real", () => {
  it("sobre as caixas semeadas: info@ passa a ler de info@, aliases novos, responsáveis e destino", () => {
    const p = byKey(mergeMailboxes0210(seeded(), { faroCityId: 42 }));
    expect(Object.keys(p).sort()).toEqual(["criticas", "info", "perdidos", "reclamacoes", "reservas", "rh"]);
    expect(p.info.sourceEmail).toBe("info@multipark.pt");
    expect(p.info.addresses).toEqual([
      { address: "info@multipark.pt", brand: "multipark", owner: "role:admin" },
      { address: "redpark@multipark.pt", brand: "redpark", cityId: null, destination: "geral", owner: null, tag: "Redpark", active: true },
      { address: "skypark@multipark.pt", brand: "skypark", cityId: null, destination: "geral", owner: null, tag: "Skypark", active: true },
      { address: "airpark@multipark.pt", brand: "airpark", cityId: null, destination: "geral", owner: null, tag: "Airpark", active: true },
      { address: "airparkfaro@multipark.pt", brand: "airpark", cityId: 42, destination: "geral", owner: null, tag: "Airpark Faro", active: true },
      { address: "driver@multipark.pt", brand: "multidriver", cityId: null, destination: "recursos-humanos", owner: "role:admin", tag: "Condutores", active: true },
    ]);
    expect(p.reservas.sourceEmail).toBeUndefined();
    expect(p.reservas.addresses).toEqual([
      { address: "reservas@multipark.pt", brand: "multipark", owner: "role:backoffice", destination: "reservas" },
      { address: "escala@multipark.pt", brand: "multipark", cityId: null, destination: "geral", owner: "role:supervisor", tag: "Escala", active: true },
    ]);
    expect(p.reclamacoes.addresses?.[0].owner).toBe("role:backoffice");
    expect(p.perdidos.addresses?.[0].owner).toBe("role:backoffice");
    expect(p.criticas.addresses?.[0].owner).toBe("role:backoffice");
    expect(p.rh.addresses?.[0].owner).toBe("role:admin");
    // ocorrencias@, campanhas@, comercial@ (não existem no Workspace) e admin@ ficam como estão.
    for (const k of ["ocorrencias", "campanhas", "comercial", "admin"]) expect(p[k]).toBeUndefined();
  });

  it("o resultado é uma configuração válida (as caixas não desaparecem por JSON inválido)", () => {
    const p = byKey(mergeMailboxes0210(seeded(), { faroCityId: null }));
    for (const k of ["info", "reservas", "rh"]) {
      const cfg = mailboxConfigSchema.safeParse({ key: k, label: k, addresses: p[k].addresses, sourceKind: "dwd", sourceEmail: p[k].sourceEmail ?? "reservas@multipark.pt", module: "comunicacao" });
      expect(cfg.success).toBe(true);
    }
    expect(p.info.addresses?.find((a) => a.address === "airparkfaro@multipark.pt")?.cityId).toBeNull();
  });

  it("nunca sobrepõe o que um administrador mudou", () => {
    const rows = seeded();
    const info = rows.find((r) => r.mailboxKey === "info")!;
    info.sourceEmail = "outra@multipark.pt";
    info.addresses = [{ address: "info@multipark.pt", brand: "multipark", owner: "user:9" }];
    const res = rows.find((r) => r.mailboxKey === "reservas")!;
    res.addresses = [{ address: "reservas@multipark.pt", brand: "multipark", destination: "geral", owner: "role:frontoffice" }];
    // redpark@ já está noutra caixa (mudado pelo admin) → não é acrescentado ao info.
    rows.find((r) => r.mailboxKey === "reclamacoes")!.addresses = [
      { address: "reclamacoes@multipark.pt", brand: "multipark", owner: "user:3" }, { address: "redpark@multipark.pt", brand: "redpark" },
    ];
    const p = byKey(mergeMailboxes0210(rows, { faroCityId: 1 }));
    expect(p.info.sourceEmail).toBeUndefined();
    expect(p.info.addresses?.[0]).toEqual({ address: "info@multipark.pt", brand: "multipark", owner: "user:9" });
    expect(p.info.addresses?.map((a) => a.address)).not.toContain("redpark@multipark.pt");
    expect(p.reservas.addresses?.[0]).toEqual({ address: "reservas@multipark.pt", brand: "multipark", destination: "geral", owner: "role:frontoffice" });
    expect(p.reclamacoes).toBeUndefined();
  });

  it("idempotente, caixas apagadas e JSON inválido ignorados; conta 'user' não muda", () => {
    const rows = seeded();
    const once = mergeMailboxes0210(rows, { faroCityId: 1 });
    const applied = rows.map((r) => {
      const p = once.find((x) => x.mailboxKey === r.mailboxKey);
      return { ...r, addresses: p?.addresses ?? r.addresses, sourceEmail: p?.sourceEmail ?? r.sourceEmail };
    });
    expect(mergeMailboxes0210(applied, { faroCityId: 1 })).toEqual([]);
    const withoutInfo = seeded().filter((r) => r.mailboxKey !== "info");
    expect(mergeMailboxes0210(withoutInfo, { faroCityId: 1 }).map((p) => p.mailboxKey)).not.toContain("info");
    const broken = seeded().map((r) => (r.mailboxKey === "reservas" ? { ...r, addresses: null } : r));
    expect(mergeMailboxes0210(broken, { faroCityId: 1 }).map((p) => p.mailboxKey)).not.toContain("reservas");
    const userSrc = seeded().map((r) => (r.mailboxKey === "info" ? { ...r, sourceKind: "user", sourceEmail: "reservas@multipark.pt" } : r));
    expect(byKey(mergeMailboxes0210(userSrc, { faroCityId: 1 })).info.sourceEmail).toBeUndefined();
  });

  it("cidade de Faro: nó level='city' único (preferindo os ativos); senão null", () => {
    expect(faroCityIdOf([{ id: 1, name: "Lisboa", level: "city" }, { id: 3, name: "Faro", level: "city" }, { id: 9, name: "Faro", level: "project" }])).toBe(3);
    expect(faroCityIdOf([{ id: 3, name: "Faro", level: "city", isActive: 0 }, { id: 4, name: "Faro (Aeroporto)", level: "city", isActive: 1 }])).toBe(4);
    expect(faroCityIdOf([{ id: 3, name: "Faro", level: "city" }, { id: 4, name: "Faro 2", level: "city" }])).toBeNull();
    expect(faroCityIdOf([])).toBeNull();
  });

  it("registo: SQL idempotente, marca própria e passo de dados em ensureRecentSchema", () => {
    for (const s of MIGRATION_0210_STATEMENTS) expect(s).toMatch(/^CREATE TABLE IF NOT EXISTS/);
    expect(DATA_0210_ID.length).toBeLessThanOrEqual(64);
    const dbTs = readFileSync(resolve(root, "server/db.ts"), "utf8");
    expect(dbTs.indexOf("migration_0210")).toBeGreaterThan(dbTs.indexOf("migration_0205"));
    expect(dbTs).toMatch(/runMigration0210Data/);
    const mig = readFileSync(resolve(root, "server/migrations/migration_0210.ts"), "utf8");
    // Marca inserida ANTES de ler/escrever as caixas, na mesma transação.
    expect(mig.indexOf("INSERT INTO app_notification_maintenance")).toBeLessThan(mig.indexOf("FROM mail_mailboxes FOR UPDATE"));
    expect(mig).toMatch(/db\.transaction/);
  });
});
