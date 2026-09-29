/**
 * Máscara de números de telefone para LOGS (nunca para a UI): mantém só os
 * últimos 3 dígitos — chega para distinguir envios num log sem expor o número.
 *   "+351912345678" → "+*********678"
 * PURA.
 */
export function maskPhone(phone: string | null | undefined): string {
  const raw = String(phone ?? "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "***";
  const keep = digits.slice(-3);
  const plus = raw.startsWith("+") ? "+" : "";
  return `${plus}${"*".repeat(Math.max(3, digits.length - 3))}${keep}`;
}

/** Substitui, num texto livre, qualquer sequência longa de dígitos (telefone) pela máscara. */
export function maskPhonesInText(text: string): string {
  return text.replace(/\+?\d[\d\s-]{7,}\d/g, (m) => maskPhone(m));
}
