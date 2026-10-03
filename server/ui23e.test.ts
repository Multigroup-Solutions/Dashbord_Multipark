/**
 * P3 lote 23e — pedidos do Jorge com capturas (3 out 2026):
 *  - Críticas: sai o cartão "Ligação Google Business Profile" (e o aviso da
 *    quota) — passa para Integrações; saem os separadores Condutores e Agentes;
 *  - Condutores e Agentes passam para Pessoas → "Condutores e agentes";
 *  - pesquisas e filtros: fundo branco e borda azul (só esses; os formulários
 *    ficam como estão).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("Críticas sem a ligação Google nem Condutores/Agentes", () => {
  const page = src("client/src/pages/GoogleReviewsPage.tsx");
  it("a página das Críticas já não mostra a ligação Google Business nem os dois separadores", () => {
    expect(page).not.toMatch(/GoogleBusinessConnection/);
    expect(page).not.toMatch(/value="drivers"|value="agents"|CheckoutDriversPanel|AgentPerformancePanel/);
    expect(page).toMatch(/<TabsTrigger value="dashboard">/);
    expect(page).toMatch(/<TabsTrigger value="list">/);
  });

  it("a ligação Google Business passou para Integrações (com âncora) e os links apontam para lá", () => {
    const hub = src("client/src/pages/IntegrationsHubPage.tsx");
    expect(hub).toMatch(/<div id="google-business"[^>]*><GoogleBusinessConnection \/><\/div>/);
    expect(src("server/integrations/alerts.ts")).toMatch(/google_business: \{ label: "Google Business Profile", link: "\/integracoes#google-business" \}/);
    expect(src("server/integrationsStatus.ts")).toMatch(/href: "\/integracoes#google-business"/);
    expect(src("server/integrationsStatus.ts")).not.toMatch(/\/criticas#google-business/);
    // o próprio cartão continua a mostrar-se só a admin/super admin com todas as cidades
    expect(src("client/src/components/GoogleBusinessConnection.tsx")).toMatch(/\['admin', 'super_admin'\]\.includes\(user\.role\) \|\| !access\?\.all\) return null;/);
  });
});

describe("Pessoas → Condutores e agentes", () => {
  it("página nova com os dois separadores, rota e entrada no menu Pessoas (mesmo acesso: Críticas)", () => {
    const p = src("client/src/pages/CondutoresAgentesPage.tsx");
    expect(p).toMatch(/export default function CondutoresAgentesPage/);
    expect(p).toMatch(/<TabsTrigger value="drivers">/);
    expect(p).toMatch(/<TabsTrigger value="agents">/);
    expect(p).toMatch(/function CheckoutDriversPanel\(\)/);
    expect(p).toMatch(/function AgentPerformancePanel\(\)/);
    expect(p).toMatch(/can\(user as any, "criticas", "view"\)/);
    expect(src("client/src/App.tsx")).toMatch(/<Route path="\/pessoas\/condutores-agentes">\s*\{\(\) => \(<DashboardLayout><CondutoresAgentesPage \/><\/DashboardLayout>\)\}/);
    const layout = src("client/src/components/DashboardLayout.tsx");
    const pessoas = layout.slice(layout.indexOf('label: "Pessoas"'), layout.indexOf('label: "Operações"'));
    expect(pessoas).toMatch(/\{ icon: Car, label: "Condutores e agentes", path: "\/pessoas\/condutores-agentes", module: "criticas" \}/);
    expect(src("docs/ajuda/condutores-agentes.md")).toMatch(/rotas: \/pessoas\/condutores-agentes/);
  });
});

describe("Pesquisas e filtros: fundo branco e borda azul", () => {
  const css = src("client/src/index.css");
  it("regra global só para pesquisas/filtros (placeholder, type=search, lupa ao lado, .mp-filter), no modo claro", () => {
    expect(css).toMatch(/:root:not\(\.dark\) input\[data-slot="input"\]:is\(\[type="search"\], \[placeholder\^="Pesquisar" i\], \[placeholder\^="Procurar" i\], \[placeholder\^="Filtrar" i\], \[placeholder\^="Buscar" i\]\)/);
    expect(css).toMatch(/:root:not\(\.dark\) :has\(> svg\.lucide-search\) > input\[data-slot="input"\]/);
    expect(css).toMatch(/:root:not\(\.dark\) \.mp-filter \{\s*background-color: #ffffff;\s*border-color: var\(--primary\);/);
  });
  it("botões de contorno brancos com borda azul; os principais continuam azuis cheios", () => {
    const b = src("client/src/components/ui/button.tsx");
    expect(b).toMatch(/outline:\s*"border border-primary bg-white shadow-xs hover:bg-accent dark:bg-transparent dark:border-input dark:hover:bg-input\/50"/);
    expect(b).toMatch(/default: "bg-primary text-primary-foreground hover:bg-primary\/90"/);
  });
  it("o campo base (formulários) não mudou", () => {
    expect(src("client/src/components/ui/input.tsx")).toMatch(/border-input h-9 w-full min-w-0 rounded-md border bg-transparent/);
  });
});
