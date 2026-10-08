/**
 * MARKETPLACE em SQL — os fragmentos ÚNICOS (BD da Multipark, só leitura).
 * Antes havia quatro cópias da mesma expressão (partners, partnerBilling,
 * partnerships, marketingBookings) e duas regras diferentes para "é
 * Marketplace" (Jorge, 8 out 2026: "têm que aparecer TODAS as reservas feitas
 * no marketplace, seja de que parque for").
 *
 * Duas perguntas diferentes, dois fragmentos:
 *   1. "É uma reserva do Marketplace?" — a regra única de
 *      shared/marketplace.ts (isMarketplaceBooking): parque que NÃO é nosso
 *      (todas as reservas) OU origem MARKETPLACE. Listas e contagens:
 *      Operações, Marketing, Parcerias.
 *   2. "É uma venda do Marketplace COM comissão nossa?" — origem MARKETPLACE
 *      ou comissão gravada > 0. Para o DINHEIRO (faturação do Marketplace,
 *      comissão nas Parcerias e na ficha do parque no CRM) e para "clientes
 *      nossos" no CRM (os clientes que o parque de terceiros angariou sozinho
 *      não são nossos). Não muda nenhum valor faturado.
 * O alias da tabela "Booking" é sempre `b`.
 */
import { MARKETPLACE_ORIGIN } from "../../shared/marketplace";

/** Reserva vinda pelo Marketplace (multipark.pt) — `origin = 'MARKETPLACE'`. */
export const MARKETPLACE_ORIGIN_SQL = `b."origin"::text = '${MARKETPLACE_ORIGIN}'`;

/**
 * Reserva do Marketplace (regra única, isMarketplaceBooking) em SQL.
 * `oursCond` = condição "o parque é nosso" (ex.: `b."parkId" IN ($1, $2)`, ou
 * "FALSE" sem parques nossos); `originSql` = o valor a comparar (literal ou
 * parâmetro). PURA.
 */
export function marketplaceBookingSql(oursCond: string, originSql = `'${MARKETPLACE_ORIGIN}'`): string {
  return `(NOT (${oursCond}) OR b."origin"::text = ${originSql})`;
}

/**
 * Venda do Marketplace COM comissão nossa: origem MARKETPLACE ou comissão
 * gravada ("commissionAmount") > 0. Só para dinheiro e "clientes nossos".
 */
export const MARKETPLACE_COMMISSIONED_SQL = `(${MARKETPLACE_ORIGIN_SQL} OR COALESCE(b."commissionAmount", 0) > 0)`;
