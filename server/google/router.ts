/**
 * tRPC — Google Tarefas & Calendário:
 *  - `googleAccount.sync.*` (caminho pessoal: o próprio, sem âmbito de cidade):
 *    estado, preferências, "Sincronizar agora", livre/ocupado (Disponibilidade);
 *  - `googleCalendar.*`: "Criar reunião" (Meet) a partir de um cliente,
 *    reclamação ou parceria (mesmas permissões de ver o registo) e os
 *    calendários partilhados da escala (admin vê; só o super_admin edita).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { requireAccess } from "../_core/access";
import { createMeetingSchema, googleSyncPrefsSchema, lisbonLocalToUtcMs, sharedCalendarsConfigSchema, dashboardUrl } from "../../shared/googleSync";
import { normalizeAddress } from "../../shared/mail";

type CtxUser = { id: number; role: string; accessOverrides?: any };
const adminOnly = (u: CtxUser) => {
  if (!["admin", "super_admin"].includes(u.role)) throw new TRPCError({ code: "FORBIDDEN", message: "Acesso não autorizado." });
};
const superOnly = (u: CtxUser) => {
  if (u.role !== "super_admin") throw new TRPCError({ code: "FORBIDDEN", message: "Só o super admin configura os calendários partilhados." });
};
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const googleSyncRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    const { googleSyncSummary } = await import("./syncService");
    return googleSyncSummary(ctx.user.id);
  }),
  setPrefs: protectedProcedure.input(googleSyncPrefsSchema).mutation(async ({ ctx, input }) => {
    const { patchSyncState } = await import("./syncStore");
    const { nowSql } = await import("./syncStore");
    await patchSyncState(ctx.user.id, { prefsJson: JSON.stringify(input), dirtyAt: nowSql() });
    try {
      const { logActivity } = await import("../db");
      await logActivity({ userId: ctx.user.id, action: "update", entity: "google_sync", entityId: null, details: `Preferências Google: ${JSON.stringify(input)}` } as any);
    } catch { /* registo */ }
    return { ok: true };
  }),
  syncNow: protectedProcedure.mutation(async ({ ctx }) => {
    const { runGoogleSync } = await import("./syncService");
    const r = await runGoogleSync({ deadlineAt: Date.now() + 25_000, onlyUserIds: [ctx.user.id], includeShared: false });
    const me = r.users[0];
    return { status: me?.status ?? "skipped", error: me?.error ?? null, tasks: me?.tasks ?? null, calendar: me?.calendar ?? null, done: r.done };
  }),
  /** Blocos ocupados do Google Calendar da própria pessoa (só horas; nunca o conteúdo). */
  busy: protectedProcedure.input(z.object({ fromDay: day, toDay: day })).query(async ({ ctx, input }) => {
    if (input.toDay < input.fromDay) throw new TRPCError({ code: "BAD_REQUEST", message: "Intervalo inválido." });
    const { userBusyBlocks } = await import("./syncService");
    return userBusyBlocks(ctx.user.id, input.fromDay, input.toDay);
  }),
});

async function meetingTarget(u: CtxUser, type: "client" | "complaint" | "partnership", rawId: string): Promise<{ id: string; label: string; email: string | null; path: string }> {
  const { db, rowsOf } = await import("./syncStore");
  const { sql } = await import("drizzle-orm");
  const d = await db();
  if (type === "client") {
    requireAccess(u, "clientes", "view");
    const email = normalizeAddress(rawId);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new TRPCError({ code: "BAD_REQUEST", message: "Cliente sem email válido." });
    const { assertEntityInScope } = await import("../mail/inbox");
    await assertEntityInScope("client", email);
    const r = rowsOf(await d.execute(sql`SELECT MAX(NULLIF(TRIM(CONCAT_WS(' ', clientFirstName, clientLastName)), '')) AS name
      FROM multipark_bookings WHERE LOWER(TRIM(clientEmail)) = ${email}`))[0];
    return { id: email, label: String(r?.name ?? email), email, path: `/clientes?email=${encodeURIComponent(email)}` };
  }
  if (type === "complaint") {
    requireAccess(u, "reclamacoes", "view");
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Reclamação inválida." });
    const { assertEntityInScope } = await import("../mail/inbox");
    await assertEntityInScope("complaint", String(id));
    const r = rowsOf(await d.execute(sql`SELECT id, title, clientEmail, clientName FROM complaints WHERE id = ${id} LIMIT 1`))[0];
    if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Reclamação não encontrada." });
    return { id: String(id), label: `Reclamação #${id} — ${r.clientName ?? r.title}`, email: r.clientEmail ? normalizeAddress(r.clientEmail) : null, path: `/reclamacoes?id=${id}` };
  }
  requireAccess(u, "parcerias", "view");
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Parceria inválida." });
  const r = rowsOf(await d.execute(sql`SELECT id, name, contactEmail FROM partnerships WHERE id = ${id} LIMIT 1`))[0];
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Parceria não encontrada." });
  return { id: String(id), label: `Parceria — ${r.name}`, email: r.contactEmail ? normalizeAddress(r.contactEmail) : null, path: "/parcerias" };
}

export const googleCalendarRouter = router({
  /** Contexto do botão "Criar reunião": o calendário está ligado? há email do cliente? */
  meetingContext: protectedProcedure
    .input(z.object({ entityType: createMeetingSchema.shape.entityType, entityId: z.string().trim().min(1).max(320) }))
    .query(async ({ ctx, input }) => {
      const t = await meetingTarget(ctx.user as CtxUser, input.entityType, input.entityId);
      const { getGoogleAccount } = await import("./userAccounts");
      const { hasFeatureScopes } = await import("../../shared/mail");
      const acc = await getGoogleAccount(ctx.user.id).catch(() => null);
      const connected = !!acc && acc.status === "connected" && !!acc.refreshTokenEnc;
      return { label: t.label, clientEmail: t.email, connected, calendarGranted: connected && hasFeatureScopes(acc!.scopes, "calendar"), needsReauth: acc?.status === "reauth_required" };
    }),
  createMeeting: protectedProcedure.input(createMeetingSchema).mutation(async ({ ctx, input }) => {
    const t = await meetingTarget(ctx.user as CtxUser, input.entityType, input.entityId);
    const { getGoogleAccount } = await import("./userAccounts");
    const { hasFeatureScopes } = await import("../../shared/mail");
    const acc = await getGoogleAccount(ctx.user.id).catch(() => null);
    if (!acc || acc.status === "disconnected" || !acc.refreshTokenEnc) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Liga primeiro a tua conta Google (Perfil → Google)." });
    if (!hasFeatureScopes(acc.scopes, "calendar")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Ativa o Calendário na tua conta Google (Perfil → Google → Ativar Tarefas e Calendário)." });
    const startMs = lisbonLocalToUtcMs(input.startLocal);
    if (!Number.isFinite(startMs) || startMs < Date.now() - 3_600_000) throw new TRPCError({ code: "BAD_REQUEST", message: "Escolhe uma data/hora futura." });
    const invite = input.inviteClient && t.email ? t.email : null;
    if (input.inviteClient && !t.email) throw new TRPCError({ code: "BAD_REQUEST", message: "Este registo não tem email do cliente para convidar." });
    const { appOrigin, googleErrorMessage } = await import("./workspace");
    const link = dashboardUrl(appOrigin(), t.path);
    try {
      const { createMeetingEvent } = await import("./syncService");
      const r = await createMeetingEvent(ctx.user.id, {
        title: input.title, startMs, durationMin: input.durationMin, description: [t.label, input.notes ?? ""].filter(Boolean).join("\n\n"),
        attendeeEmail: invite, link, entityType: input.entityType, entityId: t.id,
      });
      try {
        const { logActivity } = await import("../db");
        await logActivity({ userId: ctx.user.id, action: "create", entity: "google_meeting", entityId: null, details: `Reunião "${input.title}" (${input.entityType} ${t.id})${invite ? ` · convidado ${invite}` : ""}` } as any);
      } catch { /* registo */ }
      return r;
    } catch (err: any) {
      if (err instanceof TRPCError) throw err;
      throw new TRPCError({ code: "BAD_REQUEST", message: `Não foi possível criar a reunião: ${googleErrorMessage(err)}` });
    }
  }),

  shared: router({
    get: protectedProcedure.query(async ({ ctx }) => {
      adminOnly(ctx.user as CtxUser);
      const { loadSharedCalendarsConfig } = await import("./syncService");
      const { db, rowsOf } = await import("./syncStore");
      const { sql } = await import("drizzle-orm");
      const { dwdConfigured, workspaceConfig } = await import("./workspace");
      let rows: any[] = [];
      try { rows = rowsOf(await (await db()).execute(sql`SELECT city, ownerEmail, calendarId, aclDomain, lastSyncAt, lastError FROM google_shared_calendars`)); } catch { rows = []; }
      return {
        canEdit: (ctx.user as CtxUser).role === "super_admin",
        config: await loadSharedCalendarsConfig(),
        dwd: dwdConfigured(),
        serviceAccountEmail: workspaceConfig().serviceAccount?.client_email ?? null,
        calendars: rows.map((r) => ({
          city: String(r.city), ownerEmail: String(r.ownerEmail), calendarId: r.calendarId ?? null, aclDomain: r.aclDomain ?? null,
          lastSyncAt: r.lastSyncAt ? String(r.lastSyncAt) : null, lastError: r.lastError ?? null,
          subscribeUrl: r.calendarId ? `https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(String(r.calendarId))}` : null,
        })),
      };
    }),
    save: protectedProcedure.input(sharedCalendarsConfigSchema).mutation(async ({ ctx, input }) => {
      superOnly(ctx.user as CtxUser);
      const { setSetting } = await import("../appSettings");
      try {
        const r = await setSetting("google.sharedCalendars", input, ctx.user.id);
        try {
          const { logActivity } = await import("../db");
          if (r.changed) await logActivity({ userId: ctx.user.id, action: "update", entity: "app_setting", entityId: null, details: `google.sharedCalendars = ${JSON.stringify(r.value)}` } as any);
        } catch { /* registo */ }
        return { ok: true };
      } catch (err: any) {
        throw new TRPCError({ code: "BAD_REQUEST", message: String(err?.message ?? err) });
      }
    }),
    syncNow: protectedProcedure.mutation(async ({ ctx }) => {
      adminOnly(ctx.user as CtxUser);
      const { syncSharedCalendars } = await import("./syncService");
      return syncSharedCalendars({ deadlineAt: Date.now() + 40_000 });
    }),
  }),
});
