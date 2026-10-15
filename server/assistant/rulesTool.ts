/**
 * Ferramenta `regras_em_vigor(modulo)` do Multis do piloto (plano MPV, §3.3,
 * F2). Só leitura; não chama IA.
 *
 *  - devolve o bloco do módulo gerado do código (rulesDocs.generated.ts, de
 *    shared/rulesInForce.ts — os mesmos valores dos marcadores da ajuda);
 *  - e os valores VIVOS (o que está gravado hoje nas Definições/interruptores)
 *    SÓ da lista branca de shared/rulesLiveWhitelist.ts, cada um só a quem já
 *    o vê hoje (admin, ou `view` no módulo onde um ecrã já o mostra), com o
 *    filtro de segurança outra vez em execução (nada de ai.*, integrações,
 *    chaves, preços, superAdminOnly);
 *  - só a quem tem `view` num dos módulos de acesso das regras pedidas.
 *
 * Declarada só no modo MPV (piloto): ver `staffToolsFor` em ./tools.ts.
 */
import { can, roleRank, ROLE_RANK } from "../../shared/access";
import { AUTOMATION_FLAGS, SETTINGS, automationFlagDefault, automationFlagSuperAdminOnly, isSettingKey, settingSuperAdminOnly, type SettingKey } from "../../shared/appSettings";
import { RULE_MODULES, RULE_MODULE_BY_ID, RULE_MODULE_IDS, isRuleModuleId, type RuleModuleId } from "../../shared/rulesInForce";
import { RULES_LIVE_WHITELIST, liveEntryForbiddenReason, type LiveValueEntry } from "../../shared/rulesLiveWhitelist";
import type { CityAccess } from "../cityAccess";
import { ToolUserError, type ChatTool } from "../_core/ai/chat/tools";
import { RULES_DOCS } from "./rulesDocs.generated";
import type { StaffToolCtx, StaffUser } from "./tools";

export const RULES_TOOL_NAME = "regras_em_vigor";

const isAdmin = (u: StaffUser) => roleRank(u.role) >= ROLE_RANK.admin;

/** Os módulos de regras que a pessoa pode ver (view num dos módulos de acesso). PURA. */
export function ruleModulesFor(user: StaffUser): RuleModuleId[] {
  return RULE_MODULES.filter((r) => r.access.some((m) => can(user, m, "view"))).map((r) => r.id);
}

/** O registo de uma entrada (para o filtro de segurança). PURA. */
export function liveEntryRegistry(e: LiveValueEntry) {
  if (e.kind === "setting") {
    const def = isSettingKey(e.key) ? SETTINGS[e.key] : undefined;
    return { exists: !!def, settingGroup: def?.group ?? null, settingSuperAdminOnly: settingSuperAdminOnly(e.key), label: def?.label ?? e.key };
  }
  const f = AUTOMATION_FLAGS.find((x) => x.name === e.key);
  return { exists: !!f, flagGroup: (f as { group?: string } | undefined)?.group ?? null, flagSuperAdminOnly: automationFlagSuperAdminOnly(e.key), label: f?.label ?? e.key };
}

/**
 * As entradas da lista branca deste módulo que ESTA pessoa pode ver: admin
 * (ou acima) vê as que são de admin; os outros só as que têm `visibleTo.module`
 * e `view` nesse módulo. As proibidas nunca (também para o super admin). PURA.
 */
export function liveEntriesFor(user: StaffUser, module: RuleModuleId): LiveValueEntry[] {
  return (RULES_LIVE_WHITELIST[module] ?? []).filter((e) => {
    if (liveEntryForbiddenReason(e, liveEntryRegistry(e)) != null) return false;
    if (isAdmin(user)) return true;
    return e.visibleTo !== "admin" && can(user, e.visibleTo.module, "view");
  });
}

const CITY_KEY: Record<string, "lisbon" | "porto" | "faro"> = { lisboa: "lisbon", lisbon: "lisbon", porto: "porto", oporto: "porto", faro: "faro" };
const norm = (s: string) => s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** As cidades (lisbon/porto/faro) da pessoa; null = todas. PURA. */
export function cityKeysOf(access: CityAccess | undefined): Set<string> | null {
  if (access?.all) return null;
  const names = access?.cityNames ?? (access?.cityName ? [access.cityName] : []);
  return new Set(names.map((n) => CITY_KEY[norm(n)]).filter(Boolean));
}

/** Um valor por cidade só com as cidades da pessoa. PURA. */
export function onlyCities(value: unknown, cities: Set<string> | null): unknown {
  if (cities == null || !value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => cities.has(k)));
}

/** Leitura dos valores vivos (injetável nos testes). */
export interface LiveReaders {
  /** Valor gravado (null = nada gravado → vale a omissão). Lança se não deu para ler. */
  setting(key: SettingKey): Promise<unknown>;
  flag(name: string): Promise<boolean>;
}

export const defaultLiveReaders: LiveReaders = {
  async setting(key) {
    const { getSetting } = await import("../appSettings");
    return getSetting(key);
  },
  async flag(name) {
    const { ensureFeatureFlagOverrides, isFeatureEnabled } = await import("../_core/featureFlags");
    await ensureFeatureFlagOverrides();
    return isFeatureEnabled(name, { defaultEnabled: automationFlagDefault(name) });
  },
};

export interface LiveValueOut {
  chave: string;
  nome: string;
  tipo: "definição" | "interruptor";
  valor: unknown;
  /** "gravado" (Definições) | "omissão" (nada gravado) | "indisponível" (não deu para ler). */
  estado: "gravado" | "omissão" | "indisponível" | "em uso";
}

/** Os valores vivos de uma lista de entradas (nunca lança). */
export async function readLiveValues(entries: readonly LiveValueEntry[], access: CityAccess | undefined, readers: LiveReaders = defaultLiveReaders): Promise<LiveValueOut[]> {
  const cities = cityKeysOf(access);
  return Promise.all(entries.map(async (e): Promise<LiveValueOut> => {
    const nome = liveEntryRegistry(e).label;
    if (e.kind === "flag") {
      try {
        return { chave: e.key, nome, tipo: "interruptor", valor: (await readers.flag(e.key)) ? "ligado" : "desligado", estado: "em uso" };
      } catch {
        return { chave: e.key, nome, tipo: "interruptor", valor: null, estado: "indisponível" };
      }
    }
    const key = e.key as SettingKey;
    try {
      const stored = await readers.setting(key);
      const raw = stored ?? SETTINGS[key].defaultValue;
      return { chave: e.key, nome, tipo: "definição", valor: e.perCity ? onlyCities(raw, cities) : raw, estado: stored == null ? "omissão" : "gravado" };
    } catch {
      return { chave: e.key, nome, tipo: "definição", valor: null, estado: "indisponível" };
    }
  }));
}

/** Executa a ferramenta (exportada para os testes). */
export async function runRulesInForce(args: Record<string, unknown>, ctx: StaffToolCtx, readers: LiveReaders = defaultLiveReaders): Promise<Record<string, unknown>> {
  const mine = ruleModulesFor(ctx.user);
  if (!mine.length) throw new ToolUserError("Sem acesso às regras de nenhum módulo.");
  const wanted = String(args.modulo ?? "").trim().toLowerCase().replace(/-/g, "_");
  if (!isRuleModuleId(wanted)) return { error: "Módulo de regras desconhecido.", modulos: mine };
  if (!mine.includes(wanted)) throw new ToolUserError(`Sem acesso às regras de «${RULE_MODULE_BY_ID[wanted].label}».`);
  const doc = RULES_DOCS[wanted];
  const valores = await readLiveValues(liveEntriesFor(ctx.user, wanted), ctx.access, readers);
  return {
    modulo: wanted,
    titulo: doc.label,
    regras: doc.block,
    valoresEmVigor: valores,
    nota: valores.length
      ? "Os valores em vigor mandam sobre os «por omissão» das regras. Não mostres o nome técnico das chaves à pessoa."
      : "Sem valores em vigor para mostrar a esta pessoa: usa os das regras e diz «por omissão» quando o são.",
  };
}

export const RULES_IN_FORCE_TOOL: ChatTool<StaffToolCtx> = {
  name: RULES_TOOL_NAME,
  description: "Regras em vigor de um módulo, geradas do código (pontos, limites, prazos, percentis, quem pode o quê), com a origem de cada regra e os valores gravados hoje nas Definições que a pessoa pode ver. Usa para explicar \"porque é que deu isto\" ou \"qual é a regra\" sem inventar números.",
  parameters: {
    type: "object",
    properties: {
      modulo: { type: "string", enum: [...RULE_MODULE_IDS], description: "avaliacao (pontos e velocidade), extras_dia (pressão e escala), tempos (entregas e recolhas), despesas, parcerias, casos (reclamações, ocorrências, perdidos) ou criticas." },
    },
    required: ["modulo"],
  },
  available: (ctx) => ruleModulesFor(ctx.user).length > 0,
  run: (args, ctx) => runRulesInForce(args, ctx),
};
