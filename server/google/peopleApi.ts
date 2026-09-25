/**
 * Adaptador da API OFICIAL Google People (@googleapis/people v1) para o que
 * os Contactos usam — sempre com prazo (timedFetch) e com repetição com
 * espera exponencial nos limites de pedidos (withGoogleRetry), só enquanto
 * o prazo da corrida o permitir. Os pedidos de escrita da mesma pessoa vão
 * sempre em série (recomendação da Google).
 *
 * Os motores (directorySync.ts, contactsSync.ts) só conhecem `PeopleApiLike`
 * — os testes usam implementações falsas. Nunca se regista o conteúdo dos
 * contactos (PII): só contagens.
 */
import type { JWT, OAuth2Client } from "google-auth-library";
import { people as peopleFactory, type people_v1 } from "@googleapis/people";
import { GOOGLE_API_TIMEOUT_MS, httpStatusOf, timedFetch } from "./workspace";
import { withGoogleRetry, type RetryOptions } from "./apis";
import {
  CONNECTIONS_PERSON_FIELDS, DIRECTORY_READ_MASK, DIRECTORY_SOURCE, OTHER_CONTACTS_READ_MASK, PEOPLE_BATCH_CREATE_MAX, PEOPLE_BATCH_DELETE_MAX,
  PEOPLE_BATCH_GET_MAX, type PersonLike,
} from "../../shared/contacts";

export interface PeoplePage { people: PersonLike[]; nextPageToken: string | null; nextSyncToken: string | null }

export interface PeopleApiLike {
  /** Diretório do domínio (perfis). */
  listDirectory(p: { pageToken?: string | null; pageSize?: number }): Promise<PeoplePage>;
  /** Contactos da pessoa ("Os meus contactos"), com syncToken. */
  listConnections(p: { pageToken?: string | null; syncToken?: string | null }): Promise<PeoplePage>;
  /** "Outros contactos" (quem já trocou emails), com syncToken. */
  listOtherContacts(p: { pageToken?: string | null; syncToken?: string | null }): Promise<PeoplePage>;
  listContactGroups(): Promise<Array<{ resourceName: string; name: string; groupType: string | null }>>;
  createContactGroup(name: string): Promise<{ resourceName: string }>;
  /** Cria (≤ 200) e devolve os resourceNames pela mesma ordem (null = falhou). */
  batchCreateContacts(persons: people_v1.Schema$Person[]): Promise<Array<string | null>>;
  /** Apaga (≤ 500). */
  batchDeleteContacts(resourceNames: string[]): Promise<void>;
  /** Lê (≤ 200) com clientData — null para os que já não existem. */
  getPeople(resourceNames: string[]): Promise<Map<string, PersonLike | null>>;
}

export function peopleFor(auth: OAuth2Client | JWT): people_v1.People {
  return peopleFactory({ version: "v1", auth, timeout: GOOGLE_API_TIMEOUT_MS, fetchImplementation: timedFetch() } as any);
}

/** O syncToken expirou (7 dias) → recomeçar a leitura completa. PURA. */
export function isExpiredSyncTokenError(err: unknown): boolean {
  const e = err as any;
  const status = httpStatusOf(err);
  let data = "";
  try { data = JSON.stringify(e?.response?.data ?? ""); } catch { data = ""; }
  const msg = `${data} ${String(e?.message ?? "")}`;
  return status === 410 || ((status === 400 || status === 412) && /EXPIRED_SYNC_TOKEN|sync token.*expired|Sync token is expired/i.test(msg));
}

export class SyncTokenExpiredError extends Error {
  syncTokenExpired = true;
  constructor() { super("O syncToken dos contactos expirou — leitura completa na próxima corrida."); }
}

const asPerson = (p: people_v1.Schema$Person): PersonLike => p as unknown as PersonLike;

export function wrapPeople(api: people_v1.People, retry: RetryOptions): PeopleApiLike {
  const r = <T>(fn: () => Promise<T>) => withGoogleRetry(fn, retry);
  const syncAware = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await r(fn); }
    catch (err) { if (isExpiredSyncTokenError(err)) throw new SyncTokenExpiredError(); throw err; }
  };
  return {
    async listDirectory(p) {
      const res = await r(() => api.people.listDirectoryPeople({
        sources: [DIRECTORY_SOURCE], readMask: DIRECTORY_READ_MASK, pageSize: Math.min(1000, p.pageSize ?? 500),
        ...(p.pageToken ? { pageToken: p.pageToken } : {}),
      }));
      return { people: (res.data.people ?? []).map(asPerson), nextPageToken: res.data.nextPageToken ?? null, nextSyncToken: res.data.nextSyncToken ?? null };
    },
    async listConnections(p) {
      const res = await syncAware(() => api.people.connections.list({
        resourceName: "people/me", personFields: CONNECTIONS_PERSON_FIELDS, pageSize: 1000, requestSyncToken: true,
        ...(p.syncToken ? { syncToken: p.syncToken } : {}), ...(p.pageToken ? { pageToken: p.pageToken } : {}),
      }));
      return { people: (res.data.connections ?? []).map(asPerson), nextPageToken: res.data.nextPageToken ?? null, nextSyncToken: res.data.nextSyncToken ?? null };
    },
    async listOtherContacts(p) {
      const res = await syncAware(() => api.otherContacts.list({
        readMask: OTHER_CONTACTS_READ_MASK, pageSize: 1000, requestSyncToken: true,
        ...(p.syncToken ? { syncToken: p.syncToken } : {}), ...(p.pageToken ? { pageToken: p.pageToken } : {}),
      }));
      return { people: (res.data.otherContacts ?? []).map(asPerson), nextPageToken: res.data.nextPageToken ?? null, nextSyncToken: res.data.nextSyncToken ?? null };
    },
    async listContactGroups() {
      const out: Array<{ resourceName: string; name: string; groupType: string | null }> = [];
      let pageToken: string | undefined;
      for (let i = 0; i < 10; i++) {
        const res = await r(() => api.contactGroups.list({ pageSize: 1000, groupFields: "name,groupType", ...(pageToken ? { pageToken } : {}) }));
        for (const g of res.data.contactGroups ?? []) if (g.resourceName) out.push({ resourceName: g.resourceName, name: String(g.name ?? ""), groupType: g.groupType ?? null });
        pageToken = res.data.nextPageToken ?? undefined;
        if (!pageToken) break;
      }
      return out;
    },
    async createContactGroup(name) {
      const res = await r(() => api.contactGroups.create({ requestBody: { contactGroup: { name } } }));
      return { resourceName: String(res.data.resourceName) };
    },
    async batchCreateContacts(persons) {
      if (!persons.length) return [];
      if (persons.length > PEOPLE_BATCH_CREATE_MAX) throw new Error(`No máximo ${PEOPLE_BATCH_CREATE_MAX} contactos por pedido.`);
      const res = await r(() => api.people.batchCreateContacts({
        requestBody: { contacts: persons.map((contactPerson) => ({ contactPerson })), readMask: "clientData,metadata" },
      }));
      // A resposta vem pela mesma ordem do pedido.
      const created = res.data.createdPeople ?? [];
      return persons.map((_, i) => {
        const c = created[i];
        const ok = !c?.status?.code;
        return ok && c?.person?.resourceName ? String(c.person.resourceName) : null;
      });
    },
    async batchDeleteContacts(resourceNames) {
      if (!resourceNames.length) return;
      if (resourceNames.length > PEOPLE_BATCH_DELETE_MAX) throw new Error(`No máximo ${PEOPLE_BATCH_DELETE_MAX} contactos por pedido.`);
      await r(() => api.people.batchDeleteContacts({ requestBody: { resourceNames } }));
    },
    async getPeople(resourceNames) {
      const out = new Map<string, PersonLike | null>();
      if (!resourceNames.length) return out;
      if (resourceNames.length > PEOPLE_BATCH_GET_MAX) throw new Error(`No máximo ${PEOPLE_BATCH_GET_MAX} contactos por pedido.`);
      const res = await r(() => api.people.getBatchGet({ resourceNames, personFields: "clientData,metadata" }));
      for (const x of res.data.responses ?? []) {
        const name = String(x.requestedResourceName ?? x.person?.resourceName ?? "");
        if (!name) continue;
        out.set(name, x.person && !x.status?.code ? asPerson(x.person) : null);
      }
      for (const n of resourceNames) if (!out.has(n)) out.set(n, null);
      return out;
    },
  };
}
