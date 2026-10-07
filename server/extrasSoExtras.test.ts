/**
 * P3 lote 17g (parte 1) — Disponibilidade e escala só para EXTRAS (Jorge,
 * 2 out 2026): a lista mostra só extras (disponíveis → sem resposta →
 * indisponíveis) e só a cidade escolhida; pedidos e avisos de escala nunca vão
 * a funcionários; quem não tem cidade não se escala; funcionários só à mão.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sortByAvailability } from "../shared/availabilityGroups";
import { noCityScheduleMessage } from "../shared/extrasSchedule";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const fnBody = (file: string, start: string, len = 2500) => { const s = src(file); const i = s.indexOf(start); expect(i).toBeGreaterThan(-1); return s.slice(i, i + len); };

describe("Lista da disponibilidade", () => {
  it("disponíveis → sem resposta → indisponíveis, e por nome", () => {
    const r = (fullName: string, responded: boolean, availableDays: number) => ({ fullName, responded, availableDays });
    const out = sortByAvailability([r("Zé", true, 0), r("Bruno", false, 0), r("Ana", true, 2), r("Carla", false, 0), r("Álvaro", true, 1)]);
    expect(out.map((x) => x.fullName)).toEqual(["Álvaro", "Ana", "Bruno", "Carla", "Zé"]);
  });
  it("só extras: quem respondeu sem ser extra deixa de entrar", () => {
    const body = fnBody("server/extrasAvailability.ts", "export async function getWeekOverview");
    expect(body).not.toContain("selectDistinct({ employeeId: extrasAvailability.employeeId })");
    expect(body).toContain("const extras = [...(await listActiveExtras(projectId))];");
  });
  it("a cidade escolhida em cima manda: só essa cidade (sem 'Todas' nem 'Sem cidade')", () => {
    const page = src("client/src/pages/ExtrasDiaPage.tsx");
    expect(page).toContain("const cityFilter: CityKey | \"all\" | \"none\" = globalCity ?? pickedCity;");
    expect(page).toContain("? [{ key: globalCity, label: CITY_LABELS[globalCity] }]");
    expect(page).toContain("let sorted = sortByAvailability(list);");
  });
});

describe("Pedidos e avisos só a extras", () => {
  it("escolhidos à mão: só extras ativos; difusões (disponibilidade, aviso de trabalho, regras) só a extras", () => {
    expect(fnBody("server/extrasAvailability.ts", "export async function listActiveEmployeesByIds", 900))
      .toContain('eq(employees.isActive, 1), eq(employees.position, "extra"), inArray(employees.id, ids)');
    const bc = src("server/whatsappBroadcast.ts");
    expect(bc).toContain("const pool = await listActiveExtras();");
    expect(bc).not.toContain("listActiveEmployeesByIds");
  });
  it("aviso de escala (WhatsApp e email) e turno cancelado: funcionário fica sem aviso, com o motivo", () => {
    const wa = fnBody("server/extrasAutomation.ts", "export async function notifyAssignments", 6000);
    expect(wa).toContain("const extrasSet = await extraIdsAmong(Array.from(byEmp.keys()));");
    expect(wa).toContain('if (!extrasSet.has(empId)) outcome.set(empId, { status: "no_contact", error: NOT_EXTRA_NO_NOTICE });');
    expect(wa).toContain("employeeIds: toNotify,");
    const em = fnBody("server/extrasSchedule.ts", "export async function sendScheduleEmails", 3000);
    expect(em).toContain('extra: String(r.position ?? "") === "extra" && Number(r.isActive) === 1,');
    expect(em).toContain('finishNotification(a, "scheduled", "email", "no_contact", NOT_EXTRA_NO_NOTICE)');
    expect(fnBody("server/extrasSchedule.ts", "async function notifyRemoval", 1200)).toContain('if (String(emp?.position ?? "") !== "extra") return out;');
  });
});

describe("Escala: sem cidade não; funcionários só à mão", () => {
  it("proposta automática e 'pedir a quem não respondeu': só extras da cidade (sem cidade fica de fora)", () => {
    // (a escolha de quem pode entrar passou para loadEligibleExtras — a mesma lista do indicador de pessoal, pedido 7)
    const cands = fnBody("server/extrasSchedule.ts", "export async function loadEligibleExtras", 1800);
    expect(fnBody("server/extrasSchedule.ts", "export async function loadScheduleCandidates", 400)).toContain("await loadEligibleExtras(date, city)");
    expect(cands).toContain('if ((c.position ?? "").toLowerCase() !== "extra") return false;');
    expect(cands).toContain("return (cities.get(c.id)?.city ?? null) === cityKey;");
    expect(fnBody("server/extrasSchedule.ts", "export async function noAnswerTargets", 1200)).toContain("return noAnswer.filter((c) => cities.get(c.id)?.city === cityKey).map((c) => c.id);");
  });
  it("à mão: quem não tem cidade é recusado com o motivo", () => {
    expect(noCityScheduleMessage("Ana Sousa")).toBe("Ana Sousa não tem cidade na ficha: não pode ser escalado(a). Define a cidade primeiro (Recursos Humanos → ficha).");
    const r = fnBody("server/routers.ts", "upsertAssignment: protectedProcedure", 4500);
    expect(r).toContain("if (!(await resolveCitiesForEmployeeIds([input.employeeId])).get(input.employeeId)?.city) {");
    expect(r).toContain('code: "PRECONDITION_FAILED", message: noCityScheduleMessage(input.personName)');
  });
  it("lista para escolher: disponíveis primeiro e, em cada grupo, extras antes dos funcionários", () => {
    expect(src("client/src/pages/ExtrasDiaPage.tsx")).toContain("return r !== 0 ? r : staff(a) - staff(b) || a.fullName.localeCompare(b.fullName);");
  });
});
