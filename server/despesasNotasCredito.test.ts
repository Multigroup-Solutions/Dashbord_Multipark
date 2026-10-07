/**
 * Notas de crédito nas Despesas (Jorge, 7 out 2026): documento próprio, ligado
 * à fatura, com valor negativo; nunca passa do que falta creditar.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CREDIT_NOTE_STATES, CREDIT_NOTE_STATE_LABELS, creditNoteError, creditNoteStoredAmount, creditedTotal, invoiceNet, isCreditNote } from "../shared/creditNotes";
import { accountantFileName, buildAccountantExport } from "../shared/accountantExport";
import { expenseTotals } from "../shared/expenseTotals";

const src = (p: string) => readFileSync(p, "utf8");
const invoice = { amount: "500.00", status: "paid", deletedAt: null, creditNoteOfId: null };

describe("regras das notas de crédito", () => {
  it("valor gravado negativo; escrito sempre positivo", () => {
    expect(creditNoteStoredAmount("45,90")).toBe("-45.90");
    expect(creditNoteStoredAmount("-5")).toBeNull();
    expect(creditNoteStoredAmount("0")).toBeNull();
  });
  it("nunca passa do que falta creditar; não em NC, eliminadas nem canceladas", () => {
    expect(creditNoteError(invoice, "120.00", 0)).toBeNull();
    expect(creditNoteError(invoice, "500.00", 0)).toBeNull();
    expect(creditNoteError(invoice, "380.01", 120)).toMatch(/não pode passar do que falta creditar na fatura \(380,00 €\)/);
    expect(creditNoteError({ ...invoice, creditNoteOfId: 9 }, "1.00", 0)).toMatch(/não leva outra nota de crédito/);
    expect(creditNoteError({ ...invoice, deletedAt: "2026-10-01" }, "1.00", 0)).toMatch(/eliminada/);
    expect(creditNoteError({ ...invoice, status: "cancelled" }, "1.00", 0)).toMatch(/cancelada/);
    expect(creditNoteError(invoice, null, 0)).toMatch(/Valor inválido/);
  });
  it("creditado e líquido; canceladas/eliminadas não contam", () => {
    expect(creditedTotal([{ amount: "-120.00", status: "paid" }, { amount: "-30.50", status: "paid" }, { amount: "-99", status: "cancelled" }, { amount: "-1", status: "paid", deletedAt: "x" }])).toBe(150.5);
    expect(invoiceNet("500.00", 150.5)).toEqual({ credited: 150.5, net: 349.5 });
    expect(isCreditNote({ creditNoteOfId: 3 })).toBe(true);
    expect(isCreditNote({ creditNoteOfId: null })).toBe(false);
    expect(CREDIT_NOTE_STATES.map((s) => CREDIT_NOTE_STATE_LABELS[s])).toEqual(["Por receber", "Recebida", "Abatida"]);
  });
  it("os totais da lista descontam a NC", () => {
    expect(expenseTotals([{ amount: "500.00", status: "paid" }, { amount: "-120.00", status: "paid" }]).total).toBe(380);
  });
});

describe("contabilista: a NC vai como documento próprio", () => {
  const nc = { id: 8, expenseDate: "2026-10-08", paidAt: "2026-10-08", supplier: "Peças SA", supplierNif: "500", documentNumber: "NC 15", description: null, amount: -120, fileKey: "invoices/1/nc.pdf", fileUrl: null, creditNote: true };
  it("nome com NC_ e folha com o tipo; o total desconta", () => {
    expect(accountantFileName(nc)).toMatch(/^NC_2026-10-08_Pe/);
    expect(accountantFileName(nc)).toContain("-120.00EUR_#8.pdf");
    const r = buildAccountantExport([nc, { ...nc, id: 7, documentNumber: "FT 9", amount: 500, creditNote: false, fileKey: "invoices/1/ft.pdf" }]);
    expect(r.sheet.map((x) => x.Tipo).sort()).toEqual(["Fatura", "Nota de crédito"]);
    expect(r.total).toBe(380);
  });
});

describe("servidor e ecrã", () => {
  it("migração 0520 só acrescenta e está registada; schema com as colunas", () => {
    const mig = src("server/migrations/migration_0520.ts");
    expect(mig).toMatch(/ADD COLUMN `creditNoteOfId` INT NULL/);
    expect(mig).toMatch(/ADD COLUMN `creditNoteState` VARCHAR\(12\) NULL/);
    expect(mig).not.toMatch(/DROP|DELETE/);
    expect(src("server/migrations/index.ts")).toMatch(/\["0520"/);
    expect(src("drizzle/schema.ts")).toMatch(/creditNoteOfId: int\(\),/);
  });
  it("criar: valida com a regra única, grava negativo, ligado à fatura, fora dos pendentes, com histórico", () => {
    const r = src("server/expensesRouter.ts");
    const block = r.split("creditNote: router({")[1]?.split("recurring: router({")[0] ?? "";
    expect(block).toMatch(/requireAccess\(ctx\.user, "despesas", "edit", \{ allowOwn: true \}\)/);
    expect(block).toMatch(/creditNoteError\(inv as any, positive, await otherCredited\(inv\.id\)\)/);
    expect(block).toMatch(/amount: `-\$\{positive\}`/);
    expect(block).toMatch(/creditNoteOfId: inv\.id/);
    expect(block).toMatch(/status: "paid"/);
    expect(block).toMatch(/type: "credit_note"/);
    expect(block).toMatch(/otherCredited\(inv\.expense\.id, nc\.id\)/);
    expect(block).not.toMatch(/DELETE FROM/);
  });
  it("o editar normal não mexe no valor nem no estado de uma NC", () => {
    expect(src("server/expensesRouter.ts")).toMatch(/É uma nota de crédito: o valor e o estado mudam-se no botão da nota de crédito\./);
  });
  it("a lista leva o creditado/líquido e a fatura de origem", () => {
    expect(src("server/expensesRouter.ts")).toMatch(/withCreditNoteInfo\(rows as any\[\]\)/);
    expect(src("server/expenseCreditNotes.ts")).toMatch(/creditNoteOfId IN \(/);
  });
  it("anomalias de despesas ignoram as NC; histórico do Financeiro aceita meses com NC", () => {
    expect(src("server/aiOps/anomalies.ts")).toMatch(/deletedAt IS NULL AND amount > 0/);
    expect(src("server/finance/compat.ts")).toMatch(/mo\.expensesWithVat !== 0/);
  });
  it("ecrã: botão na fatura, linha da NC com estado, creditado na fatura, diálogo", () => {
    const page = src("client/src/pages/ExpensesPage.tsx");
    expect(page).toMatch(/aria-label="Lançar nota de crédito"/);
    expect(page).toMatch(/function CreditNoteStateBadge/);
    expect(page).toMatch(/NC −\{fmtEur\(row\.creditNote\.credited\)\} · líquido \{fmtEur\(row\.creditNote\.net\)\}/);
    expect(page).toMatch(/<CreditNoteDialog target=\{creditTarget\}/);
    const dlg = src("client/src/components/CreditNoteDialog.tsx");
    expect(dlg).toMatch(/trpc\.expenses\.creditNote\.create\.useMutation/);
    expect(dlg).toMatch(/Falta creditar no máximo/);
  });
});
