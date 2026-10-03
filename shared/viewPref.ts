/** D46: cartões ou lista (preferência por página, guardada no aparelho). */
export type ViewMode = "cards" | "list";

export const VIEW_MODE_LABELS: Record<ViewMode, string> = { cards: "Cartões", list: "Lista" };

/** Chave no localStorage. PURA. */
export function viewPrefKey(page: string): string {
  return `mp.view.${page}`;
}

/** Valor guardado → modo (lixo/antigo = nenhum). PURA. */
export function parseViewMode(raw: unknown): ViewMode | null {
  return raw === "cards" || raw === "list" ? raw : null;
}
