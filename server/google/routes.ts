/**
 * Rotas HTTP do OAuth "Ligar a minha conta Google" + crons manuais google-sync/knowledge-sync/web-analytics (a sessão da app tem de
 * ser a mesma no início e no callback; o `state` é de uso único e ligado ao
 * utilizador). Os erros voltam à página de origem como `?google=error&msg=`.
 *
 * POST /api/google/push — notificações da Google (Calendário e Drive), sem
 * sessão: autenticadas pelo canal (id + segredo X-Goog-Channel-Token com
 * hash na BD + X-Goog-Resource-ID). Responde logo (200) e sincroniza só
 * aquele calendário/Drive em segundo plano (server/google/pushChannels.ts).
 */
import type { Express, Request, Response } from "express";
import { sdk } from "../_core/sdk";
import { cronAuthOk } from "../cronAuth";
import { GOOGLE_ACCOUNT_CALLBACK_PATH, GOOGLE_ACCOUNT_START_PATH, googleErrorMessage } from "./workspace";
import { GOOGLE_PUSH_PATH } from "../../shared/googlePush";

function withQuery(path: string, params: Record<string, string>): string {
  const [base, hash] = path.split("#");
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${new URLSearchParams(params).toString()}${hash ? `#${hash}` : ""}`;
}

export function registerGoogleAccountRoutes(app: Express, opts: { defer?: (p: Promise<unknown>) => void } = {}) {
  // Notificações da Google. O corpo vem vazio (tudo nos cabeçalhos); nunca
  // devolve pormenores. 404/401 fazem a Google desistir desse canal.
  app.post(GOOGLE_PUSH_PATH, async (req: Request, res: Response) => {
    try {
      const { handleGooglePush } = await import("./pushChannels");
      const out = await handleGooglePush(req.headers as Record<string, unknown>);
      res.status(out.status).end();
      if (out.key) {
        const key = out.key;
        const { markPending, drainPending } = await import("./pendingSync");
        const work = markPending([key], "push").then((keys) => (keys.length ? drainPending({ deadlineAt: Date.now() + 40_000, keys }) : null))
          .catch((err) => console.warn("[google-push] sincronização falhou:", String(err?.message ?? err).slice(0, 160)));
        if (opts.defer) opts.defer(work);
      }
    } catch {
      if (!res.headersSent) res.status(503).end();
    }
  });

  // Google Tarefas & Calendário (+ Contactos e Drive): rede de segurança do
  // agendador /api/cron/tick de 4 em 4 horas (o resto chega por eventos);
  // este endpoint fica para uso manual. Prazo 45 s; `done:false` → a corrida
  // seguinte continua.
  app.get("/api/cron/google-sync", async (req: Request, res: Response) => {
    if (!cronAuthOk(req.headers["authorization"])) { res.status(401).json({ error: "Unauthorized" }); return; }
    const { googleSyncCron, sendCronRun } = await import("../cronJobs");
    sendCronRun(res, await googleSyncCron({ deadlineAt: Date.now() + 45_000 }));
  });

  // Base de conhecimento: pastas do Shared Drive + documentos por processar.
  // SEM agenda (decisão do Jorge, 26 set 2026): só à mão — "Sincronizar
  // agora" na página ou este endpoint; os carregamentos processam-se logo.
  app.get("/api/cron/knowledge-sync", async (req: Request, res: Response) => {
    if (!cronAuthOk(req.headers["authorization"])) { res.status(401).json({ error: "Unauthorized" }); return; }
    const { knowledgeSyncCron, sendCronRun } = await import("../cronJobs");
    sendCronRun(res, await knowledgeSyncCron({ deadlineAt: Date.now() + 45_000 }));
  });

  // Web & SEO (GA4, Search Console, PageSpeed): o agendador corre-o 1×/dia
  // a partir das 09h (ou da hora das Definições, se for mais tarde), a
  // retomar enquanto `done:false`. Prazo 45 s.
  app.get("/api/cron/web-analytics", async (req: Request, res: Response) => {
    if (!cronAuthOk(req.headers["authorization"])) { res.status(401).json({ error: "Unauthorized" }); return; }
    const { webAnalyticsCron, sendCronRun } = await import("../cronJobs");
    sendCronRun(res, await webAnalyticsCron({ deadlineAt: Date.now() + 45_000 }));
  });

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
