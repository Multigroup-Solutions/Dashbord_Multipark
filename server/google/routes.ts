/**
 * Rotas HTTP do OAuth "Ligar a minha conta Google" (a sessão da app tem de
 * ser a mesma no início e no callback; o `state` é de uso único e ligado ao
 * utilizador). Os erros voltam à página de origem como `?google=error&msg=`.
 */
import type { Express, Request, Response } from "express";
import { sdk } from "../_core/sdk";
import { GOOGLE_ACCOUNT_CALLBACK_PATH, GOOGLE_ACCOUNT_START_PATH, googleErrorMessage } from "./workspace";

function withQuery(path: string, params: Record<string, string>): string {
  const [base, hash] = path.split("#");
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${new URLSearchParams(params).toString()}${hash ? `#${hash}` : ""}`;
}

export function registerGoogleAccountRoutes(app: Express) {
  app.get(GOOGLE_ACCOUNT_START_PATH, async (req: Request, res: Response) => {
    const { safeReturnPath, requestedFeatures, startGoogleAccountOAuth } = await import("./userAccounts");
    const returnTo = safeReturnPath(req.query.returnTo);
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user) { res.status(401).type("text").send("Inicia sessão na aplicação antes de ligar a conta Google."); return; }
      res.redirect(302, await startGoogleAccountOAuth(user, { features: requestedFeatures(req.query.features), returnTo }));
    } catch (err) {
      res.redirect(302, withQuery(returnTo, { google: "error", msg: googleErrorMessage(err).slice(0, 200) }));
    }
  });

  app.get(GOOGLE_ACCOUNT_CALLBACK_PATH, async (req: Request, res: Response) => {
    const { consumeGoogleAccountState, finishGoogleAccountOAuth } = await import("./userAccounts");
    let returnTo = "/perfil";
    try {
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user) { res.status(401).type("text").send("Sessão expirada — inicia sessão e volta a ligar a conta Google."); return; }
      const { state, code, error } = req.query;
      if (typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state)) { res.status(400).type("text").send("Pedido OAuth inválido."); return; }
      const st = await consumeGoogleAccountState(state, user.id);
      if (!st) { res.redirect(302, withQuery(returnTo, { google: "error", msg: "Pedido expirado — tenta outra vez." })); return; }
      returnTo = st.returnTo;
      if (error || typeof code !== "string") {
        res.redirect(302, withQuery(returnTo, { google: "error", msg: error === "access_denied" ? "Autorização recusada." : "Autorização não concluída." }));
        return;
      }
      const r = await finishGoogleAccountOAuth(code, st.verifier, user);
      try {
        const { logActivity } = await import("../db");
        await logActivity({ userId: user.id, action: "connect", entity: "google_account", entityId: null, details: `Conta Google ligada: ${r.email}` } as any);
      } catch { /* registo nunca parte a ligação */ }
      res.redirect(302, withQuery(returnTo, { google: "connected" }));
    } catch (err) {
      res.redirect(302, withQuery(returnTo, { google: "error", msg: googleErrorMessage(err).slice(0, 200) }));
    }
  });
}
