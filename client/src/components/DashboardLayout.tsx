import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
import { ACCESS_DENIED_MSG } from "@shared/const";
import ProfilePhotoPrompt from "@/components/ProfilePhotoPrompt";
import CameraCapture from "@/components/CameraCapture";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { fmtPTTime } from "@/lib/lisbonTime";
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
  MessageCircle,
  Star,
  AlertTriangle,
  Package,
  Key,
  ScrollText,
  LogOut,
  Camera,
  PanelLeft,
  ChevronDown,
  ArrowDownToLine,
  ArrowUpFromLine,
  XCircle,
  RefreshCw,
  ShieldCheck,
  CalendarCheck,
  SlidersHorizontal,
  Bell,
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
import { trpc } from "@/lib/trpc";
import { MobileTabBar } from "@/components/MobileTabBar";

export type MenuItem = {
  icon: React.ElementType;
  label: string;
  path: string;
  minRole?: string;
};

export type MenuGroup = {
  label: string;
  items: MenuItem[];
  minRole?: string;
  icon?: React.ElementType;
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

export function hasRole(userRole: string, minRole: string): boolean {
  return (ROLE_HIERARCHY[userRole] ?? 0) >= (ROLE_HIERARCHY[minRole] ?? 0);
}

export function getFilteredMenuGroups(userRole: string): MenuGroup[] {
  return menuGroups
    .filter(g => !g.minRole || hasRole(userRole, g.minRole))
    .map(g => ({
      ...g,
      items: g.items.filter(i => !i.minRole || hasRole(userRole, i.minRole)),
    }))
    .filter(g => g.items.length > 0);
}

// Itens fixos no topo, fora dos grupos — o mais usado nunca fica escondido
// pelo acordeão.
export const topLevelItems: MenuItem[] = [
  // dashboards iniciais não aparecem ao frontoffice
  { icon: BarChart3, label: "Dashboards", path: "/dashboards", minRole: "backoffice" },
];

export const menuGroups: MenuGroup[] = [
  {
    label: "Financeiro",
    icon: Receipt,
    minRole: "frontoffice",
    items: [
      { icon: Receipt, label: "Despesas", path: "/despesas" },
      // Faturação / Projetos / Marketing escondidos do frontoffice
      { icon: FileText, label: "Faturação", path: "/faturacao", minRole: "admin" },
      { icon: Handshake, label: "Parcerias", path: "/parcerias" },
      { icon: FolderTree, label: "Projetos", path: "/projetos", minRole: "backoffice" },
      { icon: Megaphone, label: "Marketing", path: "/marketing", minRole: "backoffice" },
    ],
  },
  {
    label: "Pessoas",
    icon: Users,
    items: [
      // RH visível a todos os roles (user/extra veem só o próprio perfil)
      { icon: UserCheck, label: "Recursos Humanos", path: "/rh" },
      { icon: GraduationCap, label: "Formação", path: "/formacao", minRole: "extra" },
      // extra vê a própria avaliação (última semana) — filtrado no servidor
      { icon: Trophy, label: "Avaliação Individual", path: "/avaliacao", minRole: "extra" },
      { icon: Trophy, label: "Avaliação Operacional", path: "/avaliacao-operacional", minRole: "backoffice" },
    ],
  },
  {
    label: "Operações",
    icon: Truck,
    // Operações escondidas do frontoffice (backoffice+); Tarefas/Disponibilidade
    // são a exceção — extra+ vê (extra só as suas)
    items: [
      { icon: LayoutDashboard, label: "Reservas & Operações", path: "/operacoes", minRole: "backoffice" },
      { icon: Wrench, label: "Serviços", path: "/servicos", minRole: "backoffice" },
      { icon: Truck, label: "Actividade Diária", path: "/operacional", minRole: "backoffice" },
      { icon: ListTodo, label: "Tarefas", path: "/tarefas", minRole: "extra" },
      { icon: CalendarDays, label: "Extras Dia", path: "/extras-dia", minRole: "backoffice" },
      { icon: CalendarCheck, label: "Passagem de Turno", path: "/passagem-turno", minRole: "team_leader" },
      { icon: CalendarCheck, label: "Disponibilidade", path: "/disponibilidade", minRole: "extra" },
      { icon: MessageCircle, label: "WhatsApp", path: "/whatsapp", minRole: "backoffice" },
    ],
  },
  {
    label: "Suporte",
    icon: MessageSquareWarning,
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
    icon: SlidersHorizontal,
    minRole: "admin",
    items: [
      { icon: Users, label: "Utilizadores", path: "/utilizadores" },
      { icon: ShieldCheck, label: "Permissões", path: "/permissoes" },
      { icon: RefreshCw, label: "Sincronização", path: "/multipark/sync" },
      { icon: Key, label: "API Keys", path: "/api-keys" },
      { icon: ScrollText, label: "Logs", path: "/logs" },
    ],
  },
];


// ─── Grupos do HUB (modelo "Dashboard Multipark v2" do Claude Design) ────────
// Sidebar/tab bar mostram Menu + estes grupos; o conteúdo é o launcher de
// cartões em /modulos. "Dashboards" é um grupo como os outros no v2.
export type HubGroup = MenuGroup & { id: string };
export const hubGroups: HubGroup[] = [
  {
    id: "dashboards",
    label: "Dashboards",
    icon: BarChart3,
    minRole: "backoffice",
    items: [
      { icon: BarChart3, label: "Geral", path: "/dashboards" },
      { icon: Receipt, label: "Financeiro", path: "/financeiro" },
      { icon: Truck, label: "Operações", path: "/operacoes-dashboard" },
      { icon: Users, label: "Pessoas", path: "/pessoas-dashboard" },
      { icon: MessageSquareWarning, label: "Suporte", path: "/suporte-dashboard" },
      { icon: Megaphone, label: "Marketing", path: "/marketing-dashboard" },
    ],
  },
  ...menuGroups.map(g => ({
    ...g,
    id: g.label.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(),
  })),
];
export function getFilteredHubGroups(userRole: string): HubGroup[] {
  return hubGroups
    .filter(g => !g.minRole || hasRole(userRole, g.minRole))
    .map(g => ({ ...g, items: g.items.filter(i => !i.minRole || hasRole(userRole, i.minRole)) }))
    .filter(g => g.items.length > 0);
}

const allMenuItems = [...topLevelItems, ...menuGroups.flatMap(g => g.items)];
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
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return saved ? parseInt(saved, 10) : DEFAULT_WIDTH;
  });
  const { loading, user, error } = useAuth();
  // Conta sem acesso (desativada/desconhecida): a MESMA mensagem que a página
  // de entrada mostra — nunca "inicia sessão", que levaria a tentar em ciclo.
  const accessDenied = error?.message === ACCESS_DENIED_MSG;

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
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
              {accessDenied ? "Sem acesso" : "Iniciar sessão"}
            </h1>
            <p className="text-sm text-muted-foreground text-center max-w-sm">
              {accessDenied
                ? ACCESS_DENIED_MSG
                : "É necessário autenticação para aceder ao painel. Clique para continuar."}
            </p>
          </div>
          {!accessDenied && (
            <Button
              onClick={() => {
                window.location.href = getLoginUrl();
              }}
              size="lg"
              className="w-full shadow-lg hover:shadow-xl transition-all"
            >
              Entrar com Google
            </Button>
          )}
        </div>
      </div>
    );
  }

  // Bloqueio de login por docs em falta / penalizações
  const employee = (user as any).employee;
  if (employee?.loginBlocked) {
    return (
      <div className="flex items-center justify-center min-h-screen p-6">
        <div className="max-w-md w-full text-center space-y-4 bg-card border rounded-lg p-8">
          <div className="text-5xl">🚫</div>
          <h1 className="text-xl font-semibold">Acesso bloqueado</h1>
          <p className="text-sm text-muted-foreground">
            {employee.loginBlockedReason ?? "Contacta o teu supervisor."}
          </p>
          <p className="text-xs text-muted-foreground border-t pt-3">
            Para libertar o acesso, fala com um supervisor ou administrador.
          </p>
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
  const { state, toggleSidebar, setOpenMobile } = useSidebar();
  const isCollapsed = state === "collapsed";
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const userRole = user?.role ?? "user";

  // Foto de perfil (colaborador). Auto-abre o prompt se faltar; "Trocar foto"
  // reabre-o a pedido.
  const employee = (user as any)?.employee;
  const photoUrl: string | null = employee?.photoUrl ?? null;
  const [photoOpen, setPhotoOpen] = useState(false);
  useEffect(() => {
    if (employee && !photoUrl) setPhotoOpen(true);
  }, [employee, photoUrl]);

  // Ponto rápido a partir do avatar: estado atual + entrada/saída com selfie+GPS
  // (mesmas regras do ponto na ficha de RH).
  const utils = trpc.useUtils();
  const pontoQ = trpc.rh.timeRecords.myStatus.useQuery(undefined, {
    enabled: !!employee,
    refetchInterval: 120_000,
  });
  const [pontoMode, setPontoMode] = useState<"check_in" | "check_out" | null>(null);
  const pontoDone = () => {
    utils.rh.timeRecords.myStatus.invalidate();
    utils.rh.timeRecords.list.invalidate();
    setPontoMode(null);
  };
  const quickCheckIn = trpc.rh.timeRecords.checkIn.useMutation({
    onSuccess: () => { toast.success("Entrada registada!"); pontoDone(); },
    onError: (e) => { toast.error(e.message); setPontoMode(null); },
  });
  const quickCheckOut = trpc.rh.timeRecords.checkOut.useMutation({
    onSuccess: (d) => { toast.success(`Saída registada! ${d.hoursWorked}h trabalhadas`); pontoDone(); },
    onError: (e) => { toast.error(e.message); setPontoMode(null); },
  });
  const submitPonto = (base64: string, mimeType: string) => {
    const employeeId = pontoQ.data?.employeeId;
    if (!employeeId || !pontoMode) return;
    const doSubmit = (lat: number, lng: number) => {
      const payload = {
        employeeId,
        photoBase64: base64,
        mimeType,
        latitude: String(lat),
        longitude: String(lng),
        locationName: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
      };
      if (pontoMode === "check_in") quickCheckIn.mutate(payload);
      else quickCheckOut.mutate(payload);
    };
    // O ponto exige localização EXATA (o bloqueio global da app foi removido —
    // a exigência vive aqui, só no check-in/check-out).
    if (!navigator.geolocation) {
      toast.error("Este dispositivo não tem GPS — o ponto exige localização exata.");
      setPontoMode(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (pos.coords.accuracy > 2000) {
          toast.error("A localização está aproximada (Wi-Fi/IP). Liga a localização EXATA e tenta outra vez.");
          setPontoMode(null);
          return;
        }
        doSubmit(pos.coords.latitude, pos.coords.longitude);
      },
      () => { toast.error("Sem acesso à localização. Autoriza a localização exata para picar o ponto."); setPontoMode(null); },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  };
  const pontoStatus = pontoQ.data?.employeeId ? pontoQ.data.status : null;
  const filteredGroups = getFilteredHubGroups(userRole);
  const filteredItems = filteredGroups.flatMap(g => g.items);
  const activeMenuItem = allMenuItems.find(item => item.path === location);
  const isMobile = useIsMobile();

  // Acordeão: um grupo aberto de cada vez. Segue a rota ativa (também quando a
  // navegação vem de fora da sidebar, ex.: notificações/links internos).
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  useEffect(() => {
    const g = filteredGroups.find(gr =>
      gr.items.some(i => location === i.path || location.startsWith(i.path + "/")),
    );
    if (g) setOpenGroup(g.label);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location, userRole]);

  const navigate = (path: string) => {
    setLocation(path);
    // Em mobile a sidebar é um drawer — fechar ao navegar, senão fica por
    // cima da página.
    if (isMobile) setOpenMobile(false);
  };

  // Redirect para página permitida quando a rota é restrita ao role
  useEffect(() => {
    if (!user) return;
    const allowedPaths = new Set(filteredItems.map(i => i.path));
    const isLowRole = (ROLE_HIERARCHY[userRole] ?? 0) < ROLE_HIERARCHY["backoffice"];
    if (isLowRole) {
      // user/extra/frontoffice: whitelist estrita — qualquer rota fora do
      // menu permitido (incl. /dashboard e /dashboards) cai na 1ª permitida
      const base = "/" + (location.split("/")[1] ?? "");
      if (!allowedPaths.has(location) && !allowedPaths.has(base)) {
        setLocation(filteredItems[0]?.path ?? "/rh");
      }
    } else if (allMenuPaths.has(location) && !allowedPaths.has(location)) {
      setLocation(filteredItems[0]?.path ?? "/formacao");
    }
  }, [location, user, filteredItems, userRole]);
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
      {/* Segurança: sem localização precisa + permissão de câmara, a app não
          funciona (overlay bloqueante). */}
      <div className="relative" ref={sidebarRef}>
        <Sidebar
          collapsible="icon"
          className="border-r"
          disableTransition={isResizing}
        >
          <SidebarHeader className="h-16 justify-center">
            <div className="flex items-center gap-3 px-2 transition-all w-full">
              <button
                onClick={toggleSidebar}
                className="h-8 w-8 flex items-center justify-center hover:bg-accent rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0"
                aria-label="Toggle navigation"
              >
                <PanelLeft className="h-4 w-4 text-gray-500" />
              </button>
              {!isCollapsed ? (
                <img
                  src="/multipark-logo.png"
                  alt="Multipark"
                  className="h-5 w-auto min-w-0 object-contain object-left dark:hidden"
                />
              ) : null}
              {!isCollapsed ? (
                <img
                  src="/multipark-logo-white.png"
                  alt="Multipark"
                  className="h-5 w-auto min-w-0 object-contain object-left hidden dark:block"
                />
              ) : null}
            </div>
          </SidebarHeader>

          <SidebarContent className="gap-0 px-1 overflow-x-hidden">
            {/* Placa "Menu" (modelo v2): hub com todos os atalhos */}
            <SidebarGroup className="py-0.5">
              <button
                type="button"
                onClick={() => { setOpenGroup(null); navigate("/modulos"); }}
                className={`flex w-full items-center rounded-xl h-12 text-[15px] font-semibold transition-all ${
                  isCollapsed ? "justify-center px-0" : "gap-3 px-3.5"
                } ${
                  location === "/modulos"
                    ? "bg-primary text-white shadow-[0_4px_10px_rgba(0,85,210,0.28)]"
                    : "text-slate-600 hover:bg-primary/10 hover:text-primary"
                }`}
              >
                <LayoutDashboard className="h-5 w-5 shrink-0" />
                {!isCollapsed && <span className="flex-1 text-left truncate">Menu</span>}
              </button>
            </SidebarGroup>
            {filteredGroups.map(group => {
              const groupActive = group.items.some(i => location === i.path || location.startsWith(i.path + "/"));
              const isOpen = isCollapsed || openGroup === group.label;
              const GIcon = group.icon ?? LayoutDashboard;
              return (
                <Collapsible
                  key={group.label}
                  open={isOpen}
                  onOpenChange={(o) => setOpenGroup(o ? group.label : null)}
                  className="group/collapsible"
                >
                  <SidebarGroup className="py-0.5">
                    <CollapsibleTrigger asChild>
                      <button
                        type="button"
                        onClick={() => navigate(`/modulos?g=${group.id}`)}
                        className={`flex w-full items-center rounded-xl h-12 text-[15px] font-semibold transition-all [&[data-state=open]>svg.mpk-chev]:rotate-180 ${
                          isCollapsed ? "justify-center px-0" : "gap-3 px-3.5"
                        } ${
                          groupActive || (!isCollapsed && isOpen)
                            ? "bg-primary text-white shadow-[0_4px_10px_rgba(0,85,210,0.28)]"
                            : "text-slate-600 hover:bg-primary/10 hover:text-primary"
                        }`}
                      >
                        <GIcon className="h-5 w-5 shrink-0" />
                        {!isCollapsed && (
                          <>
                            <span className="flex-1 text-left truncate">{group.label}</span>
                            <span className={`text-[11px] font-bold rounded-full px-2 py-0.5 ${
                              groupActive || isOpen ? "bg-white/[.22] text-white" : "bg-slate-100 text-slate-500"
                            }`}>{group.items.length}</span>
                            <ChevronDown className={`mpk-chev h-4 w-4 transition-transform duration-200 ${
                              groupActive || isOpen ? "text-white/80" : "text-slate-400"
                            }`} />
                          </>
                        )}
                      </button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <SidebarGroupContent className={isCollapsed ? "mt-1" : "ml-[18px] mt-1 border-l border-slate-200 pl-2"}>
                        <SidebarMenu>
                          {group.items.map(item => {
                            const isActive = location === item.path || location.startsWith(item.path + "/");
                            return (
                              <SidebarMenuItem key={item.path}>
                                <SidebarMenuButton
                                  isActive={isActive}
                                  onClick={() => navigate(item.path)}
                                  tooltip={item.label}
                                  className="h-9 rounded-lg transition-all font-normal data-[active=true]:!bg-primary data-[active=true]:!text-primary-foreground data-[active=true]:font-semibold hover:data-[active=true]:!bg-primary"
                                >
                                  <item.icon className="h-4 w-4" />
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
        <div className="flex border-b h-16 items-center justify-between bg-white px-4 lg:px-6 sticky top-0 z-40">
          <div className="flex items-center gap-3 min-w-0">
            {isMobile && (
              <SidebarTrigger className="h-9 w-9 rounded-lg bg-background" />
            )}
            <h1 className="text-xl lg:text-[22px] font-bold text-[#0c1f3f] truncate">
              {activeMenuItem?.label ?? (location === "/modulos" ? "Menu" : location === "/perfil" ? "Perfil" : "Dashboard")}
            </h1>
          </div>

          <div className="flex items-center gap-3">
            {/* Filtros de cidade/parques REMOVIDOS do topo (pedido Jorge:
                não filtravam a maioria das páginas — cada página tem o seu
                seletor de cidade, já limitado às permissões da pessoa) */}
            {/* Date filter popover */}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant={hasDateFilter ? "default" : "outline"}
                  size="sm"
                  className="hidden sm:flex items-center gap-2 h-9"
                >
                  <Calendar className="h-4 w-4" />
                  <span className="hidden lg:inline">
                    {hasDateFilter ? "Datas ativas" : "Datas"}
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
            <NotificationsBell />
            {/* Notifications */}

            {/* User Avatar with dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full">
                  <Avatar className="h-9 w-9 border cursor-pointer">
                    {photoUrl && <AvatarImage src={photoUrl} alt={user?.name ?? ""} className="object-cover" />}
                    <AvatarFallback className="text-xs font-medium bg-primary text-primary-foreground">
                      {user?.name?.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <div className="px-2 py-2">
                  <p className="text-sm font-medium">{employee?.fullName || user?.name || "-"}</p>
                  <p className="text-xs text-muted-foreground">{user?.email || "-"}</p>
                  {pontoStatus && (
                    <p className="text-xs mt-1 flex items-center gap-1.5">
                      <span className={`inline-block h-2 w-2 rounded-full ${pontoStatus === "in" ? "bg-green-500" : "bg-gray-400"}`} />
                      {pontoStatus === "in"
                        ? `Em serviço desde ${fmtPTTime(pontoQ.data?.since)}`
                        : "Fora de serviço"}
                    </p>
                  )}
                </div>
                <DropdownMenuSeparator />
                {pontoStatus === "out" && (
                  <DropdownMenuItem
                    onClick={() => setPontoMode("check_in")}
                    className="cursor-pointer text-green-700 focus:text-green-700"
                  >
                    <ArrowDownToLine className="mr-2 h-4 w-4" />
                    <span>Dar entrada (check-in)</span>
                  </DropdownMenuItem>
                )}
                {pontoStatus === "in" && (
                  <DropdownMenuItem
                    onClick={() => setPontoMode("check_out")}
                    className="cursor-pointer text-red-600 focus:text-red-600"
                  >
                    <ArrowUpFromLine className="mr-2 h-4 w-4" />
                    <span>Dar saída (check-out)</span>
                  </DropdownMenuItem>
                )}
                {employee && (
                  <DropdownMenuItem onClick={() => setPhotoOpen(true)} className="cursor-pointer">
                    <Camera className="mr-2 h-4 w-4" />
                    <span>{photoUrl ? "Trocar foto" : "Adicionar foto"}</span>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={logout}
                  className="cursor-pointer text-destructive focus:text-destructive"
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  <span>Sair</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {employee && <ProfilePhotoPrompt open={photoOpen} onOpenChange={setPhotoOpen} />}
            <Dialog open={!!pontoMode} onOpenChange={(o) => { if (!o) setPontoMode(null); }}>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <Camera className="h-4 w-4" />
                    {pontoMode === "check_in" ? "Entrada — Foto + GPS" : "Saída — Foto + GPS"}
                  </DialogTitle>
                </DialogHeader>
                {pontoMode && (
                  <CameraCapture onCapture={submitPonto} onCancel={() => setPontoMode(null)} />
                )}
                {(quickCheckIn.isPending || quickCheckOut.isPending) && (
                  <p className="text-sm text-muted-foreground text-center animate-pulse">
                    A registar ponto com foto e GPS...
                  </p>
                )}
              </DialogContent>
            </Dialog>
          </div>
        </div>

        <main className="flex-1 p-4 lg:p-6 min-w-0 overflow-x-hidden pb-20 md:pb-6" style={{ backgroundColor: '#F0F4FF' }}>{children}</main>
        {/* Tab bar mobile (design Multipark Mobile) — só em ecrãs pequenos */}
        <MobileTabBar />
      </SidebarInset>
    </>
  );
}

function NotificationsBell() {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const countQ = trpc.notifications.unreadCount.useQuery(undefined, { refetchInterval: 60_000 });
  const listQ = trpc.notifications.list.useQuery({ limit: 20 });
  const markRead = trpc.notifications.markRead.useMutation({
    onSuccess: () => {
      utils.notifications.list.invalidate();
      utils.notifications.unreadCount.invalidate();
    },
  });
  const markAll = trpc.notifications.markAllRead.useMutation({
    onSuccess: () => {
      utils.notifications.list.invalidate();
      utils.notifications.unreadCount.invalidate();
    },
  });

  const count = countQ.data?.count ?? 0;
  const items = listQ.data ?? [];

  const onItemClick = (n: any) => {
    if (!n.isRead) markRead.mutate({ id: n.id });
    if (n.link) setLocation(n.link);
  };

  const fmtTime = (iso?: string | Date | null) => {
    if (!iso) return "";
    const d = typeof iso === "string" ? new Date(iso) : iso;
    const diffMs = Date.now() - d.getTime();
    const m = Math.floor(diffMs / 60_000);
    if (m < 1) return "agora";
    if (m < 60) return `Há ${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return `Há ${h}h`;
    const days = Math.floor(h / 24);
    return `Há ${days}d`;
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="icon" className="relative h-9 w-9">
          <Bell className="h-4 w-4" />
          {count > 0 && (
            <span className="absolute -top-1 -right-1 h-4 min-w-[16px] px-1 rounded-full bg-destructive text-[10px] font-bold text-white flex items-center justify-center">
              {count > 99 ? "99+" : count}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(24rem,calc(100vw-2rem))]" align="end">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="font-medium text-sm">Notificações</h4>
            {count > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => markAll.mutate()}
                disabled={markAll.isPending}
              >
                Marcar todas como lidas
              </Button>
            )}
          </div>
          <div className="space-y-1 max-h-80 overflow-y-auto">
            {items.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-6">Sem notificações</p>
            ) : (
              items.map((n: any) => (
                <button
                  key={n.id}
                  onClick={() => onItemClick(n)}
                  className={`w-full text-left flex gap-3 p-2 rounded-lg hover:bg-muted/50 transition-colors ${n.isRead ? "opacity-60" : ""}`}
                >
                  <div className={`h-2 w-2 rounded-full mt-2 shrink-0 ${n.isRead ? "bg-muted-foreground" : "bg-blue-500"}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm truncate">{n.title}</p>
                    {n.body && <p className="text-xs text-muted-foreground line-clamp-2 break-words">{n.body}</p>}
                    <p className="text-[10px] text-muted-foreground mt-0.5">{fmtTime(n.createdAt)}</p>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
