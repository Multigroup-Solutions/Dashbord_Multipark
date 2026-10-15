/**
 * Árvore de conhecimento da ajuda (plano MPV, F1): regra das secções, ids
 * estáveis (e o registo dos que já existiram), separadores, marcadores de
 * regras, rotas do menu, ligação ao contexto da página (shared/multisPage.ts)
 * e o gerado em dia.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HELP_GROUPS, HELP_INDEX_MAX_TOKENS, HelpTreeError, buildHelpTree, chooseIndexLevel, estimateTokens, findHelpNode, firstSentence, openHelpNode,
  pagesForPath, parseHelpPage, parseTabsField, renderHelpIndex, renderPageSections, sectionForTab, sectionHeading, slugify, splitFrontMatter, splitSections,
  treeIds, treeOutline, treePages,
} from "../shared/helpTree";
import { HELP_RULE_VALUES, HelpRuleMarkerError, renderRuleMarkers, ruleMarkersIn, settingMarkersWithoutNote } from "../shared/helpRuleValues";
import { HELP_ID_ALIASES } from "../shared/helpIdAliases";
import { DEFAULT_TIMES_PERCENTILE } from "../shared/appSettings";
import { EVALUATION_POINTS } from "../shared/evaluationRules";
import { MULTIS_PAGE_TABS } from "../shared/multisPage";
import { IDS_FILE, missingIds, readAjudaFiles, readAjudaSources, readKnownIds, renderGenerated, renderKnowledgeTree, renderKnownIds } from "../scripts/gen-ajuda";
import { HELP_FILES } from "./assistant/helpDocs.generated";
import { KNOWLEDGE_INDEX, KNOWLEDGE_INDEX_LEVEL, KNOWLEDGE_OUTLINE, knowledgeForPage, knowledgeTree, openKnowledge } from "./assistant/knowledgeTree";

const ROOT = resolve(__dirname, "..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const noNote = { requireDefaultNote: false };

const page = (body: string, head = "grupo: Operações\npagina: teste") => `---\nmodulo: teste\n${head}\ntitulo: Teste\nrotas: /teste\n---\n# Teste\n\n${body}`;

describe("regra das secções", () => {
  it("só ##, ### e linhas só a negrito abrem secção", () => {
    expect(sectionHeading("## Separadores")).toEqual({ title: "Separadores", level: 2 });
    expect(sectionHeading("### Juntar contas (só administradores)")).toEqual({ title: "Juntar contas (só administradores)", level: 3 });
    expect(sectionHeading("**Lista**")).toEqual({ title: "Lista", level: 4 });
    expect(sectionHeading("**Notas**:")).toEqual({ title: "Notas", level: 4 });
    expect(sectionHeading("**Notas** :")).toEqual({ title: "Notas", level: 4 });
    expect(sectionHeading("**Entrar**: \"Entrar com Google\" na página inicial.")).toBeNull();
    expect(sectionHeading("1. **Online (Stripe)**: todos os dias")).toBeNull();
    expect(sectionHeading("- **Estado**: saúde das tarefas")).toBeNull();
    expect(sectionHeading("**Gestão** (backoffice e acima)")).toBeNull();
    expect(sectionHeading("#### Muito fundo")).toBeNull();
    expect(sectionHeading("# Título da página")).toBeNull();
  });

  it("início, secções e o que está dentro de ``` / ~~~ não conta", () => {
    const secs = splitSections("x.md", "# X\n\nIntro da página.\n\n**Primeira**\nTexto um.\n\n```ts\n**Não é secção**\n```\n\n~~~\n## Também não\n```\n~~~\n\n## Segunda\nTexto dois. E mais.", "X");
    expect(secs.map((s) => [s.slug, s.level])).toEqual([["inicio", 1], ["primeira", 4], ["segunda", 2]]);
    expect(secs[1].text).toContain("**Não é secção**");
    expect(secs[1].text).toContain("## Também não");
    expect(secs[2].summary).toBe("Texto dois.");
  });

  it("uma linha com ``` no meio do texto não abre bloco; bloco aberto no fim = erro", () => {
    const secs = splitSections("x.md", "Usa ```código``` assim.\n\n**Depois**\nok", "X");
    expect(secs.map((s) => s.slug)).toEqual(["inicio", "depois"]);
    expect(() => splitSections("x.md", "**A**\n```\nnunca fecha", "X")).toThrow(/bloco de código aberto/);
    expect(() => parseHelpPage("t.md", page("**A**\n~~~\nnunca fecha"))).toThrow(HelpTreeError);
  });

  it("BOM no início do ficheiro é tolerado", () => {
    expect(splitFrontMatter("﻿---\npagina: x\n---\n# X").head.pagina).toBe("x");
    expect(parseHelpPage("t.md", `﻿${page("ok")}`).id).toBe("teste");
  });

  it("ids estáveis: pelo título, repetidos com -2, colisões resolvidas sempre da mesma maneira", () => {
    const a = splitSections("f.md", "**Notas**\na\n\n**Lista**\nb\n\n**Notas**\nc", "F").map((s) => s.id);
    expect(a).toEqual(["f.md#notas", "f.md#lista", "f.md#notas-2"]);
    const b = splitSections("f.md", "**Nova**\nz\n\n**Notas**\na\n\n**Lista**\nb", "F").map((s) => s.id);
    expect(b).toContain("f.md#lista");
    expect(b).toContain("f.md#notas");
    // "Notas 2" (título) com um "Notas" repetido antes: nunca dois ids iguais
    const c = splitSections("f.md", "**Notas**\na\n\n**Notas**\nb\n\n**Notas 2**\nc", "F").map((s) => s.id);
    expect(c).toEqual(["f.md#notas", "f.md#notas-2", "f.md#notas-2-2"]);
    expect(splitSections("f.md", "**Notas**\na\n\n**Notas**\nb\n\n**Notas 2**\nc", "F").map((s) => s.id)).toEqual(c);
    expect(new Set(splitSections("f.md", "**Inicio**\na", "F").map((s) => s.slug)).size).toBe(1);
    expect(slugify("Separador \"Pressão\" (quando é que aperta)")).toBe("separador-pressao-quando-e-que-aperta");
  });

  it("resumo: 1.ª frase, sem markdown, no máx. 160 caracteres, sem cortar em abreviaturas", () => {
    expect(firstSentence("**Financeiro → Caixa** (29c). Tem permissão própria.")).toBe("Financeiro → Caixa (29c).");
    expect(firstSentence("Fala com o Sr. Silva ou com a Dra. Ana. Depois volta.")).toBe("Fala com o Sr. Silva ou com a Dra. Ana.");
    expect(firstSentence("Vê o n.º da reserva, p. ex. AB12. Depois.")).toBe("Vê o n.º da reserva, p. ex. AB12.");
    expect(firstSentence("Versão 3.5 do motor. Outra.")).toBe("Versão 3.5 do motor.");
    const long = firstSentence(`- ${"palavra ".repeat(60)}fim.`);
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith("…")).toBe(true);
  });

  it("subsecções e contentores (um ## só de arrumação abre a lista dos filhos)", () => {
    const tree = buildHelpTree([{ file: "t.md", raw: page("## Separadores\n\n### Um\nTexto um.\n\n### Dois\nTexto dois.\n\n**Nota do dois**\nnota\n\n## Outra\nTexto.") }]);
    const p = treePages(tree)[0];
    const sep = p.sections.find((s) => s.slug === "separadores")!;
    expect(sep).toMatchObject({ container: true, children: ["t.md#um", "t.md#dois"] });
    expect(p.sections.find((s) => s.slug === "dois")!.children).toEqual(["t.md#nota-do-dois"]);
    expect(p.sections.find((s) => s.slug === "outra")).toMatchObject({ container: false, children: [] });
    const open = openHelpNode(tree, "t.md#separadores")!;
    expect(open.text).toContain("t.md#um: Um — Texto um.");
    expect(open.text).toContain("t.md#dois");
    expect(openHelpNode(tree, "t.md#dois")!.text).toBe("Texto dois.\n\nSubsecções:\n- t.md#nota-do-dois: Nota do dois — nota");
    expect(openHelpNode(tree, "teste")!.text).toContain("t.md#outra");
    expect(openHelpNode(tree, "nao-existe")).toBeNull();
  });
});

describe("cabeçalho e separadores", () => {
  it("lê grupo, página e separadores (a vírgula do título não parte)", () => {
    expect(parseTabsField("dia=Dia, pressao=Separador \"Pressão\", x=Reservas, Recolhas e Entregas")).toEqual([
      { tab: "dia", section: "Dia" }, { tab: "pressao", section: "Separador \"Pressão\"" }, { tab: "x", section: "Reservas, Recolhas e Entregas" },
    ]);
    const p = parseHelpPage("t.md", page("**Dia**\num\n\n## Pressão (quando aperta)\ndois", "grupo: Operações\npagina: teste\nseparadores: dia=Dia, pressao=Pressão"));
    expect(p).toMatchObject({ id: "teste", group: "Operações", routes: ["/teste"] });
    expect(p.tabs).toEqual([{ tab: "dia", section: "Dia", sectionId: "t.md#dia" }, { tab: "pressao", section: "Pressão", sectionId: "t.md#pressao-quando-aperta" }]);
    expect(sectionForTab(p, "pressao")?.text).toBe("dois");
    expect(sectionForTab(p, "outro")).toBeNull();
  });

  it("erros: sem grupo, grupo fora do menu, sem página, separador sem secção, página repetida", () => {
    expect(() => parseHelpPage("t.md", page("x", "pagina: teste"))).toThrow(HelpTreeError);
    expect(() => parseHelpPage("t.md", page("x", "grupo: Outros\npagina: teste"))).toThrow(/não é um grupo do menu/);
    expect(() => parseHelpPage("t.md", page("x", "grupo: Sistema"))).toThrow(/pagina/);
    expect(() => parseHelpPage("t.md", page("**Dia**\nx", "grupo: Sistema\npagina: t\nseparadores: mes=Mês"))).toThrow(/não existe/);
    const f = { file: "a.md", raw: page("x") };
    expect(() => buildHelpTree([f, { file: "b.md", raw: page("y") }])).toThrow(/repetida/);
  });
});

describe("marcadores de regras {{regra:…}}", () => {
  it("troca pelo valor do código", () => {
    expect(renderRuleMarkers("p{{regra:extras.timesPercentile.porto}} no Porto (por omissão)")).toBe(`p${DEFAULT_TIMES_PERCENTILE.porto} no Porto (por omissão)`);
    expect(renderRuleMarkers("acidente {{regra:evaluation.points.accidentOrDamage}}")).toBe(`acidente −${-EVALUATION_POINTS.accidentOrDamage}`);
  });

  it("marcador desconhecido ou mal escrito = erro do gerador", () => {
    expect(() => renderRuleMarkers("{{regra:nao.existe}}", "x.md")).toThrow(HelpRuleMarkerError);
    expect(() => renderRuleMarkers("{{regra:nao.existe}}", "x.md")).toThrow(/x\.md.*desconhecido/);
    expect(() => renderRuleMarkers("{{ regra extras }}", "x.md")).toThrow(/mal escrito/);
    expect(() => renderRuleMarkers("{{regra:constructor}}", "x.md")).toThrow(/desconhecido/);
    expect(HELP_RULE_VALUES["extras.pressureWindowDays"]).toBeUndefined();
  });

  it("um valor que é omissão de uma definição exige \"por omissão\" (ou \"em uso\") por perto", () => {
    expect(() => renderRuleMarkers("A meta é {{regra:serviceTimes.targetMinutes}} min.", "x.md")).toThrow(/por omissão/);
    expect(renderRuleMarkers("A meta é {{regra:serviceTimes.targetMinutes}} min por omissão.", "x.md")).toMatch(/^A meta é \d+ min por omissão\.$/);
    expect(renderRuleMarkers("O percentil em uso aparece no botão; p{{regra:extras.timesPercentile.porto}}.")).toContain("p");
    expect(renderRuleMarkers("Sem nota: {{regra:serviceTimes.targetMinutes}}", "x.md", HELP_RULE_VALUES, noNote)).toMatch(/\d+$/);
    // as constantes do código (pontos) não pedem a nota
    expect(() => renderRuleMarkers("vale {{regra:evaluation.points.movement}}")).not.toThrow();
    const settings = Object.entries(HELP_RULE_VALUES).filter(([, v]) => v.setting).map(([k]) => k);
    expect(settings).toEqual(expect.arrayContaining(["extras.timesPercentile.lisbon", "extras.autoProposeAt", "serviceTimes.targetMinutes", "serviceTimes.gpsGate.minN"]));
    expect(settings).not.toContain("evaluation.points.movement");
    for (const f of readAjudaSources()) expect(settingMarkersWithoutNote(f.raw), f.file).toEqual([]);
  });

  it("todos os marcadores da ajuda existem e o que se mostra nunca leva o marcador cru", () => {
    const used = readAjudaSources().flatMap((f) => ruleMarkersIn(f.raw));
    expect(used.length).toBeGreaterThan(15);
    for (const k of used) expect(HELP_RULE_VALUES[k], k).toBeDefined();
    for (const f of HELP_FILES) expect(f.raw, f.file).not.toMatch(/\{\{\s*regra/);
    expect(JSON.stringify(KNOWLEDGE_OUTLINE)).not.toMatch(/\{\{\s*regra/);
    expect(KNOWLEDGE_INDEX).not.toMatch(/\{\{\s*regra/);
  });

  it("a ajuda mostra o percentil por cidade do código (Pressão) e a meta da entrega", () => {
    const extras = HELP_FILES.find((f) => f.file === "extras-dia.md")!.raw;
    expect(extras).toContain(`p${DEFAULT_TIMES_PERCENTILE.lisbon} em Lisboa`);
    expect(extras).toContain(`p${DEFAULT_TIMES_PERCENTILE.porto} no Porto e em Faro`);
    expect(extras).toMatch(/mais escuro = mais entregas na meta \(melhor\)/);
    expect(extras).toContain("explica o p75 e o percentil da cidade");
    const pressure = src("client/src/pages/extrasDia/PressureTab.tsx");
    expect(pressure).toContain('pct < 75 ? "É menos prudente do que o p75." : "É mais prudente do que o p75."');
  });
});

describe("árvore gerada (docs/ajuda → knowledgeTree.generated.ts) e a árvore em execução", () => {
  const tree = buildHelpTree(readAjudaFiles());

  it("está em dia (pnpm tsx scripts/gen-ajuda.ts)", () => {
    expect(src("server/assistant/knowledgeTree.generated.ts")).toBe(renderKnowledgeTree(readAjudaFiles()));
    expect(src("server/assistant/helpDocs.generated.ts")).toBe(renderGenerated(readAjudaFiles()));
    expect(KNOWLEDGE_OUTLINE).toEqual(JSON.parse(JSON.stringify(treeOutline(tree))));
  });

  it("o gerado não repete o texto da ajuda: o texto vem do helpDocs em execução", () => {
    const gen = src("server/assistant/knowledgeTree.generated.ts");
    expect(gen).not.toContain('"text"');
    expect(gen.length).toBeLessThan(src("server/assistant/helpDocs.generated.ts").length / 2);
    expect(knowledgeTree()).toEqual(buildHelpTree(HELP_FILES));
    expect(treeOutline(knowledgeTree())).toEqual(KNOWLEDGE_OUTLINE);
    expect(openKnowledge("caixa.md#confirmacao-da-caixa")?.text).toContain("Caixa → Confirmação");
    expect(knowledgeForPage("/extras-dia", "pressao")?.tabSection?.id).toBe("extras-dia.md#separador-pressao-quando-e-que-aperta");
  });

  it("grupos = os do menu, cada ficheiro é uma página", () => {
    expect(tree.groups.map((g) => g.group)).toEqual([...HELP_GROUPS]);
    expect(treePages(tree).map((p) => p.file).sort()).toEqual(HELP_FILES.map((f) => f.file).sort());
  });

  it("ids de secção únicos e no formato <ficheiro>#<slug>; tópicos com pai existente", () => {
    const ids = treePages(tree).flatMap((p) => p.sections.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of treePages(tree)) {
      for (const s of p.sections) expect(s.id).toMatch(new RegExp(`^${p.file.replace(".", "\\.")}#[a-z0-9-]+$`));
      for (const s of p.sections) expect(s.summary.length).toBeLessThanOrEqual(160);
      if (p.id.includes(".")) expect(treePages(tree).some((q) => q.id === p.id.split(".")[0]), p.id).toBe(true);
    }
    expect(findHelpNode(tree, "caixa.md#confirmacao-da-caixa")?.page.id).toBe("caixa");
    expect(findHelpNode(tree, "extras-dia")?.section).toBeNull();
  });

  it("nenhum id que já existiu desaparece sem alias (knowledgeTreeIds.json só cresce)", () => {
    const known = readKnownIds();
    expect(known.length).toBeGreaterThan(300);
    expect(missingIds(tree, known)).toEqual([]);
    for (const id of treeIds(tree)) expect(known, id).toContain(id);
    expect(src("server/assistant/knowledgeTreeIds.json")).toBe(renderKnownIds(tree, known));
    expect(IDS_FILE).toMatch(/knowledgeTreeIds\.json$/);
    // um id que desaparece falha; com alias para um que existe, passa
    expect(() => renderKnownIds(tree, [...known, "caixa.md#ja-nao-existe"])).toThrow(/desapareceram: caixa\.md#ja-nao-existe/);
    expect(missingIds(tree, ["caixa.md#ja-nao-existe"], { "caixa.md#ja-nao-existe": "caixa.md#resumo" })).toEqual([]);
    expect(findHelpNode(tree, "caixa.md#ja-nao-existe", { "caixa.md#ja-nao-existe": "caixa.md#resumo" })?.section?.id).toBe("caixa.md#resumo");
    for (const [from, to] of Object.entries(HELP_ID_ALIASES)) expect(findHelpNode(tree, to), `${from} → ${to}`).not.toBeNull();
  });

  it("índice dentro do teto; secções de uma página para o ajuda_abrir", () => {
    expect(estimateTokens(KNOWLEDGE_INDEX)).toBeLessThanOrEqual(HELP_INDEX_MAX_TOKENS);
    expect(estimateTokens(renderHelpIndex(tree, "pages"))).toBeLessThanOrEqual(HELP_INDEX_MAX_TOKENS);
    expect(KNOWLEDGE_INDEX_LEVEL).toBe(chooseIndexLevel(tree));
    const extras = findHelpNode(tree, "extras-dia")!.page;
    expect(renderPageSections(extras)).toContain("extras-dia.md#separador-pressao-quando-e-que-aperta");
    expect(renderPageSections(extras)).toContain("pressao → ");
  });

  it("as secções contentor abrem a lista dos filhos", () => {
    const sep = findHelpNode(tree, "parcerias.md#separadores")!.section!;
    expect(sep.container).toBe(true);
    expect(sep.children).toContain("parcerias.md#fecho-do-mes");
    expect(openHelpNode(tree, "parcerias.md#separadores")!.text).toMatch(/^Subsecções/);
    expect(findHelpNode(tree, "web-analytics.md#configurar-super-admin")!.section!.container).toBe(true);
  });
});

// ─── Rotas do menu ──────────────────────────────────────────────────────────

/** (rota, grupo) de cada item do menu (topo, grupos do menu e grupos do hub). */
function menuItems(): Array<{ path: string; group: string }> {
  const text = src("client/src/components/DashboardLayout.tsx");
  const start = text.indexOf("export const topLevelItems");
  const end = text.indexOf("export function getFilteredHubGroups");
  expect(start).toBeGreaterThan(0);
  let group = "Dashboards";
  const out: Array<{ path: string; group: string }> = [];
  for (const line of text.slice(start, end).split("\n")) {
    const g = /^\s*label: "([^"]+)",\s*$/.exec(line);
    if (g) group = g[1];
    const p = /path: "([^"]+)"/.exec(line);
    if (p) out.push({ path: p[1], group });
  }
  return out;
}

/** Rotas que só redirecionam (não precisam de página própria). */
const REDIRECTS: Record<string, string> = { "/marketing-dashboard": "/marketing" };

describe("cada rota do menu tem página na árvore", () => {
  const tree = buildHelpTree(readAjudaFiles());
  const items = menuItems();

  it("lê o menu todo", () => {
    expect(items.length).toBeGreaterThan(40);
    expect(items).toContainEqual({ path: "/pessoas-dashboard", group: "Dashboards" });
    expect(items).toContainEqual({ path: "/caixa", group: "Financeiro" });
    expect(items).toContainEqual({ path: "/definicoes", group: "Sistema" });
  });

  it.each(menuItems().filter((i) => !REDIRECTS[i.path]).map((i) => [i.path]))("%s", (path) => {
    const top = pagesForPath(tree, path)[0];
    expect(top, `sem página para ${path}`).toBeDefined();
    expect(top.routes, path).toContain(path);
    const groups = items.filter((i) => i.path === path).map((i) => i.group);
    expect(groups, `${path} → ${top.file} (${top.group})`).toContain(top.group);
  });

  it("rotas fora do menu e a mais específica a ganhar", () => {
    const at = (p: string) => pagesForPath(tree, p)[0]?.file;
    expect(at("/formacao/conhecimento")).toBe("pesquisa-e-conhecimento.md");
    expect(at("/formacao")).toBe("formacao.md");
    expect(at("/formacao/qualquer")).toBe("formacao.md");
    expect(at("/faturacao/diagnose")).toBe("faturacao.md");
    expect(at("/parcerias/inferir")).toBe("parcerias.md");
    expect(at("/drive")).toBe("drive.md");
    expect(at("/perfil")).toBe("perfil.md");
    expect(at("/definicoes")).toBe("definicoes.md");
    expect(at("/definicoes?tab=estado")).toBe("definicoes.md");
    expect(at("/operacoes")).toBe("reservas-do-dia.md");
    expect(at("/operacional")).toBe("atividade-diaria.md");
    expect(at("/whatsapp")).toBe("whatsapp.md");
    expect(at("/comunicacao")).toBe("comunicacao.md");
    expect(at("/marketing/web")).toBe("web-analytics.md");
    expect(at("/marketing/google-ads")).toBe("marketing.md");
    expect(at("/financeiro")).toBe("dashboards.md");
    expect(at("/dashboard")).toBe("dashboards.md");
    expect(at("/")).toBe("entrada.md");
    expect(at("/modulos")).toBe("entrada.md");
    expect(pagesForPath(tree, "/nao-existe")).toEqual([]);
    expect(pagesForPath(tree, null)).toEqual([]);
    // desempates: o nome da página = o fim da rota, depois menos rotas
    const t2 = buildHelpTree([
      { file: "a.md", raw: page("x", "grupo: Sistema\npagina: x.geral").replace("rotas: /teste", "rotas: /x/web") },
      { file: "b.md", raw: page("y", "grupo: Sistema\npagina: x.web").replace("rotas: /teste", "rotas: /x/web") },
      { file: "c.md", raw: page("z", "grupo: Sistema\npagina: x").replace("rotas: /teste", "rotas: /x, /y, /x/web") },
    ]);
    expect(pagesForPath(t2, "/x/web").map((p) => p.file)).toEqual(["b.md", "a.md", "c.md"]);
    // a redireção existe mesmo no código
    expect(src("client/src/App.tsx")).toMatch(/path="\/marketing-dashboard">\s*\{\(\) => <Redirect to="\/marketing"/);
  });

  it("a entrada na app é um tópico próprio (o recorte do v1 não começa pelos dashboards)", () => {
    const entrada = HELP_FILES.find((f) => f.file === "entrada.md")!.raw;
    expect(entrada).toMatch(/^---\nmodulo: dashboards\ngrupo: Dashboards\npagina: dashboards\.entrada\n/);
    expect(entrada.split("\n---\n")[1].trimStart()).toMatch(/^# Entrada, menu e "Sem acesso"\n\n\*\*Entrar\*\*/);
    expect(entrada).not.toContain("## Geral (o resumo de hoje)");
  });
});

// ─── Separadores = os do código ─────────────────────────────────────────────

/** Separadores que existem no código, por rota: os que o servidor aceita (shared/multisPage.ts) ou os TabsTrigger da página. */
function codeTabs(route: string): string[] | null {
  if (MULTIS_PAGE_TABS[route]) return [...MULTIS_PAGE_TABS[route]];
  const fromPage = (file: string) => [...src(`client/src/pages/${file}`).matchAll(/TabsTrigger value="([a-z0-9_-]+)"/g)].map((m) => m[1]);
  switch (route) {
    case "/dashboards": return fromPage("DashboardsPage.tsx");
    case "/definicoes": return fromPage("DefinicoesPage.tsx");
    case "/operacoes": return fromPage("OperacoesPage.tsx");
    case "/faturacao": return fromPage("InvoicesPage.tsx");
    case "/api-keys": return fromPage("ApiKeysPage.tsx");
    default: return null;
  }
}
const TAB_ROUTES = [...Object.keys(MULTIS_PAGE_TABS), "/dashboards", "/definicoes", "/operacoes", "/faturacao", "/api-keys"];

describe("separadores do cabeçalho = os do código", () => {
  const tree = buildHelpTree(readAjudaFiles());
  const withTabs = treePages(tree).filter((p) => p.tabs.length);

  it("as listas do servidor batem com os TabsTrigger das páginas", () => {
    const pages: Record<string, string> = { "/extras-dia": "ExtrasDiaPage.tsx", "/avaliacao": "AvaliacaoPage.tsx", "/despesas": "ExpensesPage.tsx", "/parcerias": "PartnershipsPage.tsx", "/pessoas/condutores-agentes": "CondutoresAgentesPage.tsx", "/formacao": "TrainingPage.tsx", "/criticas": "GoogleReviewsPage.tsx", "/caixa": "CaixaPage.tsx", "/operacional": "OperationalPage.tsx" };
    for (const [route, file] of Object.entries(pages)) {
      const inPage = [...src(`client/src/pages/${file}`).matchAll(/TabsTrigger value="([a-z0-9_-]+)"/g)].map((m) => m[1]);
      expect(new Set(inPage), route).toEqual(new Set(MULTIS_PAGE_TABS[route]));
    }
  });

  it.each(withTabs.map((p) => [p.file, p] as const))("%s: cada separador do cabeçalho existe no código", (_f, p) => {
    const known = p.routes.map(codeTabs).filter((x): x is string[] => !!x);
    expect(known.length, `${p.file}: nenhuma rota com separadores conhecidos no teste`).toBeGreaterThan(0);
    const all = new Set(known.flat());
    for (const t of p.tabs) expect(all.has(t.tab), `${p.file}: separador "${t.tab}" não existe no código`).toBe(true);
  });

  it.each(TAB_ROUTES.map((r) => [r]))("%s: cada separador do código tem secção própria (≤ 5 000 car.)", (route) => {
    const pages = pagesForPath(tree, route).filter((p) => p.routes.includes(route));
    const declared = pages.flatMap((p) => p.tabs.map((t) => ({ ...t, page: p })));
    const seen = new Map<string, string>();
    for (const tab of codeTabs(route)!) {
      const hits = declared.filter((d) => d.tab === tab);
      expect(hits.length, `${route}: o separador "${tab}" não tem secção na ajuda`).toBeGreaterThan(0);
      for (const h of hits) {
        const sec = h.page.sections.find((s) => s.id === h.sectionId)!;
        expect(sec.text.length, `${h.sectionId} tem ${sec.text.length} car.`).toBeLessThanOrEqual(5000);
        const other = seen.get(h.sectionId);
        expect(other, `${route}: "${tab}" e "${other}" apontam para a mesma secção ${h.sectionId}`).toBeUndefined();
        seen.set(h.sectionId, tab);
      }
    }
  });

  it("cada página com separadores no servidor (multisPage) tem página na árvore com essa rota", () => {
    for (const route of Object.keys(MULTIS_PAGE_TABS)) {
      const top = pagesForPath(tree, route)[0];
      expect(top?.routes, route).toContain(route);
      expect(top.tabs.length, `${route} → ${top.file} sem separadores`).toBeGreaterThan(0);
      expect(knowledgeForPage(route, MULTIS_PAGE_TABS[route][0])?.tabSection, route).not.toBeNull();
    }
  });
});
