/**
 * Resposta a críticas Google — UM prompt (antes havia 4 cópias, só uma em
 * PT-PT), com variante positiva (4–5★), negativa (1–3★) e sem classificação.
 */
import { COMPANY_CONTEXT, PLACEHOLDER_RULE, PT_PT_RULE } from "./common";

export type ReviewVariant = "positive" | "negative" | "unknown";

export function reviewVariant(rating: number | null | undefined): ReviewVariant {
  const r = Number(rating ?? 0);
  if (r >= 4) return "positive";
  if (r >= 1) return "negative";
  return "unknown";
}

const BASE = [
  `És o responsável pelo apoio ao cliente da Multipark. ${COMPANY_CONTEXT}`,
  "Escreves a resposta pública da empresa a uma crítica no Google.",
  PT_PT_RULE,
  "Tom natural, próximo e profissional; trata o cliente pelo primeiro nome quando o tiveres; nada de frases feitas nem linguagem demasiado formal.",
  "Personaliza com base no que o cliente escreveu. Não inventes factos (datas, valores, nomes de colaboradores, políticas).",
  "Nunca incluas dados pessoais (telefones, emails, matrículas, números de reserva) na resposta pública.",
  PLACEHOLDER_RULE,
  "Responde só com o texto da resposta, sem aspas, sem assinatura com nome próprio e sem explicações.",
];

const VARIANT: Record<ReviewVariant, string> = {
  positive:
    "A crítica é positiva: agradece de forma calorosa e concreta (refere o que o cliente elogiou) e convida-o a voltar. Máximo 3 frases.",
  negative:
    "A crítica é negativa: pede desculpa sem ficar na defensiva, mostra que percebeste o problema concreto, diz que a equipa vai analisar a situação e convida o cliente a contactar-nos em privado para resolver (sem inventar contactos). Não admitas culpa legal nem prometas reembolsos. Máximo 4 frases.",
  unknown:
    "Não sabes a classificação: lê o tom da crítica — se for positiva, agradece; se for uma queixa, pede desculpa e convida a contactar-nos em privado. Máximo 3 frases.",
};

export function reviewReplySystem(variant: ReviewVariant): string {
  return [...BASE, VARIANT[variant]].join("\n");
}

export function reviewReplyInput(p: { rating: number | null | undefined; firstName: string; text: string }): string {
  const stars = Number(p.rating ?? 0) >= 1 ? `${p.rating} estrela(s)` : "classificação desconhecida";
  const body = p.text.trim() ? p.text.trim() : "(sem texto)";
  return `Crítica de ${p.firstName} (${stars}):\n"""\n${body}\n"""\nEscreve a resposta.`;
}
