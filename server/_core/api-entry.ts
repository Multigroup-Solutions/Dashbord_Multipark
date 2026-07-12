import express from "express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { createExternalApiRouter } from "../externalApi";
import { createMcpApiRouter } from "../mcpApi";
import { createWhatsappWebhookRouter } from "../whatsappWebhook";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { sdk } from "./sdk";
import { getBookingTryAllParks } from "../multipark";

const app = express();
app.set("trust proxy", 1);
// WhatsApp webhook (Meta) — MONTADO ANTES do express.json global: a validação
// da assinatura HMAC precisa do raw body intacto (usa express.raw internamente).
app.use("/api/whatsapp/webhook", createWhatsappWebhookRouter());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

let initError: string | null = null;

try {
  registerOAuthRoutes(app);
  app.use("/api/external", createExternalApiRouter());
  app.use("/api/v1", createMcpApiRouter());

  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
} catch (err: any) {
  initError = err.stack || err.message || String(err);
  console.error("[API Init Error]", initError);
}

// Debug endpoint: fetch raw booking JSON straight from MultiPark API.
// Admin-only (session cookie). Usage: /api/debug/booking?id=cm...
app.get("/api/debug/booking", async (req, res) => {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user || user.role !== "admin" && user.role !== "super_admin") {
      return res.status(403).json({ error: "Forbidden — admin only" });
    }
    const id = String(req.query.id ?? "").trim();
    if (!id) return res.status(400).json({ error: "Missing ?id=<externalId>" });

    const found = await getBookingTryAllParks(id);
    if (!found) {
      return res.status(404).json({
        error: "Reserva não encontrada em nenhum parque",
        triedKeys: Object.keys(process.env).filter(k => k.startsWith("MULTIPARK_API_KEY_")),
      });
    }

    return res.json({
      park: `${found.parkConfig.name} (${found.parkConfig.city})`,
      parkId: found.parkConfig.id,
      booking: found.booking,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || String(err) });
  }
});

// Debug endpoint: tenta várias URLs / params para descobrir se há algum
// caminho onde a API devolve o nome real do parceiro.
// Uso: /api/debug/probe-partner?id=<externalId>
app.get("/api/debug/probe-partner", async (req, res) => {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
      return res.status(403).json({ error: "Forbidden — admin only" });
    }
    const id = String(req.query.id ?? "").trim();
    if (!id) return res.status(400).json({ error: "Missing ?id=<externalId>" });

    // Primeiro descobre qual parque é (para usar a chave certa)
    const { getBookingTryAllParks, PARK_CONFIGS, getParkApiKey } = await import("../multipark");
    const found = await getBookingTryAllParks(id);
    if (!found) return res.status(404).json({ error: "Reserva não encontrada" });

    const apiKey = getParkApiKey(found.parkConfig);
    if (!apiKey) return res.status(500).json({ error: "Sem API key para o parque" });

    const partnerId = (found.booking as any).partnerId;
    const base = process.env.MULTIPARK_API_URL || "https://api.multipark.pt/api/v1/bookings-api";
    const baseRoot = base.replace(/\/bookings-api$/, "");

    // Lista de URLs/params para testar
    const probes: { name: string; url: string }[] = [
      { name: "GET /partners/:partnerId", url: `${base}/partners/${partnerId}` },
      { name: "GET /partner/:partnerId", url: `${base}/partner/${partnerId}` },
      { name: "GET /users/:partnerId", url: `${base}/users/${partnerId}` },
      { name: "GET /agents/:partnerId", url: `${base}/agents/${partnerId}` },
      { name: "GET /agent/:partnerId", url: `${base}/agent/${partnerId}` },
      { name: "GET /bookings/:id?include=partner", url: `${base}/bookings/${id}?include=partner` },
      { name: "GET /bookings/:id?expand=partner", url: `${base}/bookings/${id}?expand=partner` },
      { name: "GET /bookings/:id?fields=*", url: `${base}/bookings/${id}?fields=*` },
      { name: "GET /bookings/:id/partner", url: `${base}/bookings/${id}/partner` },
      { name: "GET /bookings/:id/details", url: `${base}/bookings/${id}/details` },
      { name: "GET /partners (lista)", url: `${base}/partners` },
      { name: "GET (root)/partners/:partnerId", url: `${baseRoot}/partners/${partnerId}` },
      { name: "GET (root)/users/:partnerId", url: `${baseRoot}/users/${partnerId}` },
    ];

    const results: any[] = [];
    for (const probe of probes) {
      try {
        const r = await fetch(probe.url, {
          headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
        });
        const status = r.status;
        let body: any = null;
        try { body = await r.json(); } catch {}
        results.push({
          probe: probe.name,
          url: probe.url,
          status,
          ok: r.ok,
          body: r.ok ? body : (body?.message ?? body?.error ?? "—"),
        });
      } catch (err: any) {
        results.push({ probe: probe.name, url: probe.url, error: err.message });
      }
    }

    return res.json({
      bookingId: id,
      partnerId,
      partnerNameFromReport: (found.booking as any).partnerName,
      probes: results,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || String(err) });
  }
});

// ─── Vercel Cron Jobs ────────────────────────────────────────────────────────
// Vercel chama estes endpoints com Authorization: Bearer <CRON_SECRET>. Em
// ausência da env var, qualquer chamada é permitida (útil em dev).
function cronAuthOk(req: any): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.headers["authorization"] === `Bearer ${secret}`;
}

app.get("/api/cron/multipark-sync", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { runRecentCronSync } = await import("../jobs/multiparkBookingSync");
    const result = await runRecentCronSync(30);
    res.json({ ok: true, ranAt: new Date().toISOString(), ...result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

app.get("/api/cron/multipark-future", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { runFutureCronSync } = await import("../jobs/multiparkBookingSync");
    const result = await runFutureCronSync(4);
    res.json({ ok: true, ranAt: new Date().toISOString(), ...result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

// Recolha diária de operações (driver history do Zello + alertas gps_off).
// Substitui o startDailyCollectionScheduler() que só corre no server Railway —
// em Vercel é preciso este cron (GitHub Actions, 1×/dia).
app.get("/api/cron/daily-ops", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { collectDailyDriverData } = await import("../jobs/dailyDriverCollection");
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000); // dia anterior
    const result = await collectDailyDriverData(yesterday);
    res.json({ ok: true, ranAt: new Date().toISOString(), date: yesterday.toISOString().slice(0, 10), ...result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

// Leitor de email inbound: lê a caixa reservas@ por IMAP e cria registos nos
// módulos (Críticas/Reclamações/Perdidos/RH) a partir dos emails reencaminhados
// para os aliases. Substitui o fluxo Make.com. GitHub Actions chama a cada ~15min.
app.get("/api/cron/email-inbound", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { runEmailInboundSync } = await import("../jobs/emailInboundSync");
    const result = await runEmailInboundSync();
    res.json({ ok: result.configured, ranAt: new Date().toISOString(), ...result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

app.get("/api/cron/multipark-cleanup", async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { getDb } = await import("../db");
    const { sql } = await import("drizzle-orm");
    const db = await getDb();
    if (!db) return res.status(500).json({ ok: false, error: "DB not available" });
    const result = await db.execute(sql`
      DELETE FROM multipark_bookings WHERE id IN (
        SELECT id FROM (
          SELECT b1.id FROM multipark_bookings b1
          INNER JOIN multipark_bookings b2
            ON b1.externalId = b2.externalId
           AND (
                 b1.updatedAt < b2.updatedAt
              OR (b1.updatedAt = b2.updatedAt AND b1.id < b2.id)
           )
          LIMIT 5000
        ) AS t
      )
    `) as any;
    const meta = Array.isArray(result[0]) ? result[0] : result;
    const deleted = Number((meta as any)?.affectedRows ?? 0);
    res.json({ ok: true, ranAt: new Date().toISOString(), deleted });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

// Health check com diagnóstico de env vars críticas (sem expor valores)
app.get("/api/health", (_req, res) => {
  res.json({
    ok: !initError,
    error: initError,
    env: {
      DATABASE_URL: !!process.env.DATABASE_URL,
      JWT_SECRET: !!process.env.JWT_SECRET,
      GOOGLE_CLIENT_ID: !!process.env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: !!process.env.GOOGLE_CLIENT_SECRET,
      VITE_APP_ID: !!process.env.VITE_APP_ID,
      NODE_ENV: process.env.NODE_ENV ?? null,
      WHATSAPP_TOKEN: !!process.env.WHATSAPP_TOKEN,
      WHATSAPP_PHONE_NUMBER_ID: !!process.env.WHATSAPP_PHONE_NUMBER_ID,
      WHATSAPP_VERIFY_TOKEN: !!process.env.WHATSAPP_VERIFY_TOKEN,
      WHATSAPP_APP_SECRET: !!process.env.WHATSAPP_APP_SECRET,
      AVAILABILITY_FORM_TOKEN_SECRET: !!process.env.AVAILABILITY_FORM_TOKEN_SECRET,
    },
  });
});

// Handler for Vercel serverless
const handler = async (req: any, res: any) => {
  if (initError && !req.url.includes("/api/health")) {
    return res.status(500).json({ error: "Server init failed", details: initError });
  }
  app(req, res);
};

export default handler;
