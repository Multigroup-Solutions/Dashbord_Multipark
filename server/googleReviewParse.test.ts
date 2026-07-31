import { describe, expect, it } from "vitest";
import { parseGoogleReviewNotification } from "./emailParse";

// Amostra real (abreviada) de uma notificação do Google Business Profile.
const SAMPLE = `Cantinho deixou uma crítica sobre Airpark - Estacionamento Aeroporto de Lisboa

<https://business.google.com/n/123/reviews/abc?trk=x>

Bom trabalho, recebeu uma nova crítica de 5 estrela(s)

Ler crítica <https://business.google.com/n/123/reviews/abc>

Cantinho Feliz

Este utilizador deixou apenas uma classificação

Responder à crítica <https://business.google.com/n/123>

Responder às críticas mostra aos clientes que valoriza o respetivo feedback.

Vamos informar Cantinho quando tiver respondido.

Ver todas as críticas <https://business.google.com/n/123/reviews>

Visite o Centro de Ajuda <https://c.gle/xyz> para saber mais.

Recebeu este email porque indicou que gostaria de receber atualizações.

(c) 2026 Google Ireland Ltd, Gordon House, Barrow Street, Dublin 4, Ireland.`;

describe("parseGoogleReviewNotification", () => {
  it("extrai estrelas, nome completo e parque da amostra real", () => {
    const g = parseGoogleReviewNotification(SAMPLE);
    expect(g.rating).toBe(5);
    expect(g.reviewerName).toBe("Cantinho Feliz");
    expect(g.parkName).toContain("Airpark");
  });

  it("limpa links de tracking e boilerplate do texto", () => {
    const g = parseGoogleReviewNotification(SAMPLE);
    expect(g.cleanText).not.toContain("https://");
    expect(g.cleanText).not.toContain("Centro de Ajuda");
    expect(g.cleanText).not.toContain("Google Ireland");
    expect(g.cleanText).toContain("5 estrela");
  });

  it("rating 0 e sem nome quando o texto não tem o padrão", () => {
    const g = parseGoogleReviewNotification("Bom dia, tenho uma reclamação sobre o meu carro.");
    expect(g.rating).toBe(0);
    expect(g.reviewerName).toBeUndefined();
    expect(g.cleanText).toContain("reclamação");
  });

  it("aceita variações de rating 1-5", () => {
    for (const n of [1, 2, 3, 4, 5]) {
      expect(parseGoogleReviewNotification(`recebeu uma nova crítica de ${n} estrela(s)`).rating).toBe(n);
    }
  });

  it("nome parcial fica quando não há linha com o nome completo", () => {
    const g = parseGoogleReviewNotification("Maria deixou uma crítica sobre Redpark - Porto\n\ncrítica de 4 estrela(s)");
    expect(g.reviewerName).toBe("Maria");
    expect(g.rating).toBe(4);
  });
});
