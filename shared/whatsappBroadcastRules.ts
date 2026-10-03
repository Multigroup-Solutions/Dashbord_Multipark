/**
 * Regras das difusões WhatsApp feitas por uma pessoa (D32, Jorge, 3 out 2026):
 *  - o mesmo template não volta ao mesmo número antes de 24 h (servidor:
 *    server/whatsappBroadcast.ts → `recent_template`);
 *  - antes de enviar a várias pessoas, um passo "Confirmar".
 */

/** A partir de quantos destinatários o envio pede confirmação. */
export const BROADCAST_CONFIRM_MIN = 2;

/** O envio a `n` destinatários pede o passo "Confirmar"? PURA. */
export function needsBroadcastConfirm(n: number): boolean {
  return n >= BROADCAST_CONFIRM_MIN;
}

/** Texto do passo "Confirmar". PURA. */
export function broadcastConfirmText(templateLabel: string, n: number): string {
  return `Vais enviar “${templateLabel}” a ${n} pessoa${n === 1 ? "" : "s"}. Quem já recebeu este template nas últimas 24 h fica de fora. Confirmas?`;
}

/** Etiqueta curta de quem ficou de fora por já ter recebido o template. */
export const RECENT_TEMPLATE_LABEL = "já recebeu (24 h)";
