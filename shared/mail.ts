/**
 * COMUNICAÇÃO — caixas de email (Gmail) dentro do dashboard (pedido do dono,
 * set 2026). Regras PURAS partilhadas entre servidor e cliente:
 *
 *  - marcas (Multipark, Multibags, Redpark, Skypark, Airpark, Multidriver) e
 *    deteção da marca pelo endereço/domínio de quem RECEBEU o email;
 *  - configuração de cada caixa partilhada (endereços/aliases, conta Google
 *    de onde se lê, módulo da matriz de acessos, regra de cidade, papéis,
 *    assinatura por marca, "pipeline" antigo de reclamações/perdidos/RH…);
 *  - classificação de uma mensagem numa caixa (Delivered-To / X-Original-To /
 *    To / Cc → alias → caixa → marca);
 *  - quem vê o quê: caixas partilhadas pela matriz (módulo `comunicacao` +
 *    módulo da caixa + papéis + cidade); "O meu email" só o próprio (e o
 *    super_admin, regra do dono);
 *  - escolha do "Enviar como" (alias) e erro claro quando o alias não está
 *    configurado no Gmail;
 *  - retenção (anos) e SLA.
 *
 * Nada aqui toca na BD nem na Google — os testes cobrem tudo sem mocks.
 */
import { z } from "zod";
import { ROLES, can, grantFor, type ModuleId, type Role, type AccessOverrides } from "./access";

// ─── Marcas ─────────────────────────────────────────────────────────────────

export const MAIL_BRAND_IDS = ["multipark", "multibags", "redpark", "skypark", "airpark", "multidriver"] as const;
export type MailBrand = (typeof MAIL_BRAND_IDS)[number];

export const MAIL_BRAND_LABELS: Record<MailBrand, string> = {
  multipark: "Multipark",
  multibags: "Multibags",
  redpark: "Redpark",
  skypark: "Skypark",
  airpark: "Airpark",
  multidriver: "Multidriver",
};

/**
 * Domínios por marca (omissão do código; sobreponível em Definições →
 * Parâmetros, `mail.brandDomains`). Os endereços de cada caixa podem ainda
 * dizer a marca explicitamente — isso ganha sempre ao domínio.
 */
export const DEFAULT_BRAND_DOMAINS: Record<MailBrand, string[]> = {
  multipark: ["multipark.pt"],
  multibags: ["multibags.pt"],
  redpark: ["redpark.pt"],
  skypark: ["skypark.pt"],
  airpark: ["airpark.pt"],
  multidriver: ["multidriver.pt"],
};

export const isMailBrand = (v: unknown): v is MailBrand => typeof v === "string" && (MAIL_BRAND_IDS as readonly string[]).includes(v);

// ─── Endereços ──────────────────────────────────────────────────────────────

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Endereço canónico (minúsculas, sem espaços nem <>). PURA. */
export function normalizeAddress(a: string | null | undefined): string {
  return String(a ?? "").trim().replace(/^<|>$/g, "").toLowerCase();
}

/** Todos os emails de um cabeçalho ("Nome <a@b.pt>, c@d.pt"). PURA. */
export function extractAddresses(header: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of String(header ?? "").match(EMAIL_IN_TEXT) ?? []) {
    const a = normalizeAddress(m);
    if (a && !out.includes(a)) out.push(a);
  }
  return out;
}

/** "Nome <a@b.pt>" → { name, email }. PURA. */
export function parseMailbox(header: string | null | undefined): { name: string | null; email: string | null } {
  const raw = String(header ?? "").trim();
  if (!raw) return { name: null, email: null };
  const email = extractAddresses(raw)[0] ?? null;
  let name = raw.replace(/<[^>]*>/, "").replace(EMAIL_IN_TEXT, "").trim().replace(/^"|"$/g, "").trim();
  if (!name) name = "";
  return { name: name || null, email };
}

export const domainOf = (address: string): string => normalizeAddress(address).split("@")[1] ?? "";

/** Marca de um endereço pelo domínio (null se não for de nenhuma marca). PURA. */
export function brandOfAddress(address: string | null | undefined, domains: Record<string, string[]> = DEFAULT_BRAND_DOMAINS): MailBrand | null {
  const d = domainOf(address ?? "");
  if (!d) return null;
  for (const b of MAIL_BRAND_IDS) {
    if ((domains[b] ?? []).some((x) => normalizeAddress(x) === d)) return b;
  }
  return null;
}

/** Endereço de uma das marcas (email interno da empresa)? PURA. */
export function isCompanyAddress(address: string | null | undefined, domains: Record<string, string[]> = DEFAULT_BRAND_DOMAINS): boolean {
  if (brandOfAddress(address, domains)) return true;
  const d = domainOf(address ?? "");
  return d === "multigroup.pt";
}

/** Remetentes automáticos (não pedem resposta). PURA. */
export function isAutomatedSender(address: string | null | undefined, headers: { autoSubmitted?: string | null; precedence?: string | null } = {}): boolean {
  const a = normalizeAddress(address);
  if (/^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|bounce[s]?)[+@._-]/.test(a)) return true;
  if (/(^|\.)(noreply|no-reply)\./.test(domainOf(a))) return true;
  const auto = String(headers.autoSubmitted ?? "").toLowerCase();
  if (auto && auto !== "no") return true;
  const prec = String(headers.precedence ?? "").toLowerCase();
  return prec === "bulk" || prec === "list" || prec === "junk";
}

// ─── Configuração das caixas partilhadas ────────────────────────────────────

/** "Pipeline" antigo (emailInboundSync): o email cria o registo no módulo. */
export const MAIL_PIPELINES = ["criticas", "reclamacoes", "perdidos", "recursos-humanos", "campanhas", "ocorrencias"] as const;
export type MailPipeline = (typeof MAIL_PIPELINES)[number];

/** Módulos da matriz a que uma caixa pode pertencer (quem a vê). */
export const MAILBOX_MODULES = [
  "comunicacao", "reclamacoes", "perdidos", "criticas", "ocorrencias", "rh", "leads_extras",
  "reservas_operacoes", "clientes", "marketing", "parcerias", "financeiro", "despesas",
] as const satisfies readonly ModuleId[];
export type MailboxModule = (typeof MAILBOX_MODULES)[number];

export const MAILBOX_CITY_RULES = ["all", "linked"] as const;
export type MailboxCityRule = (typeof MAILBOX_CITY_RULES)[number];
export const MAILBOX_CITY_RULE_LABELS: Record<MailboxCityRule, string> = {
  all: "Todas as conversas (quem vê a caixa vê tudo)",
  linked: "Papéis de cidade só veem conversas ligadas à sua cidade",
};

const addressSchema = z.string().trim().toLowerCase().email("Endereço inválido.").max(320);

export const mailboxAddressSchema = z.object({
  address: addressSchema,
  brand: z.enum(MAIL_BRAND_IDS, { error: "Marca desconhecida." }),
});
export type MailboxAddress = z.infer<typeof mailboxAddressSchema>;

export const mailboxConfigSchema = z.object({
  key: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,39}$/, "Chave: 2–40 letras minúsculas, números, - ou _."),
  label: z.string().trim().min(1, "Indica o nome da caixa.").max(80),
  /** Endereços/aliases que chegam a esta caixa (e com que marca). */
  addresses: z.array(mailboxAddressSchema).min(1, "Indica pelo menos um endereço.").max(40),
  /** De onde se lê: conta do Workspace por delegação (service account) ou a conta Google ligada de um utilizador. */
  sourceKind: z.enum(["dwd", "user"]),
  /** Conta do Workspace a impersonar (sourceKind = dwd). */
  sourceEmail: z.union([z.literal(""), addressSchema]).default(""),
  /** Utilizador cuja conta Google ligada serve de fonte (sourceKind = user). */
  sourceUserId: z.number().int().positive().nullable().default(null),
  module: z.enum(MAILBOX_MODULES),
  pipeline: z.enum(MAIL_PIPELINES).nullable().default(null),
  cityRule: z.enum(MAILBOX_CITY_RULES).default("all"),
  /** Vazio = todos os papéis com acesso ao módulo; senão só estes (super_admin sempre). */
  visibleRoles: z.array(z.enum(ROLES as unknown as [Role, ...Role[]])).max(ROLES.length).default([]),
  /** Assinatura (texto) por marca; vazio = sem assinatura. */
  signatures: z.partialRecord(z.enum(MAIL_BRAND_IDS), z.string().max(4000)).default({}),
  /** Recebe o que chega à conta e não corresponde a nenhuma outra caixa. */
  catchAll: z.boolean().default(false),
  /** Notificar (mail_new) quem vê a caixa quando chega uma conversa nova. */
  notify: z.boolean().default(true),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(999).default(100),
}).superRefine((v, ctx) => {
  if (v.sourceKind === "dwd" && !v.sourceEmail) ctx.addIssue({ code: "custom", message: "Indica a conta Google (Workspace) de onde se lê esta caixa." });
  if (v.sourceKind === "user" && !v.sourceUserId) ctx.addIssue({ code: "custom", message: "Escolhe o utilizador cuja conta Google ligada serve esta caixa." });
  const seen = new Set<string>();
  for (const a of v.addresses) {
    if (seen.has(a.address)) ctx.addIssue({ code: "custom", message: `Endereço repetido: ${a.address}.` });
    seen.add(a.address);
  }
});
export type MailboxConfig = z.output<typeof mailboxConfigSchema>;

/** Chave da conta de sincronização de uma caixa ("dwd:email" / "user:id"). PURA. */
export function sourceAccountKey(m: Pick<MailboxConfig, "sourceKind" | "sourceEmail" | "sourceUserId">): string | null {
  if (m.sourceKind === "dwd") return m.sourceEmail ? `dwd:${normalizeAddress(m.sourceEmail)}` : null;
  return m.sourceUserId ? `user:${m.sourceUserId}` : null;
}
export const personalAccountKey = (userId: number) => `user:${userId}`;

/** "user:12" → 12; senão null. PURA. */
export function userIdOfAccountKey(key: string | null | undefined): number | null {
  const m = /^user:(\d+)$/.exec(String(key ?? ""));
  return m ? Number(m[1]) : null;
}

/**
 * Caixas por omissão (semeadas UMA vez pela migração 0145). Os endereços de
 * info@/admin@/comercial@ e as contas de origem são pontos de partida — o
 * dono edita-os em Definições → Comunicação.
 */
export const DEFAULT_MAILBOX_SOURCE = "reservas@multipark.pt";

// ─── Classificação (alias → caixa → marca) ──────────────────────────────────

export interface MessageRecipients {
  deliveredTo?: readonly string[];
  xOriginalTo?: readonly string[];
  to?: readonly string[];
  cc?: readonly string[];
  bcc?: readonly string[];
  from?: string | null;
}

export interface Classification {
  mailboxKey: string | null;
  brand: MailBrand | null;
  /** Endereço (alias) pelo qual a mensagem entrou/saiu na caixa. */
  matchedAddress: string | null;
  /** Conversa da caixa pessoal (conta ligada de um utilizador, sem caixa partilhada). */
  personal: boolean;
}

/**
 * Em que caixa cai uma mensagem de uma conta. Ordem dos sinais (o mais fiável
 * primeiro): Delivered-To, X-Original-To, To, Cc, Bcc; nas mensagens ENVIADAS
 * conta o From (o alias com que saiu). Sem correspondência: caixa "apanha
 * tudo" da conta; conta pessoal → "O meu email"; senão sem caixa (fica
 * guardada, visível só na administração). PURA.
 */
export function classifyMessage(
  r: MessageRecipients,
  mailboxes: readonly Pick<MailboxConfig, "key" | "addresses" | "catchAll" | "active">[],
  opts: { outbound?: boolean; personalOwner?: boolean; brandDomains?: Record<string, string[]> } = {},
): Classification {
  const active = mailboxes.filter((m) => m.active);
  const order: string[] = opts.outbound
    ? [...(r.from ? [r.from] : [])]
    : [...(r.deliveredTo ?? []), ...(r.xOriginalTo ?? []), ...(r.to ?? []), ...(r.cc ?? []), ...(r.bcc ?? [])];
  const candidates = order.map(normalizeAddress).filter(Boolean);
  for (const addr of candidates) {
    for (const m of active) {
      const hit = m.addresses.find((a) => normalizeAddress(a.address) === addr);
      if (hit) return { mailboxKey: m.key, brand: hit.brand, matchedAddress: addr, personal: false };
    }
  }
  const brandAddr = candidates.find((a) => brandOfAddress(a, opts.brandDomains));
  const brand = brandAddr ? brandOfAddress(brandAddr, opts.brandDomains) : null;
  if (opts.personalOwner) return { mailboxKey: null, brand, matchedAddress: brandAddr ?? null, personal: true };
  const catchAll = active.find((m) => m.catchAll);
  return { mailboxKey: catchAll?.key ?? null, brand: brand ?? catchAll?.addresses[0]?.brand ?? null, matchedAddress: brandAddr ?? null, personal: false };
}

/** A mensagem entra no pipeline antigo (ocorrências por assunto, como o IMAP fazia)? PURA. */
export function pipelineFor(
  mailbox: Pick<MailboxConfig, "pipeline"> | null | undefined,
  subject: string | null | undefined,
  accountPipelines: readonly MailPipeline[] = [],
): MailPipeline | null {
  if (mailbox?.pipeline) return mailbox.pipeline;
  // O IMAP apanhava também reencaminhamentos para a caixa principal com
  // "ocorrência" no assunto (enquanto o alias próprio não existia).
  if (accountPipelines.includes("ocorrencias") && /ocorr[eê]ncias?/i.test(String(subject ?? ""))) return "ocorrencias";
  return null;
}

// ─── Quem vê o quê ──────────────────────────────────────────────────────────

export interface MailViewer {
  id: number;
  role: string | null | undefined;
  accessOverrides?: AccessOverrides | null;
}

/** Pode ver a caixa partilhada (ignora a cidade — ver `mailboxCityRestricted`)? PURA. */
export function canSeeMailbox(v: MailViewer | null | undefined, m: Pick<MailboxConfig, "module" | "visibleRoles" | "active">): boolean {
  if (!v) return false;
  if (v.role === "super_admin") return true;
  if (!m.active) return false;
  if (!can(v, "comunicacao", "view")) return false;
  const g = grantFor(v, m.module);
  if (g.access === "none" || g.access === "own" || !g.actions.includes("view")) return false;
  if (m.visibleRoles.length && !(m.visibleRoles as readonly string[]).includes(String(v.role))) return false;
  return true;
}

/** Pode responder/atribuir/mudar estado na caixa? PURA. */
export function canActOnMailbox(v: MailViewer | null | undefined, m: Pick<MailboxConfig, "module" | "visibleRoles" | "active">): boolean {
  return canSeeMailbox(v, m) && (v!.role === "super_admin" || can(v, "comunicacao", "edit"));
}

/**
 * Só vê as conversas ligadas à sua cidade? (regra "linked" + alcance de
 * cidade no módulo comunicacao). PURA.
 */
export function mailboxCityRestricted(v: MailViewer, m: Pick<MailboxConfig, "cityRule">): boolean {
  if (m.cityRule !== "linked" || v.role === "super_admin") return false;
  return grantFor(v, "comunicacao").access !== "national";
}

/** "O meu email": o próprio; o super_admin vê todas (regra do dono). PURA. */
export function canSeePersonalMailbox(v: Pick<MailViewer, "id" | "role"> | null | undefined, ownerUserId: number | null | undefined): boolean {
  if (!v || ownerUserId == null) return false;
  return v.id === ownerUserId || v.role === "super_admin";
}

/** Só o próprio envia pela sua conta pessoal (nem o super_admin envia em nome de outro). PURA. */
export function canSendFromPersonalMailbox(v: Pick<MailViewer, "id"> | null | undefined, ownerUserId: number | null | undefined): boolean {
  return !!v && ownerUserId != null && v.id === ownerUserId;
}

// ─── Enviar como (alias) ────────────────────────────────────────────────────

export interface SendAsEntry { sendAsEmail?: string | null; verificationStatus?: string | null; isPrimary?: boolean | null; isDefault?: boolean | null; displayName?: string | null }

/**
 * Endereço com que se responde: o alias pelo qual o cliente escreveu (se for
 * da caixa), senão o 1.º endereço da caixa na marca da conversa, senão o 1.º
 * da caixa. `requested` (escolha na UI) só vale se for da caixa. PURA.
 */
export function pickFromAddress(
  mailbox: Pick<MailboxConfig, "addresses">,
  opts: { requested?: string | null; matchedAddress?: string | null; brand?: MailBrand | null } = {},
): string | null {
  const own = mailbox.addresses.map((a) => normalizeAddress(a.address));
  const req = normalizeAddress(opts.requested);
  if (req && own.includes(req)) return req;
  const matched = normalizeAddress(opts.matchedAddress);
  if (matched && own.includes(matched)) return matched;
  const byBrand = opts.brand ? mailbox.addresses.find((a) => a.brand === opts.brand) : null;
  return byBrand ? normalizeAddress(byBrand.address) : own[0] ?? null;
}

export type SendAsCheck = { ok: true; email: string; displayName: string | null } | { ok: false; error: string };

/**
 * O alias está configurado como "Enviar como" (e verificado) na conta do
 * Gmail? Erro claro em PT-PT quando não está. PURA.
 */
export function checkSendAs(from: string | null | undefined, account: string, list: readonly SendAsEntry[]): SendAsCheck {
  const want = normalizeAddress(from);
  if (!want) return { ok: false, error: "Sem endereço de envio para esta caixa — configura os endereços em Definições → Comunicação." };
  const hit = list.find((s) => normalizeAddress(s.sendAsEmail) === want);
  if (!hit) {
    return { ok: false, error: `O endereço ${want} não está configurado como "Enviar email como" na conta ${account}. Um administrador tem de o adicionar no Gmail (Definições → Contas → Enviar email como) ou como alias no Google Workspace.` };
  }
  const status = String(hit.verificationStatus ?? "accepted").toLowerCase();
  if (!hit.isPrimary && status !== "accepted") {
    return { ok: false, error: `O endereço ${want} ainda não foi verificado na conta ${account} (estado: ${status}). Confirma a verificação no Gmail antes de enviar.` };
  }
  return { ok: true, email: want, displayName: hit.displayName ?? null };
}

// ─── Estado, SLA e retenção ─────────────────────────────────────────────────

export const MAIL_THREAD_STATUSES = ["aberto", "pendente", "resolvido"] as const;
export type MailThreadStatus = (typeof MAIL_THREAD_STATUSES)[number];
export const MAIL_THREAD_STATUS_LABELS: Record<MailThreadStatus, string> = { aberto: "Aberta", pendente: "Pendente", resolvido: "Resolvida" };

export const MAIL_DEFAULT_SLA_HOURS = 24;
export const MAIL_DEFAULT_RETENTION_YEARS = 5;
export const MAIL_DEFAULT_BACKFILL_DAYS = 90;

/** Por responder há mais do que o SLA? PURA. */
export function isMailOverdue(awaitingSince: string | null | undefined, slaHours: number, now = Date.now()): boolean {
  if (!awaitingSince) return false;
  const t = Date.parse(String(awaitingSince).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(awaitingSince)) ? "" : "Z"));
  return Number.isFinite(t) && now - t > slaHours * 3_600_000;
}

/** Limite da retenção ("YYYY-MM-DD HH:MM:SS", UTC): mais antigo do que isto e sem ligações → apaga. PURA. */
export function retentionCutoff(years: number, now: Date = new Date()): string {
  const y = Math.max(1, Math.floor(years || MAIL_DEFAULT_RETENTION_YEARS));
  const d = new Date(Date.UTC(now.getUTCFullYear() - y, now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds()));
  return d.toISOString().slice(0, 19).replace("T", " ");
}

// ─── Ligações (mensagem/conversa ↔ registo) ─────────────────────────────────

export const MAIL_LINK_TYPES = ["client", "booking", "complaint", "lost_found", "incident"] as const;
export type MailLinkType = (typeof MAIL_LINK_TYPES)[number];
export const MAIL_LINK_LABELS: Record<MailLinkType, string> = {
  client: "Cliente",
  booking: "Reserva",
  complaint: "Reclamação",
  lost_found: "Perdidos e Achados",
  incident: "Ocorrência",
};
/** Módulo que dá acesso à timeline de cada tipo de registo. */
export const MAIL_LINK_MODULE: Record<MailLinkType, ModuleId> = {
  client: "clientes",
  booking: "reservas_operacoes",
  complaint: "reclamacoes",
  lost_found: "perdidos",
  incident: "ocorrencias",
};

/** Id canónico do registo ligado (email em minúsculas; números como texto). PURA. */
export function normalizeLinkEntityId(type: MailLinkType, id: string | number): string {
  const s = String(id ?? "").trim();
  if (type === "client") return normalizeAddress(s);
  if (type === "booking") return s.slice(0, 100);
  return /^\d+$/.test(s) ? String(Number(s)) : "";
}

/** Confiança mínima para uma ligação automática contar. */
export const AUTO_LINK_MIN_CONFIDENCE = 50;

// ─── Âmbitos Google (autorização incremental) ───────────────────────────────

/** Funcionalidades que pedem acesso Google — cada uma pede só o que precisa. */
export const GOOGLE_FEATURES = ["gmail", "calendar", "tasks", "drive", "contacts"] as const;
export type GoogleFeature = (typeof GOOGLE_FEATURES)[number];
export const GOOGLE_FEATURE_LABELS: Record<GoogleFeature, string> = {
  gmail: "Email (Gmail)",
  calendar: "Calendário",
  tasks: "Tarefas",
  drive: "Drive",
  contacts: "Contactos",
};
/** Só o Gmail está ligado por agora; os outros ficam preparados (hooks). */
export const GOOGLE_FEATURES_ENABLED: readonly GoogleFeature[] = ["gmail"];
export const GOOGLE_FEATURE_SCOPES: Record<GoogleFeature, readonly string[]> = {
  gmail: ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.send"],
  calendar: ["https://www.googleapis.com/auth/calendar.events"],
  tasks: ["https://www.googleapis.com/auth/tasks"],
  drive: ["https://www.googleapis.com/auth/drive.file"],
  contacts: ["https://www.googleapis.com/auth/contacts.readonly"],
};

/** A conta tem todos os âmbitos da funcionalidade? PURA. */
export function hasFeatureScopes(granted: string | readonly string[] | null | undefined, feature: GoogleFeature): boolean {
  const list = Array.isArray(granted) ? granted : String(granted ?? "").split(/[\s,]+/);
  const set = new Set(list.filter(Boolean));
  return GOOGLE_FEATURE_SCOPES[feature].every((s) => set.has(s));
}

/**
 * A identidade Google pertence ao Workspace da empresa? Exige email
 * verificado e o `hd` (domínio hospedado) numa das listas permitidas — uma
 * conta @gmail.com (sem `hd`) é recusada. PURA.
 */
export function isAllowedWorkspaceIdentity(
  id: { email?: string | null; email_verified?: unknown; hd?: string | null },
  allowedDomains: readonly string[],
): { ok: true; email: string } | { ok: false; error: string } {
  const email = normalizeAddress(id.email);
  const verified = id.email_verified === true || String(id.email_verified).toLowerCase() === "true";
  if (!email || !verified) return { ok: false, error: "A Google não confirmou o email desta conta." };
  const domains = allowedDomains.map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (!domains.length) return { ok: false, error: "Nenhum domínio do Workspace configurado (GOOGLE_WORKSPACE_DOMAINS)." };
  const hd = String(id.hd ?? "").trim().toLowerCase();
  if (!hd || !domains.includes(hd)) return { ok: false, error: `Só contas Google do Workspace da empresa (${domains.join(", ")}). Esta conta (${email}) não pertence ao Workspace.` };
  return { ok: true, email };
}

/** "multipark.pt, skypark.pt" → ["multipark.pt","skypark.pt"]. PURA. */
export function parseDomainList(raw: string | null | undefined): string[] {
  return Array.from(new Set(String(raw ?? "").split(/[\s,;]+/).map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean)));
}
