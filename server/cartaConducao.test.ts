/**
 * Frente A — Carta de condução (Jorge, 7 out 2026: "deve haver 'carta
 * pendente de validação' e 'carta validada'. Carta validada é quando o
 * condutor tem carta há mais de 3 anos"; decisão: < 3 anos = etiqueta +
 * aviso ao escalar, nunca bloqueia).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fullYearsBetween, isCalendarDay, isLicenceIssueKey, licenceAnniversary, licenceIssueDateFromPayload,
  licenceRelevant, licenceScheduleWarning, licenceStatus, LICENCE_STATUS_LABELS, LICENCE_STATUSES,
} from "../shared/drivingLicence";
import { computeLeadScore, licenceYearsFromIssueDate } from "./aiOps/leadScoring";
import { leadIdentityPatch } from "./extrasAutomation";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

describe("anos completos de carta (calendário, aniversário)", () => {
  it("faz anos no dia do aniversário — nem um dia antes", () => {
    expect(fullYearsBetween("2023-10-07", "2026-10-07")).toBe(3);
    expect(fullYearsBetween("2023-10-08", "2026-10-07")).toBe(2);
    expect(fullYearsBetween("2023-10-07", "2026-10-06")).toBe(2);
    expect(fullYearsBetween("2026-10-07", "2026-10-07")).toBe(0);
    expect(fullYearsBetween("2026-10-08", "2026-10-07")).toBe(-1);
  });

  it("29/02: faz anos a 28/02 nos anos não bissextos (art. 279.º CC) e a 29/02 nos bissextos", () => {
    expect(fullYearsBetween("2020-02-29", "2023-02-27")).toBe(2);
    expect(fullYearsBetween("2020-02-29", "2023-02-28")).toBe(3);
    expect(fullYearsBetween("2020-02-29", "2023-03-01")).toBe(3);
    expect(fullYearsBetween("2020-02-29", "2024-02-28")).toBe(3);
    expect(fullYearsBetween("2020-02-29", "2024-02-29")).toBe(4);
    expect(licenceAnniversary("2020-02-29", 3)).toBe("2023-02-28");
    expect(licenceAnniversary("2020-02-29", 4)).toBe("2024-02-29");
    expect(licenceAnniversary("2023-10-07")).toBe("2026-10-07");
  });

  it("só dias reais", () => {
    expect(isCalendarDay("2023-02-29")).toBe(false);
    expect(isCalendarDay("2024-02-29")).toBe(true);
    expect(isCalendarDay("2024-13-01")).toBe(false);
    expect(isCalendarDay("07/10/2026")).toBe(false);
    expect(isCalendarDay(null)).toBe(false);
    expect(() => fullYearsBetween("2023-02-29", "2026-10-07")).toThrow();
  });
});

describe("licenceStatus — etiqueta da carta", () => {
  const today = "2026-10-07";
  it("validada pelo RH e com 3 anos completos → Carta validada (exatamente 3 anos conta)", () => {
    expect(licenceStatus({ issuedAt: "2023-10-07", validatedAt: "2026-10-01 10:00:00" }, today)).toBe("validated");
    expect(licenceStatus({ issuedAt: "2010-01-01", validatedAt: "2026-10-01 10:00:00", hasDocument: true }, today)).toBe("validated");
  });
  it("3 anos menos um dia → Carta < 3 anos (validada ou só declarada); passa sozinha no aniversário", () => {
    expect(licenceStatus({ issuedAt: "2023-10-08", validatedAt: "2026-10-01 10:00:00" }, today)).toBe("under_3y");
    expect(licenceStatus({ issuedAt: "2023-10-08", validatedAt: null }, today)).toBe("under_3y");
    expect(licenceStatus({ issuedAt: "2023-10-08", validatedAt: "2026-10-01 10:00:00" }, "2026-10-08")).toBe("validated");
  });
  it("29/02 de 2020: < 3 anos até 27/02/2023, validada a 28/02/2023", () => {
    const f = { issuedAt: "2020-02-29", validatedAt: "2021-01-01 09:00:00" };
    expect(licenceStatus(f, "2023-02-27")).toBe("under_3y");
    expect(licenceStatus(f, "2023-02-28")).toBe("validated");
  });
  it("há carta mas o RH ainda não validou → pendente de validação", () => {
    expect(licenceStatus({ issuedAt: "2015-05-05", validatedAt: null }, today)).toBe("pending");
    expect(licenceStatus({ issuedAt: null, validatedAt: null, hasDocument: true }, today)).toBe("pending");
    expect(licenceStatus({ issuedAt: null, validatedAt: null, hasNumber: true }, today)).toBe("pending");
    // validada sem data (não acontece pela app) não chega para "validada"
    expect(licenceStatus({ issuedAt: null, validatedAt: "2026-10-01 10:00:00", hasDocument: true }, today)).toBe("pending");
    // data no futuro: engano — por validar
    expect(licenceStatus({ issuedAt: "2027-01-01", validatedAt: "2026-10-01 10:00:00" }, today)).toBe("pending");
  });
  it("nada sobre a carta → Sem carta (data inválida conta como nada)", () => {
    expect(licenceStatus({ issuedAt: null, validatedAt: null }, today)).toBe("missing");
    expect(licenceStatus({ issuedAt: "31/12/2010", validatedAt: null, hasDocument: false, hasNumber: false }, today)).toBe("missing");
  });
  it("etiqueta só onde interessa: quem conduz sempre; escritório só se houver carta", () => {
    expect(licenceRelevant("extra", "missing")).toBe(true);
    expect(licenceRelevant("team_leader", "pending")).toBe(true);
    expect(licenceRelevant("backoffice", "missing")).toBe(false);
    expect(licenceRelevant("director", "validated")).toBe(true);
    expect(licenceRelevant("extra", null)).toBe(false);
  });
  it("etiquetas PT-PT", () => {
    expect(LICENCE_STATUSES.map((s) => LICENCE_STATUS_LABELS[s])).toEqual(["Carta validada", "Carta pendente de validação", "Carta < 3 anos", "Sem carta"]);
  });
});

describe("aviso ao escalar (nunca bloqueia)", () => {
  it("< 3 anos, pendente e sem carta avisam; validada não", () => {
    expect(licenceScheduleWarning("under_3y", "Ana")).toMatch(/^Ana tem carta há menos de 3 anos\. Podes escalar/);
    expect(licenceScheduleWarning("pending", "Rui")).toMatch(/carta de Rui ainda não foi validada/);
    expect(licenceScheduleWarning("missing", null)).toMatch(/^Esta pessoa não tem carta/);
    expect(licenceScheduleWarning("validated", "Ana")).toBeNull();
    expect(licenceScheduleWarning(undefined, "Ana")).toBeNull();
  });
  it("os candidatos do Extras-dia trazem o estado da carta (leitura falhada → sem etiqueta)", () => {
    expect(src("server/extrasDia.ts")).toMatch(/licenceStatusMap\(rows\.map\(r => r\.id\)\)/);
    expect(src("server/extrasDia.ts")).toMatch(/licence: licences\.get\(r\.id\),/);
  });
});

describe("candidatura do site → data de emissão da carta", () => {
  // Formato do payload do site multidriver (route.ts): o n.º e a validade da carta já vinham; a data de emissão vem a seguir.
  const payload = { "Carta de Condução": "L-1234567 8", "Validade da Carta": "2031-05-04", "País da Carta": "Portugal", "Data de Emissão da Carta": "2019-03-15" };
  it("lê só a chave de EMISSÃO — nunca o n.º nem a validade", () => {
    expect(licenceIssueDateFromPayload(payload)).toBe("2019-03-15");
    expect(licenceIssueDateFromPayload({ "Carta de Condução": "2015", "Validade da Carta": "2031-05-04" })).toBeNull();
    expect(isLicenceIssueKey("Data de Emissão da Carta")).toBe(true);
    expect(isLicenceIssueKey("licenseIssueDate")).toBe(true);
    expect(isLicenceIssueKey("Carta de Condução")).toBe(false);
    expect(isLicenceIssueKey("Validade da Carta")).toBe(false);
    expect(isLicenceIssueKey("Data de emissão do CC")).toBe(false);
  });
  it("aceita DD/MM/AAAA, ISO com hora e JSON em texto; recusa dias que não existem", () => {
    expect(licenceIssueDateFromPayload({ "Data de Emissão da Carta": "5/3/2019" })).toBe("2019-03-05");
    expect(licenceIssueDateFromPayload({ licenseIssueDate: "2019-03-15T00:00:00.000Z" })).toBe("2019-03-15");
    expect(licenceIssueDateFromPayload(JSON.stringify(payload))).toBe("2019-03-15");
    expect(licenceIssueDateFromPayload({ "Data de Emissão da Carta": "31/02/2019" })).toBeNull();
    expect(licenceIssueDateFromPayload(null)).toBeNull();
    expect(licenceIssueDateFromPayload("não é json")).toBeNull();
  });
  it("lead → ficha: a data passa só se a ficha não a tiver", () => {
    expect(leadIdentityPatch({ drivingLicenseIssuedAt: "2019-03-15" }, { nif: null, idDocNumber: null, drivingLicenseNumber: null, drivingLicenseIssuedAt: null })).toEqual({ drivingLicenseIssuedAt: "2019-03-15" });
    expect(leadIdentityPatch({ drivingLicenseIssuedAt: "2019-03-15" }, { nif: null, idDocNumber: null, drivingLicenseNumber: null, drivingLicenseIssuedAt: "2010-01-01" })).toEqual({});
  });
  it("candidatura → lead e aprovação → ficha (só se vazia)", () => {
    const sync = src("server/extraLeadsSync.ts");
    expect(sync).toMatch(/drivingLicenseIssuedAt: licenceIssueDateFromPayload\(app\.payload\)/);
    expect(sync).toMatch(/COALESCE\(\$\{extraLeads\.drivingLicenseIssuedAt\}, \$\{cand\.drivingLicenseIssuedAt\}\)/);
    const intake = src("server/webIntake.ts");
    expect(intake).toMatch(/licenceIssueDateFromPayload\(app\.payload\)/);
    expect(intake).toMatch(/isNull\(employees\.drivingLicenseIssuedAt\)/);
  });
});

describe("pontuação dos leads: 'Anos de carta' pela data de emissão (bug: lia o n.º da carta)", () => {
  it("o n.º da carta nunca vira anos", () => {
    expect(licenceYearsFromIssueDate("L-1234567 8", "2026-10-07")).toBeNull();
    expect(licenceYearsFromIssueDate("12345678", "2026-10-07")).toBeNull();
    expect(licenceYearsFromIssueDate("2019-03-15", "2026-10-07")).toBe(7);
    expect(licenceYearsFromIssueDate("2026-12-01", "2026-10-07")).toBeNull();
    const src2 = src("server/aiOps/leadScoring.ts");
    expect(src2).not.toMatch(/pickPayload\(payload, \/licen\|carta/);
    expect(src2).toMatch(/licenceYearsFromIssueDate\(l\.drivingLicenseIssuedAt \?\? licenceIssueDateFromPayload\(payload\), today\)/);
  });
  it("sem data → 'sem dados' (0 pontos), em vez de pontos inventados", () => {
    const base = { availabilityText: null, city: null, experienceText: null, firstContactedAt: null, lastInboundAt: null, status: "new" } as const;
    const line = (y: number | null) => computeLeadScore({ ...base, licenceYears: y }, "2026-10-07 10:00:00").lines.find((l) => l.key === "licenceYears")!;
    expect(line(null)).toMatchObject({ points: 0, detail: "sem dados" });
    expect(line(7)).toMatchObject({ points: 20 });
  });
});
