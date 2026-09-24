/**
 * RH → Ligações (Fase 4): o que falta ligar entre fichas, utilizadores (login)
 * e agentes Multipark. A ligação automática corre de hora a hora; aqui ficam
 * os casos que precisam de uma decisão, com sugestões aceites num clique.
 */
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { AlertTriangle, Link2, Loader2, RefreshCw, UserPlus } from "lucide-react";
import { toast } from "sonner";

const dm = (s: string | null) => (s ? `${String(s).slice(8, 10)}/${String(s).slice(5, 7)}` : "—");

function Section({ title, count, hint, children }: { title: string; count: number; hint?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          {title} <Badge variant={count ? "destructive" : "secondary"}>{count}</Badge>
        </CardTitle>
        {hint && <CardDescription>{hint}</CardDescription>}
      </CardHeader>
      <CardContent>{count === 0 ? <p className="text-sm text-muted-foreground">Nada por ligar. 👌</p> : children}</CardContent>
    </Card>
  );
}

function PickEmployee({ options, onPick, busy, label }: { options: { value: string; label: string }[]; onPick: (id: number) => void; busy: boolean; label: string }) {
  const [v, setV] = useState("");
  return (
    <div className="flex items-center gap-2 justify-end">
      <SearchableSelect value={v} onChange={setV} options={options} placeholder="Escolher ficha…" searchPlaceholder="Procurar nome…" className="w-52" />
      <Button size="sm" variant="outline" disabled={!v || busy} onClick={() => onPick(Number(v))}>
        <Link2 className="h-3.5 w-3.5 mr-1" /> {label}
      </Button>
    </div>
  );
}

export function IdentityLinksSection() {
  const utils = trpc.useUtils();
  const q = trpc.identityLinks.overview.useQuery();
  const emps = trpc.multipark.employeesForMapping.useQuery();
  const empOptions = useMemo(() => ((emps.data ?? []) as any[]).map((e) => ({ value: String(e.id), label: e.fullName })), [emps.data]);
  const refresh = () => {
    utils.identityLinks.overview.invalidate();
    utils.multipark.unlinkedAgents.invalidate();
  };
  const onErr = (e: { message: string }) => toast.error(e.message);
  const reconcile = trpc.identityLinks.reconcileNow.useMutation({
    onSuccess: (r) => {
      refresh();
      const n = r.usersLinked + r.usersCreated + r.employeesLinkedToUsers + r.agentIdsFilled + r.agentsByEmail + r.agentsByName + r.agentAliases;
      toast.success(n ? `${n} ligação(ões) feitas automaticamente.` : "Nada de novo para ligar automaticamente.");
      if (r.errors.length) toast.warning(r.errors.join(" · "));
    },
    onError: onErr,
  });
  const createUser = trpc.identityLinks.createUser.useMutation({ onSuccess: (r) => { refresh(); toast.success(r.created ? "Utilizador criado e ligado." : "Ligado ao utilizador existente."); }, onError: onErr });
  const linkUser = trpc.identityLinks.linkUser.useMutation({ onSuccess: (r) => { refresh(); toast.success(r.mode === "extra" ? "Ligado como conta extra da mesma pessoa." : "Ligado."); }, onError: onErr });
  const unAccount = trpc.identityLinks.removeAccountAlias.useMutation({ onSuccess: () => { refresh(); toast.success("Conta extra separada."); }, onError: onErr });
  const unAgent = trpc.identityLinks.removeAgentAlias.useMutation({ onSuccess: () => { refresh(); toast.success("Agente extra separado."); }, onError: onErr });
  const linkAgent = trpc.identityLinks.linkAgent.useMutation({ onSuccess: (r) => { refresh(); toast.success(`Agente "${r.agentName}" ligado.`); }, onError: onErr });
  const busy = createUser.isPending || linkUser.isPending || linkAgent.isPending;

  if (q.isLoading) return <div className="py-10 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (q.error) return <p className="text-sm text-red-600">{q.error.message}</p>;
  const d = q.data!;
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap gap-6 text-sm">
            <div><div className="text-xs text-muted-foreground">Fichas ativas</div><div className="text-xl font-semibold">{d.counts.employeesActive}</div></div>
            <div><div className="text-xs text-muted-foreground">Com utilizador</div><div className="text-xl font-semibold">{pct(d.counts.withUser, d.counts.employeesActive)}</div></div>
            <div><div className="text-xs text-muted-foreground">Com agente Multipark</div><div className="text-xl font-semibold">{pct(d.counts.withAgent, d.counts.employeesActive)}</div></div>
          </div>
          <div className="flex flex-col items-end gap-1">
            <Button onClick={() => reconcile.mutate()} disabled={reconcile.isPending}>
              <RefreshCw className={`h-4 w-4 mr-2 ${reconcile.isPending ? "animate-spin" : ""}`} /> Reconciliar agora
            </Button>
            <span className="text-xs text-muted-foreground">Corre sozinho de hora a hora.</span>
          </div>
        </CardContent>
      </Card>

      <Section title="Fichas sem utilizador" count={d.employeesWithoutUser.length} hint="Sem utilizador não há ponto nem app. Com email válido, cria-se (ou liga-se) num clique.">
        <table className="w-full text-sm">
          <tbody>
            {d.employeesWithoutUser.map((e) => (
              <tr key={e.employeeId} className="border-b last:border-0">
                <td className="py-1.5">{e.fullName}</td>
                <td className="py-1.5 text-muted-foreground text-xs">{e.email}</td>
                <td className="py-1.5 text-right">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => createUser.mutate({ employeeId: e.employeeId })}>
                    <UserPlus className="h-3.5 w-3.5 mr-1" /> {e.existingUserId ? `Ligar ao utilizador #${e.existingUserId}` : "Criar utilizador"}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {d.employeesNoEmail.length > 0 && (
        <Section title="Fichas sem email (nem utilizador)" count={d.employeesNoEmail.length} hint="Acrescenta o email na ficha — a ligação faz-se sozinha a seguir.">
          <p className="text-sm">{d.employeesNoEmail.map((e) => e.fullName).join(" · ")}</p>
        </Section>
      )}

      <Section title="Agentes Multipark com sugestão" count={d.agentsToAttach.length} hint="O email do agente coincide com uma ficha — confirma a ligação.">
        <table className="w-full text-sm">
          <tbody>
            {d.agentsToAttach.map((a) => (
              <tr key={a.agentUserId} className="border-b last:border-0">
                <td className="py-1.5">{a.agentName} <span className="text-xs text-muted-foreground">· {a.actions} ações · último {dm(a.lastAction)}</span></td>
                <td className="py-1.5 text-right space-x-1">
                  {a.suggestions.map((s) => (
                    <Button key={s.employeeId} size="sm" variant="outline" disabled={busy} onClick={() => linkAgent.mutate({ employeeId: s.employeeId, agentUserId: a.agentUserId })}>
                      <Link2 className="h-3.5 w-3.5 mr-1" /> {s.fullName}
                    </Button>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Agentes Multipark por ligar" count={d.agentsUnmatched.length} hint="Sem ficha correspondente. Liga à ficha certa — se a pessoa já tiver agente, este entra como agente extra.">
        <table className="w-full text-sm">
          <tbody>
            {d.agentsUnmatched.map((a) => (
              <tr key={a.agentUserId} className="border-b last:border-0">
                <td className="py-1.5">
                  {a.agentName}
                  <div className="text-xs text-muted-foreground">{a.email ?? "sem email"} · {a.actions} ações · último {dm(a.lastAction)}</div>
                </td>
                <td className="py-1.5">
                  <PickEmployee options={empOptions} busy={busy} label="Ligar" onPick={(employeeId) => linkAgent.mutate({ employeeId, agentUserId: a.agentUserId })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {d.usersWithoutEmployee.length > 0 && (
        <Section title="Utilizadores sem ficha" count={d.usersWithoutEmployee.length} hint="Contas de login sem ficha de RH. Liga à ficha certa — se a ficha já tiver conta, esta entra como conta extra da mesma pessoa.">
          <table className="w-full text-sm">
            <tbody>
              {d.usersWithoutEmployee.map((u) => (
                <tr key={u.userId} className="border-b last:border-0">
                  <td className="py-1.5">{u.name ?? "—"} <span className="text-xs text-muted-foreground">· {u.email ?? "sem email"} · {u.role}</span></td>
                  <td className="py-1.5">
                    <PickEmployee options={empOptions} busy={busy} label="Ligar" onPick={(employeeId) => linkUser.mutate({ employeeId, userId: u.userId })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {(d.aliases.accounts.length > 0 || d.aliases.agents.length > 0) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Contas e agentes extra</CardTitle>
            <CardDescription>A mesma pessoa com mais do que um login (ex.: email pessoal e profissional) ou mais do que um agente Multipark.</CardDescription>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <tbody>
                {d.aliases.accounts.map((a) => (
                  <tr key={`u${a.userId}`} className="border-b last:border-0">
                    <td className="py-1.5">{a.fullName}</td>
                    <td className="py-1.5 text-muted-foreground text-xs">login extra · {a.email ?? `#${a.userId}`}</td>
                    <td className="py-1.5 text-right"><Button size="sm" variant="ghost" disabled={unAccount.isPending} onClick={() => unAccount.mutate({ userId: a.userId })}>Separar</Button></td>
                  </tr>
                ))}
                {d.aliases.agents.map((a) => (
                  <tr key={`a${a.agentUserId}`} className="border-b last:border-0">
                    <td className="py-1.5">{a.fullName}</td>
                    <td className="py-1.5 text-muted-foreground text-xs">agente extra · {a.agentName ?? a.agentUserId}</td>
                    <td className="py-1.5 text-right"><Button size="sm" variant="ghost" disabled={unAgent.isPending} onClick={() => unAgent.mutate({ agentUserId: a.agentUserId })}>Separar</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {d.conflicts.length > 0 && (
        <Card className="border-amber-300">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-600" /> Para decidir à mão <Badge variant="secondary">{d.conflicts.length}</Badge></CardTitle>
            <CardDescription>Casos ambíguos que a ligação automática não toca (duplicados, emails diferentes…). Resolve na ficha ou nos Utilizadores.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="text-sm space-y-1">
              {d.conflicts.map((c, i) => (
                <li key={i}><span className="font-medium">{c.kind}:</span> <span className="text-muted-foreground">{c.text}</span></li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
