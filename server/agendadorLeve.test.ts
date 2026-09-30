import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertReadOnlySql } from "./multiparkDb/client";
import { buildCrmRowsByIdsSql } from "./multiparkDb/crmLive";
import { WHATSAPP_TRIAGE_MAX_FAILS, whatsappTriageRetry } from "../shared/commsAi";
import { MIGRATION_0315_STATEMENTS } from "./migrations/migration_0315";
import { TICK_JOBS, describeCadence } from "./cronSchedule";
import { CRON_JOBS } from "../shared/appSettings";
import { kindDef } from "../shared/notificationRouting";

const root = resolve(import.meta.dirname, "..");
const src = (p: string) => readFileSync(resolve(root, p), "utf8");

// Jorge, 29 set 2026: "agendador mais leve" — o que chega pelo webhook trata-se
// logo; as voltas passam a ser diárias ou de hora a hora.
describe("agendador mais leve", () => {
  it("cadências novas", () => {
    const c = Object.fromEntries(TICK_JOBS.map((j) => [j.key, describeCadence(j.cadence)]));
    expect(c["cash-sweep"]).toBe("a cada 3 h");
    expect(c["multipark-deliveries"]).toBe("de hora a hora");
    expect(c["google-pending"]).toBe("de hora a hora");
    expect(c["crm-sync"]).toBe("diário a partir das 04:00");
    expect(c["crm-auto-merge"]).toBe("diário a partir das 05:05");
    expect(c["services-tasks"]).toBe("diário a partir das 18:00");
    const known = Object.fromEntries(CRON_JOBS.map((j) => [j.name, j.intervalMinutes]));
    expect(known).toMatchObject({ "cash-sweep": 180, "multipark-deliveries": 60, "google-pending": 60, "crm-sync": 1440, "crm-auto-merge": 1440, "services-tasks": 1440 });
  });

  it("CRM das reservas do webhook: só leitura, por ids, só clientes nossos", () => {
    const q = buildCrmRowsByIdsSql({ ids: ["b1", "b2", "b1", ""], ourParkIds: ["p1"] });
    assertReadOnlySql(q.sql);
    expect(q.sql).toMatch(/WHERE b\."id" IN \(\$1, \$2\)/);
    expect(q.sql).toMatch(/LIMIT \$\d+$/);
    expect(q.params).toEqual(expect.arrayContaining(["b1", "b2", "p1"]));
    expect(q.params.filter((p) => p === "b1")).toHaveLength(1);
    expect(() => buildCrmRowsByIdsSql({ ids: [], ourParkIds: ["p1"] })).toThrow();
  });

  it("o webhook trata a ficha do CRM e as tarefas dos serviços da reserva, sem partir", () => {
    const hook = src("server/multiparkWebhook.ts");
    expect(hook).toMatch(/await onBookingArrived\(ev\.bookingId\)/);
    expect(hook).toMatch(/syncCrmForBookings\(\[bookingId\]\)/);
    expect(hook).toMatch(/runServiceTasksForBookings\(\[bookingId\]/);
  });

  it("aviso das tarefas de amanhã vai aos team leaders e supervisores da cidade", () => {
    const k = kindDef("service_tasks_tomorrow")!;
    expect(k.roles).toEqual(["team_leader", "supervisor"]);
    expect(k.cityScoped).toBe(true);
  });

  it("triagem do WhatsApp: desiste à 3.ª falha seguida; o teto de saída chega para o raciocínio", () => {
    expect(WHATSAPP_TRIAGE_MAX_FAILS).toBe(3);
    expect(whatsappTriageRetry(1)).toBe(true);
    expect(whatsappTriageRetry(2)).toBe(true);
    expect(whatsappTriageRetry(3)).toBe(false);
    expect(MIGRATION_0315_STATEMENTS[0]).toMatch(/ADD COLUMN `aiTriageFails` INT NOT NULL DEFAULT 0/);
    expect(src("server/db.ts")).toContain("migration_0315");
    const t = src("server/whatsappTriage.ts");
    expect(t).toMatch(/maxTokens: 600/);
    expect(t).toMatch(/aiTriageFails: 0/);
  });
});
