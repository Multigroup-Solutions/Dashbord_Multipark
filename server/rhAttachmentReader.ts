/**
 * D39 (Jorge, 3 out 2026): os anexos dos emails do RH passam pela IA.
 *
 * Corre no varrimento de IA da comunicação (commsAiSweep, de 15 em 15 min),
 * fora da sincronização do email. Só com o interruptor AI_HR_EMAIL_ATTACHMENTS
 * (desligado por omissão). Para cada email do RH (`inbound_emails`,
 * targetModule 'rh') dos últimos 14 dias que já deu um candidato
 * (`extra_lead_sources` "email:<id>"), lê cada anexo UMA vez
 * (`rh_attachment_reads`) e:
 *  - preenche no candidato só os campos vazios (NIF, n.º do BI/CC, n.º da
 *    carta, cidade só quando é certa, telefone/email) — os outros contactos
 *    vão para as notas;
 *  - guarda o resumo do CV para quem entrevista.
 * Nunca escreve a ninguém. Nunca lança (cada anexo é best-effort).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, logActivity } from "./db";
import { extraLeadSources, extraLeads, rhAttachmentReads } from "../drizzle/schema";
import { normalizePhoneE164 } from "../shared/phone";
import { normalizeEmail } from "../shared/email";
import {
  RH_ATTACHMENT_MAX_AGE_DAYS,
  RH_ATTACHMENTS_PER_EMAIL,
  attachmentReadPlan,
  planLeadFromAttachment,
  type AttachmentExtract,
} from "../shared/rhAttachments";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

interface StoredAttachment { filename?: string | null; contentType?: string | null; size?: number | null; url?: string | null; key?: string | null }

/** Anexos de um email (JSON guardado na sincronização). PURA. */
export function parseAttachmentsJson(raw: string | null | undefined): StoredAttachment[] {
  try {
    const v = JSON.parse(String(raw ?? ""));
    return Array.isArray(v) ? v.filter((a) => a && typeof a === "object") : [];
  } catch {
    return [];
  }
}

async function recordRead(db: Db, row: { inboundEmailId: number; attachmentIndex: number; filename: string | null; leadId: number | null; status: "done" | "failed" | "skipped"; reason?: string | null; docKind?: string | null; extractedJson?: string | null; summary?: string | null }): Promise<boolean> {
  try {
    await db.insert(rhAttachmentReads).values({
      inboundEmailId: row.inboundEmailId,
      attachmentIndex: row.attachmentIndex,
      filename: row.filename?.slice(0, 255) ?? null,
      leadId: row.leadId,
      status: row.status,
      reason: row.reason?.slice(0, 255) ?? null,
      docKind: row.docKind ?? null,
      extractedJson: row.extractedJson ?? null,
      summary: row.summary ?? null,
    });
    return true;
  } catch (err: any) {
    // Corrida com outra corrida do varrimento: o anexo já ficou registado.
    const code = err?.code ?? err?.cause?.code;
    if (code === "ER_DUP_ENTRY") return false;
    throw err;
  }
}

/** Lê UM anexo com a IA. null = a IA falhou. */
async function extractAttachment(input: "pdf" | "image" | "docx", mimeType: string, bytes: Buffer, ctx: { leadId: number | null }): Promise<AttachmentExtract | null> {
  const { runAi } = await import("./_core/ai/run");
  const { HR_ATTACHMENT_SYSTEM, HR_ATTACHMENT_INSTRUCTION, hrAttachmentSchema } = await import("./_core/ai/prompts/hrAttachment");
  let content: any[];
  if (input === "docx") {
    const { docxToText } = await import("./knowledge/docx");
    const text = docxToText(bytes);
    if (!text?.trim()) return null;
    content = [{ type: "text", text: `${HR_ATTACHMENT_INSTRUCTION}\n\n---\n${text.slice(0, 20_000)}` }];
  } else {
    const data = bytes.toString("base64");
    content = [input === "pdf" ? { type: "pdf", data } : { type: "image", mimeType, data }, { type: "text", text: HR_ATTACHMENT_INSTRUCTION }];
  }
  try {
    const r = await runAi({
      feature: "hr_email_attachments",
      system: HR_ATTACHMENT_SYSTEM,
      input: content,
      schema: hrAttachmentSchema,
      maxTokens: 1200,
      timeoutMs: 30_000,
      entity: "extra_lead",
      entityId: ctx.leadId,
    });
    return r.output as AttachmentExtract;
  } catch (err: any) {
    console.warn("[rhAttachments] IA falhou:", String(err?.code ?? err?.name ?? "erro"));
    return null;
  }
}

/** Aplica o que a IA leu ao candidato (só campos vazios). Devolve o que mudou. */
async function applyToLead(db: Db, leadId: number, x: AttachmentExtract): Promise<string[]> {
  const [lead] = await db
    .select({ id: extraLeads.id, nif: extraLeads.nif, idDocNumber: extraLeads.idDocNumber, drivingLicenseNumber: extraLeads.drivingLicenseNumber, projectId: extraLeads.projectId, phone: extraLeads.phone, email: extraLeads.email, aiSummary: extraLeads.aiSummary, notes: extraLeads.notes })
    .from(extraLeads)
    .where(eq(extraLeads.id, leadId))
    .limit(1);
  if (!lead) return [];
  let cityProjectId: number | null = null;
  if (x.cityCertain === true && x.city) {
    const { getProjects } = await import("./db");
    const { cityProjectIdFromText } = await import("./extraLeadsSync");
    cityProjectId = cityProjectIdFromText(x.city, (await getProjects()) as any);
  }
  const plan = planLeadFromAttachment(lead, x, {
    cityProjectId,
    normalizePhone: (p) => normalizePhoneE164(p),
    normalizeEmail: (e) => normalizeEmail(e) || null,
  });
  const patch: Record<string, unknown> = { ...plan.patch, aiReadAt: sql`CURRENT_TIMESTAMP` };
  if (typeof plan.patch.phone === "string") patch.phoneE164 = plan.patch.phone;
  if (plan.otherContacts.length) {
    const { appendSourceNote } = await import("./extraLeadsSync");
    patch.notes = appendSourceNote(lead.notes ?? null, `Outros contactos (anexo): ${plan.otherContacts.join(", ")}`);
  }
  await db.update(extraLeads).set(patch as any).where(eq(extraLeads.id, leadId));
  return plan.filled;
}

/**
 * Varrimento: lê os anexos ainda por ler. Lote pequeno e prazo (cada leitura
 * pode levar até 30 s).
 */
export async function runRhAttachmentSweep(opts: { limit?: number; deadlineAt?: number } = {}): Promise<{ read: number; skipped: number; failed: number; off?: true }> {
  const out = { read: 0, skipped: 0, failed: 0 };
  const { aiFeatureAvailableFresh } = await import("./_core/ai/status");
  if (!(await aiFeatureAvailableFresh("hr_email_attachments"))) return { ...out, off: true };
  const db = await getDb();
  if (!db) return out;
  const deadlineAt = opts.deadlineAt ?? Date.now() + 40_000;
  const limit = Math.max(1, Math.min(5, opts.limit ?? 2));

  // Emails do RH recentes, com anexos e já com candidato (a origem "email:<id>"
  // em extra_lead_sources; cruzada em código — sem misturar collations no SQL).
  const [emailRows] = (await db.execute(sql`
    SELECT e.id, e.attachmentsJson
      FROM inbound_emails e
     WHERE e.targetModule = 'rh' AND e.attachmentsJson IS NOT NULL
       AND COALESCE(e.receivedAt, e.processedAt) >= NOW() - INTERVAL ${RH_ATTACHMENT_MAX_AGE_DAYS} DAY
     ORDER BY e.id DESC
     LIMIT 30`)) as any;
  const recent = ((emailRows as Array<{ id: number; attachmentsJson: string | null }>) ?? []).map((e) => ({ id: Number(e.id), attachmentsJson: e.attachmentsJson }));
  if (!recent.length) return out;
  const sources = await db
    .select({ sourceRef: extraLeadSources.sourceRef, leadId: extraLeadSources.leadId })
    .from(extraLeadSources)
    .where(inArray(extraLeadSources.sourceRef, recent.map((e) => `email:${e.id}`)));
  const leadByEmail = new Map(sources.filter((r) => r.leadId != null).map((r) => [Number(r.sourceRef.slice(6)), Number(r.leadId)]));
  const list = recent.filter((e) => leadByEmail.has(e.id)).map((e) => ({ ...e, leadId: leadByEmail.get(e.id)! }));
  if (!list.length) return out;
  const done = await db
    .select({ inboundEmailId: rhAttachmentReads.inboundEmailId, attachmentIndex: rhAttachmentReads.attachmentIndex })
    .from(rhAttachmentReads)
    .where(inArray(rhAttachmentReads.inboundEmailId, list.map((e) => Number(e.id))));
  const seen = new Set(done.map((d) => `${d.inboundEmailId}:${d.attachmentIndex}`));

  let processed = 0;
  for (const e of list) {
    const atts = parseAttachmentsJson(e.attachmentsJson);
    for (let i = 0; i < atts.length; i++) {
      if (seen.has(`${e.id}:${i}`)) continue;
      if (processed >= limit || Date.now() + 32_000 > deadlineAt) return out;
      const a = atts[i];
      const base = { inboundEmailId: Number(e.id), attachmentIndex: i, filename: a.filename ?? null, leadId: Number(e.leadId) };
      if (i >= RH_ATTACHMENTS_PER_EMAIL) {
        if (await recordRead(db, { ...base, status: "skipped", reason: "demasiados anexos neste email" })) out.skipped++;
        continue;
      }
      const plan = attachmentReadPlan(a);
      if (!plan.ok) {
        if (await recordRead(db, { ...base, status: "skipped", reason: plan.reason })) out.skipped++;
        continue;
      }
      processed++;
      try {
        const { fetchStoredBytes } = await import("./google/driveService");
        const bytes = await fetchStoredBytes(a.key || a.url!, a.url ?? null);
        const x = await extractAttachment(plan.input, plan.mimeType, bytes, { leadId: base.leadId });
        if (!x) {
          if (await recordRead(db, { ...base, status: "failed", reason: "a IA não conseguiu ler" })) out.failed++;
          continue;
        }
        // Regista ANTES de mexer no candidato: um anexo nunca é aplicado duas vezes.
        const mine = await recordRead(db, {
          ...base, status: "done", docKind: x.docKind ?? null,
          extractedJson: JSON.stringify({ fullName: x.fullName ?? null, nif: x.nif ?? null, idDocNumber: x.idDocNumber ?? null, drivingLicenseNumber: x.drivingLicenseNumber ?? null, city: x.city ?? null, cityCertain: x.cityCertain ?? null, phones: x.phones ?? [], emails: x.emails ?? [] }),
          summary: x.summary ?? null,
        });
        if (!mine) continue;
        const filled = await applyToLead(db, base.leadId, x);
        out.read++;
        await logActivity({ userId: 0, action: "update", entity: "extra_leads", entityId: base.leadId, details: `IA leu o anexo «${String(a.filename ?? "anexo").slice(0, 80)}» do email do RH${filled.length ? ` — preencheu: ${filled.join(", ")}` : ""}` });
      } catch (err: any) {
        if (await recordRead(db, { ...base, status: "failed", reason: String(err?.message ?? err).slice(0, 200) }).catch(() => false)) out.failed++;
      }
    }
  }
  return out;
}

/** Leituras de um candidato (para a ficha do candidato). */
export async function attachmentReadsForLead(leadId: number): Promise<Array<{ filename: string | null; status: string; reason: string | null; docKind: string | null; summary: string | null; createdAt: string }>> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({ filename: rhAttachmentReads.filename, status: rhAttachmentReads.status, reason: rhAttachmentReads.reason, docKind: rhAttachmentReads.docKind, summary: rhAttachmentReads.summary, createdAt: rhAttachmentReads.createdAt })
    .from(rhAttachmentReads)
    .where(and(eq(rhAttachmentReads.leadId, leadId)))
    .orderBy(rhAttachmentReads.id);
}
