/**
 * Lote 39a — Central Vodafone (Integrações, só super admin): o endereço a pôr
 * na One Net Attendant Console (como "Sugar CRM"), um acesso por pessoa (o
 * segredo só aparece ao criar), as últimas chamadas e o que a consola pediu.
 */
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { Copy, KeyRound, PhoneCall, PhoneIncoming, PhoneMissed, PhoneOutgoing } from "lucide-react";

const copy = (t: string) => navigator.clipboard?.writeText(t).then(() => toast.success("Copiado."), () => toast.error("Não deu para copiar."));
// 39e: a consola manda a duração em minutos — 0 é "menos de 1 min", não "0 s"
const dur = (s: number | null) => (s == null ? "" : s === 0 ? "menos de 1 min" : s >= 60 ? `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ""}` : `${s} s`);

export function CentralVodafoneCard() {
  const utils = trpc.useUtils();
  const q = trpc.central.status.useQuery(undefined, { refetchInterval: 30_000 });
  const users = trpc.central.users.useQuery(undefined, { staleTime: 60_000 });
  const [userId, setUserId] = useState("");
  const [username, setUsername] = useState("");
  const [created, setCreated] = useState<{ username: string; secret: string } | null>(null);
  const [showRequests, setShowRequests] = useState(false);
  const create = trpc.central.createAccount.useMutation({
    onSuccess: (r) => { setCreated(r); setUserId(""); setUsername(""); utils.central.status.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const revoke = trpc.central.revokeAccount.useMutation({
    onSuccess: () => { toast.success("Acesso revogado."); utils.central.status.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const serverUrl = `${typeof window !== "undefined" ? window.location.origin : ""}${q.data?.basePath ?? "/api/central/sugar"}`;
  const userOptions = useMemo(() => (users.data ?? []).map((u) => ({ value: String(u.id), label: `${u.name}${u.email ? ` · ${u.email}` : ""}` })), [users.data]);
  const suggest = (id: string) => {
    const u = (users.data ?? []).find((x) => String(x.id) === id);
    const base = (u?.email ?? u?.name ?? "").split("@")[0].toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9._-]+/g, ".").replace(/^\.+|\.+$/g, "");
    return base.slice(0, 60);
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          <PhoneCall className="h-4 w-4" /> Central Vodafone (consola One Net)
          {q.data && (q.data.enabled
            ? <Badge variant="outline" className="bg-emerald-100 text-emerald-800 border-emerald-200">Ligada</Badge>
            : <Badge variant="outline" className="bg-muted">Desligada</Badge>)}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          A consola da Vodafone só regista chamadas num CRM conhecido; a dashboard faz de <b>Sugar CRM</b>. Cada chamada fica em nome de quem
          atendeu ou fez e conta no Desempenho. Liga em Definições → Automações → <b>Central Vodafone: receber as chamadas da consola</b>.
        </p>
        {q.isError && <QueryErrorNote error={q.error} onRetry={() => q.refetch()} what="a central" />}
        {q.data && !q.data.hasSecret && <p className="text-xs text-destructive">O servidor não tem segredo de sessão (JWT_SECRET): a consola não consegue entrar.</p>}

        <div className="space-y-1">
          <div className="text-xs font-medium">Na consola: Ligar a um servidor CRM → Sugar CRM</div>
          <ol className="list-decimal pl-5 text-xs text-muted-foreground space-y-0.5">
            <li>Descrição: <i>Dashboard</i>. Deixa <b>Ativar CRM</b> e <b>Registar chamadas do histórico</b> ligados.</li>
            <li>Server URL (copia daqui):</li>
          </ol>
          <div className="flex items-center gap-2 max-w-xl">
            <Input readOnly value={serverUrl} className="font-mono text-xs" aria-label="Server URL para a consola" />
            <Button size="sm" variant="outline" onClick={() => copy(serverUrl)}><Copy className="h-4 w-4" /></Button>
          </div>
          <p className="text-xs text-muted-foreground">3. Quando pedir utilizador e palavra-passe, usa o acesso <b>da pessoa que está nesse computador</b> (abaixo).</p>
        </div>

        <div className="space-y-2">
          <div className="text-xs font-medium flex items-center gap-1"><KeyRound className="h-3.5 w-3.5" /> Acessos (um por pessoa)</div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-72 max-w-full">
              <SearchableSelect value={userId} options={userOptions} className="w-full h-8 text-xs" placeholder={users.isLoading ? "A carregar…" : "Pessoa (conta da dashboard)"}
                searchPlaceholder="Procurar…" onChange={(v) => { setUserId(v); setUsername(suggest(v)); }} />
            </div>
            <Input className="w-48 h-8 text-xs" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="utilizador (ex.: ana.silva)" aria-label="Utilizador na consola" />
            <Button size="sm" disabled={!userId || !username || create.isPending} onClick={() => create.mutate({ userId: Number(userId), username })}>Criar acesso</Button>
          </div>
          {created && (
            <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 space-y-1 max-w-xl">
              <div className="text-xs font-medium">Acesso criado — a palavra-passe só aparece agora. Escreve-a na consola dessa pessoa.</div>
              <div className="flex items-center gap-2 text-xs"><span className="w-28 text-muted-foreground">Utilizador</span><code>{created.username}</code></div>
              <div className="flex items-center gap-2 text-xs"><span className="w-28 text-muted-foreground">Palavra-passe</span><code className="break-all">{created.secret}</code>
                <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => copy(created.secret)}><Copy className="h-3.5 w-3.5" /></Button></div>
              <Button size="sm" variant="outline" className="h-7" onClick={() => setCreated(null)}>Já está na consola</Button>
            </div>
          )}
          <div className="divide-y rounded-md border">
            {(q.data?.accounts ?? []).length === 0 && <div className="p-2 text-xs text-muted-foreground">Ainda não há acessos.</div>}
            {(q.data?.accounts ?? []).map((a) => (
              <div key={a.id} className={`flex flex-wrap items-center gap-2 p-2 text-xs ${a.revokedAt ? "opacity-60" : ""}`}>
                <code className="font-medium">{a.username}</code>
                <span>{a.userName ?? `conta #${a.userId}`}</span>
                <span className="text-muted-foreground">{a.lastUsedAt ? `usado ${fmtPTDateTime(a.lastUsedAt)}` : "nunca usado"}</span>
                {a.revokedAt ? <Badge variant="outline">revogado</Badge> : (
                  <AlertDialog>
                    <AlertDialogTrigger asChild><Button size="sm" variant="ghost" className="ml-auto h-7 text-destructive">Revogar</Button></AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Revogar o acesso "{a.username}"?</AlertDialogTitle>
                        <AlertDialogDescription>A consola dessa pessoa deixa logo de registar chamadas. As chamadas que já registou ficam. Não se desfaz: cria-se outro acesso.</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancelar</AlertDialogCancel>
                        <AlertDialogAction onClick={() => revoke.mutate({ id: a.id })}>Revogar</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-1">
          <div className="text-xs font-medium">Últimas chamadas registadas</div>
          <div className="text-[11px] text-muted-foreground">As internas (Equipa e Interna) ficam registadas mas não contam no Desempenho.</div>
          <div className="divide-y rounded-md border max-h-64 overflow-auto">
            {(q.data?.calls ?? []).length === 0 && <div className="p-2 text-xs text-muted-foreground">Ainda nenhuma.</div>}
            {(q.data?.calls ?? []).map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-2 p-2 text-xs" title={c.subject ?? undefined}>
                {!c.held ? <PhoneMissed className="h-3.5 w-3.5 text-destructive" /> : c.direction === "out" ? <PhoneOutgoing className="h-3.5 w-3.5" /> : <PhoneIncoming className="h-3.5 w-3.5" />}
                <span>{c.startedAt ? fmtPTDateTime(c.startedAt) : ""}</span>
                <span className="font-medium">{c.userName ?? "?"}</span>
                <span className="text-muted-foreground">{c.direction === "out" ? "ligou a" : "chamada de"}</span>
                {/* 39e: com quem foi (a ficha que a consola escolheu); sem ficha, o número; sem nada, o texto da consola */}
                {c.contact && c.contact.kind !== "Sem ficha" ? (
                  <>
                    {c.contact.href ? <Link href={c.contact.href} className="underline">{c.contact.name}</Link> : <span>{c.contact.name}</span>}
                    <Badge variant="outline" className="h-4 px-1 text-[10px]">{c.contact.kind}</Badge>
                  </>
                ) : null}
                <span>{c.contact?.kind === "Interna" ? "" : c.phone ?? (c.contact?.kind === "Sem ficha" ? c.contact.name : c.contact ? "" : c.subject ?? "")}</span>
                <span className="text-muted-foreground">{dur(c.durationS)}{!c.held ? " · não atendida" : ""}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-1">
          <Button size="sm" variant="ghost" className="h-7 px-0 text-xs underline" onClick={() => setShowRequests((v) => !v)}>
            {showRequests ? "Esconder" : "Ver"} o que a consola pediu ({q.data?.requests.length ?? 0})
          </Button>
          {showRequests && (
            <div className="divide-y rounded-md border max-h-80 overflow-auto font-mono text-[11px]">
              {(q.data?.requests ?? []).map((r) => (
                <details key={r.id} className="p-2">
                  <summary className="cursor-pointer">
                    {r.at ? fmtPTDateTime(r.at) : ""} · {r.method} {r.path} · <span className={r.status >= 400 ? "text-destructive" : ""}>{r.status}</span>{r.note ? ` · ${r.note}` : ""}
                  </summary>
                  {r.body && <pre className="whitespace-pre-wrap break-all mt-1 text-muted-foreground">{r.body}</pre>}
                </details>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
