// Migration 0825 — Exceções por data ao horário fixo (plano 63, passo 10b).
//
// Cada funcionário tem o seu horário fixo (`schedules`, por dia da semana) e
// o fim de semana RODA. `schedule_overrides` guarda, por pessoa e DIA DE
// CALENDÁRIO da entrada (Lisboa):
//  - `kind` 'work': trabalha das `startTime` às `endTime` ("HH:MM"; uma saída
//    ≤ entrada é no dia seguinte) — o fim de semana de serviço, um feriado de
//    serviço, uma troca;
//  - `kind` 'off': folga nesse dia — a folga de compensação, ou um sábado que
//    está no horário fixo mas não é a vez da pessoa.
// `reason`: weekend | holiday | compensation | swap | other.
//
// Uma ativa por pessoa e dia: `activeFlag` = 1 enquanto vale e NULL quando é
// cancelada, com UNIQUE (employeeId, day, activeFlag) — o MySQL deixa vários
// NULL, por isso as canceladas ficam todas. Por colunas (nunca um texto com o
// id lá dentro): juntar fichas muda o employeeId com UPDATE IGNORE e a chave
// continua certa. Cancelar não apaga (`cancelledAt`, `cancelledById`).
//
// Só cria; idempotente (CREATE TABLE IF NOT EXISTS → ER_TABLE_EXISTS_ERROR calado).
export const MIGRATION_0825_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `schedule_overrides` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`employeeId` INT NOT NULL, " +
    "`day` DATE NOT NULL, " +
    "`kind` VARCHAR(8) NOT NULL, " +
    "`startTime` VARCHAR(5) NULL, " +
    "`endTime` VARCHAR(5) NULL, " +
    "`reason` VARCHAR(16) NOT NULL DEFAULT 'other', " +
    "`city` VARCHAR(16) NULL, " +
    "`note` VARCHAR(255) NULL, " +
    "`activeFlag` TINYINT NULL DEFAULT 1, " +
    "`createdById` INT NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedById` INT NULL, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "`cancelledAt` TIMESTAMP NULL, " +
    "`cancelledById` INT NULL, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_schedule_overrides_active` (`employeeId`, `day`, `activeFlag`), " +
    "KEY `idx_schedule_overrides_day` (`day`, `activeFlag`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
];

export const IDEMPOTENT_ERROR_CODES_0825 = new Set<string>(["ER_TABLE_EXISTS_ERROR"]);
