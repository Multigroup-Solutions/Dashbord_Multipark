import { beforeEach, describe, expect, it } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import {
  APP_CONTACT_EXPIRES_KEY, APP_CONTACT_MARKER_KEY, DEFAULT_CONTACTS_CONFIG, PUSH_GROUP_NAMES, appMarkerOf, buildMatchIndex, contactKindsFor, desiredPartnerContacts,
  desiredServiceContacts, emailKey, mapDirectoryPerson, matchContact, parseContactQuery, parseContactsConfig, partnersPushAllowed, phoneKey, planPushOps,
  pushContactBody, selectDeletable, servicePushAllowed, type DesiredPushContact, type PersonLike, type PushMapping,
} from "../shared/contacts";
import { GOOGLE_FEATURES_ENABLED, GOOGLE_FEATURE_SCOPES, hasFeatureScopes } from "../shared/mail";
import { scopesFor } from "./google/workspace";
import { requestedFeatures } from "./google/userAccounts";
import { directoryDue, syncDirectory, type DirectoryState, type DirectoryStore } from "./google/directorySync";
import { syncUserContacts, type ContactsStateRow, type ContactsSyncStore, type UserContactRow } from "./google/contactsSync";
import type { PeopleApiLike, PeoplePage } from "./google/peopleApi";
import { isExpiredSyncTokenError } from "./google/peopleApi";
import { MIGRATION_0155_STATEMENTS } from "./migrations/migration_0155";
import { cityScope } from "./cityScope";
import { searchContacts, contactDetail, searchableKinds } from "./contactsSearch";
import { invalidateClientsCache } from "./clientsCrm";

const H = 3_600_000;
const D = 24 * H;

// ─── 1. Funcionalidade "contacts" (autorização incremental) ─────────────────

describe("Contactos — âmbitos e funcionalidade", () => {
  it("a funcionalidade está ligada e pede só contacts + contacts.other.readonly", () => {
    expect(GOOGLE_FEATURES_ENABLED).toContain("contacts");
    expect(GOOGLE_FEATURE_SCOPES.contacts).toEqual(["https://www.googleapis.com/auth/contacts", "https://www.googleapis.com/auth/contacts.other.readonly"]);
    expect(scopesFor(["contacts"])).toEqual(["openid", "email", "profile", ...GOOGLE_FEATURE_SCOPES.contacts]);
  });
  it("pedido incremental aceita contacts (e o drive, ligado na fase do Drive)", () => {
    expect(requestedFeatures("contacts")).toEqual(["contacts"]);
    expect(requestedFeatures("tasks,contacts,drive")).toEqual(["tasks", "contacts", "drive"]);
    expect(requestedFeatures("drive")).toEqual(["drive"]);
  });
  it("hasFeatureScopes exige os dois âmbitos (readonly antigo não chega)", () => {
    const both = `openid ${GOOGLE_FEATURE_SCOPES.contacts.join(" ")} https://www.googleapis.com/auth/gmail.modify`;
    expect(hasFeatureScopes(both, "contacts")).toBe(true);
    expect(hasFeatureScopes("https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/contacts.other.readonly", "contacts")).toBe(false);
    expect(hasFeatureScopes("https://www.googleapis.com/auth/contacts", "contacts")).toBe(false);
  });
  it("definições: omissões (condutor e TL, 2 dias) e leitura campo a campo", () => {
    expect(parseContactsConfig(null)).toEqual(DEFAULT_CONTACTS_CONFIG);
    expect(DEFAULT_CONTACTS_CONFIG.service.roles).toEqual(["condutor", "team_leader"]);
    expect(DEFAULT_CONTACTS_CONFIG.service.retentionDays).toBe(2);
    const c = parseContactsConfig({ service: { retentionDays: 5 } });
    expect(c.service.retentionDays).toBe(5);
    expect(c.service.roles).toEqual(["condutor", "team_leader"]);
    expect(servicePushAllowed("condutor", c)).toBe(true);
    expect(servicePushAllowed("team_leader", c)).toBe(true);
    expect(servicePushAllowed("backoffice", c)).toBe(false);
    expect(partnersPushAllowed("backoffice", c)).toBe(false); // desligado por omissão
    expect(partnersPushAllowed("backoffice", parseContactsConfig({ partners: { enabled: true } }))).toBe(true);
    // Diretório ligado sem conta → inválido → omissões seguras
    expect(parseContactsConfig({ directory: { enabled: true, adminEmail: "" } }).directory.enabled).toBe(false);
  });
  it("syncToken expirado reconhecido (410 / EXPIRED_SYNC_TOKEN)", () => {
    expect(isExpiredSyncTokenError({ response: { status: 410 } })).toBe(true);
    expect(isExpiredSyncTokenError({ response: { status: 400, data: { error: { status: "FAILED_PRECONDITION", details: [{ reason: "EXPIRED_SYNC_TOKEN" }] } } } })).toBe(true);
    expect(isExpiredSyncTokenError({ response: { status: 400, data: { error: { message: "Invalid field" } } } })).toBe(false);
  });
});

// ─── 2. Normalização e correspondências ─────────────────────────────────────

describe("Contactos — normalização (E.164, Portugal por omissão) e correspondências", () => {
  it("telefones: nacional PT, 00, +, separadores; o resto é descartado", () => {
    expect(phoneKey("912 345 678")).toBe("+351912345678");
    expect(phoneKey("00351 912-345-678")).toBe("+351912345678");
    expect(phoneKey("(+351) 912.345.678")).toBe("+351912345678");
    expect(phoneKey("351912345678")).toBe("+351912345678");
    expect(phoneKey("+44 7911 123456")).toBe("+447911123456");
    expect(phoneKey("12345")).toBe("");
    expect(phoneKey(null)).toBe("");
  });
  it("emails: minúsculas, sem espaços, só plausíveis", () => {
    expect(emailKey("  Ana.Silva@Gmail.COM ")).toBe("ana.silva@gmail.com");
    expect(emailKey("nao-e-email")).toBe("");
  });
  it("encontra por email e por telefone escrito de outra forma; sem repetidos; email primeiro", () => {
    const idx = buildMatchIndex([
      { kind: "client", id: "ana@x.pt", label: "Ana", emails: ["ANA@x.pt"], phones: ["912345678"] },
      { kind: "partner", id: "7", label: "Agência Sol", emails: [], phones: ["+351 213 000 000"] },
      { kind: "lead", id: "3", label: "Rui", emails: ["rui@y.pt"], phones: [] },
    ]);
    const m = matchContact({ emails: ["ana@x.pt"], phones: ["+351912345678"] }, idx);
    expect(m).toEqual([{ kind: "client", id: "ana@x.pt", label: "Ana", via: "email" }]);
    expect(matchContact({ emails: [], phones: ["00351213000000"] }, idx)).toEqual([{ kind: "partner", id: "7", label: "Agência Sol", via: "phone" }]);
    expect(matchContact({ emails: ["outro@z.pt"], phones: ["+351999999999"] }, idx)).toEqual([]);
  });
  it("pesquisa: LIKE escapado, dígitos e agulha de telefone (últimos 9)", () => {
    const q = parseContactQuery("50%_off\\");
    expect(q.like).toBe("%50\\%\\_off\\\\%");
    const p = parseContactQuery("+351 912 345 678");
    expect(p.phoneNeedle).toBe("912345678");
    expect(parseContactQuery("ab").phoneNeedle).toBe("");
  });
});

// ─── 3. Grupo "Serviço": desejados, plano e retenção ────────────────────────

const now = Date.parse("2026-09-25T10:00:00Z");
const sqlTs = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

describe("Contactos — grupo \"Multipark — Serviço\"", () => {
  it("clientes das recolhas/entregas nas janelas, 1 por telefone, sem cancelados, retenção a contar do último serviço, limite", () => {
    const w = [{ fromMs: now - 2 * H, toMs: now + 10 * H }];
    const list = desiredServiceContacts([
      { clientFirstName: "Ana", clientLastName: "Silva", clientPhone: "912345678", licensePlate: "aa-00-bb", status: "CONFIRMED", checkIn: sqlTs(now + H), checkOut: sqlTs(now + 5 * D) },
      { clientFirstName: "Ana", clientLastName: "Silva", clientPhone: "+351 912 345 678", status: "CONFIRMED", checkIn: sqlTs(now - 20 * D), checkOut: sqlTs(now + 3 * H) },
      { clientFirstName: "Bruno", clientPhone: "913000000", status: "CANCELLED", checkIn: sqlTs(now + H) },
      { clientFirstName: "Carla", clientPhone: "sem número", status: "CONFIRMED", checkIn: sqlTs(now + H) },
      { clientFirstName: "Dora", clientPhone: "914000000", status: "CONFIRMED", checkIn: sqlTs(now + 2 * D) }, // fora da janela
      { clientFirstName: "Eva", clientPhone: "915000000", status: "CONFIRMED", checkOut: sqlTs(now + 8 * H) },
    ], w, { retentionDays: 2, max: 10, nowMs: now });
    expect(list.map((c) => c.phoneE164)).toEqual(["+351912345678", "+351915000000"]);
    const ana = list[0];
    // Nome/matrícula da reserva do serviço mais tardio (a 2.ª não tem matrícula).
    expect(ana.displayName).toBe("Cliente Multipark: Ana Silva");
    expect(list[1].displayName).toBe("Cliente Multipark: Eva");
    expect(ana.lastServiceMs).toBe(now + 3 * H);
    expect(ana.expiresAtMs).toBe(now + 3 * H + 2 * D);
    expect(desiredServiceContacts([{ clientFirstName: "A", clientPhone: "912345678", checkIn: sqlTs(now + H) }, { clientFirstName: "B", clientPhone: "913345678", checkIn: sqlTs(now + 2 * H) }], w,
      { retentionDays: 2, max: 1, nowMs: now }).map((c) => c.phoneE164)).toEqual(["+351912345678"]);
  });

  it("corpo do contacto: mínimo (nome, telefone, grupo) + marca da app e validade", () => {
    const [c] = desiredServiceContacts([{ clientFirstName: "Ana", clientPhone: "912345678", checkIn: sqlTs(now + H) }], [{ fromMs: now, toMs: now + D }], { retentionDays: 2, max: 5, nowMs: now });
    const body = pushContactBody(c, 42, "contactGroups/abc");
    expect(body.phoneNumbers).toEqual([{ value: "+351912345678", type: "mobile" }]);
    expect(body.memberships[0].contactGroupMembership.contactGroupResourceName).toBe("contactGroups/abc");
    expect(body.clientData).toEqual([{ key: APP_CONTACT_MARKER_KEY, value: "service:42" }, { key: APP_CONTACT_EXPIRES_KEY, value: new Date(c.expiresAtMs!).toISOString() }]);
    expect(JSON.stringify(body)).not.toContain("@");
    expect(appMarkerOf(body as any)).toEqual({ group: "service", userId: 42, expiresAtMs: c.expiresAtMs });
  });

  const d = (key: string, expiresAtMs: number | null): DesiredPushContact => ({ key, group: "service", displayName: key, phoneE164: key, lastServiceMs: null, expiresAtMs, hash: "h" });
  const m = (key: string, expiresAtMs: number | null): PushMapping => ({ key, resourceName: `people/${key}`, hash: "h", expiresAtMs });

  it("plano: cria o que falta, prolonga a retenção, apaga só depois da retenção; desligado apaga tudo; idempotente", () => {
    const plan = planPushOps([d("+1", now + 3 * D), d("+2", now + D)], [m("+2", now + D / 2), m("+3", now + H), m("+4", now - H)], now, { enabled: true });
    expect(plan.create.map((x) => x.key)).toEqual(["+1"]);
    expect(plan.extend).toEqual([{ key: "+2", expiresAtMs: now + D }]);
    expect(plan.delete.map((x) => x.key)).toEqual(["+4"]); // +3 ainda dentro da retenção
    expect(planPushOps([], [m("+3", now + H)], now, { enabled: false }).delete.map((x) => x.key)).toEqual(["+3"]);
    const again = planPushOps([d("+1", now + 3 * D)], [m("+1", now + 3 * D)], now, { enabled: true });
    expect(again).toEqual({ create: [], extend: [], delete: [] });
    // Parceiros (sem retenção): deixa de ser desejado → apaga logo
    expect(planPushOps([], [m("+9", null)], now, { enabled: true }).delete.map((x) => x.key)).toEqual(["+9"]);
  });

  it("limpeza: só apaga contactos com a marca da app DESTA pessoa e DESTE grupo", () => {
    const mk = (value: string | null): PersonLike => ({ clientData: value ? [{ key: APP_CONTACT_MARKER_KEY, value }] : [] });
    const cands = [m("a", 0), m("b", 0), m("c", 0), m("d", 0), m("e", 0)];
    const remote = new Map<string, PersonLike | null>([
      ["people/a", mk("service:42")],     // nosso → apaga
      ["people/b", mk(null)],             // sem marca (a pessoa editou/é dela) → nunca apaga
      ["people/c", mk("service:7")],      // de outra pessoa → nunca
      ["people/d", mk("partners:42")],    // outro grupo → nunca
      ["people/e", null],                 // já não existe → esquece
    ]);
    const r = selectDeletable(cands, remote, 42, "service");
    expect(r.delete.map((x) => x.key)).toEqual(["a"]);
    expect(r.forget.map((x) => x.key).sort()).toEqual(["b", "c", "d", "e"]);
  });

  it("parceiros: ativos com telefone, 1 por número", () => {
    const l = desiredPartnerContacts([
      { name: "Agência Sol", contactName: "Rita", contactPhone: "213000000", status: "active" },
      { name: "Outra", contactPhone: "213000000", status: "active" },
      { name: "Inativa", contactPhone: "214000000", status: "inactive" },
    ]);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ group: "partners", phoneE164: "+351213000000", expiresAtMs: null, displayName: "Parceiro Multipark: Agência Sol (Rita)" });
    expect(PUSH_GROUP_NAMES.service).toBe("Multipark — Serviço");
  });
});

// ─── Motor por pessoa (API e BD falsas) ─────────────────────────────────────

function fakeStore() {
  const state: ContactsStateRow = { otherSyncToken: null, otherPageToken: null, connSyncToken: null, connPageToken: null, serviceGroup: null, partnersGroup: null };
  const contacts = new Map<string, UserContactRow>();
  const pushed = new Map<string, PushMapping & { group: string }>();
  const store: ContactsSyncStore = {
    async getState() { return { ...state }; },
    async saveState(_u, p) { Object.assign(state, p); },
    async countUserContacts() { return contacts.size; },
    async upsertUserContacts(_u, rows) { for (const r of rows) contacts.set(r.resourceName, r); },
    async deleteUserContacts(_u, names) { for (const n of names) contacts.delete(n); },
    async clearUserContacts(_u, source) { for (const [k, v] of contacts) if (!source || v.source === source) contacts.delete(k); },
    async loadPushMappings(_u, g) { return Array.from(pushed.values()).filter((x) => x.group === g).map(({ group: _g, ...x }) => x); },
    async savePushMapping(_u, g, mm) { pushed.set(`${g}|${mm.key}`, { ...mm, group: g }); },
    async extendPushMapping(_u, g, key, exp) { const x = pushed.get(`${g}|${key}`); if (x) x.expiresAtMs = exp; },
    async forgetPushMappings(_u, g, keys) { for (const k of keys) pushed.delete(`${g}|${k}`); },
    async adoptPushed(_u, g, rn, exp) { pushed.set(`${g}|adotado:${rn}`, { key: `adotado:${rn}`, resourceName: rn, hash: null, expiresAtMs: exp ?? 0, group: g }); },
    async pushedResourceNames() { return new Set(Array.from(pushed.values()).map((x) => x.resourceName)); },
  };
  return { store, state, contacts, pushed };
}

function fakeApi(remote: Map<string, PersonLike>, pages: { other?: PeoplePage[]; conn?: PeoplePage[] } = {}) {
  const calls = { deleted: [] as string[], created: 0, groupsCreated: 0 };
  let n = 0;
  const api: PeopleApiLike = {
    async listDirectory() { return { people: [], nextPageToken: null, nextSyncToken: null }; },
    async listConnections(p) { const list = pages.conn ?? [{ people: [], nextPageToken: null, nextSyncToken: "c1" }]; return list[p.pageToken ? Number(p.pageToken) : 0]; },
    async listOtherContacts(p) { const list = pages.other ?? [{ people: [], nextPageToken: null, nextSyncToken: "o1" }]; return list[p.pageToken ? Number(p.pageToken) : 0]; },
    async listContactGroups() { return []; },
    async createContactGroup() { calls.groupsCreated++; return { resourceName: "contactGroups/svc" }; },
    async batchCreateContacts(persons) {
      return persons.map((p: any) => { const rn = `people/new${++n}`; remote.set(rn, { resourceName: rn, clientData: p.clientData }); calls.created++; return rn; });
    },
    async batchDeleteContacts(names) { for (const x of names) { calls.deleted.push(x); remote.delete(x); } },
    async getPeople(names) { return new Map(names.map((x) => [x, remote.get(x) ?? null])); },
  };
  return { api, calls };
}

describe("Contactos — motor por pessoa", () => {
  const marked = (rn: string, value: string): PersonLike => ({ resourceName: rn, clientData: [{ key: APP_CONTACT_MARKER_KEY, value }] });

  it("cria o grupo e os contactos; na corrida seguinte (retenção acabada) apaga só os da app", async () => {
    const f = fakeStore();
    const remote = new Map<string, PersonLike>();
    const { api, calls } = fakeApi(remote);
    const want = desiredServiceContacts([{ clientFirstName: "Ana", clientPhone: "912345678", checkIn: sqlTs(now + H) }], [{ fromMs: now, toMs: now + D }], { retentionDays: 2, max: 10, nowMs: now });
    const r1 = await syncUserContacts(api, f.store, { userId: 42, prefs: { suggestions: false, serviceGroup: true, partnersGroup: false }, groups: [{ group: "service", enabled: true, desired: want }], deadlineAt: now + 60_000, now: () => now });
    expect(r1).toMatchObject({ created: 1, deleted: 0, partial: false });
    expect(calls.groupsCreated).toBe(1);
    expect(f.state.serviceGroup).toBe("contactGroups/svc");
    // A pessoa tem também um contacto dela com o mesmo número (sem marca) e um que a app criou para outra pessoa.
    remote.set("people/mine", { resourceName: "people/mine" });
    f.pushed.set("service|+351999", { key: "+351999", resourceName: "people/mine", hash: null, expiresAtMs: now, group: "service" });
    remote.set("people/other", marked("people/other", "service:7"));
    f.pushed.set("service|+351888", { key: "+351888", resourceName: "people/other", hash: null, expiresAtMs: now, group: "service" });
    const later = now + 3 * H + 3 * D;
    const r2 = await syncUserContacts(api, f.store, { userId: 42, prefs: { suggestions: false, serviceGroup: true, partnersGroup: false }, groups: [{ group: "service", enabled: true, desired: [] }], deadlineAt: later + 60_000, now: () => later });
    expect(calls.deleted).toEqual(["people/new1"]);
    expect(r2).toMatchObject({ deleted: 1, forgotten: 2 });
    expect(remote.has("people/mine")).toBe(true);
    expect(remote.has("people/other")).toBe(true);
    expect(f.pushed.size).toBe(0);
  });

  it("antes da retenção acabar não apaga nada", async () => {
    const f = fakeStore();
    const remote = new Map<string, PersonLike>([["people/x", marked("people/x", "service:42")]]);
    f.pushed.set("service|+1", { key: "+1", resourceName: "people/x", hash: null, expiresAtMs: now + D, group: "service" });
    const { api, calls } = fakeApi(remote);
    await syncUserContacts(api, f.store, { userId: 42, prefs: { suggestions: false, serviceGroup: true, partnersGroup: false }, groups: [{ group: "service", enabled: true, desired: [] }], deadlineAt: now + 60_000, now: () => now });
    expect(calls.deleted).toEqual([]);
    expect(f.pushed.size).toBe(1);
  });

  it("leitura (sugestões): guarda nome/emails/telefones normalizados; ignora e adota os da app; syncToken guardado", async () => {
    const f = fakeStore();
    const remote = new Map<string, PersonLike>();
    const { api } = fakeApi(remote, {
      other: [
        { people: [{ resourceName: "otherContacts/1", names: [{ displayName: "Rui" }], emailAddresses: [{ value: "RUI@y.pt" }] }], nextPageToken: "1", nextSyncToken: null },
        { people: [{ resourceName: "otherContacts/2", phoneNumbers: [{ value: "913 000 000" }] }], nextPageToken: null, nextSyncToken: "tok-o" },
      ],
      conn: [{ people: [marked("people/app", "service:42"), { resourceName: "people/gone", metadata: { deleted: true } }], nextPageToken: null, nextSyncToken: "tok-c" }],
    });
    const r = await syncUserContacts(api, f.store, { userId: 42, prefs: { suggestions: true, serviceGroup: false, partnersGroup: false }, groups: [], deadlineAt: now + 60_000, now: () => now });
    expect(r).toMatchObject({ pulled: 2, adopted: 1, partial: false });
    expect(f.contacts.get("otherContacts/1")).toMatchObject({ displayName: "Rui", emails: ["rui@y.pt"] });
    expect(f.contacts.get("otherContacts/2")?.phones).toEqual(["+351913000000"]);
    expect(f.contacts.has("people/app")).toBe(false);
    expect(f.state).toMatchObject({ otherSyncToken: "tok-o", otherPageToken: null, connSyncToken: "tok-c" });
    expect(Array.from(f.pushed.values()).map((x) => x.resourceName)).toEqual(["people/app"]);
  });

  it("sem sugestões: apaga o que se tinha lido", async () => {
    const f = fakeStore();
    f.contacts.set("otherContacts/1", { resourceName: "otherContacts/1", source: "other", displayName: "x", emails: [], phones: [] });
    const { api } = fakeApi(new Map());
    await syncUserContacts(api, f.store, { userId: 42, prefs: { suggestions: false, serviceGroup: false, partnersGroup: false }, groups: [], deadlineAt: now + 60_000, now: () => now });
    expect(f.contacts.size).toBe(0);
  });

  it("prazo curto: pára e fica parcial (continua na próxima corrida)", async () => {
    const f = fakeStore();
    const { api, calls } = fakeApi(new Map());
    const want = [{ key: "+351912345678", group: "service" as const, displayName: "x", phoneE164: "+351912345678", lastServiceMs: now, expiresAtMs: now + D, hash: "h" }];
    const r = await syncUserContacts(api, f.store, { userId: 42, prefs: { suggestions: true, serviceGroup: true, partnersGroup: false }, groups: [{ group: "service", enabled: true, desired: want }], deadlineAt: now + 1_000, now: () => now });
    expect(r.partial).toBe(true);
    expect(calls.created).toBe(0);
  });
});

// ─── 5. Diretório ───────────────────────────────────────────────────────────

describe("Contactos — diretório da empresa", () => {
  it("mapeia o perfil: email principal, cargo, departamento, telefone E.164, sem foto por omissão", () => {
    const r = mapDirectoryPerson({
      resourceName: "people/1",
      names: [{ displayName: "Ana Silva", givenName: "Ana", familyName: "Silva", metadata: { primary: true } }],
      emailAddresses: [{ value: "ana.alias@multipark.pt" }, { value: "Ana@Multipark.pt", metadata: { primary: true } }],
      phoneNumbers: [{ value: "912 345 678", metadata: { primary: true } }],
      organizations: [{ title: "Team Leader", department: "Operações Lisboa", metadata: { primary: true } }],
      photos: [{ url: "https://lh3.googleusercontent.com/a/default", default: true }],
    });
    expect(r).toMatchObject({
      resourceName: "people/1", primaryEmail: "ana@multipark.pt", emails: ["ana@multipark.pt", "ana.alias@multipark.pt"], displayName: "Ana Silva",
      jobTitle: "Team Leader", department: "Operações Lisboa", phoneE164: "+351912345678", phoneRaw: null, photoUrl: null, deleted: false,
    });
    const withPhoto = mapDirectoryPerson({ resourceName: "people/2", emailAddresses: [{ value: "rui@multipark.pt" }], photos: [{ url: "https://lh3/x" }], phoneNumbers: [{ value: "ext. 204" }] });
    expect(withPhoto).toMatchObject({ photoUrl: "https://lh3/x", phoneE164: null, phoneRaw: "ext. 204", displayName: "rui@multipark.pt" });
    expect(mapDirectoryPerson({ resourceName: "people/3" })).toBeNull(); // sem email
    expect(mapDirectoryPerson({ emailAddresses: [{ value: "x@y.pt" }] })).toBeNull(); // sem resourceName
  });

  it("1× por dia, ou a meio de uma leitura", () => {
    expect(directoryDue({ pageToken: null, lastFullSyncAt: null }, now)).toBe(true);
    expect(directoryDue({ pageToken: null, lastFullSyncAt: sqlTs(now - 2 * H) }, now)).toBe(false);
    expect(directoryDue({ pageToken: null, lastFullSyncAt: sqlTs(now - 25 * H) }, now)).toBe(true);
    expect(directoryDue({ pageToken: "p2", lastFullSyncAt: sqlTs(now - H) }, now)).toBe(true);
  });

  it("leitura resumível: guarda a página, continua na corrida seguinte e fecha no fim", async () => {
    const st: DirectoryState & Record<string, any> = { pageToken: null, runStartedMs: null, lastFullSyncAt: null };
    const upserts: Array<{ n: number; run: number }> = [];
    let finished: number | null = null;
    const store: DirectoryStore = {
      async getState() { return { ...st }; },
      async saveState(p) { Object.assign(st, p); },
      async upsertPeople(rows, run) { upserts.push({ n: rows.length, run }); },
      async finishRun(run) { finished = run; return 3; },
    };
    const person = (i: number): PersonLike => ({ resourceName: `people/${i}`, emailAddresses: [{ value: `p${i}@multipark.pt` }] });
    const pages: PeoplePage[] = [
      { people: [person(1), person(2)], nextPageToken: "1", nextSyncToken: null },
      { people: [person(3), { resourceName: "people/x" }], nextPageToken: null, nextSyncToken: null },
    ];
    let t = now;
    const api = { async listDirectory(p: { pageToken?: string | null }) { t += 2_000; return pages[p.pageToken ? Number(p.pageToken) : 0]; } } as unknown as PeopleApiLike;
    // 1.ª corrida: só dá tempo para uma página
    const r1 = await syncDirectory(api, store, { deadlineAt: now + 4_500, now: () => t });
    expect(r1).toMatchObject({ pages: 1, upserted: 2, done: false });
    expect(st.pageToken).toBe("1");
    const run = st.runStartedMs;
    const r2 = await syncDirectory(api, store, { deadlineAt: t + 60_000, now: () => t });
    expect(r2).toMatchObject({ pages: 1, upserted: 1, skipped: 1, done: true, count: 3 });
    expect(upserts.every((u) => u.run === run)).toBe(true);
    expect(finished).toBe(run);
    expect(st.pageToken).toBeNull();
    expect(st.lastFullSyncAt).toBeTruthy();
  });

  it("migração 0155 idempotente (só CREATE TABLE IF NOT EXISTS)", () => {
    expect(MIGRATION_0155_STATEMENTS.length).toBe(6);
    for (const s of MIGRATION_0155_STATEMENTS) expect(s.startsWith("CREATE TABLE IF NOT EXISTS")).toBe(true);
  });
});

// ─── 4. Acessos e âmbito de cidade na pesquisa ──────────────────────────────

describe("Contactos — quem pesquisa o quê", () => {
  const kinds = (role: string, accessOverrides?: any) => contactKindsFor({ role, accessOverrides }).map((k) => k.kind);
  it("papéis sem o módulo não pesquisam nada", () => {
    for (const r of ["user", "extra", "condutor"]) expect(kinds(r)).toEqual([]);
  });
  it("team leader: tipos dos seus módulos (colaboradores só da equipa); fornecedores fora (despesas da equipa)", () => {
    const tl = contactKindsFor({ role: "team_leader" });
    expect(tl.map((k) => k.kind)).toEqual(["client", "crm", "lead", "partner", "supplier", "employee", "directory", "google"]);
    expect(tl.find((k) => k.kind === "employee")?.access).toBe("below_city");
    expect(searchableKinds({ id: 1, role: "team_leader" }).map((k) => k.kind)).not.toContain("supplier");
    expect(searchableKinds({ id: 1, role: "supervisor" }).map((k) => k.kind)).toContain("supplier");
  });
  it("super admin / backoffice: tudo, nacional", () => {
    for (const r of ["backoffice", "super_admin"]) {
      const l = contactKindsFor({ role: r });
      expect(l.map((k) => k.kind)).toEqual(["client", "crm", "lead", "partner", "supplier", "employee", "directory", "google"]);
      expect(l.filter((k) => k.kind !== "google").every((k) => k.access === "national")).toBe(true);
    }
  });
  it("override por pessoa: dar Contactos a um condutor não lhe dá clientes", () => {
    const ov = { contactos: { access: "city", actions: ["view"] } };
    expect(kinds("condutor", ov)).toEqual(["directory", "google"]);
    expect(kinds("backoffice", { clientes: { access: "none", actions: [] } })).not.toContain("client");
  });
});

describe("Contactos — pesquisa: âmbito de cidade em todas as queries", () => {
  const dialect = new MySqlDialect();
  const porto = { all: false, defaultCityId: 50, cityName: "Porto", cityIds: [50], projectIds: [50, 65], missingCostCenter: false };
  let queries: { sql: string; params: unknown[] }[] = [];
  const fakeDb = {
    execute: async (q: any) => {
      const r = dialect.sqlToQuery(q);
      queries.push(r);
      if (r.sql.includes("FROM crm_contacts")) return [[{ id: 1, kind: "client", name: "Ana", email: "ana@x.pt", phoneE164: "+351912345678" }], []];
      return [[], []];
    },
  };
  beforeEach(() => { queries = []; invalidateClientsCache(); });

  it("\"todos\" sem pesquisa não consulta nada", async () => {
    const r = await cityScope.run(porto, () => searchContacts(fakeDb, { id: 9, role: "supervisor" }, { q: "a" }));
    expect(r.groups).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  it("todos os tipos filtram pela cidade; parâmetros (sem injeção); google só do próprio", async () => {
    const r = await cityScope.run(porto, () => searchContacts(fakeDb, { id: 9, role: "supervisor" }, { q: "x%' OR 1=1 --" }));
    expect(r.groups.map((g) => g.kind)).toEqual(["client", "crm", "lead", "partner", "supplier", "employee", "directory", "google"]);
    for (const q of queries) expect(q.sql).not.toContain("OR 1=1");
    const has = (frag: string) => queries.filter((q) => q.sql.includes(frag));
    for (const q of has("multipark_bookings b")) expect(q.sql).toContain("b.projectId IN");
    expect(has("FROM crm_contacts")[0].sql).toContain("c.projectId IN");
    expect(has("FROM extra_leads")[0].sql).toContain("l.projectId IS NULL OR l.projectId IN");
    expect(has("FROM partnerships p")[0].sql).toContain("city_operator");
    expect(has("FROM expenses e")[0].sql).toContain("e.projectId IN");
    expect(has("FROM employees e")[0].sql).toContain("e.projectId IN");
    const g = has("FROM google_user_contacts")[0];
    expect(g.sql).toContain("c.userId = ?");
    expect(g.params).toContain(9);
    expect(r.groups.find((x) => x.kind === "crm")?.items[0]).toMatchObject({ ref: "crm:1", name: "Ana" });
  });

  it("team leader: colaboradores só da equipa (papéis abaixo, sem conta ou o próprio)", async () => {
    await cityScope.run(porto, () => searchContacts(fakeDb, { id: 9, role: "team_leader" }, { q: "rui", kind: "employee" }));
    const q = queries.find((x) => x.sql.includes("FROM employees e"))!;
    expect(q.sql).toContain("u.role IN");
    expect(q.params).toEqual(expect.arrayContaining(["condutor", "extra", "user", 9]));
    expect(q.params).not.toContain("supervisor");
  });

  it("tipo sem acesso → recusado; papel sem módulo → recusado", async () => {
    await expect(cityScope.run(porto, () => searchContacts(fakeDb, { id: 9, role: "team_leader" }, { q: "rui", kind: "supplier" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(cityScope.run(porto, () => searchContacts(fakeDb, { id: 9, role: "condutor" }, { q: "rui" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(queries).toHaveLength(0);
  });

  it("páginas: um tipo pede limite+1 a partir do cursor", async () => {
    const r = await cityScope.run(porto, () => searchContacts(fakeDb, { id: 9, role: "backoffice" }, { kind: "directory", cursor: 30, limit: 30 }));
    const q = queries.find((x) => x.sql.includes("FROM google_directory_people"))!;
    expect(q.params.slice(-2)).toEqual([31, 30]);
    expect(r.groups[0]).toMatchObject({ kind: "directory", hasMore: false, nextCursor: null });
  });

  it("ficha: fora da cidade → não encontrado; reservas/reclamações/WhatsApp com âmbito", async () => {
    await expect(cityScope.run(porto, () => contactDetail(fakeDb, { id: 9, role: "supervisor" }, "partner", "3"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    queries = [];
    const d = await cityScope.run(porto, () => contactDetail(fakeDb, { id: 9, role: "supervisor" }, "crm", "1"));
    expect(d.phones).toEqual(["+351912345678"]);
    const bookings = queries.find((q) => q.sql.includes("ORDER BY b.checkIn DESC"))!;
    expect(bookings.sql).toContain("b.projectId IN");
    expect(bookings.params).toEqual(expect.arrayContaining(["ana@x.pt", "%912345678"]));
    expect(queries.find((q) => q.sql.includes("FROM complaints c"))!.sql).toContain("c.projectId IN");
    const wa = queries.find((q) => q.sql.includes("FROM whatsapp_conversations"))!;
    expect(wa.sql).toContain("bookingProjectId");
  });
});
