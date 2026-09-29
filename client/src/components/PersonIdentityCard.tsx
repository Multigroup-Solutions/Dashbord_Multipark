/**
 * RH → Ligações → "Uma pessoa": tudo o que liga uma ficha — contas de login
 * (principal + extra) e agentes da Multipark (principal + extra). Aqui anexa-se
 * ou retira-se um agente à mão e juntam-se contas da mesma pessoa (a conta que
 * entra na app fica; a outra é desativada, nunca apagada).
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Link2, Loader2, Merge, Unlink, UserRound } from "lucide-react";
import { toast } from "sonner";

type Opt = { value: string; label: string };

export function PersonIdentityCard({ employeeOptions, orphanUsers, canMerge }: { employeeOptions: Opt[]; orphanUsers: Array<{ userId: number; name: string | null; email: string | null }>; canMerge: boolean }) {
  const utils = trpc.useUtils();
  const [empId, setEmpId] = useState("");
  const [q, setQ] = useState("");
  const [orphan, setOrphan] = useState("");
  const [merge, setMerge] = useState<{ keepUserId: number; dropUserId: number } | null>(null);
  const person = trpc.identityLinks.person.useQuery({ employeeId: Number(empId) }, { enabled: !!empId });
  const search = trpc.identityLinks.searchAgents.useQuery({ q }, { enabled: q.trim().length >= 2 });
  const preview = trpc.identityLinks.previewMerge.useQuery(merge ?? { keepUserId: 0, dropUserId: 0 }, { enabled: !!merge, retry: false });
  const refresh = () => { utils.identityLinks.person.invalidate(); utils.identityLinks.overview.invalidate(); utils.identityLinks.searchAgents.invalidate(); };
  const onErr = (e: { message: string }) => toast.error(e.message);
  const link = trpc.identityLinks.linkAgent.useMutation({ onSuccess: (r) => { refresh(); setQ(""); toast.success(`Agente "${r.agentName}" anexado.`); }, onError: onErr });
  const detach = trpc.identityLinks.detachAgent.useMutation({ onSuccess: () => { refresh(); toast.success("Agente retirado da ficha."); }, onError: onErr });
  const doMerge = trpc.identityLinks.mergeUsers.useMutation({ onSuccess: () => { refresh(); setMerge(null); setOrphan(""); toast.success("Contas juntas. A antiga ficou desativada."); }, onError: onErr });

  const p = person.data;
  const principal = p?.accounts.find((a) => a.principal) ?? null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><UserRound className="h-4 w-4" /> Uma pessoa: contas e agentes</CardTitle>
        <CardDescription>Escolhe a ficha para ver as contas de login e os agentes da Multipark dessa pessoa. Uma pessoa pode ter vários agentes (emails antigos e novos) e várias contas.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <SearchableSelect value={empId} onChange={setEmpId} options={employeeOptions} placeholder="Escolher ficha…" searchPlaceholder="Procurar nome…" className="w-72" />
        {person.isLoading && empId && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        {person.error && <p className="text-red-600">{person.error.message}</p>}
        {p && (
          <>
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Contas de login</div>
              {p.accounts.length === 0 && <p className="text-muted-foreground">Sem conta.</p>}
              <ul className="space-y-1">
                {p.accounts.map((a) => (
                  <li key={a.userId} className="flex flex-wrap items-center gap-2">
                    <Badge variant={a.principal ? "default" : "secondary"}>{a.principal ? "principal" : "extra"}</Badge>
                    <span className="[overflow-wrap:anywhere]">{a.email ?? `#${a.userId}`}</span>
                    <span className="text-xs text-muted-foreground">{a.role}{a.isActive ? "" : " · desativada"}{a.lastSignedIn ? ` · último login ${a.lastSignedIn}` : ""}</span>
                    {!a.principal && principal && canMerge && (
                      <Button size="sm" variant="outline" className="h-7" onClick={() => setMerge({ keepUserId: a.userId, dropUserId: principal.userId })}>
                        <Merge className="h-3.5 w-3.5 mr-1" /> Ficar só com esta
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              {canMerge && principal && orphanUsers.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <SearchableSelect value={orphan} onChange={setOrphan} className="w-72" placeholder="Conta perdida (sem ficha)…" searchPlaceholder="Procurar email ou nome…"
                    options={orphanUsers.map((u) => ({ value: String(u.userId), label: `${u.email ?? "sem email"}${u.name ? ` · ${u.name}` : ""}` }))} />
                  <Button size="sm" variant="outline" disabled={!orphan} onClick={() => setMerge({ keepUserId: Number(orphan), dropUserId: principal.userId })}>
                    <Merge className="h-3.5 w-3.5 mr-1" /> Juntar (fica a que entra na app)
                  </Button>
                </div>
              )}
            </div>

            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Agentes da Multipark</div>
              {p.agents.length === 0 && <p className="text-muted-foreground">Sem agente.</p>}
              <ul className="space-y-1">
                {p.agents.map((a, i) => (
                  <li key={a.agentUserId ?? `n${i}`} className="flex flex-wrap items-center gap-2">
                    <Badge variant={a.principal ? "default" : "secondary"}>{a.principal ? "principal" : "extra"}</Badge>
                    <span>{a.agentName ?? a.agentUserId}</span>
                    {a.email && <span className="text-xs text-muted-foreground">{a.email}</span>}
                    {a.agentUserId && (
                      <Button size="sm" variant="ghost" className="h-7" disabled={detach.isPending} onClick={() => detach.mutate({ employeeId: p.employee.id, agentUserId: a.agentUserId! })}>
                        <Unlink className="h-3.5 w-3.5 mr-1" /> Retirar
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              <div className="mt-2 space-y-1">
                <Input className="h-8 w-72" placeholder="Anexar agente: procurar nome ou email…" value={q} onChange={(e) => setQ(e.target.value)} />
                {search.data && search.data.length > 0 && (
                  <ul className="max-h-56 overflow-auto rounded-md border">
                    {search.data.map((a) => (
                      <li key={a.agentUserId} className="flex flex-wrap items-center justify-between gap-2 border-b px-2 py-1 last:border-0">
                        <span className="[overflow-wrap:anywhere]">{a.agentName ?? a.agentUserId} <span className="text-xs text-muted-foreground">{a.email ?? ""} · {a.total} ações{a.employeeName ? ` · já é de ${a.employeeName}` : ""}</span></span>
                        <Button size="sm" variant="outline" className="h-7" disabled={link.isPending || a.employeeId === p.employee.id} onClick={() => link.mutate({ employeeId: p.employee.id, agentUserId: a.agentUserId })}>
                          <Link2 className="h-3.5 w-3.5 mr-1" /> {a.employeeId && a.employeeId !== p.employee.id ? "Passar para esta pessoa" : "Anexar"}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {search.data && search.data.length === 0 && <p className="text-xs text-muted-foreground">Nenhum agente com esse nome ou email.</p>}
              </div>
            </div>
          </>
        )}
      </CardContent>

      <AlertDialog open={!!merge} onOpenChange={(o) => !o && setMerge(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Juntar contas</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                {preview.isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                {preview.error && <p className="text-red-600">{preview.error.message}</p>}
                {preview.data && (
                  <>
                    <p>Fica: <strong>{preview.data.keep.email ?? `#${preview.data.keep.id}`}</strong> (a que entra na app).</p>
                    <p>Sai: <strong>{preview.data.drop.email ?? `#${preview.data.drop.id}`}</strong> — fica desativada (não é apagada) e o email passa para a ficha como email pessoal.</p>
                    <p>Tudo o que era da pessoa (ficha, permissões, notificações, Google, email, WhatsApp, casos atribuídos) passa para a conta que fica.</p>
                    {preview.data.warnings.map((w, i) => <p key={i} className="text-amber-700">{w}</p>)}
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction disabled={!preview.data || doMerge.isPending} onClick={(e) => { e.preventDefault(); if (merge) doMerge.mutate(merge); }}>Juntar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
