/**
 * Regras ÚNICAS do GPS do Zello partilhadas entre a recolha (servidor) e as
 * contas feitas sobre os pontos guardados (Resumo do dia: parado no turno,
 * velocidade máxima numa entrega). Antes viviam só em server/zelloGps.ts,
 * que as reexporta — mudar aqui muda em todo o lado.
 */

/** Acima disto é ruído (não há condutores a 150 km/h num parque). */
export const MAX_PLAUSIBLE_KMH = 150;
/** Abaixo disto (km/h) o condutor está parado — "horas de movimento" = o resto. */
export const STOPPED_SPEED_KMH = 2;
/** Dois pontos com mais do que isto (s) entre eles: o Zello esteve desligado/sem sinal — o troço não conta. */
export const MAX_SEGMENT_GAP_S = 3600;
