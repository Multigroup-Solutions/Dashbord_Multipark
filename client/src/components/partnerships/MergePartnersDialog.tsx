import { useEffect, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import { getPartnerType } from "@shared/partnerTypes";

/**
 * Juntar registos das Parcerias (o mesmo parceiro em vários registos).
 * Escolhe-se o que FICA; os outros juntam-se a ele (aliases, id da Multipark,
 * agentes, nome e chave de campanha — as reservas vão com eles) e ficam
 * arquivados "Junto a…". Desfaz-se em Arquivados → Separar.
 */
export function MergePartnersDialog({ records, onClose }: { records: any[]; onClose: (done: boolean) => void }) {
  const utils = trpc.useUtils();
  const best = [...records].sort((a, b) => Number(!!b.multiparkPartnerId) - Number(!!a.multiparkPartnerId) || Number(!!b.configuredAt) - Number(!!a.configuredAt) || a.id - b.id)[0];
  const [keepId, setKeepId] = useState<number>(best?.id);
  const preview = trpc.partnerships.mergePreview.useMutation();
  const merge = trpc.partnerships.merge.useMutation({
    onSuccess: (r) => {
      toast.success(`${r.drops.length} registo(s) juntos a "${r.keep.name}".`);
      utils.partnerships.list.invalidate(); utils.partnerships.archived.invalidate(); utils.partnerships.invoicingSummary.invalidate(); utils.partnerships.live.invalidate();
      onClose(true);
    },
    onError: (e) => toast.error(e.message),
  });
  const dropIds = records.map((r) => r.id).filter((id) => id !== keepId);
  useEffect(() => { if (keepId && dropIds.length) preview.mutate({ keepId, dropIds }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [keepId]);

  return (
    <Dialog open onOpenChange={(v) => !v && onClose(false)}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Juntar registos</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">Escolhe o registo que <strong>fica</strong>. Os outros juntam-se a ele: tudo o que liga as reservas (nome, chave de campanha, id da Multipark, aliases e agentes) passa para o que fica, e eles ficam arquivados "Junto a…" (nunca apagados; em Arquivados há <strong>Separar</strong>).</p>
        <div className="space-y-1">
          {records.map((r) => (
            <label key={r.id} className={`flex items-start gap-2 rounded border p-2 text-sm cursor-pointer ${keepId === r.id ? "border-sky-500 bg-sky-50 dark:bg-sky-950/30" : ""}`}>
              <input type="radio" name="keep" checked={keepId === r.id} onChange={() => setKeepId(r.id)} className="mt-1" />
              <span className="flex-1 min-w-0">
                <span className="font-medium break-words">{r.name}</span> <span className="text-xs text-muted-foreground">#{r.id}</span>
                <span className="block text-xs text-muted-foreground">
                  <Badge variant="outline" className="text-[10px] mr-1">{getPartnerType(r.partnerType).label}</Badge>
                  {r.contactEmail ?? "sem email"}{r.multiparkPartnerId ? " · ligado à Multipark" : ""}
                </span>
              </span>
              {keepId === r.id && <Badge className="bg-sky-600">fica</Badge>}
            </label>
          ))}
        </div>
        {preview.isPending && <p className="text-xs text-muted-foreground"><Loader2 className="inline w-3 h-3 animate-spin mr-1" />A ver o que muda…</p>}
        {preview.error && <p className="text-xs text-red-600">{preview.error.message}</p>}
        {preview.data && (
          <div className="text-xs space-y-1">
            {preview.data.drops.map((d) => (
              <div key={d.id}>→ <strong>{d.name}</strong> junta-se a <strong>{preview.data!.keep.name}</strong>{d.aliases || d.agents ? ` (${d.aliases} alias, ${d.agents} agente(s))` : ""}</div>
            ))}
            {preview.data.warnings.map((w) => <div key={w} className="text-amber-700">⚠ {w}</div>)}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onClose(false)}>Cancelar</Button>
          <Button disabled={!preview.data || merge.isPending || !dropIds.length} onClick={() => merge.mutate({ keepId, dropIds })}>
            {merge.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}Juntar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
