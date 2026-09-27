import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { PARK_LISTING_TYPE_LABELS, PARK_STATUS_LABELS } from "@shared/multiparkParks";
import { AlertTriangle, RefreshCw } from "lucide-react";

/**
 * "Classificação dos parques" (só leitura): cada parque da BD da Multipark com
 * a marca (firebaseBrand), cidade, listingType, estado e a classificação que o
 * dashboard calcula — para o Jorge confirmar as regras de shared/multiparkParks.ts.
 * Lê a tabela "Park" ao vivo só quando o diálogo está aberto.
 */
export default function ParkClassificationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const q = trpc.multipark.parkClassification.useQuery(undefined, { enabled: open, staleTime: 60_000 });
  const parks = q.data?.available ? q.data.parks : [];
  const counts = useMemo(() => ({ ours: parks.filter((p) => p.ours).length, market: parks.filter((p) => !p.ours).length }), [parks]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Classificação dos parques</DialogTitle>
          <DialogDescription>
            Nosso = marca Airpark, Redpark ou Skypark (do <code>firebaseBrand</code>; se vazio, do nome) numa cidade
            Lisboa, Porto ou Faro (do campo cidade; se vazio, do nome). Os outros vão para o Marketplace.
            O tipo de listagem só se mostra.
          </DialogDescription>
        </DialogHeader>

        {q.isLoading ? (
          <div className="flex items-center justify-center py-10"><RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" /></div>
        ) : q.data && !q.data.available ? (
          <p className="text-sm flex gap-2"><AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />{q.data.reason}</p>
        ) : q.error ? (
          <p className="text-sm text-destructive">Erro: {q.error.message}</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {parks.length} parques · {counts.ours} nossos · {counts.market} no Marketplace
            </p>
            <div className="overflow-x-auto border rounded-md">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground bg-muted/40">
                    <th className="p-2 font-medium">Parque</th>
                    <th className="p-2 font-medium">firebaseBrand</th>
                    <th className="p-2 font-medium">Cidade</th>
                    <th className="p-2 font-medium">Listagem</th>
                    <th className="p-2 font-medium">Estado</th>
                    <th className="p-2 font-medium">Classificação</th>
                  </tr>
                </thead>
                <tbody>
                  {parks.map((p) => (
                    <tr key={p.id} className="border-t align-top">
                      <td className="p-2">{p.name}</td>
                      <td className="p-2 text-xs font-mono">{p.firebaseBrand ?? <span className="text-muted-foreground">—</span>}</td>
                      <td className="p-2 text-xs">{p.cityName ?? <span className="text-muted-foreground">—</span>}</td>
                      <td className="p-2 text-xs">{p.listingType ? PARK_LISTING_TYPE_LABELS[p.listingType] ?? p.listingType : "—"}</td>
                      <td className="p-2 text-xs">{p.status ? PARK_STATUS_LABELS[p.status] ?? p.status : "—"}</td>
                      <td className="p-2 text-xs">
                        <Badge variant="outline" className={p.ours ? "border-sky-200 text-sky-700" : "border-dashed border-rose-200 text-rose-700"}>
                          {p.ours ? `Nosso · ${p.label}` : "Marketplace"}
                        </Badge>
                        <span className="block text-[11px] text-muted-foreground mt-0.5">{p.reason}</span>
                      </td>
                    </tr>
                  ))}
                  {parks.length === 0 && (
                    <tr><td colSpan={6} className="p-4 text-center text-muted-foreground">Sem parques no teu âmbito.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
