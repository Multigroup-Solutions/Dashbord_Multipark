/**
 * External REST API endpoints for device integration (Zilo GPS, radios, etc.)
 * Authentication via X-API-Key header
 */
import { Router, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { vehicles } from "../drizzle/schema";
import { apiKeyMiddleware, logApiKeyAction } from "./apiKeyAuth";
import {
  getVehicles,
  getAllEmployees,
  createSpeedAlert,
  createVehicleMovement,
  createRadioTranscription,
  createGoogleReview,
  createIncident,
  getReviewBySourceEmailId,
  getIncidentBySourceEmailId,
  updateGoogleReview,
} from "./db";

let _db: ReturnType<typeof drizzle> | null = null;
async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    _db = drizzle(process.env.DATABASE_URL);
  }
  return _db;
}

// ─── API KEY MIDDLEWARE ──────────────────────────────────────────────────────
// Autenticação por hash + scopes (GET=read, escrita=write; chaves "device"
// cobrem ambos) — ver server/apiKeyAuth.ts.

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
      res.status(500).json({ error: e.message });
    }
  });

  // ─── GET /api/external/employees ───────────────────────────────────────────
  r.get("/employees", async (_req: Request, res: Response) => {
    try {
      const list = await getAllEmployees();
      res.json({ success: true, data: list.map((e: any) => ({ id: e.employee.id, fullName: e.employee.fullName, position: e.employee.position, status: e.employee.status })) });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
    }
  });

  // ─── POST /api/external/radio-upload ───────────────────────────────────────
  // Body: { audioUrl, employeeId?, vehicleId?, duration? }
  r.post("/radio-upload", async (req: Request, res: Response) => {
    try {
      const { audioUrl, employeeId, vehicleId, duration } = req.body;

      if (!audioUrl) {
        res.status(400).json({ error: "audioUrl is required" });
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
      res.status(500).json({ error: e.message });
    }
  });

  // ─── GET /api/external/docs ────────────────────────────────────────────────
  r.get("/docs", (_req: Request, res: Response) => {
    res.json({
      title: "Dashboard Multipark External API",
      version: "1.0",
      auth: "Header X-API-Key required on all endpoints. Scopes: GET = read; POST = write (device keys: both).",
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
          notes: "Pode enviar vehicleId ou plate. Notifica automaticamente o Super Admin.",
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
          notes: "O áudio é transcrito via Whisper e resumido com IA.",
        },
      ],
    });
  });

  // ─── GMAIL IMPORT (receives pre-parsed data from external scheduled task) ─
  r.post("/gmail-import", async (req: Request, res: Response) => {
    try {
      const importStarted = Date.now();
      const { occurrences, reviews } = req.body;
      const result = { reviewsImported: 0, reviewsSkipped: 0, incidentsImported: 0, incidentsSkipped: 0, details: [] as string[], errors: [] as string[] };

      // Import occurrences
      if (Array.isArray(occurrences)) {
        for (const occ of occurrences) {
          try {
            if (occ.sourceEmailId) {
              const existing = await getIncidentBySourceEmailId(occ.sourceEmailId);
              if (existing) { result.incidentsSkipped++; continue; }
            }
            const now = new Date();
            const weekNum = Math.ceil((now.getDate() + new Date(now.getFullYear(), now.getMonth(), 1).getDay()) / 7);
            await createIncident({
              incidentType: occ.incidentType || "outro",
              severity: occ.severity || "medium",
              description: occ.description || "",
              vehiclePlate: occ.vehiclePlate || undefined,
              status: "open",
              weekNumber: weekNum,
              yearNumber: now.getFullYear(),
              sourceEmailId: occ.sourceEmailId || undefined,
              aiClassification: occ.aiClassification || undefined,
              gpsLatitude: occ.gpsLatitude || undefined,
              gpsLongitude: occ.gpsLongitude || undefined,
              reservationLink: occ.reservationLink || undefined,
              importedAt: now.toISOString().slice(0, 19).replace("T", " "),
            });
            result.incidentsImported++;
            result.details.push(`Ocorr\u00eancia: ${occ.description?.substring(0, 60) || "sem descri\u00e7\u00e3o"}`);
          } catch (e: any) {
            result.errors.push(`Erro ocorr\u00eancia: ${e.message}`);
          }
        }
      }

      // Import reviews
      if (Array.isArray(reviews)) {
        for (const rev of reviews) {
          try {
            if (rev.sourceEmailId) {
              const existing = await getReviewBySourceEmailId(rev.sourceEmailId);
              if (existing) { result.reviewsSkipped++; continue; }
            }
            const id = await createGoogleReview({
              reviewerName: rev.reviewerName || "An\u00f3nimo",
              rating: rev.rating || 5,
              reviewText: rev.reviewText || "",
              reviewDate: new Date().toISOString().slice(0, 19).replace("T", " "),
              status: "pending_response",
              sourceEmailId: rev.sourceEmailId || undefined,
              importedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
            });
            // Generate AI response if we have LLM access
            if (id && rev.aiResponse) {
              await updateGoogleReview(id, { aiResponse: rev.aiResponse, status: "ai_responded" });
            } else if (id && Date.now() - importStarted < 30_000) {
              // Rascunho IA best-effort, dentro de um orçamento de tempo (60 s do Vercel).
              try {
                const { draftReviewReply } = await import("./_core/ai/reviewReply");
                const aiText = await draftReviewReply({ rating: rev.rating || 5, reviewerName: rev.reviewerName, reviewText: rev.reviewText || "" }, { reviewId: id, timeoutMs: 12_000 });
                if (aiText) await updateGoogleReview(id, { aiResponse: aiText, status: "ai_responded" });
              } catch { /* IA opcional */ }
            }
            result.reviewsImported++;
            result.details.push(`Cr\u00edtica: ${rev.rating}\u2605 de ${rev.reviewerName}`);
          } catch (e: any) {
            result.errors.push(`Erro review: ${e.message}`);
          }
        }
      }

      await logApiKeyAction(req, { action: "import", entity: "gmail_import", asKeyEvent: true,
        details: `Gmail import: ${result.incidentsImported} ocorrências, ${result.reviewsImported} críticas (${result.errors.length} erros)` });
      res.json({ success: true, ...result });
    } catch (err: any) {
      console.error("[GmailImport] Error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return r;
}
