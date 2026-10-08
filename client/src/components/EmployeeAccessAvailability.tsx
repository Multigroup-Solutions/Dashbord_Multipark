import { useState } from 'react';
import { Link } from 'wouter';
import { addDays, format, startOfWeek } from 'date-fns';
import { AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, Copy, ExternalLink, Link2, LogIn, Shield, UserRound } from 'lucide-react';
import { useAuth } from '@/_core/hooks/useAuth';
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

/**
 * Lote 46 (Jorge, 7 out 2026): com que conta(s) Google a pessoa entra. Sem
 * nenhuma: os emails da ficha com que tem de entrar e as contas que entraram
 * SEM ficha e parecem ser dela (só a quem gere o RH de todas as cidades).
 */
function EmployeeLoginsSection({ employeeId }: { employeeId: number }) {
  const q = trpc.rh.loginLinks.useQuery({ employeeId });
  const d = q.data;
  if (q.isLoading) return <p className="text-sm text-muted-foreground">A carregar as contas de login…</p>;
  if (q.error) return <p role="alert" className="text-sm text-destructive">{q.error.message}</p>;
  if (!d) return null;
  const active = d.logins.filter(l => l.isActive);
  return <div className="space-y-2">
    <p className="flex items-center gap-2 text-sm font-medium"><LogIn className="h-4 w-4" />Entra com a Google como</p>
    {active.length > 0 ? <ul className="space-y-1">{active.map(l => <li key={l.userId} className="flex flex-wrap items-center gap-2 text-sm">
      <Badge variant={l.principal ? 'default' : 'secondary'}>{l.principal ? 'principal' : 'extra'}</Badge>
      <span className="min-w-0 [overflow-wrap:anywhere]">{l.email ?? `conta #${l.userId}`}</span>
      <span className="text-xs text-muted-foreground">{l.lastSignedIn && l.loginMethod === 'google' ? `último login ${l.lastSignedIn}` : 'ainda não entrou'}</span>
    </li>)}</ul>
      : <div role="status" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/20 dark:text-amber-100 space-y-1">
        <p><strong>Sem conta ligada.</strong> {d.fichaEmails.length
          ? <>Liga-se sozinha quando a pessoa entrar com a Google com <strong className="[overflow-wrap:anywhere]">{d.fichaEmails.join(' ou ')}</strong>.</>
          : <>A ficha não tem email: põe o email Google da pessoa na ficha.</>}</p>
        <p className="text-xs">Se entrou com outro email, põe esse email na ficha ou liga a conta em <strong>Ligações (unir / separar)</strong>{d.canLink && !d.national ? ' (as contas sem ficha só as vê quem gere todas as cidades)' : ''}.</p>
      </div>}
    {d.candidates.length > 0 && <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">Entraram sem ficha e parecem ser esta pessoa:</p>
      <ul className="space-y-1">{d.candidates.map(c => <li key={c.userId} className="text-sm [overflow-wrap:anywhere]">
        {c.email ?? `conta #${c.userId}`}{c.name ? ` · ${c.name}` : ''} <span className="text-xs text-muted-foreground">({c.reason}{c.lastSignedIn ? ` · último login ${c.lastSignedIn}` : ''})</span>
      </li>)}</ul>
    </div>}
    {d.warnings.length > 0 && <ul className="list-disc pl-5 text-xs text-amber-800 dark:text-amber-200 space-y-1">{d.warnings.map(w => <li key={w}>{w}</li>)}</ul>}
    {d.canLink && <EmployeeLinkRequests employeeId={employeeId} />}
  </div>;
}

/**
 * 49c: pedidos "Liga a tua conta" e possíveis duplicados que apontam para
 * esta ficha — "Pedido de ligação: <email Google> diz ser <email/telefone>"
 * com Ligar / Recusar (as regras das Ligações). Só quem gere o RH.
 */
function EmployeeLinkRequests({ employeeId }: { employeeId: number }) {
  const utils = trpc.useUtils();
  const q = trpc.accountLink.forEmployee.useQuery({ employeeId }, { retry: false });
  const decide = trpc.accountLink.decide.useMutation({
    onSuccess: (_r, v) => {
      toast.success(v.action === 'link' ? 'Conta ligada a esta ficha.' : v.action === 'done' ? 'Marcado como tratado.' : 'Pedido recusado.');
      utils.accountLink.forEmployee.invalidate({ employeeId });
      utils.rh.loginLinks.invalidate({ employeeId });
      utils.rh.accountSummary.invalidate({ employeeId });
    },
    onError: (e) => toast.error(e.message),
  });
  const list = q.data?.requests ?? [];
  if (!list.length) return null;
  return <div role="status" className="space-y-2 rounded-md border border-sky-300 bg-sky-50 p-3 text-sm text-sky-950 dark:border-sky-800 dark:bg-sky-950/20 dark:text-sky-100">
    {list.map(r => <div key={r.id} className="space-y-1">
      <p className="font-medium [overflow-wrap:anywhere]">{r.summary}</p>
      <p className="text-xs">{r.createdAt}{r.note ? ` · ${r.note}` : ''}{r.otherEmployeeId ? <> · <Link className="underline" href={`/rh?employeeId=${r.otherEmployeeId}`}>abrir a ficha #{r.otherEmployeeId}</Link></> : null}</p>
      {q.data?.canDecide && <div className="flex flex-wrap gap-2">
        {r.kind === 'link'
          ? <Button size="sm" className="h-7" disabled={decide.isPending} onClick={() => decide.mutate({ requestId: r.id, action: 'link', employeeId })}><Link2 className="h-3.5 w-3.5 mr-1" />Ligar a esta ficha</Button>
          : <Button size="sm" variant="outline" className="h-7" disabled={decide.isPending} onClick={() => decide.mutate({ requestId: r.id, action: 'done' })}>Já tratei</Button>}
        <Button size="sm" variant="ghost" className="h-7" disabled={decide.isPending} onClick={() => { if (confirm(r.kind === 'duplicate' ? 'Não é a mesma pessoa?' : 'Recusar este pedido?')) decide.mutate({ requestId: r.id, action: 'reject' }); }}>{r.kind === 'duplicate' ? 'Não é a mesma pessoa' : 'Recusar'}</Button>
      </div>}
    </div>)}
  </div>;
}

export function EmployeeAccessAvailability({ employeeId, employeeName }: { employeeId: number; employeeName?: string | null }) {
  // Lote 46: na PRÓPRIA ficha, o atalho para marcar a disponibilidade.
  const { user } = useAuth();
  const isMine = (user as any)?.employee?.id === employeeId;
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
          : !a ? null : <>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div><p className="font-medium">{a.canManage ? <Link className="hover:underline" href={`/rh/utilizadores?userId=${a.id}`}>{a.name || a.email}</Link> : a.name || a.email}</p><p className="text-xs text-muted-foreground">{a.email}</p></div>
              {a.canManage && <Button variant="outline" size="sm" asChild><Link href={`/rh/utilizadores?userId=${a.id}`}><ExternalLink className="h-3.5 w-3.5 mr-1.5" />Abrir utilizador</Link></Button>}
            </div>
            <div className="flex flex-wrap gap-2"><Badge variant="secondary">{USER_ROLE_LABELS[a.role] ?? a.role}</Badge><Badge variant={a.isActive ? 'outline' : 'destructive'}>{a.isActive ? 'Ativo' : 'Inativo'}</Badge></div>
            {a.effectiveRole !== a.role && <p className="text-sm">Perfil efetivo: <strong>{USER_ROLE_LABELS[a.effectiveRole]}</strong></p>}
            <p className="text-sm"><strong>Cidades:</strong> {a.cities.missingCostCenter ? 'Sem centro de custos (cidade) — até se pôr a cidade na ficha, só abre a própria ficha e a disponibilidade' : a.cities.all ? 'Todas as cidades' : (a.cities.cityNames ?? [a.cities.cityName]).filter(Boolean).join(', ')}</p>
            {a.warnings.length > 0 && <div role="status" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-950 dark:bg-amber-950/20 dark:text-amber-100">
              <p className="flex gap-2 items-center text-sm font-medium"><AlertTriangle className="h-4 w-4 shrink-0" />Acessos a rever</p>
              <ul className="mt-2 list-disc pl-5 text-xs space-y-1">{a.warnings.map(w => <li key={w}>{w}</li>)}</ul>
            </div>}
            <details className="text-sm"><summary className="cursor-pointer font-medium">Ver permissões</summary>
              {a.canManage && <Link className="mt-2 inline-block text-primary underline" href={`/rh/utilizadores?userId=${a.id}&view=permissions`}>Gerir permissões deste utilizador</Link>}
              <ul className="mt-2 space-y-2">{a.permissions.map(p => <li key={p.id} className="flex justify-between gap-3"><span>{p.label}</span><span className="text-xs text-muted-foreground">{p.mode === 'grant' ? 'Concedida' : p.mode === 'deny' ? 'Negada' : !p.enabled ? 'Sem acesso' : p.id.startsWith('city.') ? 'Centro de custos' : 'Pelo perfil'}</span></li>)}</ul>
            </details>
          </>}
        <EmployeeLoginsSection employeeId={employeeId} />
        <EmployeeAgentSection employeeId={employeeId} name={employeeName} />
      </CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><CalendarDays className="h-4 w-4" />Disponibilidade</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-2"><Button size="icon" variant="outline" aria-label="Semana anterior" onClick={() => moveWeek(-7)}><ChevronLeft className="h-4 w-4" /></Button>
          <span className="text-sm font-medium">Semana de {format(new Date(`${weekStart}T12:00:00`), 'dd/MM/yyyy')}</span>
          <Button size="icon" variant="outline" aria-label="Semana seguinte" onClick={() => moveWeek(7)}><ChevronRight className="h-4 w-4" /></Button></div>
        {isMine && <Button size="sm" asChild><Link href={`/disponibilidade?week=${weekStart}`}><CalendarDays className="h-3.5 w-3.5 mr-1.5" />Marcar a minha disponibilidade</Link></Button>}
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
