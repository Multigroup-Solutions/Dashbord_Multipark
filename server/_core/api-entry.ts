import express from "express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { createExternalApiRouter } from "../externalApi";
import { createMcpApiRouter } from "../mcpApi";
import { createWhatsappWebhookRouter } from "../whatsappWebhook";
import { createMultiparkWebhookRouter } from "../multiparkWebhook";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { sdk } from "./sdk";
import { getBookingTryAllParks } from "../multipark";

const app = express();
app.set("trust proxy", 1);
// WhatsApp webhook (Meta) — MONTADO ANTES do express.json global: a validação
// da assinatura HMAC precisa do raw body intacto (usa express.raw internamente).
app.use("/api/whatsapp/webhook", createWhatsappWebhookRouter());
// Webhook das Conexões Multipark (reservas em tempo real) — também precisa do
// raw body para o HMAC, por isso monta antes do express.json.
app.use("/api/multipark/webhook", createMultiparkWebhookRouter());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

let initError: string | null = null;

try {
  registerOAuthRoutes(app);
  app.use("/api/external", createExternalApiRouter());
  app.use("/api/v1", createMcpApiRouter());

  // Upload multipart (paridade com o index.ts do Railway — os PDAs usam isto
  // p/ a foto de entrada/saída do check-in; sem isto o Vercel dava 404).
  // NOTA: o Vercel limita o body a ~4.5MB — o cliente redimensiona antes.
  app.post("/api/upload", async (req, res, next) => {
    const multer = (await import("multer")).default;
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });
    upload.single("file")(req as any, res as any, async (err: any) => {
      if (err) return res.status(400).json({ error: err.message || "Upload inválido" });
      try {
        const file = (req as any).file;
        if (!file) return res.status(400).json({ error: "No file" });
        const { storagePut } = await import("../storage");
        const ext = file.originalname?.split(".").pop() || "bin";
        const key = `uploads/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        const { url } = await storagePut(key, file.buffer, file.mimetype);
        return res.json({ url, key });
      } catch (e: any) {
        console.error("[Upload] Error:", e);
        return res.status(500).json({ error: e.message || "Upload failed" });
      }
    });
  });

  // Resolve um ficheiro do storage pela KEY (ex.: training/manuals/...).
  // Necessário porque URLs relativas "/uploads/..." gravadas na BD não são
  // servidas no Vercel (o rewrite manda tudo o que não é /api p/ o index.html).
  app.get(/^\/api\/file\/(.+)/, async (req, res) => {
    try {
      // O Express já decodifica os grupos capturados — um 2º decodeURIComponent
      // lançava URIError (500) com nomes que contêm "%".
      const key = String((req.params as any)[0] ?? "");
      if (!key || key.includes("..")) return res.status(400).json({ error: "Key inválida" });
      const { storageGet } = await import("../storage");
      const { url } = await storageGet(key);
      if (url && /^https?:\/\//.test(url)) return res.redirect(302, url);
      // Modo local (sem BLOB_READ_WRITE_TOKEN): serve do disco com o
      // content-type inferido da extensão, em vez de 404.
      const fs = await import("fs");
      const path = await import("path");
      const uploadsRoot = path.resolve(process.cwd(), "uploads");
      const localPath = path.resolve(uploadsRoot, key);
      if (localPath.startsWith(uploadsRoot) && fs.existsSync(localPath)) {
        return res.sendFile(localPath);
      }
      return res.status(404).json({ error: "Ficheiro não encontrado no storage" });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Falha a resolver ficheiro" });
    }
  });

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
    // ?date=YYYY-MM-DD permite recolher um dia específico (backfill de dias
    // falhados); por omissão, o dia anterior.
    const qDate = typeof req.query?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? new Date(`${req.query.date}T12:00:00Z`)
      : null;
    const yesterday = qDate ?? new Date(Date.now() - 24 * 60 * 60 * 1000); // dia anterior
    // Prazo < maxDuration (60s): sem isto a recolha morria com 504 a meio e a
    // corrida seguinte via registos parciais e desistia. done:false → o
    // workflow chama outra vez até done:true (a recolha é retomável).
    const result = await collectDailyDriverData(yesterday, { deadlineAt: Date.now() + 45_000 });
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
    // Prazo < maxDuration (60s): o scan IMAP dos 4 aliases × 30d passava dos
    // 60s e morria SEMPRE com 504. partial:true → o workflow repete a chamada
    // (dedup por messageId torna cada corrida incremental).
    const result = await runEmailInboundSync({ deadlineAt: Date.now() + 45_000 });
    res.json({ ok: result.configured, done: !result.partial, ranAt: new Date().toISOString(), ...result });
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
      MULTIPARK_WEBHOOK_SECRET: !!process.env.MULTIPARK_WEBHOOK_SECRET,
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
