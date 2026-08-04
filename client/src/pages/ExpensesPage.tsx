import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { RecurringExpensesDialog, CompareExpensesDialog } from "@/components/ExpenseRecurringCompare";
import { Separator } from "@/components/ui/separator";
import {
  Plus,
  Search,
  Camera,
  Loader2,
  Sparkles,
  Receipt,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Clock,
  XCircle,
  Eye,
  Pencil,
  Upload,
  FileDown,
  User,
  Euro,
  CreditCard,
  Banknote,
  ArrowUpDown,
  TrendingUp,
  Wallet,
  ArrowLeftRight,
  Repeat,
  FileText,
} from "lucide-react";
import { toast } from "sonner";
import { format, startOfWeek, endOfWeek, startOfMonth, endOfMonth } from "date-fns";
import { pt } from "date-fns/locale";
import { fileHref } from "@/lib/fileHref";
import DateRangeNav from "@/components/DateRangeNav";

const STATUS_CONFIG: Record<string, { label: string; icon: any; className: string }> = {
  pending: { label: "Pendente", icon: Clock, className: "bg-yellow-100 text-yellow-800 border-yellow-200" },
  paid: { label: "Pago", icon: CheckCircle2, className: "bg-green-100 text-green-800 border-green-200" },
  overdue: { label: "Em atraso", icon: AlertCircle, className: "bg-red-100 text-red-800 border-red-200" },
  cancelled: { label: "Cancelado", icon: XCircle, className: "bg-gray-100 text-gray-700 border-gray-200" },
};

function quickRangeDates(range: string): { start: string; end: string } {
  const now = new Date();
  if (range === "week") {
    return {
      start: format(startOfWeek(now, { weekStartsOn: 1 }), "yyyy-MM-dd"),
      end: format(endOfWeek(now, { weekStartsOn: 1 }), "yyyy-MM-dd"),
    };
  }
  if (range === "month") {
    return {
      start: format(startOfMonth(now), "yyyy-MM-dd"),
      end: format(endOfMonth(now), "yyyy-MM-dd"),
    };
  }
  return { start: "", end: "" };
}

const PAYMENT_LABELS: Record<string, string> = {
  cash: "Numerário",
  card: "Cartão",
  transfer: "Transferência",
  check: "Cheque",
  other: "Outro",
};

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.pending;
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border ${cfg.className}`}>
      <Icon className="h-3 w-3" />
      {cfg.label}
    </span>
  );
}

function fmtEur(v: number | string) {
  return parseFloat(String(v || 0)).toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
}

// ─── Hierarquia de projetos (Grupo → Cidade → Marca → Projeto) ─────────────
const LEVEL_LABEL: Record<string, string> = {
  group: "Grupo",
  city: "Cidade",
  brand: "Marca",
  project: "Projeto",
};
const LEVEL_COLOR: Record<string, string> = {
  group: "bg-violet-100 text-violet-700 border-violet-200",
  city: "bg-blue-100 text-blue-700 border-blue-200",
  brand: "bg-emerald-100 text-emerald-700 border-emerald-200",
  project: "bg-amber-100 text-amber-700 border-amber-200",
};

/** Devolve a lista de projetos ordenada hierarquicamente (pai antes dos
 * filhos) com `__depth` calculado para indentação no UI. */
function sortProjectsHierarchical<T extends { id: number; name: string; parentId?: number | null; level?: string | null }>(
  list: T[],
): Array<T & { __depth: number }> {
  const byParent = new Map<number | null, T[]>();
  for (const p of list) {
    const key = p.parentId ?? null;
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
  // Captura órfãos (parentId que não existe na lista)
  const seen = new Set(out.map((p) => p.id));
  for (const p of list) {
    if (!seen.has(p.id)) out.push({ ...p, __depth: 0 });
  }
  return out;
}

export default function ExpensesPage() {
  const { user } = useAuth();
  const filters = useGlobalFilters();
  const utils = trpc.useUtils();

  // Filters
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [filterCategory, setFilterCategory] = useState<string>("");
  const [filterProject, setFilterProject] = useState<string>("");
  const [filterUser, setFilterUser] = useState<string>("");

  // Sync global filter to local project filter
  useEffect(() => {
    if (filters.projectId !== undefined) {
      setFilterProject(String(filters.projectId));
    } else {
      setFilterProject("");
    }
  }, [filters.projectId]);
  // Por omissão mostra só a semana atual — o histórico completo vem por
  // pesquisa, pelo botão "Tudo" ou por datas manuais.
  const [startDate, setStartDate] = useState(() => quickRangeDates("week").start);
  const [endDate, setEndDate] = useState(() => quickRangeDates("week").end);
  const [quickRange, setQuickRange] = useState<string>("week");

  // Modals
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [detailExpense, setDetailExpense] = useState<any>(null);

  // Quick date range helpers
  const applyQuickRange = (range: string) => {
    setQuickRange(range);
    const { start, end } = quickRangeDates(range);
    setStartDate(start);
    setEndDate(end);
  };

  // Pesquisa com ≥3 caracteres alarga automaticamente a todo o histórico —
  // senão o default "semana atual" esconderia resultados antigos.
  const searchAllHistory = search.trim().length >= 3;
  const effectiveStartDate = searchAllHistory ? "" : startDate;
  const effectiveEndDate = searchAllHistory ? "" : endDate;

  // Matriz de permissões (Jorge, 2026-08-04): backoffice/team_leader só
  // INSEREM (modo input, sem lista/totais); supervisor vê as suas + as do
  // seu centro de custos (filtrado no servidor); admin+ vê tudo.
  const role = user?.role ?? "";
  const isInputOnly = ["backoffice", "team_leader"].includes(role);
  const canManage = ["admin", "super_admin"].includes(role);
  const canDelete = role === "super_admin";

  // Queries
  const { data: expensesList, isLoading } = trpc.expenses.list.useQuery({
    search: search || undefined,
    status: (filterStatus && filterStatus !== "all") ? filterStatus : undefined,
    categoryId: (filterCategory && filterCategory !== "all") ? parseInt(filterCategory) : undefined,
    projectId: (filterProject && filterProject !== "all") ? parseInt(filterProject) : undefined,
    userId: (filterUser && filterUser !== "all") ? parseInt(filterUser) : undefined,
    startDate: effectiveStartDate || undefined,
    endDate: effectiveEndDate || undefined,
  }, { enabled: !isInputOnly });
  const { data: categories } = trpc.categories.list.useQuery();
  const { data: projectsList } = trpc.projects.list.useQuery();
  const { data: employeesList } = trpc.rh.list.useQuery({});
  const { data: usersList } = trpc.users.list.useQuery();

  const deleteMutation = trpc.expenses.delete.useMutation({
    onSuccess: () => {
      toast.success("Despesa eliminada");
      utils.expenses.list.invalidate();
      utils.expenses.stats.invalidate();
    },
    onError: () => toast.error("Erro ao eliminar despesa"),
  });

  const updateMutation = trpc.expenses.update.useMutation({
    onSuccess: () => {
      toast.success("Estado atualizado");
      utils.expenses.list.invalidate();
      utils.expenses.stats.invalidate();
    },
  });

  const isAdmin = canManage;

  // KPI calculations
  const kpis = useMemo(() => {
    const items = expensesList ?? [];
    const total = items.reduce((s, e) => s + parseFloat(String(e.expense.amount ?? 0)), 0);
    const pending = items.filter(e => e.expense.status === "pending").reduce((s, e) => s + parseFloat(String(e.expense.amount ?? 0)), 0);
    const paid = items.filter(e => e.expense.status === "paid").reduce((s, e) => s + parseFloat(String(e.expense.amount ?? 0)), 0);
    const overdue = items.filter(e => e.expense.status === "overdue").reduce((s, e) => s + parseFloat(String(e.expense.amount ?? 0)), 0);
    return { total, pending, paid, overdue, count: items.length };
  }, [expensesList]);

  // Selected user name for KPI label
  const selectedUserName = useMemo(() => {
    if (!filterUser || filterUser === "all") return null;
    const uid = parseInt(filterUser);
    const u = usersList?.find(u => u.id === uid);
    return u?.name ?? null;
  }, [filterUser, usersList]);

  const exportMutation = trpc.expenses.exportExcel.useMutation({
    onSuccess: (data) => {
      const bytes = Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = data.filename;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Excel exportado com ${data.count} despesa(s)`);
    },
    onError: () => toast.error("Erro ao exportar Excel"),
  });

  const handleExport = () => {
    exportMutation.mutate({
      search: search || undefined,
      status: (filterStatus && filterStatus !== "all") ? filterStatus : undefined,
      categoryId: (filterCategory && filterCategory !== "all") ? parseInt(filterCategory) : undefined,
      projectId: (filterProject && filterProject !== "all") ? parseInt(filterProject) : undefined,
      userId: (filterUser && filterUser !== "all") ? parseInt(filterUser) : undefined,
      startDate: effectiveStartDate || undefined,
      endDate: effectiveEndDate || undefined,
    });
  };

  // Limpar volta ao default (semana atual), não ao histórico completo —
  // esse pede-se explicitamente com o botão "Tudo".
  const clearFilters = () => {
    setSearch("");
    setFilterStatus("");
    setFilterCategory("");
    setFilterProject("");
    setFilterUser("");
    applyQuickRange("week");
  };

  const defaultWeek = quickRangeDates("week");
  const hasFilters = Boolean(
    search || filterStatus || filterCategory || filterProject || filterUser ||
    startDate !== defaultWeek.start || endDate !== defaultWeek.end
  );

  const [showRecurring, setShowRecurring] = useState(false);
  const [showCompare, setShowCompare] = useState(false);
  // Auto-gera as despesas recorrentes do mês corrente (idempotente) ao abrir a página.
  const genRecurring = trpc.expenses.recurring.generateMonth.useMutation({
    onSuccess: (r) => { if (r.created > 0) { utils.expenses.list.invalidate(); utils.expenses.stats.invalidate(); toast.success(`${r.created} despesa(s) recorrente(s) lançada(s) este mês`); } },
  });
  useEffect(() => {
    // Só admins disparam a geração das recorrentes (o cron diário também o
    // faz — antes qualquer utilizador lançava as fixas em nome dele).
    if (!canManage) return;
    const now = new Date();
    genRecurring.mutate({ year: now.getFullYear(), month: now.getMonth() + 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          {!isInputOnly ? (
            <p className="text-sm text-muted-foreground">
              {kpis.count} despesa(s)
              {searchAllHistory
                ? " — a pesquisar em todo o histórico"
                : effectiveStartDate || effectiveEndDate
                  ? ` — ${effectiveStartDate ? format(new Date(`${effectiveStartDate}T00:00:00`), "dd MMM", { locale: pt }) : "…"} a ${effectiveEndDate ? format(new Date(`${effectiveEndDate}T00:00:00`), "dd MMM", { locale: pt }) : "…"}`
                  : " — todo o histórico"}
              {selectedUserName && <> de <strong>{selectedUserName}</strong></>}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">Registo de despesas</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {canManage && (
            <Button
              variant="outline"
              onClick={handleExport}
              disabled={exportMutation.isPending}
              className="gap-2"
            >
              {exportMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileDown className="h-4 w-4" />
              )}
              Exportar Excel
            </Button>
          )}
          {!isInputOnly && (
            <Button variant="outline" onClick={() => setShowCompare(true)} className="gap-2">
              <ArrowLeftRight className="h-4 w-4" /> Comparar
            </Button>
          )}
          {isAdmin && (
            <Button variant="outline" onClick={() => setShowRecurring(true)} className="gap-2">
              <Repeat className="h-4 w-4" /> Recorrentes
            </Button>
          )}
          <Button onClick={() => { setEditId(null); setShowForm(true); }} className="gap-2">
            <Plus className="h-4 w-4" />
            Nova Despesa
          </Button>
        </div>
      </div>

      {/* Modo "só input" (backoffice/team_leader): regista mas não vê nada */}
      {isInputOnly && (
        <Card className="p-8 text-center space-y-2">
          <Receipt className="h-10 w-10 mx-auto text-muted-foreground/40" />
          <p className="font-medium">Regista aqui as despesas com o botão "Nova Despesa"</p>
          <p className="text-sm text-muted-foreground">O teu perfil permite inserir despesas (com foto e extração automática); a consulta de listas e totais é reservada a supervisores e administração.</p>
        </Card>
      )}

      <RecurringExpensesDialog open={showRecurring} onClose={() => setShowRecurring(false)} categories={categories ?? []} projects={projectsList ?? []} />
      <CompareExpensesDialog open={showCompare} onClose={() => setShowCompare(false)} categories={categories ?? []} projectId={(filterProject && filterProject !== "all") ? parseInt(filterProject) : undefined} />

      {/* KPI Cards */}
      {!isInputOnly && (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Euro className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground font-medium">Total</p>
                <p className="text-lg font-bold">{fmtEur(kpis.total)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-yellow-100">
                <Clock className="h-5 w-5 text-yellow-700" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground font-medium">Pendente</p>
                <p className="text-lg font-bold text-yellow-700">{fmtEur(kpis.pending)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-100">
                <CheckCircle2 className="h-5 w-5 text-green-700" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground font-medium">Pago</p>
                <p className="text-lg font-bold text-green-700">{fmtEur(kpis.paid)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-red-100">
                <AlertCircle className="h-5 w-5 text-red-700" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground font-medium">Em Atraso</p>
                <p className="text-lg font-bold text-red-700">{fmtEur(kpis.overdue)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
      )}

      {/* Filters */}
      {!isInputOnly && (
      <Card>
        <CardContent className="pt-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="relative sm:col-span-2 lg:col-span-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Pesquisar fornecedor..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={filterStatus} onValueChange={setFilterStatus}>
              <SelectTrigger>
                <SelectValue placeholder="Estado" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os estados</SelectItem>
                <SelectItem value="pending">Pendente</SelectItem>
                <SelectItem value="paid">Pago</SelectItem>
                <SelectItem value="overdue">Em atraso</SelectItem>
                <SelectItem value="cancelled">Cancelado</SelectItem>
              </SelectContent>
            </Select>
            <Select value={filterCategory} onValueChange={setFilterCategory}>
              <SelectTrigger>
                <SelectValue placeholder="Categoria" />
              </SelectTrigger>
              <SelectContent>
                {[{ id: "all", name: "Todas as categorias" }, ...(categories ?? [])].map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filterProject} onValueChange={setFilterProject}>
              <SelectTrigger>
                <SelectValue placeholder="Centro de custos" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos (grupo / cidade / marca / projeto)</SelectItem>
                {sortProjectsHierarchical(projectsList ?? []).map((p: any) => (
                  <SelectItem key={p.id} value={String(p.id)}>
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
            {/* User filter (who inserted) */}
            <Select value={filterUser} onValueChange={setFilterUser}>
              <SelectTrigger>
                <SelectValue placeholder="Inserido por" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os utilizadores</SelectItem>
                {(usersList ?? []).filter(u => u.isActive).map((u) => (
                  <SelectItem key={u.id} value={String(u.id)}>{u.name ?? u.email ?? `#${u.id}`}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* Navegador de datas: granularidade + setas ◀ ▶ (componente transversal) */}
            <div className="flex gap-2 items-center sm:col-span-2 lg:col-span-3 flex-wrap">
              <DateRangeNav
                start={startDate}
                end={endDate}
                gran={(quickRange || "custom") as any}
                onChange={(s, e, g) => {
                  setStartDate(s);
                  setEndDate(e);
                  setQuickRange(!s && !e ? "" : g);
                }}
              />
              {hasFilters && (
                <Button variant="ghost" size="icon" onClick={clearFilters} title="Limpar filtros (volta à semana atual)">
                  <XCircle className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
      )}

      {/* Table */}
      {!isInputOnly && (
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : expensesList?.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Receipt className="h-12 w-12 text-muted-foreground/30 mb-4" />
              <p className="text-muted-foreground font-medium">Nenhuma despesa encontrada</p>
              {effectiveStartDate || effectiveEndDate ? (
                <Button variant="link" size="sm" className="mt-1" onClick={() => applyQuickRange("")}>
                  Procurar em todo o histórico
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground mt-1">Cria a primeira despesa com o botão acima</p>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fornecedor</TableHead>
                    <TableHead>Categoria</TableHead>
                    <TableHead>Projeto</TableHead>
                    <TableHead>Data</TableHead>
                    <TableHead>Pagamento</TableHead>
                    <TableHead>Comprador</TableHead>
                    <TableHead className="text-right">Valor</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead>Inserido por</TableHead>
                    <TableHead className="text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {expensesList?.map((row) => {
                    const { expense, category, project, insertedBy, buyer } = row;
                    return (
                      <TableRow
                        key={expense.id}
                        className="group cursor-pointer hover:bg-muted/50"
                        onClick={() => setDetailExpense(row)}
                      >
                        <TableCell>
                          <div className="font-medium text-foreground">{expense.supplier ?? "—"}</div>
                          {expense.description && (
                            <div className="text-xs text-muted-foreground truncate max-w-[180px]">{expense.description}</div>
                          )}
                        </TableCell>
                        <TableCell>
                          {category ? (
                            <span className="inline-flex items-center gap-1 text-xs">
                              <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: category.color ?? "#6366f1" }} />
                              {category.name}
                            </span>
                          ) : "—"}
                        </TableCell>
                        <TableCell className="text-sm">{project?.name ?? "—"}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {expense.expenseDate ? format(new Date(expense.expenseDate), "dd MMM yyyy", { locale: pt }) : "—"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {PAYMENT_LABELS[expense.paymentMethod ?? ""] ?? "—"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {buyer?.fullName ?? "—"}
                        </TableCell>
                        <TableCell className="text-right font-semibold">
                          {fmtEur(expense.amount)}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={expense.status} />
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{insertedBy?.name ?? "—"}</TableCell>
                        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
                            {(expense.invoiceImageUrl || expense.invoiceImageKey) && (
                              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => window.open(fileHref(expense.invoiceImageUrl, expense.invoiceImageKey) ?? undefined, "_blank")}>
                                <Eye className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            {canManage && expense.status !== "paid" && expense.status !== "cancelled" && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-green-600 hover:text-green-700"
                                title="Marcar como paga"
                                onClick={() => updateMutation.mutate({ id: expense.id, status: "paid" })}
                              >
                                <CheckCircle2 className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            {canManage && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => { setEditId(expense.id); setShowForm(true); }}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            {canDelete && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-destructive hover:text-destructive"
                                onClick={() => {
                                  if (confirm("Eliminar esta despesa?")) {
                                    deleteMutation.mutate({ id: expense.id });
                                  }
                                }}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            )}
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

      {/* Detail Sheet */}
      <ExpenseDetailSheet
        data={detailExpense}
        onClose={() => setDetailExpense(null)}
        onEdit={(id) => { setDetailExpense(null); setEditId(id); setShowForm(true); }}
      />

      {/* Form Modal */}
      {showForm && (
        <ExpenseFormModal
          editId={editId}
          categories={categories ?? []}
          projects={projectsList ?? []}
          employees={(employeesList ?? []).map((e: any) => e.employee).filter(Boolean)}
          onClose={() => { setShowForm(false); setEditId(null); }}
          onSuccess={() => {
            setShowForm(false);
            setEditId(null);
            utils.expenses.list.invalidate();
            utils.expenses.stats.invalidate();
          }}
        />
      )}
    </div>
  );
}

// ─── EXPENSE DETAIL SHEET ────────────────────────────────────────────────────

function ExpenseDetailSheet({
  data,
  onClose,
  onEdit,
}: {
  data: any;
  onClose: () => void;
  onEdit: (id: number) => void;
}) {
  if (!data) return null;
  const { expense, category, project, insertedBy, buyer } = data;

  return (
    <Sheet open={!!data} onOpenChange={() => onClose()}>
      <SheetContent className="sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Receipt className="h-5 w-5 text-primary" />
            Despesa #{expense.id}
          </SheetTitle>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          {/* Status + Amount */}
          <div className="flex items-center justify-between">
            <StatusBadge status={expense.status} />
            <span className="text-2xl font-bold">{fmtEur(expense.amount)}</span>
          </div>

          {/* Invoice Image */}
          {(expense.invoiceImageUrl || expense.invoiceImageKey) && (
            <div>
              <img
                src={fileHref(expense.invoiceImageUrl, expense.invoiceImageKey) ?? undefined}
                alt="Fatura"
                className="w-full max-h-48 object-contain rounded-lg border cursor-pointer"
                onClick={() => window.open(fileHref(expense.invoiceImageUrl, expense.invoiceImageKey) ?? undefined, "_blank")}
              />
            </div>
          )}

          <Separator />

          {/* Details Grid */}
          <div className="space-y-3">
            <DetailRow label="Fornecedor" value={expense.supplier} />
            <DetailRow label="Descrição" value={expense.description} />
            <DetailRow label="Categoria" value={category?.name} badge badgeColor={category?.color} />
            <DetailRow label="Projeto" value={project?.name} />
            <DetailRow label="Data da Despesa" value={expense.expenseDate ? format(new Date(expense.expenseDate), "dd MMMM yyyy", { locale: pt }) : null} />
            <DetailRow label="Data de Vencimento" value={expense.paymentDueDate ? format(new Date(expense.paymentDueDate), "dd MMMM yyyy", { locale: pt }) : null} />
            <DetailRow label="Pago em" value={expense.paidAt ? format(new Date(expense.paidAt), "dd MMMM yyyy", { locale: pt }) : null} />
            <DetailRow label="Método de Pagamento" value={PAYMENT_LABELS[expense.paymentMethod ?? ""] ?? null} />
            <DetailRow label="Moeda" value={expense.currency} />
            <DetailRow label="Comprador" value={buyer?.fullName} />
            <DetailRow label="Inserido por" value={insertedBy?.name} />
            {expense.notes && <DetailRow label="Notas" value={expense.notes} />}
            {expense.extractedByAi && (
              <div className="flex items-center gap-1 text-xs text-green-600">
                <Sparkles className="h-3 w-3" />
                Dados extraídos por IA
              </div>
            )}
            <DetailRow label="Criado em" value={expense.createdAt ? format(new Date(expense.createdAt), "dd MMM yyyy, HH:mm", { locale: pt }) : null} />
          </div>

          <Separator />

          <div className="flex gap-2">
            <Button variant="outline" className="flex-1 gap-2" onClick={() => onEdit(expense.id)}>
              <Pencil className="h-4 w-4" />
              Editar
            </Button>
            <Button variant="outline" onClick={onClose}>Fechar</Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function DetailRow({ label, value, badge, badgeColor }: { label: string; value?: string | null; badge?: boolean; badgeColor?: string | null }) {
  if (!value) return null;
  return (
    <div className="flex justify-between items-start gap-4">
      <span className="text-sm text-muted-foreground shrink-0">{label}</span>
      {badge ? (
        <span className="inline-flex items-center gap-1 text-sm font-medium">
          {badgeColor && <span className="h-2 w-2 rounded-full" style={{ backgroundColor: badgeColor }} />}
          {value}
        </span>
      ) : (
        <span className="text-sm font-medium text-right">{value}</span>
      )}
    </div>
  );
}

// ─── EXPENSE FORM MODAL ───────────────────────────────────────────────────────

interface FormData {
  supplier: string;
  description: string;
  amount: string;
  currency: string;
  paymentMethod: string;
  expenseDate: string;
  paymentDueDate: string;
  categoryId: string;
  projectId: string;
  buyerId: string;
  notes: string;
  invoiceImageUrl: string;
  invoiceImageKey: string;
  extractedByAi: boolean;
  status: string;
}

function ExpenseFormModal({
  editId,
  categories,
  projects,
  employees,
  onClose,
  onSuccess,
}: {
  editId: number | null;
  categories: any[];
  projects: any[];
  employees: any[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [scanning, setScanning] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [lastFileBase64, setLastFileBase64] = useState<string>("");
  const [lastFileMime, setLastFileMime] = useState<string>("");

  const [form, setForm] = useState<FormData>({
    supplier: "",
    description: "",
    amount: "",
    currency: "EUR",
    paymentMethod: "card",
    expenseDate: format(new Date(), "yyyy-MM-dd"),
    paymentDueDate: "",
    categoryId: "",
    projectId: "",
    buyerId: "",
    notes: "",
    invoiceImageUrl: "",
    invoiceImageKey: "",
    extractedByAi: false,
    status: "pending",
  });

  // Load existing data when editing
  const { data: existingExpense, isLoading: loadingExisting } = trpc.expenses.byId.useQuery(
    { id: editId! },
    { enabled: !!editId }
  );

  // Pre-fill form when editing — em useEffect para evitar setState durante render
  const [prefilled, setPrefilled] = useState(false);
  useEffect(() => {
    if (!editId || !existingExpense || prefilled) return;
    const e = existingExpense.expense;
    setForm({
      supplier: e.supplier ?? "",
      description: e.description ?? "",
      amount: String(e.amount ?? ""),
      currency: e.currency ?? "EUR",
      paymentMethod: e.paymentMethod ?? "card",
      expenseDate: e.expenseDate ? format(new Date(e.expenseDate), "yyyy-MM-dd") : "",
      paymentDueDate: e.paymentDueDate ? format(new Date(e.paymentDueDate), "yyyy-MM-dd") : "",
      categoryId: e.categoryId ? String(e.categoryId) : "",
      projectId: e.projectId ? String(e.projectId) : "",
      buyerId: e.buyerId ? String(e.buyerId) : "",
      notes: e.notes ?? "",
      invoiceImageUrl: e.invoiceImageUrl ?? "",
      invoiceImageKey: e.invoiceImageKey ?? "",
      extractedByAi: Boolean(e.extractedByAi),
      status: e.status ?? "pending",
    });
    if (e.invoiceImageUrl) setPreviewUrl(e.invoiceImageUrl);
    setPrefilled(true);
  }, [editId, existingExpense, prefilled]);

  const set = (key: keyof FormData, value: string | boolean) =>
    setForm((f) => ({ ...f, [key]: value }));

  const createMutation = trpc.expenses.create.useMutation({
    onSuccess,
    onError: (e) => toast.error("Erro ao criar despesa: " + e.message),
  });

  const updateMutation = trpc.expenses.update.useMutation({
    onSuccess,
    onError: (e) => toast.error("Erro ao atualizar despesa: " + e.message),
  });

  const uploadMutation = trpc.expenses.uploadInvoice.useMutation();
  const extractMutation = trpc.expenses.extractFromImage.useMutation();

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);

    setUploading(true);
    try {
      // Fotos de telemóvel (8-12MB) rebentavam no limite de ~4.5MB do Vercel
      // (base64 em JSON ainda infla 33%) — comprimir imagens para 1600px/q0.85
      // antes de enviar. PDFs seguem como estão, mas com aviso se enormes.
      let uploadFile = file;
      if (!isPdf && file.type.startsWith("image/") && file.size > 1_500_000) {
        uploadFile = await compressImage(file, 1600, 0.85);
      }
      if (uploadFile.size > 3_200_000) {
        toast.error("Ficheiro demasiado grande (máx ~3MB depois de comprimido)", {
          description: isPdf ? "Tenta um PDF mais pequeno ou fotografa a fatura." : undefined,
        });
        setUploading(false);
        return;
      }
      const base64 = await fileToBase64(uploadFile);

      if (isPdf) {
        // Converte para imagem (preview + OCR); o PDF original é o que fica guardado.
        const pngDataUrl = await pdfToPngDataUrl(file);
        setPreviewUrl(pngDataUrl);
        setLastFileBase64(pngDataUrl.split(",")[1]);
        setLastFileMime("image/png");
      } else {
        const reader = new FileReader();
        reader.onload = (ev) => setPreviewUrl(ev.target?.result as string);
        reader.readAsDataURL(uploadFile);
        setLastFileBase64(base64);
        setLastFileMime(uploadFile.type);
      }

      const result = await uploadMutation.mutateAsync({
        fileName: file.name,
        fileBase64: base64,
        mimeType: uploadFile.type || (isPdf ? "application/pdf" : "application/octet-stream"),
      });
      set("invoiceImageUrl", result.url);
      set("invoiceImageKey", result.key);
      toast.success(isPdf ? "PDF carregado — pronto para extrair com IA!" : "Fatura carregada com sucesso!");
    } catch {
      toast.error("Erro ao carregar a fatura");
    } finally {
      setUploading(false);
    }
  }, [uploadMutation]);

  const handleExtract = async () => {
    if (!lastFileBase64) return;
    setScanning(true);
    try {
      const data = await extractMutation.mutateAsync({ imageBase64: lastFileBase64, mimeType: lastFileMime || "image/jpeg" });
      // Fatura emitida pela PRÓPRIA Multipark (venda a cliente) — não é uma
      // despesa; avisa antes que alguém a registe como tal.
      if ((data as any).selfInvoice) {
        toast.warning("Atenção: esta fatura parece EMITIDA pela Multipark a um cliente", {
          description: `Emitente: ${data.supplier ?? "?"} · Cliente: ${(data as any).customerName ?? "?"} — isto é uma venda, não uma despesa. Confirma antes de gravar.`,
          duration: 10000,
        });
      }
      if (data.supplier) set("supplier", data.supplier);
      if (data.description) set("description", data.description);
      if (data.amount) set("amount", data.amount);
      if (data.currency) set("currency", data.currency);
      if (data.paymentMethod && ["cash","card","transfer","check","other"].includes(data.paymentMethod)) {
        set("paymentMethod", data.paymentMethod);
      }
      if (data.expenseDate) set("expenseDate", data.expenseDate);
      if (data.paymentDueDate) set("paymentDueDate", data.paymentDueDate);
      // Categoria sugerida pela IA — mapeia por nome (case-insensitive).
      const suggested = (data as any).suggestedCategory;
      if (suggested && !form.categoryId) {
        const cat = categories.find((c: any) => c.name?.toLowerCase() === String(suggested).toLowerCase());
        if (cat) set("categoryId", String(cat.id));
      }
      // NIF / nº de fatura vão para as notas (não há colunas próprias ainda).
      const extras: string[] = [];
      if ((data as any).nif) extras.push(`NIF: ${(data as any).nif}`);
      if ((data as any).invoiceNumber) extras.push(`Fatura nº: ${(data as any).invoiceNumber}`);
      if (extras.length && !form.notes?.includes("NIF:")) {
        set("notes", [form.notes, extras.join(" · ")].filter(Boolean).join("\n"));
      }
      set("extractedByAi", true);
      toast.success("Dados extraídos com IA!", { description: "Verifica e corrige se necessário." });
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : "erro desconhecido";
      toast.error("Não foi possível extrair dados da fatura", { description: msg.slice(0, 200) });
      console.error("[extractFromImage]", e);
    } finally {
      setScanning(false);
    }
  };

  const handleSubmit = () => {
    if (!form.amount || !form.expenseDate) {
      toast.error("Valor e data são obrigatórios");
      return;
    }
    if (!form.projectId) {
      toast.error("Tens de associar a despesa a um centro de custos (grupo / cidade / marca / projeto)");
      return;
    }
    const sanitize = (v: string) => (!v || v === 'null' || v === 'undefined' ? undefined : v);

    if (editId) {
      updateMutation.mutate({
        id: editId,
        supplier: sanitize(form.supplier),
        description: sanitize(form.description),
        amount: form.amount,
        paymentMethod: (form.paymentMethod && ['cash','card','transfer','check','other'].includes(form.paymentMethod)) ? form.paymentMethod as any : undefined,
        expenseDate: form.expenseDate,
        paymentDueDate: sanitize(form.paymentDueDate),
        categoryId: form.categoryId ? parseInt(form.categoryId) : undefined,
        projectId: parseInt(form.projectId),
        buyerId: (form.buyerId && form.buyerId !== "none") ? parseInt(form.buyerId) : null,
        status: form.status as any,
        notes: form.notes || undefined,
        // Se trocou a fatura, envia a nova (o servidor apaga a antiga).
        invoiceImageUrl: form.invoiceImageUrl || null,
        invoiceImageKey: form.invoiceImageKey || null,
      });
    } else {
      createMutation.mutate({
        supplier: sanitize(form.supplier),
        description: sanitize(form.description),
        amount: form.amount,
        currency: form.currency || 'EUR',
        paymentMethod: (form.paymentMethod && ['cash','card','transfer','check','other'].includes(form.paymentMethod)) ? form.paymentMethod as any : undefined,
        expenseDate: form.expenseDate,
        paymentDueDate: sanitize(form.paymentDueDate),
        categoryId: form.categoryId ? parseInt(form.categoryId) : undefined,
        projectId: parseInt(form.projectId),
        buyerId: (form.buyerId && form.buyerId !== "none") ? parseInt(form.buyerId) : undefined,
        notes: form.notes || undefined,
        invoiceImageUrl: form.invoiceImageUrl || undefined,
        invoiceImageKey: form.invoiceImageKey || undefined,
        extractedByAi: form.extractedByAi,
      });
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  if (editId && loadingExisting) {
    return (
      <Dialog open onOpenChange={onClose}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>A carregar...</DialogTitle>
          </DialogHeader>
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={onClose}>
      {/* flex-col + corpo com overflow próprio: o footer fica sempre visível e nada sai do ecrã */}
      <DialogContent className="max-w-3xl w-[calc(100vw-2rem)] max-h-[92vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Receipt className="h-5 w-5 text-primary" />
            {editId ? "Editar Despesa" : "Nova Despesa"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5 flex-1 min-h-0 overflow-y-auto pr-1">
          {/* Invoice Upload */}
          <div className="border-2 border-dashed border-border rounded-xl p-4 bg-muted/30">
            <div className="flex flex-col sm:flex-row gap-4 items-start">
              {previewUrl ? (
                <div className="relative shrink-0">
                  {/\.pdf(\?|$)/i.test(previewUrl) ? (
                    // PDF guardado (ao editar): não dá para mostrar em <img>, mostra link
                    <a
                      href={previewUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="h-32 w-32 rounded-lg border shadow-sm flex flex-col items-center justify-center gap-2 bg-muted/50 hover:bg-muted transition-colors"
                    >
                      <FileText className="h-8 w-8 text-muted-foreground" />
                      <span className="text-xs text-muted-foreground">Ver PDF</span>
                    </a>
                  ) : (
                    <img src={previewUrl} alt="Fatura" className="h-32 w-32 object-cover rounded-lg border shadow-sm" />
                  )}
                  {uploading && (
                    <div className="absolute inset-0 bg-black/50 rounded-lg flex items-center justify-center">
                      <Loader2 className="h-6 w-6 animate-spin text-white" />
                    </div>
                  )}
                </div>
              ) : (
                <div
                  className="h-32 w-32 rounded-xl border-2 border-dashed border-muted-foreground/30 flex flex-col items-center justify-center gap-2 cursor-pointer hover:border-primary/50 hover:bg-primary/5 transition-colors shrink-0"
                  onClick={() => cameraInputRef.current?.click()}
                >
                  <Camera className="h-8 w-8 text-muted-foreground/50" />
                  <span className="text-xs text-muted-foreground text-center px-2">Tirar foto</span>
                </div>
              )}

              <div className="flex flex-col gap-2 flex-1">
                <p className="text-sm font-medium">Fatura / Recibo</p>
                <p className="text-xs text-muted-foreground">
                  Carrega uma imagem ou PDF da fatura e usa a IA para extrair os dados automaticamente.
                </p>
                <div className="flex flex-wrap gap-2 mt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => cameraInputRef.current?.click()}
                    disabled={uploading}
                    className="gap-1.5"
                  >
                    <Camera className="h-3.5 w-3.5" />
                    Tirar Foto
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    className="gap-1.5"
                  >
                    <Upload className="h-3.5 w-3.5" />
                    {previewUrl ? "Substituir" : "Carregar"}
                  </Button>
                  {form.invoiceImageUrl && (
                    <Button
                      size="sm"
                      onClick={handleExtract}
                      disabled={scanning || uploading}
                      className="gap-1.5 bg-accent text-accent-foreground hover:bg-accent/90"
                    >
                      {scanning ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5" />
                      )}
                      {scanning ? "A extrair..." : "Extrair com IA"}
                    </Button>
                  )}
                </div>
                {form.extractedByAi && (
                  <p className="text-xs text-green-600 flex items-center gap-1">
                    <Sparkles className="h-3 w-3" /> Dados extraídos por IA — verifica antes de guardar
                  </p>
                )}
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,application/pdf,.pdf"
              className="hidden"
              onChange={handleFileChange}
            />
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>

          {/* Secção 1: dados que vêm da fatura */}
          <div className="space-y-3">
            <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Dados da fatura</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Fornecedor</Label>
              <Input
                placeholder="Nome do fornecedor"
                value={form.supplier}
                onChange={(e) => set("supplier", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Valor ({form.currency}) *</Label>
              <Input
                type="number"
                step="0.01"
                placeholder="0.00"
                value={form.amount}
                onChange={(e) => set("amount", e.target.value)}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Descrição</Label>
              <Textarea
                placeholder="Descrição dos produtos/serviços"
                value={form.description}
                onChange={(e) => set("description", e.target.value)}
                rows={2}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Data da Despesa *</Label>
              <Input
                type="date"
                value={form.expenseDate}
                onChange={(e) => set("expenseDate", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Data de Vencimento</Label>
              <Input
                type="date"
                value={form.paymentDueDate}
                onChange={(e) => set("paymentDueDate", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Método de Pagamento</Label>
              <Select value={form.paymentMethod} onValueChange={(v) => set("paymentMethod", v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Numerário</SelectItem>
                  <SelectItem value="card">Cartão</SelectItem>
                  <SelectItem value="transfer">Transferência</SelectItem>
                  <SelectItem value="check">Cheque</SelectItem>
                  <SelectItem value="other">Outro</SelectItem>
                </SelectContent>
              </Select>
            </div>
            </div>
          </div>

          {/* Secção 2: classificação interna */}
          <div className="space-y-3">
            <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Classificação</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Categoria</Label>
              <Select value={form.categoryId} onValueChange={(v) => set("categoryId", v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecionar categoria" />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      <span className="flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: c.color }} />
                        {c.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1">
                Centro de custos *
                <span className="text-xs text-muted-foreground font-normal">(Grupo / Cidade / Marca / Projeto)</span>
              </Label>
              <Select value={form.projectId} onValueChange={(v) => set("projectId", v)}>
                <SelectTrigger className={!form.projectId ? "border-amber-400" : undefined}>
                  <SelectValue placeholder="Escolher centro de custos..." />
                </SelectTrigger>
                <SelectContent>
                  {sortProjectsHierarchical(projects).map((p: any) => (
                    <SelectItem key={p.id} value={String(p.id)}>
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
              <p className="text-xs text-muted-foreground">
                Esta despesa vai entrar nos custos deste centro <em>e</em> de todos os pais (rollup automático).
              </p>
            </div>
            {/* Buyer / Employee */}
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1">
                <User className="h-3.5 w-3.5" />
                Funcionário (quem comprou)
              </Label>
              <Select value={form.buyerId} onValueChange={(v) => set("buyerId", v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecionar funcionário" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Nenhum</SelectItem>
                  {employees.map((emp: any) => (
                    <SelectItem key={emp.id} value={String(emp.id)}>{emp.fullName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {/* Status (only on edit) */}
            {editId && (
              <div className="space-y-1.5">
                <Label>Estado</Label>
                <Select value={form.status} onValueChange={(v) => set("status", v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pending">Pendente</SelectItem>
                    <SelectItem value="paid">Pago</SelectItem>
                    <SelectItem value="overdue">Em atraso</SelectItem>
                    <SelectItem value="cancelled">Cancelado</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Notas</Label>
            <Textarea
              placeholder="Notas adicionais..."
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              rows={2}
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button
            onClick={handleSubmit}
            disabled={isPending || uploading}
            className="gap-2"
          >
            {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {editId ? "Guardar Alterações" : "Guardar Despesa"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Reduz fotos grandes antes do upload: o limite de body da Vercel (~4.5MB)
// rebenta com fotos de telemóvel em base64 (+33%). Redimensiona para maxDim
// e re-encoda em JPEG; se falhar (formato exótico), devolve o original.
async function compressImage(file: File, maxDim = 1600, quality = 0.85): Promise<File> {
  try {
    const dataUrl: string = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = dataUrl;
    });
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality)
    );
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

// Converte as primeiras páginas de um PDF numa única imagem PNG (empilhadas
// na vertical) para o preview e o OCR por IA. pdf.js é importado on-demand
// para não pesar no bundle de quem nunca carrega PDFs.
async function pdfToPngDataUrl(file: File, maxPages = 2): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;

  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = Math.min(pdf.numPages, maxPages);
  const canvases: HTMLCanvasElement[] = [];
  for (let i = 1; i <= pages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2 }); // A4 → ~1190×1684, bom para OCR
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d")!, viewport } as any).promise;
    canvases.push(canvas);
  }
  if (canvases.length === 1) return canvases[0].toDataURL("image/png");
  const out = document.createElement("canvas");
  out.width = Math.max(...canvases.map((c) => c.width));
  out.height = canvases.reduce((s, c) => s + c.height, 0);
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  let y = 0;
  for (const c of canvases) { ctx.drawImage(c, 0, y); y += c.height; }
  return out.toDataURL("image/png");
}
