/**
 * tRPC `googleDrive.*` — Google Drive / Docs / Sheets.
 * Cada procedimento verifica o acesso ao registo (driveAccess.ts) ou ao
 * relatório (sheetsExport.ts) com a matriz de acessos e o âmbito de cidade do
 * pedido (este caminho NÃO é pessoal: o middleware aplica a cidade).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  DRIVE_ENTITY_TYPES, GENERATE_DESTINATIONS, GENERATE_ENTITY_TYPES, SHEET_IMPORT_PURPOSES, docTemplateInputSchema, driveConfigSchema,
  driveLinkInputSchema, sheetExportInputSchema, type GenerateEntityType,
} from "../../shared/drive";

type CtxUser = { id: number; role: string; name?: string | null; email?: string | null; accessOverrides?: any };
const adminOnly = (u: CtxUser) => {
  if (!["admin", "super_admin"].includes(u.role)) throw new TRPCError({ code: "FORBIDDEN", message: "Acesso não autorizado." });
};
const superOnly = (u: CtxUser) => {
  if (u.role !== "super_admin") throw new TRPCError({ code: "FORBIDDEN", message: "Só o super admin configura o Shared Drive." });
};

// Os documentos do RH ("employee_document") NUNCA vão para o Drive (decisão do dono, 26 set 2026).
const saveSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mail_attachment"), messageId: z.number().int().positive(), index: z.number().int().min(0).max(500) }),
  z.object({ kind: z.literal("complaint_photo"), id: z.number().int().positive() }),
]);

export const googleDriveRouter = router({
  /** Estado do Drive da pessoa (ligado? autorizado?) e se há Shared Drive. */
  status: protectedProcedure.query(async ({ ctx }) => {
    const { driveStatus } = await import("./driveService");
    return driveStatus(ctx.user.id);
  }),

  /** Token curto (só drive.file) para o Google Picker da própria pessoa; null = colar o link. */
  pickerToken: protectedProcedure.mutation(async ({ ctx }) => {
    const { pickerAccessToken } = await import("./driveService");
    try { return await pickerAccessToken(ctx.user.id); } catch { return null; }
  }),

  links: router({
    list: protectedProcedure.input(driveLinkInputSchema).query(async ({ ctx, input }) => {
      const { assertDriveEntityAccess } = await import("./driveAccess");
      const { listEntityLinks } = await import("./driveService");
      const info = await assertDriveEntityAccess(ctx.user as CtxUser, input.entityType, input.entityId, "view");
      const canEdit = await assertDriveEntityAccess(ctx.user as CtxUser, input.entityType, input.entityId, "edit").then(() => true, () => false);
      return { label: info.label, canEdit, hasSharedFolder: !!info.folder, links: await listEntityLinks(info.type, info.id) };
    }),
    attach: protectedProcedure
      .input(driveLinkInputSchema.extend({ link: z.string().trim().min(10).max(1000), name: z.string().trim().max(200).nullable().optional(), source: z.enum(["link", "picker"]).default("link") }))
      .mutation(async ({ ctx, input }) => {
        const { attachDriveFile } = await import("./driveService");
        return attachDriveFile(ctx.user as CtxUser, input);
      }),
    remove: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const { removeDriveLink } = await import("./driveService");
      await removeDriveLink(ctx.user as CtxUser, input.id);
      return { ok: true };
    }),
  }),

  /** "Guardar no Drive" (pasta "Multipark" da pessoa). */
  save: protectedProcedure.input(z.object({ source: saveSourceSchema, linkToRecord: z.boolean().optional() })).mutation(async ({ ctx, input }) => {
    const { saveToUserDrive } = await import("./driveService");
    const r = await saveToUserDrive(ctx.user as CtxUser, input.source, { linkToRecord: input.linkToRecord });
    return { name: r.file.name, url: r.file.webViewLink, linkId: r.linkId };
  }),

  templates: router({
    /** Modelos ativos que se aplicam a um registo (para "Gerar documento"). */
    forEntity: protectedProcedure.input(z.object({ entityType: z.enum(DRIVE_ENTITY_TYPES) })).query(async ({ input }) => {
      const { listTemplates } = await import("./driveService");
      return (await listTemplates({ entityType: input.entityType })).map((t) => ({ id: t.id, name: t.name, templateType: t.templateType, description: t.description }));
    }),
    all: protectedProcedure.query(async ({ ctx }) => {
      adminOnly(ctx.user as CtxUser);
      const { listTemplates } = await import("./driveService");
      return listTemplates({ includeInactive: true });
    }),
    inspect: protectedProcedure.input(z.object({ link: z.string().trim().min(10).max(500) })).mutation(async ({ ctx, input }) => {
      adminOnly(ctx.user as CtxUser);
      const { inspectTemplate } = await import("./driveService");
      return inspectTemplate(input.link);
    }),
    save: protectedProcedure.input(docTemplateInputSchema.extend({ id: z.number().int().positive().nullable().optional() })).mutation(async ({ ctx, input }) => {
      adminOnly(ctx.user as CtxUser);
      const { saveTemplate } = await import("./driveService");
      return { id: await saveTemplate(ctx.user.id, input) };
    }),
    setActive: protectedProcedure.input(z.object({ id: z.number().int().positive(), active: z.boolean() })).mutation(async ({ ctx, input }) => {
      adminOnly(ctx.user as CtxUser);
      const { setTemplateActive } = await import("./driveService");
      await setTemplateActive(ctx.user.id, input.id, input.active);
      return { ok: true };
    }),
  }),

  /** "Gerar documento" (passo 1: cópia + marcadores). */
  generate: protectedProcedure
    .input(z.object({
      templateId: z.number().int().positive(),
      entityType: z.enum(GENERATE_ENTITY_TYPES as unknown as [GenerateEntityType, ...GenerateEntityType[]]),
      entityId: z.string().trim().min(1).max(320),
      // "app" = RH: só o PDF nos documentos da ficha (nunca fica no Drive).
      destination: z.enum(GENERATE_DESTINATIONS),
    }))
    .mutation(async ({ ctx, input }) => {
      const { generateDocument } = await import("./driveService");
      const r = await generateDocument(ctx.user as CtxUser, input);
      return {
        linkId: r.linkId, url: r.file?.webViewLink ?? null, name: r.file?.name ?? null, replaced: r.replaced, missing: r.missing, warnings: r.warnings,
        employeeDocumentId: r.employeeDocumentId,
      };
    }),
  /** Passo 2 (pedido à parte, por causa do limite de 60 s): PDF anexado ao registo. */
  pdf: protectedProcedure.input(z.object({ linkId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const { exportGeneratedPdf } = await import("./driveService");
    const r = await exportGeneratedPdf(ctx.user as CtxUser, input.linkId);
    return { linkId: r.linkId, url: r.file.webViewLink, name: r.file.name, employeeDocumentId: r.employeeDocumentId };
  }),

  sheets: router({
    /** "Exportar para Sheets": mesmos dados (e permissões) da página. */
    export: protectedProcedure.input(sheetExportInputSchema).mutation(async ({ ctx, input }) => {
      const { exportReportToSheets } = await import("./driveService");
      const { appRouter } = await import("../routers");
      const caller: any = appRouter.createCaller({ req: (ctx as any).req, res: (ctx as any).res, user: ctx.user, accessDenied: false } as any);
      const call = (path: string, i?: unknown) => {
        const fn = path.split(".").reduce((o: any, k) => (o == null ? o : o[k]), caller);
        if (typeof fn !== "function") throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Relatório indisponível." });
        return fn(i);
      };
      return exportReportToSheets(ctx.user as CtxUser, input, call);
    }),
    /** Importar de uma folha Google → CSV para a importação existente (mesma validação). */
    readCsv: protectedProcedure
      .input(z.object({ link: z.string().trim().min(10).max(1000), purpose: z.enum(SHEET_IMPORT_PURPOSES), sheetTitle: z.string().max(100).nullable().optional() }))
      .mutation(async ({ ctx, input }) => {
        const { readSheetAsCsv } = await import("./driveService");
        return readSheetAsCsv(ctx.user as CtxUser, input);
      }),
  }),

  /** Definições → Comunicação → Google Drive (admin vê; só o super admin grava). */
  settings: router({
    get: protectedProcedure.query(async ({ ctx }) => {
      adminOnly(ctx.user as CtxUser);
      const { loadDriveConfig, getDriveState } = await import("./driveService");
      const { dwdConfigured, workspaceConfig } = await import("./workspace");
      const { getDb } = await import("../db");
      const { sql } = await import("drizzle-orm");
      let mirror: Array<{ sourceType: string; status: string; n: number }> = [];
      try {
        const d = await getDb();
        const res: any = d ? await d.execute(sql`SELECT sourceType, status, COUNT(*) AS n FROM google_drive_mirror GROUP BY sourceType, status`) : [[]];
        mirror = (Array.isArray(res) ? res[0] : []).map((r: any) => ({ sourceType: String(r.sourceType), status: String(r.status), n: Number(r.n) }));
      } catch { mirror = []; }
      // Relatórios ao vivo: ver/configurar só o super admin (os admins não veem o link nem a configuração).
      const isSuper = (ctx.user as CtxUser).role === "super_admin";
      const config = await loadDriveConfig();
      return {
        canEdit: isSuper,
        canSeeLive: isSuper,
        config: isSuper ? config : { ...config, liveDriveName: "", liveReports: { ...config.liveReports, enabled: false, reports: [] }, liveRunAsUserId: null },
        dwd: dwdConfigured(),
        serviceAccountEmail: workspaceConfig().serviceAccount?.client_email ?? null,
        liveSpreadsheetUrl: isSuper ? await getDriveState("live:spreadsheetUrl") : null,
        liveLastRunAt: isSuper ? await getDriveState("live:lastRunAt") : null,
        mirror,
      };
    }),
    save: protectedProcedure.input(driveConfigSchema).mutation(async ({ ctx, input }) => {
      superOnly(ctx.user as CtxUser);
      const { setSetting } = await import("../appSettings");
      try {
        // Os relatórios ao vivo correm com as permissões de quem os configurou.
        const value = { ...input, liveRunAsUserId: input.liveReports.enabled ? ctx.user.id : null };
        const r = await setSetting("google.drive", value, ctx.user.id);
        try {
          const { logActivity } = await import("../db");
          if (r.changed) await logActivity({ userId: ctx.user.id, action: "update", entity: "app_setting", entityId: null, details: `google.drive = ${JSON.stringify(r.value)}` } as any);
        } catch { /* registo */ }
        return { ok: true };
      } catch (err: any) {
        throw new TRPCError({ code: "BAD_REQUEST", message: String(err?.message ?? err) });
      }
    }),
    runNow: protectedProcedure.mutation(async ({ ctx }) => {
      adminOnly(ctx.user as CtxUser);
      const { runDriveJobs } = await import("./driveJobs");
      // Relatórios ao vivo: só quando é o super admin a pedir.
      return runDriveJobs({ deadlineAt: Date.now() + 40_000, includeLive: (ctx.user as CtxUser).role === "super_admin" });
    }),
  }),
});
