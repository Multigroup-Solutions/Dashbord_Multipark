/**
 * Guarda Express para rotas de ficheiros (/api/upload, /api/file/*): exige uma
 * sessão válida — o MESMO autenticador do contexto tRPC (cookie de sessão,
 * conta ativa). Sem sessão → 401 JSON.
 *
 * Nenhuma página pública usa estes endpoints (verificado: upload em RH/Radio/
 * Operacional/Formação e /api/file em Reclamações/Perdidos/Formação, todas
 * atrás de login; o <img>/fetch same-origin leva o cookie).
 */
import type { NextFunction, Request, Response } from "express";

type Authenticate = (req: Request) => Promise<unknown>;

export function makeRequireSession(authenticate: Authenticate) {
  return async function requireSession(req: Request, res: Response, next: NextFunction) {
    let user: unknown = null;
    try {
      user = await authenticate(req);
    } catch {
      user = null;
    }
    if (!user) {
      res.status(401).json({ error: "Sessão inválida ou expirada — volta a entrar." });
      return;
    }
    (req as any).sessionUser = user;
    next();
  };
}

/** Guarda com o autenticador real (import dinâmico: não arrasta a BD para testes). */
export const requireSession = makeRequireSession(async (req) => {
  const { sdk } = await import("./sdk");
  return sdk.authenticateRequest(req as any);
});
