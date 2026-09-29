/**
 * Sugestões para os "agentes por ligar" (RH): a que ficha pertence cada
 * agente da equipa, e a que parceria pertence cada agente de agência/parceiro.
 * Os agentes dos parceiros ligam-se à parceria para sabermos quando mexem em
 * carros ou fazem reservas; não precisam de utilizador no dashboard. PURO.
 */
import { agentListKind } from "../shared/multiparkExports";
import { cleanAgentName } from "../shared/agentIdentity";
import { matchKey } from "../shared/textKey";
import { nameKeys, normName } from "./identityLink";

export interface AgentForSuggest { agentName: string; email: string | null; partnerOnly?: boolean }
export interface EmpForSuggest { id: number; fullName: string; emails: string[]; hasAgent: boolean }
export interface PartnershipForSuggest { id: number; name: string; contactEmail: string | null }

export type AgentGroup = "equipa" | "parceiro";
export type AgentSuggestion =
  | { type: "ficha"; employeeId: number; name: string; by: "email" | "nome" }
  | { type: "parceiro"; partnershipId: number; name: string; by: "email" | "nome" };

const GENERIC_DOMAINS = new Set(["gmail.com", "hotmail.com", "outlook.com", "outlook.pt", "live.com", "icloud.com", "yahoo.com", "sapo.pt", "googlemail.com", "msn.com", "hotmail.pt"]);

/** A que grupo pertence o agente: equipa ou parceiro/agência. PURA. */
export function agentGroup(a: AgentForSuggest): AgentGroup {
  if (a.partnerOnly) return "parceiro";
  return agentListKind({ name: a.agentName, email: a.email, cities: [] }) === "agencia" ? "parceiro" : "equipa";
}

/** Sugestões para cada agente (mesma ordem). PURA. */
export function suggestForAgents(agents: readonly AgentForSuggest[], emps: readonly EmpForSuggest[], partnerships: readonly PartnershipForSuggest[]): Array<{ group: AgentGroup; suggestion: AgentSuggestion | null }> {
  const byEmail = new Map<string, EmpForSuggest[]>();
  const byName = new Map<string, EmpForSuggest[]>();
  for (const e of emps) {
    for (const m of e.emails) byEmail.set(m, [...(byEmail.get(m) ?? []), e]);
    if (e.hasAgent) continue;
    for (const k of nameKeys(e.fullName)) byName.set(k, [...(byName.get(k) ?? []), e]);
  }
  const uniq = <T extends { id: number }>(l: T[] | undefined) => (l ?? []).filter((x, i, arr) => arr.findIndex((y) => y.id === x.id) === i);

  const partnerKeys = partnerships.map((p) => ({ p, key: matchKey(p.name), domain: String(p.contactEmail ?? "").split("@")[1]?.toLowerCase() ?? "" }));

  return agents.map((a) => {
    const group = agentGroup(a);
    const email = a.email ? a.email.trim().toLowerCase() : null;
    if (group === "equipa") {
      const e1 = uniq(email ? byEmail.get(email) : undefined);
      if (e1.length === 1) return { group, suggestion: { type: "ficha", employeeId: e1[0].id, name: e1[0].fullName, by: "email" } };
      const e2 = uniq(byName.get(normName(cleanAgentName(a.agentName))));
      if (e2.length === 1 && !e2[0].hasAgent) return { group, suggestion: { type: "ficha", employeeId: e2[0].id, name: e2[0].fullName, by: "nome" } };
      return { group, suggestion: null };
    }
    // parceiro: pelo domínio do email (não genérico) ou pelo nome
    const domain = email?.split("@")[1] ?? "";
    const domainLabel = matchKey(domain.split(".")[0] ?? "");
    if (domain && !GENERIC_DOMAINS.has(domain)) {
      const hits = partnerKeys.filter((x) => (x.domain && x.domain === domain) || (domainLabel.length >= 4 && x.key.includes(domainLabel)));
      if (hits.length === 1) return { group, suggestion: { type: "parceiro", partnershipId: hits[0].p.id, name: hits[0].p.name, by: "email" } };
    }
    const ak = matchKey(cleanAgentName(a.agentName));
    const hits = partnerKeys.filter((x) => x.key.length >= 4 && ak.length >= 4 && (ak.includes(x.key) || x.key.includes(ak)));
    if (hits.length === 1) return { group, suggestion: { type: "parceiro", partnershipId: hits[0].p.id, name: hits[0].p.name, by: "nome" } };
    return { group, suggestion: null };
  });
}
