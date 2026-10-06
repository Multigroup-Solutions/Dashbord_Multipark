/**
 * RH → Ligações → Agentes × pessoas (31a, Jorge 6 out 2026): "vai ver todos
 * os agentes que estão na Multipark… eles têm de estar em algum lado. Cada
 * agente tem que ser um utilizador e cada utilizador tem que ter um agente."
 *
 * Todos os agentes da Multipark e onde está cada um (ficha, parceria,
 * ignorado…); os que estão em lado nenhum com a pessoa provável e o porquê
 * (email, nome, cidade, Zello e escala nos dias em que mexeu); as fichas sem
 * utilizador; e os utilizadores sem agente. Nada se liga sozinho: cada botão
 * faz uma ligação (fica nos Logs).
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchableSelect, type SearchableOption } from "@/components/ui/searchable-select";
import { Download, EyeOff, Link2, Loader2, RefreshCw, UserPlus, Users } from "lucide-react";

type Tab = "nenhum" | "sem_utilizador" | "parceiros" | "utilizadores" | "todos";
const CITY: Record<string, string> = { lisboa: "Lisboa", porto: "Porto", faro: "Faro" };
const dmy = (s: string | null) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : "—");
const plausibleEmail = (e: string | null | undefined) => !!e && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function placeLabel(p: any): { text: string; tone: "ok" | "warn" | "bad" | "muted" } {
  switch (p.kind) {
    case "ficha": return { text: `Ficha: ${p.name}${p.byName ? " (só pelo nome)" : ""}${p.active ? "" : " · inativa"}`, tone: p.hasUser ? "ok" : "warn" };
    case "parceria": return { text: `Parceria: ${p.name}${p.viaMultipark ? " (pela Multipark, falta ligar o agente)" : ""}`, tone: p.viaMultipark ? "warn" : "ok" };
    case "parceiro_sem_parceria": return { text: `Parceiro na Multipark: ${p.name ?? "?"}${p.type ? ` (${String(p.type).toLowerCase()})` : ""} · sem parceria cá`, tone: "warn" };
    case "ignorado": return { text: "Ignorado", tone: "muted" };
    case "sistema": return { text: `Fora (${p.reason})`, tone: "muted" };
    default: return { text: "Em lado nenhum", tone: "bad" };
  }
}
const TONE = { ok: "bg-emerald-100 text-emerald-900", warn: "bg-amber-100 text-amber-900", bad: "bg-red-100 text-red-900", muted: "bg-muted text-muted-foreground" } as const;

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function AgentCrossCheckCard({ employeeOptions }: { employeeOptions: SearchableOption[] }) {
  const utils = trpc.useUtils();
  const [nonce, setNonce] = useState(0);
  const [tab, setTab] = useState<Tab>("nenhum");
  const [search, setSearch] = useState("");
  const [showStale, setShowStale] = useState(false);
  const q = trpc.identityLinks.agentCrossCheck.useQuery({ nonce }, { retry: false, staleTime: 5 * 60_000 });
  const done = (msg: string) => () => { toast.success(msg); setNonce((n) => n + 1); utils.identityLinks.overview.invalidate(); };
  const onError = (e: { message: string }) => toast.error(e.message);
  const linkAgent = trpc.identityLinks.linkAgent.useMutation({ onSuccess: done("Agente ligado à ficha."), onError });
  const createUser = trpc.identityLinks.createUser.useMutation({ onSuccess: done("Utilizador criado e ligado."), onError });
  const createEmp = trpc.multipark.createEmployeeFromAgent.useMutation({ onSuccess: done("Ficha criada e ligada ao agente."), onError });
  const setPartner = trpc.multipark.setAgentPartner.useMutation({ onSuccess: done("Agente ligado à parceria."), onError });
  const ignore = trpc.multipark.ignoreAgent.useMutation({ onSuccess: done("Agente ignorado (volta a aparecer se o tirares da lista)."), onError });
  const busy = linkAgent.isPending || createUser.isPending || createEmp.isPending || setPartner.isPending || ignore.isPending;

  const d = q.data && q.data.available ? q.data : null;
  const rows = useMemo(() => {
    if (!d) return [];
    const term = search.trim().toLowerCase();
    return d.agents.filter((a) => {
      if (!showStale && !a.active && a.total === 0) return false;
      if (term && !`${a.name ?? ""} ${a.names.join(" ")} ${a.email ?? ""} ${a.userId}`.toLowerCase().includes(term)) return false;
      if (tab === "nenhum") return a.place.kind === "nenhum";
      if (tab === "sem_utilizador") return a.needsUser;
      if (tab === "parceiros") return a.place.kind === "parceiro_sem_parceria" || (a.place.kind === "parceria" && a.place.viaMultipark);
      return tab === "todos";
    });
  }, [d, tab, search, showStale]);

  function exportCsv() {
    if (!d) return;
    const head = ["Agente", "ID Multipark", "Email", "Ativo", "Papéis", "Cidades", "Parques", "Ações 180 dias", "Última ação", "Onde está", "Precisa de utilizador", "Sugestão", "Pontos", "Porquê"];
    const lines = d.agents.map((a) => {
      const s = a.suggestions[0];
      return [a.name ?? "", a.userId, a.email ?? "", a.active ? "sim" : "não", a.roles.join(" "), a.cities.map((c) => CITY[c] ?? c).join(" "), a.parks.join(" | "), a.total, dmy(a.lastSeen), placeLabel(a.place).text, a.needsUser ? "sim" : "", s?.label ?? "", s?.score ?? "", s?.reasons.join("; ") ?? ""].map(csvCell).join(";");
    });
    const users = d.users.map((u) => [`UTILIZADOR SEM AGENTE: ${u.name ?? ""}`, "", u.email ?? "", "", u.role, "", "", "", "", u.employeeName ? `Ficha: ${u.employeeName}` : "sem ficha", "", u.suggestions[0]?.agentName ?? "", u.suggestions[0]?.score ?? "", u.suggestions[0]?.reasons.join("; ") ?? ""].map(csvCell).join(";"));
    const blob = new Blob([`﻿${[head.join(";"), ...lines, ...users].join("\n")}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const el = document.createElement("a");
    el.href = url; el.download = `agentes-x-pessoas-${new Date().toISOString().slice(0, 10)}.csv`; el.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  const s = d?.summary;
  const tabs: Array<[Tab, string, number | undefined]> = [
    ["nenhum", "Em lado nenhum", s?.nowhere], ["sem_utilizador", "Agente sem utilizador", s?.withoutUser],
    ["parceiros", "Parceiros por ligar", s?.partnersToLink], ["utilizadores", "Utilizadores sem agente", s?.usersWithoutAgent], ["todos", "Todos", s?.agents],
  ];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex flex-wrap items-center gap-2"><Users className="h-4 w-4" /> Agentes da Multipark × pessoas</CardTitle>
        <CardDescription>
          Todos os agentes da Multipark e onde está cada um: ficha (funcionário, extra, condutor), parceria (agência, agregador, parceiro) ou em lado nenhum. Para os que faltam, a pessoa provável e o porquê: mesmo email, nome, cidade, e se estava no Zello ou na escala dos Extras nos dias em que mexeu. Regra: cada agente é um utilizador e cada utilizador tem um agente.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setNonce((n) => n + 1)} disabled={q.isFetching}><RefreshCw className={`h-4 w-4 mr-1 ${q.isFetching ? "animate-spin" : ""}`} /> Cruzar de novo</Button>
          <Button size="sm" variant="outline" onClick={exportCsv} disabled={!d}><Download className="h-4 w-4 mr-1" /> CSV</Button>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Procurar agente, email ou id…" className="h-8 w-56" aria-label="Procurar agente" />
          <label className="flex items-center gap-1 text-xs text-muted-foreground"><input type="checkbox" checked={showStale} onChange={(e) => setShowStale(e.target.checked)} /> mostrar inativos sem ações</label>
          {d && <span className="text-xs text-muted-foreground">Cruzado às {new Date(d.at).toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" })}</span>}
        </div>
        {q.isLoading && <div className="py-6 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}
        {q.error && <p role="alert" className="text-sm text-red-600">{q.error.message}</p>}
        {q.data && !q.data.available && <p role="status" className="text-sm text-amber-800">A Multipark não respondeu: {q.data.reason}</p>}
        {d?.daysNotice && <p role="status" className="text-xs text-amber-800">{d.daysNotice}</p>}
        {s && (
          <div className="flex flex-wrap gap-1.5">
            {tabs.map(([k, label, n]) => (
              <Button key={k} size="sm" variant={tab === k ? "selected" : "outline"} onClick={() => setTab(k)}>
                {label} <Badge variant={k === "todos" ? "secondary" : n ? "destructive" : "secondary"} className="ml-1">{n ?? 0}</Badge>
              </Button>
            ))}
            <span className="self-center text-xs text-muted-foreground">Em fichas: {s.inFicha} · parceiros: {s.partners} · ignorados: {s.ignored} · com sugestão: {s.nowhereWithSuggestion}/{s.nowhere}</span>
          </div>
        )}

        {d && tab !== "utilizadores" && (
          rows.length === 0 ? <p className="text-sm text-muted-foreground">Nada aqui. 👌</p> : (
            <ul className="divide-y">
              {rows.slice(0, 300).map((a) => {
                const pl = placeLabel(a.place);
                return (
                  <li key={a.userId} className="py-2 space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <b className="[overflow-wrap:anywhere]">{a.name ?? "(sem nome)"}</b>
                      <span className={`rounded px-1.5 py-0.5 text-xs ${TONE[pl.tone]}`}>{pl.text}</span>
                      {!a.active && <Badge variant="outline">inativo na Multipark</Badge>}
                      <span className="text-xs text-muted-foreground">{a.email ?? "sem email"} · {a.roles.join("/") || "—"} · {a.cities.map((c) => CITY[c] ?? c).join(", ") || "sem cidade"} · {a.total} ações (180 dias) · última {dmy(a.lastSeen)}</span>
                    </div>
                    {a.suggestions.map((sg, i) => (
                      <div key={i} className="flex flex-wrap items-center gap-2 pl-3 text-xs">
                        <span>→ <b>{sg.label}</b> <span className="text-muted-foreground">({sg.score} pts: {sg.reasons.join(", ")})</span></span>
                        {sg.kind === "ficha" && sg.employeeId != null && <Button size="sm" variant="outline" disabled={busy} onClick={() => linkAgent.mutate({ employeeId: sg.employeeId!, agentUserId: a.userId, agentName: a.name ?? undefined })}><Link2 className="h-3.5 w-3.5 mr-1" /> Ligar</Button>}
                        {sg.kind === "parceria" && sg.partnershipId != null && a.name && <Button size="sm" variant="outline" disabled={busy} onClick={() => setPartner.mutate({ agentName: a.name!, partnershipId: sg.partnershipId! })}><Link2 className="h-3.5 w-3.5 mr-1" /> Ligar à parceria</Button>}
                      </div>
                    ))}
                    <div className="flex flex-wrap items-center gap-2 pl-3">
                      {a.place.kind === "nenhum" && <PickFicha options={employeeOptions} busy={busy} onPick={(id) => linkAgent.mutate({ employeeId: id, agentUserId: a.userId, agentName: a.name ?? undefined })} />}
                      {a.place.kind === "nenhum" && a.name && !a.partnerLike && (
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => createEmp.mutate({ agentName: a.name!, agentUserId: a.userId, ...(plausibleEmail(a.email) ? { email: a.email! } : {}) })}>
                          <UserPlus className="h-3.5 w-3.5 mr-1" /> Criar ficha{plausibleEmail(a.email) ? " + utilizador" : ""}
                        </Button>
                      )}
                      {a.place.kind === "nenhum" && a.name && <Button size="sm" variant="ghost" disabled={busy} onClick={() => ignore.mutate({ agentName: a.name!, ignored: true })}><EyeOff className="h-3.5 w-3.5 mr-1" /> Ignorar</Button>}
                      {a.needsUser && a.place.kind === "ficha" && <Button size="sm" variant="outline" disabled={busy} onClick={() => createUser.mutate({ employeeId: (a.place as { employeeId: number }).employeeId })}><UserPlus className="h-3.5 w-3.5 mr-1" /> Criar utilizador</Button>}
                      {a.place.kind === "parceria" && a.place.viaMultipark && a.name && <Button size="sm" variant="outline" disabled={busy} onClick={() => setPartner.mutate({ agentName: a.name!, partnershipId: (a.place as { partnershipId: number }).partnershipId })}><Link2 className="h-3.5 w-3.5 mr-1" /> Ligar o agente à parceria</Button>}
                      {a.place.kind === "parceiro_sem_parceria" && <span className="text-xs text-muted-foreground">Em Parcerias → Ligar à Multipark → Aplicar, a parceria é criada e o agente liga-se.</span>}
                    </div>
                  </li>
                );
              })}
              {rows.length > 300 && <li className="py-2 text-xs text-muted-foreground">Mais {rows.length - 300} — usa a pesquisa ou o CSV.</li>}
            </ul>
          )
        )}

        {d && tab === "utilizadores" && (
          d.users.length === 0 ? <p className="text-sm text-muted-foreground">Todos os utilizadores têm agente. 👌</p> : (
            <ul className="divide-y">
              {d.users.map((u) => (
                <li key={u.id} className="py-2 space-y-1 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <b>{u.name ?? u.email ?? `#${u.id}`}</b>
                    <span className="text-xs text-muted-foreground">{u.email ?? "sem email"} · {u.role} · {u.employeeName ? `ficha: ${u.employeeName}` : "sem ficha"}</span>
                  </div>
                  {u.suggestions.length === 0 && <p className="pl-3 text-xs text-muted-foreground">Sem agente provável: cria-o na Multipark (convite com o email dele) e volta a cruzar.</p>}
                  {u.suggestions.map((sg) => (
                    <div key={sg.agentUserId} className="flex flex-wrap items-center gap-2 pl-3 text-xs">
                      <span>→ agente <b>{sg.agentName ?? sg.agentUserId}</b> <span className="text-muted-foreground">({sg.score} pts: {sg.reasons.join(", ")})</span></span>
                      {u.employeeId != null && <Button size="sm" variant="outline" disabled={busy} onClick={() => linkAgent.mutate({ employeeId: u.employeeId!, agentUserId: sg.agentUserId, agentName: sg.agentName ?? undefined })}><Link2 className="h-3.5 w-3.5 mr-1" /> Ligar</Button>}
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          )
        )}
      </CardContent>
    </Card>
  );
}

function PickFicha({ options, busy, onPick }: { options: SearchableOption[]; busy: boolean; onPick: (id: number) => void }) {
  const [v, setV] = useState("");
  return (
    <span className="flex items-center gap-1">
      <SearchableSelect value={v} onChange={setV} options={options} placeholder="Ligar a outra ficha…" searchPlaceholder="Procurar nome…" className="w-52" />
      <Button size="sm" variant="outline" disabled={!v || busy} onClick={() => onPick(Number(v))}><Link2 className="h-3.5 w-3.5" /></Button>
    </span>
  );
}
