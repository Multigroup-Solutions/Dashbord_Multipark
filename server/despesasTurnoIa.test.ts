/**
 * Despesas do turno com a IA a ler o talão (Jorge, 12 out 2026): "a despesa
 * deve ir imediatamente para as Despesas, com um link direto; o team leader
 * envia as despesas por aqui e não pelo Financeiro, com as MESMAS
 * funcionalidades: tirar fotografia e a IA ler o talão".
 *  - shiftHandover.readReceipt: permissão da passagem de turno, a MESMA IA das
 *    Despesas (expense_ocr), erro amigável quando está desligada;
 *  - addShiftExpense: fornecedor, NIF, n.º, data do talão, IVA e categoria
 *    (opcionais; sem eles fica como antes);
 *  - "Abrir nas Despesas": /despesas?id=N, só para quem pode ver a despesa.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  runAi: vi.fn(),
  inserted: [] as any[],
  events: [] as any[],
  rows: [] as any[],
  overrides: {} as Record<string, unknown>,
  dup: null as any,
}));

const chain = (rows: () => any[]) => {
  const c: any = {
    from: () => c, where: () => c, orderBy: () => c, limit: () => c, leftJoin: () => c,
    then: (res: any, rej: any) => Promise.resolve(rows()).then(res, rej),
  };
  return c;
};
const fakeDb = {
  select: () => chain(() => h.rows),
  insert: () => ({ values: async (v: any) => { h.inserted.push(v); return [{ insertId: 501 }]; } }),
  update: () => ({ set: () => ({ where: async () => [{ affectedRows: 1 }] }) }),
  execute: async () => [[]],
};

vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => fakeDb,
  getProjects: async () => [{ id: 49, parentId: null, name: "Lisboa", level: "city" }],
  getAllCategories: async () => [{ id: 3, name: "Combustível" }, { id: 4, name: "Portagens" }],
  categoryExists: async (id: number) => id === 3 || id === 4,
  findPossibleDuplicateExpense: async () => h.dup,
  recordExpenseEvent: async (ev: any) => { h.events.push(ev); },
  logActivity: async () => {},
  getEmployeeByUserId: async () => null,
  getUserPermissionOverrides: async () => ({}),
  getUserModuleOverrides: async () => h.overrides,
}));
const national = vi.hoisted(() => ({ all: true, defaultCityId: null, cityName: null, cityIds: [] as number[], projectIds: [] as number[], missingCostCenter: false }));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => national,
  loadCityAccessParts: async () => ({ access: national, base: national, all: national }),
}));
vi.mock("./_core/ai/run", () => ({ runAi: (...a: any[]) => h.runAi(...a) }));

import { appRouter } from "./routers";
import { addShiftExpense, receiptReadingFrom, shiftExpenseExtras, shiftExpenseNotes } from "./shiftExpenses";
import { AiDisabledError } from "./_core/ai/errors";
import { invoiceSchema } from "./_core/ai/prompts/invoice";
import { normalizeSupplierNif } from "../shared/supplierNif";
import { parseVatInput, shiftReceiptDateProblem, shiftReceiptVatProblem } from "../shared/shiftReceipt";
import { expenseIdFromSearch, expenseLink, searchWithoutExpenseId } from "../shared/expenseLink";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const caller = (user: Record<string, unknown>) => appRouter.createCaller({ user: { id: 77, name: "Rita", ...user }, req: { headers: {} }, res: {} } as any);
const TL = { role: "team_leader" };
const DAY = "2026-10-12";
const base = { date: DAY, shift: "night" as const, city: "lisbon" as const };
const invoice = {
  supplier: "Galp Energia", customerName: "Multipark", selfInvoice: false, description: "Gasóleo", amount: "45,90 €", vatAmount: "8.58",
  currency: "EUR", paymentMethod: "cash", expenseDate: "2026-10-13", paymentDueDate: null, nif: "PT 500 697 370", invoiceNumber: "FS 01/2345",
  suggestedCategory: "combustivel",
};

beforeEach(() => {
  h.runAi.mockReset();
  h.inserted = [];
  h.events = [];
  h.rows = [];
  h.overrides = {};
  h.dup = null;
});

describe("regras puras do talão", () => {
  it("NIF: PT com dígito de controlo; estrangeiro passa; vazio = sem NIF", () => {
    expect(normalizeSupplierNif("PT 500 697 370")).toEqual({ ok: true, nif: "500697370" });
    expect(normalizeSupplierNif("500.697.370")).toEqual({ ok: true, nif: "500697370" });
    expect(normalizeSupplierNif("IE6388047V")).toEqual({ ok: true, nif: "IE6388047V" });
    expect(normalizeSupplierNif("")).toEqual({ ok: true, nif: null });
    expect(normalizeSupplierNif(null)).toEqual({ ok: true, nif: null });
    for (const bad of ["500697371", "12345", "abc", "5006973700"]) expect(normalizeSupplierNif(bad).ok, bad).toBe(false);
  });

  it("data do talão: do dia seguinte (noite) até um mês antes do turno", () => {
    expect(shiftReceiptDateProblem("", DAY)).toBeNull();
    expect(shiftReceiptDateProblem(DAY, DAY)).toBeNull();
    expect(shiftReceiptDateProblem("2026-10-13", DAY)).toBeNull();
    expect(shiftReceiptDateProblem("2026-09-11", DAY)).toBeNull();
    expect(shiftReceiptDateProblem("2026-10-14", DAY)).toMatch(/depois do turno/);
    expect(shiftReceiptDateProblem("2026-09-10", DAY)).toMatch(/mais de um mês/);
    expect(shiftReceiptDateProblem("2026-02-30", DAY)).toMatch(/inválida/);
  });

  it("IVA: entre 0 e o total; '2,30' lê-se", () => {
    expect(parseVatInput("2,30")).toBe(2.3);
    expect(parseVatInput("")).toBeNull();
    expect(parseVatInput("abc")).toBeNaN();
    expect(shiftReceiptVatProblem(null, 10)).toBeNull();
    expect(shiftReceiptVatProblem(0, 10)).toBeNull();
    expect(shiftReceiptVatProblem(11, 10)).toMatch(/maior do que o total/);
    expect(shiftReceiptVatProblem(-1, 10)).toMatch(/inválido/);
  });

  it("sem os dados do talão fica como antes (dia do turno, sem fornecedor, notas de sempre)", () => {
    expect(shiftExpenseExtras(DAY, 10)).toEqual({ ok: true, value: { supplier: null, supplierNif: null, documentNumber: null, expenseDay: DAY, vatAmount: null, categoryId: null, extractedByAi: false } });
    expect(shiftExpenseNotes("night", null)).toBe("Despesa do turno (noite) — Passagem de turno, paga com o dinheiro da caixa");
    expect(shiftExpenseNotes("morning", 2.3)).toBe("Despesa do turno (manhã) — Passagem de turno, paga com o dinheiro da caixa · IVA no talão: 2,30 €");
  });

  it("o que a IA leu → o que o cartão preenche (categoria ligada à lista, sem acentos nem maiúsculas)", () => {
    const r = receiptReadingFrom({ ...invoice, amount: "45.90", vatAmount: "8.58", nif: "PT500697370", currency: "EUR", paymentMethod: "cash" } as any, [{ id: 3, name: "Combustível" }, { id: 4, name: "Portagens" }]);
    expect(r).toEqual({
      supplier: "Galp Energia", supplierNif: "500697370", nifValid: true, documentNumber: "FS 01/2345", invoiceDate: "2026-10-13",
      amount: 45.9, vatAmount: 8.58, description: "Gasóleo", category: { id: 3, name: "Combustível" }, selfInvoice: false,
    });
    const bad = receiptReadingFrom({ ...invoice, amount: null, vatAmount: null, nif: "500 697 371", expenseDate: "13/10/2026", suggestedCategory: "Outra" } as any, [{ id: 3, name: "Combustível" }]);
    expect(bad).toMatchObject({ supplierNif: "500697371", nifValid: false, invoiceDate: null, amount: null, vatAmount: null, category: null });
  });

  it("a leitura das Despesas não muda: o IVA é opcional na resposta da IA", () => {
    const { vatAmount: _omit, ...withoutVat } = invoice;
    expect(() => invoiceSchema.parse(withoutVat)).not.toThrow();
  });
});

describe("shiftHandover.readReceipt — a MESMA IA das Despesas, com a permissão da passagem de turno", () => {
  it("TL: chama expense_ocr com a lista de categorias e devolve fornecedor, NIF, n.º, data, total, IVA, categoria e descrição", async () => {
    h.runAi.mockResolvedValueOnce({ output: invoice });
    const r = await caller(TL).shiftHandover.readReceipt({ imageBase64: "aW1n", mimeType: "image/jpeg" });
    expect(h.runAi).toHaveBeenCalledTimes(1);
    const arg = h.runAi.mock.calls[0][0];
    expect(arg.feature).toBe("expense_ocr");
    expect(arg.tier).toBe("lite");
    expect(arg.userId).toBe(77);
    expect(arg.input[0]).toEqual({ type: "image", mimeType: "image/jpeg", data: "aW1n" });
    expect(arg.input[1].text).toContain("Combustível, Portagens");
    expect(r).toMatchObject({
      supplier: "Galp Energia", supplierNif: "500697370", nifValid: true, documentNumber: "FS 01/2345", invoiceDate: "2026-10-13",
      amount: 45.9, vatAmount: 8.58, description: "Gasóleo", category: { id: 3, name: "Combustível" }, selfInvoice: false, duplicate: null,
    });
  });

  it("aviso de duplicado como nas Despesas: n.º visível só a quem pode ver a despesa", async () => {
    h.runAi.mockResolvedValue({ output: invoice });
    h.dup = { id: 300, documentNumber: "FS 01/2345", insertedById: 77, projectId: 49 };
    expect((await caller(TL).shiftHandover.readReceipt({ imageBase64: "aW1n" })).duplicate).toEqual({ id: 300, documentNumber: "FS 01/2345" });
    h.dup = { id: 301, documentNumber: "FS 01/2345", insertedById: 88, projectId: 49 };
    expect((await caller(TL).shiftHandover.readReceipt({ imageBase64: "aW1n" })).duplicate).toEqual({ id: null, documentNumber: "FS 01/2345" });
  });

  it("sem a passagem de turno → FORBIDDEN, sem chamar a IA", async () => {
    await expect(caller({ role: "condutor" }).shiftHandover.readReceipt({ imageBase64: "aW1n" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.runAi).not.toHaveBeenCalled();
  });

  it("IA desligada → erro amigável (o TL preenche à mão)", async () => {
    h.runAi.mockRejectedValueOnce(new AiDisabledError("expense_ocr"));
    await expect(caller(TL).shiftHandover.readReceipt({ imageBase64: "aW1n" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "Esta funcionalidade de IA está desligada." });
  });

  it("formato não suportado → BAD_REQUEST, sem chamar a IA", async () => {
    await expect(caller(TL).shiftHandover.readReceipt({ imageBase64: "eA==", mimeType: "text/html" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.runAi).not.toHaveBeenCalled();
  });
});

describe("addShiftExpense — dados do talão gravados na despesa", () => {
  const user = { id: 77, name: "Rita" };

  it("grava fornecedor, NIF, n.º, data do talão, categoria, IVA (nas notas) e 'lido pela IA'; continua paga, dinheiro, cidade e do turno", async () => {
    const r = await addShiftExpense({
      day: DAY, shift: "night", city: "lisbon", description: "Gasóleo", amount: 45.9, invoiceKey: "invoices/77/1-talao.jpg", invoiceUrl: "https://x/t.jpg", user,
      supplier: " Galp Energia ", supplierNif: "PT 500 697 370", documentNumber: "FS 01/2345", invoiceDate: "2026-10-13", vatAmount: 8.58, categoryId: 3, extractedByAi: true,
    });
    expect(r).toEqual({ id: 501 });
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0]).toMatchObject({
      supplier: "Galp Energia", supplierNif: "500697370", documentNumber: "FS 01/2345", categoryId: 3, extractedByAi: 1,
      expenseDate: "2026-10-13 00:00:00", paidAt: `${DAY} 00:00:00`, amount: "45.90", paymentMethod: "cash", status: "paid", projectId: 49,
      cashSource: `shift:${DAY}:night:lisbon`, invoiceImageKey: "invoices/77/1-talao.jpg",
      notes: "Despesa do turno (noite) — Passagem de turno, paga com o dinheiro da caixa · IVA no talão: 8,58 €",
    });
    expect(h.events[0]).toMatchObject({ expenseId: 501, type: "created", after: { source: "shift", supplier: "Galp Energia", documentNumber: "FS 01/2345", categoryId: 3, expenseDate: "2026-10-13", extractedByAi: true } });
  });

  it("sem os campos novos fica como hoje", async () => {
    await addShiftExpense({ day: DAY, shift: "morning", city: "lisbon", description: "Lavagem", amount: 12, user });
    expect(h.inserted[0]).toMatchObject({
      supplier: null, supplierNif: null, documentNumber: null, categoryId: null, extractedByAi: 0, expenseDate: `${DAY} 00:00:00`,
      notes: "Despesa do turno (manhã) — Passagem de turno, paga com o dinheiro da caixa",
    });
  });

  it("NIF inválido, data longe do turno, IVA > total ou categoria inexistente → recusa sem gravar", async () => {
    await expect(addShiftExpense({ day: DAY, shift: "night", city: "lisbon", description: "x1", amount: 10, user, supplierNif: "500697371" })).rejects.toThrow(/NIF inválido/);
    await expect(addShiftExpense({ day: DAY, shift: "night", city: "lisbon", description: "x1", amount: 10, user, invoiceDate: "2025-10-12" })).rejects.toThrow(/mais de um mês/);
    await expect(addShiftExpense({ day: DAY, shift: "night", city: "lisbon", description: "x1", amount: 10, user, vatAmount: 12 })).rejects.toThrow(/IVA/);
    await expect(addShiftExpense({ day: DAY, shift: "night", city: "lisbon", description: "x1", amount: 10, user, categoryId: 99 })).rejects.toThrow(/Categoria inexistente/);
    expect(h.inserted).toHaveLength(0);
  });

  it("pela rota: o TL lança com os dados do talão; NIF inválido → BAD_REQUEST", async () => {
    await expect(caller(TL).shiftHandover.addExpense({ ...base, description: "Gasóleo", amount: 45.9, supplierNif: "500697370", categoryId: 3, vatAmount: 8.58, extractedByAi: true }))
      .resolves.toEqual({ id: 501 });
    expect(h.inserted[0]).toMatchObject({ supplierNif: "500697370", categoryId: 3, extractedByAi: 1 });
    await expect(caller(TL).shiftHandover.addExpense({ ...base, description: "Gasóleo", amount: 45.9, supplierNif: "123" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("NIF inválido") });
    expect(h.inserted).toHaveLength(1);
  });
});

describe("'Abrir nas Despesas' — ligação direta", () => {
  const row = (id: number, insertedById: number) => ({
    id, cashSource: `shift:${DAY}:night:lisbon`, description: "Gasóleo", supplier: "Galp", amount: "12.30", status: "paid",
    invoiceImageKey: null, invoiceImageUrl: null, insertedById, projectId: 49, createdAt: null,
  });

  it("/despesas?id=N", () => {
    expect(expenseLink(501)).toBe("/despesas?id=501");
    expect(expenseIdFromSearch("?id=501")).toBe(501);
    expect(expenseIdFromSearch("?tab=resumo&id=7")).toBe(7);
    for (const bad of ["", "?id=", "?id=abc", "?id=0", "?id=-3", "?id=1.5"]) expect(expenseIdFromSearch(bad), bad).toBeNull();
    expect(searchWithoutExpenseId("?id=7&tab=resumo")).toBe("?tab=resumo");
    expect(searchWithoutExpenseId("?id=7")).toBe("");
  });

  it("o link só aparece a quem pode ver a despesa nas Despesas (TL: as suas; admin: todas; sem Despesas: nenhuma)", async () => {
    h.rows = [row(10, 77), row(11, 88)];
    const tl = await caller(TL).shiftHandover.expenses(base);
    expect(tl.rows.map((r) => [r.id, r.canOpen])).toEqual([[10, true], [11, false]]);
    expect(tl.rows[0]).toMatchObject({ supplier: "Galp", projectId: 49 });
    expect(tl.total).toBe(24.6);
    const admin = await caller({ role: "admin" }).shiftHandover.expenses(base);
    expect(admin.rows.map((r) => r.canOpen)).toEqual([true, true]);
    h.overrides = { despesas: { access: "none", actions: [] } };
    const noExpenses = await caller(TL).shiftHandover.expenses(base);
    expect(noExpenses.rows.map((r) => r.canOpen)).toEqual([false, false]);
  });

  it("ecrãs: a página das Despesas abre ?id=; o cartão lê o talão, mostra o link e reaproveita a preparação das Despesas", () => {
    const page = src("client/src/pages/ExpensesPage.tsx");
    expect(page).toContain("expenseIdFromSearch(window.location.search)");
    expect(page).toContain("trpc.expenses.byId.useQuery({ id: linkedId ?? 0 }");
    expect(page).toContain('from "@/lib/invoiceFile"');
    expect(page).not.toMatch(/function pdfToPngDataUrl|function fileToBase64/);
    const card = src("client/src/components/ShiftExpensesCard.tsx");
    for (const t of ["trpc.shiftHandover.readReceipt.useMutation", "prepareInvoiceFile(file)", "A ler o talão…", "Abrir nas Despesas", "Já está nas Despesas", "expenseLink(r.id)", "extractedByAi: aiUsed"]) expect(card, t).toContain(t);
    const lib = src("client/src/lib/invoiceFile.ts");
    expect(lib).toContain("compressImage(file, 1600, 0.85)");
    expect(lib).toContain("file.size > 1_500_000");
    const r = src("server/routers.ts");
    const i = r.indexOf("readReceipt: protectedProcedure");
    expect(r.slice(i, i + 700)).toContain(`requireAccess(ctx.user, "passagem_turno", "edit");`);
    expect(r.slice(i, i + 1200)).toContain("throw aiTrpcError(err);");
  });
});
