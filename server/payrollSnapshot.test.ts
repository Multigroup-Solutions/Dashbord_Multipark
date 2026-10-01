import { describe, expect, it } from "vitest";
import { payrollSnapshotForRead } from "./rhService";

// Fechos do mês (decisão Jorge, 1 out 2026): o fecho guarda o snapshot inteiro
// (nada se apaga), mas NIF e NIB não saem ao ler — não servem ao fecho.
describe("payrollSnapshotForRead", () => {
  it("tira NIF e NIB e mantém os valores do fecho", () => {
    const snap = { employeeId: 7, fullName: "Ana", totalHours: 160, totalPayment: 1234.5, netEstimate: 1000, nif: "123456789", nib: "PT50000000000000000000000", warnings: [] };
    const out = payrollSnapshotForRead(snap);
    expect(out).toEqual({ employeeId: 7, fullName: "Ana", totalHours: 160, totalPayment: 1234.5, netEstimate: 1000, warnings: [] });
    expect(snap.nib).toBe("PT50000000000000000000000"); // o original não muda
  });

  it("snapshot ilegível ou vazio passa tal e qual", () => {
    expect(payrollSnapshotForRead(null)).toBeNull();
    expect(payrollSnapshotForRead([1, 2] as any)).toEqual([1, 2]);
  });
});
