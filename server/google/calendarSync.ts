/**
 * Google Calendar — escrever os eventos do dashboard num calendário
 * ("Multipark" de cada pessoa, ou "Escala Multipark — <cidade>" partilhado)
 * de forma IDEMPOTENTE (núcleo com dependências injetáveis):
 *
 *  1. Calendário: o guardado, senão um nosso com o mesmo nome (lista de
 *     calendários), senão cria-o (calendário secundário — não suja o
 *     calendário principal da pessoa).
 *  2. Ler as alterações com syncToken (events.list incremental; 410 → leitura
 *     completa): eventos com a propriedade privada `mpKey` são "adotados"
 *     (ligação refeita mesmo que a BD a tenha perdido); cancelados pela
 *     pessoa ficam marcados (não se recriam enquanto a origem não mudar).
 *  3. Plano (shared/googleSync.ts → planCalendarOps): inserir / atualizar /
 *     apagar. O id do evento é determinístico → inserir duas vezes dá 409 e
 *     passa a atualização, nunca duplica.
 *  4. Operações em pequenos lotes paralelos, sempre dentro do prazo.
 */
import {
  GOOGLE_TIMEZONE, calendarEventId, eventBody, eventHash, mappingFromEvent, planCalendarOps,
  type CalendarMapping, type DesiredEvent,
} from "../../shared/googleSync";
import { httpStatusOf } from "./workspace";
import { GoogleRateLimitError, type CalendarApiLike } from "./apis";

export interface CalendarTargetState { calendarId: string | null; syncToken: string | null }

export interface CalendarStore {
  getState(target: string): Promise<CalendarTargetState>;
  saveState(target: string, patch: Partial<CalendarTargetState>): Promise<void>;
  loadMappings(target: string): Promise<CalendarMapping[]>;
  saveMapping(target: string, calendarId: string, m: CalendarMapping): Promise<void>;
  deleteMapping(target: string, key: string): Promise<void>;
}

export interface CalendarSyncOptions {
  title: string;
  description: string;
  deadlineAt: number;
  windowFromMs: number;
  now?: () => number;
  concurrency?: number;
  /** Depois de criar o calendário (ex.: partilhar com o domínio). */
  onCreated?: (calendarId: string) => Promise<void>;
}

export interface CalendarSyncResult {
  calendarId: string | null;
  inserted: number;
  updated: number;
  deleted: number;
  adopted: number;
  unchanged: number;
  partial: boolean;
  rateLimited: boolean;
  fullResync: boolean;
}

async function ensureCalendar(api: CalendarApiLike, store: CalendarStore, target: string, o: CalendarSyncOptions): Promise<string> {
  const st = await store.getState(target);
  if (st.calendarId) return st.calendarId;
  const mine = await api.listCalendars();
  const found = mine.find((c) => c.summary.trim() === o.title && (c.accessRole === "owner" || c.accessRole == null));
  let id = found?.id ?? null;
  if (!id) {
    id = (await api.insertCalendar({ summary: o.title, description: o.description, timeZone: GOOGLE_TIMEZONE })).id;
    if (o.onCreated) await o.onCreated(id);
  }
  await store.saveState(target, { calendarId: id, syncToken: null });
  return id;
}

/** Lê as alterações (syncToken) e refaz as ligações a partir das propriedades privadas. */
async function pullChanges(api: CalendarApiLike, store: CalendarStore, target: string, calendarId: string, mappings: Map<string, CalendarMapping>, o: CalendarSyncOptions, res: CalendarSyncResult): Promise<boolean> {
  const now = o.now ?? Date.now;
  let { syncToken } = await store.getState(target);
  let pageToken: string | null = null;
  let next: string | null = null;
  for (let page = 0; page < 40; page++) {
    if (now() > o.deadlineAt) return false;
    let r: Awaited<ReturnType<CalendarApiLike["listEvents"]>>;
    try { r = await api.listEvents(calendarId, { syncToken: pageToken ? null : syncToken, pageToken }); }
    catch (err) {
      if (httpStatusOf(err) === 410 && syncToken) {
        // syncToken expirado → leitura completa.
        syncToken = null; pageToken = null; res.fullResync = true;
        await store.saveState(target, { syncToken: null });
        continue;
      }
      throw err;
    }
    for (const e of r.items) {
      const m = mappingFromEvent(e as any);
      if (!m) continue;
      const cur = mappings.get(m.key);
      if (m.remoteDeleted) {
        if (cur && cur.eventId === m.eventId && !cur.remoteDeleted) {
          const upd = { ...cur, remoteDeleted: true };
          mappings.set(m.key, upd);
          await store.saveMapping(target, calendarId, upd);
        }
        continue;
      }
      if (!cur || cur.eventId !== m.eventId || cur.version !== m.version || cur.hash !== m.hash || cur.remoteDeleted) {
        mappings.set(m.key, m);
        await store.saveMapping(target, calendarId, m);
        if (!cur) res.adopted++;
      }
    }
    pageToken = r.nextPageToken;
    next = r.nextSyncToken ?? next;
    if (!pageToken) break;
  }
  if (next) await store.saveState(target, { syncToken: next });
  return true;
}

async function runLimited<T>(items: readonly T[], limit: number, deadlineAt: number, now: () => number, fn: (x: T) => Promise<void>): Promise<boolean> {
  for (let i = 0; i < items.length; i += limit) {
    if (now() > deadlineAt) return false;
    await Promise.all(items.slice(i, i + limit).map(fn));
  }
  return true;
}

/** Sincroniza um alvo ("user:<id>" / "shared:<cidade>") com a lista de eventos desejados. */
export async function syncCalendarTarget(api: CalendarApiLike, store: CalendarStore, target: string, desired: readonly DesiredEvent[], o: CalendarSyncOptions): Promise<CalendarSyncResult> {
  const now = o.now ?? Date.now;
  const res: CalendarSyncResult = { calendarId: null, inserted: 0, updated: 0, deleted: 0, adopted: 0, unchanged: 0, partial: false, rateLimited: false, fullResync: false };
  try {
    let calendarId = await ensureCalendar(api, store, target, o);
    res.calendarId = calendarId;
    const mappings = new Map((await store.loadMappings(target)).map((m) => [m.key, m]));
    let pulled: boolean;
    try { pulled = await pullChanges(api, store, target, calendarId, mappings, o, res); }
    catch (err) {
      // Calendário apagado pela pessoa → cria outro e recomeça.
      if (httpStatusOf(err) !== 404) throw err;
      await store.saveState(target, { calendarId: null, syncToken: null });
      for (const k of Array.from(mappings.keys())) await store.deleteMapping(target, k);
      mappings.clear();
      calendarId = await ensureCalendar(api, store, target, o);
      res.calendarId = calendarId;
      pulled = true;
    }
    if (!pulled) { res.partial = true; return res; }

    const plan = planCalendarOps(desired, Array.from(mappings.values()), o.windowFromMs);
    res.unchanged = desired.length - plan.insert.length - plan.patch.length;
    const limit = Math.max(1, o.concurrency ?? 4);
    const save = (d: DesiredEvent, eventId: string) => store.saveMapping(target, calendarId, { key: d.key, eventId, version: d.version, hash: eventHash(d), startMs: d.startMs, remoteDeleted: false });

    const patchOne = async (d: DesiredEvent, eventId: string) => {
      try {
        await api.patchEvent(calendarId, eventId, eventBody(d) as any);
        await save(d, eventId);
        res.updated++;
      } catch (err) {
        if (![404, 410].includes(httpStatusOf(err) ?? 0)) throw err;
        await insertOne(d); // desapareceu de vez → volta a criar
      }
    };
    const insertOne = async (d: DesiredEvent) => {
      const id = calendarEventId(target, d.key);
      try {
        const e = await api.insertEvent(calendarId, { id, ...(eventBody(d) as any) });
        await save(d, String(e.id ?? id));
        res.inserted++;
      } catch (err) {
        // Já existe (corrida anterior a meio, ou apagado pela pessoa) → atualiza.
        if (httpStatusOf(err) !== 409) throw err;
        await api.patchEvent(calendarId, id, eventBody(d) as any);
        await save(d, id);
        res.updated++;
      }
    };

    const ok1 = await runLimited(plan.insert, limit, o.deadlineAt, now, insertOne);
    const ok2 = ok1 && (await runLimited(plan.patch, limit, o.deadlineAt, now, (p) => patchOne(p.desired, p.eventId)));
    const ok3 = ok2 && (await runLimited(plan.delete, limit, o.deadlineAt, now, async (m) => {
      await api.deleteEvent(calendarId, m.eventId);
      await store.deleteMapping(target, m.key);
      res.deleted++;
    }));
    for (const m of plan.forget) await store.deleteMapping(target, m.key);
    if (!ok3) res.partial = true;
    return res;
  } catch (err) {
    if (err instanceof GoogleRateLimitError) { res.rateLimited = true; res.partial = true; return res; }
    throw err;
  }
}
