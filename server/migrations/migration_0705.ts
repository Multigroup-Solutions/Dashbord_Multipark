// Migration 0705 — plano MPV, F7 (Extras Dia e Críticas 5★).
//
//  - extras_dia_alerts: um registo por aviso da escala que só pode sair UMA
//    vez (lembrete das 10:30/14:30 por dia e cidade, "dia mexido à mão — não
//    se confirmou", "ficaram por avisar", cobertura baixa, "completado às
//    14:30"). O INSERT IGNORE na chave única é a reserva: duas corridas ao
//    mesmo tempo nunca mandam o mesmo aviso duas vezes.
//  - review_auto_publish: fila das respostas automáticas às críticas de 5★
//    (interruptor REVIEW_AUTO_PUBLISH_5STAR, desligado por omissão). Uma linha
//    por crítica (nunca há segunda tentativa automática de outra resposta): o
//    texto preparado, quando sai (6 h depois), o estado (à espera, publicada,
//    cancelada, saltada com o motivo, falhada) e a verificação diária depois
//    de publicar. Nada se apaga: cancelar/saltar só muda o estado.
//
// Só acrescenta (tabelas novas com IF NOT EXISTS). Idempotente.

export const MIGRATION_0705_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `extras_dia_alerts` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`assignmentDate` VARCHAR(10) NOT NULL, " +
    "`city` VARCHAR(16) NOT NULL, " +
    "`kind` VARCHAR(32) NOT NULL, " +
    "`alertKey` VARCHAR(64) NOT NULL DEFAULT '', " +
    "`detail` VARCHAR(1000) NULL, " +
    "`recipients` INT NOT NULL DEFAULT 0, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_eda_alert` (`assignmentDate`, `city`, `kind`, `alertKey`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS `review_auto_publish` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`reviewId` INT NOT NULL, " +
    "`googleLocationId` INT NULL, " +
    "`projectId` INT NULL, " +
    "`status` VARCHAR(16) NOT NULL, " +
    "`replyText` TEXT NULL, " +
    "`reason` VARCHAR(300) NULL, " +
    "`scheduledFor` DATETIME NULL, " +
    "`attempts` INT NOT NULL DEFAULT 0, " +
    "`lastAttemptAt` DATETIME NULL, " +
    "`publishedAt` DATETIME NULL, " +
    "`channel` VARCHAR(12) NULL, " +
    "`cancelledById` INT NULL, " +
    "`cancelledAt` DATETIME NULL, " +
    "`verifiedAt` DATETIME NULL, " +
    "`alertedAt` DATETIME NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_rap_review` (`reviewId`), " +
    "KEY `idx_rap_status_when` (`status`, `scheduledFor`), " +
    "KEY `idx_rap_location_published` (`googleLocationId`, `publishedAt`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
];

export const IDEMPOTENT_ERROR_CODES_0705 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME"]);
