/**
 * P3 lote 17g (parte 4) — Leads de Extras com tudo junto (Jorge, 2 out 2026:
 * "isto deve aparecer tudo junto na parte das leads extras e a parte de
 * recrutamento que está nos RH também vai para lá"): leads, candidaturas do
 * site e emails de recrutamento em três separadores; saem da Disponibilidade
 * e do RH.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("Leads de Extras: três separadores", () => {
  const page = src("client/src/pages/ExtraLeadsPage.tsx");
  it("leads, candidaturas do site (com as novas) e recrutamento; ?tab= abre o certo", () => {
    expect(page).toContain('const LEADS_TABS = ["leads", "candidaturas", "recrutamento"] as const;');
    expect(page).toContain('<TabsContent value="candidaturas" className="mt-4"><CandidaturasSection /></TabsContent>');
    expect(page).toContain('<TabsContent value="recrutamento" className="mt-4"><RecruitmentSection /></TabsContent>');
    expect(page).toContain('trpc.driverApplications.list.useQuery({ status: "new" }');
  });
  it("as candidaturas têm componente próprio (a página dos leads não carrega a Extras Dia)", () => {
    expect(src("client/src/components/CandidaturasSection.tsx")).toContain("export function CandidaturasSection()");
    expect(page).not.toContain("@/pages/ExtrasDiaPage");
    expect(src("client/src/pages/ExtrasDiaPage.tsx")).not.toContain("export function CandidaturasSection()");
  });
});

describe("Saem da Disponibilidade e do RH", () => {
  it("Disponibilidade: sem candidaturas nem recrutamento, com o link para os Leads", () => {
    const d = src("client/src/pages/DisponibilidadePage.tsx");
    expect(d).not.toContain("<CandidaturasSection />");
    expect(d).not.toContain("<RecruitmentSection />");
    expect(d).toContain('href="/extras-leads?tab=candidaturas"');
  });
  it("RH: sem o separador Recrutamento (quem o tinha aberto volta aos colaboradores)", () => {
    const h = src("client/src/pages/HRPage.tsx");
    expect(h).not.toContain('<TabsTrigger value="recrutamento">');
    expect(h).not.toContain("<RecruitmentSection />");
    expect(h).toContain('useEffect(() => { if (activeTab === "recrutamento") setActiveTab("employees"); }, [activeTab, setActiveTab]);');
  });
  it("as rotas do recrutamento já são da permissão dos leads", () => {
    const r = src("server/rhRouter.ts");
    const i = r.indexOf("recruitmentEmails: protectedProcedure");
    expect(r.slice(i, i + 300)).toContain('requireAccess(ctx.user, "leads_extras", "view");');
  });
});
