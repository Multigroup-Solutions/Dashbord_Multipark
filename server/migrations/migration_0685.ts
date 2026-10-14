// Migration 0685 — Tempos de entrega e de recolha (plano 62, P6).
//
// `service_times`: uma linha por CICLO FECHADO de uma reserva — entrega
// (fecha no CHECK_OUT ou no CANCEL) ou recolha (fecha no CHECK_IN ou no
// CANCEL) —, calculada pelo trabalho noturno `service-times`
// (server/serviceTimesJob.ts, interruptor SERVICE_TIMES, desligado) a partir
// da "History" da Multipark (só leitura), das chamadas e do GPS do Zello.
//
// Chave: (kind, bookingId, anchorHistoryId) — a linha da History que fecha o
// ciclo. Estatística derivada: escreve-se por upsert; um ciclo que deixe de
// aparecer fica com `voidedAt` (volta a NULL se reaparecer). Nada se apaga.
// Nunca se guardam coordenadas, telefones nem dados do cliente.
//
// Tempos em ms (INT chega para 24 dias); instantes UTC com milissegundos;
// cada tempo tem o estado ("medido" ou o motivo de não haver medição).
// `calcVersion` + `paramsHash` (impressão digital das zonas, papéis das
// garagens e janela das chamadas) dizem com que regras a linha foi feita.
//
// Q7 (Jorge, 14 out 2026: "queremos tempos por pessoa"): cada tempo guarda o
// SEU condutor (ficha do RH) — Fila/Trânsito/Nosso: quem pegou no carro
// (startEmployeeId); Cliente da entrega: quem fez o check-out
// (deliverEmployeeId); no terminal e até à 1.ª garagem: quem tirou o carro
// (driverEmployeeId); Cliente da recolha e T2: quem fez o check-in
// (checkInEmployeeId); P2: quem o tirou do P2 (p2EmployeeId); até arrumado:
// quem o arrumou (parkedEmployeeId). Um índice (condutor, dia) para cada um,
// para as médias por condutor e período (semana, mês, 6 meses); a comparação
// com os colegas da mesma cidade e tipo de serviço usa (kind, opDay, cityKey).
//
// Só cria; idempotente (CREATE TABLE IF NOT EXISTS → ER_TABLE_EXISTS_ERROR calado).
export const MIGRATION_0685_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `service_times` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`kind` VARCHAR(8) NOT NULL, " +
    "`bookingId` VARCHAR(64) NOT NULL, " +
    "`anchorHistoryId` VARCHAR(64) NOT NULL, " +
    "`anchorAt` DATETIME(3) NOT NULL, " +
    "`outcome` VARCHAR(12) NOT NULL, " +
    "`bookingCode` VARCHAR(40) NULL, " +
    "`parkId` VARCHAR(64) NULL, " +
    "`cityKey` VARCHAR(8) NULL, " +
    "`parkGroup` VARCHAR(40) NULL, " +
    "`terminalClass` VARCHAR(8) NULL, " +
    "`opDay` DATE NOT NULL, " +
    "`refHour` TINYINT NULL, " +
    "`callAt` DATETIME(3) NULL, " +
    "`callSource` VARCHAR(10) NULL, " +
    "`callHeld` TINYINT NULL, " +
    "`requestAt` DATETIME(3) NULL, " +
    "`requestCount` INT NOT NULL DEFAULT 0, " +
    "`startSource` VARCHAR(12) NULL, " +
    "`customerMs` INT NULL, " +
    "`customerStatus` VARCHAR(32) NULL, " +
    "`zelloUsername` VARCHAR(255) NULL, " +
    "`gpsPoints` INT NULL, " +
    "`gpsMaxGapS` INT NULL, " +
    "`gpsPass` VARCHAR(10) NOT NULL DEFAULT 'none', " +
    "`flags` VARCHAR(600) NULL, " +
    // entregas
    "`startedAt` DATETIME(3) NULL, " +
    "`startAgentId` VARCHAR(64) NULL, " +
    "`startEmployeeId` INT NULL, " +
    "`startPlatform` VARCHAR(10) NULL, " +
    "`startRole` VARCHAR(16) NULL, " +
    "`arrivedAt` DATETIME(3) NULL, " +
    "`arrivedSource` VARCHAR(24) NULL, " +
    "`arrivedPrecisionS` INT NULL, " +
    "`buttonArrivedAt` DATETIME(3) NULL, " +
    "`buttonGapS` INT NULL, " +
    "`baggageWaitingAt` DATETIME(3) NULL, " +
    "`deliveredAt` DATETIME(3) NULL, " +
    "`deliverAgentId` VARCHAR(64) NULL, " +
    "`deliverEmployeeId` INT NULL, " +
    "`queueMs` INT NULL, " +
    "`transitMs` INT NULL, " +
    "`ourMs` INT NULL, " +
    "`totalMs` INT NULL, " +
    "`queueStatus` VARCHAR(32) NULL, " +
    "`transitStatus` VARCHAR(32) NULL, " +
    "`ourStatus` VARCHAR(32) NULL, " +
    // recolhas
    "`checkInAt` DATETIME(3) NULL, " +
    "`checkInAgentId` VARCHAR(64) NULL, " +
    "`checkInEmployeeId` INT NULL, " +
    "`driverEmployeeId` INT NULL, " +
    "`terminalExitAt` DATETIME(3) NULL, " +
    "`terminalExitSource` VARCHAR(24) NULL, " +
    "`terminalMs` INT NULL, " +
    "`terminalStatus` VARCHAR(32) NULL, " +
    "`firstGarage` VARCHAR(80) NULL, " +
    "`firstGarageRole` VARCHAR(12) NULL, " +
    "`firstGarageAt` DATETIME(3) NULL, " +
    "`toFirstGarageMs` INT NULL, " +
    "`p2ExitAt` DATETIME(3) NULL, " +
    "`p2Ms` INT NULL, " +
    "`p2Status` VARCHAR(32) NULL, " +
    "`p2EmployeeId` INT NULL, " +
    "`parkedGarage` VARCHAR(80) NULL, " +
    "`parkedAt` DATETIME(3) NULL, " +
    "`toParkedMs` INT NULL, " +
    "`parkedStatus` VARCHAR(16) NULL, " +
    "`parkedEmployeeId` INT NULL, " +
    "`spotType` VARCHAR(12) NULL, " +
    "`t2DriverArrivedAt` DATETIME(3) NULL, " +
    "`t2LateMs` INT NULL, " +
    "`t2Status` VARCHAR(32) NULL, " +
    // controlo
    "`calcVersion` INT NOT NULL, " +
    "`paramsHash` CHAR(16) NOT NULL, " +
    "`computedAt` DATETIME NOT NULL, " +
    "`voidedAt` DATETIME NULL, " +
    "PRIMARY KEY (`id`), " +
    "UNIQUE KEY `uq_service_times_cycle` (`kind`, `bookingId`, `anchorHistoryId`), " +
    "KEY `idx_service_times_day_city` (`kind`, `opDay`, `cityKey`), " +
    "KEY `idx_service_times_driver_day` (`startEmployeeId`, `opDay`), " +
    "KEY `idx_service_times_deliver_day` (`deliverEmployeeId`, `opDay`), " +
    "KEY `idx_service_times_pickup_driver_day` (`driverEmployeeId`, `opDay`), " +
    "KEY `idx_service_times_checkin_day` (`checkInEmployeeId`, `opDay`), " +
    "KEY `idx_service_times_p2_day` (`p2EmployeeId`, `opDay`), " +
    "KEY `idx_service_times_parked_day` (`parkedEmployeeId`, `opDay`), " +
    "KEY `idx_service_times_anchor` (`anchorAt`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
];

export const IDEMPOTENT_ERROR_CODES_0685 = new Set<string>(["ER_TABLE_EXISTS_ERROR"]);
