/**
 * Plano 56 (A2): o código de entrada por email — preparado e desligado (a
 * definição `login.codeDelivery` vem em "duty": o código vai ao TL/supervisor).
 *
 *  - Sai da conta PRÓPRIA acesso@multipark.pt (delegação), nunca de uma caixa
 *    da Comunicação: se a acesso@ estiver configurada como caixa (ou alias de
 *    uma), o servidor recusa enviar — a resposta da pessoa e o próprio email
 *    iam parar à Comunicação com o código.
 *  - Leva `X-Multipark-Login` (a sincronização salta-o: nunca fica guardado) e
 *    os cabeçalhos de sistema (`kind: "system"`).
 *  - Texto: o código e "escreve-o no aparelho onde pediste" — sem link.
 *  - Nunca lança: devolve `ok: false` (e quem chama cai no TL/supervisor).
 */
import { LOGIN_CODE_SENDER, loginCodeEmail } from "../shared/loginCode";
import { LOGIN_MAIL_HEADER } from "../shared/mail";
import type { SendEmailOptions, SendResult } from "./mail/systemMail";

export interface LoginMailDeps {
  /** O endereço é uma caixa (ou alias de uma caixa) da Comunicação? */
  isMailbox(address: string): Promise<boolean>;
  send(o: SendEmailOptions): Promise<SendResult>;
}

export interface LoginMailResult { ok: boolean; error?: string; refused?: "mailbox" }

export async function sendLoginCodeEmailWith(deps: LoginMailDeps, input: { to: string; code: string; sender?: string }): Promise<LoginMailResult> {
  const from = String(input.sender ?? LOGIN_CODE_SENDER).trim().toLowerCase();
  let mailbox = true;
  try { mailbox = await deps.isMailbox(from); } catch { mailbox = true; } // sem confirmar → não envia
  if (mailbox) return { ok: false, refused: "mailbox", error: `O remetente ${from} é uma caixa da Comunicação — o código não sai por aí.` };
  const { subject, text } = loginCodeEmail(input.code);
  try {
    const r = await deps.send({
      to: input.to, subject, text, kind: "system", account: from, fromName: "Multipark",
      headers: { [LOGIN_MAIL_HEADER]: "1" },
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error ?? "não enviado" };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err).slice(0, 200) };
  }
}

export async function sendLoginCodeEmail(input: { to: string; code: string }): Promise<LoginMailResult> {
  const [{ loginStore }, { sendEmailDetailed }] = await Promise.all([import("./loginStore"), import("./mail/systemMail")]);
  return sendLoginCodeEmailWith({ isMailbox: (a) => loginStore().isMailboxAddress(a), send: sendEmailDetailed }, input);
}
