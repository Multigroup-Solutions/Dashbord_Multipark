// Migration 0084 — funil único de recrutamento nos leads de extras (Jorge, 24 set 2026).
//
//  - `sourceRef` (ex.: "application:123", "email:456"): de onde veio o lead —
//    UNIQUE (vários NULL permitidos) para a mesma candidatura/email nunca gerar
//    dois leads;
//  - estado `replied` ("Respondeu") — acrescentado no FIM do enum, que é a
//    alteração INSTANTÂNEA do InnoDB (a meio obrigava a copiar a tabela em cada
//    arranque, porque isto corre sempre no ensureRecentSchema);
//  - `lastInboundAt` (última mensagem WhatsApp recebida do lead),
//    `firstContactedAt` e `convertedAt` (métricas do funil) e `autoRepliedAt`
//    (guarda: a resposta automática com o link da candidatura sai no máximo 1×);
//  - `extra_lead_sources`: cada candidatura/email já processado fica aqui, para
//    a importação não recriar um lead que o backoffice apagou.
//
// Os UPDATEs só preenchem colunas ainda NULL (e mantêm o `updatedAt`), por isso
// correm em cada arranque sem pisar o que a app escreve depois.

export const MIGRATION_0084_NAME = "0084_extra_leads_funnel";

export const MIGRATION_0084_STATEMENTS: string[] = [
  "ALTER TABLE `extra_leads` ADD COLUMN `sourceRef` VARCHAR(64) NULL",
  "ALTER TABLE `extra_leads` ADD UNIQUE KEY `uq_extra_leads_source_ref` (`sourceRef`)",
  "ALTER TABLE `extra_leads` MODIFY COLUMN `status` ENUM('new','contacted','converted','declined','replied') NOT NULL DEFAULT 'new'",
  "ALTER TABLE `extra_leads` ADD COLUMN `lastInboundAt` DATETIME NULL",
  "ALTER TABLE `extra_leads` ADD COLUMN `firstContactedAt` DATETIME NULL",
  "ALTER TABLE `extra_leads` ADD COLUMN `convertedAt` DATETIME NULL",
  "ALTER TABLE `extra_leads` ADD COLUMN `autoRepliedAt` DATETIME NULL",
  `UPDATE \`extra_leads\` SET \`firstContactedAt\` = \`lastContactedAt\`, \`updatedAt\` = \`updatedAt\`
     WHERE \`firstContactedAt\` IS NULL AND \`lastContactedAt\` IS NOT NULL`,
  `UPDATE \`extra_leads\` SET \`convertedAt\` = \`updatedAt\`, \`updatedAt\` = \`updatedAt\`
     WHERE \`convertedAt\` IS NULL AND \`status\` = 'converted'`,
  `CREATE TABLE IF NOT EXISTS \`extra_lead_sources\` (
    \`sourceRef\` VARCHAR(64) NOT NULL PRIMARY KEY,
    \`leadId\` INT NULL,
    \`outcome\` VARCHAR(16) NOT NULL,
    \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

export const IDEMPOTENT_ERROR_CODES_0084 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME", "ER_TABLE_EXISTS_ERROR"]);
