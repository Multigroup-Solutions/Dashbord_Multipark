/**
 * Contactos Google de UMA pessoa (funcionalidade "contacts", autorização
 * incremental) — motor sem BD nem rede (ContactsSyncStore + PeopleApiLike):
 *
 *  1. Ler (se a pessoa quer sugestões): "Outros contactos" e "Os meus
 *     contactos" com syncToken (resumível por pageToken; syncToken expirado →
 *     leitura completa). Guarda só nome + emails/telefones normalizados.
 *     Os contactos com a marca da app não são "contactos da pessoa": se não
 *     houver ligação na BD (ex.: a gravação falhou depois de criar), são
 *     adotados para a limpeza.
 *  2. Escrever os grupos da app ("Multipark — Serviço" / "Parceiros e
 *     fornecedores"): plano idempotente (shared/contacts.ts → planPushOps);
 *     apagar SÓ o que no Google ainda tem a marca desta pessoa/grupo
 *     (selectDeletable), criar em lotes de 200. Pedidos de escrita em série.
 *
 * Prazo: pára antes do fim (a corrida seguinte continua). Nunca regista o
 * conteúdo dos contactos — só contagens.
 */
import {
  PEOPLE_BATCH_CREATE_MAX, PEOPLE_BATCH_GET_MAX, PUSH_GROUP_NAMES, USER_CONTACTS_MAX, appMarkerOf, chunk, personEmails, personName, personPhones,
  planPushOps, pushContactBody, selectDeletable,
  type DesiredPushContact, type GoogleContactsPrefs, type PersonLike, type PushGroupKey, type PushMapping,
} from "../../shared/contacts";
import type { PeopleApiLike } from "./peopleApi";

export type ContactsSource = "other" | "connection";

export interface ContactsStateRow {
  otherSyncToken: string | null;
  otherPageToken: string | null;
  connSyncToken: string | null;
  connPageToken: string | null;
  serviceGroup: string | null;
  partnersGroup: string | null;
}

export interface UserContactRow { resourceName: string; source: ContactsSource; displayName: string; emails: string[]; phones: string[] }

export interface ContactsSyncStore {
  getState(userId: number): Promise<ContactsStateRow>;
  saveState(userId: number, patch: Partial<ContactsStateRow>): Promise<void>;
  countUserContacts(userId: number): Promise<number>;
  upsertUserContacts(userId: number, rows: readonly UserContactRow[]): Promise<void>;
  deleteUserContacts(userId: number, resourceNames: readonly string[]): Promise<void>;
  clearUserContacts(userId: number, source?: ContactsSource): Promise<void>;
  loadPushMappings(userId: number, group: PushGroupKey): Promise<PushMapping[]>;
  savePushMapping(userId: number, group: PushGroupKey, m: PushMapping): Promise<void>;
  extendPushMapping(userId: number, group: PushGroupKey, key: string, expiresAtMs: number | null): Promise<void>;
  forgetPushMappings(userId: number, group: PushGroupKey, keys: readonly string[]): Promise<void>;
  /** Ligação para um contacto com a marca da app mas sem linha na BD (adotado → limpeza). */
  adoptPushed(userId: number, group: PushGroupKey, resourceName: string, expiresAtMs: number | null): Promise<void>;
  /** resourceNames já ligados (qualquer grupo) — para não adotar duas vezes. */
  pushedResourceNames(userId: number): Promise<Set<string>>;
}

export interface PushGroupInput { group: PushGroupKey; enabled: boolean; desired: DesiredPushContact[] }

export interface ContactsSyncInput {
  userId: number;
  prefs: GoogleContactsPrefs;
  groups: PushGroupInput[];
  deadlineAt: number;
  now?: () => number;
}

export interface ContactsSyncResult {
  pulled: number;
  removed: number;
  adopted: number;
  created: number;
  deleted: number;
  forgotten: number;
  partial: boolean;
  rateLimited: boolean;
  warnings: string[];
}

const stateKeys = (source: ContactsSource) => (source === "other"
  ? { sync: "otherSyncToken", page: "otherPageToken" } as const
  : { sync: "connSyncToken", page: "connPageToken" } as const);

async function pullSource(api: PeopleApiLike, store: ContactsSyncStore, input: ContactsSyncInput, source: ContactsSource, res: ContactsSyncResult, known: Set<string>): Promise<boolean> {
  const now = input.now ?? Date.now;
  const keys = stateKeys(source);
  const st = await store.getState(input.userId);
  let syncToken = st[keys.sync];
  let pageToken = st[keys.page];
  let count = await store.countUserContacts(input.userId);
  for (let i = 0; i < 50; i++) {
    if (now() > input.deadlineAt - 4_000) return false;
    let page;
    try {
      page = source === "other"
        ? await api.listOtherContacts({ syncToken, pageToken })
        : await api.listConnections({ syncToken, pageToken });
    } catch (err: any) {
      if (!err?.syncTokenExpired) throw err;
      // syncToken expirado: recomeça do zero (o que existe é substituído pela leitura completa).
      await store.clearUserContacts(input.userId, source);
      await store.saveState(input.userId, { [keys.sync]: null, [keys.page]: null } as Partial<ContactsStateRow>);
      syncToken = null;
      pageToken = null;
      count = await store.countUserContacts(input.userId);
      continue;
    }
    const upserts: UserContactRow[] = [];
    const removed: string[] = [];
    for (const p of page.people as PersonLike[]) {
      const rn = String(p.resourceName ?? "");
      if (!rn) continue;
      if (p.metadata?.deleted) { removed.push(rn); continue; }
      const mark = appMarkerOf(p);
      if (mark) {
        // Criado pela app: não é "contacto da pessoa". Sem ligação → adota (para a limpeza).
        if (mark.userId === input.userId && !known.has(rn)) {
          await store.adoptPushed(input.userId, mark.group, rn, mark.expiresAtMs);
          known.add(rn);
          res.adopted++;
        }
        removed.push(rn);
        continue;
      }
      const emails = personEmails(p);
      const phones = personPhones(p);
      if (!emails.length && !phones.length) continue;
      if (count >= USER_CONTACTS_MAX) continue;
      upserts.push({ resourceName: rn, source, displayName: personName(p), emails: emails.slice(0, 10), phones: phones.slice(0, 10) });
      count++;
    }
    if (removed.length) { await store.deleteUserContacts(input.userId, removed); res.removed += removed.length; }
    if (upserts.length) { await store.upsertUserContacts(input.userId, upserts); res.pulled += upserts.length; }
    if (page.nextPageToken) {
      pageToken = page.nextPageToken;
      await store.saveState(input.userId, { [keys.page]: pageToken } as Partial<ContactsStateRow>);
      continue;
    }
    await store.saveState(input.userId, { [keys.page]: null, [keys.sync]: page.nextSyncToken ?? syncToken ?? null } as Partial<ContactsStateRow>);
    if (count >= USER_CONTACTS_MAX) res.warnings.push(`Só os primeiros ${USER_CONTACTS_MAX} contactos Google são usados nas sugestões.`);
    return true;
  }
  return false;
}

async function ensureGroup(api: PeopleApiLike, store: ContactsSyncStore, userId: number, group: PushGroupKey): Promise<string> {
  const st = await store.getState(userId);
  const field = group === "service" ? "serviceGroup" : "partnersGroup";
  if (st[field]) return st[field]!;
  const name = PUSH_GROUP_NAMES[group];
  const existing = (await api.listContactGroups()).find((g) => g.name === name && g.groupType !== "SYSTEM_CONTACT_GROUP");
  const resourceName = existing?.resourceName ?? (await api.createContactGroup(name)).resourceName;
  await store.saveState(userId, { [field]: resourceName } as Partial<ContactsStateRow>);
  return resourceName;
}

async function pushGroup(api: PeopleApiLike, store: ContactsSyncStore, input: ContactsSyncInput, g: PushGroupInput, res: ContactsSyncResult): Promise<boolean> {
  const now = input.now ?? Date.now;
  const mappings = await store.loadPushMappings(input.userId, g.group);
  const plan = planPushOps(g.desired, mappings, now(), { enabled: g.enabled });
  // 1) Limpeza primeiro (retenção / desligado): só o que ainda tem a marca da app.
  for (const part of chunk(plan.delete, PEOPLE_BATCH_GET_MAX)) {
    if (now() > input.deadlineAt - 3_000) return false;
    const remote = await api.getPeople(part.map((m) => m.resourceName));
    const sel = selectDeletable(part, remote, input.userId, g.group);
    if (sel.delete.length) await api.batchDeleteContacts(sel.delete.map((m) => m.resourceName));
    const gone = [...sel.delete, ...sel.forget].map((m) => m.key);
    if (gone.length) await store.forgetPushMappings(input.userId, g.group, gone);
    res.deleted += sel.delete.length;
    res.forgotten += sel.forget.length;
  }
  // 2) Retenção prolongada (só BD).
  for (const e of plan.extend) await store.extendPushMapping(input.userId, g.group, e.key, e.expiresAtMs);
  // 3) Criar em lotes.
  if (!plan.create.length) return true;
  const groupRes = await ensureGroup(api, store, input.userId, g.group);
  for (const part of chunk(plan.create, PEOPLE_BATCH_CREATE_MAX)) {
    if (now() > input.deadlineAt - 4_000) return false;
    let names: Array<string | null>;
    try {
      names = await api.batchCreateContacts(part.map((c) => pushContactBody(c, input.userId, groupRes) as any));
    } catch (err: any) {
      // O grupo foi apagado pela pessoa no Google → recria na próxima corrida.
      const msg = String(err?.message ?? "");
      if (/contactGroup|contact group/i.test(msg) && [400, 404].includes(Number(err?.response?.status ?? err?.status ?? 0))) {
        await store.saveState(input.userId, { [g.group === "service" ? "serviceGroup" : "partnersGroup"]: null } as Partial<ContactsStateRow>);
        res.warnings.push(`O grupo "${PUSH_GROUP_NAMES[g.group]}" já não existia — é recriado na próxima sincronização.`);
        return false;
      }
      throw err;
    }
    for (let i = 0; i < part.length; i++) {
      const rn = names[i];
      if (!rn) continue;
      await store.savePushMapping(input.userId, g.group, { key: part[i].key, resourceName: rn, hash: part[i].hash, expiresAtMs: part[i].expiresAtMs });
      res.created++;
    }
  }
  return true;
}

/** Uma corrida da pessoa: ler (sugestões) e escrever os grupos. */
export async function syncUserContacts(api: PeopleApiLike, store: ContactsSyncStore, input: ContactsSyncInput): Promise<ContactsSyncResult> {
  const res: ContactsSyncResult = { pulled: 0, removed: 0, adopted: 0, created: 0, deleted: 0, forgotten: 0, partial: false, rateLimited: false, warnings: [] };
  try {
    // Escrever primeiro: é o que a pessoa vê no telemóvel (e a limpeza da retenção).
    for (const g of input.groups) {
      if (!(await pushGroup(api, store, input, g, res))) { res.partial = true; return res; }
    }
    if (input.prefs.suggestions) {
      const known = await store.pushedResourceNames(input.userId);
      for (const source of ["other", "connection"] as const) {
        if (!(await pullSource(api, store, input, source, res, known))) { res.partial = true; return res; }
      }
    } else {
      // Sem sugestões: não se guarda nada dos contactos da pessoa.
      await store.clearUserContacts(input.userId);
      await store.saveState(input.userId, { otherSyncToken: null, otherPageToken: null, connSyncToken: null, connPageToken: null });
    }
    return res;
  } catch (err: any) {
    if (err?.rateLimited) { res.rateLimited = true; res.partial = true; return res; }
    throw err;
  }
}
