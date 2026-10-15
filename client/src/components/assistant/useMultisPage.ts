/**
 * Plano MPV §3.1 (F0b): a página diz ao Multis o separador e o registo que
 * tem abertos — `useMultisPage({ tab: "pressao" })`,
 * `useMultisPage({ entity: { type: "booking", id: 123 } })`. O widget manda-os
 * com cada pergunta; o servidor só aceita os da lista da página
 * (shared/multisPage.ts) e ignora o resto. Só informação — não dá acesso.
 */
import { useEffect } from "react";
import { useLocation } from "wouter";
import type { MultisEntityType } from "@shared/multisPage";
import { clearMultisPage, setMultisPage } from "./multisStore";

export function useMultisPage(opts: { tab?: string | null; entity?: { type: MultisEntityType; id: number | null | undefined } | null }): void {
  const [location] = useLocation();
  const path = location.split("?")[0];
  const tab = opts.tab ?? null;
  const type = opts.entity?.type ?? null;
  const id = opts.entity?.id ?? null;
  useEffect(() => {
    const entity = type && id != null && Number.isSafeInteger(id) && id > 0 ? { type, id } : null;
    setMultisPage({ path, tab, entity });
  }, [path, tab, type, id]);
  useEffect(() => () => clearMultisPage(path), [path]);
}
