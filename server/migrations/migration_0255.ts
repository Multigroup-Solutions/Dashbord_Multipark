// Migration 0255 — reservas ao vivo, parte B (29 set 2026): os serviços extra
// passam a ser lidos AO VIVO da Multipark (BookingExtraService); o "feito"
// marcado na página Serviços fica do nosso lado, por linha de serviço
// (a BD da Multipark é só de leitura). Os "feitos" antigos
// (multipark_booking_extras.done) passam uma vez; nada se apaga.

export const MIGRATION_0255_NAME = "0255_service_extra_done";

export const MIGRATION_0255_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `service_extra_done` ("
    + " `id` INT AUTO_INCREMENT PRIMARY KEY,"
    + " `bookingExternalId` VARCHAR(128) NOT NULL,"
    + " `lineId` VARCHAR(128) NOT NULL,"
    + " `done` TINYINT NOT NULL DEFAULT 0,"
    + " `userId` INT NULL,"
    + " `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,"
    + " UNIQUE KEY `uq_service_extra_done_line` (`lineId`),"
    + " KEY `idx_service_extra_done_booking` (`bookingExternalId`)"
    + ")",
  "INSERT IGNORE INTO `service_extra_done` (`bookingExternalId`, `lineId`, `done`)"
    + " SELECT `bookingExternalId`, `extraId`, 1 FROM `multipark_booking_extras` WHERE `done` = 1 AND `extraId` IS NOT NULL AND `extraId` <> ''",
];

export const IDEMPOTENT_ERROR_CODES_0255 = new Set<string>(["ER_TABLE_EXISTS_ERROR"]);
