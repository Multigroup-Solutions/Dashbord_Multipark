import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";

// O relatório anual antigo (annual_reports com divisão parceiro/empresa,
// calculado à parte das Finanças) saiu a 2 out 2026: nenhum ecrã o usava e o
// Anual é o motor das Finanças. A tabela e os dados ficam (a árvore de
// projetos ainda os conta como referências).

const procedures = Object.keys((appRouter as any)._def.procedures as Record<string, unknown>);

describe("Anual: só o motor das Finanças", () => {
  it("as rotas do relatório antigo saíram; ficam o breakdown e o histórico importado", () => {
    for (const p of ["annual.list", "annual.generate", "annual.update", "annual.delete"]) expect(procedures, p).not.toContain(p);
    for (const p of ["annual.breakdown", "annual.importHistory", "annual.historyList", "annual.historyDeleteYear"]) expect(procedures, p).toContain(p);
  });

  it("o cálculo antigo saiu do db.ts, mas a tabela (e os dados) ficam", () => {
    const db = readFileSync(resolve(import.meta.dirname, "db.ts"), "utf8");
    for (const fn of ["generateAnnualSummary", "getAnnualReports", "createAnnualReport", "updateAnnualReport", "deleteAnnualReport"]) {
      expect(db, fn).not.toContain(`export async function ${fn}(`);
    }
    expect(readFileSync(resolve(import.meta.dirname, "..", "drizzle/schema.ts"), "utf8")).toContain('mysqlTable("annual_reports"');
    expect(readFileSync(resolve(import.meta.dirname, "..", "shared/projectTree.ts"), "utf8")).toContain('table: "annual_reports"');
  });
});
