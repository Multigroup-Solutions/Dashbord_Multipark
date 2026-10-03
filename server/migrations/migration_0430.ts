// Migration 0430 — Extras-dia, Pressão: tempos por condutor (P3 lote 22d, fase 1
// da capacidade aprendida — Jorge, 3 out 2026).
//  ops_pressure_stats ganha, nas cidades:
//   - condutor por carro (início de um serviço → início do seguinte do mesmo
//     condutor): cycleN e p50/p60/p75/p85/p90;
//   - na estrada (início da entrega → entregue): driveN, p50/p75/p90;
//   - até ao parque (recolhido → 1.º movimento): toParkN, p50/p75;
//   - pessoas por hora (média): crewAvg;
//   - linhas kind = 'crew' (escalão de pessoas × hora cheia), com bandLabel.
// Estatística derivada (a corrida refaz-se a partir da BD da Multipark).
// Idempotente: ADD COLUMN ignora o que já existe.
const col = (name: string, type: string) => `ALTER TABLE \`ops_pressure_stats\` ADD COLUMN \`${name}\` ${type}`;

export const MIGRATION_0430_STATEMENTS: string[] = [
  col("cycleN", "INT NOT NULL DEFAULT 0"),
  col("cycleP50", "DECIMAL(7,1) NULL"),
  col("cycleP60", "DECIMAL(7,1) NULL"),
  col("cycleP75", "DECIMAL(7,1) NULL"),
  col("cycleP85", "DECIMAL(7,1) NULL"),
  col("cycleP90", "DECIMAL(7,1) NULL"),
  col("driveN", "INT NOT NULL DEFAULT 0"),
  col("driveP50", "DECIMAL(7,1) NULL"),
  col("driveP75", "DECIMAL(7,1) NULL"),
  col("driveP90", "DECIMAL(7,1) NULL"),
  col("toParkN", "INT NOT NULL DEFAULT 0"),
  col("toParkP50", "DECIMAL(7,1) NULL"),
  col("toParkP75", "DECIMAL(7,1) NULL"),
  col("crewAvg", "DECIMAL(5,1) NULL"),
  col("bandLabel", "VARCHAR(16) NULL"),
];

export const IDEMPOTENT_ERROR_CODES_0430 = new Set<string>(["ER_DUP_FIELDNAME"]);
