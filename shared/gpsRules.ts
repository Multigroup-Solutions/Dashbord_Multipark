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

// ─── Limite de velocidade (Jorge, 14 out 2026) ──────────────────────────────
// Passou para a definição "Limite de velocidade (GPS do Zello)" (`gps.speedRule`,
// shared/speedRules.ts): 120 km/h + 10 % = 132 km/h por omissão, editável em
// Definições. A tabela antiga `speed_limits` (sem ecrã) deixou de ser lida.
// O MAX_PLAUSIBLE_KMH (150) só limpa a velocidade MÉDIA; a máxima e os excessos
// usam o filtro de picos de shared/speedRules.ts (um 160 real já não desaparece).
