/**
 * Rascunhos do composer do WhatsApp — UM POR CONVERSA (F11, P1 — 1 out 2026).
 * Antes havia um só texto para todas: a sugestão da IA (ou o "limpar" depois
 * de enviar) chegava quando já se estava noutra conversa e caía lá.
 */
export type WhatsAppDrafts = Readonly<Record<number, string>>;

/** Muda o rascunho de UMA conversa (texto vazio = sem rascunho). PURA. */
export function withDraft(drafts: WhatsAppDrafts, conversationId: number, value: string | ((prev: string) => string)): WhatsAppDrafts {
  const prev = drafts[conversationId] ?? "";
  const next = typeof value === "function" ? value(prev) : value;
  if (next === prev) return drafts;
  const out: Record<number, string> = { ...drafts };
  if (next) out[conversationId] = next;
  else delete out[conversationId];
  return out;
}
