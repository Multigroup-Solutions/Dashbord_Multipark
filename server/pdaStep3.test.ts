import { SCHEMA_MIGRATION_IDS } from "./migrations/index";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zelloDisplayName, ZELLO_FULL_NAME_MAX } from "./pdaZelloName";
import { MIGRATION_0280_STATEMENTS } from "./migrations/migration_0280";
import { AUTOMATION_FLAGS, automationFlagDefault } from "../shared/appSettings";

const read = (f: string) => readFileSync(join(__dirname, "..", f), "utf8");
// O appRouter está repartido (P2: rh e operational têm ficheiro próprio).
const routersCode = () => ["server/routers.ts", "server/rhRouter.ts", "server/operationalRouter.ts"].map(read).join("\n");

describe("PDAs, passo 3 (decisões do dono)", () => {
  it("nome no Zello: \"PDA 12 · Rui Santos\" com alguém, \"PDA 12\" sem ninguém", () => {
    expect(zelloDisplayName("PDA 12", "Rui Manuel Alves Santos")).toBe("PDA 12 · Rui Santos");
    expect(zelloDisplayName("PDA 12", null)).toBe("PDA 12");
    expect(zelloDisplayName("  ", "Ana")).toBe("PDA · Ana");
    expect(zelloDisplayName("PDA".repeat(40), "Ana").length).toBeLessThanOrEqual(ZELLO_FULL_NAME_MAX);
  });
  it("escrita no Zello: só o nome (user/save com name + full_name), com interruptor desligado por omissão", () => {
    const z = read("server/zello.ts");
    expect(z).toMatch(/user\/save\?sid=/);
    expect(z).toContain("new URLSearchParams({ name: username, full_name: fullName })");
    expect(automationFlagDefault("ZELLO_PDA_NAMES")).toBe(false);
    expect(AUTOMATION_FLAGS.some((f) => f.name === "ZELLO_PDA_NAMES")).toBe(true);
    const r = routersCode();
    expect(r).toContain("syncPdaZelloName(att.pdaId)");
    expect(r).toContain("syncPdaZelloNameByToken(input.token)");
    expect(r).toContain("syncPdaZelloNamesForEmployee(input.employeeId)");
  });
  it("só pelo QR: sem check-in manual nem registo pela lista", () => {
    const r = routersCode();
    expect(r).toContain("Já não há check-in manual");
    expect(r).toContain("O PDA regista-se só pelo QR");
    const ui = read("client/src/pages/OperationalPage.tsx");
    expect(ui).not.toContain("function CheckinDialog(");
    expect(ui).not.toContain("Registar este aparelho");
    expect(read("client/src/pages/PdaRegisterPage.tsx")).toContain("beforeinstallprompt");
  });
  it("cidade fixa do PDA: coluna nova e o âmbito de cidade usa-a primeiro", () => {
    expect(MIGRATION_0280_STATEMENTS.join("\n")).toContain("ALTER TABLE `pdas` ADD COLUMN `projectId` INT NULL");
    expect(SCHEMA_MIGRATION_IDS).toContain("0280");
    expect(read("drizzle/schema.ts")).toMatch(/pdas[\s\S]{0,1500}projectId: int\(\)/);
    expect(read("server/cityScope.ts")).toContain("city_fix.projectId IS NOT NULL");
  });
});
