/**
 * Automações internas com IA — o runAi está SIMULADO (nunca há chamadas
 * reais). Cobre: matemática das anomalias, agregação do briefing, limiares
 * das respostas de disponibilidade, pontuação das leads, pendentes repetidos
 * da passagem de turno, lógica do `ok` do cron e "interruptor desligado →
 * nenhuma chamada à IA".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  runAi: vi.fn(),
  available: vi.fn(async () => true),
  db: null as any,
  trees: [] as any[],
}));

vi.mock("../_core/ai/run", () => ({ runAi: (...a: any[]) => h.runAi(...a) }));
vi.mock("../_core/ai/status", () => ({ aiFeatureAvailableFresh: (...a: any[]) => h.available(...a) }));
vi.mock("../db", async (orig) => ({ ...(await orig<any>()), getDb: async () => h.db }));
vi.mock("./cities", async (orig) => ({ ...(await orig<any>()), loadCityTrees: async () => h.trees }));

import { AiCallCap, tryAi } from "./aiCall";
import {
  countMinStd,
  detectSeriesAnomalies,
  duplicateExpenses,
  expenseOutliers,
  mean,
  sameWeekdayDays,
  stdDev,
  zScore,
  type ExpenseLite,
} from "./anomalyMath";
import { anomalyPrompt, bookingSeries, marketingSeries, seriesDetail } from "./anomalies";
import {
  briefingFacts,
  briefingFallbackSummary,
  briefingSummary,
  buildBriefingData,
  filterBriefingFor,
  renderBriefingEmail,
  viewerPerms,
} from "./briefing";
import { AUTO_APPLY_CONFIDENCE, classifyUnclearAvailability, decideAiAvailability, requestDays } from "./availabilityAi";
import { availabilityDays, computeLeadScore, LEAD_SCORE_FIELDS, licenceYearsFrom, parseYears, summaryFallback } from "./leadScoring";
import { aggregateHandoverWeek, detectRepeatedItems, textSimilarity } from "./handoverRepeats";
import { opsCronOutcome, runOpsBriefingCron, lisbonClockOf } from "./cron";
import { explanationFacts, explanationFallback } from "./evaluationExplain";
import { cityTrees, opsCityOf } from "./cities";
import { eligibleForCity, eligibleNational } from "./recipients";
import { AiBudgetExceededError } from "../_core/ai/errors";

beforeEach(() => {
  h.runAi.mockReset();
  h.available.mockReset();
  h.available.mockImplementation(async () => true);
  h.db = null;
  h.trees = [];
});

// ─── Anomalias ───────────────────────────────────────────────────────────────

describe("anomalias — matemática", () => {
  it("média, desvio amostral e z-score", () => {
    expect(mean([2, 4, 6])).toBe(4);
    expect(stdDev([2, 4, 6])).toBeCloseTo(2, 6);
    expect(zScore(10, [2, 4, 6, 4])!.z).toBeCloseTo((10 - 4) / stdDev([2, 4, 6, 4]), 6);
    expect(zScore(10, [2, 4])).toBeNull(); // histórico curto
    expect(zScore(5, [5, 5, 5, 5])).toEqual({ z: 0, expected: 5, std: 0 });
    expect(zScore(6, [5, 5, 5, 5])).toBeNull(); // sem variação e sem desvio mínimo
    expect(zScore(6, [5, 5, 5, 5], { minStd: 1 })!.z).toBe(1);
  });

  it("compara com o MESMO dia da semana das 8 semanas anteriores", () => {
    const days = sameWeekdayDays("2026-09-23");
    expect(days).toHaveLength(8);
    expect(days[0]).toBe("2026-09-16");
    expect(days[7]).toBe("2026-07-29");
    for (const d of days) expect(new Date(`${d}T12:00:00Z`).getUTCDay()).toBe(new Date("2026-09-23T12:00:00Z").getUTCDay());
  });

  it("deteta picos e quebras; ignora ruído pequeno; desvio mínimo das contagens", () => {
    const day = "2026-09-23";
    const hist = sameWeekdayDays(day);
    const series = (vals: number[], today: number) => new Map([[day, today], ...hist.map((d, i) => [d, vals[i]] as [string, number])]);
    const out = detectSeriesAnomalies(day, [
      { subject: "Parque A", values: series([20, 22, 19, 21, 20, 23, 18, 21], 45) }, // pico
      { subject: "Parque B", values: series([30, 31, 29, 30, 32, 28, 30, 31], 5) },  // quebra
      { subject: "Parque C", values: series([20, 22, 19, 21, 20, 23, 18, 21], 22) }, // normal
      { subject: "Parque D", values: series([0, 1, 0, 0, 1, 0, 0, 0], 3) },          // ruído (< 5)
    ], { counts: true, fillMissing: true, minMagnitude: 5 });
    expect(out.map((a) => a.subject)).toEqual(expect.arrayContaining(["Parque A", "Parque B"]));
    expect(out.find((a) => a.subject === "Parque C")).toBeUndefined();
    expect(out.find((a) => a.subject === "Parque D")).toBeUndefined();
    expect(out.find((a) => a.subject === "Parque A")!.direction).toBe("up");
    expect(out.find((a) => a.subject === "Parque B")!.direction).toBe("down");
    expect(out.find((a) => a.subject === "Parque B")!.severity).toBe("critical");
    expect(countMinStd([4, 4, 4, 4])).toBe(2);
  });

  it("dias em falta contam como 0 só com fillMissing", () => {
    const day = "2026-09-23";
    const values = new Map([[day, 10], [sameWeekdayDays(day)[0], 2]]);
    expect(detectSeriesAnomalies(day, [{ subject: "X", values }])).toEqual([]);
    expect(detectSeriesAnomalies(day, [{ subject: "X", values }], { fillMissing: true, counts: true }).length).toBe(1);
  });

  it("despesas: valor fora do normal para o fornecedor e duplicados", () => {
    const base = (id: number, day: string, amount: number, extra: Partial<ExpenseLite> = {}): ExpenseLite => ({
      id, day, amount, supplier: "Galp Energia, Lda", supplierNif: null, documentNumber: null, categoryId: 3, projectId: 10, ...extra,
    });
    const hist = [80, 95, 90, 100, 85, 92, 88].map((a, i) => base(i + 1, `2026-08-0${i + 1}`, a));
    const rows = [...hist, base(50, "2026-09-22", 900), base(51, "2026-09-22", 120, { supplier: "Outro", categoryId: 8 }),
      base(60, "2026-09-20", 250, { supplier: "Oficina X", categoryId: null }), base(61, "2026-09-22", 250, { supplier: "OFICINA X", categoryId: null }),
      base(70, "2026-09-10", 40, { supplier: "Papelaria", documentNumber: "FT 1/2", categoryId: null }), base(71, "2026-09-22", 41, { supplier: "Papelaria", documentNumber: "ft 1/2", categoryId: null })];
    const out = expenseOutliers(rows, "2026-09-21");
    expect(out.map((o) => o.expense.id)).toEqual([50]);
    expect(out[0].median).toBe(90);
    const dups = duplicateExpenses(rows, "2026-09-21");
    expect(dups.map((d) => [d.a.id, d.b.id, d.reason])).toEqual(expect.arrayContaining([[60, 61, "same_amount"], [70, 71, "document"]]));
    expect(dups.find((d) => d.a.id === 1)).toBeUndefined(); // histórico antigo não gera alertas
  });

  it("marketing: séries de gasto e ROAS s/ IVA (só com gasto ≥ 20 €)", () => {
    const { spend, roas } = marketingSeries([
      { day: "2026-09-23", provider: "google_ads", spend: 100, revenue: 1230 },
      { day: "2026-09-23", provider: "meta", spend: 10, revenue: 500 },
    ], 0.23);
    expect(spend.map((s) => s.subject).sort()).toEqual(["Google Ads", "Meta"]);
    expect(roas).toHaveLength(1);
    expect(roas[0].values.get("2026-09-23")).toBe(10);
  });

  it("reservas: séries por parque e por cidade × canal; texto com os números", () => {
    const trees = cityTrees([{ id: 1, name: "Lisboa", level: "city", parentId: null }, { id: 2, name: "Airpark Lisboa", level: "brand", parentId: 1 }]);
    const { parks, channels } = bookingSeries([
      { day: "2026-09-23", parkName: "Airpark Lisboa", city: "Lisboa", projectId: 2, origin: "MARKETPLACE", hasPartner: 0, hasCampaign: 0, n: 4 },
      { day: "2026-09-23", parkName: "Airpark Lisboa", city: "Lisboa", projectId: 2, origin: "GENERAL_FORM", hasPartner: 0, hasCampaign: 0, n: 6 },
    ], trees);
    expect(parks).toHaveLength(1);
    expect(parks[0].values.get("2026-09-23")).toBe(10);
    expect(parks[0].city).toBe("lisbon");
    expect(channels.map((c) => c.subject).sort()).toEqual(["Marketplace (Lisboa)", "Site (Lisboa)"]);
    expect(seriesDetail("Reservas", "2026-09-23", 30, 12, 4.2)).toMatch(/30 em 2026-09-23 \(quarta\), acima do habitual/);
    expect(anomalyPrompt([{ n: 1, domain: "bookings", detail: "x" }])).toBe("1. [bookings] x");
  });
});

// ─── Briefing ────────────────────────────────────────────────────────────────

function sampleBriefing() {
  return buildBriefingData({
    city: "lisbon", day: "2026-09-24", nowUtc: "2026-09-24 06:30:00",
    hourly: [
      { hour: 1, checkins: 9, checkouts: 9 }, // fora do dia operacional
      { hour: 6, checkins: 3, checkouts: 1 },
      { hour: 9, checkins: 8, checkouts: 6 },
      { hour: 25, checkins: 1, checkouts: 0 },
      { hour: 12, checkins: 0, checkouts: 0 },
    ],
    extras: { neededPeak: 5, neededHours: 40, assignments: [
      { isTeamLeader: true, startHour: 3, endHour: 15 },
      { isTeamLeader: false, startHour: 6, endHour: 14 },
      { isTeamLeader: false, startHour: 8, endHour: 12 },
    ] },
    sla: [
      { type: "complaint", id: 11, title: "Risco na porta", dueAt: "2026-09-24 20:00:00" },
      { type: "complaint", id: 12, title: "Atraso", dueAt: "2026-09-23 10:00:00" },
      { type: "incident", id: 21, title: "Dano", dueAt: "2026-09-24 05:00:00" },
    ],
    handover: { last: "2026-09-23 noite", pending: [{ key: "note:a", kind: "note", text: "Repor rolos MB", resolved: false }], repeated: [{ text: "Repor rolos MB", count: 3, since: "2026-09-22 manhã", kind: "note" }] },
    anomalies: [
      { domain: "bookings", severity: "warning", detail: "Reservas acima do habitual", explanation: null },
      { domain: "expenses", severity: "critical", detail: "Despesa #9 fora do normal", explanation: "Verificar" },
      { domain: "marketing", severity: "warning", detail: "Gasto Google acima", explanation: null },
    ],
    marketingAlerts: [{ level: "critical", title: "Campanha sem conversões", detail: "x" }],
  });
}

describe("briefing — agregação", () => {
  it("entradas/saídas por hora (só 03h→03h), pico, extras e SLA", () => {
    const d = sampleBriefing();
    expect(d.bookings.byHour.map((b) => b.label)).toEqual(["06h", "09h", "01h"]);
    expect(d.bookings.checkins).toBe(12);
    expect(d.bookings.checkouts).toBe(7);
    expect(d.bookings.peak).toEqual({ label: "09h", total: 14 });
    expect(d.extras).toEqual({ neededPeak: 5, neededHours: 40, scheduled: 2, scheduledHours: 12, teamLeaders: 1, gap: 3 });
    expect(d.sla).toMatchObject({ complaintsDueToday: 1, complaintsOverdue: 1, incidentsDueToday: 0, incidentsOverdue: 1 });
    expect(d.sla.items[0]).toMatchObject({ id: 12, overdue: true });
    expect(d.handover.pending).toEqual(["Repor rolos MB"]);
  });

  it("cada pessoa só vê as secções dos módulos a que tem acesso", () => {
    const d = sampleBriefing();
    const tl = viewerPerms({ role: "team_leader" });
    expect(tl).toMatchObject({ marketing: false, expenseAnomalies: false, bookingsAnomalies: true, complaints: true });
    const f = filterBriefingFor(d, tl);
    expect(f.marketingAlerts).toEqual([]);
    expect(f.anomalies.map((a) => a.domain)).toEqual(["bookings"]);
    const sa = filterBriefingFor(d, viewerPerms({ role: "super_admin" }));
    expect(sa.anomalies).toHaveLength(3);
    expect(sa.marketingAlerts).toHaveLength(1);
    const noComplaints = filterBriefingFor(d, { ...tl, complaints: false });
    expect(noComplaints.sla.items.every((i) => i.type === "incident")).toBe(true);
    expect(noComplaints.sla.complaintsOverdue).toBe(0);
    const mail = renderBriefingEmail(f, "Resumo.", "https://app");
    expect(mail.subject).toBe("Briefing Lisboa 24/09: 12 entradas, 7 saídas, faltam 3 extras");
    expect(mail.html).not.toMatch(/Campanha sem conversões|Despesa #9/);
  });

  it("os factos para a IA não levam marketing nem despesas; o texto fixo tem os números", () => {
    const d = sampleBriefing();
    const facts = briefingFacts(d);
    expect(facts).toMatch(/12 entradas e 7 saídas/);
    expect(facts).toMatch(/Faltam 3/);
    expect(facts).not.toMatch(/Campanha|Despesa|Gasto Google/);
    expect(briefingFallbackSummary(d)).toBe("Hoje em Lisboa: 12 entradas e 7 saídas, com pico às 09h (14). Extras: 2 escalados para 5 necessários no pico — faltam 3. 1 caso(s) com prazo hoje e 2 em atraso. 1 pendente(s) da passagem de turno, 1 a repetir-se.");
  });

  it("IA ligada → texto da IA; interruptor desligado → texto fixo SEM chamada", async () => {
    const d = sampleBriefing();
    h.runAi.mockResolvedValueOnce({ output: "Dia calmo até às 9h." });
    const on = await briefingSummary(d, new AiCallCap(5));
    expect(on).toEqual({ text: "Dia calmo até às 9h.", ai: true });
    expect(h.runAi.mock.calls[0][0]).toMatchObject({ feature: "ops_briefing" });
    h.runAi.mockClear();
    h.available.mockImplementation(async () => false);
    const off = await briefingSummary(d, new AiCallCap(5));
    expect(off.ai).toBe(false);
    expect(off.text).toBe(briefingFallbackSummary(d));
    expect(h.runAi).not.toHaveBeenCalled();
  });
});

// ─── IA: interruptor, teto, orçamento, dados pessoais ───────────────────────

describe("tryAi", () => {
  it("interruptor desligado → nenhuma chamada", async () => {
    h.available.mockImplementation(async () => false);
    const r = await tryAi({ feature: "anomaly_explain", system: "s", input: "x" });
    expect(r).toEqual({ ok: false, skipped: "disabled" });
    expect(h.runAi).not.toHaveBeenCalled();
  });
  it("teto de chamadas por corrida", async () => {
    h.runAi.mockResolvedValue({ output: "ok" });
    const cap = new AiCallCap(1);
    expect((await tryAi({ feature: "weekly_report", system: "s", input: "a", cap })).ok).toBe(true);
    expect(await tryAi({ feature: "weekly_report", system: "s", input: "b", cap })).toEqual({ ok: false, skipped: "cap" });
    expect(h.runAi).toHaveBeenCalledTimes(1);
  });
  it("orçamento excedido → salta sem lançar", async () => {
    h.runAi.mockRejectedValue(new AiBudgetExceededError());
    expect(await tryAi({ feature: "weekly_report", system: "s", input: "a" })).toEqual({ ok: false, skipped: "budget" });
  });
  it("tapa telefones/emails antes de enviar e repõe na resposta (privada)", async () => {
    h.runAi.mockImplementation(async (o: any) => ({ output: `Ligar para ${o.input.match(/\[TELEFONE_1\]/)![0]}` }));
    const r = await tryAi({ feature: "tasks_from_text", system: "s", input: "Ligar ao cliente 912 345 678 amanhã" });
    expect(h.runAi.mock.calls[0][0].input).not.toContain("912 345 678");
    expect(r).toEqual({ ok: true, output: "Ligar para 912 345 678" });
    expect(h.runAi.mock.calls[0][0]).toMatchObject({ feature: "tasks_from_text" });
  });
});

// ─── Disponibilidade ────────────────────────────────────────────────────────

describe("respostas de disponibilidade pouco claras", () => {
  const day = { kind: "day", targetDate: "2026-09-26", weekStart: null, shift: "morning" };
  const week = { kind: "week", targetDate: null, weekStart: "2026-09-28", shift: null };
  const ai = (o: Partial<any>) => ({ intent: "available", days: [], fromHour: null, toHour: null, confidence: 0.9, ...o });

  it("limiares: confiança alta aplica; baixa/pergunta → revisão humana", () => {
    expect(AUTO_APPLY_CONFIDENCE).toBe(0.85);
    expect(decideAiAvailability(ai({ confidence: 0.85, fromHour: 8, toHour: 14 }), day)).toEqual({ action: "apply_yes", days: ["2026-09-26"], fromHour: 8, toHour: 14, confidence: 0.85 });
    expect(decideAiAvailability(ai({ confidence: 0.84 }), day).action).toBe("review");
    expect(decideAiAvailability(ai({ intent: "unavailable", confidence: 0.95 }), day)).toEqual({ action: "apply_no", confidence: 0.95 });
    expect(decideAiAvailability(ai({ intent: "unavailable", confidence: 0.6 }), day).action).toBe("review");
    expect(decideAiAvailability(ai({ intent: "question", confidence: 0.99 }), day).action).toBe("review");
    expect(decideAiAvailability(null, day).action).toBe("review");
  });

  it("semana: só com dias do pedido; horas coerentes", () => {
    expect(requestDays(week)).toHaveLength(7);
    expect(decideAiAvailability(ai({ days: ["2026-09-29", "2026-10-01"] }), week)).toMatchObject({ action: "apply_yes", days: ["2026-09-29", "2026-10-01"] });
    expect(decideAiAvailability(ai({ days: [] }), week).action).toBe("review");
    expect(decideAiAvailability(ai({ days: ["2026-10-10"] }), week).action).toBe("review");
    expect(decideAiAvailability(ai({ fromHour: 14, toHour: 8 }), day).action).toBe("review");
  });

  it("interruptor desligado → revisão humana sem chamada à IA", async () => {
    h.available.mockImplementation(async () => false);
    const d = await classifyUnclearAvailability("talvez de manhã", day);
    expect(d).toMatchObject({ action: "review", reason: "IA desligada" });
    expect(h.runAi).not.toHaveBeenCalled();
  });

  it("com IA: usa o schema e aplica a leitura", async () => {
    h.runAi.mockResolvedValueOnce({ output: { intent: "available", days: [], fromHour: 9, toHour: 13, confidence: 0.92 } });
    const d = await classifyUnclearAvailability("Dá para ir das 9 às 13", day);
    expect(d).toMatchObject({ action: "apply_yes", fromHour: 9, toHour: 13 });
    expect(h.runAi.mock.calls[0][0]).toMatchObject({ feature: "availability_classify" });
    expect(h.runAi.mock.calls[0][0].schema).toBeTruthy();
  });
});

// ─── Leads ──────────────────────────────────────────────────────────────────

describe("pontuação das leads", () => {
  const now = "2026-09-24 12:00:00";
  it("critérios explícitos e somas", () => {
    const s = computeLeadScore({
      availabilityText: "segunda, terça, quarta, sábado e domingo", city: "porto", experienceText: "mais de 5 anos",
      licenceYears: 4, firstContactedAt: "2026-09-20 10:00:00", lastInboundAt: "2026-09-20 18:00:00", status: "replied",
    }, now);
    expect(s.lines.map((l) => [l.key, l.points])).toEqual([
      ["availability", 25], ["cityKnown", 15], ["experience", 20], ["licenceYears", 14], ["responsiveness", 20],
    ]);
    expect(s.score).toBe(94);
    expect(s.lines.map((l) => l.key)).toEqual([...LEAD_SCORE_FIELDS]);
  });
  it("sem dados → 0 nesse critério; sem resposta há > 3 dias → 0", () => {
    const s = computeLeadScore({ availabilityText: null, city: null, experienceText: null, licenceYears: null, firstContactedAt: "2026-09-10 10:00:00", lastInboundAt: null, status: "contacted" }, now);
    expect(s.score).toBe(0);
    expect(summaryFallback(s)).toMatch(/^0\/100; falta saber disponibilidade, experiência de condução, anos de carta\.$/);
    const fresh = computeLeadScore({ availabilityText: null, city: null, experienceText: null, licenceYears: null, firstContactedAt: null, lastInboundAt: null, status: "new" }, now);
    expect(fresh.lines.find((l) => l.key === "responsiveness")!.points).toBe(10);
  });
  it("leitura dos textos", () => {
    expect(parseYears("2-4 anos")).toBe(2);
    expect(parseYears("menos de 1 ano")).toBe(0);
    expect(availabilityDays("Fins de semana")).toBe(2);
    expect(availabilityDays("full-time")).toBe(7);
    expect(licenceYearsFrom("2015-06-01", 2026)).toBe(11);
    expect(licenceYearsFrom("3 anos", 2026)).toBe(3);
  });
  it("nunca usa atributos protegidos (a função nem os recebe)", () => {
    const input: any = { availabilityText: "sábado", city: "faro", experienceText: "1 ano", licenceYears: 2, firstContactedAt: null, lastInboundAt: null, status: "new" };
    const a = computeLeadScore(input, now);
    const b = computeLeadScore({ ...input, age: 60, gender: "F", nationality: "BR", country: "Brasil", nif: "123456789" }, now);
    expect(b).toEqual(a);
  });
});

// ─── Passagem de turno ─────────────────────────────────────────────────────

describe("pendentes repetidos (passagem de turno)", () => {
  const item = (text: string, resolved = false, key?: string) => ({ key: key ?? `note:${text}`, kind: "note" as const, text, resolved });
  it("semelhança de texto", () => {
    expect(textSimilarity("Repor rolos do MB no terminal", "repor os rolos MB terminal")).toBeGreaterThan(0.72);
    expect(textSimilarity("Repor rolos do MB", "Carro com vidro aberto")).toBeLessThan(0.4);
  });
  it("conta passagens SEGUIDAS com o mesmo pendente (chave ou texto parecido)", () => {
    const snaps = [
      { date: "2026-09-24", shift: "morning", items: [item("Repor rolos do MB no terminal"), item("PDA 3 sem bateria"), item("Chamar reboque", true)] },
      { date: "2026-09-23", shift: "night", items: [item("repor os rolos MB terminal", false, "note:x"), item("PDA 3 sem bateria")] },
      { date: "2026-09-23", shift: "morning", items: [item("Repor rolos MB no terminal!")] },
      { date: "2026-09-22", shift: "night", items: [item("Outra coisa")] },
      { date: "2026-09-22", shift: "morning", items: [item("Repor rolos do MB no terminal")] },
    ];
    const r = detectRepeatedItems(snaps);
    expect(r).toEqual([
      { text: "Repor rolos do MB no terminal", count: 3, since: "2026-09-23 morning", kind: "note" },
      { text: "PDA 3 sem bateria", count: 2, since: "2026-09-23 night", kind: "note" },
    ]);
    expect(detectRepeatedItems(snaps, { minCount: 3 })).toHaveLength(1);
    expect(detectRepeatedItems([])).toEqual([]);
  });
  it("resumo semanal: cumprimento e pendentes", () => {
    const w = aggregateHandoverWeek({
      city: "porto", from: "2026-09-14", to: "2026-09-20",
      shiftsWithScale: [{ date: "2026-09-14", shift: "morning" }, { date: "2026-09-14", shift: "night" }, { date: "2026-09-15", shift: "morning" }],
      handovers: [
        { date: "2026-09-14", shift: "morning", acked: true, items: [item("a", true)] },
        { date: "2026-09-15", shift: "morning", acked: false, items: [item("b"), item("c")] },
      ],
      repeated: [],
    });
    expect(w).toMatchObject({ expectedShifts: 3, filled: 2, acknowledged: 1, pendingOpen: 2, resolvedItems: 1 });
  });
});

// ─── Avaliação ──────────────────────────────────────────────────────────────

describe("explicação da avaliação", () => {
  const lines: any[] = [
    { key: "movement", label: "Movimento", points: 1, count: 30, subtotal: 30 },
    { key: "delay", label: "Atraso", points: -5, count: 2, subtotal: -10 },
    { key: "complaint", label: "Reclamação", points: -10, count: 0, subtotal: 0 },
  ];
  it("só as linhas com pontos vão para a IA, com o total do motor", () => {
    const f = explanationFacts(lines, 20);
    expect(f).toMatch(/^Total do período: \+20 pontos\./);
    expect(f).toMatch(/Atraso: 2 × −5 = −10/);
    expect(f).not.toMatch(/Reclamação/);
  });
  it("texto fixo (sem IA)", () => {
    expect(explanationFallback(lines, 20)).toBe('Tens +20 pontos neste período. O que mais somou foi "Movimento" (+30). O que mais tirou foi "Atraso" (−10).');
    expect(explanationFallback([], 0)).toBe("Ainda não há pontos neste período.");
  });
});

// ─── Destinatários ──────────────────────────────────────────────────────────

describe("destinatários dos emails", () => {
  it("cidade: só TL/supervisor com acesso ao módulo e a essa cidade", () => {
    const c = { role: "team_leader", email: "tl@multipark.pt", accessOverrides: {} };
    expect(eligibleForCity(c, ["Lisboa"], "lisbon", "passagem_turno")).toBe(true);
    expect(eligibleForCity(c, ["Porto"], "lisbon", "passagem_turno")).toBe(false);
    expect(eligibleForCity({ ...c, role: "condutor" }, ["Lisboa"], "lisbon", "passagem_turno")).toBe(false);
    expect(eligibleForCity({ ...c, email: null }, ["Lisboa"], "lisbon", "passagem_turno")).toBe(false);
    expect(eligibleForCity({ ...c, accessOverrides: { passagem_turno: { access: "none", actions: [] } } }, ["Lisboa"], "lisbon", "passagem_turno")).toBe(false);
  });
  it("nacional: só quem tem o módulo com alcance nacional", () => {
    expect(eligibleNational({ role: "super_admin", email: "a@b.pt", accessOverrides: {} }, "marketing")).toBe(true);
    expect(eligibleNational({ role: "admin", email: "a@b.pt", accessOverrides: {} }, "marketing")).toBe(false);
    expect(eligibleNational({ role: "supervisor", email: "a@b.pt", accessOverrides: {} }, "reservas_operacoes")).toBe(false);
  });
  it("cidades", () => {
    expect(opsCityOf("Lisboa")).toBe("lisbon");
    expect(opsCityOf("porto")).toBe("porto");
    expect(opsCityOf("Portimão")).toBeNull();
  });
});

// ─── Cron ───────────────────────────────────────────────────────────────────

describe("cron ops-briefing", () => {
  it("ok honesto: falha de um passo → ok:false; prazo → done:false", () => {
    expect(opsCronOutcome({ stepErrors: [], outOfTime: false })).toEqual({ ok: true, done: true });
    expect(opsCronOutcome({ stepErrors: ["briefing:lisbon: BD"], outOfTime: false })).toEqual({ ok: false, done: true });
    expect(opsCronOutcome({ stepErrors: [], outOfTime: true })).toEqual({ ok: true, done: false });
  });
  it("hora de Lisboa (verão/inverno)", () => {
    expect(lisbonClockOf(new Date("2026-09-24T06:32:00Z"))).toEqual({ date: "2026-09-24", dow: 4, hour: 7 });
    expect(lisbonClockOf(new Date("2026-12-07T06:32:00Z"))).toEqual({ date: "2026-12-07", dow: 1, hour: 6 });
  });
  it("antes das 07h de Lisboa não faz nada (ok, saltado)", async () => {
    const r = await runOpsBriefingCron({ now: new Date("2026-12-07T06:32:00Z"), deadlineAt: Date.now() + 10_000 });
    expect(r).toMatchObject({ ok: true, done: true });
    expect(r.skipped).toMatch(/fora de horas/);
    expect(r.ran).toEqual([]);
  });
  it("prazo esgotado → done:false e sem erros", async () => {
    const r = await runOpsBriefingCron({ now: new Date("2026-09-24T06:40:00Z"), deadlineAt: Date.now() - 1 });
    expect(r).toMatchObject({ ok: true, done: false });
    expect(h.runAi).not.toHaveBeenCalled();
  });
  it("BD indisponível num passo → ok:false (fica vermelho no workflow); IA nunca chamada", async () => {
    const prev = process.env.OPS_ANOMALIES;
    process.env.OPS_ANOMALIES = "off";
    try {
      h.trees = [{ city: "lisbon", rootId: 1, ids: [1] }];
      h.db = null;
      const r = await runOpsBriefingCron({ now: new Date("2026-09-24T06:40:00Z"), deadlineAt: Date.now() + 10_000 });
      expect(r.ok).toBe(false);
      expect(r.done).toBe(true);
      expect(r.stepErrors.join(" ")).toMatch(/briefing:lisbon: BD indisponível/);
      expect(r.warnings.join(" ")).toMatch(/anomalias desligadas/);
      expect(h.runAi).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.OPS_ANOMALIES; else process.env.OPS_ANOMALIES = prev;
    }
  });
});

// ─── Catálogo e migração ────────────────────────────────────────────────────

describe("catálogo e migração 0125", () => {
  it("cada automação tem funcionalidade própria, lite, com interruptor no catálogo", async () => {
    const { AI_FEATURES } = await import("../../shared/aiFeatures");
    const { AUTOMATION_FLAGS, CRON_JOBS } = await import("../../shared/appSettings");
    const ids = ["ops_briefing", "weekly_report", "anomaly_explain", "availability_classify", "lead_summary", "lead_first_contact", "evaluation_explain", "handover_repeats", "tasks_from_text"] as const;
    const flags = new Set(AUTOMATION_FLAGS.map((f) => f.name));
    for (const id of ids) {
      expect(AI_FEATURES[id].tier).toBe("lite");
      expect(AI_FEATURES[id].essential).toBe(false);
      expect(flags.has(AI_FEATURES[id].flag!)).toBe(true);
    }
    for (const f of ["OPS_BRIEFING", "WEEKLY_REPORTS", "OPS_ANOMALIES"]) expect(flags.has(f)).toBe(true);
    expect(CRON_JOBS.find((j) => j.name === "ops-briefing")?.intervalMinutes).toBe(1440);
  });
  it("só CREATE TABLE IF NOT EXISTS (idempotente)", async () => {
    const { MIGRATION_0125_STATEMENTS, IDEMPOTENT_ERROR_CODES_0125 } = await import("../migrations/migration_0125");
    expect(MIGRATION_0125_STATEMENTS).toHaveLength(5);
    for (const st of MIGRATION_0125_STATEMENTS) expect(st).toMatch(/^CREATE TABLE IF NOT EXISTS `/);
    for (const st of MIGRATION_0125_STATEMENTS) expect(st).not.toMatch(/^\s*(UPDATE|DROP|DELETE|ALTER)\b|\bDROP\s|\bDELETE\s/i);
    expect(IDEMPOTENT_ERROR_CODES_0125.has("ER_TABLE_EXISTS_ERROR")).toBe(true);
  });
});
