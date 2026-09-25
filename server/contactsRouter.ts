/**
 * tRPC — Contactos (pedido do dono set 2026):
 *  - `contacts.*` (módulo "contactos", âmbito de cidade do pedido): pesquisa
 *    unificada, ficha, diretório da empresa (lista/lookup/estado/sincronizar),
 *    sugestões a partir dos contactos Google da própria pessoa e "criar
 *    cliente/lead" a partir de um deles, definições (super admin edita);
 *  - `googleAccount.contacts.*` (caminho pessoal): estado, preferências e
 *    "Sincronizar agora" da funcionalidade Contactos do próprio.
 * Nunca devolve tokens; nunca regista dados pessoais dos contactos.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { protectedProcedure, router } from "./_core/trpc";
import { requireAccess, withOverrides } from "./_core/access";
import {
  CONTACT_KINDS, CREATE_FROM_GOOGLE_AS, CREATE_FROM_GOOGLE_REQUIRES, buildMatchIndex, contactsConfigSchema, emailKey, googleContactsPrefsSchema, matchContact,
  phoneKey, uniqueStrings, type ContactMatch, type MatchRecord,
} from "../shared/contacts";
import { can, grantFor } from "../shared/access";
import type { ContactViewer } from "./contactsSearch";

type CtxUser = { id: number; role: string; accessOverrides?: any };
const viewerOf = (u: CtxUser): ContactViewer => {
  const w = withOverrides(u);
  return { id: w.id, role: w.role, accessOverrides: w.accessOverrides ?? null };
};
const adminOnly = (u: CtxUser) => {
  if (!["admin", "super_admin"].includes(u.role)) throw new TRPCError({ code: "FORBIDDEN", message: "Acesso não autorizado." });
};
const superOnly = (u: CtxUser) => {
  if (u.role !== "super_admin") throw new TRPCError({ code: "FORBIDDEN", message: "Só o super admin configura os Contactos Google." });
};
const beyondOwn = (u: ContactViewer, m: Parameters<typeof grantFor>[1]) => {
  const g = grantFor(u as any, m);
  return g.access !== "none" && g.access !== "own" && g.actions.includes("view");
};

async function database() {
  const { getDb } = await import("./db");
  const d = await getDb();
  if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Base de dados indisponível." });
  return d;
}
const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const inList = (xs: readonly (string | number)[]) => sql.join(xs.map((x) => sql`${x}`), sql`, `);
const parseList = (raw: unknown): string[] => { try { const v = JSON.parse(String(raw ?? "[]")); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };

const kindEnum = z.enum(CONTACT_KINDS);

// ─── Sugestões (contactos Google da pessoa → registos existentes) ──────────

/** Registos (no âmbito e nos módulos da pessoa) com estes emails/telefones. */
export async function matchRecordsFor(d: { execute: (q: any) => Promise<any> }, viewer: ContactViewer, emails: string[], phones: string[]): Promise<MatchRecord[]> {
  const { projectScope, partnerScope, scopedProjectIds } = await import("./cityScope");
  const out: MatchRecord[] = [];
  const last9 = uniqueStrings(phones.map((p) => p.replace(/\D+/g, "").slice(-9)).filter((x) => x.length === 9));
  const emailCond = (col: any) => (emails.length ? sql`LOWER(TRIM(${col})) IN (${inList(emails)})` : sql`1 = 0`);
  const phoneCond = (col: any) => (last9.length ? sql`RIGHT(REGEXP_REPLACE(COALESCE(${col}, ''), '[^0-9]', ''), 9) IN (${inList(last9)})` : sql`1 = 0`);
  if (!emails.length && !last9.length) return out;
  if (beyondOwn(viewer, "clientes")) {
    for (const r of rowsOf(await d.execute(sql`SELECT LOWER(TRIM(b.clientEmail)) AS email, MAX(NULLIF(TRIM(CONCAT_WS(' ', b.clientFirstName, b.clientLastName)), '')) AS name,
        MAX(b.clientPhone) AS phone FROM multipark_bookings b
      WHERE b.clientEmail IS NOT NULL AND b.clientEmail LIKE '%@%' AND (${emailCond(sql`b.clientEmail`)} OR ${phoneCond(sql`b.clientPhone`)}) AND ${projectScope(sql`b.projectId`)}
      GROUP BY LOWER(TRIM(b.clientEmail)) LIMIT 300`))) {
      out.push({ kind: "client", id: String(r.email), label: String(r.name ?? r.email), emails: [String(r.email)], phones: [String(r.phone ?? "")] });
    }
    for (const r of rowsOf(await d.execute(sql`SELECT c.id, c.name, c.email, c.phoneE164 FROM crm_contacts c
      WHERE (${emailCond(sql`c.email`)} OR ${phoneCond(sql`c.phoneE164`)}) AND ${projectScope(sql`c.projectId`)} LIMIT 300`).catch(() => [[]]))) {
      out.push({ kind: "crm", id: String(r.id), label: String(r.name), emails: [String(r.email ?? "")], phones: [String(r.phoneE164 ?? "")] });
    }
  }
  if (beyondOwn(viewer, "leads_extras")) {
    const ids = scopedProjectIds();
    const scope = ids === undefined ? sql`1 = 1` : ids.length ? sql`(l.projectId IS NULL OR l.projectId IN (${inList(ids)}))` : sql`l.projectId IS NULL`;
    for (const r of rowsOf(await d.execute(sql`SELECT l.id, l.fullName, l.email, l.phoneE164 FROM extra_leads l
      WHERE (${emailCond(sql`l.email`)} OR ${phoneCond(sql`l.phoneE164`)}) AND ${scope} LIMIT 300`))) {
      out.push({ kind: "lead", id: String(r.id), label: String(r.fullName), emails: [String(r.email ?? "")], phones: [String(r.phoneE164 ?? "")] });
    }
  }
  if (beyondOwn(viewer, "parcerias")) {
    for (const r of rowsOf(await d.execute(sql`SELECT p.id, p.name, p.contactEmail, p.contactPhone FROM partnerships p
      WHERE (${emailCond(sql`p.contactEmail`)} OR ${phoneCond(sql`p.contactPhone`)}) AND ${partnerScope(sql`p.id`)} LIMIT 300`))) {
      out.push({ kind: "partner", id: String(r.id), label: String(r.name), emails: [String(r.contactEmail ?? "")], phones: [String(r.contactPhone ?? "")] });
    }
  }
  if (beyondOwn(viewer, "rh") || beyondOwn(viewer, "utilizadores")) {
    for (const r of rowsOf(await d.execute(sql`SELECT e.id, e.fullName, e.email, e.phone FROM employees e
      WHERE e.isActive = 1 AND (${emailCond(sql`e.email`)} OR ${phoneCond(sql`e.phone`)}) AND ${projectScope(sql`e.projectId`)} LIMIT 300`))) {
      out.push({ kind: "employee", id: String(r.id), label: String(r.fullName), emails: [String(r.email ?? "")], phones: [String(r.phone ?? "")] });
    }
  }
  return out;
}

const googleRouter = router({
  suggestions: protectedProcedure
    .input(z.object({ cursor: z.number().int().min(0).max(10_000).nullish(), q: z.string().max(120).nullish(), onlyUnmatched: z.boolean().optional() }))
    .query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "contactos", "view");
      const v = viewerOf(ctx.user as CtxUser);
      const d = await database();
      const offset = input.cursor ?? 0;
      const limit = 40;
      const { parseContactQuery } = await import("../shared/contacts");
      const q = parseContactQuery(input.q);
      const filter = q.text || q.digits
        ? sql`AND (LOWER(c.displayName) LIKE ${q.like} OR LOWER(c.emailsJson) LIKE ${q.like}${q.phoneNeedle ? sql` OR c.phonesJson LIKE ${`%${q.phoneNeedle}%`}` : sql``})`
        : sql``;
      const rows = rowsOf(await d.execute(sql`SELECT c.id, c.resourceName, c.displayName, c.emailsJson, c.phonesJson, c.source FROM google_user_contacts c
        WHERE c.userId = ${v.id} ${filter} ORDER BY c.displayName LIMIT ${limit + 1} OFFSET ${offset}`).catch(() => [[]]));
      const page = rows.slice(0, limit).map((r) => ({ id: Number(r.id), name: String(r.displayName ?? ""), emails: parseList(r.emailsJson), phones: parseList(r.phonesJson), source: String(r.source) }));
      const emails = uniqueStrings(page.flatMap((c) => c.emails.map(emailKey)));
      const phones = uniqueStrings(page.flatMap((c) => c.phones.map(phoneKey)));
      const idx = buildMatchIndex(await matchRecordsFor(d, v, emails, phones));
      let items = page.map((c) => ({ ...c, matches: matchContact(c, idx) as ContactMatch[] }));
      if (input.onlyUnmatched) items = items.filter((x) => !x.matches.length);
      const canCreate = CREATE_FROM_GOOGLE_AS.filter((a) => can(v as any, CREATE_FROM_GOOGLE_REQUIRES[a].module, "edit") && beyondOwn(v, CREATE_FROM_GOOGLE_REQUIRES[a].module));
      return { items, nextCursor: rows.length > limit ? offset + limit : null, canCreate };
    }),

  /** "Criar cliente/lead" a partir de um contacto Google da própria pessoa. */
  create: protectedProcedure
    .input(z.object({ id: z.number().int().positive(), as: z.enum(CREATE_FROM_GOOGLE_AS) }))
    .mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "contactos", "view");
      const need = CREATE_FROM_GOOGLE_REQUIRES[input.as];
      requireAccess(ctx.user, need.module, need.action);
      const v = viewerOf(ctx.user as CtxUser);
      const d = await database();
      const r = rowsOf(await d.execute(sql`SELECT id, resourceName, displayName, emailsJson, phonesJson FROM google_user_contacts WHERE id = ${input.id} AND userId = ${v.id} LIMIT 1`))[0];
      if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Contacto Google não encontrado." });
      const email = parseList(r.emailsJson).map(emailKey).find(Boolean) ?? null;
      const phone = parseList(r.phonesJson).map(phoneKey).find(Boolean) ?? null;
      const name = String(r.displayName ?? "").trim() || (email ? email.split("@")[0] : "") || phone || "";
      if (name.length < 2) throw new TRPCError({ code: "BAD_REQUEST", message: "O contacto não tem nome suficiente." });
      if (!email && !phone) throw new TRPCError({ code: "BAD_REQUEST", message: "O contacto não tem email nem telefone." });
      const { logActivity } = await import("./db");
      if (input.as === "extra_lead") {
        const { createExtraLead } = await import("./extraLeads");
        try {
          const lead = await createExtraLead({ fullName: name, phone, email }, v.id);
          return { kind: "lead" as const, id: String(lead.id) };
        } catch (err: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: String(err?.message ?? err) });
        }
      }
      const { projectScope, scopedProjectIds } = await import("./cityScope");
      const dupConds = [email ? sql`LOWER(TRIM(c.email)) = ${email}` : null, phone ? sql`c.phoneE164 = ${phone}` : null].filter(Boolean) as any[];
      const dup = rowsOf(await d.execute(sql`SELECT c.id FROM crm_contacts c WHERE (${sql.join(dupConds, sql` OR `)}) AND ${projectScope(sql`c.projectId`)} LIMIT 1`))[0];
      if (dup) throw new TRPCError({ code: "CONFLICT", message: `Já existe um contacto do CRM com este email/telefone (#${dup.id}).` });
      const { cityScope } = await import("./cityScope");
      const scoped = scopedProjectIds();
      const projectId = scoped === undefined ? null : cityScope.getStore()?.defaultCityId ?? scoped[0] ?? null;
      const res: any = await d.execute(sql`INSERT INTO crm_contacts (kind, name, email, phone, phoneE164, projectId, source, googleResourceName, createdById)
        VALUES (${input.as}, ${name.slice(0, 255)}, ${email}, ${phone}, ${phone}, ${projectId}, 'google', ${String(r.resourceName).slice(0, 128)}, ${v.id})`);
      const id = Number((Array.isArray(res) ? res[0] : res)?.insertId ?? 0);
      await logActivity({ userId: v.id, action: "create", entity: "crm_contact", entityId: id, details: `Contacto do CRM (${input.as === "lead" ? "lead comercial" : "cliente"}) criado a partir de um contacto Google` } as any).catch(() => {});
      return { kind: "crm" as const, id: String(id) };
    }),
});

// ─── Diretório ──────────────────────────────────────────────────────────────

const directoryRouter = router({
  /** Foto/cargo/telefone do diretório para uma página de emails (listas de Utilizadores/RH). */
  lookup: protectedProcedure.input(z.object({ emails: z.array(z.string().max(320)).max(200) })).query(async ({ ctx, input }) => {
    const v = viewerOf(ctx.user as CtxUser);
    if (!beyondOwn(v, "contactos") && !beyondOwn(v, "utilizadores") && !beyondOwn(v, "rh")) throw new TRPCError({ code: "FORBIDDEN", message: "Acesso não autorizado." });
    const emails = uniqueStrings(input.emails.map(emailKey));
    if (!emails.length) return {} as Record<string, { photoUrl: string | null; jobTitle: string | null; department: string | null; phone: string | null }>;
    const d = await database();
    const rows = rowsOf(await d.execute(sql`SELECT primaryEmail, photoUrl, jobTitle, department, phoneE164, phoneRaw FROM google_directory_people
      WHERE deletedAt IS NULL AND primaryEmail IN (${inList(emails)})`).catch(() => [[]]));
    const out: Record<string, { photoUrl: string | null; jobTitle: string | null; department: string | null; phone: string | null }> = {};
    for (const r of rows) out[String(r.primaryEmail)] = { photoUrl: r.photoUrl ?? null, jobTitle: r.jobTitle ?? null, department: r.department ?? null, phone: r.phoneE164 ?? r.phoneRaw ?? null };
    return out;
  }),
  status: protectedProcedure.query(async ({ ctx }) => {
    requireAccess(ctx.user, "contactos", "view");
    const { getDirectoryState } = await import("./google/contactsStore");
    const { loadContactsConfig } = await import("./google/contactsService");
    const cfg = await loadContactsConfig();
    const st = await getDirectoryState().catch(() => null);
    return {
      enabled: cfg.directory.enabled, lastFullSyncAt: st?.lastFullSyncAt ?? null, lastRunAt: st?.lastRunAt ?? null,
      lastError: ["admin", "super_admin"].includes(ctx.user.role) ? st?.lastError ?? null : null, count: st?.peopleCount ?? 0, inProgress: !!st?.pageToken,
      canSync: ["admin", "super_admin"].includes(ctx.user.role),
    };
  }),
  syncNow: protectedProcedure.mutation(async ({ ctx }) => {
    requireAccess(ctx.user, "contactos", "view");
    adminOnly(ctx.user as CtxUser);
    const { runDirectorySync } = await import("./google/contactsService");
    return runDirectorySync({ deadlineAt: Date.now() + 40_000, force: true });
  }),
});

// ─── Definições (Definições → Comunicação → Contactos Google) ───────────────

const settingsRouter = router({
  get: protectedProcedure.query(async ({ ctx }) => {
    adminOnly(ctx.user as CtxUser);
    const { loadContactsConfig } = await import("./google/contactsService");
    const { dwdConfigured, workspaceConfig } = await import("./google/workspace");
    return {
      canEdit: ctx.user.role === "super_admin",
      config: await loadContactsConfig(),
      dwd: dwdConfigured(),
      serviceAccountEmail: workspaceConfig().serviceAccount?.client_email ?? null,
    };
  }),
  save: protectedProcedure.input(contactsConfigSchema).mutation(async ({ ctx, input }) => {
    superOnly(ctx.user as CtxUser);
    const { setSetting } = await import("./appSettings");
    try {
      const r = await setSetting("google.contacts", input, ctx.user.id);
      try {
        const { logActivity } = await import("./db");
        if (r.changed) await logActivity({ userId: ctx.user.id, action: "update", entity: "app_setting", entityId: null, details: `google.contacts = ${JSON.stringify(r.value)}` } as any);
      } catch { /* registo */ }
      return { ok: true };
    } catch (err: any) {
      throw new TRPCError({ code: "BAD_REQUEST", message: String(err?.message ?? err) });
    }
  }),
});

export const contactsRouter = router({
  /** Tipos que a pessoa pode pesquisar. */
  kinds: protectedProcedure.query(async ({ ctx }) => {
    requireAccess(ctx.user, "contactos", "view");
    const { searchableKinds } = await import("./contactsSearch");
    return searchableKinds(viewerOf(ctx.user as CtxUser)).map((k) => k.kind);
  }),
  search: protectedProcedure
    .input(z.object({ q: z.string().max(120).nullish(), kind: z.union([kindEnum, z.literal("all")]).optional(), cursor: z.number().int().min(0).max(10_000).nullish(), limit: z.number().int().min(5).max(50).nullish() }))
    .query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "contactos", "view");
      const { searchContacts } = await import("./contactsSearch");
      return searchContacts(await database(), viewerOf(ctx.user as CtxUser), input);
    }),
  detail: protectedProcedure.input(z.object({ kind: kindEnum, id: z.string().trim().min(1).max(320) })).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "contactos", "view");
    const { contactDetail } = await import("./contactsSearch");
    return contactDetail(await database(), viewerOf(ctx.user as CtxUser), input.kind, input.id);
  }),
  directory: directoryRouter,
  google: googleRouter,
  settings: settingsRouter,
});

// ─── Pessoal: googleAccount.contacts.* ──────────────────────────────────────

export const googleContactsRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    const { contactsSummary } = await import("./google/contactsService");
    return contactsSummary(ctx.user.id, ctx.user.role);
  }),
  setPrefs: protectedProcedure.input(googleContactsPrefsSchema).mutation(async ({ ctx, input }) => {
    const { setContactsPrefs } = await import("./google/contactsService");
    await setContactsPrefs(ctx.user.id, input);
    try {
      const { logActivity } = await import("./db");
      await logActivity({ userId: ctx.user.id, action: "update", entity: "google_contacts", entityId: null, details: `Preferências dos Contactos Google: ${JSON.stringify(input)}` } as any);
    } catch { /* registo */ }
    return { ok: true };
  }),
  syncNow: protectedProcedure.mutation(async ({ ctx }) => {
    const { runGoogleSync } = await import("./google/syncService");
    const r = await runGoogleSync({ deadlineAt: Date.now() + 25_000, onlyUserIds: [ctx.user.id], includeShared: false });
    const me = r.users[0];
    return { status: me?.status ?? "skipped", error: me?.error ?? null, contacts: me?.contacts ?? null, done: r.done };
  }),
});
