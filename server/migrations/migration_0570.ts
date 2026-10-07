// Migration 0570 — "Pressão" do Extras-Dia guardada POR DIA (47c, 7 out 2026).
//
// Decisão do Jorge: ler UMA vez desde extras.timesSince e depois só o dia
// novo, acrescentando. Uma linha por (grupo de parques, parte, dia de Lisboa):
//   part = 'group'  — por hora: check-ins/check-outs feitos e começados,
//                     durações das entregas e das recolhas (ms), carros em
//                     mãos por hora de relógio;
//   part = 'driver' — por hora (só cidades): serviços começados, tempo por
//                     carro / na estrada / até ao parque (ms) e quem agiu.
// `payload` é JSON (server/pressureDays.ts). `sig` = versão do cálculo +
// parques do grupo (se mudarem, o dia volta a ler-se); `readEnd` = janela da
// leitura que o calculou. O trabalho `extras-pressure` junta os dias e escreve
// o mesmo ops_pressure_stats de sempre (a página não muda).
// Estatística derivada: substitui-se por (grupo, parte, dia); nunca se apaga.
// Só cria; idempotente (ER_TABLE_EXISTS_ERROR).
export const MIGRATION_0570_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `ops_pressure_days` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`parkGroup` VARCHAR(40) NOT NULL, " +
    "`part` VARCHAR(8) NOT NULL, " +
    "`day` DATE NOT NULL, " +
    "`sig` VARCHAR(64) NOT NULL, " +
    "`readEnd` DATE NOT NULL, " +
    "`events` INT NOT NULL DEFAULT 0, " +
    "`payload` MEDIUMTEXT NOT NULL, " +
    "`computedAt` DATETIME NOT NULL, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_ops_pressure_day` (`parkGroup`, `part`, `day`)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
];

export const IDEMPOTENT_ERROR_CODES_0570 = new Set<string>(["ER_TABLE_EXISTS_ERROR"]);
