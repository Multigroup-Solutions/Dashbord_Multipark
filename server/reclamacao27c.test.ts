/**
 * P3 lote 27c — Jorge (5 out 2026): "sim" ao ponto 2 do #245. Na ficha da
 * reclamação as leituras repetem só 2 vezes as falhas passageiras e nunca
 * repetem sem permissão / pedido inválido (antes: 3 repetições por omissão do
 * React Query → 4 leituras pesadas da BD da Multipark por cada abertura).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { retryTransient } from "../client/src/lib/queryRetry";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const err = (code: string) => ({ data: { code } });

describe("27c — repetições na ficha da reclamação", () => {
  it("falha passageira: mais 2 vezes; sem permissão / inválido: nenhuma", () => {
    expect([0, 1, 2].map((n) => retryTransient(n, err("INTERNAL_SERVER_ERROR")))).toEqual([true, true, false]);
    for (const c of ["FORBIDDEN", "UNAUTHORIZED", "BAD_REQUEST"]) expect(retryTransient(0, err(c))).toBe(false);
  });

  it("todas as leituras da ficha usam retryTransient", () => {
    const page = src("client/src/pages/ComplaintsPage.tsx");
    expect(page).toContain('import { retryTransient } from "@/lib/queryRetry";');
    expect(page).toContain("trpc.complaints.getById.useQuery({ id }, { retry: retryTransient })");
    for (const q of ["vehicleHistory", "bookingTimeline", "bookingDossier", "vehicleAgents", "findDriversOnDuty", "listAttachedDrivers"]) {
      const at = page.indexOf(`trpc.complaints.${q}.useQuery(`);
      expect(at, q).toBeGreaterThan(0);
      expect(page.slice(at, at + 400), q).toContain("retry: retryTransient");
    }
    const lf = src("client/src/pages/lostFound/DetailView.tsx");
    const at = lf.indexOf("trpc.lostFound.vehicleAgents.useQuery(");
    expect(lf.slice(at, at + 400)).toContain("retry: retryTransient");
  });
});
