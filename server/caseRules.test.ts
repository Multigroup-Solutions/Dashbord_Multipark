import { describe, it, expect } from "vitest";
import {
  buildDriverCrossRef, complaintToLostFields, contentTypeForFilename, driverKey, escapeHtml,
  incidentCountsAgainstDriver, incidentStatusPatch, incidentToComplaintFields, incidentToLostFields,
  isDuplicateIncident, isoWeekYearLisbon, lisbonLocalToUtc, lostStatusPatch, lostToComplaintFields,
  reminderDue, repeatDriversForCase, safeExt, textToSafeHtml, ageBucket, convertedOriginPatch,
} from "../shared/caseRules";
import { MIGRATION_0092_STATEMENTS, IDEMPOTENT_ERROR_CODES_0092 } from "./migrations/migration_0092";

const NOW = "2026-09-24 10:00:00";

describe("pontos justos (elegibilidade)", () => {
  it("só conta com condutor + envolvimento confirmado + não descartada/convertida", () => {
    expect(incidentCountsAgainstDriver({ employeeId: 5, driverConfirmed: 1, status: "open" })).toBe(true);
    expect(incidentCountsAgainstDriver({ employeeId: 5, driverConfirmed: 1, status: "resolved" })).toBe(true);
    expect(incidentCountsAgainstDriver({ employeeId: 5, driverConfirmed: 0, status: "open" })).toBe(false);
    expect(incidentCountsAgainstDriver({ employeeId: 5, driverConfirmed: 1, status: "dismissed" })).toBe(false);
    expect(incidentCountsAgainstDriver({ employeeId: 5, driverConfirmed: 1, status: "converted" })).toBe(false);
    expect(incidentCountsAgainstDriver({ employeeId: null, driverConfirmed: 1, status: "open" })).toBe(false);
  });
});

describe("transições de estado + timestamps", () => {
  it("ocorrência: resolver/descartar põe resolvedAt; reabrir limpa", () => {
    expect(incidentStatusPatch({ status: "open" }, "resolved", NOW, 7)).toEqual({ status: "resolved", resolvedAt: NOW, resolvedBy: 7 });
    expect(incidentStatusPatch({ status: "investigating" }, "dismissed", NOW, 7)).toEqual({ status: "dismissed", resolvedAt: NOW, resolvedBy: 7 });
    expect(incidentStatusPatch({ status: "resolved", resolvedAt: "2026-09-01 00:00:00" }, "open", NOW, 7)).toEqual({ status: "open", resolvedAt: null, resolvedBy: null });
    // fechado → fechado mantém o instante original
    expect(incidentStatusPatch({ status: "resolved", resolvedAt: "2026-09-01 00:00:00" }, "dismissed", NOW, 7)).toEqual({ status: "dismissed" });
    expect(incidentStatusPatch({ status: "open" }, "investigating", NOW, 7)).toEqual({ status: "investigating" });
  });
  it("perdido: devolvido/fechado põe closedAt; reabrir limpa", () => {
    expect(lostStatusPatch({ status: "found" }, "returned", NOW, 3)).toEqual({ status: "returned", closedAt: NOW, closedById: 3 });
    expect(lostStatusPatch({ status: "closed", closedAt: "2026-09-01 00:00:00" }, "investigating", NOW, 3)).toEqual({ status: "investigating", closedAt: null, closedById: null });
    expect(lostStatusPatch({ status: "new" }, "found", NOW, 3)).toEqual({ status: "found" });
  });
  it("semana/ano ISO pelo dia de Lisboa", () => {
    // 31 dez 2024 23:30 Lisboa (= UTC) é semana 1 de 2025
    expect(isoWeekYearLisbon("2024-12-31T23:30:00Z")).toEqual({ week: 1, year: 2025 });
    // 2027-01-01 00:30 Lisboa é sexta da semana 53 de 2026
    expect(isoWeekYearLisbon("2027-01-01T00:30:00Z")).toEqual({ week: 53, year: 2026 });
    // verão: 23:30 UTC já é o dia seguinte em Lisboa
    expect(isoWeekYearLisbon("2026-09-27T23:30:00Z").week).toBe(40);
  });
  it("hora de Lisboa → UTC (verão e inverno)", () => {
    expect(lisbonLocalToUtc("2026-07-31 10:37:00")).toBe("2026-07-31 09:37:00");
    expect(lisbonLocalToUtc("2026-01-15 10:00")).toBe("2026-01-15 10:00:00");
    expect(lisbonLocalToUtc("lixo")).toBeNull();
  });
  it("lembrete 1× por dia de Lisboa + baldes de idade", () => {
    expect(reminderDue(null, new Date("2026-09-24T10:00:00Z"))).toBe(true);
    expect(reminderDue("2026-09-24 08:00:00", new Date("2026-09-24T18:00:00Z"))).toBe(false);
    expect(reminderDue("2026-09-23 22:00:00", new Date("2026-09-24T10:00:00Z"))).toBe(true);
    const now = Date.UTC(2026, 8, 24, 10);
    expect(ageBucket("2026-09-24 00:00:00", now)).toBe("lt1d");
    expect(ageBucket("2026-09-22 00:00:00", now)).toBe("d1to3");
    expect(ageBucket("2026-09-10 00:00:00", now)).toBe("gt7d");
  });
});

describe("janela de duplicados (±2h)", () => {
  const t = Date.UTC(2026, 8, 24, 10);
  it("mesma matrícula + reserva compatível + ≤2h", () => {
    expect(isDuplicateIncident({ plate: "AA-00-BB", bookingRef: "c1", atMs: t }, { plate: "aa00bb", bookingRef: "c1", atMs: t + 90 * 60_000 })).toBe(true);
    expect(isDuplicateIncident({ plate: "AA-00-BB", bookingRef: null, atMs: t }, { plate: "AA00BB", bookingRef: "c1", atMs: t - 2 * 3_600_000 })).toBe(true);
  });
  it("fora da janela, outra reserva ou outra matrícula não é duplicado", () => {
    expect(isDuplicateIncident({ plate: "AA00BB", bookingRef: "c1", atMs: t }, { plate: "AA00BB", bookingRef: "c1", atMs: t + 2 * 3_600_000 + 1 })).toBe(false);
    expect(isDuplicateIncident({ plate: "AA00BB", bookingRef: "c1", atMs: t }, { plate: "AA00BB", bookingRef: "c2", atMs: t })).toBe(false);
    expect(isDuplicateIncident({ plate: "AA00BB", bookingRef: "c1", atMs: t }, { plate: "ZZ00BB", bookingRef: "c1", atMs: t })).toBe(false);
    expect(isDuplicateIncident({ plate: "", atMs: t }, { plate: "", atMs: t })).toBe(false);
  });
});

describe("cruzamento de condutores (agregação pura)", () => {
  it("conta casos DISTINTOS por condutor, junta anexados + movimentos e compara com a equipa", () => {
    const links = [
      { caseId: 1, via: "attached" as const, employeeId: 10, name: "Ana" },
      { caseId: 1, via: "movement" as const, employeeId: 10, name: "Ana" }, // mesmo caso → 1
      { caseId: 2, via: "movement" as const, employeeId: 10, name: "Ana" },
      { caseId: 2, via: "movement" as const, employeeId: null, name: "Rui  Sá" },
      { caseId: 3, via: "movement" as const, employeeId: null, name: "rui sá" }, // mesmo nome normalizado
      { caseId: 3, via: "movement" as const, employeeId: 11, name: "Bruno" },
    ];
    const { rows, teamRate, totalCases } = buildDriverCrossRef({
      links,
      movementTotals: [
        { employeeId: 10, agentName: "Ana", total: 10, inCase: 4 },
        { employeeId: null, agentName: "Rui Sá", total: 20, inCase: 2 },
        { employeeId: 11, agentName: "Bruno", total: 70, inCase: 4 },
      ],
      incidentsByEmployee: new Map([[10, 3]]),
      complaintsByEmployee: new Map([[11, 1]]),
    });
    expect(totalCases).toBe(3);
    expect(teamRate).toBeCloseTo(0.1);
    expect(rows.map((r) => r.key)).toEqual(["e:10", "n:rui sa", "e:11"]);
    expect(rows[0]).toMatchObject({ caseCount: 2, attachedCases: 1, movementCases: 2, incidents: 3, complaints: 0, caseRate: 0.4 });
    expect(rows[0].vsTeam).toBeCloseTo(4);
    expect(rows[1]).toMatchObject({ caseCount: 2, caseIds: [3, 2] });
    expect(rows[2]).toMatchObject({ caseCount: 1, complaints: 1 });
    expect(driverKey(null, "Rui Sá")).toBe("n:rui sa");
  });
  it("condutores deste caso que aparecem noutros casos", () => {
    const links = [
      { caseId: 1, via: "movement" as const, employeeId: 10, name: "Ana" },
      { caseId: 1, via: "movement" as const, employeeId: 12, name: "Zé" },
      { caseId: 2, via: "attached" as const, employeeId: 10, name: "Ana" },
      { caseId: 4, via: "movement" as const, employeeId: 10, name: "Ana" },
      { caseId: 5, via: "movement" as const, employeeId: 99, name: "Outro" },
    ];
    expect(repeatDriversForCase(1, links)).toEqual([{ key: "e:10", name: "Ana", employeeId: 10, otherCaseIds: [4, 2] }]);
  });
});

describe("mapeamento das conversões", () => {
  const inc = { id: 9, incidentType: "dano", severity: "critical", description: "Risco porta\nmais", vehiclePlate: "AA00BB", projectId: 3, reservationLink: "cabc123def456", costAmount: "120.50", employeeId: 4 };
  it("ocorrência → reclamação / perdido", () => {
    expect(incidentToComplaintFields(inc)).toMatchObject({ complaintType: "damage", complaintPriority: "urgent", reservationRef: "cabc123def456", projectId: 3, convertedFromType: "incident", convertedFromId: 9 });
    expect(incidentToComplaintFields(inc).title).toBe("Dano — AA00BB: Risco porta");
    expect(incidentToLostFields(inc)).toMatchObject({ bookingRef: "cabc123def456", estimatedValue: 121, priority: "high", status: "new", convertedFromId: 9 });
    expect(incidentToLostFields({ ...inc, reservationLink: "https://x/y z" }).bookingRef).toBeNull();
  });
  it("perdido ↔ reclamação copia valor, tipo e ligação", () => {
    const lost = { id: 4, description: "Óculos", priority: "high", itemType: "accessories", estimatedValue: 200, clientName: "Ana", bookingRef: "c1", projectId: 2, assignedTo: 8 };
    const c = lostToComplaintFields(lost);
    expect(c.title).toBe("[Acessórios] Óculos");
    expect(c.description).toContain("Valor estimado: 200€");
    expect(c).toMatchObject({ reservationRef: "c1", assignedToId: 8, complaintPriority: "high", convertedFromType: "lost", convertedFromId: 4 });
    const back = complaintToLostFields({ id: 7, title: "T", description: "D", complaintPriority: "urgent", reservationRef: "c9", assignedToId: 1 });
    expect(back).toMatchObject({ description: "T\n\nD", priority: "high", bookingRef: "c9", assignedTo: 1, clientName: "Desconhecido", convertedFromType: "complaint", convertedFromId: 7 });
    expect(convertedOriginPatch("lost", 12)).toEqual({ convertedToType: "lost", convertedToId: 12 });
  });
});

describe("HTML e ficheiros", () => {
  it("escapa todo o texto antes de o transformar em HTML", () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'y'`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;");
    expect(textToSafeHtml("Olá <b>Ana</b>,\nLinha 2")).toBe("<p>Olá &lt;b&gt;Ana&lt;/b&gt;,<br>Linha 2</p>");
  });
  it("content type correto e extensão segura", () => {
    expect(contentTypeForFilename("fatura.PDF")).toBe("application/pdf");
    expect(contentTypeForFilename("foto.jpg")).toBe("image/jpeg");
    expect(contentTypeForFilename("x.exe")).toBe("application/octet-stream");
    expect(safeExt("a.b/../../x.p<h>p")).toBe("php");
  });
});

describe("migration 0092", () => {
  it("é idempotente (backfill só nas NULL, depois NOT NULL)", () => {
    const all = MIGRATION_0092_STATEMENTS.join("\n");
    const add = MIGRATION_0092_STATEMENTS.findIndex((x) => x.includes("ADD COLUMN `driverConfirmed` TINYINT NULL"));
    const upd = MIGRATION_0092_STATEMENTS.findIndex((x) => x.startsWith("UPDATE `incidents` SET `driverConfirmed`"));
    const mod = MIGRATION_0092_STATEMENTS.findIndex((x) => x.includes("MODIFY COLUMN `driverConfirmed` TINYINT NOT NULL DEFAULT 0"));
    expect(add).toBeGreaterThanOrEqual(0);
    expect(add < upd && upd < mod).toBe(true);
    expect(MIGRATION_0092_STATEMENTS[upd]).toMatch(/WHERE `driverConfirmed` IS NULL/);
    expect(all).toMatch(/'converted'/);
    expect(IDEMPOTENT_ERROR_CODES_0092.has("ER_DUP_FIELDNAME")).toBe(true);
  });
});
