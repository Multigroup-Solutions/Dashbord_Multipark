import { Link } from 'wouter';
import { ExternalLink } from 'lucide-react';

type EmployeeLink = { id: number; fullName: string; isActive: number; projectName: string | null };

export function UserEmployeeLinks({ employees }: { employees: EmployeeLink[] }) {
  if (!employees.length) return <span className="text-xs text-amber-700 dark:text-amber-400">Sem ficha RH associada</span>;
  return <div className="space-y-1.5">
    {employees.length > 1 && <p className="text-xs text-amber-700 dark:text-amber-400">Várias fichas associadas — rever ligação</p>}
    {employees.map(person => <div key={person.id}>
      <Link href={`/rh?employeeId=${person.id}`} className="inline-flex items-center gap-1 text-sm text-primary hover:underline" aria-label={`Abrir ficha RH de ${person.fullName}`}>
        {person.fullName}<ExternalLink className="h-3 w-3 shrink-0" />
      </Link>
      <p className="text-xs text-muted-foreground">{person.projectName ?? 'Sem centro de custos'}{!person.isActive && ' · Inativa'}</p>
    </div>)}
  </div>;
}
