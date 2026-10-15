/**
 * Críticas → Limpeza (admin; plano MPV F6b — R2/R3): as que não são críticas
 * e as repetidas. Só pré-visualizar → aplicar → desfazer; nunca corre sozinha.
 * Nada se apaga: as marcadas saem das listas e dos números e voltam com
 * "Desfazer".
 */
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { toast } from "sonner";
import { Loader2, Undo2 } from "lucide-react";
import { useConfirm } from "@/pages/training/shared";

type Kind = "not_review" | "duplicate";

const KIND_TEXT: Record<Kind, { title: string; intro: string; markLabel: string; markedLabel: string }> = {
  not_review: {
    title: "Emails que não são críticas",
    intro: "Emails que entraram pelas Críticas sem ser um aviso de avaliação e sem estrelas (candidaturas, respostas de clientes, alertas). Ao aplicar ficam marcados \"não é crítica\": saem da lista e dos números e o rascunho da IA é guardado à parte (volta com Desfazer). Nada se apaga.",
    markLabel: "Marcar como \"não é crítica\"",
    markedLabel: "Marcadas como \"não é crítica\"",
  },
  duplicate: {
    title: "Críticas repetidas",
    intro: "A mesma crítica que chegou duas vezes (2 emails da Google, ou email + Windsor): mesmo parque, mesmas estrelas, mesmo 1.º nome, o mesmo texto com 20 ou mais letras e até 48 h de diferença. Sem texto nunca se junta. Fica a original (a da API, senão a mais antiga); as outras ficam marcadas \"repetida de #…\" e saem das listas. Nada se apaga.",
    markLabel: "Marcar como repetidas",
    markedLabel: "Marcadas como repetidas",
  },
};

export default function ReviewCleanupPanel({ onOpen }: { onOpen?: (id: number) => void }) {
  const [kind, setKind] = useState<Kind>("not_review");
  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        {(["not_review", "duplicate"] as Kind[]).map((k) => (
          <Button key={k} size="sm" variant={kind === k ? "selected" : "outline"} onClick={() => setKind(k)}>{KIND_TEXT[k].title}</Button>
        ))}
      </div>
      <KindSection key={kind} kind={kind} onOpen={onOpen} />
    </div>
  );
}

function KindSection({ kind, onOpen }: { kind: Kind; onOpen?: (id: number) => void }) {
  const text = KIND_TEXT[kind];
  const utils = trpc.useUtils();
  const previewQ = trpc.reviews.cleanupPreview.useQuery({ kind });
  const [confirm, confirmUi] = useConfirm();
  const refresh = () => Promise.all([utils.reviews.cleanupPreview.invalidate(), utils.reviews.list.invalidate(), utils.reviews.stats.invalidate()]);
  const applyMut = trpc.reviews.cleanupApply.useMutation({
    onSuccess: (r) => { toast.success(`${r.marked} crítica(s) marcada(s)`); void refresh(); },
    onError: (e) => toast.error(e.message || "Não foi possível aplicar"),
  });
  const undoMut = trpc.reviews.cleanupUndo.useMutation({
    onSuccess: (r) => { toast.success(`Desfeito em ${r.undone} crítica(s)`); void refresh(); },
    onError: (e) => toast.error(e.message || "Não foi possível desfazer"),
  });
  const data = previewQ.data;
  const markIds = useMemo(() => (data?.mark ?? []).map((i) => i.id), [data]);

  const apply = async () => {
    if (!markIds.length) return;
    const ok = await confirm({ title: text.markLabel, description: `${markIds.length} crítica(s). Não se apaga nada e desfaz-se aqui em baixo.`, confirmLabel: "Aplicar" });
    if (ok) applyMut.mutate({ kind, ids: markIds });
  };
  const undoAll = async () => {
    const ok = await confirm({ title: "Desfazer todas", description: "Todas as marcadas deste tipo voltam às listas (e o rascunho guardado volta, se não houver outro).", confirmLabel: "Desfazer todas" });
    if (ok) undoMut.mutate({ kind, ids: [] });
  };

  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">{text.title}</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">{text.intro}</p>
        {previewQ.error && <QueryErrorNote error={previewQ.error} onRetry={() => previewQ.refetch()} retrying={previewQ.isFetching} what="a limpeza" />}
        {previewQ.isLoading && <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> A calcular…</div>}
        {data && (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline">{data.mark.length} para marcar</Badge>
              {data.keep.length > 0 && <Badge variant="outline">{data.keep.length} ficam</Badge>}
              <Badge variant="outline">{data.marked.length} já marcadas</Badge>
              <Button size="sm" disabled={!markIds.length || applyMut.isPending} onClick={apply}>
                {applyMut.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}{text.markLabel}
              </Button>
            </div>
            <ItemList title="Vão ser marcadas" items={data.mark} kind={kind} onOpen={onOpen} />
            {data.keep.length > 0 && <ItemList title="Batem na regra mas ficam" items={data.keep} kind={kind} onOpen={onOpen} />}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="font-medium">{text.markedLabel}</div>
                {data.marked.length > 0 && (
                  <Button size="sm" variant="outline" disabled={undoMut.isPending} onClick={undoAll}><Undo2 className="w-4 h-4 mr-1" /> Desfazer todas</Button>
                )}
              </div>
              {data.marked.length === 0 ? <p className="text-muted-foreground">Nenhuma.</p> : (
                <ItemList items={data.marked} kind={kind} onOpen={onOpen} onUndo={(id) => undoMut.mutate({ kind, ids: [id] })} undoing={undoMut.isPending} />
              )}
            </div>
          </>
        )}
      </CardContent>
      {confirmUi}
    </Card>
  );
}

type Item = { id: number; reviewerName: string; rating: number; date: string | null; snippet: string; fromEmail?: string | null; duplicateOf?: number | null; hasDraft?: boolean; why?: string };

function ItemList({ title, items, kind, onOpen, onUndo, undoing }: { title?: string; items: Item[]; kind: Kind; onOpen?: (id: number) => void; onUndo?: (id: number) => void; undoing?: boolean }) {
  if (!items.length) return title ? <div><div className="font-medium">{title}</div><p className="text-muted-foreground">Nenhuma.</p></div> : null;
  return (
    <div className="space-y-1">
      {title && <div className="font-medium">{title}</div>}
      <ul className="divide-y rounded border max-h-96 overflow-y-auto">
        {items.map((i) => (
          <li key={i.id} className="p-2 flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <button type="button" className="font-mono text-xs underline" onClick={() => onOpen?.(i.id)}>#{i.id}</button>
                <span className="font-medium truncate">{i.reviewerName || "—"}</span>
                <span className="text-xs text-muted-foreground">{i.rating > 0 ? `${i.rating}★` : "sem estrelas"}</span>
                {i.date && <span className="text-xs text-muted-foreground">{fmtPTDateTime(i.date)}</span>}
                {kind === "not_review" && i.fromEmail && <span className="text-xs text-muted-foreground truncate">de {i.fromEmail}</span>}
                {kind === "duplicate" && i.duplicateOf && <Badge variant="outline" className="text-xs">repetida de #{i.duplicateOf}</Badge>}
                {i.hasDraft && <Badge variant="outline" className="text-xs">tem rascunho</Badge>}
              </div>
              <div className="text-xs text-muted-foreground truncate">{i.snippet}</div>
              {i.why && <div className="text-xs text-amber-700 dark:text-amber-300">{i.why}</div>}
            </div>
            {onUndo && <Button size="sm" variant="ghost" disabled={undoing} onClick={() => onUndo(i.id)}><Undo2 className="w-4 h-4 mr-1" /> Desfazer</Button>}
          </li>
        ))}
      </ul>
    </div>
  );
}
