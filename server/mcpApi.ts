/**
 * MCP Control API — superfície REST completa para controlar a Dashboard Multipark
 * a partir de um servidor MCP (ou qualquer cliente HTTP).
 *
 * Montado em /api/v1. Autenticação por header X-API-Key (tabela api_keys).
 * Cada chave tem um campo `permissions` que define o scope:
 *   - "read"           → só leituras
 *   - "read,write"     → leituras + escrita operacional (criar/editar, syncs)
 *   - "admin" ou "*"   → tudo, incluindo operações destrutivas
 * (admin implica write implica read). Chaves sem permissions não acedem aqui.
 *
 * Cobre todos os parques e cidades (PARK_CONFIGS).
 */
import { Router, Request, Response, NextFunction } from "express";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { apiKeys, multiparkBookings } from "../drizzle/schema";
import {
  getMultiparkBookings,
  getMultiparkBookingByExternalId,
  getMultiparkBookingStats,
  getComplaints,
  getComplaintById,
  getComplaintMessages,
  getComplaintPhotos,
  createComplaint,
  updateComplaint,
  deleteComplaint,
  addComplaintMessage,
  getComplaintStats,
  getGoogleReviews,
  createGoogleReview,
  getVehicles,
  getAllEmployees,
  logActivity,
} from "./db";

let _db: ReturnType<typeof drizzle> | null = null;
async function db() {
  if (!_db && process.env.DATABASE_URL) _db = drizzle(process.env.DATABASE_URL);
  return _db;
}

// ─── AUTH + SCOPES ────────────────────────────────────────────────────────────

type Scope = "read" | "write" | "admin";

function scopesFor(permissions: string | null | undefined): Set<Scope> {
  const s = new Set<Scope>();
  if (!permissions) return s;
  let parts: string[] = [];
  try {
    const parsed = JSON.parse(permissions);
    parts = Array.isArray(parsed) ? parsed.map(String) : String(parsed).split(/[,\s]+/);
  } catch {
    parts = permissions.split(/[,\s]+/);
  }
  const set = new Set(parts.map(p => p.trim().toLowerCase()).filter(Boolean));
  if (set.has("*") || set.has("admin") || set.has("full")) { s.add("read"); s.add("write"); s.add("admin"); return s; }
  if (set.has("write")) { s.add("read"); s.add("write"); }
  if (set.has("read")) s.add("read");
  return s;
}

async function validateApiKey(req: Request, res: Response, next: NextFunction) {
  const key = req.headers["x-api-key"] as string;
  if (!key) return res.status(401).json({ error: "Missing X-API-Key header" });
  const d = await db();
  if (!d) return res.status(500).json({ error: "Database unavailable" });
  const rows = await d.select().from(apiKeys).where(and(eq(apiKeys.apiKey, key), eq(apiKeys.active, 1))).limit(1);
  if (rows.length === 0) return res.status(403).json({ error: "Invalid or inactive API key" });
  await d.update(apiKeys).set({ lastUsedAt: new Date().toISOString().slice(0, 19).replace("T", " ") }).where(eq(apiKeys.id, rows[0].id));
  (req as any).apiKeyInfo = rows[0];
  (req as any).scopes = scopesFor(rows[0].permissions);
  next();
}

function requireScope(scope: Scope) {
  return (req: Request, res: Response, next: NextFunction) => {
    const scopes: Set<Scope> = (req as any).scopes ?? new Set();
    if (!scopes.has(scope)) {
      return res.status(403).json({
        error: `Esta API key não tem o scope '${scope}'. Scopes da chave: [${Array.from(scopes).join(", ") || "nenhum"}].`,
      });
    }
    next();
  };
}

// helper para apanhar erros sem repetir try/catch
const h = (fn: (req: Request, res: Response) => Promise<any>) =>
  (req: Request, res: Response) => fn(req, res).catch((e: any) => res.status(500).json({ error: e?.message || String(e) }));

function parseDate(v: any): Date | undefined {
  if (!v) return undefined;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? undefined : d;
}

// ─── ROUTER ─────────────────────────────────────────────────────────────────

export function createMcpApiRouter(): Router {
  const r = Router();
  r.use(validateApiKey);

  // Índice / capacidades
  r.get("/", (req: Request, res: Response) => {
    res.json({
      service: "Multipark Dashboard MCP Control API",
      version: "1",
      yourScopes: Array.from((req as any).scopes ?? []),
      endpoints: {
        read: [
          "GET /parks", "GET /bookings", "GET /bookings/stats", "GET /bookings/:externalId",
          "GET /complaints", "GET /complaints/stats", "GET /complaints/:id",
          "GET /reviews", "GET /vehicles", "GET /employees", "GET /dashboard/summary",
          "GET /campaigns", "GET /campaigns/:type/:id/daily", "GET /projects",
          "GET /availability-form/context?token=",
        ],
        write: [
          "POST /complaints", "PATCH /complaints/:id", "POST /complaints/:id/messages",
          "POST /reviews", "POST /sync/recent", "POST /sync/future", "POST /sync/day",
          "POST /campaigns/daily",
          "POST /availability-form/submit",
        ],
        admin: ["DELETE /complaints/:id", "POST /admin/cleanup-duplicates", "POST /projects"],
      },
    });
  });

  // ── FORMULÁRIO EXTERNO DE DISPONIBILIDADES (Fase 4) ─────────────────────────
  // Consumido por uma app externa de formulário. Além do X-API-Key (auth da
  // app), cada pedido traz um token JWT single-use por extra (auth do utilizador).
  //
  // GET /context NÃO consome o token (o extra pode abrir, fechar e voltar).
  r.get("/availability-form/context", requireScope("read"), h(async (req, res) => {
    const token = String(req.query.token ?? "");
    if (!token) return res.status(400).json({ success: false, error: "Missing token", code: "token_missing" });
    const { getFormContext } = await import("./availabilityForm");
    const result = await getFormContext(token);
    if (!result.ok) return res.status(result.status).json({ success: false, error: result.message, code: result.code });
    return res.json({ success: true, ...result.data });
  }));

  // POST /submit CONSOME o token (single-use) e escreve a disponibilidade.
  r.post("/availability-form/submit", requireScope("write"), h(async (req, res) => {
    const token = String(req.body?.token ?? "");
    if (!token) return res.status(400).json({ success: false, error: "Missing token", code: "token_missing" });
    const { submitDaysSchema, submitForm } = await import("./availabilityForm");
    const parsed = submitDaysSchema.safeParse(req.body?.days);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: "Invalid days", code: "invalid_input", details: parsed.error.flatten() });
    }
    const result = await submitForm(token, parsed.data);
    if (!result.ok) return res.status(result.status).json({ success: false, error: result.message, code: result.code });
    return res.json({ success: true, saved: result.data.saved });
  }));

  // ── PARQUES / CIDADES ───────────────────────────────────────────────────────
  r.get("/parks", requireScope("read"), h(async (_req, res) => {
    const { PARK_CONFIGS } = await import("./multipark");
    const cities = Array.from(new Set(PARK_CONFIGS.map((p: any) => p.city)));
    res.json({
      success: true,
      cities,
      parks: PARK_CONFIGS.map((p: any) => ({ id: p.id, name: p.name, city: p.city, closed: !!p.closed })),
    });
  }));

  // ── PROJETOS (centros de custos: grupo → cidade → marca → projeto) ──────────
  r.get("/projects", requireScope("read"), h(async (_req, res) => {
    const d = await db();
    if (!d) return res.status(500).json({ error: "DB unavailable" });
    const rows = (r2: any) => (Array.isArray(r2[0]) ? r2[0] : r2) as any[];
    const projects = rows(await d.execute(sql`SELECT id, name, parentId, level, isActive FROM projects ORDER BY parentId, name`));
    res.json({ success: true, count: projects.length, projects });
  }));

  // Cria um nó da árvore de projetos. Idempotente por (name, parentId):
  // se já existir devolve o existente em vez de duplicar.
  r.post("/projects", requireScope("admin"), h(async (req, res) => {
    const b = req.body ?? {};
    const name = String(b.name ?? "").trim();
    const level = String(b.level ?? "project");
    const parentId = b.parentId != null ? Number(b.parentId) : null;
    if (!name) return res.status(400).json({ error: "name é obrigatório" });
    if (!["group", "brand", "city", "project"].includes(level)) return res.status(400).json({ error: "level deve ser group|brand|city|project" });
    const d = await db();
    if (!d) return res.status(500).json({ error: "DB unavailable" });
    const rows = (r2: any) => (Array.isArray(r2[0]) ? r2[0] : r2) as any[];
    const existing = rows(await d.execute(sql`SELECT id, name, parentId, level FROM projects WHERE name = ${name} AND ${parentId === null ? sql`parentId IS NULL` : sql`parentId = ${parentId}`} LIMIT 1`))[0];
    if (existing) return res.json({ success: true, created: false, project: existing });
    await d.execute(sql`INSERT INTO projects (name, parentId, level, color, isActive) VALUES (${name}, ${parentId}, ${level}, ${b.color ?? "#0055d2"}, 1)`);
    const created = rows(await d.execute(sql`SELECT id, name, parentId, level FROM projects WHERE name = ${name} AND ${parentId === null ? sql`parentId IS NULL` : sql`parentId = ${parentId}`} ORDER BY id DESC LIMIT 1`))[0];
    await logActivity({ userId: 0, action: "create", entity: "project", entityId: created?.id ?? 0, details: `[MCP] ${level}: ${name}` });
    res.json({ success: true, created: true, project: created });
  }));

  // ── CAMPANHAS (marketing) ─────────────────────────────────────────────────────
  // Lista campanhas lógicas: internal_campaigns + campaigns (ad).
  r.get("/campaigns", requireScope("read"), h(async (_req, res) => {
    const d = await db();
    if (!d) return res.status(500).json({ error: "DB unavailable" });
    const rows = (r2: any) => (Array.isArray(r2[0]) ? r2[0] : r2) as any[];
    const internal = rows(await d.execute(sql`SELECT id, name, projectId, dailyBudget, city, brand, campaignStatus FROM internal_campaigns ORDER BY name`))
      .map((c: any) => ({ ...c, campaignType: "internal" }));
    const ad = rows(await d.execute(sql`SELECT id, name, projectId, budget AS dailyBudget, platform AS brand, campaignStatus FROM campaigns ORDER BY name`))
      .map((c: any) => ({ ...c, city: null, campaignType: "ad" }));
    res.json({ success: true, count: internal.length + ad.length, campaigns: [...internal, ...ad] });
  }));

  // Histórico diário (gasto + métricas) de uma campanha.
  r.get("/campaigns/:type/:id/daily", requireScope("read"), h(async (req, res) => {
    const type = String(req.params.type);
    if (type !== "internal" && type !== "ad") return res.status(400).json({ error: "type deve ser 'internal' ou 'ad'" });
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "id inválido" });
    const d = await db();
    if (!d) return res.status(500).json({ error: "DB unavailable" });
    const rows = (r2: any) => (Array.isArray(r2[0]) ? r2[0] : r2) as any[];
    const daily = rows(await d.execute(sql`SELECT costDate, amount, impressions, clicks, ctr, conversions, conversionValue, notes FROM internal_campaign_costs WHERE campaignType = ${type} AND campaignId = ${id} ORDER BY costDate DESC LIMIT 120`));
    res.json({ success: true, count: daily.length, daily });
  }));

  // Upsert das métricas diárias de uma campanha (mesma semântica do botão
  // "Atualizar campanhas": campos omitidos preservam o que já está registado).
  // Identifica por campaignType+campaignId, ou por name (procura internal e ad).
  r.post("/campaigns/daily", requireScope("write"), h(async (req, res) => {
    const b = req.body ?? {};
    const date = String(b.costDate ?? b.date ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "costDate (YYYY-MM-DD) é obrigatório" });
    const d = await db();
    if (!d) return res.status(500).json({ error: "DB unavailable" });
    const rows = (r2: any) => (Array.isArray(r2[0]) ? r2[0] : r2) as any[];

    let campaignType: string | null = b.campaignType ?? null;
    let campaignId: number | null = b.campaignId != null ? Number(b.campaignId) : null;
    if ((!campaignType || campaignId == null) && b.name) {
      const name = String(b.name);
      const hitInternal = rows(await d.execute(sql`SELECT id FROM internal_campaigns WHERE name = ${name} LIMIT 1`))[0];
      if (hitInternal) { campaignType = "internal"; campaignId = Number(hitInternal.id); }
      else {
        const hitAd = rows(await d.execute(sql`SELECT id FROM campaigns WHERE name = ${name} LIMIT 1`))[0];
        if (hitAd) { campaignType = "ad"; campaignId = Number(hitAd.id); }
      }
      if (campaignId == null) return res.status(404).json({ error: `Campanha "${name}" não encontrada (usa GET /campaigns para listar)` });
    }
    if (campaignType !== "internal" && campaignType !== "ad") return res.status(400).json({ error: "campaignType deve ser 'internal' ou 'ad' (ou indica name)" });
    if (campaignId == null || !Number.isFinite(campaignId)) return res.status(400).json({ error: "campaignId é obrigatório (ou indica name)" });

    const num = (v: any) => (v === undefined || v === null || v === "" ? null : Number(v));
    const amount = num(b.amount ?? b.spend) ?? 0;
    const impressions = num(b.impressions);
    const clicks = num(b.clicks);
    const ctr = num(b.ctr) ?? (clicks != null && impressions ? Math.round((clicks / impressions) * 100000) / 1000 : null);
    const conversions = num(b.conversions);
    const conversionValue = num(b.conversionValue);
    const notes = b.notes != null ? String(b.notes) : null;

    await d.execute(sql`
      INSERT INTO internal_campaign_costs (campaignType, campaignId, costDate, amount, impressions, clicks, ctr, conversions, conversionValue, notes, createdById)
      VALUES (${campaignType}, ${campaignId}, ${date}, ${amount}, ${impressions}, ${clicks}, ${ctr}, ${conversions}, ${conversionValue}, ${notes}, ${(req as any).apiKeyInfo?.createdById ?? null})
      ON DUPLICATE KEY UPDATE
        amount = ${amount},
        impressions = COALESCE(${impressions}, impressions),
        clicks = COALESCE(${clicks}, clicks),
        ctr = COALESCE(${ctr}, ctr),
        conversions = COALESCE(${conversions}, conversions),
        conversionValue = COALESCE(${conversionValue}, conversionValue),
        notes = COALESCE(${notes}, notes)`);
    await logActivity({ userId: 0, action: "update", entity: "campaign_daily", entityId: campaignId, details: `[MCP] ${campaignType}:${campaignId} ${date} €${amount}` });
    res.json({ success: true, campaignType, campaignId, costDate: date });
  }));

  // ── RESERVAS (todos os parques/cidades) ──────────────────────────────────────
  r.get("/bookings", requireScope("read"), h(async (req, res) => {
    const q = req.query;
    const list = await getMultiparkBookings({
      status: q.status ? String(q.status) : undefined,
      parkingType: q.parkingType ? String(q.parkingType) : undefined,
      city: q.city ? String(q.city) : undefined,
      parkId: q.parkId ? String(q.parkId) : undefined,
      from: parseDate(q.from),
      to: parseDate(q.to),
      search: q.search ? String(q.search) : undefined,
      limit: q.limit ? Math.min(Number(q.limit), 500) : 100,
      offset: q.offset ? Number(q.offset) : 0,
    });
    res.json({ success: true, count: list.length, data: list });
  }));

  r.get("/bookings/stats", requireScope("read"), h(async (req, res) => {
    const q = req.query;
    const stats = await getMultiparkBookingStats({
      from: q.from ? String(q.from) : undefined,
      to: q.to ? String(q.to) : undefined,
      projectId: q.projectId ? Number(q.projectId) : undefined,
    });
    res.json({ success: true, data: stats });
  }));

  r.get("/bookings/:externalId", requireScope("read"), h(async (req, res) => {
    const ext = req.params.externalId;
    const local = await getMultiparkBookingByExternalId(ext);
    let live: any = null;
    let park: any = null;
    try {
      const { getBookingTryAllParks } = await import("./multipark");
      const found = await getBookingTryAllParks(ext);
      if (found) { live = found.booking; park = { id: found.parkConfig.id, name: found.parkConfig.name, city: found.parkConfig.city }; }
    } catch { /* API pode falhar; devolvemos o local na mesma */ }
    if (!local && !live) return res.status(404).json({ error: "Reserva não encontrada (local nem API)" });
    res.json({ success: true, local: local ?? null, live, park });
  }));

  // ── RECLAMAÇÕES ───────────────────────────────────────────────────────────────
  r.get("/complaints", requireScope("read"), h(async (req, res) => {
    const q = req.query;
    const list = await getComplaints({
      status: q.status ? String(q.status) : undefined,
      type: q.type ? String(q.type) : undefined,
      projectId: q.projectId ? Number(q.projectId) : undefined,
      assignedToId: q.assignedToId ? Number(q.assignedToId) : undefined,
    });
    res.json({ success: true, count: list.length, data: list });
  }));

  r.get("/complaints/stats", requireScope("read"), h(async (req, res) => {
    const projectId = req.query.projectId ? Number(req.query.projectId) : undefined;
    res.json({ success: true, data: await getComplaintStats(projectId) });
  }));

  r.get("/complaints/:id", requireScope("read"), h(async (req, res) => {
    const id = Number(req.params.id);
    const complaint = await getComplaintById(id);
    if (!complaint) return res.status(404).json({ error: "Reclamação não encontrada" });
    res.json({
      success: true,
      data: { complaint, messages: await getComplaintMessages(id), photos: await getComplaintPhotos(id) },
    });
  }));

  r.post("/complaints", requireScope("write"), h(async (req, res) => {
    const b = req.body ?? {};
    if (!b.title) return res.status(400).json({ error: "title é obrigatório" });
    if (!b.type) return res.status(400).json({ error: "type é obrigatório (damage|dirt|delay|overcharge|staff|other)" });
    const slaHours = b.slaHours ? Number(b.slaHours) : null;
    const slaDeadline = slaHours ? new Date(Date.now() + slaHours * 3600000).toISOString().slice(0, 19).replace("T", " ") : null;
    const id = await createComplaint({
      title: String(b.title),
      description: b.description ?? null,
      complaintType: b.type,
      complaintPriority: b.priority ?? "medium",
      complaintStatus: "new",
      clientName: b.clientName ?? null,
      clientEmail: b.clientEmail ?? null,
      clientPhone: b.clientPhone ?? null,
      reservationRef: b.reservationRef ?? null,
      vehiclePlate: b.vehiclePlate ?? null,
      slaDeadline,
      projectId: b.projectId ? Number(b.projectId) : null,
      assignedToId: b.assignedToId ? Number(b.assignedToId) : null,
      createdById: (req as any).apiKeyInfo?.createdById ?? null,
    } as any);
    await logActivity({ userId: 0, action: "create", entity: "complaint", entityId: id, details: `[MCP] ${b.title}` });
    res.json({ success: true, id });
  }));

  r.patch("/complaints/:id", requireScope("write"), h(async (req, res) => {
    const id = Number(req.params.id);
    const b = req.body ?? {};
    const data: any = {};
    if (b.title !== undefined) data.title = b.title;
    if (b.description !== undefined) data.description = b.description;
    if (b.type !== undefined) data.complaintType = b.type;
    if (b.status !== undefined) data.complaintStatus = b.status;
    if (b.priority !== undefined) data.complaintPriority = b.priority;
    if (b.assignedToId !== undefined) data.assignedToId = b.assignedToId === null ? null : Number(b.assignedToId);
    if (b.penaltyPoints !== undefined) data.penaltyPoints = Number(b.penaltyPoints);
    if (b.slaHours !== undefined) data.slaDeadline = Number(b.slaHours) > 0 ? new Date(Date.now() + Number(b.slaHours) * 3600000) : null;
    if (b.status === "resolved") data.resolvedAt = new Date();
    if (Object.keys(data).length === 0) return res.status(400).json({ error: "Nada para atualizar" });
    await updateComplaint(id, data);
    await logActivity({ userId: 0, action: "update", entity: "complaint", entityId: id, details: `[MCP] update` });
    res.json({ success: true });
  }));

  r.post("/complaints/:id/messages", requireScope("write"), h(async (req, res) => {
    const complaintId = Number(req.params.id);
    const b = req.body ?? {};
    if (!b.message) return res.status(400).json({ error: "message é obrigatório" });
    const msgId = await addComplaintMessage({
      complaintId,
      message: String(b.message),
      isInternal: b.isInternal ? 1 : 0,
      authorId: (req as any).apiKeyInfo?.createdById ?? null,
      authorName: b.authorName ?? "MCP",
    } as any);
    res.json({ success: true, id: msgId });
  }));

  r.delete("/complaints/:id", requireScope("admin"), h(async (req, res) => {
    const id = Number(req.params.id);
    await deleteComplaint(id);
    await logActivity({ userId: 0, action: "delete", entity: "complaint", entityId: id, details: `[MCP] delete` });
    res.json({ success: true });
  }));

  // ── GOOGLE REVIEWS ────────────────────────────────────────────────────────────
  r.get("/reviews", requireScope("read"), h(async (req, res) => {
    const q = req.query;
    const list = await getGoogleReviews({
      rating: q.rating ? Number(q.rating) : undefined,
      status: q.status ? String(q.status) : undefined,
      projectId: q.projectId ? Number(q.projectId) : undefined,
    });
    res.json({ success: true, count: list.length, data: list });
  }));

  r.post("/reviews", requireScope("write"), h(async (req, res) => {
    const b = req.body ?? {};
    if (!b.reviewerName || !b.rating) return res.status(400).json({ error: "reviewerName e rating são obrigatórios" });
    const reviewDate = (b.reviewDate ? new Date(b.reviewDate) : new Date()).toISOString().slice(0, 19).replace("T", " ");
    const id = await createGoogleReview({
      reviewerName: String(b.reviewerName),
      reviewerEmail: b.reviewerEmail ?? null,
      rating: Number(b.rating),
      reviewText: b.reviewText ?? null,
      reviewDate,
      projectId: b.projectId ? Number(b.projectId) : null,
      vehiclePlate: b.vehiclePlate ?? null,
      createdById: (req as any).apiKeyInfo?.createdById ?? null,
    } as any);
    res.json({ success: true, id });
  }));

  // ── VIATURAS / COLABORADORES ──────────────────────────────────────────────────
  r.get("/vehicles", requireScope("read"), h(async (_req, res) => {
    const list = await getVehicles();
    res.json({ success: true, count: list.length, data: list.map((v: any) => ({ id: v.id, plate: v.plate, brand: v.brand, model: v.model, status: v.status, projectId: v.projectId })) });
  }));

  r.get("/employees", requireScope("read"), h(async (_req, res) => {
    const list = await getAllEmployees();
    res.json({ success: true, count: list.length, data: list.map((e: any) => ({ id: e.employee.id, fullName: e.employee.fullName, position: e.employee.position, projectId: e.employee.projectId })) });
  }));

  // ── SYNC (controlar a sincronização) ────────────────────────────────────────
  r.post("/sync/recent", requireScope("write"), h(async (req, res) => {
    const { runRecentCronSync } = await import("./jobs/multiparkBookingSync");
    const windowMinutes = req.body?.windowMinutes ? Number(req.body.windowMinutes) : 30;
    res.json({ success: true, ...(await runRecentCronSync(windowMinutes)) });
  }));

  r.post("/sync/future", requireScope("write"), h(async (req, res) => {
    const { runFutureCronSync } = await import("./jobs/multiparkBookingSync");
    const weeks = req.body?.weeksAhead ? Number(req.body.weeksAhead) : 4;
    res.json({ success: true, ...(await runFutureCronSync(weeks)) });
  }));

  // Sincroniza um dia específico (report + enrich + history) — para backfill
  r.post("/sync/day", requireScope("write"), h(async (req, res) => {
    const date = String(req.body?.date ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date (YYYY-MM-DD) é obrigatório" });
    const { syncBookings, enrichBookingsBatch, syncBookingHistoryBatch } = await import("./jobs/multiparkBookingSync");
    const report = await syncBookings({ startDate: date, endDate: date });
    const [enrichRes, historyRes] = await Promise.allSettled([enrichBookingsBatch(100), syncBookingHistoryBatch(50)]);
    res.json({
      success: true,
      date,
      report,
      enriched: enrichRes.status === "fulfilled" ? (enrichRes.value as any).enriched : 0,
      historyFetched: historyRes.status === "fulfilled" ? (historyRes.value as any).fetched : 0,
    });
  }));

  // ── ADMIN (destrutivo) ──────────────────────────────────────────────────────
  // One-shot, idempotente: colunas de métricas diárias nas campanhas (0048).
  r.post("/admin/migrate-0048", requireScope("admin"), h(async (_req, res) => {
    const { MIGRATION_0048_STATEMENTS, IDEMPOTENT_ERROR_CODES_0048 } = await import("./migrations/migration_0048");
    const d = await db();
    if (!d) return res.status(500).json({ error: "DB unavailable" });
    let ok = 0, skipped = 0;
    const errors: string[] = [];
    for (const stmt of MIGRATION_0048_STATEMENTS) {
      try {
        await d.execute(sql.raw(stmt));
        ok++;
      } catch (e: any) {
        // drizzle embrulha o erro do mysql2 — o code fica em e.cause
        const code = e?.code ?? e?.cause?.code;
        const msg = String(e?.cause?.message ?? e?.message ?? e);
        if ((code && IDEMPOTENT_ERROR_CODES_0048.has(code)) || /duplicate column/i.test(msg)) skipped++;
        else errors.push(`${code ?? "ERR"}: ${msg.slice(0, 200)}`);
      }
    }
    res.json({ success: errors.length === 0, ok, skipped, errors });
  }));

  // Backfill: associa reservas sem projectId ao projeto certo via
  // "parque + cidade" (mesma normalização do sync). Idempotente.
  r.post("/admin/backfill-projects", requireScope("admin"), h(async (_req, res) => {
    const d = await db();
    if (!d) return res.status(500).json({ error: "DB unavailable" });
    const rows = (r2: any) => (Array.isArray(r2[0]) ? r2[0] : r2) as any[];
    const CITY_PT: Record<string, string> = { lisbon: "lisboa", lisboa: "lisboa", oporto: "porto", porto: "porto", faro: "faro" };

    const projs = rows(await d.execute(sql`SELECT id, name FROM projects WHERE level = 'project' AND isActive = 1`));
    const projMap = new Map<string, number>(projs.map((p: any) => [String(p.name).toLowerCase().trim(), Number(p.id)]));

    // Sem projeto OU arquivadas num nó intermédio (cidade/marca/grupo) — o
    // fallback do sync usava o nó da cidade quando o projeto folha não existia.
    const pending = rows(await d.execute(sql`
      SELECT id, parkName, city FROM multipark_bookings
      WHERE parkName IS NOT NULL AND parkName <> ''
        AND (projectId IS NULL OR projectId IN (SELECT id FROM projects WHERE level <> 'project'))`));
    const byProject = new Map<number, number[]>();
    let unmatched = 0;
    const unmatchedNames = new Map<string, number>();
    for (const b of pending) {
      const parkNorm = String(b.parkName).toLowerCase().replace(/\s*-\s*/g, " ").replace(/\s+/g, " ").trim();
      const cityRaw = String(b.city ?? "").toLowerCase().trim();
      const cityPt = CITY_PT[cityRaw] ?? cityRaw;
      // 1) parkName já contém a cidade ("boardingpark faro"); 2) junta a coluna city
      const pid = projMap.get(parkNorm) ?? (cityPt ? projMap.get(`${parkNorm} ${cityPt}`) : undefined);
      if (pid) {
        if (!byProject.has(pid)) byProject.set(pid, []);
        byProject.get(pid)!.push(Number(b.id));
      } else {
        unmatched++;
        unmatchedNames.set(parkNorm, (unmatchedNames.get(parkNorm) ?? 0) + 1);
      }
    }

    const updated: Array<{ projectId: number; project: string; bookings: number }> = [];
    for (const [pid, ids] of byProject) {
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        await d.execute(sql`UPDATE multipark_bookings SET projectId = ${pid} WHERE id IN (${sql.join(chunk.map((v) => sql`${v}`), sql`, `)})`);
      }
      const pname = projs.find((p: any) => Number(p.id) === pid)?.name ?? String(pid);
      updated.push({ projectId: pid, project: pname, bookings: ids.length });
    }
    updated.sort((a, b) => b.bookings - a.bookings);
    res.json({
      success: true,
      pending: pending.length,
      matched: pending.length - unmatched,
      unmatched,
      unmatchedTop: Array.from(unmatchedNames.entries()).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([name, n]) => ({ name, bookings: n })),
      updated,
    });
  }));

  r.post("/admin/cleanup-duplicates", requireScope("admin"), h(async (_req, res) => {
    const d = await db();
    if (!d) return res.status(500).json({ error: "DB unavailable" });
    const result = await d.execute(sql`
      DELETE FROM multipark_bookings WHERE id IN (
        SELECT id FROM (
          SELECT b1.id FROM multipark_bookings b1
          INNER JOIN multipark_bookings b2
            ON b1.externalId = b2.externalId
           AND (b1.updatedAt < b2.updatedAt OR (b1.updatedAt = b2.updatedAt AND b1.id < b2.id))
          LIMIT 5000
        ) AS t
      )`) as any;
    const meta = Array.isArray(result[0]) ? result[0] : result;
    res.json({ success: true, deleted: Number((meta as any)?.affectedRows ?? 0) });
  }));

  // ── DASHBOARD SUMMARY (visão cruzada, todos os parques) ──────────────────────
  r.get("/dashboard/summary", requireScope("read"), h(async (req, res) => {
    const d = await db();
    const q = req.query;
    const from = q.from ? String(q.from) : undefined;
    const to = q.to ? String(q.to) : undefined;
    const [bookingStats, complaintStats] = await Promise.all([
      getMultiparkBookingStats({ from, to }),
      getComplaintStats(),
    ]);
    let byCity: any[] = [];
    if (d) {
      const conds: any[] = [];
      if (from) conds.push(sql`${multiparkBookings.checkIn} >= ${from}`);
      if (to) conds.push(sql`${multiparkBookings.checkIn} <= ${to}`);
      byCity = await d
        .select({ city: multiparkBookings.city, count: sql<number>`COUNT(*)`, revenue: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}),0)` })
        .from(multiparkBookings)
        .where(conds.length ? (and(...conds) as any) : undefined)
        .groupBy(multiparkBookings.city);
    }
    res.json({ success: true, bookings: bookingStats, complaints: complaintStats, byCity });
  }));

  return r;
}
