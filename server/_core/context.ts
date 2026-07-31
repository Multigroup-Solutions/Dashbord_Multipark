import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { ACCESS_DENIED_MSG } from "@shared/const";
import type { User } from "../../drizzle/schema";
import { sdk } from "./sdk";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
  /**
   * `true` quando havia uma sessão VÁLIDA mas a conta não tem acesso (conta
   * desativada / sem linha em `users`). Distinto de "anónimo": permite ao
   * `auth.me` responder com a mensagem única em vez de um simples "não
   * autenticado", que levaria a pessoa a tentar entrar em ciclo.
   */
  accessDenied: boolean;
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: User | null = null;
  let accessDenied = false;

  try {
    user = await sdk.authenticateRequest(opts.req);
  } catch (error) {
    // Authentication is optional for public procedures.
    user = null;
    accessDenied = (error as { message?: string })?.message === ACCESS_DENIED_MSG;
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
    accessDenied,
  };
}
