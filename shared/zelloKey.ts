/**
 * Lote 43b — a chave de um utilizador do Zello: sem espaços à volta e em
 * minúsculas, igual em todo o lado (no servidor havia Maps com o texto exato e
 * no cliente em minúsculas — "Extra12" e "extra12" não batiam). Não junta
 * "extra_12" com "extra12": podem ser duas contas diferentes. PURA.
 */
export const zelloKey = (s: string | null | undefined): string => String(s ?? "").trim().toLowerCase();
