/**
 * O conteúdo do Multis no modo MPV (plano MPV, F3) — só para quem está no
 * piloto (interruptor MPV + ai.assistantPilot); o v1 fica igual.
 *
 *  - Sistema (estável, IGUAL para toda a gente): as regras + o índice da
 *    árvore (Grupo → Página → secções), ≤ 6 000 tokens no índice. Uma cache
 *    por modelo: também as ferramentas declaradas são as mesmas para todos
 *    (o acesso é verificado ao executar; a lista das que a pessoa pode usar
 *    vai no <contexto>, §3.7).
 *  - Por pergunta (fora do sistema): <pagina_atual> com o perfil da página
 *    (shared/multisProfiles.ts) e, em <ajuda>, SEMPRE a secção do separador
 *    aberto (ou a introdução da página, sem separador) + até 2 secções da
 *    pesquisa lexical por secção; teto de 5 000 caracteres no total, com
 *    recorte (excerptSection → excerptHelp) nas secções grandes.
 *  - Ferramentas: `ajuda_abrir` e `ajuda_procurar` em vez do `abrir_ajuda`.
 */
import { assistantMpvSystemPrompt } from "../_core/ai/prompts/assistant";
import type { ChatTool } from "../_core/ai/chat/tools";
import { DEFAULT_MULTIS_PROFILE, multisProfileFor, profileQuestions, type MultisProfile } from "../../shared/multisProfiles";
import type { HelpTreePage, HelpTreeSection } from "../../shared/helpTree";
import { canSeeHelpPage, excerptSection, searchHelpSections, sectionFullText, sectionSubtreeIds } from "./helpTools";
import { KNOWLEDGE_INDEX, knowledgeForPage, knowledgeTree } from "./knowledgeTree";
import { MPV_STAFF_TOOLS, type StaffToolCtx, type StaffUser } from "./tools";

export const MPV_VARIANT = "mpv" as const;

let systemMemo: string | null = null;
/** O prefixo estável do MPV (o mesmo texto para toda a gente). */
export function mpvSystemPrompt(): string {
  if (!systemMemo) systemMemo = assistantMpvSystemPrompt(KNOWLEDGE_INDEX);
  return systemMemo;
}

/**
 * As ferramentas do MPV (tools.ts → MPV_STAFF_TOOLS), pela mesma ordem para
 * todos: as de navegação na ajuda primeiro, as de dados de sempre sem o
 * `abrir_ajuda`, e as do piloto (regras_em_vigor, F2).
 */
export function mpvTools(): ChatTool<StaffToolCtx>[] {
  return MPV_STAFF_TOOLS;
}

/**
 * Orçamento do turno por versão (plano MPV §3.6): prazo total 35 s com 8 s
 * guardados para a chamada final sem cache (as voltas com ferramentas param
 * aos 27 s); MPV-Argon (assistant_smart) até 4 voltas, MPV-lite (assistant,
 * também no modo económico) até 3. Até 4 chamadas por volta (o runAi:
 * MAX_TOOL_CALLS_PER_ROUND). O v1 não usa isto (fica com os 40 s e 3 voltas).
 */
export const MPV_TURN_TIMEOUT_MS = 35_000;
export const MPV_FINAL_RESERVE_MS = 8_000;
export function mpvTurnBudget(feature: "assistant" | "assistant_smart"): { timeoutMs: number; finalReserveMs: number; maxToolRounds: number } {
  return { timeoutMs: MPV_TURN_TIMEOUT_MS, finalReserveMs: MPV_FINAL_RESERVE_MS, maxToolRounds: feature === "assistant_smart" ? 4 : 3 };
}

/** Os nomes das ferramentas que esta pessoa pode usar (vão no <contexto>). */
export function mpvAllowedToolNames(ctx: StaffToolCtx, tools: ChatTool<StaffToolCtx>[] = mpvTools()): string[] {
  return tools.filter((t) => { try { return t.available(ctx); } catch { return false; } }).map((t) => t.name);
}

/** A página da ajuda aberta (a mais específica) e o perfil do Multis para ela. */
export function mpvPageProfile(path: string | null | undefined, tab: string | null | undefined): {
  page: HelpTreePage | null; tabSection: HelpTreeSection | null; profile: MultisProfile;
} {
  const here = knowledgeForPage(path, tab);
  const profile = multisProfileFor({ page: here?.page.id, tab: here?.tabSection ? tab : null, group: here?.page.group });
  return { page: here?.page ?? null, tabSection: here?.tabSection ?? null, profile };
}

/**
 * Perguntas sugeridas do MPV para a página/separador (filtradas pelo módulo).
 * null = a página não tem perfil próprio → ficam as do v1.
 */
export function mpvSuggestions(path: string | null | undefined, tab: string | null | undefined, user: StaffUser): string[] | null {
  const { profile } = mpvPageProfile(path, tab);
  if (profile === DEFAULT_MULTIS_PROFILE) return null;
  const out = profileQuestions(profile, user);
  return out.length ? out : null;
}

/** Teto do bloco <ajuda> do MPV (todas as secções juntas, com as etiquetas). */
export const MPV_HELP_MAX_CHARS = 5000;
/** Secções a mais pela pesquisa (além da do separador). */
export const MPV_SEARCH_SECTIONS = 2;
/** Sem separador, a introdução da página entra só até aqui. */
export const MPV_INTRO_MAX_CHARS = 1200;

const attr = (s: string) => s.replace(/"/g, "'").replace(/[<>]/g, "");

/**
 * O bloco POR PERGUNTA do MPV: <pagina_atual> (perfil) + <ajuda> (secções).
 * `refs` = ids das secções (ficam guardados com a resposta, como os ficheiros
 * do v1). Ferramentas preferidas: só as que existem e a pessoa pode usar.
 */
export function mpvTurnKnowledge(p: {
  path?: string | null; tab?: string | null; question: string; ctx: StaffToolCtx; maxChars?: number;
}): { block: string; refs: string[]; profile: MultisProfile } {
  const tree = knowledgeTree();
  const { page, tabSection, profile } = mpvPageProfile(p.path, p.tab);
  const canSee = (pg: HelpTreePage) => canSeeHelpPage(p.ctx.user, pg);
  const allowed = new Set(mpvAllowedToolNames(p.ctx));
  const preferred = profile.tools.filter((t) => allowed.has(t));

  const head = [
    page ? `Página: ${page.title} (${page.id})${tabSection && p.tab ? ` · separador: ${p.tab}` : ""}` : null,
    `O teu papel aqui: ${profile.role}`,
    preferred.length ? `Ferramentas mais úteis aqui: ${preferred.join(", ")}.` : null,
  ].filter(Boolean).join("\n");
  const pageBlock = `<pagina_atual>\n${head}\n</pagina_atual>`;

  // Âncora: a secção do separador aberto; sem separador, a introdução da página.
  type Item = { page: HelpTreePage; section: HelpTreeSection; cap?: number };
  const items: Item[] = [];
  const exclude = new Set<string>();
  if (page && canSee(page)) {
    const anchor = tabSection ?? page.sections.find((s) => s.level === 1) ?? null;
    if (anchor) {
      items.push({ page, section: anchor, ...(tabSection ? {} : { cap: MPV_INTRO_MAX_CHARS }) });
      for (const id of sectionSubtreeIds(page, anchor)) exclude.add(id);
    }
  }
  let found = 0;
  for (const h of searchHelpSections(tree, p.question, { canSee, currentPage: page?.id ?? null, exclude, max: MPV_SEARCH_SECTIONS * 3 })) {
    if (found >= MPV_SEARCH_SECTIONS) break;
    // Uma secção dentro de outra já escolhida não se repete; uma que contenha
    // uma já escolhida também não (ficava o texto duas vezes).
    const sub = sectionSubtreeIds(h.page, h.section);
    if (exclude.has(h.section.id) || items.some((it) => sub.has(it.section.id))) continue;
    items.push({ page: h.page, section: h.section });
    for (const id of sub) exclude.add(id);
    found++;
  }

  const max = p.maxChars ?? MPV_HELP_MAX_CHARS;
  const open = (it: Item) => `<ajuda id="${attr(it.section.id)}" titulo="${attr(it.section.level === 1 ? it.page.title : `${it.page.title} → ${it.section.title}`)}">\n`;
  const close = "\n</ajuda>";
  const out: string[] = [];
  const refs: string[] = [];
  let left = max - Math.max(0, items.length - 1) * 2; // os "\n\n" entre blocos
  items.forEach((it, idx) => {
    const wrap = open(it).length + close.length;
    const share = Math.min(Math.floor(left / (items.length - idx)), (it.cap ?? Infinity) + wrap);
    const room = share - wrap;
    if (room < 200) return;
    const text = sectionFullText(it.page, it.section);
    if (!text) return;
    const chunk = excerptSection(text, room, p.question);
    out.push(`${open(it)}${chunk}${close}`);
    refs.push(it.section.id);
    left -= wrap + chunk.length;
  });
  return { block: [pageBlock, ...out].join("\n\n"), refs, profile };
}
