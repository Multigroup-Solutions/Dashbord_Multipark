/**
 * Plano 63 (passo 11): a expressão ÚNICA das ausências que contam — só as
 * APROVADAS, e nunca a indisponibilidade dos extras (`unavailable`, que só o
 * Extras-Dia lê). Todos os leitores de `employee_leaves` (folha, Avaliação,
 * possíveis faltas, dias de férias do mês) passam por aqui; um teste procura
 * os leitores em `server/` e falha se algum a esquecer
 * (server/ferias63.test.ts, com a lista de exceções escrita).
 *
 * As pedidas, as recusadas e as canceladas não contam em lado nenhum.
 */
import { sql, type SQL } from "drizzle-orm";

/**
 * `status = 'approved' AND leaveType <> 'unavailable'`, opcionalmente com o
 * prefixo da tabela (ex.: "l"). Serve no SQL escrito à mão e no `where` do
 * drizzle (colunas sem prefixo).
 */
export function approvedLeaveSql(alias?: string): SQL {
  const p = alias ? `${alias.replace(/[^A-Za-z0-9_]/g, "")}.` : "";
  return sql.raw(`(${p}\`status\` = 'approved' AND ${p}\`leaveType\` <> 'unavailable')`);
}

/** Só as de dia inteiro (sem `hours`): o horário desse dia sai todo (faltas automáticas). */
export function fullDayLeaveSql(alias?: string): SQL {
  const p = alias ? `${alias.replace(/[^A-Za-z0-9_]/g, "")}.` : "";
  return sql.raw(`${p}\`hours\` IS NULL`);
}
