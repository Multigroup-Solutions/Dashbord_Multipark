/**
 * Leads de extras — contactos que AINDA não são extras mas estão a ser recrutados.
 *
 * Um lead tem nome e telemóvel e/ou email (pelo menos um dos dois). Vive fora de
 * `employees`: a ficha só nasce quando a pessoa aceita — até lá é um lead com um
 * estado (`new` → `contacted` → `replied` → `converted` | `declined`).
 *
 * Origens (`source`): `manual` (criado aqui), `site` (candidatura Be a Driver)
 * e `email` (recursos-humanos@) — as duas últimas importadas automaticamente
 * por server/extraLeadsSync.ts (um só funil de recrutamento).
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
import { currentDefaultCityId, projectVisible, scopedProjectIds } from "./extrasCityFilter";
import { assertProjectAccess } from "./cityScope";
import { and, desc, eq, gte, inArray, isNull, like, or, sql } from "drizzle-orm";
import { getDb, getProjects, logActivity } from "./db";
import { extraLeads } from "../drizzle/schema";
import { normalizeEmail, isPlausibleEmail } from "../shared/email";
import { normalizePhoneE164, normalizePhoneForStorage } from "../shared/phone";
import { findWhatsAppTemplate, templateHasBodyParams } from "../shared/whatsappTemplate";
import { sendTemplateToContacts, type BroadcastRecipient } from "./whatsappBroadcast";
import { driverCityFrom, driverCityLabel, hasDriverTemplate, isDriverCity, type City } from "../shared/driverTemplates";
import { resolveCitiesForProjectIds } from "./employeeCity";
import type { CityKey } from "../shared/city";
import { findActiveEmployeeByPhoneE164 } from "./extrasAvailability";
import { aggregateFunnel, EXTRA_LEADS_LIST_LIMIT, LEAD_STATUSES, manualStatusError, type FunnelLeadRow, type FunnelResult } from "../shared/extraLeadsFunnel";

export const EXTRA_LEAD_STATUSES = LEAD_STATUSES;
export type ExtraLeadStatus = (typeof EXTRA_LEAD_STATUSES)[number];
// Regra de transições manuais — vive em shared/ (a página usa a mesma).
export { manualStatusError };

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
  sourceRef: string | null;
  contactCount: number;
  lastContactedAt: string | null;
  firstContactedAt: string | null;
  lastInboundAt: string | null;
  convertedAt: string | null;
  autoRepliedAt: string | null;
  /** Pediu STOP por WhatsApp (migração 0094). */
  optedOutAt: string | null;
  employeeId: number | null;
  projectId: number | null;
  /** 0380 — arquivado (sai da lista, do funil, dos envios e dos lembretes). */
  archivedAt?: string | null;
  archivedById?: number | null;
  /** 0460 (D39): lido pela IA nos anexos do email do RH. NIF e números só o RH vê (a lista tira-os aos outros). */
  nif?: string | null;
  idDocNumber?: string | null;
  drivingLicenseNumber?: string | null;
  aiSummary?: string | null;
  aiReadAt?: string | null;
  /** D46: foto da ficha (só depois de convertido em extra). */
  photoUrl?: string | null;
  createdById: number | null;
  createdAt: string;
  updatedAt: string;
}

/** BD em falta → erro (antes: lista vazia, que parecia "ainda não há leads"). */
async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  return db;
}

/** Filtro de cidade dos leads: os da(s) cidade(s) do utilizador + os sem cidade. */
function leadScopeCondition() {
  const scope = scopedProjectIds();
  if (scope === undefined) return undefined;
  return scope.length ? or(isNull(extraLeads.projectId), inArray(extraLeads.projectId, scope))! : isNull(extraLeads.projectId);
}

export async function listExtraLeads(
  filter: { status?: ExtraLeadStatus | null; search?: string | null; source?: string | null; archived?: boolean | null } = {},
): Promise<ExtraLeadRow[]> {
  const db = await requireDb();
  // Arquivados (0380) só com o filtro "Arquivados".
  const conds = [filter.archived ? sql`${extraLeads.archivedAt} IS NOT NULL` : isNull(extraLeads.archivedAt)];
  if (filter.status) conds.push(eq(extraLeads.status, filter.status));
  if (filter.source) conds.push(eq(extraLeads.source, filter.source));
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
  // Cidade (ponto 10): quem só vê uma cidade não vê os leads das outras;
  // leads sem cidade (antigos) continuam visíveis a todos. No WHERE, antes do
  // LIMIT (filtrar depois cortava leads da própria cidade com >500 linhas).
  const scoped = leadScopeCondition();
  if (scoped) conds.push(scoped);
  const rows = await db
    .select()
    .from(extraLeads)
    .where(and(...conds))
    .orderBy(desc(extraLeads.createdAt))
    .limit(EXTRA_LEADS_LIST_LIMIT);
  // D46: cartões com foto — a da ficha, para quem já é extra (os outros ficam com as iniciais).
  const empIds = Array.from(new Set(rows.map((r) => r.employeeId).filter((x): x is number => x != null)));
  const photos = new Map<number, string | null>();
  if (empIds.length) {
    try {
      const { employees } = await import("../drizzle/schema");
      for (const e of await db.select({ id: employees.id, photoUrl: employees.photoUrl }).from(employees).where(inArray(employees.id, empIds))) photos.set(e.id, e.photoUrl ?? null);
    } catch { /* sem fotos: iniciais */ }
  }
  return rows.map((r) => ({ ...r, photoUrl: r.employeeId != null ? photos.get(r.employeeId) ?? null : null })) as ExtraLeadRow[];
}


/** Lead fora das cidades de quem pede → "não encontrado" (não revela que existe). */
export function assertLeadVisible(lead: { projectId: number | null } | undefined | null): void {
  if (!lead || !projectVisible(lead.projectId, scopedProjectIds())) throw new Error("Lead não encontrado");
}

/**
 * Cidade escolhida para um lead: tem de ser um nó `level='city'` e estar nas
 * cidades de quem edita (a MESMA guarda do Converter: `assertProjectAccess`).
 * `null` (sem cidade) só para quem vê todas as cidades.
 */
export async function assertLeadCity(projectId: number | null): Promise<void> {
  assertProjectAccess(projectId);
  if (projectId == null) return;
  const node = ((await getProjects()) as { id: number; level: string | null }[]).find((p) => p.id === projectId);
  if (!node || node.level !== "city") throw new Error("Escolhe uma cidade (centro de custos de nível cidade).");
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
    .select({ id: extraLeads.id, fullName: extraLeads.fullName, phoneE164: extraLeads.phoneE164, email: extraLeads.email, archivedAt: extraLeads.archivedAt })
    .from(extraLeads)
    .where(or(...conds))
    .limit(5);
  const hit = rows.find((r) => r.id !== excludeId);
  if (!hit) return null;
  const [full] = await db.select({ projectId: extraLeads.projectId }).from(extraLeads).where(eq(extraLeads.id, hit.id)).limit(1);
  if (full && !projectVisible(full.projectId, scopedProjectIds())) {
    // Existe noutra cidade: avisa sem mostrar quem é
    return { id: 0, fullName: "noutra cidade", field: lead.phoneE164 && hit.phoneE164 === lead.phoneE164 ? "telemóvel" : "email" };
  }
  // Arquivado (0380): diz-se onde está, para o repor em vez de criar outro.
  return { id: hit.id, fullName: hit.archivedAt ? `${hit.fullName} — está nos Arquivados, repõe-o` : hit.fullName, field: lead.phoneE164 && hit.phoneE164 === lead.phoneE164 ? "telemóvel" : "email" };
}

export async function createExtraLead(input: LeadInput, createdById: number | null): Promise<ExtraLeadRow> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const parsed = normalizeLeadInput(input);
  if (!parsed.ok) throw new Error(parsed.error);
  const { lead } = parsed;

  const dup = await findDuplicate(db, lead);
  if (dup) throw new Error(dup.id ? `Já existe um lead com este ${dup.field}: ${dup.fullName} (#${dup.id}).` : `Já existe um lead com este ${dup.field} ${dup.fullName}.`);
  if (lead.phoneE164) {
    // Um número que já pertence a um colaborador ativo não é um lead — é gente
    // da casa. Evita "recrutar" quem já trabalha connosco.
    const emp = await findActiveEmployeeByPhoneE164(lead.phoneE164);
    if (emp) throw new Error(`Este número já pertence ao colaborador ${emp.fullName} — não é um lead.`);
  }

  // O lead fica na cidade de quem o cria (null se vê todas as cidades).
  const result = await db.insert(extraLeads).values({ ...lead, createdById, source: "manual", projectId: currentDefaultCityId() });
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
  patch: Partial<LeadInput> & { status?: ExtraLeadStatus | null; projectId?: number | null },
  userId: number | null,
): Promise<ExtraLeadRow> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const [current] = await db.select().from(extraLeads).where(eq(extraLeads.id, id)).limit(1);
  assertLeadVisible(current);
  if (current.archivedAt) throw new Error("Lead arquivado: repõe-o primeiro (filtro «Arquivados»).");
  if (patch.status) {
    const err = manualStatusError(current, patch.status);
    if (err) throw new Error(err);
  }
  const cityChanged = patch.projectId !== undefined && patch.projectId !== current.projectId;
  if (cityChanged) await assertLeadCity(patch.projectId ?? null);

  const parsed = normalizeLeadInput({
    fullName: patch.fullName ?? current.fullName,
    phone: patch.phone !== undefined ? patch.phone : current.phone,
    email: patch.email !== undefined ? patch.email : current.email,
    notes: patch.notes !== undefined ? patch.notes : current.notes,
  });
  if (!parsed.ok) throw new Error(parsed.error);
  const { lead } = parsed;
  const dup = await findDuplicate(db, lead, id);
  if (dup) throw new Error(dup.id ? `Já existe um lead com este ${dup.field}: ${dup.fullName} (#${dup.id}).` : `Já existe um lead com este ${dup.field} ${dup.fullName}.`);

  const set: Record<string, unknown> = { ...lead };
  if (patch.status) set.status = patch.status;
  if (cityChanged) set.projectId = patch.projectId ?? null;
  await db.update(extraLeads).set(set).where(eq(extraLeads.id, id));
  if (cityChanged) {
    await logActivity({
      userId: userId ?? 0,
      action: "extra_lead_city",
      entity: "extra_leads",
      entityId: id,
      details: `Lead ${current.fullName}: cidade ${current.projectId ?? "—"} → ${patch.projectId ?? "—"}`,
    });
  }

  if (patch.status && patch.status !== current.status) {
    await logActivity({
      userId: userId ?? 0,
      action: "extra_lead_status",
      entity: "extra_leads",
      entityId: id,
      details: `Lead ${current.fullName}: ${current.status} → ${patch.status}`,
    });
    // "Sem interesse" rejeita também a candidatura do site (Jorge, 2 out 2026).
    if (patch.status === "declined") {
      const { rejectApplicationForLead } = await import("./extraLeadsSync");
      await rejectApplicationForLead({ ...current, email: lead.email ?? current.email }, userId);
    }
  }
  const [row] = await db.select().from(extraLeads).where(eq(extraLeads.id, id)).limit(1);
  return row as ExtraLeadRow;
}

/**
 * "Apagar" = ARQUIVAR (0380, P3 18b): sai da lista, do funil, dos envios e dos
 * lembretes, mas a linha fica (e a origem continua marcada como vista — não
 * volta a ser importada). Pode ser reposto. Antes era um DELETE sem volta.
 */
export async function archiveExtraLead(id: number, userId: number | null): Promise<void> {
  const db = await requireDb();
  const [current] = await db.select({ fullName: extraLeads.fullName, projectId: extraLeads.projectId, status: extraLeads.status, archivedAt: extraLeads.archivedAt }).from(extraLeads).where(eq(extraLeads.id, id)).limit(1);
  assertLeadVisible(current);
  if (current.archivedAt) return;
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  await db.update(extraLeads).set({ archivedAt: now, archivedById: userId }).where(and(eq(extraLeads.id, id), isNull(extraLeads.archivedAt)));
  await logActivity({ userId: userId ?? 0, action: "extra_lead_archive", entity: "extra_leads", entityId: id, details: `Lead arquivado: ${current.fullName} (estava «${current.status}»)` });
}

/** Repor um lead arquivado (volta à lista com o estado que tinha). */
export async function restoreExtraLead(id: number, userId: number | null): Promise<void> {
  const db = await requireDb();
  const [current] = await db.select({ fullName: extraLeads.fullName, projectId: extraLeads.projectId, archivedAt: extraLeads.archivedAt }).from(extraLeads).where(eq(extraLeads.id, id)).limit(1);
  assertLeadVisible(current);
  if (!current.archivedAt) return;
  await db.update(extraLeads).set({ archivedAt: null, archivedById: null }).where(eq(extraLeads.id, id));
  await logActivity({ userId: userId ?? 0, action: "extra_lead_restore", entity: "extra_leads", entityId: id, details: `Lead reposto: ${current.fullName}` });
}

export interface LeadContactResult {
  leadId: number;
  fullName: string;
  status: BroadcastRecipient["status"] | "no_phone" | "skipped" | "no_city";
  error?: string;
  /** Cidade do template usado. */
  city?: City;
}

export interface ContactLeadsSummary {
  broadcastId: number | null;
  total: number;
  sent: number;
  failed: number;
  noPhone: number;
  /** Leads sem cidade: não receberam nada (nunca se assume Lisboa). */
  noCity: number;
  results: LeadContactResult[];
}

/**
 * Envia um template do catálogo aos leads indicados, com o template da CIDADE de
 * cada lead (registo shared/driverTemplates.ts). Só templates SEM parâmetros (o
 * lead não tem ficha → não há campo de diálogo nem token de formulário). Leads
 * sem telemóvel ficam `no_phone`, sem chamada.
 *
 * Cidade: `cityByLead` (escolhida no diálogo) manda; sem mapa (lembrete
 * automático) usa-se a cidade do próprio lead (`projectId`). Lead sem cidade →
 * `no_city`, sem envio: nunca se assume Lisboa.
 */
export async function contactExtraLeads(opts: {
  leadIds: number[];
  templateId: string;
  createdById: number | null;
  /** Cidade por lead, decidida no diálogo. Ausente = cidade do próprio lead. */
  cityByLead?: Record<number, City> | null;
  /** Nota do broadcast/atividade (ex.: "lembrete automático"). */
  note?: string;
  /** Código único do envio (do ecrã, 17b): carregar outra vez retoma, não duplica. */
  sendKey?: string | null;
}): Promise<ContactLeadsSummary> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const def = findWhatsAppTemplate(opts.templateId);
  if (!def) throw new Error(`Template desconhecido: ${opts.templateId}`);
  if (templateHasBodyParams(def)) {
    throw new Error(`O template “${def.label}” precisa de parâmetros. Aos leads só se enviam templates sem campos.`);
  }
  const ids = [...new Set(opts.leadIds)].filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) throw new Error("Nenhum lead selecionado.");

  const scope = scopedProjectIds();
  const leads = ((await db.select().from(extraLeads).where(inArray(extraLeads.id, ids))) as ExtraLeadRow[])
    .filter((l) => projectVisible(l.projectId, scope));
  const results: LeadContactResult[] = [];
  const contactable = leads.filter((l) => {
    // Arquivados (0380) não recebem nada.
    if (l.archivedAt) {
      results.push({ leadId: l.id, fullName: l.fullName, status: "skipped", error: "Arquivado" });
      return false;
    }
    // Convertidos (já trabalham cá) e sem interesse não recebem o convite
    if (l.status === "converted" || l.status === "declined") {
      results.push({ leadId: l.id, fullName: l.fullName, status: "skipped", error: l.status === "converted" ? "Já é extra" : "Sem interesse" });
      return false;
    }
    // Pediu STOP por WhatsApp → nunca mais recebe templates (nem o lembrete automático).
    if (l.optedOutAt) {
      results.push({ leadId: l.id, fullName: l.fullName, status: "opted_out", error: "Não quer mensagens (STOP)" });
      return false;
    }
    if (l.phoneE164) return true;
    results.push({ leadId: l.id, fullName: l.fullName, status: "no_phone", error: "Sem telemóvel" });
    return false;
  });

  // Cidade de cada lead: a do diálogo, senão a do próprio lead.
  const ownCity = opts.cityByLead ? new Map<number, CityKey | null>() : await resolveCitiesForProjectIds(contactable.map((l) => l.projectId));
  const groups = new Map<City, ExtraLeadRow[]>();
  for (const l of contactable) {
    const city = opts.cityByLead
      ? opts.cityByLead[l.id] ?? null
      : driverCityFrom(l.projectId != null ? ownCity.get(l.projectId) ?? null : null);
    if (!city || !isDriverCity(city)) {
      results.push({ leadId: l.id, fullName: l.fullName, status: "no_city", error: "Sem cidade: atribui uma cidade ao lead" });
      continue;
    }
    if (!hasDriverTemplate(city, def.message)) {
      results.push({ leadId: l.id, fullName: l.fullName, status: "no_city", error: `${driverCityLabel(city)} ainda não tem template de "${def.label}"` });
      continue;
    }
    groups.set(city, [...(groups.get(city) ?? []), l]);
  }

  let broadcastId: number | null = null;
  if (groups.size) {
    const sentByCity = await sendTemplateToContacts({
      templateId: def.id,
      groups: Array.from(groups.entries()).map(([city, list]) => ({
        city,
        contacts: list.map((l) => ({ name: l.fullName, phone: l.phoneE164! })),
      })),
      note: `${opts.note ?? "leads de extras"} (${contactable.length})`,
      createdById: opts.createdById,
      sendKey: opts.sendKey ?? null,
    });
    broadcastId = sentByCity[0]?.summary.broadcastId ?? null;
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    for (const { city, summary } of sentByCity) {
      const list = groups.get(city)!;
      for (let i = 0; i < list.length; i++) {
        const lead = list[i];
        const r = summary.recipients[i];
        results.push({ leadId: lead.id, fullName: lead.fullName, status: r.status, error: r.error, city });
        if (r.status === "sent") {
          await db
            .update(extraLeads)
            .set({
              lastContactedAt: now,
              firstContactedAt: sql`COALESCE(${extraLeads.firstContactedAt}, ${now})`,
              // Retoma de um envio cortado (17b): já contado da 1.ª vez.
              ...(r.resumed ? {} : { contactCount: sql`${extraLeads.contactCount} + 1` }),
              // Só o 1º contacto muda o estado; um lead já convertido/recusado
              // que volte a receber o template mantém o que o backoffice decidiu.
              ...(lead.status === "new" ? { status: "contacted" as const } : {}),
            })
            .where(eq(extraLeads.id, lead.id));
        }
      }
    }
  }

  const sent = results.filter((r) => r.status === "sent").length;
  const noPhone = results.filter((r) => r.status === "no_phone").length;
  const noCity = results.filter((r) => r.status === "no_city").length;
  const skipped = results.filter((r) => r.status === "skipped" || r.status === "opted_out" || r.status === "duplicate_phone" || r.status === "recent_template").length;
  const failed = results.length - sent - noPhone - noCity - skipped;
  const perCity = Array.from(groups.entries()).map(([city, list]) => `${driverCityLabel(city)} ${list.length}`).join(", ");
  await logActivity({
    userId: opts.createdById ?? 0,
    action: "extra_lead_contact",
    entity: "extra_leads",
    details:
      `${opts.note ? `[${opts.note}] ` : ""}WhatsApp “${def.label}”${perCity ? ` (${perCity})` : ""} a ${results.length} lead(s): ` +
      `${sent} enviados, ${failed} falhas, ${noPhone} sem telemóvel${noCity ? `, ${noCity} sem cidade` : ""}`,
  });
  return { broadcastId, total: results.length, sent, failed, noPhone, noCity, results };
}

// ─── Ações em lote ──────────────────────────────────────────────────────────

export interface BulkUpdateResult {
  updated: number;
  skipped: { leadId: number; fullName: string | null; error: string }[];
}

/**
 * Muda o estado (nunca para Convertido) e/ou a cidade de vários leads. Cada
 * lead passa pela MESMA verificação da edição individual: fora das cidades de
 * quem pede → "não encontrado"; transição inválida → fica de fora com o motivo.
 */
export async function bulkUpdateExtraLeads(
  opts: { leadIds: number[]; status?: ExtraLeadStatus | null; projectId?: number | null },
  userId: number | null,
): Promise<BulkUpdateResult> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const ids = [...new Set(opts.leadIds)].filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) throw new Error("Nenhum lead selecionado.");
  if (!opts.status && opts.projectId === undefined) throw new Error("Nada para alterar.");
  if (opts.status === "converted") throw new Error("Para marcar como convertido usa o botão Converter (lead a lead).");
  if (opts.projectId !== undefined) await assertLeadCity(opts.projectId ?? null);

  const rows = (await db.select().from(extraLeads).where(inArray(extraLeads.id, ids))) as ExtraLeadRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const res: BulkUpdateResult = { updated: 0, skipped: [] };
  const toUpdate: number[] = [];
  for (const id of ids) {
    const lead = byId.get(id);
    try {
      assertLeadVisible(lead);
    } catch (err: any) {
      res.skipped.push({ leadId: id, fullName: null, error: err.message });
      continue;
    }
    if (lead!.archivedAt) { res.skipped.push({ leadId: id, fullName: lead!.fullName, error: "Arquivado" }); continue; }
    if (opts.status) {
      const err = manualStatusError(lead!, opts.status);
      if (err) { res.skipped.push({ leadId: id, fullName: lead!.fullName, error: err }); continue; }
    }
    toUpdate.push(id);
  }
  if (toUpdate.length) {
    const set: Record<string, unknown> = {};
    if (opts.status) set.status = opts.status;
    if (opts.projectId !== undefined) set.projectId = opts.projectId ?? null;
    await db.update(extraLeads).set(set).where(inArray(extraLeads.id, toUpdate));
    res.updated = toUpdate.length;
    // "Sem interesse" em lote também rejeita as candidaturas do site (Jorge, 2 out 2026).
    if (opts.status === "declined") {
      const { rejectApplicationForLead } = await import("./extraLeadsSync");
      for (const id of toUpdate) {
        const l = byId.get(id)!;
        if (l.status !== "declined") await rejectApplicationForLead(l, userId);
      }
    }
    await logActivity({
      userId: userId ?? 0,
      action: "extra_lead_bulk",
      entity: "extra_leads",
      details: `Lote de ${toUpdate.length} lead(s)${opts.status ? ` → estado ${opts.status}` : ""}${opts.projectId !== undefined ? ` → cidade ${opts.projectId ?? "—"}` : ""} (ids ${toUpdate.slice(0, 50).join(", ")}${toUpdate.length > 50 ? "…" : ""})`,
    });
  }
  return res;
}

// ─── Funil ──────────────────────────────────────────────────────────────────

/**
 * Métricas do funil (origem × cidade × semana ISO da criação) dos leads
 * criados nas últimas `weeks` semanas, no âmbito de cidades de quem pede.
 */
export async function getLeadFunnel(opts: { weeks?: number } = {}): Promise<FunnelResult & { weeks: number }> {
  const weeks = Math.min(52, Math.max(1, Math.floor(opts.weeks ?? 12)));
  const db = await requireDb();
  const since = new Date(Date.now() - weeks * 7 * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  const conds = [gte(extraLeads.createdAt, since), isNull(extraLeads.archivedAt)];
  const scoped = leadScopeCondition();
  if (scoped) conds.push(scoped);
  const rows = (await db
    .select({
      source: extraLeads.source,
      projectId: extraLeads.projectId,
      status: extraLeads.status,
      createdAt: extraLeads.createdAt,
      contactCount: extraLeads.contactCount,
      firstContactedAt: extraLeads.firstContactedAt,
      lastContactedAt: extraLeads.lastContactedAt,
      lastInboundAt: extraLeads.lastInboundAt,
      convertedAt: extraLeads.convertedAt,
    })
    .from(extraLeads)
    .where(and(...conds))
    .limit(20_000)) as FunnelLeadRow[];
  const names = new Map(((await getProjects()) as { id: number; name: string }[]).map((p) => [p.id, p.name]));
  const result = aggregateFunnel(rows, (pid) => (pid == null ? "Sem cidade" : names.get(pid) ?? `#${pid}`));
  return { ...result, weeks };
}
