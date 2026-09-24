import { describe, expect, it } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { SQL } from "drizzle-orm";
import {
  buildHandoverEmail,
  cashDifference,
  citiesNeedingReminder,
  coveredCarsPending,
  HANDOVER_CITY_FIELDS,
  type CoveredCarCandidate,
  complianceStatus,
  compliancePercent,
  extractNoteItems,
  handoverDueAtMs,
  materialExceptionsFor,
  mergeCarryOver,
  mergeStoredOpenItems,
  nextShiftOf,
  normalizeAiBullets,
  openItemKey,
  parseMaterialExceptions,
  parseOpenItems,
  previousShiftOf,
  remindersDue,
  shiftWindowUtc,
  withNoteItems,
  type HandoverDraftCounts,
  type OpenItem,
} from "../shared/shiftHandoverAuto";
import { bucketByHour, cityProjectIdsFrom, draftOpenItems } from "./shiftHandoverDraft";
import { handoverEmailCc, handoverEmailEnabled } from "./shiftHandoverAutomation";
import { buildClaimEmailVersion, buildHandoverAck, buildHandoverInsert, buildHandoverMetaUpdate, buildHandoverUpdate, handoverBoundValues } from "./shiftHandoverSql";
import { MIGRATION_0088_STATEMENTS, IDEMPOTENT_ERROR_CODES_0088 } from "./migrations/migration_0088";

const at = (iso: string) => Date.parse(iso);
const compile = (q: SQL) => new MySqlDialect().sqlToQuery(q);

describe("turno seguinte / anterior e janelas", () => {
  it("manhã → noite do mesmo dia → manhã do dia seguinte", () => {
    expect(nextShiftOf({ date: "2026-09-24", shift: "morning" })).toEqual({ date: "2026-09-24", shift: "night" });
    expect(nextShiftOf({ date: "2026-09-24", shift: "night" })).toEqual({ date: "2026-09-25", shift: "morning" });
    expect(previousShiftOf({ date: "2026-09-24", shift: "morning" })).toEqual({ date: "2026-09-23", shift: "night" });
    expect(previousShiftOf({ date: "2026-09-24", shift: "night" })).toEqual({ date: "2026-09-24", shift: "morning" });
  });
  it("janela UTC da noite (verão) e da manhã (inverno)", () => {
    expect(shiftWindowUtc({ date: "2026-09-24", shift: "night" })).toMatchObject({ start: "2026-09-24 14:00:00", end: "2026-09-25 02:00:00" });
    expect(shiftWindowUtc({ date: "2026-01-15", shift: "morning" })).toMatchObject({ start: "2026-01-15 03:00:00", end: "2026-01-15 15:00:00" });
  });
});

describe("lembretes (~15:30 manhã, ~03:30 noite, Lisboa)", () => {
  it("prazo = fim do turno + 30 min", () => {
    expect(new Date(handoverDueAtMs({ date: "2026-09-24", shift: "morning" })).toISOString()).toBe("2026-09-24T14:30:00.000Z"); // 15:30 WEST
    expect(new Date(handoverDueAtMs({ date: "2026-09-24", shift: "night" })).toISOString()).toBe("2026-09-25T02:30:00.000Z"); // 03:30 WEST
    expect(new Date(handoverDueAtMs({ date: "2026-01-15", shift: "morning" })).toISOString()).toBe("2026-01-15T15:30:00.000Z"); // WET
  });
  it("cron das 16:07 (Lisboa) apanha a manhã; às 15:07 ainda não", () => {
    expect(remindersDue(at("2026-09-24T15:07:00Z"))).toEqual([{ date: "2026-09-24", shift: "morning" }]);
    expect(remindersDue(at("2026-09-24T14:07:00Z"))).toEqual([]);
  });
  it("cron das 04:07 apanha a noite de ontem", () => {
    expect(remindersDue(at("2026-09-25T03:07:00Z"))).toEqual([{ date: "2026-09-24", shift: "night" }]);
    // 01:07 de Lisboa: a noite ainda decorre
    expect(remindersDue(at("2026-09-25T00:07:00Z"))).toEqual([]);
  });
  it("não lembra turnos antigos (mais de 6h depois do prazo)", () => {
    expect(remindersDue(at("2026-09-24T21:07:00Z"))).toEqual([]);
  });
  it("idempotente: só cidades com turno, sem passagem e sem lembrete", () => {
    expect(citiesNeedingReminder({ citiesWithShift: ["lisbon", "porto", "faro", "lisbon"], citiesWithHandover: ["porto"], citiesAlreadyReminded: [] })).toEqual(["faro", "lisbon"]);
    expect(citiesNeedingReminder({ citiesWithShift: ["lisbon", "faro"], citiesWithHandover: [], citiesAlreadyReminded: ["lisbon", "faro"] })).toEqual([]);
  });
});

describe("cumprimento", () => {
  const s = { date: "2026-09-24", shift: "morning" as const };
  const due = handoverDueAtMs(s);
  it("em falta só depois do prazo", () => {
    expect(complianceStatus(s, null, due - 1).status).toBe("pending");
    expect(complianceStatus(s, null, due).status).toBe("missing");
  });
  it("a tempo / atrasada / confirmada", () => {
    expect(complianceStatus(s, { createdAtMs: due - 60_000, ackAtMs: null }, due + 1)).toEqual({ status: "on_time", late: false });
    expect(complianceStatus(s, { createdAtMs: due + 60_000, ackAtMs: null }, due + 1)).toEqual({ status: "late", late: true });
    expect(complianceStatus(s, { createdAtMs: due + 60_000, ackAtMs: due + 120_000 }, due + 1)).toEqual({ status: "confirmed", late: true });
  });
  it("% a 30 dias ignora turnos a decorrer", () => {
    expect(compliancePercent([
      { status: "on_time", late: false }, { status: "confirmed", late: false },
      { status: "late", late: true }, { status: "missing", late: false }, { status: "pending", late: false },
    ])).toBe(50);
    expect(compliancePercent([{ status: "pending", late: false }])).toBeNull();
  });
  it("diferença de caixa só quando é relevante (≥ 5 €)", () => {
    expect(cashDifference({ frontPouchValue: "100.00", terminalPouchValue: 50 }, { frontPouchValue: 120, terminalPouchValue: "50" })).toBe(-20);
    expect(cashDifference({ frontPouchValue: 100 }, { frontPouchValue: 102 })).toBeNull();
    expect(cashDifference({ frontPouchValue: 100 }, null)).toBeNull();
    expect(cashDifference({ frontPouchValue: null }, { frontPouchValue: 10 })).toBeNull();
  });
});

describe("pendentes (carry-over)", () => {
  const note = (t: string, extra: Partial<OpenItem> = {}): OpenItem => ({ key: openItemKey("note", t), kind: "note", text: t, resolved: false, ...extra });
  const compl = (id: number, extra: Partial<OpenItem> = {}): OpenItem => ({ key: openItemKey("complaint", id), kind: "complaint", refId: id, text: `#${id}`, resolved: false, ...extra });

  it("notas em lista viram pendentes; texto normal não", () => {
    const items = extractNoteItems("Tudo ok\n- Ligar ao cliente do BMW\n* Chave no cofre\n• Rever PDA 3\n[ ] Repor rolos\n-x", "2026-09-24 morning");
    expect(items.map((i) => i.text)).toEqual(["Ligar ao cliente do BMW", "Chave no cofre", "Rever PDA 3", "Repor rolos"]);
    expect(openItemKey("note", "Chave  no Cofre")).toBe(openItemKey("note", "chave no cofre"));
    expect(withNoteItems([note("Chave no cofre")], "- chave no cofre\n- Outra", "x").map((i) => i.text)).toEqual(["Chave no cofre", "Outra"]);
  });

  it("anterior por resolver passa; resolvidos não; entidade fechada resolve-se sozinha", () => {
    const merged = mergeCarryOver({
      previous: [note("Ligar cliente"), note("Feito", { resolved: true }), compl(1), compl(2)],
      draft: [compl(2), compl(3)],
      nowIso: "2026-09-24T15:00:00.000Z",
    });
    const byKey = Object.fromEntries(merged.map((i) => [i.key, i]));
    expect(byKey[openItemKey("note", "Ligar cliente")].resolved).toBe(false);
    expect(byKey[openItemKey("note", "Feito")]).toBeUndefined();
    expect(byKey[openItemKey("complaint", 1)]).toMatchObject({ resolved: true, resolvedByName: "sistema" });
    expect(byKey[openItemKey("complaint", 2)].resolved).toBe(false);
    expect(byKey[openItemKey("complaint", 3)].resolved).toBe(false);
  });

  it("o que está no formulário prevalece (visto do utilizador)", () => {
    const merged = mergeCarryOver({ previous: [], draft: [compl(5)], current: [compl(5, { resolved: true, resolvedByName: "Ana" })] });
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ resolved: true, resolvedByName: "Ana" });
  });

  it("gravação: resolvido na BD não reabre por um formulário antigo", () => {
    const out = mergeStoredOpenItems([compl(1, { resolved: true, resolvedByName: "Rui", resolvedAt: "t" })], [compl(1), note("nova")]);
    expect(out[0]).toMatchObject({ resolved: true, resolvedByName: "Rui" });
    expect(out[1].resolved).toBe(false);
  });

  it("JSON inválido ou lixo → lista limpa", () => {
    expect(parseOpenItems("not json")).toEqual([]);
    expect(parseOpenItems(JSON.stringify([{ key: "x", kind: "hack", text: "a" }, compl(1)]))).toHaveLength(1);
    expect(parseMaterialExceptions([{ code: "pens", note: "  2 em falta " }, { code: "zzz" }])).toEqual([{ code: "pens", note: "2 em falta" }]);
  });

  it("rascunho → pendentes com chave estável por entidade", () => {
    const items = draftOpenItems({
      complaints: [{ id: 7, title: "Risco" }], lostFound: [{ id: 3, clientName: "Ana", description: "Óculos" }],
      pdas: [{ id: 9, pdaName: "PDA 2", employeeName: "Rui" }], incidents: [], pendingDeliveries: [{ externalId: "ab", bookingNumber: "B1", plate: "AA-00-BB" }],
    }, "2026-09-24 morning");
    expect(items.map((i) => i.key)).toEqual(["complaint:7", "lost_found:3", "pda:9", "delivery:ab"]);
  });
});

describe("agregação do rascunho", () => {
  it("recolhas/entregas por hora de Lisboa (noite: 15h → 02h)", () => {
    const next = { date: "2026-09-24", shift: "night" as const };
    const rows = bucketByHour(next, [at("2026-09-24T14:10:00Z"), at("2026-09-24T14:50:00Z"), at("2026-09-25T01:59:00Z")], [at("2026-09-24T23:30:00Z"), at("2026-09-25T03:00:00Z")]);
    expect(rows).toHaveLength(12);
    expect(rows[0]).toMatchObject({ hour: 15, label: "15h", checkins: 2 });
    expect(rows.find((r) => r.hour === 26)).toMatchObject({ label: "02h", checkins: 1 });
    expect(rows.find((r) => r.hour === 24)).toMatchObject({ label: "00h", checkouts: 1 });
    // 03:00 já é o turno seguinte → fora
    expect(rows.reduce((s, r) => s + r.checkouts, 0)).toBe(1);
  });
  it("projetos da árvore da cidade", () => {
    const projects = [
      { id: 1, parentId: null, name: "Lisboa", level: "city" },
      { id: 2, parentId: 1, name: "Parque A", level: "park" },
      { id: 3, parentId: 2, name: "Lavagem", level: "service" },
      { id: 4, parentId: null, name: "Faro", level: "city" },
    ];
    expect(cityProjectIdsFrom(projects, "lisbon").sort()).toEqual([1, 2, 3]);
    expect(cityProjectIdsFrom(projects, "faro")).toEqual([4]);
    expect(cityProjectIdsFrom(projects, "porto")).toEqual([]);
  });
});

describe("email ao team leader do turno seguinte", () => {
  const counts: HandoverDraftCounts = {
    checkinsNext: 12, checkoutsNext: 9, pendingDeliveries: 1, complaintsNew: 0, complaintsOpen: 2, lostFoundOpen: 1,
    incidentsOpen: 0, whatsappUnread: 3, pdasCheckedIn: 2, clockInsOpen: 1, speedAlerts: 0, gpsAlerts: 1, toCollectEur: 45.5,
  };
  it("assunto, resumo IA, números, pendentes abertos e link; HTML escapado", () => {
    const m = buildHandoverEmail({
      city: "porto", shift: { date: "2026-09-24", shift: "night" }, authorName: "Ana <script>",
      aiSummary: "• Pico às 06h\n• 2 reclamações abertas", counts, notes: null,
      openItems: [{ key: "note:a", kind: "note", text: "Chave <b>", resolved: false }, { key: "note:b", kind: "note", text: "Feito", resolved: true }],
      link: "https://x.pt/passagem-turno",
    });
    expect(m.subject).toBe("Passagem de turno — Porto 2026-09-24 Noite");
    expect(m.text).toContain("• Pico às 06h");
    expect(m.text).toContain("Entregas no próximo turno: 9 (a cobrar 45,50 €)");
    expect(m.text).toContain("Pendentes (1):");
    expect(m.text).not.toContain("Feito");
    expect(m.text).toContain("https://x.pt/passagem-turno");
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("Chave &lt;b&gt;");
  });
  it("sem IA → notas/resumo simples", () => {
    const m = buildHandoverEmail({ city: "faro", shift: { date: "2026-09-24", shift: "morning" }, authorName: null, aiSummary: null, counts: null, notes: "Tudo calmo", openItems: [], link: "l" });
    expect(m.text).toContain("Notas: Tudo calmo");
    expect(m.text).toContain("Sem pendentes.");
  });
  it("interruptor e CC", () => {
    const smtp = { SMTP_HOST: "h", SMTP_USER: "u", SMTP_PASS: "p" };
    expect(handoverEmailEnabled(smtp)).toBe(true);
    expect(handoverEmailEnabled({ ...smtp, HANDOVER_EMAIL: "off" })).toBe(false);
    expect(handoverEmailEnabled({})).toBe(false);
    expect(handoverEmailCc("a@x.pt; B@x.pt, lixo, a@x.pt", ["b@x.pt"])).toEqual(["a@x.pt"]);
  });
  it("IA → no máximo 5 pontos", () => {
    expect(normalizeAiBullets("1. um\n2) dois\n- três\n* quatro\n• cinco\n- seis")).toBe("• um\n• dois\n• três\n• quatro\n• cinco");
    expect(normalizeAiBullets("")).toBeNull();
  });
});

describe("material por cidade", () => {
  it("bolsa do terminal em todas as cidades (incl. Faro e Porto)", () => {
    for (const c of ["lisbon", "porto", "faro"] as const) {
      expect(HANDOVER_CITY_FIELDS[c].terminalPouch).toBe(true);
      expect(materialExceptionsFor(c)).toContain("terminal_pouch");
      expect(materialExceptionsFor(c)).toContain("mb_rolls_pouch");
    }
  });
});

describe("carros p/ coberto (automático)", () => {
  const base: CoveredCarCandidate = { externalId: "a", bookingNumber: "1", plate: "AA-00-00", parkName: "P", status: "CHECKED_IN", spotType: "covered", parkingType: null, checkInMs: 1000, lastMoveMs: null };
  const now = 10_000;
  it("conta coberto, no parque e sem movimento depois do check-in", () => {
    expect(coveredCarsPending([base], now).map((b) => b.externalId)).toEqual(["a"]);
  });
  it("movimento depois do check-in → já foi para o coberto", () => {
    expect(coveredCarsPending([{ ...base, lastMoveMs: 2000 }], now)).toEqual([]);
    // movimento de uma estadia anterior (antes do check-in) não conta
    expect(coveredCarsPending([{ ...base, lastMoveMs: 500 }], now)).toHaveLength(1);
  });
  it("ignora descobertos, já entregues e check-ins futuros; aceita parkingType COVERED", () => {
    expect(coveredCarsPending([{ ...base, spotType: "uncovered" }], now)).toEqual([]);
    expect(coveredCarsPending([{ ...base, spotType: "unknown", parkingType: "COVERED" }], now)).toHaveLength(1);
    expect(coveredCarsPending([{ ...base, status: "CHECKED_OUT" }], now)).toEqual([]);
    expect(coveredCarsPending([{ ...base, status: "PENDING_CHECKOUT" }], now)).toEqual([]);
    expect(coveredCarsPending([{ ...base, checkInMs: 20_000 }], now)).toEqual([]);
  });
  it("ordena por check-in", () => {
    const r = coveredCarsPending([{ ...base, externalId: "b", checkInMs: 3000 }, { ...base, externalId: "c", checkInMs: 2000 }], now);
    expect(r.map((x) => x.externalId)).toEqual(["c", "b"]);
  });
});

describe("SQL da automação — parametrizado e sem mexer na versão", () => {
  const evil = "x' OR 1=1 -- ";
  it("uniformsCount já não se escreve (legado preservado)", () => {
    const q = compile(buildHandoverUpdate(1, 2, { notes: "a" }, { id: 1, name: "n" }));
    expect(q.sql).not.toContain("uniformsCount");
    const ins = compile(buildHandoverInsert({ handoverDate: "2026-09-24", shift: "morning", city: "faro" }, { openItems: [{ key: "note:a" }], materialOk: false }, { id: 1, name: "n" }));
    expect(ins.sql).toContain("`openItems`");
    expect(ins.params).toContain(JSON.stringify([{ key: "note:a" }]));
    expect(handoverBoundValues({ materialOk: true, materialExceptions: [{ code: "pens" }] })).toMatchObject({ materialOk: 1, materialExceptions: '[{"code":"pens"}]' });
  });
  it("metadados: whitelist, texto como parâmetro, updatedAt/versão intactos", () => {
    const q = compile(buildHandoverMetaUpdate(5, { aiSummary: evil, emailSentVersion: 3 })!);
    expect(q.sql).not.toContain("OR 1=1");
    expect(q.sql).not.toContain("`version`");
    expect(q.sql).toContain("`updatedAt` = `updatedAt`");
    expect(q.params).toEqual([evil, 3, 5]);
    expect(buildHandoverMetaUpdate(5, {})).toBeNull();
  });
  it("email reclamado 1× por versão", () => {
    const q = compile(buildClaimEmailVersion(5, 2));
    expect(q.sql).toMatch(/`emailSentVersion` IS NULL OR `emailSentVersion` < \?/);
    expect(q.params).toEqual([2, 5, 2, 2]);
  });
  it("Recebi: só a 1.ª vez e nunca o autor", () => {
    const q = compile(buildHandoverAck(9, { id: 4, name: evil }));
    expect(q.sql).toContain("`ackAt` IS NULL");
    expect(q.sql).toContain("`createdById` <> ?");
    expect(q.params).toEqual([4, evil, 9, 4]);
  });
});

describe("migração 0088", () => {
  it("colunas novas idempotentes + tabela de lembretes", () => {
    for (const c of ["autoSummary", "openItems", "aiSummary", "ackById", "ackByName", "ackAt", "emailSentVersion", "materialOk", "materialExceptions"]) {
      expect(MIGRATION_0088_STATEMENTS.some((s) => s.includes(`ADD COLUMN \`${c}\``))).toBe(true);
    }
    expect(MIGRATION_0088_STATEMENTS.some((s) => s.startsWith("CREATE TABLE IF NOT EXISTS `shift_handover_reminders`"))).toBe(true);
    expect(IDEMPOTENT_ERROR_CODES_0088.has("ER_DUP_FIELDNAME")).toBe(true);
  });
});
