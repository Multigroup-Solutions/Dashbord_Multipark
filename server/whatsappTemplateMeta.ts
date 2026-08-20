/**
 * Inspeção de templates na WhatsApp Cloud API — para o envio se ADAPTAR ao
 * template em vez de assumir um formato.
 *
 * Porquê: um template criado no WhatsApp Manager pode ter parâmetros
 * POSICIONAIS (`{{1}}`, `{{2}}`) ou NOMEADOS (`{{nome}}`, `{{semana}}`). Para os
 * nomeados, a Cloud API EXIGE `parameter_name` em cada parâmetro do body; enviar
 * os posicionais dá `(#100) Parameter name is missing or empty` — foi
 * exactamente o que aconteceu ao `disponibilidade_extras` (pt_BR). O mesmo vale
 * para o número de parâmetros e para a existência (ou não) de um botão com URL
 * dinâmico.
 *
 * Estratégia: uma chamada `GET /{wabaId}/message_templates?name=...` por
 * broadcast (cache em memória, 5 min), tudo o resto é lógica PURA e testável.
 *
 * NUNCA bloqueia o envio por falha de inspeção: se não der para ler os
 * metadados (falta de permissão, rede, WABA ambíguo), regista o motivo e o envio
 * segue com o comportamento anterior — e, se falhar, o motivo é anexado ao erro.
 */

import { resolveBodyParamRoles, type TemplateBodyRoles } from "../shared/whatsappTemplate";

const GRAPH_BASE = "https://graph.facebook.com";
const CACHE_TTL_MS = 5 * 60 * 1000;

function apiVersion(): string {
  return process.env.WHATSAPP_API_VERSION || "v21.0";
}

// ─── Tipos ──────────────────────────────────────────────────────────────────

export type ParameterFormat = "POSITIONAL" | "NAMED";

/** O que o envio precisa de saber sobre UMA tradução de um template. */
export interface TemplateAnalysis {
  name: string;
  language: string;
  status: string;
  /** Texto do BODY tal como aprovado (com os `{{...}}`) — base da pré-visualização. */
  bodyText: string;
  parameterFormat: ParameterFormat;
  /** Nomes ordenados dos parâmetros do body (vazio se posicional). */
  paramNames: string[];
  /** Quantos parâmetros o body espera (nomeados ou posicionais). */
  paramCount: number;
  /** O template tem um botão URL com parte dinâmica (precisa de parâmetro). */
  hasDynamicUrlButton: boolean;
  /** Índice do botão dinâmico dentro do bloco BUTTONS (a Meta conta a partir de 0). */
  dynamicUrlButtonIndex: number;
}

/** Resultado da seleção de uma tradução dentro da resposta da Graph API. */
export type TemplateLookup =
  | { ok: true; analysis: TemplateAnalysis }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "language_mismatch"; availableLanguages: string[] }
  | { ok: false; reason: "not_approved"; status: string; language: string };

/** Metadados resolvidos, ou o motivo de não termos conseguido lê-los. */
export type TemplateMetaResult =
  | { available: true; lookup: TemplateLookup }
  | { available: false; reason: string };

// ─── Núcleo PURO ────────────────────────────────────────────────────────────

/**
 * Nomes dos parâmetros de um texto de body, POR ORDEM DE APARIÇÃO e sem
 * repetições (a Meta só quer um valor por nome, mesmo que o texto o use duas
 * vezes). Ignora `{{1}}` — esses são posicionais, não nomes.
 */
export function extractBodyParamNames(bodyText: string | null | undefined): string[] {
  if (!bodyText) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const m of bodyText.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** Quantos `{{n}}` posicionais distintos existem no texto. */
export function countPositionalParams(bodyText: string | null | undefined): number {
  if (!bodyText) return 0;
  const seen = new Set<string>();
  for (const m of bodyText.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) seen.add(m[1]);
  return seen.size;
}

function findComponent(components: any[], type: string): any | undefined {
  return components.find((c) => String(c?.type ?? "").toUpperCase() === type);
}

/**
 * Traduz UMA entrada da Graph API para o que o envio precisa. PURA.
 *
 * O formato é decidido pelo campo `parameter_format` quando existe; quando não
 * existe (contas/versões antigas), infere-se do texto do body — se lá houver
 * `{{nome}}` é NAMED, senão POSITIONAL.
 */
export function analyzeTemplateEntry(entry: any): TemplateAnalysis {
  const components: any[] = Array.isArray(entry?.components) ? entry.components : [];
  const body = findComponent(components, "BODY");
  const bodyText: string = body?.text ?? "";

  const namesFromText = extractBodyParamNames(bodyText);
  const declared = String(entry?.parameter_format ?? "").toUpperCase();
  const parameterFormat: ParameterFormat =
    declared === "NAMED" || declared === "POSITIONAL"
      ? (declared as ParameterFormat)
      : namesFromText.length > 0
        ? "NAMED"
        : "POSITIONAL";

  // Ordem preferida: a do TEXTO do body (é a que o utilizador vê). Só se o texto
  // não der nada é que se usa a lista de exemplo devolvida pela Meta.
  let paramNames = namesFromText;
  if (parameterFormat === "NAMED" && paramNames.length === 0) {
    const example = body?.example?.body_text_named_params;
    if (Array.isArray(example)) {
      paramNames = example
        .map((p: any) => p?.param_name)
        .filter((n: any): n is string => typeof n === "string" && n.length > 0);
    }
  }

  const paramCount = parameterFormat === "NAMED" ? paramNames.length : countPositionalParams(bodyText);

  // Botão URL dinâmico = url com `{{...}}`; é o único que exige parâmetro.
  const buttonsComp = findComponent(components, "BUTTONS");
  const buttons: any[] = Array.isArray(buttonsComp?.buttons) ? buttonsComp.buttons : [];
  const dynamicUrlButtonIndex = buttons.findIndex(
    (b) => String(b?.type ?? "").toUpperCase() === "URL" && /\{\{.+?\}\}/.test(String(b?.url ?? "")),
  );

  return {
    name: String(entry?.name ?? ""),
    language: String(entry?.language ?? ""),
    status: String(entry?.status ?? "UNKNOWN"),
    bodyText,
    parameterFormat,
    paramNames: parameterFormat === "NAMED" ? paramNames : [],
    paramCount,
    hasDynamicUrlButton: dynamicUrlButtonIndex >= 0,
    dynamicUrlButtonIndex: dynamicUrlButtonIndex >= 0 ? dynamicUrlButtonIndex : 0,
  };
}

/**
 * Escolhe a tradução pedida entre as entradas devolvidas pela Meta. PURA.
 *
 * A comparação de língua é case-insensitive; o resto é exato. Quando a língua
 * não existe, devolve as que EXISTEM — é isso que transforma um 132001 cego em
 * "está aprovado em: pt_BR".
 */
export function selectTemplate(entries: any[], name: string, language: string): TemplateLookup {
  const sameName = entries.filter((e) => String(e?.name ?? "") === name);
  if (sameName.length === 0) return { ok: false, reason: "not_found" };

  const wanted = language.toLowerCase();
  const match = sameName.find((e) => String(e?.language ?? "").toLowerCase() === wanted);
  if (!match) {
    return {
      ok: false,
      reason: "language_mismatch",
      availableLanguages: Array.from(new Set(sameName.map((e) => String(e?.language ?? "")).filter(Boolean))),
    };
  }

  const analysis = analyzeTemplateEntry(match);
  if (analysis.status.toUpperCase() !== "APPROVED") {
    return { ok: false, reason: "not_approved", status: analysis.status, language: analysis.language };
  }
  return { ok: true, analysis };
}

/** Mensagem PT para cada motivo de recusa antes do envio. PURA. */
export function describeLookupFailure(
  lookup: Exclude<TemplateLookup, { ok: true }>,
  name: string,
  language: string,
): string {
  switch (lookup.reason) {
    case "not_found":
      return (
        `Não existe nenhum template chamado "${name}" nesta conta WhatsApp. ` +
        `Confirma o nome EXATO em WhatsApp Manager → Modelos de mensagem (maiúsculas, underscores e acentos contam).`
      );
    case "language_mismatch":
      return (
        `O template "${name}" existe, mas NÃO na língua "${language}". ` +
        `Está aprovado em: ${lookup.availableLanguages.join(", ")}. ` +
        `Muda o campo Língua no diálogo para uma destas (ou cria a tradução no WhatsApp Manager).`
      );
    case "not_approved":
      return (
        `O template "${name}" (${lookup.language}) está com estado ${lookup.status}, não APPROVED. ` +
        `Só é possível enviar depois de a Meta aprovar.`
      );
  }
}

/**
 * Valida o que vamos enviar contra o que o template espera. PURA.
 *
 * Devolve `null` quando está tudo bem, ou a mensagem de erro (em PT, já com o
 * nome dos parâmetros do template) que impede o envio antes de gastar chamadas.
 */
export function validateTemplateUsage(
  analysis: TemplateAnalysis,
  opts: { hasBodyParam2: boolean; hasWeekStart: boolean; roles?: TemplateBodyRoles | null },
): string | null {
  const paramsRef = analysis.paramNames.length
    ? ` (${analysis.paramNames.map((n) => `{{${n}}}`).join(", ")})`
    : "";

  if (analysis.paramCount > 2) {
    return (
      `O template "${analysis.name}" tem ${analysis.paramCount} parâmetros${paramsRef}, ` +
      `mas este envio só sabe preencher 2: o nome do extra e o campo "Semana/dia". ` +
      `Simplifica o template ou pede o alargamento desta funcionalidade.`
    );
  }
  // O campo do dialog é obrigatório sempre que ALGUM parâmetro do template o
  // consome — inclui o caso de um template com um único parâmetro que não é o
  // nome (aí o nome não entra e o campo é o único valor a enviar).
  const slots = resolveBodyParamRoles(analysis.paramNames, analysis.paramCount, opts.roles);
  if (slots.includes("shared") && !opts.hasBodyParam2) {
    return (
      `O template "${analysis.name}" tem ${analysis.paramCount} parâmetro(s)${paramsRef} e um deles vem do ` +
      `campo "Semana/dia" do diálogo, que está vazio. Preenche-o antes de enviar.`
    );
  }
  if (analysis.hasDynamicUrlButton && !opts.hasWeekStart) {
    return (
      `O template "${analysis.name}" tem um botão com link dinâmico, que precisa do token pessoal de cada ` +
      `extra. Escolhe a semana antes de enviar.`
    );
  }
  return null;
}

/**
 * Componente `body` já no formato que a Cloud API exige para ESTE template.
 * PURA.
 *
 *  - NAMED      → cada parâmetro leva `parameter_name` (sem isto: erro 100).
 *  - POSITIONAL → parâmetros simples, pela ordem.
 *  - 0 params   → nenhum componente de body (enviar um dá 132000).
 *
 * `values` vem JÁ pela ordem dos parâmetros do template (ver `orderBodyValues` em
 * shared/whatsappTemplate.ts). O template decide quantos são usados.
 */
export function buildBodyComponent(analysis: TemplateAnalysis, values: string[]): unknown | null {
  if (analysis.paramCount === 0) return null;
  const used = values.slice(0, analysis.paramCount);
  if (used.length === 0) return null;

  const parameters =
    analysis.parameterFormat === "NAMED"
      ? used.map((text, i) => ({
          type: "text",
          parameter_name: analysis.paramNames[i] ?? `param${i + 1}`,
          text,
        }))
      : used.map((text) => ({ type: "text", text }));

  return { type: "body", parameters };
}

// ─── I/O: resolução do WABA + leitura dos templates ─────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

let wabaCache: CacheEntry<{ id: string } | { error: string }> | null = null;
const templateCache = new Map<string, CacheEntry<any[]>>();

/** Só para testes: limpa as caches em memória. */
export function __clearTemplateMetaCache(): void {
  wabaCache = null;
  templateCache.clear();
}

/**
 * Ids de WABA visíveis no token, a partir de `/debug_token`. PURA.
 *
 * Prefere o scope de MANAGEMENT (é o que dá acesso a `message_templates`); se
 * não houver, aceita o de messaging.
 */
export function wabaIdsFromDebugToken(payload: any): string[] {
  const scopes: any[] = payload?.data?.granular_scopes ?? [];
  const pick = (scope: string): string[] => {
    const entry = scopes.find((s) => String(s?.scope ?? "") === scope);
    return Array.isArray(entry?.target_ids) ? entry.target_ids.map(String) : [];
  };
  const management = pick("whatsapp_business_management");
  const ids = management.length ? management : pick("whatsapp_business_messaging");
  return Array.from(new Set(ids));
}

/**
 * Id da WABA: env `WHATSAPP_WABA_ID` (determinístico, preferido) ou, em
 * alternativa, o que o token revelar. Ambíguo (>1) = não adivinha.
 */
async function resolveWabaId(token: string): Promise<{ id: string } | { error: string }> {
  const fromEnv = process.env.WHATSAPP_WABA_ID?.trim();
  if (fromEnv) return { id: fromEnv };

  if (wabaCache && wabaCache.expiresAt > Date.now()) return wabaCache.value;

  let value: { id: string } | { error: string };
  try {
    const url = `${GRAPH_BASE}/${apiVersion()}/debug_token?input_token=${encodeURIComponent(token)}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const payload = (await resp.json().catch(() => ({}))) as any;
    if (!resp.ok) {
      value = { error: `não foi possível ler o token (HTTP ${resp.status}: ${payload?.error?.message ?? "sem detalhe"})` };
    } else {
      const ids = wabaIdsFromDebugToken(payload);
      if (ids.length === 1) value = { id: ids[0] };
      else if (ids.length === 0) value = { error: "o token não revela nenhuma conta WhatsApp Business" };
      else value = { error: `o token dá acesso a ${ids.length} contas WhatsApp Business (${ids.join(", ")}) e não é possível escolher` };
    }
  } catch (err: any) {
    value = { error: `erro de rede a ler o token: ${err?.message || err}` };
  }

  wabaCache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

const SET_WABA_HINT = "define a env WHATSAPP_WABA_ID com o id da conta WhatsApp Business";

/**
 * Metadados do template `name` na língua `language`.
 *
 * Uma chamada por broadcast (cache 5 min por nome). NUNCA lança: devolve
 * `available:false` com o motivo, e o envio continua com o comportamento antigo.
 */
export async function getTemplateMeta(name: string, language: string): Promise<TemplateMetaResult> {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) return { available: false, reason: "falta WHATSAPP_TOKEN" };

  const waba = await resolveWabaId(token);
  if ("error" in waba) return { available: false, reason: `${waba.error} — ${SET_WABA_HINT}` };

  const cacheKey = `${waba.id}|${name}`;
  const cached = templateCache.get(cacheKey);
  let entries: any[] | undefined = cached && cached.expiresAt > Date.now() ? cached.value : undefined;

  if (!entries) {
    try {
      const url =
        `${GRAPH_BASE}/${apiVersion()}/${waba.id}/message_templates` +
        `?name=${encodeURIComponent(name)}&limit=50`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const payload = (await resp.json().catch(() => ({}))) as any;
      if (!resp.ok) {
        const detail = payload?.error?.message ?? `HTTP ${resp.status}`;
        // 200 = permissão em falta no token (whatsapp_business_management).
        const hint =
          Number(payload?.error?.code) === 200
            ? " — o token não tem a permissão whatsapp_business_management"
            : "";
        return { available: false, reason: `não foi possível ler os templates (${detail})${hint}` };
      }
      const fetched: any[] = Array.isArray(payload?.data) ? payload.data : [];
      templateCache.set(cacheKey, { value: fetched, expiresAt: Date.now() + CACHE_TTL_MS });
      entries = fetched;
    } catch (err: any) {
      return { available: false, reason: `erro de rede a ler os templates: ${err?.message || err}` };
    }
  }

  return { available: true, lookup: selectTemplate(entries, name, language) };
}
