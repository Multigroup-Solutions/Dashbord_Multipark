/**
 * Classes de layout partilhadas pelas páginas financeiras / marketing /
 * definições (só apresentação, dentro do design system Multipark).
 */

/**
 * Tabela larga no telemóvel: o contentor faz scroll horizontal e a 1.ª
 * coluna fica fixa (sticky) com o fundo do cartão; números sem quebra.
 * Aplicar ao <table> dentro de um `overflow-x-auto`.
 */
export const STICKY_FIRST_COL =
  "[&_tr>*:first-child]:sticky [&_tr>*:first-child]:left-0 [&_tr>*:first-child]:z-[1] [&_tr>*:first-child]:bg-card " +
  "[&_tr>*:first-child]:shadow-[1px_0_0_var(--border)] [&_td.text-right]:whitespace-nowrap [&_th]:whitespace-nowrap";

/**
 * Separadores que não cabem no telemóvel: a barra faz scroll horizontal em
 * vez de empurrar a página para fora do ecrã.
 * (Fix partilhado sugerido: pôr isto por omissão no TabsList.)
 */
export const TABS_SCROLL = "max-w-full overflow-x-auto justify-start [scrollbar-width:thin]";
