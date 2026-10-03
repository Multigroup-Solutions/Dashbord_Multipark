/**
 * P3 lote 26b — D7: onde a IA corre, página a página.
 *  - inventário (docs/ia-inventario.md) e docs/ia.md cobrem TODOS os
 *    interruptores do catálogo (uma funcionalidade nova sem documentação falha aqui);
 *  - IBAN lido pela IA nos documentos do RH respeita o D49 (pedido ao RH);
 *  - quiz a partir de um manual com o texto tapado (redactPii);
 *  - ajuda para o Multis responder "onde é que a IA trabalha".
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AI_FEATURES } from "../shared/aiFeatures";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const flags = [...new Set(Object.values(AI_FEATURES).map((f) => f.flag).filter((f): f is NonNullable<typeof f> => !!f))];

describe("26b — inventário da IA", () => {
  it("o inventário e a tabela do docs/ia.md têm todos os interruptores da IA", () => {
    const inv = src("docs/ia-inventario.md");
    const ia = src("docs/ia.md");
    expect(flags.length).toBeGreaterThanOrEqual(28);
    for (const f of flags) {
      expect(inv, f).toContain(`\`${f}\``);
      expect(ia, f).toContain(`| \`${f}\` |`);
    }
    expect(ia).toContain("[`docs/ia-inventario.md`](ia-inventario.md)");
  });

  it("inventário: quando, quem vê, dados e o que faz sozinha; docs/ia.md sem agendamentos antigos", () => {
    const inv = src("docs/ia-inventario.md");
    for (const h of ["| O quê | Quando | Quem vê |", "## O que a IA faz sozinha"]) expect(inv).toContain(h);
    const ia = src("docs/ia.md");
    expect(ia).not.toContain("06:32 e 07:32 UTC");
    expect(ia).not.toContain("Business Profile (a cada 10 min)");
    expect(ia).not.toContain("(`.github/workflows/ai-comms.yml`, a cada 15 min)");
    expect(ia).toContain("a partir das 07:30 de Lisboa");
  });

  it("ajuda do Multis: onde é que a IA trabalha", () => {
    const help = src("docs/ajuda/ia-no-dashboard.md");
    expect(help).toMatch(/^---\nmodulo: ia\n/);
    expect(help).toContain("**Sozinha (automática)**");
    expect(help).toContain("**Começam desligadas**");
    expect(src("server/assistant/helpDocs.generated.ts")).toContain("ia-no-dashboard.md");
  });
});

describe("26b — correções", () => {
  it("D49: o IBAN lido pela IA só entra na hora para quem o muda na hora; os outros ficam com pedido", () => {
    const r = src("server/rhRouter.ts");
    expect(r.match(/const ibanDirect = canChangeIbanDirectly\(await rhViewer\(ctx\.user\), await rhEmployeeRefOrThrow\(input\.employeeId\)\);/g)?.length).toBe(2);
    expect(r.match(/userId: ctx\.user\.id, ibanDirect \}\)/g)?.length).toBe(2);
    expect(r).toContain("if (r.skipped || r.ibanRequested) break;");
    const a = src("server/documentAutofill.ts");
    expect(a).toContain("if (plan.patch.nib && !opts.ibanDirect)");
    expect(a).toContain("await createBankChangeRequest(opts.employeeId, iban, opts.userId)");
  });

  it("quiz do manual: o texto vai com redactPii e os marcadores saem das perguntas", () => {
    const t = src("server/trainingAttempts.ts");
    const fn = t.slice(t.indexOf("export async function generateQuizDrafts"));
    expect(fn).toContain("quizInstruction(m.title, red.text, n)");
    expect(fn).toContain("question: red.strip(q.question)");
  });
});
