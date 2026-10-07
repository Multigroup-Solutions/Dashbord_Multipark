/**
 * Jorge (7 out 2026): o `multipark-db-sync` (retirado a 27 set) continuava no
 * Estado do sistema como "Falhou". Trabalhos fora de CRON_JOBS e sem corridas
 * há mais de 7 dias saem da lista e dos alertas; o histórico fica.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CRON_JOBS, RETIRED_CRON_AFTER_DAYS, isRetiredCron } from "../shared/appSettings";

const DAY = 86_400_000;
const now = Date.UTC(2026, 9, 7, 20, 0, 0);

describe("Trabalhos retirados no Estado do sistema", () => {
  it("fora da agenda e parado há mais de 7 dias → retirado", () => {
    expect(RETIRED_CRON_AFTER_DAYS).toBe(7);
    expect(isRetiredCron(false, now - 11 * DAY, now)).toBe(true);   // multipark-db-sync, 27/09
    expect(isRetiredCron(false, null, now)).toBe(true);
  });
  it("um trabalho da agenda nunca é retirado, mesmo parado", () => {
    expect(isRetiredCron(true, now - 30 * DAY, now)).toBe(false);
  });
  it("um nome fora da agenda que correu há pouco (à mão) continua a aparecer", () => {
    expect(isRetiredCron(false, now - 2 * DAY, now)).toBe(false);
  });
  it("o multipark-db-sync já não está na agenda", () => {
    expect(CRON_JOBS.find((j) => j.name === "multipark-db-sync")).toBeUndefined();
  });
  it("a lista e os alertas filtram; a página mostra uma nota com os retirados", () => {
    const runs = readFileSync("server/cronRuns.ts", "utf8");
    expect(runs).toContain(".filter((n) => !isRetiredCron(known.has(n), lastAt.get(n) ?? null, now));");
    expect(runs).toContain("export async function getRetiredCronNames(");
    expect(runs.slice(runs.indexOf("export async function getRetiredCronNames(")).split("\n").slice(0, 14).join("\n")).not.toMatch(/\bDELETE\b/);
    expect(readFileSync("server/settingsRouter.ts", "utf8")).toContain("return { now, crons, retired };");
    expect(readFileSync("client/src/pages/DefinicoesPage.tsx", "utf8")).toContain("Retirados (já não correm; histórico guardado, fora da lista e dos alertas)");
  });
});
