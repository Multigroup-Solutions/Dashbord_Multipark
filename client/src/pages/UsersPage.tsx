import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Users,
  Shield,
  Loader2,
  AlertCircle,
  Plus,
  Search,
  Pencil,
  UserCheck,
  UserX,
  Mail,
  Building2,
  Send,
  KeyRound,
  ChevronLeft,
} from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { pt } from "date-fns/locale";

const ROLES = [
  { value: "super_admin", label: "Super Admin", color: "bg-purple-100 text-purple-800 border-purple-200" },
  { value: "admin", label: "Admin", color: "bg-blue-100 text-blue-800 border-blue-200" },
  { value: "supervisor", label: "Supervisor", color: "bg-indigo-100 text-indigo-800 border-indigo-200" },
  { value: "team_leader", label: "Team Leader", color: "bg-cyan-100 text-cyan-800 border-cyan-200" },
  { value: "backoffice", label: "Backoffice", color: "bg-teal-100 text-teal-800 border-teal-200" },
  { value: "frontoffice", label: "Frontoffice", color: "bg-green-100 text-green-800 border-green-200" },
  { value: "extra", label: "Extra", color: "bg-yellow-100 text-yellow-800 border-yellow-200" },
  { value: "user", label: "Utilizador", color: "bg-gray-100 text-gray-700 border-gray-200" },
];

const DEPARTMENTS = [
  "Administração",
  "Operações",
  "Marketing",
  "Backoffice",
  "Frontoffice",
  "RH",
  "Financeiro",
  "TI",
];

function RoleBadge({ role }: { role: string }) {
  const cfg = ROLES.find((r) => r.value === role) ?? ROLES[ROLES.length - 1];
  return (
    <span className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full border ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}

type UserFormData = {
  name: string;
  email: string;
  role: string;
  department: string;
};

const emptyForm: UserFormData = { name: "", email: "", role: "user", department: "" };

export default function UsersPage({ onBack }: { onBack?: () => void } = {}) {
  const { user: currentUser } = useAuth();
  const utils = trpc.useUtils();

  const { data: users, isLoading } = trpc.users.list.useQuery();

  // Filters
  const [search, setSearch] = useState("");
  const [filterRole, setFilterRole] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");

  // Create/Edit modal
  const [showModal, setShowModal] = useState(false);
  const [editingUser, setEditingUser] = useState<any>(null);
  const [form, setForm] = useState<UserFormData>(emptyForm);

  const isSuperAdmin = currentUser?.role === "super_admin";

  const createMutation = trpc.users.create.useMutation({
    onSuccess: () => {
      toast.success("Utilizador criado com sucesso");
      utils.users.list.invalidate();
      closeModal();
    },
    onError: (e) => toast.error("Erro: " + e.message),
  });

  const updateMutation = trpc.users.update.useMutation({
    onSuccess: () => {
      toast.success("Utilizador atualizado com sucesso");
      utils.users.list.invalidate();
      closeModal();
    },
    onError: (e) => toast.error("Erro: " + e.message),
  });

  const toggleActiveMutation = trpc.users.toggleActive.useMutation({
    onSuccess: (_, vars) => {
      toast.success(vars.isActive ? "Utilizador ativado" : "Utilizador desativado");
      utils.users.list.invalidate();
    },
    onError: (e) => toast.error("Erro: " + e.message),
  });

  const updateRoleMutation = trpc.users.updateRole.useMutation({
    onSuccess: () => {
      toast.success("Role atualizado");
      utils.users.list.invalidate();
    },
    onError: (e) => toast.error("Erro: " + e.message),
  });

  const sendInviteMutation = trpc.users.sendInvite.useMutation({
    onSuccess: (data) => {
      toast.success(`Convite gerado para ${data.email}! Copia o link e envia ao utilizador.`);
      setInviteLink(data.inviteLink);
      setShowInviteDialog(true);
    },
    onError: (e) => toast.error("Erro ao enviar convite: " + e.message),
  });

  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [inviteLink, setInviteLink] = useState("");
  // Permissões por utilizador (dialog)
  const [permUser, setPermUser] = useState<{ id: number; name: string } | null>(null);

  // Filtered users
  const filteredUsers = useMemo(() => {
    if (!users) return [];
    return users.filter((u) => {
      const matchSearch =
        !search ||
        u.name?.toLowerCase().includes(search.toLowerCase()) ||
        u.email?.toLowerCase().includes(search.toLowerCase());
      const matchRole = filterRole === "all" || u.role === filterRole;
      const matchStatus =
        filterStatus === "all" ||
        (filterStatus === "active" && u.isActive) ||
        (filterStatus === "inactive" && !u.isActive);
      return matchSearch && matchRole && matchStatus;
    });
  }, [users, search, filterRole, filterStatus]);

  // Stats
  const stats = useMemo(() => {
    if (!users) return { total: 0, active: 0, inactive: 0, admins: 0 };
    return {
      total: users.length,
      active: users.filter((u) => u.isActive).length,
      inactive: users.filter((u) => !u.isActive).length,
      admins: users.filter((u) => ["super_admin", "admin"].includes(u.role)).length,
    };
  }, [users]);

  function openCreate() {
    setEditingUser(null);
    setForm(emptyForm);
    setShowModal(true);
  }

  function openEdit(u: any) {
    setEditingUser(u);
    setForm({
      name: u.name ?? "",
      email: u.email ?? "",
      role: u.role,
      department: u.department ?? "",
    });
    setShowModal(true);
  }

  function closeModal() {
    setShowModal(false);
    setEditingUser(null);
    setForm(emptyForm);
  }

  function handleSubmit() {
    if (!form.name.trim() || !form.email.trim()) {
      toast.error("Nome e email são obrigatórios");
      return;
    }
    if (editingUser) {
      updateMutation.mutate({
        userId: editingUser.id,
        name: form.name,
        email: form.email,
        role: form.role,
        department: form.department || null,
      });
    } else {
      createMutation.mutate({
        name: form.name,
        email: form.email,
        role: form.role,
        department: form.department || undefined,
      });
    }
  }

  if (!["super_admin", "admin"].includes(currentUser?.role ?? "")) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <AlertCircle className="h-12 w-12 text-muted-foreground/30 mb-4" />
        <p className="text-muted-foreground font-medium">Acesso restrito</p>
        <p className="text-sm text-muted-foreground mt-1">Não tens permissão para ver esta página</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {onBack && (
            <Button variant="ghost" size="sm" onClick={onBack}>
              <ChevronLeft className="w-4 h-4 mr-1" /> Voltar
            </Button>
          )}
          <p className="text-sm text-muted-foreground">
            Criar, editar e gerir utilizadores da plataforma
          </p>
        </div>
        {isSuperAdmin && (
          <Button onClick={openCreate} className="gap-2">
            <Plus className="h-4 w-4" />
            Novo Utilizador
          </Button>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Users className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.total}</p>
              <p className="text-xs text-muted-foreground">Total</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-green-100 flex items-center justify-center">
              <UserCheck className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.active}</p>
              <p className="text-xs text-muted-foreground">Ativos</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-red-100 flex items-center justify-center">
              <UserX className="h-5 w-5 text-red-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.inactive}</p>
              <p className="text-xs text-muted-foreground">Inativos</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-purple-100 flex items-center justify-center">
              <Shield className="h-5 w-5 text-purple-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.admins}</p>
              <p className="text-xs text-muted-foreground">Admins</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Pesquisar por nome ou email..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={filterRole} onValueChange={setFilterRole}>
              <SelectTrigger>
                <SelectValue placeholder="Filtrar por role" />
              </SelectTrigger>
              <SelectContent>
                {[
                  { value: "all", label: "Todos os roles" },
                  ...ROLES,
                ].map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filterStatus} onValueChange={setFilterStatus}>
              <SelectTrigger>
                <SelectValue placeholder="Filtrar por estado" />
              </SelectTrigger>
              <SelectContent>
                {[
                  { value: "all", label: "Todos os estados" },
                  { value: "active", label: "Ativos" },
                  { value: "inactive", label: "Inativos" },
                ].map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Users Table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Utilizadores ({filteredUsers.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : filteredUsers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <Users className="h-12 w-12 text-muted-foreground/20 mb-3" />
              <p className="text-muted-foreground text-sm">Nenhum utilizador encontrado</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12"></TableHead>
                    <TableHead>Nome</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Departamento</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead>Último Acesso</TableHead>
                    <TableHead>Criado em</TableHead>
                    {(isSuperAdmin || currentUser) && <TableHead className="text-right">Ações</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredUsers.map((u) => (
                    <TableRow
                      key={u.id}
                      className={!u.isActive ? "opacity-50" : ""}
                    >
                      <TableCell>
                        <Avatar className="h-8 w-8">
                          <AvatarFallback className="text-xs font-semibold bg-primary/10 text-primary">
                            {u.name?.charAt(0).toUpperCase() ?? "?"}
                          </AvatarFallback>
                        </Avatar>
                      </TableCell>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-1.5">
                          {u.name ?? "Sem nome"}
                          {u.id === currentUser?.id && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0">Tu</Badge>
                          )}
                        </div>
                        {u.loginMethod === "manual" && (
                          <span className="text-[10px] text-muted-foreground">Criado manualmente</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {u.email ?? "—"}
                      </TableCell>
                      <TableCell>
                        {isSuperAdmin && u.id !== currentUser?.id ? (
                          <Select
                            value={u.role}
                            onValueChange={(newRole) => {
                              updateRoleMutation.mutate({ userId: u.id, role: newRole });
                            }}
                          >
                            <SelectTrigger className="w-32 h-7 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {ROLES.map((r) => (
                                <SelectItem key={r.value} value={r.value} className="text-xs">
                                  {r.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <RoleBadge role={u.role} />
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {u.department ? (
                          <Badge variant="secondary" className="text-xs font-normal">
                            <Building2 className="h-3 w-3 mr-1" />
                            {u.department}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {isSuperAdmin && u.id !== currentUser?.id ? (
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={Boolean(u.isActive)}
                              onCheckedChange={(checked) => {
                                toggleActiveMutation.mutate({ userId: u.id, isActive: checked });
                              }}
                              className="scale-75"
                            />
                            <span className={`text-xs ${u.isActive ? "text-green-600" : "text-red-500"}`}>
                              {u.isActive ? "Ativo" : "Inativo"}
                            </span>
                          </div>
                        ) : (
                          <Badge variant={u.isActive ? "default" : "destructive"} className="text-xs">
                            {u.isActive ? "Ativo" : "Inativo"}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {u.lastSignedIn
                          ? format(new Date(u.lastSignedIn), "dd MMM yyyy HH:mm", { locale: pt })
                          : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {format(new Date(u.createdAt), "dd MMM yyyy", { locale: pt })}
                      </TableCell>
                      {(isSuperAdmin || currentUser) && (
                        <TableCell className="text-right">
                          <div className="flex items-center gap-1">
                            {(isSuperAdmin || u.id === currentUser?.id) && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => openEdit(u)}
                                className="h-7 w-7 p-0"
                                title="Editar"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            {isSuperAdmin && u.loginMethod === "manual" && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => sendInviteMutation.mutate({ userId: u.id, origin: window.location.origin })}
                                disabled={sendInviteMutation.isPending}
                                className="h-7 w-7 p-0 text-blue-600 hover:text-blue-700"
                                title="Enviar convite"
                              >
                                {sendInviteMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setPermUser({ id: u.id, name: u.name ?? u.email ?? `#${u.id}` })}
                              className="h-7 w-7 p-0"
                              title="Permissões deste utilizador"
                            >
                              <KeyRound className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Role Legend */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Hierarquia de Roles</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {ROLES.map((r) => (
              <div key={r.value} className="flex flex-col gap-1 p-3 rounded-lg bg-muted/30 border">
                <RoleBadge role={r.value} />
                <p className="text-xs text-muted-foreground mt-1">
                  {r.value === "super_admin" && "Acesso total, logs, roles, gestão de users"}
                  {r.value === "admin" && "Gestão de despesas, RH e operações"}
                  {r.value === "supervisor" && "Visão geral de todos os dados"}
                  {r.value === "team_leader" && "Gestão da sua equipa"}
                  {r.value === "backoffice" && "Operações internas"}
                  {r.value === "frontoffice" && "Operações de front"}
                  {r.value === "extra" && "Acesso limitado, registo de ponto"}
                  {r.value === "user" && "Apenas dados próprios"}
                </p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Permissões do utilizador */}
      {permUser && <UserPermissionsDialog user={permUser} onClose={() => setPermUser(null)} />}

      {/* Create/Edit Modal */}
      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {editingUser ? (
                <>
                  <Pencil className="h-4 w-4" />
                  Editar Utilizador
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4" />
                  Novo Utilizador
                </>
              )}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="name">Nome *</Label>
              <Input
                id="name"
                placeholder="Nome completo"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email">Email *</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="email"
                  type="email"
                  placeholder="email@exemplo.com"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  className="pl-9"
                />
              </div>
            </div>
            {/* Role and Department only visible for super_admin editing others */}
            {(isSuperAdmin && editingUser?.id !== currentUser?.id || !editingUser) && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Role</Label>
                <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLES.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Departamento</Label>
                <Select
                  value={form.department || "none"}
                  onValueChange={(v) => setForm({ ...form, department: v === "none" ? "" : v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Selecionar..." />
                  </SelectTrigger>
                  <SelectContent>
                    {[
                      { value: "none", label: "Nenhum" },
                      ...DEPARTMENTS.map((d) => ({ value: d, label: d })),
                    ].map((d) => (
                      <SelectItem key={d.value} value={d.value}>
                        {d.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            )}
            {editingUser?.id === currentUser?.id && !isSuperAdmin && (
              <p className="text-xs text-muted-foreground bg-muted/50 p-3 rounded-lg">
                Podes alterar o teu nome e email. Para alterar role ou departamento, contacta um administrador.
              </p>
            )}
            {!editingUser && (
              <p className="text-xs text-muted-foreground bg-muted/50 p-3 rounded-lg">
                O utilizador será criado manualmente. Para aceder à plataforma, precisará de ser convidado
                ou fazer login via OAuth com o mesmo email.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeModal}>
              Cancelar
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={createMutation.isPending || updateMutation.isPending}
            >
              {(createMutation.isPending || updateMutation.isPending) && (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              )}
              {editingUser ? "Guardar" : "Criar Utilizador"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Invite Link Dialog */}
      <Dialog open={showInviteDialog} onOpenChange={setShowInviteDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="h-4 w-4" />
              Link de Convite Gerado
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Copia este link e envia-o ao utilizador. O link expira em 7 dias.
            </p>
            <div className="flex gap-2">
              <Input value={inviteLink} readOnly className="text-xs" />
              <Button
                variant="outline"
                onClick={() => {
                  navigator.clipboard.writeText(inviteLink);
                  toast.success("Link copiado!");
                }}
              >
                Copiar
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setShowInviteDialog(false)}>Fechar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── PERMISSÕES POR UTILIZADOR (dialog) ──────────────────────────────────────
// Pedido Jorge: "na página dos utilizadores, quais são as permissões que eles
// têm, poder adicionar ou não". 3 estados por permissão: — (default do role),
// ✓ dar, ✕ negar.
function UserPermissionsDialog({ user, onClose }: { user: { id: number; name: string }; onClose: () => void }) {
  const utils = trpc.useUtils();
  const { data: catalog = [] } = trpc.permissions.catalog.useQuery();
  const { data: overrides = {}, isLoading } = trpc.permissions.forUser.useQuery({ userId: user.id });
  const setMut = trpc.permissions.setForUser.useMutation({
    onSuccess: () => {
      utils.permissions.forUser.invalidate({ userId: user.id });
      utils.permissions.assignments.invalidate();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" /> Permissões — {user.name}
          </DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <div className="py-8 text-center"><Loader2 className="h-5 w-5 animate-spin mx-auto text-muted-foreground" /></div>
        ) : (
          <div className="space-y-2">
            {(catalog as any[]).map((p) => {
              const mode = (overrides as any)[p.id] ?? "default";
              return (
                <div key={p.id} className="flex items-center justify-between gap-3 p-2.5 rounded-lg border">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{p.label}</p>
                    <p className="text-[11px] text-muted-foreground">{p.description}</p>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    {([["default", "—"], ["grant", "✓ Dar"], ["deny", "✕ Negar"]] as const).map(([m, label]) => (
                      <Button
                        key={m}
                        size="sm"
                        variant={mode === m ? (m === "grant" ? "default" : m === "deny" ? "destructive" : "secondary") : "outline"}
                        className="h-7 text-xs px-2"
                        disabled={setMut.isPending}
                        onClick={() => setMut.mutate({ userId: user.id, permission: p.id, mode: m === "default" ? null : m })}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Fechar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
