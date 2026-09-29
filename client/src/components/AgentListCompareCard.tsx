import { useMemo, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Loader2, Upload, Link2 } from "lucide-react";

/**
 * RH → Ligações: comparar a lista de agentes exportada da Multipark com as
 * fichas. Aceita o CSV antigo (nome_agente;email;cidade) ou a exportação xlsx
 * (folha "Agentes": traz o ID de utilizador, o telefone e o cargo). A equipa
 * liga-se às fichas (ID → email → telefone → nome); os parceiros às parcerias.
 * Não grava nada sozinho: cada sugestão liga-se num clique (ou as seguras de uma vez).
 */
const STATUS: Record<string, { label: string; tone: string }> = {
  sugestao_email: { label: "Ligar (mesmo email)", tone: "bg-emerald-100 text-emerald-800" },
  sugestao_telefone: { label: "Ligar (mesmo telefone)", tone: "bg-emerald-100 text-emerald-800" },
  sugestao_nome: { label: "Ligar? (mesmo nome)", tone: "bg-amber-100 text-amber-800" },
  parceiro: { label: "Parceiro por ligar", tone: "bg-sky-100 text-sky-800" },
  sem_ficha: { label: "Sem ficha", tone: "bg-red-100 text-red-800" },
  nao_encontrado: { label: "Não está na Multipark", tone: "bg-muted text-muted-foreground" },
  ligado: { label: "Ligado", tone: "bg-muted text-muted-foreground" },
  fora: { label: "Sistema / teste", tone: "bg-muted text-muted-foreground" },
};
const ORDER = ["sugestao_email", "sugestao_telefone", "sugestao_nome", "parceiro", "sem_ficha", "nao_encontrado", "ligado", "fora"];

type Row = Record<string, string | number | boolean | null>;

/** Lê a folha "Agentes" do xlsx no browser (o ficheiro não sai daqui inteiro). */
async function readAgentSheet(f: File): Promise<Row[]> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
  const name = wb.SheetNames.find((n) => /^agentes$/i.test(n.trim()))
    ?? wb.SheetNames.find((n) => {
      const first = XLSX.utils.sheet_to_json<Row>(wb.Sheets[n], { defval: "" })[0] ?? {};
      return "Nome" in first && "ID utilizador" in first;
    });
  if (!name) throw new Error("Não encontrei a folha \"Agentes\" neste ficheiro.");
  const keep = ["Nome", "Email", "Telefone", "Estado", "Cargo principal", "Parques ativos", "Parques inativos", "ID utilizador"];
  return XLSX.utils.sheet_to_json<Row>(wb.Sheets[name], { defval: "" }).map((r) => {
    const o: Row = {};
    for (const k of keep) if (k in r) o[k] = typeof r[k] === "number" || typeof r[k] === "boolean" ? r[k] : String(r[k] ?? "").slice(0, 2000);
    return o;
  });
}

export function AgentListCompareCard() {
  const utils = trpc.useUtils();
  const [filter, setFilter] = useState<string | null>(null);
  const [hideInactive, setHideInactive] = useState(false);
  const compare = trpc.identityLinks.compareAgentList.useMutation({ onError: (e) => toast.error(e.message) });
  const link = trpc.identityLinks.linkAgent.useMutation({ onError: (e) => toast.error(e.message) });
  const partnerLink = trpc.multipark.setAgentPartner.useMutation({ onError: (e) => toast.error(e.message) });
  const { data: partnershipsList = [] } = trpc.partnerships.list.useQuery({} as any);
  const [done, setDone] = useState<Map<string, string>>(new Map());
  const [busyAll, setBusyAll] = useState(false);
  const [reading, setReading] = useState(false);

  async function onFile(f: File | null) {
    if (!f) return;
    setDone(new Map());
    if (/\.xlsx?$/i.test(f.name)) {
      setReading(true);
      try { compare.mutate({ sheet: await readAgentSheet(f) }); }
      catch (e) { toast.error((e as Error).message); }
      finally { setReading(false); }
    } else {
      compare.mutate({ csv: await f.text() });
    }
  }
  const results = compare.data?.results ?? [];
  const visible = results.filter((r) => !hideInactive || !r.inactive);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of visible) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [visible]);
  const shown = visible
    .filter((r) => !filter || r.status === filter)
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || Number(a.inactive) - Number(b.inactive) || a.name.localeCompare(b.name));
  const keyOf = (r: (typeof results)[number]) => r.agentUserId ?? `${r.name}|${r.email}`;
  const partnerOptions = ((partnershipsList as any[]) ?? []).map((pp: any) => ({ value: String(pp.id ?? pp.partnership?.id), label: pp.name ?? pp.partnership?.name ?? `#${pp.id}` }));

  async function linkOne(r: (typeof results)[number], employeeId: number) {
    await link.mutateAsync({ agentUserId: r.agentUserId!, employeeId, agentName: r.agentName ?? r.name });
    setDone((m) => new Map(m).set(keyOf(r), "Ligado ✓"));
  }
  async function linkPartner(r: (typeof results)[number], partnershipId: number, label: string) {
    await partnerLink.mutateAsync({ agentName: r.agentName ?? r.name, partnershipId });
    setDone((m) => new Map(m).set(keyOf(r), `→ ${label} ✓`));
  }
  const safe = visible.filter((r) => !done.has(keyOf(r)) && (
    ((r.status === "sugestao_email" || r.status === "sugestao_telefone") && r.agentUserId && r.suggestion)
    || (r.status === "parceiro" && r.partnerSuggestion?.by === "email")));
  async function linkAllSafe() {
    setBusyAll(true);
    let n = 0;
    try {
      for (const r of safe) {
        try {
          if (r.suggestion) await linkOne(r, r.suggestion.employeeId);
          else if (r.partnerSuggestion) await linkPartner(r, r.partnerSuggestion.partnershipId, r.partnerSuggestion.name);
          n++;
        } catch { /* o toast já avisou */ }
      }
    } finally {
      setBusyAll(false);
      utils.identityLinks.overview.invalidate();
      utils.multipark.unlinkedAgents.invalidate();
      toast.success(`${n} agente(s) ligados (email, telefone e parceiros pelo email).`);
    }
  }
  const busy = compare.isPending || reading;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Comparar a lista de agentes da Multipark</CardTitle>
        <p className="text-xs text-muted-foreground">
          Carrega a exportação de agentes (<strong>xlsx</strong>, a melhor: traz o ID, o telefone e o cargo) ou o CSV antigo. A equipa liga-se às fichas pelo ID, email, telefone ou nome; os parceiros às parcerias. Nada é ligado sem carregares num botão.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="inline-flex items-center gap-2 cursor-pointer text-sm">
          <Button asChild size="sm" variant="outline"><span>{busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Upload className="h-4 w-4 mr-1" />}Escolher ficheiro (xlsx ou CSV)</span></Button>
          <input type="file" accept=".xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="hidden" onChange={(e) => { onFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
        </label>
        {compare.data && !compare.data.liveAvailable && <p className="text-xs text-red-600">A BD da Multipark não respondeu: só deu para usar os IDs do ficheiro. Tenta daqui a pouco para o resto.</p>}
        {results.length > 0 && (
          <>
            <div className="flex flex-wrap gap-2 items-center">
              <Button size="sm" variant={filter ? "outline" : "default"} onClick={() => setFilter(null)}>Todos ({visible.length})</Button>
              {ORDER.filter((s) => counts[s]).map((s) => (
                <Button key={s} size="sm" variant={filter === s ? "default" : "outline"} onClick={() => setFilter(s)}>{STATUS[s].label} ({counts[s]})</Button>
              ))}
              {safe.length > 0 && (
                <Button size="sm" onClick={linkAllSafe} disabled={busyAll}>
                  {busyAll ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Link2 className="h-4 w-4 mr-1" />}Ligar os seguros ({safe.length})
                </Button>
              )}
              <label className="text-xs inline-flex items-center gap-1 ml-auto">
                <input type="checkbox" checked={hideInactive} onChange={(e) => setHideInactive(e.target.checked)} /> Esconder inativos
              </label>
            </div>
            <div className="max-h-[520px] overflow-auto">
              <table className="w-full text-sm">
                <tbody>
                  {shown.map((r, i) => {
                    const k = keyOf(r);
                    return (
                      <tr key={`${k}-${i}`} className="border-b last:border-0 align-top">
                        <td className="py-1.5 pr-2 [overflow-wrap:anywhere]">
                          <div className="font-medium">{r.name} {r.inactive && <Badge variant="outline" className="ml-1 text-[10px]">inativo</Badge>}</div>
                          <div className="text-xs text-muted-foreground">
                            {[r.role, r.email ?? "sem email", r.phone, r.cities.join(", ")].filter(Boolean).join(" · ")}
                          </div>
                        </td>
                        <td className="py-1.5 pr-2 text-xs">
                          <span className={`rounded px-1.5 py-0.5 ${STATUS[r.status].tone}`}>{STATUS[r.status].label}</span>
                          {r.linkedTo && <div className="text-muted-foreground mt-1">{r.linkedTo.fullName}</div>}
                          {r.partnerLinked && <div className="text-muted-foreground mt-1">{r.partnerLinked.name}</div>}
                          {r.suggestion && !r.linkedTo && <div className="text-muted-foreground mt-1">→ {r.suggestion.fullName}</div>}
                          {r.partnerSuggestion && <div className="text-muted-foreground mt-1">→ {r.partnerSuggestion.name} ({r.partnerSuggestion.by})</div>}
                          {r.agentMatch === "nome" && <Badge variant="outline" className="mt-1">agente encontrado pelo nome</Badge>}
                        </td>
                        <td className="py-1.5 text-right">
                          {done.has(k) ? <span className="text-xs text-emerald-700">{done.get(k)}</span>
                            : r.status === "parceiro" ? (
                              <div className="flex flex-col items-end gap-1">
                                {r.partnerSuggestion && (
                                  <Button size="sm" variant="outline" disabled={partnerLink.isPending || busyAll}
                                    onClick={() => linkPartner(r, r.partnerSuggestion!.partnershipId, r.partnerSuggestion!.name).then(() => toast.success("Ligado à parceria."))}>Ligar</Button>
                                )}
                                <SearchableSelect className="h-7 w-44 text-xs" value="" placeholder="— parceria —" options={partnerOptions}
                                  onChange={(v: string) => { const o = partnerOptions.find((x) => x.value === v); if (o) linkPartner(r, Number(v), o.label).then(() => toast.success("Ligado à parceria.")); }} />
                              </div>
                            )
                            : r.agentUserId && r.suggestion && !r.linkedTo && (
                              <Button size="sm" variant="outline" disabled={link.isPending || busyAll}
                                onClick={() => linkOne(r, r.suggestion!.employeeId).then(() => { toast.success("Ligado."); utils.identityLinks.overview.invalidate(); })}>Ligar</Button>
                            )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">"Ligar os seguros" liga só os do mesmo email ou telefone e os parceiros encontrados pelo domínio do email; os do nome vês um a um. "Sem ficha": o agente existe na Multipark mas nenhuma ficha tem esse email, telefone nem nome — anexa-o à mão no cartão "Uma pessoa" acima.</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
