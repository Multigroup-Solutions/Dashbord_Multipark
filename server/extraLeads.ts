/**
 * Leads de extras — contactos que AINDA não são extras mas estão a ser recrutados.
 *
 * Um lead tem nome e telemóvel e/ou email (pelo menos um dos dois). Vive fora de
 * `employees`: a ficha só nasce quando a pessoa aceita — até lá é um lead com um
 * estado (`new` → `contacted` → `converted` | `declined`).
 *
 * O contacto é feito por WhatsApp com o template `seja_motorista` (sem
 * parâmetros) através de `sendTemplateToContacts`, o MESMO caminho de envio dos
 * extras: inspeção do template na Meta, conversa no inbox (sem employeeId, mas
 * com o nome do lead — ver `whatsappInbox.listConversations`), linha em
 * `whatsapp_messages` e broadcast auditável. Cada envio bem sucedido carimba
 * `lastContactedAt`, incrementa `contactCount` e passa `new` → `contacted`.
 *
 * A parte pura (`normalizeLeadInput`) é testada sem BD.
 */
import { and, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { getDb, logActivity } from "./db";
import { extraLeads } from "../drizzle/schema";
import { normalizeEmail, isPlausibleEmail } from "../shared/email";
import { normalizePhoneE164, normalizePhoneForStorage } from "../shared/phone";
import { findWhatsAppTemplate, templateHasBodyParams } from "../shared/whatsappTemplate";
import { sendTemplateToContacts, type BroadcastRecipient } from "./whatsappBroadcast";
import { findActiveEmployeeByPhoneE164 } from "./extrasAvailability";

export const EXTRA_LEAD_STATUSES = ["new", "contacted", "converted", "declined"] as const;
export type ExtraLeadStatus = (typeof EXTRA_LEAD_STATUSES)[number];

export interface LeadInput {
  fullName: string;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
}

export interface NormalizedLead {
  fullName: string;
  phone: string | null;
  phoneE164: string | null;
  email: string | null;
  notes: string | null;
}

/**
 * Valida e normaliza um lead. PURA.
 *  - nome com pelo menos 2 caracteres;
 *  - telemóvel OU email obrigatório (um dos dois pode faltar, não os dois);
 *  - um telemóvel escrito tem de normalizar para E.164 (senão nunca receberia
 *    WhatsApp e o lead ficaria "contactável" só na aparência);
 *  - um email escrito tem de ser plausível.
 */
export function normalizeLeadInput(input: LeadInput): { ok: true; lead: NormalizedLead } | { ok: false; error: string } {
  const fullName = (input.fullName ?? "").trim().replace(/\s+/g, " ").slice(0, 256);
  if (fullName.length < 2) return { ok: false, error: "Indica o nome do contacto." };

  const rawPhone = (input.phone ?? "").trim();
  const rawEmail = (input.email ?? "").trim();
  if (!rawPhone && !rawEmail) return { ok: false, error: "Indica o telemóvel ou o email (pelo menos um)." };

  let phone: string | null = null;
  let phoneE164: string | null = null;
  if (rawPhone) {
    phoneE164 = normalizePhoneE164(rawPhone);
    if (!phoneE164) return { ok: false, error: `Número de telemóvel inválido: “${rawPhone}”.` };
    phone = normalizePhoneForStorage(rawPhone) ?? rawPhone.slice(0, 32);
  }

  let email: string | null = null;
  if (rawEmail) {
    email = normalizeEmail(rawEmail);
    if (!isPlausibleEmail(email)) return { ok: false, error: `Email inválido: “${rawEmail}”.` };
  }

  const notes = (input.notes ?? "").trim().slice(0, 512) || null;
  return { ok: true, lead: { fullName, phone, phoneE164, email, notes } };
}

export interface ExtraLeadRow {
  id: number;
  fullName: string;
  phone: string | null;
  phoneE164: string | null;
  email: string | null;
  status: ExtraLeadStatus;
  notes: string | null;
  source: string;
  contactCount: number;
  lastContactedAt: string | null;
  employeeId: number | null;
  createdById: number | null;
  createdAt: string;
  updatedAt: string;
}

export async function listExtraLeads(filter: { status?: ExtraLeadStatus | null; search?: string | null } = {}): Promise<ExtraLeadRow[]> {
  const db = await getDb();
  if (!db) return [];
  const conds = [];
  if (filter.status) conds.push(eq(extraLeads.status, filter.status));
  const q = filter.search?.trim();
  if (q) {
    const pattern = `%${q}%`;
    const digits = q.replace(/\D/g, "");
    conds.push(
      or(
        like(extraLeads.fullName, pattern),
        like(extraLeads.email, pattern),
        like(extraLeads.phone, pattern),
        ...(digits ? [like(extraLeads.phoneE164, `%${digits}%`)] : []),
      )!,
    );
  }
  const rows = await db
    .select()
    .from(extraLeads)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(extraLeads.createdAt))
    .limit(500);
  return rows as ExtraLeadRow[];
}

/** Outro lead (que não `excludeId`) já usa este número ou email? */
async function findDuplicate(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  lead: Pick<NormalizedLead, "phoneE164" | "email">,
  excludeId?: number,
): Promise<{ id: number; fullName: string; field: "telemóvel" | "email" } | null> {
  const conds = [];
  if (lead.phoneE164) conds.push(eq(extraLeads.phoneE164, lead.phoneE164));
  if (lead.email) conds.push(eq(extraLeads.email, lead.email));
  if (!conds.length) return null;
  const rows = await db
    .select({ id: extraLeads.id, fullName: extraLeads.fullName, phoneE164: extraLeads.phoneE164, email: extraLeads.email })
    .from(extraLeads)
    .where(or(...conds))
    .limit(5);
  const hit = rows.find((r) => r.id !== excludeId);
  if (!hit) return null;
  return { id: hit.id, fullName: hit.fullName, field: lead.phoneE164 && hit.phoneE164 === lead.phoneE164 ? "telemóvel" : "email" };
}

export async function createExtraLead(input: LeadInput, createdById: number | null): Promise<ExtraLeadRow> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const parsed = normalizeLeadInput(input);
  if (!parsed.ok) throw new Error(parsed.error);
  const { lead } = parsed;

  const dup = await findDuplicate(db, lead);
  if (dup) throw new Error(`Já existe um lead com este ${dup.field}: ${dup.fullName} (#${dup.id}).`);
  if (lead.phoneE164) {
    // Um número que já pertence a um colaborador ativo não é um lead — é gente
    // da casa. Evita "recrutar" quem já trabalha connosco.
    const emp = await findActiveEmployeeByPhoneE164(lead.phoneE164);
    if (emp) throw new Error(`Este número já pertence ao colaborador ${emp.fullName} — não é um lead.`);
  }

  const result = await db.insert(extraLeads).values({ ...lead, createdById, source: "manual" });
  const id = Number((result as any)[0]?.insertId ?? (result as any).insertId);
  await logActivity({
    userId: createdById ?? 0,
    action: "extra_lead_create",
    entity: "extra_leads",
    entityId: id,
    details: `Lead de extra criado: ${lead.fullName}${lead.phone ? ` · ${lead.phone}` : ""}${lead.email ? ` · ${lead.email}` : ""}`,
  });
  const [row] = await db.select().from(extraLeads).where(eq(extraLeads.id, id)).limit(1);
  return row as ExtraLeadRow;
}

export async function updateExtraLead(
  id: number,
  patch: Partial<LeadInput> & { status?: ExtraLeadStatus | null },
  userId: number | null,
): Promise<ExtraLeadRow> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const [current] = await db.select().from(extraLeads).where(eq(extraLeads.id, id)).limit(1);
  if (!current) throw new Error("Lead não encontrado");

  const parsed = normalizeLeadInput({
    fullName: patch.fullName ?? current.fullName,
    phone: patch.phone !== undefined ? patch.phone : current.phone,
    email: patch.email !== undefined ? patch.email : current.email,
    notes: patch.notes !== undefined ? patch.notes : current.notes,
  });
  if (!parsed.ok) throw new Error(parsed.error);
  const { lead } = parsed;
  const dup = await findDuplicate(db, lead, id);
  if (dup) throw new Error(`Já existe um lead com este ${dup.field}: ${dup.fullName} (#${dup.id}).`);

  const set: Record<string, unknown> = { ...lead };
  if (patch.status) set.status = patch.status;
  await db.update(extraLeads).set(set).where(eq(extraLeads.id, id));

  if (patch.status && patch.status !== current.status) {
    await logActivity({
      userId: userId ?? 0,
      action: "extra_lead_status",
      entity: "extra_leads",
      entityId: id,
      details: `Lead ${current.fullName}: ${current.status} → ${patch.status}`,
    });
  }
  const [row] = await db.select().from(extraLeads).where(eq(extraLeads.id, id)).limit(1);
  return row as ExtraLeadRow;
}

export async function deleteExtraLead(id: number, userId: number | null): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const [current] = await db.select({ fullName: extraLeads.fullName }).from(extraLeads).where(eq(extraLeads.id, id)).limit(1);
  if (!current) throw new Error("Lead não encontrado");
  await db.delete(extraLeads).where(eq(extraLeads.id, id));
  await logActivity({ userId: userId ?? 0, action: "extra_lead_delete", entity: "extra_leads", entityId: id, details: `Lead apagado: ${current.fullName}` });
}

export interface LeadContactResult {
  leadId: number;
  fullName: string;
  status: BroadcastRecipient["status"] | "no_phone";
  error?: string;
}

export interface ContactLeadsSummary {
  broadcastId: number | null;
  total: number;
  sent: number;
  failed: number;
  noPhone: number;
  results: LeadContactResult[];
}

/**
 * Envia um template do catálogo aos leads indicados. Só templates SEM
 * parâmetros (o lead não tem ficha → não há campo de diálogo nem token de
 * formulário). Leads sem telemóvel ficam registados como `no_phone`, sem chamada.
 */
export async function contactExtraLeads(opts: { leadIds: number[]; templateId: string; createdById: number | null }): Promise<ContactLeadsSummary> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const def = findWhatsAppTemplate(opts.templateId);
  if (!def) throw new Error(`Template desconhecido: ${opts.templateId}`);
  if (templateHasBodyParams(def)) {
    throw new Error(`O template “${def.label}” precisa de parâmetros — aos leads só se enviam templates sem campos.`);
  }
  const ids = [...new Set(opts.leadIds)].filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) throw new Error("Nenhum lead selecionado.");

  const leads = (await db.select().from(extraLeads).where(inArray(extraLeads.id, ids))) as ExtraLeadRow[];
  const results: LeadContactResult[] = [];
  const contactable = leads.filter((l) => {
    if (l.phoneE164) return true;
    results.push({ leadId: l.id, fullName: l.fullName, status: "no_phone", error: "Sem telemóvel" });
    return false;
  });

  let broadcastId: number | null = null;
  if (contactable.length) {
    const summary = await sendTemplateToContacts({
      templateName: def.name,
      languageCode: def.language,
      contacts: contactable.map((l) => ({ name: l.fullName, phone: l.phoneE164! })),
      note: `leads de extras (${contactable.length})`,
      createdById: opts.createdById,
    });
    broadcastId = summary.broadcastId;
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    for (let i = 0; i < contactable.length; i++) {
      const lead = contactable[i];
      const r = summary.recipients[i];
      results.push({ leadId: lead.id, fullName: lead.fullName, status: r.status, error: r.error });
      if (r.status === "sent") {
        await db
          .update(extraLeads)
          .set({
            lastContactedAt: now,
            contactCount: sql`${extraLeads.contactCount} + 1`,
            // Só o 1º contacto muda o estado; um lead já convertido/recusado
            // que volte a receber o template mantém o que o backoffice decidiu.
            ...(lead.status === "new" ? { status: "contacted" as const } : {}),
          })
          .where(eq(extraLeads.id, lead.id));
      }
    }
  }

  const sent = results.filter((r) => r.status === "sent").length;
  const noPhone = results.filter((r) => r.status === "no_phone").length;
  const failed = results.length - sent - noPhone;
  await logActivity({
    userId: opts.createdById ?? 0,
    action: "extra_lead_contact",
    entity: "extra_leads",
    details: `WhatsApp “${def.name}” a ${results.length} lead(s): ${sent} enviados, ${failed} falhas, ${noPhone} sem telemóvel`,
  });
  return { broadcastId, total: results.length, sent, failed, noPhone, results };
}
