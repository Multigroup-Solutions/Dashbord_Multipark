/**
 * CRM — alterações à ficha. Tudo fica no registo de ações da plataforma
 * (activity_logs, entity "crm_client"), com quem, quando e o antes → depois.
 */
import { sql } from "drizzle-orm";
import { emailKey, nifKey, phoneKey, plateKey } from "../../shared/crmIdentity";
import { countryFromPhone } from "../../shared/crmGeo";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const insertId = (res: any) => Number((Array.isArray(res) ? res[0] : res)?.insertId ?? 0);

export async function logCrm(userId: number, clientId: number | null, action: string, details: unknown) {
  const { logActivity } = await import("../db");
  await logActivity({ userId, action: action.slice(0, 64), entity: "crm_client", entityId: clientId ?? undefined, details: JSON.stringify(details).slice(0, 60_000) } as any);
}

/** Campos que a ficha deixa editar (o resto vem das reservas ou é calculado). */
export const EDITABLE = [
  "displayName", "firstName", "lastName", "kind", "nif", "taxName", "taxAddress", "address", "zone", "gender", "ageBand",
  "birthDate", "language", "isPro", "proDiscount", "consentEmail", "consentWhatsapp", "consentSms", "notes", "originChannel",
] as const;
export type EditableField = (typeof EDITABLE)[number];

export async function updateClient(db: any, userId: number, id: number, patch: Partial<Record<EditableField, unknown>> & { tags?: string[] }) {
  const [before] = rowsOf(await db.execute(sql`SELECT * FROM crm_clients WHERE id = ${id} AND status = 'active'`));
  if (!before) throw new Error("Ficha não encontrada.");
  const sets: any[] = [];
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of EDITABLE) {
    if (!(k in patch)) continue;
    let v: unknown = (patch as any)[k];
    if (k === "nif") v = v ? nifKey(String(v)) || String(v).trim().slice(0, 16) : null;
    if (k === "isPro" || k === "consentEmail" || k === "consentWhatsapp" || k === "consentSms") v = v == null ? null : v ? 1 : 0;
    if (typeof v === "string") v = v.trim() === "" ? null : v.trim();
    const old = before[k] instanceof Date ? before[k].toISOString().slice(0, 10) : before[k];
    if (String(old ?? "") === String(v ?? "")) continue;
    changes[k] = { from: old ?? null, to: v ?? null };
    sets.push(sql`${sql.raw("`" + k + "`")} = ${v as any}`);
  }
  if (patch.tags) {
    const json = JSON.stringify([...new Set(patch.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 40));
    if (json !== (before.tagsJson ?? "[]")) { changes.tags = { from: before.tagsJson ?? null, to: json }; sets.push(sql`tagsJson = ${json}`); }
  }
  if (!sets.length) return { changed: 0 };
  // Pro decidido à mão: a carga das reservas deixa de o mudar
  if (changes.isPro) sets.push(sql`proManual = 1`);
  await db.execute(sql`UPDATE crm_clients SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`);
  await logCrm(userId, id, "crm_client_update", changes);
  return { changed: Object.keys(changes).length };
}

export async function createClient(db: any, userId: number, o: { displayName: string; kind?: "person" | "company"; email?: string | null; phone?: string | null; nif?: string | null }) {
  const email = o.email ? emailKey(o.email) : "";
  const phone = o.phone ? phoneKey(o.phone) : "";
  const res = await db.execute(sql`INSERT INTO crm_clients (kind, source, displayName, primaryEmail, primaryPhone, nif, country, noEmail, lastSeenAt)
    VALUES (${o.kind ?? "person"}, 'manual', ${o.displayName.trim().slice(0, 255)}, ${email || null}, ${phone || null}, ${o.nif ? nifKey(o.nif) || null : null},
      ${countryFromPhone(phone)}, ${email ? 0 : 1}, UTC_TIMESTAMP())`);
  const id = insertId(res);
  if (email) await db.execute(sql`INSERT IGNORE INTO crm_client_emails (clientId, email, isPrimary, source, firstSeenAt, lastSeenAt) VALUES (${id}, ${email}, 1, 'manual', UTC_TIMESTAMP(), UTC_TIMESTAMP())`);
  if (phone) await db.execute(sql`INSERT IGNORE INTO crm_client_phones (clientId, phone, isPrimary, source, firstSeenAt, lastSeenAt) VALUES (${id}, ${phone}, 1, 'manual', UTC_TIMESTAMP(), UTC_TIMESTAMP())`);
  await logCrm(userId, id, "crm_client_create", { displayName: o.displayName, kind: o.kind ?? "person" });
  return { id };
}

// ─── Emails / telefones ─────────────────────────────────────────────────────

/** Retirado à mão → a carga das reservas não o volta a pôr nesta ficha. */
async function block(db: any, userId: number, clientId: number, kind: "email" | "phone" | "plate", value: string) {
  await db.execute(sql`INSERT IGNORE INTO crm_blocked_identifiers (clientId, kind, value, blockedBy) VALUES (${clientId}, ${kind}, ${value}, ${userId})`);
}
/** Acrescentado à mão → deixa de estar bloqueado. */
async function unblock(db: any, clientId: number, kind: "email" | "phone" | "plate", value: string) {
  await db.execute(sql`DELETE FROM crm_blocked_identifiers WHERE clientId = ${clientId} AND kind = ${kind} AND value = ${value}`);
}

async function refreshPrimary(db: any, clientId: number) {
  await db.execute(sql`UPDATE crm_clients c SET
    primaryEmail = (SELECT e.email FROM crm_client_emails e WHERE e.clientId = c.id AND e.generic = 0 ORDER BY e.isPrimary DESC, e.lastSeenAt DESC LIMIT 1),
    primaryPhone = (SELECT p.phone FROM crm_client_phones p WHERE p.clientId = c.id ORDER BY p.isPrimary DESC, p.lastSeenAt DESC LIMIT 1),
    noEmail = NOT EXISTS (SELECT 1 FROM crm_client_emails e WHERE e.clientId = c.id AND e.generic = 0),
    genericEmailOnly = NOT EXISTS (SELECT 1 FROM crm_client_emails e WHERE e.clientId = c.id AND e.generic = 0)
      AND EXISTS (SELECT 1 FROM crm_client_emails e WHERE e.clientId = c.id AND e.generic = 1)
    WHERE c.id = ${clientId}`);
}

export async function addEmail(db: any, userId: number, clientId: number, raw: string, primary = false) {
  const email = emailKey(raw);
  if (!email) throw new Error("Email inválido.");
  if (primary) await db.execute(sql`UPDATE crm_client_emails SET isPrimary = 0 WHERE clientId = ${clientId}`);
  await db.execute(sql`INSERT INTO crm_client_emails (clientId, email, isPrimary, verified, source, firstSeenAt, lastSeenAt)
    VALUES (${clientId}, ${email}, ${primary ? 1 : 0}, 1, 'manual', UTC_TIMESTAMP(), UTC_TIMESTAMP())
    ON DUPLICATE KEY UPDATE isPrimary = GREATEST(isPrimary, VALUES(isPrimary)), generic = 0, verified = 1`);
  await unblock(db, clientId, "email", email);
  await refreshPrimary(db, clientId);
  await logCrm(userId, clientId, "crm_email_add", { email, primary });
}

export async function removeEmail(db: any, userId: number, clientId: number, emailId: number, reason?: string | null) {
  const [e] = rowsOf(await db.execute(sql`SELECT email FROM crm_client_emails WHERE id = ${emailId} AND clientId = ${clientId}`));
  if (!e) throw new Error("Email não encontrado.");
  await db.execute(sql`DELETE FROM crm_client_emails WHERE id = ${emailId} AND clientId = ${clientId}`);
  await block(db, userId, clientId, "email", String(e.email));
  await refreshPrimary(db, clientId);
  await logCrm(userId, clientId, "crm_email_remove", { email: e.email, reason: reason ?? null });
}

export async function setPrimaryEmail(db: any, userId: number, clientId: number, emailId: number) {
  await db.execute(sql`UPDATE crm_client_emails SET isPrimary = (id = ${emailId}) WHERE clientId = ${clientId}`);
  await refreshPrimary(db, clientId);
  await logCrm(userId, clientId, "crm_email_primary", { emailId });
}

export async function addPhone(db: any, userId: number, clientId: number, raw: string, o: { primary?: boolean; whatsapp?: boolean; label?: string | null } = {}) {
  const phone = phoneKey(raw);
  if (!phone) throw new Error("Telefone inválido.");
  if (o.primary) await db.execute(sql`UPDATE crm_client_phones SET isPrimary = 0 WHERE clientId = ${clientId}`);
  await db.execute(sql`INSERT INTO crm_client_phones (clientId, phone, isPrimary, whatsapp, label, source, firstSeenAt, lastSeenAt)
    VALUES (${clientId}, ${phone}, ${o.primary ? 1 : 0}, ${o.whatsapp ? 1 : 0}, ${o.label ?? null}, 'manual', UTC_TIMESTAMP(), UTC_TIMESTAMP())
    ON DUPLICATE KEY UPDATE isPrimary = GREATEST(isPrimary, VALUES(isPrimary)), whatsapp = GREATEST(whatsapp, VALUES(whatsapp)), label = COALESCE(VALUES(label), label)`);
  await unblock(db, clientId, "phone", phone);
  await refreshPrimary(db, clientId);
  await db.execute(sql`UPDATE crm_clients SET country = COALESCE(country, ${countryFromPhone(phone)}) WHERE id = ${clientId}`);
  await logCrm(userId, clientId, "crm_phone_add", { phone, ...o });
}

export async function removePhone(db: any, userId: number, clientId: number, phoneId: number) {
  const [p] = rowsOf(await db.execute(sql`SELECT phone FROM crm_client_phones WHERE id = ${phoneId} AND clientId = ${clientId}`));
  if (!p) throw new Error("Telefone não encontrado.");
  await db.execute(sql`DELETE FROM crm_client_phones WHERE id = ${phoneId} AND clientId = ${clientId}`);
  await block(db, userId, clientId, "phone", String(p.phone));
  await refreshPrimary(db, clientId);
  await logCrm(userId, clientId, "crm_phone_remove", { phone: p.phone });
}

export async function setPrimaryPhone(db: any, userId: number, clientId: number, phoneId: number, whatsapp?: boolean) {
  await db.execute(sql`UPDATE crm_client_phones SET isPrimary = (id = ${phoneId}) WHERE clientId = ${clientId}`);
  if (whatsapp != null) await db.execute(sql`UPDATE crm_client_phones SET whatsapp = ${whatsapp ? 1 : 0} WHERE id = ${phoneId} AND clientId = ${clientId}`);
  await refreshPrimary(db, clientId);
  await logCrm(userId, clientId, "crm_phone_primary", { phoneId, whatsapp });
}

// ─── Carros ─────────────────────────────────────────────────────────────────

export async function upsertVehicle(db: any, userId: number, clientId: number, v: { id?: number; plate: string; brand?: string | null; model?: string | null; color?: string | null; vehicleType?: string | null }) {
  const key = plateKey(v.plate);
  if (!key) throw new Error("Matrícula inválida.");
  const clean = (s?: string | null) => (s && s.trim() ? s.trim().slice(0, 96) : null);
  if (v.id) {
    // matrícula corrigida: a antiga não volta com a carga das reservas
    const [old] = rowsOf(await db.execute(sql`SELECT plate FROM crm_client_vehicles WHERE id = ${v.id} AND clientId = ${clientId}`));
    if (!old) throw new Error("Carro não encontrado.");
    if (String(old.plate) !== key) await block(db, userId, clientId, "plate", String(old.plate));
    await db.execute(sql`UPDATE crm_client_vehicles SET plate = ${key}, plateDisplay = ${v.plate.trim().slice(0, 32)}, brand = ${clean(v.brand)},
      model = ${clean(v.model)}, color = ${clean(v.color)}, vehicleType = ${clean(v.vehicleType)} WHERE id = ${v.id} AND clientId = ${clientId}`);
  } else {
    await db.execute(sql`INSERT INTO crm_client_vehicles (clientId, plate, plateDisplay, brand, model, color, vehicleType, firstSeenAt, lastSeenAt)
      VALUES (${clientId}, ${key}, ${v.plate.trim().slice(0, 32)}, ${clean(v.brand)}, ${clean(v.model)}, ${clean(v.color)}, ${clean(v.vehicleType)}, UTC_TIMESTAMP(), UTC_TIMESTAMP())
      ON DUPLICATE KEY UPDATE brand = COALESCE(VALUES(brand), brand), model = COALESCE(VALUES(model), model), color = COALESCE(VALUES(color), color)`);
  }
  await unblock(db, clientId, "plate", key);
  await logCrm(userId, clientId, v.id ? "crm_vehicle_update" : "crm_vehicle_add", v);
}

export async function removeVehicle(db: any, userId: number, clientId: number, vehicleId: number) {
  const [v] = rowsOf(await db.execute(sql`SELECT plateDisplay, plate FROM crm_client_vehicles WHERE id = ${vehicleId} AND clientId = ${clientId}`));
  if (!v) throw new Error("Carro não encontrado.");
  await db.execute(sql`DELETE FROM crm_client_vehicles WHERE id = ${vehicleId} AND clientId = ${clientId}`);
  await block(db, userId, clientId, "plate", String(v.plate));
  await logCrm(userId, clientId, "crm_vehicle_remove", { plate: v.plateDisplay || v.plate });
}

export async function setPhoto(db: any, userId: number, o: { clientId: number; vehicleId?: number | null; url: string }) {
  if (o.vehicleId) {
    await db.execute(sql`UPDATE crm_client_vehicles SET photoUrl = ${o.url} WHERE id = ${o.vehicleId} AND clientId = ${o.clientId}`);
  } else {
    await db.execute(sql`UPDATE crm_clients SET photoUrl = ${o.url} WHERE id = ${o.clientId}`);
  }
  await logCrm(userId, o.clientId, o.vehicleId ? "crm_vehicle_photo" : "crm_client_photo", { vehicleId: o.vehicleId ?? null });
}

export async function setIban(db: any, userId: number, clientId: number, iban: string | null) {
  const { encryptSecret } = await import("../integrations/googleAds/crypto");
  const clean = iban ? iban.replace(/\s+/g, "").toUpperCase() : "";
  if (clean && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(clean)) throw new Error("IBAN inválido.");
  await db.execute(sql`UPDATE crm_clients SET ibanEnc = ${clean ? encryptSecret(clean) : null} WHERE id = ${clientId}`);
  // sem dígitos no registo: o registo da ficha é visível a quem não vê finanças
  await logCrm(userId, clientId, "crm_iban", { set: !!clean });
}

// ─── Ligações (pessoa ↔ empresa, familiar) ─────────────────────────────────

export const RELATION_KINDS = ["employee", "manager", "family", "other"] as const;

export async function addRelation(db: any, userId: number, o: { clientId: number; relatedClientId: number; kind: (typeof RELATION_KINDS)[number]; label?: string | null; pays?: boolean }) {
  if (o.clientId === o.relatedClientId) throw new Error("Uma ficha não se liga a si própria.");
  await db.execute(sql`INSERT INTO crm_client_relations (clientId, relatedClientId, kind, label, pays, createdBy)
    VALUES (${o.clientId}, ${o.relatedClientId}, ${o.kind}, ${o.label ?? null}, ${o.pays ? 1 : 0}, ${userId})
    ON DUPLICATE KEY UPDATE label = VALUES(label), pays = VALUES(pays)`);
  // ligadas → nunca se sugere juntá-las
  const [a, b] = o.clientId < o.relatedClientId ? [o.clientId, o.relatedClientId] : [o.relatedClientId, o.clientId];
  await db.execute(sql`UPDATE crm_merge_suggestions SET status = 'dismissed', decidedBy = ${userId}, decidedAt = UTC_TIMESTAMP() WHERE clientA = ${a} AND clientB = ${b} AND status = 'pending'`);
  await logCrm(userId, o.clientId, "crm_relation_add", o);
  await logCrm(userId, o.relatedClientId, "crm_relation_add", o);
}

export async function removeRelation(db: any, userId: number, relationId: number) {
  const [r] = rowsOf(await db.execute(sql`SELECT * FROM crm_client_relations WHERE id = ${relationId}`));
  if (!r) throw new Error("Ligação não encontrada.");
  await db.execute(sql`DELETE FROM crm_client_relations WHERE id = ${relationId}`);
  await logCrm(userId, Number(r.clientId), "crm_relation_remove", { relatedClientId: Number(r.relatedClientId), kind: r.kind });
}

// ─── Sugestões ──────────────────────────────────────────────────────────────

export async function dismissSuggestion(db: any, userId: number, suggestionId: number) {
  const [s] = rowsOf(await db.execute(sql`SELECT clientA, clientB FROM crm_merge_suggestions WHERE id = ${suggestionId}`));
  if (!s) throw new Error("Sugestão não encontrada.");
  await db.execute(sql`UPDATE crm_merge_suggestions SET status = 'dismissed', decidedBy = ${userId}, decidedAt = UTC_TIMESTAMP() WHERE id = ${suggestionId}`);
  await logCrm(userId, Number(s.clientA), "crm_suggestion_dismiss", { other: Number(s.clientB) });
}

// ─── Filtros guardados ──────────────────────────────────────────────────────

export async function listSavedFilters(db: any, userId: number) {
  const { sanitizeSavedView } = await import("../../shared/crmFilters");
  return rowsOf(await db.execute(sql`SELECT f.id, f.userId, f.name, f.payloadJson, f.shared, f.isDefault, u.name AS ownerName
    FROM crm_saved_filters f LEFT JOIN users u ON u.id = f.userId
    WHERE f.userId = ${userId} OR f.shared = 1 ORDER BY f.userId = ${userId} DESC, f.name`)).map((f) => {
    // 21a: um filtro antigo com valores que deixaram de existir aplica o que ainda vale e diz quantos caíram
    const { view, dropped } = sanitizeSavedView(safeJson(f.payloadJson));
    return {
      id: Number(f.id), name: String(f.name), shared: Number(f.shared) === 1, isDefault: Number(f.isDefault) === 1 && Number(f.userId) === userId,
      mine: Number(f.userId) === userId, ownerName: f.ownerName ?? null, payload: view, dropped,
    };
  });
}

function safeJson(s: unknown) { try { return JSON.parse(String(s ?? "{}")); } catch { return {}; } }

export async function saveFilter(db: any, userId: number, o: { id?: number; name: string; payload: unknown; shared: boolean; isDefault: boolean }) {
  const { savedViewSchema, SAVED_VIEW_MAX_CHARS } = await import("../../shared/crmFilters");
  // 21a: valida-se ao guardar; nunca se corta o JSON a meio (cortado ficava inválido e abria "sem filtro")
  const parsed = savedViewSchema.safeParse(o.payload ?? {});
  if (!parsed.success) throw new Error("O filtro tem valores inválidos e não foi guardado.");
  const payload = JSON.stringify(parsed.data);
  if (payload.length > SAVED_VIEW_MAX_CHARS) throw new Error("O filtro é grande demais para guardar. Tira alguns valores (parques, parceiros) e tenta de novo.");
  if (o.isDefault) await db.execute(sql`UPDATE crm_saved_filters SET isDefault = 0 WHERE userId = ${userId}`);
  if (o.id) {
    await db.execute(sql`UPDATE crm_saved_filters SET name = ${o.name.slice(0, 128)}, payloadJson = ${payload}, shared = ${o.shared ? 1 : 0}, isDefault = ${o.isDefault ? 1 : 0}
      WHERE id = ${o.id} AND userId = ${userId}`);
    return { id: o.id };
  }
  const res = await db.execute(sql`INSERT INTO crm_saved_filters (userId, name, payloadJson, shared, isDefault)
    VALUES (${userId}, ${o.name.slice(0, 128)}, ${payload}, ${o.shared ? 1 : 0}, ${o.isDefault ? 1 : 0})`);
  return { id: insertId(res) };
}

export async function deleteFilter(db: any, userId: number, id: number) {
  // Preferência da pessoa (não é um dado de negócio): sai, mas fica no registo — com o nome
  // e se era partilhado, porque um partilhado desaparece também aos outros.
  const [f] = rowsOf(await db.execute(sql`SELECT name, shared FROM crm_saved_filters WHERE id = ${id} AND userId = ${userId}`));
  if (!f) throw new Error("Filtro não encontrado.");
  await db.execute(sql`DELETE FROM crm_saved_filters WHERE id = ${id} AND userId = ${userId}`);
  const { logActivity } = await import("../db");
  await logActivity({ userId, action: "crm_filter_delete", entity: "crm_filter", entityId: id, details: JSON.stringify({ name: String(f.name), shared: Number(f.shared) === 1 }) } as any);
}
