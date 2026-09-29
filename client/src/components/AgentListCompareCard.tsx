import { useMemo, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Upload, Link2 } from "lucide-react";

/**
 * RH → Ligações: comparar a lista de agentes exportada da Multipark (CSV
 * nome_agente;email;cidade) com as fichas. Não grava nada sozinho: cada
 * sugestão liga-se num clique (ou todas as do email de uma vez).
 */
const STATUS: Record<string, { label: string; tone: string }> = {
  sugestao_email: { label: "Ligar (mesmo email)", tone: "bg-emerald-100 text-emerald-800" },
  sugestao_nome: { label: "Ligar? (mesmo nome)", tone: "bg-amber-100 text-amber-800" },
  sem_ficha: { label: "Sem ficha", tone: "bg-red-100 text-red-800" },
  nao_encontrado: { label: "Não está na Multipark", tone: "bg-muted text-muted-foreground" },
  ligado: { label: "Ligado", tone: "bg-muted text-muted-foreground" },
  fora: { label: "Agência / teste", tone: "bg-muted text-muted-foreground" },
};
const ORDER = ["sugestao_email", "sugestao_nome", "sem_ficha", "nao_encontrado", "ligado", "fora"];

export function AgentListCompareCard() {
  const utils = trpc.useUtils();
  const [filter, setFilter] = useState<string | null>(null);
  const compare = trpc.identityLinks.compareAgentList.useMutation({ onError: (e) => toast.error(e.message) });
  const link = trpc.identityLinks.linkAgent.useMutation({ onError: (e) => toast.error(e.message) });
  const [done, setDone] = useState<Set<string>>(new Set());
  const [busyAll, setBusyAll] = useState(false);

  async function onFile(f: File | null) {
    if (!f) return;
    setDone(new Set());
    compare.mutate({ csv: await f.text() });
  }
  const results = compare.data?.results ?? [];
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of results) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [results]);
  const shown = results
    .filter((r) => !filter || r.status === filter)
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.name.localeCompare(b.name));

  async function linkOne(agentUserId: string, employeeId: number) {
    await link.mutateAsync({ agentUserId, employeeId });
    setDone((s) => new Set(s).add(agentUserId));
  }
  async function linkAllEmail() {
    setBusyAll(true);
    let n = 0;
    try {
      for (const r of results) {
        if (r.status !== "sugestao_email" || !r.agentUserId || !r.suggestion || done.has(r.agentUserId)) continue;
        try { await linkOne(r.agentUserId, r.suggestion.employeeId); n++; } catch { /* o toast já avisou */ }
      }
    } finally {
      setBusyAll(false);
      utils.identityLinks.overview.invalidate();
      toast.success(`${n} agente(s) ligados pelo email.`);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Comparar a lista de agentes da Multipark</CardTitle>
        <p className="text-xs text-muted-foreground">
          Carrega o CSV exportado (nome_agente;email;cidade). Cada agente é procurado na Multipark (pelo email, senão pelo nome) e comparado com as fichas. Nada é ligado sem carregares em Ligar.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="inline-flex items-center gap-2 cursor-pointer text-sm">
          <Button asChild size="sm" variant="outline"><span>{compare.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Upload className="h-4 w-4 mr-1" />}Escolher CSV</span></Button>
          <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { onFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
        </label>
        {compare.data && !compare.data.liveAvailable && <p className="text-xs text-red-600">A BD da Multipark não respondeu: não deu para encontrar os agentes. Tenta daqui a pouco.</p>}
        {results.length > 0 && (
          <>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant={filter ? "outline" : "default"} onClick={() => setFilter(null)}>Todos ({results.length})</Button>
              {ORDER.filter((s) => counts[s]).map((s) => (
                <Button key={s} size="sm" variant={filter === s ? "default" : "outline"} onClick={() => setFilter(s)}>{STATUS[s].label} ({counts[s]})</Button>
              ))}
              {(counts.sugestao_email ?? 0) > 0 && (
                <Button size="sm" onClick={linkAllEmail} disabled={busyAll}>
                  {busyAll ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Link2 className="h-4 w-4 mr-1" />}Ligar todos os do mesmo email
                </Button>
              )}
            </div>
            <div className="max-h-[480px] overflow-auto">
              <table className="w-full text-sm">
                <tbody>
                  {shown.map((r, i) => (
                    <tr key={`${r.name}-${r.email}-${i}`} className="border-b last:border-0 align-top">
                      <td className="py-1.5 pr-2 [overflow-wrap:anywhere]">
                        <div className="font-medium">{r.name}</div>
                        <div className="text-xs text-muted-foreground">{r.email ?? "sem email"}{r.cities.length ? ` · ${r.cities.join(", ")}` : ""}</div>
                      </td>
                      <td className="py-1.5 pr-2 text-xs">
                        <span className={`rounded px-1.5 py-0.5 ${STATUS[r.status].tone}`}>{STATUS[r.status].label}</span>
                        {r.linkedTo && <div className="text-muted-foreground mt-1">{r.linkedTo.fullName}</div>}
                        {r.suggestion && !r.linkedTo && <div className="text-muted-foreground mt-1">→ {r.suggestion.fullName}</div>}
                        {r.agentMatch === "nome" && <Badge variant="outline" className="mt-1">agente encontrado pelo nome</Badge>}
                      </td>
                      <td className="py-1.5 text-right">
                        {r.agentUserId && r.suggestion && !r.linkedTo && (
                          done.has(r.agentUserId)
                            ? <span className="text-xs text-emerald-700">Ligado ✓</span>
                            : <Button size="sm" variant="outline" disabled={link.isPending || busyAll} onClick={() => linkOne(r.agentUserId!, r.suggestion!.employeeId).then(() => { toast.success("Ligado."); utils.identityLinks.overview.invalidate(); })}>Ligar</Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">"Sem ficha": o agente existe na Multipark mas nenhuma ficha tem esse email nem esse nome — anexa-o à mão no cartão "Uma pessoa" acima.</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
