/**
 * Plano 05 — o lado do cliente da conta Multipark (be-shared):
 *  - página de entrada: "Entrar com a conta Multipark" só com auth.shared.options ligado;
 *  - perfil: cartão "Conta Multipark" (escondido sem os interruptores);
 *  - Sistema → "Identidade partilhada": só super admin e só com SHARED_AUTH_LINK/LOGIN;
 *  - /ligar-conta-multipark/:token abre sem sessão e só liga com "Confirmar".
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isPublicPath } from "../shared/loginReturn";
import { menuFlagsFrom } from "../shared/menuFlags";
import { SHARED_LINK_METHOD_LABEL, sharedRefusal } from "../shared/sharedIdentity";
import {
  accessRequestCandidates, backfillSummary, filterIdentityRows, identityCounts, identityCsv, identityReadiness, linkMethodLabel, pageOf,
  type IdentityRow,
} from "../shared/sharedIdentityView";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const row = (o: Partial<IdentityRow> & { id: number }): IdentityRow => ({
  name: null, email: null, role: "user", isActive: true, hasFicha: false, lastSignedIn: null,
  sharedUserId: null, linkMethod: null, linkedAt: null, proposal: null, ...o,
});

const ROWS: IdentityRow[] = [
  row({ id: 1, name: "João Alves", email: "joao@multipark.pt", role: "admin", sharedUserId: "s1", linkMethod: "proposal", linkedAt: "2026-10-10T10:00:00.000Z", hasFicha: true }),
  row({ id: 2, name: "Ana Maria", email: "ana@gmail.com", proposal: { sharedEmail: "ana@multipark.pt", expiresAt: "2026-10-17T09:00:00.000Z" } }),
  row({ id: 3, name: "Sem Email", email: null, isActive: false }),
  row({ id: 4, name: "Pedro Silva", email: "pedro@x.pt", role: "condutor" }),
];

describe("filtros, contagens e páginas", () => {
  it("cada filtro conta o que deve", () => {
    expect(identityCounts(ROWS)).toEqual({ all: 4, linked: 1, unlinked: 3, proposal: 1, no_email: 1 });
  });
  it("pesquisa sem acentos, por email da proposta e por #id; ativas primeiro", () => {
    expect(filterIdentityRows(ROWS, { filter: "all", search: "joao alv" }).map((r) => r.id)).toEqual([1]);
    expect(filterIdentityRows(ROWS, { filter: "all", search: "ana@multipark" }).map((r) => r.id)).toEqual([2]);
    expect(filterIdentityRows(ROWS, { filter: "all", search: "#4" }).map((r) => r.id)).toEqual([4]);
    const unlinked = filterIdentityRows(ROWS, { filter: "unlinked", search: "" });
    expect(unlinked.map((r) => r.id)).toEqual([2, 4, 3]); // ativas pelo nome; a inativa no fim
    expect(unlinked[unlinked.length - 1].isActive).toBe(false);
    expect(filterIdentityRows(ROWS, { filter: "no_email", search: "" }).map((r) => r.id)).toEqual([3]);
    expect(filterIdentityRows(ROWS, { filter: "proposal", search: "" }).map((r) => r.id)).toEqual([2]);
  });
  it("páginas: limita o índice e dá pelo menos 1 página", () => {
    const list = Array.from({ length: 120 }, (_, i) => i);
    expect(pageOf(list, 0, 50)).toMatchObject({ page: 0, pages: 3 });
    expect(pageOf(list, 2, 50).items).toHaveLength(20);
    expect(pageOf(list, 9, 50).page).toBe(2);
    expect(pageOf([], 3, 50)).toEqual({ items: [], page: 0, pages: 1 });
  });
});

describe("rótulos, CSV e resumos", () => {
  it("como ficou ligada: o rótulo partilhado com o servidor", () => {
    expect(linkMethodLabel("proposal")).toBe(SHARED_LINK_METHOD_LABEL.proposal);
    expect(linkMethodLabel("novo_metodo")).toBe("novo_metodo");
    expect(linkMethodLabel(null)).toBe("—");
  });
  it("CSV com ; seguro (fórmulas neutralizadas) e datas de Lisboa", () => {
    const csv = identityCsv(ROWS, (r) => (r === "admin" ? "Admin" : r));
    const lines = csv.split("\n");
    expect(lines[0]).toBe("ID;Nome;Email;Papel;Ativo;Ficha;Ligada;Como;Ligada em;Proposta para;Proposta expira");
    expect(lines[1]).toBe(`1;João Alves;joao@multipark.pt;Admin;sim;sim;sim;${SHARED_LINK_METHOD_LABEL.proposal};10/10/2026;;`);
    expect(lines[2]).toContain(";ana@multipark.pt;17/10/2026");
    expect(lines[4]).toContain(";Pedro Silva;pedro@x.pt;condutor;sim;não;não;;;;");
    expect(csv).not.toContain("s1"); // o id da conta Multipark não sai
    expect(identityCsv([row({ id: 9, name: "=HYPERLINK(1);x" })], (r) => r)).toContain(`"'=HYPERLINK(1);x"`);
  });
  it("backfill → números do ecrã", () => {
    expect(backfillSummary({ checked: 10, candidates: [1, 2, 3], linked: [1], mismatches: [1, 2], errors: 1 }))
      .toEqual({ checked: 10, confirmed: 3, linked: 1, mismatches: 2, errors: 1 });
  });
  it("o ecrã só age com um interruptor ligado E o be-shared configurado", () => {
    expect(identityReadiness({ flags: { link: false, login: false }, configured: false })).toEqual({ ready: false, missing: ["switches", "config"] });
    expect(identityReadiness({ flags: { link: true, login: false }, configured: false })).toEqual({ ready: false, missing: ["config"] });
    expect(identityReadiness({ flags: { link: false, login: true }, configured: true })).toEqual({ ready: true, missing: [] });
  });
  it("pedidos de acesso: só contas por ligar, a do mesmo email primeiro", () => {
    const c = accessRequestCandidates(ROWS, "PEDRO@x.pt ");
    expect(c.map((r) => r.id)).toEqual([4, 2, 3]); // o do mesmo email, depois as ativas, a inativa no fim
    expect(c.some((r) => r.sharedUserId)).toBe(false);
  });
});

describe("menu: só super admin e só com os interruptores", () => {
  it("o item fica escondido sem resposta, com tudo desligado, e aparece com qualquer dos dois", () => {
    expect(menuFlagsFrom(undefined).size).toBe(0);
    expect(menuFlagsFrom([{ name: "SHARED_AUTH_LINK", effective: false }, { name: "SHARED_AUTH_LOGIN", effective: false }]).size).toBe(0);
    expect(menuFlagsFrom([{ name: "SHARED_AUTH_LINK", effective: true }]).has("sharedIdentity")).toBe(true);
    expect(menuFlagsFrom([{ name: "SHARED_AUTH_LOGIN", effective: true }, { name: "OUTRO", effective: true }]).has("sharedIdentity")).toBe(true);
  });
  it("o item do menu é super_admin + flag, e o canSeeItem respeita a flag", () => {
    const layout = src("client/src/components/DashboardLayout.tsx");
    expect(layout).toContain(`{ icon: Fingerprint, label: "Identidade partilhada", path: "/utilizadores/identidade-partilhada", module: "utilizadores", roles: ["super_admin"], flag: "sharedIdentity" },`);
    expect(layout).toContain("if (item.flag && !flagsOn?.has(item.flag)) return false;");
    expect(layout).toContain("getFilteredHubGroups(user ?? userRole, menuFlags)");
    expect(src("client/src/pages/ModulesPage.tsx")).toContain("getFilteredHubGroups(user ?? role, menuFlags)");
    expect(src("client/src/lib/menuFlags.ts")).toMatch(/enabled: superAdmin/);
  });
  it("a página pede os dados só ao super admin (o servidor também recusa)", () => {
    const page = src("client/src/pages/SharedIdentityPage.tsx");
    expect(page).toContain(`const isSuperAdmin = user?.role === "super_admin";`);
    expect(page).toMatch(/admin\.overview\.useQuery\(undefined, \{ enabled: isSuperAdmin/);
    expect(src("server/sharedIdentityRouter.ts")).toContain(`if (ctx.user?.role !== "super_admin") throw new TRPCError({ code: "FORBIDDEN"`);
  });
});

describe("rotas e página pública", () => {
  it("/ligar-conta-multipark/:token abre sem sessão; as outras não", () => {
    expect(isPublicPath("/ligar-conta-multipark/abcDEF_123-xyz0000000")).toBe(true);
    expect(isPublicPath("/ligar-conta-multipark")).toBe(true);
    expect(isPublicPath("/utilizadores/identidade-partilhada")).toBe(false);
    const app = src("client/src/App.tsx");
    expect(app).toContain(`<Route path="/ligar-conta-multipark/:token" component={SharedLinkConfirmPage} />`);
    // fora do DashboardLayout (como o convite) e o ecrã do super admin antes de /utilizadores
    expect(app.indexOf('path="/utilizadores/identidade-partilhada"')).toBeLessThan(app.indexOf('path="/utilizadores">'));
  });
  it("a confirmação nunca liga ao abrir: só a mutação no botão", () => {
    const page = src("client/src/pages/SharedLinkConfirmPage.tsx");
    expect(page).toContain("proposal.view.useQuery({ token }");
    expect(page).toContain("proposal.confirm.useMutation()");
    expect(page).not.toMatch(/useEffect/);
    expect(page).toMatch(/onClick=\{submit\}/);
    expect(page).toContain("Se não és esta pessoa, não confirmes");
    expect(page).toContain("Ligada. Já podes entrar no dashboard com a tua conta Multipark.");
    expect(sharedRefusal("expired")).toMatch(/expirou/);
  });
});

describe("entrada e perfil", () => {
  it("a página de entrada só mostra a conta Multipark com auth.shared.options ligado", () => {
    const home = src("client/src/pages/Home.tsx");
    expect(home).toContain("const sharedLogin = useSharedLoginOption();");
    expect(home).toContain(`const sharedStep = !choosingPassword && step === "conta-multipark" && sharedLogin === true;`);
    // os botões novos só com sharedLogin (desligado: a página é a de sempre)
    for (const m of home.matchAll(/\{sharedButton\}/g)) {
      const before = home.slice(Math.max(0, (m.index ?? 0) - 400), m.index);
      expect(before).toMatch(/sharedLogin/);
    }
    const form = src("client/src/components/login/SharedLoginForm.tsx");
    expect(form).toContain("trpc.auth.shared.login.useMutation()");
    expect(form).toContain("pdaToken: getPdaToken()");
    expect(form).toContain('href={SHARED_FORGOT_PASSWORD_URL} target="_blank" rel="noopener noreferrer"');
    expect(src("shared/sharedIdentityView.ts")).toContain(`"https://multipark.pt/pt-PT/forgot-password"`);
  });
  it("o cartão do perfil esconde-se sem os interruptores e não guarda a palavra-passe", () => {
    const card = src("client/src/components/login/SharedAccountCard.tsx");
    expect(card).toContain("if (!d?.enabled) return null;");
    expect(card).toContain("sharedIdentity.linkWithPassword.useMutation()");
    expect(card).not.toMatch(/localStorage|sessionStorage/);
    expect(src("client/src/pages/ProfilePage.tsx")).toContain("<SharedAccountCard email={user.email ?? null} />");
  });
});
