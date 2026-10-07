/**
 * P3 lote 31a — Agentes × pessoas (Jorge, 6 out 2026): "vai ver todos os
 * agentes que estão na Multipark. Os agentes podem ser agregadores, parques,
 * parceiros, pros, agências, avenças, extras, condutores, funcionários… Eles
 * têm de estar em algum lado. Se não estiverem, arranja-os por nome, email,
 * cidade, telefone, movimentações feitas com o Zello. Cada agente tem que ser
 * um utilizador, ponto final. E cada utilizador tem que ter um agente."
 *
 * Cruza cada agente da Multipark (um por "userId") com o que temos cá:
 *  - ONDE ESTÁ: ficha (funcionário/extra/condutor), parceria (agência,
 *    agregador, parceiro — pela ligação cá ou pela empresa na Multipark),
 *    ignorado, sistema… ou em lado nenhum;
 *  - SUGESTÕES para os que estão em lado nenhum, com o PORQUÊ: mesmo email,
 *    nome, cidade, e os dias — mexeu na Multipark nos mesmos dias em que a
 *    pessoa estava no Zello ou na escala dos Extras. O telefone entra pelo
 *    Zello (a Multipark não guarda o telefone dos agentes): conta do Zello
 *    sem ficha cujo telefone é o de uma ficha → essa pessoa;
 *  - ao contrário: utilizadores (login) sem agente, com o agente provável.
 * PURO: os dados vêm lidos de fora (server/agentCrossCheck.ts).
 */
import { matchWords, searchText, emailKey } from "./textKey";
import { cleanAgentName } from "./agentIdentity";

export type CityKey = "lisboa" | "porto" | "faro";

export interface XAgent {
  userId: string;
  name: string | null;
  names: string[];
  email: string | null;
  active: boolean;
  roles: string[];
  parks: string[];
  cities: CityKey[];
  /** ações nos últimos 180 dias e a última */
  total: number;
  lastSeen: string | null;
  /** "sistema" | "script" | "teste" → fica de fora das contas */
  excluded: string | null;
  /** parece empresa (agência, agregador, parque) ou tem só contas PARTNER: procura-se a parceria */
  partnerLike: boolean;
  /** empresa parceira na Multipark: é o dono ("Partner".userId), membro, ou agente gerido por ela */
  mpPartner: { ownerUserId: string; name: string | null; type: string | null; how: "dono" | "membro" | "gerido" } | null;
}

export interface XPerson {
  employeeId: number;
  name: string;
  emails: string[];
  phones: string[];
  city: CityKey | null;
  active: boolean;
  position: string | null;
  userId: number | null;
  agentIds: string[];
  /** ficha ligada só pelo nome antigo (sem id) */
  legacyAgentName: string | null;
  zelloUsernames: string[];
}

export interface XUser { id: number; name: string | null; email: string | null; role: string; employeeId: number | null }
export interface XPartnership { id: number; name: string; kind: string | null; multiparkPartnerId: string | null; contactEmail: string | null; archived: boolean }
export interface XZelloAccount { username: string; fullName: string | null; email: string | null; phone: string | null; employeeId: number | null }

export interface XInput {
  agents: XAgent[];
  persons: XPerson[];
  users: XUser[];
  /**
   * 41a: contas DESATIVADAS — o agente continua preso à conta e à ficha (não
   * aparece como "sem utilizador"), mas não entram na lista de quem não tem agente.
   */
  inactiveUsers?: XUser[];
  partnerships: XPartnership[];
  /** agent_partner_map: chave do nome do agente → parceria */
  partnerByAgentName: Map<string, number>;
  ignoredAgentNames: Set<string>;
  zello: XZelloAccount[];
  /** dias (AAAA-MM-DD) com ações na Multipark, por agente (só os sem sítio) */
  agentDays: Map<string, Set<string>>;
  /** dias no Zello por conta */
  zelloDays: Map<string, Set<string>>;
  /** dias na escala dos Extras por ficha, e por nome (os da escala sem ficha) */
  escalaDaysByEmployee: Map<number, Set<string>>;
  escalaDaysByName: Map<string, { name: string; city: CityKey | null; days: Set<string> }>;
}

export type XPlace =
  | { kind: "ficha"; employeeId: number; name: string; byName: boolean; hasUser: boolean; active: boolean }
  | { kind: "parceria"; partnershipId: number; name: string; viaMultipark: boolean }
  | { kind: "parceiro_sem_parceria"; ownerUserId: string; name: string | null; type: string | null }
  | { kind: "ignorado" }
  | { kind: "sistema"; reason: string }
  | { kind: "nenhum" };

export interface XSuggestion {
  kind: "ficha" | "zello" | "escala" | "parceria";
  employeeId?: number;
  partnershipId?: number;
  zelloUsername?: string;
  label: string;
  score: number;
  reasons: string[];
}

export interface XAgentRow extends XAgent { place: XPlace; needsUser: boolean; suggestions: XSuggestion[] }
export interface XUserRow extends XUser { employeeName: string | null; suggestions: Array<{ agentUserId: string; agentName: string | null; score: number; reasons: string[] }> }

const GENERIC_DOMAINS = new Set(["gmail.com", "hotmail.com", "outlook.com", "outlook.pt", "live.com", "yahoo.com", "icloud.com", "sapo.pt", "multipark.pt", "airpark.pt", "redpark.pt"]);
const STOP = new Set(["da", "de", "do", "das", "dos", "e"]);

/** Últimos 9 dígitos (telemóvel PT com ou sem +351). PURA. */
export const phoneTail = (s: string | null | undefined): string => String(s ?? "").replace(/\D/g, "").slice(-9);

/** Palavras do nome sem partículas (e sem o sufixo de cidade dos agentes). PURA. */
export function nameWords(name: string | null | undefined): string[] {
  return matchWords(cleanAgentName(name)).filter((w) => !STOP.has(w) && (w.length > 1 || /\d/.test(w)));
}

/**
 * Quão parecido é o nome do agente com o da pessoa. PURA.
 * 60 = igual · 45 = primeiro + apelido(s) da pessoa (ex.: "Bruno Meireles" ↔
 * "Bruno Filipe Meireles Silva") · 15 = só o primeiro nome · 0.
 */
export function nameScore(agentName: string | null | undefined, personName: string | null | undefined): { score: number; reason: string | null } {
  const a = nameWords(agentName), p = nameWords(personName);
  if (!a.length || !p.length) return { score: 0, reason: null };
  if (a.join(" ") === p.join(" ")) return { score: 60, reason: "mesmo nome" };
  if (a[0] === p[0] && a.length >= 2 && a.slice(1).every((w) => p.slice(1).includes(w))) return { score: 45, reason: "nome parecido" };
  if (a[0] === p[0] && p.length >= 2 && p.slice(1).every((w) => a.slice(1).includes(w))) return { score: 45, reason: "nome parecido" };
  if (a.length === 1 && a[0] === p[0]) return { score: 15, reason: "só o primeiro nome" };
  return { score: 0, reason: null };
}

/** Semelhança dos dias (Jaccard) e quantos em comum. PURA. */
export function daysOverlap(a: Set<string> | undefined, b: Set<string> | undefined): { common: number; jaccard: number; ofAgent: number } {
  if (!a?.size || !b?.size) return { common: 0, jaccard: 0, ofAgent: a?.size ?? 0 };
  let common = 0;
  for (const d of a) if (b.has(d)) common++;
  return { common, jaccard: common / (a.size + b.size - common), ofAgent: a.size };
}

function daysPoints(o: { common: number; jaccard: number; ofAgent: number }, strong: number, weak: number, label: string): { score: number; reason: string | null } {
  if (o.common < 3) return { score: 0, reason: null };
  if (o.jaccard >= 0.6) return { score: strong, reason: `${label} em ${o.common} dos ${o.ofAgent} dias em que mexeu na Multipark` };
  if (o.jaccard >= 0.35) return { score: weak, reason: `${label} em ${o.common} dos ${o.ofAgent} dias em que mexeu na Multipark (em parte)` };
  return { score: 0, reason: null };
}

/** Pontos de um agente para uma ficha (email, nome, cidade, Zello, escala). PURA. */
export function scoreAgentPerson(agent: XAgent, person: XPerson, ctx: { agentDays?: Set<string>; zelloDays: Map<string, Set<string>>; escalaDays?: Set<string> }): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const ae = agent.email ? emailKey(agent.email) : "";
  if (ae && person.emails.some((e) => emailKey(e) === ae)) { score += 100; reasons.push("mesmo email"); }
  else if (ae) {
    const local = ae.split("@")[0];
    if (local.length >= 5 && person.emails.some((e) => emailKey(e).split("@")[0] === local)) { score += 30; reasons.push("email parecido"); }
  }
  let best = { score: 0, reason: null as string | null };
  for (const n of [agent.name, ...agent.names]) { const s = nameScore(n, person.name); if (s.score > best.score) best = s; }
  if (best.reason) { score += best.score; reasons.push(best.reason); }
  if (person.city && agent.cities.length) {
    if (agent.cities.includes(person.city)) { score += 10; reasons.push("mesma cidade"); }
    else { score -= 15; reasons.push("cidade diferente"); }
  }
  if (ctx.agentDays?.size) {
    const zd = new Set<string>();
    for (const u of person.zelloUsernames) for (const d of ctx.zelloDays.get(u) ?? []) zd.add(d);
    const z = daysPoints(daysOverlap(ctx.agentDays, zd), 40, 20, "no Zello");
    if (z.reason) { score += z.score; reasons.push(z.reason); }
    const e = daysPoints(daysOverlap(ctx.agentDays, ctx.escalaDays), 30, 15, "na escala");
    if (e.reason) { score += e.score; reasons.push(e.reason); }
  }
  if (person.agentIds.length) { score -= 10; reasons.push("já tem outro agente (seria conta extra)"); }
  if (!person.active) { score -= 20; reasons.push("ficha inativa"); }
  return { score, reasons };
}

const domainOf = (e: string | null | undefined) => (e && e.includes("@") ? emailKey(e).split("@")[1] : "");

/** Cruza tudo. PURA. */
export function crossCheckAgents(i: XInput): { agents: XAgentRow[]; users: XUserRow[] } {
  const byAgentId = new Map<string, XPerson>();
  for (const p of i.persons) for (const id of p.agentIds) if (!byAgentId.has(id) || p.active) byAgentId.set(id, p);
  const byLegacyName = new Map<string, XPerson[]>();
  for (const p of i.persons) if (p.legacyAgentName && !p.agentIds.length) {
    const k = searchText(cleanAgentName(p.legacyAgentName));
    if (k) byLegacyName.set(k, [...(byLegacyName.get(k) ?? []), p]);
  }
  const allUsers = [...i.users, ...(i.inactiveUsers ?? [])];
  const userIds = new Set(allUsers.map((u) => u.id));
  const hasUser = (p: XPerson) => (p.userId != null && userIds.has(p.userId)) || allUsers.some((u) => u.employeeId === p.employeeId);
  const partnershipByMp = new Map(i.partnerships.filter((p) => p.multiparkPartnerId).map((p) => [String(p.multiparkPartnerId), p]));
  const partnershipById = new Map(i.partnerships.map((p) => [p.id, p]));
  const personById = new Map(i.persons.map((p) => [p.employeeId, p]));
  // Conta do Zello sem ficha cujo telefone/email é o de uma ficha → é essa pessoa (ponte do telefone)
  const zelloOwner = new Map<string, number>();
  for (const z of i.zello) {
    if (z.employeeId != null) { zelloOwner.set(z.username, z.employeeId); continue; }
    const tail = phoneTail(z.phone), ze = z.email ? emailKey(z.email) : "";
    const hit = i.persons.filter((p) => (tail.length === 9 && p.phones.some((ph) => phoneTail(ph) === tail)) || (ze && p.emails.some((e) => emailKey(e) === ze)));
    if (hit.length === 1) zelloOwner.set(z.username, hit[0].employeeId);
  }
  const personsZ: XPerson[] = i.persons.map((p) => {
    const extra = [...zelloOwner].filter(([, id]) => id === p.employeeId).map(([u]) => u);
    return extra.length ? { ...p, zelloUsernames: [...new Set([...p.zelloUsernames, ...extra])] } : p;
  });

  const agents: XAgentRow[] = i.agents.map((a) => {
    const nameKey = searchText(cleanAgentName(a.name));
    let place: XPlace = { kind: "nenhum" };
    const linked = byAgentId.get(a.userId);
    const legacy = !linked && nameKey ? byLegacyName.get(nameKey) : undefined;
    const pmap = nameKey ? [nameKey, ...a.names.map((n) => searchText(cleanAgentName(n)))].map((k) => i.partnerByAgentName.get(k)).find((x) => x != null) : undefined;
    if (a.excluded) place = { kind: "sistema", reason: a.excluded };
    else if (linked) place = { kind: "ficha", employeeId: linked.employeeId, name: linked.name, byName: false, hasUser: hasUser(linked), active: linked.active };
    else if (legacy?.length === 1) place = { kind: "ficha", employeeId: legacy[0].employeeId, name: legacy[0].name, byName: true, hasUser: hasUser(legacy[0]), active: legacy[0].active };
    else if (pmap != null && partnershipById.has(pmap)) place = { kind: "parceria", partnershipId: pmap, name: partnershipById.get(pmap)!.name, viaMultipark: false };
    else if (a.mpPartner) {
      const p = partnershipByMp.get(a.mpPartner.ownerUserId);
      place = p ? { kind: "parceria", partnershipId: p.id, name: p.name, viaMultipark: true } : { kind: "parceiro_sem_parceria", ownerUserId: a.mpPartner.ownerUserId, name: a.mpPartner.name, type: a.mpPartner.type };
    } else if ((nameKey && i.ignoredAgentNames.has(nameKey))) place = { kind: "ignorado" };

    const suggestions: XSuggestion[] = [];
    if (place.kind === "nenhum") {
      const days = i.agentDays.get(a.userId);
      for (const p of personsZ) {
        const s = scoreAgentPerson(a, p, { agentDays: days, zelloDays: i.zelloDays, escalaDays: i.escalaDaysByEmployee.get(p.employeeId) });
        if (s.score >= 40) suggestions.push({ kind: "ficha", employeeId: p.employeeId, label: p.name, score: s.score, reasons: s.reasons });
      }
      // contas do Zello sem ficha (nem por telefone/email) que trabalharam nesses dias
      if (days?.size) {
        for (const z of i.zello) {
          if (zelloOwner.has(z.username)) continue;
          const o = daysOverlap(days, i.zelloDays.get(z.username));
          const d = daysPoints(o, 40, 20, "no Zello");
          const n = nameScore(a.name, z.fullName || z.username);
          const score = d.score + n.score;
          if (score >= 40) suggestions.push({ kind: "zello", zelloUsername: z.username, label: `Zello "${z.fullName || z.username}" (sem ficha${z.phone ? ` · ${z.phone}` : ""})`, score, reasons: [n.reason, d.reason].filter((x): x is string => !!x) });
        }
        for (const e of i.escalaDaysByName.values()) {
          const o = daysOverlap(days, e.days);
          const d = daysPoints(o, 30, 15, "na escala");
          const n = nameScore(a.name, e.name);
          const c = e.city && a.cities.length ? (a.cities.includes(e.city) ? 10 : -15) : 0;
          const score = d.score + n.score + c;
          if (score >= 40) suggestions.push({ kind: "escala", label: `Escala dos Extras: "${e.name}" (sem ficha)`, score, reasons: [n.reason, d.reason, c > 0 ? "mesma cidade" : c < 0 ? "cidade diferente" : null].filter((x): x is string => !!x) });
        }
      }
    }
    // agentes com cara de empresa (ou só contas PARTNER) sem empresa conhecida: parceria pelo domínio do email ou pelo nome
    if (place.kind === "nenhum" && a.partnerLike) {
      const dom = domainOf(a.email);
      const ak = nameWords(a.name).join("");
      for (const p of i.partnerships) {
        if (p.archived) continue;
        const reasons: string[] = [];
        let score = 0;
        if (dom && !GENERIC_DOMAINS.has(dom) && domainOf(p.contactEmail) === dom) { score += 70; reasons.push("mesmo domínio de email"); }
        const pk = nameWords(p.name).join("");
        if (ak.length >= 4 && pk.length >= 4 && (ak.includes(pk) || pk.includes(ak))) { score += 50; reasons.push("nome da parceria"); }
        if (score >= 50) suggestions.push({ kind: "parceria", partnershipId: p.id, label: `Parceria: ${p.name}`, score, reasons });
      }
    }
    suggestions.sort((x, y) => y.score - x.score || x.label.localeCompare(y.label, "pt"));
    const needsUser = place.kind === "ficha" && !place.hasUser;
    return { ...a, place, needsUser, suggestions: suggestions.slice(0, 3) };
  });

  // Utilizadores sem agente → o agente provável (dos que estão em lado nenhum)
  const free = agents.filter((a) => a.place.kind === "nenhum");
  const users: XUserRow[] = [];
  for (const u of i.users) {
    const p = u.employeeId != null ? personById.get(u.employeeId) : undefined;
    const pz = p ? personsZ.find((x) => x.employeeId === p.employeeId) ?? p : undefined;
    const hasAgent = !!pz && (pz.agentIds.length > 0 || agents.some((a) => a.place.kind === "ficha" && a.place.employeeId === pz.employeeId));
    if (hasAgent) continue;
    const person: XPerson = pz ?? { employeeId: -u.id, name: u.name ?? "", emails: u.email ? [u.email] : [], phones: [], city: null, active: true, position: null, userId: u.id, agentIds: [], legacyAgentName: null, zelloUsernames: [] };
    const emails = [...new Set([...person.emails, ...(u.email ? [u.email] : [])])];
    const sugg = free.map((a) => {
      const s = scoreAgentPerson(a, { ...person, emails }, { agentDays: i.agentDays.get(a.userId), zelloDays: i.zelloDays, escalaDays: pz ? i.escalaDaysByEmployee.get(pz.employeeId) : undefined });
      return { agentUserId: a.userId, agentName: a.name, score: s.score, reasons: s.reasons };
    }).filter((s) => s.score >= 40).sort((x, y) => y.score - x.score).slice(0, 3);
    users.push({ ...u, employeeName: pz?.name ?? null, suggestions: sugg });
  }
  return { agents, users };
}

/** Resumo para o topo do cartão. PURA. */
export function crossCheckSummary(r: { agents: XAgentRow[]; users: XUserRow[] }) {
  const people = r.agents.filter((a) => a.place.kind !== "sistema");
  const count = (k: XPlace["kind"]) => people.filter((a) => a.place.kind === k).length;
  return {
    agents: people.length,
    inFicha: count("ficha"),
    withoutUser: people.filter((a) => a.needsUser).length,
    partners: count("parceria") + count("parceiro_sem_parceria"),
    partnersToLink: people.filter((a) => a.place.kind === "parceiro_sem_parceria" || (a.place.kind === "parceria" && a.place.viaMultipark)).length,
    ignored: count("ignorado"),
    nowhere: count("nenhum"),
    nowhereWithSuggestion: people.filter((a) => a.place.kind === "nenhum" && a.suggestions.length > 0).length,
    usersWithoutAgent: r.users.length,
  };
}

/**
 * 31b — Jorge (6 out): "as sugestões com o mesmo email ligam-se sozinhas".
 * Agentes em lado nenhum (pessoas, não empresas) cujo email é o de UMA só
 * ficha ativa. Um email partilhado por mais de 2 agentes (caixa comum) não
 * conta. Se a ficha já tem agente, o novo entra como agente extra; se está
 * ligada só pelo nome antigo a outro agente, não se toca (fica para o ecrã). PURA.
 */
export function planEmailAutoLinks(rows: readonly XAgentRow[], persons: readonly XPerson[]): Array<{ agentUserId: string; agentName: string | null; employeeId: number; email: string }> {
  const agentsPerEmail = new Map<string, number>();
  for (const a of rows) { const e = a.email ? emailKey(a.email) : ""; if (e) agentsPerEmail.set(e, (agentsPerEmail.get(e) ?? 0) + 1); }
  const out: Array<{ agentUserId: string; agentName: string | null; employeeId: number; email: string }> = [];
  for (const a of rows) {
    if (a.place.kind !== "nenhum" || a.excluded || a.partnerLike) continue;
    const e = a.email ? emailKey(a.email) : "";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) || (agentsPerEmail.get(e) ?? 0) > 2) continue;
    const hits = persons.filter((p) => p.active && p.emails.some((x) => emailKey(x) === e));
    if (hits.length !== 1) continue;
    // ficha ligada só pelo nome antigo a OUTRO agente: a ligação nova apagava-a — fica para o ecrã
    const h = hits[0];
    if (!h.agentIds.length && h.legacyAgentName && searchText(cleanAgentName(h.legacyAgentName)) !== searchText(cleanAgentName(a.name))) continue;
    out.push({ agentUserId: a.userId, agentName: a.name, employeeId: h.employeeId, email: e });
  }
  return out;
}

