import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import {
  FolderTree, Plus, ChevronRight, ChevronDown, Users, Pencil, Trash2,
  Building2, Tag, MapPin, FolderKanban, UserPlus, X, Euro, Handshake
} from "lucide-react";
import { useLocation } from "wouter";

const LEVEL_LABELS: Record<string, string> = {
  group: "Grupo", city: "Cidade", brand: "Marca", project: "Projeto",
};
const LEVEL_ICONS: Record<string, any> = {
  group: Building2, city: MapPin, brand: Tag, project: FolderKanban,
};
const LEVEL_COLORS: Record<string, string> = {
  group: "bg-indigo-100 text-indigo-800", city: "bg-emerald-100 text-emerald-800",
  brand: "bg-amber-100 text-amber-800", project: "bg-sky-100 text-sky-800",
};
const CHILD_LEVEL: Record<string, string> = {
  group: "city", city: "brand", brand: "project",
};

type Project = {
  id: number; name: string; description: string | null; parentId: number | null;
  level: string; color: string | null; managerId: number | null; isActive: boolean | number;
  budget: string | null; partnerName: string | null; partnerPercent: string | null;
  createdAt: string | Date; updatedAt: string | Date;
};

function buildTree(projects: Project[], parentId: number | null = null): (Project & { children: any[] })[] {
  return projects
    .filter(p => p.parentId === parentId)
    .map(p => ({ ...p, children: buildTree(projects, p.id) }));
}

export default function ProjectsPage() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const { data: allProjects = [], isLoading } = trpc.projects.list.useQuery();
  const { data: employees = [] } = trpc.rh.list.useQuery();
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [showCreate, setShowCreate] = useState(false);
  const [createParentId, setCreateParentId] = useState<number | null>(null);
  const [createLevel, setCreateLevel] = useState("group");
  const [editProject, setEditProject] = useState<Project | null>(null);
  const [showAssign, setShowAssign] = useState<number | null>(null);
  const [form, setForm] = useState({ name: "", description: "", color: "#1E5BFF", managerId: "", budget: "", partnerName: "", partnerPercent: "" });
  const { data: usersList = [] } = trpc.users.list.useQuery();

  const createMut = trpc.projects.create.useMutation({
    onSuccess: () => { utils.projects.list.invalidate(); setShowCreate(false); resetForm(); toast.success("Projeto criado!"); },
    onError: (e) => toast.error(e.message),
  });
  const updateMut = trpc.projects.update.useMutation({
    onSuccess: () => { utils.projects.list.invalidate(); setEditProject(null); toast.success("Projeto atualizado!"); },
    onError: (e) => toast.error(e.message),
  });
  const deleteMut = trpc.projects.delete.useMutation({
    onSuccess: () => { utils.projects.list.invalidate(); toast.success("Projeto eliminado!"); },
    onError: (e) => toast.error(e.message),
  });
  const assignMut = trpc.projects.assignEmployee.useMutation({
    onSuccess: () => { utils.projects.getEmployees.invalidate(); toast.success("Colaborador atribuído!"); },
    onError: (e) => toast.error(e.message),
  });
  const removeMut = trpc.projects.removeEmployee.useMutation({
    onSuccess: () => { utils.projects.getEmployees.invalidate(); toast.success("Colaborador removido!"); },
    onError: (e) => toast.error(e.message),
  });

  const tree = useMemo(() => buildTree(allProjects as Project[]), [allProjects]);

  function resetForm() {
    setForm({ name: "", description: "", color: "#1E5BFF", managerId: "", budget: "", partnerName: "", partnerPercent: "" });
  }

  function toggleExpand(id: number) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function openCreate(parentId: number | null, level: string) {
    setCreateParentId(parentId);
    setCreateLevel(level);
    resetForm();
    setShowCreate(true);
  }

  function openEdit(p: Project) {
    setEditProject(p);
    setForm({ name: p.name, description: p.description ?? "", color: p.color ?? "#1E5BFF", managerId: p.managerId?.toString() ?? "", budget: (p as any).budget ?? "", partnerName: (p as any).partnerName ?? "", partnerPercent: (p as any).partnerPercent ?? "" });
  }

  function getManagerName(managerId: number | null) {
    if (!managerId) return null;
    const u = usersList.find((u: any) => u.id === managerId);
    return u ? (u as any).name : null;
  }

  const isAdmin = user && ["super_admin", "admin"].includes(user.role);

  function TreeNode({ node, depth = 0 }: { node: Project & { children: any[] }; depth?: number }) {
    const isOpen = expanded.has(node.id);
    const hasChildren = node.children.length > 0;
    const Icon = LEVEL_ICONS[node.level] || FolderKanban;
    const childLevel = CHILD_LEVEL[node.level];

    return (
      <div>
        <div
          className={`flex items-center gap-2 py-2 px-3 rounded-lg hover:bg-muted/50 cursor-pointer transition-colors group`}
          style={{ paddingLeft: `${depth * 24 + 12}px` }}
          onClick={() => hasChildren && toggleExpand(node.id)}
        >
          {hasChildren ? (
            isOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
          ) : (
            <span className="w-4 shrink-0" />
          )}
          <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: node.color ?? "#1E5BFF" }} />
          <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="font-medium text-sm flex-1">{node.name}</span>
          {node.managerId && getManagerName(node.managerId) && (
            <span className="text-xs text-muted-foreground">Resp: {getManagerName(node.managerId)}</span>
          )}
          {node.partnerName && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Handshake className="h-3 w-3" /> {node.partnerName} ({node.partnerPercent}%)
            </span>
          )}
          {node.budget && (
            <span className="text-xs font-mono text-emerald-600">€{parseFloat(node.budget).toLocaleString("pt-PT")}</span>
          )}
          <Badge variant="outline" className={`text-xs ${LEVEL_COLORS[node.level] ?? ""}`}>
            {LEVEL_LABELS[node.level] ?? node.level}
          </Badge>
          {!node.isActive && <Badge variant="secondary" className="text-xs">Inativo</Badge>}
          {isAdmin && (
            <div className="opacity-0 group-hover:opacity-100 flex gap-1 transition-opacity">
              {childLevel && (
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={(e) => { e.stopPropagation(); openCreate(node.id, childLevel); }}>
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              )}
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={(e) => { e.stopPropagation(); setShowAssign(node.id); }}>
                <UserPlus className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={(e) => { e.stopPropagation(); openEdit(node); }}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={(e) => { e.stopPropagation(); if (confirm("Eliminar este projeto e todos os sub-projetos?")) deleteMut.mutate({ id: node.id }); }}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </div>
        {isOpen && node.children.map((child: any) => (
          <TreeNode key={child.id} node={child} depth={depth + 1} />
        ))}
      </div>
    );
  }

  function AssignDialog() {
    const { data: assigned = [] } = trpc.projects.getEmployees.useQuery(
      { projectId: showAssign! },
      { enabled: !!showAssign }
    );
    const [selectedEmp, setSelectedEmp] = useState("");
    const assignedIds = new Set(assigned.map((a: any) => a.employeeId));
    const available = employees.filter((e: any) => !assignedIds.has((e.employee ?? e).id));

    return (
      <Dialog open={!!showAssign} onOpenChange={() => setShowAssign(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Users className="h-5 w-5" /> Colaboradores do Projeto</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {assigned.length > 0 ? (
              <div className="space-y-2">
                {assigned.map((a: any) => {
                  const empRow = employees.find((e: any) => (e as any).employee ? (e as any).employee.id === a.employeeId : (e as any).id === a.employeeId);
                  const emp = empRow ? ((empRow as any).employee ?? empRow) : null;
                  return (
                    <div key={a.id} className="flex items-center justify-between py-1.5 px-3 bg-muted/50 rounded-md">
                      <span className="text-sm">{emp ? emp.fullName : `#${a.employeeId}`}</span>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => removeMut.mutate({ projectId: showAssign!, employeeId: a.employeeId })}>
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-4">Nenhum colaborador atribuído.</p>
            )}
            {available.length > 0 && (
              <div className="flex gap-2">
                <Select value={selectedEmp} onValueChange={setSelectedEmp}>
                  <SelectTrigger className="flex-1"><SelectValue placeholder="Selecionar colaborador..." /></SelectTrigger>
                  <SelectContent>
                    {available.map((e: any) => {
                      const emp = e.employee ?? e;
                      return <SelectItem key={emp.id} value={emp.id.toString()}>{emp.fullName}</SelectItem>;
                    })}
                  </SelectContent>
                </Select>
                <Button
                  disabled={!selectedEmp || assignMut.isPending}
                  onClick={() => {
                    assignMut.mutate({ projectId: showAssign!, employeeId: parseInt(selectedEmp) });
                    setSelectedEmp("");
                  }}
                >
                  <UserPlus className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // Stats
  const stats = useMemo(() => {
    const p = allProjects as Project[];
    return {
      groups: p.filter(x => x.level === "group").length,
      brands: p.filter(x => x.level === "brand").length,
      cities: p.filter(x => x.level === "city").length,
      projects: p.filter(x => x.level === "project").length,
      total: p.length,
    };
  }, [allProjects]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-muted-foreground text-sm">Estrutura organizacional em árvore</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setLocation("/projetos/custos")}>
            <Euro className="h-4 w-4 mr-2" /> Custos
          </Button>
          {isAdmin && (
            <Button onClick={() => openCreate(null, "group")}><Plus className="h-4 w-4 mr-2" /> Novo Grupo</Button>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label: "Grupos", value: stats.groups, icon: Building2, color: "text-indigo-600" },
          { label: "Cidades", value: stats.cities, icon: MapPin, color: "text-emerald-600" },
          { label: "Marcas", value: stats.brands, icon: Tag, color: "text-amber-600" },
          { label: "Projetos", value: stats.projects, icon: FolderKanban, color: "text-sky-600" },
          { label: "Total", value: stats.total, icon: FolderTree, color: "text-slate-600" },
        ].map(s => (
          <Card key={s.label}>
            <CardContent className="py-3 px-4 flex items-center gap-3">
              <s.icon className={`h-5 w-5 ${s.color}`} />
              <div>
                <p className="text-xs text-muted-foreground">{s.label}</p>
                <p className="text-lg font-bold">{s.value}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Tree */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Árvore de Projetos</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground py-8 text-center">A carregar...</p>
          ) : tree.length === 0 ? (
            <div className="text-center py-12">
              <FolderTree className="h-12 w-12 mx-auto text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground">Nenhum projeto criado.</p>
              {isAdmin && <Button variant="outline" className="mt-3" onClick={() => openCreate(null, "group")}><Plus className="h-4 w-4 mr-2" /> Criar Grupo</Button>}
            </div>
          ) : (
            <div className="divide-y">
              {tree.map(node => <TreeNode key={node.id} node={node} />)}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Novo {LEVEL_LABELS[createLevel] ?? "Projeto"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Nome</Label>
              <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder={`Nome do ${LEVEL_LABELS[createLevel]?.toLowerCase() ?? "projeto"}...`} />
            </div>
            <div>
              <Label>Descrição</Label>
              <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={2} />
            </div>
            <div className="flex gap-4">
              <div className="flex-1">
                <Label>Cor</Label>
                <Input type="color" value={form.color} onChange={e => setForm(f => ({ ...f, color: e.target.value }))} />
              </div>
              <div className="flex-1">
                <Label>Responsável</Label>
                <Select value={form.managerId} onValueChange={v => setForm(f => ({ ...f, managerId: v }))}>
                  <SelectTrigger><SelectValue placeholder="Opcional..." /></SelectTrigger>
                  <SelectContent>
                    {usersList.map((u: any) => (
                      <SelectItem key={u.id} value={u.id.toString()}>{u.name ?? u.email}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Budget (€)</Label>
              <Input type="number" step="0.01" min="0" value={form.budget} onChange={e => setForm(f => ({ ...f, budget: e.target.value }))} placeholder="Ex: 50000" />
            </div>
            <div className="flex gap-4">
              <div className="flex-1">
                <Label>Parceiro</Label>
                <Input value={form.partnerName} onChange={e => setForm(f => ({ ...f, partnerName: e.target.value }))} placeholder="Nome do parceiro" />
              </div>
              <div className="w-28">
                <Label>% Parceiro</Label>
                <Input type="number" step="0.01" min="0" max="100" value={form.partnerPercent} onChange={e => setForm(f => ({ ...f, partnerPercent: e.target.value }))} placeholder="Ex: 30" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancelar</Button>
            <Button
              disabled={!form.name || createMut.isPending}
              onClick={() => createMut.mutate({
                name: form.name,
                description: form.description || undefined,
                parentId: createParentId ?? undefined,
                level: createLevel as any,
                color: form.color,
                managerId: form.managerId ? parseInt(form.managerId) : undefined,
                budget: form.budget || undefined,
                partnerName: form.partnerName || undefined,
                partnerPercent: form.partnerPercent || undefined,
              })}
            >
              Criar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editProject} onOpenChange={() => setEditProject(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Editar {editProject ? LEVEL_LABELS[editProject.level] : "Projeto"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Nome</Label>
              <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div>
              <Label>Descrição</Label>
              <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={2} />
            </div>
            <div className="flex gap-4">
              <div className="flex-1">
                <Label>Cor</Label>
                <Input type="color" value={form.color} onChange={e => setForm(f => ({ ...f, color: e.target.value }))} />
              </div>
              <div className="flex-1">
                <Label>Responsável</Label>
                <Select value={form.managerId} onValueChange={v => setForm(f => ({ ...f, managerId: v }))}>
                  <SelectTrigger><SelectValue placeholder="Opcional..." /></SelectTrigger>
                  <SelectContent>
                    {usersList.map((u: any) => (
                      <SelectItem key={u.id} value={u.id.toString()}>{u.name ?? u.email}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Budget (€)</Label>
              <Input type="number" step="0.01" min="0" value={form.budget} onChange={e => setForm(f => ({ ...f, budget: e.target.value }))} placeholder="Ex: 50000" />
            </div>
            <div className="flex gap-4">
              <div className="flex-1">
                <Label>Parceiro</Label>
                <Input value={form.partnerName} onChange={e => setForm(f => ({ ...f, partnerName: e.target.value }))} placeholder="Nome do parceiro" />
              </div>
              <div className="w-28">
                <Label>% Parceiro</Label>
                <Input type="number" step="0.01" min="0" max="100" value={form.partnerPercent} onChange={e => setForm(f => ({ ...f, partnerPercent: e.target.value }))} placeholder="Ex: 30" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditProject(null)}>Cancelar</Button>
            <Button
              disabled={!form.name || updateMut.isPending}
              onClick={() => editProject && updateMut.mutate({
                id: editProject.id,
                name: form.name,
                description: form.description || undefined,
                color: form.color,
                managerId: form.managerId ? parseInt(form.managerId) : null,
                budget: form.budget || null,
                partnerName: form.partnerName || null,
                partnerPercent: form.partnerPercent || null,
              })}
            >
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Assign Dialog */}
      {showAssign && <AssignDialog />}
    </div>
  );
}
