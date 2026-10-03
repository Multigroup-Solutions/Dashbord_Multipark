/**
 * External REST API endpoints for device integration (Zilo GPS, radios, etc.)
 * Authentication via X-API-Key header
 */
import { Router, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { vehicles } from "../drizzle/schema";
import { apiInternalError, apiKeyMiddleware, logApiKeyAction } from "./apiKeyAuth";
import {
  getVehicles,
  getAllEmployees,
  createSpeedAlert,
  createVehicleMovement,
  createRadioTranscription,
} from "./db";

let _db: ReturnType<typeof drizzle> | null = null;
async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    _db = drizzle(process.env.DATABASE_URL);
  }
  return _db;
}

// ─── API KEY MIDDLEWARE ──────────────────────────────────────────────────────
// Autenticação por hash + capacidades (leituras: relatórios/dados pessoais ou
// dispositivo; escritas: dispositivo; Gmail: reclamações ou dispositivo) —
// ver server/apiKeyAuth.ts (externalRequiredCaps).

/**
 * O servidor vai descarregar o áudio: só http(s) e nunca um endereço interno
 * (localhost, rede privada, metadados da cloud). PURA.
 */
export function radioAudioUrlError(raw: unknown): string | null {
  const v = String(raw ?? "").trim();
  if (!v) return "audioUrl is required";
  if (v.length > 2048) return "audioUrl too long";
  let u: URL;
  try { u = new URL(v); } catch { return "audioUrl must be a valid http(s) URL"; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "audioUrl must be a valid http(s) URL";
  if (u.username || u.password) return "audioUrl must not carry credentials";
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const privateHost =
    host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") ||
    /^(0|10|127)\./.test(host) || /^169\.254\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
    host === "::1" || host === "::" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host) || host.startsWith("::ffff:") ||
    (!host.includes(".") && !host.includes(":"));
  if (privateHost) return "audioUrl must be a public address";
  return null;
}

// ─── ROUTER ──────────────────────────────────────────────────────────────────

export function createExternalApiRouter(): Router {
  const r = Router();
  r.use(apiKeyMiddleware("external"));

  // ─── GET /api/external/vehicles ────────────────────────────────────────────
  r.get("/vehicles", async (_req: Request, res: Response) => {
    try {
      const list = await getVehicles();
      res.json({ success: true, data: list.map((v: any) => ({ id: v.id, plate: v.plate, brand: v.brand, model: v.model, status: v.status, projectId: v.projectId })) });
    } catch (e: any) {
      apiInternalError(res, "external GET /vehicles", e);
    }
  });

  // ─── GET /api/external/employees ───────────────────────────────────────────
  r.get("/employees", async (_req: Request, res: Response) => {
    try {
      const list = await getAllEmployees();
      res.json({ success: true, data: list.map((e: any) => ({ id: e.employee.id, fullName: e.employee.fullName, position: e.employee.position, status: e.employee.status })) });
    } catch (e: any) {
      apiInternalError(res, "external GET /employees", e);
    }
  });

  // ─── POST /api/external/speed-alert ────────────────────────────────────────
  // Body: { vehicleId OR plate, speed, speedLimit, latitude?, longitude?, roadName?, employeeId? }
  r.post("/speed-alert", async (req: Request, res: Response) => {
    try {
      const { vehicleId, plate, speed, speedLimit, latitude, longitude, roadName, employeeId } = req.body;

      if (!speed || !speedLimit) {
        res.status(400).json({ error: "speed and speedLimit are required" });
        return;
      }

      // Resolve vehicle by plate if vehicleId not provided
      let resolvedVehicleId = vehicleId;
      if (!resolvedVehicleId && plate) {
        const db = await getDb();
        if (db) {
          const veh = await db.select().from(vehicles).where(eq(vehicles.plate, plate)).limit(1);
          if (veh.length > 0) resolvedVehicleId = veh[0].id;
        }
      }
      if (!resolvedVehicleId) {
        res.status(400).json({ error: "vehicleId or valid plate is required" });
        return;
      }

      const id = await createSpeedAlert({
        vehicleId: resolvedVehicleId,
        employeeId: employeeId ?? null,
        speed: Number(speed),
        speedLimit: Number(speedLimit),
        latitude: latitude ? String(latitude) : null,
        longitude: longitude ? String(longitude) : null,
        roadName: roadName ?? null,
      });

      // Aviso `speed_alert` (chefias da cidade do condutor + quem vê todas).
      const plateLabel = plate || `Viatura #${resolvedVehicleId}`;
      const { notify } = await import("./notify");
      await notify({
        kind: "speed_alert", employeeId: employeeId ?? null,
        title: "Alerta de Velocidade (GPS)",
        body: `${plateLabel} a ${speed} km/h (limite: ${speedLimit} km/h)${roadName ? " em " + roadName : ""}. Excesso: +${speed - speedLimit} km/h.`,
        link: "/operacional", entity: { type: "speed_alert", id },
      });

      await logApiKeyAction(req, { action: "create", entity: "speed_alert", entityId: id, details: `${speed}km/h (limite ${speedLimit}km/h) - ${plateLabel}` });

      res.json({ success: true, id, message: "Speed alert registered and team notified" });
    } catch (e: any) {
      apiInternalError(res, "external POST /speed-alert", e);
    }
  });

  // ─── POST /api/external/vehicle-movement ───────────────────────────────────
  // Body: { vehicleId OR plate, employeeId, type: "pickup"|"return", kmReading?, latitude?, longitude?, notes? }
  r.post("/vehicle-movement", async (req: Request, res: Response) => {
    try {
      const { vehicleId, plate, employeeId, type, kmReading, latitude, longitude, notes } = req.body;

      if (!employeeId || !type) {
        res.status(400).json({ error: "employeeId and type (pickup/return) are required" });
        return;
      }

      let resolvedVehicleId = vehicleId;
      if (!resolvedVehicleId && plate) {
        const db = await getDb();
        if (db) {
          const veh = await db.select().from(vehicles).where(eq(vehicles.plate, plate)).limit(1);
          if (veh.length > 0) resolvedVehicleId = veh[0].id;
        }
      }
      if (!resolvedVehicleId) {
        res.status(400).json({ error: "vehicleId or valid plate is required" });
        return;
      }

      const id = await createVehicleMovement({
        vehicleId: resolvedVehicleId,
        employeeId: Number(employeeId),
        movementType: type,
        kmReading: kmReading ? Number(kmReading) : null,
        latitude: latitude ? String(latitude) : null,
        longitude: longitude ? String(longitude) : null,
        notes: notes ?? null,
      });

      await logApiKeyAction(req, { action: "create", entity: "vehicle_movement", entityId: id, details: `${type} viatura ${plate || "#" + resolvedVehicleId}` });

      res.json({ success: true, id, message: "Vehicle movement registered" });
    } catch (e: any) {
      apiInternalError(res, "external POST /vehicle-movement", e);
    }
  });

  // ─── POST /api/external/radio-upload ───────────────────────────────────────
  // Body: { audioUrl, employeeId?, vehicleId?, duration? }
  r.post("/radio-upload", async (req: Request, res: Response) => {
    try {
      const { audioUrl, employeeId, vehicleId, duration } = req.body;

      const urlError = radioAudioUrlError(audioUrl);
      if (urlError) {
        res.status(400).json({ error: urlError });
        return;
      }

      // Transcrição (IA) + resumo best-effort
      let result: { transcription: string; summary: string };
      try {
        const { transcribeAndSummarizeRadio } = await import("./radioAi");
        result = await transcribeAndSummarizeRadio(String(audioUrl));
      } catch (err) {
        const { aiUserMessage, isAiError } = await import("./_core/ai/errors");
        const code = isAiError(err) && ["disabled", "not_configured", "budget"].includes(err.code) ? 503 : 502;
        res.status(code).json({ error: aiUserMessage(err) });
        return;
      }
      const summaryText = result.summary;

      const id = await createRadioTranscription({
        audioUrl,
        transcription: result.transcription,
        summary: summaryText,
        employeeId: employeeId ? Number(employeeId) : null,
        vehicleId: vehicleId ? Number(vehicleId) : null,
        duration: duration ? Number(duration) : null,
        transcribedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
        createdById: null,
      });

      await logApiKeyAction(req, { action: "create", entity: "radio_transcription", entityId: id, details: "Transcrição automática" });

      res.json({ success: true, id, transcription: result.transcription, summary: summaryText });
    } catch (e: any) {
      apiInternalError(res, "external POST /radio-upload", e);
    }
  });

  // ─── GET /api/external/docs ────────────────────────────────────────────────
  r.get("/docs", (_req: Request, res: Response) => {
    res.json({
      title: "Dashboard Multipark External API",
      version: "1.0",
      auth: "Header X-API-Key required on all endpoints. Capabilities: device (all of the routes below), reports:ops (GET /vehicles), pii (GET /employees), complaints:write (POST /gmail-import — descontinuado, 410). Limit: 240 requests/minute per key (429 + Retry-After).",
      endpoints: [
        {
          method: "GET", path: "/api/external/vehicles",
          description: "Listar todas as viaturas",
          response: "{ success, data: [{ id, plate, brand, model, status, projectId }] }",
        },
        {
          method: "GET", path: "/api/external/employees",
          description: "Listar todos os colaboradores",
          response: "{ success, data: [{ id, fullName, position, status }] }",
        },
        {
          method: "POST", path: "/api/external/speed-alert",
          description: "Registar alerta de velocidade (ex: GPS Zilo)",
          body: "{ vehicleId? | plate?, speed, speedLimit, latitude?, longitude?, roadName?, employeeId? }",
          response: "{ success, id }",
          notes: "Pode enviar vehicleId ou plate. Avisa as chefias da cidade do condutor (aviso speed_alert).",
        },
        {
          method: "POST", path: "/api/external/vehicle-movement",
          description: "Registar movimento de viatura (recolha/devolução)",
          body: "{ vehicleId? | plate?, employeeId, type: 'pickup'|'return', kmReading?, latitude?, longitude?, notes? }",
          response: "{ success, id }",
        },
        {
          method: "POST", path: "/api/external/radio-upload",
          description: "Enviar áudio de rádio para transcrição automática",
          body: "{ audioUrl, employeeId?, vehicleId?, duration? }",
          response: "{ success, id, transcription, summary }",
          notes: "audioUrl tem de ser um endereço http(s) público. O áudio é transcrito e resumido com IA.",
        },
        {
          method: "POST", path: "/api/external/gmail-import",
          description: "DESCONTINUADO (410): as críticas chegam pela sincronização do Gmail e as ocorrências vêm da app Multipark.",
        },
      ],
    });
  });

  // ─── GMAIL IMPORT — DESCONTINUADO (23a, D18: Jorge, 3 out) ─────────────────
  // As críticas chegam pela sincronização do Gmail (server/jobs/emailInboundSync.ts)
  // e as ocorrências vêm da app Multipark. Nada se grava aqui: 410.
  r.post("/gmail-import", (_req: Request, res: Response) => {
    res.status(410).json({ success: false, error: "Descontinuado: as críticas chegam pela sincronização do Gmail e as ocorrências vêm da app Multipark. Nada foi gravado." });
  });

  return r;
}
