import { Link } from 'wouter';
import { MailCheck } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/** "YYYY-MM-DD HH:MM:SS" (UTC) → dd/MM HH:mm (hora de Lisboa). */
function fmt(ts: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString('pt-PT', { timeZone: 'Europe/Lisbon', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/**
 * Ficha do colaborador/extra → "Comunicações automáticas": os emails que a
 * aplicação lhe enviou sozinha (pedidos/lembretes de disponibilidade, avisos
 * de escala…). Não aparecem na caixa partilhada da Comunicação; aqui vê-se se
 * a pessoa respondeu e abre-se a conversa.
 */
export function EmployeeAutoMail({ employeeId }: { employeeId: number }) {
  const q = trpc.rh.autoMail.useQuery({ employeeId });
  const rows = q.data ?? [];
  if (!q.isLoading && !q.error && rows.length === 0) return null;
  return <Card>
    <CardHeader><CardTitle className="flex items-center gap-2 text-base"><MailCheck className="h-4 w-4" />Comunicações automáticas</CardTitle></CardHeader>
    <CardContent>
      {q.isLoading ? <p className="text-sm text-muted-foreground">A carregar…</p>
        : q.error ? <p role="alert" className="text-sm text-destructive">{q.error.message}</p>
        : <ul className="divide-y">{rows.map(r => {
          const subject = r.subject || r.kindLabel;
          return <li key={r.id} className="py-2 text-sm flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-xs text-muted-foreground tabular-nums w-24 shrink-0">{fmt(r.sentAt)}</span>
            <span className="text-xs text-muted-foreground shrink-0">{r.kindLabel}</span>
            <span className="min-w-0 flex-1 truncate">
              {r.threadId ? <Link className="hover:underline" href={`/comunicacao?${r.mailboxKey ? `caixa=${encodeURIComponent(r.mailboxKey)}&` : ''}t=${r.threadId}`}>{subject}</Link> : subject}
            </span>
            <Badge variant={r.status === 'respondido' ? 'default' : 'outline'}>{r.status === 'respondido' ? 'Respondido' : 'Enviado'}</Badge>
          </li>;
        })}</ul>}
    </CardContent>
  </Card>;
}
