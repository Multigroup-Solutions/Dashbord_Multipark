import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PONTO_NO_RECORD_MSG,
  PONTO_UNAVAILABLE_MSG,
  pontoMenuState,
  pontoRefetchIntervalMs,
} from "../shared/pontoMenu";

// Jorge (28 out 2026): o check-in/out do menu da foto desaparecia (Márcia e outros)
// quando o myStatus ainda não tinha respondido ou falhava. Com ficha, há SEMPRE ponto no menu.
const IN = { employeeId: 7, status: "in" as const, since: "2026-10-28T08:00:00.000Z", terminal: true };
const OUT = { employeeId: 7, status: "out" as const, since: null, terminal: false };

describe("pontoMenuState", () => {
  it("sem ficha: nada de ponto no menu", () => {
    expect(pontoMenuState({ hasEmployee: false, data: undefined, error: undefined })).toEqual({ kind: "none" });
    expect(pontoMenuState({ hasEmployee: false, data: OUT, error: null })).toEqual({ kind: "none" });
  });

  it("em serviço / fora de serviço vêm da resposta", () => {
    expect(pontoMenuState({ hasEmployee: true, data: IN, error: null })).toEqual({ kind: "in", since: IN.since, terminal: true });
    expect(pontoMenuState({ hasEmployee: true, data: OUT, error: null })).toEqual({ kind: "out" });
  });

  it("ainda sem resposta: 'a verificar', nunca vazio", () => {
    expect(pontoMenuState({ hasEmployee: true, data: undefined, error: null })).toEqual({ kind: "loading" });
  });

  it("erro de rede/servidor: aviso com 'tentar de novo'", () => {
    const s = pontoMenuState({ hasEmployee: true, data: undefined, error: { message: "Failed to fetch" } });
    expect(s).toEqual({ kind: "error", message: PONTO_UNAVAILABLE_MSG, retry: true });
  });

  it("ficha bloqueada a meio da sessão (FORBIDDEN): mostra o motivo, sem repetir", () => {
    const s = pontoMenuState({ hasEmployee: true, data: undefined, error: { message: "Acesso bloqueado: documentos em falta", data: { code: "FORBIDDEN" } } });
    expect(s).toEqual({ kind: "error", message: "Acesso bloqueado: documentos em falta", retry: false });
  });

  it("um erro numa pergunta seguinte não apaga o último estado conhecido", () => {
    expect(pontoMenuState({ hasEmployee: true, data: IN, error: { message: "Failed to fetch" } }).kind).toBe("in");
    expect(pontoMenuState({ hasEmployee: true, data: OUT, error: { message: "Failed to fetch" } }).kind).toBe("out");
  });

  it("servidor sem ficha mas a sessão tem uma: diz o que fazer", () => {
    const s = pontoMenuState({ hasEmployee: true, data: { employeeId: null, status: null, since: null, terminal: false }, error: null });
    expect(s).toEqual({ kind: "error", message: PONTO_NO_RECORD_MSG, retry: true });
  });

  it("com ficha nunca devolve 'none' (o menu tem sempre uma linha de ponto)", () => {
    const datas = [undefined, null, IN, OUT, { employeeId: null, status: null, since: null, terminal: false }];
    const errors = [undefined, null, { message: "x" }, { message: "y", data: { code: "FORBIDDEN" } }];
    for (const data of datas) for (const error of errors) {
      expect(pontoMenuState({ hasEmployee: true, data, error }).kind).not.toBe("none");
    }
  });
});

describe("pontoRefetchIntervalMs", () => {
  it("com erro volta a perguntar aos 15 s; sem erro, de 2 em 2 min", () => {
    expect(pontoRefetchIntervalMs(true)).toBe(15_000);
    expect(pontoRefetchIntervalMs(false)).toBe(120_000);
  });
});

describe("DashboardLayout usa a regra do menu", () => {
  const src = readFileSync(join(__dirname, "../client/src/components/DashboardLayout.tsx"), "utf8");
  it("o estado do ponto vem do pontoMenuState e o menu volta a perguntar ao abrir", () => {
    expect(src).toContain("pontoMenuState({ hasEmployee: !!employee");
    expect(src).toContain("pontoRefetchIntervalMs(");
    expect(src).toMatch(/<DropdownMenu onOpenChange=\{\(open\) => \{ if \(open && employee\) void pontoQ\.refetch\(\); \}\}>/);
    expect(src).toContain("A verificar o ponto…");
    expect(src).toContain("Ponto: tentar de novo");
  });
});
