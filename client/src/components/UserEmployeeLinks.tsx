import { Link } from 'wouter';
import { ExternalLink } from 'lucide-react';

type EmployeeLink = { id: number; fullName: string; isActive: number; projectName: string | null; viaAlias?: boolean };
type AgentLink = { agentUserId: string | null; agentName: string | null; principal: boolean };

export function UserEmployeeLinks({ employees }: { employees: EmployeeLink[] }) {
  if (!employees.length) return <span className="text-xs text-amber-700 dark:text-amber-400">Sem ficha RH associada</span>;
  // 41a: só avisa quando há mais de uma ficha ATIVA (uma ativa + antigas inativas é normal)
  const active = employees.filter(e => e.isActive).length;
  return <div className="min-w-0 space-y-1.5">
    {active > 1 && <p className="text-xs text-amber-700 dark:text-amber-400">Várias fichas ativas — rever ligação</p>}
    {employees.map(person => <div key={person.id} className="min-w-0">
      <Link href={`/rh?employeeId=${person.id}`} className="inline-flex max-w-full items-center gap-1 text-sm text-primary hover:underline" aria-label={`Abrir ficha RH de ${person.fullName}`}>
        <span className="[overflow-wrap:anywhere]">{person.fullName}</span><ExternalLink className="h-3 w-3 shrink-0" />
      </Link>
      <p className="text-xs text-muted-foreground">{person.projectName ?? 'Sem centro de custos'}{!person.isActive && ' · Inativa'}{person.viaAlias && ' · conta extra'}</p>
    </div>)}
  </div>;
}

/**
 * 41a: coluna "Agente" da lista de Utilizadores — os agentes da Multipark das
 * fichas desta conta (das ativas; só se não houver ativa, os das inativas).
 */
export function UserAgentLinks({ employees }: { employees: Array<EmployeeLink & { agents?: AgentLink[] }> }) {
  if (!employees.length) return <span className="text-xs text-muted-foreground">—</span>;
  const active = employees.filter(e => e.isActive);
  const from = active.length ? active : employees;
  const seen = new Set<string>();
  const agents: Array<AgentLink & { employeeId: number }> = [];
  for (const e of from) for (const a of e.agents ?? []) {
    const k = a.agentUserId ?? `n:${a.agentName}`;
    if (seen.has(k)) continue;
    seen.add(k);
    agents.push({ ...a, employeeId: e.id });
  }
  if (!agents.length) return <span className="text-xs text-amber-700 dark:text-amber-400">Sem agente</span>;
  return <div className="min-w-0 space-y-1">
    {agents.map(a => <div key={a.agentUserId ?? a.agentName ?? a.employeeId} className="min-w-0 text-sm">
      <span className="[overflow-wrap:anywhere]">{a.agentName ?? a.agentUserId}</span>
      {!a.principal && <span className="text-xs text-muted-foreground"> · extra</span>}
      {!active.length && <span className="text-xs text-muted-foreground"> · ficha inativa</span>}
    </div>)}
  </div>;
}
