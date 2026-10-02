/**
 * "Não enviar" por pessoa (P3 lote 17g — Jorge, 2 out 2026). Desliga tudo o
 * que é automático ou em massa, separado por canal: pedidos e lembretes de
 * disponibilidade, avisos de escala, turno cancelado, difusões, lembretes de
 * formação, pedido da cidade. As conversas uma a uma continuam. PURO.
 */
export const NO_AUTO_WHATSAPP_ERROR = "Não recebe WhatsApp automáticos (ficha: \"Não enviar WhatsApp\")";
export const NO_AUTO_EMAIL_ERROR = "Não recebe emails automáticos (ficha: \"Não enviar email\")";

export type ContactChannel = "whatsapp" | "email";

/** O que fica desligado, em texto curto para a ficha e a lista. */
export function contactPrefsLabel(p: { noAutoWhatsapp?: number | boolean | null; noAutoEmail?: number | boolean | null }): string | null {
  const wa = !!p.noAutoWhatsapp, em = !!p.noAutoEmail;
  if (wa && em) return "Não enviar WhatsApp nem email";
  if (wa) return "Não enviar WhatsApp";
  if (em) return "Não enviar email";
  return null;
}
