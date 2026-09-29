import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, Repeat, Trash2, Zap } from "lucide-react";
import { ALL_WEEKDAYS_MASK, TEMPLATE_SHIFT_LABELS, TEMPLATE_SHIFTS, WEEKDAY_LABELS, type TemplateShift } from "@shared/taskRules";

const ROLE_LABELS: Record<string, string> = {
  none: "Só as pessoas escolhidas",
  shift_team_leader: "Team leader(s) escalado(s) no turno",
  shift_all: "Toda a equipa escalada no turno",
};
const PRIORITY_LABELS: Record<string, string> = { low: "Baixa", medium: "Média", high: "Alta", urgent: "Urgente" };

type Form = {
  id?: number; title: string; description: string; cityProjectId: string; shift: TemplateShift; weekdaysMask: number;
  dueHour: string; priority: string; assigneeRole: string; assigneeEmployeeIds: number[]; active: boolean;
};
const EMPTY: Form = { title: "", description: "", cityProjectId: "", shift: "manha", weekdaysMask: ALL_WEEKDAYS_MASK, dueHour: "", priority: "medium", assigneeRole: "shift_team_leader", assigneeEmployeeIds: [], active: true };

const maskLabel = (m: number) => (m === ALL_WEEKDAYS_MASK ? "Todos os dias" : WEEKDAY_LABELS.filter((_, i) => m & (1 << i)).join(", "));

/** Gestão das checklists recorrentes (supervisor+). As tarefas geram-se de hora a hora (idempotente). */
export function TaskTemplatesPanel({ projects }: { projects: Array<{ id: number; name: string; level: string }> }) {
  const utils = trpc.useUtils();
  const list = trpc.tasks.templates.list.useQuery();
  const [form, setForm] = useState<Form | null>(null);
  const people = trpc.tasks.assignable.useQuery({ projectId: form?.cityProjectId ? Number(form.cityProjectId) : null }, { enabled: !!form });
  const save = trpc.tasks.templates.save.useMutation({
    onSuccess: () => { toast.success("Checklist guardada"); setForm(null); utils.tasks.templates.list.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const del = trpc.tasks.templates.delete.useMutation({
    onSuccess: () => { toast.success("Checklist apagada"); utils.tasks.templates.list.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const gen = trpc.tasks.templates.generateNow.useMutation({
    onSuccess: (r) => { toast.success(`${r.created} tarefa(s) criada(s) para ${r.date}`); utils.tasks.list.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const cities = projects.filter((p) => p.level === "city");
  const projName = (id: number | null) => projects.find((p) => p.id === id)?.name ?? "Todas";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm text-muted-foreground">Cada checklist ativa cria uma tarefa por dia (e turno) nos dias escolhidos. Não duplica.</p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => gen.mutate()} disabled={gen.isPending} title="Gera já as tarefas de hoje (o cron faz isto de hora a hora)">
            {gen.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Zap className="h-4 w-4 mr-1" />}Gerar hoje
          </Button>
          <Button size="sm" onClick={() => setForm({ ...EMPTY })}><Plus className="h-4 w-4 mr-1" />Nova checklist</Button>
        </div>
      </div>
      {list.isLoading && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
      {(list.data ?? []).length === 0 && !list.isLoading && (
        <Card><CardContent className="py-8 text-center text-muted-foreground"><Repeat className="h-8 w-8 mx-auto mb-2 opacity-40" />Sem checklists recorrentes.</CardContent></Card>
      )}
      <div className="grid gap-2 md:grid-cols-2">
        {(list.data ?? []).map((t: any) => (
          <Card key={t.id} className={t.active ? "" : "opacity-60"}>
            <CardContent className="p-3 space-y-1">
              <div className="flex items-start justify-between gap-2">
                <p className="font-medium">{t.title}</p>
                <div className="flex gap-0.5 shrink-0">
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setForm({
                    id: t.id, title: t.title, description: t.description ?? "", cityProjectId: t.cityProjectId ? String(t.cityProjectId) : "",
                    shift: t.shift, weekdaysMask: t.weekdaysMask, dueHour: t.dueHour == null ? "" : String(t.dueHour), priority: t.priority,
                    assigneeRole: t.assigneeRole ?? "none", assigneeEmployeeIds: t.assigneeEmployeeIds ?? [], active: !!t.active,
                  })}><Pencil className="h-3.5 w-3.5" /></Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => { if (confirm("Apagar esta checklist? As tarefas já criadas ficam.")) del.mutate({ id: t.id }); }}><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1 text-xs">
                <Badge variant="outline">{projName(t.cityProjectId)}</Badge>
                <Badge variant="outline">{TEMPLATE_SHIFT_LABELS[t.shift as TemplateShift] ?? t.shift}{t.dueHour != null ? ` · até ${String(t.dueHour).padStart(2, "0")}h` : ""}</Badge>
                <Badge variant="outline">{maskLabel(t.weekdaysMask)}</Badge>
                {!t.active && <Badge variant="outline">inativa</Badge>}
              </div>
              <p className="text-xs text-muted-foreground">{ROLE_LABELS[t.assigneeRole ?? "none"]}{t.assigneeEmployeeIds?.length ? ` + ${t.assigneeEmployeeIds.length} pessoa(s)` : ""}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={!!form} onOpenChange={(o) => { if (!o) setForm(null); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{form?.id ? "Editar checklist" : "Nova checklist recorrente"}</DialogTitle></DialogHeader>
          {form && (
            <div className="space-y-3">
              <div><Label>Título</Label><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Ex.: Verificar chaves no cofre" /></div>
              <div><Label>Descrição / passos</Label><Textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Cidade</Label>
                  <Select value={form.cityProjectId || "all"} onValueChange={(v) => setForm({ ...form, cityProjectId: v === "all" ? "" : v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Sem cidade</SelectItem>
                      {cities.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Turno</Label>
                  <Select value={form.shift} onValueChange={(v) => setForm({ ...form, shift: v as TemplateShift })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{TEMPLATE_SHIFTS.map((s) => <SelectItem key={s} value={s}>{TEMPLATE_SHIFT_LABELS[s]}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label>Dias da semana</Label>
                <div className="flex flex-wrap gap-2 mt-1">
                  {WEEKDAY_LABELS.map((l, i) => (
                    <label key={l} className="flex items-center gap-1 text-sm">
                      <Checkbox checked={!!(form.weekdaysMask & (1 << i))} onCheckedChange={(c) => setForm({ ...form, weekdaysMask: c ? form.weekdaysMask | (1 << i) : form.weekdaysMask & ~(1 << i) })} />{l}
                    </label>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Hora limite (0–23)</Label>
                  <Input inputMode="numeric" value={form.dueHour} onChange={(e) => setForm({ ...form, dueHour: e.target.value.replace(/\D/g, "").slice(0, 2) })} placeholder="fim do turno" />
                </div>
                <div>
                  <Label>Prioridade</Label>
                  <Select value={form.priority} onValueChange={(v) => setForm({ ...form, priority: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{Object.entries(PRIORITY_LABELS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label>Responsáveis</Label>
                <Select value={form.assigneeRole} onValueChange={(v) => setForm({ ...form, assigneeRole: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{Object.entries(ROLE_LABELS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
                </Select>
                <div className="border rounded-lg max-h-36 overflow-y-auto p-2 space-y-1 mt-2">
                  {(people.data ?? []).map((p: any) => (
                    <label key={p.id} className="flex items-center gap-2 text-sm px-1">
                      <Checkbox checked={form.assigneeEmployeeIds.includes(p.id)} onCheckedChange={(c) => setForm({ ...form, assigneeEmployeeIds: c ? [...form.assigneeEmployeeIds, p.id] : form.assigneeEmployeeIds.filter((x) => x !== p.id) })} />{p.fullName}
                    </label>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">A escala do turno só funciona com cidade escolhida.</p>
              </div>
              <label className="flex items-center gap-2 text-sm"><Switch checked={form.active} onCheckedChange={(v) => setForm({ ...form, active: v })} />Ativa</label>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)}>Cancelar</Button>
            <Button disabled={!form?.title.trim() || !form?.weekdaysMask || save.isPending} onClick={() => form && save.mutate({
              id: form.id,
              title: form.title.trim(),
              description: form.description || null,
              cityProjectId: form.cityProjectId ? Number(form.cityProjectId) : null,
              shift: form.shift,
              weekdaysMask: form.weekdaysMask,
              dueHour: form.dueHour === "" ? null : Math.min(23, Number(form.dueHour)),
              priority: form.priority as any,
              assigneeRole: form.assigneeRole === "none" ? null : (form.assigneeRole as any),
              assigneeEmployeeIds: form.assigneeEmployeeIds,
              active: form.active,
            })}>Guardar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
