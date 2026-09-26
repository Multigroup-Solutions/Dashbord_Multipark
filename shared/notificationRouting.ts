/**
 * ROTEAMENTO DAS NOTIFICAÇÕES (pedido do dono, 24 set 2026: "as notificações
 * estão uma confusão — separa-as"). Fonte ÚNICA de verdade, PURA, partilhada
 * entre servidor (server/notify.ts decide quem recebe) e cliente (Perfil →
 * Notificações; Definições → Regras das notificações).
 *
 * Regras (ver docs/notificacoes.md):
 *  - cada TIPO pertence a um módulo da matriz de acessos (shared/access.ts) e
 *    precisa de uma ação (quase sempre "ver");
 *  - recebe quem está ATIVO, tem o PAPEL na lista do tipo (ou um override
 *    por pessoa que lhe dá o módulo), consegue abrir o módulo e tem a CIDADE
 *    da notificação no seu âmbito;
 *  - super_admin recebe TUDO de todas as cidades; admin recebe tudo o que a
 *    matriz lhe dá (sem Marketing/Logs/Faturação/Anual → nada disso);
 *  - papéis de cidade só recebem da(s) sua(s) cidade(s) (centro de custos +
 *    cidades dadas); papéis nacionais recebem só da sua (omissão desde 26 set
 *    2026 — "Só a própria cidade" ligado) ou de todas, se o super_admin o
 *    desligar;
 *  - tipos PESSOAIS ("a tua tarefa", "os teus documentos") vão só à pessoa;
 *  - cada pessoa pode silenciar qualquer tipo que não seja OBRIGATÓRIO e
 *    ligar/desligar o email nos tipos que têm email.
 * As sobreposições do super_admin ficam em app_settings
 * (`notifications.routing`), validadas pelo schema abaixo.
 */
import { z } from "zod";
import {
  ROLES, ROLE_LABELS, activeOverride, can, grantFor, isRole, roleGrantFor,
  type AccessOverrides, type Action, type ModuleId, type Role,
} from "./access";
import { matchCityKey } from "./city";

// ─── Cidades ────────────────────────────────────────────────────────────────

export const NOTIFY_CITIES = ["lisbon", "porto", "faro"] as const;
export type NotifyCity = (typeof NOTIFY_CITIES)[number];
export const NOTIFY_CITY_LABELS: Record<NotifyCity, string> = { lisbon: "Lisboa", porto: "Porto", faro: "Faro" };

/** Texto livre ("Lisboa", "lisbon", "Porto") → cidade; `null` se não reconhecer. PURA. */
export function notifyCityOf(text: string | null | undefined): NotifyCity | null {
  const t = String(text ?? "").trim().toLowerCase();
  if ((NOTIFY_CITIES as readonly string[]).includes(t)) return t as NotifyCity;
  const k = matchCityKey(text);
  return k === "lisboa" ? "lisbon" : k === "porto" ? "porto" : k === "faro" ? "faro" : null;
}

// ─── Tipos ──────────────────────────────────────────────────────────────────

export type NotificationChannel = "in_app" | "email";
export type NotificationGroup = "suporte" | "operacoes" | "pessoas" | "financeiro" | "marketing" | "sistema";

export const NOTIFICATION_GROUP_LABELS: Record<NotificationGroup, string> = {
  suporte: "Suporte (reclamações, ocorrências, perdidos)",
  operacoes: "Operações",
  pessoas: "Pessoas (RH, formação, recrutamento)",
  financeiro: "Financeiro",
  marketing: "Marketing",
  sistema: "Sistema",
};

export interface NotificationKindDef {
  kind: string;
  group: NotificationGroup;
  label: string;
  description: string;
  /** Módulo da matriz de acessos a que pertence. */
  module: ModuleId;
  /** Ação necessária no módulo (quase sempre "view"). */
  action: Action;
  /**
   * Papéis que recebem por omissão (tipos não pessoais). super_admin recebe
   * sempre; admin entra sozinho quando a matriz lhe dá o módulo.
   */
  roles: readonly Role[];
  /** A notificação leva uma cidade e só chega a quem tem essa cidade. */
  cityScoped: boolean;
  /** Vai só à(s) pessoa(s) indicada(s) (a tarefa DELA, os documentos DELA…). */
  personal: boolean;
  /** Não se pode silenciar (pede ação/confirmação). */
  mandatory?: boolean;
  channels: readonly NotificationChannel[];
  /** Email ligado por omissão (só se `channels` tiver email). */
  emailDefault?: boolean;
  /** Janela de deduplicação (min): 1 notificação por pessoa × tipo × registo. */
  dedupeMinutes?: number;
}

const IN_APP = ["in_app"] as const;
const WITH_EMAIL = ["in_app", "email"] as const;

const K = <T extends NotificationKindDef>(d: T) => d;

/** Catálogo (a ordem é a da UI). */
export const NOTIFICATION_KIND_DEFS = [
  // ── Suporte ──
  K({ kind: "complaint_new", group: "suporte", label: "Reclamação nova", description: "Reclamações novas da tua cidade (e as que te forem atribuídas).",
    module: "reclamacoes", action: "view", roles: ["frontoffice", "backoffice", "supervisor"], cityScoped: true, personal: false, channels: IN_APP }),
  K({ kind: "complaint_sla", group: "suporte", label: "Reclamações fora do prazo", description: "Reclamações que passaram o SLA (resumo por cidade).",
    module: "reclamacoes", action: "view", roles: ["frontoffice", "backoffice", "supervisor"], cityScoped: true, personal: false, channels: IN_APP, dedupeMinutes: 12 * 60 }),
  K({ kind: "complaint_triage", group: "suporte", label: "Triagem da IA por rever", description: "Reclamação urgente ou possível duplicado sugerido pela IA.",
    module: "reclamacoes", action: "view", roles: ["frontoffice", "backoffice", "supervisor"], cityScoped: true, personal: false, channels: IN_APP }),
  K({ kind: "google_reviews_alert", group: "suporte", label: "Críticas Google: alertas", description: "Média de estrelas dos últimos 7 dias a cair e críticas Google sem resposta há demasiado tempo (por perfil da tua cidade).",
    module: "criticas", action: "view", roles: ["supervisor"], cityScoped: true, personal: false, channels: WITH_EMAIL, dedupeMinutes: 1440 }),
  K({ kind: "incident_critical", group: "suporte", label: "Ocorrência crítica", description: "Ocorrências registadas com gravidade crítica.",
    module: "ocorrencias", action: "view", roles: ["team_leader", "supervisor", "backoffice"], cityScoped: true, personal: false, channels: WITH_EMAIL, emailDefault: true }),
  K({ kind: "incident_sla", group: "suporte", label: "Ocorrências fora do prazo", description: "Resumo diário das ocorrências em atraso.",
    module: "ocorrencias", action: "view", roles: ["team_leader", "supervisor", "backoffice"], cityScoped: true, personal: false, channels: IN_APP, dedupeMinutes: 12 * 60 }),
  K({ kind: "lost_found_new", group: "suporte", label: "Perdido novo", description: "Perdidos e achados registados na tua cidade.",
    module: "perdidos", action: "view", roles: ["team_leader", "supervisor", "backoffice"], cityScoped: true, personal: false, channels: IN_APP }),
  K({ kind: "lost_found_sla", group: "suporte", label: "Perdidos fora do prazo", description: "Resumo diário dos perdidos em atraso (e os que tens atribuídos).",
    module: "perdidos", action: "view", roles: ["team_leader", "supervisor", "backoffice"], cityScoped: true, personal: false, channels: IN_APP, dedupeMinutes: 12 * 60 }),

  K({ kind: "mail_new", group: "suporte", label: "Email novo de cliente", description: "Conversa nova (ou reaberta) numa caixa de email partilhada que vês (Comunicação).",
    module: "comunicacao", action: "view", roles: ["team_leader", "supervisor", "frontoffice", "backoffice"], cityScoped: true, personal: false, channels: IN_APP }),
  K({ kind: "mail_assigned", group: "suporte", label: "Email atribuído a ti", description: "Uma conversa de email foi-te atribuída.",
    module: "comunicacao", action: "view", roles: [], cityScoped: false, personal: true, channels: IN_APP }),

  // ── Operações ──
  K({ kind: "whatsapp_sla", group: "operacoes", label: "WhatsApp por responder", description: "Conversas fora do prazo, urgentes ou com a janela de 24h a fechar (e as que te estão atribuídas).",
    module: "whatsapp", action: "view", roles: ["team_leader", "supervisor", "frontoffice", "backoffice"], cityScoped: true, personal: false, channels: IN_APP }),
  K({ kind: "extras_gap", group: "operacoes", label: "Faltam condutores", description: "Horas sem condutores suficientes na escala (proposta e véspera).",
    module: "extras_dia", action: "view", roles: ["team_leader", "supervisor"], cityScoped: true, personal: false, channels: IN_APP }),
  K({ kind: "extras_schedule_reply", group: "operacoes", label: "Respostas ao aviso de escala", description: "Extra que não pode ir ao turno ou resposta por rever.",
    module: "extras_dia", action: "view", roles: ["team_leader", "supervisor"], cityScoped: true, personal: false, channels: IN_APP }),
  K({ kind: "handover", group: "operacoes", label: "A tua passagem de turno", description: "Passagem entregue para ti (pede \"Recebi\") e lembretes do teu turno.",
    module: "passagem_turno", action: "view", roles: [], cityScoped: true, personal: true, mandatory: true, channels: IN_APP }),
  K({ kind: "handover_missing", group: "operacoes", label: "Passagem de turno em falta", description: "Turnos da tua cidade sem passagem preenchida.",
    module: "passagem_turno", action: "view", roles: ["supervisor"], cityScoped: true, personal: false, channels: IN_APP }),
  K({ kind: "speed_alert", group: "operacoes", label: "Excesso de velocidade", description: "Alertas de velocidade (GPS / Zello).",
    module: "historico_diario", action: "view", roles: ["team_leader", "supervisor"], cityScoped: true, personal: false, channels: IN_APP }),
  K({ kind: "gps_alert", group: "operacoes", label: "GPS desligado", description: "Condutores com o GPS desligado no Zello.",
    module: "historico_diario", action: "view", roles: ["team_leader", "supervisor"], cityScoped: true, personal: false, channels: IN_APP }),
  K({ kind: "driver_daily_report", group: "operacoes", label: "Relatório diário dos motoristas", description: "Resumo da recolha automática do histórico GPS.",
    module: "historico_diario", action: "view", roles: [], cityScoped: false, personal: false, channels: WITH_EMAIL }),
  K({ kind: "anomaly_bookings", group: "operacoes", label: "Anomalias nas reservas", description: "Quedas/picos fora do normal nas reservas (só críticas).",
    module: "reservas_operacoes", action: "view", roles: ["supervisor"], cityScoped: true, personal: false, channels: IN_APP }),
  K({ kind: "task", group: "operacoes", label: "As tuas tarefas", description: "Tarefas tuas: atribuídas, comentários, atrasos e conclusões.",
    module: "tarefas", action: "view", roles: [], cityScoped: false, personal: true, channels: IN_APP }),

  // ── Pessoas ──
  K({ kind: "rh_docs_missing", group: "pessoas", label: "Documentos em falta (RH)", description: "Extras com documentos obrigatórios em falta há 14 dias.",
    module: "rh", action: "view", roles: ["backoffice", "supervisor"], cityScoped: true, personal: false, channels: IN_APP }),
  K({ kind: "my_docs_missing", group: "pessoas", label: "Os teus documentos em falta", description: "Documentos obrigatórios que ainda tens de carregar na tua ficha.",
    module: "ficha", action: "view", roles: [], cityScoped: false, personal: true, channels: WITH_EMAIL, emailDefault: true }),
  K({ kind: "driver_application", group: "pessoas", label: "Candidaturas", description: "Candidaturas novas \"Be a Driver\" da tua cidade.",
    module: "leads_extras", action: "view", roles: ["team_leader", "supervisor", "backoffice"], cityScoped: true, personal: false, channels: IN_APP }),
  K({ kind: "lead_replied", group: "pessoas", label: "Lead respondeu", description: "Leads de extras que responderam por WhatsApp.",
    module: "leads_extras", action: "view", roles: ["team_leader", "supervisor", "backoffice"], cityScoped: true, personal: false, channels: IN_APP }),
  K({ kind: "leads_waiting", group: "pessoas", label: "Leads à espera", description: "Resumo diário das leads sem contacto ou sem resposta.",
    module: "leads_extras", action: "view", roles: ["supervisor", "backoffice"], cityScoped: true, personal: false, channels: IN_APP, dedupeMinutes: 12 * 60 }),
  K({ kind: "training_overdue", group: "pessoas", label: "Formação em atraso (equipa)", description: "Pessoas da tua cidade com formação obrigatória em atraso.",
    module: "formacao", action: "view", roles: ["team_leader", "supervisor"], cityScoped: true, personal: false, channels: IN_APP }),
  K({ kind: "training_promotion", group: "pessoas", label: "Promoções por aprovar", description: "Quem passou num exame de carreira e espera aprovação.",
    module: "formacao", action: "edit", roles: ["supervisor", "backoffice"], cityScoped: true, personal: false, channels: IN_APP }),
  K({ kind: "my_training", group: "pessoas", label: "A tua formação", description: "Formação por concluir e promoções aprovadas.",
    module: "formacao", action: "view", roles: [], cityScoped: false, personal: true, channels: IN_APP }),
  K({ kind: "evaluation_dispute", group: "pessoas", label: "Contestações da avaliação", description: "Contestações novas da avaliação na tua cidade.",
    module: "avaliacao", action: "edit", roles: ["supervisor"], cityScoped: true, personal: false, channels: IN_APP }),
  K({ kind: "my_evaluation", group: "pessoas", label: "A tua avaliação", description: "Decisão sobre as tuas contestações.",
    module: "ficha", action: "view", roles: [], cityScoped: false, personal: true, channels: IN_APP }),

  // ── Financeiro ──
  K({ kind: "expense_due", group: "financeiro", label: "Despesas com vencimento", description: "Despesa nova com data de pagamento.",
    module: "despesas", action: "view", roles: ["supervisor"], cityScoped: true, personal: false, channels: WITH_EMAIL }),
  K({ kind: "expense_overdue", group: "financeiro", label: "Despesas em atraso", description: "Despesas que passaram a data de pagamento.",
    module: "despesas", action: "view", roles: ["supervisor"], cityScoped: true, personal: false, channels: WITH_EMAIL }),
  K({ kind: "anomaly_expenses", group: "financeiro", label: "Anomalias nas despesas", description: "Valores fora do normal e possíveis duplicados (só críticas).",
    module: "despesas", action: "view", roles: ["supervisor"], cityScoped: true, personal: false, channels: IN_APP }),
  K({ kind: "payroll_ready", group: "financeiro", label: "Folha de ordenados", description: "Folha de ordenados gerada, pronta a enviar ao contabilista.",
    module: "rh_salarios", action: "view", roles: [], cityScoped: false, personal: false, channels: WITH_EMAIL, emailDefault: true }),

  // ── Marketing ──
  K({ kind: "marketing_alert", group: "marketing", label: "Alertas de marketing", description: "Gasto ou ROAS fora do normal (só críticos).",
    module: "marketing", action: "view", roles: [], cityScoped: false, personal: false, channels: WITH_EMAIL }),
  K({ kind: "google_business_alert", group: "marketing", label: "Alertas Google Business", description: "Impressões ou chamadas dos perfis Google a cair e perfis suspensos, fechados, alterados pela Google ou com edições pendentes.",
    module: "marketing", action: "view", roles: [], cityScoped: false, personal: false, channels: WITH_EMAIL, dedupeMinutes: 1440 }),
  K({ kind: "web_analytics_alert", group: "marketing", label: "Alertas Web & SEO", description: "Quedas de sessões ou de cliques do Google, pesquisas a perder posição, PageSpeed móvel baixa e experiência real (CrUX) lenta nas páginas-chave.",
    module: "marketing", action: "view", roles: [], cityScoped: false, personal: false, channels: WITH_EMAIL, dedupeMinutes: 1440 }),

  // ── Sistema ──
  K({ kind: "integration_alert", group: "sistema", label: "Integrações com problemas", description: "Ligação que precisa de ser religada ou está em erro.",
    module: "integracoes", action: "view", roles: [], cityScoped: false, personal: false, channels: WITH_EMAIL, emailDefault: true }),
  K({ kind: "cron_stale", group: "sistema", label: "Crons parados", description: "Tarefas automáticas que deixaram de correr.",
    module: "definicoes", action: "view", roles: [], cityScoped: false, personal: false, channels: WITH_EMAIL, emailDefault: true }),
  K({ kind: "google_account_reauth", group: "sistema", label: "A tua conta Google", description: "A ligação à tua conta Google (O meu email, Tarefas e Calendário) expirou ou foi revogada e tem de ser religada.",
    module: "ficha", action: "view", roles: [], cityScoped: false, personal: true, channels: WITH_EMAIL, emailDefault: true }),
  K({ kind: "sync_alert", group: "sistema", label: "Sincronização Multipark", description: "Webhooks parados/retomados e reservas por sincronizar.",
    module: "sincronizacao", action: "view", roles: [], cityScoped: false, personal: false, channels: IN_APP }),
  K({ kind: "ai_budget", group: "sistema", label: "Orçamento da IA", description: "O gasto da IA chegou ao orçamento do mês.",
    module: "definicoes", action: "view", roles: [], cityScoped: false, personal: false, channels: WITH_EMAIL }),
] as const satisfies readonly NotificationKindDef[];

export type NotificationKindId = (typeof NOTIFICATION_KIND_DEFS)[number]["kind"];
export const NOTIFICATION_KIND_IDS = NOTIFICATION_KIND_DEFS.map((d) => d.kind) as [NotificationKindId, ...NotificationKindId[]];
const DEF_BY_KIND = new Map<string, NotificationKindDef>(NOTIFICATION_KIND_DEFS.map((d) => [d.kind, d]));

export function isNotificationKind(v: unknown): v is NotificationKindId {
  return typeof v === "string" && DEF_BY_KIND.has(v);
}
export function kindDef(kind: string): NotificationKindDef | null {
  return DEF_BY_KIND.get(kind) ?? null;
}

/**
 * Tipos antigos (antes do roteamento) → tipos novos: servem para migrar os
 * silenciamentos guardados e para dar nome às notificações antigas no sino.
 */
export const LEGACY_KIND_MAP: Record<string, readonly NotificationKindId[]> = {
  extras: ["extras_gap", "extras_schedule_reply", "handover_missing"],
  complaint: ["complaint_new", "complaint_sla", "complaint_triage"],
  case_sla: ["incident_sla", "lost_found_sla"],
  training: ["my_training", "training_overdue", "training_promotion"],
  sync: ["sync_alert"],
  integration: ["integration_alert", "cron_stale"],
};

/** Etiqueta de um tipo (novo, antigo ou desconhecido) para o sino. PURA. */
export function kindLabel(kind: string | null | undefined): string {
  const k = String(kind ?? "");
  const d = DEF_BY_KIND.get(k);
  if (d) return d.label;
  const legacy = LEGACY_KIND_MAP[k];
  if (legacy) return DEF_BY_KIND.get(legacy[0])?.label ?? k;
  return "Outras";
}

/** Tipos guardados que contam como `kind` no filtro do sino (inclui os antigos). PURA. */
export function kindFilterValues(kind: string): string[] {
  const out = new Set([kind]);
  for (const [old, list] of Object.entries(LEGACY_KIND_MAP)) if ((list as readonly string[]).includes(kind)) out.add(old);
  return Array.from(out);
}

// ─── Sobreposições do super_admin (app_settings `notifications.routing`) ────

export const NOTIFICATION_ROUTING_SETTING_KEY = "notifications.routing";

/** Papéis nacionais que o super_admin pode limitar à própria cidade. */
export const HOME_CITY_ROLES = ["frontoffice", "backoffice", "admin"] as const satisfies readonly Role[];
/**
 * Omissão (decisão do dono, 26 set 2026): "Papéis nacionais só da própria
 * cidade" LIGADO para todos — cada um recebe só a(s) sua(s) cidade(s). O
 * super_admin recebe sempre tudo; quem tem "todas as cidades" (grupo) também.
 */
export type HomeCityRole = (typeof HOME_CITY_ROLES)[number];
export const DEFAULT_HOME_CITY_ONLY: HomeCityRole[] = [...HOME_CITY_ROLES];

const roleSchema = z.enum(ROLES as unknown as [Role, ...Role[]], { error: "Papel desconhecido." });

export const kindRoutingOverrideSchema = z.object({
  roles: z.array(roleSchema).max(ROLES.length).optional(),
  email: z.boolean({ error: "Email: ligado ou desligado." }).optional(),
}).strict();

export const notificationRoutingSchema = z.object({
  kinds: z.record(z.string(), kindRoutingOverrideSchema).default({}),
  homeCityOnly: z.array(z.enum(HOME_CITY_ROLES, { error: "Só frontoffice, backoffice ou admin." })).max(3).default(() => [...DEFAULT_HOME_CITY_ONLY]),
}).strict().superRefine((v, ctx) => {
  for (const [kind, o] of Object.entries(v.kinds)) {
    const d = DEF_BY_KIND.get(kind);
    if (!d) { ctx.addIssue({ code: "custom", message: `Tipo de notificação desconhecido: ${kind}.` }); continue; }
    if (o.roles && d.personal) ctx.addIssue({ code: "custom", message: `"${d.label}" é pessoal: vai só à pessoa, não tem papéis.` });
    if (o.email !== undefined && !d.channels.includes("email")) ctx.addIssue({ code: "custom", message: `"${d.label}" não tem email.` });
    for (const r of o.roles ?? []) {
      if (!can(r, d.module, d.action)) {
        ctx.addIssue({ code: "custom", message: `${ROLE_LABELS[r]} não tem acesso a "${d.label}" na matriz de acessos.` });
      }
    }
  }
}).transform((v) => ({
  kinds: Object.fromEntries(Object.entries(v.kinds).map(([k, o]) => [k, {
    ...(o.roles ? { roles: ROLES.filter((r) => r === "super_admin" || o.roles!.includes(r)) } : {}),
    ...(o.email !== undefined ? { email: o.email } : {}),
  }])) as Record<string, { roles?: Role[]; email?: boolean }>,
  homeCityOnly: Array.from(new Set(v.homeCityOnly)),
}));

export type NotificationRouting = z.output<typeof notificationRoutingSchema>;
/** Regras do código (nada sobreposto): papéis nacionais só da própria cidade. */
export const EMPTY_ROUTING: NotificationRouting = { kinds: {}, homeCityOnly: [...DEFAULT_HOME_CITY_ONLY] };

/** Normaliza o valor guardado (nunca lança; inválido → omissões). PURA. */
export function parseRouting(raw: unknown): NotificationRouting {
  const r = notificationRoutingSchema.safeParse(raw ?? {});
  return r.success ? r.data : { kinds: {}, homeCityOnly: [...DEFAULT_HOME_CITY_ONLY] };
}

/** Papéis que recebem o tipo (omissão + sobreposição; super_admin sempre; admin se a matriz deixar). PURA. */
export function effectiveRoles(kind: string, routing: NotificationRouting = EMPTY_ROUTING): Role[] {
  const d = DEF_BY_KIND.get(kind);
  if (!d || d.personal) return [];
  const base = routing.kinds[kind]?.roles ?? defaultRoles(d);
  return ROLES.filter((r) => (r === "super_admin" || base.includes(r)) && can(r, d.module, d.action));
}

/** Papéis por omissão (do código): os do tipo + admin (se a matriz deixar) + super_admin. PURA. */
export function defaultRoles(d: NotificationKindDef): Role[] {
  return ROLES.filter((r) => (d.roles.includes(r) || r === "super_admin" || r === "admin") && can(r, d.module, d.action));
}

export function effectiveEmailDefault(kind: string, routing: NotificationRouting = EMPTY_ROUTING): boolean {
  const d = DEF_BY_KIND.get(kind);
  if (!d || !d.channels.includes("email")) return false;
  return routing.kinds[kind]?.email ?? !!d.emailDefault;
}

// ─── Preferências de cada pessoa (users.notificationPrefs) ─────────────────

export const notificationPrefsSchema = z.object({
  muted: z.array(z.string().max(32)).max(80).default([]),
  email: z.record(z.string().max(32), z.boolean()).default({}),
});
export interface NotificationPrefs { muted: string[]; email: Record<string, boolean> }

/** Normaliza as preferências guardadas (JSON cru ou objeto) — nunca lança. Tipos antigos → novos. PURA. */
export function parseNotificationPrefs(raw: unknown): NotificationPrefs {
  let v = raw;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { v = null; }
  }
  const r = notificationPrefsSchema.safeParse(v ?? {});
  if (!r.success) return { muted: [], email: {} };
  const mutable = new Set(NOTIFICATION_KIND_DEFS.filter((d) => !("mandatory" in d && d.mandatory)).map((d) => d.kind as string));
  const muted = new Set<string>();
  for (const k of r.data.muted) {
    for (const x of LEGACY_KIND_MAP[k] ?? [k]) if (mutable.has(x)) muted.add(x);
  }
  const email: Record<string, boolean> = {};
  for (const [k, on] of Object.entries(r.data.email)) {
    if (DEF_BY_KIND.get(k)?.channels.includes("email")) email[k] = on;
  }
  return { muted: NOTIFICATION_KIND_IDS.filter((k) => muted.has(k)), email };
}

/** A pessoa quer receber este tipo na app? (obrigatórias e tipos desconhecidos → sim). PURA. */
export function wantsNotification(prefs: NotificationPrefs, kind: string | null | undefined): boolean {
  const d = DEF_BY_KIND.get(String(kind ?? ""));
  if (!d || d.mandatory) return true;
  return !prefs.muted.includes(d.kind);
}

/** A pessoa quer este tipo também por email? PURA. */
export function wantsEmail(prefs: NotificationPrefs, kind: string, routing: NotificationRouting = EMPTY_ROUTING): boolean {
  const d = DEF_BY_KIND.get(kind);
  if (!d || !d.channels.includes("email")) return false;
  return prefs.email[kind] ?? effectiveEmailDefault(kind, routing);
}

// ─── Resolução dos destinatários ────────────────────────────────────────────

export interface RoutingCandidate {
  id: number;
  role: string;
  isActive: boolean;
  email?: string | null;
  accessOverrides?: AccessOverrides | null;
  /** Cidades da pessoa: centro de custos + cidades dadas ("all" = grupo Multipark / todas). */
  cities: readonly NotifyCity[] | "all";
  prefs: NotificationPrefs;
  /** Sem centro de custos válido (não abre a app por cidade): só recebe as pessoais. */
  personalOnly?: boolean;
}

export interface RouteInput {
  kind: string;
  /** Cidade da notificação (`null` = sem cidade conhecida). */
  city: NotifyCity | null;
  /** Tipos pessoais: a(s) pessoa(s) a quem se destina. */
  targetUserIds?: readonly number[];
  /** Tipos não pessoais: pessoas a juntar (ex.: o responsável do caso), com acesso ao módulo. */
  alsoUserIds?: readonly number[];
  /** Restrição extra (ex.: só quem vê a caixa de email em causa). */
  filter?: (c: RoutingCandidate) => boolean;
}

export interface RoutedRecipient { userId: number; email: boolean; reason: "role" | "override" | "personal" | "assignee" }

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** A pessoa vê a cidade `city` neste tipo? PURA. */
export function seesCity(c: RoutingCandidate, d: NotificationKindDef, city: NotifyCity | null, routing: NotificationRouting = EMPTY_ROUTING): boolean {
  if (c.role === "super_admin") return true;
  const g = grantFor(c, d.module);
  // Só "o que é do próprio" não chega para avisos da cidade/do sistema.
  if (g.access === "none" || g.access === "own") return false;
  if (!d.cityScoped) return true;
  const fromOverride = !!activeOverride(c, d.module);
  const national = g.access === "national"
    && (fromOverride || !(routing.homeCityOnly as readonly string[]).includes(c.role));
  if (national || c.cities === "all") return true;
  if (city == null) return false;
  return c.cities.includes(city);
}

/**
 * Pode receber o tipo (em ALGUMA cidade)? — para o Perfil mostrar só o que a
 * pessoa pode receber. PURA.
 */
export function canReceiveKind(c: RoutingCandidate, kind: string, routing: NotificationRouting = EMPTY_ROUTING): boolean {
  const d = DEF_BY_KIND.get(kind);
  if (!d || !c.isActive) return false;
  if (d.personal) return can(c, d.module, "view");
  if (c.personalOnly) return false;
  if (!can(c, d.module, d.action)) return false;
  const byRole = isRole(c.role) && effectiveRoles(kind, routing).includes(c.role);
  const byOverride = !byRole && !!activeOverride(c, d.module);
  if (!byRole && !byOverride) return false;
  if (c.role === "super_admin") return true;
  const g = grantFor(c, d.module);
  if (g.access === "none" || g.access === "own") return false;
  if (!d.cityScoped) return true;
  return c.cities === "all" || c.cities.length > 0 || g.access === "national";
}

/**
 * QUEM recebe uma notificação (sem duplicados), e se também por email. PURA.
 *  - pessoal: só os `targetUserIds` (ativos, sem o tipo silenciado);
 *  - resto: papel na lista do tipo OU override do módulo, com a ação no
 *    módulo, com a cidade no âmbito, sem o tipo silenciado; + `alsoUserIds`
 *    com acesso ao módulo (sem verificação de cidade: o caso é deles).
 */
export function resolveRecipients(input: RouteInput, candidates: readonly RoutingCandidate[], routing: NotificationRouting = EMPTY_ROUTING): RoutedRecipient[] {
  const d = DEF_BY_KIND.get(input.kind);
  if (!d) return [];
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const out = new Map<number, RoutedRecipient>();
  const emailOk = (c: RoutingCandidate) => !!c.email && EMAIL_RE.test(c.email) && wantsEmail(c.prefs, d.kind, routing);
  const add = (c: RoutingCandidate, reason: RoutedRecipient["reason"]) => {
    if (!c.isActive || out.has(c.id) || !wantsNotification(c.prefs, d.kind)) return;
    out.set(c.id, { userId: c.id, email: emailOk(c), reason });
  };

  if (d.personal) {
    for (const id of input.targetUserIds ?? []) {
      const c = byId.get(id);
      if (c) add(c, "personal");
    }
    return Array.from(out.values());
  }

  const roles = effectiveRoles(d.kind, routing) as string[];
  for (const c of candidates) {
    if (!c.isActive || c.personalOnly || !can(c, d.module, d.action)) continue;
    const byRole = roles.includes(c.role);
    const byOverride = !byRole && !!activeOverride(c, d.module);
    if (!byRole && !byOverride) continue;
    if (!seesCity(c, d, d.cityScoped ? input.city : null, routing)) continue;
    if (input.filter && !input.filter(c)) continue;
    add(c, byRole ? "role" : "override");
  }
  for (const id of input.alsoUserIds ?? []) {
    const c = byId.get(id);
    if (c && !c.personalOnly && can(c, d.module, "view") && (!input.filter || input.filter(c))) add(c, "assignee");
  }
  return Array.from(out.values());
}

// ─── Deduplicação ───────────────────────────────────────────────────────────

export const DEFAULT_DEDUPE_MINUTES = 30;

export function dedupeMinutesFor(kind: string): number {
  return DEF_BY_KIND.get(kind)?.dedupeMinutes ?? DEFAULT_DEDUPE_MINUTES;
}

/** Hash curto e estável (FNV-1a 32 bits) — para deduplicar notificações sem registo. PURA. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

/**
 * Chave de deduplicação (tipo + registo): com `entity` usa o registo; sem
 * registo usa a cidade, o título e o texto (a MESMA mensagem repetida não
 * volta a entrar dentro da janela). PURA.
 */
export function entityKeyOf(input: { entity?: { type: string; id: string | number } | null; city?: string | null; title: string; body?: string | null }): string {
  if (input.entity) return `${input.entity.type}:${String(input.entity.id)}`.slice(0, 96);
  return `t:${input.city ?? "-"}:${fnv1a(`${input.title}\n${input.body ?? ""}`)}`.slice(0, 96);
}

// ─── Tabela para a documentação / Definições ────────────────────────────────

export interface RoutingTableRow {
  kind: string; label: string; group: NotificationGroup; module: ModuleId; action: Action;
  personal: boolean; mandatory: boolean; cityScoped: boolean; email: boolean; emailDefault: boolean;
  roles: Role[]; defaultRoles: Role[]; allowedRoles: Role[];
}

/** Uma linha por tipo, com os papéis efetivos e os que a matriz permite. PURA. */
export function routingTable(routing: NotificationRouting = EMPTY_ROUTING): RoutingTableRow[] {
  return NOTIFICATION_KIND_DEFS.map((d0) => {
    const d = d0 as NotificationKindDef;
    return {
      kind: d.kind, label: d.label, group: d.group, module: d.module, action: d.action,
      personal: d.personal, mandatory: !!d.mandatory, cityScoped: d.cityScoped,
      email: d.channels.includes("email"), emailDefault: effectiveEmailDefault(d.kind, routing),
      roles: effectiveRoles(d.kind, routing), defaultRoles: d.personal ? [] : defaultRoles(d),
      allowedRoles: d.personal ? [] : ROLES.filter((r) => roleGrantFor(r, d.module).actions.includes(d.action)),
    };
  });
}
