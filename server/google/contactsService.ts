/**
 * Contactos Google — o que a corrida (cron google-sync) e a app usam:
 *
 *  - diretório da empresa (conta de serviço com delegação, a impersonar a
 *    conta configurada em Definições → Comunicação → Contactos Google):
 *    leitura completa 1×/dia, resumível;
 *  - por pessoa com a funcionalidade "Contactos" autorizada: grupo
 *    "Multipark — Serviço" (clientes das recolhas/entregas de hoje e amanhã
 *    do seu turno/cidade; papéis e retenção configuráveis), grupo opcional de
 *    parceiros, e leitura dos contactos para as sugestões;
 *  - resumo para o Perfil e "Testar" das Integrações.
 * Nunca regista dados de contactos (só contagens).
 */
import { sql } from "drizzle-orm";
import {
  DIRECTORY_SCOPES, desiredPartnerContacts, desiredServiceContacts, parseContactsConfig, partnersPushAllowed, serviceRoleEligible, servicePushAllowed,
  type ContactsConfig, type DesiredPushContact, type GoogleContactsPrefs, type ServiceWindow,
} from "../../shared/contacts";
import { hasFeatureScopes } from "../../shared/mail";
import { addDays, lisbonDayOf, lisbonMidnightUtcMs } from "../../shared/lisbonDay";
import { handoverCityKey, lisbonLocalTimeUtcMs } from "../../shared/shiftHandover";
import { delegatedClient, dwdConfigured, googleErrorMessage, isAuthRevokedError } from "./workspace";
import { peopleFor, wrapPeople } from "./peopleApi";
import { directoryDue, syncDirectory } from "./directorySync";
import { syncUserContacts, type ContactsSyncResult, type PushGroupInput } from "./contactsSync";
import {
  claimDirectoryLock, dbContactsStore, dbDirectoryStore, getContactsState, getDirectoryState, patchContactsState, patchDirectoryState,
  releaseDirectoryLock,
} from "./contactsStore";
import { db, inList, nowSql, rowsOf } from "./syncStore";

export async function loadContactsConfig(): Promise<ContactsConfig> {
  try {
    const { getSetting } = await import("../appSettings");
    return parseContactsConfig(await getSetting("google.contacts"));
  } catch { return parseContactsConfig(null); }
}

// ─── Diretório ──────────────────────────────────────────────────────────────

export interface DirectoryRunReport { configured: boolean; ran: boolean; done: boolean; count: number | null; error: string | null }

export async function runDirectorySync(opts: { deadlineAt: number; force?: boolean; now?: () => number }): Promise<DirectoryRunReport> {
  const out: DirectoryRunReport = { configured: false, ran: false, done: true, count: null, error: null };
  const cfg = await loadContactsConfig();
  if (!cfg.directory.enabled || !cfg.directory.adminEmail) return out;
  out.configured = true;
  if (!dwdConfigured()) { out.error = "Diretório: conta de serviço em falta (GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON)."; return out; }
  const state = await getDirectoryState();
  if (!opts.force && !directoryDue(state, (opts.now ?? Date.now)())) return out;
  if (!(await claimDirectoryLock())) { out.done = false; return out; }
  out.ran = true;
  try {
    const client = delegatedClient(cfg.directory.adminEmail, DIRECTORY_SCOPES);
    try { await client.authorize(); }
    catch (err) {
      out.error = isAuthRevokedError(err)
        ? `Diretório: a conta de serviço não tem delegação para ${cfg.directory.adminEmail} (Admin Google → Segurança → Controlos de API → Delegação ao nível do domínio: autoriza ${DIRECTORY_SCOPES.join(", ")}).`
        : `Diretório: ${googleErrorMessage(err)}`;
      await patchDirectoryState({ lastError: out.error, lastRunAt: nowSql() }).catch(() => {});
      return out;
    }
    const api = wrapPeople(peopleFor(client), { deadlineAt: opts.deadlineAt });
    const r = await syncDirectory(api, dbDirectoryStore, { deadlineAt: opts.deadlineAt, now: opts.now });
    out.done = r.done;
    out.count = r.count;
    return out;
  } catch (err: any) {
    out.error = `Diretório: ${googleErrorMessage(err)}`;
    out.done = !err?.rateLimited ? true : false;
    await patchDirectoryState({ lastError: out.error.slice(0, 500), lastRunAt: nowSql() }).catch(() => {});
    return out;
  } finally {
    await releaseDirectoryLock().catch(() => {});
  }
}

// ─── Contactos desejados ────────────────────────────────────────────────────

const CITY_ALIASES: Record<string, string[]> = { lisbon: ["lisboa", "lisbon"], porto: ["porto", "oporto"], faro: ["faro"] };

async function baseCities(userId: number, role: string): Promise<string[]> {
  try {
    const { loadCityAccessParts } = await import("../cityAccess");
    const { base } = await loadCityAccessParts(userId, role);
    if (base.all) return [];
    const names = base.cityNames?.length ? base.cityNames : base.cityName ? [base.cityName] : [];
    return Array.from(new Set(names.map((n) => handoverCityKey(n)).filter((x): x is NonNullable<typeof x> => !!x)));
  } catch { return []; }
}

/**
 * Janelas de serviço da pessoa (hoje e amanhã, Lisboa) por cidade:
 *  - turnos confirmados no Extras-Dia → das (início − 1 h) às (fim + 1 h);
 *  - supervisor ou acima (os únicos que recebem o grupo — decisão de 26 set
 *    2026) → o dia inteiro das suas cidades de base;
 *  - team leader → o dia inteiro das suas cidades (coordena todos);
 *  - condutor sem turno nesse dia na escala → o dia inteiro da sua cidade
 *    (os condutores da casa nem sempre estão no Extras-Dia).
 */
export async function serviceWindows(u: { userId: number; role: string; employeeId: number | null }, nowMs: number): Promise<Map<string, ServiceWindow[]>> {
  const today = lisbonDayOf(nowMs);
  const days = [today, addDays(today, 1)];
  const out = new Map<string, ServiceWindow[]>();
  const add = (city: string, w: ServiceWindow) => { const l = out.get(city) ?? []; l.push(w); out.set(city, l); };
  const d = await db();
  const withShift = new Set<string>();
  if (u.employeeId != null) {
    const rows = rowsOf(await d.execute(sql`SELECT assignmentDate, city, startHour, endHour, sentHomeHour FROM extras_dia_assignments
      WHERE employeeId = ${u.employeeId} AND status = 'confirmed' AND assignmentDate IN (${inList(days)}) LIMIT 20`));
    for (const r of rows) {
      const end = r.sentHomeHour != null && Number(r.sentHomeHour) > Number(r.startHour) ? Number(r.sentHomeHour) : Number(r.endHour);
      add(String(r.city), { fromMs: lisbonLocalTimeUtcMs(String(r.assignmentDate), Math.max(0, Number(r.startHour) - 1)), toMs: lisbonLocalTimeUtcMs(String(r.assignmentDate), end + 1) });
      withShift.add(String(r.assignmentDate));
    }
  }
  // Só supervisor ou acima chega aqui (servicePushAllowed): o dia inteiro das suas cidades de base.
  const wholeDayFor = serviceRoleEligible(u.role) || u.role === "team_leader" ? days : u.role === "condutor" ? days.filter((x) => !withShift.has(x)) : [];
  if (wholeDayFor.length) {
    for (const city of await baseCities(u.userId, u.role)) {
      for (const day of wholeDayFor) add(city, { fromMs: lisbonMidnightUtcMs(day), toMs: lisbonMidnightUtcMs(addDays(day, 1)) });
    }
  }
  return out;
}

export async function desiredServiceFor(u: { userId: number; role: string; employeeId: number | null }, cfg: ContactsConfig, nowMs: number): Promise<DesiredPushContact[]> {
  const windows = await serviceWindows(u, nowMs);
  if (!windows.size) return [];
  const d = await db();
  const bookings: any[] = [];
  const all: ServiceWindow[] = [];
  for (const [city, ws] of windows) {
    all.push(...ws);
    const aliases = CITY_ALIASES[city] ?? [city];
    const from = new Date(Math.min(...ws.map((w) => w.fromMs))).toISOString().slice(0, 19).replace("T", " ");
    const to = new Date(Math.max(...ws.map((w) => w.toMs))).toISOString().slice(0, 19).replace("T", " ");
    bookings.push(...rowsOf(await d.execute(sql`SELECT clientFirstName, clientLastName, clientPhone, licensePlate, status, checkIn, checkOut
      FROM multipark_bookings
      WHERE clientPhone IS NOT NULL AND clientPhone <> '' AND LOWER(TRIM(city)) IN (${inList(aliases)})
        AND UPPER(COALESCE(status, '')) NOT LIKE '%CANCEL%'
        AND ((checkIn >= ${from} AND checkIn < ${to}) OR (checkOut >= ${from} AND checkOut < ${to}))
      LIMIT 3000`)));
  }
  const toStr = (v: any) => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 19).replace("T", " ") : String(v));
  return desiredServiceContacts(bookings.map((b) => ({ ...b, checkIn: toStr(b.checkIn), checkOut: toStr(b.checkOut) })), all,
    { retentionDays: cfg.service.retentionDays, max: cfg.service.maxPerUser, nowMs });
}

export async function desiredPartnersFor(): Promise<DesiredPushContact[]> {
  const d = await db();
  const rows = rowsOf(await d.execute(sql`SELECT name, contactName, contactPhone, partnerStatus FROM partnerships
    WHERE partnerStatus = 'active' AND contactPhone IS NOT NULL AND contactPhone <> '' ORDER BY name LIMIT 1000`));
  return desiredPartnerContacts(rows.map((r) => ({ name: String(r.name), contactName: r.contactName ?? null, contactPhone: r.contactPhone ?? null, status: r.partnerStatus ?? null })));
}

// ─── Uma pessoa (chamado pelo syncOneUser do google-sync) ───────────────────

export interface ContactsUserReport extends Pick<ContactsSyncResult, "pulled" | "created" | "deleted" | "forgotten" | "adopted" | "partial" | "rateLimited"> { warnings: string[] }

export async function runUserContacts(c: { userId: number; role: string }, employeeId: number | null, opts: { deadlineAt: number; now?: () => number }): Promise<ContactsUserReport> {
  const cfg = await loadContactsConfig();
  const state = await getContactsState(c.userId);
  const prefs: GoogleContactsPrefs = state.prefs;
  const nowMs = (opts.now ?? Date.now)();
  const groups: PushGroupInput[] = [];
  const serviceOn = servicePushAllowed(c.role, cfg) && prefs.serviceGroup;
  groups.push({ group: "service", enabled: serviceOn, desired: serviceOn ? await desiredServiceFor({ userId: c.userId, role: c.role, employeeId }, cfg, nowMs) : [] });
  const partnersOn = partnersPushAllowed(c.role, cfg) && prefs.partnersGroup;
  groups.push({ group: "partners", enabled: partnersOn, desired: partnersOn ? await desiredPartnersFor() : [] });
  const { userGoogleAuth } = await import("./userAccounts");
  const { client } = await userGoogleAuth(c.userId, "contacts");
  const api = wrapPeople(peopleFor(client), { deadlineAt: opts.deadlineAt });
  const r = await syncUserContacts(api, dbContactsStore, { userId: c.userId, prefs, groups, deadlineAt: opts.deadlineAt - 1_500, now: opts.now });
  const warnings = [...r.warnings];
  if (serviceOn && employeeId == null) warnings.push("Sem ficha de funcionário ligada — o grupo \"Serviço\" só usa a cidade da conta.");
  await patchContactsState(c.userId, {
    ...(r.partial ? {} : { lastPushAt: nowSql(), ...(prefs.suggestions ? { lastPullAt: nowSql() } : {}) }),
  });
  return { pulled: r.pulled, created: r.created, deleted: r.deleted, forgotten: r.forgotten, adopted: r.adopted, partial: r.partial, rateLimited: r.rateLimited, warnings };
}

/** A pessoa quer alguma coisa dos Contactos (e o papel permite)? */
export async function wantsContacts(userId: number, role: string): Promise<boolean> {
  try {
    const cfg = await loadContactsConfig();
    const st = await getContactsState(userId);
    if (st.prefs.suggestions) return true;
    if (servicePushAllowed(role, cfg) && st.prefs.serviceGroup) return true;
    if (partnersPushAllowed(role, cfg) && st.prefs.partnersGroup) return true;
    // Desligou tudo mas ainda há contactos criados pela app → é preciso limpar.
    const d = await db();
    return rowsOf(await d.execute(sql`SELECT 1 AS x FROM google_pushed_contacts WHERE userId = ${userId} LIMIT 1`)).length > 0;
  } catch { return false; }
}

// ─── Resumo para o Perfil ───────────────────────────────────────────────────

export async function contactsSummary(userId: number, role: string) {
  const { googleAccountSummary } = await import("./userAccounts");
  const account = await googleAccountSummary(userId);
  const cfg = await loadContactsConfig();
  let state = null as Awaited<ReturnType<typeof getContactsState>> | null;
  let counts = { service: 0, partners: 0, contacts: 0 };
  try {
    state = await getContactsState(userId);
    const d = await db();
    const r = rowsOf(await d.execute(sql`SELECT SUM(groupKey = 'service') AS service, SUM(groupKey = 'partners') AS partners FROM google_pushed_contacts WHERE userId = ${userId}`))[0];
    const c = rowsOf(await d.execute(sql`SELECT COUNT(*) AS n FROM google_user_contacts WHERE userId = ${userId}`))[0];
    counts = { service: Number(r?.service ?? 0), partners: Number(r?.partners ?? 0), contacts: Number(c?.n ?? 0) };
  } catch { /* tabelas ainda por criar */ }
  const granted = account.features.find((x) => x.id === "contacts")?.granted ?? false;
  const { DEFAULT_GOOGLE_CONTACTS_PREFS } = await import("../../shared/contacts");
  return {
    account,
    granted,
    prefs: state?.prefs ?? DEFAULT_GOOGLE_CONTACTS_PREFS,
    serviceAllowed: servicePushAllowed(role, cfg),
    partnersAllowed: partnersPushAllowed(role, cfg),
    retentionDays: cfg.service.retentionDays,
    counts,
    lastRunAt: state?.lastRunAt ?? null,
    lastStatus: state?.lastStatus ?? null,
    lastError: state?.lastError ?? null,
    lastWarning: state?.lastWarning ?? null,
  };
}

/** Desligar os Contactos: esquece o que se guardou (os criados no Google são limpos na próxima corrida). */
export async function setContactsPrefs(userId: number, prefs: GoogleContactsPrefs): Promise<void> {
  await patchContactsState(userId, { prefsJson: JSON.stringify(prefs) });
  if (!prefs.suggestions) {
    const { purgeUserContacts } = await import("./contactsStore");
    await purgeUserContacts(userId);
  }
  const { patchSyncState } = await import("./syncStore");
  await patchSyncState(userId, { dirtyAt: nowSql() }).catch(() => {});
}

/** Apaga do Google da pessoa tudo o que a app lá criou (desligar a conta). */
export async function removeAllAppContacts(userId: number, deadlineAt: number): Promise<void> {
  const { userGoogleAuth } = await import("./userAccounts");
  const { client } = await userGoogleAuth(userId, "contacts");
  const api = wrapPeople(peopleFor(client), { deadlineAt });
  await syncUserContacts(api, dbContactsStore, {
    userId, prefs: { suggestions: false, serviceGroup: false, partnersGroup: false },
    groups: [{ group: "service", enabled: false, desired: [] }, { group: "partners", enabled: false, desired: [] }], deadlineAt,
  });
}

/** Contas com a funcionalidade autorizada (para o "Testar"). */
export async function testGoogleContacts(): Promise<string> {
  const parts: string[] = [];
  const cfg = await loadContactsConfig();
  if (cfg.directory.enabled && cfg.directory.adminEmail) {
    const client = delegatedClient(cfg.directory.adminEmail, DIRECTORY_SCOPES);
    await client.authorize();
    const page = await wrapPeople(peopleFor(client), { deadlineAt: Date.now() + 15_000 }).listDirectory({ pageSize: 1 });
    parts.push(`diretório OK (delegação para ${cfg.directory.adminEmail}${page.people.length ? "" : ", sem perfis"})`);
  }
  const d = await db();
  const rows = rowsOf(await d.execute(sql`SELECT userId, scopes FROM google_user_accounts WHERE status = 'connected' LIMIT 500`));
  const withContacts = rows.filter((r) => hasFeatureScopes(String(r.scopes ?? ""), "contacts"));
  if (withContacts[0]) {
    const { userGoogleAuth } = await import("./userAccounts");
    const { client } = await userGoogleAuth(Number(withContacts[0].userId), "contacts");
    await wrapPeople(peopleFor(client), { deadlineAt: Date.now() + 15_000 }).listContactGroups();
    parts.push("API People (contactos) OK");
  }
  if (!parts.length) throw new Error("O diretório está desligado e ninguém autorizou ainda os Contactos (Perfil → Google).");
  return `Ligação OK (${parts.join("; ")}; ${withContacts.length} pessoa(s) com Contactos).`;
}
