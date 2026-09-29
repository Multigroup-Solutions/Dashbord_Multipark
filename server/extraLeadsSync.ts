/**
 * Um só funil de recrutamento (Jorge, 24 set 2026): candidaturas do site
 * ("Be a Driver", `driver_applications`) e emails de recrutamento
 * (recursos-humanos@ → `inbound_emails` com targetModule 'rh') passam a gerar
 * leads automaticamente, com `source` = 'site' / 'email' e `sourceRef`
 * ("application:123" / "email:456").
 *
 *  - Dedupe por telemóvel (E.164) e email contra os leads existentes: se a
 *    pessoa já é lead, só se anota a origem (não duplica).
 *  - Quem já é colaborador ATIVO (mesmo telemóvel ou email) não vira lead.
 *  - Cada origem processada fica em `extra_lead_sources` → um lead apagado
 *    pelo backoffice não volta a nascer da mesma candidatura/email.
 *  - Aprovar a candidatura converte o lead (com o employeeId); converter o lead
 *    aprova a candidatura pendente correspondente.
 *  - Mensagem WhatsApp recebida de um lead `new`/`contacted` → "Respondeu",
 *    notificação ao backoffice e (1× por lead) resposta automática com o link
 *    da candidatura.
 *
 * Tudo best-effort do lado de quem chama (webhook, cron, intake): nunca parte
 * o fluxo principal.
 */
import { isFeatureEnabled } from "./_core/featureFlags";
import { and, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb, logActivity } from "./db";
import { driverApplications, employees, extraLeadSources, extraLeads, inboundEmails } from "../drizzle/schema";
import { normalizeEmail } from "../shared/email";
import { normalizePhoneE164 } from "../shared/phone";
import { matchCityKey } from "../shared/city";
import { canAutoMarkReplied, isAutomatedSender, matchExistingLead } from "../shared/extraLeadsFunnel";
import { normalizeLeadInput } from "./extraLeads";
import { extractAffectedRows } from "./availabilityFormToken";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

// ─── Puras ──────────────────────────────────────────────────────────────────

/**
 * Cidade escrita à mão (candidatura) → id do nó `level='city'` dessa cidade.
 * Só quando há EXATAMENTE um nó dessa cidade (senão fica sem cidade = visível
 * a todos, melhor do que escondê-lo na cidade errada). PURA.
 */
export function cityProjectIdFromText(
  text: string | null | undefined,
  projects: { id: number; name: string; level: string | null }[],
): number | null {
  const key = matchCityKey(text ?? "");
  if (!key) return null;
  const hits = projects.filter((p) => p.level === "city" && matchCityKey(p.name) === key);
  return hits.length === 1 ? hits[0].id : null;
}

/** Nota acrescentada a um lead existente que volta a aparecer por outra origem. PURA. */
export function appendSourceNote(notes: string | null, tag: string): string | null {
  const cur = (notes ?? "").trim();
  if (cur.includes(tag)) return cur || null;
  return (cur ? `${cur} · ${tag}` : tag).slice(0, 512);
}

// ─── Contexto de importação ─────────────────────────────────────────────────

interface LeadLite {
  id: number;
  phoneE164: string | null;
  email: string | null;
  sourceRef: string | null;
  notes: string | null;
}

interface SyncContext {
  leads: LeadLite[];
  employeePhones: Set<string>;
  employeeEmails: Set<string>;
}

async function loadSyncContext(db: Db): Promise<SyncContext> {
  const leads = (await db
    .select({ id: extraLeads.id, phoneE164: extraLeads.phoneE164, email: extraLeads.email, sourceRef: extraLeads.sourceRef, notes: extraLeads.notes })
    .from(extraLeads)) as LeadLite[];
  const emps = await db
    .select({ phone: employees.phone, email: employees.email })
    .from(employees)
    .where(eq(employees.isActive, 1));
  const employeePhones = new Set<string>();
  const employeeEmails = new Set<string>();
  for (const e of emps) {
    const p = e.phone ? normalizePhoneE164(e.phone) : null;
    if (p) employeePhones.add(p);
    if (e.email) employeeEmails.add(normalizeEmail(e.email));
  }
  return { leads, employeePhones, employeeEmails };
}

async function seenRefs(db: Db, refs: string[]): Promise<Set<string>> {
  if (!refs.length) return new Set();
  const out = new Set<string>();
  for (let i = 0; i < refs.length; i += 500) {
    const rows = await db.select({ r: extraLeadSources.sourceRef }).from(extraLeadSources).where(inArray(extraLeadSources.sourceRef, refs.slice(i, i + 500)));
    for (const r of rows) out.add(r.r);
  }
  return out;
}

async function markSeen(db: Db, sourceRef: string, leadId: number | null, outcome: string): Promise<void> {
  await db.execute(sql`INSERT IGNORE INTO \`extra_lead_sources\` (sourceRef, leadId, outcome) VALUES (${sourceRef}, ${leadId}, ${outcome})`);
}

export interface LeadCandidate {
  sourceRef: string;
  source: "site" | "email";
  fullName: string;
  phone: string | null;
  email: string | null;
  projectId: number | null;
  note: string;
}

export type IngestOutcome = "created" | "merged" | "employee" | "invalid" | "seen";

/**
 * Cria (ou junta a um lead existente) um contacto vindo de uma origem
 * automática. Idempotente pela `sourceRef` (tabela `extra_lead_sources` +
 * UNIQUE em extra_leads.sourceRef).
 */
async function ingestCandidate(db: Db, ctx: SyncContext, cand: LeadCandidate): Promise<{ outcome: IngestOutcome; leadId: number | null }> {
  if ((await seenRefs(db, [cand.sourceRef])).size) return { outcome: "seen", leadId: null };

  // Telemóvel do formulário/email é texto livre: se não normalizar, fica só o email.
  let parsed = normalizeLeadInput({ fullName: cand.fullName, phone: cand.phone, email: cand.email, notes: cand.note });
  if (!parsed.ok && cand.phone && cand.email) {
    parsed = normalizeLeadInput({ fullName: cand.fullName, phone: null, email: cand.email, notes: cand.note });
  }
  if (!parsed.ok) {
    await markSeen(db, cand.sourceRef, null, "invalid");
    return { outcome: "invalid", leadId: null };
  }
  const lead = parsed.lead;

  if ((lead.phoneE164 && ctx.employeePhones.has(lead.phoneE164)) || (lead.email && ctx.employeeEmails.has(lead.email))) {
    await markSeen(db, cand.sourceRef, null, "employee");
    return { outcome: "employee", leadId: null };
  }

  const tag = cand.source === "site" ? "via candidatura do site" : "via email de recrutamento";
  const existing = matchExistingLead(lead, ctx.leads);
  if (existing) {
    const notes = appendSourceNote(existing.notes, tag);
    await db
      .update(extraLeads)
      .set({ notes, sourceRef: sql`COALESCE(${extraLeads.sourceRef}, ${cand.sourceRef})` } as any)
      .where(eq(extraLeads.id, existing.id));
    existing.notes = notes;
    existing.sourceRef = existing.sourceRef ?? cand.sourceRef;
    await markSeen(db, cand.sourceRef, existing.id, "merged");
    return { outcome: "merged", leadId: existing.id };
  }

  let id: number;
  try {
    const res = await db.insert(extraLeads).values({
      ...lead,
      source: cand.source,
      sourceRef: cand.sourceRef,
      projectId: cand.projectId,
      createdById: null,
    });
    id = Number((res as any)[0]?.insertId ?? (res as any).insertId);
  } catch (err: any) {
    const code = err?.code ?? err?.cause?.code;
    if (code === "ER_DUP_ENTRY") {
      // Outra corrida (webhook + cron) criou-o ao mesmo tempo.
      await markSeen(db, cand.sourceRef, null, "merged");
      return { outcome: "seen", leadId: null };
    }
    throw err;
  }
  ctx.leads.push({ id, phoneE164: lead.phoneE164, email: lead.email, sourceRef: cand.sourceRef, notes: lead.notes });
  await markSeen(db, cand.sourceRef, id, "created");
  await logActivity({
    userId: 0,
    action: "extra_lead_import",
    entity: "extra_leads",
    entityId: id,
    details: `Lead importado (${cand.source}, ${cand.sourceRef}): ${lead.fullName}${lead.phone ? ` · ${lead.phone}` : ""}${lead.email ? ` · ${lead.email}` : ""}`,
  });
  return { outcome: "created", leadId: id };
}

// ─── Candidaturas do site ───────────────────────────────────────────────────

type ApplicationRow = typeof driverApplications.$inferSelect;

async function applicationCandidate(app: ApplicationRow, projects: { id: number; name: string; level: string | null }[]): Promise<LeadCandidate> {
  const bits = ["Candidatura do site", app.city, app.drivingExperience ? `experiência: ${app.drivingExperience}` : null].filter(Boolean);
  return {
    sourceRef: `application:${app.id}`,
    source: "site",
    fullName: app.fullName,
    phone: app.phone,
    email: app.email,
    projectId: cityProjectIdFromText(app.city, projects),
    note: bits.join(" · "),
  };
}

async function loadProjectNodes(): Promise<{ id: number; name: string; level: string | null }[]> {
  const { getProjects } = await import("./db");
  return (await getProjects()) as { id: number; name: string; level: string | null }[];
}

export interface SyncSummary { scanned: number; created: number; merged: number; employee: number; invalid: number }

function tally(sum: SyncSummary, o: IngestOutcome): void {
  if (o === "seen") return;
  sum[o]++;
}

/** Nova candidatura (hook do intake). Best-effort: nunca lança. */
export async function onApplicationCreated(applicationId: number): Promise<IngestOutcome | null> {
  try {
    const db = await getDb();
    if (!db) return null;
    const [app] = await db.select().from(driverApplications).where(eq(driverApplications.id, applicationId)).limit(1);
    if (!app) return null;
    const ctx = await loadSyncContext(db);
    return (await ingestCandidate(db, ctx, await applicationCandidate(app, await loadProjectNodes()))).outcome;
  } catch (err) {
    console.warn("[extraLeadsSync] candidatura → lead falhou:", String(err).slice(0, 200));
    return null;
  }
}

/**
 * Backfill idempotente: candidaturas PENDENTES (new/reviewed, sem ficha) que
 * ainda não passaram pela importação viram leads.
 */
export async function syncApplicationLeads(): Promise<SyncSummary> {
  const sum: SyncSummary = { scanned: 0, created: 0, merged: 0, employee: 0, invalid: 0 };
  const db = await getDb();
  if (!db) return sum;
  const apps = await db
    .select()
    .from(driverApplications)
    .where(and(inArray(driverApplications.status, ["new", "reviewed"]), isNull(driverApplications.employeeId)));
  const seen = await seenRefs(db, apps.map((a) => `application:${a.id}`));
  const todo = apps.filter((a) => !seen.has(`application:${a.id}`));
  sum.scanned = todo.length;
  if (!todo.length) return sum;
  const ctx = await loadSyncContext(db);
  const projects = await loadProjectNodes();
  for (const app of todo) {
    try {
      tally(sum, (await ingestCandidate(db, ctx, await applicationCandidate(app, projects))).outcome);
    } catch (err) {
      console.warn("[extraLeadsSync] candidatura", app.id, String(err).slice(0, 160));
    }
  }
  return sum;
}

// ─── Emails de recrutamento ─────────────────────────────────────────────────

/** Janela dos emails de recrutamento importados (dias). */
export const EMAIL_LEADS_SINCE_DAYS = 90;

/**
 * Emails em recursos-humanos@ que viraram tarefa de recrutamento (targetModule
 * 'rh') com nome + email/telefone → leads `source='email'`. Remetentes
 * automáticos e o próprio domínio ficam de fora.
 */
export async function syncEmailLeads(sinceDays = EMAIL_LEADS_SINCE_DAYS): Promise<SyncSummary> {
  const sum: SyncSummary = { scanned: 0, created: 0, merged: 0, employee: 0, invalid: 0 };
  const db = await getDb();
  if (!db) return sum;
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  const rows = await db
    .select({
      id: inboundEmails.id,
      fromName: inboundEmails.fromName,
      fromEmail: inboundEmails.fromEmail,
      clientName: inboundEmails.clientName,
      clientEmail: inboundEmails.clientEmail,
      clientPhone: inboundEmails.clientPhone,
      subject: inboundEmails.subject,
    })
    .from(inboundEmails)
    .where(
      and(
        eq(inboundEmails.alias, "recursos-humanos"),
        eq(inboundEmails.targetModule, "rh"),
        eq(inboundEmails.status, "processed"),
        gte(inboundEmails.createdAt, since),
      ),
    )
    .limit(2000);
  const seen = await seenRefs(db, rows.map((r) => `email:${r.id}`));
  const todo = rows.filter((r) => !seen.has(`email:${r.id}`));
  sum.scanned = todo.length;
  if (!todo.length) return sum;
  const ctx = await loadSyncContext(db);
  for (const r of todo) {
    const ref = `email:${r.id}`;
    try {
      const email = (r.clientEmail || r.fromEmail || "").trim() || null;
      const name = (r.clientName || r.fromName || "").trim().replace(/^["']|["']$/g, "");
      if (!name || name.includes("@") || /^desconhecido$/i.test(name) || (!email && !r.clientPhone) || isAutomatedSender(email)) {
        await markSeen(db, ref, null, "invalid");
        sum.invalid++;
        continue;
      }
      tally(
        sum,
        (
          await ingestCandidate(db, ctx, {
            sourceRef: ref,
            source: "email",
            fullName: name,
            phone: r.clientPhone,
            email,
            projectId: null,
            note: `Email de recrutamento${r.subject ? `: ${r.subject}` : ""}`.slice(0, 200),
          })
        ).outcome,
      );
    } catch (err) {
      console.warn("[extraLeadsSync] email", r.id, String(err).slice(0, 160));
    }
  }
  return sum;
}

// ─── Candidatura ↔ lead na conversão ────────────────────────────────────────

/** Lead que corresponde a uma candidatura: pela sourceRef, senão telemóvel/email. */
async function findLeadForApplication(db: Db, app: { id: number; email: string; phone: string | null }) {
  const ref = `application:${app.id}`;
  const phoneE164 = app.phone ? normalizePhoneE164(app.phone) : null;
  const email = normalizeEmail(app.email);
  const conds = [eq(extraLeads.sourceRef, ref), eq(extraLeads.email, email)];
  if (phoneE164) conds.push(eq(extraLeads.phoneE164, phoneE164));
  const rows = await db.select().from(extraLeads).where(or(...conds)).limit(10);
  return rows.find((r) => r.sourceRef === ref) ?? matchExistingLead({ phoneE164, email }, rows);
}

/**
 * Candidatura aprovada → o lead correspondente fica Convertido e ligado à
 * ficha. Não mexe num lead já ligado a outra ficha. Best-effort.
 */
export async function markLeadConvertedForApplication(
  applicationId: number,
  employeeId: number,
  projectId: number,
  userId: number | null,
): Promise<number | null> {
  try {
    const db = await getDb();
    if (!db) return null;
    const [app] = await db.select().from(driverApplications).where(eq(driverApplications.id, applicationId)).limit(1);
    if (!app) return null;
    const lead = await findLeadForApplication(db, app);
    if (!lead || (lead.employeeId != null && lead.employeeId !== employeeId)) return null;
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    const upd = await db
      .update(extraLeads)
      .set({
        status: "converted",
        employeeId,
        convertedAt: sql`COALESCE(${extraLeads.convertedAt}, ${now})`,
        projectId: sql`COALESCE(${extraLeads.projectId}, ${projectId})`,
        sourceRef: sql`COALESCE(${extraLeads.sourceRef}, ${`application:${applicationId}`})`,
      } as any)
      .where(and(eq(extraLeads.id, lead.id), or(isNull(extraLeads.employeeId), eq(extraLeads.employeeId, employeeId))));
    if (extractAffectedRows(upd) === 0) return null;
    await logActivity({
      userId: userId ?? 0,
      action: "extra_lead_convert",
      entity: "extra_leads",
      entityId: lead.id,
      details: `Lead ${lead.fullName} convertido pela aprovação da candidatura #${applicationId} → employee ${employeeId}`,
    });
    return lead.id;
  } catch (err) {
    console.warn("[extraLeadsSync] aprovação → lead falhou:", String(err).slice(0, 200));
    return null;
  }
}

/**
 * Lead convertido → a candidatura pendente (new/reviewed) da mesma pessoa fica
 * aprovada e ligada à ficha. Só candidaturas sem ficha ou já com esta ficha.
 */
export async function approveApplicationForConvertedLead(
  lead: { id: number; sourceRef: string | null; email: string | null; phoneE164: string | null },
  employeeId: number,
  userId: number | null,
): Promise<number | null> {
  try {
    const db = await getDb();
    if (!db) return null;
    const refId = lead.sourceRef?.startsWith("application:") ? Number(lead.sourceRef.slice("application:".length)) : null;
    const conds = [];
    if (refId && Number.isInteger(refId)) conds.push(eq(driverApplications.id, refId));
    if (lead.email) conds.push(sql`LOWER(TRIM(${driverApplications.email})) = ${normalizeEmail(lead.email)}`);
    if (!conds.length) return null;
    const apps = await db
      .select({ id: driverApplications.id, status: driverApplications.status, employeeId: driverApplications.employeeId, fullName: driverApplications.fullName })
      .from(driverApplications)
      .where(or(...conds))
      .limit(5);
    const app = apps.find((a) => (a.status === "new" || a.status === "reviewed") && (a.employeeId == null || a.employeeId === employeeId));
    if (!app) return null;
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    const upd = await db
      .update(driverApplications)
      .set({ status: "approved", employeeId, reviewedById: userId, reviewedAt: now })
      .where(and(eq(driverApplications.id, app.id), inArray(driverApplications.status, ["new", "reviewed"])));
    if (extractAffectedRows(upd) === 0) return null;
    await logActivity({
      userId: userId ?? 0,
      action: "driver_application_approve",
      entity: "driver_applications",
      entityId: app.id,
      details: `Candidatura aprovada pela conversão do lead #${lead.id}: ${app.fullName} → employee ${employeeId}`,
    });
    return app.id;
  } catch (err) {
    console.warn("[extraLeadsSync] conversão → candidatura falhou:", String(err).slice(0, 200));
    return null;
  }
}

// ─── WhatsApp recebido de um lead ───────────────────────────────────────────

/**
 * Link público da candidatura (site "Be a Driver"). Sem DRIVER_APPLICATION_URL
 * não há resposta automática: não se manda um link adivinhado a candidatos.
 */
export function driverApplicationUrl(): string | null {
  const v = (process.env.DRIVER_APPLICATION_URL || "").trim();
  return v || null;
}

export function leadAutoReplyText(fullName: string, url: string): string {
  const first = fullName.trim().split(/\s+/)[0] || "";
  return `Olá${first ? ` ${first}` : ""}! Obrigado pela resposta 🙌 Para avançarmos, preenche a candidatura aqui: ${url} — depois entramos em contacto contigo.`;
}

export interface LeadInboundOutcome { leadIds: number[]; replied: number[]; autoReplied: number[] }

/**
 * Mensagem WhatsApp recebida de `phoneE164`: carimba `lastInboundAt` em todos
 * os leads com esse número; os `new`/`contacted` passam a `replied`, avisa-se
 * o backoffice e (se ligado) vai 1× a resposta automática com o link da
 * candidatura — a janela de 24h acabou de abrir, por isso é texto livre.
 * `stampOnly` (STOP/INICIAR, ou número em opt-out) e leads com `optedOutAt`:
 * só a hora da última mensagem — não passam a "Respondeu" nem recebem nada.
 * O aviso vai ao backoffice da cidade do lead (+ quem vê todas).
 * Best-effort: nunca lança (o webhook tem de responder 200 à Meta).
 */
export async function handleLeadInbound(input: { phoneE164: string; conversationId: number; at?: string; stampOnly?: boolean }): Promise<LeadInboundOutcome> {
  const out: LeadInboundOutcome = { leadIds: [], replied: [], autoReplied: [] };
  try {
    const db = await getDb();
    if (!db || !input.phoneE164) return out;
    const leads = await db.select().from(extraLeads).where(eq(extraLeads.phoneE164, input.phoneE164)).limit(5);
    if (!leads.length) return out;
    const at = input.at ?? new Date().toISOString().slice(0, 19).replace("T", " ");
    for (const lead of leads) {
      out.leadIds.push(lead.id);
      if (!input.stampOnly && !lead.optedOutAt && canAutoMarkReplied(lead.status)) {
        const upd = await db
          .update(extraLeads)
          .set({ status: "replied", lastInboundAt: at })
          .where(and(eq(extraLeads.id, lead.id), inArray(extraLeads.status, ["new", "contacted"])));
        if (extractAffectedRows(upd) === 0) continue;
        out.replied.push(lead.id);
        await logActivity({ userId: 0, action: "extra_lead_status", entity: "extra_leads", entityId: lead.id, details: `Lead ${lead.fullName}: ${lead.status} → replied (WhatsApp recebido)` });
        try {
          const { notify } = await import("./notify");
          await notify({
            kind: "lead_replied",
            projectId: lead.projectId ?? null,
            title: `Lead respondeu: ${lead.fullName}`,
            body: `Respondeu por WhatsApp (${lead.phone ?? input.phoneE164}). Vê a conversa no inbox.`,
            link: "/extras-leads",
            entity: { type: "extra_lead", id: lead.id },
          });
        } catch { /* segue */ }

        const applicationUrl = driverApplicationUrl();
        if (isFeatureEnabled("LEAD_AUTO_REPLY") && applicationUrl) {
          const claim = await db
            .update(extraLeads)
            .set({ autoRepliedAt: at })
            .where(and(eq(extraLeads.id, lead.id), isNull(extraLeads.autoRepliedAt)));
          if (extractAffectedRows(claim) === 1) {
            const { replyToConversation } = await import("./whatsappInbox");
            const r = await replyToConversation(input.conversationId, leadAutoReplyText(lead.fullName, applicationUrl), null);
            if (r.ok) out.autoReplied.push(lead.id);
            else console.warn("[extraLeadsSync] resposta automática ao lead", lead.id, "falhou:", (r as any).error);
          }
        }
      } else {
        await db.update(extraLeads).set({ lastInboundAt: at }).where(eq(extraLeads.id, lead.id));
      }
    }
  } catch (err) {
    console.warn("[extraLeadsSync] WhatsApp de lead:", String(err).slice(0, 200));
  }
  return out;
}
