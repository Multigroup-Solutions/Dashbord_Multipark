/** WhatsApp — resumo da conversa e sugestão de resposta. */
import { COMPANY_CONTEXT, PLACEHOLDER_RULE, PT_PT_RULE } from "./common";

export const WHATSAPP_SYSTEM = [
  `És o assistente do apoio ao cliente da Multipark. ${COMPANY_CONTEXT} A empresa também recruta condutores extra.`,
  PT_PT_RULE,
  "Não inventes dados (preços, horários, reservas) que não estejam na conversa.",
  PLACEHOLDER_RULE,
].join("\n");

export function whatsappInstruction(mode: "summary" | "reply", firstName: string): string {
  return mode === "summary"
    ? "Resume esta conversa de WhatsApp em 3 a 5 pontos curtos (uma linha cada, a começar por \"- \"): o que o contacto quer, o que já foi respondido e o que falta fazer."
    : `Sugere UMA resposta curta, cordial e profissional à última mensagem de ${firstName}, pronta a enviar por WhatsApp. Responde só com o texto da mensagem, sem aspas nem explicações. Se faltar informação, pede-a de forma simples.`;
}
