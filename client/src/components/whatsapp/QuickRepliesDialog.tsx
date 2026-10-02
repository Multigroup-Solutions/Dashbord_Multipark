import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { can } from "@shared/access";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Archive, Pencil, Plus, Zap } from "lucide-react";

/** Gestão das respostas rápidas (lista + criar/editar; arquivar é de quem gere). */
export function QuickRepliesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { user } = useAuth();
  const canEdit = can(user as any, "whatsapp", "edit");
  const canManage = can(user as any, "whatsapp", "manage");
  const utils = trpc.useUtils();
  const list = trpc.whatsapp.quickReplies.list.useQuery(undefined, { enabled: open });
  const [editId, setEditId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  function reset() {
    setEditId(null);
    setTitle("");
    setBody("");
  }

  const save = trpc.whatsapp.quickReplies.save.useMutation({
    onSuccess: () => {
      toast.success(editId ? "Resposta rápida atualizada." : "Resposta rápida criada.");
      reset();
      utils.whatsapp.quickReplies.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const del = trpc.whatsapp.quickReplies.archive.useMutation({
    onSuccess: () => {
      toast.success("Resposta rápida arquivada.");
      utils.whatsapp.quickReplies.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-green-600" /> Respostas rápidas
          </DialogTitle>
          <DialogDescription>
            Textos guardados para inserir no composer. Usa <code>{"{{nome}}"}</code> para o primeiro nome do contacto.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {list.isLoading && <p className="text-sm text-muted-foreground">A carregar…</p>}
          {list.error && <QueryErrorNote error={list.error} onRetry={() => list.refetch()} retrying={list.isFetching} what="as respostas rápidas" />}
          {list.data?.length === 0 && <p className="text-sm text-muted-foreground">Ainda não há respostas rápidas.</p>}
          {list.data?.map((r) => (
            <div key={r.id} className={`rounded-md border p-2 text-sm flex gap-2 ${editId === r.id ? "border-green-500" : ""}`}>
              <div className="min-w-0 flex-1">
                <div className="font-medium truncate">{r.title}</div>
                <div className="text-xs text-muted-foreground line-clamp-2 whitespace-pre-wrap">{r.body}</div>
              </div>
              {canEdit && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 shrink-0"
                  aria-label={`Editar ${r.title}`}
                  onClick={() => { setEditId(r.id); setTitle(r.title); setBody(r.body); }}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
              )}
              {canManage && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 shrink-0 text-muted-foreground"
                  aria-label={`Arquivar ${r.title}`}
                  title="Arquivar (sai do menu de toda a gente; não se apaga)"
                  disabled={del.isPending}
                  onClick={() => { if (window.confirm(`Arquivar a resposta rápida “${r.title}”? Sai do menu de toda a gente.`)) del.mutate({ id: r.id }); }}
                >
                  <Archive className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}
        </div>

        {canEdit && <div className="space-y-2 border-t pt-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {editId ? "Editar resposta rápida" : "Nova resposta rápida"}
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Título</Label>
            <Input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="Ex.: Horário do parque" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Texto</Label>
            <Textarea rows={4} value={body} maxLength={4000} onChange={(e) => setBody(e.target.value)} placeholder="Olá {{nome}}, …" />
          </div>
          <div className="flex justify-end gap-2">
            {editId && (
              <Button variant="ghost" size="sm" onClick={reset}>Cancelar edição</Button>
            )}
            <Button
              size="sm"
              className="bg-green-600 hover:bg-green-700 text-white"
              disabled={!title.trim() || !body.trim() || save.isPending}
              onClick={() => save.mutate({ id: editId, title: title.trim(), body: body.trim() })}
            >
              <Plus className="h-4 w-4 mr-1" /> {editId ? "Guardar" : "Adicionar"}
            </Button>
          </div>
        </div>}
      </DialogContent>
    </Dialog>
  );
}
