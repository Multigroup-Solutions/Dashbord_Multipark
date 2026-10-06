/**
 * Router `operational` (Operacional: PDAs, ponto dos condutores, Zello…) —
 * saiu do routers.ts a 1 out 2026 (P2, só mudança de sítio).
 */
import { TRPCError } from "@trpc/server";
import { requireGlobalCityAccess } from './cityScope';
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { requireAccess, isOwnOnly } from "./_core/access";
import { ROLE_RANK as ACCESS_ROLE_RANK } from "../shared/access";
import { logActivity, getEmployeeByUserId, getVehicles, getVehicleById, createVehicle, updateVehicle, deleteVehicle, getVehicleMovements, createVehicleMovement, getSpeedAlerts, createSpeedAlert, acknowledgeSpeedAlert, getRadioTranscriptions, createRadioTranscription, getOperationalStats, getVehicleDriverHistory, getSpeedLimits, getDefaultSpeedLimit, createSpeedLimit, updateSpeedLimit, deleteSpeedLimit, recordSpeedViolation, getSpeedViolations, acknowledgeSpeedViolation, getSpeedViolationStats, getDailyDriverHistoryByDate, getDailyDriverHistoryByUser, getDailyDriverHistoryRange, getDailyDriverStats, createPda, updatePda, listPdas, getPdaById, createPdaCheckin, checkoutPda, getActiveCheckins, getCheckinsByDate, getCheckinsByPda, createGpsAlert, getGpsAlerts, acknowledgeGpsAlert, getGpsAlertStats } from "./db";
import { getZelloUsers, getZelloChannels, getZelloLocations, getZelloUserHistory, getZelloUserLocation } from "./zello";
import { collectDailyDriverData } from "./jobs/dailyDriverCollection";
import { requireRole } from "./routerGuards";

export const operationalRouter = router({
  dashboard: protectedProcedure.query(async ({ ctx }) => {
    requireAccess(ctx.user, "atividade_diaria", "view");
    return getOperationalStats();
  }),

  vehicles: router({
    // frontoffice: usado nas Reclamações (associar viatura)
    list: protectedProcedure.input(z.object({ status: z.string().optional(), projectId: z.number().optional() }).optional()).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "atividade_diaria", "view");
      return getVehicles(input ?? undefined);
    }),
    get: protectedProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "atividade_diaria", "view");
      return getVehicleById(input.id);
    }),
    create: protectedProcedure.input(z.object({
      plate: z.string().min(1),
      brand: z.string().optional(),
      model: z.string().optional(),
      year: z.number().optional(),
      color: z.string().optional(),
      status: z.enum(["active", "maintenance", "inactive"]).optional(),
      projectId: z.number().optional(),
      notes: z.string().optional(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "atividade_diaria", "manage");
      const id = await createVehicle({
        plate: input.plate,
        brand: input.brand ?? null,
        model: input.model ?? null,
        year: input.year ?? null,
        color: input.color ?? null,
        vehicleStatus: input.status ?? "active",
        projectId: input.projectId ?? null,
        notes: input.notes ?? null,
      });
      await logActivity({ userId: ctx.user.id, action: "create", entity: "vehicle", entityId: id, details: `Viatura ${input.plate}` });
      return { id };
    }),
    update: protectedProcedure.input(z.object({
      id: z.number(),
      data: z.object({
        plate: z.string().optional(),
        brand: z.string().optional(),
        model: z.string().optional(),
        year: z.number().optional(),
        color: z.string().optional(),
        status: z.enum(["active", "maintenance", "inactive"]).optional(),
        projectId: z.number().nullable().optional(),
        notes: z.string().optional(),
      }),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "atividade_diaria", "manage");
      const { status, ...rest } = input.data;
      await updateVehicle(input.id, { ...rest, ...(status !== undefined && { vehicleStatus: status }) });
      await logActivity({ userId: ctx.user.id, action: "update", entity: "vehicle", entityId: input.id, details: "Viatura atualizada" });
      return { success: true };
    }),
    delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      requireRole(ctx.user.role, "super_admin");
      await deleteVehicle(input.id);
      await logActivity({ userId: ctx.user.id, action: "delete", entity: "vehicle", entityId: input.id, details: "Viatura eliminada" });
      return { success: true };
    }),
    driverHistory: protectedProcedure.input(z.object({ vehicleId: z.number() })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "atividade_diaria", "view");
      return getVehicleDriverHistory(input.vehicleId);
    }),
  }),

  movements: router({
    list: protectedProcedure.input(z.object({ vehicleId: z.number().optional(), employeeId: z.number().optional(), limit: z.number().optional() }).optional()).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "atividade_diaria", "view");
      return getVehicleMovements(input ?? undefined);
    }),
    create: protectedProcedure.input(z.object({
      vehicleId: z.number(),
      employeeId: z.number(),
      type: z.enum(["pickup", "return"]),
      kmReading: z.number().optional(),
      latitude: z.string().optional(),
      longitude: z.string().optional(),
      notes: z.string().optional(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "atividade_diaria", "edit");
      const id = await createVehicleMovement({
        vehicleId: input.vehicleId,
        employeeId: input.employeeId,
        movementType: input.type,
        kmReading: input.kmReading ?? null,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        notes: input.notes ?? null,
      });
      await logActivity({ userId: ctx.user.id, action: "create", entity: "vehicle_movement", entityId: id, details: `${input.type === "pickup" ? "Recolha" : "Devolução"} viatura #${input.vehicleId}` });
      return { id };
    }),
  }),

  speedAlerts: router({
    list: protectedProcedure.input(z.object({ vehicleId: z.number().optional(), acknowledged: z.boolean().optional(), limit: z.number().optional() }).optional()).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "atividade_diaria", "view");
      return getSpeedAlerts(input ?? undefined);
    }),
    create: protectedProcedure.input(z.object({
      vehicleId: z.number(),
      employeeId: z.number().optional(),
      speed: z.number(),
      speedLimit: z.number(),
      latitude: z.string().optional(),
      longitude: z.string().optional(),
      roadName: z.string().optional(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "atividade_diaria", "edit");
      const id = await createSpeedAlert({
        vehicleId: input.vehicleId,
        employeeId: input.employeeId ?? null,
        speed: input.speed,
        speedLimit: input.speedLimit,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        roadName: input.roadName ?? null,
      });
      // Aviso `speed_alert` (chefias da cidade do condutor + quem vê todas).
      const { notify } = await import("./notify");
      await notify({
        kind: "speed_alert", employeeId: input.employeeId ?? null,
        title: "Alerta de Velocidade",
        body: `Viatura #${input.vehicleId} a ${input.speed} km/h (limite: ${input.speedLimit} km/h)${input.roadName ? " em " + input.roadName : ""}`,
        link: "/operacional", entity: { type: "speed_alert", id },
      });
      await logActivity({ userId: ctx.user.id, action: "create", entity: "speed_alert", entityId: id, details: `${input.speed}km/h (limite ${input.speedLimit}km/h)` });
      return { id };
    }),
    acknowledge: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "atividade_diaria", "manage");
      await acknowledgeSpeedAlert(input.id, ctx.user.id);
      return { success: true };
    }),
  }),

  radio: router({
    // Página de 50 (máx. 200), mais recentes primeiro; `cursor` (o id da
    // última vista) continua para as mais antigas ("Ver mais").
    list: protectedProcedure.input(z.object({
      employeeId: z.number().int().positive().optional(),
      vehicleId: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      cursor: z.number().int().positive().nullish(),
    }).optional()).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "radio", "view");
      return getRadioTranscriptions({ ...input, beforeId: input?.cursor ?? undefined });
    }),
    transcribe: protectedProcedure.input(z.object({
      audioUrl: z.string().trim().min(1).max(2048),
      employeeId: z.number().int().positive().optional(),
      vehicleId: z.number().int().positive().optional(),
      duration: z.number().int().min(0).max(24 * 3600).optional(),
    })).mutation(async ({ ctx, input }) => {
      // Transcrição com custo real (IA). Restringir a team_leader+.
      requireAccess(ctx.user, "radio", "edit");
      // O servidor descarrega o áudio: só ficheiros do NOSSO storage (o que o
      // "Carregar ficheiro" grava), nunca um endereço qualquer.
      const { readS3Env, isS3OwnedUrl } = await import("./storage");
      const s3 = readS3Env();
      if (s3 && !isS3OwnedUrl(s3, input.audioUrl)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "O áudio tem de ser carregado aqui (escolhe o ficheiro e carrega em Transcrever)." });
      }
      const { transcribeAndSummarizeRadio } = await import("./radioAi");
      const { aiTrpcError } = await import("./_core/ai/trpcError");
      let transcriptionText: string;
      let summaryText: string;
      try {
        ({ transcription: transcriptionText, summary: summaryText } = await transcribeAndSummarizeRadio(input.audioUrl, { userId: ctx.user.id }));
      } catch (err) {
        throw aiTrpcError(err);
      }
      const id = await createRadioTranscription({
        audioUrl: input.audioUrl,
        transcription: transcriptionText,
        summary: summaryText,
        employeeId: input.employeeId ?? null,
        vehicleId: input.vehicleId ?? null,
        duration: input.duration ?? null,
        transcribedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
        createdById: ctx.user.id,
      });
      await logActivity({ userId: ctx.user.id, action: "create", entity: "radio_transcription", entityId: id, details: "Transcrição de rádio" });
      return { id, transcription: transcriptionText, summary: summaryText };
    }),

    // ─── 32a: gravações do Zello × GPS × Multipark ─────────────────────────
    /** Utilizadores e canais do Zello para os filtros. */
    zelloOptions: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "radio", "view");
      const { isZelloConfigured } = await import("./zello");
      if (!isZelloConfigured()) return { configured: false as const, users: [], channels: [] };
      const [users, channels] = await Promise.all([getZelloUsers().catch(() => []), getZelloChannels().catch(() => [])]);
      return {
        configured: true as const,
        users: users.map((u) => ({ username: u.name, fullName: u.fullName || u.name })).sort((a, b) => a.fullName.localeCompare(b.fullName, "pt")),
        channels: channels.map((c) => c.name).sort((a, b) => a.localeCompare(b, "pt")),
      };
    }),
    /** Mensagens de voz do Zello num intervalo (máx. 24 h), com quem falou, GPS e ações na Multipark. */
    zelloSearch: protectedProcedure.input(z.object({
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      from: z.string().regex(/^\d{2}:\d{2}$/),
      to: z.string().regex(/^\d{2}:\d{2}$/),
      user: z.string().trim().min(1).max(128).optional(),
      channel: z.string().trim().min(1).max(128).optional(),
      includeReceived: z.boolean().optional(),
      start: z.number().int().min(0).max(100_000).optional(),
    })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "radio", "view");
      const { radioRange } = await import("../shared/radioCross");
      const range = radioRange(input.day, input.from, input.to);
      if ("error" in range) throw new TRPCError({ code: "BAD_REQUEST", message: range.error });
      const [{ searchZelloRadio }, { scopedProjectIds }] = await Promise.all([import("./radioZello"), import("./cityScope")]);
      return searchZelloRadio({ ...range, user: input.user ?? null, channel: input.channel ?? null, includeReceived: input.includeReceived, start: input.start, scopeProjectIds: scopedProjectIds() });
    }),
    /**
     * 36a: o áudio de uma mensagem do Zello, descarregado pelo servidor (o link
     * do Zello aberto no browser ficava a "0 segundos"); "a preparar"
     * enquanto o Zello o converte.
     */
    zelloAudio: protectedProcedure.input(z.object({ key: z.string().trim().regex(/^[A-Za-z0-9_.-]{4,200}$/) })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "radio", "view");
      const { zelloAudio } = await import("./radioZello");
      try {
        return await zelloAudio(input.key);
      } catch (err) {
        throw new TRPCError({ code: "BAD_GATEWAY", message: `O Zello não deu o áudio: ${String((err as Error)?.message ?? err).replace(/sid=[^&\s]+/g, "sid=…").slice(0, 160)}` });
      }
    }),
    /** Transcreve com a IA uma mensagem que o Zello não transcreveu (fica ligada a ela; não se paga duas vezes). */
    zelloTranscribe: protectedProcedure.input(z.object({
      messageId: z.number().int().positive(),
      mediaKey: z.string().trim().regex(/^[A-Za-z0-9_.-]{4,200}$/),
      durationS: z.number().min(0).max(24 * 3600).optional(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "radio", "edit");
      const [{ transcribeZelloMessage }, { aiTrpcError }] = await Promise.all([import("./radioZello"), import("./_core/ai/trpcError")]);
      let r: Awaited<ReturnType<typeof transcribeZelloMessage>>;
      try {
        r = await transcribeZelloMessage({ messageId: input.messageId, mediaKey: input.mediaKey, durationS: input.durationS ?? null, userId: ctx.user.id });
      } catch (err) {
        throw aiTrpcError(err);
      }
      if (!("pending" in r) && !r.reused) await logActivity({ userId: ctx.user.id, action: "create", entity: "radio_transcription", entityId: r.id, details: `Transcrição (IA) da mensagem ${input.messageId} do Zello` });
      return r;
    }),

    // ─── 34a: provas (mensagens guardadas com a transcrição e o histórico) ──
    /** Guarda mensagens do Zello como prova: o servidor volta a lê-las (nada vem do browser). */
    evidenceSave: protectedProcedure.input(z.object({
      picks: z.array(z.object({
        id: z.number().int().positive(),
        at: z.number().int().positive(),
        sender: z.string().trim().min(1).max(128),
      })).min(1).max(10),
      situation: z.string().max(400),
      reference: z.string().max(200).optional(),
      notes: z.string().max(4000).optional(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "radio", "edit");
      // 36a: só supervisor, backoffice, admin e super admin
      const { canSaveEvidence } = await import("../shared/radioEvidence");
      if (!canSaveEvidence(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN", message: "Guardar provas é só para supervisores, backoffice e administração." });
      const now = Date.now();
      if (input.picks.some((p) => p.at > now + 60_000 || p.at < now - 400 * 86_400_000)) throw new TRPCError({ code: "BAD_REQUEST", message: "Mensagem fora do histórico do Zello." });
      const [{ saveRadioEvidence }, { scopedProjectIds }] = await Promise.all([import("./radioEvidence"), import("./cityScope")]);
      let r: Awaited<ReturnType<typeof saveRadioEvidence>>;
      try {
        r = await saveRadioEvidence({ picks: input.picks, input: { situation: input.situation, reference: input.reference, notes: input.notes }, userId: ctx.user.id, scopeProjectIds: scopedProjectIds() });
      } catch (err) {
        throw new TRPCError({ code: "BAD_REQUEST", message: String((err as Error)?.message ?? err).slice(0, 200) });
      }
      for (const s of r.saved) await logActivity({ userId: ctx.user.id, action: "create", entity: "radio_evidence", entityId: s.id, details: `Prova do rádio: mensagem ${s.messageId} do Zello — ${input.situation.trim().slice(0, 120)}` });
      return r;
    }),
    /** Provas guardadas (as mais recentes primeiro), com o âmbito de cidade. */
    evidenceList: protectedProcedure.input(z.object({
      q: z.string().trim().max(100).optional(),
      includeArchived: z.boolean().optional(),
      cursor: z.number().int().positive().nullish(),
    }).optional()).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "radio", "view");
      const [{ listRadioEvidence }, { scopedProjectIds }] = await Promise.all([import("./radioEvidence"), import("./cityScope")]);
      return listRadioEvidence({ q: input?.q ?? null, includeArchived: input?.includeArchived, beforeId: input?.cursor ?? null, scopeProjectIds: scopedProjectIds() });
    }),
    /** Junta o áudio do Zello à prova (o Zello pode ainda estar a converter → "pending"). */
    evidenceAttachAudio: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "radio", "edit");
      const { canSaveEvidence } = await import("../shared/radioEvidence");
      if (!canSaveEvidence(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN", message: "Juntar o áudio às provas é só para supervisores, backoffice e administração." });
      const [{ getRadioEvidence, attachEvidenceAudio }, { scopedProjectIds }] = await Promise.all([import("./radioEvidence"), import("./cityScope")]);
      const e = await getRadioEvidence(input.id, scopedProjectIds());
      if (!e) throw new TRPCError({ code: "NOT_FOUND", message: "Prova não encontrada." });
      try {
        return await attachEvidenceAudio(input.id);
      } catch (err) {
        throw new TRPCError({ code: "BAD_GATEWAY", message: String((err as Error)?.message ?? err).slice(0, 200) });
      }
    }),
    /** Link (temporário) para ouvir o áudio guardado da prova. */
    evidenceAudioUrl: protectedProcedure.input(z.object({ id: z.number().int().positive() })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "radio", "view");
      const [{ getRadioEvidence }, { scopedProjectIds }, { signedFileUrl }] = await Promise.all([import("./radioEvidence"), import("./cityScope"), import("./caseOps")]);
      const e = await getRadioEvidence(input.id, scopedProjectIds());
      if (!e) throw new TRPCError({ code: "NOT_FOUND", message: "Prova não encontrada." });
      return { url: e.audioKey ? await signedFileUrl(e.audioKey, e.audioUrl) : null };
    }),
    /** Arquivar (nunca apagar), com motivo. */
    evidenceArchive: protectedProcedure.input(z.object({ id: z.number().int().positive(), reason: z.string().max(400) })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "radio", "manage");
      const [{ getRadioEvidence, archiveRadioEvidence }, { scopedProjectIds }] = await Promise.all([import("./radioEvidence"), import("./cityScope")]);
      const e = await getRadioEvidence(input.id, scopedProjectIds());
      if (!e) throw new TRPCError({ code: "NOT_FOUND", message: "Prova não encontrada." });
      try {
        await archiveRadioEvidence(input.id, ctx.user.id, input.reason);
      } catch (err) {
        throw new TRPCError({ code: "BAD_REQUEST", message: String((err as Error)?.message ?? err).slice(0, 200) });
      }
      await logActivity({ userId: ctx.user.id, action: "archive", entity: "radio_evidence", entityId: input.id, details: `Prova do rádio arquivada: ${input.reason.trim().slice(0, 150)}` });
      return { ok: true };
    }),
  }),

  // ─── ZELLO INTEGRATION ──────────────────────────────────────────────
  zello: router({
    users: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "atividade_diaria", "view");
      const [users, { loadZelloGpsExclusions }, { isZelloGpsExcluded }] = await Promise.all([
        getZelloUsers(), import("./zello"), import("../shared/appSettings"),
      ]);
      const excluded = await loadZelloGpsExclusions();
      return users.map((u) => ({ ...u, gpsExcluded: isZelloGpsExcluded(u.name, excluded) }));
    }),
    // Resolução Zello→pessoa para o mapa ao vivo: check-ins de PDA ativos
    // primeiro (os "Extra NNN" vivem nos PDAs e cada dia é uma pessoa
    // diferente), ligações fixas da ficha como fallback.
    mappings: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "atividade_diaria", "view");
      const { getZelloLiveMappings } = await import("./db");
      return getZelloLiveMappings();
    }),
    // Anexa (ou desanexa) um utilizador Zello a um colaborador — PERSISTENTE,
    // como o mapping de agentes Multipark. Único: limpa o username de quem o
    // tivesse. O GPS passa a mostrar o colaborador em vez de "extra600".
    mapUserToEmployee: protectedProcedure
      .input(z.object({ zelloUsername: z.string().min(1), employeeId: z.number().nullable() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "atividade_diaria", "edit");
        const { getDb } = await import("./db");
        const { sql } = await import("drizzle-orm");
        const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });
        await db.execute(sql`UPDATE employees SET zelloUsername = NULL WHERE zelloUsername = ${input.zelloUsername}`);
        if (input.employeeId != null) {
          await db.execute(sql`UPDATE employees SET zelloUsername = ${input.zelloUsername} WHERE id = ${input.employeeId}`);
        }
        await logActivity({ userId: ctx.user.id, action: "map_zello", entity: "employees", entityId: input.employeeId ?? undefined, details: `zello=${input.zelloUsername}` });
        return { success: true };
      }),
    channels: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "atividade_diaria", "view");
      return getZelloChannels();
    }),
    locations: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "atividade_diaria", "view");
      return getZelloLocations();
    }),
    userLocation: protectedProcedure.input(z.object({ username: z.string() })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "atividade_diaria", "view");
      return getZelloUserLocation(input.username);
    }),
    userHistory: protectedProcedure.input(z.object({
      username: z.string(),
      startTs: z.number(),
      endTs: z.number(),
    })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "atividade_diaria", "view");
      return getZelloUserHistory(input.username, input.startTs, input.endTs);
    }),
  }),

  // ─── SPEED MONITORING ──────────────────────────────────────────────
  speedMonitoring: router({
    limits: router({
      list: protectedProcedure.query(async ({ ctx }) => {
        requireAccess(ctx.user, "atividade_diaria", "view");
        return getSpeedLimits();
      }),
      create: protectedProcedure.input(z.object({
        name: z.string().min(1),
        maxSpeed: z.number().min(1),
        tolerancePercent: z.number().min(0).max(100).default(10),
        isDefault: z.boolean().default(false),
      })).mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "atividade_diaria", "manage");
        const id = await createSpeedLimit({
          name: input.name,
          maxSpeed: input.maxSpeed,
          tolerancePercent: input.tolerancePercent,
          isDefault: input.isDefault ? 1 : 0,
        });
        await logActivity({ userId: ctx.user.id, action: "create", entity: "speed_limit", entityId: id, details: `Limite ${input.name}: ${input.maxSpeed}km/h` });
        return { id };
      }),
      update: protectedProcedure.input(z.object({
        id: z.number(),
        data: z.object({
          name: z.string().optional(),
          maxSpeed: z.number().optional(),
          tolerancePercent: z.number().optional(),
          isDefault: z.boolean().optional(),
          isActive: z.boolean().optional(),
        }),
      })).mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "atividade_diaria", "manage");
        const { isDefault, isActive, ...rest } = input.data;
        const patch: Record<string, unknown> = { ...rest };
        if (isDefault !== undefined) patch.isDefault = isDefault ? 1 : 0;
        if (isActive !== undefined) patch.isActive = isActive ? 1 : 0;
        await updateSpeedLimit(input.id, patch);
        return { success: true };
      }),
      delete: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "atividade_diaria", "manage");
        await deleteSpeedLimit(input.id);
        return { success: true };
      }),
    }),

    violations: router({
      list: protectedProcedure.input(z.object({
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        username: z.string().optional(),
        acknowledged: z.boolean().optional(),
      }).optional()).query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "atividade_diaria", "view");
        return getSpeedViolations({
          startDate: input?.startDate ? new Date(input.startDate) : undefined,
          endDate: input?.endDate ? new Date(input.endDate) : undefined,
          username: input?.username,
          acknowledged: input?.acknowledged,
        });
      }),
      acknowledge: protectedProcedure.input(z.object({
        id: z.number(),
        notes: z.string().optional(),
      })).mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "atividade_diaria", "manage");
        await acknowledgeSpeedViolation(input.id, ctx.user.id, input.notes);
        await logActivity({ userId: ctx.user.id, action: "update", entity: "speed_violation", entityId: input.id, details: "Infração reconhecida" });
        return { success: true };
      }),
      stats: protectedProcedure.input(z.object({
        startDate: z.string().optional(),
        endDate: z.string().optional(),
      }).optional()).query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "atividade_diaria", "view");
        return getSpeedViolationStats(
          input?.startDate ? new Date(input.startDate) : undefined,
          input?.endDate ? new Date(input.endDate) : undefined,
        );
      }),
    }),

    /** Check all Zello locations and record violations */
    checkNow: protectedProcedure.mutation(async ({ ctx }) => {
      requireAccess(ctx.user, "atividade_diaria", "manage");
      const locations = await getZelloLocations();
      const defaultLimit = await getDefaultSpeedLimit();
      if (!defaultLimit) return { checked: 0, violations: 0, message: "Nenhum limite de velocidade configurado" };

      const threshold = defaultLimit.maxSpeed * (1 + defaultLimit.tolerancePercent / 100);
      let violationCount = 0;

      for (const loc of locations) {
        if (loc.speed > threshold) {
          const excessPercent = ((loc.speed - defaultLimit.maxSpeed) / defaultLimit.maxSpeed) * 100;
          await recordSpeedViolation({
            zelloUsername: loc.username,
            displayName: loc.displayName || loc.username,
            speed: String(loc.speed),
            speedLimit: defaultLimit.maxSpeed,
            excessPercent: String(Math.round(excessPercent * 100) / 100),
            latitude: loc.latitude ? String(loc.latitude) : null,
            longitude: loc.longitude ? String(loc.longitude) : null,
            heading: loc.heading ? String(loc.heading) : null,
            notificationSent: 1,
            occurredAt: new Date().toISOString().slice(0, 19).replace("T", " "),
          });
          violationCount++;
          // Aviso `speed_alert` (sem cidade conhecida no Zello → quem vê todas).
          const { notify } = await import("./notify");
          await notify({
            kind: "speed_alert",
            title: "Excesso de Velocidade",
            body: `${loc.displayName || loc.username} a ${loc.speed.toFixed(1)} km/h (limite: ${defaultLimit.maxSpeed} km/h, +${excessPercent.toFixed(0)}%) - Lat: ${loc.latitude}, Lon: ${loc.longitude}`,
            link: "/operacional", entity: { type: "zello_speed", id: loc.username },
          });
        }
      }

      return { checked: locations.length, violations: violationCount, threshold };
    }),
  }),

  // ─── DAILY DRIVER HISTORY ──────────────────────────────────────────
  driverHistory: router({
    byDate: protectedProcedure.input(z.object({ date: z.string(), projectId: z.number().optional() })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "historico_diario", "view");
      return getDailyDriverHistoryByDate(input.date);
    }),
    byUser: protectedProcedure.input(z.object({ username: z.string(), projectId: z.number().optional(), limit: z.number().optional() })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "historico_diario", "view");
      return getDailyDriverHistoryByUser(input.username, input.limit);
    }),
    range: protectedProcedure.input(z.object({ startDate: z.string(), endDate: z.string() })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "historico_diario", "view");
      return getDailyDriverHistoryRange(input.startDate, input.endDate);
    }),
    stats: protectedProcedure.input(z.object({ date: z.string(), projectId: z.number().optional() })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "historico_diario", "view");
      return getDailyDriverStats(input.date);
    }),
    /**
     * Recolha manual de um dia (só admin — abrange todas as cidades). Prazo de
     * 45 s (a função morre aos 60 s): devolve `done:false` e a UI volta a
     * chamar — a recolha é retomável. `resplit`: volta a partir o GPS já
     * recolhido por quem tinha cada PDA (depois de corrigir check-ins) — não
     * mexe nas velocidades (já em km/h).
     */
    collectDay: protectedProcedure.input(z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      projectId: z.number().optional(),
      resplit: z.boolean().optional(),
      afterId: z.number().optional(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "historico_diario", "manage");
      requireGlobalCityAccess();
      const deadlineAt = Date.now() + 45_000;
      if (input.resplit) {
        const { resplitDriverDay } = await import("./jobs/dailyDriverCollection");
        const r = await resplitDriverDay(input.date, { deadlineAt, afterId: input.afterId });
        if (r.done) await logActivity({ userId: ctx.user.id, action: "update", entity: "daily_driver_history", entityId: 0, details: `Re-divisão do GPS de ${input.date} por PDA` });
        return { success: true, done: r.done, driversProcessed: r.processed, errors: r.errors, nextAfterId: r.nextAfterId, mode: "resplit" as const };
      }
      // Meio-dia UTC → o dia de Lisboa é sempre `input.date`
      // Manual: volta também a buscar as linhas finais VAZIAS (antigo bug do D-1).
      const result = await collectDailyDriverData(new Date(`${input.date}T12:00:00Z`), { deadlineAt, retryEmpty: true });
      await logActivity({ userId: ctx.user.id, action: "create", entity: "daily_driver_history", entityId: 0, details: `Recolha manual para ${input.date}: ${result.driversProcessed} motoristas${result.done ? "" : " (parcial)"}` });
      return { ...result, nextAfterId: null as number | null, mode: "collect" as const };
    }),
    /** Histórico de velocidade de UMA pessoa (ou Zello sem login): por dia. */
    personHistory: protectedProcedure.input(z.object({
      employeeId: z.number().optional(), zelloUsername: z.string().max(255).optional(),
      days: z.number().int().min(1).max(366).default(30), projectId: z.number().optional(),
    })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "historico_diario", "view", { allowOwn: true });
      const { getPersonSpeedHistory } = await import("./dayActivity");
      // extra/condutor: só o PRÓPRIO histórico (a ficha da conta), nunca outro.
      if (isOwnOnly(ctx.user, "historico_diario")) {
        const me = await getEmployeeByUserId(ctx.user.id);
        if (!me) throw new TRPCError({ code: "FORBIDDEN", message: "Sem ficha associada." });
        return getPersonSpeedHistory({ ...input, employeeId: me.employee.id, zelloUsername: undefined });
      }
      return getPersonSpeedHistory(input);
    }),
    people: protectedProcedure.input(z.object({ projectId: z.number().optional() }).optional()).query(async ({ ctx }) => {
      requireAccess(ctx.user, "historico_diario", "view");
      const { listSpeedHistoryPeople, speedThreshold } = await import("./dayActivity");
      return { ...(await listSpeedHistoryPeople(90)), threshold: await speedThreshold() };
    }),
  }),

  // ─── A trabalhar sem PDA ou Zello ligado (passo 4, server/opsPresence.ts) ──
  opsPresence: router({
    list: protectedProcedure.input(z.object({ hours: z.number().int().min(1).max(168).optional() }).optional()).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "pdas", "view");
      const { listPresenceAlerts } = await import("./opsPresence");
      return listPresenceAlerts(input?.hours ?? 24);
    }),
    acknowledge: protectedProcedure.input(z.object({ id: z.number().int().positive(), note: z.string().trim().max(255).optional() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "pdas", "edit");
      const { acknowledgePresenceAlert, receivedPresenceAlert } = await import("./opsPresence");
      // Team leader para cima, ou quem recebeu o aviso (o TL escalado pode ter papel de extra).
      const received = await receivedPresenceAlert(input.id, ctx.user.id);
      if ((ACCESS_ROLE_RANK[ctx.user.role as keyof typeof ACCESS_ROLE_RANK] ?? 0) < ACCESS_ROLE_RANK.team_leader && !received) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Só o team leader, o supervisor ou a administração dão \"Visto\"." });
      }
      const ok = await acknowledgePresenceAlert(input.id, ctx.user.id, input.note || null, received);
      if (!ok) throw new TRPCError({ code: "NOT_FOUND", message: "Alerta já fechado, já visto ou fora da tua cidade." });
      await logActivity({ userId: ctx.user.id, action: "update", entity: "ops_presence_alert", entityId: input.id, details: `Visto${input.note ? `: ${input.note}` : ""}` });
      return { success: true };
    }),
  }),

  // ─── PDAs (DISPOSITIVOS) ──────────────────────────────────────────
  pdas: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "pdas", "view");
      return listPdas();
    }),
    // PDA ligado AGORA ao próprio utilizador (check-in aberto) — para o Perfil.
    mine: protectedProcedure.query(async ({ ctx }) => {
      const me = await getEmployeeByUserId(ctx.user.id);
      if (!me) return null;
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return null;
      const res: any = await db.execute(sql`
          SELECT p.id, p.name, p.zelloUsername, c.checkinAt
          FROM pda_checkins c INNER JOIN pdas p ON p.id = c.pdaId
          WHERE c.employeeId = ${me.employee.id} AND c.checkin_status = 'checked_in'
          ORDER BY c.checkinAt DESC LIMIT 1`);
      const row = (Array.isArray(res?.[0]) ? res[0] : res)?.[0];
      return row ? { id: Number(row.id), name: String(row.name), zelloUsername: row.zelloUsername ?? null, since: row.checkinAt ? String(row.checkinAt) : null } : null;
    }),
    // "Este browser É o PDA X" — regista o aparelho e devolve o token que o
    // cliente guarda no localStorage. A partir daí, qualquer check-in do
    // PONTO feito neste aparelho liga a pessoa ao PDA/Zello automaticamente.
    registerDevice: protectedProcedure.input(z.object({ pdaId: z.number() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "pdas", "edit", { allowOwn: true });
      // Decisão do dono (29 set 2026): o aparelho regista-se SÓ pelo QR colado no PDA.
      if (input.pdaId > 0) throw new TRPCError({ code: "FORBIDDEN", message: "O PDA regista-se só pelo QR colado no aparelho: abre a câmara do PDA e lê o QR." });
      const { setPdaDeviceToken } = await import("./db");
      const token = await setPdaDeviceToken(input.pdaId);
      if (!token) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "BD indisponível" });
      await logActivity({ userId: ctx.user.id, action: "register_device", entity: "pda", entityId: input.pdaId, details: "Browser registado como este PDA" });
      return { token };
    }),
    // ── Fase 2: QR code, ligação no login e libertação no logout ─────────
    // Link do QR a imprimir e colar no PDA.
    qrLink: protectedProcedure.input(z.object({ pdaId: z.number() })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "pdas", "view");
      const { ensurePdaQrCode } = await import("./db");
      const code = await ensurePdaQrCode(input.pdaId);
      if (!code) throw new TRPCError({ code: "NOT_FOUND", message: "PDA não encontrado" });
      return { path: `/pda/registar?pda=${input.pdaId}&c=${code}` };
    }),
    // Ler o QR no próprio aparelho regista-o como este PDA (substitui a
    // escolha na lista). Só chefias — é uma vez por aparelho.
    registerByQr: protectedProcedure.input(z.object({ pdaId: z.number(), code: z.string().min(8).max(64) })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "pdas", "edit", { allowOwn: true });
      const { verifyPdaQrCode, setPdaDeviceToken } = await import("./db");
      const pda = await verifyPdaQrCode(input.pdaId, input.code);
      if (!pda) throw new TRPCError({ code: "BAD_REQUEST", message: "QR inválido ou PDA inativo." });
      const token = await setPdaDeviceToken(input.pdaId);
      if (!token) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "BD indisponível" });
      await logActivity({ userId: ctx.user.id, action: "register_device", entity: "pda", entityId: input.pdaId, details: `Aparelho registado por QR como ${pda.name}` });
      return { token, name: pda.name };
    }),
    // Login num PDA registado → o PDA (e o Zello) fica com esta pessoa até
    // sair ou entrar outra (PDAs partilhados entre turnos).
    claimOnLogin: protectedProcedure.input(z.object({ token: z.string().min(8) })).mutation(async ({ ctx, input }) => {
      const me = await getEmployeeByUserId(ctx.user.id);
      if (!me) return { attached: false as const, reason: "sem ficha" };
      const { attachPdaByDeviceToken } = await import("./db");
      let att: Awaited<ReturnType<typeof attachPdaByDeviceToken>>;
      try {
        att = await attachPdaByDeviceToken(input.token, me.employee.id);
      } catch (err) {
        // Nunca em silêncio: foi assim que o nome de coluna errado (checkin_status) passou semanas despercebido
        console.warn("[pda] login→PDA falhou:", err);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível ligar este aparelho a ti (PDA). Avisa a chefia." });
      }
      if (!att) return { attached: false as const, reason: "aparelho não registado" };
      if (att.changed) {
        await logActivity({ userId: ctx.user.id, action: "create", entity: "pda_checkin", entityId: att.pdaId, details: `Auto: login→PDA ${att.pdaName}${att.replacedName ? ` (substituiu ${att.replacedName})` : ""}` });
        const { syncPdaZelloName } = await import("./pdaZelloName");
        void syncPdaZelloName(att.pdaId);
      }
      return { attached: true as const, changed: att.changed, pdaName: att.pdaName, zelloUsername: att.zelloUsername, replacedName: att.replacedName };
    }),
    releaseOnLogout: protectedProcedure.input(z.object({ token: z.string().min(8) })).mutation(async ({ ctx, input }) => {
      const me = await getEmployeeByUserId(ctx.user.id);
      if (!me) return { released: 0 };
      const { releasePdaByDeviceToken } = await import("./db");
      let released = 0;
      try {
        released = await releasePdaByDeviceToken(input.token, me.employee.id);
      } catch (err) {
        console.warn("[pda] logout→soltar PDA falhou:", err);
        return { released: 0, error: true as const };
      }
      if (released) {
        await logActivity({ userId: ctx.user.id, action: "update", entity: "pda_checkin", details: "Auto: logout soltou o PDA" });
        const { syncPdaZelloNameByToken } = await import("./pdaZelloName");
        void syncPdaZelloNameByToken(input.token);
      }
      return { released };
    }),
    // Info do aparelho atual (cartão "Este aparelho" na aba PDAs) — qualquer
    // role autenticada pode consultar: os condutores precisam de ver em que
    // PDA estão a picar o ponto.
    deviceInfo: protectedProcedure.input(z.object({ token: z.string().min(8) })).query(async ({ ctx, input }) => {
      const { getPdaByDeviceToken } = await import("./db");
      return getPdaByDeviceToken(input.token);
    }),
    get: protectedProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "pdas", "view");
      return getPdaById(input.id);
    }),
    create: protectedProcedure.input(z.object({
      name: z.string().min(1),
      phoneNumber: z.string().optional(),
      imei: z.string().optional(),
      model: z.string().optional(),
      zelloUsername: z.string().optional(),
      status: z.enum(["active", "inactive", "maintenance", "lost"]).optional(),
      photoUrl: z.string().optional(),
      simDataPlan: z.string().optional(),
      notes: z.string().optional(),
      projectId: z.number().int().positive().nullable().optional(),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "pdas", "edit");
      const id = await createPda({
        projectId: input.projectId ?? null,
        name: input.name,
        phoneNumber: input.phoneNumber ?? null,
        imei: input.imei ?? null,
        model: input.model ?? null,
        zelloUsername: input.zelloUsername ?? null,
        status: input.status ?? "active",
        photoUrl: input.photoUrl ?? null,
        simDataPlan: input.simDataPlan ?? null,
        notes: input.notes ?? null,
      });
      await logActivity({ userId: ctx.user.id, action: "create", entity: "pda", entityId: id, details: `PDA ${input.name}` });
      return { id };
    }),
    update: protectedProcedure.input(z.object({
      id: z.number(),
      data: z.object({
        name: z.string().optional(),
        phoneNumber: z.string().nullable().optional(),
        imei: z.string().nullable().optional(),
        model: z.string().nullable().optional(),
        zelloUsername: z.string().nullable().optional(),
        status: z.enum(["active", "inactive", "maintenance", "lost"]).optional(),
        photoUrl: z.string().nullable().optional(),
        simDataPlan: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
        projectId: z.number().int().positive().nullable().optional(),
      }),
    })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "pdas", "edit");
      await updatePda(input.id, input.data);
      if (input.data.name !== undefined || input.data.zelloUsername !== undefined) {
        const { syncPdaZelloName } = await import("./pdaZelloName");
        void syncPdaZelloName(input.id);
      }
      await logActivity({ userId: ctx.user.id, action: "update", entity: "pda", entityId: input.id, details: "PDA atualizado" });
      return { success: true };
    }),
    // "Retirar" um PDA: passa a Inativo — NUNCA se apaga (as passagens de mão,
    // o GPS partido por quem o tinha e o dia de cada pessoa dependem dele).
    // O nome da rota fica por compatibilidade.
    delete: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "pdas", "manage");
      const pda = await getPdaById(input.id);
      if (!pda) throw new TRPCError({ code: "NOT_FOUND", message: "PDA não encontrado." });
      await updatePda(input.id, { status: "inactive" });
      await logActivity({ userId: ctx.user.id, action: "update", entity: "pda", entityId: input.id, details: `PDA retirado (passou a Inativo; histórico mantido): ${pda.name}` });
      return { success: true, retired: true };
    }),
    // Check-ins
    checkins: router({
      active: protectedProcedure.query(async ({ ctx }) => {
        requireAccess(ctx.user, "pdas", "view");
        return getActiveCheckins();
      }),
      byDate: protectedProcedure.input(z.object({ date: z.string() })).query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "pdas", "view");
        return getCheckinsByDate(input.date);
      }),
      byPda: protectedProcedure.input(z.object({ pdaId: z.number().int().positive(), limit: z.number().int().min(1).max(500).optional() })).query(async ({ ctx, input }) => {
        requireAccess(ctx.user, "pdas", "view");
        return getCheckinsByPda(input.pdaId, input.limit);
      }),
      checkin: protectedProcedure.input(z.object({
        pdaId: z.number(),
        // Funcionário OBRIGATÓRIO: sem pessoa não há check-in — é o que
        // permite ao histórico de atividade mostrar QUEM usou o Zello/PDA
        // naquele dia em vez do nome cru do Zello ("Faro 411").
        employeeId: z.number({ error: "Escolhe o funcionário — o check-in tem de ficar associado a uma pessoa" }),
        zelloUsername: z.string().optional(),
        // Foto do PDA OBRIGATÓRIA (Jorge, 2026-09-09): é a prova do estado do
        // aparelho à entrada. A UI só ativa o botão com foto carregada; isto é
        // a garantia do lado do servidor.
        photoEntryUrl: z.string().trim().min(1, { error: "Tira a foto do PDA — o check-in precisa da foto de entrada" }),
        mobileDataMbStart: z.number().optional(),
        notes: z.string().optional(),
      })).mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "pdas", "edit");
        // Decisão do dono (29 set 2026): sem check-in manual — o PDA liga-se a
        // quem faz login no próprio aparelho (registado pelo QR).
        if (input.pdaId > 0) throw new TRPCError({ code: "FORBIDDEN", message: "Já não há check-in manual: a pessoa faz login no próprio PDA (registado pelo QR) e fica ligada sozinha." });
        const id = await createPdaCheckin({
          pdaId: input.pdaId,
          employeeId: input.employeeId,
          zelloUsername: input.zelloUsername ?? null,
          teamLeaderId: ctx.user.id,
          photoEntryUrl: input.photoEntryUrl,
          mobileDataMbStart: input.mobileDataMbStart ?? null,
          notes: input.notes ?? null,
        });
        // NOTA (regra do Jorge 2026-08-06): já NÃO se anexa o Zello à ficha
        // aqui — os utilizadores Zello dos PDAs mudam de mãos todos os dias,
        // e a resolução Zello→pessoa passou a ser dinâmica pelo check-in do
        // PDA (getZelloLiveMappings / resolveZelloUsernameForShift). A
        // ligação fixa na ficha fica só para telemóveis pessoais.
        await logActivity({ userId: ctx.user.id, action: "create", entity: "pda_checkin", entityId: id, details: `Check-in PDA #${input.pdaId}` });
        return { id };
      }),
      checkout: protectedProcedure.input(z.object({
        id: z.number(),
        photoExitUrl: z.string().optional(),
        mobileDataMbEnd: z.number().optional(),
        notes: z.string().optional(),
      })).mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "pdas", "edit");
        await checkoutPda(input.id, {
          photoExitUrl: input.photoExitUrl,
          mobileDataMbEnd: input.mobileDataMbEnd,
          notes: input.notes,
        });
        { const { syncPdaZelloNameByCheckin } = await import("./pdaZelloName"); void syncPdaZelloNameByCheckin(input.id); }
        await logActivity({ userId: ctx.user.id, action: "update", entity: "pda_checkin", entityId: input.id, details: "Check-out PDA" });
        return { success: true };
      }),
    }),
  }),

  // ─── GPS ALERTS ──────────────────────────────────────────────────────
  gpsAlerts: router({
    list: protectedProcedure.input(z.object({
      limit: z.number().optional(),
      unacknowledgedOnly: z.boolean().optional(),
    }).optional()).query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "atividade_diaria", "view");
      return getGpsAlerts(input ?? {});
    }),
    stats: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "atividade_diaria", "view");
      return getGpsAlertStats();
    }),
    acknowledge: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "atividade_diaria", "edit");
      await acknowledgeGpsAlert(input.id, ctx.user.id);
      await logActivity({ userId: ctx.user.id, action: "update", entity: "gps_alert", entityId: input.id, details: "Alerta GPS reconhecido" });
      return { success: true };
    }),
    /** Check all users and create alerts for disabled GPS/Zello */
    checkNow: protectedProcedure.mutation(async ({ ctx }) => {
      requireAccess(ctx.user, "atividade_diaria", "edit");
      // Todos menos a lista explícita (Definições → "Contas Zello excluídas do GPS")
      const { getZelloGpsUsers } = await import("./zello");
      const users = await getZelloGpsUsers();
      let alertsCreated = 0;
      for (const user of users) {
        if (user.geotrackingOff) {
          await createGpsAlert({
            zelloUsername: user.name,
            displayName: user.fullName || user.name,
            alertType: "gps_off",
            message: `${user.fullName || user.name} tem o GPS desligado no Zello`,
            notificationSent: 1,
            occurredAt: new Date().toISOString().slice(0, 19).replace("T", " "),
          });
          alertsCreated++;
          const { notify } = await import("./notify");
          await notify({
            kind: "gps_alert",
            title: "GPS Desligado",
            body: `${user.fullName || user.name} (${user.name}) tem o GPS desligado no Zello`,
            link: "/operacional", entity: { type: "zello_gps_off", id: user.name },
          });
        }
      }
      // Also check for users with very low battery
      try {
        const locations = await getZelloLocations();
        for (const loc of locations) {
          if (loc.batteryLevel > 0 && loc.batteryLevel < 15) {
            await createGpsAlert({
              zelloUsername: loc.username,
              displayName: loc.displayName || loc.username,
              alertType: "battery_low",
              message: `${loc.displayName || loc.username} com bateria a ${loc.batteryLevel}%`,
              latitude: String(loc.latitude),
              longitude: String(loc.longitude),
              batteryLevel: loc.batteryLevel,
              notificationSent: 1,
              occurredAt: new Date().toISOString().slice(0, 19).replace("T", " "),
            });
            alertsCreated++;
          }
        }
      } catch (e) {
        // Locations may fail if no users are online
      }
      return { success: true, alertsCreated };
    }),
  }),
});
