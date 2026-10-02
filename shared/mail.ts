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
  // multivalet.pt é da Multipark (não há marca Multivalet).
  multipark: ["multipark.pt", "multipark.app", "multivalet.pt"],
  multibags: ["multibags.pt", "multibags.app"],
  redpark: ["redpark.pt"],
  skypark: ["skypark.pt"],
  // airpark.pt e multidriver.pt ainda não estão no Workspace (ficam para quando entrarem).
  airpark: ["airpark.pt"],
  multidriver: ["multidriver.pt"],
};

/**
 * Google Workspace da empresa (dono, 27 set 2026): domínio principal
 * multipark.pt + "domínios alternativos" (alias domains). Num domínio
 * alternativo, TODOS os endereços do domínio principal (utilizadores e
 * aliases de utilizador) funcionam automaticamente — reclamacoes@skypark.pt
 * chega à conta dona de reclamacoes@multipark.pt sem configurar nada.
 * A lista é sobreponível em Definições → Parâmetros (`mail.aliasDomains`).
 */
export const MAIL_WORKSPACE_PRIMARY_DOMAIN = "multipark.pt";
export const DEFAULT_MAIL_ALIAS_DOMAINS: readonly string[] = ["skypark.pt", "redpark.pt", "multibags.pt", "multivalet.pt", "multibags.app", "multipark.app"];

/** Domínios equivalentes do Workspace: o principal + os alternativos (sem repetidos, minúsculas). PURA. */
export function workspaceDomainsOf(aliasDomains: readonly string[] | null | undefined = DEFAULT_MAIL_ALIAS_DOMAINS, primary: string = MAIL_WORKSPACE_PRIMARY_DOMAIN): string[] {
  const out: string[] = [];
  for (const d of [primary, ...(aliasDomains ?? [])]) {
    const x = String(d ?? "").trim().toLowerCase().replace(/^@/, "");
    if (x && !out.includes(x)) out.push(x);
  }
  return out;
}

/**
 * O mesmo endereço nos outros domínios do Workspace (reclamacoes@skypark.pt →
 * reclamacoes@multipark.pt, reclamacoes@redpark.pt…), o principal primeiro.
 * Vazio se o domínio não for do Workspace. PURA.
 */
export function domainAliasVariants(address: string | null | undefined, workspaceDomains: readonly string[] | null | undefined): string[] {
  const a = normalizeAddress(address);
  const at = a.lastIndexOf("@");
  if (at <= 0 || !workspaceDomains?.length) return [];
  const local = a.slice(0, at);
  const domain = a.slice(at + 1);
  const domains = workspaceDomains.map((d) => String(d ?? "").trim().toLowerCase()).filter(Boolean);
  if (!domains.includes(domain)) return [];
  return domains.filter((d) => d !== domain).map((d) => `${local}@${d}`);
}

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

// ─── Notificações automáticas de reserva (decisão do dono, 26 set 2026) ────
//
// As ~4000 notificações automáticas "Nova Reserva" por mês que a Multipark
// manda para a caixa "Reservas (geral)" ficam GUARDADAS, mas escondidas por
// omissão nas listas da Comunicação ("Mostrar automáticos" desligado); a
// pesquisa continua a encontrá-las. Mesma heurística do pipeline antigo
// (server/emailParse.ts isReservationNotification + remetente interno).

/** mail_messages.automated: 0 = pessoa, 1 = remetente automático, 2 = notificação automática de reserva, 3 = email de sistema do dashboard. */
export const MAIL_AUTOMATED_RESERVATION = 2;
/**
 * Email de sistema enviado pelo próprio dashboard (notificações, briefing,
 * escala, tarefas, formações…) pela API do Gmail: leva o cabeçalho
 * `X-Multipark-System` e, quando a sincronização o encontra (enviados da
 * conta remetente ou recebido numa caixa), fica automático e escondido —
 * nunca aparece como conversa de cliente na Comunicação.
 */
export const MAIL_AUTOMATED_SYSTEM = 3;
export const SYSTEM_MAIL_HEADER = "X-Multipark-System";
/** Valores de mail_messages.automated que tornam a conversa "automática" (escondida por omissão). */
export const MAIL_HIDDEN_AUTOMATED_VALUES: readonly number[] = [MAIL_AUTOMATED_RESERVATION, MAIL_AUTOMATED_SYSTEM];

// ─── Envios automáticos da aplicação (set 2026) ─────────────────────────────
//
// TODOS os emails que a aplicação envia sozinha (pedidos e lembretes de
// disponibilidade aos extras, avisos de escala, lembretes de formação,
// notificações…) levam `X-Multipark-System: 1` + `X-Multipark-Auto: <tipo>`
// + `Auto-Submitted: auto-generated`, mesmo quando saem por um alias
// (recursos-humanos@). A sincronização guarda-os como automáticos (3): a
// conversa só com envios nossos fica escondida na Comunicação (fora das
// contagens de não lidas / por responder / abertas). Se a pessoa responder,
// a resposta (humana) torna a conversa normal. Os envios ligados a um
// colaborador/extra ficam também em `mail_auto_sends` (ficha do extra →
// "Comunicações automáticas").

/** Cabeçalho com o tipo do envio automático (ver AUTO_MAIL_KIND_LABELS). */
export const AUTO_MAIL_HEADER = "X-Multipark-Auto";

export const AUTO_MAIL_KIND_LABELS: Record<string, string> = {
  availability_request: "Pedido de disponibilidade",
  availability_reminder: "Lembrete de disponibilidade",
  availability_test: "Pedido de disponibilidade (teste)",
  schedule_notice: "Aviso de escala",
  schedule_cancel: "Turno cancelado",
  training_reminder: "Lembrete de formação",
  task_notice: "Aviso de tarefa",
  handover: "Passagem de turno",
  report: "Relatório",
  notification: "Notificação",
  owner_alert: "Alerta ao dono",
  system: "Email de sistema",
};

export function autoMailKindLabel(kind: string | null | undefined): string {
  const k = String(kind ?? "").trim();
  return AUTO_MAIL_KIND_LABELS[k] ?? (k || "Automático");
}

/** Tipo do envio automático guardado no cabeçalho (só letras, dígitos e _; máx. 40). PURA. */
export function normalizeAutoMailKind(v: string | null | undefined): string | null {
  const k = String(v ?? "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return k || null;
}

/**
 * Assuntos das automações (para os emails antigos, enviados antes do
 * cabeçalho existir). Só assuntos gerados pelo código — nunca Re:/Fwd:.
 */
const AUTO_SUBJECTS: ReadonlyArray<{ re: RegExp; kind: string }> = [
  { re: /^\[TESTE\]\s*(Disponibilidade\s*[—–-]\s*semana de |Estás disponível .+ no turno |Que horas podes fazer |Preciso de um condutor )/i, kind: "availability_test" },
  { re: /^Disponibilidade\s*[—–-]\s*semana de /i, kind: "availability_request" },
  { re: /^Estás disponível .+ no turno .+\?$/i, kind: "availability_request" },
  { re: /^Que horas podes fazer .+\?$/i, kind: "availability_request" },
  { re: /^Preciso de um condutor .+ das \d{1,2}h às \d{1,2}h$/i, kind: "availability_request" },
  { re: /^Escala Multipark\s*[—–-]\s*turno cancelado/i, kind: "schedule_cancel" },
  { re: /^Escala Multipark\s*[—–-]\s*/i, kind: "schedule_notice" },
  { re: /^Formação por concluir\s*[—–-]\s*/i, kind: "training_reminder" },
  { re: /^\[Dashboard Multipark\]\s/i, kind: "notification" },
];

/** Remetentes das automações (além do remetente de sistema configurado). */
export const AUTO_MAIL_SENDERS: readonly string[] = ["recursos-humanos@multipark.pt", "reservas@multipark.pt"];

/**
 * Envio automático da aplicação? Pelo cabeçalho (X-Multipark-System /
 * X-Multipark-Auto) ou, para os antigos, por um remetente das automações +
 * assunto conhecido. Só mensagens ENVIADAS por nós. Devolve o tipo ou null.
 * PURA.
 */
export function automaticOutboundKind(
  m: { outbound: boolean; fromEmail?: string | null; subject?: string | null; systemHeader?: boolean; autoKind?: string | null },
  senders: readonly string[] = AUTO_MAIL_SENDERS,
): string | null {
  const headerKind = normalizeAutoMailKind(m.autoKind);
  if (headerKind) return headerKind;
  if (m.systemHeader) return "system";
  if (!m.outbound) return null;
  const from = normalizeAddress(m.fromEmail);
  if (!from || !senders.some((s) => normalizeAddress(s) === from)) return null;
  const subject = String(m.subject ?? "").trim();
  if (!subject || REPLY_OR_FORWARD.test(subject)) return null;
  for (const s of AUTO_SUBJECTS) if (s.re.test(subject)) return s.kind;
  return null;
}

/**
 * Conversa automática (escondida)? Só quando TODAS as mensagens são
 * automáticas escondidas (notificação de reserva ou envio da aplicação). Uma
 * resposta de uma pessoa (0) torna-a normal. Mesma regra que o SQL de
 * server/mail/store.ts recomputeThread e da migração 0220. PURA.
 */
export function threadIsAutomatic(messageAutomated: readonly number[]): boolean {
  return messageAutomated.length > 0 && messageAutomated.every((v) => MAIL_HIDDEN_AUTOMATED_VALUES.includes(Number(v)));
}

/**
 * Estado de um envio automático na ficha do extra: "respondido" quando a
 * conversa já tem uma mensagem recebida de uma pessoa (deixou de ser
 * automática); senão "enviado". PURA.
 */
export function autoSendStatus(t: { threadAutomated?: number | boolean | null; lastInboundAt?: string | null } | null | undefined): "enviado" | "respondido" {
  if (!t) return "enviado";
  const automated = t.threadAutomated == null ? null : Number(t.threadAutomated) === 1;
  return automated === false && !!t.lastInboundAt ? "respondido" : "enviado";
}

const RESERVATION_NOTICE_SUBJECT = /nova reserva/i;
const REPLY_OR_FORWARD = /^\s*(re|res|fw|fwd|enc|reenc|tr)\s*:/i;
const INTERNAL_SENDER = /@(multipark|skypark)\.(pt|app)$/;

/**
 * Notificação automática de reserva enviada pelo próprio sistema (assunto
 * "Nova Reserva…" de um endereço interno; respostas/reencaminhamentos não
 * contam — podem trazer contexto humano). PURA.
 */
export function isReservationNotificationEmail(m: { fromEmail?: string | null; fromName?: string | null; subject?: string | null; outbound?: boolean }, domains: Record<string, string[]> = DEFAULT_BRAND_DOMAINS): boolean {
  if (m.outbound) return false;
  const subject = String(m.subject ?? "");
  if (REPLY_OR_FORWARD.test(subject)) return false;
  const byName = /nova reserva\s*-\s*skypark/i.test(String(m.fromName ?? ""));
  if (!RESERVATION_NOTICE_SUBJECT.test(subject) && !byName) return false;
  const a = normalizeAddress(m.fromEmail);
  return INTERNAL_SENDER.test(a) || isCompanyAddress(a, domains);
}

/**
 * Esconder as conversas automáticas (notificações de reserva) nesta lista?
 * Escondidas por omissão; "Mostrar automáticos" mostra-as e a PESQUISA
 * encontra-as sempre. PURA.
 */
export function hideAutomaticThreads(input: { showAutomatic?: boolean | null; search?: string | null }): boolean {
  if (input.showAutomatic) return false;
  return !String(input.search ?? "").trim();
}

// ─── Configuração das caixas partilhadas ────────────────────────────────────

/** Pipeline temático (server/jobs/emailInboundSync.ts → processInboundEmail): o email cria o registo no módulo. */
export const MAIL_PIPELINES = ["criticas", "reclamacoes", "perdidos", "recursos-humanos", "campanhas", "ocorrencias"] as const;
export type MailPipeline = (typeof MAIL_PIPELINES)[number];
export const MAIL_PIPELINE_LABELS: Record<MailPipeline, string> = {
  criticas: "Críticas",
  reclamacoes: "Reclamações",
  perdidos: "Perdidos e Achados",
  "recursos-humanos": "Recursos Humanos",
  campanhas: "Campanhas",
  ocorrencias: "Ocorrências",
};
export const isMailPipeline = (v: unknown): v is MailPipeline => typeof v === "string" && (MAIL_PIPELINES as readonly string[]).includes(v);

/**
 * Destino de um alias na tabela de encaminhamento: "caixa" = o da caixa
 * (o pipeline dela, se tiver); "geral"/"reservas" = só a conversa na caixa
 * (sem criar registos); os restantes = pipeline temático.
 */
export const MAIL_ALIAS_DESTINATIONS = ["caixa", "geral", "reservas", ...MAIL_PIPELINES] as const;
export type MailAliasDestination = (typeof MAIL_ALIAS_DESTINATIONS)[number];
export const MAIL_ALIAS_DESTINATION_LABELS: Record<MailAliasDestination, string> = {
  caixa: "Como a caixa",
  geral: "Geral (só conversa)",
  reservas: "Reservas (só conversa)",
  ...MAIL_PIPELINE_LABELS,
};

/** Papéis que podem ser "equipa" responsável por um alias. */
export const MAIL_OWNER_ROLES = ["team_leader", "supervisor", "frontoffice", "backoffice", "admin", "super_admin"] as const;
export type MailOwnerRole = (typeof MAIL_OWNER_ROLES)[number];

/** Responsável de um alias: "user:<id>" (pessoa) ou "role:<papel>" (equipa = quem tem o papel). */
export const mailOwnerSchema = z.string().trim().regex(new RegExp(`^(user:[1-9]\\d{0,9}|role:(${MAIL_OWNER_ROLES.join("|")}))$`), "Responsável inválido.");
export type MailOwner = { kind: "user"; userId: number } | { kind: "role"; role: MailOwnerRole };

/** "user:12" / "role:backoffice" → responsável; resto → null. PURA. */
export function parseMailOwner(v: string | null | undefined): MailOwner | null {
  const s = String(v ?? "").trim();
  const u = /^user:([1-9]\d{0,9})$/.exec(s);
  if (u) return { kind: "user", userId: Number(u[1]) };
  const r = /^role:([a-z_]+)$/.exec(s);
  if (r && (MAIL_OWNER_ROLES as readonly string[]).includes(r[1])) return { kind: "role", role: r[1] as MailOwnerRole };
  return null;
}

/** Caixa virtual "Por classificar" (emails que chegaram por um endereço que não está na tabela de aliases). */
export const MAIL_TRIAGE_KEY = "por-classificar";
export const MAIL_TRIAGE_LABEL = "Por classificar";

/** Módulos da matriz a que uma caixa pode pertencer (quem a vê). */
export const MAILBOX_MODULES = [
  "comunicacao", "reclamacoes", "perdidos", "criticas", "ocorrencias", "rh", "leads_extras",
  "reservas_operacoes", "clientes", "marketing", "parcerias", "financeiro", "despesas", "servicos",
] as const satisfies readonly ModuleId[];
export type MailboxModule = (typeof MAILBOX_MODULES)[number];

export const MAILBOX_CITY_RULES = ["all", "linked"] as const;
export type MailboxCityRule = (typeof MAILBOX_CITY_RULES)[number];
export const MAILBOX_CITY_RULE_LABELS: Record<MailboxCityRule, string> = {
  all: "Todas as conversas (quem vê a caixa vê tudo)",
  linked: "Papéis de cidade só veem conversas ligadas à sua cidade",
};

const addressSchema = z.string().trim().toLowerCase().email("Endereço inválido.").max(320);

/**
 * Uma linha da tabela de encaminhamento por alias (Definições → Comunicação):
 * o endereço (qualquer domínio) por onde o email entrou → caixa, marca,
 * cidade, destino (pipeline), responsável, etiqueta. Guardada no
 * `addressesJson` da caixa (a mesma configuração, sem sistema paralelo);
 * os campos novos têm omissões — as caixas antigas continuam válidas.
 */
export const mailboxAddressSchema = z.object({
  address: addressSchema,
  brand: z.enum(MAIL_BRAND_IDS, { error: "Marca desconhecida." }),
  /** Cidade (id do nó "cidade" da árvore de projetos): a conversa fica dessa cidade. */
  cityId: z.number().int().positive().nullable().default(null),
  destination: z.enum(MAIL_ALIAS_DESTINATIONS, { error: "Destino desconhecido." }).default("caixa"),
  owner: mailOwnerSchema.nullable().default(null),
  /** Etiqueta mostrada na conversa (ex.: "Skypark Porto"). */
  tag: z.string().trim().max(40, "Etiqueta: máximo 40 caracteres.").default(""),
  /** Inativo = o endereço deixa de encaminhar (os emails por ele vão para "Por classificar"). */
  active: z.boolean().default(true),
});
export type MailboxAddress = z.infer<typeof mailboxAddressSchema>;

export const mailboxConfigSchema = z.object({
  key: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,39}$/, "Chave: 2–40 letras minúsculas, números, - ou _."),
  label: z.string().trim().min(1, "Indica o nome da caixa.").max(80),
  /** Endereços/aliases que chegam a esta caixa (e com que marca). Caixa por tema: pode não ter. */
  addresses: z.array(mailboxAddressSchema).max(300),
  /**
   * De onde se lê: conta do Workspace por delegação (service account), a conta
   * Google ligada de um utilizador, ou "tema" (17f): caixa por tema SEM conta
   * própria — recebe as conversas que a IA ou uma pessoa movem para lá
   * (email das caixas gerais e WhatsApp).
   */
  sourceKind: z.enum(["dwd", "user", "tema"]),
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
  /** 17f: a IA separa os emails novos desta caixa (geral) pelas caixas do tema (interruptor AI_MAIL_ROUTING). */
  aiRoute: z.boolean().default(false),
}).superRefine((v, ctx) => {
  if (v.sourceKind !== "tema" && !v.addresses.length) ctx.addIssue({ code: "custom", message: "Indica pelo menos um endereço." });
  if (v.sourceKind === "dwd" && !v.sourceEmail) ctx.addIssue({ code: "custom", message: "Indica a conta Google (Workspace) de onde se lê esta caixa." });
  if (v.sourceKind === "user" && !v.sourceUserId) ctx.addIssue({ code: "custom", message: "Escolhe o utilizador cuja conta Google ligada serve esta caixa." });
  const seen = new Set<string>();
  for (const a of v.addresses) {
    if (seen.has(a.address)) ctx.addIssue({ code: "custom", message: `Endereço repetido: ${a.address}.` });
    seen.add(a.address);
  }
});
export type MailboxConfig = z.output<typeof mailboxConfigSchema>;

/** Linha da tabela de aliases (Definições → Comunicação → Aliases): o alias + a caixa a que pertence. */
export const mailAliasRowSchema = mailboxAddressSchema.extend({
  mailboxKey: z.string().trim().min(1, "Escolhe a caixa.").max(40),
});
export type MailAliasRow = z.output<typeof mailAliasRowSchema>;

/** Caixas → tabela plana de aliases (pela ordem das caixas). PURA. */
export function aliasTableOf(mailboxes: readonly Pick<MailboxConfig, "key" | "addresses">[]): MailAliasRow[] {
  return mailboxes.flatMap((m) => m.addresses.map((a) => ({ ...a, mailboxKey: m.key })));
}

/**
 * Aplica a tabela de aliases editada às caixas: cada caixa fica com as suas
 * linhas (por ordem). Recusa endereços repetidos (um alias só encaminha para
 * UMA caixa), caixas desconhecidas e caixas que ficariam sem endereços.
 * Devolve só as caixas alteradas. PURA.
 */
export function applyAliasTable<M extends MailboxConfig>(mailboxes: readonly M[], rows: readonly MailAliasRow[]): { ok: true; changed: M[] } | { ok: false; error: string } {
  const keys = new Set(mailboxes.map((m) => m.key));
  const seen = new Map<string, string>();
  const byBox = new Map<string, MailboxAddress[]>();
  for (const r of rows) {
    const addr = normalizeAddress(r.address);
    if (!keys.has(r.mailboxKey)) return { ok: false, error: `Caixa desconhecida: ${r.mailboxKey}.` };
    if (seen.has(addr)) return { ok: false, error: `O endereço ${addr} está repetido (caixas ${seen.get(addr)} e ${r.mailboxKey}) — cada alias encaminha para uma só caixa.` };
    seen.set(addr, r.mailboxKey);
    const { mailboxKey, ...alias } = r;
    byBox.set(mailboxKey, [...(byBox.get(mailboxKey) ?? []), { ...alias, address: addr }]);
  }
  const changed: M[] = [];
  for (const m of mailboxes) {
    const next = byBox.get(m.key) ?? [];
    if (!next.length) return { ok: false, error: `A caixa "${m.label}" ficaria sem endereços — mantém pelo menos um (ou apaga a caixa).` };
    if (JSON.stringify(next) !== JSON.stringify(m.addresses)) changed.push({ ...m, addresses: next });
  }
  return { ok: true, changed };
}

/** Chave da conta de sincronização de uma caixa ("dwd:email" / "user:id"). PURA. */
export function sourceAccountKey(m: Pick<MailboxConfig, "sourceKind" | "sourceEmail" | "sourceUserId">): string | null {
  if (m.sourceKind === "tema") return null; // caixa por tema: sem conta própria (17f)
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
  /** Linha da tabela de aliases que encaminhou a mensagem (null = nenhum alias conhecido). */
  alias?: MailboxAddress | null;
  /** Cabeçalho onde o alias foi encontrado. */
  via?: AliasHeader | null;
  /** Recebida numa caixa partilhada por um endereço que não está na tabela → "Por classificar". */
  triage?: boolean;
}

/** Cabeçalhos por ordem de confiança (as enviadas usam o From). */
export const ALIAS_HEADER_ORDER = ["delivered-to", "x-original-to", "to", "cc", "bcc"] as const;
export type AliasHeader = (typeof ALIAS_HEADER_ORDER)[number] | "from";

export interface AliasResolution {
  mailboxKey: string | null;
  alias: MailboxAddress | null;
  matchedAddress: string | null;
  via: AliasHeader | null;
  /**
   * Linha encontrada pelo domínio alternativo do Workspace (o endereço
   * configurado na tabela — ex.: reclamacoes@multipark.pt — quando o email
   * chegou a reclamacoes@skypark.pt); null = correspondência exata.
   */
  domainAliasOf?: string | null;
}

/**
 * Resolve o alias pelo qual a mensagem chegou: percorre Delivered-To →
 * X-Original-To → To → Cc → Bcc (nas ENVIADAS, o From) e devolve a primeira
 * linha ATIVA da tabela de aliases (caixas ativas) que corresponde, em
 * qualquer domínio. O Delivered-To igual à própria conta de origem
 * (reservas@/info@) não diz nada — no Google Workspace é sempre o endereço
 * principal da caixa — e é saltado; o alias vem nos cabeçalhos seguintes.
 * Um endereço que esteja em duas caixas conta na primeira (ordem da lista).
 *
 * Domínios alternativos do Workspace (`workspaceDomains` = principal +
 * alternativos; vazio = desligado): um endereço que não está na tabela mas
 * cujo nome local existe noutro domínio do Workspace (reclamacoes@skypark.pt
 * ↔ reclamacoes@multipark.pt) conta como esse alias. A correspondência
 * EXATA ganha sempre: em cada cabeçalho procuram-se primeiro os endereços
 * exatos e só depois os equivalentes por domínio (e um cabeçalho mais fiável
 * ganha a um menos fiável, como antes). A marca vem do domínio para onde o
 * email foi mesmo enviado (`brandOfAddress`), senão a do alias; o resto
 * (caixa, destino, responsável, cidade, etiqueta) é o do alias. Um endereço
 * que está na tabela mas inativo NÃO é reencaminhado pelo domínio
 * alternativo (foi desligado de propósito → "Por classificar"). PURA.
 */
export function resolveAlias(
  r: MessageRecipients,
  mailboxes: readonly Pick<MailboxConfig, "key" | "addresses" | "active">[],
  opts: { outbound?: boolean; accountEmails?: readonly (string | null | undefined)[]; workspaceDomains?: readonly string[] | null; brandDomains?: Record<string, string[]> } = {},
): AliasResolution {
  const index = new Map<string, { key: string; alias: MailboxAddress }>();
  // Endereços escritos na tabela (mesmo inativos / de caixas inativas): um
  // alias desligado de propósito nunca volta a encaminhar pelo domínio alternativo.
  const configured = new Set<string>();
  for (const m of mailboxes) {
    for (const a of m.addresses) {
      const k = normalizeAddress(a.address);
      if (!k) continue;
      configured.add(k);
      if (!m.active || a.active === false) continue;
      if (!index.has(k)) index.set(k, { key: m.key, alias: a as MailboxAddress });
    }
  }
  const ws = opts.workspaceDomains ?? [];
  const accounts = new Set<string>();
  for (const e of opts.accountEmails ?? []) {
    const a = normalizeAddress(e);
    if (!a) continue;
    accounts.add(a);
    // A própria conta num domínio alternativo (reservas@multivalet.pt) também é "a conta".
    for (const v of domainAliasVariants(a, ws)) accounts.add(v);
  }
  const ordered: Array<[AliasHeader, readonly string[] | undefined]> = opts.outbound
    ? [["from", r.from ? [r.from] : []]]
    : [["delivered-to", r.deliveredTo], ["x-original-to", r.xOriginalTo], ["to", r.to], ["cc", r.cc], ["bcc", r.bcc]];
  for (const [via, list] of ordered) {
    const addrs = (list ?? []).map(normalizeAddress).filter((a) => a && !(via === "delivered-to" && accounts.has(a)));
    for (const addr of addrs) {
      const hit = index.get(addr);
      if (hit) return { mailboxKey: hit.key, alias: hit.alias, matchedAddress: addr, via, domainAliasOf: null };
    }
    if (!ws.length) continue;
    for (const addr of addrs) {
      if (configured.has(addr)) continue;
      for (const v of domainAliasVariants(addr, ws)) {
        const hit = index.get(v);
        if (!hit) continue;
        const brand = brandOfAddress(addr, opts.brandDomains) ?? hit.alias.brand;
        return { mailboxKey: hit.key, alias: { ...hit.alias, brand }, matchedAddress: addr, via, domainAliasOf: normalizeAddress(hit.alias.address) };
      }
    }
  }
  return { mailboxKey: null, alias: null, matchedAddress: null, via: null, domainAliasOf: null };
}

/**
 * Em que caixa cai uma mensagem de uma conta: o alias (ver `resolveAlias`)
 * dá a caixa e a marca. Sem alias conhecido: conta pessoal → "O meu email";
 * caixa partilhada → fica marcada "Por classificar" (triage) e, se houver,
 * guardada na caixa "apanha tudo" da conta até alguém a atribuir. PURA.
 */
export function classifyMessage(
  r: MessageRecipients,
  mailboxes: readonly Pick<MailboxConfig, "key" | "addresses" | "catchAll" | "active">[],
  opts: {
    outbound?: boolean; personalOwner?: boolean; brandDomains?: Record<string, string[]>; accountEmails?: readonly (string | null | undefined)[];
    /** Domínios equivalentes do Workspace (`workspaceDomainsOf`); vazio = sem correspondência por domínio alternativo. */
    workspaceDomains?: readonly string[] | null;
  } = {},
): Classification {
  const hit = resolveAlias(r, mailboxes, { outbound: opts.outbound, accountEmails: opts.accountEmails, workspaceDomains: opts.workspaceDomains, brandDomains: opts.brandDomains });
  if (hit.mailboxKey && hit.alias) {
    return { mailboxKey: hit.mailboxKey, brand: hit.alias.brand, matchedAddress: hit.matchedAddress, personal: false, alias: hit.alias, via: hit.via, triage: false };
  }
  const active = mailboxes.filter((m) => m.active);
  const order: string[] = opts.outbound
    ? [...(r.from ? [r.from] : [])]
    : [...(r.deliveredTo ?? []), ...(r.xOriginalTo ?? []), ...(r.to ?? []), ...(r.cc ?? []), ...(r.bcc ?? [])];
  const candidates = order.map(normalizeAddress).filter(Boolean);
  // O endereço "interessante" é o da empresa que não é a própria conta (ex.: o alias por configurar).
  const own = new Set((opts.accountEmails ?? []).map(normalizeAddress).filter(Boolean));
  const brandAddr = candidates.find((a) => !own.has(a) && brandOfAddress(a, opts.brandDomains)) ?? candidates.find((a) => brandOfAddress(a, opts.brandDomains));
  const brand = brandAddr ? brandOfAddress(brandAddr, opts.brandDomains) : null;
  if (opts.personalOwner) return { mailboxKey: null, brand, matchedAddress: brandAddr ?? null, personal: true, alias: null, via: null, triage: false };
  const catchAll = active.find((m) => m.catchAll);
  return {
    mailboxKey: catchAll?.key ?? null, brand: brand ?? catchAll?.addresses[0]?.brand ?? null, matchedAddress: brandAddr ?? null, personal: false,
    alias: null, via: null, triage: !opts.outbound,
  };
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

/**
 * Pipeline de uma mensagem encaminhada por um alias: o destino do alias manda
 * (pipeline, ou "geral"/"reservas" = nenhum); "como a caixa" → `pipelineFor`. PURA.
 */
export function aliasPipeline(
  mailbox: Pick<MailboxConfig, "pipeline"> | null | undefined,
  alias: Pick<MailboxAddress, "destination"> | null | undefined,
  subject: string | null | undefined,
  accountPipelines: readonly MailPipeline[] = [],
): MailPipeline | null {
  const d = alias?.destination ?? "caixa";
  if (isMailPipeline(d)) return d;
  if (d === "geral" || d === "reservas") return null;
  return pipelineFor(mailbox, subject, accountPipelines);
}

/** Pipelines que a configuração encaminha (caixa com pipeline ou alias com destino). PURA. */
export function configuredPipelines(mailboxes: readonly Pick<MailboxConfig, "active" | "pipeline" | "addresses">[]): Map<MailPipeline, number> {
  const out = new Map<MailPipeline, number>();
  const add = (p: MailPipeline) => out.set(p, (out.get(p) ?? 0) + 1);
  for (const m of mailboxes) {
    if (!m.active) continue;
    for (const a of m.addresses) {
      if (a.active === false) continue;
      const p = aliasPipeline(m, a, null);
      if (p) add(p);
    }
  }
  return out;
}

export interface MailSourceHealth { accountKey: string; status: string | null; lastOkAt: string | Date | null }

/**
 * Avisos do encaminhamento por alias para Integrações/Estado: pipeline sem
 * nenhum alias/caixa a alimentá-lo e caixas (e os pipelines delas) cuja conta
 * Gmail de origem não está ligada ou não sincroniza há mais de `staleHours`.
 * Sem IMAP de reserva: um pipeline sem Gmail saudável NÃO cria registos. PURA.
 */
export function mailRoutingWarnings(input: {
  mailboxes: readonly MailboxConfig[];
  accounts: readonly MailSourceHealth[];
  dwdAvailable: boolean;
  now?: number;
  staleHours?: number;
}): string[] {
  const now = input.now ?? Date.now();
  const staleMs = (input.staleHours ?? 2) * 3_600_000;
  const byKey = new Map(input.accounts.map((a) => [a.accountKey, a]));
  const parseUtc = (s: string | Date | null) => (s instanceof Date ? s.getTime() : s ? Date.parse(String(s).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(s)) ? "" : "Z")) : NaN);
  const problemOf = (m: MailboxConfig): string | null => {
    const key = sourceAccountKey(m);
    if (!key) return "sem conta Google de origem";
    if (m.sourceKind === "dwd" && !input.dwdAvailable) return "conta de serviço Google (delegação) em falta";
    const a = byKey.get(key);
    const who = m.sourceKind === "dwd" ? m.sourceEmail : `conta ligada #${m.sourceUserId}`;
    if (!a) return `a conta ${who} ainda não sincronizou`;
    if (a.status && a.status !== "ok" && a.status !== "pending") return `a conta ${who} está em "${a.status}"`;
    const ok = parseUtc(a.lastOkAt);
    if (!Number.isFinite(ok)) return `a conta ${who} ainda não sincronizou com sucesso`;
    if (now - ok > staleMs) return `a conta ${who} não sincroniza há mais de ${Math.round(staleMs / 3_600_000)} h`;
    return null;
  };
  const out: string[] = [];
  const active = input.mailboxes.filter((m) => m.active);
  const fed = configuredPipelines(active);
  for (const p of MAIL_PIPELINES) {
    if (!fed.has(p)) out.push(`${MAIL_PIPELINE_LABELS[p]}: nenhum alias encaminha para este destino — os emails não criam registos (Definições → Comunicação → Aliases).`);
  }
  for (const m of active) {
    const problem = problemOf(m);
    if (!problem) continue;
    const pipes = Array.from(new Set(m.addresses.filter((a) => a.active !== false).map((a) => aliasPipeline(m, a, null)).filter((x): x is MailPipeline => !!x)));
    out.push(`Caixa "${m.label}": ${problem}${pipes.length ? ` — ${pipes.map((x) => MAIL_PIPELINE_LABELS[x]).join(", ")} não está(ão) a criar registos` : ""}.`);
  }
  return out;
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

// ─── RH → Google Drive: só currículos (Jorge, 2 out 2026) ───────────────────

/**
 * A conversa é do email do RH (recursos-humanos@)? Caixa do módulo RH, caixa
 * com pipeline do RH, ou o alias por onde entrou vai para o RH. PURA.
 */
export function isHrMailThread(
  mailbox: Pick<MailboxConfig, "module" | "pipeline" | "addresses"> | null | undefined,
  matchedAddress: string | null | undefined,
): boolean {
  const addr = normalizeAddress(matchedAddress);
  if (addr.startsWith("recursos-humanos@")) return true;
  if (!mailbox) return false;
  if (mailbox.module === "rh" || mailbox.pipeline === "recursos-humanos") return true;
  const alias = mailbox.addresses.find((a) => normalizeAddress(a.address) === addr);
  return alias?.destination === "recursos-humanos";
}

/** O ficheiro é um currículo (pelo nome: CV, currículo, curriculum, resume)? PURA. */
export function isCurriculumFilename(name: string | null | undefined): boolean {
  const n = String(name ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return /(^|[^a-z])cv([^a-z]|$)/.test(n) || /curricul/.test(n) || /(^|[^a-z])resume/.test(n);
}

/** "Guardar no meu Drive" de um anexo de email: do RH, só currículos; o resto sim. PURA. */
export function mailAttachmentDriveAllowed(hrThread: boolean, filename: string | null | undefined): boolean {
  return !hrThread || isCurriculumFilename(filename);
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
/** Todas ligadas: Gmail, Calendário, Tarefas, Drive e Contactos. */
export const GOOGLE_FEATURES_ENABLED: readonly GoogleFeature[] = ["gmail", "calendar", "tasks", "drive", "contacts"];
export const GOOGLE_FEATURE_SCOPES: Record<GoogleFeature, readonly string[]> = {
  gmail: ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.send"],
  // Calendário: eventos (turnos, prazos, reuniões com Meet), o calendário
  // secundário "Multipark" criado pela app, a lista de calendários (para o
  // reencontrar) e só a disponibilidade (livre/ocupado) — nunca o conteúdo
  // dos eventos pessoais.
  calendar: [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.app.created",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.freebusy",
  ],
  tasks: ["https://www.googleapis.com/auth/tasks"],
  // Drive (shared/drive.ts): drive.file — a app vê apenas os ficheiros que
  // criou ou que a pessoa abriu com ela (Google Picker). Chega para guardar no
  // Drive, exportar para Sheets e gerar documentos (APIs Sheets/Docs aceitam
  // drive.file nos ficheiros da app). Nunca lê o resto do Drive da pessoa.
  // + spreadsheets.readonly (decisão do dono, 26 set 2026): "Importar do
  // Google Sheets" a partir de QUALQUER link de folha que a pessoa consiga
  // abrir (só leitura de folhas; nunca Docs/ficheiros). É opcional: quem
  // ativou o Drive antes continua com o Drive ativo e só lhe é pedido de novo
  // para importar de folhas que a app não conhece.
  drive: ["https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/spreadsheets.readonly"],
  // Contactos (shared/contacts.ts): escrever o grupo "Multipark — Serviço"
  // (só os contactos criados pela app) e ler os "Outros contactos" para
  // sugerir ligações a clientes/leads/parceiros.
  contacts: ["https://www.googleapis.com/auth/contacts", "https://www.googleapis.com/auth/contacts.other.readonly"],
};

/** Leitura de folhas Google (importar de qualquer link que a pessoa abre). */
export const SHEETS_READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

/**
 * Âmbitos pedidos com a funcionalidade mas que NÃO são precisos para ela
 * contar como ativa (quem ativou antes não perde o acesso; é-lhe pedido de
 * novo só quando precisa). PURA.
 */
export const GOOGLE_FEATURE_OPTIONAL_SCOPES: Partial<Record<GoogleFeature, readonly string[]>> = {
  drive: [SHEETS_READONLY_SCOPE],
};

function scopeSet(granted: string | readonly string[] | null | undefined): Set<string> {
  const list = Array.isArray(granted) ? granted : String(granted ?? "").split(/[\s,]+/);
  return new Set(list.filter(Boolean));
}

/** A conta tem todos os âmbitos (obrigatórios) da funcionalidade? PURA. */
export function hasFeatureScopes(granted: string | readonly string[] | null | undefined, feature: GoogleFeature): boolean {
  const set = scopeSet(granted);
  const optional = GOOGLE_FEATURE_OPTIONAL_SCOPES[feature] ?? [];
  return GOOGLE_FEATURE_SCOPES[feature].every((s) => optional.includes(s) || set.has(s));
}

/** A conta pode ler qualquer folha Google que a pessoa abre (spreadsheets.readonly)? PURA. */
export function hasSheetsReadScope(granted: string | readonly string[] | null | undefined): boolean {
  return scopeSet(granted).has(SHEETS_READONLY_SCOPE);
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
