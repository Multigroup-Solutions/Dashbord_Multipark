import { useAuth } from "@/_core/hooks/useAuth";
import { BlockedOwnDocuments } from "@/components/BlockedOwnDocuments";
import { PdaDeviceBinder } from "@/components/PdaDeviceBinder";
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
import { currentPath, getLoginUrl } from "@/const";
import { ACCESS_DENIED_MSG } from "@shared/const";
import { isComebackPosition, isInactivitySuspensionText } from "@shared/comeback";
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
  UserPlus,
  Users,
  Trophy,
  Car,
  GraduationCap,
  BookOpen,
  Truck,
  Megaphone,
  Wallet,
  ParkingCircle,
  Wrench,
  MessageSquareWarning,
  MessageCircle,
  Contact,
  BookUser,
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
  MapPin,
  CalendarCheck,
  SlidersHorizontal,
  Plug,
  Bell,
  Calendar,
  X,
  Mail as MailIcon,
  Inbox,
  HardDrive,
  PhoneCall,
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
import { AssistantWidget } from "@/components/assistant/AssistantWidget";
import { useMultisState } from "@/components/assistant/multisStore";
import { MULTIS_PANEL_WIDTH_PX } from "@shared/assistant";
import { GlobalSearch, GlobalSearchButton } from "@/components/GlobalSearch";
import { WhatsAppCallManager } from "@/components/whatsapp/WhatsAppCallManager";
import { CentralRingManager } from "@/components/CentralRingManager";
import { GoogleOnlineSync } from "@/components/google/GoogleOnlineSync";
import { can, roleRank, seesBeyondOwn, type AccessOverrides, type ModuleId } from "@shared/access";
import { allowedWithoutCostCenter, decideRoute } from "@shared/routeAccess";
import { noAccessHint, noLinkedRecordMessage } from "@shared/ownAccess";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import ErrorBoundary from "@/components/ErrorBoundary";
import { PAGE_RELOAD_EVENT, jumpTo } from "@/lib/jumpTo";
import { NOTIFICATION_KIND_DEFS, NOTIFY_CITY_LABELS, kindLabel, type NotifyCity } from "@shared/notificationRouting";

/** Lote 45: o "Drive" do menu abre o Google Drive da pessoa (a conta Google com que está no browser). */
export const GOOGLE_DRIVE_URL = "https://drive.google.com/drive/my-drive";

/** Papel ou utilizador (com os overrides de módulo que vêm do auth.me). */
export type AccessSubject = string | { role: string | null | undefined; accessOverrides?: AccessOverrides | null } | null | undefined;

export type MenuItem = {
  icon: React.ElementType;
  label: string;
  path: string;
  /** Módulo da matriz de acessos (shared/access.ts); visível com can(role, módulo, "view"). */
  module?: ModuleId;
  /** Alternativas: visível se QUALQUER destes módulos se vir (ex.: RH ou a própria ficha). */
  anyOf?: ModuleId[];
  /** Só aparece a quem vê mais do que os próprios casos no módulo (a página não tem vista "só meus"). */
  beyondOwn?: boolean;
  /** Lote 45: abre este endereço num separador novo (ex.: o Google Drive) em vez de navegar. */
  external?: string;
  /** Lote 46: nome no menu de quem só vê o que é SEU aqui (ex.: "A minha ficha" em vez de "Recursos Humanos"). */
  ownLabel?: string;
};

/** Abre um item do menu: navega, ou abre o endereço externo num separador novo. */
export function openMenuItem(item: Pick<MenuItem, "path" | "external">, navigate: (path: string) => void): void {
  if (item.external) {
    window.open(item.external, "_blank", "noopener,noreferrer");
    return;
  }
  navigate(item.path);
}

export type MenuGroup = {
  label: string;
  items: MenuItem[];
  icon?: React.ElementType;
};

/** O item é visível para a pessoa (papel + overrides)? (sem módulo = visível a qualquer sessão) */
export function canSeeItem(userRole: AccessSubject, item: Pick<MenuItem, "module" | "anyOf" | "beyondOwn">): boolean {
  const mods = item.anyOf ?? (item.module ? [item.module] : []);
  if (item.beyondOwn) return mods.some(m => seesBeyondOwn(userRole, m));
  return mods.length === 0 || mods.some(m => can(userRole, m, "view"));
}

/** Lote 46: quem só vê o que é seu neste item (nenhum dos módulos além do "próprio") vê o ownLabel. */
export function menuLabelFor(userRole: AccessSubject, item: Pick<MenuItem, "label" | "ownLabel" | "module" | "anyOf">): string {
  if (!item.ownLabel) return item.label;
  const mods = item.anyOf ?? (item.module ? [item.module] : []);
  return mods.some(m => seesBeyondOwn(userRole, m)) ? item.label : item.ownLabel;
}

function visibleItems(userRole: AccessSubject, items: MenuItem[]): MenuItem[] {
  return items.filter(i => canSeeItem(userRole, i)).map(i => (i.ownLabel ? { ...i, label: menuLabelFor(userRole, i) } : i));
}

export function getFilteredMenuGroups(userRole: AccessSubject): MenuGroup[] {
  return menuGroups
    .map(g => ({ ...g, items: visibleItems(userRole, g.items) }))
    .filter(g => g.items.length > 0);
}

// Itens fixos no topo, fora dos grupos — o mais usado nunca fica escondido
// pelo acordeão.
export const topLevelItems: MenuItem[] = [
  { icon: BarChart3, label: "Dashboards", path: "/dashboards", module: "dashboards" },
];

// Menu conduzido pela matriz de acessos (shared/access.ts) — o servidor aplica
// a MESMA matriz (requireAccess), por isso o que aparece aqui é o que abre.
export const menuGroups: MenuGroup[] = [
  {
    label: "Financeiro",
    icon: Receipt,
    items: [
      { icon: Receipt, label: "Despesas", path: "/despesas", module: "despesas" },
      { icon: FileText, label: "Faturação", path: "/faturacao", module: "faturacao" },
      // 29c: "uma coisa é faturação, outra coisa é caixa" — item próprio (módulo caixa; quem tem a Faturação também vê)
      { icon: Wallet, label: "Caixa", path: "/caixa", anyOf: ["caixa", "faturacao"] },
      { icon: Handshake, label: "Parcerias", path: "/parcerias", module: "parcerias" },
      { icon: FolderTree, label: "Projetos", path: "/projetos", module: "projetos" },
      { icon: Megaphone, label: "Marketing", path: "/marketing", module: "marketing" },
    ],
  },
  {
    label: "Pessoas",
    icon: Users,
    items: [
      // RH: quem gere fichas vê a lista; os restantes veem só a própria ficha
      { icon: UserCheck, label: "Recursos Humanos", path: "/rh", anyOf: ["rh", "ficha"], ownLabel: "A minha ficha" },
      { icon: UserPlus, label: "Leads de Extras", path: "/extras-leads", module: "leads_extras" },
      { icon: GraduationCap, label: "Formação", path: "/formacao", module: "formacao" },
      // Base de conhecimento (manuais do Drive/carregados): gestão admin/super_admin.
      { icon: BookOpen, label: "Base de conhecimento", path: "/formacao/conhecimento", module: "definicoes" },
      // Avaliação: separadores "Dia" (avaliacao_operacional) e "Mês";
      // extra/condutor veem a própria avaliação — filtrado no servidor
      { icon: Trophy, label: "Avaliação", path: "/avaliacao", anyOf: ["avaliacao", "avaliacao_operacional"] },
      // Jorge, 3 out 2026: saíram das Críticas (mesmo acesso: módulo Críticas, team leader+).
      { icon: Car, label: "Condutores e agentes", path: "/pessoas/condutores-agentes", module: "criticas" },
    ],
  },
  {
    label: "Operações",
    icon: Truck,
    items: [
      { icon: LayoutDashboard, label: "Reservas & Operações", path: "/operacoes", module: "reservas_operacoes" },
      { icon: Wrench, label: "Serviços", path: "/servicos", module: "servicos" },
      { icon: Truck, label: "Actividade Diária", path: "/operacional", anyOf: ["atividade_diaria", "historico_diario", "radio"] },
      { icon: ListTodo, label: "Tarefas", path: "/tarefas", module: "tarefas" },
      { icon: CalendarDays, label: "Extras Dia", path: "/extras-dia", module: "extras_dia" },
      { icon: CalendarCheck, label: "Passagem de Turno", path: "/passagem-turno", module: "passagem_turno" },
      { icon: CalendarCheck, label: "Disponibilidade", path: "/disponibilidade", anyOf: ["disponibilidade", "disponibilidade_extras"], ownLabel: "A minha disponibilidade" },
    ],
  },
  {
    label: "Suporte",
    icon: MessageSquareWarning,
    items: [
      { icon: Contact, label: "Clientes", path: "/clientes", module: "clientes" },
      { icon: BookUser, label: "Contactos", path: "/contactos", module: "contactos" },
      { icon: MessageSquareWarning, label: "Reclamações", path: "/reclamacoes", module: "reclamacoes" },
      { icon: Star, label: "Críticas Google", path: "/criticas", module: "criticas" },
      // Ocorrências vêm da app Multipark e só se leem por cidade: quem só tem
      // "os próprios" (condutor, extra) caía no cadeado (16a).
      { icon: AlertTriangle, label: "Ocorrências", path: "/ocorrencias", module: "ocorrencias", beyondOwn: true },
      { icon: Package, label: "Perdidos e Achados", path: "/perdidos-achados", module: "perdidos" },
    ],
  },
  {
    label: "Comunicação",
    icon: MailIcon,
    items: [
      // Caixas partilhadas: matriz (comunicacao) + regra de cada caixa no servidor.
      // Lote 45 (Jorge, 7 out 2026): "é só de email" — o WhatsApp tem a entrada dele; as caixas
      // ficam à esquerda como no Gmail, com o "O meu email" na mesma lista.
      // Ordem (Jorge, lote 45): Caixas de email → O meu email → Drive → WhatsApp → Central → Calendário → Tarefas.
      { icon: Inbox, label: "Caixas de email", path: "/comunicacao", module: "comunicacao" },
      // O próprio email: qualquer pessoa (a ficha é de todos); liga a conta Google na página.
      { icon: MailIcon, label: "O meu email", path: "/comunicacao/meu-email", anyOf: ["ficha"] },
      // Lote 45 (Jorge: opção "a"): o Google Drive da pessoa num separador ao lado.
      { icon: HardDrive, label: "Drive", path: "/drive", anyOf: ["ficha"], external: GOOGLE_DRIVE_URL },
      // 17f (Jorge): o WhatsApp passa para a Comunicação.
      { icon: MessageCircle, label: "WhatsApp", path: "/whatsapp", module: "whatsapp" },
      // Lote 45: as chamadas da consola — cada um as suas; admin e super admin todas.
      { icon: PhoneCall, label: "Central", path: "/central", module: "central" },
      // Lote 45e (Jorge: opção "b"): a agenda Google da própria pessoa, como no Google Calendar.
      { icon: CalendarDays, label: "Calendário", path: "/calendario", anyOf: ["ficha"] },
      // Lote 45: as Tarefas também aqui (continuam nas Operações).
      { icon: ListTodo, label: "Tarefas", path: "/tarefas", module: "tarefas" },
    ],
  },
  {
    label: "Sistema",
    icon: SlidersHorizontal,
    items: [
      { icon: Users, label: "Utilizadores", path: "/utilizadores", module: "utilizadores" },
      { icon: ShieldCheck, label: "Permissões", path: "/permissoes", module: "permissoes" },
      { icon: Key, label: "API Keys", path: "/api-keys", module: "api_keys" },
      { icon: Plug, label: "Integrações", path: "/integracoes", module: "integracoes" },
      { icon: ScrollText, label: "Logs", path: "/logs", module: "logs" },
      { icon: SlidersHorizontal, label: "Definições", path: "/definicoes", module: "definicoes" },
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
    items: [
      { icon: BarChart3, label: "Geral", path: "/dashboards", module: "dashboards" },
      { icon: Receipt, label: "Financeiro", path: "/financeiro", module: "financeiro" },
      { icon: Truck, label: "Operações", path: "/operacoes-dashboard", module: "dashboards" },
      { icon: Users, label: "Pessoas", path: "/pessoas-dashboard", module: "dashboards" },
      { icon: MessageSquareWarning, label: "Suporte", path: "/suporte-dashboard", module: "dashboards" },
      // Um só endereço para o Marketing (24 set 2026): /marketing-dashboard era
      // uma cópia do mesmo dashboard e agora redireciona para /marketing.
      { icon: Megaphone, label: "Marketing", path: "/marketing", module: "marketing" },
    ],
  },
  ...menuGroups.map(g => ({
    ...g,
    id: g.label.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(),
  })),
];
export function getFilteredHubGroups(userRole: AccessSubject): HubGroup[] {
  return hubGroups
    .map(g => ({ ...g, items: visibleItems(userRole, g.items) }))
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
  const { loading, user, error, logout } = useAuth();
  const utils = trpc.useUtils();
  // Conta sem acesso (desativada/desconhecida): a MESMA mensagem que a página
  // de entrada mostra — nunca "inicia sessão", que levaria a tentar em ciclo.
  const accessDenied = error?.message === ACCESS_DENIED_MSG;
  // 20d: falha a verificar a sessão (rede/servidor) ≠ "não tens sessão".
  const sessionCheckFailed = !!error && !accessDenied;

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
              {accessDenied ? "Sem acesso" : sessionCheckFailed ? "Não foi possível verificar a sessão" : "Iniciar sessão"}
            </h1>
            <p className="text-sm text-muted-foreground text-center max-w-sm">
              {accessDenied
                ? ACCESS_DENIED_MSG
                : sessionCheckFailed
                  ? "O servidor não respondeu. A tua sessão pode continuar válida — tenta de novo."
                  : "É necessário autenticação para aceder ao painel. Clique para continuar."}
            </p>
          </div>
          {sessionCheckFailed && (
            <Button size="lg" className="w-full" onClick={() => utils.auth.me.invalidate()}>Tentar de novo</Button>
          )}
          {accessDenied && (
            <Button variant="outline" onClick={() => { logout().finally(() => { window.location.href = "/"; }); }}>Sair</Button>
          )}
          {!accessDenied && !sessionCheckFailed && (
            <Button
              onClick={() => {
                // entra e volta a esta página (ex.: um link para /rh aberto sem sessão)
                window.location.href = getLoginUrl(currentPath());
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
          {/* 49c: os "Suspenso: sem atividade" passam a inativos ao voltar a entrar → chegam à ficha e ao "Voltei". */}
          {isInactivitySuspensionText(employee.loginBlockedReason) && isComebackPosition(employee.position) ? (
            <p className="text-sm border-t pt-3">
              Estavas inativo por falta de atividade. <strong>Sai e volta a entrar com a Google</strong>: passas a ver a tua ficha, atualizas os teus dias livres e dizes ao RH que voltaste.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground border-t pt-3">
              Para libertar o acesso, fala com um supervisor ou administrador.
            </p>
          )}
          {/* 41c: bloqueado por documentos? Carrega-os daqui (só a tua ficha). */}
          <BlockedOwnDocuments />
          {/* 20d: sem isto não havia como sair (ex.: PDA partilhado) */}
          <Button variant="outline" onClick={() => { logout().finally(() => { window.location.href = "/"; }); }}>Sair</Button>
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
  // Interruptor WHATSAPP_CALLS (desligado por omissão): sem ele não há polling de chamadas.
  const callsFlag = trpc.whatsapp.calls.enabled.useQuery(undefined, {
    enabled: !!user && can(user as any, "whatsapp", "edit"),
    staleTime: 5 * 60_000,
    retry: false,
  });
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
    onSuccess: (d) => {
      toast.success("Entrada registada!");
      // Terminal no ponto (aeroporto) — só vem preenchido com o interruptor ligado
      if (d?.terminal === "start") toast.success("Terminal: entrada no aeroporto. Este troço conta como terminal. Antes de saíres do aeroporto, dá saída + entrada.", { duration: 10000 });
      if (d?.terminal === "return") toast.info("Saíste do terminal: voltas a contar como extra normal.", { duration: 8000 });
      pontoDone();
    },
    onError: (e) => { toast.error(e.message); setPontoMode(null); },
  });
  const quickCheckOut = trpc.rh.timeRecords.checkOut.useMutation({
    onSuccess: (d) => {
      toast.success(`Saída registada! ${d.hoursWorked}h trabalhadas`);
      if (d?.terminal === "auto") toast.success("Troço de terminal fechado no aeroporto.", { duration: 8000 });
      if (d?.terminal === "partial") toast.success(`${d.terminalLabel ?? "Terminal até à última recolha/entrega"}. Daí até à saída conta como hora normal.`, { duration: 10000 });
      if (d?.terminal === "pending") toast.warning("Terminal por confirmar: a saída não foi no aeroporto (ou sem GPS) e ainda não há recolhas/entregas tuas no troço. Não paga terminal até o RH confirmar.", { duration: 10000 });
      pontoDone();
    },
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
  const filteredGroups = getFilteredHubGroups(user ?? userRole);
  const filteredItems = filteredGroups.flatMap(g => g.items);
  const activeMenuItem = allMenuItems.find(item => item.path === location);
  // Badge do WhatsApp: conversas por ler/por responder (só para quem tem o item no menu).
  const showWhatsappBadge = filteredItems.some(i => i.path === "/whatsapp");
  const waBadgeQ = trpc.whatsapp.badge.useQuery(undefined, {
    enabled: showWhatsappBadge,
    refetchInterval: 60_000,
    retry: false,
  });
  const waBadge = showWhatsappBadge ? waBadgeQ.data : undefined;
  // Badge da Comunicação: conversas com emails por ler (caixas visíveis / pessoal).
  const showMailBadge = filteredItems.some(i => i.path.startsWith("/comunicacao"));
  const mailBadgeQ = trpc.mail.badge.useQuery(undefined, { enabled: showMailBadge, refetchInterval: 120_000, retry: false });
  const mailBadgeFor = (path: string): number => {
    if (!showMailBadge || !mailBadgeQ.data) return 0;
    return path === "/comunicacao" ? mailBadgeQ.data.shared : path === "/comunicacao/meu-email" ? mailBadgeQ.data.personal : 0;
  };
  const isMobile = useIsMobile();
  // Multis acoplado à direita (computador): o conteúdo encolhe para não ficar por baixo dela.
  const multis = useMultisState();
  const multisDocked = multis.open && !isMobile;

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

  // 20d: o Perfil (e o resto do que é pessoal) abre para todos; um ecrã do
  // menu que não é para a pessoa mostra "Sem acesso" (antes saltava em
  // silêncio); os ecrãs de entrada levam ao primeiro do menu da pessoa.
  const isLowRole = roleRank(userRole) < roleRank("team_leader");
  const routeDecision = user ? decideRoute({
    path: location,
    allowedPaths: new Set(filteredItems.map(i => i.path)),
    allMenuPaths,
    lowRole: isLowRole,
    firstAllowed: filteredItems[0]?.path ?? (isLowRole ? "/rh" : "/formacao"),
  }) : { kind: "ok" as const };
  useEffect(() => {
    if (routeDecision.kind === "redirect" && routeDecision.to !== location) setLocation(routeDecision.to, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeDecision.kind, (routeDecision as any).to, location]);
  const filters = useGlobalFilters();
  // 20d: salto do sino/pesquisa para a mesma página com outro ?id → volta a montá-la.
  const [pageNonce, setPageNonce] = useState(0);
  useEffect(() => {
    const bump = () => setPageNonce((n) => n + 1);
    window.addEventListener(PAGE_RELOAD_EVENT, bump);
    return () => window.removeEventListener(PAGE_RELOAD_EVENT, bump);
  }, []);

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
      {/* Fase 2: login num PDA registado → o PDA fica com esta pessoa */}
      <PdaDeviceBinder userId={user?.id} />
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
                <PanelLeft className="h-4 w-4 text-slate-600" />
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
                              groupActive || isOpen ? "bg-[#0046ad] text-white" : "bg-slate-100 text-slate-600"
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
                                  onClick={() => openMenuItem(item, navigate)}
                                  tooltip={item.label}
                                  className="h-9 rounded-lg transition-all font-normal data-[active=true]:!bg-primary data-[active=true]:!text-primary-foreground data-[active=true]:font-semibold hover:data-[active=true]:!bg-primary"
                                >
                                  <item.icon className="h-4 w-4" />
                                  <span>{item.label}</span>
                                  {showMailBadge && mailBadgeQ.error && !mailBadgeQ.data && (item.path === "/comunicacao" || item.path === "/comunicacao/meu-email") && (
                                    <span className="ml-auto group-data-[collapsible=icon]:hidden min-w-5 h-5 px-1.5 rounded-full text-[11px] font-bold leading-5 text-center text-amber-900 bg-amber-200"
                                      title="Não foi possível contar os emails por ler">?</span>
                                  )}
                                  {mailBadgeFor(item.path) > 0 && (
                                    <span className="ml-auto group-data-[collapsible=icon]:hidden min-w-5 h-5 px-1.5 rounded-full text-[11px] font-bold leading-5 text-center text-white bg-primary"
                                      title={`${mailBadgeFor(item.path)} conversa(s) com emails por ler`}>
                                      {mailBadgeFor(item.path) > 99 ? "99+" : mailBadgeFor(item.path)}
                                    </span>
                                  )}
                                  {item.path === "/whatsapp" && waBadge && waBadge.attention > 0 && (
                                    <span
                                      className={`ml-auto group-data-[collapsible=icon]:hidden min-w-5 h-5 px-1.5 rounded-full text-[11px] font-bold leading-5 text-center text-white ${
                                        waBadge.overdue > 0 ? "bg-red-600" : "bg-green-600"
                                      }`}
                                      title={waBadge.overdue > 0
                                        ? `${waBadge.attention} conversas por tratar · ${waBadge.overdue} sem resposta há mais de ${waBadge.slaMinutes} min`
                                        : `${waBadge.attention} conversas por ler/responder`}
                                    >
                                      {waBadge.attention > 99 ? "99+" : waBadge.attention}
                                    </span>
                                  )}
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

      <SidebarInset style={multisDocked ? { marginRight: MULTIS_PANEL_WIDTH_PX } : undefined}>
        {/* Topbar */}
        <div className="flex border-b h-16 items-center justify-between bg-white px-4 lg:px-6 sticky top-0 z-40">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            {isMobile && (
              <SidebarTrigger className="h-9 w-9 rounded-lg bg-background" />
            )}
            <h1
              className="text-lg sm:text-xl lg:text-[22px] font-bold text-foreground truncate"
              title={activeMenuItem?.label ?? undefined}
            >
              {activeMenuItem?.label ?? (location === "/modulos" ? "Menu" : location === "/perfil" ? "Perfil" : "Dashboard")}
            </h1>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            {/* Pesquisa global (Ctrl/Cmd+K) */}
            <GlobalSearchButton />
            {/* City filter */}
            <Select
              disabled={filters.cities.length <= 1}
              value={filters.cityId === null ? "all" : String(filters.cityId)}
              onValueChange={(v) => filters.setCityId(v === "all" ? null : Number(v))}
            >
              <SelectTrigger className="hidden md:flex h-9 w-[168px]" aria-label="Filtro de cidade">
                <SelectValue placeholder="Cidade" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{filters.cities.length === 0 ? "Sem cidade atribuída" : "Todas as cidades"}</SelectItem>
                {filters.cities.map((city) => (
                  <SelectItem key={city.id} value={String(city.id)}>
                    {city.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Filtro de Marca (nós level=brand; antes dizia "Parque") */}
            <Select
              value={filters.brandId === null ? "all" : String(filters.brandId)}
              onValueChange={(v) => filters.setBrandId(v === "all" ? null : Number(v))}
            >
              <SelectTrigger className="hidden md:flex h-9 w-[168px]" aria-label="Filtro de marca">
                <SelectValue placeholder="Marca" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas as marcas</SelectItem>
                {filters.brands.map((brand) => (
                  <SelectItem key={brand.id} value={String(brand.id)}>
                    {brand.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Botão "Datas" global REMOVIDO (pedido Jorge: não filtrava nada
                — as datas escolhem-se dentro de cada página, no seletor azul) */}
            {/* Cidade/Parques em MOBILE (pedido Jorge): os selects de cima
                escondem-se em ecrãs pequenos — este botão abre-os num popover,
                ligado ao MESMO estado global */}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant={filters.cityId !== null || filters.brandId !== null ? "selected" : "outline"}
                  size="icon"
                  className="md:hidden h-9 w-9"
                  title="Cidade e marca"
                  aria-label="Cidade e marca"
                >
                  <MapPin className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64 space-y-3" align="end">
                <div className="space-y-1.5">
                  <Label className="text-xs">Cidade</Label>
                  <Select
                    disabled={filters.cities.length <= 1}
              value={filters.cityId === null ? "all" : String(filters.cityId)}
                    onValueChange={(v) => filters.setCityId(v === "all" ? null : Number(v))}
                  >
                    <SelectTrigger className="w-full h-9"><SelectValue placeholder="Cidade" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{filters.cities.length === 0 ? "Sem cidade atribuída" : "Todas as cidades"}</SelectItem>
                      {filters.cities.map((city) => (
                        <SelectItem key={city.id} value={String(city.id)}>{city.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Marca</Label>
                  <Select
                    value={filters.brandId === null ? "all" : String(filters.brandId)}
                    onValueChange={(v) => filters.setBrandId(v === "all" ? null : Number(v))}
                  >
                    <SelectTrigger className="w-full h-9"><SelectValue placeholder="Marca" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Todas as marcas</SelectItem>
                      {filters.brands.map((brand) => (
                        <SelectItem key={brand.id} value={String(brand.id)}>{brand.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </PopoverContent>
            </Popover>

            {/* Notifications */}
            <NotificationsBell />
            {/* Notifications */}

            {/* User Avatar with dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full" aria-label="Menu da conta">
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
                      {pontoStatus === "in" && pontoQ.data?.terminal && (
                        <span className="ml-1 inline-flex items-center rounded-full border border-sky-300 bg-sky-100 px-1.5 py-0 text-[10px] font-medium text-sky-800 dark:bg-sky-950 dark:text-sky-200">Terminal</span>
                      )}
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

        {/* pb extra: a última linha da página não fica por baixo da tab bar
            (mobile) nem do botão flutuante do Multis */}
        <main className="flex-1 p-4 lg:p-6 min-w-0 overflow-x-hidden pb-40 md:pb-24 lg:pb-24 bg-background">
          {routeDecision.kind === "no_access" ? (
            <NoAccessScreen onHome={() => setLocation(filteredItems[0]?.path ?? "/perfil", { replace: true })} onLogout={logout}
              hint={noAccessHint(location, new Set(filteredItems.map(i => i.path)))} onHint={(to) => setLocation(to)} />
          ) : filters.isLoading && !allowedWithoutCostCenter(location) ? <p>A verificar o acesso às cidades…</p>
          : filters.accessError && !allowedWithoutCostCenter(location) ? (
            // 20d: falhar a leitura do acesso ≠ "sem centro de custos"
            <QueryErrorNote error={filters.accessError} onRetry={filters.retryAccess} what="o teu acesso às cidades" />
          ) : filters.missingCostCenter && !allowedWithoutCostCenter(location) ? (
            <div role="status" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
              {/* Lote 46: conta sem ficha ≠ ficha sem cidade — cada um diz o que pedir ao RH. */}
              {(user as any)?.employee === null
                ? <><strong>A tua conta não está ligada a nenhuma ficha.</strong> {noLinkedRecordMessage(user?.email)}</>
                : <><strong>Sem centro de custos atribuído.</strong> O acesso às cidades fica indisponível até à atribuição. Pede ao RH para pôr a tua cidade na ficha.</>} Entretanto, abre o que é teu:
              <span className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
                <a href="/perfil" className="underline">O meu perfil</a>
                <a href="/rh" className="underline">A minha ficha</a>
                <a href="/disponibilidade" className="underline">Disponibilidade</a>
              </span>
            </div>
          ) : <ErrorBoundary compact resetKey={location}><div key={pageNonce} className="contents">{children}</div></ErrorBoundary>}
        </main>
        {/* Tab bar mobile (design Multipark Mobile) — só em ecrãs pequenos */}
        <MobileTabBar />
        {/* Multis (IA): botão flutuante em todas as páginas; no PC fica acoplada à direita */}
        <AssistantWidget />
        {/* Pesquisa global: paleta Ctrl/Cmd+K */}
        <GlobalSearch />
        {/* Google Tarefas/Contactos enquanto o dashboard está aberto (heartbeat de 5 min) */}
        <GoogleOnlineSync enabled={!!user} />
        {/* Chamadas de voz do WhatsApp: toque + chamada em curso em qualquer página */}
        <WhatsAppCallManager enabled={!!user && can(user as any, "whatsapp", "edit") && !!callsFlag.data?.enabled} userId={user?.id ?? null} />
        {/* Lote 45: a Central Vodafone toca aqui (quem tem acesso da consola; interruptor CENTRAL_RING) */}
        <CentralRingManager enabled={!!user} />
      </SidebarInset>
    </>
  );
}

function NotificationsBell() {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const countQ = trpc.notifications.unreadCount.useQuery(undefined, { refetchInterval: 60_000 });
  // Filtro por tipo (só os tipos que a pessoa pode receber).
  const [kindFilter, setKindFilter] = useState<string>("");
  const prefsQ = trpc.notifications.prefs.useQuery(undefined, { staleTime: 5 * 60_000 });
  const listQ = trpc.notifications.list.useQuery({ limit: 30, kind: kindFilter || null });
  const kindOptions = NOTIFICATION_KIND_DEFS.filter((d) => (prefsQ.data?.kinds ?? []).includes(d.kind));
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
    if (n.link) jumpTo(n.link, setLocation);
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
        <Button
          variant="outline"
          size="icon"
          className="relative h-9 w-9"
          aria-label={count > 0 ? `Notificações (${count} por ler)` : "Notificações"}
        >
          <Bell className="h-4 w-4" />
          {count > 0 && (
            <span className="absolute -top-1.5 -right-1.5 h-[18px] min-w-[18px] px-1 rounded-full bg-destructive text-[11px] leading-none font-bold text-white flex items-center justify-center tabular-nums ring-2 ring-white">
              {count > 99 ? "99+" : count}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(24rem,calc(100vw-2rem))]" align="end">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
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
          {kindOptions.length > 1 && (
            <select
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value)}
              aria-label="Filtrar por tipo"
              className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs"
            >
              <option value="">Todos os tipos</option>
              {kindOptions.map((d) => <option key={d.kind} value={d.kind}>{d.label}</option>)}
            </select>
          )}
          <div className="space-y-1 max-h-80 overflow-y-auto">
            {listQ.error ? (
              // 20d: erro ≠ "Sem notificações"
              <QueryErrorNote error={listQ.error} onRetry={() => listQ.refetch()} retrying={listQ.isFetching} what="as notificações" />
            ) : listQ.isLoading ? (
              <p className="text-xs text-muted-foreground text-center py-6">A carregar…</p>
            ) : items.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-6">{kindFilter ? "Sem notificações deste tipo" : "Sem notificações"}</p>
            ) : (
              items.map((n: any) => (
                <button
                  key={n.id}
                  onClick={() => onItemClick(n)}
                  className={`w-full text-left flex gap-3 p-2 rounded-lg hover:bg-muted/50 transition-colors ${n.isRead ? "opacity-60" : ""}`}
                >
                  <div className={`h-2 w-2 rounded-full mt-2 shrink-0 ${n.isRead ? "bg-muted-foreground" : "bg-blue-500"}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium line-clamp-2 break-words">{n.title}</p>
                    {n.body && <p className="text-xs text-muted-foreground line-clamp-2 break-words">{n.body}</p>}
                    <p className="text-[11px] text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-1.5">
                      <span>{fmtTime(n.createdAt)}</span>
                      <span aria-hidden>·</span>
                      <span>{kindLabel(n.kind)}</span>
                      {n.cityKey && NOTIFY_CITY_LABELS[n.cityKey as NotifyCity] && (
                        <span className="rounded border border-border px-1 leading-4 text-foreground/80">{NOTIFY_CITY_LABELS[n.cityKey as NotifyCity]}</span>
                      )}
                    </p>
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

/** 20d: ecrã do menu que não é para esta pessoa — diz porquê, em vez de saltar em silêncio. */
function NoAccessScreen({ onHome, onLogout, hint, onHint }: {
  onHome: () => void;
  onLogout: () => Promise<void> | void;
  /** Lote 46: o lado "teu" desta página está noutra (ex.: Extras Dia → a minha disponibilidade). */
  hint?: { to: string; label: string; text: string } | null;
  onHint?: (to: string) => void;
}) {
  return (
    <div role="alert" className="max-w-md mx-auto mt-10 text-center space-y-4 rounded-xl border bg-card p-6">
      <h1 className="text-lg font-semibold">Sem acesso a esta página</h1>
      <p className="text-sm text-muted-foreground">
        A tua conta não tem permissão para abrir esta página. Se achas que devias ter, fala com o teu supervisor ou com a administração.
      </p>
      {hint && <p className="text-sm">{hint.text}</p>}
      <div className="flex flex-wrap justify-center gap-2">
        {hint && onHint && <Button onClick={() => onHint(hint.to)}>{hint.label}</Button>}
        <Button variant={hint ? "outline" : "default"} onClick={onHome}>Ir para o início</Button>
        <Button variant="outline" onClick={() => { Promise.resolve(onLogout()).finally(() => { window.location.href = "/"; }); }}>Sair</Button>
      </div>
    </div>
  );
}
