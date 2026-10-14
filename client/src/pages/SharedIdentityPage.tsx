/**
 * Plano 05 — Sistema → "Identidade partilhada" (só super admin): cada conta do
 * dashboard e a conta Multipark (be-shared) ligada a ela. Ligar exige sempre
 * prova dos dois lados (docs/integration/05-dashboard-auth-unificada.md §3.1):
 *   - Propor ligação (L2): a pessoa confirma no email da conta Multipark;
 *   - Criar conta Multipark (L4): só se não existir; a pessoa define a palavra-passe;
 *   - Ligar pelas fichas (A): ficha aponta para o agente E o email é igual (simula primeiro);
 *   - Pedidos de acesso (L5): quem entrou com a conta Multipark sem ligação;
 *   - Desligar: as sessões da pessoa no dashboard terminam.
 * O servidor aplica as mesmas regras (sharedIdentityRouter: superAdminProcedure).
 */
import { useMemo, useState, type FormEvent } from "react";
import { useSearch } from "wouter";
import { toast } from "sonner";
import {
  AlertTriangle, CheckCircle2, Download, Inbox, Link2, Link2Off, Loader2, Mail, Search, ShieldAlert, UserPlus, Users, Wand2,
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { fmtPTDate, fmtPTDateTime } from "@/lib/lisbonTime";
import { ROLE_LABELS, type Role } from "@shared/access";
import { sharedRefusal } from "@shared/sharedIdentity";
import {
  IDENTITY_FILTERS, accessRequestCandidates, backfillSummary, filterIdentityRows, identityCounts, identityCsv, identityReadiness,
  linkMethodLabel, pageOf, type IdentityFilter, type IdentityRow,
} from "@shared/sharedIdentityView";

const PAGE_SIZE = 50;
const roleLabel = (r: string) => ROLE_LABELS[r as Role] ?? r;
const who = (u: Pick<IdentityRow, "name" | "email" | "id">) => u.name || u.email || `#${u.id}`;
const errMsg = (e: unknown, fallback: string) => String((e as { message?: string })?.message || fallback);

export default function SharedIdentityPage() {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "super_admin";
  const search = useSearch();
  const [tab, setTab] = useState(() => (new URLSearchParams(search).get("tab") === "pedidos" ? "pedidos" : "contas"));
  const overview = trpc.sharedIdentity.admin.overview.useQuery(undefined, { enabled: isSuperAdmin, retry: false, refetchOnWindowFocus: false });

  if (!isSuperAdmin) {
    return (
      <div role="alert" className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200 max-w-xl">
        <ShieldAlert className="h-5 w-5 shrink-0 mt-0.5" aria-hidden />
        <span>Só o super admin liga contas Multipark. Pede ao administrador.</span>
      </div>
    );
  }

  const d = overview.data;
  const rows: IdentityRow[] = (d?.users ?? []) as IdentityRow[];
  const readiness = d ? identityReadiness(d) : { ready: false, missing: [] as string[] };

  return (
    <div className="min-w-0 space-y-4 sm:space-y-6">
      <p className="text-sm text-muted-foreground max-w-3xl">
        Cada conta do dashboard e a conta Multipark (a mesma da app e do site) ligada a ela. Ligar exige sempre que a pessoa o confirme —
        nunca basta o email ser igual.
      </p>

      {overview.error && <QueryErrorNote error={overview.error} onRetry={() => overview.refetch()} retrying={overview.isFetching} what="as contas" />}
      {overview.isLoading && (
        <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> A carregar as contas…</div>
      )}

      {d && !readiness.ready && <ReadinessBanner missing={readiness.missing} />}

      {d && (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="contas"><Users className="h-4 w-4 mr-1.5" aria-hidden />Contas</TabsTrigger>
            <TabsTrigger value="pedidos">
              <Inbox className="h-4 w-4 mr-1.5" aria-hidden />Pedidos de acesso
              {d.pendingRequests > 0 && <Badge className="ml-1.5 h-5 px-1.5 text-[11px]" aria-label={`${d.pendingRequests} pendentes`}>{d.pendingRequests}</Badge>}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="contas" className="mt-4">
            <AccountsTab rows={rows} ready={readiness.ready} />
          </TabsContent>
          <TabsContent value="pedidos" className="mt-4">
            <AccessRequestsTab rows={rows} ready={readiness.ready} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function ReadinessBanner({ missing }: { missing: string[] }) {
  return (
    <div role="status" className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
      <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" aria-hidden />
      <div className="min-w-0 space-y-1">
        <p className="font-semibold">Este ecrã ainda não liga contas.</p>
        <p>Só funciona depois de:</p>
        <ul className="list-disc pl-5 space-y-0.5">
          {missing.includes("switches") && (
            <li>ligar os interruptores em <strong>Definições → Automações</strong> ("Conta Multipark: ligar as contas" e/ou "Conta Multipark: entrar com ela");</li>
          )}
          {missing.includes("config") && (
            <li>configurar <code className="text-[12px]">SHARED_AUTH_URL</code> e <code className="text-[12px]">SHARED_AUTH_SERVICE_TOKEN</code> no servidor.</li>
          )}
        </ul>
        <p className="text-[13px] opacity-90">Até lá vês a lista, mas as ações ficam desligadas.</p>
      </div>
    </div>
  );
}

// ─── Contas ──────────────────────────────────────────────────────────────────

type Dlg = { kind: "propose" | "create" | "unlink"; row: IdentityRow } | { kind: "backfill" } | null;

function AccountsTab({ rows, ready }: { rows: IdentityRow[]; ready: boolean }) {
  const [filter, setFilter] = useState<IdentityFilter>("all");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [dlg, setDlg] = useState<Dlg>(null);
  const counts = useMemo(() => identityCounts(rows), [rows]);
  const filtered = useMemo(() => filterIdentityRows(rows, { filter, search: q }), [rows, filter, q]);
  const pg = pageOf(filtered, page, PAGE_SIZE);
  const notReady = ready ? undefined : "Liga primeiro os interruptores e a configuração (ver o aviso acima).";

  const exportCsv = () => {
    const blob = new Blob([`﻿${identityCsv(filtered, roleLabel)}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `identidade-partilhada-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="p-3 sm:p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[200px] max-w-md">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden />
              <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder="Procurar nome, email ou #id" className="pl-8" aria-label="Procurar contas" />
            </div>
            <div className="flex flex-wrap gap-2 ml-auto">
              <Button variant="outline" size="sm" onClick={() => setDlg({ kind: "backfill" })} disabled={!ready} title={notReady}>
                <Wand2 className="h-4 w-4 mr-1" aria-hidden />Ligar pelas fichas
              </Button>
              <Button variant="outline" size="sm" onClick={exportCsv} disabled={filtered.length === 0}>
                <Download className="h-4 w-4 mr-1" aria-hidden />CSV
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtrar contas">
            {IDENTITY_FILTERS.map((f) => (
              <Button key={f.value} size="sm" variant={filter === f.value ? "selected" : "outline"} className="h-7 text-xs"
                aria-pressed={filter === f.value} onClick={() => { setFilter(f.value); setPage(0); }}>
                {f.label} <span className="ml-1 opacity-70 tabular-nums">{counts[f.value]}</span>
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableCaption className="sr-only">Contas do dashboard e a ligação à conta Multipark</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Papel</TableHead>
                  <TableHead>Ativo</TableHead>
                  <TableHead>Ficha</TableHead>
                  <TableHead>Ligação</TableHead>
                  <TableHead>Proposta aberta</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pg.items.length === 0 && (
                  <TableRow><TableCell colSpan={8} className="text-center text-sm text-muted-foreground py-8">Nenhuma conta com estes filtros.</TableCell></TableRow>
                )}
                {pg.items.map((u) => (
                  <TableRow key={u.id} className={u.isActive ? "" : "opacity-60"}>
                    <TableCell className="max-w-[220px]">
                      <span className="line-clamp-2 break-words font-medium" title={u.name ?? undefined}>{u.name ?? "Sem nome"}</span>
                      <span className="block text-[11px] text-muted-foreground">#{u.id}</span>
                    </TableCell>
                    <TableCell className="max-w-[240px] [overflow-wrap:anywhere] text-sm">{u.email ?? <span className="text-muted-foreground">sem email</span>}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm">{roleLabel(u.role)}</TableCell>
                    <TableCell className="text-sm">{u.isActive ? "Sim" : "Não"}</TableCell>
                    <TableCell className="text-sm">{u.hasFicha ? "Sim" : "Não"}</TableCell>
                    <TableCell className="text-sm min-w-[150px]">
                      {u.sharedUserId ? (
                        <span className="inline-flex flex-col">
                          <span className="inline-flex items-center gap-1 font-medium text-green-700 dark:text-green-400"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden />Ligada</span>
                          <span className="text-[11px] text-muted-foreground">{linkMethodLabel(u.linkMethod)}{u.linkedAt ? ` · ${fmtPTDate(u.linkedAt)}` : ""}</span>
                        </span>
                      ) : <span className="text-muted-foreground">Por ligar</span>}
                    </TableCell>
                    <TableCell className="text-sm min-w-[150px]">
                      {u.proposal ? (
                        <span className="inline-flex flex-col">
                          <span className="[overflow-wrap:anywhere]">{u.proposal.sharedEmail}</span>
                          <span className="text-[11px] text-muted-foreground">expira {fmtPTDateTime(u.proposal.expiresAt)}</span>
                        </span>
                      ) : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex flex-wrap justify-end gap-1">
                        {u.sharedUserId ? (
                          <Button size="sm" variant="ghost" className="h-8 text-destructive hover:text-destructive" disabled={!ready} title={notReady}
                            aria-label={`Desligar ${who(u)}`} onClick={() => setDlg({ kind: "unlink", row: u })}>
                            <Link2Off className="h-3.5 w-3.5 mr-1" aria-hidden />Desligar
                          </Button>
                        ) : (
                          <>
                            <Button size="sm" variant="outline" className="h-8" disabled={!ready} title={notReady}
                              aria-label={`Propor ligação a ${who(u)}`} onClick={() => setDlg({ kind: "propose", row: u })}>
                              <Mail className="h-3.5 w-3.5 mr-1" aria-hidden />Propor ligação
                            </Button>
                            <Button size="sm" variant="ghost" className="h-8" disabled={!ready || !u.email} title={notReady ?? (!u.email ? "Esta conta não tem email." : undefined)}
                              aria-label={`Criar conta Multipark para ${who(u)}`} onClick={() => setDlg({ kind: "create", row: u })}>
                              <UserPlus className="h-3.5 w-3.5 mr-1" aria-hidden />Criar conta Multipark
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
            <span>
              {filtered.length === 0 ? "0 contas" : `${pg.page * PAGE_SIZE + 1}–${Math.min(filtered.length, (pg.page + 1) * PAGE_SIZE)} de ${filtered.length} contas`}
            </span>
            {pg.pages > 1 && (
              <div className="flex items-center gap-1">
                <Button size="sm" variant="outline" className="h-7" disabled={pg.page === 0} onClick={() => setPage(pg.page - 1)}>Anterior</Button>
                <span className="px-1 tabular-nums">{pg.page + 1}/{pg.pages}</span>
                <Button size="sm" variant="outline" className="h-7" disabled={pg.page >= pg.pages - 1} onClick={() => setPage(pg.page + 1)}>Seguinte</Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {dlg?.kind === "propose" && <ProposeDialog row={dlg.row} onClose={() => setDlg(null)} />}
      {dlg?.kind === "create" && <CreateDialog row={dlg.row} onClose={() => setDlg(null)} onPropose={(row) => setDlg({ kind: "propose", row })} />}
      {dlg?.kind === "unlink" && <UnlinkDialog row={dlg.row} onClose={() => setDlg(null)} />}
      {dlg?.kind === "backfill" && <BackfillDialog rows={rows} onClose={() => setDlg(null)} />}
    </div>
  );
}

function useRefreshOverview() {
  const utils = trpc.useUtils();
  return () => Promise.all([utils.sharedIdentity.admin.overview.invalidate(), utils.sharedIdentity.admin.accessRequests.invalidate()]);
}

/** L2: o super admin propõe; a pessoa confirma no email da conta Multipark. */
function ProposeDialog({ row, onClose }: { row: IdentityRow; onClose: () => void }) {
  const refresh = useRefreshOverview();
  const propose = trpc.sharedIdentity.admin.propose.useMutation();
  const [email, setEmail] = useState(row.email ?? "");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await propose.mutateAsync({ userId: row.id, sharedEmail: email.trim() });
      toast.success(`Proposta enviada para ${r.sharedEmail}.`, { description: `A pessoa confirma no link do email. Expira a ${fmtPTDateTime(r.expiresAt)}.` });
      await refresh();
      onClose();
    } catch (x) {
      toast.error(errMsg(x, "Não foi possível enviar a proposta."));
    }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !propose.isPending) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Propor ligação — {who(row)}</DialogTitle>
            <DialogDescription>
              Enviamos um email para a conta Multipark com este endereço. A ligação só fica feita quando a pessoa abrir o link e confirmar (vale 72 horas).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="propose-email">Email da conta Multipark</Label>
            <Input id="propose-email" type="email" inputMode="email" autoCapitalize="none" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            <p className="text-xs text-muted-foreground">Por omissão o email desta conta do dashboard. Muda-o se a pessoa usa outro na Multipark.</p>
          </div>
          {row.proposal && (
            <p className="text-xs rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-500/10 px-2.5 py-2 text-amber-900 dark:text-amber-200">
              Já há uma proposta aberta para {row.proposal.sharedEmail} (expira {fmtPTDateTime(row.proposal.expiresAt)}). Enviar outra cancela essa.
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={propose.isPending}>Cancelar</Button>
            <Button type="submit" variant="selected" disabled={propose.isPending || !email.trim()}>
              {propose.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" aria-hidden /> : <Mail className="h-4 w-4 mr-1" aria-hidden />}Enviar proposta
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** L4: cria a conta Multipark (só se não existir) e liga-a. */
function CreateDialog({ row, onClose, onPropose }: { row: IdentityRow; onClose: () => void; onPropose: (row: IdentityRow) => void }) {
  const refresh = useRefreshOverview();
  const create = trpc.sharedIdentity.admin.createAccount.useMutation();
  const [exists, setExists] = useState(false);
  const run = async () => {
    setExists(false);
    try {
      const r = await create.mutateAsync({ userId: row.id });
      toast.success(`Conta Multipark criada e ligada (${r.sharedEmail}).`, {
        description: r.setPasswordEmailSent
          ? "A pessoa recebeu um email para definir a palavra-passe."
          : "O email para definir a palavra-passe não saiu — a pessoa pode usar \"Esqueci-me da palavra-passe\" no site da Multipark.",
      });
      await refresh();
      onClose();
    } catch (x) {
      const m = errMsg(x, "Não foi possível criar a conta.");
      if (m === sharedRefusal("exists")) setExists(true);
      else toast.error(m);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !create.isPending) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Criar conta Multipark — {who(row)}</DialogTitle>
          <DialogDescription>
            Cria a conta Multipark com o email <strong className="[overflow-wrap:anywhere]">{row.email}</strong> e liga-a já a esta conta do dashboard.
            A pessoa recebe um email "define a tua palavra-passe". Só funciona se ainda não houver conta Multipark com este email.
          </DialogDescription>
        </DialogHeader>
        {exists && (
          <div role="alert" className="text-sm rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-amber-900 dark:text-amber-200 space-y-2">
            <p>{sharedRefusal("exists")}</p>
            <Button size="sm" variant="outline" onClick={() => onPropose(row)}><Mail className="h-3.5 w-3.5 mr-1" aria-hidden />Propor ligação</Button>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={create.isPending}>Cancelar</Button>
          <Button type="button" variant="selected" onClick={run} disabled={create.isPending || exists}>
            {create.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" aria-hidden /> : <UserPlus className="h-4 w-4 mr-1" aria-hidden />}Criar conta
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UnlinkDialog({ row, onClose }: { row: IdentityRow; onClose: () => void }) {
  const refresh = useRefreshOverview();
  const unlink = trpc.sharedIdentity.admin.unlink.useMutation();
  const [reason, setReason] = useState("");
  const run = async () => {
    try {
      const r = await unlink.mutateAsync({ userId: row.id, reason: reason.trim() || undefined });
      if (r.ok) toast.success(`${who(row)} ficou desligada da conta Multipark. As sessões no dashboard terminaram.`);
      else toast.info("Esta conta já não estava ligada.");
      await refresh();
      onClose();
    } catch (x) {
      toast.error(errMsg(x, "Não foi possível desligar."));
    }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !unlink.isPending) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Desligar — {who(row)}</DialogTitle>
          <DialogDescription>
            A conta do dashboard deixa de estar ligada à conta Multipark e <strong>todas as sessões desta pessoa no dashboard terminam</strong> (tem de voltar a entrar).
            As propostas abertas são canceladas.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="unlink-reason">Motivo (opcional)</Label>
          <Textarea id="unlink-reason" value={reason} maxLength={300} rows={3} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: ligada à conta errada" />
          <p className="text-xs text-muted-foreground">Fica no registo (Logs).</p>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={unlink.isPending}>Cancelar</Button>
          <Button type="button" variant="destructive" onClick={run} disabled={unlink.isPending}>
            {unlink.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" aria-hidden /> : <Link2Off className="h-4 w-4 mr-1" aria-hidden />}Desligar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A: simula primeiro; "Aplicar" liga só as confirmadas (ficha → agente E email igual). */
function BackfillDialog({ rows, onClose }: { rows: IdentityRow[]; onClose: () => void }) {
  const refresh = useRefreshOverview();
  const backfill = trpc.sharedIdentity.admin.backfill.useMutation();
  type Report = NonNullable<typeof backfill.data>;
  const [sim, setSim] = useState<Report | null>(null);
  const [applied, setApplied] = useState<Report | null>(null);
  const nameOf = useMemo(() => new Map(rows.map((r) => [r.id, who(r)])), [rows]);

  const simulate = async () => {
    setApplied(null);
    try { setSim(await backfill.mutateAsync({ dryRun: true })); } catch (x) { toast.error(errMsg(x, "Não foi possível simular.")); }
  };
  const apply = async () => {
    try {
      const r = await backfill.mutateAsync({ dryRun: false });
      setApplied(r);
      toast.success(`${r.linked.length} ${r.linked.length === 1 ? "conta ligada" : "contas ligadas"} pelas fichas.`);
      await refresh();
    } catch (x) { toast.error(errMsg(x, "Não foi possível aplicar.")); }
  };

  const shown = applied ?? sim;
  const s = shown ? backfillSummary(shown) : null;
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !backfill.isPending) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Ligar pelas fichas</DialogTitle>
          <DialogDescription>
            Liga só quem tem a ficha a apontar para um agente Multipark <strong>e</strong> o email dessa conta Multipark igual ao do dashboard.
            Primeiro simula (não muda nada); depois "Aplicar".
          </DialogDescription>
        </DialogHeader>
        {!shown && (
          <Button variant="selected" onClick={simulate} disabled={backfill.isPending} className="w-full sm:w-auto">
            {backfill.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" aria-hidden /> : <Wand2 className="h-4 w-4 mr-1" aria-hidden />}Simular
          </Button>
        )}
        {s && shown && (
          <div className="space-y-3" role="status">
            <p className="text-sm font-medium">{applied ? "Aplicado:" : "Simulação (nada mudou):"}</p>
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
              {[
                ["Com agente na ficha", s.checked],
                [applied ? "Ligadas agora" : "Confirmadas", applied ? s.linked : s.confirmed],
                ["Email diferente", s.mismatches],
                ["Erros", s.errors],
              ].map(([l, v]) => (
                <div key={String(l)} className="rounded-lg border p-2">
                  <dd className="text-xl font-bold tabular-nums">{v}</dd>
                  <dt className="text-[11px] text-muted-foreground">{l}</dt>
                </div>
              ))}
            </dl>
            {shown.mismatches.length > 0 && (
              <div className="text-xs">
                <p className="text-muted-foreground mb-1">Email diferente (liga-se à mão com "Propor ligação"):</p>
                <ul className="max-h-32 overflow-auto rounded-md border divide-y">
                  {[...new Set(shown.mismatches.map((m) => m.userId))].slice(0, 50).map((id) => (
                    <li key={id} className="px-2 py-1">{nameOf.get(id) ?? `#${id}`}</li>
                  ))}
                </ul>
              </div>
            )}
            {s.errors > 0 && <p className="text-xs text-amber-800 dark:text-amber-300">Houve contas que a Multipark não respondeu — corre outra vez mais tarde.</p>}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={backfill.isPending}>{applied ? "Fechar" : "Cancelar"}</Button>
          {sim && !applied && (
            <Button type="button" variant="selected" onClick={apply} disabled={backfill.isPending || sim.candidates.length === 0}>
              {backfill.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" aria-hidden /> : <Link2 className="h-4 w-4 mr-1" aria-hidden />}
              Aplicar ({sim.candidates.length})
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Pedidos de acesso (L5) ────────────────────────────────────────────────────

type RequestStatus = "pending" | "approved" | "rejected" | "all";
const STATUS_LABEL: Record<Exclude<RequestStatus, "all">, string> = { pending: "Pendente", approved: "Aprovado", rejected: "Recusado" };

function AccessRequestsTab({ rows, ready }: { rows: IdentityRow[]; ready: boolean }) {
  const [status, setStatus] = useState<RequestStatus>("pending");
  const list = trpc.sharedIdentity.admin.accessRequests.useQuery({ status }, { retry: false, refetchOnWindowFocus: false });
  type Req = NonNullable<typeof list.data>[number];
  const [dlg, setDlg] = useState<{ kind: "existing" | "new" | "reject"; req: Req } | null>(null);
  const nameOf = useMemo(() => new Map(rows.map((r) => [r.id, who(r)])), [rows]);
  const notReady = ready ? undefined : "Liga primeiro os interruptores e a configuração (ver o aviso acima).";
  const items = list.data ?? [];
  const last = items.reduce<string | null>((m, r) => (r.lastRequestedAt && (!m || r.lastRequestedAt > m) ? r.lastRequestedAt : m), null);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground max-w-3xl">
        Quem entrou com uma conta Multipark sem ligação ao dashboard fica aqui. Aprovar liga-a a uma conta existente ou cria uma conta nova (papel Utilizador; as permissões dão-se depois em Utilizadores).
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={status} onValueChange={(v) => setStatus(v as RequestStatus)}>
          <SelectTrigger className="w-[170px]" aria-label="Estado dos pedidos"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="pending">Pendentes</SelectItem>
            <SelectItem value="approved">Aprovados</SelectItem>
            <SelectItem value="rejected">Recusados</SelectItem>
            <SelectItem value="all">Todos</SelectItem>
          </SelectContent>
        </Select>
        {list.data && (
          <span className="text-xs text-muted-foreground">
            {items.length} {items.length === 1 ? "pedido" : "pedidos"}{last ? ` · último a ${fmtPTDateTime(last)}` : ""}
          </span>
        )}
      </div>
      {list.error && <QueryErrorNote error={list.error} onRetry={() => list.refetch()} retrying={list.isFetching} what="os pedidos" />}
      {list.isLoading && <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> A carregar…</div>}
      {list.data && (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableCaption className="sr-only">Pedidos de acesso ao dashboard com a conta Multipark</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Pedidos</TableHead>
                  <TableHead>Último</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 && (
                  <TableRow><TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-8">Sem pedidos.</TableCell></TableRow>
                )}
                {items.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium max-w-[200px] break-words">{r.name ?? "—"}</TableCell>
                    <TableCell className="max-w-[240px] [overflow-wrap:anywhere] text-sm">{r.email ?? "—"}</TableCell>
                    <TableCell className="tabular-nums text-sm">{r.requestCount}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm">{r.lastRequestedAt ? fmtPTDateTime(r.lastRequestedAt) : "—"}</TableCell>
                    <TableCell className="text-sm">
                      <span className="inline-flex flex-col">
                        <span>{STATUS_LABEL[r.status]}</span>
                        {r.status !== "pending" && (
                          <span className="text-[11px] text-muted-foreground">
                            {r.decidedAt ? fmtPTDate(r.decidedAt) : ""}{r.userId ? ` · ${nameOf.get(r.userId) ?? `#${r.userId}`}` : ""}
                          </span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      {r.status === "pending" && (
                        <div className="flex flex-wrap justify-end gap-1">
                          <Button size="sm" variant="outline" className="h-8" disabled={!ready} title={notReady} onClick={() => setDlg({ kind: "existing", req: r })}
                            aria-label={`Ligar o pedido de ${r.name ?? r.email ?? r.id} a uma conta existente`}>
                            <Link2 className="h-3.5 w-3.5 mr-1" aria-hidden />Ligar a conta existente
                          </Button>
                          <Button size="sm" variant="ghost" className="h-8" disabled={!ready} title={notReady} onClick={() => setDlg({ kind: "new", req: r })}
                            aria-label={`Criar conta nova para ${r.name ?? r.email ?? r.id}`}>
                            <UserPlus className="h-3.5 w-3.5 mr-1" aria-hidden />Conta nova
                          </Button>
                          <Button size="sm" variant="ghost" className="h-8 text-destructive hover:text-destructive" disabled={!ready} title={notReady} onClick={() => setDlg({ kind: "reject", req: r })}
                            aria-label={`Recusar o pedido de ${r.name ?? r.email ?? r.id}`}>
                            Recusar
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      {dlg && <DecideDialog kind={dlg.kind} req={dlg.req} rows={rows} onClose={() => setDlg(null)} />}
    </div>
  );
}

function DecideDialog({ kind, req, rows, onClose }: {
  kind: "existing" | "new" | "reject";
  req: { id: number; name: string | null; email: string | null };
  rows: IdentityRow[];
  onClose: () => void;
}) {
  const refresh = useRefreshOverview();
  const decide = trpc.sharedIdentity.admin.decideAccessRequest.useMutation();
  const candidates = useMemo(() => accessRequestCandidates(rows, req.email), [rows, req.email]);
  const sameEmail = candidates[0] && req.email && String(candidates[0].email ?? "").trim().toLowerCase() === req.email.trim().toLowerCase() ? candidates[0] : null;
  const [userId, setUserId] = useState(sameEmail ? String(sameEmail.id) : "");
  const label = req.name ?? req.email ?? `#${req.id}`;

  const run = async () => {
    try {
      const r = await decide.mutateAsync({
        requestId: req.id,
        decision: kind === "existing" ? "approve_existing" : kind === "new" ? "approve_new" : "reject",
        userId: kind === "existing" ? Number(userId) : undefined,
      });
      toast.success(kind === "reject" ? "Pedido recusado." : kind === "new" ? `Conta criada e ligada${r.userId ? ` (#${r.userId})` : ""}. Dá as permissões em Utilizadores.` : "Pedido aprovado: conta ligada.");
      await refresh();
      onClose();
    } catch (x) {
      toast.error(errMsg(x, "Não foi possível decidir o pedido."));
    }
  };

  const title = kind === "existing" ? "Ligar a uma conta existente" : kind === "new" ? "Criar conta nova" : "Recusar o pedido";
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !decide.isPending) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title} — {label}</DialogTitle>
          <DialogDescription>
            {kind === "existing" && "A conta Multipark deste pedido fica ligada à conta do dashboard que escolheres; a pessoa passa a entrar nela."}
            {kind === "new" && <>Cria uma conta no dashboard com o papel <strong>Utilizador</strong> ({req.email ?? "sem email"}) e liga-a. As permissões dão-se depois em Utilizadores.</>}
            {kind === "reject" && "A pessoa continua sem acesso ao dashboard. Se voltar a entrar com a conta Multipark, o pedido volta a aparecer."}
          </DialogDescription>
        </DialogHeader>
        {kind === "existing" && (
          <div className="space-y-1.5">
            <Label>Conta do dashboard</Label>
            <SearchableSelect
              value={userId}
              onChange={setUserId}
              className="w-full"
              placeholder="Escolher a conta…"
              searchPlaceholder="Procurar nome ou email"
              emptyText="Nenhuma conta por ligar com esse nome"
              options={candidates.map((u) => ({ value: String(u.id), label: `${who(u)}${u.email && u.email !== u.name ? ` — ${u.email}` : ""} (${roleLabel(u.role)}${u.isActive ? "" : ", inativa"})` }))}
            />
            <p className="text-xs text-muted-foreground">Só aparecem contas ainda por ligar{sameEmail ? "; a do mesmo email vem escolhida" : ""}.</p>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={decide.isPending}>Cancelar</Button>
          <Button type="button" variant={kind === "reject" ? "destructive" : "selected"} onClick={run} disabled={decide.isPending || (kind === "existing" && !userId)}>
            {decide.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" aria-hidden />}
            {kind === "existing" ? "Ligar" : kind === "new" ? "Criar e ligar" : "Recusar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
