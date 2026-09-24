/**
 * MCP Control API — superfície REST completa para controlar a Dashboard Multipark
 * a partir de um servidor MCP (ou qualquer cliente HTTP).
 *
 * Montado em /api/v1. Autenticação por header X-API-Key (tabela api_keys).
 * Cada chave tem um campo `permissions` que define o scope (ver server/apiKeyAuth.ts):
 *   - "read"           → só leituras
 *   - "read,write"     → leituras + escrita operacional (criar/editar, syncs)
 *   - "admin" ou "*"   → tudo, incluindo operações destrutivas
 * (admin implica write implica read). Chaves "device" (ou sem permissions) não acedem aqui.
 *
 * Cobre todos os parques e cidades (PARK_CONFIGS).
 */
import { Router, Request, Response } from "express";
import { and, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { multiparkBookings } from "../drizzle/schema";
import { apiKeyMiddleware, requireScope, logApiKeyAction, apiKeyActorId, getApiKeyInfo } from "./apiKeyAuth";
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
} from "./db";

let _db: ReturnType<typeof drizzle> | null = null;
async function db() {
  if (!_db && process.env.DATABASE_URL) _db = drizzle(process.env.DATABASE_URL);
  return _db;
}

// ─── AUTH + SCOPES ────────────────────────────────────────────────────────────

// Autenticação por hash, expiração, lastUsedAt (5 min) e scopes: server/apiKeyAuth.ts.
// Chaves "device" (dispositivos) não têm acesso a nenhuma rota daqui.

// helper para apanhar erros sem repetir try/catch
const h = (fn: (req: Request, res: Response) => Promise<any>) =>
  (req: Request, res: Response) => fn(req, res).catch((e: any) => {
    console.error("[MCP API]", req.method, req.path, e);
    res.status(500).json({ error: String(e?.message || "Erro interno").slice(0, 300) });
  });

function parseDate(v: any): Date | undefined {
  if (!v) return undefined;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? undefined : d;
}

// ─── ROUTER ─────────────────────────────────────────────────────────────────

export function createMcpApiRouter(): Router {
  const r = Router();
  r.use(apiKeyMiddleware("v1"));
  // Defesa em profundidade: TUDO em /admin/* exige 'admin', mesmo que uma rota
  // nova se esqueça do requireScope.
  r.use("/admin", requireScope("admin"));

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
          "GET /campaigns", "GET /campaigns/api/:id/daily", "GET /projects",
          "GET /availability-form/context?token=",
        ],
        write: [
          "POST /complaints", "PATCH /complaints/:id", "POST /complaints/:id/messages",
          "POST /reviews", "POST /sync/recent", "POST /sync/future", "POST /sync/day",
          "POST /availability-form/submit",
          "POST /driver-applications",
          "POST /extras-availability/submit-by-email",
        ],
        admin: [
          "DELETE /complaints/:id", "POST /projects", "POST /admin/migrate-0048", "POST /admin/backfill-projects",
          "POST /admin/merge-duplicate-extras",
        ],
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
    await logApiKeyAction(req, { action: "submit", entity: "extras_availability", details: `[form] ${result.data.saved} dia(s)` });
    return res.json({ success: true, saved: result.data.saved });
  }));

  // ── WEBSITE MULTIDRIVER (intake por email) ──────────────────────────────────
  // Candidatura "Be a Driver": upsert por email (UNIQUE) — nunca duplica.
  r.post("/driver-applications", requireScope("write"), h(async (req, res) => {
    const { driverApplicationSchema, upsertDriverApplication } = await import("./webIntake");
    const parsed = driverApplicationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: "Invalid application", code: "invalid_input", details: parsed.error.flatten() });
    }
    const result = await upsertDriverApplication(parsed.data);
    await logApiKeyAction(req, { action: "upsert", entity: "driver_application", entityId: (result as any)?.id ?? null, details: "[site] candidatura Be a Driver" });
    return res.json({ success: true, ...result });
  }));

  // Disponibilidade semanal submetida no site (email verificado por Google
  // sign-in no site). Auto-cria um extra pendente se o email for desconhecido.
  r.post("/extras-availability/submit-by-email", requireScope("write"), h(async (req, res) => {
    const { availabilityByEmailSchema, submitAvailabilityByEmail } = await import("./webIntake");
    const parsed = availabilityByEmailSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: "Invalid availability", code: "invalid_input", details: parsed.error.flatten() });
    }
    const result = await submitAvailabilityByEmail(parsed.data);
    await logApiKeyAction(req, { action: "submit", entity: "extras_availability", entityId: (result as any)?.employeeId ?? null, details: "[site] disponibilidade por email" });
    return res.json({ success: true, ...result });
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
    await logApiKeyAction(req, { action: "create", entity: "project", entityId: created?.id ?? null, details: `[MCP] ${level}: ${name}`, asKeyEvent: true });
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
    // Campanhas das APIs (Google Ads/Meta) — as que têm histórico diário (/campaigns/api/:id/daily).
    const api = rows(await d.execute(sql`SELECT id, name, projectId, budgetMicros / 1000000 AS dailyBudget, provider AS brand, status AS campaignStatus FROM ad_campaigns ORDER BY name`))
      .map((c: any) => ({ ...c, city: null, campaignType: "api" }));
    res.json({ success: true, count: internal.length + ad.length + api.length, campaigns: [...internal, ...ad, ...api] });
  }));

  // Histórico diário (gasto + métricas) de uma campanha — da MESMA fonte do
  // Marketing (ad_daily_metrics, APIs Google Ads/Meta). type "api" = id de
  // ad_campaigns (ver GET /campaigns). Os tipos antigos ("internal"/"ad")
  // liam internal_campaign_costs, que já ninguém escreve → 410, como o POST.
  r.get("/campaigns/:type/:id/daily", requireScope("read"), h(async (req, res) => {
    const type = String(req.params.type);
    if (type === "internal" || type === "ad") {
      return res.status(410).json({ error: "Descontinuado: o histórico diário vem das APIs Google Ads/Meta. Usa GET /campaigns (campaignType 'api') e /campaigns/api/:id/daily." });
    }
    if (type !== "api") return res.status(400).json({ error: "type deve ser 'api'" });
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "id inválido" });
    const d = await db();
    if (!d) return res.status(500).json({ error: "DB unavailable" });
    const rows = (r2: any) => (Array.isArray(r2[0]) ? r2[0] : r2) as any[];
    const [camp] = rows(await d.execute(sql`SELECT id, provider, accountId, externalId, name FROM ad_campaigns WHERE id = ${id} LIMIT 1`));
    if (!camp) return res.status(404).json({ error: "Campanha não encontrada" });
    const daily = rows(await d.execute(sql`
      SELECT m.date AS date, SUM(m.costMicros) / 1000000 AS cost, MAX(COALESCE(m.currency, a.currency)) AS currency,
             SUM(m.impressions) AS impressions, SUM(m.clicks) AS clicks, SUM(m.conversions) AS conversions,
             SUM(m.conversionValueMicros) / 1000000 AS conversionValue, MAX(m.isProvisional) AS provisional
        FROM ad_daily_metrics m
        JOIN ad_accounts a ON a.id = m.accountId
       WHERE m.provider = ${camp.provider} AND m.accountId = ${camp.accountId} AND m.campaignExternalId = ${camp.externalId} AND m.source = 'api'
       GROUP BY m.date
       ORDER BY m.date DESC
       LIMIT 120`)).map((x: any) => ({
        date: String(x.date instanceof Date ? x.date.toISOString() : x.date).slice(0, 10),
        cost: Number(x.cost ?? 0), currency: x.currency ?? null, impressions: Number(x.impressions ?? 0), clicks: Number(x.clicks ?? 0),
        conversions: Number(x.conversions ?? 0), conversionValue: Number(x.conversionValue ?? 0), provisional: Number(x.provisional ?? 0) === 1,
      }));
    res.json({ success: true, campaign: { id: camp.id, provider: camp.provider, name: camp.name }, count: daily.length, daily });
  }));

  // Descontinuado (24 set 2026): gravava em internal_campaign_costs, que já
  // ninguém lê — o gasto vem só das APIs (Google Ads / Meta, ad_daily_metrics).
  r.post("/campaigns/daily", requireScope("write"), (_req: Request, res: Response) => {
    res.status(410).json({ error: "Descontinuado: o gasto das campanhas vem das APIs Google Ads/Meta (Marketing). Nada foi gravado." });
  });

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
      createdById: apiKeyActorId(getApiKeyInfo(req)) || null,
    } as any);
    await logApiKeyAction(req, { action: "create", entity: "complaint", entityId: id, details: `[MCP] ${b.title}` });
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
    await logApiKeyAction(req, { action: "update", entity: "complaint", entityId: id, details: `[MCP] update (${Object.keys(data).join(", ")})` });
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
      authorId: apiKeyActorId(getApiKeyInfo(req)) || null,
      authorName: b.authorName ?? "MCP",
    } as any);
    await logApiKeyAction(req, { action: "create", entity: "complaint_message", entityId: complaintId, details: `[MCP] mensagem #${msgId}` });
    res.json({ success: true, id: msgId });
  }));

  r.delete("/complaints/:id", requireScope("admin"), h(async (req, res) => {
    const id = Number(req.params.id);
    await deleteComplaint(id);
    await logApiKeyAction(req, { action: "delete", entity: "complaint", entityId: id, details: `[MCP] delete`, asKeyEvent: true });
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
      createdById: apiKeyActorId(getApiKeyInfo(req)) || null,
    } as any);
    await logApiKeyAction(req, { action: "create", entity: "google_review", entityId: id, details: `[MCP] ${b.rating}★ ${b.reviewerName}` });
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
    const result = await runRecentCronSync(windowMinutes);
    await logApiKeyAction(req, { action: "sync", entity: "multipark", asKeyEvent: true, details: `[MCP] sync recente (${windowMinutes} min)` });
    res.json({ success: true, ...result });
  }));

  r.post("/sync/future", requireScope("write"), h(async (req, res) => {
    const { runFutureCronSync } = await import("./jobs/multiparkBookingSync");
    const weeks = req.body?.weeksAhead ? Number(req.body.weeksAhead) : 4;
    const result = await runFutureCronSync(weeks);
    await logApiKeyAction(req, { action: "sync", entity: "multipark", asKeyEvent: true, details: `[MCP] sync futuro (${weeks} semanas)` });
    res.json({ success: true, ...result });
  }));

  // Sincroniza um dia específico (report + enrich + history) — para backfill
  r.post("/sync/day", requireScope("write"), h(async (req, res) => {
    const date = String(req.body?.date ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date (YYYY-MM-DD) é obrigatório" });
    const { syncBookings, enrichBookingsBatch, syncBookingHistoryBatch } = await import("./jobs/multiparkBookingSync");
    const report = await syncBookings({ startDate: date, endDate: date });
    const [enrichRes, historyRes] = await Promise.allSettled([enrichBookingsBatch(100), syncBookingHistoryBatch(50)]);
    await logApiKeyAction(req, { action: "sync", entity: "multipark", asKeyEvent: true, details: `[MCP] sync do dia ${date}` });
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
  r.post("/admin/migrate-0048", requireScope("admin"), h(async (req, res) => {
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
    await logApiKeyAction(req, { action: "admin_migrate", entity: "migration_0048", asKeyEvent: true, details: `[MCP] migrate-0048: ${ok} ok, ${skipped} ignoradas, ${errors.length} erros` });
    res.json({ success: errors.length === 0, ok, skipped, errors });
  }));

  // Backfill: associa reservas sem projectId (ou presas num nó intermédio)
  // ao projeto certo com o matcher determinístico partilhado com o sync
  // (shared/projectTree.ts via server/projectAdmin.ts). Idempotente.
  r.post("/admin/backfill-projects", requireScope("admin"), h(async (req, res) => {
    const { backfillBookingProjects } = await import("./projectAdmin");
    const result = await backfillBookingProjects({ includeIntermediate: true });
    await logApiKeyAction(req, { action: "admin_backfill", entity: "multipark_bookings", asKeyEvent: true, details: "[MCP] backfill-projects" });
    res.json({ success: true, ...result });
  }));

  // Funde extras duplicados por email (duplicados auto-criados pelo site antes
  // da correção de identidade). DRY-RUN por defeito: body `{ "apply": true }`
  // para escrever. Ver server/mergeDuplicateExtras.ts.
  r.post("/admin/merge-duplicate-extras", requireScope("admin"), h(async (req, res) => {
    const { mergeDuplicateExtras } = await import("./mergeDuplicateExtras");
    const report = await mergeDuplicateExtras({ apply: req.body?.apply === true });
    await logApiKeyAction(req, { action: "admin_merge", entity: "employees", asKeyEvent: true, details: `[MCP] merge-duplicate-extras (${req.body?.apply === true ? "apply" : "dry-run"})` });
    res.json({ success: true, ...report });
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
