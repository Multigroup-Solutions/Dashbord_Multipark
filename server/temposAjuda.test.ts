/**
 * A ajuda dos tempos de entrega e de recolha: cada ecrã novo explicado na
 * página dele (sem nomes internos de tarefas nem de planos) e o ficheiro
 * gerado em dia.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

describe("ajuda dos tempos", () => {
  const pages: Record<string, string[]> = {
    "docs/ajuda/atividade-diaria.md": ["**Entregas (tarde)**", "**Recolhas (manhã)**", "Em calibração", "Sem dados suficientes", "máxima no Trânsito", "dentro da meta", "**Tempos**: escolhe ao lado qual"],
    "docs/ajuda/extras-dia.md": ["**Tempos**: os tempos separados", "**Hora apertada pela Fila**", "**De onde vêm os tempos**", "Total (pedido → assinatura)"],
    "docs/ajuda/passagem-turno.md": ["**Na fila há X**", "\"na fila há X min\""],
    "docs/ajuda/condutores-agentes.md": ["**Tempos de um condutor**", "sem dados suficientes", "Só informação: não dá pontos."],
    "docs/ajuda/ficha-reserva.md": ["**Tempos** (abre ao clicar)"],
    "docs/ajuda/definicoes.md": ["**Hora apertada pela Fila (por cidade)**", "Sem dados suficientes"],
  };
  for (const [file, needles] of Object.entries(pages)) {
    it(file, () => {
      const s = src(file);
      for (const n of needles) expect(s, n).toContain(n);
      expect(s).not.toMatch(/tarefa 62|plano 62|Plano 62/i);
    });
  }
  it("o ficheiro gerado tem as páginas novas", () => {
    const gen = src("server/assistant/helpDocs.generated.ts");
    expect(gen).toContain("Tempos de um condutor");
    expect(gen).toContain("De onde vêm os tempos");
    expect(gen).toContain("Hora apertada pela Fila");
  });
});
