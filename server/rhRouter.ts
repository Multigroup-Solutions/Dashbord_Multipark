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
import { canViewEmployee, canViewTimeAndSchedule, canEditPersonal, canEditContract, canDeleteDocument, employeeAccess, sanitizeEmployee, sanitizeEmployeeRows, isOwn, PERSONAL_FIELDS, CONTRACT_FIELDS, type EmployeeRef, isRhAdmin, canEditIdentity } from "./rhAccess";
import { applyDocsCompliance, detectExtraDiaNoShows, listPendingPenalties, reviewPenalty, listSuspiciousTimeRecords, reviewTimeRecord, insertTimeRecordAtomic, createPayrollRun, listPayrollRuns, getPayrollRun, transitionPayrollRun } from "./rhService";
import { matchKey } from "../shared/textKey";
import { importExtrasFromCsv } from "./extrasImport";
import { getAllUsers, createManualUser, getUserByEmail, getOpenPenalties, clearPenalty, unblockEmployeeLogin, getEmployeeLeaves, createEmployeeLeave, deleteEmployeeLeave, getEmployeeSalaryHistory, getRhDashboardSummary, toggleUserActive, deactivationColumns, getUserById, resolveProjectIds, logActivity, getAllEmployees, getEmployeeById, getEmployeeByUserId, createEmployee, updateEmployee, deleteEmployee, getEmployeeDocuments, createEmployeeDocument, deleteEmployeeDocument, getDocumentChecklistForEmployee, getAllEmployeesDocumentStatus, getEmployeeSchedules, upsertSchedule, deleteSchedule, getTimeRecords, checkGeofenceNote, setProjectGeofence, deleteProjectGeofence, listProjectGeofences, getMonthlyHours, getExtraRates, seedExtraRates, updateExtraRate, getHRStats, createInviteToken, countActiveSuperAdmins, getPayrollData, savePayslipRecord } from "./db";
import { generatePayrollPdf } from "./payrollPdf";
import { generatePayslipPdf, generateAllPayslipsPdf } from "./payslipPdf";
import { ROLE_HIERARCHY, requireRole, resolveDeactivationOrThrow } from "./routerGuards";
import { rhViewer, rhEmployeeRef, employeeAccountRole, rhEmployeeRefOrThrow, assertEmployeeWriteScope, assertOwnOrScopedEmployee, assertCanViewDocuments, assertCanViewTimeRecords, assertCanUploadDocuments } from "./rhGuards";

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
    return listInboundEmailsByAlias("recursos-humanos", 200);
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
      return { ok, inviteLink };
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
      return sanitizeEmployeeRows(viewer, rows as any[], (emp) => (emp.userId != null ? roleByUserId.get(emp.userId) : null));
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
      // `access` diz ao cliente o que este utilizador pode fazer na ficha
      return { ...result, employee: sanitizeEmployee(viewer, result.employee as any, ref.role), access: employeeAccess(viewer, ref) };
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
        });
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
      if (sent(CONTRACT_FIELDS) && !canEditContract(viewer, ref)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Só admin pode alterar dados contratuais (posto, centro, contrato, salário, conta)." });
      }
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
      const { id, birthDate, contractStart, contractEnd, ...rest } = input;
      const data: any = { ...rest };
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
      await updateEmployee(id, data);
      await logActivity({ userId: ctx.user.id, action: "update", entity: "employee", entityId: id, details: `Colaborador atualizado: ${id}` });
      // Fase 1: mudou o email → volta a tentar ligar ao utilizador com esse email
      if (input.email !== undefined || input.personalEmail !== undefined) {
        try {
          const { getDb } = await import("./db");
          const db = await getDb();
          const fresh = await getEmployeeById(id);
          if (db && fresh && !fresh.employee.userId) {
            const { ensureUserForEmployee } = await import("./identity");
            await ensureUserForEmployee(db as any, { id, fullName: fresh.employee.fullName, email: fresh.employee.email, position: String(fresh.employee.position ?? ""), userId: null });
          }
        } catch (err) { console.warn("[rh.update] religar utilizador:", err); }
      }
      return { success: true };
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
      if (!canEditPersonal(viewer, ref)) throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão para alterar os dados desta ficha." });
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
      if (!canEditContract(await rhViewer(ctx.user), await rhEmployeeRefOrThrow(input.id))) {
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
        details: `${input.isActive ? "Ativado" : "Desativado"} colaborador ${found.employee.fullName}${userId ? " + utilizador" : ""}${deactivation ? ` — ${deactivation.summary}` : ""}`,
      });
      return { success: true, cascadedUser: !!userId, reasonLabel: deactivation?.label ?? null };
    }),

  uploadPhoto: protectedProcedure
    .input(z.object({ employeeId: z.number(), fileBase64: z.string(), mimeType: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // A foto é dado pessoal: o próprio, ou quem gere o centro (rhAccess).
      const viewer = await rhViewer(ctx.user);
      const ref = await rhEmployeeRefOrThrow(input.employeeId);
      if (!canEditPersonal(viewer, ref)) throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão para alterar a foto desta ficha." });
      await assertEmployeeWriteScope(viewer, ref);
      const { storagePut } = await import("./storage");
      const buffer = Buffer.from(input.fileBase64, "base64");
      const ext = input.mimeType.split("/")[1] ?? "jpg";
      const key = `employees/${input.employeeId}/photo-${Date.now()}.${ext}`;
      const { url } = await storagePut(key, buffer, input.mimeType);
      await updateEmployee(input.employeeId, { photoUrl: url, photoKey: key });
      return { url, key };
    }),

  // O PRÓPRIO utilizador define/troca a sua foto de perfil (obrigatória p/ ponto).
  uploadMyPhoto: protectedProcedure
    .input(z.object({ fileBase64: z.string(), mimeType: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const me = await getEmployeeByUserId(ctx.user.id);
      if (!me) throw new TRPCError({ code: "FORBIDDEN", message: "A tua conta não está associada a um colaborador." });
      const { storagePut } = await import("./storage");
      const buffer = Buffer.from(input.fileBase64, "base64");
      const ext = input.mimeType.split("/")[1] ?? "jpg";
      const key = `employees/${me.employee.id}/photo-${Date.now()}.${ext}`;
      const { url } = await storagePut(key, buffer, input.mimeType);
      await updateEmployee(me.employee.id, { photoUrl: url, photoKey: key });
      return { url, key };
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
        label: z.string().optional(),
        fileBase64: z.string(),
        mimeType: z.string(),
        fileName: z.string(),
      }))
      .mutation(async ({ ctx, input }) => {
        await assertCanUploadDocuments(ctx.user, input.employeeId);
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
        });
        await logActivity({ userId: ctx.user.id, action: "upload", entity: "employee_document", entityId: input.employeeId, details: `Documento carregado: ${input.docType}` });
        // IA lê o documento e preenche os campos VAZIOS da ficha (best-effort)
        let autofill: { filled: string[] } = { filled: [] };
        try {
          const { autofillFromDocument } = await import("./documentAutofill");
          const r = await autofillFromDocument({ employeeId: input.employeeId, docType: input.docType, mimeType: input.mimeType, base64: input.fileBase64, userId: ctx.user.id });
          autofill = { filled: r.filled };
        } catch (err) { console.warn("[documents.upload] leitura por IA falhou:", String((err as any)?.message ?? err).slice(0, 200)); }
        return { url, key, autofill };
      }),

    uploadBatch: protectedProcedure
      .input(z.object({
        employeeId: z.number(),
        docType: z.enum(["id_card","residence_permit","driving_license","nib_proof","address_proof","contract","extra_contract","contract_annex","responsibility_term","work_accident_insurance","photo","other"]),
        files: z.array(z.object({
          fileBase64: z.string(),
          mimeType: z.string(),
          fileName: z.string(),
          label: z.string().optional(),
        })),
      }))
      .mutation(async ({ ctx, input }) => {
        await assertCanUploadDocuments(ctx.user, input.employeeId);
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
          });
          results.push({ url, key });
        }
        await logActivity({ userId: ctx.user.id, action: "upload", entity: "employee_document", entityId: input.employeeId, details: `${input.files.length} documentos carregados: ${input.docType}` });
        // IA: lê as páginas (ex.: frente e verso do CC) até preencher o que falta
        const filled: string[] = [];
        try {
          const { autofillFromDocument } = await import("./documentAutofill");
          for (const f of input.files.slice(0, 3)) {
            const r = await autofillFromDocument({ employeeId: input.employeeId, docType: input.docType, mimeType: f.mimeType, base64: f.fileBase64, userId: ctx.user.id });
            filled.push(...r.filled);
            if (r.skipped) break;
          }
        } catch (err) { console.warn("[documents.uploadBatch] leitura por IA falhou:", String((err as any)?.message ?? err).slice(0, 200)); }
        return Object.assign(results, { autofill: { filled } });
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
        const map = await getAllEmployeesDocumentStatus();
        const MANDATORY = ["photo","id_card","driving_license","nib_proof","address_proof","contract","responsibility_term"];
        const result: Record<number, { total: number; present: number; missing: string[] }> = {};
        if (map instanceof Map) {
          map.forEach((types, empId) => {
            const missing = MANDATORY.filter(t => !types.has(t));
            result[empId] = { total: MANDATORY.length, present: MANDATORY.length - missing.length, missing };
          });
        }
        return result;
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        // admin+ (ficha não protegida), ou quem carregou o documento e ainda
        // pode mexer na ficha (o próprio, gestor do centro, backoffice).
        const { getDb } = await import("./db");
        const { employeeDocuments } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });
        const [doc] = await db.select().from(employeeDocuments).where(eq(employeeDocuments.id, input.id)).limit(1);
        if (!doc) throw new TRPCError({ code: "NOT_FOUND" });
        const viewer = await rhViewer(ctx.user);
        const ref = await rhEmployeeRef(doc.employeeId);
        const allowed = ref ? canDeleteDocument(viewer, ref, doc.uploadedById) : isRhAdmin(viewer);
        if (!allowed) throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão para eliminar este documento" });
        await deleteEmployeeDocument(input.id);
        await logActivity({ userId: ctx.user.id, action: "delete", entity: "employee_document", entityId: doc.id, details: `${doc.docType} de #${doc.employeeId}` });
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
        requireAccess(ctx.user, "rh", "manage");
        await upsertSchedule({ ...input, isWorkDay: input.isWorkDay ? 1 : 0 });
        return { success: true };
      }),

    delete: protectedProcedure
      .input(z.object({ employeeId: z.number(), weekday: z.number().min(0).max(6) }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "manage");
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
        requireAccess(ctx.user, "rh", "manage");
        await reviewTimeRecord(input.id, input.decision, ctx.user.id, input.note ?? null, input.correctedHours ?? null);
        await logActivity({ userId: ctx.user.id, action: "review", entity: "time_record", entityId: input.id, details: `${input.decision}${input.correctedHours != null ? ` (${input.correctedHours}h)` : ""}${input.note ? ` — ${input.note}` : ""}` });
        return { success: true };
      }),

    checkIn: protectedProcedure
      .input(z.object({
        employeeId: z.number(),
        photoBase64: z.string().optional(),
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
          const { storagePut } = await import("./storage");
          const buffer = Buffer.from(input.photoBase64, "base64");
          const ext = input.mimeType.split("/")[1] ?? "jpg";
          const key = `employees/${input.employeeId}/ponto/${Date.now()}.${ext}`;
          const result = await storagePut(key, buffer, input.mimeType);
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
        photoBase64: z.string().optional(),
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
          const { storagePut } = await import("./storage");
          const buffer = Buffer.from(input.photoBase64, "base64");
          const ext = input.mimeType.split("/")[1] ?? "jpg";
          const key = `employees/${input.employeeId}/ponto/${Date.now()}-out.${ext}`;
          const result = await storagePut(key, buffer, input.mimeType);
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
      return listProjectGeofences();
    }),
    setGeofence: protectedProcedure
      .input(z.object({ projectId: z.number(), lat: z.number(), lng: z.number(), radiusM: z.number().min(50).max(50000) }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "manage");
        await setProjectGeofence(input.projectId, input.lat, input.lng, input.radiusM);
        await logActivity({ userId: ctx.user.id, action: "update", entity: "project_geofence", entityId: input.projectId });
        return { success: true };
      }),
    deleteGeofence: protectedProcedure
      .input(z.object({ projectId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "manage");
        await deleteProjectGeofence(input.projectId);
        return { success: true };
      }),

    monthlyHours: protectedProcedure
      .input(z.object({ employeeId: z.number(), year: z.number(), month: z.number() }))
      .query(async ({ ctx, input }) => {
        await assertOwnOrScopedEmployee(ctx.user, input.employeeId, "admin");
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
        await assertOwnOrScopedEmployee(ctx.user, input.employeeId, "admin");
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
        requireAccess(ctx.user, "rh", "manage");
        await createEmployeeLeave({ ...input, createdById: ctx.user.id });
        await logActivity({ userId: ctx.user.id, action: "create", entity: "employee_leave", entityId: input.employeeId, details: `${input.leaveType} ${input.fromDate}→${input.toDate}` });
        return { success: true };
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "manage");
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
        await clearPenalty(input.id, ctx.user.id);
        await logActivity({ userId: ctx.user.id, action: "clear", entity: "employee_penalty", entityId: input.id });
        return { success: true };
      }),
    // Gera "POSSÍVEIS faltas" (pendentes) — só contam pontos depois de confirmadas.
    processNoShows: protectedProcedure
      .input(z.object({ date: z.string() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "rh", "manage");
        const report = await detectExtraDiaNoShows(input.date);
        await logActivity({ userId: ctx.user.id, action: "process_noshows", entity: "extras_dia", details: `${input.date}: ${report.created} possíveis faltas` });
        return report;
      }),
    pending: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "rh", "edit");
      return listPendingPenalties();
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
