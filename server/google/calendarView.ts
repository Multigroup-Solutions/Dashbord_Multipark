/**
 * Página Calendário (lote 45e): lê ao vivo a agenda Google da PRÓPRIA pessoa
 * (nada fica guardado no dashboard) e cria eventos no calendário principal
 * dela. Erro de leitura ≠ calendário vazio: devolve reason "error" e o ecrã
 * diz que não conseguiu ler (com Tentar de novo).
 *
 * As dependências (conta e API) são injetáveis — os testes usam uma API falsa.
 */
import { TRPCError } from "@trpc/server";
import { hasFeatureScopes } from "../../shared/mail";
import { addDays, lisbonMidnightUtcMs } from "../../shared/lisbonDay";
import { meetLinkOf } from "../../shared/googleSync";
import {
  CALENDAR_MAX_PAGES, compareViewEvents, emptyCalendarView, newCalendarEventBody, pickViewCalendars, validateNewCalendarEvent, viewEventOf,
  type CalendarViewEvent, type CalendarViewResult, type CreateCalendarEventInput,
} from "../../shared/calendarView";
import type { CalendarApiLike, CalendarReadApiLike } from "./apis";

export type CalendarViewApi = CalendarReadApiLike & Pick<CalendarApiLike, "insertEvent">;

export interface CalendarViewDeps {
  /** A conta Google da pessoa (null = nunca ligou). Lança se a BD falhar. */
  account(userId: number): Promise<{ status: string; refreshTokenEnc?: string | null; scopes: string | null; email?: string | null } | null>;
  /** Cliente da API com a conta da própria pessoa (âmbito Calendário). */
  api(userId: number, deadlineAt: number): Promise<CalendarViewApi>;
  now?: () => number;
  /** Para o Meet (createRequest.requestId). */
  requestId?: () => string;
  /** Link do dashboard posto no evento ("source"). */
  link?: () => string | null;
}

const defaultDeps: CalendarViewDeps = {
  async account(userId) {
    const { getGoogleAccount } = await import("./userAccounts");
    return getGoogleAccount(userId);
  },
  async api(userId, deadlineAt) {
    const { userGoogleAuth } = await import("./userAccounts");
    const { calendarFor, wrapCalendar } = await import("./apis");
    const { client } = await userGoogleAuth(userId, "calendar");
    return wrapCalendar(calendarFor(client), { deadlineAt });
  },
};

async function errorKind(err: unknown) {
  const { calendarAndTasksErrorKind } = await import("./workspace");
  return calendarAndTasksErrorKind(err);
}

async function errorMessage(err: unknown): Promise<string> {
  if ((err as any)?.rateLimited) return "A Google está a limitar pedidos — tenta daqui a um minuto.";
  try {
    const { googleErrorMessage } = await import("./workspace");
    return googleErrorMessage(err).slice(0, 200);
  } catch {
    return String((err as any)?.message ?? err).slice(0, 200);
  }
}

/** Corre `fn` sobre a lista com no máximo `limit` pedidos ao mesmo tempo. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Eventos de [fromDay, toDay] (dias de Lisboa) dos calendários que a pessoa
 * tem visíveis + principal + "Multipark". Um calendário secundário que falha
 * não esconde os outros (fica em `failedCalendars`); falhar o principal (ou
 * todos) é erro. Só a conta da própria pessoa.
 */
export async function myCalendarEvents(userId: number, fromDay: string, toDay: string, deps: CalendarViewDeps = defaultDeps): Promise<CalendarViewResult> {
  let acc: Awaited<ReturnType<CalendarViewDeps["account"]>>;
  try { acc = await deps.account(userId); }
  catch (err) { return emptyCalendarView("error", await errorMessage(err)); }
  if (!acc || acc.status === "disconnected" || !acc.refreshTokenEnc) return emptyCalendarView("not_connected");
  if (!hasFeatureScopes(acc.scopes, "calendar")) return emptyCalendarView("scope_missing");
  if (acc.status === "reauth_required") return emptyCalendarView("reauth_required");
  const now = deps.now ?? Date.now;
  try {
    const api = await deps.api(userId, now() + 20_000);
    const calendars = pickViewCalendars(await api.listVisibleCalendars());
    const timeMin = new Date(lisbonMidnightUtcMs(fromDay)).toISOString();
    const timeMax = new Date(lisbonMidnightUtcMs(addDays(toDay, 1))).toISOString();
    const results = await mapLimit(calendars, 5, async (c) => {
      try { return { c, res: await api.listEventsInRange(c.id, { timeMin, timeMax, maxPages: CALENDAR_MAX_PAGES }), err: null as unknown }; }
      catch (err) { return { c, res: null, err }; }
    });
    const failed = results.filter((x) => x.err != null);
    for (const f of failed) {
      const kind = await errorKind(f.err);
      if (kind === "reauth_required" || kind === "scope_missing") return emptyCalendarView(kind);
    }
    const primaryFailed = failed.find((x) => x.c.primary);
    if (primaryFailed || (results.length > 0 && failed.length === results.length)) {
      const msg = await errorMessage((primaryFailed ?? failed[0]).err);
      console.warn(`[Calendario] utilizador ${userId}: não foi possível ler o calendário — ${msg}`);
      return emptyCalendarView("error", msg);
    }
    if (failed.length) console.warn(`[Calendario] utilizador ${userId}: ${failed.length} calendário(s) sem leitura — ${await errorMessage(failed[0].err)}`);
    const events: CalendarViewEvent[] = [];
    let truncated = false;
    for (const x of results) {
      if (!x.res) continue;
      if (x.res.truncated) truncated = true;
      for (const e of x.res.items) {
        const v = viewEventOf(e as any, x.c);
        if (v) events.push(v);
      }
    }
    events.sort(compareViewEvents);
    return {
      enabled: true,
      reason: null,
      error: null,
      calendars: calendars.map(({ accessRole: _a, ...c }) => c),
      events,
      failedCalendars: failed.map((x) => ({ id: x.c.id, name: x.c.name })),
      truncated,
    };
  } catch (err) {
    const kind = await errorKind(err);
    if (kind === "reauth_required" || kind === "scope_missing") return emptyCalendarView(kind);
    const msg = await errorMessage(err);
    console.warn(`[Calendario] utilizador ${userId}: não foi possível ler o calendário — ${msg}`);
    return emptyCalendarView("error", msg);
  }
}

/**
 * "Novo evento" no calendário principal da própria pessoa. Convites só com
 * convidados (sendUpdates "all"); Meet opcional. Lança TRPCError com a
 * mensagem para o ecrã.
 */
export async function createMyCalendarEvent(userId: number, input: CreateCalendarEventInput, deps: CalendarViewDeps = defaultDeps): Promise<{
  eventId: string; htmlLink: string | null; meetLink: string | null; start: string; end: string; allDay: boolean; guests: number;
}> {
  const acc = await deps.account(userId);
  if (!acc || acc.status === "disconnected" || !acc.refreshTokenEnc) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Liga primeiro a tua conta Google." });
  if (!hasFeatureScopes(acc.scopes, "calendar")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Ativa o Calendário na tua conta Google." });
  if (acc.status === "reauth_required") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A autorização da conta Google expirou — volta a ligar." });
  const now = deps.now ?? Date.now;
  const v = validateNewCalendarEvent(input, { nowMs: now(), ownEmail: acc.email ?? null });
  if (!v.ok) throw new TRPCError({ code: "BAD_REQUEST", message: v.error });
  const requestId = deps.requestId ? deps.requestId() : (await import("node:crypto")).randomUUID();
  let link: string | null = null;
  try {
    if (deps.link) link = deps.link();
    else {
      const { appOrigin } = await import("./workspace");
      const { dashboardUrl } = await import("../../shared/googleSync");
      link = dashboardUrl(appOrigin(), "/calendario");
    }
  } catch { link = null; }
  const body = newCalendarEventBody(v.value, { requestId, link });
  const api = await deps.api(userId, now() + 25_000);
  const e = await api.insertEvent("primary", body as any, {
    ...(v.value.withMeet ? { conferenceDataVersion: 1 } : {}),
    sendUpdates: v.value.guests.length ? "all" : "none",
  });
  return {
    eventId: String(e.id ?? ""),
    htmlLink: e.htmlLink ?? null,
    meetLink: meetLinkOf(e as any),
    start: new Date(v.value.startMs).toISOString(),
    end: new Date(v.value.endMs).toISOString(),
    allDay: v.value.allDay,
    guests: v.value.guests.length,
  };
}
