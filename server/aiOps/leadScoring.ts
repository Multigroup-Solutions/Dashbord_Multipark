/**
 * Pontuação das leads de extras (0–100) com critérios EXPLÍCITOS e não
 * sensíveis, calculada no código:
 *   disponibilidade (25) · cidade operacional (15) · experiência (20) ·
 *   anos de carta (20) · rapidez de resposta (20).
 * NUNCA usa atributos protegidos (idade, género, nacionalidade/país, origem,
 * NIF, saúde, nome…): só os campos listados em `LEAD_SCORE_FIELDS`.
 *
 * A IA (`lead_summary`, lite) só escreve uma linha a partir das linhas da
 * pontuação (sem nome nem contactos). O rascunho do 1.º contacto
 * (`lead_first_contact`) fica PENDENTE de aprovação humana; o template
 * existente (`seja_motorista`) continua a sair sem aprovação, como hoje.
 */
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { LEAD_FIRST_CONTACT_SYSTEM, LEAD_SUMMARY_SYSTEM } from "../_core/ai/prompts/ops";
import { firstName } from "../_core/ai/pii";
import { AiCallCap, oneLine, tryAi } from "./aiCall";
import { cityOfProject, loadCityTrees, OPS_CITY_LABELS, opsCityOf } from "./cities";

const rowsOf = (res: unknown): any[] => (Array.isArray(res) ? (Array.isArray(res[0]) ? res[0] : res) : []) as any[];

/** Os ÚNICOS dados que entram na pontuação. */
export const LEAD_SCORE_FIELDS = ["availability", "cityKnown", "experience", "licenceYears", "responsiveness"] as const;

export interface LeadScoreInput {
  /** texto livre de disponibilidade (candidatura) */
  availabilityText: string | null;
  /** cidade operacional da lead (projeto) ou do texto da candidatura */
  city: "lisbon" | "porto" | "faro" | null;
  /** texto da experiência de condução (candidatura) */
  experienceText: string | null;
  /** anos de carta, se a candidatura os tiver */
  licenceYears: number | null;
  firstContactedAt: string | null;
  lastInboundAt: string | null;
  status: string;
}

export interface ScoreLine { key: (typeof LEAD_SCORE_FIELDS)[number]; label: string; points: number; max: number; detail: string }
export interface LeadScore { score: number; lines: ScoreLine[] }

/** "mais de 5 anos", "3 anos", "5+", "2-4 anos" → anos (o número mais baixo dito). PURA. */
export function parseYears(text: string | null | undefined): number | null {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return null;
  if (/\bmenos de (1|um) ano\b|\bsem experi|\bnenhum/.test(t)) return 0;
  const m = t.match(/(\d+(?:[.,]\d+)?)/);
  return m ? Number(m[1].replace(",", ".")) : null;
}

/** Nº de dias por semana indicados (0–7); "todos"/"full time" = 7. PURA. */
export function availabilityDays(text: string | null | undefined): number | null {
  const t = String(text ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (!t.trim()) return null;
  if (/\b(todos os dias|full[- ]?time|tempo inteiro|total|qualquer dia|sempre)\b/.test(t)) return 7;
  const days = ["segunda", "terca", "quarta", "quinta", "sexta", "sabado", "domingo"].filter((d) => t.includes(d)).length;
  if (days) return days;
  if (/fins? de semana|fds|weekend/.test(t)) return 2;
  const n = t.match(/(\d)\s*(dias|x)/);
  if (n) return Math.min(7, Number(n[1]));
  if (/part[- ]?time|meio tempo|algumas/.test(t)) return 3;
  return null;
}

const hoursBetween = (a: string, b: string) => (Date.parse(b.replace(" ", "T") + "Z") - Date.parse(a.replace(" ", "T") + "Z")) / 3_600_000;

/** Pontuação (PURA). */
export function computeLeadScore(i: LeadScoreInput, nowUtc: string): LeadScore {
  const lines: ScoreLine[] = [];
  const days = availabilityDays(i.availabilityText);
  lines.push({
    key: "availability", label: "Disponibilidade", max: 25,
    points: days == null ? 0 : days >= 5 ? 25 : days >= 3 ? 18 : days >= 1 ? 10 : 0,
    detail: days == null ? "sem dados" : `${days} dia(s) por semana`,
  });
  lines.push({
    key: "cityKnown", label: "Cidade de trabalho", max: 15,
    points: i.city ? 15 : 0, detail: i.city ? OPS_CITY_LABELS[i.city] : "sem cidade operacional",
  });
  const exp = parseYears(i.experienceText);
  lines.push({
    key: "experience", label: "Experiência de condução", max: 20,
    points: exp == null ? 0 : exp >= 3 ? 20 : exp >= 1 ? 12 : 4,
    detail: exp == null ? "sem dados" : `${exp} ano(s)`,
  });
  lines.push({
    key: "licenceYears", label: "Anos de carta", max: 20,
    points: i.licenceYears == null ? 0 : i.licenceYears >= 5 ? 20 : i.licenceYears >= 3 ? 14 : i.licenceYears >= 1 ? 8 : 0,
    detail: i.licenceYears == null ? "sem dados" : `${i.licenceYears} ano(s)`,
  });
  let resp: { points: number; detail: string };
  if (i.lastInboundAt && i.firstContactedAt) {
    const h = hoursBetween(i.firstContactedAt, i.lastInboundAt);
    resp = h >= 0 && h <= 24 ? { points: 20, detail: "respondeu em menos de 24 h" } : { points: 12, detail: "respondeu" };
  } else if (i.lastInboundAt || i.status === "replied") resp = { points: 12, detail: "respondeu" };
  else if (i.firstContactedAt) {
    const h = hoursBetween(i.firstContactedAt, nowUtc);
    resp = h > 72 ? { points: 0, detail: "sem resposta há mais de 3 dias" } : { points: 8, detail: "contactada, a aguardar resposta" };
  } else resp = { points: 10, detail: "ainda não contactada" };
  lines.push({ key: "responsiveness", label: "Rapidez de resposta", max: 20, ...resp });
  return { score: lines.reduce((s, l) => s + l.points, 0), lines };
}

export function scoreHash(s: LeadScore): string {
  return crypto.createHash("sha1").update(JSON.stringify(s.lines.map((l) => [l.key, l.points, l.detail]))).digest("hex");
}

export function summaryFacts(s: LeadScore): string {
  return [`Pontuação: ${s.score}/100.`, ...s.lines.map((l) => `${l.label}: ${l.points}/${l.max} (${l.detail})`)].join("\n");
}

/** Texto fixo (sem IA). PURA. */
export function summaryFallback(s: LeadScore): string {
  const strong = s.lines.filter((l) => l.points >= l.max * 0.7).map((l) => l.label.toLowerCase());
  const missing = s.lines.filter((l) => l.detail === "sem dados").map((l) => l.label.toLowerCase());
  return oneLine(`${s.score}/100${strong.length ? ` — forte em ${strong.join(", ")}` : ""}${missing.length ? `; falta saber ${missing.join(", ")}` : ""}.`, 300);
}

// ─── Dados da lead (só os campos permitidos) ────────────────────────────────

function pickPayload(payload: unknown, re: RegExp): string | null {
  if (!payload || typeof payload !== "object") return null;
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (!re.test(k)) continue;
    if (v == null) continue;
    if (Array.isArray(v)) return v.map(String).join(", ").slice(0, 300);
    if (typeof v === "object") continue;
    return String(v).slice(0, 300);
  }
  return null;
}

/** Anos de carta a partir de um número ou de uma data/ano. PURA. */
export function licenceYearsFrom(v: string | null, nowYear: number): number | null {
  if (!v) return null;
  const year = v.match(/\b(19[5-9]\d|20\d\d)\b/);
  if (year) return Math.max(0, nowYear - Number(year[1]));
  return parseYears(v);
}

async function loadLeadInputs(leadIds: number[]): Promise<Map<number, LeadScoreInput & { firstName: string; projectId: number | null }>> {
  const db = await getDb();
  const out = new Map<number, LeadScoreInput & { firstName: string; projectId: number | null }>();
  if (!db || !leadIds.length) return out;
  const ids = sql.join(leadIds.map((id) => sql`${id}`), sql`, `);
  const leads = rowsOf(await db.execute(sql`
    SELECT id, fullName, status, sourceRef, projectId,
           DATE_FORMAT(firstContactedAt, '%Y-%m-%d %H:%i:%s') AS firstContactedAt,
           DATE_FORMAT(lastInboundAt, '%Y-%m-%d %H:%i:%s') AS lastInboundAt
      FROM extra_leads WHERE id IN (${ids})`));
  const appIds = leads.map((l) => String(l.sourceRef ?? "").match(/^application:(\d+)$/)?.[1]).filter(Boolean).map(Number);
  const apps = appIds.length ? rowsOf(await db.execute(sql`
    SELECT id, city, drivingExperience, payload FROM driver_applications WHERE id IN (${sql.join(appIds.map((id) => sql`${id}`), sql`, `)})`)) : [];
  const appById = new Map(apps.map((a) => [Number(a.id), a]));
  const trees = await loadCityTrees();
  const nowYear = new Date().getUTCFullYear();
  for (const l of leads) {
    const appId = Number(String(l.sourceRef ?? "").match(/^application:(\d+)$/)?.[1] ?? 0);
    const app = appId ? appById.get(appId) : undefined;
    let payload: unknown = app?.payload ?? null;
    if (typeof payload === "string") { try { payload = JSON.parse(payload); } catch { payload = null; } }
    const projectId = l.projectId == null ? null : Number(l.projectId);
    out.set(Number(l.id), {
      firstName: firstName(l.fullName, "olá"),
      projectId,
      availabilityText: pickPayload(payload, /dispon|availab/i),
      city: cityOfProject(projectId, trees)?.city ?? opsCityOf(app?.city ?? null),
      experienceText: (app?.drivingExperience as string | null) ?? pickPayload(payload, /experi/i),
      licenceYears: licenceYearsFrom(pickPayload(payload, /licen|carta|driving.?licen/i), nowYear),
      firstContactedAt: l.firstContactedAt ?? null,
      lastInboundAt: l.lastInboundAt ?? null,
      status: String(l.status),
    });
  }
  return out;
}

export interface LeadScoreView { leadId: number; score: number; lines: ScoreLine[]; summary: string | null; draftMessage: string | null; draftStatus: string | null }

/** Calcula/atualiza (e resume com IA, se mudou) as leads pedidas. */
export async function scoreLeads(leadIds: number[], opts: { cap?: AiCallCap; withSummary?: boolean; userId?: number | null } = {}): Promise<LeadScoreView[]> {
  const db = await getDb();
  if (!db) return [];
  const inputs = await loadLeadInputs(leadIds.slice(0, 200));
  const existing = new Map(rowsOf(await db.execute(sql`
    SELECT leadId, inputsHash, summary, summaryHash, draftMessage, draftStatus FROM extra_lead_scores
     WHERE leadId IN (${sql.join([...inputs.keys(), 0].map((id) => sql`${id}`), sql`, `)})`)).map((r) => [Number(r.leadId), r]));
  const nowUtc = new Date().toISOString().slice(0, 19).replace("T", " ");
  const cap = opts.cap ?? new AiCallCap(10);
  const out: LeadScoreView[] = [];
  for (const [leadId, input] of inputs) {
    const s = computeLeadScore(input, nowUtc);
    const hash = scoreHash(s);
    const prev = existing.get(leadId);
    let summary: string | null = prev?.summaryHash === hash ? prev.summary ?? null : null;
    if (!summary && opts.withSummary) {
      const r = await tryAi({ feature: "lead_summary", system: LEAD_SUMMARY_SYSTEM, input: summaryFacts(s), cap, maxTokens: 120, entity: "extra_lead", entityId: leadId, userId: opts.userId ?? null });
      summary = r.ok ? oneLine(r.output, 300) : null;
    }
    await db.execute(sql`
      INSERT INTO extra_lead_scores (leadId, score, breakdown, inputsHash, summary, summaryHash, computedAt)
      VALUES (${leadId}, ${s.score}, ${JSON.stringify(s.lines)}, ${hash}, ${summary}, ${summary ? hash : null}, ${nowUtc})
      ON DUPLICATE KEY UPDATE score = VALUES(score), breakdown = VALUES(breakdown), inputsHash = VALUES(inputsHash),
        summary = VALUES(summary), summaryHash = VALUES(summaryHash), computedAt = VALUES(computedAt)`);
    out.push({ leadId, score: s.score, lines: s.lines, summary: summary ?? (opts.withSummary ? summaryFallback(s) : null), draftMessage: prev?.draftMessage ?? null, draftStatus: prev?.draftStatus ?? null });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Rascunho do 1.º contacto (fica PENDENTE de aprovação). */
export async function draftFirstContact(leadId: number, userId: number): Promise<{ ok: true; message: string } | { ok: false; reason: string }> {
  const db = await getDb();
  if (!db) return { ok: false, reason: "BD indisponível" };
  const input = (await loadLeadInputs([leadId])).get(leadId);
  if (!input) return { ok: false, reason: "Lead não encontrada" };
  const facts = [`Primeiro nome: ${input.firstName}.`, input.city ? `Cidade: ${OPS_CITY_LABELS[input.city]}.` : "", "Objetivo: saber a disponibilidade para trabalhar como condutor extra (valet) nos parques."].filter(Boolean).join("\n");
  const r = await tryAi({ feature: "lead_first_contact", system: LEAD_FIRST_CONTACT_SYSTEM, input: facts, maxTokens: 200, entity: "extra_lead", entityId: leadId, userId, redact: false });
  if (!r.ok) return { ok: false, reason: r.skipped === "disabled" ? "A IA das leads está desligada." : "IA indisponível — usa o template." };
  const message = r.output.trim().slice(0, 1000);
  await scoreLeads([leadId]); // garante a linha (com a pontuação real)
  await db.execute(sql`
    UPDATE extra_lead_scores SET draftMessage = ${message}, draftStatus = 'pending', draftCreatedById = ${userId},
           draftReviewedById = NULL, draftReviewedAt = NULL
     WHERE leadId = ${leadId}`);
  return { ok: true, message };
}

/**
 * Aprovar (com o texto final, que o humano pode ter editado) ou rejeitar.
 * Aprovado + janela de 24 h do WhatsApp aberta → envia pela conversa (fica
 * registado no inbox); janela fechada → só aprovado (usar o template).
 */
export async function reviewFirstContact(leadId: number, input: { approve: boolean; message?: string | null }, user: { id: number }): Promise<{ status: "approved" | "rejected"; sent: boolean; reason?: string }> {
  const db = await getDb();
  if (!db) throw new Error("BD indisponível");
  const row = rowsOf(await db.execute(sql`SELECT draftMessage, draftStatus FROM extra_lead_scores WHERE leadId = ${leadId} LIMIT 1`))[0];
  if (!row?.draftMessage || row.draftStatus !== "pending") throw new Error("Não há rascunho pendente para esta lead.");
  const text = (input.message ?? row.draftMessage).trim().slice(0, 1000);
  const nowUtc = new Date().toISOString().slice(0, 19).replace("T", " ");
  const status = input.approve ? "approved" : "rejected";
  const upd = await db.execute(sql`
    UPDATE extra_lead_scores SET draftStatus = ${status}, draftMessage = ${text}, draftReviewedById = ${user.id}, draftReviewedAt = ${nowUtc}
     WHERE leadId = ${leadId} AND draftStatus = 'pending'`);
  if (Number((Array.isArray(upd) ? (upd[0] as any) : (upd as any))?.affectedRows ?? 0) === 0) throw new Error("O rascunho já foi revisto.");
  if (!input.approve) return { status, sent: false };
  const lead = rowsOf(await db.execute(sql`SELECT phoneE164, optedOutAt FROM extra_leads WHERE id = ${leadId} LIMIT 1`))[0];
  if (!lead?.phoneE164) return { status, sent: false, reason: "A lead não tem telemóvel." };
  if (lead.optedOutAt) return { status, sent: false, reason: "A lead pediu para não receber WhatsApp." };
  const conv = rowsOf(await db.execute(sql`SELECT id FROM whatsapp_conversations WHERE phoneE164 = ${lead.phoneE164} ORDER BY id DESC LIMIT 1`))[0];
  if (!conv) return { status, sent: false, reason: "Sem conversa aberta: inicia com o template «seja_motorista»." };
  const { replyToConversation } = await import("../whatsappInbox");
  const r = await replyToConversation(Number(conv.id), text, user.id);
  return r.ok ? { status, sent: true } : { status, sent: false, reason: r.error ?? "Não foi possível enviar." };
}

export async function getLeadScores(leadIds: number[]): Promise<LeadScoreView[]> {
  const db = await getDb();
  if (!db || !leadIds.length) return [];
  const rows = rowsOf(await db.execute(sql`
    SELECT leadId, score, breakdown, summary, draftMessage, draftStatus FROM extra_lead_scores
     WHERE leadId IN (${sql.join(leadIds.slice(0, 500).map((id) => sql`${id}`), sql`, `)})`));
  return rows.map((r) => {
    let lines: ScoreLine[] = [];
    try { lines = JSON.parse(String(r.breakdown)); } catch { lines = []; }
    return { leadId: Number(r.leadId), score: Number(r.score), lines, summary: r.summary ?? null, draftMessage: r.draftMessage ?? null, draftStatus: r.draftStatus ?? null };
  });
}
