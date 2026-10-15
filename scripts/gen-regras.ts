/**
 * Gera server/assistant/rulesDocs.generated.ts — as "regras em vigor" por
 * módulo (plano MPV, §3.3, F2) a partir de shared/rulesInForce.ts, com os
 * valores do código de shared/helpRuleValues.ts (os MESMOS dos marcadores
 * `{{regra:…}}` da ajuda). Marcador desconhecido = erro.
 *
 *   pnpm tsx scripts/gen-regras.ts
 *
 * O `pnpm tsx scripts/gen-ajuda.ts` também o corre (um comando para os dois).
 * O teste server/assistant/rulesTool.test.ts falha se o gerado não estiver em dia.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { RULE_MODULES, renderRuleModules, type RuleModuleDef } from "../shared/rulesInForce";
import { HELP_RULE_VALUES, type HelpRuleValue } from "../shared/helpRuleValues";

export const RULES_FILE = resolve(import.meta.dirname ?? __dirname, "..", "server", "assistant", "rulesDocs.generated.ts");

/** O conteúdo do ficheiro gerado. PURA. */
export function renderRulesDocs(modules: readonly RuleModuleDef[] = RULE_MODULES, values: Readonly<Record<string, HelpRuleValue>> = HELP_RULE_VALUES): string {
  return [
    "// GERADO por scripts/gen-regras.ts a partir de shared/rulesInForce.ts e shared/helpRuleValues.ts — não editar à mão.",
    "// Regras em vigor por módulo (plano MPV §3.3): frases com os valores do código e a origem de cada uma.",
    'import type { RenderedRuleModule, RuleModuleId } from "../../shared/rulesInForce";',
    "",
    "export const RULES_DOCS: Readonly<Record<RuleModuleId, RenderedRuleModule>> = " + JSON.stringify(renderRuleModules(modules, values), null, 1) + ";",
    "",
  ].join("\n");
}

export function writeRulesDocs(path = RULES_FILE): void {
  writeFileSync(path, renderRulesDocs());
  console.log(`Escrito ${path}`);
}

if (process.argv[1] && /gen-regras\.ts$/.test(process.argv[1])) writeRulesDocs();
