import { useState, useMemo, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { fmtPTDate, fmtPTDateTime } from "@/lib/lisbonTime";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import {
  ListTodo, Plus, Clock, AlertTriangle, CheckCircle2, Circle,
  ArrowUpCircle, Pencil, Trash2, CalendarDays, Users, LayoutGrid, List, GripVertical, Bell, Search,
  ChevronLeft, ChevronRight,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";

const LEVEL_LABEL: Record<string, string> = {
  group: "Grupo", city: "Cidade", brand: "Marca", project: "Projeto",
};
const LEVEL_COLOR: Record<string, string> = {
  group: "bg-violet-100 text-violet-700 border-violet-200",
  city: "bg-blue-100 text-blue-700 border-blue-200",
  brand: "bg-emerald-100 text-emerald-700 border-emerald-200",
  project: "bg-amber-100 text-amber-700 border-amber-200",
};

function sortProjectsHierarchical<T extends { id: number; name: string; parentId?: number | null; level?: string | null }>(
  list: T[],
): Array<T & { __depth: number }> {
  const byParent = new Map<number | null, T[]>();
  for (const p of list) {
    const key = (p.parentId ?? null) as number | null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(p);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.name.localeCompare(b.name, "pt"));
  const out: Array<T & { __depth: number }> = [];
  function walk(parentId: number | null, depth: number) {
    const children = byParent.get(parentId) ?? [];
    for (const c of children) {
      out.push({ ...c, __depth: depth });
      walk(c.id, depth + 1);
    }
  }
  walk(null, 0);
  const seen = new Set(out.map((p) => p.id));
  for (const p of list) {
    if (!seen.has(p.id)) out.push({ ...p, __depth: 0 });
  }
  return out;
}

const COLUMNS = [
  { id: "backlog", label: "Backlog", icon: Circle, pill: "bg-slate-100 text-slate-800" },
  { id: "todo", label: "A Fazer", icon: ListTodo, pill: "bg-blue-100 text-blue-800" },
  { id: "in_progress", label: "Em Curso", icon: Clock, pill: "bg-amber-100 text-amber-800" },
  { id: "review", label: "Revisão", icon: ArrowUpCircle, pill: "bg-purple-100 text-purple-800" },
  { id: "done", label: "Concluído", icon: CheckCircle2, pill: "bg-emerald-100 text-emerald-800" },
];

const PRIORITY_COLORS: Record<string, string> = {
  low: "bg-slate-100 text-slate-700", medium: "bg-blue-100 text-blue-700",
  high: "bg-amber-100 text-amber-700", urgent: "bg-red-100 text-red-700",
};
const PRIORITY_LABELS: Record<string, string> = {
  low: "Baixa", medium: "Média", high: "Alta", urgent: "Urgente",
};
const STATUS_LABELS: Record<string, string> = {
  backlog: "Backlog", todo: "A Fazer", in_progress: "Em Curso", review: "Revisão", done: "Concluído",
};

type Assignee = { id: number; fullName: string };
type TaskRaw = {
  id: number; title: string; description: string | null; projectId: number | null;
  projectName?: string | null;
  assigneeId: number | null; assignees?: Assignee[]; createdById: number;
  taskStatus?: string; taskPriority?: string; status?: string; priority?: string;
  dueDate: Date | string | null; completedAt: Date | string | null;
  createdAt: Date | string; updatedAt: Date | string;
};
type Task = {
  id: number; title: string; description: string | null; projectId: number | null;
  projectName: string | null;
  assigneeId: number | null; assignees: Assignee[]; createdById: number;
  status: string; priority: string;
  dueDate: Date | string | null; completedAt: Date | string | null;
  createdAt: Date | string; updatedAt: Date | string;
};
function normalizeTask(t: TaskRaw): Task {
  return {
    ...t,
    projectName: t.projectName ?? null,
    assignees: t.assignees ?? [],
    status: t.taskStatus ?? t.status ?? "todo",
    priority: t.taskPriority ?? t.priority ?? "medium",
  } as Task;
}

export default function TasksPage() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const { data: allTasks = [], isLoading } = trpc.tasks.list.useQuery();
  const { data: stats } = trpc.tasks.stats.useQuery();
  const { data: projects = [] } = trpc.projects.list.useQuery();
  const { data: employees = [] } = trpc.rh.roster.useQuery({ activeOnly: true });
  const [showCreate, setShowCreate] = useState(false);
  const [editTask, setEditTask] = useState<Task | null>(null);
  const [filterProject, setFilterProject] = useState<string>("all");
  const [viewMode, setViewMode] = useState<"kanban" | "list">("kanban");
  const [searchTerm, setSearchTerm] = useState("");
  const [form, setForm] = useState({
    title: "", description: "", projectId: "", assigneeIds: [] as number[], priority: "medium", dueDate: "",
  });

  // Drag & Drop state
  const [draggedTaskId, setDraggedTaskId] = useState<number | null>(null);
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);

  const createMut = trpc.tasks.create.useMutation({
    onSuccess: () => { utils.tasks.list.invalidate(); utils.tasks.stats.invalidate(); setShowCreate(false); resetForm(); toast.success("Tarefa criada!"); },
    onError: (e) => toast.error(e.message),
  });
  const updateMut = trpc.tasks.update.useMutation({
    onSuccess: () => { utils.tasks.list.invalidate(); utils.tasks.stats.invalidate(); setEditTask(null); toast.success("Tarefa atualizada!"); },
    onError: (e) => toast.error(e.message),
  });
  const deleteMut = trpc.tasks.delete.useMutation({
    onSuccess: () => { utils.tasks.list.invalidate(); utils.tasks.stats.invalidate(); toast.success("Tarefa eliminada!"); },
    onError: (e) => toast.error(e.message),
  });
  // Drag & drop com optimistic update — actualiza a UI imediatamente e faz
  // rollback se o servidor falhar.
  const moveMut = trpc.tasks.update.useMutation({
    onMutate: async (vars: { id: number; status?: string }) => {
      if (!vars.status) return { prev: undefined };
      await utils.tasks.list.cancel();
      const prev = utils.tasks.list.getData();
      if (prev) {
        utils.tasks.list.setData(undefined, (old: any) => {
          if (!old) return old;
          return old.map((t: any) =>
            t.id === vars.id ? { ...t, taskStatus: vars.status } : t,
          );
        });
      }
      return { prev };
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.prev !== undefined) utils.tasks.list.setData(undefined, ctx.prev);
      toast.error("Não foi possível mover a tarefa");
    },
    onSettled: () => {
      utils.tasks.list.invalidate();
      utils.tasks.stats.invalidate();
    },
  });
  const checkNotifMut = trpc.tasks.checkNotifications.useMutation({
    onSuccess: (data) => {
      if (data.notified > 0) {
        toast.success(`${data.notified} notificação(ões) enviada(s)`);
      } else {
        toast.info("Nenhuma notificação pendente");
      }
    },
    onError: (e) => toast.error(e.message),
  });

  function resetForm() {
    setForm({ title: "", description: "", projectId: "", assigneeIds: [], priority: "medium", dueDate: "" });
  }

  function openEdit(t: Task | TaskRaw) {
    const normalized = "taskStatus" in t ? normalizeTask(t as TaskRaw) : t as Task;
    setEditTask(normalized);
    // Os assignees já vêm da query lista; sem necessidade de fetch extra
    const ids = normalized.assignees.length > 0
      ? normalized.assignees.map(a => a.id)
      : (normalized.assigneeId ? [normalized.assigneeId] : []);
    setForm({
      title: normalized.title,
      description: normalized.description ?? "",
      projectId: normalized.projectId?.toString() ?? "",
      assigneeIds: ids,
      priority: normalized.priority,
      dueDate: normalized.dueDate ? new Date(normalized.dueDate).toISOString().split("T")[0] : "",
    });
  }

  function toggleAssignee(empId: number) {
    setForm(f => ({
      ...f,
      assigneeIds: f.assigneeIds.includes(empId)
        ? f.assigneeIds.filter(id => id !== empId)
        : [...f.assigneeIds, empId],
    }));
  }

  const filteredTasks = useMemo(() => {
    let t = (allTasks as unknown as TaskRaw[]).map(normalizeTask);
    if (filterProject !== "all") t = t.filter(x => x.projectId === parseInt(filterProject));
    const q = searchTerm.trim().toLowerCase();
    if (q) {
      t = t.filter(x =>
        x.title.toLowerCase().includes(q) ||
        (x.description ?? "").toLowerCase().includes(q) ||
        x.assignees.some(a => a.fullName.toLowerCase().includes(q)),
      );
    }
    return t;
  }, [allTasks, filterProject, searchTerm]);

  const grouped = useMemo(() => {
    const map: Record<string, Task[]> = {};
    COLUMNS.forEach(c => { map[c.id] = []; });
    filteredTasks.forEach(t => {
      if (map[t.status]) map[t.status].push(t);
    });
    return map;
  }, [filteredTasks]);

  function isOverdue(t: Task) {
    return t.dueDate && new Date(t.dueDate) < new Date() && t.status !== "done";
  }

  function renderAssignees(task: Task) {
    const list = task.assignees;
    if (list.length === 0) return null;
    const visible = list.slice(0, 2);
    const extra = list.length - visible.length;
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
        <Users className="h-3 w-3 shrink-0" />
        {visible.map(a => a.fullName).join(", ")}
        {extra > 0 && <span className="font-medium">+{extra}</span>}
      </span>
    );
  }

  // ─── DRAG & DROP HANDLERS ─────────────────────────────────────────────────
  const handleDragStart = useCallback((e: React.DragEvent, taskId: number) => {
    setDraggedTaskId(taskId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(taskId));
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = "0.5";
    }
  }, []);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    setDraggedTaskId(null);
    setDragOverCol(null);
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = "1";
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, colId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverCol(colId);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Só limpa quando sai mesmo da coluna — sair para um FILHO da coluna
    // disparava isto e o highlight piscava.
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverCol(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, colId: string) => {
    e.preventDefault();
    setDragOverCol(null);
    const taskId = parseInt(e.dataTransfer.getData("text/plain"));
    if (isNaN(taskId)) return;
    const task = (allTasks as unknown as TaskRaw[]).map(normalizeTask).find(t => t.id === taskId);
    if (!task || task.status === colId) return;
    moveMut.mutate({ id: taskId, status: colId as any });
    toast.success(`Tarefa movida para ${STATUS_LABELS[colId]}`);
  }, [allTasks, moveMut]);


  // ─── MULTI-ASSIGNEE PICKER ───────────────────────────────────────────────
  function AssigneePicker() {
    return (
      <div>
        <Label className="mb-2 block">Responsáveis</Label>
        <div className="border rounded-lg max-h-40 overflow-y-auto p-2 space-y-1">
          {(employees as any[]).length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-2">Nenhum funcionário registado</p>
          )}
          {(employees as Array<{ id: number; fullName: string }>).map((emp) => {
            const checked = form.assigneeIds.includes(emp.id);
            return (
              <label key={emp.id} className="flex items-center gap-2 py-1 px-2 rounded hover:bg-muted/50 cursor-pointer">
                <Checkbox
                  checked={checked}
                  onCheckedChange={() => toggleAssignee(emp.id)}
                />
                <span className="text-sm">{emp.fullName}</span>
              </label>
            );
          })}
        </div>
        {form.assigneeIds.length > 0 && (
          <p className="text-xs text-muted-foreground mt-1">{form.assigneeIds.length} selecionado(s)</p>
        )}
      </div>
    );
  }

  // ─── TASK CARD (Kanban) ───────────────────────────────────────────────────
  function TaskCard({ task }: { task: Task }) {
    const colIdx = COLUMNS.findIndex(c => c.id === task.status);
    const canMoveLeft = colIdx > 0;
    const canMoveRight = colIdx >= 0 && colIdx < COLUMNS.length - 1;
    const move = (dir: -1 | 1) => {
      const target = COLUMNS[colIdx + dir]?.id;
      if (!target) return;
      moveMut.mutate({ id: task.id, status: target as any });
      toast.success(`Tarefa movida para ${STATUS_LABELS[target]}`);
    };
    return (
      <Card
        draggable
        onDragStart={(e) => handleDragStart(e, task.id)}
        onDragEnd={handleDragEnd}
        onClick={() => { if (canEdit) openEdit(task); }}
        className={`cursor-grab active:cursor-grabbing hover:shadow-md transition-all ${
          draggedTaskId === task.id ? "opacity-50 ring-2 ring-primary" : ""
        } ${isOverdue(task) ? "border-red-400 border-2" : ""}`}
      >
        <CardContent className="p-3 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              <GripVertical className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
              <p className="text-sm font-medium leading-tight truncate">{task.title}</p>
            </div>
            {canEdit && (
              <div className="flex gap-0.5 shrink-0">
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={(e) => { e.stopPropagation(); openEdit(task); }}>
                  <Pencil className="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={(e) => { e.stopPropagation(); if (confirm("Eliminar tarefa?")) deleteMut.mutate({ id: task.id }); }}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            )}
          </div>
          {task.description && <p className="text-xs text-muted-foreground line-clamp-2">{task.description}</p>}
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline" className={`text-xs ${PRIORITY_COLORS[task.priority]}`}>
              {PRIORITY_LABELS[task.priority]}
            </Badge>
            {task.projectName && <Badge variant="outline" className="text-xs">{task.projectName}</Badge>}
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            {renderAssignees(task)}
            {task.dueDate && (
              <span className={`flex items-center gap-1 ${isOverdue(task) ? "text-red-600 font-medium" : ""}`}>
                <CalendarDays className="h-3 w-3" />
                {fmtPTDate(task.dueDate)}
                {isOverdue(task) && <AlertTriangle className="h-3 w-3" />}
              </span>
            )}
          </div>
          <div className="flex items-center justify-between pt-1">
            <span className="text-[10px] text-muted-foreground">#{task.id}</span>
            {/* Setas = alternativa ao drag em ecrãs táteis (o drag HTML5 não existe em touch) */}
            <div className="flex gap-1">
              {canMoveLeft && (
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={(e) => { e.stopPropagation(); move(-1); }}>
                  <ChevronLeft className="w-3 h-3" />
                </Button>
              )}
              {canMoveRight && (
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={(e) => { e.stopPropagation(); move(1); }}>
                  <ChevronRight className="w-3 h-3" />
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const isAdmin = user && ["super_admin", "admin"].includes(user.role);
  // extra/user só consultam — criar/editar exige frontoffice+ (o servidor também valida)
  const canEdit = user && !["user", "extra"].includes(user.role);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <p className="text-muted-foreground text-sm">Quadro Kanban de tarefas</p>
        </div>
        <div className="flex gap-2 items-center">
          {/* View toggle */}
          <div className="flex border rounded-lg overflow-hidden">
            <Button
              variant={viewMode === "kanban" ? "default" : "ghost"}
              size="sm"
              className="rounded-none h-9"
              onClick={() => setViewMode("kanban")}
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === "list" ? "default" : "ghost"}
              size="sm"
              className="rounded-none h-9"
              onClick={() => setViewMode("list")}
            >
              <List className="h-4 w-4" />
            </Button>
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Pesquisar tarefa..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-8 h-9 w-56"
            />
          </div>
          <Select value={filterProject} onValueChange={setFilterProject}>
            <SelectTrigger className="w-56"><SelectValue placeholder="Centro de custos..." /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos (grupo / cidade / marca / projeto)</SelectItem>
              {sortProjectsHierarchical(projects as any[]).map((p: any) => (
                <SelectItem key={p.id} value={p.id.toString()}>
                  <span style={{ paddingLeft: `${p.__depth * 12}px` }} className="inline-flex items-center gap-2">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${LEVEL_COLOR[p.level] ?? ""}`}>
                      {LEVEL_LABEL[p.level] ?? p.level}
                    </span>
                    {p.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {isAdmin && (
            <Button variant="outline" size="sm" onClick={() => checkNotifMut.mutate()} disabled={checkNotifMut.isPending}>
              <Bell className="h-4 w-4 mr-1" />
              {checkNotifMut.isPending ? "A verificar..." : "Verificar Notificações"}
            </Button>
          )}
          {canEdit && (
            <Button onClick={() => { resetForm(); setShowCreate(true); }}><Plus className="h-4 w-4 mr-2" /> Nova Tarefa</Button>
          )}
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-3 md:grid-cols-7 gap-2">
          {[
            { label: "Total", value: stats.total, color: "text-slate-600" },
            { label: "Backlog", value: stats.backlog, color: "text-slate-500" },
            { label: "A Fazer", value: stats.todo, color: "text-blue-600" },
            { label: "Em Curso", value: stats.inProgress, color: "text-amber-600" },
            { label: "Revisão", value: stats.review, color: "text-purple-600" },
            { label: "Concluído", value: stats.done, color: "text-emerald-600" },
            { label: "Atrasadas", value: stats.overdue, color: "text-red-600" },
          ].map(s => (
            <Card key={s.label}>
              <CardContent className="py-2 px-3 text-center">
                <p className="text-xs text-muted-foreground">{s.label}</p>
                <p className={`text-lg font-bold ${s.color}`}>{s.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Kanban Board */}
      {viewMode === "kanban" && (isLoading ? (
        <div className="flex justify-center py-20"><div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" /></div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
          {COLUMNS.map(col => (
            <div
              key={col.id}
              className={`space-y-3 rounded-lg transition-colors ${
                dragOverCol === col.id ? "ring-2 ring-primary/60 bg-primary/5" : ""
              }`}
              onDragOver={(e) => handleDragOver(e, col.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, col.id)}
            >
              <div className={`flex items-center gap-2 p-2 rounded-lg ${col.pill} border`}>
                <col.icon className="w-4 h-4" />
                <span className="font-medium text-sm">{col.label}</span>
                <Badge variant="secondary" className="ml-auto text-xs">{grouped[col.id]?.length ?? 0}</Badge>
              </div>
              <ScrollArea className="max-h-[60vh]">
                <div className="space-y-2 pr-2">
                  {(grouped[col.id] ?? []).map(task => (
                    <TaskCard key={task.id} task={task} />
                  ))}
                  {(grouped[col.id]?.length ?? 0) === 0 && (
                    <p className="text-xs text-muted-foreground text-center py-8">Sem tarefas</p>
                  )}
                </div>
              </ScrollArea>
            </div>
          ))}
        </div>
      ))}

      {/* List View */}
      {viewMode === "list" && (
        <Card>
          <CardContent className="p-0">
            {filteredTasks.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <ListTodo className="h-12 w-12 text-muted-foreground/30 mb-4" />
                <p className="text-muted-foreground font-medium">Sem tarefas</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Título</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead>Prioridade</TableHead>
                      <TableHead>Projeto</TableHead>
                      <TableHead>Responsáveis</TableHead>
                      <TableHead>Data Limite</TableHead>
                      <TableHead className="text-right">Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredTasks.map(task => {
                      const col = COLUMNS.find(c => c.id === task.status);
                      return (
                        <TableRow key={task.id} className={`group ${isOverdue(task) ? "bg-red-50" : ""}`}>
                          <TableCell>
                            <div className="font-medium">{task.title}</div>
                            {task.description && (
                              <div className="text-xs text-muted-foreground truncate max-w-[250px]">{task.description}</div>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={`text-xs ${col?.pill ?? ""}`}>
                              {col?.label ?? task.status}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={`text-xs ${PRIORITY_COLORS[task.priority]}`}>
                              {PRIORITY_LABELS[task.priority]}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm">{task.projectName ?? "—"}</TableCell>
                          <TableCell className="text-sm">
                            {task.assignees.length === 0
                              ? "—"
                              : task.assignees.map(a => a.fullName).join(", ")}
                          </TableCell>
                          <TableCell className="text-sm">
                            {task.dueDate ? (
                              <span className={isOverdue(task) ? "text-red-600 font-medium" : ""}>
                                {fmtPTDate(task.dueDate)}
                                {isOverdue(task) && <AlertTriangle className="h-3 w-3 inline ml-1" />}
                              </span>
                            ) : "—"}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
                              <Select
                                value={task.status}
                                onValueChange={(v) => moveMut.mutate({ id: task.id, status: v as any })}
                              >
                                <SelectTrigger className="h-7 w-28 text-xs">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {COLUMNS.map(c => (
                                    <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(task)}>
                                <Pencil className="h-3 w-3" />
                              </Button>
                              <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => { if (confirm("Eliminar?")) deleteMut.mutate({ id: task.id }); }}>
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Create Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader><DialogTitle>Nova Tarefa</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Título</Label>
              <Input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="Título da tarefa..." />
            </div>
            <div>
              <Label>Descrição</Label>
              <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={2} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Centro de custos</Label>
                <Select value={form.projectId} onValueChange={v => setForm(f => ({ ...f, projectId: v }))}>
                  <SelectTrigger><SelectValue placeholder="Opcional..." /></SelectTrigger>
                  <SelectContent>
                    {sortProjectsHierarchical(projects as any[]).map((p: any) => (
                      <SelectItem key={p.id} value={p.id.toString()}>
                        <span style={{ paddingLeft: `${p.__depth * 12}px` }} className="inline-flex items-center gap-2">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${LEVEL_COLOR[p.level] ?? ""}`}>
                            {LEVEL_LABEL[p.level] ?? p.level}
                          </span>
                          {p.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Prioridade</Label>
                <Select value={form.priority} onValueChange={v => setForm(f => ({ ...f, priority: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Baixa</SelectItem>
                    <SelectItem value="medium">Média</SelectItem>
                    <SelectItem value="high">Alta</SelectItem>
                    <SelectItem value="urgent">Urgente</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Data Limite</Label>
              <Input type="date" value={form.dueDate} onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))} />
            </div>
            <AssigneePicker />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancelar</Button>
            <Button disabled={!form.title || createMut.isPending} onClick={() => createMut.mutate({
              title: form.title,
              description: form.description || undefined,
              projectId: form.projectId ? parseInt(form.projectId) : undefined,
              assigneeIds: form.assigneeIds.length > 0 ? form.assigneeIds : undefined,
              priority: form.priority as any,
              dueDate: form.dueDate || undefined,
            })}>
              Criar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editTask} onOpenChange={() => setEditTask(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Editar Tarefa</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Título</Label>
              <Input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
            </div>
            <div>
              <Label>Descrição</Label>
              <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={2} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Centro de custos</Label>
                <Select value={form.projectId} onValueChange={v => setForm(f => ({ ...f, projectId: v }))}>
                  <SelectTrigger><SelectValue placeholder="Opcional..." /></SelectTrigger>
                  <SelectContent>
                    {sortProjectsHierarchical(projects as any[]).map((p: any) => (
                      <SelectItem key={p.id} value={p.id.toString()}>
                        <span style={{ paddingLeft: `${p.__depth * 12}px` }} className="inline-flex items-center gap-2">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${LEVEL_COLOR[p.level] ?? ""}`}>
                            {LEVEL_LABEL[p.level] ?? p.level}
                          </span>
                          {p.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Prioridade</Label>
                <Select value={form.priority} onValueChange={v => setForm(f => ({ ...f, priority: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Baixa</SelectItem>
                    <SelectItem value="medium">Média</SelectItem>
                    <SelectItem value="high">Alta</SelectItem>
                    <SelectItem value="urgent">Urgente</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Data Limite</Label>
                <Input type="date" value={form.dueDate} onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))} />
              </div>
              <div>
                <Label>Estado</Label>
                <Select value={editTask?.status ?? "todo"} onValueChange={v => setEditTask(prev => prev ? { ...prev, status: v } : null)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {COLUMNS.map(c => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <AssigneePicker />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTask(null)}>Cancelar</Button>
            <Button disabled={!form.title || updateMut.isPending} onClick={() => editTask && updateMut.mutate({
              id: editTask.id,
              title: form.title,
              description: form.description || undefined,
              projectId: form.projectId ? parseInt(form.projectId) : null,
              assigneeIds: form.assigneeIds,
              priority: form.priority as any,
              status: editTask.status as any,
              dueDate: form.dueDate || null,
            })}>
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
