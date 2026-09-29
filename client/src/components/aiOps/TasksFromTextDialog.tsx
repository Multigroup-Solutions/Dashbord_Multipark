/**
 * "Criar tarefas a partir de texto": colar notas/passagem → a IA propõe
 * tarefas (título, responsável sugerido, prazo) → a pessoa revê, edita e
 * escolhe quais criar. Nada é criado sem o "Criar".
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Sparkles } from "lucide-react";

type Row = { keep: boolean; title: string; description: string | null; assigneeId: number | null; dueDate: string; priority: "low" | "medium" | "high" | "urgent"; hint: string | null };

const PRIORITY_LABEL = { low: "Baixa", medium: "Média", high: "Alta", urgent: "Urgente" } as const;

export default function TasksFromTextDialog({ open, onOpenChange, projectId, onCreated }: { open: boolean; onOpenChange: (v: boolean) => void; projectId?: number | null; onCreated?: () => void }) {
  const [text, setText] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const assignable = trpc.tasks.assignable.useQuery({ projectId: projectId ?? null }, { enabled: open && !!rows });
  const propose = trpc.tasks.proposeFromText.useMutation({
    onSuccess: (r) => {
      if (!r.proposals.length) { toast.info("A IA não encontrou tarefas neste texto."); return; }
      setRows(r.proposals.map((p) => ({ keep: true, title: p.title, description: p.description, assigneeId: p.suggestedAssigneeId, dueDate: p.dueDate ?? "", priority: p.priority, hint: p.assigneeHint })));
    },
    onError: (e) => toast.error(e.message),
  });
  const create = trpc.tasks.createFromProposals.useMutation({
    onSuccess: (r) => { toast.success(`${r.created} tarefa(s) criada(s)`); reset(); onOpenChange(false); onCreated?.(); },
    onError: (e) => toast.error(e.message),
  });
  const reset = () => { setText(""); setRows(null); };
  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs!.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  const chosen = (rows ?? []).filter((r) => r.keep && r.title.trim());

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Sparkles className="h-4 w-4" />Criar tarefas a partir de texto</DialogTitle>
          <DialogDescription>Cola notas ou uma passagem de turno. A IA propõe as tarefas; tu revês e só são criadas as que confirmares.</DialogDescription>
        </DialogHeader>
        {!rows ? (
          <div className="space-y-3">
            <Textarea rows={8} value={text} maxLength={6000} placeholder="Ex.: Amanhã o Rui tem de ligar ao cliente da reclamação 123. Falta repor os rolos do MB no terminal..." onChange={(e) => setText(e.target.value)} />
            <p className="text-[11px] text-muted-foreground">Emails, telefones e matrículas são tapados antes de irem para a IA.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {rows.map((r, i) => (
              <div key={i} className={`rounded-lg border p-3 space-y-2 ${r.keep ? "" : "opacity-50"}`}>
                <div className="flex items-start gap-2">
                  <Checkbox className="mt-2.5" checked={r.keep} onCheckedChange={(v) => set(i, { keep: !!v })} aria-label="Criar esta tarefa" />
                  <Input value={r.title} maxLength={256} onChange={(e) => set(i, { title: e.target.value })} />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pl-6">
                  <Select value={r.assigneeId ? String(r.assigneeId) : "none"} onValueChange={(v) => set(i, { assigneeId: v === "none" ? null : Number(v) })}>
                    <SelectTrigger className="w-full"><SelectValue placeholder="Responsável" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Sem responsável{r.hint ? ` (sugerido: ${r.hint})` : ""}</SelectItem>
                      {(assignable.data ?? []).map((e: any) => <SelectItem key={e.id} value={String(e.id)}>{e.fullName}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Input type="date" value={r.dueDate} onChange={(e) => set(i, { dueDate: e.target.value })} aria-label="Prazo" />
                  <Select value={r.priority} onValueChange={(v) => set(i, { priority: v as Row["priority"] })}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>{(Object.keys(PRIORITY_LABEL) as Row["priority"][]).map((p) => <SelectItem key={p} value={p}>{PRIORITY_LABEL[p]}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                {r.description && <p className="pl-6 text-xs text-muted-foreground break-words">{r.description}</p>}
              </div>
            ))}
          </div>
        )}
        <DialogFooter className="gap-2 flex-col-reverse sm:flex-row">
          {rows && <Button variant="outline" onClick={() => setRows(null)}>Voltar ao texto</Button>}
          {!rows ? (
            <Button disabled={text.trim().length < 10 || propose.isPending} onClick={() => propose.mutate({ text, projectId: projectId ?? null })}>
              {propose.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Propor tarefas
            </Button>
          ) : (
            <Button disabled={!chosen.length || create.isPending} onClick={() => create.mutate({
              projectId: projectId ?? null,
              tasks: chosen.map((r) => ({ title: r.title.trim(), description: r.description, assigneeId: r.assigneeId, dueDate: r.dueDate || null, priority: r.priority })),
            })}>
              {create.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Criar {chosen.length} tarefa(s)
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
