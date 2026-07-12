/**
 * Normalização de números de telefone para E.164 (formato que a WhatsApp
 * Cloud API exige: `+<indicativo><número>`).
 *
 * Regras (decisão do Jorge — default de país é Portugal, +351):
 *   - Já em `+...`            → valida e mantém.
 *   - Prefixo internacional `00...` → converte para `+...`.
 *   - Número nacional PT de 9 dígitos → prefixa `+351`.
 *   - `351` + 9 dígitos (sem `+`)     → prefixa `+`.
 *   - Qualquer outra coisa   → `null` (não inventamos indicativo).
 *
 * Espaços, hífens, parêntesis e pontos são removidos antes de validar.
 * Devolve sempre `+` seguido de 8–15 dígitos (limite E.164) ou `null`.
 *
 * NÃO altera `employees.phone` na BD — é só uma função de normalização para
 * usar no ponto de envio / validação.
 */
export function normalizePhoneE164(raw: string): string | null {
  if (typeof raw !== "string") return null;

  // Remove separadores comuns (espaços incl. NBSP, hífens, parêntesis, pontos, barras).
  let s = raw.trim().replace(/[\s ().\-/]/g, "");
  if (!s) return null;

  // 00 (prefixo internacional) → +
  if (s.startsWith("00")) s = "+" + s.slice(2);

  if (s.startsWith("+")) {
    const digits = s.slice(1);
    if (!/^\d{8,15}$/.test(digits)) return null;
    return "+" + digits;
  }

  // A partir daqui só aceitamos dígitos.
  if (!/^\d+$/.test(s)) return null;

  // Número nacional PT (9 dígitos) → +351.
  if (s.length === 9) return "+351" + s;

  // Indicativo PT sem o "+": 351 + 9 dígitos = 12 dígitos.
  if (s.length === 12 && s.startsWith("351")) return "+" + s;

  // Não conseguimos inferir com segurança o indicativo → descarta.
  return null;
}
