// Migration 0580 — dias livres HABITUAIS (Jorge, 8 out 2026): "um esboço da
// escala dele, onde ele pode colocar os dias que tem livres. Não precisa de
// ser os dias exatos — ex.: tenho livres as terças-feiras à tarde e as quartas
// de manhã, e todos os fins de semana."
//
// Uma linha por ficha (`employeeId` único):
//   - `slots`  — JSON em texto, dia da semana → períodos
//                ({"tue":["afternoon"],"sat":["morning","afternoon","night"]});
//                regras em shared/availabilityPattern.ts (sempre normalizado);
//   - `note`   — texto livre curto ("não posso em agosto");
//   - `updatedById` — quem gravou (a própria pessoa ou o RH/supervisor).
// Gravar substitui a linha (INSERT … ON DUPLICATE KEY UPDATE); "Limpar" grava
// a grelha vazia — nunca se apaga. O histórico fica em activity_logs.
// Não toca na disponibilidade por semana (extras_availability).
//
// Só cria; idempotente (ER_TABLE_EXISTS_ERROR).
export const MIGRATION_0580_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `extras_availability_pattern` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`employeeId` INT NOT NULL, " +
    "`slots` TEXT NOT NULL, " +
    "`note` VARCHAR(300) NULL, " +
    "`updatedById` INT NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `extras_availability_pattern_emp_unique` (`employeeId`)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
];

export const IDEMPOTENT_ERROR_CODES_0580 = new Set<string>(["ER_TABLE_EXISTS_ERROR"]);
