import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// O agendador é só o cron-job.org → /api/cron/tick (docs/ajuda/agendador.md).
// O GitHub atrasava/saltava os schedules e a "rede de segurança" de hora a hora
// levou 401 de 27 set a 2 out 2026 sem ninguém dar pela falta: saiu.
const dir = resolve(import.meta.dirname, "..", ".github", "workflows");
const workflows = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
const code = (f: string) => readFileSync(resolve(dir, f), "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

describe("GitHub Actions não agenda nada", () => {
  it("nenhum workflow tem schedule (os crons só correm à mão no GitHub)", () => {
    expect(workflows.length).toBeGreaterThan(0);
    expect(workflows.filter((f) => /^\s*schedule\s*:/m.test(code(f)))).toEqual([]);
  });

  it("o tick continua a poder correr à mão (Run workflow)", () => {
    const tick = code("cron-tick.yml");
    expect(tick).toMatch(/^\s*workflow_dispatch\s*:/m);
    expect(tick).toContain("/api/cron/tick?wait=1");
  });
});
