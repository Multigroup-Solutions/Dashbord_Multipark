// Migration 0260 — parcerias por cidade AO VIVO (29 set 2026): que parcerias
// têm reservas em que centros (cidades), calculado da BD da Multipark e
// guardado num resumo pequeno (parceria × centro). O âmbito de cidade das
// Parcerias (cityScope.partnerScope) passa a ler este resumo em vez da cópia
// `multipark_bookings`. É um resumo derivado: o refresco substitui-o todo.

export const MIGRATION_0260_NAME = "0260_partner_city_presence";

export const MIGRATION_0260_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `partner_city_presence` ("
    + " `partnershipId` INT NOT NULL,"
    + " `projectId` INT NOT NULL,"
    + " `bookings` INT NOT NULL DEFAULT 0,"
    + " `lastCheckIn` DATETIME NULL,"
    + " `refreshedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,"
    + " PRIMARY KEY (`partnershipId`, `projectId`),"
    + " KEY `idx_partner_city_presence_project` (`projectId`)"
    + ")",
];

export const IDEMPOTENT_ERROR_CODES_0260 = new Set<string>(["ER_TABLE_EXISTS_ERROR"]);
