import { describe, expect, it } from "vitest";
import {
  aggregateFunnel,
  canAutoMarkReplied,
  isAutomatedSender,
  isLeadReminderTime,
  isoWeekKey,
  leadAttention,
  leadStages,
  manualStatusError,
  matchExistingLead,
  median,
  pct,
  selectReminderLeads,
  selectSlaLeads,
  type FunnelLeadRow,
  type SlaLead,
} from "../shared/extraLeadsFunnel";
import { appendSourceNote, cityProjectIdFromText, leadAutoReplyText } from "./extraLeadsSync";
import { MIGRATION_0084_STATEMENTS } from "./migrations/migration_0084";

const NOW = Date.parse("2026-09-24T12:00:00Z");
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString().slice(0, 19).replace("T", " ");

describe("estados e transições (incl. Respondeu)", () => {
  it("só novo/contactado passam automaticamente a Respondeu", () => {
    expect(canAutoMarkReplied("new")).toBe(true);
    expect(canAutoMarkReplied("contacted")).toBe(true);
    for (const s of ["replied", "converted", "declined"]) expect(canAutoMarkReplied(s)).toBe(false);
  });
  it("Respondeu pode ser escolhido à mão; Convertido não", () => {
    expect(manualStatusError({ status: "contacted", employeeId: null }, "replied")).toBeNull();
    expect(manualStatusError({ status: "replied", employeeId: null }, "declined")).toBeNull();
    expect(manualStatusError({ status: "replied", employeeId: null }, "converted")).toMatch(/Converter/);
  });
  it("lead com ficha não sai de Convertido, nem para Respondeu", () => {
    expect(manualStatusError({ status: "converted", employeeId: 7 }, "replied")).toMatch(/ficha/);
  });
  it("estado desconhecido é recusado", () => {
    expect(manualStatusError({ status: "new", employeeId: null }, "banana")).toMatch(/desconhecido/);
  });
});

describe("deduplicação de contactos", () => {
  const leads = [
    { id: 1, phoneE164: "+351912345678", email: "ana@x.pt" },
    { id: 2, phoneE164: null, email: "rui@x.pt" },
  ];
  it("o telemóvel ganha ao email", () => {
    expect(matchExistingLead({ phoneE164: "+351912345678", email: "rui@x.pt" }, leads)?.id).toBe(1);
  });
  it("sem telemóvel igual, casa pelo email (sem maiúsculas)", () => {
    expect(matchExistingLead({ phoneE164: "+351900000000", email: " RUI@x.pt" }, leads)?.id).toBe(2);
  });
  it("sem nada igual → null", () => {
    expect(matchExistingLead({ phoneE164: null, email: null }, leads)).toBeNull();
    expect(matchExistingLead({ phoneE164: "+351911111111", email: "z@x.pt" }, leads)).toBeNull();
  });
  it("remetentes automáticos e o próprio domínio não viram leads", () => {
    expect(isAutomatedSender("no-reply@indeed.com")).toBe(true);
    expect(isAutomatedSender("notifications@linkedin.com")).toBe(true);
    expect(isAutomatedSender("rh@multipark.pt")).toBe(true);
    expect(isAutomatedSender("joao.silva@gmail.com")).toBe(false);
    expect(isAutomatedSender(null)).toBe(false);
  });
  it("nota de origem acrescentada uma só vez e cortada a 512", () => {
    expect(appendSourceNote(null, "via site")).toBe("via site");
    expect(appendSourceNote("indicado pelo Rui", "via site")).toBe("indicado pelo Rui · via site");
    expect(appendSourceNote("indicado · via site", "via site")).toBe("indicado · via site");
    expect(appendSourceNote("x".repeat(600), "via site")!.length).toBe(512);
  });
  it("cidade da candidatura → nó de cidade (só quando é inequívoco)", () => {
    const projects = [
      { id: 10, name: "Lisboa", level: "city" },
      { id: 11, name: "Porto", level: "city" },
      { id: 12, name: "Airpark Lisboa", level: "project" },
    ];
    expect(cityProjectIdFromText("lisbon", projects)).toBe(10);
    expect(cityProjectIdFromText("Porto", projects)).toBe(11);
    expect(cityProjectIdFromText("Portimão", projects)).toBeNull();
    expect(cityProjectIdFromText(null, projects)).toBeNull();
    expect(cityProjectIdFromText("Lisboa", [...projects, { id: 13, name: "Lisboa", level: "city" }])).toBeNull();
  });
  it("resposta automática traz o primeiro nome e o link", () => {
    const t = leadAutoReplyText("Ana Maria Costa", "https://multidriver.pt");
    expect(t).toContain("Olá Ana!");
    expect(t).toContain("https://multidriver.pt");
  });
});

describe("SLA e lembretes", () => {
  const base: SlaLead = { id: 1, status: "new", createdAt: ago(1), lastContactedAt: null, lastInboundAt: null, contactCount: 0, phoneE164: "+351912345678" };
  it("novo sem contacto há mais de 24h", () => {
    expect(leadAttention({ ...base, createdAt: ago(23) }, NOW)).toBeNull();
    expect(leadAttention({ ...base, createdAt: ago(25) }, NOW)).toBe("new_stale");
  });
  it("contactado sem resposta há mais de 3 dias", () => {
    const c = { ...base, status: "contacted", createdAt: ago(200), contactCount: 1 };
    expect(leadAttention({ ...c, lastContactedAt: ago(71) }, NOW)).toBeNull();
    expect(leadAttention({ ...c, lastContactedAt: ago(73) }, NOW)).toBe("contacted_stale");
    // respondeu depois do contacto → não precisa de atenção
    expect(leadAttention({ ...c, lastContactedAt: ago(100), lastInboundAt: ago(90) }, NOW)).toBeNull();
    // mensagem antiga (antes do último contacto) não conta como resposta
    expect(leadAttention({ ...c, lastContactedAt: ago(100), lastInboundAt: ago(150) }, NOW)).toBe("contacted_stale");
  });
  it("outros estados nunca pedem atenção", () => {
    for (const status of ["replied", "converted", "declined"]) {
      expect(leadAttention({ ...base, status, createdAt: ago(500) }, NOW)).toBeNull();
    }
  });
  it("selectSlaLeads separa as duas listas", () => {
    const r = selectSlaLeads(
      [
        { ...base, id: 1, createdAt: ago(30) },
        { ...base, id: 2, status: "contacted", contactCount: 1, lastContactedAt: ago(80) },
        { ...base, id: 3 },
      ],
      NOW,
    );
    expect(r.newStale.map((l) => l.id)).toEqual([1]);
    expect(r.contactedStale.map((l) => l.id)).toEqual([2]);
  });
  it("lembrete só a contactados com telemóvel e menos de 2 envios", () => {
    const stale = { ...base, status: "contacted", lastContactedAt: ago(80) };
    const r = selectReminderLeads(
      [
        { ...stale, id: 1, contactCount: 1 },
        { ...stale, id: 2, contactCount: 2 }, // já levou o lembrete
        { ...stale, id: 3, contactCount: 1, phoneE164: null },
        { ...stale, id: 4, contactCount: 1, lastContactedAt: ago(10) }, // ainda cedo
        { ...base, id: 5, createdAt: ago(80) }, // novo — nunca recebeu o 1.º
      ],
      NOW,
    );
    expect(r.map((l) => l.id)).toEqual([1]);
  });
  it("lembretes só de dia, de segunda a sábado", () => {
    expect(isLeadReminderTime({ dow: 1, hour: 10 })).toBe(true);
    expect(isLeadReminderTime({ dow: 6, hour: 18 })).toBe(true);
    expect(isLeadReminderTime({ dow: 3, hour: 9 })).toBe(false);
    expect(isLeadReminderTime({ dow: 3, hour: 19 })).toBe(false);
    expect(isLeadReminderTime({ dow: 7, hour: 12 })).toBe(false);
  });
});

describe("funil", () => {
  const row = (o: Partial<FunnelLeadRow>): FunnelLeadRow => ({
    source: "manual",
    projectId: 10,
    status: "new",
    createdAt: "2026-09-21 09:00:00",
    contactCount: 0,
    firstContactedAt: null,
    lastContactedAt: null,
    lastInboundAt: null,
    convertedAt: null,
    ...o,
  });
  it("semana ISO", () => {
    expect(isoWeekKey(Date.parse("2026-09-21T09:00:00Z"))).toBe("2026-W39");
    expect(isoWeekKey(Date.parse("2027-01-01T09:00:00Z"))).toBe("2026-W53");
    expect(isoWeekKey(Date.parse("2025-12-29T09:00:00Z"))).toBe("2026-W01");
  });
  it("mediana e percentagem", () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(pct(1, 4)).toBe(25);
    expect(pct(1, 0)).toBeNull();
  });
  it("etapas cumulativas", () => {
    expect(leadStages(row({ status: "replied" }))).toEqual({ contacted: true, replied: true, converted: false });
    expect(leadStages(row({ status: "converted" }))).toEqual({ contacted: false, replied: false, converted: true });
    expect(leadStages(row({ status: "declined", contactCount: 1, lastInboundAt: "2026-09-22 10:00:00" }))).toEqual({
      contacted: true,
      replied: true,
      converted: false,
    });
  });
  it("agrega por origem × cidade × semana, com medianas", () => {
    const r = aggregateFunnel(
      [
        row({ source: "site", status: "contacted", contactCount: 1, firstContactedAt: "2026-09-21 11:00:00", lastContactedAt: "2026-09-21 11:00:00" }),
        row({ source: "site", status: "replied", contactCount: 1, firstContactedAt: "2026-09-21 13:00:00", lastInboundAt: "2026-09-22 08:00:00" }),
        row({
          source: "site",
          status: "converted",
          contactCount: 1,
          firstContactedAt: "2026-09-22 09:00:00",
          lastInboundAt: "2026-09-22 10:00:00",
          convertedAt: "2026-09-24 09:00:00",
        }),
        row({ source: "manual", projectId: null, createdAt: "2026-09-14 09:00:00" }),
      ],
      (pid) => (pid == null ? "Sem cidade" : pid === 10 ? "Lisboa" : `#${pid}`),
    );
    expect(r.totals).toEqual({ created: 4, contacted: 3, replied: 2, converted: 1 });
    expect(r.bySource[0]).toEqual({ source: "site", created: 3, contacted: 3, replied: 2, converted: 1 });
    expect(r.rows[0]).toMatchObject({ source: "site", city: "Lisboa", week: "2026-W39", created: 3, converted: 1 });
    expect(r.rows[1]).toMatchObject({ source: "manual", city: "Sem cidade", week: "2026-W38", created: 1 });
    expect(r.medianHoursToFirstContact).toBe(4); // 2h, 4h, 24h
    expect(r.medianDaysToConversion).toBe(3);
  });
});

describe("migração 0084", () => {
  it("acrescenta 'replied' no FIM do enum (alteração instantânea) mantendo os antigos", () => {
    const modify = MIGRATION_0084_STATEMENTS.find((s) => s.includes("MODIFY COLUMN `status`"))!;
    expect(modify).toContain("ENUM('new','contacted','converted','declined','replied')");
  });
  it("os UPDATEs só preenchem colunas NULL e mantêm o updatedAt", () => {
    for (const s of MIGRATION_0084_STATEMENTS.filter((x) => x.startsWith("UPDATE"))) {
      expect(s).toMatch(/IS NULL/);
      expect(s).toContain("`updatedAt` = `updatedAt`");
    }
  });
});
