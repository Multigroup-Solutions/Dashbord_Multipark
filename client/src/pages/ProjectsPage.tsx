import { useState, useMemo, useEffect } from "react";
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
  Building2, Tag, MapPin, FolderKanban, UserPlus, X, Euro, Handshake,
  Search, ChevronsUpDown, ChevronsDownUp
} from "lucide-react";
import { useLocation } from "wouter";
import ProjectCostsDashboard from "./ProjectCostsDashboard";

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

// Raio de picagem do ponto (geofence): check-in/out fora do raio é permitido
// mas fica marcado a vermelho. Herda pelo pai se o nó não tiver raio próprio.
function GeofenceSection({ projectId }: { projectId: number }) {
  const utils = trpc.useUtils();
  const { data: fences = [] } = trpc.rh.timeRecords.geofences.useQuery();
  const mine = fences.find((f: any) => f.projectId === projectId);
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [radius, setRadius] = useState("500");
  useEffect(() => {
    if (mine) { setLat(String(mine.lat)); setLng(String(mine.lng)); setRadius(String(mine.radiusM)); }
    else { setLat(""); setLng(""); setRadius("500"); }
  }, [projectId, mine?.lat, mine?.lng, mine?.radiusM]);
  const saveMut = trpc.rh.timeRecords.setGeofence.useMutation({
    onSuccess: () => { utils.rh.timeRecords.geofences.invalidate(); toast.success("Raio de picagem guardado"); },
    onError: (e) => toast.error(e.message),
  });
  const delMut = trpc.rh.timeRecords.deleteGeofence.useMutation({
    onSuccess: () => { utils.rh.timeRecords.geofences.invalidate(); toast.success("Raio removido"); },
  });
  const useMyLocation = () => {
    if (!navigator.geolocation) { toast.error("Sem GPS neste dispositivo"); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => { setLat(pos.coords.latitude.toFixed(6)); setLng(pos.coords.longitude.toFixed(6)); },
      () => toast.error("Sem acesso à localização"),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };
  return (
    <div className="border-t pt-3 space-y-2">
      <Label className="flex items-center gap-1.5">
        <MapPin className="w-3.5 h-3.5" /> Raio de picagem do ponto
        {mine && <Badge variant="outline" className="text-[10px]">configurado</Badge>}
      </Label>
      <p className="text-xs text-muted-foreground">Check-in/out fora deste raio fica marcado a vermelho (mas é permitido). Sem raio, herda o do nível acima.</p>
      <div className="flex gap-2 items-end flex-wrap">
        <div className="w-32"><Label className="text-xs">Latitude</Label><Input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="38.7756" /></div>
        <div className="w-32"><Label className="text-xs">Longitude</Label><Input value={lng} onChange={(e) => setLng(e.target.value)} placeholder="-9.1354" /></div>
        <div className="w-24"><Label className="text-xs">Raio (m)</Label><Input type="number" value={radius} onChange={(e) => setRadius(e.target.value)} /></div>
        <Button type="button" variant="outline" size="sm" onClick={useMyLocation}>📍 Usar a minha localização</Button>
        <Button
          type="button" size="sm"
          disabled={!lat || !lng || saveMut.isPending}
          onClick={() => saveMut.mutate({ projectId, lat: parseFloat(lat), lng: parseFloat(lng), radiusM: parseInt(radius) || 500 })}
        >
          Guardar raio
        </Button>
        {mine && (
          <Button type="button" variant="ghost" size="sm" className="text-red-600" onClick={() => delMut.mutate({ projectId })}>Remover</Button>
        )}
      </div>
    </div>
  );
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
  const [form, setForm] = useState({ name: "", description: "", color: "#6366f1", managerId: "", budget: "", partnerName: "", partnerPercent: "" });
  const [searchTerm, setSearchTerm] = useState("");
  const [showCosts, setShowCosts] = useState(false);
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
  const tree = useMemo(() => buildTree(allProjects as Project[]), [allProjects]);

  // Pesquisa: quando há termo, calcula os ids que devem aparecer (matches + os
  // seus ancestrais). Faz force-expand desses ancestrais.
  const searchMatches = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return null;
    const list = allProjects as Project[];
    const directMatches = new Set<number>(
      list.filter((p) => p.name.toLowerCase().includes(q) || (p.description ?? "").toLowerCase().includes(q)).map((p) => p.id),
    );
    // Inclui ancestrais para que a árvore mostre o caminho até ao match
    const visible = new Set<number>(directMatches);
    const byId = new Map(list.map((p) => [p.id, p]));
    for (const id of Array.from(directMatches)) {
      let cur = byId.get(id);
      while (cur?.parentId != null) {
        visible.add(cur.parentId);
        cur = byId.get(cur.parentId);
      }
    }
    return { visible, directMatches };
  }, [searchTerm, allProjects]);

  // Quando há pesquisa, expande automaticamente o caminho até aos matches.
  const effectiveExpanded = useMemo(() => {
    if (!searchMatches) return expanded;
    return new Set<number>([...expanded, ...searchMatches.visible]);
  }, [expanded, searchMatches]);

  // Contagens: nº de descendentes e nº de colaboradores atribuídos por nó.
  const descendantCount = useMemo(() => {
    const list = allProjects as Project[];
    const childrenMap = new Map<number, number[]>();
    for (const p of list) {
      if (p.parentId != null) {
        if (!childrenMap.has(p.parentId)) childrenMap.set(p.parentId, []);
        childrenMap.get(p.parentId)!.push(p.id);
      }
    }
    const counts = new Map<number, number>();
    function count(id: number): number {
      if (counts.has(id)) return counts.get(id)!;
      const kids = childrenMap.get(id) ?? [];
      let total = kids.length;
      for (const k of kids) total += count(k);
      counts.set(id, total);
      return total;
    }
    for (const p of list) count(p.id);
    return counts;
  }, [allProjects]);

  function expandAll() {
    setExpanded(new Set((allProjects as Project[]).map((p) => p.id)));
  }
  function collapseAll() {
    setExpanded(new Set());
  }

  function resetForm() {
    setForm({ name: "", description: "", color: "#6366f1", managerId: "", budget: "", partnerName: "", partnerPercent: "" });
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
    setForm({ name: p.name, description: p.description ?? "", color: p.color ?? "#6366f1", managerId: p.managerId?.toString() ?? "", budget: (p as any).budget ?? "", partnerName: (p as any).partnerName ?? "", partnerPercent: (p as any).partnerPercent ?? "" });
  }

  function getManagerName(managerId: number | null) {
    if (!managerId) return null;
    const u = usersList.find((u: any) => u.id === managerId);
    return u ? (u as any).name : null;
  }

  const isAdmin = user && ["super_admin", "admin"].includes(user.role);

  function TreeNode({ node, depth = 0 }: { node: Project & { children: any[] }; depth?: number }) {
    // Filtra invisíveis quando há pesquisa em curso
    if (searchMatches && !searchMatches.visible.has(node.id)) return null;

    const isOpen = effectiveExpanded.has(node.id);
    const hasChildren = node.children.length > 0;
    const Icon = LEVEL_ICONS[node.level] || FolderKanban;
    const childLevel = CHILD_LEVEL[node.level];
    const descCount = descendantCount.get(node.id) ?? 0;
    const isMatch = searchMatches?.directMatches.has(node.id);

    return (
      <div>
        <div
          className={`flex items-center gap-2 py-2 px-3 rounded-lg hover:bg-muted/50 cursor-pointer transition-colors group ${
            isMatch ? "bg-amber-50 dark:bg-amber-950/20" : ""
          }`}
          style={{ paddingLeft: `${depth * 24 + 12}px` }}
          onClick={() => hasChildren && toggleExpand(node.id)}
        >
          {hasChildren ? (
            isOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
          ) : (
            <span className="w-4 shrink-0" />
          )}
          <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: node.color ?? "#6366f1" }} />
          <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="font-medium text-sm flex-1">{node.name}</span>
          {descCount > 0 && (
            <Badge variant="secondary" className="text-[10px] px-1.5">
              {descCount} sub
            </Badge>
          )}
          {node.managerId && getManagerName(node.managerId) && (
            <span className="text-xs text-muted-foreground hidden md:inline">Resp: {getManagerName(node.managerId)}</span>
          )}
          {node.partnerName && (
            <span className="text-xs text-muted-foreground hidden md:flex items-center gap-1">
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
            // Sempre visíveis (eram hover-only e ficavam "escondidos" no tema novo)
            <div className="opacity-60 group-hover:opacity-100 flex gap-1 transition-opacity">
              {childLevel && (
                <Button variant="ghost" size="icon" className="h-7 w-7" title={`Criar ${LEVEL_LABELS[childLevel]}`} onClick={(e) => { e.stopPropagation(); openCreate(node.id, childLevel); }}>
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              )}
              <Button variant="ghost" size="icon" className="h-7 w-7" title="Colaboradores" onClick={(e) => { e.stopPropagation(); setShowAssign(node.id); }}>
                <UserPlus className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7" title="Editar" onClick={(e) => { e.stopPropagation(); openEdit(node); }}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" title="Eliminar" onClick={(e) => { e.stopPropagation(); if (confirm("Eliminar este projeto e todos os sub-projetos?")) deleteMut.mutate({ id: node.id }); }}>
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

  if (showCosts) {
    return <ProjectCostsDashboard onBack={() => setShowCosts(false)} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-muted-foreground text-sm">Estrutura organizacional em árvore</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setShowCosts(true)}>
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
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-base">Árvore de Projetos</CardTitle>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Pesquisar por nome ou descrição..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-8 h-9 w-64"
                />
              </div>
              <Button variant="outline" size="sm" onClick={expandAll} title="Expandir tudo">
                <ChevronsUpDown className="h-3.5 w-3.5 mr-1" /> Expandir
              </Button>
              <Button variant="outline" size="sm" onClick={collapseAll} title="Colapsar tudo">
                <ChevronsDownUp className="h-3.5 w-3.5 mr-1" /> Colapsar
              </Button>
            </div>
          </div>
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
          ) : searchMatches && searchMatches.directMatches.size === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              Sem resultados para "<span className="font-medium">{searchTerm}</span>".
            </p>
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
            {editProject && <GeofenceSection projectId={editProject.id} />}
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
      {showAssign !== null && (
        <AssignDialog
          projectId={showAssign}
          employees={employees}
          onClose={() => setShowAssign(null)}
        />
      )}
    </div>
  );
}

function AssignDialog({
  projectId,
  employees,
  onClose,
}: {
  projectId: number;
  employees: any[];
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const { data: assigned = [] } = trpc.projects.getEmployees.useQuery({ projectId });
  const assignMut = trpc.projects.assignEmployee.useMutation({
    onSuccess: () => {
      utils.projects.getEmployees.invalidate({ projectId });
      toast.success("Colaborador atribuído!");
    },
    onError: (e) => toast.error(e.message),
  });
  const removeMut = trpc.projects.removeEmployee.useMutation({
    onSuccess: () => {
      utils.projects.getEmployees.invalidate({ projectId });
      toast.success("Colaborador removido!");
    },
    onError: (e) => toast.error(e.message),
  });
  const [selectedEmp, setSelectedEmp] = useState("");
  const assignedIds = new Set((assigned as any[]).map((a) => a.employeeId));
  const available = employees.filter((e: any) => !assignedIds.has((e.employee ?? e).id));

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Users className="h-5 w-5" /> Colaboradores do Projeto</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {(assigned as any[]).length > 0 ? (
            <div className="space-y-2">
              {(assigned as any[]).map((a) => {
                const empRow = employees.find((e: any) => (e.employee ?? e).id === a.employeeId);
                const emp = empRow ? (empRow.employee ?? empRow) : null;
                return (
                  <div key={a.id} className="flex items-center justify-between py-1.5 px-3 bg-muted/50 rounded-md">
                    <span className="text-sm">{emp ? emp.fullName : `#${a.employeeId}`}</span>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => removeMut.mutate({ projectId, employeeId: a.employeeId })}>
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
                  assignMut.mutate({ projectId, employeeId: parseInt(selectedEmp) });
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
