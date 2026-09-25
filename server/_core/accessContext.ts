/**
 * Acesso EFETIVO por pedido (papel + overrides por utilizador).
 *
 * O middleware autenticado (server/_core/trpc.ts) abre um contexto por
 * procedimento com as linhas de user_permissions da pessoa (UMA consulta,
 * memorizada) e as cidades que lhe correspondem. Daqui saem:
 *  - `cachedPermissionRows` — o cache que db.getUserPermissionOverrides usa;
 *  - `requestOverrides` — os overrides de módulo para requireAccess/can();
 *  - `adjustCityScope` — alarga/estreita o cityScope quando um override muda
 *    o alcance do módulo (ex.: supervisor com Serviços "nacional", ou
 *    backoffice com Despesas só "cidade").
 * Tarefas de fundo não têm contexto (tudo cai no comportamento antigo).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { AccessOverrides, Access, ModuleId } from "../../shared/access";
import type { CityAccess } from "../cityAccess";
import { cityScope } from "../cityScope";

export interface PermissionRow {
  permission: string;
  mode: "grant" | "deny";
  scope: string | null;
  actions: string | null;
  expiresOn: string | null;
}

export interface AccessRequest {
  userId: number;
  rows?: Promise<PermissionRow[]>;
  overrides?: AccessOverrides;
  /** Cidades do centro de custos (+ city.*), antes do alargamento do papel. */
  cityBase?: CityAccess;
  /** Todas as cidades (para um override "nacional"). */
  cityAll?: CityAccess;
  /** O cityScope deste pedido já foi mudado por um override. */
  adjusted?: boolean;
}

export const accessRequest = new AsyncLocalStorage<AccessRequest>();

/** Linhas de user_permissions da pessoa do pedido (memorizadas); undefined fora do pedido. */
export function cachedPermissionRows(userId: number, load: () => Promise<PermissionRow[]>): Promise<PermissionRow[]> | undefined {
  const req = accessRequest.getStore();
  if (!req || req.userId !== userId) return undefined;
  if (!req.rows) req.rows = load().catch((e) => { req.rows = undefined; throw e; });
  return req.rows;
}

/** Overrides de módulo da pessoa do pedido (já carregados pelo middleware). */
export function requestOverrides(userId: number | undefined): AccessOverrides | undefined {
  const req = accessRequest.getStore();
  return req && userId != null && req.userId === userId ? req.overrides : undefined;
}

/**
 * Ajusta o cityScope ao alcance efetivo do módulo que o procedimento acabou de
 * verificar: "nacional" → todas as cidades (se ainda estava na cidade base);
 * restante → nunca fora das cidades base. Só mexe no contexto da própria
 * pessoa, só dentro de um pedido e só quando há override em jogo
 * (`fromOverride`) ou o pedido já foi ajustado — sem overrides, tudo fica
 * exatamente como o papel dava.
 */
export function adjustCityScope(userId: number | undefined, access: Access, fromOverride: boolean): void {
  const req = accessRequest.getStore();
  const cur = cityScope.getStore();
  if (!req || !cur || userId == null || req.userId !== userId || !req.cityBase) return;
  if (!fromOverride && !req.adjusted) return;
  const base = req.cityBase;
  if (access === "none") return;
  if (access === "national") {
    if (!cur.all && req.cityAll && sameIds(cur.projectIds, base.projectIds)) {
      req.adjusted = true;
      cityScope.enterWith(req.cityAll);
    }
    return;
  }
  if (base.all) return;
  const inBase = new Set(base.projectIds);
  if (!cur.all && cur.projectIds.every(id => inBase.has(id))) return;
  const projectIds = cur.all ? [...base.projectIds] : cur.projectIds.filter(id => inBase.has(id));
  req.adjusted = true;
  cityScope.enterWith({ ...base, projectIds, all: false });
}

/** Qual módulo decide o alcance de cidade de um procedimento (pelo prefixo). */
const PATH_MODULE: Array<[string, ModuleId]> = [
  ["expenses.", "despesas"],
  ["reviews.", "criticas"],
  ["complaints.", "reclamacoes"],
  ["lostFound.", "perdidos"],
  ["incidents.", "ocorrencias"],
  ["extrasDia.", "extras_dia"],
  ["extrasAvailability.", "disponibilidade_extras"],
  ["shiftHandover.", "passagem_turno"],
  ["extraLeads.", "leads_extras"],
  ["whatsapp.", "whatsapp"],
  ["clients.", "clientes"],
  ["contacts.", "contactos"],
  ["mail.", "comunicacao"],
  ["services.", "servicos"],
  ["partnerships.", "parcerias"],
  ["tasks.", "tarefas"],
  ["training.", "formacao"],
  ["users.", "utilizadores"],
  ["permissions.", "permissoes"],
  ["marketing.", "marketing"],
  ["invoices.", "faturacao"],
  ["annual.", "anual"],
];

export function moduleForPath(path: string): ModuleId | undefined {
  return PATH_MODULE.find(([p]) => path.startsWith(p))?.[1];
}

function sameIds(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every(id => s.has(id));
}

/** Todas as cidades a partir das cidades base (mesma forma que applyRoleScope). */
export function allCitiesFrom(base: CityAccess, projects: Array<{ id: number; name: string; level: string }>): CityAccess {
  const cities = projects.filter(p => p.level === "city");
  return { ...base, all: true, missingCostCenter: false, cityIds: cities.map(p => p.id), cityNames: cities.map(p => p.name),
    projectIds: projects.map(p => p.id) };
}
