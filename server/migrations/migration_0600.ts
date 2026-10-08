// Migration 0600 — passagem de turno: o resumo da IA só ao ENTREGAR (Jorge,
// 8 out 2026: "avança com o 7"). Antes corria a cada gravação, incluindo as
// edições, e cada vez era uma chamada paga. Agora corre na 1.ª gravação e no
// botão "Resumir agora"; editar depois deixa o resumo como estava e o ecrã
// mostra "resumo desatualizado".
//
//  - `aiSummaryVersion` (INT): a `version` da passagem para a qual o resumo
//    foi feito. Resumo desatualizado = `aiSummaryVersion` < `version`.
//    NULL nos resumos de antes desta migração (contam como em dia até à
//    próxima edição, que os carimba com a versão anterior).
//
// Só acrescenta a coluna; sem backfill. Idempotente: ADD COLUMN repetido dá
// ER_DUP_FIELDNAME.

export const MIGRATION_0600_STATEMENTS: string[] = [
  "ALTER TABLE `shift_handovers` ADD COLUMN `aiSummaryVersion` INT NULL AFTER `aiSummary`",
];

export const IDEMPOTENT_ERROR_CODES_0600 = new Set<string>(["ER_DUP_FIELDNAME"]);
