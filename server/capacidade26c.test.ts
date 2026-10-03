/**
 * P3 lote 26c — fase 2 da capacidade aprendida (Extras Dia):
 *  - interruptor por cidade "Escala com os tempos medidos" (desligado por omissão);
 *  - ligado: tempo por carro MEDIDO nas horas cheias (percentil da cidade, ≥ 30
 *    serviços), nunca acima do máximo da tabela (D12); sem medição → tabela;
 *  - a previsão, a escala automática e a estimativa leem a mesma regra.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CREW_RULES, DEFAULT_USE_MEASURED_TIMES, SETTINGS, useMeasuredTimesSchema } from "../shared/appSettings";
import { CREW_MEASURE_MIN_SAMPLES, PRESSURE_CITY_GROUP, describeMeasuredCrewRule, effectiveCrewRule, type PressureCrewRow } from "../shared/extrasPressure";
import { extrasNeededFor } from "../shared/extrasSchedule";

const settings: Record<string, unknown> = {};
const crewRows: PressureCrewRow[] = [];
vi.mock("./appSettings", () => ({ getSetting: vi.fn(async (k: string) => settings[k]) }));
vi.mock("./extrasPressure", () => ({ loadLatestCrewRows: vi.fn(async () => crewRows) }));

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const row = (over: Partial<PressureCrewRow>): PressureCrewRow => ({
  group: "cidade_lisboa", band: 1, bandLabel: "2", busy: true, n: 40, p50: 40, p60: 45, p75: 50, p85: 60, p90: 70, ...over,
});

describe("26c — regra efetiva com os tempos medidos (PURA)", () => {
  const lisbon = DEFAULT_CREW_RULES.lisbon; // 2 → 75 · 3–4 → 60 · 5–6 → 45 · 7+ → 30

  it("usa o medido das horas cheias quando há amostra, nunca acima da tabela", () => {
    const crew = [
      row({ bandLabel: "2", p75: 52.4 }),                 // medido 52 < 75 → 52
      row({ band: 2, bandLabel: "3–4", p75: 80 }),        // medido 80 > 60 → 60 (máximo)
      row({ band: 3, bandLabel: "5–6", p75: 44, n: 10 }), // poucos serviços → tabela
      row({ band: 4, bandLabel: "7+", p75: 20, busy: false, n: 200 }), // hora calma → ignorada
    ];
    const eff = effectiveCrewRule(lisbon, crew, 75);
    expect(eff.rule.bands.map((b) => b.minutes)).toEqual([52, 60, 45, 30]);
    expect(eff.rule.bands.map((b) => b.upTo)).toEqual([2, 4, 6, null]);
    expect(eff.rule.minCrew).toBe(2);
    expect(eff.usedAny).toBe(true);
    expect(eff.bands.map((b) => [b.label, b.measured, b.used, b.source])).toEqual([
      ["2", 52, 52, "medido"], ["3–4", 80, 60, "medido"], ["5–6", null, 45, "tabela"], ["7+", null, 30, "tabela"],
    ]);
    // A tabela original não muda.
    expect(lisbon.bands.map((b) => b.minutes)).toEqual([75, 60, 45, 30]);
  });

  it("casa a faixa pelo rótulo, respeita o percentil e nunca desce de 5 min", () => {
    const crew = [row({ band: 9, bandLabel: "3–4", p60: 2, p75: 58 })];
    expect(effectiveCrewRule(lisbon, crew, 75).rule.bands[1].minutes).toBe(58);
    expect(effectiveCrewRule(lisbon, crew, 60).rule.bands[1].minutes).toBe(5);
    expect(effectiveCrewRule(lisbon, [row({ p75: null })], 75).usedAny).toBe(false);
    expect(effectiveCrewRule(lisbon, [], 75).rule.bands).toEqual(lisbon.bands);
  });

  it(`só com pelo menos ${CREW_MEASURE_MIN_SAMPLES} serviços (ou o mínimo pedido)`, () => {
    expect(CREW_MEASURE_MIN_SAMPLES).toBe(30);
    expect(effectiveCrewRule(lisbon, [row({ n: 29 })], 75).usedAny).toBe(false);
    expect(effectiveCrewRule(lisbon, [row({ n: 30 })], 75).usedAny).toBe(true);
    expect(effectiveCrewRule(lisbon, [row({ n: 10 })], 75, 5).usedAny).toBe(true);
  });

  it("menos tempo por carro → menos (ou os mesmos) extras para a mesma procura", () => {
    const fast = effectiveCrewRule(lisbon, [row({ bandLabel: "3–4", band: 2, p75: 30 }), row({ bandLabel: "5–6", band: 3, p75: 30 })], 75).rule;
    for (const cars of [2, 4, 6, 9, 14]) expect(extrasNeededFor(cars, fast)).toBeLessThanOrEqual(extrasNeededFor(cars, lisbon));
  });

  it("texto da capacidade diz o que é medido e o que é tabela", () => {
    const eff = effectiveCrewRule(DEFAULT_CREW_RULES.porto, [row({ group: "cidade_porto", bandLabel: "3+", p60: 24 })], 60);
    const t = describeMeasuredCrewRule(eff.bands, 60, DEFAULT_CREW_RULES.porto.minCrew);
    expect(t).toContain("medido p60");
    expect(t).toContain("nunca acima da tabela");
    expect(t).toContain("3+ → 24 min (máx. 30)");
    expect(t).not.toContain("2 → 45"); // abaixo do mínimo do Porto (3) não aparece
  });
});

describe("26c — interruptor por cidade (desligado por omissão)", () => {
  beforeEach(() => {
    for (const k of Object.keys(settings)) delete settings[k];
    crewRows.length = 0;
  });

  it("definição viva, todas as cidades desligadas, JSON validado", () => {
    expect(DEFAULT_USE_MEASURED_TIMES).toEqual({ lisbon: false, porto: false, faro: false });
    const d = SETTINGS["extras.useMeasuredTimes"];
    expect(d.defaultValue).toEqual(DEFAULT_USE_MEASURED_TIMES);
    expect(d.wiring).toBe("live");
    expect(d.label).toBe("Escala com os tempos medidos (por cidade)");
    expect(useMeasuredTimesSchema.safeParse({ lisbon: true, porto: false, faro: false }).success).toBe(true);
    expect(useMeasuredTimesSchema.safeParse({ lisbon: "sim" }).success).toBe(false);
  });

  it("desligado (ou sem definição) → a tabela, sem ler as medições", async () => {
    const { loadCapacityRule } = await import("./extrasDia");
    const pressure = await import("./extrasPressure");
    crewRows.push(row({ p75: 40 }));
    const off = await loadCapacityRule("lisbon");
    expect(off.measured).toBeNull();
    expect(off.rule).toEqual(DEFAULT_CREW_RULES.lisbon);
    settings["extras.useMeasuredTimes"] = { lisbon: false, porto: true, faro: true };
    expect((await loadCapacityRule("lisbon")).measured).toBeNull();
    expect(pressure.loadLatestCrewRows).not.toHaveBeenCalled();
  });

  it("ligado numa cidade → só as medições dessa cidade, com o percentil dela", async () => {
    const { loadCapacityRule } = await import("./extrasDia");
    settings["extras.useMeasuredTimes"] = { lisbon: false, porto: true, faro: false };
    settings["extras.timesPercentile"] = { lisbon: 75, porto: 85, faro: 60 };
    crewRows.push(
      row({ group: "cidade_lisboa", bandLabel: "3+", p85: 10 }),
      row({ group: PRESSURE_CITY_GROUP.porto, bandLabel: "3+", p60: 12, p85: 22 }),
    );
    const on = await loadCapacityRule("porto");
    expect(on.tableRule).toEqual(DEFAULT_CREW_RULES.porto);
    expect(on.measured?.percentile).toBe(85);
    expect(on.rule.bands.map((b) => b.minutes)).toEqual([45, 22]);
    expect(on.measured?.usedAny).toBe(true);
  });

  it("ligado mas sem medições (BD em baixo / janela vazia) → a tabela", async () => {
    const { loadCapacityRule } = await import("./extrasDia");
    settings["extras.useMeasuredTimes"] = { lisbon: true, porto: false, faro: false };
    const r = await loadCapacityRule("lisbon");
    expect(r.rule).toEqual(DEFAULT_CREW_RULES.lisbon);
    expect(r.measured?.usedAny).toBe(false);
  });
});

describe("26c — ligações no código", () => {
  it("a previsão usa a regra efetiva; a escala e a estimativa leem o texto da previsão", () => {
    const dia = src("server/extrasDia.ts");
    expect(dia).toContain("const capacity = await loadCapacityRule(city);");
    expect(dia).toContain("const crewRule = capacity.rule;");
    expect(dia).toContain("crewRuleTable: capacity.tableRule");
    expect(dia).not.toContain("ops_pressure_stats");
    expect(src("server/extrasSchedule.ts").match(/forecast\.crewRuleText/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("medições: só leitura, última janela completa, só escalões; cache; nunca lança", () => {
    const p = src("server/extrasPressure.ts");
    const fn = p.slice(p.indexOf("export async function loadLatestCrewRows"));
    expect(fn).toContain("kind = 'crew'");
    expect(fn).toContain("PRESSURE_DONE_GROUP");
    expect(fn).toContain("CREW_ROWS_CACHE_MS");
    expect(fn).toContain("catch");
    expect(fn).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });

  it("Pressão: o cartão diz se a escala usa os tempos medidos", () => {
    const tab = src("client/src/pages/extrasDia/PressureTab.tsx");
    expect(tab).toContain("useMeasured={!!cityInfo.useMeasured}");
    expect(tab).toContain("A escala usa o valor das horas cheias");
    expect(tab).toContain("a escala continua a usar a tabela máxima");
    expect(src("server/routers.ts")).toContain('getSetting("extras.useMeasuredTimes").catch(() => null)');
    expect(src("docs/ajuda/extras-dia.md")).toContain("**Escala com os tempos medidos**");
  });
});
