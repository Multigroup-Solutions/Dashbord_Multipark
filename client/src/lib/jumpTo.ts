/**
 * Saltos "de fora" da página (sino, pesquisa global): muitas páginas leem o
 * `?id=`/`?tab=` só quando abrem. Se o salto é para a MESMA página com outros
 * parâmetros, o layout volta a montar a página (20d) — senão a notificação
 * "não fazia nada".
 */
export const PAGE_RELOAD_EVENT = "mp:page-reload";

const pathOf = (href: string) => String(href ?? "").split("?")[0].split("#")[0];

export function jumpTo(href: string, navigate: (to: string) => void): void {
  const same = typeof window !== "undefined" && pathOf(href) === window.location.pathname;
  navigate(href);
  if (same && typeof window !== "undefined") {
    // depois de o wouter atualizar o URL
    setTimeout(() => window.dispatchEvent(new Event(PAGE_RELOAD_EVENT)), 0);
  }
}
