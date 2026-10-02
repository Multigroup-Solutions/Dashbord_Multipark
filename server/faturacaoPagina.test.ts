import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Aceitação da Faturação (P2.3, 1 out 2026) — o que a página mostra.
const page = () => readFileSync(resolve(import.meta.dirname, "..", "client/src/pages/InvoicesPage.tsx"), "utf8");

describe("Faturação — página", () => {
  it("erro ≠ a carregar: falha da BD da Multipark ou falta de permissão mostra o porquê (antes rodava para sempre)", () => {
    const src = page();
    expect(src).toMatch(/error && !summary \? \(\s*\/\/[^\n]*\n\s*<LoadError message=\{error\.message\}/);
    expect(src).toContain("if (error && !cash) return <LoadError");
    expect(src).toContain("function LoadError(");
    // sem permissão não se repete o pedido; falha passageira tenta mais 2 vezes
    expect(src).toMatch(/count < 2 && !\["FORBIDDEN", "UNAUTHORIZED", "BAD_REQUEST"\]/);
  });

  it("a tabela da equipa do dia é a do ponto (a que soma o cartão), com total; a escala só como referência", () => {
    const src = page();
    expect(src).toContain("extrasReal.map((e, i) =>");
    expect(src).toContain("{fmt(summary.extrasDiaCost ?? 0)}");
    expect(src).toContain("Escala do Extras Dia no período (previsto, não soma)");
    expect(src).not.toMatch(/extrasDia\.map\(/);
  });
});

const diagnose = () => readFileSync(resolve(import.meta.dirname, "..", "client/src/pages/BillingDiagnosePage.tsx"), "utf8");

describe("Faturação → Diagnóstico — página", () => {
  it("o mês por omissão é o da Faturação (dias locais), não o toISOString que no verão recuava um dia", () => {
    const src = diagnose();
    expect(src).toContain('const month = rangeFor("month", new Date());');
    expect(src).not.toMatch(/toISOString\(\)\.slice\(0, 10\)/);
  });

  it("erro ≠ \"Sem dados.\": mostra o porquê e deixa tentar de novo", () => {
    const src = diagnose();
    expect(src).toMatch(/error && !data \? \(/);
    expect(src).toContain("Não foi possível fazer o diagnóstico.");
    expect(src).not.toContain("Sem dados.");
  });

  it("sem verificações que não verificam nada (leitura direta à BD da Multipark)", () => {
    const src = diagnose();
    expect(src).not.toContain("Duplicados em externalId");
    expect(src).not.toContain("+ checkOut IS NOT NULL");
    expect(src).not.toContain("cancelledAt");
    expect(src).not.toContain("b.campaign");
  });
});
