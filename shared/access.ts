/**
 * MODELO DE ACESSOS (pedido do Jorge, 24 set 2026) — fonte ÚNICA de verdade
 * para o servidor (requireAccess) e para o cliente (menu, botões).
 *
 * Papéis por ordem de hierarquia:
 *   user < extra < condutor < team_leader < supervisor  → papéis de CIDADE
 *   frontoffice ≈ backoffice (supervisor nacional) < admin < super_admin → NACIONAIS
 *
 * "Cidade" = cidade do centro de custos da ficha (+ cidades dadas por
 * permissão explícita). O servidor aplica-a sozinho (cityScope) a quem não é
 * nacional; aqui só se diz SE o papel tem acesso ao módulo e com que alcance:
 *   none        — nada
 *   own         — só o que é do próprio (a sua ficha, as suas despesas, os
 *                 casos em que é o condutor envolvido…)
 *   below_city  — na sua cidade, o que é dele ou de quem está ABAIXO dele
 *   city        — tudo na sua cidade
 *   national    — todas as cidades
 * Ações: view (ver), edit (criar/alterar o dia a dia), export (Excel/PDF),
 * manage (configuração, apagar, aprovar, coisas de administração).
 *
 * Por cima do papel, cada pessoa pode ter overrides por módulo (grantFor =
 * override ativo, senão o papel) — ver "Overrides por utilizador" abaixo.
 *
 * A tabela para revisão está em docs/permissoes.md (gerada por
 * `pnpm tsx scripts/gen-permissoes-doc.ts`; um teste garante que está em dia).
 */

export const ROLES = ["user", "extra", "condutor", "team_leader", "supervisor", "frontoffice", "backoffice", "admin", "super_admin"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  user: "Utilizador",
  extra: "Extra",
  condutor: "Condutor",
  team_leader: "Team Leader",
  supervisor: "Supervisor",
  frontoffice: "Frontoffice",
  backoffice: "Backoffice",
  admin: "Admin",
  super_admin: "Super Admin",
};

/** Hierarquia para "abaixo de" e para quem gere quem. frontoffice = backoffice. */
export const ROLE_RANK: Record<Role, number> = {
  user: 0, extra: 1, condutor: 2, team_leader: 3, supervisor: 4, frontoffice: 5, backoffice: 5, admin: 6, super_admin: 7,
};
export const roleRank = (role: string | null | undefined): number => ROLE_RANK[role as Role] ?? -1;
export const isRole = (role: unknown): role is Role => typeof role === "string" && (ROLES as readonly string[]).includes(role);

/** Papéis que veem todas as cidades. */
export const NATIONAL_ROLES: readonly Role[] = ["frontoffice", "backoffice", "admin", "super_admin"];
export const isNationalRole = (role: string | null | undefined) => (NATIONAL_ROLES as readonly string[]).includes(String(role ?? ""));

/** `target` está abaixo de `viewer` na hierarquia (estritamente). */
export function isBelow(viewerRole: string | null | undefined, targetRole: string | null | undefined): boolean {
  return roleRank(targetRole) >= 0 && roleRank(targetRole) < roleRank(viewerRole);
}

/** Papéis abaixo de `role` (para filtros "da equipa"). */
export function rolesBelow(role: string | null | undefined): Role[] {
  return ROLES.filter(r => isBelow(role, r));
}

export type Access = "none" | "own" | "below_city" | "city" | "national";
export type Action = "view" | "edit" | "export" | "manage";
export interface Grant { access: Access; actions: readonly Action[] }

export type ModuleId =
  | "ficha" | "formacao" | "disponibilidade" | "avaliacao" | "avaliacao_operacional"
  | "servicos" | "historico_diario" | "pdas" | "tarefas" | "despesas"
  | "reservas_operacoes" | "extras_dia" | "parcerias" | "rh" | "rh_salarios"
  | "leads_extras" | "atividade_diaria" | "radio" | "passagem_turno" | "passagem_resumo_dia"
  | "disponibilidade_extras" | "whatsapp" | "clientes" | "contactos" | "comunicacao"
  | "reclamacoes" | "criticas" | "ocorrencias" | "perdidos"
  | "utilizadores" | "permissoes" | "sincronizacao" | "integracoes"
  | "marketing" | "logs" | "financeiro" | "faturacao" | "dashboards" | "anual" | "projetos"
  | "api_keys" | "definicoes" | "manutencao";

export interface ModuleDef { id: ModuleId; label: string; group: string }

export const MODULES: readonly ModuleDef[] = [
  { id: "ficha", label: "Minha ficha", group: "Pessoal" },
  { id: "formacao", label: "Formação", group: "Pessoas" },
  { id: "disponibilidade", label: "Disponibilidade (própria)", group: "Pessoal" },
  { id: "avaliacao", label: "Avaliação Individual", group: "Pessoas" },
  { id: "avaliacao_operacional", label: "Avaliação Operacional", group: "Pessoas" },
  { id: "rh", label: "Recursos Humanos", group: "Pessoas" },
  { id: "rh_salarios", label: "RH — ordenados e processamento", group: "Pessoas" },
  { id: "leads_extras", label: "Leads de Extras", group: "Pessoas" },
  { id: "servicos", label: "Serviços", group: "Operações" },
  { id: "historico_diario", label: "Histórico diário (GPS)", group: "Operações" },
  { id: "pdas", label: "PDAs", group: "Operações" },
  { id: "tarefas", label: "Tarefas", group: "Operações" },
  { id: "reservas_operacoes", label: "Reservas & Operações", group: "Operações" },
  { id: "atividade_diaria", label: "Actividade Diária", group: "Operações" },
  { id: "radio", label: "Rádio", group: "Operações" },
  { id: "extras_dia", label: "Extras Dia", group: "Operações" },
  { id: "passagem_turno", label: "Passagem de Turno", group: "Operações" },
  { id: "passagem_resumo_dia", label: "Passagem — Resumo do dia", group: "Operações" },
  { id: "disponibilidade_extras", label: "Disponibilidade dos extras", group: "Operações" },
  { id: "whatsapp", label: "WhatsApp", group: "Operações" },
  { id: "clientes", label: "Clientes", group: "Suporte" },
  { id: "contactos", label: "Contactos (pesquisa unificada e diretório)", group: "Suporte" },
  { id: "comunicacao", label: "Comunicação (caixas de email partilhadas)", group: "Suporte" },
  { id: "reclamacoes", label: "Reclamações", group: "Suporte" },
  { id: "criticas", label: "Críticas Google", group: "Suporte" },
  { id: "ocorrencias", label: "Ocorrências", group: "Suporte" },
  { id: "perdidos", label: "Perdidos e Achados", group: "Suporte" },
  { id: "despesas", label: "Despesas", group: "Financeiro" },
  { id: "parcerias", label: "Parcerias", group: "Financeiro" },
  { id: "projetos", label: "Projetos", group: "Financeiro" },
  { id: "marketing", label: "Marketing", group: "Financeiro" },
  { id: "financeiro", label: "Financeiro (totais e dashboards)", group: "Financeiro" },
  { id: "anual", label: "Anual", group: "Financeiro" },
  { id: "faturacao", label: "Faturação", group: "Financeiro" },
  { id: "dashboards", label: "Dashboards (sem Faturação)", group: "Dashboards" },
  { id: "utilizadores", label: "Utilizadores", group: "Sistema" },
  { id: "permissoes", label: "Permissões", group: "Sistema" },
  { id: "sincronizacao", label: "Sincronização", group: "Sistema" },
  { id: "integracoes", label: "Integrações", group: "Sistema" },
  { id: "definicoes", label: "Definições", group: "Sistema" },
  { id: "logs", label: "Logs", group: "Sistema" },
  { id: "api_keys", label: "API Keys", group: "Sistema" },
  { id: "manutencao", label: "Manutenção (migrações, correções)", group: "Sistema" },
];

// ─── Matriz ──────────────────────────────────────────────────────────────────
// Notação compacta: "alcance:ações" com v=view e=edit x=export m=manage.
type Spec = `${Access}:${string}`;
type Row = Partial<Record<Role, Spec>>;

/** Mesma entrada para vários papéis. */
const same = (spec: Spec, ...roles: Role[]): Row => Object.fromEntries(roles.map(r => [r, spec]));
const NAT_OPS: Role[] = ["frontoffice", "backoffice"];
const TOP: Role[] = ["admin", "super_admin"];
const ALL: Role[] = [...ROLES];

const MATRIX_SPEC: Record<ModuleId, Row> = {
  // O que é de cada um: toda a gente.
  ficha: same("own:ve", ...ALL),
  disponibilidade: same("own:ve", ...ALL),
  formacao: {
    ...same("own:ve", "user", "extra", "condutor"),
    // "Formação admin" do TL: progresso e atribuição de percursos à equipa.
    team_leader: "below_city:ve", supervisor: "city:ve",
    ...same("national:ve", ...NAT_OPS), ...same("national:vexm", ...TOP),
  },
  avaliacao: {
    ...same("own:v", "extra", "condutor"),
    team_leader: "below_city:v", supervisor: "city:ve",
    ...same("national:ve", ...NAT_OPS), ...same("national:vexm", ...TOP),
  },
  avaliacao_operacional: { supervisor: "city:v", ...same("national:v", ...NAT_OPS), ...same("national:vx", ...TOP) },
  servicos: {
    ...same("city:v", "extra", "condutor"),
    ...same("city:ve", "team_leader", "supervisor"),
    ...same("national:ve", ...NAT_OPS), ...same("national:vem", ...TOP),
  },
  historico_diario: {
    ...same("own:v", "extra", "condutor"),
    ...same("city:v", "team_leader", "supervisor"),
    ...same("national:v", ...NAT_OPS), ...same("national:vem", ...TOP),
  },
  pdas: {
    ...same("own:ve", "extra", "condutor"),
    ...same("city:ve", "team_leader", "supervisor"),
    ...same("national:ve", ...NAT_OPS), ...same("national:vem", ...TOP),
  },
  tarefas: {
    ...same("own:ve", "extra", "condutor"),
    team_leader: "below_city:ve", supervisor: "city:vem",
    ...same("national:vem", ...NAT_OPS), ...same("national:vem", ...TOP),
  },
  despesas: {
    condutor: "own:ve", team_leader: "below_city:ve", supervisor: "city:vex",
    ...same("national:vex", ...NAT_OPS), ...same("national:vexm", ...TOP),
  },
  reservas_operacoes: {
    ...same("city:v", "condutor", "team_leader", "supervisor"),
    ...same("national:v", ...NAT_OPS), ...same("national:vexm", ...TOP),
  },
  extras_dia: {
    condutor: "city:v", ...same("city:ve", "team_leader", "supervisor"),
    ...same("national:ve", ...NAT_OPS), ...same("national:vem", ...TOP),
  },
  parcerias: {
    ...same("city:v", "team_leader", "supervisor"),
    ...same("national:v", ...NAT_OPS), ...same("national:vexm", ...TOP),
  },
  rh: {
    team_leader: "below_city:ve", supervisor: "city:ve",
    ...same("national:ve", ...NAT_OPS), ...same("national:vexm", ...TOP),
  },
  rh_salarios: same("national:vexm", ...TOP),
  leads_extras: {
    ...same("city:ve", "team_leader", "supervisor"),
    ...same("national:ve", ...NAT_OPS), ...same("national:vem", ...TOP),
  },
  atividade_diaria: {
    ...same("city:ve", "team_leader", "supervisor"),
    ...same("national:ve", ...NAT_OPS), ...same("national:vem", ...TOP),
  },
  radio: {
    ...same("city:ve", "team_leader", "supervisor"),
    ...same("national:ve", ...NAT_OPS), ...same("national:vem", ...TOP),
  },
  passagem_turno: {
    ...same("city:ve", "team_leader", "supervisor"),
    ...same("national:ve", ...NAT_OPS), ...same("national:vem", ...TOP),
  },
  passagem_resumo_dia: { supervisor: "city:v", ...same("national:v", ...NAT_OPS), ...same("national:v", ...TOP) },
  disponibilidade_extras: {
    ...same("city:ve", "team_leader", "supervisor"),
    ...same("national:ve", ...NAT_OPS), ...same("national:vem", ...TOP),
  },
  whatsapp: {
    ...same("city:ve", "team_leader", "supervisor"),
    ...same("national:ve", ...NAT_OPS), ...same("national:vem", ...TOP),
  },
  clientes: {
    ...same("city:ve", "team_leader", "supervisor"),
    ...same("national:ve", ...NAT_OPS), ...same("national:vexm", ...TOP),
  },
  // Contactos (pedido do dono set 2026): pesquisa unificada + diretório da
  // empresa, com as mesmas entregas dos Clientes. Cada tipo de contacto
  // precisa ainda do seu módulo (shared/contacts.ts → contactKindsFor).
  contactos: {
    ...same("city:ve", "team_leader", "supervisor"),
    ...same("national:ve", ...NAT_OPS), ...same("national:vexm", ...TOP),
  },
  // Comunicação (caixas de email partilhadas, pedido do dono set 2026). Cada
  // caixa tem ainda a sua regra (módulo + papéis + cidade) em shared/mail.ts;
  // "O meu email" (caixa pessoal) não depende deste módulo — só do dono.
  comunicacao: {
    ...same("city:ve", "team_leader", "supervisor"),
    ...same("national:ve", ...NAT_OPS), ...same("national:vem", ...TOP),
  },
  reclamacoes: {
    ...same("own:v", "extra", "condutor"),
    ...same("city:ve", "team_leader", "supervisor"),
    ...same("national:ve", ...NAT_OPS), ...same("national:vexm", ...TOP),
  },
  criticas: {
    ...same("own:v", "extra", "condutor"),
    ...same("city:ve", "team_leader", "supervisor"),
    ...same("national:ve", ...NAT_OPS), ...same("national:vexm", ...TOP),
  },
  ocorrencias: {
    ...same("own:v", "extra", "condutor"),
    ...same("city:ve", "team_leader", "supervisor"),
    ...same("national:ve", ...NAT_OPS), ...same("national:vexm", ...TOP),
  },
  perdidos: {
    condutor: "own:v",
    ...same("city:ve", "team_leader", "supervisor"),
    ...same("national:ve", ...NAT_OPS), ...same("national:vexm", ...TOP),
  },
  utilizadores: { supervisor: "city:vem", ...same("national:vem", ...NAT_OPS), ...same("national:vem", ...TOP) },
  permissoes: { supervisor: "city:vem", backoffice: "national:vem", ...same("national:vem", ...TOP) },
  sincronizacao: { supervisor: "city:ve", ...same("national:ve", ...NAT_OPS), ...same("national:vem", ...TOP) },
  integracoes: { supervisor: "city:ve", ...same("national:ve", ...NAT_OPS), ...same("national:vem", ...TOP) },
  // Dashboards: só a partir de admin (matriz do dono: "admin = backoffice + dashboards").
  dashboards: same("national:v", ...TOP),
  // Correção do dono (24 set 2026): Marketing só super_admin (admin não).
  marketing: { super_admin: "national:vexm" },
  // Correção do dono (24 set 2026): Logs só super_admin (admin não).
  logs: { super_admin: "national:v" },
  financeiro: same("national:vexm", ...TOP),
  // Correção do dono (24 set 2026): Anual só super_admin, como a Faturação.
  anual: { super_admin: "national:vexm" },
  projetos: same("national:vem", ...TOP),
  definicoes: same("national:vem", ...TOP),
  faturacao: { super_admin: "national:vexm" },
  api_keys: { super_admin: "national:vem" },
  manutencao: { super_admin: "national:vem" },
};

const LETTER: Record<string, Action> = { v: "view", e: "edit", x: "export", m: "manage" };
const NONE: Grant = Object.freeze({ access: "none", actions: [] });

function parse(spec: Spec | undefined): Grant {
  if (!spec) return NONE;
  const [access, letters] = spec.split(":") as [Access, string];
  return { access, actions: [...letters].map(l => LETTER[l]) };
}

export const MATRIX: Record<ModuleId, Record<Role, Grant>> = Object.fromEntries(
  (Object.keys(MATRIX_SPEC) as ModuleId[]).map(m => [m, Object.fromEntries(ROLES.map(r => [r, parse(MATRIX_SPEC[m][r])]))]),
) as Record<ModuleId, Record<Role, Grant>>;

// ─── Overrides por utilizador (pedido do dono, 24 set 2026) ─────────────────
// "Dar a cada pessoa permissão para qualquer coisa": para qualquer módulo da
// matriz, uma pessoa pode ter um override que SUBSTITUI o que o papel lhe dá
// (alcance + ações), com validade opcional (`expiresOn`, dia de Lisboa,
// inclusivo). access "none" = retirar o módulo. Guardados em user_permissions
// com a chave `module.<id>` (migração 0100); regras de quem pode dar o quê em
// shared/accessOverrides.ts.

export const ACCESS_RANK: Record<Access, number> = { none: 0, own: 1, below_city: 2, city: 3, national: 4 };
export const ACCESS_VALUES: readonly Access[] = ["none", "own", "below_city", "city", "national"];
export const ACTION_VALUES: readonly Action[] = ["view", "edit", "export", "manage"];
export const MODULE_IDS = MODULES.map(m => m.id) as [ModuleId, ...ModuleId[]];
export const isModuleId = (v: unknown): v is ModuleId => typeof v === "string" && (MODULE_IDS as string[]).includes(v);

export interface ModuleOverride { access: Access; actions: readonly Action[]; expiresOn?: string | null }
export type AccessOverrides = Partial<Record<ModuleId, ModuleOverride>>;

/** Chave em user_permissions de um override de módulo. */
export const moduleOverrideKey = (m: ModuleId) => `module.${m}`;

/** Dia de hoje em Lisboa (YYYY-MM-DD) — a validade é um dia inclusivo. */
function lisbonDay(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** O override ainda vale hoje? (sem data = sem fim) */
export function overrideActive(o: Pick<ModuleOverride, "expiresOn"> | null | undefined, today?: string): boolean {
  if (!o) return false;
  if (!o.expiresOn) return true;
  return String(o.expiresOn).slice(0, 10) >= (today ?? lisbonDay());
}

/** Forma canónica: ações válidas, por ordem, sempre com "ver"; sem ações = nada. */
export function normalizeGrant(g: { access: Access; actions: readonly Action[] }): Grant {
  if (!g || g.access === "none" || !ACCESS_VALUES.includes(g.access)) return NONE;
  const acts = ACTION_VALUES.filter(a => a === "view" || g.actions.includes(a));
  return { access: g.access, actions: acts };
}

/** Letras compactas (v/e/x/m) ↔ ações, como na matriz. */
export const actionsToLetters = (a: readonly Action[]) => ACTION_VALUES.filter(x => a.includes(x)).map(x => x === "export" ? "x" : x[0]).join("");
export const lettersToActions = (s: string | null | undefined): Action[] => [...new Set([...(s ?? "")].map(l => LETTER[l]).filter(Boolean))];

type UserLike = { role: string | null | undefined; accessOverrides?: AccessOverrides | null } | string | null | undefined;
const roleOf = (u: UserLike): string => (typeof u === "string" ? u : u?.role ?? "") || "";
const overridesOf = (u: UserLike): AccessOverrides | null | undefined => (typeof u === "object" && u ? u.accessOverrides : undefined);

/** O que o PAPEL dá no módulo (sem overrides). */
export function roleGrantFor(role: string | null | undefined, module: ModuleId): Grant {
  return isRole(role) ? MATRIX[module][role] : NONE;
}

/** Override ativo da pessoa neste módulo (ou null). */
export function activeOverride(user: UserLike, module: ModuleId, today?: string): ModuleOverride | null {
  const o = overridesOf(user)?.[module];
  return o && overrideActive(o, today) ? o : null;
}

/**
 * Acesso EFETIVO: override ativo da pessoa (se houver) — senão o do papel.
 * Papel desconhecido sem override = nada. É isto que o servidor
 * (requireAccess), o menu e os botões usam.
 */
export function grantFor(user: UserLike, module: ModuleId, today?: string): Grant {
  const o = activeOverride(user, module, today);
  return o ? normalizeGrant(o) : roleGrantFor(roleOf(user), module);
}

/** Acesso efetivo em todos os módulos (+ de onde vem). */
export function effectiveGrants(user: UserLike, today?: string): Record<ModuleId, Grant & { source: "role" | "override" }> {
  return Object.fromEntries(MODULE_IDS.map(m => {
    const o = activeOverride(user, m, today);
    return [m, { ...(o ? normalizeGrant(o) : roleGrantFor(roleOf(user), m)), source: o ? "override" : "role" }];
  })) as Record<ModuleId, Grant & { source: "role" | "override" }>;
}

/** Pode fazer `action` no módulo (em algum alcance)? */
export function can(user: UserLike, module: ModuleId, action: Action = "view"): boolean {
  const g = grantFor(user, module);
  return g.access !== "none" && g.actions.includes(action);
}

/** Alcance do papel no módulo. */
export function scopeFor(user: UserLike, module: ModuleId): Access {
  return grantFor(user, module).access;
}

/** Vê mais do que o próprio (cidade/equipa/nacional)? */
export function seesBeyondOwn(user: UserLike, module: ModuleId): boolean {
  const a = scopeFor(user, module);
  return a === "below_city" || a === "city" || a === "national";
}

// ─── Utilizadores e permissões ──────────────────────────────────────────────

/** Papéis que `actor` pode ATRIBUIR (criar/alterar para). */
export function assignableRoles(actor: UserLike): Role[] {
  const role = roleOf(actor);
  if (role === "super_admin") return [...ROLES];
  if (role === "admin") return ROLES.filter(r => roleRank(r) < ROLE_RANK.admin);
  if (role === "backoffice" || role === "frontoffice") return ROLES.filter(r => roleRank(r) <= ROLE_RANK.backoffice);
  if (role === "supervisor") return ROLES.filter(r => roleRank(r) <= ROLE_RANK.supervisor);
  return [];
}

/** Pode gerir (editar/ativar/convidar/mudar papel) uma conta com `targetRole`? */
export function canManageUserRole(actor: UserLike, targetRole: string | null | undefined): boolean {
  if (!can(actor, "utilizadores", "manage")) return false;
  return (assignableRoles(actor) as string[]).includes(String(targetRole ?? "user"));
}

/** Pode dar/retirar permissões a uma conta com `targetRole`? */
export function canGrantPermissionsTo(actor: UserLike, targetRole: string | null | undefined): boolean {
  if (!can(actor, "permissoes", "manage")) return false;
  const role = roleOf(actor);
  if (role === "super_admin") return true;
  if (role === "admin") return roleRank(targetRole) < ROLE_RANK.admin;
  // supervisor / backoffice: qualquer conta que não seja admin/super_admin
  return roleRank(targetRole) >= 0 && roleRank(targetRole) < ROLE_RANK.admin;
}

/**
 * Que permissões `actor` pode mexer ("não podes dar o que não tens"):
 *  - city.* (cidades extra) só quem é nacional;
 *  - finance.view_totals só quem tem o Financeiro;
 *  - extras_dia.team_leader qualquer um com Permissões.
 */
export function canTouchPermission(actor: UserLike, permissionId: string): boolean {
  if (!can(actor, "permissoes", "manage")) return false;
  if (permissionId.startsWith("city.")) return isNationalRole(roleOf(actor));
  if (permissionId === "finance.view_totals") return can(actor, "financeiro", "view");
  return true;
}

/**
 * Totais financeiros (receita, totais da empresa): quem tem o Financeiro, a
 * não ser que tenha deny de `finance.view_totals`; um grant explícito dá-os
 * também a supervisor / frontoffice / backoffice.
 */
export function canSeeFinanceTotalsFor(user: UserLike, overrides: Record<string, string> = {}): boolean {
  const ov = overrides["finance.view_totals"];
  if (ov === "deny") return false;
  if (can(user, "financeiro", "view")) return true;
  return ov === "grant" && ["supervisor", "frontoffice", "backoffice"].includes(roleOf(user));
}
