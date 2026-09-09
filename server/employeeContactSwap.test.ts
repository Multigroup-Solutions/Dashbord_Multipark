import { describe, expect, it } from "vitest";
import {
  classifyContactValue,
  isValidNifChecksum,
  planContactSwap,
  type EmployeeContactRow,
} from "./employeeContactSwap";

// NIFs com checksum válido (gerados pela regra mod 11), usados nos cenários.
const NIF_1 = "123456789"; // 1 → pessoa singular
const NIF_2 = "234567899"; // 2 → pessoa singular
const NIF_5 = "504426524"; // 5 → pessoa coletiva
const NIF_BAD = "123456788"; // checksum errado

function row(partial: Partial<EmployeeContactRow> & { id: number }): EmployeeContactRow {
  return { fullName: `Pessoa ${partial.id}`, isActive: 1, phone: null, nif: null, ...partial };
}

describe("isValidNifChecksum", () => {
  it("aceita NIFs reais e rejeita gralhas", () => {
    expect(isValidNifChecksum(NIF_1)).toBe(true);
    expect(isValidNifChecksum(NIF_2)).toBe(true);
    expect(isValidNifChecksum(NIF_5)).toBe(true);
    expect(isValidNifChecksum(NIF_BAD)).toBe(false);
    expect(isValidNifChecksum("12345678")).toBe(false);
    expect(isValidNifChecksum("abc")).toBe(false);
  });
});

describe("classifyContactValue", () => {
  it("vazio", () => {
    expect(classifyContactValue(null).kind).toBe("empty");
    expect(classifyContactValue("   ").kind).toBe("empty");
    expect(classifyContactValue(undefined).kind).toBe("empty");
  });

  it("telefone PT: +351 explícito, 351 sem +, 00351, 9 dígitos a começar por 9, 0+9 dígitos", () => {
    for (const v of ["+351 912 345 678", "351912345678", "00351912345678", "912345678", "0912345678", "+351 21 123 4567"]) {
      const c = classifyContactValue(v);
      expect(c.kind, v).toBe("phone");
      expect(c.normalized, v).toMatch(/^\+351\d{9}$/);
    }
  });

  it("um 9xxxxxxxx com checksum de NIF válido continua a ser telemóvel (regra do Jorge), com nota", () => {
    // Dos 10 números 91234567x só um bate o checksum (dígito de controlo 5).
    const candidates = Array.from({ length: 10 }, (_, d) => `91234567${d}`).filter(isValidNifChecksum);
    expect(candidates.length).toBe(1);
    const c = classifyContactValue(candidates[0]);
    expect(c.kind).toBe("phone");
    expect(c.detail).toMatch(/checksum de NIF também válido/);
  });

  it("telefone estrangeiro fica como telefone (intl), nunca NIF", () => {
    expect(classifyContactValue("+44 7700 900123").kind).toBe("intl");
    expect(classifyContactValue("0033612345678").kind).toBe("intl");
  });

  it("9 dígitos nus com 1.º dígito 1–8 e checksum válido = NIF (só dígitos)", () => {
    expect(classifyContactValue(` ${NIF_1} `)).toMatchObject({ kind: "nif", normalized: NIF_1 });
    expect(classifyContactValue("PT " + NIF_5)).toMatchObject({ kind: "nif", normalized: NIF_5 });
    expect(classifyContactValue("234 567 899")).toMatchObject({ kind: "nif", normalized: NIF_2 });
  });

  it("9 dígitos com checksum inválido / 0 inicial / 8 dígitos / texto = other", () => {
    expect(classifyContactValue(NIF_BAD).kind).toBe("other");
    expect(classifyContactValue("012345678").kind).toBe("other");
    expect(classifyContactValue("12345678").kind).toBe("other");
    expect(classifyContactValue("n/a").kind).toBe("other");
    expect(classifyContactValue("11912345678").kind).toBe("other");
  });
});

describe("planContactSwap", () => {
  it("caso clássico: NIF no phone e telemóvel no nif → troca com normalização", () => {
    const plan = planContactSwap([row({ id: 1, phone: "123 456 789", nif: "912345678" })]);
    expect(plan.swaps).toBe(1);
    expect(plan.items[0]).toMatchObject({
      decision: "swap",
      newPhone: "+351912345678",
      newNif: NIF_1,
    });
  });

  it("nif começa por 9 e phone vazio → telemóvel vai para phone, nif fica null", () => {
    const plan = planContactSwap([row({ id: 2, phone: null, nif: "912345678" })]);
    expect(plan.items[0]).toMatchObject({ decision: "swap", newPhone: "+351912345678", newNif: null });
  });

  it("phone tem NIF e nif vazio → NIF vai para nif, phone fica null", () => {
    const plan = planContactSwap([row({ id: 3, phone: NIF_2, nif: "" })]);
    expect(plan.items[0]).toMatchObject({ decision: "swap", newPhone: null, newNif: NIF_2 });
  });

  it("nif com telefone estrangeiro e phone com NIF → troca (o intl é telefone)", () => {
    const plan = planContactSwap([row({ id: 4, phone: NIF_5, nif: "+44 7700 900123" })]);
    expect(plan.items[0]).toMatchObject({ decision: "swap", newPhone: "+447700900123", newNif: NIF_5 });
  });

  it("dados corretos ficam intocados (incl. telefone estrangeiro no phone)", () => {
    const plan = planContactSwap([
      row({ id: 5, phone: "+351912345678", nif: NIF_1 }),
      row({ id: 6, phone: "912345678", nif: null }),
      row({ id: 7, phone: "+44 7700 900123", nif: NIF_2 }),
      row({ id: 8, phone: null, nif: null }),
      row({ id: 9, phone: null, nif: NIF_5 }),
    ]);
    expect(plan.ok).toBe(5);
    expect(plan.swaps).toBe(0);
    expect(plan.reviews).toBe(0);
  });

  it("dois telefones → revisão (both-phones / same-value), nunca troca", () => {
    const plan = planContactSwap([
      row({ id: 10, phone: "912345678", nif: "913000000" }),
      row({ id: 11, phone: "+351 912 345 678", nif: "912345678" }),
    ]);
    expect(plan.items[0]).toMatchObject({ decision: "review", reason: "both-phones" });
    expect(plan.items[1]).toMatchObject({ decision: "review", reason: "same-value" });
  });

  it("dois NIFs → revisão (both-nifs)", () => {
    const plan = planContactSwap([row({ id: 12, phone: NIF_1, nif: NIF_2 })]);
    expect(plan.items[0]).toMatchObject({ decision: "review", reason: "both-nifs" });
  });

  it("telemóvel verificado em nif + lixo em phone → troca na mesma, lixo passa tal e qual para nif (swap-nif-unverified)", () => {
    // casos reais da 1.ª aplicação (2026-09-09): checksum errado, 8 dígitos, 11 dígitos
    const plan = planContactSwap([
      row({ id: 14, phone: "12345678", nif: "912345678" }),
      row({ id: 17, phone: "620909051", nif: "939924166" }),
      row({ id: 18, phone: " 12168946701 ", nif: "+351 939 334 037" }),
      row({ id: 19, phone: "x".repeat(40), nif: "0033612345678" }),
    ]);
    expect(plan.swaps).toBe(4);
    expect(plan.items[0]).toMatchObject({ reason: "swap-nif-unverified", newPhone: "+351912345678", newNif: "12345678" });
    expect(plan.items[1]).toMatchObject({ reason: "swap-nif-unverified", newPhone: "+351939924166", newNif: "620909051" });
    expect(plan.items[2]).toMatchObject({ reason: "swap-nif-unverified", newPhone: "+351939334037", newNif: "12168946701" });
    expect(plan.items[3]).toMatchObject({ reason: "swap-nif-unverified", newPhone: "+33612345678", newNif: "x".repeat(20) });
  });

  it("NIF verificado em phone + lixo em nif → troca, lixo passa para phone (swap-phone-unverified)", () => {
    const plan = planContactSwap([row({ id: 16, phone: NIF_1, nif: "n/a" })]);
    expect(plan.items[0]).toMatchObject({ decision: "swap", reason: "swap-phone-unverified", newPhone: "n/a", newNif: NIF_1 });
  });

  it("phone com lixo SEM telefone válido em nif → revisão (phone-unrecognized)", () => {
    const plan = planContactSwap([
      row({ id: 13, phone: NIF_BAD, nif: NIF_1 }),
      row({ id: 15, phone: "sem número", nif: null }),
      row({ id: 86, phone: "23445678999", nif: "Guyg" }),
    ]);
    for (const item of plan.items) expect(item).toMatchObject({ decision: "review", reason: "phone-unrecognized" });
  });

  it("contagens batem com os itens", () => {
    const plan = planContactSwap([
      row({ id: 20, phone: NIF_1, nif: "912345678" }),
      row({ id: 21, phone: "912345678", nif: NIF_1 }),
      row({ id: 22, phone: "912345678", nif: "913000000" }),
    ]);
    expect(plan).toMatchObject({ total: 3, swaps: 1, ok: 1, reviews: 1 });
  });
});

// ─── applyContactSwap com um db falso (transação, guarda otimista, activity_logs)

describe("applyContactSwap", () => {
  interface FakeCalls {
    updates: Array<{ sql: string; params: unknown[] }>;
    logs: Array<Record<string, unknown>>;
  }

  function fakeDb(affectedRowsFor: (employeeId: number) => number) {
    const calls: FakeCalls = { updates: [], logs: [] };
    const tx = {
      execute: async (query: { toQuery?: unknown; queryChunks?: unknown[] }) => {
        // Extrai os parâmetros da query drizzle (`sql` template) sem a compilar:
        // os chunks de texto são `StringChunk { value: string[] }`, o resto são
        // os valores interpolados tal e qual (primitivos ou null).
        const params = (query.queryChunks ?? []).filter(
          (c: unknown) => !(c !== null && typeof c === "object" && Array.isArray((c as { value?: unknown }).value)),
        );
        const employeeId = Number(params[2]);
        calls.updates.push({ sql: "UPDATE employees", params });
        return [{ affectedRows: affectedRowsFor(employeeId) }];
      },
      insert: () => ({
        values: async (row: Record<string, unknown>) => {
          calls.logs.push(row);
        },
      }),
    };
    const db = { transaction: async (cb: (t: typeof tx) => Promise<void>) => cb(tx) };
    return { db, calls };
  }

  it("actualiza cada troca, regista antes/depois em activity_logs e devolve os ids", async () => {
    const { applyContactSwap, CONTACT_SWAP_ACTION } = await import("./employeeContactSwap");
    const plan = planContactSwap([
      row({ id: 1, phone: NIF_1, nif: "912345678" }),
      row({ id: 2, phone: "912345678", nif: NIF_2 }), // ok — não deve ser tocado
    ]);
    const { db, calls } = fakeDb(() => 1);
    const result = await applyContactSwap(db as never, plan);

    expect(result).toEqual({ applied: [1], stale: [] });
    expect(calls.updates).toHaveLength(1);
    // params: newPhone, newNif, id, phone lido, nif lido
    expect(calls.updates[0].params).toEqual(["+351912345678", NIF_1, 1, NIF_1, "912345678"]);
    expect(calls.logs).toHaveLength(1);
    expect(calls.logs[0]).toMatchObject({ userId: 0, action: CONTACT_SWAP_ACTION, entity: "employees", entityId: 1 });
    expect(JSON.parse(String(calls.logs[0].details))).toEqual({
      before: { phone: NIF_1, nif: "912345678" },
      after: { phone: "+351912345678", nif: NIF_1 },
      kinds: { phone: "nif", nif: "phone" },
    });
  });

  it("linha alterada entre leitura e escrita (0 affectedRows) fica em stale e sem log", async () => {
    const { applyContactSwap } = await import("./employeeContactSwap");
    const plan = planContactSwap([
      row({ id: 1, phone: NIF_1, nif: "912345678" }),
      row({ id: 3, phone: null, nif: "913000000" }),
    ]);
    const { db, calls } = fakeDb((id) => (id === 3 ? 0 : 1));
    const result = await applyContactSwap(db as never, plan);

    expect(result).toEqual({ applied: [1], stale: [3] });
    expect(calls.updates).toHaveLength(2);
    expect(calls.logs).toHaveLength(1);
    expect(calls.logs[0].entityId).toBe(1);
  });

  it("plano sem trocas não abre transação", async () => {
    const { applyContactSwap } = await import("./employeeContactSwap");
    const plan = planContactSwap([row({ id: 9, phone: "912345678", nif: NIF_1 })]);
    let opened = false;
    const db = { transaction: async () => { opened = true; } };
    const result = await applyContactSwap(db as never, plan);
    expect(result).toEqual({ applied: [], stale: [] });
    expect(opened).toBe(false);
  });
});
