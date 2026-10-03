/**
 * P3 lote 20d — Hub/entrada: página de erro do login sem XSS, _diag só super
 * admin, entradas registadas, sem ciclo de login, Perfil aberto a todos,
 * "Sem acesso" em vez de saltos, erro ≠ zero no Dashboard e no sino, links do
 * calendário certos, ErrorBoundary em português.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { escapeHtml, maskEmailForLog, renderErrorPage } from "./_core/oauth";
import { allowedWithoutCostCenter, decideRoute, isPersonalRoute, routeBase } from "../shared/routeAccess";
import { cityDayEvent, shiftEvent } from "../shared/googleSync";

const read = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

describe("20d página de erro do login", () => {
  it("tudo escapado: um <script> na query nunca entra como HTML", () => {
    const html = renderErrorPage("<b>t</b>", `x"><script>alert(1)</script>`, "<img src=x onerror=alert(1)>");
    expect(html).not.toMatch(/<script>alert/);
    expect(html).not.toMatch(/<img src=x/);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(escapeHtml(`'"<>&\``)).toBe("&#39;&quot;&lt;&gt;&amp;&#96;");
  });
  it("o erro da Google só mostra um código com a forma certa; CSP sem scripts; sem detalhes internos", () => {
    const src = read("server/_core/oauth.ts");
    expect(src).toMatch(/\/\^\[a-z_\]\{1,64\}\$\/\.test\(googleError\) \? googleError : "desconhecido"/);
    expect(src).toMatch(/default-src 'none'; style-src 'unsafe-inline'/);
    expect(src).not.toMatch(/`\$\{msg\}\\n\\nVerifica/);
    expect(src).toMatch(/Se voltar a acontecer, avisa o administrador com esta referência: \$\{ref\}/);
    expect(src).not.toMatch(/res\.status\(\d+\)\.type\("html"\)\.send\(\s*renderErrorPage/);
  });
  it("_diag só para o super admin; entradas e recusas nos logs; emails mascarados no log do servidor", () => {
    const src = read("server/_core/oauth.ts");
    expect(src).toMatch(/allowed = \(await sdk\.authenticateRequest\(req\)\)\?\.role === "super_admin"/);
    expect(src).toMatch(/action: "login", entityId: account\.id/);
    expect((src.match(/action: "login_denied"/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(src).not.toMatch(/Acesso recusado <\$\{email \|\| "sem email"\}>/);
    expect(maskEmailForLog("rita.santos@multipark.pt")).toBe("ri***@multipark.pt");
    expect(maskEmailForLog("")).toBe("sem email");
  });
});

describe("20d sem ciclo de login", () => {
  it("os filtros globais só pedem dados protegidos depois de haver sessão", () => {
    const ctx = read("client/src/contexts/GlobalFiltersContext.tsx");
    expect(ctx).toMatch(/const needsSession = !isPublicPath\(location\) && !!me\.data;/);
  });
  it("com ?auth=denied o 401 não manda outra vez para a Google", () => {
    const main = read("client/src/main.tsx");
    expect(main).toMatch(/get\(AUTH_DENIED_PARAM\) === AUTH_DENIED_VALUE\) return;/);
  });
  it("falhar a verificar a sessão ≠ 'entra'", () => {
    expect(read("client/src/pages/Home.tsx")).toMatch(/Não foi possível verificar a sessão/);
    expect(read("client/src/components/DashboardLayout.tsx")).toMatch(/sessionCheckFailed \? "Não foi possível verificar a sessão"/);
  });
});

describe("20d que ecrã abre para quem", () => {
  const menu = new Set(["/dashboard", "/rh", "/tarefas", "/extras-dia", "/disponibilidade", "/logs"]);
  const decide = (path: string, allowed: string[], lowRole: boolean) =>
    decideRoute({ path, allowedPaths: new Set(allowed), allMenuPaths: menu, lowRole, firstAllowed: allowed[0] ?? "/rh" });
  it("o Perfil e o Menu abrem para um extra (antes era empurrado para fora)", () => {
    expect(decide("/perfil", ["/rh", "/disponibilidade"], true)).toEqual({ kind: "ok" });
    expect(decide("/modulos", ["/rh"], true)).toEqual({ kind: "ok" });
    expect(isPersonalRoute("/perfil?tab=x")).toBe(true);
  });
  it("ecrã do menu que não é para a pessoa → 'Sem acesso' (não salta em silêncio); entrada → o primeiro dela", () => {
    expect(decide("/extras-dia", ["/rh", "/disponibilidade"], true)).toEqual({ kind: "no_access" });
    expect(decide("/logs", ["/dashboard", "/tarefas"], false)).toEqual({ kind: "no_access" });
    expect(decide("/dashboard", ["/rh"], true)).toEqual({ kind: "redirect", to: "/rh" });
    expect(decide("/", ["/tarefas"], false)).toEqual({ kind: "redirect", to: "/tarefas" });
    expect(decide("/rh/123", ["/rh"], true)).toEqual({ kind: "ok" });
    expect(decide("/clientes/5", ["/dashboard"], false)).toEqual({ kind: "ok" });
    expect(routeBase("/rh/123?x=1")).toBe("/rh");
  });
  it("sem centro de custos abrem o perfil, a ficha, a disponibilidade e a avaliação (o que o servidor deixa)", () => {
    for (const p of ["/perfil", "/rh", "/disponibilidade", "/avaliacao"]) expect(allowedWithoutCostCenter(p)).toBe(true);
    expect(allowedWithoutCostCenter("/reclamacoes")).toBe(false);
    const layout = read("client/src/components/DashboardLayout.tsx");
    expect(layout).toMatch(/filters\.accessError && !allowedWithoutCostCenter\(location\)/);
    expect(layout).toMatch(/<NoAccessScreen /);
  });
  it("ecrãs de bloqueio têm 'Sair'", () => {
    const layout = read("client/src/components/DashboardLayout.tsx");
    expect((layout.match(/>Sair<\/Button>/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe("20d erro ≠ zero", () => {
  it("Dashboard: cada cartão diz 'não carregou' (ou 'sem acesso'); atalhos pela matriz", () => {
    const page = read("client/src/pages/DashboardPage.tsx");
    expect(page).toMatch(/Não carregou · tentar de novo/);
    expect((page.match(/failed=\{/g) ?? []).length).toBe(10);
    expect(page).toMatch(/const modules = dashboardModules\.filter\(\(m\) => can\(user as any, m\.module, "view"\)\)/);
  });
  it("sino: erro ≠ 'Sem notificações'", () => {
    expect(read("client/src/components/DashboardLayout.tsx")).toMatch(/what="as notificações"/);
  });
  it("ErrorBoundary em português, sem stack, por página, com 'versão nova'", () => {
    const eb = read("client/src/components/ErrorBoundary.tsx");
    expect(eb).not.toMatch(/An unexpected error occurred/);
    expect(eb).not.toMatch(/error\?\.stack/);
    expect(eb).toMatch(/Há uma versão nova da aplicação/);
    expect(read("client/src/components/DashboardLayout.tsx")).toMatch(/<ErrorBoundary compact resetKey=\{location\}>/);
    expect(read("client/src/main.tsx")).toMatch(/vite:preloadError/);
  });
});

describe("20d links e saltos", () => {
  const row = { id: 1, version: 1, assignmentDate: "2026-10-05", city: "lisbon", startHour: 8, endHour: 16, sentHomeHour: null, isTeamLeader: 0, personName: "Ana" } as any;
  it("turno de um extra → Disponibilidade; TL e escala do dia → ?dia=", () => {
    expect(shiftEvent(row, "https://app").link).toBe("https://app/disponibilidade");
    expect(shiftEvent({ ...row, isTeamLeader: 1 }, "https://app").link).toBe("https://app/extras-dia?dia=2026-10-05");
    expect(cityDayEvent("2026-10-05", "lisbon", [row], "https://app")?.link).toBe("https://app/extras-dia?dia=2026-10-05");
    expect(read("client/src/pages/ExtrasDiaPage.tsx")).toMatch(/qs\.get\("dia"\) \?\? qs\.get\("date"\)/);
    const handover = read("client/src/pages/ShiftHandoverPage.tsx");
    expect(handover).toMatch(/get\("city"\) \|\| localStorage\.getItem\(LAST_CITY_KEY\)/);
    expect(handover).toMatch(/get\("date"\);\s*\n\s*if \(d && \/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(d\) && d <= maxDate\) return d;/);
  });
  it("notificação para a página já aberta volta a montá-la; sair apaga as pesquisas recentes", () => {
    expect(read("client/src/components/DashboardLayout.tsx")).toMatch(/if \(n\.link\) jumpTo\(n\.link, setLocation\);/);
    expect(read("client/src/components/GlobalSearch.tsx")).toMatch(/else jumpTo\(href, navigate\);/);
    expect(read("client/src/_core/hooks/useAuth.ts")).toMatch(/localStorage\.removeItem\(RECENT_SEARCHES_KEY\)/);
  });
  it("PWA: ícones quadrados certos e arranque em '/'", () => {
    const m = JSON.parse(read("client/public/manifest.webmanifest"));
    expect(m.start_url).toBe("/");
    expect(m.icons.map((i: any) => `${i.src} ${i.sizes} ${i.purpose}`)).toEqual([
      "/icon-192.png 192x192 any", "/icon-512.png 512x512 any", "/icon-maskable-512.png 512x512 maskable",
    ]);
    for (const f of ["icon-192.png", "icon-512.png", "icon-maskable-512.png"]) expect(fs.existsSync(path.join(__dirname, "..", "client/public", f))).toBe(true);
  });
});
