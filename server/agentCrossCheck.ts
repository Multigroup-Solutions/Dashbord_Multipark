/**
 * P3 lote 31a — Agentes × pessoas: junta o que é preciso para o cruzamento
 * (regras em shared/agentCrossCheck.ts) e devolve-o ao RH → Ligações.
 *
 * Só LÊ: Multipark (agentes, papéis, parques, empresa parceira e dias com
 * ações — só leitura, com LIMIT), e cá as fichas, utilizadores, ligações,
 * parcerias, Zello (contas e dias) e escala dos Extras. Não liga nada
 * sozinho: as ligações fazem-se no ecrã, uma a uma, com as rotas que já
 * existem (e ficam nos Logs). Fica 5 min em memória (o botão "Cruzar de novo"
 * força uma leitura nova).
 */
import { sql } from "drizzle-orm";
import { matchCityKey } from "../shared/city";
import { searchText } from "../shared/textKey";
import { cleanAgentName, isNonPersonAgentName, isScriptAgentName, isSystemAgentId } from "../shared/agentIdentity";
import { crossCheckAgents, crossCheckSummary, type CityKey, type XAgent, type XInput, type XPerson, type XUser, type XZelloAccount } from "../shared/agentCrossCheck";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const cityKey = (s: string | null | undefined): CityKey | null => {
  const k = matchCityKey(s);
  return k === "lisboa" || k === "porto" || k === "faro" ? k : null;
};
const OPS_TO_KEY: Record<string, CityKey> = { lisbon: "lisboa", porto: "porto", faro: "faro" };
const DAYS = 60;

let cache: { at: number; data: Awaited<ReturnType<typeof build>> } | null = null;

export async function loadAgentCrossCheck(opts: { refresh?: boolean } = {}) {
  if (!opts.refresh && cache && Date.now() - cache.at < 5 * 60_000) return cache.data;
  const data = await build();
  if (data.available) cache = { at: Date.now(), data };
  return data;
}

async function build() {
  const [{ listLiveAgents }, { readAgentRegistry, readAgentDays }, { safeMultiparkRead }, { getDb, listAgentPartners, listIgnoredAgents }, { listAgentAliases }, { looksLikeTestAgent }, { loadCityTrees, cityOfProject }] = await Promise.all([
    import("./multiparkDb/activityLive"), import("./multiparkDb/agentRegistry"), import("./multiparkDb/read"), import("./db"),
    import("./employeeAliases"), import("./personIdentity"), import("./aiOps/cities"),
  ]);
  const live = await listLiveAgents();
  if (!live.available) return { available: false as const, reason: live.reason };
  const reg = await safeMultiparkRead("agentes (registo)", () => readAgentRegistry());
  if (!reg.available) return { available: false as const, reason: reg.reason };
  const db = await getDb();
  if (!db) return { available: false as const, reason: "Base de dados indisponível." };

  // ── Agentes (um por userId: ações dos últimos 180 dias + todos os do "Agent") ──
  const byId = new Map<string, XAgent>();
  const regById = new Map(reg.data.map((r) => [r.userId, r]));
  for (const id of new Set([...live.data.map((a) => a.agentUserId), ...reg.data.map((r) => r.userId)])) {
    const l = live.data.find((a) => a.agentUserId === id);
    const r = regById.get(id);
    const names = [...new Set([...(l?.agentNames ?? []), ...(r?.name ? [r.name] : [])])];
    const name = names[0] ?? null;
    const email = l?.email ?? r?.memberEmail ?? null;
    const excluded = isSystemAgentId(id) ? "sistema" : isScriptAgentName(name) ? "script" : looksLikeTestAgent(name, email) ? "teste" : null;
    const roles = r?.roles ?? (l?.partnerOnly ? ["PARTNER"] : []);
    byId.set(id, {
      userId: id, name, names, email, active: r ? r.active : !!l?.active, roles, parks: r?.parks ?? [],
      cities: [...new Set((r?.cities ?? []).map(cityKey).filter((x): x is CityKey => !!x))],
      total: l?.total ?? 0, lastSeen: l?.lastSeen ?? null, excluded,
      partnerLike: !excluded && ((roles.length > 0 && roles.every((x) => x === "PARTNER")) || isNonPersonAgentName(name, email)),
      mpPartner: r?.partner ?? null,
    });
  }

  // ── Fichas, utilizadores, ligações ──
  const trees = await loadCityTrees().catch(() => []);
  const emps = rowsOf(await db.execute(sql`SELECT id, fullName, email, personalEmail, phone, personalPhone, projectId, isActive, position, userId, multiparkAgentUserId, multiparkAgentName, zelloUsername FROM employees`));
  const aliases = await listAgentAliases();
  const accRows = rowsOf(await db.execute(sql`SELECT userId, employeeId FROM employee_accounts`).catch(() => [[]]));
  const userRows = rowsOf(await db.execute(sql`SELECT id, name, email, role FROM users WHERE isActive = 1`));
  const persons: XPerson[] = emps.map((e) => {
    const city = cityOfProject(e.projectId == null ? null : Number(e.projectId), trees);
    return {
      employeeId: Number(e.id), name: String(e.fullName ?? ""),
      emails: [e.email, e.personalEmail].map((x) => (x ? String(x).trim().toLowerCase() : "")).filter(Boolean),
      phones: [e.phone, e.personalPhone].map((x) => (x ? String(x) : "")).filter(Boolean),
      city: city ? OPS_TO_KEY[city.city] ?? null : null,
      active: Number(e.isActive) === 1, position: e.position ? String(e.position) : null,
      userId: e.userId == null ? null : Number(e.userId),
      agentIds: [...new Set([String(e.multiparkAgentUserId ?? "").trim(), ...aliases.filter((a) => a.employeeId === Number(e.id)).map((a) => a.agentUserId)].filter(Boolean))],
      legacyAgentName: e.multiparkAgentName ? String(e.multiparkAgentName) : null,
      zelloUsernames: e.zelloUsername ? [String(e.zelloUsername)] : [],
    };
  });
  const empOfUser = new Map<number, number>();
  for (const e of emps) if (e.userId != null && (Number(e.isActive) === 1 || !empOfUser.has(Number(e.userId)))) empOfUser.set(Number(e.userId), Number(e.id));
  for (const a of accRows) if (!empOfUser.has(Number(a.userId))) empOfUser.set(Number(a.userId), Number(a.employeeId));
  const users: XUser[] = userRows.map((u) => ({ id: Number(u.id), name: u.name ? String(u.name) : null, email: u.email ? String(u.email).toLowerCase() : null, role: String(u.role ?? ""), employeeId: empOfUser.get(Number(u.id)) ?? null }));
  // os e-mails dos utilizadores também identificam a ficha
  for (const u of users) {
    const p = u.employeeId != null ? persons.find((x) => x.employeeId === u.employeeId) : undefined;
    if (p && u.email && !p.emails.includes(u.email)) p.emails.push(u.email);
  }

  const partnerships = rowsOf(await db.execute(sql`SELECT id, name, multiparkKind, multiparkPartnerId, contactEmail, archivedAt FROM partnerships`).catch(() => [[]]))
    .map((p) => ({ id: Number(p.id), name: String(p.name ?? ""), kind: p.multiparkKind ?? null, multiparkPartnerId: p.multiparkPartnerId ? String(p.multiparkPartnerId) : null, contactEmail: p.contactEmail ?? null, archived: p.archivedAt != null }));
  const partnerByAgentName = new Map<string, number>();
  for (const m of await listAgentPartners()) { const k = searchText(cleanAgentName(m.agentName)); if (k) partnerByAgentName.set(k, m.partnershipId); }
  const ignoredAgentNames = new Set((await listIgnoredAgents()).map((n) => searchText(cleanAgentName(n))).filter(Boolean));

  // ── Zello (contas e dias) e escala dos Extras, últimos 60 dias ──
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);
  const zRows = rowsOf(await db.execute(sql`SELECT zelloUsername, DATE_FORMAT(date, '%Y-%m-%d') AS d, employeeId, displayName FROM daily_driver_history WHERE date >= ${since}`).catch(() => [[]]));
  const zelloDays = new Map<string, Set<string>>();
  const zelloSeen = new Map<string, XZelloAccount>();
  for (const r of zRows) {
    const u = String(r.zelloUsername ?? ""); if (!u) continue;
    const s = zelloDays.get(u) ?? new Set<string>(); s.add(String(r.d)); zelloDays.set(u, s);
    if (!zelloSeen.has(u)) zelloSeen.set(u, { username: u, fullName: r.displayName ? String(r.displayName) : null, email: null, phone: null, employeeId: r.employeeId == null ? null : Number(r.employeeId) });
  }
  try {
    const { getZelloUsers } = await import("./zello");
    for (const z of await getZelloUsers()) {
      const prev = zelloSeen.get(z.name);
      zelloSeen.set(z.name, { username: z.name, fullName: z.fullName || prev?.fullName || null, email: z.email || null, phone: z.phone || null, employeeId: prev?.employeeId ?? null });
    }
  } catch { /* sem a API do Zello: ficam as contas do histórico */ }
  for (const p of persons) for (const u of p.zelloUsernames) { const z = zelloSeen.get(u); if (z && z.employeeId == null) z.employeeId = p.employeeId; }
  const escRows = rowsOf(await db.execute(sql`SELECT assignmentDate AS d, employeeId, personName, city FROM extras_dia_assignments WHERE assignmentDate >= ${since}`).catch(() => [[]]));
  const escalaDaysByEmployee = new Map<number, Set<string>>();
  const escalaDaysByName = new Map<string, { name: string; city: CityKey | null; days: Set<string> }>();
  for (const r of escRows) {
    if (r.employeeId != null) { const s = escalaDaysByEmployee.get(Number(r.employeeId)) ?? new Set<string>(); s.add(String(r.d)); escalaDaysByEmployee.set(Number(r.employeeId), s); continue; }
    const k = searchText(r.personName); if (!k) continue;
    const e = escalaDaysByName.get(k) ?? { name: String(r.personName), city: OPS_TO_KEY[String(r.city)] ?? null, days: new Set<string>() };
    e.days.add(String(r.d)); escalaDaysByName.set(k, e);
  }

  // ── Dias com ações na Multipark, só dos que (ainda) não estão em lado nenhum ──
  const linkedIds = new Set(persons.flatMap((p) => p.agentIds));
  const needDays = [...byId.values()].filter((a) => !a.excluded && !a.mpPartner && !linkedIds.has(a.userId) && a.total > 0).map((a) => a.userId);
  const daysRead = needDays.length ? await safeMultiparkRead("agentes (dias)", () => readAgentDays(needDays)) : { available: true as const, data: new Map<string, Set<string>>() };
  const agentDays = daysRead.available ? daysRead.data : new Map<string, Set<string>>();

  const input: XInput = {
    agents: [...byId.values()], persons, users, partnerships, partnerByAgentName, ignoredAgentNames,
    zello: [...zelloSeen.values()], agentDays, zelloDays, escalaDaysByEmployee, escalaDaysByName,
  };
  const r = crossCheckAgents(input);
  return {
    available: true as const,
    at: new Date().toISOString(),
    daysNotice: daysRead.available ? null : "Não deu para ler os dias de cada agente na Multipark: as sugestões pelo Zello e pela escala ficam de fora.",
    summary: crossCheckSummary(r),
    agents: r.agents.sort((a, b) => b.total - a.total || String(a.name ?? "").localeCompare(String(b.name ?? ""), "pt")),
    users: r.users,
  };
}
