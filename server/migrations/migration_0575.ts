// Migration 0575 — terminal no ponto: "conta até à última recolha ou entrega"
// (Jorge, 7 out 2026). Quando o troço de terminal fecha FORA do aeroporto (ou
// sem GPS, ou saída esquecida), o terminal conta da entrada no aeroporto até à
// ÚLTIMA recolha (CHECK_IN) ou entrega (CHECK_OUT) feita pelo extra na
// Multipark dentro do troço; daí até à saída é hora normal. Regras em
// shared/pontoTerminal.ts; interruptor PONTO_TERMINAL (desligado por omissão).
//
//  - `terminalUntil` (na SAÍDA, DATETIME em UTC): até quando conta o terminal
//    quando `terminalStatus` = "partial" (estado novo). NULL nos outros.
//    O RH continua a mandar: "confirmed" = troço todo terminal, "rejected" =
//    nenhum (o `terminalUntil` fica guardado, não se apaga).
//
// Só acrescenta a coluna; SEM backfill (os "pending" antigos resolvem-se no
// trabalho diário, os mais antigos ficam para o RH). Idempotente: ADD COLUMN
// repetido dá ER_DUP_FIELDNAME.

export const MIGRATION_0575_STATEMENTS: string[] = [
  "ALTER TABLE `time_records` ADD COLUMN `terminalUntil` DATETIME NULL AFTER `terminalStatus`",
];

export const IDEMPOTENT_ERROR_CODES_0575 = new Set<string>(["ER_DUP_FIELDNAME"]);
