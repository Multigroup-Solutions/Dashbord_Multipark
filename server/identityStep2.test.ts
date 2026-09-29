import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reassignStatements, USER_OWNERSHIP_COLUMNS, ROLE_RANK } from "./userMerge";
import { looksLikeTestAgent } from "./personIdentity";
import { dominantCity, MISSING_CITY_ASSIGNEE_DEFAULT } from "./employeeCityFix";
import { buildAgentCitiesSql } from "./multiparkDb/agentCities";
import { assertReadOnlySql } from "./multiparkDb/client";
import { SETTINGS } from "../shared/appSettings";

const read = (f: string) => readFileSync(join(__dirname, "..", f), "utf8");

describe("juntar contas da mesma pessoa (decisão do dono)", () => {
  it("passa tudo o que é da pessoa; nas chaves únicas ganha o que a conta que fica já tinha", () => {
    const st = reassignStatements(7, 3);
    for (const t of ["employee_accounts", "user_permissions", "app_notifications", "google_user_accounts", "mail_threads", "whatsapp_conversations", "complaints"]) {
      expect(st.some((s) => s.includes(`\`${t}\``))).toBe(true);
    }
    expect(st).toContain("UPDATE IGNORE `user_permissions` SET `userId` = 3 WHERE `userId` = 7");
    expect(st).toContain("DELETE FROM `user_permissions` WHERE `userId` = 7");
    expect(st).toContain("UPDATE `ai_chat_conversations` SET `ownerKey` = 'user:3' WHERE `ownerKey` = 'user:7'");
    expect(() => reassignStatements(3, 3)).toThrow();
    expect(() => reassignStatements(0, 3)).toThrow();
  });
  it("nunca apaga a conta: desativa-a (conta duplicada) e o registo fica como está", () => {
    const src = read("server/userMerge.ts");
    expect(src).not.toMatch(/DELETE FROM `?users`?\b/);
    expect(src).toContain("isActive = 0");
    expect(src).toContain("conta_duplicada");
    expect(USER_OWNERSHIP_COLUMNS.some((c) => c.table === "activity_logs")).toBe(false);
    expect(ROLE_RANK.super_admin).toBeGreaterThan(ROLE_RANK.admin);
  });
  it("só administradores juntam contas; ninguém se junta a si próprio", () => {
    const r = read("server/routers.ts");
    expect(r).toMatch(/mergeUsers: protectedProcedure[\s\S]{0,600}Só um administrador junta contas/);
    expect(r).toContain("Não podes juntar (desativar) a tua própria conta.");
  });
});

describe("agentes de teste e cidade das fichas", () => {
  it("agentes de teste saem da lista dos por ligar", () => {
    expect(looksLikeTestAgent("Teste Lisboa")).toBe(true);
    expect(looksLikeTestAgent("Demo PDA")).toBe(true);
    expect(looksLikeTestAgent("Rui Santos", "test.pda@multipark.pt")).toBe(true);
    expect(looksLikeTestAgent("Celeste Martins")).toBe(false);
    expect(looksLikeTestAgent("Testa Silva")).toBe(false);
  });
  it("cidade: onde o agente mais trabalha (somando todos os agentes da pessoa)", () => {
    expect(dominantCity([new Map([["Lisboa", 10], ["Porto", 3]]), new Map([["Porto", 9]])])).toBe("porto");
    expect(dominantCity([new Map([["Faro", 1]])])).toBe("faro");
    expect(dominantCity([])).toBeNull();
    const q = buildAgentCitiesSql({ agentIds: ["a1"], since: "2026-04-01 00:00:00" });
    expect(() => assertReadOnlySql(q.sql)).not.toThrow();
    expect(q.sql).toMatch(/LIMIT \$\d+/);
  });
  it("sem cidade: tarefa (e email) para a Márcia Nunes, configurável; corre com a ligação de hora a hora", () => {
    expect(MISSING_CITY_ASSIGNEE_DEFAULT).toBe("Márcia Nunes");
    expect(SETTINGS["rh.missingCityAssignee"].defaultValue).toBe("Márcia Nunes");
    expect(read("server/cronJobs.ts")).toContain("fixMissingEmployeeCities");
    expect(read("server/employeeCityFix.ts")).toContain("rh:missing-city:");
  });
});
