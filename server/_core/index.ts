import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { logTrpcServerError } from "./trpcErrorLog";
import { registerOAuthRoutes } from "./oauth";
import { registerGoogleBusinessRoutes } from "../integrations/googleBusiness/routes";
import { registerGoogleAccountRoutes } from "../google/routes";
import { registerMailRoutes } from "../mail/routes";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { createExternalApiRouter } from "../externalApi";
import { createMcpApiRouter } from "../mcpApi";
import { createCentralSugarRouter } from "../centralSugar";
import { CENTRAL_SUGAR_BASE_PATH } from "../../shared/centralSugar";
import { createWhatsappWebhookRouter } from "../whatsappWebhook";
import { registerWhatsappCallStreamRoute } from "../whatsappCallStream";
import { createMultiparkWebhookRouter } from "../multiparkWebhook";
import { seedProjectHierarchy } from "../db";
import multer from "multer";
import { requireSession } from "./requireSession";
import { storagePut } from "../storage";
import { cronRunRecorder } from "../cronRuns";
import { registerInitialBookingPriceRoutes } from "../multiparkDb/initialBookingPriceRoutes";
import { registerActiveAgentsExportRoutes } from "../multiparkDb/activeAgentsExportRoutes";

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
  registerInitialBookingPriceRoutes(app);
  registerActiveAgentsExportRoutes(app);
  // Registo das corridas de /api/cron/* (Definições → Estado do sistema).
  app.use("/api/cron", cronRunRecorder());
  // Serve local uploads when S3 is not configured
  app.use("/uploads", requireSession, express.static("uploads"));
  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);
  registerGoogleBusinessRoutes(app);
  // Comunicação (conta Google por utilizador, cron do Gmail, push, anexos)
  registerGoogleAccountRoutes(app);
  registerMailRoutes(app);
  // External REST API (device integrations)
  app.use("/api/external", createExternalApiRouter());
  // MCP Control API (X-API-Key) — paridade com o api-entry.ts (Vercel)
  app.use("/api/v1", createMcpApiRouter());
  // 39a: central Vodafone como "Sugar CRM" (paridade com o api-entry.ts).
  app.use(CENTRAL_SUGAR_BASE_PATH, createCentralSugarRouter());
  // Toque das chamadas do WhatsApp por SSE (paridade com o api-entry.ts).
  registerWhatsappCallStreamRoute(app);

  // File upload endpoint (multer)
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });
  app.post("/api/upload", requireSession, upload.single("file"), async (req: any, res: any) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file" });
      const ext = req.file.originalname?.split(".").pop() || "bin";
      const key = `uploads/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
      const { url } = await storagePut(key, req.file.buffer, req.file.mimetype);
      // Recibo: prova que foi esta pessoa que carregou (anexos de email, 17d).
      const { uploadTicket } = await import("../uploadTicket");
      const uid = Number(req.sessionUser?.id);
      return res.json({ url, key, ...(uid ? { ticket: uploadTicket(uid, key) } : {}) });
    } catch (err: any) {
      console.error("[Upload] Error:", err);
      return res.status(500).json({ error: err.message || "Upload failed" });
    }
  });
  // Abre um ficheiro do storage pela KEY, com autorização por entidade
  // (paridade com o api-entry.ts do Vercel — server/fileRoute.ts).
  app.get(/^\/api\/file\/(.+)/, async (req: any, res: any) => {
    const { fileRoute } = await import("../fileRoute");
    return fileRoute(req, res);
  });
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
      // 500 com a causa no log (paridade com o api-entry.ts) — nunca o input.
      onError: logTrpcServerError,
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
    seedProjectHierarchy().catch(e => console.error("[Seed] Project hierarchy error:", e));
    // Sem timers in-process: o agendador é o /api/cron/tick da função do
    // Vercel (server/cronScheduler.ts), chamado pelo cron-job.org.
  });
}

startServer().catch(console.error);
