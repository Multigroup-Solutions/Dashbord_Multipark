import { useState, useEffect } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import { UserEmployeeLinks } from '@/components/UserEmployeeLinks';
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
  ChevronRight,
  ChevronDown,
  Clock,
  MapPin,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { pt } from "date-fns/locale";
import { DeactivationDialog, type DeactivationSubmitValues } from "@/components/DeactivationDialog";
import { DEFAULT_DEACTIVATION_REASON, deactivationReasonLabel } from "@shared/deactivationReasons";
import { CITY_KEYS, CITY_LABELS, type CityKey } from "@shared/city";
import { ROLE_LABELS, assignableRoles, can, canGrantPermissionsTo, canManageUserRole, canTouchPermission, roleRank, type Role } from "@shared/access";

// Papéis e hierarquia: shared/access.ts (a mesma matriz que o servidor aplica).
const ROLES = [
  { value: "super_admin", label: ROLE_LABELS.super_admin, color: "bg-purple-100 text-purple-800 border-purple-200" },
  { value: "admin", label: ROLE_LABELS.admin, color: "bg-blue-100 text-blue-800 border-blue-200" },
  { value: "backoffice", label: ROLE_LABELS.backoffice, color: "bg-teal-100 text-teal-800 border-teal-200" },
  { value: "frontoffice", label: ROLE_LABELS.frontoffice, color: "bg-green-100 text-green-800 border-green-200" },
  { value: "supervisor", label: ROLE_LABELS.supervisor, color: "bg-indigo-100 text-indigo-800 border-indigo-200" },
  { value: "team_leader", label: ROLE_LABELS.team_leader, color: "bg-cyan-100 text-cyan-800 border-cyan-200" },
  { value: "condutor", label: ROLE_LABELS.condutor, color: "bg-orange-100 text-orange-800 border-orange-200" },
  { value: "extra", label: ROLE_LABELS.extra, color: "bg-yellow-100 text-yellow-800 border-yellow-200" },
  { value: "user", label: ROLE_LABELS.user, color: "bg-gray-100 text-gray-700 border-gray-200" },
];

type RoleValue = Role;

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

/** "Sugerir condutores": contas user/extra cuja ficha tem posto driver/senior_driver. */
function SuggestCondutoresCard() {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const { data: rows = [], isLoading } = trpc.users.suggestCondutores.useQuery(undefined, { enabled: open });
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const promote = trpc.users.promoteToCondutor.useMutation({
    onSuccess: (r) => {
      toast.success(`${r.changed} conta(s) passaram a Condutor`);
      setPicked(new Set());
      // lista paginada, resumo e sugestões
      utils.users.invalidate();
    },
    onError: (e) => toast.error("Erro: " + e.message),
  });
  const all = rows.length > 0 && picked.size === rows.length;
  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">Sugerir condutores</CardTitle>
        <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)}>{open ? "Esconder" : "Ver sugestões"}</Button>
      </CardHeader>
      {open && (
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Contas com papel Utilizador ou Extra cuja ficha RH tem o posto Motorista / Motorista sénior. Ninguém muda de papel sem confirmares.
          </p>
          {isLoading ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /> : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sem sugestões.</p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Switch checked={all} onCheckedChange={(v) => setPicked(v ? new Set(rows.map((r) => r.id)) : new Set())} className="scale-75" />
                <span className="text-xs">Selecionar todos ({rows.length})</span>
                <Button size="sm" className="ml-auto" disabled={picked.size === 0 || promote.isPending}
                  onClick={() => promote.mutate({ userIds: [...picked] })}>
                  {promote.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}Passar a Condutor ({picked.size})
                </Button>
              </div>
              <div className="max-h-72 overflow-y-auto divide-y border rounded-md">
                {rows.map((r) => (
                  <label key={r.id} className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer">
                    <input type="checkbox" checked={picked.has(r.id)} onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(r.id); else next.delete(r.id);
                      setPicked(next);
                    }} />
                    <span className="font-medium">{r.fullName ?? r.name ?? r.email}</span>
                    <span className="text-xs text-muted-foreground">{r.email}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{r.projectName ?? "—"} · {ROLE_LABELS[r.role as Role] ?? r.role}</span>
                  </label>
                ))}
              </div>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}

// ─── Filtros do diretório (lembrados em localStorage) ─────────────────────────
// Pedido do Jorge (set 2026): "eu escolho, põe o que eu quero" — a página abre
// com o resumo e só as contas com atividade mais recente; o resto aparece a
// pedido (pesquisa + filtros), sempre paginado no servidor (users.search).
type DirFilters = {
  search: string;
  role: string; // "all" | Role
  city: string; // "all" | CityKey | "none"
  status: string; // "all" | "active" | "inactive"
  lastLogin: string; // "all" | "7d" | "30d" | "stale30" | "stale90" | "never"
  employee: string; // "all" | "with" | "without"
  sort: "recent" | "name" | "created";
  pageSize: number;
};

const DEFAULT_DIR_FILTERS: DirFilters = {
  search: "",
  role: "all",
  city: "all",
  status: "all",
  lastLogin: "all",
  employee: "all",
  sort: "recent",
  pageSize: 20,
};
const DIR_FILTERS_KEY = "mp.users.directory.v1";
const PAGE_SIZES = [20, 50, 100];

const LAST_LOGIN_OPTIONS = [
  { value: "all", label: "Qualquer último acesso" },
  { value: "7d", label: "Entrou nos últimos 7 dias" },
  { value: "30d", label: "Entrou nos últimos 30 dias" },
  { value: "stale30", label: "Sem entrar há +30 dias" },
  { value: "stale90", label: "Sem entrar há +90 dias" },
  { value: "never", label: "Nunca entrou" },
];

function loadDirFilters(): DirFilters {
  try {
    const raw = localStorage.getItem(DIR_FILTERS_KEY);
    if (!raw) return DEFAULT_DIR_FILTERS;
    const parsed = JSON.parse(raw) as Partial<DirFilters>;
    const merged = { ...DEFAULT_DIR_FILTERS, ...parsed };
    if (!PAGE_SIZES.includes(merged.pageSize)) merged.pageSize = DEFAULT_DIR_FILTERS.pageSize;
    if (!["recent", "name", "created"].includes(merged.sort)) merged.sort = "recent";
    return merged;
  } catch {
    return DEFAULT_DIR_FILTERS;
  }
}

function saveDirFilters(f: DirFilters) {
  try {
    localStorage.setItem(DIR_FILTERS_KEY, JSON.stringify(f));
  } catch {
    /* modo privado / quota — os filtros só não ficam lembrados */
  }
}

const orNull = (v: string) => (v === "all" ? null : v);

export default function UsersPage({ onBack }: { onBack?: () => void } = {}) {
  const { user: currentUser } = useAuth();
  const utils = trpc.useUtils();

  // Filtros (lembrados) + página atual (não lembrada: volta sempre à 1ª).
  const [filters, setFilters] = useState<DirFilters>(loadDirFilters);
  const [searchInput, setSearchInput] = useState(filters.search);
  const [page, setPage] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const [showLegend, setShowLegend] = useState(false);

  useEffect(() => saveDirFilters(filters), [filters]);
  // Pesquisa com debounce — não pede ao servidor a cada tecla.
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => (f.search === searchInput.trim() ? f : { ...f, search: searchInput.trim() }));
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);
  // Qualquer mudança de filtro volta à 1ª página.
  useEffect(() => setPage(0), [filters]);

  function patchFilters(p: Partial<DirFilters>) {
    setFilters((f) => ({ ...f, ...p }));
  }
  function clearFilters() {
    setSearchInput("");
    setFilters({ ...DEFAULT_DIR_FILTERS, sort: filters.sort, pageSize: filters.pageSize });
  }

  const activeFilterCount =
    (filters.search ? 1 : 0) +
    (["role", "city", "status", "lastLogin", "employee"] as const).filter((k) => filters[k] !== "all").length;
  const hasFilters = activeFilterCount > 0;

  const canView = can(currentUser?.role ?? "user", "utilizadores", "view");
  const summaryQ = trpc.users.summary.useQuery(undefined, { enabled: canView });
  const searchQ = trpc.users.search.useQuery(
    {
      search: filters.search || null,
      role: orNull(filters.role) as RoleValue | null,
      city: orNull(filters.city) as CityKey | "none" | null,
      status: orNull(filters.status) as "active" | "inactive" | null,
      lastLogin: orNull(filters.lastLogin) as "7d" | "30d" | "stale30" | "stale90" | "never" | null,
      employee: orNull(filters.employee) as "with" | "without" | null,
      sort: filters.sort,
      limit: filters.pageSize,
      offset: page * filters.pageSize,
    },
    { enabled: canView, placeholderData: keepPreviousData },
  );
  const rows = searchQ.data?.rows ?? [];
  const total = searchQ.data?.total ?? 0;
  const isLoading = searchQ.isLoading;
  const pageCount = Math.max(1, Math.ceil(total / filters.pageSize));
  const summary = summaryQ.data;

  // Create/Edit modal
  const [showModal, setShowModal] = useState(false);
  const [editingUser, setEditingUser] = useState<any>(null);
  const [form, setForm] = useState<UserFormData>(emptyForm);

  const isSuperAdmin = currentUser?.role === "super_admin";
  const myRole = currentUser?.role ?? "user";
  const canManageUsers = can(myRole, "utilizadores", "manage");
  const assignable = assignableRoles(myRole) as string[];
  const roleOptions = ROLES.filter((r) => assignable.includes(r.value));
  /** Pode gerir esta conta (papel dentro do que pode atribuir; nunca a própria)? */
  const manageable = (u: { id: number; role: string }) => canManageUserRole(myRole, u.role) && u.id !== currentUser?.id;

  /** Tudo o que é `users.*` (lista paginada, resumo e a lista antiga usada noutras páginas). */
  const refreshUsers = () => utils.users.invalidate();

  const createMutation = trpc.users.create.useMutation({
    onSuccess: () => {
      toast.success("Utilizador criado com sucesso");
      refreshUsers();
      closeModal();
    },
    onError: (e) => toast.error("Erro: " + e.message),
  });

  const updateMutation = trpc.users.update.useMutation({
    onSuccess: () => {
      toast.success("Utilizador atualizado com sucesso");
      refreshUsers();
      closeModal();
    },
    onError: (e) => toast.error("Erro: " + e.message),
  });

  // Desativar NUNCA é imediato: abre o pop-up que pede motivo + notas
  // (`deactivating`). Ativar é directo — não há nada a perguntar.
  const [deactivating, setDeactivating] = useState<{ id: number; name: string } | null>(null);

  const toggleActiveMutation = trpc.users.toggleActive.useMutation({
    onSuccess: (_, vars) => {
      toast.success(
        vars.isActive
          ? "Utilizador ativado"
          : `Utilizador desativado — ${deactivationReasonLabel(vars.reason ?? DEFAULT_DEACTIVATION_REASON, vars.reasonOther)}`,
      );
      refreshUsers();
      setDeactivating(null);
    },
    onError: (e) => toast.error("Erro: " + e.message),
  });

  function confirmDeactivation(values: DeactivationSubmitValues) {
    if (!deactivating) return;
    toggleActiveMutation.mutate({ userId: deactivating.id, isActive: false, ...values });
  }

  const updateRoleMutation = trpc.users.updateRole.useMutation({
    onSuccess: () => {
      toast.success("Role atualizado");
      refreshUsers();
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
  const [permUser, setPermUser] = useState<{ id: number; name: string } | null>(null);

  // Link direto (?userId=…[&view=permissions]): a conta é procurada no servidor
  // (com a mesma guarda de cidade) em vez de na lista completa, que já não vem.
  const [requestedUserId, setRequestedUserId] = useState(() => Number(new URLSearchParams(window.location.search).get("userId")) || null);
  useEffect(() => {
    if (requestedUserId == null) return;
    const id = requestedUserId;
    setRequestedUserId(null);
    utils.users.getById
      .fetch({ id })
      .then((target) => {
        if (!target) {
          toast.error("O utilizador não está disponível nas tuas cidades autorizadas.");
          return;
        }
        const needle = target.email ?? target.name ?? "";
        setSearchInput(needle);
        setFilters((f) => ({ ...DEFAULT_DIR_FILTERS, sort: f.sort, pageSize: f.pageSize, search: needle }));
        if (new URLSearchParams(window.location.search).get("view") === "permissions") {
          setPermUser({ id: target.id, name: target.name ?? target.email ?? "Utilizador" });
        } else {
          openEdit({ ...target, employees: [] });
        }
      })
      .catch(() => toast.error("O utilizador não está disponível nas tuas cidades autorizadas."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedUserId]);

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
      // Email e role: só o super_admin altera (o servidor recusa o resto).
      updateMutation.mutate({
        userId: editingUser.id,
        name: form.name,
        ...(manageable(editingUser) ? {
          ...(isSuperAdmin ? { email: form.email } : {}),
          role: form.role as RoleValue,
          department: form.department || null,
        } : {}),
      });
    } else {
      createMutation.mutate({
        name: form.name,
        email: form.email,
        role: form.role as RoleValue,
        department: form.department || undefined,
      });
    }
  }

  if (!can(myRole, "utilizadores", "view")) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <AlertCircle className="h-12 w-12 text-muted-foreground/30 mb-4" />
        <p className="text-muted-foreground font-medium">Acesso restrito</p>
        <p className="text-sm text-muted-foreground mt-1">Não tens permissão para ver esta página</p>
      </div>
    );
  }

  // ── Peças de cada linha (partilhadas pela tabela e pelos cartões móveis) ──
  type Row = (typeof rows)[number];

  const roleCell = (u: Row) =>
    manageable(u) ? (
      <Select value={u.role} onValueChange={(newRole) => updateRoleMutation.mutate({ userId: u.id, role: newRole as RoleValue })}>
        <SelectTrigger className="w-32 h-7 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {roleOptions.map((r) => (
            <SelectItem key={r.value} value={r.value} className="text-xs">
              {r.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : (
      <RoleBadge role={u.role} />
    );

  const statusCell = (u: Row) => (
    <>
      {manageable(u) ? (
        <div className="flex items-center gap-2">
          <Switch
            checked={Boolean(u.isActive)}
            onCheckedChange={(checked) => {
              // Desativar passa pelo pop-up (motivo + notas); o switch fica
              // controlado por `u.isActive`, por isso não se mexe enquanto o
              // diálogo está aberto.
              if (checked) toggleActiveMutation.mutate({ userId: u.id, isActive: true });
              else setDeactivating({ id: u.id, name: u.name ?? u.email ?? `#${u.id}` });
            }}
            className="scale-75"
          />
          <span className={`text-xs ${u.isActive ? "text-green-600" : "text-red-500"}`}>{u.isActive ? "Ativo" : "Inativo"}</span>
        </div>
      ) : (
        <Badge variant={u.isActive ? "default" : "destructive"} className="text-xs">
          {u.isActive ? "Ativo" : "Inativo"}
        </Badge>
      )}
      {/* Motivo da desativação actual (as notas ficam no tooltip) */}
      {!u.isActive && u.deactivationReason && (
        <p
          className="text-[11px] text-muted-foreground mt-1 max-w-[180px] truncate"
          title={[
            deactivationReasonLabel(u.deactivationReason, u.deactivationReasonOther),
            u.deactivationNotes ? `Notas: ${u.deactivationNotes}` : null,
            u.deactivatedAt ? `Desativado em ${format(new Date(u.deactivatedAt), "dd MMM yyyy HH:mm", { locale: pt })}` : null,
          ].filter(Boolean).join("\n")}
        >
          {deactivationReasonLabel(u.deactivationReason, u.deactivationReasonOther)}
        </p>
      )}
    </>
  );

  const lastAccess = (u: Row) =>
    u.loginMethod === "manual" ? "Nunca entrou" : u.lastSignedIn ? format(new Date(u.lastSignedIn), "dd MMM yyyy HH:mm", { locale: pt }) : "—";

  const actionsCell = (u: Row) => (
    <div className="flex items-center gap-1">
      {(manageable(u) || u.id === currentUser?.id) && (
        <Button variant="ghost" size="sm" onClick={() => openEdit(u)} className="h-8 w-8 p-0" title="Editar" aria-label="Editar">
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      )}
      {manageable(u) && u.loginMethod === "manual" && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => sendInviteMutation.mutate({ userId: u.id, origin: window.location.origin })}
          disabled={sendInviteMutation.isPending}
          className="h-8 w-8 p-0 text-blue-600 hover:text-blue-700"
          title="Enviar convite"
          aria-label="Enviar convite"
        >
          {sendInviteMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
        </Button>
      )}
      {canGrantPermissionsTo(myRole, u.role) && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setPermUser({ id: u.id, name: u.name ?? u.email ?? `#${u.id}` })}
          className="h-8 w-8 p-0"
          title="Permissões deste utilizador"
          aria-label="Permissões deste utilizador"
        >
          <KeyRound className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );

  const nameCell = (u: Row) => (
    <>
      <div className="flex items-center gap-1.5">
        {u.name ?? "Sem nome"}
        {u.id === currentUser?.id && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">Tu</Badge>
        )}
      </div>
      {u.loginMethod === "manual" && <span className="text-[10px] text-muted-foreground">Criado manualmente</span>}
    </>
  );

  const from = total === 0 ? 0 : page * filters.pageSize + 1;
  const to = Math.min(total, (page + 1) * filters.pageSize);

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          {onBack && (
            <Button variant="ghost" size="sm" onClick={onBack}>
              <ChevronLeft className="w-4 h-4 mr-1" /> Voltar
            </Button>
          )}
          <p className="text-sm text-muted-foreground">Criar, editar e gerir utilizadores da plataforma</p>
        </div>
        {canManageUsers && (
          <Button onClick={openCreate} className="gap-2">
            <Plus className="h-4 w-4" />
            Novo Utilizador
          </Button>
        )}
      </div>

      {/* Resumo — cada número é um atalho para o filtro correspondente */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { key: "all", label: "Total", value: summary?.total, icon: Users, tone: "bg-primary/10 text-primary", onClick: () => patchFilters({ status: "all", lastLogin: "all" }) },
          { key: "active", label: "Ativos", value: summary?.active, icon: UserCheck, tone: "bg-green-100 text-green-600", onClick: () => patchFilters({ status: "active" }) },
          { key: "inactive", label: "Inativos", value: summary?.inactive, icon: UserX, tone: "bg-red-100 text-red-600", onClick: () => patchFilters({ status: "inactive" }) },
          { key: "never", label: "Nunca entraram", value: summary?.neverLoggedIn, icon: Clock, tone: "bg-amber-100 text-amber-600", onClick: () => patchFilters({ lastLogin: "never" }) },
        ].map(({ key, label, value, icon: Icon, tone, onClick }) => (
          <button key={key} type="button" onClick={onClick} className="text-left">
            <Card className="hover:border-primary/50 transition-colors">
              <CardContent className="p-3 sm:p-4 flex items-center gap-3">
                <div className={`h-9 w-9 sm:h-10 sm:w-10 rounded-lg flex items-center justify-center shrink-0 ${tone}`}>
                  <Icon className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-xl sm:text-2xl font-bold">{value ?? "—"}</p>
                  <p className="text-xs text-muted-foreground truncate">{label}</p>
                </div>
              </CardContent>
            </Card>
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="p-3 sm:p-4 space-y-3">
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
              <Shield className="h-3.5 w-3.5" /> Por papel
            </p>
            <div className="flex flex-wrap gap-1.5">
              {ROLES.filter((r) => (summary?.byRole[r.value] ?? 0) > 0).map((r) => (
                <button
                  key={r.value}
                  type="button"
                  onClick={() => patchFilters({ role: filters.role === r.value ? "all" : r.value })}
                  className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full border ${r.color} ${filters.role === r.value ? "ring-2 ring-primary ring-offset-1" : ""}`}
                  aria-pressed={filters.role === r.value}
                >
                  {r.label} <span className="opacity-70">{summary?.byRole[r.value] ?? 0}</span>
                </button>
              ))}
              {!summary && <span className="text-xs text-muted-foreground">A carregar…</span>}
            </div>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
              <MapPin className="h-3.5 w-3.5" /> Por cidade (fichas RH ligadas)
            </p>
            <div className="flex flex-wrap gap-1.5">
              {[...CITY_KEYS.map((k) => ({ key: k as string, label: CITY_LABELS[k] })), { key: "none", label: "Sem cidade" }].map(({ key, label }) => (
                <Button
                  key={key}
                  size="sm"
                  variant={filters.city === key ? "default" : "outline"}
                  className="h-7 text-xs"
                  onClick={() => patchFilters({ city: filters.city === key ? "all" : key })}
                  aria-pressed={filters.city === key}
                >
                  {label}
                  <span className="ml-1 opacity-70">{summary?.byCity[key as keyof NonNullable<typeof summary>["byCity"]] ?? "—"}</span>
                </Button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Pesquisa + filtros */}
      <Card>
        <CardContent className="p-3 sm:p-4 space-y-3">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Pesquisar por nome, email ou ficha RH…"
                aria-label="Pesquisar utilizadores"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="pl-9 pr-8"
              />
              {searchInput && (
                <button
                  type="button"
                  aria-label="Limpar pesquisa"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setSearchInput("")}
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <Button variant="outline" className="shrink-0 gap-1.5" onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters}>
              <SlidersHorizontal className="h-4 w-4" />
              <span className="hidden sm:inline">Filtros</span>
              {activeFilterCount - (filters.search ? 1 : 0) > 0 && (
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">{activeFilterCount - (filters.search ? 1 : 0)}</Badge>
              )}
            </Button>
          </div>
          {showFilters && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              <Select value={filters.role} onValueChange={(v) => patchFilters({ role: v })}>
                <SelectTrigger aria-label="Filtrar por papel"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os papéis</SelectItem>
                  {ROLES.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={filters.city} onValueChange={(v) => patchFilters({ city: v })}>
                <SelectTrigger aria-label="Filtrar por cidade"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas as cidades</SelectItem>
                  {CITY_KEYS.map((k) => <SelectItem key={k} value={k}>{CITY_LABELS[k]}</SelectItem>)}
                  <SelectItem value="none">Sem cidade</SelectItem>
                </SelectContent>
              </Select>
              <Select value={filters.status} onValueChange={(v) => patchFilters({ status: v })}>
                <SelectTrigger aria-label="Filtrar por estado"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Ativos e inativos</SelectItem>
                  <SelectItem value="active">Só ativos</SelectItem>
                  <SelectItem value="inactive">Só inativos</SelectItem>
                </SelectContent>
              </Select>
              <Select value={filters.lastLogin} onValueChange={(v) => patchFilters({ lastLogin: v })}>
                <SelectTrigger aria-label="Filtrar por último acesso"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LAST_LOGIN_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={filters.employee} onValueChange={(v) => patchFilters({ employee: v })}>
                <SelectTrigger aria-label="Filtrar por ficha RH"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas as ligações RH</SelectItem>
                  <SelectItem value="with">Com ficha RH</SelectItem>
                  <SelectItem value="without">Sem ficha RH</SelectItem>
                </SelectContent>
              </Select>
              <Select value={filters.sort} onValueChange={(v) => patchFilters({ sort: v as DirFilters["sort"] })}>
                <SelectTrigger aria-label="Ordenar"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="recent">Ordenar: atividade mais recente</SelectItem>
                  <SelectItem value="name">Ordenar: nome (A–Z)</SelectItem>
                  <SelectItem value="created">Ordenar: criados mais recentemente</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {hasFilters && (
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{activeFilterCount} filtro{activeFilterCount === 1 ? "" : "s"} ativo{activeFilterCount === 1 ? "" : "s"} (lembrados neste browser)</span>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={clearFilters}>
                <X className="h-3.5 w-3.5 mr-1" /> Limpar filtros
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Resultados (paginados no servidor) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2 flex-wrap">
            <Shield className="h-4 w-4" />
            {hasFilters ? "Resultados" : filters.sort === "recent" ? "Atividade mais recente" : "Utilizadores"}
            <span className="text-sm font-normal text-muted-foreground">
              {total > 0 ? `${from}–${to} de ${total}` : ""}
            </span>
            {searchQ.isFetching && !isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          </CardTitle>
          {!hasFilters && (
            <p className="text-xs text-muted-foreground">
              Pesquisa ou escolhe um filtro (ou toca num número do resumo) para ver outras contas.
            </p>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : searchQ.error ? (
            <div className="flex flex-col items-center justify-center py-12 text-center px-4">
              <AlertCircle className="h-10 w-10 text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground">{searchQ.error.message}</p>
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <Users className="h-12 w-12 text-muted-foreground/20 mb-3" />
              <p className="text-muted-foreground text-sm">Nenhum utilizador encontrado</p>
              {hasFilters && (
                <Button variant="link" size="sm" onClick={clearFilters}>Limpar filtros</Button>
              )}
            </div>
          ) : (
            <>
              {/* Telemóvel: cartões */}
              <div className="md:hidden divide-y">
                {rows.map((u) => (
                  <div key={u.id} className={`p-3 space-y-2 ${!u.isActive ? "opacity-60" : ""}`}>
                    <div className="flex items-start gap-3">
                      <Avatar className="h-8 w-8 shrink-0">
                        <AvatarFallback className="text-xs font-semibold bg-primary/10 text-primary">
                          {u.name?.charAt(0).toUpperCase() ?? "?"}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-sm">{nameCell(u)}</div>
                        <p className="text-xs text-muted-foreground truncate">{u.email ?? "—"}</p>
                      </div>
                      {actionsCell(u)}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {roleCell(u)}
                      {u.department && (
                        <Badge variant="secondary" className="text-xs font-normal">
                          <Building2 className="h-3 w-3 mr-1" />
                          {u.department}
                        </Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>{statusCell(u)}</div>
                      <span className="text-[11px] text-muted-foreground">Último acesso: {lastAccess(u)}</span>
                    </div>
                    {u.employees.length > 0 && <UserEmployeeLinks employees={u.employees} />}
                  </div>
                ))}
              </div>

              {/* Desktop: tabela */}
              <div className="hidden md:block overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12"></TableHead>
                      <TableHead>Nome</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Ficha RH</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Departamento</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead>Último Acesso</TableHead>
                      <TableHead>Criado em</TableHead>
                      <TableHead className="text-right">Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((u) => (
                      <TableRow key={u.id} className={!u.isActive ? "opacity-50" : ""}>
                        <TableCell>
                          <Avatar className="h-8 w-8">
                            <AvatarFallback className="text-xs font-semibold bg-primary/10 text-primary">
                              {u.name?.charAt(0).toUpperCase() ?? "?"}
                            </AvatarFallback>
                          </Avatar>
                        </TableCell>
                        <TableCell className="font-medium">{nameCell(u)}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{u.email ?? "—"}</TableCell>
                        <TableCell><UserEmployeeLinks employees={u.employees} /></TableCell>
                        <TableCell>{roleCell(u)}</TableCell>
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
                        <TableCell>{statusCell(u)}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{lastAccess(u)}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {format(new Date(u.createdAt), "dd MMM yyyy", { locale: pt })}
                        </TableCell>
                        <TableCell className="text-right">{actionsCell(u)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Paginação */}
              <div className="flex items-center justify-between gap-2 flex-wrap border-t px-3 py-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>Por página</span>
                  <Select value={String(filters.pageSize)} onValueChange={(v) => patchFilters({ pageSize: Number(v) })}>
                    <SelectTrigger className="h-8 w-20 text-xs" aria-label="Utilizadores por página"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {PAGE_SIZES.map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="sm" className="h-8" disabled={page === 0 || searchQ.isFetching} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                    <ChevronLeft className="h-4 w-4" />
                    <span className="hidden sm:inline ml-1">Anterior</span>
                  </Button>
                  <span className="text-xs text-muted-foreground px-2">
                    Página {page + 1} de {pageCount}
                  </span>
                  <Button variant="outline" size="sm" className="h-8" disabled={page + 1 >= pageCount || searchQ.isFetching} onClick={() => setPage((p) => p + 1)}>
                    <span className="hidden sm:inline mr-1">Seguinte</span>
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Sugerir condutores (admin+): fichas com posto driver/senior_driver */}
      {roleRank(myRole) >= roleRank("admin") && <SuggestCondutoresCard />}

      {/* Role Legend */}
      <Card>
        <CardHeader className="pb-3">
          <button type="button" className="flex items-center justify-between w-full text-left" onClick={() => setShowLegend((v) => !v)} aria-expanded={showLegend}>
            <CardTitle className="text-base">Hierarquia de Roles</CardTitle>
            {showLegend ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
          </button>
        </CardHeader>
        {showLegend && <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {ROLES.map((r) => (
              <div key={r.value} className="flex flex-col gap-1 p-3 rounded-lg bg-muted/30 border">
                <RoleBadge role={r.value} />
                <p className="text-xs text-muted-foreground mt-1">
                  {r.value === "super_admin" && "Tudo: Faturação, Marketing, Logs, API Keys, qualquer papel"}
                  {r.value === "admin" && "Nacional: tudo do backoffice + Financeiro (sem Faturação, Marketing nem Logs)"}
                  {r.value === "backoffice" && "Nacional: o mesmo que o supervisor, em todas as cidades"}
                  {r.value === "frontoffice" && "Nacional: o mesmo que o backoffice, sem Permissões"}
                  {r.value === "supervisor" && "Cidade: tudo do team leader + utilizadores, permissões, resumo do dia"}
                  {r.value === "team_leader" && "Cidade: a sua equipa (condutores, extras), escala, casos"}
                  {r.value === "condutor" && "Próprio + despesas próprias, reservas e extras-dia da cidade"}
                  {r.value === "extra" && "Próprio: ficha, formação, tarefas, serviços pendentes, PDA"}
                  {r.value === "user" && "Apenas a própria ficha, formação e disponibilidade"}
                </p>
              </div>
            ))}
          </div>
        </CardContent>}
      </Card>

      {/* Permissões do utilizador */}
      {permUser && <UserPermissionsDialog user={permUser} onClose={() => setPermUser(null)} />}

      {/* Desativar: motivo + notas (opcionais) */}
      <DeactivationDialog
        open={!!deactivating}
        subjectName={deactivating?.name ?? ""}
        subjectKind="utilizador"
        effectNote="O acesso à plataforma é bloqueado imediatamente."
        pending={toggleActiveMutation.isPending}
        onOpenChange={(v) => { if (!v) setDeactivating(null); }}
        onConfirm={confirmDeactivation}
      />


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
            {editingUser && <div className="rounded-md border p-3 space-y-2">
              <p className="text-sm font-medium">Ficha RH</p>
              <UserEmployeeLinks employees={editingUser.employees ?? []} />
            </div>}
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
                  disabled={!!editingUser && !isSuperAdmin}
                  title={editingUser && !isSuperAdmin ? "Só o super_admin pode alterar o email de uma conta." : undefined}
                />
              </div>
            </div>
            {/* Role and Department only visible for super_admin editing others */}
            {(editingUser ? manageable(editingUser) : canManageUsers) && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Role</Label>
                <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {roleOptions.map((r) => (
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
                Podes alterar o teu nome. Para alterar email, role ou departamento, contacta um super admin.
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
  const { user: me } = useAuth();
  const setMut = trpc.permissions.setForUser.useMutation({
    onSuccess: () => {
      utils.permissions.forUser.invalidate({ userId: user.id });
      utils.permissions.assignments.invalidate();
      utils.permissions.myCityAccess.invalidate();
      utils.permissions.mine.invalidate();
      utils.rh.accountSummary.invalidate();
      utils.auth.me.invalidate();
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
                        disabled={setMut.isPending || !canTouchPermission(me?.role, p.id)}
                        title={canTouchPermission(me?.role, p.id) ? undefined : "Não podes dar nem retirar esta permissão."}
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
