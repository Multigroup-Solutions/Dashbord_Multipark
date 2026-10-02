/**
 * Ligar / WhatsApp / Email a partir das fichas (P3 lote 17f, parte 3 — Jorge:
 * "deve poder ligar, enviar mensagem ou email da ficha de cliente ou reserva e
 * da ficha do colaborador"). PURAS — usadas pelo botão `ContactActions`.
 */
import { normalizePhoneE164 } from "./phone";

export interface ContactPhone {
  /** Como está na ficha (para mostrar e para o `tel:`). */
  raw: string;
  /** E.164 quando se consegue — só esses servem para o WhatsApp. */
  e164: string | null;
}

/** Telefones da ficha, sem vazios nem repetidos (o mesmo número escrito de duas maneiras conta uma vez). */
export function contactPhones(list: ReadonlyArray<string | null | undefined>): ContactPhone[] {
  const out: ContactPhone[] = [];
  const seen = new Set<string>();
  for (const v of list) {
    const raw = String(v ?? "").trim();
    if (!raw) continue;
    const e164 = normalizePhoneE164(raw);
    const key = e164 ?? raw.replace(/\s+/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw, e164 });
  }
  return out;
}

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

/** Emails da ficha, válidos, sem repetidos (maiúsculas não contam). */
export function contactEmails(list: ReadonlyArray<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of list) {
    const e = String(v ?? "").trim();
    if (!EMAIL_RE.test(e)) continue;
    const k = e.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/** "Nova mensagem" na Comunicação já com o destinatário (e a caixa sugerida, ex.: RH). */
export function composeEmailHref(email: string, mailbox?: string | null): string {
  const p = new URLSearchParams({ novo: email });
  if (mailbox) p.set("caixa", mailbox);
  return `/comunicacao?${p.toString()}`;
}

/** A conversa no ecrã do WhatsApp; `call` abre logo a chamada. */
export function whatsappConversationHref(conversationId: number, call = false): string {
  return `/whatsapp?c=${conversationId}${call ? "&ligar=1" : ""}`;
}
