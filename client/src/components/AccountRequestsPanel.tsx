/**
 * 49c (Jorge, 8 out 2026): no Recrutamento (Leads de Extras → Candidaturas),
 * o que vem da app:
 *  - pedidos de ligação ("<email Google> diz ser <email/telefone>") — Ligar /
 *    Recusar;
 *  - possíveis duplicados (o candidato gravou um telefone/NIF que já está
 *    noutro registo) — abrir as fichas, "Já tratei" ou "Não é a mesma pessoa";
 *  - quem "Quer voltar" (estava inativo e carregou em "Voltei") — Reativar;
 *  - candidatos por aprovar (fichas criadas na app) — Aprovar.
 * Reativar/Aprovar = rh.setActive (a conta "utilizador" passa ao papel do posto).
 * Não mostra nada quando não há nada.
 */
import { useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { CheckCircle2, Link2, Loader2, UserCheck, UserPlus, Users, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function AccountRequestsPanel() {
  const utils = trpc.useUtils();
  const q = trpc.accountLink.inbox.useQuery(undefined, { refetchInterval: 60_000, retry: false });
  const [fichaFor, setFichaFor] = useState<Record<number, string>>({});
  const refresh = () => { utils.accountLink.inbox.invalidate(); utils.rh.list.invalidate(); };
  const decide = trpc.accountLink.decide.useMutation({
    onSuccess: (r, v) => { toast.success(v.action === "link" ? `Conta ligada à ficha #${r.employeeId}.` : v.action === "done" ? "Marcado como tratado." : "Pedido recusado."); refresh(); },
    onError: (e) => toast.error(e.message),
  });
  const setActive = trpc.rh.setActive.useMutation({
    onSuccess: (r) => { toast.success(r.promotedRole ? `Ficha ativa. A conta passou a ${r.promotedRole}.` : "Ficha ativa."); refresh(); },
    onError: (e) => toast.error(e.message),
  });
  const d = q.data;
  if (!d || (!d.requests.length && !d.comebacks.length && !d.candidates.length)) return null;
  const busy = decide.isPending || setActive.isPending;

  return (
    <Card className="mb-4 border-sky-200">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><Users className="h-4 w-4 text-sky-600" />Entradas pela app</CardTitle>
        <p className="text-xs text-muted-foreground">Quem entrou com a Google e se candidatou, pediu para ligar a conta ou disse que quer voltar.</p>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {d.requests.length > 0 && (
          <section aria-label="Pedidos de ligação" className="space-y-2">
            <h3 className="font-medium flex items-center gap-1.5"><Link2 className="h-4 w-4" />Pedidos de ligação e possíveis duplicados <Badge variant="secondary">{d.requests.length}</Badge></h3>
            <ul className="divide-y rounded-md border">
              {d.requests.map((r) => (
                <li key={r.id} className="p-2 space-y-1">
                  <p className="font-medium [overflow-wrap:anywhere]">{r.summary}</p>
                  <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {r.userName ? `${r.userName} · ` : ""}{r.createdAt ?? ""}
                    {r.codeOut ? " · código enviado por email (à espera da pessoa)" : ""}
                    {r.note ? ` · ${r.note}` : ""}
                  </p>
                  {r.kind === "duplicate" ? (
                    <p className="text-xs">
                      {r.employeeId && <Link className="text-primary underline mr-2" href={`/rh?employeeId=${r.employeeId}`}>Ficha do candidato #{r.employeeId}{r.requesterName ? ` (${r.requesterName})` : ""}</Link>}
                      {r.matchedEmployeeId && <Link className="text-primary underline mr-2" href={`/rh?employeeId=${r.matchedEmployeeId}`}>Ficha #{r.matchedEmployeeId}{r.matchedName ? ` (${r.matchedName})` : ""}</Link>}
                      {r.matchedApplicationId && <span>Candidatura #{r.matchedApplicationId}{r.appName ? ` (${r.appName})` : ""}</span>}
                      <span className="block text-muted-foreground">Se for a mesma pessoa, junta as fichas em RH → Ligações → Juntar fichas e marca como tratado.</span>
                    </p>
                  ) : (
                    <p className="text-xs">
                      {r.matchedEmployeeId ? (
                        <>Encontrado: <Link className="text-primary underline" href={`/rh?employeeId=${r.matchedEmployeeId}`}>ficha #{r.matchedEmployeeId}{r.matchedName ? ` ${r.matchedName}` : ""}</Link>
                          {r.matchedState && r.matchedState !== "ativo" && <Badge variant={r.matchedState === "desativado" ? "destructive" : "secondary"} className="ml-1.5">{r.matchedState === "desativado" ? `desativada: ${r.matchedReason}` : r.matchedState === "candidato" ? "candidato" : `inativa: ${r.matchedReason}`}</Badge>}</>
                      ) : r.matchedApplicationId ? <>Encontrada a candidatura #{r.matchedApplicationId}{r.appName ? ` (${r.appName}${r.appCity ? `, ${r.appCity}` : ""})` : ""} — ao ligar cria-se a ficha de candidato.</>
                        : <>Sem correspondência: confirma com a pessoa e escreve o n.º da ficha.</>}
                    </p>
                  )}
                  {d.canDecide && (
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      {r.kind === "link" && (
                        <>
                          {!r.matchedEmployeeId && !r.matchedApplicationId && (
                            <Input aria-label="N.º da ficha a ligar" className="h-8 w-28" inputMode="numeric" placeholder="n.º ficha"
                              value={fichaFor[r.id] ?? ""} onChange={(e) => setFichaFor((m) => ({ ...m, [r.id]: e.target.value.replace(/\D/g, "") }))} />
                          )}
                          <Button size="sm" className="h-8" disabled={busy || (r.matchedState === "desativado") || (!r.matchedEmployeeId && !r.matchedApplicationId && !fichaFor[r.id])}
                            title={r.matchedState === "desativado" ? "Ficha desativada (motivo que bloqueia): não se liga." : undefined}
                            onClick={() => decide.mutate({ requestId: r.id, action: "link", ...(fichaFor[r.id] ? { employeeId: Number(fichaFor[r.id]) } : {}) })}>
                            <Link2 className="h-3.5 w-3.5 mr-1" />Ligar
                          </Button>
                        </>
                      )}
                      {r.kind === "duplicate" && (
                        <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => decide.mutate({ requestId: r.id, action: "done" })}>
                          <CheckCircle2 className="h-3.5 w-3.5 mr-1" />Já tratei
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" className="h-8" disabled={busy}
                        onClick={() => { if (confirm(r.kind === "duplicate" ? "Não é a mesma pessoa?" : "Recusar este pedido? A conta continua sem ficha.")) decide.mutate({ requestId: r.id, action: "reject" }); }}>
                        <X className="h-3.5 w-3.5 mr-1" />{r.kind === "duplicate" ? "Não é a mesma pessoa" : "Recusar"}
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {d.comebacks.length > 0 && (
          <section aria-label="Quer voltar" className="space-y-2">
            <h3 className="font-medium flex items-center gap-1.5"><UserCheck className="h-4 w-4" />Quer voltar <Badge variant="secondary">{d.comebacks.length}</Badge></h3>
            <ul className="divide-y rounded-md border">
              {d.comebacks.map((c) => (
                <li key={c.id} className="p-2 flex flex-wrap items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <Link className="font-medium hover:underline [overflow-wrap:anywhere]" href={`/rh?employeeId=${c.id}`}>{c.fullName}</Link>
                    <p className="text-xs text-muted-foreground">{[c.position, c.projectName, c.reason ? `inativo: ${c.reason}` : null, c.comebackRequestedAt ? `pediu a ${c.comebackRequestedAt}` : null].filter(Boolean).join(" · ")}</p>
                  </div>
                  {d.canReactivate && (
                    <Button size="sm" className="h-8" disabled={busy} onClick={() => { if (confirm(`Reativar ${c.fullName}? A ficha volta a ativa e a conta ao papel do posto.`)) setActive.mutate({ id: c.id, isActive: true }); }}>
                      {setActive.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5 mr-1" />}Reativar
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {d.candidates.length > 0 && (
          <section aria-label="Candidatos por aprovar" className="space-y-2">
            <h3 className="font-medium flex items-center gap-1.5"><UserPlus className="h-4 w-4" />Candidatos — por aprovar <Badge variant="secondary">{d.candidates.length}</Badge></h3>
            <p className="text-xs text-muted-foreground">Fichas criadas na app ("Sou novo"). A pessoa preenche os dados e os documentos; aprova-se aqui na candidatura (com a cidade) ou na ficha.</p>
            <ul className="divide-y rounded-md border">
              {d.candidates.map((c) => (
                <li key={c.id} className="p-2 flex flex-wrap items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <Link className="font-medium hover:underline [overflow-wrap:anywhere]" href={`/rh?employeeId=${c.id}`}>{c.fullName}</Link>
                    <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{[c.email, c.phone, c.createdAt ? `desde ${c.createdAt}` : null].filter(Boolean).join(" · ")}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </CardContent>
    </Card>
  );
}
