/**
 * Plano MPV (Multis por página), fase F2 — "regras em vigor":
 *  - o gerado (rulesDocs.generated.ts) está em dia, sem marcadores crus, cada
 *    frase com origem (ficheiro:constante que existe); marcador desconhecido = erro;
 *  - a lista branca dos valores vivos: chaves que existem, nada de ai.*,
 *    integrações, chaves, preços nem superAdminOnly;
 *  - por papel (extra, TL, supervisor, admin, super admin): o que cada um vê;
 *  - a ferramenta só é declarada no modo MPV (piloto).
 * Sem IA real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const h = vi.hoisted(() => ({ db: null as any }));
vi.mock("../db", () => ({
  getDb: async () => h.db,
  logActivity: vi.fn(),
  getUserPermissionOverrides: async () => ({}),
}));

import type { CityAccess } from "../cityAccess";
import { setAiProvidersForTests } from "../_core/ai/client";
import { resetContextCacheForTests } from "../_core/ai/contextCache";
import { resetFinalCallModeForTests } from "../_core/ai/run";
import { resetRateLimitMemoryForTests } from "../_core/ai/rateLimit";
import { resetAiUsageCachesForTests } from "../_core/ai/usage";
import { makeToolExecutor } from "../_core/ai/chat/tools";
import { resetMaskedColumnsForTests } from "../_core/ai/chat/store";
import { createFakeDb, createFakeProvider, okResponse } from "../_core/ai/testUtils";
import { invalidateSettingsCache } from "../appSettings";
import { AUTOMATION_FLAGS, SETTINGS, isSettingKey, type SettingKey } from "../../shared/appSettings";
import { HELP_RULE_VALUES, HelpRuleMarkerError, ruleMarkersIn } from "../../shared/helpRuleValues";
import { RULE_MODULES, RULE_MODULE_IDS, renderRuleModules, ruleSources, type RuleModuleDef, type RuleModuleId } from "../../shared/rulesInForce";
import { RULES_LIVE_WHITELIST, liveEntryForbiddenReason, type LiveValueEntry } from "../../shared/rulesLiveWhitelist";
import { MODULE_IDS } from "../../shared/access";
import { MAX_GPS_SPEEDING_PER_DAY, speedingWithGpsDay } from "../../shared/evaluationRules";
import { PARTNER_TYPE_BY_ID } from "../../shared/partnerTypes";
import { partnerFeeForPeriod } from "../../shared/partnerRules";
import { renderRulesDocs } from "../../scripts/gen-regras";
import { RULES_DOCS } from "./rulesDocs.generated";
import {
  RULES_IN_FORCE_TOOL, RULES_TOOL_NAME, cityKeysOf, liveEntriesFor, liveEntryRegistry, onlyCities, readLiveValues, ruleModulesFor, runRulesInForce, withCityScope, type LiveReaders,
} from "./rulesTool";
import { MPV_STAFF_TOOLS, STAFF_TOOLS, staffToolsFor, type StaffToolCtx } from "./tools";
import { askAssistant, staffHelpDocs, type AssistantMode } from "./service";

const ROOT = resolve(__dirname, "../..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const ALL_ENTRIES: LiveValueEntry[] = Object.values(RULES_LIVE_WHITELIST).flat();
const ROLES = ["extra", "team_leader", "supervisor", "admin", "super_admin"] as const;
const user = (role: string) => ({ id: 7, role });

const LISBOA: CityAccess = { all: false, defaultCityId: 10, cityName: "Lisboa", cityNames: ["Lisboa"], cityIds: [10], projectIds: [10], missingCostCenter: false };
const TODAS: CityAccess = { all: true, defaultCityId: null, cityIds: [], projectIds: [], missingCostCenter: false };
const ctxFor = (role: string, access: CityAccess = LISBOA): StaffToolCtx =>
  ({ user: user(role), access, call: async () => ({}), today: "2026-10-15", financeAllowed: false, helpDocs: staffHelpDocs() }) as any;

/** Leitor falso: devolve um valor "gravado" para QUALQUER chave (também as proibidas) — só a lista branca pode passar. */
const fakeReaders = (): LiveReaders & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    async setting(key: SettingKey) {
      asked.push(key);
      if (key === "extras.timesPercentile") return { lisbon: 85, porto: 60, faro: 50 };
      if (key === "extras.autoProposeAt") return "11:00";
      return SETTINGS[key].defaultValue;
    },
    async flag(name: string) { asked.push(name); return true; },
  };
};

// ─── O gerado ───────────────────────────────────────────────────────────────

describe("regras geradas do código (rulesDocs.generated.ts)", () => {
  it("está em dia (pnpm tsx scripts/gen-regras.ts ou gen-ajuda.ts)", () => {
    expect(src("server/assistant/rulesDocs.generated.ts")).toBe(renderRulesDocs());
  });

  it("o gen-ajuda corre também o gerador das regras (um comando para os dois)", () => {
    expect(src("scripts/gen-ajuda.ts")).toMatch(/writeRulesDocs\(\)/);
  });

  it("tem todos os módulos, cada um com frases, e nenhuma frase tem marcadores crus", () => {
    expect(Object.keys(RULES_DOCS).sort()).toEqual([...RULE_MODULE_IDS].sort());
    for (const id of RULE_MODULE_IDS) {
      const doc = RULES_DOCS[id];
      expect(doc.rules.length, id).toBeGreaterThan(2);
      for (const r of doc.rules) {
        expect(r.text, id).not.toMatch(/\{\{|\}\}|regra:/);
        expect(r.sources.length, r.text).toBeGreaterThan(0);
      }
      expect(doc.block).not.toMatch(/\{\{|\}\}/);
      expect(doc.block.split("\n")).toHaveLength(doc.rules.length + 1);
    }
  });

  it("os valores vêm do código (a mesma fonte dos marcadores da ajuda)", () => {
    const av = RULES_DOCS.avaliacao.block;
    expect(av).toContain(`Pontos por cada «Excesso de velocidade»: ${HELP_RULE_VALUES["evaluation.points.speeding"].value}.`);
    expect(RULES_DOCS.extras_dia.block).toContain(`cobertura ${HELP_RULE_VALUES["extras.rankWeights.coverage"].value} %`);
    expect(RULES_DOCS.extras_dia.block).toContain(`p${HELP_RULE_VALUES["extras.timesPercentile.porto"].value} no Porto`);
  });

  it("cada origem é ficheiro:constante que existe nesse ficheiro", () => {
    const all = new Set(Object.values(RULES_DOCS).flatMap((d) => d.rules.flatMap((r) => r.sources)));
    expect(all.size).toBeGreaterThan(20);
    for (const s of all) {
      const m = /^([\w/.-]+\.ts):(.+)$/.exec(s);
      expect(m, s).not.toBeNull();
      expect(existsSync(resolve(ROOT, m![1])), s).toBe(true);
      const name = m![2];
      const setting = /^SETTINGS\[(.+)\]$/.exec(name);
      const flag = /^AUTOMATION_FLAGS\[(.+)\]$/.exec(name);
      if (setting) expect(isSettingKey(setting[1]), s).toBe(true);
      else if (flag) expect(AUTOMATION_FLAGS.some((f) => f.name === flag[1]), s).toBe(true);
      else expect(src(m![1]), s).toMatch(new RegExp(`export (const|function|async function) ${name}\\b`));
    }
  });

  it("os valores que vêm de definições levam «por omissão»", () => {
    let checked = 0;
    for (const mod of RULE_MODULES) {
      for (const t of mod.rules) {
        if (ruleMarkersIn(t.text).some((k) => HELP_RULE_VALUES[k]?.setting)) {
          expect(t.text, t.text).toMatch(/por omiss[aã]o/);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it("velocidade: o GPS do Zello dá no máximo 1 excesso por dia e nunca a dobrar — a frase e o código usam a mesma regra", () => {
    expect(RULES_DOCS.avaliacao.block).toContain(`o GPS do Zello dá no máximo ${MAX_GPS_SPEEDING_PER_DAY} excesso (${HELP_RULE_VALUES["evaluation.points.speeding"].value}) por pessoa e dia`);
    expect(RULES_DOCS.avaliacao.block).toMatch(/alerta ou uma penalização RH de velocidade no mesmo dia de calendário/);
    expect(RULES_DOCS.avaliacao.block).toContain("server/evaluationCore.ts:computeEmployeeDays");
    expect(speedingWithGpsDay(0, false)).toBe(MAX_GPS_SPEEDING_PER_DAY);
    expect(speedingWithGpsDay(0, true)).toBe(0);
    expect(speedingWithGpsDay(2, false)).toBe(2);
    expect(src("server/evaluationCore.ts")).toMatch(/speedingWithGpsDay\(m\.speedingEvents/);
  });

  it("parcerias: a avença anual é €/mês faturada por períodos (nunca «uma vez por ano»), na origem e nas regras", () => {
    for (const r of RULES_DOCS.parcerias.rules) expect(r.text, r.text).not.toMatch(/uma vez por ano|fatura anual/i);
    expect(PARTNER_TYPE_BY_ID.avenca_anual.description).toMatch(/€\/mês/);
    expect(PARTNER_TYPE_BY_ID.avenca_anual.description).not.toMatch(/uma vez por ano/);
    expect(src("shared/partnerTypes.ts")).not.toMatch(/÷ 12/);
    // a mesma conta do partnerFeeForPeriod: 100 €/mês × 3 meses = 300 (anual ou mensal)
    expect(partnerFeeForPeriod("avenca_anual", 100, "2026-01-01", "2026-03-31")).toBe(300);
    expect(partnerFeeForPeriod("avenca_mensal", 100, "2026-01-01", "2026-03-31")).toBe(300);
  });

  it("tempos, hora apertada e críticas: as condições e as omissões estão escritas", () => {
    expect(RULES_DOCS.tempos.block).toMatch(/contar desde a chamada» ligado por omissão/);
    expect(RULES_DOCS.tempos.block).toMatch(/mais cedo entre a chamada do cliente e o «em recolha»/);
    expect(RULES_DOCS.extras_dia.block).toMatch(/Hora apertada pela Fila» ligado na cidade \(desligado em todas as cidades por omissão\), o p75 da Fila/);
    const cr = RULES_DOCS.criticas.block;
    expect(cr).toMatch(/IA: rascunho automático para cada crítica nova», ligado por omissão/);
    expect(cr).toMatch(/sem nenhuma, a data em que foi registada cá/);
    expect(cr).toMatch(/«não é crítica» ou como repetidas nunca levam rascunho automático/);
  });

  const fake = (rules: RuleModuleDef["rules"]): RuleModuleDef[] => [{ id: "avaliacao", label: "Teste", access: ["avaliacao"], rules }];

  it("um marcador desconhecido (ou mal escrito) dá erro", () => {
    expect(() => renderRuleModules(fake([{ text: "vale {{regra:nao.existe}}" }]))).toThrow(HelpRuleMarkerError);
    expect(() => renderRuleModules(fake([{ text: "vale {{regra:nao.existe}}" }]))).toThrow(/desconhecido/);
    expect(() => renderRuleModules(fake([{ text: "vale {{ regra extras }}" }]))).toThrow(/mal escrito/);
  });

  it("uma definição sem «por omissão» por perto dá erro; uma frase sem origem também", () => {
    expect(() => renderRuleModules(fake([{ text: "A meta é {{regra:serviceTimes.targetMinutes}} min." }]))).toThrow(/por omissão/);
    expect(() => renderRuleModules(fake([{ text: "Regra sem número nem origem." }]))).toThrow(/sem origem/);
    expect(renderRuleModules(fake([{ text: "Sem número.", source: "shared/evaluationRules.ts:scoreOf" }])).avaliacao.rules[0].sources).toEqual(["shared/evaluationRules.ts:scoreOf"]);
  });

  it("as origens juntam a própria e as dos marcadores, sem repetir", () => {
    expect(ruleSources({ text: "{{regra:evaluation.points.movement}} e {{regra:evaluation.points.spotChange}}", source: "x.ts:Y" }))
      .toEqual(["x.ts:Y", "shared/evaluationRules.ts:EVALUATION_POINTS"]);
  });

  it("os módulos de acesso das regras existem", () => {
    for (const mod of RULE_MODULES) for (const m of mod.access) expect(MODULE_IDS, `${mod.id}:${m}`).toContain(m);
  });
});

// ─── A lista branca ─────────────────────────────────────────────────────────

describe("lista branca dos valores vivos (shared/rulesLiveWhitelist.ts)", () => {
  it("todas as chaves existem no registo de definições / interruptores", () => {
    for (const e of ALL_ENTRIES) {
      if (e.kind === "setting") expect(isSettingKey(e.key), e.key).toBe(true);
      else expect(AUTOMATION_FLAGS.some((f) => f.name === e.key), e.key).toBe(true);
    }
  });

  it("nenhuma é ai.*, de IA, integração, chave, preço, financeiro ou superAdminOnly", () => {
    for (const e of ALL_ENTRIES) {
      expect(liveEntryForbiddenReason(e, liveEntryRegistry(e)), e.key).toBeNull();
      expect(e.key.startsWith("ai."), e.key).toBe(false);
      expect(e.key, e.key).not.toMatch(/^(AI_|MPV$|serviceTimes\.|finance\.|mail\.|google\.|marketing\.|notifications\.)/);
      expect(e.key, e.key).not.toMatch(/key|secret|token|password|price|eur/i);
    }
  });

  it("o filtro apanha o que nunca pode sair (mesmo que alguém o meta na lista)", () => {
    const bad: LiveValueEntry[] = [
      { kind: "setting", key: "ai.monthlyBudgetEur", visibleTo: "admin" },
      { kind: "setting", key: "ai.priceOverridesEur", visibleTo: "admin" },
      { kind: "setting", key: "ai.assistantPilot", visibleTo: "admin" },
      { kind: "setting", key: "serviceTimes.targetMinutes", visibleTo: "admin" },
      { kind: "setting", key: "mail.systemSender", visibleTo: "admin" },
      { kind: "setting", key: "google.drive", visibleTo: "admin" },
      { kind: "setting", key: "finance.vat", visibleTo: "admin" },
      { kind: "setting", key: "notifications.routing", visibleTo: "admin" },
      { kind: "setting", key: "knowledge.config", visibleTo: "admin" },
      { kind: "setting", key: "nao.existe", visibleTo: "admin" },
      { kind: "flag", key: "MPV", visibleTo: "admin" },
      { kind: "flag", key: "AI_ASSISTANT", visibleTo: "admin" },
      { kind: "flag", key: "CASH_STRIPE_CHECK", visibleTo: "admin" },
      { kind: "flag", key: "GBP_WINDSOR_REPLY", visibleTo: "admin" },
      { kind: "flag", key: "SERVICE_TIMES", visibleTo: "admin" },
      { kind: "flag", key: "CRM_AUTO_MERGE", visibleTo: "admin" },
    ];
    for (const e of bad) expect(liveEntryForbiddenReason(e, liveEntryRegistry(e)), e.key).not.toBeNull();
  });

  it("uma entrada aberta a um módulo diz onde já se vê hoje (seenIn) e o módulo existe", () => {
    for (const e of ALL_ENTRIES) {
      if (e.visibleTo === "admin") continue;
      expect(MODULE_IDS, e.key).toContain(e.visibleTo.module);
      expect(e.visibleTo.seenIn.trim().length, e.key).toBeGreaterThan(5);
    }
  });

  it("o comentário da lista explica que é lista branca", () => {
    expect(src("shared/rulesLiveWhitelist.ts")).toMatch(/LISTA BRANCA/);
  });
});

// ─── Por papel ──────────────────────────────────────────────────────────────

describe("o que cada papel vê", () => {
  const sees = (role: string) => Object.fromEntries(RULE_MODULE_IDS.map((m) => [m, liveEntriesFor(user(role), m).map((e) => e.key)]));
  const MODULE_VISIBLE = (m: RuleModuleId) => RULES_LIVE_WHITELIST[m].filter((e) => e.visibleTo !== "admin").map((e) => e.key);

  it("extra: só as regras da Avaliação (as suas), sem valores vivos", () => {
    expect(ruleModulesFor(user("extra"))).toEqual(["avaliacao"]);
    for (const m of RULE_MODULE_IDS) expect(liveEntriesFor(user("extra"), m), m).toEqual([]);
  });

  it("team leader e supervisor: as regras dos seus módulos e só os valores que já veem nesses ecrãs", () => {
    for (const role of ["team_leader", "supervisor"]) {
      expect(ruleModulesFor(user(role)).sort(), role).toEqual(["avaliacao", "casos", "criticas", "despesas", "extras_dia", "parcerias", "tempos"]);
      const s = sees(role);
      expect(s.extras_dia, role).toEqual(MODULE_VISIBLE("extras_dia"));
      expect(s.extras_dia, role).toEqual(expect.arrayContaining(["extras.autoProposeAt", "extras.autoConfirmAt", "extras.timesPercentile"]));
      expect(s.extras_dia, role).not.toContain("extras.pairPickups");
      expect(s.extras_dia, role).not.toContain("EXTRAS_AUTOMATION");
      expect(s.casos, role).toEqual(["sla.lostFoundDays"]);
      expect(s.avaliacao, role).toEqual([]);
      expect(s.parcerias, role).toEqual([]);
    }
  });

  it("admin e super admin: toda a lista branca (e nada mais)", () => {
    for (const role of ["admin", "super_admin"]) {
      expect(ruleModulesFor(user(role)).sort(), role).toEqual([...RULE_MODULE_IDS].sort());
      expect(Object.values(sees(role)).flat().sort(), role).toEqual(ALL_ENTRIES.map((e) => e.key).sort());
    }
  });

  it("nenhum papel vê ai.*, chaves, preços; quem não é admin nunca vê o que é só de admin", () => {
    for (const role of ROLES) {
      for (const m of RULE_MODULE_IDS) {
        for (const e of liveEntriesFor(user(role), m)) {
          expect(e.key.startsWith("ai."), `${role}:${e.key}`).toBe(false);
          expect(e.key, `${role}:${e.key}`).not.toMatch(/key|secret|token|password|price|eur/i);
          if (role !== "admin" && role !== "super_admin") expect(e.visibleTo, `${role}:${e.key}`).not.toBe("admin");
        }
      }
    }
  });

  it("a ferramenta, por papel, só lê o que a lista branca deixa (nunca pergunta pelos outros valores)", async () => {
    for (const role of ROLES) {
      for (const m of ruleModulesFor(user(role))) {
        const r = fakeReaders();
        const out = await runRulesInForce({ modulo: m }, ctxFor(role, role === "admin" || role === "super_admin" ? TODAS : LISBOA), r);
        const allowed = liveEntriesFor(user(role), m).map((e) => e.key);
        expect(r.asked.sort(), `${role}:${m}`).toEqual([...allowed].sort());
        expect((out.valoresEmVigor as any[]).map((v) => v.chave).sort(), `${role}:${m}`).toEqual([...allowed].sort());
        expect(String(out.regras)).toBe(RULES_DOCS[m].block);
      }
    }
  });

  it("extra a pedir as regras do Extras Dia ou das Despesas → sem acesso (erro para o modelo explicar)", async () => {
    const exec = makeToolExecutor([RULES_IN_FORCE_TOOL], ctxFor("extra"));
    expect(await exec({ name: RULES_TOOL_NAME, args: { modulo: "extras_dia" } } as any)).toEqual({ error: "Sem acesso às regras de «Extras Dia (pressão e escala)»." });
    expect(await exec({ name: RULES_TOOL_NAME, args: { modulo: "despesas" } } as any)).toMatchObject({ error: expect.stringMatching(/Sem acesso/) });
    const ok = await exec({ name: RULES_TOOL_NAME, args: { modulo: "avaliacao" } } as any);
    expect(ok).toMatchObject({ modulo: "avaliacao", valoresEmVigor: [] });
  });

  it("módulo desconhecido → lista dos módulos que a pessoa pode ver", async () => {
    expect(await runRulesInForce({ modulo: "salarios" }, ctxFor("team_leader"), fakeReaders())).toMatchObject({ error: expect.any(String), modulos: expect.arrayContaining(["extras_dia"]) });
  });

  it("valores por cidade só com as cidades da pessoa; gravado vs omissão; leitura falhada → indisponível", async () => {
    const out = await runRulesInForce({ modulo: "extras_dia" }, ctxFor("team_leader", LISBOA), fakeReaders());
    const v = Object.fromEntries((out.valoresEmVigor as any[]).map((x) => [x.chave, x]));
    expect(v["extras.timesPercentile"]).toMatchObject({ valor: { lisbon: 85 }, estado: "gravado", tipo: "definição" });
    expect(v["extras.autoProposeAt"]).toMatchObject({ valor: "11:00", estado: "gravado" });
    const omissao = await readLiveValues([{ kind: "setting", key: "extras.autoConfirmAt", visibleTo: "admin" }], TODAS, { setting: async () => null, flag: async () => false });
    expect(omissao[0]).toMatchObject({ valor: SETTINGS["extras.autoConfirmAt"].defaultValue, estado: "omissão" });
    const falha = await readLiveValues([{ kind: "flag", key: "CASE_REMINDERS", visibleTo: "admin" }], TODAS, { setting: async () => { throw new Error("x"); }, flag: async () => { throw new Error("x"); } });
    expect(falha[0]).toMatchObject({ valor: null, estado: "indisponível" });
    const semBd = await readLiveValues([{ kind: "setting", key: "extras.autoConfirmAt", visibleTo: "admin" }], TODAS, { setting: async () => null, settingsReadable: async () => false, flag: async () => false });
    expect(semBd[0]).toMatchObject({ valor: SETTINGS["extras.autoConfirmAt"].defaultValue, estado: "omissão (sem BD)" });
    expect(cityKeysOf(TODAS)).toBeNull();
    expect(cityKeysOf(undefined)).toEqual(new Set());
    expect(onlyCities({ lisbon: 1, porto: 2 }, new Set(["porto"]))).toEqual({ porto: 2 });
  });

  it("Extras Dia sem nenhuma cidade em âmbito (como o assertCityInScope do ecrã) → sem os valores do schedule nem os por cidade", async () => {
    const SEM: CityAccess = { all: false, defaultCityId: null, cityNames: [], cityIds: [], projectIds: [], missingCostCenter: true };
    const out = await runRulesInForce({ modulo: "extras_dia" }, ctxFor("team_leader", SEM), fakeReaders());
    expect(out.valoresEmVigor).toEqual([]);
    const lisboa = await runRulesInForce({ modulo: "extras_dia" }, ctxFor("team_leader", LISBOA), fakeReaders());
    expect((lisboa.valoresEmVigor as any[]).map((v) => v.chave)).toContain("extras.autoProposeAt");
    expect(withCityScope(RULES_LIVE_WHITELIST.casos, SEM).map((e) => e.key)).toEqual(RULES_LIVE_WHITELIST.casos.map((e) => e.key));
  });

  it("sem módulos de regras (utilizador) → a ferramenta nem está disponível", () => {
    expect(RULES_IN_FORCE_TOOL.available(ctxFor("user"))).toBe(false);
    expect(RULES_IN_FORCE_TOOL.available(ctxFor("extra"))).toBe(true);
  });
});

// ─── Só no modo MPV ─────────────────────────────────────────────────────────

describe("regras_em_vigor só no modo MPV (piloto)", () => {
  const KEYS = ["GEMINI_API_KEY", "LLM_API_KEY", "OPENAI_API_KEY", "AI_ENABLED", "AI_ASSISTANT", "AI_ASSISTANT_SMART", "MPV", "AI_MODEL_SMART", "AI_MONTHLY_BUDGET_EUR", "AI_PROVIDER", "AI_ASSISTANT_MEMORY"];
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    process.env.GEMINI_API_KEY = "test-key";
    h.db = createFakeDb(() => [[]]);
    setAiProvidersForTests(null);
    resetAiUsageCachesForTests();
    resetRateLimitMemoryForTests();
    resetContextCacheForTests();
    resetFinalCallModeForTests();
    resetMaskedColumnsForTests(null);
    invalidateSettingsCache();
  });
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    setAiProvidersForTests(null);
  });

  it("o conjunto de ferramentas: v1 sem, MPV com (o resto igual)", () => {
    expect(staffToolsFor({ pilot: false })).toBe(STAFF_TOOLS);
    expect(STAFF_TOOLS.map((t) => t.name)).not.toContain(RULES_TOOL_NAME);
    // F3: no MPV, ajuda_abrir/ajuda_procurar no lugar do abrir_ajuda (o resto igual).
    expect(staffToolsFor({ pilot: true }).map((t) => t.name)).toEqual(["ajuda_abrir", "ajuda_procurar", ...STAFF_TOOLS.map((t) => t.name).filter((n) => n !== "abrir_ajuda"), RULES_TOOL_NAME]);
    expect(MPV_STAFF_TOOLS).toContain(RULES_IN_FORCE_TOOL);
  });

  const declared = async (mode: AssistantMode) => {
    const p = createFakeProvider("gemini", [okResponse("Olá.")]);
    setAiProvidersForTests({ gemini: p });
    const r = await askAssistant({ question: "Qual é a regra?" }, ctxFor("supervisor"), { knowledge: null, memoryEnabled: false, mode });
    expect(r.ok).toBe(true);
    return (p.calls[0].tools ?? []).map((t) => t.name);
  };

  it("fora do piloto o Multis não declara regras_em_vigor; no piloto (também em modo económico) declara", async () => {
    const v1 = await declared({ feature: "assistant", pilot: false, economy: false, economyReason: null });
    expect(v1).toContain("abrir_ajuda");
    expect(v1).not.toContain(RULES_TOOL_NAME);
    const mpv = await declared({ feature: "assistant", pilot: true, economy: true, economyReason: "day" });
    expect(mpv).toContain(RULES_TOOL_NAME);
  });
});
