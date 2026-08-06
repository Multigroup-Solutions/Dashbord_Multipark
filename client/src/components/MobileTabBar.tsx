// Tab bar inferior para telemóvel/PDA — implementação do design "Multipark
// Mobile" do Claude Design (opção 2a: app interna em mobile). Só aparece em
// ecrãs pequenos; o desktop mantém a sidebar.
import { useLocation } from "wouter";
import { Home, LayoutGrid, CalendarCheck, User } from "lucide-react";

const TABS = [
  { id: "inicio", label: "Início", icon: Home, path: "/dashboards" },
  { id: "modulos", label: "Módulos", icon: LayoutGrid, path: "/modulos" },
  { id: "reservas", label: "Reservas", icon: CalendarCheck, path: "/operacoes" },
  { id: "perfil", label: "Perfil", icon: User, path: "/perfil" },
];

export function MobileTabBar() {
  const [location, navigate] = useLocation();
  return (
    <nav
      className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-white border-t border-slate-200 flex items-stretch"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {TABS.map((t) => {
        const active = location === t.path || (t.id === "inicio" && location === "/");
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => navigate(t.path)}
            className={`flex-1 flex flex-col items-center justify-center gap-0.5 py-2 text-[10.5px] font-semibold transition-colors ${
              active ? "text-[#0055d2]" : "text-slate-400 hover:text-slate-600"
            }`}
          >
            <t.icon className="w-5 h-5" strokeWidth={active ? 2.4 : 2} />
            {t.label}
          </button>
        );
      })}
    </nav>
  );
}
