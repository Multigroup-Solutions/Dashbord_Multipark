import { describe, expect, it } from "vitest";
import { autoMergeOk } from "../../shared/crmIdentity";
import { AUTOMATION_FLAGS } from "../../shared/appSettings";
import { TICK_JOBS } from "../cronSchedule";

const side = (o: Partial<{ id: number; name: string | null; emails: string[]; phones: string[]; plates: string[]; nif: string | null }>) =>
  ({ id: 1, name: null, emails: [], phones: [], plates: [], nif: null, ...o });

describe("CRM: juntar sozinho só o óbvio", () => {
  it("mesmo nome e mesmo telefone, email ou NIF → junta", () => {
    expect(autoMergeOk(side({ name: "Ana Maria Silva", phones: ["351912345678"] }), side({ name: "Ana Silva", phones: ["351912345678"] }))).toBe(true);
    expect(autoMergeOk(side({ name: "Rui Costa", emails: ["rui@x.pt"] }), side({ name: "rui costa", emails: ["rui@x.pt"] }))).toBe(true);
    expect(autoMergeOk(side({ name: "Rui Costa", nif: "123456789" }), side({ name: "Rui Costa", nif: "123456789" }))).toBe(true);
  });
  it("nome diferente, só matrícula, só nome ou empresa → não junta (fica para rever)", () => {
    expect(autoMergeOk(side({ name: "Ana Silva", phones: ["351912345678"] }), side({ name: "Pedro Silva", phones: ["351912345678"] }))).toBe(false);
    expect(autoMergeOk(side({ name: "Ana Silva", plates: ["AA00BB"] }), side({ name: "Ana Silva", plates: ["AA00BB"] }))).toBe(false);
    expect(autoMergeOk(side({ name: "Ana Silva" }), side({ name: "Ana Silva" }))).toBe(false);
    expect(autoMergeOk(side({ name: "Ana Silva", phones: ["1"] }), side({ name: "Ana Silva", phones: ["1"] }), { kindA: "company" })).toBe(false);
  });
  it("interruptor ligado por omissão e cron registada", () => {
    expect(AUTOMATION_FLAGS.find((f) => f.name === "CRM_AUTO_MERGE")?.defaultEnabled).toBe(true);
    expect(TICK_JOBS.some((j) => j.key === "crm-auto-merge")).toBe(true);
  });
});
