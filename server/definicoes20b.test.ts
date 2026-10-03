/**
 * P3 lote 20b — Definições: estado desconhecido ≠ "Tudo a correr", saltado ≠
 * feito, cron parado há mais de 30 dias continua parado, segredos fora dos
 * erros, acesso pela matriz, super admin no CRM_AUTO_MERGE e no remetente,
 * gravações que não pisam a de outra pessoa, editor dos telefones.
 */
import fs from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ calls: 0, firstRow: null as any, enabled: false }));

vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => ({ all: true, defaultCityId: null, cityIds: [], projectIds: [], missingCostCenter: false }),
}));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getUserPermissionOverrides: async () => ({}),
  getDb: async () => (fake.enabled
    ? { execute: async () => { fake.calls++; return fake.calls === 1 ? [[fake.firstRow].filter(Boolean)] : [{ affectedRows: 1 }]; } }
    : null),
}));

import { appRouter } from "./routers";
import { applyOutcome, emptyState, type TickJobSpec } from "./cronSchedule";
import { skippedReason } from "./cronScheduler";
import { getCronStatuses } from "./cronRuns";
import { SettingConflictError, setSetting } from "./appSettings";
import { automationFlagSuperAdminOnly, settingSuperAdminOnly, validateSetting } from "../shared/appSettings";

const read = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const caller = (role: string, id = 1) => appRouter.createCaller({ user: { id, role, name: "Rita", accessOverrides: {} }, req: { headers: {} }, res: {} } as any);

beforeEach(() => { fake.calls = 0; fake.firstRow = null; fake.enabled = false; });

const daily: TickJobSpec = { key: "crm-auto-merge", runName: "crm-auto-merge", label: "x", cadence: { kind: "daily", from: "05:30" }, priority: 1, minMs: 1000, maxMs: 2000 } as any;

describe("20b saltado ≠ feito", () => {
  it("corrida saltada: período arrumado, mas o Último OK não avança e o motivo fica", () => {
    const prev = { ...emptyState("crm-auto-merge"), lastOkAt: 111, lastStatus: "ok" as const };
    const t = Date.parse("2026-10-02T05:40:00Z");
    const st = applyOutcome(daily, prev, { ok: true, done: true, cursor: null, error: null, startedAt: t, finishedAt: t + 500, skipped: "CRM_AUTO_MERGE desligado" });
    expect(st.lastStatus).toBe("skipped");
    expect(st.lastOkAt).toBe(111);
    expect(st.lastError).toBe("saltado: CRM_AUTO_MERGE desligado");
    expect(st.periodKey).toBe("2026-10-02");
    const ok = applyOutcome(daily, prev, { ok: true, done: true, cursor: null, error: null, startedAt: t, finishedAt: t + 500 });
    expect([ok.lastStatus, ok.lastOkAt]).toEqual(["ok", t + 500]);
  });
  it("motivo: skipped (texto/true/status); 'locked' não é salto", () => {
    expect(skippedReason({ skipped: "zello_not_configured" })).toBe("zello_not_configured");
    expect(skippedReason({ skipped: true, reason: "sem contas" })).toBe("sem contas");
    expect(skippedReason({ status: "skipped" })).toBe("sem motivo indicado");
    expect(skippedReason({ skipped: "locked" })).toBeNull();
    expect(skippedReason({ ok: true })).toBeNull();
    expect(read("server/cronScheduler.ts")).toMatch(/skipped: outcome\.ok \? skippedReason\(run\.body\) : null/);
  });
});

describe("20b estado dos crons", () => {
  it("sem BD = erro (a página mostra 'Estado desconhecido', nunca 'Tudo a correr')", async () => {
    await expect(getCronStatuses()).rejects.toThrow(/estado dos crons desconhecido/);
    const page = read("client/src/pages/DefinicoesPage.tsx");
    expect(page).toMatch(/!q\.data\s*\n?\s*\? <Badge[^>]*>Estado desconhecido<\/Badge>\s*\n?\s*: problems > 0/);
    expect(page).toMatch(/what="o estado dos crons"/);
    expect(page).toMatch(/skipped: \{ label: "Saltado"/);
  });
  it("Último OK sem as saltadas; a última corrida de cada cron nunca se apaga; mail-sync pela cadência em vigor", () => {
    const src = read("server/cronRuns.ts");
    expect(src).toMatch(/WHERE ok = 1 AND \(error IS NULL OR error NOT LIKE 'saltado:%'\)/);
    expect(src).toMatch(/SELECT MAX\(id\) AS id FROM cron_runs GROUP BY name/);
    expect(src).toMatch(/AND id NOT IN/);
    expect(src).toMatch(/intervalOverrides\.get\(name\) \?\? job\?\.intervalMinutes/);
    expect(read("server/settingsRouter.ts")).toMatch(/\["mail-sync", dyn\.mailPushHealthy \? MAIL_SYNC_SAFETY_NET_MINUTES : MAIL_SYNC_MINUTES\]/);
  });
  it("erros e query strings sem segredos (gravar e mostrar)", () => {
    const src = read("server/cronRuns.ts");
    expect(src).toMatch(/error = \$\{clean\(error, 1000\)\}/);
    expect(src).toMatch(/\$\{clean\(meta, 255\)\}/);
    expect(src).toMatch(/error: r\.error \? clean\(String\(r\.error\), 1000\)/);
    expect(read("server/cronScheduler.ts")).toMatch(/lastError = \$\{st\.lastError \? scrubSecrets\(st\.lastError, process\.env, 1000\)/);
  });
});

describe("20b quem mexe", () => {
  it("pela matriz: quem não tem Definições não vê nada", async () => {
    await expect(caller("supervisor").settings.systemStatus()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("backoffice").settings.flags.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("CRM_AUTO_MERGE e o remetente: só o super admin (decisão do Jorge)", async () => {
    expect(automationFlagSuperAdminOnly("CRM_AUTO_MERGE")).toBe(true);
    expect(settingSuperAdminOnly("mail.systemSender")).toBe(true);
    await expect(caller("admin").settings.flags.set({ name: "CRM_AUTO_MERGE", value: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("admin").settings.values.set({ key: "mail.systemSender", value: "x@multipark.pt" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("admin").mail.settings.setSystemSender({ email: "x@multipark.pt" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const card = read("client/src/components/mail/MailAliasTable.tsx");
    expect(card).toMatch(/disabled=\{!isSuper \|\| !email/);
    expect(card).toMatch(/Só o super admin muda o remetente/);
    expect(read("server/mail/router.ts")).toMatch(/Remetente dos emails de sistema: \$\{before \?\? "—"\} → \$\{input\.email\}/);
  });
  it("as rotas antigas settings.integrations saíram (vive tudo no hub)", () => {
    expect(read("server/settingsRouter.ts")).not.toMatch(/integrations: router\(/);
  });
});

describe("20b duas pessoas ao mesmo tempo", () => {
  it("se mudou depois de a página ler → conflito e nada se grava", async () => {
    fake.enabled = true;
    fake.firstRow = { value: '"a@multipark.pt"', updatedAt: "2026-10-02 10:00:00", updatedByName: "Márcia" };
    await expect(setSetting("emails.handoverCc", ["b@multipark.pt"], 1, { expectedUpdatedAt: "2026-10-01 09:00:00" }))
      .rejects.toBeInstanceOf(SettingConflictError);
    expect(fake.calls).toBe(1);
    fake.calls = 0;
    await expect(setSetting("emails.handoverCc", ["b@multipark.pt"], 1, { expectedUpdatedAt: "2026-10-02 10:00:00" })).resolves.toMatchObject({ changed: true });
    expect(fake.calls).toBeGreaterThan(1);
  });
  it("o ecrã manda o que leu e recarrega no conflito", () => {
    const page = read("client/src/pages/DefinicoesPage.tsx");
    expect(page).toMatch(/save\.mutate\(\{ key: s\.key, value, expectedUpdatedAt: s\.updatedAt \?\? null \}\)/);
    expect(page).toMatch(/setFlag\.mutate\(\{ name: f\.name, value, expectedUpdatedAt: f\.updatedAt \?\? null \}\)/);
    expect(page).toMatch(/e\.data\?\.code === "CONFLICT"/);
    expect(read("server/settingsRouter.ts")).toMatch(/code: "CONFLICT"/);
  });
  it("Serviços → tarefas: sem leitura não há regras por omissão para gravar", () => {
    const src = read("client/src/components/ServiceTasksSettings.tsx");
    expect(src).toMatch(/if \(!values\.data\) return null;/);
    expect(src).toMatch(/disabled=\{!dirty \|\| !stored \|\| save\.isPending\}/);
    expect(src).toMatch(/expectedUpdatedAt: row\?\.updatedAt \?\? null/);
    expect(src).toMatch(/what="as regras gravadas/);
  });
});

describe("20b ecrã", () => {
  it("telefones dos alertas: por cidade + cópia, um por linha (o editor genérico estragava a lista)", () => {
    const page = read("client/src/pages/DefinicoesPage.tsx");
    expect(page).toMatch(/const isPhones = item\.key === "ops\.presencePhones";/);
    expect(page).toMatch(/\{ id: "copy", label: "Cópia \(todas as cidades\)" \}/);
    expect(page).toMatch(/const isCityMap = !isPhones &&/);
    const built = { lisbon: ["+351912345678"], porto: [], faro: [], copy: ["+351934567890"] };
    expect(validateSetting("ops.presencePhones", built).ok).toBe(true);
    expect(validateSetting("ops.presencePhones", { lisbon: "+351912345678", porto: "", faro: "" }).ok).toBe(false);
  });
  it("interruptores dizem de onde vem o estado; histórico filtra por definição", () => {
    const page = read("client/src/pages/DefinicoesPage.tsx");
    expect(page).toMatch(/"definido aqui"/);
    expect(page).toMatch(/"pela variável do servidor"/);
    expect(page).toMatch(/"por omissão"/);
    expect(page).toMatch(/aria-label="Filtrar o histórico"/);
    expect(page).toMatch(/useSearch\(\)/);
    expect(page).toMatch(/can\(user as any, "definicoes", "view"\)/);
  });
  it("cartões que não leem mostram o erro (antes desapareciam ou rodavam para sempre)", () => {
    for (const f of ["google/SharedCalendarsSettings.tsx", "google/GooglePushSettings.tsx", "google/GoogleContactsSettings.tsx", "google/GoogleDriveSettings.tsx", "marketing/WebAnalyticsSettings.tsx"]) {
      const src = read(`client/src/components/${f}`);
      expect(src, f).not.toMatch(/if \(q\.error\) return null;/);
      expect(src, f).toMatch(/<SettingsCardError /);
    }
    const routing = read("client/src/components/NotificationRoutingCard.tsx");
    expect(routing.indexOf("if (q.error) return <QueryErrorNote")).toBeLessThan(routing.indexOf("if (q.isLoading || !draft)"));
  });
});
