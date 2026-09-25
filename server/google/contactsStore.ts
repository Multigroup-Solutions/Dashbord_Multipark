/**
 * BD dos Contactos Google (migração 0155). SQL sempre parametrizado; lista
 * fechada de colunas nos UPDATE dinâmicos. Nunca regista dados pessoais.
 */
import { sql, type SQL } from "drizzle-orm";
import { toSqlUtc } from "../../shared/googleSync";
import { parseGoogleContactsPrefs, type DirectoryPersonRow, type GoogleContactsPrefs, type PushGroupKey, type PushMapping } from "../../shared/contacts";
import { affected, db, inList, nowSql, rowsOf } from "./syncStore";
import type { DirectoryState, DirectoryStore } from "./directorySync";
import type { ContactsStateRow, ContactsSyncStore, UserContactRow } from "./contactsSync";

// ─── Diretório ──────────────────────────────────────────────────────────────

const DIR_STATE_COLUMNS = ["pageToken", "runStartedMs", "lastFullSyncAt", "lastRunAt", "lastError", "peopleCount", "lockAt"] as const;

export async function getDirectoryState(): Promise<DirectoryState & { lastRunAt: string | null; lastError: string | null; peopleCount: number }> {
  const d = await db();
  await d.execute(sql`INSERT IGNORE INTO google_directory_state (id) VALUES (1)`);
  const r = rowsOf(await d.execute(sql`SELECT * FROM google_directory_state WHERE id = 1 LIMIT 1`))[0] ?? {};
  return {
    pageToken: r.pageToken ?? null, runStartedMs: r.runStartedMs == null ? null : Number(r.runStartedMs),
    lastFullSyncAt: r.lastFullSyncAt ? String(r.lastFullSyncAt) : null, lastRunAt: r.lastRunAt ? String(r.lastRunAt) : null,
    lastError: r.lastError ?? null, peopleCount: Number(r.peopleCount ?? 0),
  };
}

export async function patchDirectoryState(patch: Record<string, unknown>): Promise<void> {
  const sets: SQL[] = [];
  for (const k of DIR_STATE_COLUMNS) {
    if (!(k in patch)) continue;
    const v = patch[k];
    sets.push(sql`${sql.identifier(k)} = ${v == null ? null : typeof v === "number" ? v : String(v).slice(0, k === "pageToken" ? 1024 : 500)}`);
  }
  if (!sets.length) return;
  const d = await db();
  await d.execute(sql`INSERT IGNORE INTO google_directory_state (id) VALUES (1)`);
  await d.execute(sql`UPDATE google_directory_state SET ${sql.join(sets, sql`, `)} WHERE id = 1`);
}

export async function claimDirectoryLock(staleSeconds = 90): Promise<boolean> {
  const d = await db();
  await d.execute(sql`INSERT IGNORE INTO google_directory_state (id) VALUES (1)`);
  const res = await d.execute(sql`UPDATE google_directory_state SET lockAt = ${nowSql()} WHERE id = 1 AND (lockAt IS NULL OR lockAt < ${toSqlUtc(Date.now() - staleSeconds * 1000)})`);
  return affected(res) === 1;
}
export async function releaseDirectoryLock(): Promise<void> {
  const d = await db();
  await d.execute(sql`UPDATE google_directory_state SET lockAt = NULL WHERE id = 1`);
}

export const dbDirectoryStore: DirectoryStore = {
  getState: getDirectoryState,
  saveState: (patch) => patchDirectoryState(patch as Record<string, unknown>),
  async upsertPeople(rows: readonly DirectoryPersonRow[], runMs: number) {
    const d = await db();
    for (let i = 0; i < rows.length; i += 200) {
      const part = rows.slice(i, i + 200);
      const values = part.map((r) => sql`(${r.resourceName}, ${r.primaryEmail}, ${JSON.stringify(r.emails).slice(0, 2000)}, ${r.displayName}, ${r.givenName}, ${r.familyName},
        ${r.jobTitle}, ${r.department}, ${r.phoneE164}, ${r.phoneRaw}, ${r.photoUrl}, ${runMs}, NULL)`);
      await d.execute(sql`INSERT INTO google_directory_people (resourceName, primaryEmail, emailsJson, displayName, givenName, familyName,
          jobTitle, department, phoneE164, phoneRaw, photoUrl, seenRunAt, deletedAt)
        VALUES ${sql.join(values, sql`, `)}
        ON DUPLICATE KEY UPDATE primaryEmail = VALUES(primaryEmail), emailsJson = VALUES(emailsJson), displayName = VALUES(displayName),
          givenName = VALUES(givenName), familyName = VALUES(familyName), jobTitle = VALUES(jobTitle), department = VALUES(department),
          phoneE164 = VALUES(phoneE164), phoneRaw = VALUES(phoneRaw), photoUrl = VALUES(photoUrl), seenRunAt = VALUES(seenRunAt), deletedAt = NULL`);
    }
  },
  async finishRun(runMs: number) {
    const d = await db();
    await d.execute(sql`UPDATE google_directory_people SET deletedAt = ${nowSql()} WHERE deletedAt IS NULL AND (seenRunAt IS NULL OR seenRunAt < ${runMs})`);
    // Ligação às contas e às fichas pelo email (principal ou um dos alternativos).
    await d.execute(sql`UPDATE google_directory_people d SET
        userId = (SELECT u.id FROM users u WHERE u.email IS NOT NULL AND (LOWER(TRIM(u.email)) = d.primaryEmail
          OR (JSON_VALID(d.emailsJson) AND JSON_CONTAINS(d.emailsJson, JSON_QUOTE(LOWER(TRIM(u.email))))))
          ORDER BY (LOWER(TRIM(u.email)) = d.primaryEmail) DESC, u.isActive DESC, u.id LIMIT 1),
        employeeId = (SELECT e.id FROM employees e WHERE e.email IS NOT NULL AND (LOWER(TRIM(e.email)) = d.primaryEmail
          OR (JSON_VALID(d.emailsJson) AND JSON_CONTAINS(d.emailsJson, JSON_QUOTE(LOWER(TRIM(e.email))))))
          ORDER BY (LOWER(TRIM(e.email)) = d.primaryEmail) DESC, e.isActive DESC, e.id DESC LIMIT 1)
      WHERE d.deletedAt IS NULL`);
    const r = rowsOf(await d.execute(sql`SELECT COUNT(*) AS n FROM google_directory_people WHERE deletedAt IS NULL`))[0];
    return Number(r?.n ?? 0);
  },
};

// ─── Estado por pessoa ──────────────────────────────────────────────────────

const STATE_COLUMNS = ["prefsJson", "otherSyncToken", "otherPageToken", "connSyncToken", "connPageToken", "serviceGroup", "partnersGroup",
  "lastPullAt", "lastPushAt", "lastRunAt", "lastStatus", "lastError", "lastWarning", "lockAt"] as const;
type StateColumn = (typeof STATE_COLUMNS)[number];
const LONG = new Set<StateColumn>(["otherSyncToken", "otherPageToken", "connSyncToken", "connPageToken"]);

export interface ContactsStateFull extends ContactsStateRow {
  prefs: GoogleContactsPrefs;
  lastPullAt: string | null; lastPushAt: string | null; lastRunAt: string | null;
  lastStatus: string | null; lastError: string | null; lastWarning: string | null;
}

export async function getContactsState(userId: number): Promise<ContactsStateFull> {
  const d = await db();
  const r = rowsOf(await d.execute(sql`SELECT * FROM google_contacts_state WHERE userId = ${userId} LIMIT 1`))[0] ?? {};
  const s = (k: string) => (r[k] == null ? null : String(r[k]));
  return {
    prefs: parseGoogleContactsPrefs(r.prefsJson ?? null),
    otherSyncToken: s("otherSyncToken"), otherPageToken: s("otherPageToken"), connSyncToken: s("connSyncToken"), connPageToken: s("connPageToken"),
    serviceGroup: s("serviceGroup"), partnersGroup: s("partnersGroup"), lastPullAt: s("lastPullAt"), lastPushAt: s("lastPushAt"),
    lastRunAt: s("lastRunAt"), lastStatus: s("lastStatus"), lastError: s("lastError"), lastWarning: s("lastWarning"),
  };
}

export async function patchContactsState(userId: number, patch: Partial<Record<StateColumn, string | null>>): Promise<void> {
  const sets: SQL[] = [];
  for (const k of STATE_COLUMNS) {
    if (!(k in patch)) continue;
    const v = patch[k] ?? null;
    sets.push(sql`${sql.identifier(k)} = ${v == null ? null : String(v).slice(0, k === "prefsJson" ? 4000 : LONG.has(k) ? 1024 : 500)}`);
  }
  if (!sets.length) return;
  const d = await db();
  await d.execute(sql`INSERT IGNORE INTO google_contacts_state (userId) VALUES (${userId})`);
  await d.execute(sql`UPDATE google_contacts_state SET ${sql.join(sets, sql`, `)} WHERE userId = ${userId}`);
}

export async function claimContactsLock(userId: number, staleSeconds = 90): Promise<boolean> {
  const d = await db();
  await d.execute(sql`INSERT IGNORE INTO google_contacts_state (userId) VALUES (${userId})`);
  const res = await d.execute(sql`UPDATE google_contacts_state SET lockAt = ${nowSql()} WHERE userId = ${userId} AND (lockAt IS NULL OR lockAt < ${toSqlUtc(Date.now() - staleSeconds * 1000)})`);
  return affected(res) === 1;
}
export async function releaseContactsLock(userId: number): Promise<void> {
  const d = await db();
  await d.execute(sql`UPDATE google_contacts_state SET lockAt = NULL WHERE userId = ${userId}`);
}

/** Apaga tudo o que se guardou dos contactos Google da pessoa (desligar / sem sugestões). */
export async function purgeUserContacts(userId: number): Promise<void> {
  const d = await db();
  await d.execute(sql`DELETE FROM google_user_contacts WHERE userId = ${userId}`);
  await d.execute(sql`UPDATE google_contacts_state SET otherSyncToken = NULL, otherPageToken = NULL, connSyncToken = NULL, connPageToken = NULL WHERE userId = ${userId}`);
}

const toMapping = (r: any): PushMapping => ({
  key: String(r.sourceKey), resourceName: String(r.resourceName), hash: r.hash ?? null, expiresAtMs: r.expiresAt == null ? null : Number(r.expiresAt),
});

export const dbContactsStore: ContactsSyncStore = {
  async getState(userId) { return getContactsState(userId); },
  async saveState(userId, patch) { await patchContactsState(userId, patch as any); },
  async countUserContacts(userId) {
    const d = await db();
    return Number(rowsOf(await d.execute(sql`SELECT COUNT(*) AS n FROM google_user_contacts WHERE userId = ${userId}`))[0]?.n ?? 0);
  },
  async upsertUserContacts(userId, rows: readonly UserContactRow[]) {
    const d = await db();
    for (let i = 0; i < rows.length; i += 200) {
      const part = rows.slice(i, i + 200);
      const values = part.map((r) => sql`(${userId}, ${r.resourceName.slice(0, 128)}, ${r.source}, ${r.displayName.slice(0, 255) || null},
        ${JSON.stringify(r.emails).slice(0, 2000)}, ${JSON.stringify(r.phones).slice(0, 500)}, ${r.emails[0] ?? null}, ${r.phones[0] ?? null})`);
      await d.execute(sql`INSERT INTO google_user_contacts (userId, resourceName, source, displayName, emailsJson, phonesJson, primaryEmail, primaryPhone)
        VALUES ${sql.join(values, sql`, `)}
        ON DUPLICATE KEY UPDATE source = VALUES(source), displayName = VALUES(displayName), emailsJson = VALUES(emailsJson), phonesJson = VALUES(phonesJson),
          primaryEmail = VALUES(primaryEmail), primaryPhone = VALUES(primaryPhone)`);
    }
  },
  async deleteUserContacts(userId, resourceNames) {
    if (!resourceNames.length) return;
    const d = await db();
    for (let i = 0; i < resourceNames.length; i += 500) {
      await d.execute(sql`DELETE FROM google_user_contacts WHERE userId = ${userId} AND resourceName IN (${inList(resourceNames.slice(i, i + 500))})`);
    }
  },
  async clearUserContacts(userId, source) {
    const d = await db();
    await d.execute(source ? sql`DELETE FROM google_user_contacts WHERE userId = ${userId} AND source = ${source}` : sql`DELETE FROM google_user_contacts WHERE userId = ${userId}`);
  },
  async loadPushMappings(userId, group) {
    const d = await db();
    return rowsOf(await d.execute(sql`SELECT sourceKey, resourceName, hash, expiresAt FROM google_pushed_contacts WHERE userId = ${userId} AND groupKey = ${group} LIMIT 5000`)).map(toMapping);
  },
  async savePushMapping(userId, group, m) {
    const d = await db();
    await d.execute(sql`INSERT INTO google_pushed_contacts (userId, groupKey, sourceKey, resourceName, hash, expiresAt)
      VALUES (${userId}, ${group}, ${m.key.slice(0, 64)}, ${m.resourceName.slice(0, 128)}, ${m.hash}, ${m.expiresAtMs})
      ON DUPLICATE KEY UPDATE resourceName = VALUES(resourceName), hash = VALUES(hash), expiresAt = VALUES(expiresAt)`);
  },
  async extendPushMapping(userId, group, key, expiresAtMs) {
    const d = await db();
    await d.execute(sql`UPDATE google_pushed_contacts SET expiresAt = ${expiresAtMs} WHERE userId = ${userId} AND groupKey = ${group} AND sourceKey = ${key.slice(0, 64)}`);
  },
  async forgetPushMappings(userId, group, keys) {
    if (!keys.length) return;
    const d = await db();
    for (let i = 0; i < keys.length; i += 500) {
      await d.execute(sql`DELETE FROM google_pushed_contacts WHERE userId = ${userId} AND groupKey = ${group} AND sourceKey IN (${inList(keys.slice(i, i + 500))})`);
    }
  },
  async adoptPushed(userId, group: PushGroupKey, resourceName, expiresAtMs) {
    const d = await db();
    // Chave própria (não se sabe o telefone de origem): apagada quando a retenção acabar.
    await d.execute(sql`INSERT IGNORE INTO google_pushed_contacts (userId, groupKey, sourceKey, resourceName, hash, expiresAt)
      VALUES (${userId}, ${group}, ${`adotado:${resourceName}`.slice(0, 64)}, ${resourceName.slice(0, 128)}, NULL, ${expiresAtMs ?? 0})`);
  },
  async pushedResourceNames(userId) {
    const d = await db();
    return new Set(rowsOf(await d.execute(sql`SELECT resourceName FROM google_pushed_contacts WHERE userId = ${userId} LIMIT 10000`)).map((r) => String(r.resourceName)));
  },
};
