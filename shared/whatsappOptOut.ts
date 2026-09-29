/**
 * Opt-out do WhatsApp (STOP / PARAR / "não quero receber"…) — deteção PURA,
 * partilhada entre o webhook (que marca `optedOutAt`) e os testes.
 *
 * Regra conservadora: só conta como pedido de saída
 *   - a mensagem INTEIRA ser uma palavra-chave ("STOP", "Parar.", "remover"), ou
 *   - conter uma FRASE clara ("não quero receber mais mensagens",
 *     "cancelar a subscrição", "deixar de receber", "removam o meu número").
 * Nunca por uma palavra solta no meio de uma frase — "não pare de me avisar"
 * ou "vou parar o carro" não são opt-out.
 *
 * "INICIAR" / "START" (mensagem inteira) volta a ligar os envios.
 */

export type OptIntent = "opt_out" | "opt_in";

/** Minúsculas, sem acentos, sem pontuação/emojis, espaços colapsados. */
export function normalizeOptText(raw: string | null | undefined): string {
  return String(raw ?? "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Mensagem inteira = pedido de saída. */
const OPT_OUT_WHOLE = new Set([
  "stop",
  "parar",
  "pare",
  "parem",
  "remover",
  "remove",
  "removam",
  "removam me",
  "remover me",
  "unsubscribe",
  "cancelar subscricao",
  "cancelar a subscricao",
  "nao quero receber",
  "nao quero receber mais",
  "stop mensagens",
  "parar mensagens",
]);

/** Frases claras dentro de uma mensagem mais longa. */
const OPT_OUT_PHRASES: RegExp[] = [
  /\bnao quero (?:receber|voltar a receber) (?:mais )?(?:as |estas |essas |vossas )?(?:mensagens|msgs?|sms|whatsapps?|nada|notificacoes|avisos)\b/,
  /\bcancelar (?:a |minha |a minha )?subscricao\b/,
  /\bdeixar de receber (?:as |estas |essas |vossas )?(?:mensagens|msgs?|whatsapps?|avisos|notificacoes)\b/,
  /\b(?:removam|remover|retirem|retirar|apaguem|apagar) (?:o )?(?:meu )?(?:numero|contacto|contato)\b/,
  /\bnao (?:me )?(?:enviem|mandem|contactem) mais\b/,
];

const OPT_IN_WHOLE = new Set(["iniciar", "start", "comecar", "reiniciar"]);

/**
 * Intenção de opt-out/opt-in de uma mensagem recebida; null = mensagem normal.
 * PURA.
 */
export function detectOptIntent(body: string | null | undefined): OptIntent | null {
  const t = normalizeOptText(body);
  if (!t) return null;
  if (OPT_IN_WHOLE.has(t)) return "opt_in";
  if (OPT_OUT_WHOLE.has(t)) return "opt_out";
  // Frases só em mensagens curtas-ish: um texto longo a citar "cancelar a
  // subscrição" de outra coisa é mais provável conversa do que pedido.
  if (t.length <= 160 && OPT_OUT_PHRASES.some((re) => re.test(t))) return "opt_out";
  return null;
}

/** Resposta única enviada quando alguém pede para sair (só com a janela aberta). */
export const OPT_OUT_CONFIRMATION =
  "Não voltará a receber mensagens. Para voltar, responda INICIAR.";

/** Resposta a quem volta a ligar os envios. */
export const OPT_IN_CONFIRMATION = "Combinado — voltará a receber as nossas mensagens.";
