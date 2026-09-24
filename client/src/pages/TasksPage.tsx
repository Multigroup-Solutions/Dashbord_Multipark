import OpsBriefingCard from "@/components/aiOps/OpsBriefingCard";
import TasksFromTextDialog from "@/components/aiOps/TasksFromTextDialog";
import { useState, useMemo, useCallback, useEffect } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { fmtPTDateTime } from "@/lib/lisbonTime";
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
import { Switch } from "@/components/ui/switch";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import {
  ListTodo, Plus, Clock, AlertTriangle, CheckCircle2, Circle,
  ArrowUpCircle, Pencil, Trash2, CalendarDays, Users, LayoutGrid, List, GripVertical, Bell, Search,
  ChevronLeft, ChevronRight, User, Play, MessageSquare, Link2, Repeat, Loader2, RotateCcw, Sparkles,
} from "lucide-react";
import {
  TASK_SOURCE_LABELS,
  TASK_STATUS_LABELS,
  canEditTasks,
  isTaskOverdue,
  taskSourceLink,
  type TaskSourceModule,
  type TaskStatus,
} from "@shared/taskRules";
import { TaskTemplatesPanel } from "@/components/TaskTemplatesPanel";

const LEVEL_LABEL: Record<string, string> = {
  group: "Grupo", city: "Cidade", brand: "Marca", project: "Projeto",
};
const LEVEL_COLOR: Record<string, string> = {
  group: "bg-violet-100 text-violet-700 border-violet-200",
  city: "bg-blue-100 text-blue-700 border-blue-200",
  brand: "bg-emerald-100 text-emerald-700 border-emerald-200",
  project: "bg-amber-100 text-amber-700 border-amber-200",
};

export function sortProjectsHierarchical<T extends { id: number; name: string; parentId?: number | null; level?: string | null }>(
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

const COLUMNS: Array<{ id: TaskStatus; label: string; icon: any; pill: string }> = [
  { id: "backlog", label: TASK_STATUS_LABELS.backlog, icon: Circle, pill: "bg-slate-100 text-slate-800" },
  { id: "todo", label: TASK_STATUS_LABELS.todo, icon: ListTodo, pill: "bg-blue-100 text-blue-800" },
  { id: "in_progress", label: TASK_STATUS_LABELS.in_progress, icon: Clock, pill: "bg-amber-100 text-amber-800" },
  { id: "review", label: TASK_STATUS_LABELS.review, icon: ArrowUpCircle, pill: "bg-purple-100 text-purple-800" },
  { id: "done", label: TASK_STATUS_LABELS.done, icon: CheckCircle2, pill: "bg-emerald-100 text-emerald-800" },
];

const PRIORITY_COLORS: Record<string, string> = {
  low: "bg-slate-100 text-slate-700", medium: "bg-blue-100 text-blue-700",
  high: "bg-amber-100 text-amber-700", urgent: "bg-red-100 text-red-700",
};
const PRIORITY_LABELS: Record<string, string> = {
  low: "Baixa", medium: "Média", high: "Alta", urgent: "Urgente",
};

type Assignee = { id: number; fullName: string };
type Task = {
  id: number; title: string; description: string | null; projectId: number | null;
  projectName: string | null;
  assigneeId: number | null; assignees: Assignee[]; createdById: number;
  status: string; priority: string;
  dueDate: string | null; dueHasTime: number; completedAt: string | null;
  createdAt: string; updatedAt: string;
  sourceModule: string | null; sourceId: number | null; sourceKey: string | null;
  commentsCount: number;
};
function normalizeTask(t: any): Task {
  return {
    ...t,
    projectName: t.projectName ?? null,
    assignees: t.assignees ?? [],
    status: t.taskStatus ?? t.status ?? "todo",
    priority: t.taskPriority ?? t.priority ?? "medium",
    dueHasTime: Number(t.dueHasTime ?? 0),
    commentsCount: Number(t.commentsCount ?? 0),
  } as Task;
}

/** Data limite: só dia → dd/mm/aaaa (sem fuso); com hora → data e hora de Lisboa. */
function fmtDue(t: Task): string {
  if (!t.dueDate) return "";
  if (t.dueHasTime) return fmtPTDateTime(t.dueDate);
  const [y, m, d] = String(t.dueDate).slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

const overdue = (t: Task) => isTaskOverdue({ dueDate: t.dueDate, dueHasTime: t.dueHasTime, status: t.status }, Date.now());

function SourceChip({ t }: { t: Task }) {
  if (!t.sourceModule || t.sourceModule === "manual") return null;
  const label = TASK_SOURCE_LABELS[t.sourceModule as TaskSourceModule] ?? t.sourceModule;
  const href = taskSourceLink(t.sourceModule, t.sourceId, t.sourceKey);
  const chip = (
    <Badge variant="outline" className="text-xs gap-1 border-sky-300 text-sky-800">
      {t.sourceModule === "template" ? <Repeat className="h-3 w-3" /> : <Link2 className="h-3 w-3" />}
      {label}{t.sourceId && t.sourceModule !== "template" && t.sourceModule !== "availability" ? ` #${t.sourceId}` : ""}
    </Badge>
  );
  return href ? <Link href={href} onClick={(e) => e.stopPropagation()}>{chip}</Link> : chip;
}

type ViewMode = "mine" | "kanban" | "list" | "templates";

export default function TasksPage() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const [showFromText, setShowFromText] = useState(false);
  const canEdit = canEditTasks(user?.role);
  const isAdmin = !!user && ["super_admin", "admin"].includes(user.role);
  const canTemplates = !!user && ["super_admin", "admin", "supervisor"].includes(user.role);

  const [viewMode, setViewMode] = useState<ViewMode>(() => (canEditTasks((user as any)?.role) ? "kanban" : "mine"));
  // O utilizador pode chegar depois do 1.º render — extras ficam em "As minhas".
  useEffect(() => { if (user && !canEdit && viewMode !== "mine") setViewMode("mine"); }, [user, canEdit, viewMode]);

  const [filterProject, setFilterProject] = useState<string>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [showOld, setShowOld] = useState(false);
  const [focusId] = useState<number | null>(() => {
    const n = Number(new URLSearchParams(window.location.search).get("focus"));
    return Number.isInteger(n) && n > 0 ? n : null;
  });
  const [detailId, setDetailId] = useState<number | null>(focusId);

  const listInput = {
    projectId: filterProject !== "all" ? parseInt(filterProject) : undefined,
    mine: viewMode === "mine" ? true : undefined,
    showOld: showOld || undefined,
    focusId: focusId ?? undefined,
  };
  const { data: rawTasks = [], isLoading } = trpc.tasks.list.useQuery(listInput, { enabled: viewMode !== "templates" });
  const { data: stats } = trpc.tasks.stats.useQuery({ projectId: listInput.projectId, mine: listInput.mine });
  const { data: projects = [] } = trpc.projects.list.useQuery(undefined, { enabled: canEdit });

  const [showCreate, setShowCreate] = useState(false);
  const [editTask, setEditTask] = useState<Task | null>(null);
  const [form, setForm] = useState({
    title: "", description: "", projectId: "", assigneeIds: [] as number[], priority: "medium", dueDate: "",
  });
  const { data: assignable = [] } = trpc.tasks.assignable.useQuery(
    { projectId: form.projectId ? parseInt(form.projectId) : null },
    { enabled: canEdit && (showCreate || !!editTask) },
  );

  // Drag & Drop state
  const [draggedTaskId, setDraggedTaskId] = useState<number | null>(null);
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);

  const invalidate = () => { utils.tasks.list.invalidate(); utils.tasks.stats.invalidate(); utils.tasks.getById.invalidate(); };
  const createMut = trpc.tasks.create.useMutation({
    onSuccess: () => { invalidate(); setShowCreate(false); resetForm(); toast.success("Tarefa criada!"); },
    onError: (e) => toast.error(e.message),
  });
  const updateMut = trpc.tasks.update.useMutation({
    onSuccess: () => { invalidate(); setEditTask(null); toast.success("Tarefa atualizada!"); },
    onError: (e) => toast.error(e.message),
  });
  const deleteMut = trpc.tasks.delete.useMutation({
    onSuccess: () => { invalidate(); setDetailId(null); toast.success("Tarefa eliminada!"); },
    onError: (e) => toast.error(e.message),
  });
  // Mudança de estado (arrastar / setas / Começar / Concluir): permitida aos
  // responsáveis; optimistic update com rollback se o servidor recusar.
  const statusMut = trpc.tasks.setStatus.useMutation({
    onMutate: async (vars: { id: number; status: TaskStatus }) => {
      await utils.tasks.list.cancel();
      const prev = utils.tasks.list.getData(listInput);
      utils.tasks.list.setData(listInput, (old: any) => old?.map((t: any) => (t.id === vars.id ? { ...t, taskStatus: vars.status } : t)));
      return { prev };
    },
    onError: (e, _vars, ctx) => {
      if (ctx?.prev !== undefined) utils.tasks.list.setData(listInput, ctx.prev);
      toast.error(e.message || "Não foi possível mudar o estado");
    },
    onSettled: () => invalidate(),
  });
  const checkNotifMut = trpc.tasks.checkNotifications.useMutation({
    onSuccess: (data) => {
      if (data.notified > 0) toast.success(`${data.notified} notificação(ões) enviada(s)`);
      else toast.info("Nenhuma notificação pendente");
    },
    onError: (e) => toast.error(e.message),
  });

  function resetForm() {
    setForm({ title: "", description: "", projectId: "", assigneeIds: [], priority: "medium", dueDate: "" });
  }

  function openEdit(t: Task) {
    setEditTask(t);
    const ids = t.assignees.length > 0 ? t.assignees.map(a => a.id) : (t.assigneeId ? [t.assigneeId] : []);
    setForm({
      title: t.title,
      description: t.description ?? "",
      projectId: t.projectId?.toString() ?? "",
      assigneeIds: ids,
      priority: t.priority,
      dueDate: t.dueDate ? String(t.dueDate).slice(0, 10) : "",
    });
  }

  function toggleAssignee(empId: number) {
    setForm(f => ({
      ...f,
      assigneeIds: f.assigneeIds.includes(empId) ? f.assigneeIds.filter(id => id !== empId) : [...f.assigneeIds, empId],
    }));
  }

  const allTasks = useMemo(() => (rawTasks as any[]).map(normalizeTask), [rawTasks]);
  const filteredTasks = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return allTasks;
    return allTasks.filter(x =>
      x.title.toLowerCase().includes(q) ||
      (x.description ?? "").toLowerCase().includes(q) ||
      x.assignees.some(a => a.fullName.toLowerCase().includes(q)),
    );
  }, [allTasks, searchTerm]);

  const grouped = useMemo(() => {
    const map: Record<string, Task[]> = {};
    COLUMNS.forEach(c => { map[c.id] = []; });
    filteredTasks.forEach(t => { if (map[t.status]) map[t.status].push(t); });
    return map;
  }, [filteredTasks]);

  function renderAssignees(task: Task) {
    const list = task.assignees;
    if (list.length === 0) return null;
    const visible = list.slice(0, 2);
    const extra = list.length - visible.length;
    return (
      <span
        className="flex items-start gap-1 text-xs text-muted-foreground min-w-0"
        title={list.map(a => a.fullName).join(", ")}
      >
        <Users className="h-3 w-3 shrink-0 mt-0.5" aria-hidden />
        <span className="line-clamp-2 break-words min-w-0">{visible.map(a => a.fullName).join(", ")}</span>
        {extra > 0 && <span className="font-medium">+{extra}</span>}
      </span>
    );
  }

  // ─── DRAG & DROP (só quem edita) ──────────────────────────────────────────
  const handleDragStart = useCallback((e: React.DragEvent, taskId: number) => {
    setDraggedTaskId(taskId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(taskId));
  }, []);
  const handleDragEnd = useCallback(() => { setDraggedTaskId(null); setDragOverCol(null); }, []);
  const handleDragOver = useCallback((e: React.DragEvent, colId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverCol(colId);
  }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverCol(null);
  }, []);
  const handleDrop = useCallback((e: React.DragEvent, colId: TaskStatus) => {
    e.preventDefault();
    setDragOverCol(null);
    const taskId = parseInt(e.dataTransfer.getData("text/plain"));
    if (isNaN(taskId)) return;
    const task = allTasks.find(t => t.id === taskId);
    if (!task || task.status === colId) return;
    statusMut.mutate({ id: taskId, status: colId });
    toast.success(`Tarefa movida para ${TASK_STATUS_LABELS[colId]}`);
  }, [allTasks, statusMut]);

  // ─── MULTI-ASSIGNEE PICKER (filtrado pelo âmbito de cidade / projeto) ─────
  function AssigneePicker() {
    const list = assignable as Array<{ id: number; fullName: string }>;
    const known = new Set(list.map((e) => e.id));
    const extraSelected = form.assigneeIds.filter((id) => !known.has(id));
    return (
      <div>
        <Label className="mb-2 block">Responsáveis</Label>
        <div className="border rounded-lg max-h-40 overflow-y-auto p-2 space-y-1">
          {list.length === 0 && <p className="text-xs text-muted-foreground text-center py-2">Nenhum funcionário no âmbito</p>}
          {list.map((emp) => (
            <label key={emp.id} className="flex items-center gap-2 py-1 px-2 rounded hover:bg-muted/50 cursor-pointer">
              <Checkbox checked={form.assigneeIds.includes(emp.id)} onCheckedChange={() => toggleAssignee(emp.id)} />
              <span className="text-sm">{emp.fullName}</span>
            </label>
          ))}
        </div>
        {form.assigneeIds.length > 0 && (
          <p className="text-xs text-muted-foreground mt-1">
            {form.assigneeIds.length} selecionado(s){extraSelected.length ? ` (${extraSelected.length} fora do filtro atual)` : ""}
          </p>
        )}
      </div>
    );
  }

  // ─── TASK CARD (quadro) ───────────────────────────────────────────────────
  function TaskCard({ task }: { task: Task }) {
    const colIdx = COLUMNS.findIndex(c => c.id === task.status);
    const move = (dir: -1 | 1) => {
      const target = COLUMNS[colIdx + dir]?.id;
      if (!target) return;
      statusMut.mutate({ id: task.id, status: target });
    };
    return (
      <Card
        draggable={canEdit}
        onDragStart={canEdit ? (e) => handleDragStart(e, task.id) : undefined}
        onDragEnd={canEdit ? handleDragEnd : undefined}
        onClick={() => setDetailId(task.id)}
        className={`${canEdit ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"} hover:shadow-md transition-all ${
          draggedTaskId === task.id ? "opacity-50 ring-2 ring-primary" : ""
        } ${overdue(task) ? "border-red-400 border-2" : ""} ${focusId === task.id ? "ring-2 ring-sky-400" : ""}`}
      >
        <CardContent className="p-3 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-1.5 flex-1 min-w-0">
              {canEdit && <GripVertical className="h-3.5 w-3.5 mt-0.5 text-muted-foreground/40 shrink-0" aria-hidden />}
              <p className="text-sm font-medium leading-snug line-clamp-2 break-words" title={task.title}>{task.title}</p>
            </div>
            {canEdit && (
              <div className="flex gap-0.5 shrink-0">
                <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Editar tarefa" title="Editar" onClick={(e) => { e.stopPropagation(); openEdit(task); }}>
                  <Pencil className="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" aria-label="Eliminar tarefa" title="Eliminar" onClick={(e) => { e.stopPropagation(); if (confirm("Eliminar tarefa?")) deleteMut.mutate({ id: task.id }); }}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            )}
          </div>
          {task.description && <p className="text-xs text-muted-foreground line-clamp-2">{task.description}</p>}
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline" className={`text-xs ${PRIORITY_COLORS[task.priority]}`}>{PRIORITY_LABELS[task.priority]}</Badge>
            {task.projectName && <Badge variant="outline" className="text-xs truncate" title={task.projectName}>{task.projectName}</Badge>}
            <SourceChip t={task} />
          </div>
          <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {renderAssignees(task)}
            {task.dueDate && (
              <span className={`flex items-center gap-1 shrink-0 whitespace-nowrap tabular-nums ${overdue(task) ? "text-red-600 font-medium" : ""}`}>
                <CalendarDays className="h-3 w-3" />
                {fmtDue(task)}
                {overdue(task) && <AlertTriangle className="h-3 w-3" />}
              </span>
            )}
          </div>
          <div className="flex items-center justify-between pt-1">
            <span className="text-[11px] text-muted-foreground flex items-center gap-2">
              #{task.id}
              {task.commentsCount > 0 && <span className="flex items-center gap-0.5"><MessageSquare className="h-3 w-3" />{task.commentsCount}</span>}
            </span>
            {canEdit && (
              <div className="flex gap-1">
                {colIdx > 0 && (
                  <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Mover para a coluna anterior" onClick={(e) => { e.stopPropagation(); move(-1); }}>
                    <ChevronLeft className="w-3 h-3" />
                  </Button>
                )}
                {colIdx >= 0 && colIdx < COLUMNS.length - 1 && (
                  <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Mover para a coluna seguinte" onClick={(e) => { e.stopPropagation(); move(1); }}>
                    <ChevronRight className="w-3 h-3" />
                  </Button>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  // ─── "As minhas tarefas" (telemóvel: cartões e botões grandes) ────────────
  function MyTaskCard({ task }: { task: Task }) {
    const done = task.status === "done";
    return (
      <Card className={`${overdue(task) ? "border-red-400 border-2" : ""} ${focusId === task.id ? "ring-2 ring-sky-400" : ""}`}>
        <CardContent className="p-4 space-y-3">
          <button type="button" className="text-left w-full" onClick={() => setDetailId(task.id)}>
            <div className="flex items-start justify-between gap-2">
              <p className={`font-medium leading-snug ${done ? "line-through text-muted-foreground" : ""}`}>{task.title}</p>
              <Badge variant="outline" className={`text-xs shrink-0 ${COLUMNS.find(c => c.id === task.status)?.pill ?? ""}`}>{TASK_STATUS_LABELS[task.status as TaskStatus] ?? task.status}</Badge>
            </div>
            {task.description && <p className="text-sm text-muted-foreground line-clamp-3 mt-1 whitespace-pre-line">{task.description}</p>}
            <div className="flex flex-wrap items-center gap-2 mt-2 text-xs text-muted-foreground">
              {task.dueDate && (
                <span className={`flex items-center gap-1 ${overdue(task) ? "text-red-600 font-medium" : ""}`}>
                  <CalendarDays className="h-3.5 w-3.5" />{fmtDue(task)}{overdue(task) && " · em atraso"}
                </span>
              )}
              {task.projectName && <span>{task.projectName}</span>}
              {task.commentsCount > 0 && <span className="flex items-center gap-0.5"><MessageSquare className="h-3.5 w-3.5" />{task.commentsCount}</span>}
              <SourceChip t={task} />
            </div>
          </button>
          <div className="flex gap-2">
            {!done && task.status !== "in_progress" && (
              <Button className="flex-1 h-12 text-base" variant="outline" disabled={statusMut.isPending} onClick={() => statusMut.mutate({ id: task.id, status: "in_progress" })}>
                <Play className="h-5 w-5 mr-2" />Começar
              </Button>
            )}
            {!done && (
              <Button className="flex-1 h-12 text-base bg-emerald-700 hover:bg-emerald-800" disabled={statusMut.isPending} onClick={() => statusMut.mutate({ id: task.id, status: "done" })}>
                <CheckCircle2 className="h-5 w-5 mr-2" />Concluir
              </Button>
            )}
            {done && (
              <Button className="flex-1 h-12" variant="ghost" disabled={statusMut.isPending} onClick={() => statusMut.mutate({ id: task.id, status: "todo" })}>
                <RotateCcw className="h-4 w-4 mr-2" />Reabrir
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  const myOpen = filteredTasks.filter((t) => t.status !== "done");
  const myDone = filteredTasks.filter((t) => t.status === "done");

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="shrink-0">
          <p className="text-muted-foreground text-sm">
            {viewMode === "mine" ? "As tuas tarefas — carrega em Começar / Concluir" : viewMode === "templates" ? "Checklists recorrentes por turno e cidade" : "Quadro de tarefas"}
          </p>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          <div className="flex border rounded-lg overflow-hidden">
            <Button variant={viewMode === "mine" ? "default" : "ghost"} size="sm" className="rounded-none h-9" onClick={() => setViewMode("mine")} title="As minhas tarefas">
              <User className="h-4 w-4 sm:mr-1" /><span className="hidden sm:inline">As minhas</span>
            </Button>
            {canEdit && (
              <>
                <Button variant={viewMode === "kanban" ? "default" : "ghost"} size="sm" className="rounded-none h-9" onClick={() => setViewMode("kanban")} title="Quadro">
                  <LayoutGrid className="h-4 w-4" />
                </Button>
                <Button variant={viewMode === "list" ? "default" : "ghost"} size="sm" className="rounded-none h-9" onClick={() => setViewMode("list")} title="Lista">
                  <List className="h-4 w-4" />
                </Button>
              </>
            )}
            {canTemplates && (
              <Button variant={viewMode === "templates" ? "default" : "ghost"} size="sm" className="rounded-none h-9" onClick={() => setViewMode("templates")} title="Checklists recorrentes">
                <Repeat className="h-4 w-4 sm:mr-1" /><span className="hidden sm:inline">Checklists</span>
              </Button>
            )}
          </div>
          {viewMode !== "templates" && (
            <>
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input placeholder="Pesquisar tarefa..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="pl-8 h-9 w-48 sm:w-56" />
              </div>
              {canEdit && (
                <Select value={filterProject} onValueChange={setFilterProject}>
                  <SelectTrigger className="w-56"><SelectValue placeholder="Centro de custos..." /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos (grupo / cidade / marca / projeto)</SelectItem>
                    {sortProjectsHierarchical(projects as any[]).map((p: any) => (
                      <SelectItem key={p.id} value={p.id.toString()}>
                        <span style={{ paddingLeft: `${p.__depth * 12}px` }} className="inline-flex items-center gap-2">
                          <span className={`text-[11px] px-1.5 py-0.5 rounded border ${LEVEL_COLOR[p.level] ?? ""}`}>{LEVEL_LABEL[p.level] ?? p.level}</span>
                          {p.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <Switch checked={showOld} onCheckedChange={setShowOld} />Mostrar antigas
              </label>
            </>
          )}
          {isAdmin && viewMode !== "templates" && (
            <Button variant="outline" size="sm" onClick={() => checkNotifMut.mutate()} disabled={checkNotifMut.isPending} title="Os avisos de atraso/conclusão correm de hora a hora; isto corre-os já.">
              <Bell className="h-4 w-4 mr-1" />
              {checkNotifMut.isPending ? "A verificar..." : "Verificar agora"}
            </Button>
          )}
          {canEdit && viewMode !== "templates" && (
            <Button variant="outline" onClick={() => setShowFromText(true)} title="Cola notas ou uma passagem de turno; a IA propõe tarefas e tu confirmas">
              <Sparkles className="h-4 w-4 mr-2" /> Criar tarefas a partir de texto
            </Button>
          )}
          {canEdit && viewMode !== "templates" && (
            <Button onClick={() => { resetForm(); setShowCreate(true); }}><Plus className="h-4 w-4 mr-2" /> Nova Tarefa</Button>
          )}
        </div>
      </div>

      {viewMode !== "templates" && <OpsBriefingCard />}
      {canEdit && (
        <TasksFromTextDialog open={showFromText} onOpenChange={setShowFromText}
          projectId={filterProject !== "all" ? parseInt(filterProject) : null} onCreated={invalidate} />
      )}

      {viewMode === "templates" && canTemplates && <TaskTemplatesPanel projects={projects as any[]} />}

      {/* Stats */}
      {stats && viewMode !== "templates" && (
        <div className="grid grid-cols-3 md:grid-cols-7 gap-2">
          {[
            { label: "Total", value: stats.total, color: "text-slate-700" },
            { label: TASK_STATUS_LABELS.backlog, value: stats.backlog, color: "text-slate-600" },
            { label: TASK_STATUS_LABELS.todo, value: stats.todo, color: "text-blue-600" },
            { label: TASK_STATUS_LABELS.in_progress, value: stats.inProgress, color: "text-amber-700" },
            { label: TASK_STATUS_LABELS.review, value: stats.review, color: "text-purple-600" },
            { label: TASK_STATUS_LABELS.done, value: stats.done, color: "text-emerald-700" },
            { label: "Em atraso", value: stats.overdue, color: "text-red-600" },
          ].map(s => (
            <Card key={s.label}>
              <CardContent className="py-2 px-2 sm:px-3 text-center">
                <p className="text-xs text-muted-foreground truncate" title={s.label}>{s.label}</p>
                <p className={`text-lg font-bold tabular-nums ${s.color}`}>{s.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* As minhas tarefas */}
      {viewMode === "mine" && (isLoading ? (
        <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="space-y-3 max-w-2xl">
          {myOpen.length === 0 && (
            <Card><CardContent className="py-10 text-center text-muted-foreground"><CheckCircle2 className="h-10 w-10 mx-auto mb-2 text-emerald-500/60" />Sem tarefas por fazer.</CardContent></Card>
          )}
          {myOpen.map((t) => <MyTaskCard key={t.id} task={t} />)}
          {myDone.length > 0 && (
            <details className="pt-2">
              <summary className="text-sm text-muted-foreground cursor-pointer select-none">Concluídas ({myDone.length})</summary>
              <div className="space-y-3 mt-3">{myDone.map((t) => <MyTaskCard key={t.id} task={t} />)}</div>
            </details>
          )}
        </div>
      ))}

      {/* Quadro */}
      {viewMode === "kanban" && (isLoading ? (
        <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
          {COLUMNS.map(col => (
            <div
              key={col.id}
              className={`space-y-3 rounded-lg transition-colors ${dragOverCol === col.id ? "ring-2 ring-primary/60 bg-primary/5" : ""}`}
              onDragOver={canEdit ? (e) => handleDragOver(e, col.id) : undefined}
              onDragLeave={canEdit ? handleDragLeave : undefined}
              onDrop={canEdit ? (e) => handleDrop(e, col.id) : undefined}
            >
              <div className={`flex items-center gap-2 p-2 rounded-lg ${col.pill} border`}>
                <col.icon className="w-4 h-4" />
                <span className="font-medium text-sm">{col.label}</span>
                <Badge variant="secondary" className="ml-auto text-xs">{grouped[col.id]?.length ?? 0}</Badge>
              </div>
              <div className="max-h-[60vh] overflow-y-auto">
                <div className="space-y-2 pr-2">
                  {(grouped[col.id] ?? []).map(task => <TaskCard key={task.id} task={task} />)}
                  {(grouped[col.id]?.length ?? 0) === 0 && <p className="text-xs text-muted-foreground text-center py-8">Sem tarefas</p>}
                </div>
              </div>
            </div>
          ))}
        </div>
      ))}

      {/* Lista */}
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
                      <TableHead>Data limite</TableHead>
                      <TableHead className="text-right">Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredTasks.map(task => (
                      <TableRow key={task.id} className={`group cursor-pointer ${overdue(task) ? "bg-red-50" : ""}`} onClick={() => setDetailId(task.id)}>
                        <TableCell>
                          <div className="font-medium flex items-center gap-2">{task.title} <SourceChip t={task} /></div>
                          {task.description && <div className="text-xs text-muted-foreground truncate max-w-[250px]">{task.description}</div>}
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <Select value={task.status} onValueChange={(v) => statusMut.mutate({ id: task.id, status: v as TaskStatus })}>
                            <SelectTrigger className="h-7 w-32 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>{COLUMNS.map(c => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}</SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`text-xs ${PRIORITY_COLORS[task.priority]}`}>{PRIORITY_LABELS[task.priority]}</Badge>
                        </TableCell>
                        <TableCell className="text-sm">{task.projectName ?? "—"}</TableCell>
                        <TableCell className="text-sm">{task.assignees.length === 0 ? "—" : task.assignees.map(a => a.fullName).join(", ")}</TableCell>
                        <TableCell className="text-sm">
                          {task.dueDate ? (
                            <span className={overdue(task) ? "text-red-600 font-medium" : ""}>
                              {fmtDue(task)}{overdue(task) && <AlertTriangle className="h-3 w-3 inline ml-1" />}
                            </span>
                          ) : "—"}
                        </TableCell>
                        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(task)}><Pencil className="h-3 w-3" /></Button>
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => { if (confirm("Eliminar?")) deleteMut.mutate({ id: task.id }); }}><Trash2 className="h-3 w-3" /></Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Detalhe (todos): estado, origem e comentários */}
      <TaskDetailDialog
        id={detailId}
        onClose={() => setDetailId(null)}
        canEdit={canEdit}
        onEdit={(t) => { setDetailId(null); openEdit(t); }}
        onStatus={(id, status) => statusMut.mutate({ id, status })}
        statusPending={statusMut.isPending}
      />

      {/* Criar / Editar */}
      {[{ open: showCreate, isEdit: false }, { open: !!editTask, isEdit: true }].map(({ open, isEdit }) => (
        <Dialog key={isEdit ? "edit" : "create"} open={open} onOpenChange={(o) => { if (!o) { if (isEdit) setEditTask(null); else setShowCreate(false); } }}>
          <DialogContent>
            <DialogHeader><DialogTitle>{isEdit ? "Editar tarefa" : "Nova tarefa"}</DialogTitle></DialogHeader>
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
                            <span className={`text-[11px] px-1.5 py-0.5 rounded border ${LEVEL_COLOR[p.level] ?? ""}`}>{LEVEL_LABEL[p.level] ?? p.level}</span>
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
                      {Object.entries(PRIORITY_LABELS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Data limite</Label>
                  <Input type="date" value={form.dueDate} onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))} />
                  <p className="text-[11px] text-muted-foreground mt-0.5">Fica em atraso no fim desse dia (Lisboa).</p>
                </div>
                {isEdit && (
                  <div>
                    <Label>Estado</Label>
                    <Select value={editTask?.status ?? "todo"} onValueChange={v => setEditTask(prev => prev ? { ...prev, status: v } : null)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>{COLUMNS.map(c => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                )}
              </div>
              <AssigneePicker />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => (isEdit ? setEditTask(null) : setShowCreate(false))}>Cancelar</Button>
              {isEdit ? (
                <Button disabled={!form.title || updateMut.isPending} onClick={() => editTask && updateMut.mutate({
                  id: editTask.id,
                  title: form.title,
                  description: form.description || undefined,
                  projectId: form.projectId ? parseInt(form.projectId) : null,
                  assigneeIds: form.assigneeIds,
                  priority: form.priority as any,
                  status: editTask.status as TaskStatus,
                  dueDate: form.dueDate || null,
                })}>Guardar</Button>
              ) : (
                <Button disabled={!form.title || createMut.isPending} onClick={() => createMut.mutate({
                  title: form.title,
                  description: form.description || undefined,
                  projectId: form.projectId ? parseInt(form.projectId) : undefined,
                  assigneeIds: form.assigneeIds.length > 0 ? form.assigneeIds : undefined,
                  priority: form.priority as any,
                  dueDate: form.dueDate || undefined,
                })}>Criar</Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ))}
    </div>
  );
}

// ─── Detalhe da tarefa + comentários ────────────────────────────────────────

function TaskDetailDialog({ id, onClose, canEdit, onEdit, onStatus, statusPending }: {
  id: number | null;
  onClose: () => void;
  canEdit: boolean;
  onEdit: (t: Task) => void;
  onStatus: (id: number, status: TaskStatus) => void;
  statusPending: boolean;
}) {
  const utils = trpc.useUtils();
  const q = trpc.tasks.getById.useQuery({ id: id ?? 0 }, { enabled: id != null, retry: false });
  const comments = trpc.tasks.comments.useQuery({ taskId: id ?? 0 }, { enabled: id != null && q.isSuccess });
  const [body, setBody] = useState("");
  const add = trpc.tasks.addComment.useMutation({
    onSuccess: () => { setBody(""); comments.refetch(); utils.tasks.list.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const t = q.data ? normalizeTask(q.data) : null;
  return (
    <Dialog open={id != null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        {q.isLoading ? (
          <div className="py-10 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : q.error ? (
          <p className="text-sm text-red-600 py-6">{q.error.message}</p>
        ) : t ? (
          <>
            <DialogHeader><DialogTitle className="pr-6">{t.title}</DialogTitle></DialogHeader>
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="outline" className={COLUMNS.find(c => c.id === t.status)?.pill}>{TASK_STATUS_LABELS[t.status as TaskStatus] ?? t.status}</Badge>
                <Badge variant="outline" className={PRIORITY_COLORS[t.priority]}>{PRIORITY_LABELS[t.priority]}</Badge>
                {t.projectName && <Badge variant="outline">{t.projectName}</Badge>}
                <SourceChip t={t} />
                {t.dueDate && <Badge variant="outline" className={overdue(t) ? "border-red-300 text-red-700" : ""}><CalendarDays className="h-3 w-3 mr-1" />{fmtDue(t)}{overdue(t) ? " · em atraso" : ""}</Badge>}
              </div>
              {t.description && <p className="whitespace-pre-line text-muted-foreground">{t.description}</p>}
              <p className="text-xs text-muted-foreground"><Users className="h-3 w-3 inline mr-1" />{t.assignees.map((a) => a.fullName).join(", ") || "Sem responsável"}</p>
              <div className="flex gap-2 flex-wrap">
                {t.status !== "done" && t.status !== "in_progress" && (
                  <Button size="sm" variant="outline" disabled={statusPending} onClick={() => onStatus(t.id, "in_progress")}><Play className="h-4 w-4 mr-1" />Começar</Button>
                )}
                {t.status !== "done" && (
                  <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800" disabled={statusPending} onClick={() => onStatus(t.id, "done")}><CheckCircle2 className="h-4 w-4 mr-1" />Concluir</Button>
                )}
                {t.status === "done" && (
                  <Button size="sm" variant="ghost" disabled={statusPending} onClick={() => onStatus(t.id, "todo")}><RotateCcw className="h-4 w-4 mr-1" />Reabrir</Button>
                )}
                {canEdit && <Button size="sm" variant="ghost" onClick={() => onEdit(t)}><Pencil className="h-4 w-4 mr-1" />Editar</Button>}
              </div>

              <div className="border-t pt-3 space-y-2">
                <p className="font-medium flex items-center gap-1"><MessageSquare className="h-4 w-4" />Comentários</p>
                {(comments.data ?? []).length === 0 && <p className="text-xs text-muted-foreground">Sem comentários.</p>}
                {(comments.data ?? []).map((c: any) => (
                  <div key={c.id} className="rounded-md bg-muted/50 p-2">
                    <p className="text-[11px] text-muted-foreground">{c.userName ?? "—"} · {fmtPTDateTime(c.createdAt)}</p>
                    <p className="whitespace-pre-line">{c.body}</p>
                  </div>
                ))}
                <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} placeholder="Escreve um comentário…" />
                <div className="flex justify-end">
                  <Button size="sm" disabled={!body.trim() || add.isPending} onClick={() => add.mutate({ taskId: t.id, body })}>
                    {add.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Comentar
                  </Button>
                </div>
              </div>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
