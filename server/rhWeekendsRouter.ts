/**
 * Router `rh.weekends` — fins de semana e exceções por data ao horário fixo
 * (plano 63, passo 10b; interruptor FINS_DE_SEMANA, desligado):
 *  - `status`                 — ligado? quem abre o ecrã Fins de semana;
 *  - `forEmployee` / `set` / `cancel` — "Exceções por data" na ficha (Horário);
 *  - `board` / `markDuty` / `repeatRotation` — o ecrã RH → Fins de semana,
 *    por cidade (quem está de serviço, folga de compensação, avisos e
 *    "Repetir a rotação");
 *  - `mine`                   — Perfil → "O meu horário".
 * Quem marca: canMarkScheduleOverride (server/scheduleOverrides.ts). Regras
 * puras em shared/workSchedule.ts (dayPlan) e shared/weekendRotation.ts.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { canAccess, requireAccess } from "./_core/access";
import { assertEmployeeAccess, scopedProjectIds } from "./cityScope";
import { canViewTimeAndSchedule, isOwn, isRhAdmin } from "./rhAccess";
import { rhEmployeeRef, rhEmployeeRefOrThrow, rhViewer } from "./rhGuards";
import { getDb, getEmployeeById, getEmployeeByUserId } from "./db";
import {
  WEEKENDS_FLAG, WEEKENDS_NOTIFY_FLAG, WEEKENDS_OFF_MESSAGE, WEEKENDS_SCREEN_ROLES, boardWindow, canMarkScheduleOverride, cancelOverride, flagOn,
  getOverride, listOverrides, loadActiveStaff, loadSchedulesAndLeaves, notifyOverrideChanges, setOverride, todayLisbon,
  type OverrideChange, type OverrideRecord,
} from "./scheduleOverrides";
import { addDays } from "../shared/lisbonDay";
import { OVERRIDE_REASONS, activeOverrideOn, fixedRowOn, weekdayOf, type ScheduleOverrideRow } from "../shared/workSchedule";
import {
  HHMM_RE, MAX_WEEKENDS, boardWarnings, compensationMap, compensationServing, dayLabelPt, defaultDutyHours, isValidDay, isWeekendDay, planCompensations, planOf,
  rotationPattern, rotationTargets, saturdaysFrom, warningText, weekendBoard, type PersonSchedule,
} from "../shared/weekendRotation";

type User = { id: number; role: string };
const CITIES = ["lisbon", "porto", "faro"] as const;
type City = (typeof CITIES)[number];

const daySchema = z.string().refine(isValidDay, "Data inválida (AAAA-MM-DD).");
const hhmm = z.string().regex(HHMM_RE, "Hora inválida: usa HH:MM (ex.: 09:00).");
const noteSchema = z.string().trim().max(255).optional().nullable();

const fmtDay = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
/** Extra (posto ou contrato): escala-se no Extras-Dia, sem exceções por data. */
const isExtraEmp = (e: { position?: string | null }) => e.position === "extra" || (e as any).contractType === "extra";
/** Até onde se marca para a frente (dias). */
const MAX_AHEAD_DAYS = 400;

async function assertWeekendsOn(): Promise<void> {
  if (!(await flagOn(WEEKENDS_FLAG))) throw new TRPCError({ code: "PRECONDITION_FAILED", message: WEEKENDS_OFF_MESSAGE });
}

/** Cidade da ficha (lisbon/porto/faro) pelo centro de custos. */
async function cityResolver(): Promise<(projectId: number | null | undefined) => City | null> {
  const db = await getDb();
  if (!db) return () => null;
  const { projectCityResolver } = await import("./aiOps/cities");
  return (await projectCityResolver(db)) as (projectId: number | null | undefined) => City | null;
}

/** Marcar na ficha: interruptor ligado, módulo RH em "gerir", âmbito de cidade e canMarkScheduleOverride; só fichas ativas e não extras. */
async function assertCanMark(user: User, employeeId: number) {
  await assertWeekendsOn();
  requireAccess(user as any, "rh", "manage");
  await assertEmployeeAccess(employeeId);
  const viewer = await rhViewer(user);
  const ref = await rhEmployeeRefOrThrow(employeeId);
  if (!canMarkScheduleOverride(viewer, ref)) {
    throw new TRPCError({ code: "FORBIDDEN", message: isOwn(viewer, employeeId) ? "O teu horário marca-o outra pessoa (supervisor, RH ou administrador)." : "Só o supervisor da cidade, o RH (back office) ou um administrador marcam o horário desta pessoa." });
  }
  const emp = (await getEmployeeById(employeeId))?.employee;
  if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "Colaborador não encontrado" });
  if (isExtraEmp(emp)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Os extras são escalados no Extras-Dia: as exceções por data são para quem tem horário fixo." });
  }
  if (!emp.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "A ficha está desativada." });
  return { viewer, ref, emp };
}

/** Datas de hoje para a frente (até um ano); para trás, só dias que a Avaliação ainda não fechou. */
async function assertDayOpen(day: string, today = todayLisbon()): Promise<void> {
  if (day > addDays(today, MAX_AHEAD_DAYS)) throw new TRPCError({ code: "BAD_REQUEST", message: "No máximo um ano para a frente." });
  if (day >= today) return;
  const { readEvaluationClosedUntil } = await import("./evaluationClose");
  const closed = await readEvaluationClosedUntil();
  if (!closed.ok) throw new TRPCError({ code: "BAD_REQUEST", message: "Não deu para ler o fecho da Avaliação: para já só se marcam datas de hoje para a frente." });
  if (closed.closedUntil && day <= closed.closedUntil) throw new TRPCError({ code: "BAD_REQUEST", message: `A Avaliação está fechada até ${fmtDay(closed.closedUntil)}: o dia ${fmtDay(day)} já não muda.` });
}

/** O ecrã Fins de semana: interruptor ligado, módulo RH em "gerir" e supervisor, back office ou administrador. */
async function assertScreen(user: User): Promise<void> {
  await assertWeekendsOn();
  requireAccess(user as any, "rh", "manage");
  if (!(WEEKENDS_SCREEN_ROLES as readonly string[]).includes(user.role)) throw new TRPCError({ code: "FORBIDDEN", message: "Os fins de semana marcam-nos o supervisor da cidade, o RH (back office) e os administradores." });
}

const toRow = (o: OverrideRecord, contract?: { contractStart: string | null; contractEnd: string | null }): ScheduleOverrideRow => ({
  id: o.id, employeeId: o.employeeId, day: o.day, kind: o.kind, startTime: o.startTime, endTime: o.endTime, reason: o.reason,
  contractStart: contract?.contractStart ?? null, contractEnd: contract?.contractEnd ?? null,
});

/** O horário de uma pessoa (fixo, exceções ativas e férias/baixas) numa janela. */
async function loadPerson(employeeId: number, from: string, to: string): Promise<PersonSchedule> {
  const e = (await getEmployeeById(employeeId))?.employee;
  const contract = { contractStart: e?.contractStart ? String(e.contractStart).slice(0, 10) : null, contractEnd: e?.contractEnd ? String(e.contractEnd).slice(0, 10) : null };
  const [{ schedules, leaves }, overrides, cityOf] = await Promise.all([loadSchedulesAndLeaves([employeeId], from, to), listOverrides([employeeId], from, to), cityResolver()]);
  return { employeeId, name: e?.fullName ?? `#${employeeId}`, schedules, leaves, overrides: overrides.map((o) => toRow(o, contract)), ...contract, city: cityOf(e?.projectId ?? null) };
}

/** As pessoas de uma cidade (no âmbito do pedido) com o horário numa janela, e quem quem pede pode marcar. */
async function loadCityPeople(user: User, city: City, from: string, to: string) {
  const viewer = await rhViewer(user);
  const cityOf = await cityResolver();
  const scoped = scopedProjectIds();
  const staff = (await loadActiveStaff()).filter((p) => cityOf(p.projectId) === city && (scoped === undefined || (p.projectId != null && scoped.includes(p.projectId))));
  const ids = staff.map((p) => p.employeeId);
  const [{ schedules, leaves }, overrides] = await Promise.all([loadSchedulesAndLeaves(ids, from, to), listOverrides(ids, from, to)]);
  const people: PersonSchedule[] = staff.map((p) => ({
    employeeId: p.employeeId, name: p.name,
    schedules: schedules.filter((s) => s.employeeId === p.employeeId),
    overrides: overrides.filter((o) => o.employeeId === p.employeeId).map((o) => toRow(o, p)),
    leaves: leaves.filter((l) => l.employeeId === p.employeeId),
    contractStart: p.contractStart, contractEnd: p.contractEnd, city,
  }));
  const canEdit = new Map(staff.map((p) => [p.employeeId, canMarkScheduleOverride(viewer, { id: p.employeeId, projectId: p.projectId, role: p.accountRole, position: p.position })]));
  return { staff, people, canEdit };
}

/** Férias/baixas nesse dia (as exceções não ganham a uma ausência registada). */
const onLeave = (p: PersonSchedule, day: string) => p.leaves.some((l) => day >= l.fromDate && day <= l.toDate);
/** Dentro do contrato da ficha nesse dia. */
const inContract = (p: PersonSchedule, day: string) => (!p.contractStart || day >= String(p.contractStart).slice(0, 10)) && (!p.contractEnd || day <= String(p.contractEnd).slice(0, 10));
/** Junta uma exceção acabada de marcar (ou só simulada, sem id) à pessoa em memória. */
const pushOverride = (p: PersonSchedule, o: Omit<ScheduleOverrideRow, "employeeId" | "contractStart" | "contractEnd">) =>
  (p.overrides as ScheduleOverrideRow[]).push({ ...o, employeeId: p.employeeId, contractStart: p.contractStart, contractEnd: p.contractEnd });
/** Janela de leitura de uma pessoa à volta de um dia (as folgas de compensação servem até 7 dias para cada lado). */
const personWindow = (from: string, to: string = from) => ({ from: addDays(from, -21), to: addDays(to, 21) });

/**
 * Grava as folgas de compensação planeadas (planCompensations: o dia útil mais
 * perto no MESMO mês, senão noutro, com aviso; nunca num dia passado nem num
 * dia que já tem exceção) e junta-as à pessoa em memória.
 */
async function writeCompensations(person: PersonSchedule, plan: ReturnType<typeof planCompensations>, userId: number, city: string | null) {
  for (const c of plan.compensations) {
    const r = await setOverride({ employeeId: person.employeeId, day: c.day, kind: "off", reason: "compensation", note: `Compensação do serviço de ${dayLabelPt(c.forDay)}`, city, userId });
    pushOverride(person, { id: r.id, day: c.day, kind: "off", reason: "compensation" });
  }
}

/**
 * Tirar alguém de serviço (cancelar, ou trocar por folga) deixa sem razão a
 * folga de compensação que servia esse dia: cancela-se também (nunca se
 * apaga), se ainda não passou e já não serve outro dia de serviço. Devolve o
 * dia da folga cancelada, ou null.
 */
async function releaseCompensation(employeeId: number, day: string, servedBefore: string | null, userId: number, today: string): Promise<string | null> {
  if (!servedBefore || servedBefore < today) return null;
  const win = personWindow(day);
  const after = await loadPerson(employeeId, win.from, win.to);
  if (compensationServing(after, day) === servedBefore) return null; // ainda serve este dia (ex.: só mudaram as horas)
  if (Array.from(compensationMap(after, addDays(servedBefore, -7), addDays(servedBefore, 7)).values()).includes(servedBefore)) return null;
  const comp = after.overrides.find((o) => o.day === servedBefore && o.kind === "off" && o.reason === "compensation" && o.id != null);
  if (!comp) return null;
  return (await cancelOverride(Number(comp.id), userId)) ? servedBefore : null;
}

export const weekendsRouter = router({
  /** O interruptor e se quem pede abre o ecrã Fins de semana. */
  status: protectedProcedure.query(async ({ ctx }) => {
    const enabled = await flagOn(WEEKENDS_FLAG);
    const notifyEnabled = enabled && (await flagOn(WEEKENDS_NOTIFY_FLAG));
    const canManage = enabled && (WEEKENDS_SCREEN_ROLES as readonly string[]).includes(ctx.user.role) && canAccess(ctx.user as any, "rh", "manage");
    return { enabled, notifyEnabled, canManage };
  }),

  // ── Ficha → Horário → "Exceções por data"
  forEmployee: protectedProcedure
    .input(z.object({ employeeId: z.number().int().positive(), includeCancelled: z.boolean().optional() }))
    .query(async ({ ctx, input }) => {
      if (!(await flagOn(WEEKENDS_FLAG))) return { enabled: false as const, canEdit: false, items: [] as OverrideRecord[] };
      const viewer = await rhViewer(ctx.user);
      const ref = await rhEmployeeRef(input.employeeId);
      if (!isRhAdmin(viewer) && (!ref || !canViewTimeAndSchedule(viewer, ref))) throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão" });
      if (!isOwn(viewer, input.employeeId)) await assertEmployeeAccess(input.employeeId);
      // os extras escalam-se no Extras-Dia: a secção não aparece na ficha deles
      const emp = (await getEmployeeById(input.employeeId))?.employee;
      if (!emp || isExtraEmp(emp)) return { enabled: false as const, canEdit: false, items: [] as OverrideRecord[] };
      const today = todayLisbon();
      const items = await listOverrides([input.employeeId], addDays(today, -31), addDays(today, 400), { includeCancelled: input.includeCancelled });
      const canEdit = !!ref && !!emp.isActive && canAccess(ctx.user as any, "rh", "manage") && canMarkScheduleOverride(viewer, ref);
      return { enabled: true as const, canEdit, items };
    }),

  set: protectedProcedure
    .input(z.object({
      employeeId: z.number().int().positive(),
      day: daySchema,
      kind: z.enum(["work", "off"]),
      startTime: hhmm.optional().nullable(),
      endTime: hhmm.optional().nullable(),
      reason: z.enum(OVERRIDE_REASONS),
      note: noteSchema,
    }).superRefine((v, c) => {
      if (v.kind !== "work") return;
      if (!v.startTime || !v.endTime) c.addIssue({ code: "custom", message: "Diz a hora de entrada e de saída (HH:MM)." });
      else if (v.startTime === v.endTime) c.addIssue({ code: "custom", message: "A entrada e a saída não podem ser iguais." });
    }))
    .mutation(async ({ ctx, input }) => {
      const { emp } = await assertCanMark(ctx.user, input.employeeId);
      const today = todayLisbon();
      await assertDayOpen(input.day, today);
      const win = personWindow(input.day);
      const before = await loadPerson(input.employeeId, win.from, win.to);
      if (input.kind === "work" && onLeave(before, input.day)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `${before.name} está de férias ou de baixa a ${dayLabelPt(input.day)}: a ausência ganha à exceção. Marca outra pessoa.` });
      }
      const servedBefore = compensationServing(before, input.day);
      const city = (await cityResolver())(emp.projectId ?? null);
      const r = await setOverride({ ...input, city, userId: ctx.user.id });
      let compensationCancelled: string | null = null;
      if (!r.unchanged) {
        const changes: OverrideChange[] = [{ day: input.day, kind: input.kind, startTime: input.startTime, endTime: input.endTime, reason: input.reason }];
        compensationCancelled = await releaseCompensation(input.employeeId, input.day, servedBefore, ctx.user.id, today);
        if (compensationCancelled) changes.push({ day: compensationCancelled, kind: "off", reason: "compensation", cancelled: true });
        await notifyOverrideChanges(input.employeeId, changes, ctx.user.id);
      }
      return { id: r.id, unchanged: r.unchanged, replaced: !!r.replaced, compensationCancelled };
    }),

  cancel: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const o = await getOverride(input.id);
      if (!o) throw new TRPCError({ code: "NOT_FOUND", message: "Exceção não encontrada." });
      await assertCanMark(ctx.user, o.employeeId);
      const today = todayLisbon();
      await assertDayOpen(o.day, today);
      const win = personWindow(o.day);
      const servedBefore = o.active && o.kind === "work" ? compensationServing(await loadPerson(o.employeeId, win.from, win.to), o.day) : null;
      const before = await cancelOverride(input.id, ctx.user.id);
      let compensationCancelled: string | null = null;
      if (before) {
        const changes: OverrideChange[] = [{ day: o.day, kind: o.kind, cancelled: true }];
        compensationCancelled = await releaseCompensation(o.employeeId, o.day, servedBefore, ctx.user.id, today);
        if (compensationCancelled) changes.push({ day: compensationCancelled, kind: "off", reason: "compensation", cancelled: true });
        await notifyOverrideChanges(o.employeeId, changes, ctx.user.id);
      }
      return { success: true, alreadyCancelled: !before, compensationCancelled };
    }),

  // ── RH → Fins de semana
  board: protectedProcedure
    .input(z.object({ city: z.enum(CITIES), from: daySchema.optional(), weeks: z.number().int().min(1).max(MAX_WEEKENDS).default(8) }))
    .query(async ({ ctx, input }) => {
      await assertScreen(ctx.user);
      const today = todayLisbon();
      const saturdays = saturdaysFrom(input.from ?? today, input.weeks);
      const win = boardWindow(saturdays[0], saturdays[saturdays.length - 1]);
      const { staff, people, canEdit } = await loadCityPeople(ctx.user, input.city, win.from, win.to);
      const weeks = weekendBoard(people, saturdays, input.city);
      const warnings = boardWarnings(people, saturdays, input.city).map((w) => ({ ...w, text: warningText(w) }));
      return {
        city: input.city, today, saturdays, weeks, warnings,
        people: staff.map((p) => {
          const sch = people.find((x) => x.employeeId === p.employeeId)?.schedules ?? [];
          return { employeeId: p.employeeId, name: p.name, position: p.position, canEdit: canEdit.get(p.employeeId) ?? false,
            defaults: { sat: defaultDutyHours(sch, saturdays[0]), sun: defaultDutyHours(sch, addDays(saturdays[0], 1)) } };
        }),
      };
    }),

  /** Pôr alguém de serviço num fim de semana (sábado, domingo ou os dois), com a folga de compensação proposta no mesmo mês. */
  markDuty: protectedProcedure
    .input(z.object({
      employeeId: z.number().int().positive(),
      days: z.array(daySchema).min(1).max(2),
      startTime: hhmm,
      endTime: hhmm,
      compensation: z.boolean().default(true),
      note: noteSchema,
    }))
    .mutation(async ({ ctx, input }) => {
      if (input.startTime === input.endTime) throw new TRPCError({ code: "BAD_REQUEST", message: "A entrada e a saída não podem ser iguais." });
      const days = Array.from(new Set(input.days)).sort();
      if (days.some((d) => !isWeekendDay(d))) throw new TRPCError({ code: "BAD_REQUEST", message: "Aqui só sábados e domingos (os outros dias marcam-se na ficha → Horário → Exceções por data)." });
      const { emp } = await assertCanMark(ctx.user, input.employeeId);
      const today = todayLisbon();
      for (const d of days) await assertDayOpen(d, today);
      const win = personWindow(days[0], days[days.length - 1]);
      const person = await loadPerson(input.employeeId, win.from, win.to);
      const away = days.filter((d) => onLeave(person, d));
      if (away.length) throw new TRPCError({ code: "BAD_REQUEST", message: `${person.name} está de férias ou de baixa a ${away.map(dayLabelPt).join(" e ")}: marca outra pessoa.` });
      const city = (await cityResolver())(emp.projectId ?? null);
      const changes: OverrideChange[] = [];
      for (const d of days) {
        const r = await setOverride({ employeeId: input.employeeId, day: d, kind: "work", startTime: input.startTime, endTime: input.endTime, reason: "weekend", note: input.note, city, userId: ctx.user.id });
        if (!r.unchanged) changes.push({ day: d, kind: "work", startTime: input.startTime, endTime: input.endTime, reason: "weekend" });
      }
      let compensations: Array<{ forDay: string; day: string; sameMonth: boolean }> = [], without: string[] = [];
      if (input.compensation) {
        const now = await loadPerson(input.employeeId, win.from, win.to);
        const plan = planCompensations(now, days, today);
        await writeCompensations(now, plan, ctx.user.id, city);
        ({ compensations, without } = plan);
        for (const c of compensations) changes.push({ day: c.day, kind: "off", reason: "compensation" });
      }
      await notifyOverrideChanges(input.employeeId, changes, ctx.user.id);
      return { marked: days.length, compensations, withoutCompensation: without };
    }),

  /**
   * "Repetir a rotação": os fins de semana de `patternFrom` a `patternTo`
   * (sábados) repetem-se, pela mesma ordem, nas `weeks` semanas seguintes.
   * Nunca mexe num dia que já tem exceção, nem em férias/baixas, nem no
   * passado. `dryRun` mostra o que ia fazer sem gravar.
   */
  repeatRotation: protectedProcedure
    .input(z.object({
      city: z.enum(CITIES),
      patternFrom: daySchema,
      patternTo: daySchema,
      weeks: z.number().int().min(1).max(MAX_WEEKENDS),
      compensation: z.boolean().default(true),
      dryRun: z.boolean().default(true),
    }))
    .mutation(async ({ ctx, input }) => {
      await assertScreen(ctx.user);
      if (weekdayOf(input.patternFrom) !== 6 || weekdayOf(input.patternTo) !== 6) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "O modelo vai de um sábado a outro sábado." });
      }
      if (input.patternTo < input.patternFrom) throw new TRPCError({ code: "BAD_REQUEST", message: "O fim do modelo é antes do início." });
      const patternSats: string[] = [];
      for (let s = input.patternFrom; s <= input.patternTo; s = addDays(s, 7)) patternSats.push(s);
      if (patternSats.length > 12) throw new TRPCError({ code: "BAD_REQUEST", message: "O modelo tem no máximo 12 fins de semana." });
      const lastTarget = addDays(input.patternTo, 7 * input.weeks);
      const today = todayLisbon();
      if (addDays(lastTarget, 1) > addDays(today, MAX_AHEAD_DAYS)) throw new TRPCError({ code: "BAD_REQUEST", message: "No máximo um ano para a frente: repete menos semanas." });
      const { people, canEdit } = await loadCityPeople(ctx.user, input.city, addDays(input.patternFrom, -21), addDays(lastTarget, 22));
      const pattern = rotationPattern(people, patternSats);
      if (pattern.every((w) => !w.length)) throw new TRPCError({ code: "BAD_REQUEST", message: "Os fins de semana do modelo não têm ninguém marcado: marca-os primeiro com \"Pôr de serviço\"." });
      const byId = new Map(people.map((p) => [p.employeeId, p]));
      type Status = "create" | "existing" | "leave" | "past" | "forbidden" | "inactive" | "contract";
      const items = rotationTargets(pattern, input.patternTo, input.weeks).flatMap((t) => t.entries.map((e) => {
        const p = byId.get(e.employeeId);
        const status: Status = !p ? "inactive" : !canEdit.get(e.employeeId) ? "forbidden" : e.day < today ? "past"
          : activeOverrideOn(p.overrides, e.day) ? "existing" : onLeave(p, e.day) ? "leave" : !inContract(p, e.day) ? "contract" : "create";
        return { saturday: t.saturday, day: e.day, employeeId: e.employeeId, name: p?.name ?? `#${e.employeeId}`, kind: e.kind, startTime: e.startTime, endTime: e.endTime, status };
      }));
      const counts = items.reduce<Record<Status, number>>((acc, i) => ({ ...acc, [i.status]: acc[i.status] + 1 }), { create: 0, existing: 0, leave: 0, past: 0, forbidden: 0, inactive: 0, contract: 0 });
      // o mesmo caminho a ver (dryRun: só simula, nada se grava) e a marcar — o que se vê é o que se marca, folgas de compensação incluídas
      const changesOf = new Map<number, OverrideChange[]>();
      const workedOf = new Map<number, string[]>();
      for (const i of items.filter((x) => x.status === "create")) {
        const p = byId.get(i.employeeId)!;
        const id = input.dryRun ? null
          : (await setOverride({ employeeId: i.employeeId, day: i.day, kind: i.kind, startTime: i.startTime, endTime: i.endTime, reason: "weekend", note: "Repetir a rotação", city: input.city, userId: ctx.user.id })).id;
        pushOverride(p, { id, day: i.day, kind: i.kind, startTime: i.startTime, endTime: i.endTime, reason: "weekend" });
        changesOf.set(i.employeeId, [...(changesOf.get(i.employeeId) ?? []), { day: i.day, kind: i.kind, startTime: i.startTime, endTime: i.endTime, reason: "weekend" }]);
        if (i.kind === "work") workedOf.set(i.employeeId, [...(workedOf.get(i.employeeId) ?? []), i.day]);
      }
      const compensations: Array<{ employeeId: number; name: string; forDay: string; day: string; sameMonth: boolean }> = [];
      const withoutCompensation: Array<{ employeeId: number; name: string; day: string }> = [];
      if (input.compensation) {
        for (const [emp, days] of workedOf) {
          const p = byId.get(emp)!;
          const plan = planCompensations(p, days, today);
          if (input.dryRun) for (const c of plan.compensations) pushOverride(p, { id: null, day: c.day, kind: "off", reason: "compensation" });
          else await writeCompensations(p, plan, ctx.user.id, input.city);
          for (const c of plan.compensations) {
            compensations.push({ employeeId: emp, name: p.name, ...c });
            changesOf.get(emp)!.push({ day: c.day, kind: "off", reason: "compensation" });
          }
          for (const d of plan.without) withoutCompensation.push({ employeeId: emp, name: p.name, day: d });
        }
      }
      if (!input.dryRun) for (const [emp, changes] of changesOf) await notifyOverrideChanges(emp, changes, ctx.user.id);
      return { dryRun: input.dryRun, items, counts, compensations, withoutCompensation };
    }),

  // ── Perfil → "O meu horário"
  mine: protectedProcedure.query(async ({ ctx }) => {
    if (!(await flagOn(WEEKENDS_FLAG))) return { enabled: false as const };
    const me = (await getEmployeeByUserId(ctx.user.id))?.employee;
    // sem ficha, ou extra (escala-se no Extras-Dia): o cartão não aparece
    if (!me || isExtraEmp(me)) return { enabled: true as const, employeeId: null, fixed: [], weekends: [], exceptions: [] };
    const today = todayLisbon();
    const person = await loadPerson(me.id, addDays(today, -7), addDays(today, 120));
    const fixed = [1, 2, 3, 4, 5, 6, 0].map((weekday) => {
      const s = fixedRowOn(person.schedules, weekday);
      const work = !!s && !(s.isWorkDay === false || Number(s.isWorkDay) === 0);
      return { weekday, isWorkDay: work, startTime: work ? String(s!.startTime).slice(0, 5) : null, endTime: work && s!.endTime ? String(s!.endTime).slice(0, 5) : null };
    });
    const weekends = saturdaysFrom(today, 8).flatMap((sat) => [sat, addDays(sat, 1)]).map((day) => {
      const plan = planOf(person, day);
      return { day, work: plan.kind === "work" ? { startTime: plan.startTime, endTime: plan.endTime, source: plan.source } : null, reason: plan.kind === "none" ? plan.reason : null };
    });
    const exceptions = person.overrides.filter((o) => o.day >= today).sort((a, b) => a.day.localeCompare(b.day))
      .map((o) => ({ day: o.day, kind: o.kind === "work" ? "work" as const : "off" as const, startTime: o.startTime ?? null, endTime: o.endTime ?? null, reason: o.reason ?? null }));
    return { enabled: true as const, employeeId: me.id, fixed, weekends, exceptions };
  }),
});
