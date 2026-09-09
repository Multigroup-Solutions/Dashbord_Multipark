/**
 * Rotas Express da integração Google Ads:
 *   GET /api/integrations/google-ads/oauth/start     (admin com sessão) → consentimento Google
 *   GET /api/integrations/google-ads/oauth/callback  → troca do código, guarda o token, descobre contas
 *   GET /api/cron/google-ads?kind=hourly|nightly|monthly  (Bearer CRON_SECRET) → recolha com prazo
 */
import type { Express, Request, Response } from "express";
import { sdk } from "../../_core/sdk";
import { OAUTH_CALLBACK_PATH, missingOAuthEnvs, readGoogleAdsConfig } from "./config";
import { buildConsentUrl, consumeOAuthState, createOAuthState, exchangeCodeForTokens, saveConnection, storeRefreshToken } from "./oauth";
import { refreshAccounts, runGoogleAdsSync } from "./sync";

const ROLE_RANK: Record<string, number> = { super_admin: 7, admin: 6 };
const PAGE = "/integracoes/google-ads";

function getOrigin(req: Request): string {
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
  const host = (req.headers["x-forwarded-host"] as string) || req.headers.host || "localhost:3000";
  return `${proto}://${host}`;
}

function escapeHtml(s: string) { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)); }
function errorPage(title: string, message: string): string {
  return `<!doctype html><html lang="pt"><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<body style="font-family:system-ui;max-width:640px;margin:60px auto;padding:0 20px;color:#1b2430">
<h1 style="font-size:20px">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>
<p><a href="${PAGE}">Voltar a Integrações → Google Ads</a></p></body></html>`;
}

export function registerGoogleAdsRoutes(app: Express) {
  // ── 1. início do consentimento ─────────────────────────────────────────────
  app.get("/api/integrations/google-ads/oauth/start", async (req: Request, res: Response) => {
    let user;
    try { user = await sdk.authenticateRequest(req); } catch { user = null; }
    if (!user || (ROLE_RANK[user.role] ?? 0) < ROLE_RANK.admin) {
      res.status(403).type("html").send(errorPage("Sem permissão", "Só administradores podem ligar o Google Ads. Inicia sessão na dashboard primeiro."));
      return;
    }
    const missing = missingOAuthEnvs();
    if (missing.length) {
      res.status(500).type("html").send(errorPage("Configuração incompleta", `Faltam variáveis no servidor: ${missing.join(", ")}. Ver .env.example (bloco Google Ads).`));
      return;
    }
    try {
      const state = await createOAuthState(user.id, typeof req.query.redirectTo === "string" ? req.query.redirectTo : null);
      res.redirect(302, buildConsentUrl(state, getOrigin(req)));
    } catch (err: any) {
      res.status(500).type("html").send(errorPage("Erro a iniciar a ligação", String(err?.message ?? err)));
    }
  });

  // ── 2. retorno da Google ───────────────────────────────────────────────────
  app.get(OAUTH_CALLBACK_PATH, async (req: Request, res: Response) => {
    const { code, state, error } = req.query as Record<string, string | undefined>;
    if (error) { res.status(400).type("html").send(errorPage("Autorização recusada", `A Google devolveu: ${error}`)); return; }
    if (!code || !state) { res.status(400).type("html").send(errorPage("Pedido inválido", "Faltam code/state.")); return; }
    const st = await consumeOAuthState(state);
    if (!st) { res.status(400).type("html").send(errorPage("Sessão OAuth expirada", "O pedido não corresponde a nenhum início válido (10 min). Volta a carregar em “Ligar Google Ads”.")); return; }
    try {
      const tokens = await exchangeCodeForTokens(code, getOrigin(req));
      const cfg = readGoogleAdsConfig();
      await storeRefreshToken(tokens, st.userId, cfg.loginCustomerId);
      // descobre as contas (não bloqueia a ligação se falhar — o developer token pode ainda não estar aprovado)
      let discovered = "";
      try {
        const r = await refreshAccounts();
        discovered = r.error ? `&accountsError=${encodeURIComponent(r.error.slice(0, 200))}` : `&accounts=${r.found}`;
      } catch (err: any) {
        discovered = `&accountsError=${encodeURIComponent(String(err?.message ?? err).slice(0, 200))}`;
        await saveConnection({ lastError: `Ligado, mas a listagem de contas falhou: ${String(err?.message ?? err).slice(0, 300)}` });
      }
      res.redirect(302, `${st.redirectTo || PAGE}?connected=1${discovered}`);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const hint = /redirect_uri_mismatch/i.test(msg)
        ? " O endereço de retorno enviado não coincide com o registado no cliente OAuth (Google Cloud → Clients → Authorized redirect URIs)."
        : /invalid_client/i.test(msg) ? " Confirma GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET." : "";
      res.status(500).type("html").send(errorPage("Não foi possível concluir a ligação", msg + hint));
    }
  });

  // ── 3. cron (GitHub Actions / Vercel) ─────────────────────────────────────
  app.get("/api/cron/google-ads", async (req: Request, res: Response) => {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers["authorization"] !== `Bearer ${secret}`) { res.status(401).json({ error: "Unauthorized" }); return; }
    const kindRaw = String(req.query.kind ?? "hourly");
    const kind = (["hourly", "nightly", "monthly", "initial"] as const).includes(kindRaw as any) ? (kindRaw as any) : "hourly";
    try {
      const r = await runGoogleAdsSync({ kind, deadlineAt: Date.now() + 45_000, triggeredById: null });
      res.json({ ranAt: new Date().toISOString(), ...r });
    } catch (err: any) {
      res.status(500).json({ ok: false, done: true, error: String(err?.message ?? err) });
    }
  });
}
