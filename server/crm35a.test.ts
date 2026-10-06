/**
 * P3 lote 35a — CRM (Jorge, 6 out 2026): "na parte do CRM só os clientes
 * estão em cartão e todos têm que ter essa opção: os Pros, os parceiros,
 * todos."
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("35a — Cartões / Lista em todos os separadores do CRM", () => {
  it("Clientes continua com o seu botão", () => {
    expect(src("client/src/pages/CrmClientsPage.tsx")).toContain("<ViewToggle value={s.view} onChange={(v) => patch({ view: v })} />");
  });

  it("Pro, Agregadores e agências e Parcerias: o mesmo botão, a escolha guardada por separador, cartões por omissão", () => {
    const pro = src("client/src/components/crm/ProAccountsPanel.tsx");
    expect(pro).toContain('useViewPref("crm-pro", "cards")');
    expect(pro).toContain("<ViewToggle value={view} onChange={setView}");
    expect(pro).toContain('view === "cards" && (');
    expect(pro).toContain('view === "list" && (');
    const p = src("client/src/components/crm/PartnersPanels.tsx");
    expect(p).toContain('useViewPref("crm-partners", "cards")');
    expect(p).toContain('useViewPref("crm-parks", "cards")');
    expect(p.match(/<ViewToggle value=\{view\} onChange=\{setView\}/g)?.length).toBe(2);
    expect(p.match(/view === "cards" && \(/g)?.length).toBe(2);
    expect(p.match(/view === "list" && \(/g)?.length).toBe(2);
  });

  it("os cartões abrem o mesmo que a linha da lista", () => {
    const pro = src("client/src/components/crm/ProAccountsPanel.tsx");
    expect(pro.match(/navigate\(`\/clientes\/\$\{r\.crmClientId\}`\)/g)?.length).toBeGreaterThanOrEqual(2);
    const p = src("client/src/components/crm/PartnersPanels.tsx");
    expect(p.match(/navigate\(`\/clientes\/parceiros\/\$\{encodeURIComponent\(r\.userId\)\}`\)/g)?.length).toBe(2);
    expect(p.match(/navigate\(`\/clientes\/parques\/\$\{encodeURIComponent\(r\.id\)\}`\)/g)?.length).toBe(2);
    // mesma grelha e caixa dos Clientes
    const ui = src("client/src/components/crm/crmUi.tsx");
    expect(ui).toContain('export const CARD_GRID = "grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4"');
  });
});
