/**
 * Router `rh` (Recursos Humanos: fichas, documentos, ponto, férias, folha,
 * penalizações…) — saiu do routers.ts a 1 out 2026 (P2, só mudança de sítio).
 * Quem vê o quê: server/rhGuards.ts + server/rhAccess.ts.
 */
import { TRPCError } from "@trpc/server";
import { scopedProjectIds, assertEmployeeAccess, assertProjectAccess } from './cityScope';
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { canAccess, requireAccess } from "./_core/access";
import { superAdminGuard } from "./userAdminRules";
import { guardedAccountChange } from "./superAdminLock";
import { DEACTIVATION_NOTES_MAX, DEACTIVATION_REASON_CODES, DEACTIVATION_REASON_OTHER_MAX } from "../shared/deactivationReasons";
import { canViewEmployee, canViewTimeAndSchedule, canEditPersonal, canEditContract, canDeleteDocument, employeeAccess, sanitizeEmployee, sanitizeEmployeeRows, isOwn, PERSONAL_FIELDS, CONTRACT_FIELDS, type EmployeeRef, isRhAdmin, canEditIdentity, isRhFor, canChangeIbanDirectly, canApproveIbanRequests, canManageEmployee, contractEditError, createEmployeeError, selfUploadDocTypeError, canValidateDocuments, documentUploadError, initialDocumentStatus, canViewInternalNotes, canEditInternalNote } from "./rhAccess";
import { applyDocsCompliance, detectExtraDiaNoShows, listPendingPenalties, reviewPenalty, listSuspiciousTimeRecords, reviewTimeRecord, insertTimeRecordAtomic, createPayrollRun, listPayrollRuns, getPayrollRun, transitionPayrollRun } from "./rhService";
import { matchKey } from "../shared/textKey";
import { importExtrasFromCsv } from "./extrasImport";
import { PHOTO_MAX_BASE64_CHARS } from "./photoUpload";
import { DOC_REJECT_REASON_MAX, DOC_TYPE_LABELS } from "../shared/employeeDocuments";
import { NOTE_BODY_MAX, NOTE_EDIT_WINDOW_MS, NOTE_KINDS, NOTE_KIND_LABELS } from "../shared/employeeNotes";
import { docsRequestRouter } from "./rhDocsRequestRouter";

/** 41c: ~10 MB por documento (base64 ≈ 4/3 do ficheiro). */
const DOC_MAX_BASE64_CHARS = 14_000_000;

/** 41c: na própria ficha, cada um carrega os SEUS documentos (contrato, anexos, termo e seguro são do RH). */
async function assertSelfUploadDocType(user: { id: number; role: string }, employeeId: number, docType: string): Promise<void> {
  const err = selfUploadDocTypeError(await rhViewer(user), await rhEmployeeRefOrThrow(employeeId), docType);
  if (err) throw new TRPCError({ code: "FORBIDDEN", message: err });
}

/**
 * Jorge (7 out 2026): entrega a 1.ª vez, volta a entregar enquanto pendente
 * ou recusado, nunca depois de validado (só o RH substitui). Devolve o estado
 * e quem valida, para gravar com o ficheiro (o RH carrega já validado).
 */
async function documentUploadPlan(user: { id: number; role: string }, employeeId: number, docType: string): Promise<{ status: "pending" | "validated"; validatedById: number | null; validatedAt: string | null }> {
  const viewer = await rhViewer(user);
  const ref = await rhEmployeeRefOrThrow(employeeId);
  const { activeDocStatuses } = await import("./rhDocuments");
  const err = documentUploadError(viewer, ref, docType, await activeDocStatuses(employeeId, docType));
  if (err) throw new TRPCError({ code: "FORBIDDEN", message: err });
  const status = initialDocumentStatus(viewer, ref);
  return status === "validated"
    ? { status, validatedById: user.id, validatedAt: new Date().toISOString().slice(0, 19).replace("T", " ") }
    : { status, validatedById: null, validatedAt: null };
}

/**
 * Validar/recusar documentos e a carta: o módulo RH com "editar", a ficha na
 * cidade de quem pede e canValidateDocuments (o RH da ficha; nunca a própria).
 */
async function assertCanValidateDocuments(user: { id: number; role: string }, employeeId: number): Promise<EmployeeRef> {
  requireAccess(user as any, "rh", "edit");
  const viewer = await rhViewer(user);
  const ref = await rhEmployeeRefOrThrow(employeeId);
  if (!canValidateDocuments(viewer, ref)) {
    throw new TRPCError({ code: "FORBIDDEN", message: isOwn(viewer, employeeId) ? "Os teus documentos são validados por outra pessoa do RH." : "Só o RH desta ficha valida ou recusa documentos." });
  }
  await assertEmployeeAccess(employeeId);
  return ref;
}

/** Documento recusado → aviso à própria pessoa (sino + email), com o motivo. Nunca lança. */
async function notifyDocumentRejected(employeeId: number, docType: string, reason: string): Promise<void> {
  try {
    const emp = (await getEmployeeById(employeeId))?.employee;
    if (!emp?.userId) return;
    const { notify } = await import("./notify");
    await notify({
      kind: "my_doc_rejected", targetUserId: emp.userId,
      title: `Documento recusado: ${DOC_TYPE_LABELS[docType] ?? docType}`,
      body: `Motivo: ${reason}. Carrega-o de novo na tua ficha.`, link: "/perfil",
      entity: { type: "employee_document_rejected", id: `${employeeId}:${docType}:${Date.now()}` },
    });
  } catch (err) {
    console.warn("[documents.reject] aviso à pessoa falhou:", String((err as any)?.message ?? err).slice(0, 160));
  }
}

/**
 * Notas internas: o módulo RH com "ver", a ficha na cidade de quem pede e
 * canViewInternalNotes (team leader e acima no seu âmbito; NUNCA a própria).
 */
async function notesContext(user: { id: number; role: string }, employeeId: number): Promise<{ viewer: Awaited<ReturnType<typeof rhViewer>>; ref: EmployeeRef }> {
  requireAccess(user as any, "rh", "view");
  const viewer = await rhViewer(user);
  const ref = await rhEmployeeRefOrThrow(employeeId);
  if (!canViewInternalNotes(viewer, ref)) throw new TRPCError({ code: "FORBIDDEN", message: "Sem acesso às notas internas desta ficha." });
  await assertEmployeeAccess(employeeId);
  return { viewer, ref };
}
import { getAllUsers, createManualUser, getUserByEmail, getOpenPenalties, clearPenalty, unblockEmployeeLogin, getEmployeeLeaves, createEmployeeLeave, deleteEmployeeLeave, getEmployeeSalaryHistory, getRhDashboardSummary, toggleUserActive, deactivationColumns, getUserById, resolveProjectIds, logActivity, getAllEmployees, getEmployeeById, getEmployeeByUserId, createEmployee, updateEmployee, deleteEmployee, getEmployeeDocuments, createEmployeeDocument, archiveEmployeeDocument, getDocumentChecklistForEmployee, getAllEmployeesDocumentStatus, getEmployeeSchedules, upsertSchedule, deleteSchedule, getTimeRecords, checkGeofenceNote, setProjectGeofence, deleteProjectGeofence, listProjectGeofences, getMonthlyHours, getExtraRates, seedExtraRates, updateExtraRate, getHRStats, createInviteToken, countActiveSuperAdmins, getPayrollData, savePayslipRecord } from "./db";
import { generatePayrollPdf } from "./payrollPdf";
import { generatePayslipPdf, generateAllPayslipsPdf } from "./payslipPdf";
import { ROLE_HIERARCHY, requireRole, resolveDeactivationOrThrow } from "./routerGuards";
import { rhViewer, rhEmployeeRef, employeeAccountRole, rhEmployeeRefOrThrow, assertEmployeeWriteScope, assertOwnOrScopedEmployee, assertCanViewDocuments, assertCanViewTimeRecords, assertCanUploadDocuments, assertCanManageEmployee, requireNationalRhManage, employeeIdOfRecord } from "./rhGuards";

/**
 * 19c: grava a foto de perfil VALIDADA (tipo pelos primeiros bytes, ≤ 4 MB,
 * extensão da lista) e regista a troca — esta foto é a referência da selfie
 * do ponto: trocar por outra sem rasto permitia picar por um colega.
 */
async function savePhoto(employeeId: number, fileBase64: string, byUserId: number): Promise<{ url: string; key: string }> {
  const { checkProfilePhoto } = await import("./photoUpload");
  const photo = checkProfilePhoto(fileBase64);
  if (!photo.ok) throw new TRPCError({ code: "BAD_REQUEST", message: photo.error });
  const before = (await getEmployeeById(employeeId))?.employee ?? null;
  const { storagePut } = await import("./storage");
  const key = `employees/${employeeId}/photo-${Date.now()}.${photo.ext}`;
  const { url } = await storagePut(key, photo.buffer, photo.mime);
  await updateEmployee(employeeId, { photoUrl: url, photoKey: key });
  await logActivity({ userId: byUserId, action: "photo", entity: "employee", entityId: employeeId,
    details: `Foto de ${before?.fullName ?? `#${employeeId}`} trocada: ${before?.photoKey ?? "sem foto"} → ${key}` });
  return { url, key };
}

export const rhRouter = router({
  // Envios automáticos da aplicação a este colaborador/extra (pedidos e
  // lembretes de disponibilidade, avisos de escala…) — não aparecem na caixa
  // partilhada; ficam aqui, com o estado enviado/respondido.
  autoMail: protectedProcedure
    .input(z.object({ employeeId: z.number() }))
    .query(async ({ ctx, input }) => {
      const viewer = await rhViewer(ctx.user);
      const person = await getEmployeeById(input.employeeId);
      if (!person) throw new TRPCError({ code: 'NOT_FOUND' });
      await assertEmployeeAccess(input.employeeId);
      if (!canViewEmployee(viewer, person.employee)) throw new TRPCError({ code: 'FORBIDDEN' });
      const { listAutoSendsForEmployee } = await import("./mail/autoSends");
      return listAutoSendsForEmployee(input.employeeId, 30);
    }),
  accountSummary: protectedProcedure
    .input(z.object({ employeeId: z.number() }))
    .query(async ({ ctx, input }) => {
      const viewer = await rhViewer(ctx.user);
      const person = await getEmployeeById(input.employeeId);
      if (!person) throw new TRPCError({ code: 'NOT_FOUND' });
      await assertEmployeeAccess(input.employeeId);
      if (!canViewEmployee(viewer, person.employee)) throw new TRPCError({ code: 'FORBIDDEN' });
      if (!person.employee.userId) return null;
      const account = await getUserById(person.employee.userId);
      if (!account) return null;
      const { getUserPermissionOverrides } = await import('./db');
      const { loadCityAccess } = await import('./cityAccess');
      const { userAccessSummary } = await import('../shared/userAccessSummary');
      const [overrides, cities] = await Promise.all([getUserPermissionOverrides(account.id), loadCityAccess(account.id, account.role)]);
      const allowedIds = scopedProjectIds();
      const canManage = ['admin', 'super_admin'].includes(ctx.user.role)
        && (!allowedIds || (!cities.all && !cities.missingCostCenter && cities.projectIds.every(id => allowedIds.includes(id))));
      return { id: account.id, name: account.name, email: account.email, isActive: account.isActive,
        ...userAccessSummary(account.role, overrides, cities), cities, canManage };
    }),
  /**
   * 41a: os agentes da Multipark desta ficha (principal + extra), para o cartão
   * "Utilizador e permissões". Ver: quem vê a ficha; ligar/separar: quem gere o RH.
   */
  agentSummary: protectedProcedure
    .input(z.object({ employeeId: z.number() }))
    .query(async ({ ctx, input }) => {
      const viewer = await rhViewer(ctx.user);
      const person = await getEmployeeById(input.employeeId);
      if (!person) throw new TRPCError({ code: 'NOT_FOUND' });
      await assertEmployeeAccess(input.employeeId);
      if (!canViewEmployee(viewer, person.employee)) throw new TRPCError({ code: 'FORBIDDEN' });
      const { getDb } = await import('./db');
      const { sql } = await import('drizzle-orm');
      const db = await getDb();
      const extra = db ? ((await db.execute(sql`SELECT agentUserId, agentName FROM employee_agents WHERE employeeId = ${input.employeeId} ORDER BY agentUserId`).catch(() => [[]])) as any)[0] ?? [] : [];
      const { getSetting } = await import('./appSettings');
      const { multiparkAgentUrl } = await import('./personIdentity');
      const template = await getSetting('multipark.agentUrl').catch(() => null);
      const e = person.employee as { multiparkAgentUserId?: string | null; multiparkAgentName?: string | null };
      const agents: Array<{ agentUserId: string | null; agentName: string | null; principal: boolean; url: string | null }> = [];
      if (e.multiparkAgentUserId || e.multiparkAgentName) {
        agents.push({ agentUserId: e.multiparkAgentUserId ?? null, agentName: e.multiparkAgentName ?? null, principal: true, url: multiparkAgentUrl(template, e.multiparkAgentUserId) });
      }
      for (const a of extra as Array<{ agentUserId: string; agentName: string | null }>) {
        agents.push({ agentUserId: String(a.agentUserId), agentName: a.agentName ?? null, principal: false, url: multiparkAgentUrl(template, String(a.agentUserId)) });
      }
      // "Abrir agente" leva a Pessoas → Condutores e agentes (módulo Críticas)
      return { agents, canManageLinks: canAccess(ctx.user, 'rh', 'manage'), canOpenAgent: canAccess(ctx.user, 'criticas', 'view'), hasAgentUrl: !!String(template ?? '').trim() };
    }),
  // ── MY PROFILE (for extra/low-role users) ──────────────────────────────────────────────────
  me: protectedProcedure.query(async ({ ctx }) => {
    return getEmployeeByUserId(ctx.user.id);
  }),

  // ── RECRUTAMENTO (emails recebidos em recursos-humanos@) ───────────────────
  recruitmentEmails: protectedProcedure.query(async ({ ctx }) => {
    requireAccess(ctx.user, "leads_extras", "view");
    const { getDb, listInboundEmailsByAlias } = await import("./db");
    // Erro ≠ vazio (18b): sem BD diz-se, em vez de "não há emails".
    if (!(await getDb())) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Base de dados indisponível" });
    // 41d: cada email diz onde está (por tratar / pronta / lixo) e se foi para o lixo sozinho.
    const { recruitmentStateOf } = await import("../shared/recruitmentEmails");
    const rows = await listInboundEmailsByAlias("recursos-humanos", 300);
    return rows.map((e: any) => { const s = recruitmentStateOf(e); return { ...e, state: s.state, autoTrash: s.auto }; });
  }),

  /**
   * 41d: mudar um ou vários emails de sítio — "Pronta", "Lixo" ou "Repor" (por
   * tratar). Nada se apaga; fica registado quem e quando. Só emails de
   * recrutamento.
   */
  setRecruitmentState: protectedProcedure
    .input(z.object({ ids: z.array(z.number().int().positive()).min(1).max(300), state: z.enum(["open", "done", "trash"]) }))
    .mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "leads_extras", "edit");
      const { getDb } = await import("./db");
      const { and, eq, inArray } = await import("drizzle-orm");
      const database = await getDb();
      if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "BD indisponível" });
      const { inboundEmails } = await import("../drizzle/schema");
      const ids = Array.from(new Set(input.ids));
      const now = new Date().toISOString().slice(0, 19).replace("T", " ");
      const res: any = await database.update(inboundEmails)
        .set({ recruitmentState: input.state, recruitmentStateAt: now, recruitmentStateById: ctx.user.id })
        .where(and(inArray(inboundEmails.id, ids), eq(inboundEmails.alias, "recursos-humanos")));
      const changed = Number(res?.[0]?.affectedRows ?? res?.affectedRows ?? 0);
      if (!changed) throw new TRPCError({ code: "NOT_FOUND", message: "Email de recrutamento não encontrado." });
      const label = input.state === "done" ? "pronta(s)" : input.state === "trash" ? "no lixo" : "repostos (por tratar)";
      await logActivity({ userId: ctx.user.id, action: "recruitment_state", entity: "inbound_emails", entityId: ids.length === 1 ? ids[0] : undefined, details: `${changed} email(s) ${label} · ids ${ids.slice(0, 60).join(",")}`.slice(0, 1000) });
      return { changed };
    }),

  // Notas internas do backoffice sobre um email/candidato de recrutamento.
  setRecruitmentNotes: protectedProcedure
    .input(z.object({ id: z.number(), notes: z.string().max(10000) }))
    .mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "leads_extras", "edit");
      const { getDb } = await import("./db");
      const { eq } = await import("drizzle-orm");
      const database = await getDb();
      if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "BD indisponível" });
      const { inboundEmails } = await import("../drizzle/schema");
      const { and } = await import("drizzle-orm");
      // Só emails de recrutamento (18b: antes gravava em qualquer email, ex.: reclamações) e fica registado.
      const res: any = await database.update(inboundEmails).set({ notes: input.notes.trim() || null })
        .where(and(eq(inboundEmails.id, input.id), eq(inboundEmails.alias, "recursos-humanos")));
      if (Number(res?.[0]?.affectedRows ?? res?.affectedRows ?? 0) === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Email de recrutamento não encontrado." });
      await logActivity({ userId: ctx.user.id, action: "recruitment_notes", entity: "inbound_emails", entityId: input.id, details: (input.notes.trim() || "(notas apagadas)").slice(0, 300) });
      return { ok: true };
    }),

  replyRecruitment: protectedProcedure
    .input(z.object({
      to: z.string().email(),
      subject: z.string().min(1),
      body: z.string().min(1),
      fromAlias: z.enum(["criticas", "reclamacoes", "perdidos", "recursos-humanos"]).optional(),
      // Inclui link de registo: cria conta para o candidato e gera /convite/:token.
      includeRegisterLink: z.boolean().optional(),
      // 41d: o email respondido passa a "Pronta" (sai da lista; "Repor" devolve-o).
      emailId: z.number().int().positive().optional(),
      candidateName: z.string().optional(),
      origin: z.string().url().optional(),
      // Ficheiros já enviados para /api/upload — o servidor descarrega-os
      // (link assinado se forem do bucket) e envia como anexos do email.
      attachments: z.array(z.object({
        filename: z.string().min(1).max(255),
        url: z.string().url().startsWith("https://"),
      })).max(5).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "leads_extras", "edit");
      // Criar a conta do candidato é gerir utilizadores (18b: antes qualquer TL criava contas "extra").
      if (input.includeRegisterLink && !canAccess(ctx.user, "utilizadores", "edit")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Só quem gere utilizadores pode criar a conta do candidato (link de registo)." });
      }
      const { sendEmail } = await import("./mail/systemMail");

      const emailAttachments: Array<{ filename: string; content: Buffer }> = [];
      const { storageReadableUrl } = await import("./storageSign");
      for (const a of input.attachments ?? []) {
        // ficheiro do nosso bucket → link assinado (o bucket deixa de ser público)
        const resp = await fetch(await storageReadableUrl(a.url));
        if (!resp.ok) throw new TRPCError({ code: "BAD_REQUEST", message: `Anexo "${a.filename}" inacessível (HTTP ${resp.status})` });
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length > 10 * 1024 * 1024) throw new TRPCError({ code: "BAD_REQUEST", message: `Anexo "${a.filename}" excede 10 MB` });
        emailAttachments.push({ filename: a.filename, content: buf });
      }
      // Recrutamento responde sempre pela recursos-humanos@ (18b: dava para responder como criticas@ ou reclamacoes@).
      const from = "recursos-humanos@multipark.pt";
      const fromName = "Multipark Recrutamento";

      let body = input.body;
      let inviteLink: string | null = null;
      if (input.includeRegisterLink) {
        if (!input.origin) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Falta o origin para gerar o link de registo." });
        }
        // Cria (ou reutiliza) a conta do candidato e gera o token de convite.
        let user = await getUserByEmail(input.to);
        if (!user) {
          user = await createManualUser({ name: input.candidateName || input.to, email: input.to, role: "extra" });
        }
        if (!user) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar a conta do candidato." });
        const invite = await createInviteToken({ email: input.to, userId: user.id, invitedById: ctx.user.id });
        inviteLink = `${input.origin.replace(/\/+$/, "")}/convite/${invite.token}`;
        body = `${input.body}\n\n— — —\nPara te registares na plataforma Multipark, abre este link e entra com a tua conta Google:\n${inviteLink}`;
      }

      const ok = await sendEmail({
        to: input.to, subject: input.subject, text: body, from, fromName,
        ...(emailAttachments.length ? { attachments: emailAttachments } : {}),
      });
      await logActivity({
        userId: ctx.user.id,
        action: "email_reply",
        entity: "recruitment",
        details: `Resposta a ${input.to}: ${input.subject.slice(0, 80)}${inviteLink ? " (+link registo)" : ""}${emailAttachments.length ? ` (+${emailAttachments.length} anexo${emailAttachments.length > 1 ? "s" : ""})` : ""}`,
      });
      if (!ok) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Envio de email (Gmail) não configurado ou falhou o envio" });
      // 41d: respondido = pronto (sai de "Por tratar"; "Repor" devolve-o). Falhar aqui não desfaz o envio.
      let markedDone = false;
      if (input.emailId) {
        try {
          const { getDb } = await import("./db");
          const { and, eq } = await import("drizzle-orm");
          const { inboundEmails } = await import("../drizzle/schema");
          const database = await getDb();
          if (database) {
            const now = new Date().toISOString().slice(0, 19).replace("T", " ");
            const r: any = await database.update(inboundEmails).set({ recruitmentState: "done", recruitmentStateAt: now, recruitmentStateById: ctx.user.id })
              .where(and(eq(inboundEmails.id, input.emailId), eq(inboundEmails.alias, "recursos-humanos")));
            markedDone = Number(r?.[0]?.affectedRows ?? r?.affectedRows ?? 0) > 0;
          }
        } catch (err) { console.warn("[recrutamento] marcar como pronta falhou:", String((err as any)?.message ?? err).slice(0, 200)); }
      }
      return { ok, inviteLink, markedDone };
    }),

  // Resumo do mês actual para o próprio colaborador: horas + valor a receber.
  // Admin pode ver de outros passando employeeId; o próprio só vê o seu.
  myMonthSummary: protectedProcedure
    .input(z.object({ employeeId: z.number().optional(), year: z.number().optional(), month: z.number().optional() }).optional())
    .query(async ({ ctx, input }) => {
      let employeeId = input?.employeeId;
      if (!employeeId) {
        const me = await getEmployeeByUserId(ctx.user.id);
        if (!me) throw new TRPCError({ code: "NOT_FOUND", message: "Sem ficha de colaborador" });
        employeeId = me.employee.id;
      }
      // Restringe: salários de outros são só para admin+ DA MESMA cidade;
      // abaixo disso cada um só vê o seu próprio resumo
      await assertOwnOrScopedEmployee(ctx.user, employeeId, "admin");
      const now = new Date();
      const year = input?.year ?? now.getFullYear();
      const month = input?.month ?? (now.getMonth() + 1);
      const payroll = await getPayrollData(year, month);
      const row = payroll.find((r: any) => r.employeeId === employeeId);
      if (!row) return null;
      return {
        year,
        month,
        fullName: row.fullName,
        isExtra: row.isExtra,
        totalHours: row.totalHours,
        daysWorked: row.daysWorked,
        hourlyRate: row.hourlyRate,
        baseSalary: row.baseSalary,
        extraPayment: row.extraPayment,
        overtimePayment: row.overtimePayment,
        nightPayment: row.nightPayment,
        weekendPayment: row.weekendPayment,
        mealAllowance: row.mealAllowance,
        totalPayment: row.totalPayment,
        tsuEmployee: row.tsuEmployee,
        irsEstimate: row.irsEstimate,
        netEstimate: row.netEstimate,
      };
    }),

  // ── ROSTER MÍNIMO ──────────────────────────────────────────────────────────────────────────
  // Lista pública (id + fullName) para selectors em qualquer página
  // (atribuir responsáveis, condutores envolvidos, etc.). Sem requireRole
  // para que frontoffice/team_leader/extra possam usar dropdowns também.
  roster: protectedProcedure
    .input(z.object({ activeOnly: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      requireRole(ctx.user.role, "extra"); // lista mínima (id+nome) p/ dropdowns; user não acede
      let rows = await getAllEmployees({ isActive: input?.activeOnly ?? true });
      // Âmbito de cidade (inclui extras): só colaboradores das cidades
      // autorizadas — e nunca mais do que id + nome.
      const allowedIds = scopedProjectIds();
      if (allowedIds) rows = rows.filter((r: any) => r.employee.projectId != null && allowedIds.includes(r.employee.projectId));
      return rows.map((row: any) => ({
        id: row.employee.id,
        fullName: row.employee.fullName,
      }));
    }),

  // ── STATS ──────────────────────────────────────────────────────────────────────────────────
  stats: protectedProcedure.query(async ({ ctx }) => {
    requireAccess(ctx.user, "rh", "view");
    await seedExtraRates();
    return getHRStats();
  }),

  // Última vez que cada colaborador trabalhou (cartões dos extras:
  // disponibilidade, extras-dia, avaliações)
  lastWorkedMap: protectedProcedure.query(async ({ ctx }) => {
    requireAccess(ctx.user, "rh", "view");
    const { getLastWorkedMap } = await import("./db");
    return getLastWorkedMap();
  }),

  // ── EMPLOYEES ─────────────────────────────────────────────────────────────────────────────────
  // Permissões por FINALIDADE (server/rhAccess.ts): frontoffice/team_leader
  // veem a lista operacional sem NIF/NIB/morada/nascimento/salário de
  // terceiros; supervisor só o seu centro; extra só a própria ficha.
  list: protectedProcedure
    .input(z.object({ isActive: z.boolean().optional(), position: z.string().optional(), projectId: z.number().optional() }).optional())
    .query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "rh", "view");
      const viewer = await rhViewer(ctx.user);
      let rows = await getAllEmployees({ isActive: input?.isActive, position: input?.position });
      const allowedIds = scopedProjectIds();
      if (allowedIds) rows = rows.filter(r => r.employee.projectId != null && allowedIds.includes(r.employee.projectId));
      // filtro global de cidade/centro (com descendentes)
      if (input?.projectId) {
        const ids = new Set(await resolveProjectIds(input.projectId));
        rows = rows.filter((r: any) => r.employee.projectId != null && ids.has(r.employee.projectId));
      }
      // role da conta de cada ficha: fichas de admin/super_admin ficam
      // protegidas de quem está abaixo (dados pessoais escondidos).
      // (também para admins: a ficha de um super_admin fica mascarada a um admin, como no detalhe)
      const roleByUserId = new Map<number, string>();
      for (const u of await getAllUsers()) roleByUserId.set(u.id, u.role);
      const visible = sanitizeEmployeeRows(viewer, rows as any[], (emp) => (emp.userId != null ? roleByUserId.get(emp.userId) : null));
      // Jorge (7 out 2026): estado da carta em cada ficha (etiqueta e filtro da lista).
      const { licenceStatusesOrNull } = await import("./rhDocuments");
      const licences = await licenceStatusesOrNull(visible.map((r: any) => r.employee));
      return visible.map((r: any) => ({ ...r, licence: licences?.get(r.employee.id) ?? null }));
    }),

  byId: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const viewer = await rhViewer(ctx.user);
      // A própria ficha vê-se sempre; as outras respeitam o módulo RH (incluindo um override "nenhum").
      if (!isOwn(viewer, input.id)) requireAccess(ctx.user, "rh", "view");
      const result = await getEmployeeById(input.id);
      if (!result) return result;
      const ref: EmployeeRef = { id: result.employee.id, projectId: result.employee.projectId ?? null, role: await employeeAccountRole(result.employee.userId ?? null) };
      if (!isOwn(viewer, ref.id)) await assertEmployeeAccess(input.id);
      if (!canViewEmployee(viewer, ref)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão" });
      }
      // `access` diz ao cliente o que este utilizador pode fazer na ficha;
      // `licence` = estado da carta (Jorge, 7 out 2026). As notas internas
      // NUNCA vêm aqui (o próprio também chama o byId) — só em rh.notes.*.
      const { licenceStatusesOrNull } = await import("./rhDocuments");
      const licence = (await licenceStatusesOrNull([result.employee]))?.get(result.employee.id) ?? null;
      return { ...result, employee: sanitizeEmployee(viewer, result.employee as any, ref.role), access: employeeAccess(viewer, ref), licence };
    }),

  create: protectedProcedure
    .input(z.object({
      fullName: z.string().min(1),
      email: z.string().email(),
      // Opcional: a ligação automática (identity sweep) encontra o agente sozinha
      multiparkAgentName: z.string().trim().max(256).optional(),
      phone: z.string().optional(),
      // Contactos pessoais — só internos (extras usam o pessoal como principal)
      personalEmail: z.string().email().optional(),
      personalPhone: z.string().optional(),
      nif: z.string().optional(),
      nib: z.string().optional(),
      address: z.string().optional(),
      birthDate: z.string().optional(),
      nationality: z.string().optional(),
      position: z.enum(["director","supervisor","team_leader","backoffice","frontoffice","senior_driver","driver","extra"]),
      extraLevel: z.number().min(1).max(5).optional(),
      department: z.string().optional(),
      projectId: z.number().optional(),
      contractType: z.enum(["permanent","fixed_term","extra"]).optional(),
      contractStart: z.string().optional(),
      contractEnd: z.string().optional(),
      monthlySalary: z.string().optional(),
      mealAllowancePerDay: z.string().optional(),
      userId: z.number().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "rh", "manage");

      // ── ANTI-DUPLICAÇÃO (regra do Jorge): mesmo nome/email/NIF ativo = 1 só ficha
      const { getDb: getDbDup } = await import("./db");
      const { employees } = await import("../drizzle/schema");
      const { eq, and } = await import("drizzle-orm");
      const dbDup = await getDbDup();
      if (dbDup) {
        const norm = (s: string) => matchKey(s);
        const all = await dbDup.select({ id: employees.id, fullName: employees.fullName, email: employees.email, nif: employees.nif })
          .from(employees).where(eq(employees.isActive, 1));
        const dup = all.find((e) =>
          norm(e.fullName) === norm(input.fullName) ||
          (input.email && e.email && e.email.toLowerCase() === input.email.toLowerCase()) ||
          (input.nif && e.nif && e.nif.trim() === input.nif.trim()),
        );
        if (dup) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `Já existe um colaborador ativo com estes dados: ${dup.fullName} (#${dup.id}). Usa a ficha existente em vez de criar outra.` });
        }
      }

      // ── LIGAÇÃO ÚNICA: um utilizador/agente não pode pertencer a 2 fichas
      if (input.userId != null && dbDup) {
        const taken = await dbDup.select({ id: employees.id, fullName: employees.fullName })
          .from(employees).where(and(eq(employees.userId, input.userId), eq(employees.isActive, 1))).limit(1);
        if (taken[0]) throw new TRPCError({ code: "BAD_REQUEST", message: `Esse utilizador já está ligado a ${taken[0].fullName} (#${taken[0].id}).` });
      }
      if (dbDup && input.multiparkAgentName) {
        const agentTaken = await dbDup.select({ id: employees.id, fullName: employees.fullName })
          .from(employees).where(and(eq(employees.multiparkAgentName, input.multiparkAgentName), eq(employees.isActive, 1))).limit(1);
        if (agentTaken[0]) throw new TRPCError({ code: "BAD_REQUEST", message: `Esse agente Multipark já está ligado a ${agentTaken[0].fullName} (#${agentTaken[0].id}).` });
      }

      // ── Centro de custos: se não indicado, infere pela morada (Algarve→Faro…)
      let projectId = input.projectId ?? null;
      if (projectId == null) {
        const { inferCityProjectIdFromAddress } = await import("./db");
        projectId = await inferCityProjectIdFromAddress(input.address);
      }
      if (projectId == null) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Centro de custos obrigatório — escolhe um, ou preenche a morada para o sistema inferir a cidade." });
      }
      // 41c: o supervisor cria fichas na sua cidade, de team leader para baixo, sem salário nem conta à mão.
      {
        const createErr = createEmployeeError(await rhViewer(ctx.user), { position: input.position, projectId, monthlySalary: input.monthlySalary, mealAllowancePerDay: input.mealAllowancePerDay, userId: input.userId });
        if (createErr) throw new TRPCError({ code: "FORBIDDEN", message: createErr });
        assertProjectAccess(projectId);
      }

      // Regra do Jorge (2026-09-10): quem tem email válido tem utilizador com
      // ESSE email. Se o userId não vier explícito, depois de criar a ficha
      // liga-se ao utilizador que já exista com o email, ou cria-se um
      // (`manual_...`, adotado no 1º login Google) — ver ensureUserForEmployee.
      let userId = input.userId ?? null;

      const inserted = await createEmployee({
        fullName: input.fullName,
        email: input.email,
        multiparkAgentName: input.multiparkAgentName || null,
        phone: input.phone ?? null,
        personalEmail: input.position === "extra" ? null : (input.personalEmail?.trim().toLowerCase() || null),
        personalPhone: input.position === "extra" ? null : (input.personalPhone?.trim() || null),
        nif: input.nif ?? null,
        nib: input.nib ?? null,
        address: input.address ?? null,
        birthDate: input.birthDate ? new Date(input.birthDate).toISOString().slice(0, 19).replace("T", " ") : null,
        nationality: input.nationality ?? null,
        position: input.position,
        extraLevel: input.extraLevel ?? null,
        department: input.department ?? null,
        projectId,
        contractType: input.contractType ?? "permanent",
        contractStart: input.contractStart ? new Date(input.contractStart).toISOString().slice(0, 19).replace("T", " ") : null,
        contractEnd: input.contractEnd ? new Date(input.contractEnd).toISOString().slice(0, 19).replace("T", " ") : null,
        monthlySalary: input.monthlySalary ?? null,
        mealAllowancePerDay: input.mealAllowancePerDay ?? null,
        userId,
        isActive: 1,
      });
      const employeeId = Number((inserted as any)?.[0]?.insertId ?? (inserted as any)?.insertId) || null;
      let userCreated = false;
      if (userId == null && employeeId && dbDup) {
        const { ensureUserForEmployee } = await import("./identity");
        const r = await ensureUserForEmployee(dbDup, {
          id: employeeId,
          fullName: input.fullName,
          email: input.email,
          position: input.position,
          userId: null,
        }, { actorId: ctx.user.id });
        userId = r.userId;
        userCreated = r.created;
      }
      await logActivity({
        userId: ctx.user.id,
        action: "create",
        entity: "employee",
        entityId: employeeId ?? undefined,
        details: `Colaborador criado: ${input.fullName}${userId ? ` (utilizador #${userId}${userCreated ? " criado" : " ligado"})` : ""}`,
      });
      return { success: true, userId, userCreated };
    }),

  importExtras: protectedProcedure
    .input(z.object({ csv: z.string().min(1), projectId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "rh", "manage");
      assertProjectAccess(input.projectId);
      const report = await importExtrasFromCsv(input.csv, ctx.user.id, { projectId: input.projectId });
      await logActivity({
        userId: ctx.user.id,
        action: "import",
        entity: "employee",
        details: `Import extras CSV: ${report.created} criados, ${report.duplicates.length} duplicados saltados, ${report.errors.length} erros (de ${report.parsed} linhas)`,
      });
      return report;
    }),

  update: protectedProcedure
    .input(z.object({
      id: z.number(),
      fullName: z.string().min(1).optional(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
      // Contactos pessoais (null limpa). Só internos — ver abaixo.
      personalEmail: z.string().email().nullable().optional(),
      personalPhone: z.string().nullable().optional(),
      nif: z.string().optional(),
      nib: z.string().optional(),
      address: z.string().optional(),
      birthDate: z.string().optional(),
      nationality: z.string().optional(),
      photoUrl: z.string().optional(),
      photoKey: z.string().optional(),
      // 41c: n.º do documento de identificação e da carta (o próprio também muda).
      idDocNumber: z.string().trim().max(32).nullable().optional(),
      drivingLicenseNumber: z.string().trim().max(32).nullable().optional(),
      position: z.enum(["director","supervisor","team_leader","backoffice","frontoffice","senior_driver","driver","extra"]).optional(),
      extraLevel: z.number().min(1).max(5).optional(),
      department: z.string().optional(),
      projectId: z.number().optional(),
      contractType: z.enum(["permanent","fixed_term","extra"]).optional(),
      contractStart: z.string().optional(),
      contractEnd: z.string().optional(),
      monthlySalary: z.string().optional(),
      mealAllowancePerDay: z.string().optional(),
      userId: z.number().nullable().optional(),
      isActive: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Dois níveis (pedido Jorge 17 set): dados PESSOAIS (o próprio, ou
      // quem gere o centro — ver rhAccess) e CONTRATUAIS (só admin+). Um
      // pedido que traga campos dos dois exige as duas permissões.
      const viewer = await rhViewer(ctx.user);
      const ref = await rhEmployeeRefOrThrow(input.id);
      const sent = (keys: readonly string[]) => keys.some((k) => (input as any)[k] !== undefined);
      // 41c: admin+ muda tudo; o supervisor da cidade muda posto (até team
      // leader), centro (da cidade), contrato e ativo — sem dinheiro nem conta.
      const contractErr = sent(CONTRACT_FIELDS) ? contractEditError(viewer, ref, input as Record<string, unknown>) : null;
      if (contractErr) throw new TRPCError({ code: "FORBIDDEN", message: contractErr });
      if (sent(PERSONAL_FIELDS) && !canEditPersonal(viewer, ref)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão para alterar os dados desta ficha." });
      }
      // Email pessoal liga a ficha a contas (identidade): só admin+ o muda.
      // Reenviar o mesmo valor (formulário completo) não conta como mudança.
      if (input.personalEmail !== undefined && !canEditIdentity(viewer, ref)) {
        const current = await getEmployeeById(input.id);
        const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
        if (norm(input.personalEmail) !== norm(current?.employee.personalEmail)) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Só um administrador pode alterar o email pessoal (é usado para ligar a ficha à conta)." });
        }
      }
      // Âmbito de cidade também nas ESCRITAS (revisão 16 set): sem isto um
      // admin do Porto editava salário/NIF de uma ficha de Lisboa.
      await assertEmployeeWriteScope(viewer, ref);
      // Foto: só uma carregada para ESTA ficha (ou por /api/upload); nunca a
      // key de um documento ou de outra pessoa. Reenviar a atual não conta.
      if (input.photoUrl !== undefined || input.photoKey !== undefined) {
        const cur = (await getEmployeeById(input.id))?.employee;
        const changed = [input.photoUrl, input.photoKey].filter((r) => r != null && r !== cur?.photoUrl && r !== cur?.photoKey);
        const { uploadRefsAllowed } = await import("./storageRefs");
        if (!uploadRefsAllowed(changed, [`employees/${input.id}/photo-`, "uploads/"])) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Foto inválida: carrega a fotografia de novo." });
        }
      }
      // D49 (Jorge, 3 out 2026): o IBAN de outra pessoa muda logo com back
      // office, supervisor, admin e super admin; o próprio, o front office e o
      // team leader deixam um PEDIDO (o antigo mantém-se até o RH aprovar).
      // Validado (mod 97); registos mascarados.
      const current = (await getEmployeeById(input.id))?.employee ?? null;
      const { nibChangeAction, createBankChangeRequest, supersedePendingForEmployee } = await import("./rhBankChange");
      const { maskIban } = await import("../shared/iban");
      const nibAct = nibChangeAction(current?.nib ?? null, input.nib, canChangeIbanDirectly(viewer, ref));
      if (nibAct.kind === "error") throw new TRPCError({ code: "BAD_REQUEST", message: nibAct.message });
      const { id, birthDate, contractStart, contractEnd, nib: _nib, ...rest } = input;
      const data: any = { ...rest };
      if (nibAct.kind === "apply") data.nib = nibAct.value;
      if (typeof data.fullName === "string") data.fullName = data.fullName.trim().slice(0, 256);
      if (typeof data.personalEmail === "string") data.personalEmail = data.personalEmail.trim().toLowerCase() || null;
      if (typeof data.personalPhone === "string") data.personalPhone = data.personalPhone.trim() || null;
      // Extras não têm contactos pessoais à parte (o pessoal é o principal).
      if (input.position === "extra") { data.personalEmail = null; data.personalPhone = null; }
      if (birthDate) data.birthDate = new Date(birthDate);
      if (contractStart) data.contractStart = new Date(contractStart);
      if (contractEnd) data.contractEnd = new Date(contractEnd);
      // Fase 1: um utilizador só pode estar numa ficha ativa (o rh.create já
      // verificava; a edição não)
      if (input.userId != null) {
        const { getDb } = await import("./db");
        const { sql } = await import("drizzle-orm");
        const db = await getDb();
        if (db) {
          const [taken] = ((await db.execute(sql`SELECT id, fullName FROM employees WHERE userId = ${input.userId} AND isActive = 1 AND id <> ${id} LIMIT 1`)) as any)[0] ?? [];
          if (taken) throw new TRPCError({ code: "BAD_REQUEST", message: `Esse utilizador já está ligado à ficha ${taken.fullName} (#${taken.id}).` });
        }
      }
      if (Object.keys(data).length) await updateEmployee(id, data);
      // 19c: o registo diz O QUE mudou (sem valores pessoais; IBAN mascarado, foto pela key)
      const changedFields = Object.keys(data).filter((k) => k !== "nib" && (data as any)[k] !== undefined && String((data as any)[k] ?? "") !== String((current as any)?.[k] ?? ""));
      const parts: string[] = [];
      if (changedFields.length) parts.push(`campos: ${changedFields.join(", ")}`);
      if (nibAct.kind === "apply") parts.push(`IBAN ${maskIban(current?.nib)} → ${maskIban(nibAct.value)}`);
      if (data.photoKey !== undefined && data.photoKey !== current?.photoKey) parts.push(`foto ${current?.photoKey ?? "—"} → ${data.photoKey ?? "—"}`);
      await logActivity({ userId: ctx.user.id, action: "update", entity: "employee", entityId: id, details: `Colaborador ${current?.fullName ?? id} atualizado${parts.length ? ` — ${parts.join("; ")}` : ""}`.slice(0, 1000) });
      let nibPending: string | null = null;
      if (nibAct.kind === "apply") await supersedePendingForEmployee(id, ctx.user.id);
      if (nibAct.kind === "request") nibPending = (await createBankChangeRequest(id, nibAct.value, ctx.user.id)).masked;
      // Fase 1: mudou o email → volta a tentar ligar ao utilizador com esse email
      if (input.email !== undefined || input.personalEmail !== undefined) {
        try {
          const { getDb } = await import("./db");
          const db = await getDb();
          const fresh = await getEmployeeById(id);
          if (db && fresh && !fresh.employee.userId) {
            const { ensureUserForEmployee } = await import("./identity");
            await ensureUserForEmployee(db as any, { id, fullName: fresh.employee.fullName, email: fresh.employee.email, position: String(fresh.employee.position ?? ""), userId: null }, { actorId: ctx.user.id });
          }
        } catch (err) { console.warn("[rh.update] religar utilizador:", err); }
      }
      return { success: true, nibPending };
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.user.role, "super_admin");
      await assertEmployeeAccess(input.id);
      await deleteEmployee(input.id);
      await logActivity({ userId: ctx.user.id, action: "delete", entity: "employee", entityId: input.id, details: `Colaborador desativado: ${input.id}` });
      return { success: true };
    }),

  // Ativa/desativa o colaborador E, em cascata, o utilizador associado
  // (login + notificações por email param imediatamente). Útil p/ extras.
  /**
   * "Não enviar" (17g — Jorge, 2 out 2026): desliga os WhatsApp e/ou os emails
   * AUTOMÁTICOS e em massa para esta pessoa (disponibilidade, lembretes,
   * escala, turno cancelado, difusões, formação, pedido da cidade). As
   * conversas uma a uma continuam. Quem pode mudar os dados pessoais da ficha.
   */
  setContactPrefs: protectedProcedure
    .input(z.object({ id: z.number().int().positive(), noAutoWhatsapp: z.boolean().optional(), noAutoEmail: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      const viewer = await rhViewer(ctx.user);
      const ref = await rhEmployeeRefOrThrow(input.id);
      // 19c (decisão do Jorge): "Não enviar" só o RH mexe — o próprio deixava de
      // receber avisos de escala e "turno cancelado" sem ninguém saber.
      if (!isRhFor(viewer, ref)) throw new TRPCError({ code: "FORBIDDEN", message: "Só o RH (front/back office ou administrador) liga ou desliga o \"Não enviar\"." });
      await assertEmployeeWriteScope(viewer, ref);
      const set: Record<string, number> = {};
      if (input.noAutoWhatsapp !== undefined) set.noAutoWhatsapp = input.noAutoWhatsapp ? 1 : 0;
      if (input.noAutoEmail !== undefined) set.noAutoEmail = input.noAutoEmail ? 1 : 0;
      if (!Object.keys(set).length) return { ok: true };
      const { getDb } = await import("./db");
      const { employees } = await import("../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Base de dados indisponível." });
      await db.update(employees).set(set as any).where(eq(employees.id, input.id));
      const label = (v: number | undefined, what: string) => (v === undefined ? null : `${what}: ${v ? "não enviar" : "enviar"}`);
      await logActivity({ userId: ctx.user.id, action: "employee_contact_prefs", entity: "employees", entityId: input.id,
        details: [label(set.noAutoWhatsapp, "WhatsApp automáticos"), label(set.noAutoEmail, "emails automáticos")].filter(Boolean).join(" · ") });
      return { ok: true };
    }),

  // 19c: pedidos de alteração do IBAN (o próprio/um chefe pede; o RH aprova).
  bankChange: router({
    /** Último pedido desta ficha — o próprio vê-o mascarado; o RH vê o IBAN novo para conferir. */
    forEmployee: protectedProcedure
      .input(z.object({ employeeId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        const viewer = await rhViewer(ctx.user);
        const ref = await rhEmployeeRefOrThrow(input.employeeId);
        if (!canEditPersonal(viewer, ref)) throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão" });
        await assertEmployeeWriteScope(viewer, ref);
        const { bankChangeForEmployee } = await import("./rhBankChange");
        const canDecide = canApproveIbanRequests(viewer, ref);
        const v = await bankChangeForEmployee(input.employeeId, canDecide);
        return { request: v, canDecide };
      }),
    /** Pedidos pendentes que ESTA pessoa pode tratar (topo da lista do RH). */
    pending: protectedProcedure.query(async ({ ctx }) => {
      const viewer = await rhViewer(ctx.user);
      const { pendingBankChanges, hydrateBankChanges } = await import("./rhBankChange");
      const rows = await pendingBankChanges();
      const allowed = new Set<number>();
      for (const r of rows) {
        const ref = await rhEmployeeRef(r.employeeId);
        if (!ref || !canApproveIbanRequests(viewer, ref)) continue;
        try { await assertEmployeeWriteScope(viewer, ref); allowed.add(r.employeeId); } catch { /* outra cidade */ }
      }
      return hydrateBankChanges(rows.filter((r) => allowed.has(r.employeeId)), () => false);
    }),
    decide: protectedProcedure
      .input(z.object({ requestId: z.number().int().positive(), approve: z.boolean(), note: z.string().max(300).optional() }))
      .mutation(async ({ ctx, input }) => {
        const { getDb } = await import("./db");
        const { employeeBankChangeRequests } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Base de dados indisponível." });
        const [req] = await db.select({ employeeId: employeeBankChangeRequests.employeeId, requestedById: employeeBankChangeRequests.requestedById }).from(employeeBankChangeRequests).where(eq(employeeBankChangeRequests.id, input.requestId)).limit(1);
        if (!req) throw new TRPCError({ code: "NOT_FOUND", message: "Pedido não encontrado." });
        const viewer = await rhViewer(ctx.user);
        const ref = await rhEmployeeRefOrThrow(req.employeeId);
        if (!canApproveIbanRequests(viewer, ref)) throw new TRPCError({ code: "FORBIDDEN", message: "Só o back office, o supervisor da cidade ou um administrador aprova ou recusa pedidos de IBAN (e nunca o da própria ficha)." });
        // quatro olhos: quem pediu não aprova o próprio pedido (exceto o super admin)
        if (input.approve && req.requestedById === ctx.user.id && ctx.user.role !== "super_admin") throw new TRPCError({ code: "FORBIDDEN", message: "Quem fez o pedido não o pode aprovar." });
        await assertEmployeeWriteScope(viewer, ref);
        const { decideBankChange } = await import("./rhBankChange");
        return decideBankChange(input.requestId, input.approve, ctx.user.id, input.note ?? null);
      }),
  }),

  setActive: protectedProcedure
    .input(z.object({
      id: z.number(),
      isActive: z.boolean(),
      // Mesmo contrato de `users.toggleActive`: motivo + notas opcionais, só
      // lidos na desativação (ver shared/deactivationReasons.ts).
      reason: z.enum(DEACTIVATION_REASON_CODES).optional(),
      reasonOther: z.string().max(DEACTIVATION_REASON_OTHER_MAX).optional(),
      notes: z.string().max(DEACTIVATION_NOTES_MAX).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "rh", "manage");
      // Âmbito de cidade: desativar cascateia para a conta e grava o motivo —
      // nunca sobre uma pessoa de outra cidade. E um admin nunca desativa
      // um super_admin (ficha protegida).
      await assertEmployeeAccess(input.id);
      const found = await getEmployeeById(input.id);
      if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Colaborador não encontrado" });
      // 41c: admin+, ou o supervisor nas fichas da sua cidade de quem está abaixo dele.
      if (!canManageEmployee(await rhViewer(ctx.user), await rhEmployeeRefOrThrow(input.id))) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão para alterar o estado desta ficha." });
      }
      const deactivation = input.isActive ? null : resolveDeactivationOrThrow(input);
      const meta = deactivation ? { ...deactivation, byUserId: ctx.user.id } : null;
      // Desativar a ficha desativa a conta: vale a mesma guarda do ecrã Utilizadores
      // (não te desativas a ti próprio nem tiras o último super_admin).
      const userId = found.employee.userId;
      if (!input.isActive && userId) {
        const acct = await getUserById(userId);
        const guard = acct ? superAdminGuard(ctx.user.id, acct, null, await countActiveSuperAdmins()) : null;
        if (guard) throw new TRPCError({ code: "FORBIDDEN", message: guard });
        if (acct && acct.id === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "Não podes desativar a tua própria ficha." });
        // A conta desativa-se PRIMEIRO, dentro da tranca do último super_admin
        // (atómico); se a guarda recusar, a ficha fica como estava.
        if (acct) {
          const locked = await guardedAccountChange(userId, (t, n) => superAdminGuard(ctx.user.id, t, null, n), (tx) => toggleUserActive(userId, false, meta, tx));
          if (locked) throw new TRPCError({ code: "FORBIDDEN", message: locked });
        }
      }
      // 41a: as contas EXTRA da pessoa também saem (a mesma guarda; a tua nunca)
      let extraOff = 0;
      if (!input.isActive) {
        const { activeExtraAccounts } = await import("./personIdentity");
        for (const xid of await activeExtraAccounts(input.id).catch(() => [] as number[])) {
          if (xid === ctx.user.id || xid === userId) continue;
          const locked = await guardedAccountChange(xid, (t, n) => superAdminGuard(ctx.user.id, t, null, n), (tx) => toggleUserActive(xid, false, meta, tx));
          if (!locked) extraOff++;
        }
      }
      await updateEmployee(input.id, {
        isActive: input.isActive ? 1 : 0,
        ...deactivationColumns(input.isActive, meta),
      });
      // O motivo segue para a conta: a ficha e o login contam a MESMA história.
      if (userId && input.isActive) await toggleUserActive(userId, true, meta);
      await logActivity({
        userId: ctx.user.id,
        action: input.isActive ? "activate" : "deactivate",
        entity: "employee",
        entityId: input.id,
        details: `${input.isActive ? "Ativado" : "Desativado"} colaborador ${found.employee.fullName}${userId ? " + utilizador" : ""}${extraOff ? ` + ${extraOff} conta(s) extra` : ""}${deactivation ? ` — ${deactivation.summary}` : ""}`,
      });
      return { success: true, cascadedUser: !!userId, extraAccounts: extraOff, reasonLabel: deactivation?.label ?? null };
    }),

  uploadPhoto: protectedProcedure
    .input(z.object({ employeeId: z.number(), fileBase64: z.string().max(PHOTO_MAX_BASE64_CHARS), mimeType: z.string().max(100) }))
    .mutation(async ({ ctx, input }) => {
      // A foto é dado pessoal: o próprio, ou quem gere o centro (rhAccess).
      const viewer = await rhViewer(ctx.user);
      const ref = await rhEmployeeRefOrThrow(input.employeeId);
      if (!canEditPersonal(viewer, ref)) throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão para alterar a foto desta ficha." });
      await assertEmployeeWriteScope(viewer, ref);
      return savePhoto(input.employeeId, input.fileBase64, ctx.user.id);
    }),

  // O PRÓPRIO utilizador define/troca a sua foto de perfil (obrigatória p/ ponto).
  uploadMyPhoto: protectedProcedure
    .input(z.object({ fileBase64: z.string().max(PHOTO_MAX_BASE64_CHARS), mimeType: z.string().max(100) }))
    .mutation(async ({ ctx, input }) => {
      const me = await getEmployeeByUserId(ctx.user.id);
      if (!me) throw new TRPCError({ code: "FORBIDDEN", message: "A tua conta não está associada a um colaborador." });
      return savePhoto(me.employee.id, input.fileBase64, ctx.user.id);
    }),

  // ── DOCUMENTS ─────────────────────────────────────────────────────────────────────────────────
  documents: router({
    // Documentos pessoais: admin+, o PRÓPRIO, ou supervisor do centro.
    list: protectedProcedure
      .input(z.object({ employeeId: z.number() }))
      .query(async ({ ctx, input }) => {
        await assertCanViewDocuments(ctx.user, input.employeeId, "Sem permissão para ver estes documentos");
        const docs = await getEmployeeDocuments(input.employeeId);
        // a URL pública gravada deixa de ser exposta — abre-se pela rota `url` (assinada)
        return docs.map((d: any) => ({ ...d, fileUrl: null }));
      }),
    // URL de leitura temporária (assinada no S3) com a MESMA permissão da lista.
    url: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ ctx, input }) => {
        const { getDb } = await import("./db");
        const { employeeDocuments } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });
        const [doc] = await db.select().from(employeeDocuments).where(eq(employeeDocuments.id, input.id)).limit(1);
        if (!doc) throw new TRPCError({ code: "NOT_FOUND" });
        await assertCanViewDocuments(ctx.user, doc.employeeId, "Sem permissão para abrir este documento");
        const { storagePresignGet } = await import("./storage");
        const r = await storagePresignGet(doc.fileKey || doc.fileUrl, { fallbackUrl: doc.fileUrl });
        await logActivity({ userId: ctx.user.id, action: "view", entity: "employee_document", entityId: doc.id, details: `${doc.docType} de #${doc.employeeId}` });
        return { url: r.url, signed: r.signed, expiresIn: r.expiresIn, mimeType: doc.mimeType };
      }),

    upload: protectedProcedure
      .input(z.object({
        employeeId: z.number(),
        docType: z.enum(["id_card","residence_permit","driving_license","nib_proof","address_proof","contract","extra_contract","contract_annex","responsibility_term","work_accident_insurance","photo","other"]),
        label: z.string().max(255).optional(),
        // 41c: limites (antes sem tamanho máximo)
        fileBase64: z.string().max(DOC_MAX_BASE64_CHARS),
        mimeType: z.string().max(100),
        fileName: z.string().max(200),
      }))
      .mutation(async ({ ctx, input }) => {
        await assertCanUploadDocuments(ctx.user, input.employeeId);
        await assertSelfUploadDocType(ctx.user, input.employeeId, input.docType);
        const plan = await documentUploadPlan(ctx.user, input.employeeId, input.docType);
        const { storagePut } = await import("./storage");
        const buffer = Buffer.from(input.fileBase64, "base64");
        const key = `employees/${input.employeeId}/docs/${input.docType}-${Date.now()}-${input.fileName}`;
        const { url } = await storagePut(key, buffer, input.mimeType);
        await createEmployeeDocument({
          employeeId: input.employeeId,
          docType: input.docType,
          label: input.label ?? input.fileName,
          fileUrl: url,
          fileKey: key,
          mimeType: input.mimeType,
          uploadedById: ctx.user.id,
          ...plan,
        });
        await logActivity({ userId: ctx.user.id, action: "upload", entity: "employee_document", entityId: input.employeeId, details: `Documento carregado: ${input.docType} (${plan.status === "validated" ? "validado — carregado pelo RH" : "pendente de validação"})` });
        // IA lê o documento e preenche os campos VAZIOS da ficha (best-effort)
        let autofill: { filled: string[] } = { filled: [] };
        try {
          const { autofillFromDocument } = await import("./documentAutofill");
          const ibanDirect = canChangeIbanDirectly(await rhViewer(ctx.user), await rhEmployeeRefOrThrow(input.employeeId));
          const r = await autofillFromDocument({ employeeId: input.employeeId, docType: input.docType, mimeType: input.mimeType, base64: input.fileBase64, userId: ctx.user.id, ibanDirect });
          autofill = { filled: r.filled };
        } catch (err) { console.warn("[documents.upload] leitura por IA falhou:", String((err as any)?.message ?? err).slice(0, 200)); }
        return { url, key, autofill, status: plan.status };
      }),

    uploadBatch: protectedProcedure
      .input(z.object({
        employeeId: z.number(),
        docType: z.enum(["id_card","residence_permit","driving_license","nib_proof","address_proof","contract","extra_contract","contract_annex","responsibility_term","work_accident_insurance","photo","other"]),
        // 41c: até 10 ficheiros de até ~10 MB cada (antes sem limites)
        files: z.array(z.object({
          fileBase64: z.string().max(DOC_MAX_BASE64_CHARS),
          mimeType: z.string().max(100),
          fileName: z.string().max(200),
          label: z.string().max(255).optional(),
        })).min(1).max(10),
      }))
      .mutation(async ({ ctx, input }) => {
        await assertCanUploadDocuments(ctx.user, input.employeeId);
        await assertSelfUploadDocType(ctx.user, input.employeeId, input.docType);
        // As várias páginas (frente/verso) são UMA entrega: verifica-se uma vez.
        const plan = await documentUploadPlan(ctx.user, input.employeeId, input.docType);
        const { storagePut } = await import("./storage");
        const results: { url: string; key: string }[] = [];
        for (const file of input.files) {
          const buffer = Buffer.from(file.fileBase64, "base64");
          const key = `employees/${input.employeeId}/docs/${input.docType}-${Date.now()}-${Math.random().toString(36).slice(2)}-${file.fileName}`;
          const { url } = await storagePut(key, buffer, file.mimeType);
          await createEmployeeDocument({
            employeeId: input.employeeId,
            docType: input.docType,
            label: file.label ?? file.fileName,
            fileUrl: url,
            fileKey: key,
            mimeType: file.mimeType,
            uploadedById: ctx.user.id,
            ...plan,
          });
          results.push({ url, key });
        }
        await logActivity({ userId: ctx.user.id, action: "upload", entity: "employee_document", entityId: input.employeeId, details: `${input.files.length} documentos carregados: ${input.docType} (${plan.status === "validated" ? "validados — carregados pelo RH" : "pendentes de validação"})` });
        // IA: lê as páginas (ex.: frente e verso do CC) até preencher o que falta
        const filled: string[] = [];
        try {
          const { autofillFromDocument } = await import("./documentAutofill");
          const ibanDirect = canChangeIbanDirectly(await rhViewer(ctx.user), await rhEmployeeRefOrThrow(input.employeeId));
          for (const f of input.files.slice(0, 3)) {
            const r = await autofillFromDocument({ employeeId: input.employeeId, docType: input.docType, mimeType: f.mimeType, base64: f.fileBase64, userId: ctx.user.id, ibanDirect });
            filled.push(...r.filled);
            if (r.skipped || r.ibanRequested) break;
          }
        } catch (err) { console.warn("[documents.uploadBatch] leitura por IA falhou:", String((err as any)?.message ?? err).slice(0, 200)); }
        return Object.assign(results, { autofill: { filled }, status: plan.status });
      }),
    checklist: protectedProcedure
      .input(z.object({ employeeId: z.number() }))
      .query(async ({ ctx, input }) => {
        await assertCanViewDocuments(ctx.user, input.employeeId, "Sem permissão");
        return getDocumentChecklistForEmployee(input.employeeId);
      }),
    allStatus: protectedProcedure
      .query(async ({ ctx }) => {
        requireAccess(ctx.user, "rh", "view");
        const { docsSummary } = await import("../shared/employeeDocuments");
        const map = await getAllEmployeesDocumentStatus();
        // 0530: "Completos" / "N em falta" e, à parte, "N por validar" (ficheiros pendentes).
        const result: Record<number, ReturnType<typeof docsSummary>> = {};
        map.forEach((rows, empId) => { result[empId] = docsSummary(rows); });
        return result;
      }),
    // "Eliminar" = ARQUIVAR (0530): o RH da ficha e admin+ sempre (substituir);
    // quem carregou e ainda mexe na ficha só enquanto não está validado.
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        const { getEmployeeDocumentById } = await import("./rhDocuments");
        const doc = await getEmployeeDocumentById(input.id);
        if (!doc || doc.archivedAt) throw new TRPCError({ code: "NOT_FOUND", message: "Documento não encontrado (já foi retirado?)" });
        const viewer = await rhViewer(ctx.user);
        const ref = await rhEmployeeRef(doc.employeeId);
        const allowed = ref ? canDeleteDocument(viewer, ref, doc.uploadedById, doc.status) : isRhAdmin(viewer);
        if (!allowed) {
          throw new TRPCError({ code: "FORBIDDEN", message: doc.status === "validated" ? "Este documento já foi validado: só o RH o retira ou substitui." : "Sem permissão para retirar este documento" });
        }
        if (ref) await assertEmployeeWriteScope(viewer, ref);
        await archiveEmployeeDocument(input.id, ctx.user.id);
        await logActivity({ userId: ctx.user.id, action: "archive", entity: "employee_document", entityId: doc.id, details: `${doc.docType} de #${doc.employeeId} arquivado (estava ${doc.status})` });
        return { success: true };
      }),
    // Jorge (7 out 2026): o RH valida o que a pessoa entregou.
    validate: protectedProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const { getEmployeeDocumentById, markDocumentValidated } = await import("./rhDocuments");
        const doc = await getEmployeeDocumentById(input.id);
        if (!doc || doc.archivedAt) throw new TRPCError({ code: "NOT_FOUND", message: "Documento não encontrado (já foi retirado?)" });
        await assertCanValidateDocuments(ctx.user, doc.employeeId);
        const changed = await markDocumentValidated(doc.id, ctx.user.id);
        if (changed) await logActivity({ userId: ctx.user.id, action: "employee_document_validate", entity: "employee_document", entityId: doc.id, details: `${doc.docType} de #${doc.employeeId} validado (estava ${doc.status})` });
        return { success: true, changed };
      }),
    // … ou recusa, com motivo: a pessoa recebe o aviso e volta a carregar.
    reject: protectedProcedure
      .input(z.object({ id: z.number().int().positive(), reason: z.string().trim().min(3, "Diz porquê (pelo menos 3 letras).").max(DOC_REJECT_REASON_MAX) }))
      .mutation(async ({ ctx, input }) => {
        const { getEmployeeDocumentById, markDocumentRejected } = await import("./rhDocuments");
        const doc = await getEmployeeDocumentById(input.id);
        if (!doc || doc.archivedAt) throw new TRPCError({ code: "NOT_FOUND", message: "Documento não encontrado (já foi retirado?)" });
        await assertCanValidateDocuments(ctx.user, doc.employeeId);
        await markDocumentRejected(doc.id, ctx.user.id, input.reason);
        await logActivity({ userId: ctx.user.id, action: "employee_document_reject", entity: "employee_document", entityId: doc.id, details: `${doc.docType} de #${doc.employeeId} recusado (estava ${doc.status}): ${input.reason}`.slice(0, 1000) });
        await notifyDocumentRejected(doc.employeeId, doc.docType, input.reason);
        return { success: true };
      }),
  }),

  // Pauta do Rafael (7 out 2026): pedir os documentos em falta aos extras
  // (WhatsApp/email), na ficha ou em grupo — server/rhDocsRequestRouter.ts.
  docsRequest: docsRequestRouter,

  // Jorge (7 out 2026): o RH valida a carta com a data de emissão (lida na
  // carta). "Carta validada" = validada e com 3 anos completos; com menos
  // fica "Carta < 3 anos" (aviso ao escalar, nunca bloqueia).
  validateDrivingLicence: protectedProcedure
    .input(z.object({ employeeId: z.number().int().positive(), issuedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida") }))
    .mutation(async ({ ctx, input }) => {
      const { isCalendarDay, fullYearsBetween, LICENCE_STATUS_LABELS } = await import("../shared/drivingLicence");
      const { lisbonDayOf } = await import("../shared/lisbonDay");
      const today = lisbonDayOf(new Date());
      if (!isCalendarDay(input.issuedAt) || input.issuedAt > today || input.issuedAt < "1940-01-01") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Data de emissão inválida (tem de ser um dia real, até hoje)." });
      }
      const ref = await assertCanValidateDocuments(ctx.user, input.employeeId);
      const { validateDrivingLicenceRecord, licenceStatusMap } = await import("./rhDocuments");
      const r = await validateDrivingLicenceRecord(ref.id, input.issuedAt, ctx.user.id);
      const licence = (await licenceStatusMap([ref.id])).get(ref.id) ?? "missing";
      await logActivity({ userId: ctx.user.id, action: "driving_licence_validate", entity: "employee", entityId: ref.id,
        details: `Carta validada: emitida a ${input.issuedAt} (${fullYearsBetween(input.issuedAt, today)} anos) → ${LICENCE_STATUS_LABELS[licence]}${r.documentsValidated ? `; ${r.documentsValidated} ficheiro(s) da carta validado(s)` : ""}` });
      return { success: true, licence, documentsValidated: r.documentsValidated };
    }),

  // ── NOTAS INTERNAS (Jorge, 7 out 2026) ───────────────────────────────────
  // Team leader e acima, no âmbito de cada um; a própria pessoa NUNCA as vê.
  // Os textos não vão para o registo de atividade (só o tipo e o dia).
  notes: router({
    list: protectedProcedure
      .input(z.object({ employeeId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        const { viewer, ref } = await notesContext(ctx.user, input.employeeId);
        const { listEmployeeNotes, noteTimestampMs } = await import("./employeeNotes");
        const now = Date.now();
        return (await listEmployeeNotes(input.employeeId)).map((n) => ({
          ...n,
          canEdit: canEditInternalNote(viewer, ref, { authorId: n.authorId, createdAtMs: noteTimestampMs(n.createdAt) }, now, NOTE_EDIT_WINDOW_MS),
        }));
      }),
    add: protectedProcedure
      .input(z.object({
        employeeId: z.number().int().positive(),
        body: z.string().trim().min(1, "Escreve a nota.").max(NOTE_BODY_MAX),
        kind: z.enum(NOTE_KINDS).default("general"),
        workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        assignmentId: z.number().int().positive().nullable().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        await notesContext(ctx.user, input.employeeId);
        const { insertEmployeeNote, assignmentBelongsTo } = await import("./employeeNotes");
        const { isCalendarDay } = await import("../shared/drivingLicence");
        let workDate = input.workDate ?? null;
        if (workDate && !isCalendarDay(workDate)) throw new TRPCError({ code: "BAD_REQUEST", message: "Dia inválido." });
        if (input.assignmentId != null) {
          const a = await assignmentBelongsTo(input.assignmentId, input.employeeId);
          if (!a.ok) throw new TRPCError({ code: "BAD_REQUEST", message: "Essa linha da escala não é desta pessoa." });
          workDate ??= a.assignmentDate;
        }
        const id = await insertEmployeeNote({ employeeId: input.employeeId, body: input.body, kind: input.kind, workDate, assignmentId: input.assignmentId ?? null, authorId: ctx.user.id });
        await logActivity({ userId: ctx.user.id, action: "employee_note_add", entity: "employee_notes", entityId: id,
          details: `Nota interna (${NOTE_KIND_LABELS[input.kind]}) na ficha #${input.employeeId}${workDate ? ` — dia ${workDate}` : ""}${input.assignmentId ? ` · escala #${input.assignmentId}` : ""}` });
        return { id };
      }),
    update: protectedProcedure
      .input(z.object({ id: z.number().int().positive(), body: z.string().trim().min(1, "Escreve a nota.").max(NOTE_BODY_MAX), kind: z.enum(NOTE_KINDS) }))
      .mutation(async ({ ctx, input }) => {
        const { getEmployeeNote, updateEmployeeNote, noteTimestampMs } = await import("./employeeNotes");
        const note = await getEmployeeNote(input.id);
        if (!note || note.archivedAt) throw new TRPCError({ code: "NOT_FOUND", message: "Nota não encontrada." });
        const { viewer, ref } = await notesContext(ctx.user, note.employeeId);
        if (!canEditInternalNote(viewer, ref, { authorId: note.authorId, createdAtMs: noteTimestampMs(note.createdAt) }, Date.now(), NOTE_EDIT_WINDOW_MS)) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Só quem escreveu a nota (nas primeiras 24 h) ou um administrador a altera." });
        }
        await updateEmployeeNote(note.id, { body: input.body, kind: input.kind });
        await logActivity({ userId: ctx.user.id, action: "employee_note_edit", entity: "employee_notes", entityId: note.id, details: `Nota interna da ficha #${note.employeeId} alterada (${NOTE_KIND_LABELS[input.kind]})` });
        return { success: true };
      }),
    archive: protectedProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const { getEmployeeNote, archiveEmployeeNote, noteTimestampMs } = await import("./employeeNotes");
        const note = await getEmployeeNote(input.id);
        if (!note || note.archivedAt) throw new TRPCError({ code: "NOT_FOUND", message: "Nota não encontrada." });
        const { viewer, ref } = await notesContext(ctx.user, note.employeeId);
        if (!canEditInternalNote(viewer, ref, { authorId: note.authorId, createdAtMs: noteTimestampMs(note.createdAt) }, Date.now(), NOTE_EDIT_WINDOW_MS)) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Só quem escreveu a nota (nas primeiras 24 h) ou um administrador a arquiva." });
        }
        await archiveEmployeeNote(note.id, ctx.user.id);
        await logActivity({ userId: ctx.user.id, action: "employee_note_archive", entity: "employee_notes", entityId: note.id, details: `Nota interna da ficha #${note.employeeId} arquivada` });
        return { success: true };
      }),
  }),

  // ── SCHEDULES ─────────────────────────────────────────────────────────────────────────────────
  schedules: router({
    list: protectedProcedure
      .input(z.object({ employeeId: z.number() }))
      .query(async ({ ctx, input }) => {
        const viewer = await rhViewer(ctx.user);
        const ref = await rhEmployeeRef(input.employeeId);
        if (!isRhAdmin(viewer) && (!ref || !canViewTimeAndSchedule(viewer, ref))) throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão" });
        if (!isOwn(viewer, input.employeeId)) await assertEmployeeAccess(input.employeeId);
        return getEmployeeSchedules(input.employeeId);
      }),

    upsert: protectedProcedure
      .input(z.object({
        employeeId: z.number(),
        weekday: z.number().min(0).max(6),
        startTime: z.string(),
        endTime: z.string(),
        isWorkDay: z.boolean(),
      }))
      .mutation(async ({ ctx, input }) => {
        // 41c: gerir a ficha (admin+ ou supervisor da cidade), nunca de outra cidade.
        await assertCanManageEmployee(ctx.user, input.employeeId);
        await upsertSchedule({ ...input, isWorkDay: input.isWorkDay ? 1 : 0 });
        return { success: true };
      }),

    delete: protectedProcedure
      .input(z.object({ employeeId: z.number(), weekday: z.number().min(0).max(6) }))
      .mutation(async ({ ctx, input }) => {
        await assertCanManageEmployee(ctx.user, input.employeeId);
        await deleteSchedule(input.employeeId, input.weekday);
        return { success: true };
      }),
  }),

  // ── TIME RECORDS ────────────────────────────────────────────────────────────────────────────────
  timeRecords: router({
    // Estado do ponto do PRÓPRIO utilizador (para o atalho no menu do avatar):
    // qualquer role pode consultar o seu — não expõe registos de terceiros.
    myStatus: protectedProcedure.query(async ({ ctx }) => {
      const me = await getEmployeeByUserId(ctx.user.id);
      if (!me) return { employeeId: null as number | null, status: null as "in" | "out" | null, since: null as string | null };
      const records = await getTimeRecords(me.employee.id);
      const last = records[0];
      return {
        employeeId: me.employee.id as number | null,
        status: (last?.type === "check_in" ? "in" : "out") as "in" | "out" | null,
        since: (last?.recordedAt ?? null) as string | null,
      };
    }),

    list: protectedProcedure
      .input(z.object({ employeeId: z.number(), startDate: z.string().optional(), endDate: z.string().optional() }))
      .query(async ({ ctx, input }) => {
        await assertCanViewTimeRecords(ctx.user, input.employeeId);
        return getTimeRecords(
          input.employeeId,
          input.startDate ? new Date(input.startDate) : undefined,
          input.endDate ? new Date(input.endDate) : undefined,
        );
      }),

    // Registos suspeitos (check-out esquecido/cortado, fora do raio): não pagam até revisão.
    suspicious: protectedProcedure
      .input(z.object({ employeeId: z.number().optional(), limit: z.number().max(500).optional() }).optional())
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "edit");
        return listSuspiciousTimeRecords({ employeeId: input?.employeeId, limit: input?.limit });
      }),
    review: protectedProcedure
      .input(z.object({ id: z.number(), decision: z.enum(["approved", "rejected"]), note: z.string().max(255).optional(), correctedHours: z.number().min(0).max(24).optional() }))
      .mutation(async ({ ctx, input }) => {
        // 41c: só picagens de fichas que quem revê gere (da sua cidade).
        const empId = await employeeIdOfRecord("time_records", input.id);
        if (empId == null) throw new TRPCError({ code: "NOT_FOUND", message: "Registo de ponto não encontrado" });
        await assertCanManageEmployee(ctx.user, empId, "Sem permissão para rever o ponto desta pessoa.");
        await reviewTimeRecord(input.id, input.decision, ctx.user.id, input.note ?? null, input.correctedHours ?? null);
        await logActivity({ userId: ctx.user.id, action: "review", entity: "time_record", entityId: input.id, details: `${input.decision}${input.correctedHours != null ? ` (${input.correctedHours}h)` : ""}${input.note ? ` — ${input.note}` : ""}` });
        return { success: true };
      }),

    checkIn: protectedProcedure
      .input(z.object({
        employeeId: z.number(),
        photoBase64: z.string().max(PHOTO_MAX_BASE64_CHARS).optional(),
        mimeType: z.string().optional(),
        latitude: z.string().optional(),
        longitude: z.string().optional(),
        locationName: z.string().optional(),
        notes: z.string().optional(),
        // Token do aparelho (localStorage do browser do PDA) — liga a pessoa
        // ao PDA/Zello automaticamente no check-in do ponto
        pdaDeviceToken: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        // admin pode picar a qualquer um; outros só ao próprio
        if (ROLE_HIERARCHY[ctx.user.role] < ROLE_HIERARCHY["admin"]) {
          const me = await getEmployeeByUserId(ctx.user.id);
          if (!me || me.employee.id !== input.employeeId) {
            throw new TRPCError({ code: "FORBIDDEN", message: "Só podes picar o teu próprio ponto" });
          }
        }
        // Pré-requisitos para dar entrada: utilizador associado + foto de perfil.
        const empForPonto = await getEmployeeById(input.employeeId);
        if (!empForPonto) throw new TRPCError({ code: "NOT_FOUND", message: "Colaborador não encontrado" });
        if (!empForPonto.employee.userId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Este colaborador ainda não tem utilizador associado. Associa um utilizador na ficha do colaborador antes de picar o ponto." });
        }
        if (!empForPonto.employee.photoUrl) {
          throw new TRPCError({ code: "FORBIDDEN", message: "É preciso uma foto de perfil para picar o ponto. Adiciona a foto na ficha do colaborador." });
        }
        // Bloqueia dois check-ins seguidos sem check-out
        const recent = await getTimeRecords(input.employeeId);
        const last = recent[0];
        if (last && last.type === "check_in") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Já tens uma entrada em aberto. Faz check-out primeiro.",
          });
        }
        // Aviso da ligação tripla (funcionário↔utilizador↔agente Multipark):
        // sem agente ligado o check-in passa, mas devolve o aviso para a UI.
        const missingAgentWarning = !empForPonto.employee.multiparkAgentName
          ? "Falta ligar o agente Multipark a este colaborador — pede à administração para o associar na ficha."
          : null;
        // Geofence do centro de custos (se configurado): fora do raio fica marcado.
        const geoNoteIn = await checkGeofenceNote(input.employeeId, input.latitude, input.longitude);
        let photoUrl: string | null = null;
        let photoKey: string | null = null;
        if (input.photoBase64 && input.mimeType) {
          // 19c: a selfie do ponto passa pela mesma validação da foto de perfil (JPEG/PNG/WebP, ≤ 4 MB)
          const { checkProfilePhoto } = await import("./photoUpload");
          const photo = checkProfilePhoto(input.photoBase64);
          if (!photo.ok) throw new TRPCError({ code: "BAD_REQUEST", message: `Foto do ponto: ${photo.error}` });
          const { storagePut } = await import("./storage");
          const key = `employees/${input.employeeId}/ponto/${Date.now()}.${photo.ext}`;
          const result = await storagePut(key, photo.buffer, photo.mime);
          photoUrl = result.url;
          photoKey = key;
        }
        // Inserção ATÓMICA (linha do colaborador bloqueada): dois toques
        // simultâneos já não criam duas entradas.
        try {
          await insertTimeRecordAtomic(input.employeeId, "check_in", {
            recordedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
            photoUrl,
            photoKey,
            latitude: input.latitude ?? null,
            longitude: input.longitude ?? null,
            locationName: input.locationName ?? null,
            notes: [geoNoteIn, input.notes].filter(Boolean).join(" · ") || null,
          });
        } catch (e: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: String(e?.message ?? e) });
        }
        await logActivity({ userId: ctx.user.id, action: "check_in", entity: "time_record", entityId: input.employeeId, details: `Check-in: ${input.locationName ?? ""}` });
        // Ponto→PDA automático: se o check-in veio do browser de um PDA
        // registado, liga já a pessoa ao PDA/Zello (e troca quem lá estava).
        let pdaAttached: { pdaName: string; zelloUsername: string | null; replacedName: string | null } | null = null;
        if (input.pdaDeviceToken) {
          try {
            const { attachPdaByDeviceToken } = await import("./db");
            const att = await attachPdaByDeviceToken(input.pdaDeviceToken, input.employeeId);
            if (att) {
              pdaAttached = { pdaName: att.pdaName, zelloUsername: att.zelloUsername, replacedName: att.replacedName };
              if (att.changed) { const { syncPdaZelloName } = await import("./pdaZelloName"); void syncPdaZelloName(att.pdaId); }
              await logActivity({ userId: ctx.user.id, action: "create", entity: "pda_checkin", entityId: att.pdaId, details: `Auto: ponto→PDA ${att.pdaName}${att.replacedName ? ` (substituiu ${att.replacedName})` : ""}` });
            }
          } catch (err) {
            console.warn("[pda] ponto→PDA automático (check-in) falhou:", err);
          }
        }
        return { success: true, warning: missingAgentWarning, outsideGeofence: !!geoNoteIn, pdaAttached };
      }),

    checkOut: protectedProcedure
      .input(z.object({
        employeeId: z.number(),
        photoBase64: z.string().max(PHOTO_MAX_BASE64_CHARS).optional(),
        mimeType: z.string().optional(),
        latitude: z.string().optional(),
        longitude: z.string().optional(),
        locationName: z.string().optional(),
        notes: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        if (ROLE_HIERARCHY[ctx.user.role] < ROLE_HIERARCHY["admin"]) {
          const me = await getEmployeeByUserId(ctx.user.id);
          if (!me || me.employee.id !== input.employeeId) {
            throw new TRPCError({ code: "FORBIDDEN", message: "Só podes picar o teu próprio ponto" });
          }
        }
        // Exige check-in aberto
        const records = await getTimeRecords(input.employeeId);
        const last = records[0];
        if (!last || last.type !== "check_in") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Não tens entrada em aberto. Faz check-in primeiro.",
          });
        }
        let photoUrl: string | null = null;
        let photoKey: string | null = null;
        if (input.photoBase64 && input.mimeType) {
          // 19c: a selfie do ponto passa pela mesma validação da foto de perfil (JPEG/PNG/WebP, ≤ 4 MB)
          const { checkProfilePhoto } = await import("./photoUpload");
          const photo = checkProfilePhoto(input.photoBase64);
          if (!photo.ok) throw new TRPCError({ code: "BAD_REQUEST", message: `Foto do ponto: ${photo.error}` });
          const { storagePut } = await import("./storage");
          const key = `employees/${input.employeeId}/ponto/${Date.now()}-out.${photo.ext}`;
          const result = await storagePut(key, photo.buffer, photo.mime);
          photoUrl = result.url;
          photoKey = key;
        }
        const diff = (new Date().getTime() - new Date(last.recordedAt).getTime()) / 3600000;
        // Regra do Jorge (turnos máx. 12h): entrada aberta há >16h = esquecimento
        // de check-out. Corta às 12h (sem extraordinárias) e marca a VERMELHO
        // para revisão — não paga dias inteiros de horas fantasma.
        let hoursWorked: string;
        let autoNote: string | null = null;
        let outAt = new Date();
        if (diff > 16) {
          hoursWorked = "12.00";
          outAt = new Date(new Date(last.recordedAt).getTime() + 12 * 3600000);
          autoNote = "[SUSPEITO] check-out esquecido — cortado a 12h";
        } else {
          hoursWorked = diff.toFixed(2);
        }
        // Geofence: se o centro de custos do colaborador tem raio definido e o
        // check-out veio com GPS fora dele, fica marcado (permitido, mas visível).
        const geoNote = await checkGeofenceNote(input.employeeId, input.latitude, input.longitude);
        const finalNotes = [autoNote, geoNote, input.notes].filter(Boolean).join(" · ") || null;
        // Snapshot Zello do turno (pedido Jorge): no check-out, vai buscar ao
        // Zello o que o condutor fez entre a entrada e a saída — km,
        // velocidades e tempo com o Zello desligado. Melhor esforço: nunca
        // pode impedir o registo do ponto.
        let zello: import("./zello").ZelloShiftSummary | null = null;
        // Descobre o utilizador Zello DESTE turno: primeiro o PDA em que a
        // pessoa fez check-in nesse dia (cada dia é um PDA diferente),
        // depois a ligação fixa da ficha (telemóveis pessoais).
        const { resolveZelloUsernameForShift } = await import("./db");
        const empZello = await resolveZelloUsernameForShift(input.employeeId, new Date(last.recordedAt), outAt);
        if (empZello) {
          try {
            const { summarizeZelloShift } = await import("./zello");
            zello = await summarizeZelloShift(empZello, new Date(last.recordedAt), outAt);
          } catch (err) {
            console.warn("[checkOut] snapshot Zello falhou:", err);
          }
        }
        // Inserção ATÓMICA (linha do colaborador bloqueada) + estado de
        // revisão: um check-out cortado a 12h nasce "suspicious" e não paga
        // até ser aprovado.
        try {
          await insertTimeRecordAtomic(input.employeeId, "check_out", {
            recordedAt: outAt.toISOString().slice(0, 19).replace("T", " "),
            photoUrl,
            photoKey,
            latitude: input.latitude ?? null,
            longitude: input.longitude ?? null,
            locationName: input.locationName ?? null,
            hoursWorked,
            notes: finalNotes,
            reviewStatus: autoNote ? "suspicious" : "ok",
            ...(zello ? {
              zelloKm: String(zello.km),
              zelloAvgSpeed: String(zello.avgSpeed),
              zelloMaxSpeed: String(zello.maxSpeed),
              zelloOfflineMinutes: zello.offlineMinutes,
              zelloOnlineMinutes: zello.onlineMinutes,
            } : {}),
          });
        } catch (e: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: String(e?.message ?? e) });
        }
        // Fecha o check-in de PDA da pessoa (o aparelho fica livre para o
        // próximo turno — quando outro picar o ponto, a app troca sozinha)
        try {
          const { closePdaCheckinsForEmployee } = await import("./db");
          await closePdaCheckinsForEmployee(input.employeeId, outAt);
          { const { syncPdaZelloNamesForEmployee } = await import("./pdaZelloName"); void syncPdaZelloNamesForEmployee(input.employeeId); }
        } catch (err) {
          console.warn("[pda] fecho do PDA no check-out do ponto falhou:", err);
        }
        await logActivity({ userId: ctx.user.id, action: "check_out", entity: "time_record", entityId: input.employeeId, details: `Check-out: ${hoursWorked}h${zello ? ` · ${zello.km}km GPS · ${zello.offlineMinutes}min offline` : ""}` });
        return { success: true, hoursWorked, zello };
      }),

    // ── Geofence por centro de custos (raio de picagem) ───────────────────
    geofences: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "rh", "manage");
      // 41c: só os centros das cidades de quem vê
      const allowed = scopedProjectIds();
      const all = await listProjectGeofences();
      return allowed === undefined ? all : all.filter((g) => allowed.includes(g.projectId));
    }),
    setGeofence: protectedProcedure
      .input(z.object({ projectId: z.number(), lat: z.number(), lng: z.number(), radiusM: z.number().min(50).max(50000) }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "manage");
        assertProjectAccess(input.projectId);
        await setProjectGeofence(input.projectId, input.lat, input.lng, input.radiusM);
        await logActivity({ userId: ctx.user.id, action: "update", entity: "project_geofence", entityId: input.projectId });
        return { success: true };
      }),
    deleteGeofence: protectedProcedure
      .input(z.object({ projectId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "manage");
        assertProjectAccess(input.projectId);
        await deleteProjectGeofence(input.projectId);
        return { success: true };
      }),

    monthlyHours: protectedProcedure
      .input(z.object({ employeeId: z.number(), year: z.number(), month: z.number() }))
      .query(async ({ ctx, input }) => {
        // 41c: horas (sem valores) — o supervisor da cidade também vê
        await assertOwnOrScopedEmployee(ctx.user, input.employeeId, "supervisor");
        return getMonthlyHours(input.employeeId, input.year, input.month);
      }),
  }),

  // ── PAYROLL ──────────────────────────────────────────────────────────────────────────────────
  // Apuramento PROVISÓRIO do mês (cálculo ao vivo). O que foi aprovado/pago
  // vive nos fechos (payrollRuns). Filtro por centro de custos opcional.
  payroll: protectedProcedure
    .input(z.object({ year: z.number(), month: z.number().min(1).max(12), projectId: z.number().optional() }))
    .query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "rh_salarios", "view");
      return getPayrollData(input.year, input.month, { projectId: input.projectId ?? null });
    }),

  // ── FECHO MENSAL: apuramento → aprovado → pago (versões imutáveis) ──────
  payrollRuns: router({
    list: protectedProcedure
      .input(z.object({ year: z.number().optional(), month: z.number().min(1).max(12).optional() }).optional())
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh_salarios", "view");
        return listPayrollRuns(input?.year, input?.month);
      }),
    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh_salarios", "view");
        return getPayrollRun(input.id);
      }),
    create: protectedProcedure
      .input(z.object({ year: z.number(), month: z.number().min(1).max(12), notes: z.string().max(1000).optional() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh_salarios", "manage");
        const r = await createPayrollRun(input.year, input.month, ctx.user.id, input.notes ?? null);
        await logActivity({ userId: ctx.user.id, action: "payroll_close", entity: "payroll_run", entityId: r.runId, details: `${input.year}-${String(input.month).padStart(2, "0")} v${r.version}: ${r.employeesCount} pessoas, ${r.totalGross.toFixed(2)}€ bruto, ${r.warningsCount} com avisos` });
        return r;
      }),
    approve: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        requireRole(ctx.user.role, "super_admin");
        try { await transitionPayrollRun(input.id, "approved", ctx.user.id); } catch (e: any) { throw new TRPCError({ code: "BAD_REQUEST", message: String(e?.message ?? e) }); }
        await logActivity({ userId: ctx.user.id, action: "payroll_approve", entity: "payroll_run", entityId: input.id });
        return { success: true };
      }),
    markPaid: protectedProcedure
      .input(z.object({ id: z.number(), paymentRef: z.string().max(128).optional() }))
      .mutation(async ({ ctx, input }) => {
        requireRole(ctx.user.role, "super_admin");
        try { await transitionPayrollRun(input.id, "paid", ctx.user.id, input.paymentRef ?? null); } catch (e: any) { throw new TRPCError({ code: "BAD_REQUEST", message: String(e?.message ?? e) }); }
        await logActivity({ userId: ctx.user.id, action: "payroll_paid", entity: "payroll_run", entityId: input.id, details: input.paymentRef ?? "" });
        return { success: true };
      }),
    void: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        requireRole(ctx.user.role, "super_admin");
        try { await transitionPayrollRun(input.id, "void", ctx.user.id); } catch (e: any) { throw new TRPCError({ code: "BAD_REQUEST", message: String(e?.message ?? e) }); }
        return { success: true };
      }),
  }),

  payrollPdf: protectedProcedure
    .input(z.object({ year: z.number(), month: z.number().min(1).max(12) }))
    .mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "rh_salarios", "export");
      const pdfBuffer = await generatePayrollPdf(input.year, input.month);
      const { storagePut } = await import("./storage");
      const fileName = `folha_ordenados_${input.year}_${String(input.month).padStart(2, "0")}.pdf`;
      const key = `payroll/${fileName}_${Date.now()}.pdf`;
      const { url } = await storagePut(key, pdfBuffer, "application/pdf");
      await savePayslipRecord({ year: input.year, month: input.month, payslipType: "payroll", url, fileName, generatedById: ctx.user.id, generatedByName: ctx.user.name ?? "Admin" });
      return { url, fileName };
    }),

  payslipPdf: protectedProcedure
    .input(z.object({ year: z.number(), month: z.number().min(1).max(12), employeeId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "rh_salarios", "export");
      // O recibo de vencimento é da cidade da ficha, não de quem o pede.
      await assertEmployeeAccess(input.employeeId);
      const pdfBuffer = await generatePayslipPdf(input.year, input.month, input.employeeId);
      const { storagePut } = await import("./storage");
      // Get employee name for history
      const payrollData = await getPayrollData(input.year, input.month);
      const emp = payrollData.find((e: any) => e.employeeId === input.employeeId);
      const empName = emp?.fullName ?? `Funcionário #${input.employeeId}`;
      const fileName = `recibo_${empName.replace(/[^a-zA-Z0-9]/g, "_")}_${input.year}_${String(input.month).padStart(2, "0")}.pdf`;
      const key = `payslips/${fileName}_${Date.now()}.pdf`;
      const { url } = await storagePut(key, pdfBuffer, "application/pdf");
      await savePayslipRecord({ employeeId: input.employeeId, employeeName: empName, year: input.year, month: input.month, payslipType: "individual", url, fileName, generatedById: ctx.user.id, generatedByName: ctx.user.name ?? "Admin" });
      return { url };
    }),

  allPayslipsPdf: protectedProcedure
    .input(z.object({ year: z.number(), month: z.number().min(1).max(12) }))
    .mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "rh_salarios", "export");
      const payslips = await generateAllPayslipsPdf(input.year, input.month);
      const { storagePut } = await import("./storage");
      const results: Array<{ employeeId: number; fullName: string; url: string }> = [];
      for (const ps of payslips) {
        const safeName = ps.fullName.replace(/[^a-zA-Z0-9]/g, "_");
        const fileName = `recibo_${safeName}_${input.year}_${String(input.month).padStart(2, "0")}.pdf`;
        const key = `payslips/${fileName}_${Date.now()}.pdf`;
        const { url } = await storagePut(key, ps.buffer, "application/pdf");
        results.push({ employeeId: ps.employeeId, fullName: ps.fullName, url });
        await savePayslipRecord({ employeeId: ps.employeeId, employeeName: ps.fullName, year: input.year, month: input.month, payslipType: "individual", url, fileName, generatedById: ctx.user.id, generatedByName: ctx.user.name ?? "Admin" });
      }
      return { payslips: results, count: results.length };
    }),

  sendPayrollEmail: protectedProcedure
    .input(z.object({ year: z.number(), month: z.number().min(1).max(12), email: z.string().email() }))
    .mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "rh_salarios", "manage");
      // Generate PDF and upload to S3
      const pdfBuffer = await generatePayrollPdf(input.year, input.month);
      const { storagePut } = await import("./storage");
      const monthNames = ["Janeiro","Fevereiro","Mar\u00e7o","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
      const monthName = monthNames[input.month - 1];
      const key = `payroll/folha_ordenados_${input.year}_${String(input.month).padStart(2, "0")}_${Date.now()}.pdf`;
      const { url } = await storagePut(key, pdfBuffer, "application/pdf");
      // Aviso `payroll_ready` (quem tem RH — ordenados; app + email) com o link do PDF.
      // O link é o da APP (/api/file pede login e RH — ordenados), nunca o do
      // bucket: os emails ficam guardados e o bucket deixa de ser público.
      const { notify } = await import("./notify");
      const { appOrigin } = await import("./shiftHandoverAutomation");
      const pdfLink = `${appOrigin()}/api/file/${key.split("/").map(encodeURIComponent).join("/")}`;
      await notify({
        kind: "payroll_ready",
        title: `Folha de Ordenados - ${monthName} ${input.year}`,
        body: `A folha de ordenados de ${monthName} ${input.year} foi gerada e est\u00e1 pronta para enviar ao contabilista (${input.email}).\n\nLink do PDF: ${pdfLink}`,
        link: "/rh", entity: { type: "payroll", id: `${input.year}-${input.month}` },
      });
      return { url, email: input.email, monthName, year: input.year };
    }),

  // ── FÉRIAS / BAIXAS ────────────────────────────────────────────────────
  leaves: router({
    list: protectedProcedure
      .input(z.object({ employeeId: z.number(), year: z.number().optional() }))
      .query(async ({ ctx, input }) => {
        // 41c: férias e baixas — o supervisor da cidade também vê
        await assertOwnOrScopedEmployee(ctx.user, input.employeeId, "supervisor");
        return getEmployeeLeaves(input.employeeId, input.year);
      }),
    create: protectedProcedure
      .input(z.object({
        employeeId: z.number(),
        leaveType: z.enum(["vacation", "sick", "unpaid", "other"]),
        fromDate: z.string(),
        toDate: z.string(),
        notes: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        await assertCanManageEmployee(ctx.user, input.employeeId);
        await createEmployeeLeave({ ...input, createdById: ctx.user.id });
        await logActivity({ userId: ctx.user.id, action: "create", entity: "employee_leave", entityId: input.employeeId, details: `${input.leaveType} ${input.fromDate}→${input.toDate}` });
        return { success: true };
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        const empId = await employeeIdOfRecord("employee_leaves", input.id);
        if (empId == null) throw new TRPCError({ code: "NOT_FOUND", message: "Ausência não encontrada" });
        await assertCanManageEmployee(ctx.user, empId);
        await deleteEmployeeLeave(input.id);
        return { success: true };
      }),
  }),

  // ── HISTÓRICO SALARIAL ─────────────────────────────────────────────────
  salaryHistory: protectedProcedure
    .input(z.object({ employeeId: z.number() }))
    .query(async ({ ctx, input }) => {
      await assertOwnOrScopedEmployee(ctx.user, input.employeeId, "admin");
      return getEmployeeSalaryHistory(input.employeeId);
    }),

  // ── PENALIZAÇÕES ───────────────────────────────────────────────────────
  penalties: router({
    list: protectedProcedure
      .input(z.object({ employeeId: z.number() }))
      .query(async ({ ctx, input }) => {
        await assertOwnOrScopedEmployee(ctx.user, input.employeeId, "team_leader");
        return getOpenPenalties(input.employeeId);
      }),
    clear: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "edit");
        // 41c: só pontos de fichas da cidade de quem limpa
        const empId = await employeeIdOfRecord("employee_penalties", input.id);
        if (empId == null) throw new TRPCError({ code: "NOT_FOUND", message: "Penalização não encontrada" });
        await assertEmployeeAccess(empId);
        await clearPenalty(input.id, ctx.user.id);
        await logActivity({ userId: ctx.user.id, action: "clear", entity: "employee_penalty", entityId: input.id });
        return { success: true };
      }),
    // Gera "POSSÍVEIS faltas" (pendentes) — só contam pontos depois de confirmadas.
    processNoShows: protectedProcedure
      .input(z.object({ date: z.string() }))
      .mutation(async ({ ctx, input }) => {
        // 41c: corre para todas as cidades — com quem gere o RH de todas
        requireNationalRhManage(ctx.user);
        const report = await detectExtraDiaNoShows(input.date);
        await logActivity({ userId: ctx.user.id, action: "process_noshows", entity: "extras_dia", details: `${input.date}: ${report.created} possíveis faltas (fora: ${report.skipped.proposed} propostos, ${report.skipped.sent_home} mandados para casa, ${report.skipped.multipark} com movimentos)` });
        return report;
      }),
    // 41b: só as das cidades de quem vê, com o total real
    pending: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "rh", "edit");
      return listPendingPenalties();
    }),
    /**
     * 41b: "marcar falta a todos" / "libertar todos" — a mesma regra de cada
     * uma (supervisor+, quem propôs não confirma, só da cidade); as que não
     * passam ficam por validar e vêm contadas.
     */
    reviewMany: protectedProcedure
      .input(z.object({ ids: z.array(z.number().int().positive()).min(1).max(200), decision: z.enum(["confirmed", "dismissed"]), note: z.string().max(200).optional() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "edit");
        let done = 0, failed = 0, blocked = 0;
        let firstError: string | null = null;
        for (const id of Array.from(new Set(input.ids))) {
          try {
            const r = await reviewPenalty(id, input.decision, ctx.user, input.note ?? null);
            done++;
            if (r.blocked) blocked++;
          } catch (err: any) {
            failed++;
            firstError = firstError ?? String(err?.message ?? err);
          }
        }
        await logActivity({ userId: ctx.user.id, action: input.decision === "confirmed" ? "confirm_penalty" : "dismiss_penalty", entity: "employee_penalty",
          details: `Em massa: ${done} ${input.decision === "confirmed" ? "faltas confirmadas" : "libertadas"}${failed ? ` · ${failed} não deu` : ""}${blocked ? ` · ${blocked} com acesso bloqueado` : ""}${input.note ? ` — ${input.note}` : ""} · ids ${input.ids.slice(0, 60).join(",")}`.slice(0, 1000) });
        return { done, failed, blocked, firstError };
      }),
    review: protectedProcedure
      .input(z.object({ id: z.number(), decision: z.enum(["confirmed", "dismissed"]), note: z.string().max(200).optional() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "edit");
        const r = await reviewPenalty(input.id, input.decision, ctx.user, input.note ?? null);
        await logActivity({ userId: ctx.user.id, action: input.decision === "confirmed" ? "confirm_penalty" : "dismiss_penalty", entity: "employee_penalty", entityId: input.id, details: `${input.decision}${input.note ? ` — ${input.note}` : ""} · pontos ${r.points}${r.blocked ? " · BLOQUEADO" : ""}` });
        return r;
      }),
  }),

  // ── BLOQUEIO LOGIN ─────────────────────────────────────────────────────
  unblock: protectedProcedure
    .input(z.object({ employeeId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "rh", "edit");
      // 41c: desbloquear só quem é da cidade de quem desbloqueia
      await assertEmployeeAccess(input.employeeId);
      await unblockEmployeeLogin(input.employeeId, ctx.user.id);
      return { success: true };
    }),

  checkDocs: protectedProcedure
    .input(z.object({ employeeId: z.number() }))
    .query(async ({ ctx, input }) => {
      if (ROLE_HIERARCHY[ctx.user.role] < ROLE_HIERARCHY["admin"]) {
        const me = await getEmployeeByUserId(ctx.user.id);
        if (!me || me.employee.id !== input.employeeId) throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão" });
      }
      // ação explícita: aplica a regra documental (escreve só blockedByDocs/aviso)
      return applyDocsCompliance(input.employeeId);
    }),

  // ── DASHBOARD RH (super_admin) ─────────────────────────────────────────
  dashboard: protectedProcedure
    .input(z.object({
      year: z.number().optional(),
      month: z.number().min(1).max(12).optional(),
      monthsLookback: z.number().min(1).max(12).optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      requireRole(ctx.user.role, "super_admin");
      const now = new Date();
      return getRhDashboardSummary(
        input?.year ?? now.getFullYear(),
        input?.month ?? (now.getMonth() + 1),
        input?.monthsLookback ?? 3,
      );
    }),

  // ── EXTRA RATES ─────────────────────────────────────────────────────────────────────────────────
  extraRates: router({
    // Leitura para quem compõe a escala (backoffice+): sem isto o Extras Dia
    // caía em silêncio nas taxas por defeito. Editar continua super_admin.
    list: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "rh_salarios", "view");
      await seedExtraRates();
      return getExtraRates();
    }),

    update: protectedProcedure
      .input(z.object({ level: z.number(), hourlyRate: z.string() }))
      .mutation(async ({ ctx, input }) => {
        requireRole(ctx.user.role, "super_admin");
        const { normalizeHourlyRate, MAX_EXTRA_HOURLY_RATE } = await import("./extraRates");
        const rate = normalizeHourlyRate(input.hourlyRate);
        if (!rate) throw new TRPCError({ code: "BAD_REQUEST", message: `Taxa inválida: indica um valor numérico maior que 0 e até ${MAX_EXTRA_HOURLY_RATE} €/h.` });
        const before = (await getExtraRates()).find((r: any) => Number(r.level) === input.level);
        if (!before) throw new TRPCError({ code: "NOT_FOUND", message: "Nível de taxa inexistente" });
        await updateExtraRate(input.level, rate);
        await logActivity({ userId: ctx.user.id, action: "update", entity: "extra_rate", entityId: input.level,
          details: `Taxa ${before.levelName ?? `nível ${input.level}`}: ${before.hourlyRate} → ${rate} €/h` });
        return { success: true };
      }),
  }),
});
