import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, MoveRight, ParkingSquare } from "lucide-react";

type Node = { id: number; name: string; level: string; parentId: number | null; isActive: boolean | number };

/**
 * Cobertura de parques (só admin com todas as cidades): que parques do
 * PARK_CONFIGS não têm nó de projeto, quantas reservas estão sem projeto e o
 * botão idempotente "Criar nós em falta" (+ backfill). Inclui o diagnóstico da
 * árvore: órfãos (pai inexistente, com "mover para…"), ciclos e nomes
 * duplicados no mesmo pai.
 */
export default function ParkCoverageCard({ projects, onMove }: { projects: Node[]; onMove: (node: Node) => void }) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = trpc.projects.parkCoverage.useQuery();
  const createMut = trpc.projects.createMissingParkNodes.useMutation({
    onSuccess: (r) => {
      utils.projects.list.invalidate();
      utils.projects.parkCoverage.invalidate();
      toast.success(`${r.created.length} nó(s) criado(s); ${r.backfill.matched} reserva(s) associada(s)${r.backfill.unmatched ? `, ${r.backfill.unmatched} sem correspondência` : ""}.`);
    },
    onError: (e) => toast.error(e.message),
  });

  if (error) return null;
  if (isLoading || !data) return null;

  const orphans = data.diagnostics.orphans;
  const problems = data.missing + orphans.length + data.diagnostics.duplicates.length + data.diagnostics.cycles.length;
  const newBrands = new Set(data.plan.filter(p => !p.brandExists).map(p => `${p.cityName} › ${p.brandName}`));

  const confirmCreate = () => {
    const lines = [
      `Vão ser criados ${data.plan.length} nó(s) de parque${newBrands.size ? ` e ${newBrands.size} nó(s) de marca (${Array.from(newBrands).join(", ")})` : ""}.`,
      `Reservas sem projeto: ${data.nullBookings.total} — associáveis agora: ${data.nullBookings.matchableNow}; depois de criar: ${data.nullBookings.matchableAfter}.`,
      "Continuar?",
    ];
    if (confirm(lines.join("\n\n"))) createMut.mutate();
  };

  return (
    <Card>
      <CardHeader className="pb-2 cursor-pointer" onClick={() => setOpen(o => !o)}>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-base flex items-center gap-2">
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <ParkingSquare className="h-4 w-4" /> Cobertura de parques e diagnóstico
          </CardTitle>
          <div className="flex items-center gap-2 text-xs">
            {problems === 0 && data.nullBookings.total === 0 ? (
              <Badge variant="outline" className="text-emerald-700"><CheckCircle2 className="h-3 w-3 mr-1" /> Tudo coberto</Badge>
            ) : (
              <>
                {data.missing > 0 && <Badge variant="destructive">{data.missing} parque(s) sem nó</Badge>}
                {data.nullBookings.total > 0 && <Badge variant="secondary">{data.nullBookings.total.toLocaleString("pt-PT")} reservas sem projeto</Badge>}
                {orphans.length > 0 && <Badge variant="secondary">{orphans.length} órfão(s)</Badge>}
                {data.diagnostics.duplicates.length > 0 && <Badge variant="secondary">{data.diagnostics.duplicates.length} nome(s) duplicado(s)</Badge>}
              </>
            )}
          </div>
        </div>
      </CardHeader>
      {open && (
        <CardContent className="space-y-5 text-sm">
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h3 className="font-medium">Parques configurados sem nó na árvore</h3>
              <Button size="sm" disabled={createMut.isPending || (data.plan.length === 0 && data.nullBookings.matchableNow === 0)} onClick={confirmCreate}>
                {createMut.isPending ? "A criar…" : "Criar nós em falta"}
              </Button>
            </div>
            {data.plan.length === 0 ? (
              <p className="text-muted-foreground">Todos os parques ativos têm nó. {data.nullBookings.matchableNow > 0 ? `O botão associa ${data.nullBookings.matchableNow} reserva(s) sem projeto.` : ""}</p>
            ) : (
              <ul className="grid sm:grid-cols-2 gap-1">
                {data.plan.map(p => (
                  <li key={`${p.cityNodeId}-${p.projectName}`} className="flex items-center gap-2">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
                    <span>{p.projectName}</span>
                    <span className="text-xs text-muted-foreground">→ {p.cityName} › {p.brandName}{p.brandExists ? "" : " (nova)"}</span>
                  </li>
                ))}
              </ul>
            )}
            {data.skipped.length > 0 && (
              <p className="text-xs text-muted-foreground">Ignorados: {data.skipped.map(s => `${s.park} ${s.city} (${s.reason})`).join(", ")}</p>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="font-medium">Reservas sem projeto ({data.nullBookings.total.toLocaleString("pt-PT")})</h3>
            {data.nullBookings.groups.length === 0 ? (
              <p className="text-muted-foreground">Nenhuma.</p>
            ) : (
              <div className="max-h-64 overflow-auto border rounded-md">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 sticky top-0">
                    <tr><th className="text-left p-2">Parque</th><th className="text-left p-2">Cidade</th><th className="text-right p-2">Reservas</th><th className="text-left p-2">Associa a</th></tr>
                  </thead>
                  <tbody>
                    {data.nullBookings.groups.map((g, i) => (
                      <tr key={i} className="border-t">
                        <td className="p-2">{g.parkName ?? "—"}</td>
                        <td className="p-2">{g.city ?? "—"}</td>
                        <td className="p-2 text-right font-mono">{g.count.toLocaleString("pt-PT")}</td>
                        <td className="p-2 text-muted-foreground">{g.wouldMatch ?? "sem correspondência"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="font-medium">Órfãos ({orphans.length})</h3>
            <p className="text-xs text-muted-foreground">Nós cujo pai já não existe — não aparecem no sítio certo da árvore.</p>
            {orphans.length === 0 ? <p className="text-muted-foreground">Nenhum.</p> : (
              <ul className="space-y-1">
                {orphans.map(o => {
                  const node = projects.find(p => p.id === o.id);
                  return (
                    <li key={o.id} className="flex items-center gap-2">
                      <span className={o.isActive ? "" : "opacity-50"}>{o.name}</span>
                      <span className="text-xs text-muted-foreground">({o.level}, pai #{o.parentId} inexistente)</span>
                      {node && (
                        <Button size="sm" variant="outline" className="h-7 ml-auto" onClick={() => onMove(node)}>
                          <MoveRight className="h-3.5 w-3.5 mr-1" /> Mover para…
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {(data.diagnostics.duplicates.length > 0 || data.diagnostics.cycles.length > 0) && (
            <section className="space-y-2">
              <h3 className="font-medium">Outros problemas</h3>
              {data.diagnostics.duplicates.map(d => (
                <p key={`${d.parentId}-${d.name}`} className="text-xs">
                  Nome duplicado «{d.name}» em {d.parentName ?? "raiz"}: ids {d.ids.join(", ")} — renomeia ou desativa um deles.
                </p>
              ))}
              {data.diagnostics.cycles.length > 0 && (
                <p className="text-xs text-destructive">Nós em ciclo (pai aponta para um descendente): ids {data.diagnostics.cycles.join(", ")}.</p>
              )}
            </section>
          )}
        </CardContent>
      )}
    </Card>
  );
}
