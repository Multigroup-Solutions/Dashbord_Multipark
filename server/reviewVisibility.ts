/**
 * Críticas que contam (Jorge, 15 out 2026): as que entraram SOZINHAS por
 * email ficam fora das Críticas e de todos os números — a regra pura é
 * `isEmailOnlyReview` (shared/reviewRules.ts); aqui a mesma regra em SQL.
 *
 * Uma crítica conta quando NÃO veio por email (`sourceEmailId` vazio), quando
 * está ligada a uma da API/Windsor (`googleReviewKey`) ou quando foi importada
 * (`emailImportedAt`: à mão, ou com o interruptor REVIEWS_FROM_EMAIL ligado).
 * Nada se apaga: é só um filtro na leitura.
 *
 * Só depende do esquema (pode ser importado pelo db.ts sem ciclos).
 */
import { isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { googleReviews } from "../drizzle/schema";

/** Condição Drizzle: a crítica está nas Críticas (não ficou só na caixa de correio). */
export function reviewInCriticas(): SQL {
  return or(isNull(googleReviews.sourceEmailId), isNotNull(googleReviews.googleReviewKey), isNotNull(googleReviews.emailImportedAt))!;
}

/** A mesma condição em SQL cru, com o alias da tabela (ex.: "r") ou sem ele. */
export function reviewInCriticasSql(alias?: string): SQL {
  if (alias && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error("alias inválido");
  const c =(name: string) => sql.raw(alias ? `${alias}.\`${name}\`` : `\`${name}\``);
  return sql`(${c("sourceEmailId")} IS NULL OR ${c("googleReviewKey")} IS NOT NULL OR ${c("emailImportedAt")} IS NOT NULL)`;
}
