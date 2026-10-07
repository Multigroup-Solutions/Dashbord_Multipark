// Migration 0495 — Central Vodafone (lote 39d): a chamada guarda a que
// contacto a consola a ligou ("crm-123" ficha do CRM, "ct-4" contacto do CRM,
// "emp-7" ficha do RH, "tel-351…" só o número). Só acrescenta. Idempotente.
export const MIGRATION_0495_STATEMENTS: string[] = [
  "ALTER TABLE `central_calls` ADD COLUMN `contactRef` VARCHAR(40) NULL",
];

export const IDEMPOTENT_ERROR_CODES_0495 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
