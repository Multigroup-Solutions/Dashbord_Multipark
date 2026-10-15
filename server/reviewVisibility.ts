/**
 * Críticas que contam (Jorge, 15 out 2026): as que entraram SOZINHAS por
 * email ficam fora das Críticas e de todos os números — a regra pura é
 * `isEmailOnlyReview` (shared/reviewRules.ts); aqui a mesma regra em SQL.
 *
 * Uma crítica conta quando NÃO veio por email (`sourceEmailId` vazio), quando
 * está ligada a uma da API/Windsor (`googleReviewKey`) ou quando foi importada
 * (`emailImportedAt`: à mão, ou com o interruptor REVIEWS_FROM_EMAIL ligado).
 * Vazio = NULL ou só espaços, como na regra pura (a lista e o "só consulta"
 * nunca discordam). Nada se apaga: é só um filtro na leitura.
 *
 * Só depende do esquema (pode ser importado pelo db.ts sem ciclos).
 */
import { sql, type SQL } from "drizzle-orm";
import { googleReviews } from "../drizzle/schema";

/** Condição Drizzle: a crítica está nas Críticas (não ficou só na caixa de correio). */
export function reviewInCriticas(): SQL {
  return sql`(NULLIF(TRIM(${googleReviews.sourceEmailId}), '') IS NULL OR NULLIF(TRIM(${googleReviews.googleReviewKey}), '') IS NOT NULL OR ${googleReviews.emailImportedAt} IS NOT NULL)`;
}

/** A mesma condição em SQL cru, com o alias da tabela (ex.: "r") ou sem ele. */
export function reviewInCriticasSql(alias?: string): SQL {
  if (alias && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error("alias inválido");
  const c = (name: string) => sql.raw(alias ? `${alias}.\`${name}\`` : `\`${name}\``);
  return sql`(NULLIF(TRIM(${c("sourceEmailId")}), '') IS NULL OR NULLIF(TRIM(${c("googleReviewKey")}), '') IS NOT NULL OR ${c("emailImportedAt")} IS NOT NULL)`;
}

/**
 * Conciliação da API/Windsor (a crítica que chega pela API pode ser uma que já
 * cá está): candidatas são as que estão nas Críticas e, das que ficaram só no
 * email, as que já viraram reclamação — ligar a da API a essa mantém a
 * reclamação (senão a da API abria outra para a mesma crítica). As outras que
 * ficaram só no email não prendem a da API "por conciliar".
 */
export function reviewLinkableToApi(): SQL {
  return sql`(${reviewInCriticas()} OR ${googleReviews.complaintId} IS NOT NULL)`;
}
