/**
 * P3 lote 25d — D46 (Jorge, 3 out 2026): tudo o que são contactos pode ver-se
 * em cartões (com foto) ou em lista, no telemóvel e no PC; a escolha fica no
 * aparelho, por página.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseViewMode, viewPrefKey, VIEW_MODE_LABELS } from "../shared/viewPref";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("D46 — cartões ou lista", () => {
  it("preferência por página no aparelho; lixo guardado = padrão", () => {
    expect(viewPrefKey("users")).toBe("mp.view.users");
    expect(parseViewMode("cards")).toBe("cards");
    expect(parseViewMode("list")).toBe("list");
    for (const x of ["grid", "", null, undefined, 1]) expect(parseViewMode(x)).toBeNull();
    expect(VIEW_MODE_LABELS).toEqual({ cards: "Cartões", list: "Lista" });
    const hook = src("client/src/hooks/useViewPref.ts");
    expect(hook).toContain("localStorage.getItem(storageKey)");
    expect(hook).toContain('window.innerWidth < 768 ? "cards" : "list"');
  });

  it("o mesmo botão em todas as listas de contactos (o escolhido a azul)", () => {
    expect(src("client/src/components/ViewToggle.tsx")).toContain('variant={value === v ? "selected" : "outline"}');
    const pages: Array<[string, string]> = [
      ["client/src/pages/UsersPage.tsx", 'useViewPref("users", "auto")'],
      ["client/src/pages/HRPage.tsx", 'useViewPref("hr", "cards")'],
      ["client/src/pages/ExtraLeadsPage.tsx", 'useViewPref("extra-leads", "auto")'],
      ["client/src/components/CandidaturasSection.tsx", 'useViewPref("candidaturas", "auto")'],
      ["client/src/pages/ContactsPage.tsx", 'useViewPref("contacts", "list")'],
      ["client/src/pages/ContactsPage.tsx", 'useViewPref("contacts-directory", "cards")'],
    ];
    for (const [p, needle] of pages) {
      const s = src(p);
      expect(s, p).toContain(needle);
      expect(s, p).toContain("<ViewToggle");
    }
    expect(src("client/src/pages/CrmClientsPage.tsx")).toContain("<ViewToggle value={s.view} onChange={(v) => patch({ view: v })} />");
  });

  it("utilizadores: a escolha vale no telemóvel e no PC (já não é md:hidden)", () => {
    const u = src("client/src/pages/UsersPage.tsx");
    expect(u).not.toContain('<div className="md:hidden divide-y">');
    expect(u).toContain('{view === "cards" && (');
    expect(u).toContain('{view === "list" && (');
  });

  it("RH ganha a lista; leads e candidaturas ganham os cartões (mesmas ações)", () => {
    const hr = src("client/src/pages/HRPage.tsx");
    expect(hr).toContain('hrView === "list" ? renderTable(employeesList)');
    expect(hr).toContain('hrView === "list" ? renderTable(extrasList)');
    const leads = src("client/src/pages/ExtraLeadsPage.tsx");
    expect(leads.match(/\{leadActions\(l\)\}/g)?.length).toBe(2);
    expect(leads.match(/\{statusSelect\(l\)\}/g)?.length).toBe(2);
    expect(leads).toContain("<ContactAvatar name={l.fullName} photoUrl={l.photoUrl}");
    const cand = src("client/src/components/CandidaturasSection.tsx");
    expect(cand.match(/\{appActions\(a\)\}/g)?.length).toBe(2);
    expect(cand.match(/\{appDetails\(a\)\}/g)?.length).toBe(2);
  });

  it("leads: a foto vem da ficha (só depois de convertido)", () => {
    const s = src("server/extraLeads.ts");
    expect(s).toContain("photoUrl: r.employeeId != null ? photos.get(r.employeeId) ?? null : null");
    expect(s).toContain("select({ id: employees.id, photoUrl: employees.photoUrl })");
  });
});
