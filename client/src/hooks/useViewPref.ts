import { useCallback, useState } from "react";
import { parseViewMode, viewPrefKey, type ViewMode } from "@shared/viewPref";

/**
 * D46 (Jorge, 3 out 2026): cada lista de pessoas/contactos vê-se em cartões
 * (com foto) ou em lista, no telemóvel e no PC. A escolha fica neste aparelho
 * (localStorage `mp.view.<chave>`), por página. Sem escolha: `fallback`;
 * "auto" = cartões no telemóvel e lista no PC (como era nos Utilizadores).
 */
export function useViewPref(key: string, fallback: ViewMode | "auto" = "auto"): [ViewMode, (v: ViewMode) => void] {
  const storageKey = viewPrefKey(key);
  const [mode, setMode] = useState<ViewMode>(() => {
    try {
      const saved = parseViewMode(localStorage.getItem(storageKey));
      if (saved) return saved;
    } catch { /* sem storage (privado) — segue o padrão */ }
    if (fallback !== "auto") return fallback;
    return typeof window !== "undefined" && window.innerWidth < 768 ? "cards" : "list";
  });
  const set = useCallback((v: ViewMode) => {
    setMode(v);
    try { localStorage.setItem(storageKey, v); } catch { /* sem storage: só nesta visita */ }
  }, [storageKey]);
  return [mode, set];
}
