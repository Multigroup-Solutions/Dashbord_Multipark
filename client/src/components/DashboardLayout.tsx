import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getLoginUrl } from "@/const";
import { useIsMobile } from "@/hooks/useMobile";
import {
  BarChart3,
  Receipt,
  FolderTree,
  LayoutDashboard,
  ListTodo,
  FileText,
  Handshake,
  CalendarDays,
  UserCheck,
  Users,
  Trophy,
  GraduationCap,
  Truck,
  Megaphone,
  ParkingCircle,
  Wrench,
  MessageSquareWarning,
  Star,
  AlertTriangle,
  Package,
  Key,
  ScrollText,
  LogOut,
  PanelLeft,
  Building2,
  ChevronDown,
  ArrowDownToLine,
  ArrowUpFromLine,
  XCircle,
  RefreshCw,
  CalendarCheck,
  SlidersHorizontal,
  Bell,
  Home,
  Calendar,
  X,
} from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { CSSProperties, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from "./DashboardLayoutSkeleton";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";

type MenuItem = {
  icon: React.ElementType;
  label: string;
  path: string;
  minRole?: string;
};

type MenuGroup = {
  label: string;
  items: MenuItem[];
  minRole?: string;
};

const ROLE_HIERARCHY: Record<string, number> = {
  user: 0,
  extra: 1,
  frontoffice: 2,
  backoffice: 3,
  team_leader: 4,
  supervisor: 5,
  admin: 6,
  super_admin: 7,
};

function hasRole(userRole: string, minRole: string): boolean {
  return (ROLE_HIERARCHY[userRole] ?? 0) >= (ROLE_HIERARCHY[minRole] ?? 0);
}

function getFilteredMenuGroups(userRole: string): MenuGroup[] {
  return menuGroups
    .filter(g => !g.minRole || hasRole(userRole, g.minRole))
    .map(g => ({
      ...g,
      items: g.items.filter(i => !i.minRole || hasRole(userRole, i.minRole)),
    }))
    .filter(g => g.items.length > 0);
}

const menuGroups: MenuGroup[] = [
  {
    label: "Geral",
    minRole: "frontoffice",
    items: [
      { icon: Home, label: "Dashboard", path: "/dashboard" },
      { icon: BarChart3, label: "Financeiro", path: "/financeiro" },
      { icon: BarChart3, label: "Operações", path: "/operacoes-dashboard" },
      { icon: BarChart3, label: "Pessoas", path: "/pessoas-dashboard" },
      { icon: BarChart3, label: "Suporte", path: "/suporte-dashboard" },
      { icon: BarChart3, label: "Marketing", path: "/marketing-dashboard" },
    ],
  },
  {
    label: "Financeiro",
    minRole: "frontoffice",
    items: [
      { icon: Receipt, label: "Despesas", path: "/despesas" },
      { icon: FolderTree, label: "Projetos", path: "/projetos" },
      { icon: LayoutDashboard, label: "Custos Projetos", path: "/projetos/custos" },
      { icon: ListTodo, label: "Tarefas", path: "/tarefas" },
      { icon: FileText, label: "Faturação", path: "/faturacao" },
      { icon: Handshake, label: "Parcerias", path: "/parcerias" },
      { icon: CalendarDays, label: "Anual", path: "/anual" },
    ],
  },
  {
    label: "Pessoas",
    items: [
      { icon: UserCheck, label: "Recursos Humanos", path: "/rh" },
      { icon: Users, label: "Utilizadores", path: "/utilizadores", minRole: "admin" },
      { icon: Trophy, label: "Avaliação", path: "/avaliacao", minRole: "frontoffice" },
      { icon: GraduationCap, label: "Formação", path: "/formacao" },
    ],
  },
  {
    label: "Operações",
    minRole: "frontoffice",
    items: [
      { icon: Truck, label: "Operacional", path: "/operacional" },
      { icon: Megaphone, label: "Marketing", path: "/marketing" },
      { icon: CalendarCheck, label: "Reservas", path: "/multipark/reservas" },
      { icon: ArrowDownToLine, label: "Entradas", path: "/multipark/entradas" },
      { icon: ArrowUpFromLine, label: "Saídas", path: "/multipark/saidas" },
      { icon: XCircle, label: "Cancelados", path: "/multipark/cancelados" },
      { icon: RefreshCw, label: "Sincronização", path: "/multipark/sync" },
      { icon: Wrench, label: "Serviços", path: "/servicos" },
    ],
  },
  {
    label: "Suporte",
    minRole: "frontoffice",
    items: [
      { icon: MessageSquareWarning, label: "Reclamações", path: "/reclamacoes" },
      { icon: Star, label: "Críticas Google", path: "/criticas" },
      { icon: AlertTriangle, label: "Ocorrências", path: "/ocorrencias" },
      { icon: Package, label: "Perdidos e Achados", path: "/perdidos-achados" },
    ],
  },
  {
    label: "Sistema",
    minRole: "admin",
    items: [
      { icon: Key, label: "API Keys", path: "/api-keys" },
      { icon: ScrollText, label: "Logs", path: "/logs" },
    ],
  },
];

const allMenuItems = menuGroups.flatMap(g => g.items);
const allMenuPaths = new Set(allMenuItems.map(i => i.path));

const SIDEBAR_WIDTH_KEY = "sidebar-width";
const DEFAULT_WIDTH = 280;
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
      const parsed = saved ? parseInt(saved, 10) : NaN;
      return Number.isFinite(parsed) ? parsed : DEFAULT_WIDTH;
    } catch {
      return DEFAULT_WIDTH;
    }
  });
  const { loading, user } = useAuth();

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
    } catch {
      /* storage indisponível (modo privado/disco cheio) — ignora */
    }
  }, [sidebarWidth]);

  if (loading) {
    return <DashboardLayoutSkeleton />;
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center gap-8 p-8 max-w-md w-full">
          <div className="flex flex-col items-center gap-6">
            <h1 className="text-2xl font-semibold tracking-tight text-center">
              Iniciar sessão
            </h1>
            <p className="text-sm text-muted-foreground text-center max-w-sm">
              É necessário autenticação para aceder ao painel. Clique para continuar.
            </p>
          </div>
          <Button
            onClick={() => {
              window.location.href = getLoginUrl();
            }}
            size="lg"
            className="w-full shadow-lg hover:shadow-xl transition-all"
          >
            Entrar com Google
          </Button>
        </div>
      </div>
    );
  }

  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
        } as CSSProperties
      }
    >
      <DashboardLayoutContent setSidebarWidth={setSidebarWidth}>
        {children}
      </DashboardLayoutContent>
    </SidebarProvider>
  );
}

type DashboardLayoutContentProps = {
  children: React.ReactNode;
  setSidebarWidth: (width: number) => void;
};

function DashboardLayoutContent({
  children,
  setSidebarWidth,
}: DashboardLayoutContentProps) {
  const { user, logout } = useAuth();
  const [location, setLocation] = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === "collapsed";
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const userRole = user?.role ?? "user";
  const filteredGroups = getFilteredMenuGroups(userRole);
  const filteredItems = filteredGroups.flatMap(g => g.items);
  const activeMenuItem = allMenuItems.find(item => item.path === location);
  const isMobile = useIsMobile();

  // Redirect extra/user to allowed page if on restricted route
  useEffect(() => {
    if (!user) return;
    const allowedPaths = new Set(filteredItems.map(i => i.path));
    if (allMenuPaths.has(location) && !allowedPaths.has(location)) {
      setLocation(filteredItems[0]?.path ?? "/formacao");
    }
  }, [location, user, filteredItems]);
  const filters = useGlobalFilters();

  useEffect(() => {
    if (isCollapsed) {
      setIsResizing(false);
    }
  }, [isCollapsed]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;

      const sidebarLeft = sidebarRef.current?.getBoundingClientRect().left ?? 0;
      const newWidth = e.clientX - sidebarLeft;
      if (newWidth >= MIN_WIDTH && newWidth <= MAX_WIDTH) {
        setSidebarWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, setSidebarWidth]);

  const hasDateFilter = filters.dateRange.from || filters.dateRange.to;

  return (
    <>
      <div className="relative" ref={sidebarRef}>
        <Sidebar
          collapsible="icon"
          className="border-r"
          disableTransition={isResizing}
        >
          <SidebarHeader className="h-20 justify-center border-b">
            <div className="flex items-center gap-3 px-3 transition-all w-full">
              <button
                onClick={toggleSidebar}
                className="h-8 w-8 flex items-center justify-center hover:bg-accent rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0"
                aria-label="Expandir ou colapsar navegação"
              >
                <PanelLeft className="h-4 w-4 text-muted-foreground" />
              </button>
              {!isCollapsed ? (
                <div className="flex flex-col gap-0.5 min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="h-6 w-6 rounded-md flex items-center justify-center" style={{ backgroundColor: '#1E5BFF' }}>
                      <ParkingCircle className="h-4 w-4 text-white" />
                    </div>
                    <span className="font-extrabold tracking-tight truncate text-foreground text-lg leading-none">
                      MULTIPARK
                    </span>
                  </div>
                  <span className="ml-8 inline-flex w-fit items-center rounded-md bg-[#E6EEFF] px-1.5 py-0.5 text-[10px] font-bold tracking-widest text-[#1E5BFF]">
                    {user?.role === "super_admin" || user?.role === "admin" ? "ADMIN" : "AGENTE"}
                  </span>
                </div>
              ) : null}
            </div>
          </SidebarHeader>

          <SidebarContent className="gap-0">
            {filteredGroups.map(group => {
              const hasActiveItem = group.items.some(item => item.path === location);
              return (
                <Collapsible key={group.label} defaultOpen={hasActiveItem || group.label === "Geral" || group.label === "Financeiro"} className="group/collapsible">
                  <SidebarGroup>
                    <SidebarGroupLabel asChild>
                      <CollapsibleTrigger className="flex w-full items-center justify-between [&[data-state=open]>svg]:rotate-180">
                        {group.label}
                        <ChevronDown className="h-4 w-4 transition-transform duration-200" />
                      </CollapsibleTrigger>
                    </SidebarGroupLabel>
                    <CollapsibleContent>
                      <SidebarGroupContent>
                        <SidebarMenu>
                          {group.items.map(item => {
                            const isActive = location === item.path;
                            return (
                              <SidebarMenuItem key={item.path}>
                                <SidebarMenuButton
                                  isActive={isActive}
                                  onClick={() => setLocation(item.path)}
                                  tooltip={item.label}
                                  className="h-9 transition-all font-normal"
                                >
                                  <item.icon
                                    className={`h-4 w-4 ${isActive ? "text-primary" : ""}`}
                                  />
                                  <span>{item.label}</span>
                                </SidebarMenuButton>
                              </SidebarMenuItem>
                            );
                          })}
                        </SidebarMenu>
                      </SidebarGroupContent>
                    </CollapsibleContent>
                  </SidebarGroup>
                </Collapsible>
              );
            })}
          </SidebarContent>
        </Sidebar>
        <div
          className={`absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/20 transition-colors ${isCollapsed ? "hidden" : ""}`}
          onMouseDown={() => {
            if (isCollapsed) return;
            setIsResizing(true);
          }}
          style={{ zIndex: 50 }}
        />
      </div>

      <SidebarInset>
        {/* Topbar */}
        <div className="flex border-b h-[76px] items-center justify-between bg-card px-4 lg:px-6 sticky top-0 z-40">
          <div className="flex items-center gap-3 min-w-0">
            {isMobile && (
              <SidebarTrigger className="h-9 w-9 rounded-lg bg-background" />
            )}
            {location !== "/dashboard" && (
              <button
                onClick={() => setLocation("/dashboard")}
                className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Voltar ao menu"
              >
                <span aria-hidden>←</span> Voltar
              </button>
            )}
            <h1 className="text-xl lg:text-2xl font-bold text-foreground truncate">
              {activeMenuItem?.label ?? "Backoffice"}
            </h1>
          </div>

          <div className="flex items-center gap-2 lg:gap-3">
            {/* City filter */}
            <Select
              value={filters.cityId === null ? "all" : String(filters.cityId)}
              onValueChange={(v) => filters.setCityId(v === "all" ? null : Number(v))}
            >
              <SelectTrigger className="hidden md:flex h-10 w-[140px] rounded-lg">
                <SelectValue placeholder="Cidade" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas as cidades</SelectItem>
                {filters.cities.map((city) => (
                  <SelectItem key={city.id} value={String(city.id)}>
                    {city.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Brand/Park filter */}
            <Select
              value={filters.brandId === null ? "all" : String(filters.brandId)}
              onValueChange={(v) => filters.setBrandId(v === "all" ? null : Number(v))}
            >
              <SelectTrigger className="hidden md:flex h-10 w-[170px] rounded-lg">
                <SelectValue
                  placeholder={`${filters.brands.length} Estacionamentos`}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{filters.brands.length} Estacionamentos</SelectItem>
                {filters.brands.map((brand) => (
                  <SelectItem key={brand.id} value={String(brand.id)}>
                    {brand.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Date filter popover */}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant={hasDateFilter ? "default" : "outline"}
                  size="sm"
                  className="hidden sm:flex items-center gap-2 h-10 rounded-lg font-semibold text-primary border-primary/30 hover:bg-primary/5 data-[state=open]:bg-primary data-[state=open]:text-primary-foreground"
                >
                  <SlidersHorizontal className="h-4 w-4" />
                  <span className="hidden lg:inline">
                    {hasDateFilter ? "filtros ativos" : "filtros"}
                  </span>
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-72" align="end">
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h4 className="font-medium text-sm">Filtrar por datas</h4>
                    {hasDateFilter && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => filters.setDateRange({ from: null, to: null })}
                      >
                        <X className="h-3 w-3 mr-1" />
                        Limpar
                      </Button>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs">De</Label>
                    <Input
                      type="date"
                      value={filters.dateRange.from?.toISOString().split('T')[0] ?? ""}
                      onChange={(e) => filters.setDateRange({
                        ...filters.dateRange,
                        from: e.target.value ? new Date(e.target.value) : null,
                      })}
                      className="h-9"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs">Até</Label>
                    <Input
                      type="date"
                      value={filters.dateRange.to?.toISOString().split('T')[0] ?? ""}
                      onChange={(e) => filters.setDateRange({
                        ...filters.dateRange,
                        to: e.target.value ? new Date(e.target.value) : null,
                      })}
                      className="h-9"
                    />
                  </div>
                </div>
              </PopoverContent>
            </Popover>

            {/* Notifications */}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="relative h-10 w-10 rounded-lg"
                  aria-label="Notificações"
                >
                  <Bell className="h-4 w-4" />
                  <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center justify-center px-1">
                    29
                  </span>
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-80" align="end">
                <div className="space-y-3">
                  <h4 className="font-medium text-sm">Notificações</h4>
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    <div className="flex gap-3 p-2 rounded-lg hover:bg-muted/50 transition-colors">
                      <div className="h-2 w-2 rounded-full bg-blue-500 mt-2 shrink-0" />
                      <div>
                        <p className="text-sm">Nova reserva #4521 criada</p>
                        <p className="text-xs text-muted-foreground">Há 5 minutos</p>
                      </div>
                    </div>
                    <div className="flex gap-3 p-2 rounded-lg hover:bg-muted/50 transition-colors">
                      <div className="h-2 w-2 rounded-full bg-amber-500 mt-2 shrink-0" />
                      <div>
                        <p className="text-sm">3 reclamações pendentes</p>
                        <p className="text-xs text-muted-foreground">Há 15 minutos</p>
                      </div>
                    </div>
                    <div className="flex gap-3 p-2 rounded-lg hover:bg-muted/50 transition-colors">
                      <div className="h-2 w-2 rounded-full bg-green-500 mt-2 shrink-0" />
                      <div>
                        <p className="text-sm">Sincronização Multipark concluída</p>
                        <p className="text-xs text-muted-foreground">Há 30 minutos</p>
                      </div>
                    </div>
                    <div className="flex gap-3 p-2 rounded-lg hover:bg-muted/50 transition-colors">
                      <div className="h-2 w-2 rounded-full bg-red-500 mt-2 shrink-0" />
                      <div>
                        <p className="text-sm">Fatura #892 vencida</p>
                        <p className="text-xs text-muted-foreground">Há 1 hora</p>
                      </div>
                    </div>
                  </div>
                </div>
              </PopoverContent>
            </Popover>

            {/* User Avatar with dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full"
                  aria-label={`Menu do utilizador ${user?.name ?? ""}`}
                >
                  <Avatar className="h-10 w-10 border-2 border-primary/30 cursor-pointer">
                    <AvatarFallback className="text-sm font-bold bg-primary text-primary-foreground">
                      {user?.name?.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <div className="px-2 py-2">
                  <p className="text-sm font-medium">{user?.name || "-"}</p>
                  <p className="text-xs text-muted-foreground">{user?.email || "-"}</p>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={logout}
                  className="cursor-pointer text-destructive focus:text-destructive"
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  <span>Sair</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <main className="flex-1 p-4 lg:p-6 bg-background">{children}</main>
      </SidebarInset>
    </>
  );
}
