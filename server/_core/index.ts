import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import crypto from "node:crypto";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext, getUserFromRequest } from "./context";
import { serveStatic, setupVite } from "./vite";
import { createExternalApiRouter } from "../externalApi";
import { startDailyCollectionScheduler } from "../jobs/dailyDriverCollection";
import { startBookingSyncScheduler } from "../jobs/multiparkBookingSync";
import { seedProjectHierarchy } from "../db";
import multer from "multer";
import { storagePut } from "../storage";
import {
  corsMiddleware,
  createRateLimiter,
  ALLOWED_UPLOAD_MIMES,
  EXT_FROM_MIME,
  detectMimeFromMagicBytes,
} from "./security";
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

  // CORS estrito antes de tudo
  app.use(corsMiddleware);

  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // Serve local uploads when S3 is not configured
  app.use("/uploads", express.static("uploads"));

  // Rate limiters por escopo
  const authLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 20,
    name: "auth",
  });
  const uploadLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 30,
    name: "upload",
  });
  const apiLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 300,
    name: "api",
  });

  // Aplicar rate limit às rotas sensíveis ANTES dos handlers
  app.use("/api/oauth", authLimiter);
  app.use("/api/dev-login", authLimiter);

  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);
  // External REST API (device integrations) — protegido por rate limit geral
  app.use("/api/external", apiLimiter, createExternalApiRouter());

  // File upload endpoint (multer) — autenticado + MIME whitelist + UUID + magic bytes
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 16 * 1024 * 1024, files: 1 },
  });
  app.post(
    "/api/upload",
    uploadLimiter,
    upload.single("file"),
    async (req: any, res: any) => {
      try {
        // Exigir utilizador autenticado
        const user = await getUserFromRequest(req);
        if (!user) {
          return res.status(401).json({ error: "Autenticação necessária" });
        }

        const file = req.file;
        if (!file) return res.status(400).json({ error: "Nenhum ficheiro enviado" });

        // 1) MIME declarado tem de estar na whitelist
        const declaredMime = String(file.mimetype || "").toLowerCase();
        if (!ALLOWED_UPLOAD_MIMES.has(declaredMime)) {
          return res.status(415).json({
            error: "Tipo de ficheiro não permitido",
            allowed: Array.from(ALLOWED_UPLOAD_MIMES),
          });
        }

        // 2) Validar com magic bytes para apanhar spoofing de Content-Type
        const detected = detectMimeFromMagicBytes(file.buffer);
        if (detected && detected !== declaredMime) {
          // Em casos HEIC/HEIF, o detetor devolve image/heic para ambas as
          // variantes — aceitamos se bater com a família.
          const isHeicFamily =
            (detected === "image/heic" && declaredMime === "image/heif") ||
            (detected === "image/heif" && declaredMime === "image/heic");
          if (!isHeicFamily) {
            return res.status(415).json({
              error: "Conteúdo do ficheiro não corresponde ao tipo declarado",
            });
          }
        }

        // 3) Nome do ficheiro: ignorar completamente o nome do utilizador
        const ext = EXT_FROM_MIME[declaredMime] ?? "bin";
        const key = `uploads/${crypto.randomUUID()}.${ext}`;

        const { url } = await storagePut(key, file.buffer, declaredMime);
        return res.json({ url, key });
      } catch (err: any) {
        console.error("[Upload] Error:", err?.message || err);
        return res.status(500).json({ error: "Falha no upload" });
      }
    }
  );
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
    // Gmail sync handled externally via Make scheduled tasks
  });
}

startServer().catch(console.error);
