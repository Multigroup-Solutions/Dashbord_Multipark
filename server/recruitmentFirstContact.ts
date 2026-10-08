/**
 * Recrutamento em 1.º contacto (Jorge, 8 out 2026: "no caso de ser
 * recrutamento e ser o PRIMEIRO contacto, pode avançar para a criação de
 * candidato").
 *
 * Quando a IA (ao separar emails e WhatsApp pelas caixas, server/commsRouting.ts)
 * percebe que é alguém a candidatar-se a trabalhar:
 *  - procura a pessoa por email/telefone nas fichas (colaborador ATIVO), nas
 *    leads (também arquivadas) e nas candidaturas do site;
 *  - colaborador → não cria nada (só fica ligado no registo da IA);
 *  - já existe lead ou candidatura → não duplica: acrescenta à lead a nota
 *    "voltou a escrever" e liga;
 *  - ninguém → cria a candidatura (driver_applications, só com email — o
 *    email é obrigatório e único lá) e a lead (extra_leads, source email ou
 *    whatsapp) com o que a IA leu e a nota "Entrou pela IA".
 * Nunca escreve a ninguém (nem ao candidato). Nunca apaga.
 *
 * Com candidatura (havia email), nasce também a ficha de CANDIDATO (49c:
 * extra, inativa, motivo `candidato`, sem conta): fica fora das listas e da
 * escala até ser aprovada, e liga-se sozinha à conta Google com o MESMO email
 * no 1.º login (server/accountLink.ts `linkCandidateFichaOnLogin`).
 */
import { sql } from "drizzle-orm";
import { normalizeEmail, isPlausibleEmail } from "../shared/email";
import { normalizePhoneE164, normalizePhoneForStorage } from "../shared/phone";
import { isAutomatedSender } from "../shared/extraLeadsFunnel";
import { AI_INTAKE_TAG, aiIntakeNote, firstContactPlan, type CandidateData } from "../shared/commsRouting";

export interface FirstContactInput {
  channel: "email" | "whatsapp";
  /** Origem concreta (extra_leads.sourceRef, UNIQUE): "ai:mail_thread:12" / "ai:whatsapp:34". */
  sourceRef: string;
  candidate: CandidateData;
  /** Cidade (nó level='city') já resolvida a partir do texto, se certa. */
  projectId: number | null;
  reason: string | null;
}

export interface FirstContactResult {
  outcome: "invalid" | "employee" | "existing" | "created";
  leadId: number | null;
  applicationId: number | null;
  /** Ficha de candidato criada (ou já existente com esse email) — só com candidatura. */
  candidateEmployeeId?: number | null;
  detail?: string;
}

/** Acesso à BD (injetável nos testes). */
export interface FirstContactStore {
  findActiveEmployee(c: { email: string | null; phoneE164: string | null }): Promise<{ id: number; fullName: string } | null>;
  findLead(c: { email: string | null; phoneE164: string | null }): Promise<{ id: number; notes: string | null } | null>;
  findApplication(c: { email: string | null; phoneE164: string | null }): Promise<{ id: number } | null>;
  createApplication(row: { email: string; fullName: string; phone: string | null; city: string | null; drivingExperience: string | null; howDidYouKnow: string; payload: Record<string, unknown>; notes: string }): Promise<number | null>;
  createLead(row: { fullName: string; phone: string | null; phoneE164: string | null; email: string | null; notes: string; source: "email" | "whatsapp"; sourceRef: string; projectId: number | null }): Promise<number | null>;
  appendLeadNote(leadId: number, note: string): Promise<void>;
  /** Marca as origens como vistas (o backfill das candidaturas não volta a criar lead). */
  markSources(refs: Array<{ sourceRef: string; leadId: number | null; outcome: string }>): Promise<void>;
  log(entry: { action: string; entity: string; entityId: number; details: string }): Promise<void>;
  /** Tarefa "Candidatura de condutor" (a mesma de qualquer lead nova). */
  afterLeadCreated(leadId: number): Promise<void>;
  /**
   * Ficha de CANDIDATO para a candidatura (inativa, motivo `candidato`, sem
   * conta). Já existe ficha com esse email → devolve essa (nunca duplica).
   */
  createCandidateEmployee?(row: { applicationId: number; email: string; fullName: string; phone: string | null; projectId: number | null }): Promise<number | null>;
}

/** Nome para a lead (≥ 2 letras): o lido pela IA, senão um rótulo com o contacto. PURA. */
export function leadNameFor(c: { fullName: string | null; email: string | null; phoneE164: string | null }): string {
  const n = (c.fullName ?? "").trim();
  if (n.length >= 2) return n.slice(0, 256);
  if (c.email) return `Candidato ${c.email.split("@")[0]}`.slice(0, 256);
  return `Candidato ${c.phoneE164 ?? ""}`.trim().slice(0, 256);
}

/** Contactos normalizados (email de pessoa, telefone E.164). PURA. */
export function contactOf(c: Pick<CandidateData, "email" | "phone">): { email: string | null; phoneE164: string | null; phone: string | null } {
  const e = c.email ? normalizeEmail(c.email) : "";
  const email = e && isPlausibleEmail(e) && !isAutomatedSender(e) ? e : null;
  const phoneE164 = c.phone ? normalizePhoneE164(c.phone) : null;
  return { email, phoneE164, phone: phoneE164 ? normalizePhoneForStorage(c.phone) : null };
}

export async function onRecruitmentFirstContact(input: FirstContactInput, store?: FirstContactStore): Promise<FirstContactResult> {
  const s = store ?? dbFirstContactStore;
  const contact = contactOf(input.candidate);
  const [employee, lead, application] = await Promise.all([
    s.findActiveEmployee(contact), s.findLead(contact), s.findApplication(contact),
  ]);
  const plan = firstContactPlan({ employee: !!employee, lead: !!lead, application: !!application }, contact);
  const label = input.channel === "email" ? "email" : "WhatsApp";

  if (plan === "invalid") return { outcome: "invalid", leadId: null, applicationId: null, detail: "sem email nem telefone" };
  if (plan === "employee") return { outcome: "employee", leadId: null, applicationId: null, detail: `já é colaborador (${employee!.fullName})` };
  if (plan === "existing") {
    if (lead) {
      await s.appendLeadNote(lead.id, `Voltou a escrever por ${label} (separado pela IA)`);
    }
    return { outcome: "existing", leadId: lead?.id ?? null, applicationId: application?.id ?? null, detail: lead ? "já era candidato" : "já tinha candidatura" };
  }

  // ── 1.º contacto: candidatura (com email) + lead ──
  const fullName = leadNameFor({ fullName: input.candidate.fullName, ...contact });
  const note = aiIntakeNote(input.channel, input.candidate, input.reason);
  let applicationId: number | null = null;
  if (contact.email) {
    applicationId = await s.createApplication({
      email: contact.email,
      fullName,
      phone: contact.phone,
      city: input.candidate.city,
      drivingExperience: input.candidate.licenseYears != null ? `${input.candidate.licenseYears} anos de carta` : null,
      howDidYouKnow: input.channel === "email" ? "Email (IA)" : "WhatsApp (IA)",
      payload: {
        source: input.channel, via: "ia", sourceRef: input.sourceRef,
        hasLicense: input.candidate.hasLicense, licenseYears: input.candidate.licenseYears, availability: input.candidate.availability,
      },
      notes: note,
    });
  }
  const leadId = await s.createLead({
    fullName, phone: contact.phone, phoneE164: contact.phoneE164, email: contact.email, notes: note,
    source: input.channel, sourceRef: input.sourceRef, projectId: input.projectId,
  });
  if (leadId == null) {
    // Outra corrida criou-a ao mesmo tempo (UNIQUE): não duplica.
    return { outcome: "existing", leadId: null, applicationId, detail: "criada noutra corrida" };
  }
  await s.markSources([
    { sourceRef: input.sourceRef, leadId, outcome: "created" },
    ...(applicationId != null ? [{ sourceRef: `application:${applicationId}`, leadId, outcome: "merged" }] : []),
  ]);
  if (applicationId != null) {
    await s.log({ action: "driver_application_create", entity: "driver_applications", entityId: applicationId, details: `[IA] Candidatura criada a partir de ${label}: ${fullName}${contact.email ? ` <${contact.email}>` : ""}` });
  }
  await s.log({ action: "extra_lead_import", entity: "extra_leads", entityId: leadId, details: `[IA] ${AI_INTAKE_TAG} (${label}, ${input.sourceRef}): ${fullName}${contact.phone ? ` · ${contact.phone}` : ""}${contact.email ? ` · ${contact.email}` : ""}` });
  // Ficha de candidato (inativa até ser aprovada) — só com candidatura (email).
  let candidateEmployeeId: number | null = null;
  if (applicationId != null && contact.email && s.createCandidateEmployee) {
    try {
      candidateEmployeeId = await s.createCandidateEmployee({ applicationId, email: contact.email, fullName, phone: contact.phone, projectId: input.projectId });
    } catch (err) {
      console.warn("[recrutamento IA] ficha de candidato:", String((err as any)?.message ?? err).slice(0, 160));
    }
  }
  await s.afterLeadCreated(leadId);
  return { outcome: "created", leadId, applicationId, candidateEmployeeId };
}

// ─── BD ──────────────────────────────────────────────────────────────────────

const rowsOf = (r: any): any[] => (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : Array.isArray(r) ? r : []);
const insertId = (r: any): number | null => { const n = Number((Array.isArray(r) ? r[0] : r)?.insertId ?? 0); return n > 0 ? n : null; };
const isDup = (err: any) => (err?.code ?? err?.cause?.code) === "ER_DUP_ENTRY";

async function database() {
  const { getDb } = await import("./db");
  const d = await getDb();
  if (!d) throw new Error("Base de dados indisponível");
  return d;
}

/** Últimos 9 dígitos (para comparar telefones guardados como texto livre). PURA. */
export function phoneTail(e164: string | null): string | null {
  const d = String(e164 ?? "").replace(/\D/g, "");
  return d.length >= 9 ? d.slice(-9) : null;
}

export const dbFirstContactStore: FirstContactStore = {
  async findActiveEmployee(c) {
    if (c.phoneE164) {
      const { findActiveEmployeeByPhoneE164 } = await import("./extrasAvailability");
      const e = await findActiveEmployeeByPhoneE164(c.phoneE164).catch(() => null);
      if (e) return { id: Number((e as any).id), fullName: String((e as any).fullName ?? "") };
    }
    if (c.email) {
      const d = await database();
      const r = rowsOf(await d.execute(sql`SELECT id, fullName FROM employees WHERE isActive = 1
        AND (LOWER(TRIM(email)) = ${c.email} OR LOWER(TRIM(personalEmail)) = ${c.email}) LIMIT 1`))[0];
      if (r) return { id: Number(r.id), fullName: String(r.fullName ?? "") };
    }
    return null;
  },
  async findLead(c) {
    const conds = [];
    if (c.phoneE164) conds.push(sql`phoneE164 = ${c.phoneE164}`);
    if (c.email) conds.push(sql`LOWER(TRIM(email)) = ${c.email}`);
    if (!conds.length) return null;
    const d = await database();
    const r = rowsOf(await d.execute(sql`SELECT id, notes FROM extra_leads WHERE ${sql.join(conds, sql` OR `)} ORDER BY id LIMIT 1`))[0];
    return r ? { id: Number(r.id), notes: r.notes ?? null } : null;
  },
  async findApplication(c) {
    const d = await database();
    if (c.email) {
      const r = rowsOf(await d.execute(sql`SELECT id FROM driver_applications WHERE LOWER(TRIM(email)) = ${c.email} ORDER BY id LIMIT 1`))[0];
      if (r) return { id: Number(r.id) };
    }
    const tail = phoneTail(c.phoneE164);
    if (tail) {
      const rows = rowsOf(await d.execute(sql`SELECT id, phone FROM driver_applications WHERE phone LIKE ${`%${tail.slice(-4)}%`} ORDER BY id LIMIT 50`));
      const hit = rows.find((x) => normalizePhoneE164(String(x.phone ?? "")) === c.phoneE164);
      if (hit) return { id: Number(hit.id) };
    }
    return null;
  },
  async createApplication(row) {
    const d = await database();
    try {
      const res = await d.execute(sql`INSERT INTO driver_applications (email, fullName, phone, city, drivingExperience, howDidYouKnow, payload, notes)
        VALUES (${row.email}, ${row.fullName}, ${row.phone}, ${row.city?.slice(0, 128) ?? null}, ${row.drivingExperience?.slice(0, 64) ?? null},
          ${row.howDidYouKnow.slice(0, 64)}, ${JSON.stringify(row.payload)}, ${row.notes.slice(0, 512)})`);
      return insertId(res);
    } catch (err) {
      if (isDup(err)) return null; // email já tem candidatura (corrida): não duplica
      throw err;
    }
  },
  async createLead(row) {
    const d = await database();
    try {
      const res = await d.execute(sql`INSERT INTO extra_leads (fullName, phone, phoneE164, email, notes, source, sourceRef, projectId, createdById)
        VALUES (${row.fullName}, ${row.phone}, ${row.phoneE164}, ${row.email}, ${row.notes.slice(0, 512)}, ${row.source}, ${row.sourceRef}, ${row.projectId}, NULL)`);
      return insertId(res);
    } catch (err) {
      if (isDup(err)) return null;
      throw err;
    }
  },
  async appendLeadNote(leadId, note) {
    const d = await database();
    const r = rowsOf(await d.execute(sql`SELECT notes FROM extra_leads WHERE id = ${leadId} LIMIT 1`))[0];
    const { appendSourceNote } = await import("./extraLeadsSync");
    const next = appendSourceNote(r?.notes ?? null, note);
    if (next !== (r?.notes ?? null)) await d.execute(sql`UPDATE extra_leads SET notes = ${next} WHERE id = ${leadId}`);
  },
  async markSources(refs) {
    const d = await database();
    for (const r of refs) {
      await d.execute(sql`INSERT IGNORE INTO extra_lead_sources (sourceRef, leadId, outcome) VALUES (${r.sourceRef.slice(0, 64)}, ${r.leadId}, ${r.outcome})`);
    }
  },
  async log(entry) {
    const { logActivity } = await import("./db");
    await logActivity({ userId: 0, ...entry }).catch(() => {});
  },
  async createCandidateEmployee(row) {
    const { createCandidateFichaForApplication } = await import("./accountLink");
    return createCandidateFichaForApplication({ ...row, how: "1.º contacto pela IA" });
  },
  async afterLeadCreated(leadId) {
    try {
      const { syncLeadTasks } = await import("./leadTasks");
      await syncLeadTasks(new Date(), { leadIds: [leadId] });
    } catch (err) {
      console.warn("[recrutamento IA] tarefa da candidatura:", String((err as any)?.message ?? err).slice(0, 160));
    }
  },
};
