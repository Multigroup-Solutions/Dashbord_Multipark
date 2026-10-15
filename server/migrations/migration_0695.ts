// Migration 0695 — Multis: resposta guardada COM os marcadores dos colegas
// (plano MPV, F0b — auditoria A1).
//
// A resposta que a pessoa vê tem os nomes completos dos colegas repostos
// ([NOME_1] → "João Silva"). Para o turno seguinte não os mandar de volta ao
// fornecedor no histórico, cada resposta guarda também:
//  - `contentMasked`: o mesmo texto com os nomes dos colegas ainda como
//    marcadores ([NOME_n]);
//  - `maskedNames`: o mapa desses marcadores (JSON {"[NOME_1]": "João Silva"}),
//    para os voltar a numerar no contexto de redação do turno seguinte.
// Ambas NULL nas respostas antigas (que só tinham o 1.º nome dos colegas).
//
// Só acrescenta (colunas NULL, sem backfill). Idempotente: ADD COLUMN repetido
// dá ER_DUP_FIELDNAME (calado).

export const MIGRATION_0695_STATEMENTS: string[] = [
  "ALTER TABLE `ai_chat_messages` ADD COLUMN `contentMasked` MEDIUMTEXT NULL",
  "ALTER TABLE `ai_chat_messages` ADD COLUMN `maskedNames` TEXT NULL",
];

export const IDEMPOTENT_ERROR_CODES_0695 = new Set<string>(["ER_DUP_FIELDNAME"]);
