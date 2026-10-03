// Migration 0450 — WhatsApp (P3 lote 24d, Jorge, 3 out 2026):
//  - D34: a triagem propõe criar o caso (reclamação / perdido) — a conversa
//    guarda o caso criado (`caseKind`, `caseId`) e o "Não é"
//    (`caseProposalDismissedAt`), para a proposta não voltar;
//  - D35: "Parar promoções" conta como STOP — `optOutSource` diz de onde veio
//    (stop | promocoes | meta).
// Só acrescenta colunas (nada se apaga). Idempotente: ADD COLUMN repetido ignora-se.
export const MIGRATION_0450_STATEMENTS: string[] = [
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `caseKind` VARCHAR(16) NULL",
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `caseId` INT NULL",
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `caseProposalDismissedAt` TIMESTAMP NULL DEFAULT NULL",
  "ALTER TABLE `whatsapp_conversations` ADD COLUMN `optOutSource` VARCHAR(16) NULL",
];

export const IDEMPOTENT_ERROR_CODES_0450 = new Set<string>(["ER_DUP_FIELDNAME"]);
