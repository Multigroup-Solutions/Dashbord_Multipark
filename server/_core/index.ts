import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { createExternalApiRouter } from "../externalApi";
import { createMcpApiRouter } from "../mcpApi";
import { createWhatsappWebhookRouter } from "../whatsappWebhook";
import { createMultiparkWebhookRouter } from "../multiparkWebhook";
import { startDailyCollectionScheduler } from "../jobs/dailyDriverCollection";
import { startBookingSyncScheduler } from "../jobs/multiparkBookingSync";
import { startEmailInboundScheduler } from "../jobs/emailInboundSync";
import { seedProjectHierarchy } from "../db";
import multer from "multer";
import { storagePut } from "../storage";
// Gmail sync handled externally via Make scheduled tasks

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  // Trust proxy headers (Railway, Render, etc.)
  app.set("trust proxy", 1);
  const server = createServer(app);
  // WhatsApp webhook (Meta) — MONTADO ANTES do express.json global: a validação
  // da assinatura HMAC precisa do raw body intacto (usa o seu próprio
  // express.raw internamente).
  app.use("/api/whatsapp/webhook", createWhatsappWebhookRouter());
  // Webhook das Conexões Multipark (reservas em tempo real) — idem raw body.
  app.use("/api/multipark/webhook", createMultiparkWebhookRouter());
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // Serve local uploads when S3 is not configured
  app.use("/uploads", express.static("uploads"));
  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);
  // External REST API (device integrations)
  app.use("/api/external", createExternalApiRouter());
  // MCP Control API (X-API-Key) — paridade com o api-entry.ts (Vercel)
  app.use("/api/v1", createMcpApiRouter());

  // File upload endpoint (multer)
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });
  app.post("/api/upload", upload.single("file"), async (req: any, res: any) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file" });
      const ext = req.file.originalname?.split(".").pop() || "bin";
      const key = `uploads/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
      const { url } = await storagePut(key, req.file.buffer, req.file.mimetype);
      return res.json({ url, key });
    } catch (err: any) {
      console.error("[Upload] Error:", err);
      return res.status(500).json({ error: err.message || "Upload failed" });
    }
  });
  // Resolve ficheiro do storage pela KEY (paridade com o api-entry.ts do
  // Vercel): Blob → redirect para a URL pública; local → redirect p/ /uploads.
  app.get(/^\/api\/file\/(.+)/, async (req: any, res: any) => {
    try {
      // O Express já decodifica os grupos capturados — sem 2º decode.
      const key = String(req.params[0] ?? "");
      if (!key || key.includes("..")) return res.status(400).json({ error: "Key inválida" });
      const { storageGet } = await import("../storage");
      const { url } = await storageGet(key);
      if (url) return res.redirect(302, url);
      return res.status(404).json({ error: "Ficheiro não encontrado no storage" });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || "Falha a resolver ficheiro" });
    }
  });
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
    // Seed data & start background jobs
    seedProjectHierarchy().catch(e => console.error("[Seed] Project hierarchy error:", e));
    startDailyCollectionScheduler();
    startBookingSyncScheduler();
    // Emails (criticas@/reclamacoes@/perdidos@/recursos-humanos@) — o cron do
    // GitHub Actions foi removido a 14/jul; passa a correr aqui, in-process.
    startEmailInboundScheduler();
  });
}

startServer().catch(console.error);
