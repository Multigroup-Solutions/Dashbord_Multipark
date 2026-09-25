/**
 * Contactos (Google People API) — regras PURAS (servidor + cliente, sem BD,
 * sem rede, sem relógio implícito). Pedido do dono (set 2026):
 *
 *  1. Diretório da empresa: perfis do domínio do Workspace (People API
 *     `listDirectoryPeople`, DOMAIN_PROFILE) lidos pela conta de serviço com
 *     delegação, guardados em cache e ligados às contas/fichas pelo email;
 *  2. Contactos unificados: uma pesquisa sobre clientes, contactos do CRM,
 *     leads, parceiros, fornecedores, colaboradores, diretório e os contactos
 *     Google da própria pessoa — cada tipo só aparece a quem vê o módulo
 *     correspondente (matriz shared/access.ts + âmbito de cidade no servidor);
 *  3. Contactos pessoais (autorização incremental "contacts"): sugestões de
 *     ligação (email/telefone → cliente/lead/parceiro) e o grupo
 *     "Multipark — Serviço" com os clientes das recolhas/entregas de hoje e
 *     amanhã (identificação de chamadas no telemóvel), apagados depois da
 *     retenção — SÓ os contactos que a app criou (marca em clientData).
 */
import { z } from "zod";
import { ROLES, grantFor, type Access, type AccessOverrides, type ModuleId, type Role } from "./access";
import { normalizeEmail, isPlausibleEmail } from "./email";
import { normalizePhoneE164 } from "./phone";
import { normalizeSearchText } from "./contactSearch";
import { stableHash } from "./googleSync";

// ─── Constantes da People API ───────────────────────────────────────────────

/** Âmbito da conta de serviço (delegação) para ler o diretório do domínio. */
export const DIRECTORY_SCOPES = ["https://www.googleapis.com/auth/directory.readonly"] as const;
export const DIRECTORY_SOURCE = "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE";
export const DIRECTORY_READ_MASK = "names,emailAddresses,phoneNumbers,photos,organizations,metadata";
/** Contactos da pessoa: clientData/memberships para reconhecer os criados pela app. */
export const CONNECTIONS_PERSON_FIELDS = "names,emailAddresses,phoneNumbers,clientData,memberships,metadata";
export const OTHER_CONTACTS_READ_MASK = "names,emailAddresses,phoneNumbers,metadata";

/** Chave do clientData que marca um contacto criado pela app ("<grupo>:<userId>"). */
export const APP_CONTACT_MARKER_KEY = "multipark";
/** Data (ISO) a partir da qual o contacto pode ser apagado (vazio = enquanto for preciso). */
export const APP_CONTACT_EXPIRES_KEY = "multipark.expira";

export const PUSH_GROUPS = ["service", "partners"] as const;
export type PushGroupKey = (typeof PUSH_GROUPS)[number];
export const PUSH_GROUP_NAMES: Record<PushGroupKey, string> = {
  service: "Multipark — Serviço",
  partners: "Multipark — Parceiros e fornecedores",
};

/** Limites da API: criar ≤ 200 e apagar ≤ 500 por pedido; ler ≤ 200 por batchGet. */
export const PEOPLE_BATCH_CREATE_MAX = 200;
export const PEOPLE_BATCH_DELETE_MAX = 500;
export const PEOPLE_BATCH_GET_MAX = 200;
/** Contactos Google guardados por pessoa (sugestões). */
export const USER_CONTACTS_MAX = 5000;
/** O diretório é relido uma vez por dia (dentro do cron google-sync). */
export const DIRECTORY_REFRESH_HOURS = 24;

// ─── Normalização (a mesma para tudo o que se compara) ──────────────────────

/** Email comparável ("" se não for plausível). PURA. */
export function emailKey(raw: string | null | undefined): string {
  const e = normalizeEmail(raw);
  return isPlausibleEmail(e) ? e : "";
}

/** Telefone comparável em E.164 (Portugal por omissão; "" se não der). PURA. */
export function phoneKey(raw: string | null | undefined): string {
  return typeof raw === "string" ? normalizePhoneE164(raw) ?? "" : "";
}

const uniq = (xs: readonly string[]) => Array.from(new Set(xs.filter(Boolean)));

// ─── Pessoa (forma mínima que lemos da People API) ──────────────────────────

export interface PersonFieldLike { value?: string | null; metadata?: { primary?: boolean | null; source?: { type?: string | null } | null } | null }
export interface PersonLike {
  resourceName?: string | null;
  etag?: string | null;
  names?: Array<{ displayName?: string | null; givenName?: string | null; familyName?: string | null; unstructuredName?: string | null; metadata?: PersonFieldLike["metadata"] }> | null;
  emailAddresses?: PersonFieldLike[] | null;
  phoneNumbers?: Array<PersonFieldLike & { canonicalForm?: string | null }> | null;
  photos?: Array<{ url?: string | null; default?: boolean | null; metadata?: PersonFieldLike["metadata"] }> | null;
  organizations?: Array<{ title?: string | null; department?: string | null; name?: string | null; metadata?: PersonFieldLike["metadata"] }> | null;
  clientData?: Array<{ key?: string | null; value?: string | null }> | null;
  memberships?: Array<{ contactGroupMembership?: { contactGroupResourceName?: string | null } | null }> | null;
  metadata?: { deleted?: boolean | null } | null;
}

function primaryFirst<T extends { metadata?: { primary?: boolean | null } | null }>(xs: readonly T[] | null | undefined): T[] {
  const list = (xs ?? []).slice();
  return list.sort((a, b) => Number(!!b.metadata?.primary) - Number(!!a.metadata?.primary));
}

/** Nome visível de uma pessoa. PURA. */
export function personName(p: PersonLike): string {
  const n = primaryFirst(p.names)[0];
  const s = n?.displayName || n?.unstructuredName || [n?.givenName, n?.familyName].filter(Boolean).join(" ");
  return String(s ?? "").trim().slice(0, 255);
}

export function personEmails(p: PersonLike): string[] {
  return uniq(primaryFirst(p.emailAddresses).map((e) => emailKey(e.value)));
}

export function personPhones(p: PersonLike): string[] {
  return uniq(primaryFirst(p.phoneNumbers).map((x) => phoneKey(x.canonicalForm || x.value)));
}

// ─── 1. Diretório ───────────────────────────────────────────────────────────

export interface DirectoryPersonRow {
  resourceName: string;
  primaryEmail: string;
  emails: string[];
  displayName: string;
  givenName: string | null;
  familyName: string | null;
  jobTitle: string | null;
  department: string | null;
  phoneE164: string | null;
  /** Telefone como está no diretório (quando não dá E.164). */
  phoneRaw: string | null;
  photoUrl: string | null;
  deleted: boolean;
}

/**
 * Perfil do diretório → linha da cache. Sem email → ignorado (não há com
 * que ligar). Foto por omissão (letra) → sem foto. PURA.
 */
export function mapDirectoryPerson(p: PersonLike): DirectoryPersonRow | null {
  const resourceName = String(p.resourceName ?? "").trim();
  if (!resourceName) return null;
  const emails = personEmails(p);
  const deleted = !!p.metadata?.deleted;
  if (!emails.length && !deleted) return null;
  const n = primaryFirst(p.names)[0];
  const org = primaryFirst(p.organizations)[0];
  const phone = primaryFirst(p.phoneNumbers)[0];
  const photo = primaryFirst(p.photos).find((x) => x.url && !x.default);
  const e164 = phoneKey(phone?.canonicalForm || phone?.value);
  const clip = (v: string | null | undefined, n = 255) => { const s = String(v ?? "").trim(); return s ? s.slice(0, n) : null; };
  return {
    resourceName: resourceName.slice(0, 128),
    primaryEmail: emails[0] ?? "",
    emails: emails.slice(0, 10),
    displayName: personName(p) || emails[0] || resourceName,
    givenName: clip(n?.givenName, 128),
    familyName: clip(n?.familyName, 128),
    jobTitle: clip(org?.title),
    department: clip(org?.department),
    phoneE164: e164 || null,
    phoneRaw: e164 ? null : clip(phone?.value, 64),
    photoUrl: photo?.url ? String(photo.url).slice(0, 1000) : null,
    deleted,
  };
}

// ─── Definições (Definições → Comunicação → Contactos Google) ───────────────

const emailOrEmpty = z.union([z.literal(""), z.string().trim().toLowerCase().email("Email inválido.")]);
const roleList = z.array(z.enum(ROLES as unknown as [Role, ...Role[]])).max(ROLES.length);

export const DEFAULT_SERVICE_ROLES: Role[] = ["condutor", "team_leader"];
export const DEFAULT_PARTNERS_ROLES: Role[] = ["backoffice", "admin", "super_admin"];

export const contactsConfigSchema = z.object({
  directory: z.object({
    /** Ler o diretório do domínio (conta de serviço com delegação). */
    enabled: z.boolean(),
    /** Conta do Workspace (admin/dona) impersonada para ler o diretório. */
    adminEmail: emailOrEmpty,
  }),
  service: z.object({
    /** Papéis com o grupo "Multipark — Serviço" (condutor e TL por omissão). */
    roles: roleList,
    /** Dias depois do serviço até o contacto ser apagado do telemóvel. */
    retentionDays: z.number({ error: "Indica os dias de retenção." }).int("Número inteiro de dias.").min(0, "Mínimo 0 dias.").max(30, "Máximo 30 dias."),
    /** Máximo de contactos por pessoa (os serviços mais próximos primeiro). */
    maxPerUser: z.number({ error: "Indica o máximo por pessoa." }).int().min(10, "Mínimo 10.").max(1000, "Máximo 1000."),
  }),
  partners: z.object({
    /** Grupo "Multipark — Parceiros e fornecedores" (parceiros ativos com telefone). */
    enabled: z.boolean(),
    roles: roleList,
  }),
}).superRefine((v, ctx) => {
  if (v.directory.enabled && !v.directory.adminEmail) ctx.addIssue({ code: "custom", message: "Indica a conta do Workspace a usar para ler o diretório." });
});
export type ContactsConfig = z.output<typeof contactsConfigSchema>;
export const DEFAULT_CONTACTS_CONFIG: ContactsConfig = {
  directory: { enabled: false, adminEmail: "" },
  service: { roles: [...DEFAULT_SERVICE_ROLES], retentionDays: 2, maxPerUser: 250 },
  partners: { enabled: false, roles: [...DEFAULT_PARTNERS_ROLES] },
};

/** Lê a configuração guardada com omissões seguras (campo a campo). PURA. */
export function parseContactsConfig(raw: unknown): ContactsConfig {
  let v: any = raw;
  if (typeof raw === "string") { try { v = JSON.parse(raw); } catch { v = {}; } }
  if (!v || typeof v !== "object") v = {};
  const d = DEFAULT_CONTACTS_CONFIG;
  const merged = {
    directory: { ...d.directory, ...(v.directory ?? {}) },
    service: { ...d.service, ...(v.service ?? {}) },
    partners: { ...d.partners, ...(v.partners ?? {}) },
  };
  const r = contactsConfigSchema.safeParse(merged);
  return r.success ? r.data : d;
}

export function servicePushAllowed(role: string | null | undefined, cfg: ContactsConfig): boolean {
  return (cfg.service.roles as string[]).includes(String(role ?? ""));
}
export function partnersPushAllowed(role: string | null | undefined, cfg: ContactsConfig): boolean {
  return cfg.partners.enabled && (cfg.partners.roles as string[]).includes(String(role ?? ""));
}

// ─── Preferências da pessoa (Perfil → Google → Contactos) ──────────────────

export const googleContactsPrefsSchema = z.object({
  /** Ler os contactos Google para sugerir ligações a clientes/leads/parceiros. */
  suggestions: z.boolean().default(true),
  /** Grupo "Multipark — Serviço" (se o papel o tiver). */
  serviceGroup: z.boolean().default(true),
  /** Grupo "Multipark — Parceiros e fornecedores" (se o papel o tiver). */
  partnersGroup: z.boolean().default(true),
});
export type GoogleContactsPrefs = z.output<typeof googleContactsPrefsSchema>;
export const DEFAULT_GOOGLE_CONTACTS_PREFS: GoogleContactsPrefs = { suggestions: true, serviceGroup: true, partnersGroup: true };

export function parseGoogleContactsPrefs(raw: unknown): GoogleContactsPrefs {
  let v: unknown = raw;
  if (typeof raw === "string") { try { v = JSON.parse(raw); } catch { v = {}; } }
  const r = googleContactsPrefsSchema.safeParse(v && typeof v === "object" ? v : {});
  return r.success ? r.data : DEFAULT_GOOGLE_CONTACTS_PREFS;
}

// ─── 3. Grupos escritos pela app ────────────────────────────────────────────

export const appMarkerValue = (group: PushGroupKey, userId: number) => `${group}:${userId}`;

/** Marca da app num contacto (grupo + dono) ou null — nunca se toca no resto. PURA. */
export function appMarkerOf(p: PersonLike): { group: PushGroupKey; userId: number; expiresAtMs: number | null } | null {
  const data = p.clientData ?? [];
  const mark = data.find((c) => c?.key === APP_CONTACT_MARKER_KEY)?.value ?? "";
  const m = /^(service|partners):(\d+)$/.exec(String(mark));
  if (!m) return null;
  const exp = data.find((c) => c?.key === APP_CONTACT_EXPIRES_KEY)?.value ?? "";
  const t = exp ? Date.parse(String(exp)) : NaN;
  return { group: m[1] as PushGroupKey, userId: Number(m[2]), expiresAtMs: Number.isFinite(t) ? t : null };
}

export interface DesiredPushContact {
  /** Chave única no grupo (telefone E.164: é o que o telemóvel usa para identificar a chamada). */
  key: string;
  group: PushGroupKey;
  displayName: string;
  phoneE164: string;
  /** Hora do serviço mais tardio (ms) — base da retenção. */
  lastServiceMs: number | null;
  /** A partir de quando se pode apagar (null = enquanto for desejado). */
  expiresAtMs: number | null;
  hash: string;
}

export const pushContactHash = (c: Pick<DesiredPushContact, "displayName" | "phoneE164">) => stableHash(`${c.displayName}|${c.phoneE164}`);

/** Corpo do contacto a criar (mínimo: nome, telefone, grupo e marca). PURA. */
export function pushContactBody(c: DesiredPushContact, userId: number, groupResourceName: string) {
  return {
    names: [{ unstructuredName: c.displayName }],
    phoneNumbers: [{ value: c.phoneE164, type: "mobile" }],
    memberships: [{ contactGroupMembership: { contactGroupResourceName: groupResourceName } }],
    clientData: [
      { key: APP_CONTACT_MARKER_KEY, value: appMarkerValue(c.group, userId) },
      { key: APP_CONTACT_EXPIRES_KEY, value: c.expiresAtMs != null ? new Date(c.expiresAtMs).toISOString() : "" },
    ],
  };
}

export interface ServiceBookingLike {
  clientFirstName?: string | null;
  clientLastName?: string | null;
  clientPhone?: string | null;
  licensePlate?: string | null;
  status?: string | null;
  /** "YYYY-MM-DD HH:MM:SS" UTC (recolha: o cliente chega). */
  checkIn?: string | null;
  /** "YYYY-MM-DD HH:MM:SS" UTC (entrega: o cliente volta). */
  checkOut?: string | null;
}

export interface ServiceWindow { fromMs: number; toMs: number }

const sqlMs = (v: string | null | undefined): number | null => {
  if (!v) return null;
  const s = String(v).trim();
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(" ", "T") : `${s.replace(" ", "T")}Z`);
  return Number.isFinite(t) ? t : null;
};

/** Nome no telemóvel: quem é e a matrícula (sem email nem mais dados). PURA. */
export function serviceDisplayName(b: Pick<ServiceBookingLike, "clientFirstName" | "clientLastName" | "licensePlate">): string {
  const name = [b.clientFirstName, b.clientLastName].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ");
  const plate = String(b.licensePlate ?? "").trim().toUpperCase();
  return `Cliente Multipark: ${name || "sem nome"}${plate ? ` (${plate})` : ""}`.slice(0, 120);
}

/**
 * Contactos desejados no grupo "Serviço": clientes (com telefone válido) das
 * reservas não canceladas cuja recolha (checkIn) ou entrega (checkOut) cai
 * numa das janelas da pessoa. Um contacto por telefone; retenção a contar do
 * serviço mais tardio; no máximo `max`, os serviços mais próximos de agora
 * primeiro. PURA.
 */
export function desiredServiceContacts(
  bookings: readonly ServiceBookingLike[],
  windows: readonly ServiceWindow[],
  opts: { retentionDays: number; max: number; nowMs: number },
): DesiredPushContact[] {
  const inWindow = (ms: number | null) => ms != null && windows.some((w) => ms >= w.fromMs && ms < w.toMs);
  const byPhone = new Map<string, { b: ServiceBookingLike; last: number; nearest: number }>();
  for (const b of bookings) {
    if (String(b.status ?? "").toUpperCase().includes("CANCEL")) continue;
    const phone = phoneKey(b.clientPhone);
    if (!phone) continue;
    const times = [sqlMs(b.checkIn), sqlMs(b.checkOut)].filter((t): t is number => inWindow(t));
    if (!times.length) continue;
    const last = Math.max(...times);
    const nearest = Math.min(...times.map((t) => Math.abs(t - opts.nowMs)));
    const cur = byPhone.get(phone);
    if (!cur) byPhone.set(phone, { b, last, nearest });
    else byPhone.set(phone, { b: last >= cur.last ? b : cur.b, last: Math.max(last, cur.last), nearest: Math.min(nearest, cur.nearest) });
  }
  const ret = Math.max(0, opts.retentionDays) * 86_400_000;
  return Array.from(byPhone.entries())
    .sort((a, b) => a[1].nearest - b[1].nearest || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, opts.max))
    .map(([phone, x]) => {
      const displayName = serviceDisplayName(x.b);
      return { key: phone, group: "service" as const, displayName, phoneE164: phone, lastServiceMs: x.last, expiresAtMs: x.last + ret, hash: pushContactHash({ displayName, phoneE164: phone }) };
    });
}

/** Parceiros ativos com telefone → grupo "Parceiros e fornecedores" (sem retenção). PURA. */
export function desiredPartnerContacts(partners: readonly { name: string; contactName?: string | null; contactPhone?: string | null; status?: string | null }[], max = 500): DesiredPushContact[] {
  const out = new Map<string, DesiredPushContact>();
  for (const p of partners) {
    if (p.status && p.status !== "active") continue;
    const phone = phoneKey(p.contactPhone);
    if (!phone || out.has(phone)) continue;
    const who = String(p.contactName ?? "").trim();
    const displayName = `Parceiro Multipark: ${String(p.name).trim()}${who ? ` (${who})` : ""}`.slice(0, 120);
    out.set(phone, { key: phone, group: "partners", displayName, phoneE164: phone, lastServiceMs: null, expiresAtMs: null, hash: pushContactHash({ displayName, phoneE164: phone }) });
    if (out.size >= max) break;
  }
  return Array.from(out.values());
}

export interface PushMapping {
  key: string;
  resourceName: string;
  hash: string | null;
  expiresAtMs: number | null;
}

export interface PushPlan {
  create: DesiredPushContact[];
  /** Só na BD: a retenção passa a contar de um serviço mais tardio. */
  extend: Array<{ key: string; expiresAtMs: number | null }>;
  /** Candidatos a apagar (confirma-se a marca no Google antes — selectDeletable). */
  delete: PushMapping[];
}

/**
 * Plano idempotente de um grupo: o que falta → criar; ainda desejado →
 * prolonga a retenção; já não desejado → apaga quando a retenção acabou (ou
 * logo, se não tem retenção); desligado → apaga tudo o que a app criou. PURA.
 */
export function planPushOps(desired: readonly DesiredPushContact[], mappings: readonly PushMapping[], nowMs: number, opts: { enabled: boolean }): PushPlan {
  const plan: PushPlan = { create: [], extend: [], delete: [] };
  if (!opts.enabled) { plan.delete.push(...mappings); return plan; }
  const byKey = new Map(mappings.map((m) => [m.key, m]));
  const wanted = new Set<string>();
  for (const d of desired) {
    if (wanted.has(d.key)) continue;
    wanted.add(d.key);
    const m = byKey.get(d.key);
    if (!m) { plan.create.push(d); continue; }
    if (d.expiresAtMs == null ? m.expiresAtMs != null : m.expiresAtMs == null || d.expiresAtMs > m.expiresAtMs) {
      plan.extend.push({ key: d.key, expiresAtMs: d.expiresAtMs == null ? null : Math.max(d.expiresAtMs, m.expiresAtMs ?? 0) });
    }
  }
  for (const m of mappings) {
    if (wanted.has(m.key)) continue;
    if (m.expiresAtMs == null || nowMs >= m.expiresAtMs) plan.delete.push(m);
  }
  return plan;
}

/**
 * De entre os candidatos a apagar, SÓ os que no Google ainda têm a marca da
 * app para este grupo e esta pessoa. Não encontrado → esquece a ligação (já
 * foi apagado); sem a marca (a pessoa editou/copiou o contacto, ou é de outra
 * origem) → esquece a ligação e NUNCA apaga. PURA.
 */
export function selectDeletable(
  candidates: readonly PushMapping[],
  remote: ReadonlyMap<string, PersonLike | null>,
  userId: number,
  group: PushGroupKey,
): { delete: PushMapping[]; forget: PushMapping[] } {
  const out = { delete: [] as PushMapping[], forget: [] as PushMapping[] };
  for (const c of candidates) {
    const p = remote.get(c.resourceName);
    if (!p || p.metadata?.deleted) { out.forget.push(c); continue; }
    const mark = appMarkerOf(p);
    if (mark && mark.group === group && mark.userId === userId) out.delete.push(c);
    else out.forget.push(c);
  }
  return out;
}

/** Divide em lotes (limites da API). PURA. */
export function chunk<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

// ─── Sugestões de ligação (email/telefone → registo existente) ─────────────

export const CONTACT_KINDS = ["client", "crm", "lead", "partner", "supplier", "employee", "directory", "google"] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];
export const CONTACT_KIND_LABELS: Record<ContactKind, string> = {
  client: "Cliente", crm: "Contacto CRM", lead: "Lead (extras)", partner: "Parceiro", supplier: "Fornecedor",
  employee: "Colaborador", directory: "Diretório", google: "Google (meus)",
};

export interface MatchRecord { kind: ContactKind; id: string; label: string; emails: readonly string[]; phones: readonly string[] }
export interface ContactMatch { kind: ContactKind; id: string; label: string; via: "email" | "phone" }

export interface MatchIndex { byEmail: Map<string, MatchRecord[]>; byPhone: Map<string, MatchRecord[]> }

/** Índice por email e por telefone (já normalizados aqui). PURA. */
export function buildMatchIndex(records: readonly MatchRecord[]): MatchIndex {
  const idx: MatchIndex = { byEmail: new Map(), byPhone: new Map() };
  const add = (m: Map<string, MatchRecord[]>, k: string, r: MatchRecord) => { if (!k) return; const l = m.get(k) ?? []; if (!l.includes(r)) l.push(r); m.set(k, l); };
  for (const r of records) {
    for (const e of r.emails) add(idx.byEmail, emailKey(e), r);
    for (const p of r.phones) add(idx.byPhone, phoneKey(p), r);
  }
  return idx;
}

/** Registos que batem com um contacto (email primeiro, depois telefone), sem repetidos. PURA. */
export function matchContact(contact: { emails: readonly string[]; phones: readonly string[] }, idx: MatchIndex): ContactMatch[] {
  const out = new Map<string, ContactMatch>();
  for (const e of contact.emails) for (const r of idx.byEmail.get(emailKey(e)) ?? []) if (!out.has(`${r.kind}:${r.id}`)) out.set(`${r.kind}:${r.id}`, { kind: r.kind, id: r.id, label: r.label, via: "email" });
  for (const p of contact.phones) for (const r of idx.byPhone.get(phoneKey(p)) ?? []) if (!out.has(`${r.kind}:${r.id}`)) out.set(`${r.kind}:${r.id}`, { kind: r.kind, id: r.id, label: r.label, via: "phone" });
  return Array.from(out.values());
}

// ─── 2. Pesquisa unificada: que tipos cada pessoa vê ────────────────────────

/** Módulo que decide cada tipo (google = só os do próprio). */
export const CONTACT_KIND_MODULES: Record<ContactKind, readonly ModuleId[]> = {
  client: ["clientes"],
  crm: ["clientes"],
  lead: ["leads_extras"],
  partner: ["parcerias"],
  supplier: ["despesas"],
  employee: ["rh", "utilizadores"],
  directory: ["contactos"],
  google: [],
};

type UserLike = { role: string; accessOverrides?: AccessOverrides | null };
const ACCESS_ORDER: Record<Access, number> = { none: 0, own: 1, below_city: 2, city: 3, national: 4 };

/**
 * Tipos que a pessoa pode pesquisar nos Contactos e com que alcance. Precisa
 * do módulo "contactos" (ver, além do próprio); cada tipo precisa ainda do
 * módulo de origem com "ver" e alcance além do próprio (o "own" não chega
 * para ver contactos de terceiros). O âmbito de cidade é do servidor. PURA.
 */
export function contactKindsFor(user: UserLike): Array<{ kind: ContactKind; access: Access }> {
  const base = grantFor(user as any, "contactos");
  if (base.access === "none" || base.access === "own" || !base.actions.includes("view")) return [];
  const out: Array<{ kind: ContactKind; access: Access }> = [];
  for (const kind of CONTACT_KINDS) {
    if (kind === "google") { out.push({ kind, access: "own" }); continue; }
    let best: Access = "none";
    for (const m of CONTACT_KIND_MODULES[kind]) {
      const g = grantFor(user as any, m);
      if (!g.actions.includes("view") || g.access === "own") continue;
      if (ACCESS_ORDER[g.access] > ACCESS_ORDER[best]) best = g.access;
    }
    if (best !== "none") out.push({ kind, access: best });
  }
  return out;
}

export interface ParsedContactQuery {
  text: string;
  /** LIKE seguro (%, _ e \ escapados). */
  like: string;
  digits: string;
  /** Para telefones: os últimos 9 dígitos (sem indicativo) quando há 9+. */
  phoneNeedle: string;
  email: string;
}

/** Pesquisa normalizada (texto sem acentos, dígitos, email). PURA. */
export function parseContactQuery(raw: string | null | undefined): ParsedContactQuery {
  const s = String(raw ?? "").trim().slice(0, 120);
  const text = normalizeSearchText(s);
  const digits = s.replace(/\D+/g, "").replace(/^00/, "");
  return {
    text,
    like: `%${s.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
    digits,
    phoneNeedle: digits.length >= 9 ? digits.slice(-9) : digits.length >= 3 ? digits : "",
    email: emailKey(s),
  };
}

export const CONTACT_SEARCH_PREVIEW = 6;
export const CONTACT_SEARCH_PAGE = 30;

/** Chave estável de um resultado ("tipo:id"). PURA. */
export const contactRef = (kind: ContactKind, id: string | number) => `${kind}:${String(id)}`;
export function parseContactRef(ref: string): { kind: ContactKind; id: string } | null {
  const i = ref.indexOf(":");
  if (i <= 0) return null;
  const kind = ref.slice(0, i) as ContactKind;
  const id = ref.slice(i + 1);
  return (CONTACT_KINDS as readonly string[]).includes(kind) && id ? { kind, id } : null;
}

// ─── Criar a partir de um contacto Google ───────────────────────────────────

export const CREATE_FROM_GOOGLE_AS = ["client", "lead", "extra_lead"] as const;
export type CreateFromGoogleAs = (typeof CREATE_FROM_GOOGLE_AS)[number];
export const CREATE_FROM_GOOGLE_LABELS: Record<CreateFromGoogleAs, string> = {
  client: "Cliente", lead: "Lead comercial", extra_lead: "Lead de extra",
};
/** Módulo + ação necessários para cada criação. */
export const CREATE_FROM_GOOGLE_REQUIRES: Record<CreateFromGoogleAs, { module: ModuleId; action: "edit" }> = {
  client: { module: "clientes", action: "edit" },
  lead: { module: "clientes", action: "edit" },
  extra_lead: { module: "leads_extras", action: "edit" },
};

// ─── "ok" honesto / mensagens ───────────────────────────────────────────────

/** Mensagem sem dados pessoais (para registos): só contagens. PURA. */
export function contactsRunSummary(r: { pulled?: number; created?: number; deleted?: number; forgotten?: number }): string {
  return `lidos ${r.pulled ?? 0}, criados ${r.created ?? 0}, apagados ${r.deleted ?? 0}, esquecidos ${r.forgotten ?? 0}`;
}

/** Retenção em dias → ms (limitada). PURA. */
export const retentionMs = (days: number) => Math.max(0, Math.min(30, Math.floor(days))) * 86_400_000;

export { uniq as uniqueStrings };
