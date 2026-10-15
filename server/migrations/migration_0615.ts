// Migration 0615 — Extras-dia, Pressão: o tempo por carro separado em
// ENTREGAS e RECOLHAS (Jorge, 12 out 2026: "um quadro igual para as recolhas").
//  ops_pressure_stats ganha, nas cidades, o mesmo "tempo por carro" (início de
//  um serviço → início do seguinte do mesmo condutor) só dos serviços que
//  começaram com o início da entrega (cycleOut*) e só dos que começaram com o
//  início da recolha (cycleIn*): n e p50/p60/p75/p85/p90. cycleN continua a ser
//  os dois juntos (é o que a escala usa).
// Estatística derivada (o trabalho extras-pressure refaz-se a partir dos dias
// guardados; a parte por condutor tem versão nova e relê-se sozinha).
// Só acrescenta colunas. Idempotente: ADD COLUMN ignora o que já existe.
const col = (name: string, type: string) => `ALTER TABLE \`ops_pressure_stats\` ADD COLUMN \`${name}\` ${type}`;

export const MIGRATION_0615_STATEMENTS: string[] = [
  col("cycleOutN", "INT NOT NULL DEFAULT 0"),
  col("cycleOutP50", "DECIMAL(7,1) NULL"),
  col("cycleOutP60", "DECIMAL(7,1) NULL"),
  col("cycleOutP75", "DECIMAL(7,1) NULL"),
  col("cycleOutP85", "DECIMAL(7,1) NULL"),
  col("cycleOutP90", "DECIMAL(7,1) NULL"),
  col("cycleInN", "INT NOT NULL DEFAULT 0"),
  col("cycleInP50", "DECIMAL(7,1) NULL"),
  col("cycleInP60", "DECIMAL(7,1) NULL"),
  col("cycleInP75", "DECIMAL(7,1) NULL"),
  col("cycleInP85", "DECIMAL(7,1) NULL"),
  col("cycleInP90", "DECIMAL(7,1) NULL"),
];

export const IDEMPOTENT_ERROR_CODES_0615 = new Set<string>(["ER_DUP_FIELDNAME"]);
