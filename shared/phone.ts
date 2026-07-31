/**
 * Normalização de números de telefone para E.164 (formato que a WhatsApp
 * Cloud API exige: `+<indicativo><número>`).
 *
 * O campo de origem (`employees.phone`, formulários do site) é TEXTO LIVRE
 * escrito por pessoas: vem com espaços, hífens unicode, parêntesis, anotações
 * ("912345678 (pessoal)"), dois números no mesmo campo ("912345678 / 913...")
 * e caracteres invisíveis colados de PDFs/WhatsApp. Ser estrito aqui marca
 * números perfeitamente válidos como inválidos e bloqueia o envio — por isso a
 * LIMPEZA é agressiva (tudo o que não seja dígito ou `+` é descartado), mas a
 * INFERÊNCIA de indicativo continua conservadora (nunca inventamos país).
 *
 * Regras (decisão do Jorge — default de país é Portugal, +351):
 *   - Já em `+...`                    → valida e mantém.
 *   - Prefixo internacional `00...`   → converte para `+...`.
 *   - Número nacional PT de 9 dígitos → prefixa `+351`.
 *   - `351` + 9 dígitos (sem `+`)     → prefixa `+`.
 *   - `0` + 9 dígitos (prefixo de rede escrito à mão) → `+351`.
 *   - Qualquer outra coisa            → `null` (não inventamos indicativo).
 *
 * Quando o campo tem VÁRIOS números, devolve o PRIMEIRO válido — é o contacto
 * principal em todos os casos reais.
 *
 * Devolve sempre `+` seguido de 8–15 dígitos (limite E.164) ou `null`.
 */

/**
 * Separadores que indicam MAIS DO QUE UM número no mesmo campo. Aplicado ao
 * texto ORIGINAL (antes da limpeza), porque "ou"/"e" são palavras.
 */
const MULTI_NUMBER_SPLIT = /[/,;|\r\n]+|\s+(?:ou|or|e|and)\s+/i;

/**
 * Normaliza UM candidato. Tudo o que não seja dígito ou `+` é descartado —
 * o que apanha de uma vez espaços, hífens (ASCII e unicode), parêntesis,
 * pontos, anotações em texto e caracteres invisíveis (zero-width, RTL marks).
 */
function normalizeSingle(candidate: string): string | null {
  const cleaned = candidate.replace(/[^\d+]/g, "");
  if (!cleaned) return null;

  const hasPlus = cleaned.startsWith("+");
  const digits = cleaned.replace(/\+/g, "");
  if (!digits) return null;

  // Já vem com indicativo explícito — só validamos o comprimento E.164.
  if (hasPlus) return /^\d{8,15}$/.test(digits) ? "+" + digits : null;

  // Prefixo internacional "00" → "+".
  if (digits.startsWith("00")) {
    const rest = digits.slice(2);
    return /^\d{8,15}$/.test(rest) ? "+" + rest : null;
  }

  // Número nacional PT (9 dígitos).
  if (digits.length === 9) return "+351" + digits;

  // Indicativo PT sem o "+": 351 + 9 dígitos = 12 dígitos.
  if (digits.length === 12 && digits.startsWith("351")) return "+" + digits;

  // "0" + 9 dígitos: prefixo de rede escrito à mão sobre um número nacional.
  if (digits.length === 10 && digits.startsWith("0")) return "+351" + digits.slice(1);

  // Não conseguimos inferir com segurança o indicativo → descarta.
  return null;
}

/** Normaliza para E.164, ou `null` se não for possível inferir com segurança. */
export function normalizePhoneE164(raw: string): string | null {
  if (typeof raw !== "string") return null;
  // NFKC converte dígitos "fullwidth" e NBSP em ASCII antes de qualquer split.
  const cleaned = raw.normalize("NFKC");
  if (!cleaned.trim()) return null;

  for (const candidate of cleaned.split(MULTI_NUMBER_SPLIT)) {
    const hit = normalizeSingle(candidate);
    if (hit) return hit;
  }
  return null;
}

/** `true` quando o texto contém um número que conseguimos enviar por WhatsApp. */
export function isValidPhone(raw: string | null | undefined): boolean {
  return typeof raw === "string" && normalizePhoneE164(raw) !== null;
}

/**
 * Valor a GRAVAR na BD a partir de input não-confiável (site, imports):
 * E.164 quando conseguimos normalizar, senão o texto limpo (nunca deitamos
 * fora o que a pessoa escreveu — o backoffice corrige à mão). `null` se vazio.
 */
export function normalizePhoneForStorage(raw: string | null | undefined, maxLength = 32): string | null {
  if (typeof raw !== "string") return null;
  const e164 = normalizePhoneE164(raw);
  if (e164) return e164.slice(0, maxLength);
  const cleaned = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}
