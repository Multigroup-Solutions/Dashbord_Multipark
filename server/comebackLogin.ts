/**
 * 49c (Jorge, 8 out 2026): no login, quem está INATIVO (e não DESATIVADO)
 * volta a entrar como utilizador — vê a ficha, atualiza os dados e os dias
 * livres e diz "Voltei". Regra PURA em shared/comeback.ts; aqui só se lê e
 * aplica. Nunca parte o login: em falha, segue a regra de sempre.
 */
import { COMEBACK_LOGIN_LOG, loginComebackDecision, type LoginAccount } from "../shared/comeback";
import { convertSuspensionToInactive, loadLoginFichas, logComeback, reactivateAccountAsUser } from "./comebackStore";

export type LoginComebackOutcome = "none" | "reactivated" | "converted";

export async function resolveLoginComeback(account: LoginAccount): Promise<LoginComebackOutcome> {
  const fichas = await loadLoginFichas(account.id);
  if (!fichas) return "none";
  const decision = loginComebackDecision(account, fichas);
  if (decision.kind === "reactivate") {
    await reactivateAccountAsUser(account.id);
    await logComeback(account.id, decision.employeeId, COMEBACK_LOGIN_LOG);
    invalidate(account.id);
    return "reactivated";
  }
  if (decision.kind === "convert_suspension") {
    await convertSuspensionToInactive(decision.employeeId, account.id);
    await logComeback(account.id, decision.employeeId, `Estava "Suspenso: sem atividade": passou a inativo (motivo Inatividade) e a conta a utilizador. ${COMEBACK_LOGIN_LOG}`);
    invalidate(account.id);
    return "converted";
  }
  return "none";
}

function invalidate(userId: number): void {
  import("./loginBlock").then((m) => m.invalidateLoginBlock(userId)).catch(() => undefined);
}
