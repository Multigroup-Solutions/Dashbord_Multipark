/**
 * Máscara dos dados sensíveis no registo de atividade (P3 lote 20c).
 *
 * Aplicada a TODOS os detalhes em `logActivity`: o registo diz o que mudou e
 * em que ficha, sem guardar o IBAN, o NIF, o telefone, o cartão ou um segredo
 * de ninguém. Os emails ficam (são o que identifica a conta nos registos de
 * acesso). PURO.
 */

const MASK = "•••";

/** Últimos `n` caracteres visíveis. */
const tail = (v: string, n: number) => `${MASK}${v.replace(/\s+/g, "").slice(-n)}`;

/** Chaves de JSON cujo valor nunca fica no registo (só a terminação). */
const SENSITIVE_KEY = /^(?:[a-z]*?(?:phone|telefone|telemovel|mobile|whatsapp)|nif|nipc|nib|iban|nibnew|newnib|card(?:number)?|cc|password|pass|secret|token|apikey|api_key|accesstoken|refreshtoken)$/i;

/**
 * Mascara um texto livre ou JSON:
 *  - JSON com chaves sensíveis ("phone":"912…", "nif":"…", "token":"…");
 *  - IBAN (PT50 0002 … → PT50 •••0154);
 *  - NIF/NIPC escritos com o rótulo (NIF 123456789 → NIF •••6789);
 *  - telemóveis portugueses e números internacionais (+351 912 345 678 → •••678);
 *  - números de cartão (13–19 dígitos seguidos ou em grupos de 4).
 */
export function maskSensitive(text: string | null | undefined): string | null {
  if (text == null) return null;
  let s = String(text);
  // JSON: "chave": "valor" ou "chave": 123
  s = s.replace(/("([A-Za-z_]+)"\s*:\s*)("((?:[^"\\]|\\.)*)"|-?\d[\d.]*)/g, (all, pre: string, key: string, _v: string, inner: string | undefined) => {
    if (!SENSITIVE_KEY.test(key)) return all;
    const raw = inner ?? _v;
    if (!raw || raw === "null") return all;
    if (/password|pass|secret|token|apikey|api_key/i.test(key)) return `${pre}"${MASK}"`;
    // Telefone/NIF/IBAN/cartão: só se o valor tiver mesmo números (ex.: "kinds": {"phone": "nif"} fica).
    if ((raw.match(/\d/g) ?? []).length < 5) return all;
    return `${pre}"${tail(raw, 3)}"`;
  });
  // IBAN (2 letras + 2 dígitos + 11 a 30 alfanuméricos, com ou sem espaços)
  s = s.replace(/\b([A-Z]{2}\d{2})((?:[ ]?[A-Z0-9]){11,30})\b/g, (all, head: string, rest: string) => {
    const compact = rest.replace(/\s+/g, "");
    if (!/\d{6,}/.test(compact)) return all;
    return `${head} ${tail(compact, 4)}`;
  });
  // NIF / NIPC com rótulo
  s = s.replace(/\b(NIF|NIPC|nif|nipc|Nif)(\s*[:#]?\s*)(\d{9})\b/g, (_a, label: string, sep: string, n: string) => `${label}${sep}${tail(n, 4)}`);
  // Cartões: 4 grupos de 4 (com espaço/hífen) ou 13–19 dígitos seguidos
  s = s.replace(/\b(?:\d{4}[ -]){3}\d{1,7}\b|\b\d{13,19}\b/g, (m) => tail(m, 4));
  // Telefones: +internacional ou 9[1236]xxxxxxx (telemóveis PT), com espaços opcionais
  s = s.replace(/(?<![\w•])(?:\+|00)\d{1,3}[\s-]?\d(?:[\s-]?\d){6,12}(?!\d)/g, (m) => tail(m, 3));
  s = s.replace(/(?<![\w•+])9[1236]\d(?:[\s-]?\d){6}(?!\d)/g, (m) => tail(m, 3));
  return s;
}

/** Origens de um registo de atividade (coluna `source`, 0410). */
export const LOG_SOURCES = ["ui", "cron", "api_key", "site", "webhook", "system"] as const;
export type LogSource = (typeof LOG_SOURCES)[number];

export const LOG_SOURCE_LABELS: Record<LogSource, string> = {
  ui: "Ecrã",
  cron: "Automático (agendador)",
  api_key: "API key",
  site: "Site",
  webhook: "Webhook",
  system: "Sistema",
};
