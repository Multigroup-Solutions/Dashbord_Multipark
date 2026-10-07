import { useState } from 'react';
import { Link } from 'wouter';
import { addDays, format, startOfWeek } from 'date-fns';
import { AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, Copy, ExternalLink, Link2, Shield, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { USER_ROLE_LABELS } from '@shared/userAccessSummary';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PersonLinksDialog } from '@/components/PersonLinksDialog';

/**
 * 41a: o agente da Multipark desta ficha (principal + extra), dentro do cartão
 * "Utilizador e permissões": "Abrir agente" (desempenho na dashboard), "Abrir na
 * Multipark" (com o endereço nas Definições; senão "Copiar ID") e "Ligações"
 * para unir/separar conta e agente — quem gere o RH.
 */
function EmployeeAgentSection({ employeeId, name }: { employeeId: number; name?: string | null }) {
  const q = trpc.rh.agentSummary.useQuery({ employeeId });
  const [links, setLinks] = useState(false);
  const d = q.data;
  const copy = (id: string) => {
    navigator.clipboard?.writeText(id).then(() => toast.success('ID do agente copiado.'), () => toast.error('Não deu para copiar.'));
  };
  return <div className="space-y-2 border-t pt-3">
    <p className="flex items-center gap-2 text-sm font-medium"><UserRound className="h-4 w-4" />Agente da Multipark</p>
    {q.isLoading ? <p className="text-sm text-muted-foreground">A carregar o agente…</p>
      : q.error ? <p role="alert" className="text-sm text-destructive">{q.error.message}</p>
      : !d ? null : <>
        {d.agents.length === 0 ? <p className="text-sm text-amber-700">Sem agente da Multipark ligado.</p>
          : <ul className="space-y-2">{d.agents.map((a, i) => <li key={a.agentUserId ?? `n${i}`} className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant={a.principal ? 'default' : 'secondary'}>{a.principal ? 'principal' : 'extra'}</Badge>
            <span className="min-w-0 [overflow-wrap:anywhere]">{a.agentName ?? a.agentUserId}</span>
            {a.agentUserId && <span className="font-mono text-xs text-muted-foreground">#{a.agentUserId}</span>}
            {a.url ? <Button variant="outline" size="sm" className="h-7" asChild><a href={a.url} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-3.5 w-3.5 mr-1" />Abrir na Multipark</a></Button>
              : a.agentUserId ? <Button variant="ghost" size="sm" className="h-7" title={d.hasAgentUrl ? undefined : 'Para abrir na Multipark: Definições → Operação → Endereço de um agente na Multipark'} onClick={() => copy(a.agentUserId!)}><Copy className="h-3.5 w-3.5 mr-1" />Copiar ID</Button> : null}
          </li>)}</ul>}
        <div className="flex flex-wrap gap-2">
          {d.canOpenAgent && d.agents.length > 0 && <Button variant="outline" size="sm" asChild><Link href={`/pessoas/condutores-agentes?ficha=${employeeId}`}><ExternalLink className="h-3.5 w-3.5 mr-1.5" />Abrir agente</Link></Button>}
          {d.canManageLinks && <Button variant="outline" size="sm" onClick={() => setLinks(true)}><Link2 className="h-3.5 w-3.5 mr-1.5" />Ligações (unir / separar)</Button>}
        </div>
      </>}
    <PersonLinksDialog employeeId={employeeId} name={name} open={links} onOpenChange={setLinks} />
  </div>;
}

export function EmployeeAccessAvailability({ employeeId, employeeName }: { employeeId: number; employeeName?: string | null }) {
  const [weekStart, setWeekStart] = useState(() => format(startOfWeek(new Date(), { weekStartsOn: 1 }), 'yyyy-MM-dd'));
  const account = trpc.rh.accountSummary.useQuery({ employeeId });
  const availability = trpc.extrasAvailability.forEmployee.useQuery({ employeeId, weekStart });
  const a = account.data;
  const moveWeek = (days: number) => setWeekStart(format(addDays(new Date(`${weekStart}T12:00:00`), days), 'yyyy-MM-dd'));
  return <div className="grid min-w-0 gap-4 lg:grid-cols-2">
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Shield className="h-4 w-4" />Utilizador e permissões</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {account.isLoading ? <p className="text-sm text-muted-foreground">A carregar o utilizador…</p>
          : account.error ? <p role="alert" className="text-sm text-destructive">{account.error.message}</p>
          : !a ? <p className="text-sm text-amber-700">Sem utilizador associado.</p> : <>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div><p className="font-medium">{a.canManage ? <Link className="hover:underline" href={`/rh/utilizadores?userId=${a.id}`}>{a.name || a.email}</Link> : a.name || a.email}</p><p className="text-xs text-muted-foreground">{a.email}</p></div>
              {a.canManage && <Button variant="outline" size="sm" asChild><Link href={`/rh/utilizadores?userId=${a.id}`}><ExternalLink className="h-3.5 w-3.5 mr-1.5" />Abrir utilizador</Link></Button>}
            </div>
            <div className="flex flex-wrap gap-2"><Badge variant="secondary">{USER_ROLE_LABELS[a.role] ?? a.role}</Badge><Badge variant={a.isActive ? 'outline' : 'destructive'}>{a.isActive ? 'Ativo' : 'Inativo'}</Badge></div>
            {a.effectiveRole !== a.role && <p className="text-sm">Perfil efetivo: <strong>{USER_ROLE_LABELS[a.effectiveRole]}</strong></p>}
            <p className="text-sm"><strong>Cidades:</strong> {a.cities.missingCostCenter ? 'Sem centro de custos — acesso bloqueado' : a.cities.all ? 'Todas as cidades' : (a.cities.cityNames ?? [a.cities.cityName]).filter(Boolean).join(', ')}</p>
            {a.warnings.length > 0 && <div role="status" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-950 dark:bg-amber-950/20 dark:text-amber-100">
              <p className="flex gap-2 items-center text-sm font-medium"><AlertTriangle className="h-4 w-4 shrink-0" />Acessos a rever</p>
              <ul className="mt-2 list-disc pl-5 text-xs space-y-1">{a.warnings.map(w => <li key={w}>{w}</li>)}</ul>
            </div>}
            <details className="text-sm"><summary className="cursor-pointer font-medium">Ver permissões</summary>
              {a.canManage && <Link className="mt-2 inline-block text-primary underline" href={`/rh/utilizadores?userId=${a.id}&view=permissions`}>Gerir permissões deste utilizador</Link>}
              <ul className="mt-2 space-y-2">{a.permissions.map(p => <li key={p.id} className="flex justify-between gap-3"><span>{p.label}</span><span className="text-xs text-muted-foreground">{p.mode === 'grant' ? 'Concedida' : p.mode === 'deny' ? 'Negada' : !p.enabled ? 'Sem acesso' : p.id.startsWith('city.') ? 'Centro de custos' : 'Pelo perfil'}</span></li>)}</ul>
            </details>
          </>}
        <EmployeeAgentSection employeeId={employeeId} name={employeeName} />
      </CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><CalendarDays className="h-4 w-4" />Disponibilidade</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-2"><Button size="icon" variant="outline" aria-label="Semana anterior" onClick={() => moveWeek(-7)}><ChevronLeft className="h-4 w-4" /></Button>
          <span className="text-sm font-medium">Semana de {format(new Date(`${weekStart}T12:00:00`), 'dd/MM/yyyy')}</span>
          <Button size="icon" variant="outline" aria-label="Semana seguinte" onClick={() => moveWeek(7)}><ChevronRight className="h-4 w-4" /></Button></div>
        {availability.isLoading ? <p className="text-sm text-muted-foreground">A carregar a disponibilidade…</p>
          : availability.error ? <p role="alert" className="text-sm text-destructive">{availability.error.message}</p>
          : !availability.data?.submitted ? <p className="text-sm text-muted-foreground">Ainda não foi indicada disponibilidade para esta semana.</p>
          : <ul className="divide-y">{availability.data.days.map(d => {
            const slots = [d.morning ? 'Manhã' : '', d.night ? 'Noite' : '', d.fromHour != null && d.toHour != null ? `${String(d.fromHour).padStart(2, '0')}h–${String(d.toHour).padStart(2, '0')}h` : ''].filter(Boolean);
            return <li key={d.day} className="py-2 text-sm"><div className="flex justify-between gap-3"><span>{d.label}</span><span className={slots.length ? 'font-medium text-green-700 dark:text-green-400' : 'text-muted-foreground'}>{!d.recorded ? 'Não indicada' : slots.join(' · ') || 'Indisponível'}</span></div>{d.note && <p className="mt-1 text-xs text-muted-foreground">{d.note}</p>}</li>;
          })}</ul>}
      </CardContent>
    </Card>
  </div>;
}
