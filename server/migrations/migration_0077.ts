// Migration 0077 — cidade dos leads de extras (Jorge, 24 set 2026).
//
// Os leads não tinham cidade: quem é do Porto via os de Lisboa. `projectId` =
// centro de custos (cidade) de quem criou o lead, ou o escolhido; NULL nos
// leads antigos (continuam visíveis a todos).

export const MIGRATION_0077_NAME = "0077_extra_leads_city";

export const MIGRATION_0077_STATEMENTS: string[] = [
  "ALTER TABLE `extra_leads` ADD COLUMN `projectId` INT NULL",
  "ALTER TABLE `extra_leads` ADD KEY `idx_extra_leads_project` (`projectId`)",
];

export const IDEMPOTENT_ERROR_CODES_0077 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
