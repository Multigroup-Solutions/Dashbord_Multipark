import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { useAuth } from '@/_core/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';

type Park = { id: number; name: string; parentId: number | null };
type Location = { id: number; title: string; address: string | null; projectId: number | null; selected: number; available: number;
  lastSyncAt: string | null; lastError: string | null; nextPageToken: string | null };
function projectLabel(p: Park, all: Park[]) {
  const names = [p.name], seen = new Set([p.id]); let parent = p.parentId;
  while (parent != null && !seen.has(parent)) {
    seen.add(parent); const next = all.find(v => v.id === parent); if (!next) break;
    names.unshift(next.name); parent = next.parentId;
  }
  return names.join(' / ');
}
function LocationRow({ location, projects, onSaved }: { location: Location; projects: Park[]; onSaved: () => void }) {
  const [projectId, setProjectId] = useState(location.projectId ? String(location.projectId) : '');
  const [selected, setSelected] = useState(!!location.selected);
  const save = trpc.integrations.googleBusiness.map.useMutation({ onSuccess: onSaved, onError: e => toast.error(e.message) });
  return <div className="rounded border p-3 space-y-2">
    <div className="flex flex-wrap justify-between gap-2"><strong>{location.title}</strong>
      <Badge variant={location.selected && location.available ? 'default' : 'secondary'}>
        {!location.available ? 'Sem acesso nesta conta' : location.selected ? location.lastSyncAt ? 'Recolha ativa' : 'Pronto para importar' : 'Por associar'}
      </Badge></div>
    <p className="text-sm text-muted-foreground">{location.address || 'Morada não indicada pela Google'}</p>
    <div className="flex flex-wrap gap-3 items-center">
      <select aria-label={`Projeto de ${location.title}`} className="border rounded p-2 max-w-full bg-background" value={projectId} onChange={e => setProjectId(e.target.value)}>
        <option value="">Escolher parque / projeto</option>
        {projects.map(p => <option key={p.id} value={p.id}>{projectLabel(p, projects)}</option>)}
      </select>
      <label className="flex gap-2 items-center"><input type="checkbox" checked={selected} disabled={!location.available} onChange={e => setSelected(e.target.checked)} />Importar avaliações</label>
      <Button size="sm" variant="outline" disabled={save.isPending || (selected && !projectId)} onClick={() => save.mutate({ id: location.id, projectId: projectId ? Number(projectId) : null, selected })}>Guardar associação</Button>
    </div>
    {location.lastError && <p className="text-sm text-destructive">{location.lastError}</p>}
    {location.nextPageToken && <p className="text-sm">Importação parcial; a próxima recolha continua o histórico.</p>}
  </div>;
}
function ConnectionPanel() {
  const utils = trpc.useUtils();
  const query = trpc.integrations.googleBusiness.status.useQuery(undefined, { retry: false });
  const { data: parks = [] } = trpc.projects.list.useQuery();
  const refresh = () => { void query.refetch(); void utils.reviews.invalidate(); };
  const discover = trpc.integrations.googleBusiness.discover.useMutation({
    onSuccess: d => { toast.success(`${d.found} perfis encontrados.`); refresh(); }, onError: e => { toast.error(e.message); refresh(); } });
  const sync = trpc.integrations.googleBusiness.sync.useMutation({ onSuccess: d => {
    if (!d.ok) toast.error('A recolha encontrou um erro. Consulta o estado de cada perfil.');
    else toast.success(`${d.imported} avaliações importadas/atualizadas; ${d.pending} por conciliar.${d.done ? '' : ' O histórico continua na próxima recolha.'}`);
    refresh();
  }, onError: e => { toast.error(e.message); refresh(); } });
  const disconnect = trpc.integrations.googleBusiness.disconnect.useMutation({ onSuccess: refresh, onError: e => toast.error(e.message) });
  const reconcile = trpc.integrations.googleBusiness.reconcile.useMutation({ onSuccess: refresh, onError: e => toast.error(e.message) });
  const data = query.data;
  const busy = discover.isPending || sync.isPending || disconnect.isPending;
  return <Card>
    <CardHeader><CardTitle className="flex flex-wrap justify-between gap-2 text-base">Ligação Google Business Profile
      <Badge variant={data?.status === 'connected' ? 'default' : 'secondary'}>{data?.status === 'connected' ? 'Conta autorizada' : data?.status === 'reauth_required' ? 'Reautorizar conta' : 'Desligado'}</Badge>
    </CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <p className="text-sm">Liga a conta Google que gere os perfis e associa cada estabelecimento ao parque correto. As avaliações de 1–3 estrelas são encaminhadas para Reclamações; as restantes ficam disponíveis para resposta.</p>
      {query.error && <p className="text-sm text-destructive">{query.error.message}</p>}
      {data?.accountEmail && <p className="text-sm">Conta: <strong>{data.accountEmail}</strong></p>}
      {data?.lastError && <p role="alert" className="text-sm text-destructive">{data.lastError}</p>}
      {data && !data.configured && <p className="text-sm text-destructive">Falta configurar as credenciais Google no servidor.</p>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !data?.configured} onClick={() => window.location.assign('/api/integrations/google-business/oauth/start')}>{data?.status === 'connected' ? 'Autorizar novamente' : 'Ligar Google Business Profile'}</Button>
        <Button variant="outline" disabled={busy || data?.status !== 'connected'} onClick={() => discover.mutate()}>Atualizar perfis</Button>
        <Button variant="outline" disabled={busy || data?.status !== 'connected' || !data.locations.some(l => l.selected && l.available)} onClick={() => sync.mutate()}>{sync.isPending ? 'A importar…' : 'Importar avaliações agora'}</Button>
        {data?.status === 'connected' && <Button variant="ghost" disabled={busy} onClick={() => disconnect.mutate()}>Desligar</Button>}
      </div>
      {data?.status === 'connected' && !data.locations.length && <p className="text-sm">Ainda sem perfis disponíveis. Confirma a aprovação da API pela Google e carrega em Atualizar perfis.</p>}
      {data?.locations.map(l => <LocationRow key={`${l.id}-${l.projectId}-${l.selected}`} location={l} projects={parks} onSaved={refresh} />)}
      {!!data?.pending.length && <div className="space-y-3"><h3 className="font-medium">Possíveis avaliações já recebidas por email</h3>
        <p className="text-sm text-muted-foreground">Escolhe a crítica existente ou importa como uma avaliação diferente. Estes casos aguardam a tua decisão para evitar duplicados.</p>
        {data.pending.map(p => <div className="border rounded p-3 space-y-2" key={p.key}>
          <p className="font-medium">{p.title} — {p.review.reviewer?.displayName || 'Utilizador Google'}</p>
          <p className="text-sm whitespace-pre-wrap">{p.review.comment || 'Sem texto'}</p>
          <div className="space-y-2">{p.candidateReviews.map(c => <div className="rounded bg-muted p-2 space-y-1" key={c.id}>
            <p className="text-sm">#{c.id} · {c.reviewerName} · {c.rating} estrelas · {c.reviewDate || 'Sem data'}{c.complaintId ? ` · Reclamação #${c.complaintId}` : ''}</p>
            <p className="text-sm whitespace-pre-wrap">{c.reviewText || 'Sem texto'}</p>
            <Button variant="outline" size="sm" disabled={reconcile.isPending} onClick={() => reconcile.mutate({ key: p.key, existingId: c.id })}>Associar à crítica #{c.id}</Button>
          </div>)}
            <Button variant="outline" size="sm" disabled={reconcile.isPending} onClick={() => reconcile.mutate({ key: p.key, existingId: null })}>Importar como diferente</Button></div>
        </div>)}
      </div>}
    </CardContent>
  </Card>;
}
export default function GoogleBusinessConnection() {
  const { user } = useAuth();
  const { data: access } = trpc.permissions.myCityAccess.useQuery();
  if (!user || !['admin', 'super_admin'].includes(user.role) || !access?.all) return null;
  return <ConnectionPanel />;
}
