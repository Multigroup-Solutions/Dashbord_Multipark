/**
 * Árvore de conhecimento da ajuda (plano MPV, F1): regra das secções, ids
 * estáveis, separadores, marcadores de regras, rotas do menu e o gerado em dia.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HELP_GROUPS, HELP_INDEX_MAX_TOKENS, HelpTreeError, buildHelpTree, chooseIndexLevel, estimateTokens, findHelpNode, firstSentence,
  pagesForPath, parseHelpPage, parseTabsField, renderHelpIndex, renderPageSections, sectionForTab, sectionHeading, slugify, splitSections, treePages,
} from "../shared/helpTree";
import { HELP_RULE_VALUES, HelpRuleMarkerError, renderRuleMarkers, ruleMarkersIn } from "../shared/helpRuleValues";
import { DEFAULT_TIMES_PERCENTILE } from "../shared/appSettings";
import { EVALUATION_POINTS } from "../shared/evaluationRules";
import { OPERATIONAL_TABS } from "../shared/operationalTabs";
import { CAIXA_TABS } from "../shared/caixaTabs";
import { readAjudaFiles, readAjudaSources, renderGenerated, renderKnowledgeTree } from "../scripts/gen-ajuda";
import { HELP_FILES } from "./assistant/helpDocs.generated";
import { KNOWLEDGE_INDEX, KNOWLEDGE_INDEX_LEVEL, KNOWLEDGE_TREE } from "./assistant/knowledgeTree.generated";

const ROOT = resolve(__dirname, "..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const page = (body: string, head = "grupo: Operações\npagina: teste") => `---\nmodulo: teste\n${head}\ntitulo: Teste\nrotas: /teste\n---\n# Teste\n\n${body}`;

describe("regra das secções", () => {
  it("só ##, ### e linhas só a negrito abrem secção", () => {
    expect(sectionHeading("## Separadores")).toEqual({ title: "Separadores", level: 2 });
    expect(sectionHeading("### Juntar contas (só administradores)")).toEqual({ title: "Juntar contas (só administradores)", level: 3 });
    expect(sectionHeading("**Lista**")).toEqual({ title: "Lista", level: 4 });
    expect(sectionHeading("**Notas**:")).toEqual({ title: "Notas", level: 4 });
    expect(sectionHeading("**Entrar**: \"Entrar com Google\" na página inicial.")).toBeNull();
    expect(sectionHeading("1. **Online (Stripe)**: todos os dias")).toBeNull();
    expect(sectionHeading("- **Estado**: saúde das tarefas")).toBeNull();
    expect(sectionHeading("**Gestão** (backoffice e acima)")).toBeNull();
    expect(sectionHeading("#### Muito fundo")).toBeNull();
    expect(sectionHeading("# Título da página")).toBeNull();
  });

  it("início, secções e o que está dentro de ``` não conta", () => {
    const secs = splitSections("x.md", "# X\n\nIntro da página.\n\n**Primeira**\nTexto um.\n\n```\n**Não é secção**\n```\n\n## Segunda\nTexto dois. E mais.", "X");
    expect(secs.map((s) => [s.slug, s.level])).toEqual([["inicio", 1], ["primeira", 4], ["segunda", 2]]);
    expect(secs[1].text).toContain("**Não é secção**");
    expect(secs[2].summary).toBe("Texto dois.");
  });

  it("ids estáveis: pelo título, repetidos com -2, sem depender da posição", () => {
    const a = splitSections("f.md", "**Notas**\na\n\n**Lista**\nb\n\n**Notas**\nc", "F").map((s) => s.id);
    expect(a).toEqual(["f.md#notas", "f.md#lista", "f.md#notas-2"]);
    const b = splitSections("f.md", "**Nova**\nz\n\n**Notas**\na\n\n**Lista**\nb", "F").map((s) => s.id);
    expect(b).toContain("f.md#lista");
    expect(b).toContain("f.md#notas");
    expect(slugify("Separador \"Pressão\" (quando é que aperta)")).toBe("separador-pressao-quando-e-que-aperta");
  });

  it("resumo: 1.ª frase, sem markdown, no máx. 160 caracteres", () => {
    expect(firstSentence("**Financeiro → Caixa** (29c). Tem permissão própria.")).toBe("Financeiro → Caixa (29c).");
    const long = firstSentence(`- ${"palavra ".repeat(60)}fim.`);
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith("…")).toBe(true);
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
    expect(renderRuleMarkers("p{{regra:extras.timesPercentile.porto}} no Porto")).toBe(`p${DEFAULT_TIMES_PERCENTILE.porto} no Porto`);
    expect(renderRuleMarkers("acidente {{regra:evaluation.points.accidentOrDamage}}")).toBe(`acidente −${-EVALUATION_POINTS.accidentOrDamage}`);
  });

  it("marcador desconhecido ou mal escrito = erro do gerador", () => {
    expect(() => renderRuleMarkers("{{regra:nao.existe}}", "x.md")).toThrow(HelpRuleMarkerError);
    expect(() => renderRuleMarkers("{{regra:nao.existe}}", "x.md")).toThrow(/x\.md.*desconhecido/);
    expect(() => renderRuleMarkers("{{ regra extras }}", "x.md")).toThrow(/mal escrito/);
    expect(() => renderRuleMarkers("{{regra:constructor}}", "x.md")).toThrow(/desconhecido/);
  });

  it("todos os marcadores da ajuda existem e o que se mostra nunca leva o marcador cru", () => {
    const used = readAjudaSources().flatMap((f) => ruleMarkersIn(f.raw));
    expect(used.length).toBeGreaterThan(10);
    for (const k of used) expect(HELP_RULE_VALUES[k], k).toBeDefined();
    for (const f of HELP_FILES) expect(f.raw, f.file).not.toMatch(/\{\{\s*regra/);
    expect(JSON.stringify(KNOWLEDGE_TREE)).not.toMatch(/\{\{\s*regra/);
    expect(KNOWLEDGE_INDEX).not.toMatch(/\{\{\s*regra/);
  });

  it("a ajuda mostra o percentil por cidade do código (Pressão) e a meta da entrega", () => {
    const extras = HELP_FILES.find((f) => f.file === "extras-dia.md")!.raw;
    expect(extras).toContain(`p${DEFAULT_TIMES_PERCENTILE.lisbon} em Lisboa`);
    expect(extras).toContain(`p${DEFAULT_TIMES_PERCENTILE.porto} no Porto e em Faro`);
    expect(extras).toMatch(/mais escuro = mais entregas na meta \(melhor\)/);
  });
});

describe("árvore gerada (docs/ajuda → knowledgeTree.generated.ts)", () => {
  const tree = buildHelpTree(readAjudaFiles());

  it("está em dia (pnpm tsx scripts/gen-ajuda.ts)", () => {
    expect(src("server/assistant/knowledgeTree.generated.ts")).toBe(renderKnowledgeTree(readAjudaFiles()));
    expect(src("server/assistant/helpDocs.generated.ts")).toBe(renderGenerated(readAjudaFiles()));
    expect(KNOWLEDGE_TREE).toEqual(JSON.parse(JSON.stringify(tree)));
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

  it("índice dentro do teto; secções de uma página para o ajuda_abrir", () => {
    expect(estimateTokens(KNOWLEDGE_INDEX)).toBeLessThanOrEqual(HELP_INDEX_MAX_TOKENS);
    expect(estimateTokens(renderHelpIndex(tree, "pages"))).toBeLessThanOrEqual(HELP_INDEX_MAX_TOKENS);
    expect(KNOWLEDGE_INDEX_LEVEL).toBe(chooseIndexLevel(tree));
    const extras = findHelpNode(tree, "extras-dia")!.page;
    expect(renderPageSections(extras)).toContain("extras-dia.md#separador-pressao-quando-e-que-aperta");
    expect(renderPageSections(extras)).toContain("pressao → ");
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
    expect(at("/financeiro")).toBe("entrada.md");
    expect(at("/dashboard")).toBe("entrada.md");
    expect(at("/marketing/google-ads")).toBe("marketing.md");
    expect(at("/")).toBe("entrada.md");
    expect(pagesForPath(tree, "/nao-existe")).toEqual([]);
    expect(pagesForPath(tree, null)).toEqual([]);
    // a redireção existe mesmo no código
    expect(src("client/src/App.tsx")).toMatch(/path="\/marketing-dashboard">\s*\{\(\) => <Redirect to="\/marketing"/);
  });
});

// ─── Separadores = os do código ─────────────────────────────────────────────

/** Separadores que existem no código, por rota (constantes partilhadas ou os TabsTrigger da página). */
function codeTabs(route: string): string[] | null {
  const fromPage = (file: string) => [...src(`client/src/pages/${file}`).matchAll(/TabsTrigger value="([a-z0-9_-]+)"/g)].map((m) => m[1]);
  switch (route) {
    case "/operacional": return [...OPERATIONAL_TABS];
    case "/caixa": return [...CAIXA_TABS];
    case "/extras-dia": return fromPage("ExtrasDiaPage.tsx");
    case "/avaliacao": return fromPage("AvaliacaoPage.tsx");
    case "/despesas": return fromPage("ExpensesPage.tsx");
    case "/parcerias": return fromPage("PartnershipsPage.tsx");
    case "/pessoas/condutores-agentes": return fromPage("CondutoresAgentesPage.tsx");
    case "/dashboards": return fromPage("DashboardsPage.tsx");
    case "/definicoes": return fromPage("DefinicoesPage.tsx");
    case "/formacao": return fromPage("TrainingPage.tsx");
    case "/operacoes": return fromPage("OperacoesPage.tsx");
    case "/faturacao": return fromPage("InvoicesPage.tsx");
    case "/api-keys": return fromPage("ApiKeysPage.tsx");
    default: return null;
  }
}

describe("separadores do cabeçalho existem no código", () => {
  const tree = buildHelpTree(readAjudaFiles());
  const withTabs = treePages(tree).filter((p) => p.tabs.length);

  it("há páginas com separadores (as do plano)", () => {
    expect(withTabs.map((p) => p.id)).toEqual(expect.arrayContaining(["operacional", "caixa", "extras-dia", "avaliacao", "despesas", "parcerias", "condutores-agentes", "dashboards"]));
    expect(codeTabs("/extras-dia")).toEqual(["dia", "pressao"]);
  });

  it.each(withTabs.map((p) => [p.file, p] as const))("%s", (_f, p) => {
    const known = p.routes.map(codeTabs).filter((x): x is string[] => !!x);
    expect(known.length, `${p.file}: nenhuma rota com separadores conhecidos no teste`).toBeGreaterThan(0);
    const all = new Set(known.flat());
    for (const t of p.tabs) expect(all.has(t.tab), `${p.file}: separador "${t.tab}" não existe no código`).toBe(true);
  });
});
