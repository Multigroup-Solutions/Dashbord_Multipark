import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Loader2, RefreshCw, Link2, Archive } from "lucide-react";

/**
 * Parcerias → "Ligar à Multipark": parceiros (agências/agregadores), Pros e
 * avenças passam a vir de lá. Primeiro vê-se o que muda (nada gravado); só
 * "Aplicar" grava. Os arquivados nunca são apagados e podem ser repostos.
 */
const KIND: Record<string, string> = { partner: "Parceiro", pro: "Pro", plan: "Avença" };

export function MultiparkSyncCard() {
  const utils = trpc.useUtils();
  const preview = trpc.partnerships.mpSyncPreview.useMutation({ onError: (e) => toast.error(e.message) });
  const apply = trpc.partnerships.mpSyncApply.useMutation({
    onSuccess: (r) => {
      if (!r.available) { toast.error(`A Multipark não respondeu: ${r.reason ?? ""}`); return; }
      toast.success(`${r.linked} ligados, ${r.created} criados, ${r.archived} arquivados, ${r.agentsLinked} agentes ligados às parcerias.`);
      utils.partnerships.list.invalidate(); utils.partnerships.live.invalidate(); utils.partnerships.archived.invalidate(); utils.partnerships.invoicingSummary.invalidate();
      preview.reset();
    },
    onError: (e) => toast.error(e.message),
  });
  const linkMp = trpc.partnerships.linkMultipark.useMutation({ onError: (e) => toast.error(e.message) });
  const { data: archived = [] } = trpc.partnerships.archived.useQuery();
  const unarchive = trpc.partnerships.unarchive.useMutation({
    onSuccess: () => { utils.partnerships.archived.invalidate(); utils.partnerships.list.invalidate(); toast.success("Reposto."); },
    onError: (e) => toast.error(e.message),
  });
  const [keep, setKeep] = useState<Set<number>>(new Set());
  const [showArchived, setShowArchived] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const d = preview.data;
  const p = d?.plan;

  return (
    <Card className="p-4 border-sky-300 bg-sky-50/50 dark:bg-sky-950/20 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold text-sm flex-1 min-w-[12rem]">Ligar à Multipark</h3>
        <Button size="sm" variant="outline" onClick={() => { setKeep(new Set()); preview.mutate(); }} disabled={preview.isPending}>
          {preview.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1" />}Ver o que muda
        </Button>
        {(archived as any[]).length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setShowArchived((v) => !v)}><Archive className="w-4 h-4 mr-1" />Arquivados ({(archived as any[]).length})</Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Parceiros (agências e agregadores, com a taxa por parque), clientes Pro e avenças passam a vir da Multipark: cada registo fica preso ao id de lá e o tipo e a comissão deixam de se mexer aqui.
        O que é só nosso (NIF, acordo, contactos, notas) fica. Os registos sem par na Multipark são arquivados, nunca apagados. "Ver o que muda" não grava nada.
      </p>
      {d && !d.available && <p className="text-xs text-red-600">A Multipark não respondeu: {d.reason}. Tenta daqui a pouco.</p>}
      {p && d?.available && (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="outline">Na Multipark: {d.counts.partners} parceiros · {d.counts.pros} Pros · {d.counts.plans} avenças</Badge>
            <Badge variant="outline">Nossos registos: {d.counts.records}</Badge>
            <Badge className="bg-emerald-600">{p.links.length} ligar</Badge>
            <Badge className="bg-sky-600">{p.creates.length} criar</Badge>
            {p.ambiguous.length > 0 && <Badge className="bg-amber-600">{p.ambiguous.length} à mão</Badge>}
            <Badge variant="secondary">{p.archives.length - keep.size} arquivar</Badge>
          </div>

          {p.links.length > 0 && (
            <details open>
              <summary className="cursor-pointer text-xs font-medium">Ligar ({p.links.length}) — o nosso registo fica preso à Multipark</summary>
              <div className="max-h-72 overflow-auto mt-1">
                <table className="w-full text-xs">
                  <thead><tr className="text-muted-foreground text-left"><th className="py-1">Nosso registo</th><th>Na Multipark</th><th>Como</th><th>Nossa taxa hoje</th><th>Na Multipark</th></tr></thead>
                  <tbody>
                    {p.links.map((l) => (
                      <tr key={l.key} className="border-t align-top">
                        <td className="py-1 pr-2 [overflow-wrap:anywhere]">{l.recordName}</td>
                        <td className="pr-2 [overflow-wrap:anywhere]">{l.mpName} <span className="text-muted-foreground">· {KIND[l.kind]}</span></td>
                        <td className="pr-2">{l.by === "id" ? "id" : l.by === "nome" ? "nome" : <span className="text-amber-700 font-medium">parecido</span>}</td>
                        <td className="pr-2">{d.money[l.recordId]?.ours ?? "—"}</td>
                        <td>{d.money[l.recordId]?.mp ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}

          {p.creates.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs font-medium">Criar ({p.creates.length}) — existem na Multipark e não temos registo</summary>
              <ul className="mt-1 text-xs grid sm:grid-cols-2 gap-x-4">
                {p.creates.map((c) => <li key={c.key} className="[overflow-wrap:anywhere]">{c.name} <span className="text-muted-foreground">· {KIND[c.kind]}</span></li>)}
              </ul>
            </details>
          )}

          {p.ambiguous.length > 0 && (
            <details open>
              <summary className="cursor-pointer text-xs font-medium">À mão ({p.ambiguous.length}) — nome repetido ou só parecido: escolhe o registo certo (ou nenhum, e fica para criar)</summary>
              <div className="mt-1 space-y-1">
                {p.ambiguous.map((a) => (
                  <div key={a.key} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-medium [overflow-wrap:anywhere]">{a.name}</span><span className="text-muted-foreground">· {KIND[a.kind]} →</span>
                    {chosen.has(a.key) ? <span className="text-emerald-700">Ligado ✓</span> : a.candidates.map((c) => (
                      <Button key={c.id} size="sm" variant="outline" className="h-6 text-xs" disabled={linkMp.isPending}
                        onClick={() => linkMp.mutateAsync({ id: c.id, multiparkPartnerId: a.key }).then(() => { setChosen((s) => new Set(s).add(a.key)); toast.success("Ligado. Carrega outra vez em \"Ver o que muda\"."); })}>
                        <Link2 className="w-3 h-3 mr-1" />{c.name} (#{c.id})
                      </Button>
                    ))}
                  </div>
                ))}
              </div>
            </details>
          )}

          {p.archives.length > 0 && (
            <details open>
              <summary className="cursor-pointer text-xs font-medium">Arquivar ({p.archives.length}) — sem par na Multipark. Desmarca os que são só nossos</summary>
              <div className="max-h-60 overflow-auto mt-1 grid sm:grid-cols-2 gap-x-4">
                {p.archives.map((a) => (
                  <label key={a.recordId} className="flex items-start gap-2 text-xs py-0.5">
                    <input type="checkbox" checked={!keep.has(a.recordId)} onChange={(e) => setKeep((s) => { const n = new Set(s); if (e.target.checked) n.delete(a.recordId); else n.add(a.recordId); return n; })} />
                    <span className="[overflow-wrap:anywhere]">{a.name} <span className="text-muted-foreground">· {a.reason}</span></span>
                  </label>
                ))}
              </div>
            </details>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => { if (confirm("Aplicar a ligação à Multipark? Liga, cria e arquiva como está acima (nada é apagado).")) apply.mutate({ keepIds: [...keep] }); }} disabled={apply.isPending}>
              {apply.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}Aplicar
            </Button>
            <span className="text-xs text-muted-foreground">Depois de aplicar, liga em Definições → Automações "Parcerias: manter ligadas à Multipark todos os dias".</span>
          </div>
          <p className="text-xs text-muted-foreground">A Faturação ainda usa as nossas taxas; passa a usar os números da Multipark no passo seguinte.</p>
        </div>
      )}

      {showArchived && (
        <div className="text-xs space-y-1 border-t pt-2">
          {(archived as any[]).map((a: any) => (
            <div key={a.id} className="flex items-center gap-2">
              <span className="flex-1 [overflow-wrap:anywhere]">{a.name} <span className="text-muted-foreground">· {a.archivedReason ?? "arquivado"}</span></span>
              <Button size="sm" variant="outline" className="h-6 text-xs" disabled={unarchive.isPending} onClick={() => unarchive.mutate({ id: a.id })}>Repor</Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
