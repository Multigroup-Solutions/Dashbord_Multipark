/**
 * Fardamento entregue na passagem de turno (pedido do Jorge, 2026-09-09).
 *
 * Substitui o antigo "Número de fardas" (um inteiro) por uma lista de peças
 * com QUANTIDADE e TAMANHO — "2 casacos M, 3 casacos L, 2 coletes S". O
 * vocabulário vive aqui (cliente + servidor) para o formulário, a validação
 * zod e o resumo do histórico dizerem exactamente o mesmo.
 *
 * Persistência: `shift_handovers.clothingItems` (TEXT, JSON deste formato).
 * A coluna antiga `uniformsCount` NÃO é removida — registos anteriores a esta
 * data continuam a mostrar o número que foi escrito na altura.
 */

export const CLOTHING_TYPES = ["colete", "polar", "casaco", "gorro"] as const;
export type ClothingType = (typeof CLOTHING_TYPES)[number];

/** Singular / plural para o resumo e para as etiquetas do formulário. */
export const CLOTHING_LABELS: Record<ClothingType, { one: string; many: string }> = {
  colete: { one: "colete", many: "coletes" },
  polar: { one: "polar", many: "polares" },
  casaco: { one: "casaco", many: "casacos" },
  gorro: { one: "gorro", many: "gorros" },
};

export const CLOTHING_SIZES = ["XS", "S", "M", "L", "XL", "XXL", "Único"] as const;
export type ClothingSize = (typeof CLOTHING_SIZES)[number];

/** Limites partilhados pela validação zod e pelo formulário. */
export const CLOTHING_MAX_ITEMS = 30;
export const CLOTHING_MAX_QTY = 999;

export interface ClothingItem {
  type: ClothingType;
  size: ClothingSize;
  qty: number;
}

export function isClothingType(v: unknown): v is ClothingType {
  return typeof v === "string" && (CLOTHING_TYPES as readonly string[]).includes(v);
}

export function isClothingSize(v: unknown): v is ClothingSize {
  return typeof v === "string" && (CLOTHING_SIZES as readonly string[]).includes(v);
}

/**
 * Lê o JSON gravado na BD. Tolerante: linhas inválidas são descartadas em vez
 * de rebentar o histórico inteiro; `null`/vazio/JSON partido → `[]`.
 */
export function parseClothingItems(raw: unknown): ClothingItem[] {
  if (raw == null) return [];
  let value: unknown = raw;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return [];
    try {
      value = JSON.parse(text);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out: ClothingItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { type, size, qty } = entry as Record<string, unknown>;
    const n = Number(qty);
    if (!isClothingType(type) || !isClothingSize(size) || !Number.isInteger(n) || n < 1) continue;
    out.push({ type, size, qty: Math.min(n, CLOTHING_MAX_QTY) });
    if (out.length >= CLOTHING_MAX_ITEMS) break;
  }
  return out;
}

/**
 * Junta linhas repetidas (mesmo tipo + tamanho) somando as quantidades e
 * ordena por tipo (ordem do vocabulário) e tamanho (ordem da tabela). PURA.
 */
export function normalizeClothingItems(items: ClothingItem[]): ClothingItem[] {
  const merged = new Map<string, ClothingItem>();
  for (const it of items) {
    if (!isClothingType(it.type) || !isClothingSize(it.size) || !(it.qty >= 1)) continue;
    const key = `${it.type}|${it.size}`;
    const prev = merged.get(key);
    if (prev) prev.qty = Math.min(prev.qty + it.qty, CLOTHING_MAX_QTY);
    else merged.set(key, { type: it.type, size: it.size, qty: Math.min(Math.floor(it.qty), CLOTHING_MAX_QTY) });
  }
  return Array.from(merged.values()).sort(
    (a, b) =>
      CLOTHING_TYPES.indexOf(a.type) - CLOTHING_TYPES.indexOf(b.type) ||
      CLOTHING_SIZES.indexOf(a.size) - CLOTHING_SIZES.indexOf(b.size),
  );
}

/** "2 casacos M, 3 casacos L, 1 colete S" — vazio → "". PURA. */
export function summarizeClothingItems(items: ClothingItem[]): string {
  return normalizeClothingItems(items)
    .map((it) => `${it.qty} ${it.qty === 1 ? CLOTHING_LABELS[it.type].one : CLOTHING_LABELS[it.type].many} ${it.size}`)
    .join(", ");
}

/** Total de peças, para contagens rápidas. */
export function countClothingItems(items: ClothingItem[]): number {
  return items.reduce((sum, it) => sum + (it.qty >= 1 ? Math.floor(it.qty) : 0), 0);
}
