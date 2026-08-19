import { useState, useEffect } from "react";

// Estado que sobrevive à navegação (pedido do Jorge: "se tiver filtros tem de
// manter exatamente os mesmos filtros" ao entrar/sair de detalhes ou mudar de
// página). Guarda em sessionStorage — limpa ao fechar o separador, não polui
// entre dias de trabalho. Usar uma key única por página+campo, ex.: "hr.search".
export function usePersistedState<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const storageKey = `mp.filters.${key}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw != null) return JSON.parse(raw) as T;
    } catch { /* sessionStorage indisponível ou JSON inválido — usa o default */ }
    return initial;
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(value));
    } catch { /* quota/privado — funciona como useState normal */ }
  }, [storageKey, value]);
  return [value, setValue];
}
