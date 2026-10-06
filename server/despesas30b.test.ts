/**
 * P3 lote 30b — Export para a contabilista (Jorge, 6 out 2026): "export
 * mensal só com as faturas e as datas, a pedido do utilizador".
 */
import { readFileSync } from "node:fs";
import { crc32 as zlibCrc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  ACCOUNTANT_FILE_MAX_BYTES, accountantFileName, buildAccountantExport, buildZip, crc32, fileExtOf, monthDays, previousMonthOf, type AccountantExpense,
} from "../shared/accountantExport";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const e = (o: Partial<AccountantExpense> & { id: number }): AccountantExpense => ({
  expenseDate: "2026-09-03 00:00:00", paidAt: null, supplier: null, supplierNif: null, documentNumber: null, description: null, amount: 0, fileKey: null, fileUrl: null, ...o,
});

describe("30b — o mês e os nomes", () => {
  it("dias do mês e mês anterior", () => {
    expect(monthDays("2026-09")).toEqual({ start: "2026-09-01", end: "2026-09-30" });
    expect(monthDays("2028-02")).toEqual({ start: "2028-02-01", end: "2028-02-29" });
    expect(() => monthDays("2026-13")).toThrow();
    expect(previousMonthOf("2026-10-06")).toBe("2026-09");
    expect(previousMonthOf("2027-01-02")).toBe("2026-12");
  });

  it("extensão pela key (sem query) ou pelo tipo", () => {
    expect(fileExtOf("invoices/3/abc.PDF")).toBe("pdf");
    expect(fileExtOf("https://x/y/foto.jpeg?X-Amz-Signature=1")).toBe("jpg");
    expect(fileExtOf("invoices/3/sem-extensao", "image/png")).toBe("png");
    expect(fileExtOf(null)).toBe("bin");
  });

  it("nome que se lê: data, fornecedor, documento, valor e o nº da despesa", () => {
    expect(accountantFileName(e({ id: 7, supplier: "Google Ireland Limited", documentNumber: "FT 2026/123", amount: 1100, fileKey: "invoices/1/a.pdf" })))
      .toBe("2026-09-03_Google-Ireland-Limited_FT-2026-123_1100.00EUR_#7.pdf");
    expect(accountantFileName(e({ id: 8, supplier: "Água & Luz, Lda.", amount: 12.5, fileUrl: "https://blob/x.png" })))
      .toBe("2026-09-03_Agua-Luz-Lda._12.50EUR_#8.png");
  });
});

describe("30b — o que vai no ZIP e na folha", () => {
  it("só as faturas com ficheiro, por data; as outras na lista 'Sem fatura'; só datas e identificação", () => {
    const r = buildAccountantExport([
      e({ id: 2, expenseDate: "2026-09-20 00:00:00", supplier: "EDP", amount: 80, fileKey: "invoices/1/edp.pdf", paidAt: "2026-09-25 10:00:00", supplierNif: "503504564", documentNumber: "F1" }),
      e({ id: 1, expenseDate: "2026-09-02 00:00:00", supplier: "Renda", amount: 1000 }),
      e({ id: 3, expenseDate: "2026-09-05 00:00:00", supplier: "Galp", amount: 40.255, fileUrl: "https://b/galp.jpg" }),
    ]);
    expect(r.files.map((f) => f.id)).toEqual([3, 2]);
    expect(r.files[0].name.startsWith("faturas/2026-09-05_Galp_")).toBe(true);
    expect(r.sheet[1]).toEqual({ "Data da fatura": "20/09/2026", "Data de pagamento": "25/09/2026", "Fornecedor": "EDP", "NIF": "503504564", "Nº documento": "F1", "Valor (€)": 80, "Ficheiro": r.files[1].name });
    expect(Object.keys(r.sheet[0])).not.toContain("Categoria");
    expect(r.missing).toEqual([{ "Data": "02/09/2026", "Fornecedor": "Renda", "Nº documento": "", "Valor (€)": 1000, "ID": 1 }]);
    expect(r.total).toBe(120.26);
  });
});

describe("30b — ZIP sem dependências (store, UTF-8)", () => {
  it("CRC-32 igual ao do zlib", () => {
    const d = new TextEncoder().encode("Faturas de setembro — 2026");
    expect(crc32(d)).toBe(zlibCrc32(d));
  });

  it("estrutura: cabeçalhos locais, diretório central e fim; nomes em UTF-8", () => {
    const a = new TextEncoder().encode("olá"), b = new Uint8Array([1, 2, 3, 4, 5]);
    const z = buildZip([{ name: "faturas-2026-09.xlsx", data: a }, { name: "faturas/Água_#1.pdf", data: b }], new Date("2026-10-06T10:00:00Z"));
    const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    expect(v.getUint16(6, true) & 0x0800).toBe(0x0800); // UTF-8
    expect(v.getUint32(14, true)).toBe(zlibCrc32(a));
    const end = z.length - 22;
    expect(v.getUint32(end, true)).toBe(0x06054b50);
    expect(v.getUint16(end + 10, true)).toBe(2);
    const cdOffset = v.getUint32(end + 16, true);
    expect(v.getUint32(cdOffset, true)).toBe(0x02014b50);
    expect(new TextDecoder().decode(z.slice(30, 30 + 20))).toBe("faturas-2026-09.xlsx");
    expect(() => buildZip([{ name: "x", data: a }, { name: "x", data: b }])).toThrow(/repetido/);
  });
});

describe("30b — servidor e ecrã", () => {
  it("a pedido, com a permissão de exportar e a visibilidade da lista; canceladas fora; fica registado", () => {
    const r = src("server/expensesRouter.ts");
    expect(r).toContain("accountantExport: protectedProcedure");
    expect(r).toContain(`.filter((r) => r.expense.status !== "cancelled")`);
    expect(r).toContain("Export para a contabilista:");
    expect(r).toContain("canSeeExpense(vis, { insertedById: row.expense.insertedById, projectId: row.expense.projectId ?? null })");
    expect(r).toContain("if (bytes.length > ACCOUNTANT_FILE_MAX_BYTES) return { tooLarge: true as const, size: bytes.length };");
    expect(ACCOUNTANT_FILE_MAX_BYTES * 4 / 3).toBeLessThan(4_500_000); // cabe numa resposta da Vercel
  });

  it("botão nas Despesas; nada é enviado sozinho", () => {
    expect(src("client/src/pages/ExpensesPage.tsx")).toContain("Para a contabilista (ZIP do mês)");
    const ui = src("client/src/components/ExpenseAccountantExport.tsx");
    expect(ui).toContain("buildZip(parts)");
    expect(ui).toContain("FALTAM-NO-ZIP.txt");
    expect(ui).not.toMatch(/sendMail|whatsapp|email\./i);
  });
});
