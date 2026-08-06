// Tab bar inferior (modelo "Dashboard Multipark v2"): Menu + os grupos, com
// scroll horizontal — igual à sidebar do desktop. O ativo fica com o ícone em
// pill azul-clara e texto azul, como no design. Perfil no fim (ponto/sair).
import { useLocation, useSearch } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { LayoutGrid, User } from "lucide-react";
import { getFilteredHubGroups } from "@/components/DashboardLayout";

export function MobileTabBar() {
  const { user } = useAuth();
  const [location, navigate] = useLocation();
  const search = useSearch();
  const activeGroup = new URLSearchParams(search).get("g");
  const groups = getFilteredHubGroups(user?.role ?? "user");

  const tabs = [
    { id: "menu", label: "Menu", icon: LayoutGrid, go: () => navigate("/modulos") },
    ...groups.map((g) => ({
      id: g.id,
      label: g.label,
      icon: (g.icon ?? LayoutGrid) as React.ElementType,
      go: () => navigate(`/modulos?g=${g.id}`),
    })),
    { id: "perfil", label: "Perfil", icon: User, go: () => navigate("/perfil") },
  ];

  const isActive = (id: string) => {
    if (id === "perfil") return location === "/perfil";
    if (id === "menu") return location === "/modulos" && !activeGroup;
    if (location === "/modulos" && activeGroup === id) return true;
    // grupo que contém a página atual
    const g = groups.find((x) => x.id === id);
    return !!g?.items.some((i) => location === i.path || location.startsWith(i.path + "/"));
  };

  return (
    <nav
      className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-white border-t border-slate-200 flex items-stretch gap-0.5 px-2 pt-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 6px)" }}
    >
      {tabs.map((t) => {
        const active = isActive(t.id);
        return (
          <button
            key={t.id}
            type="button"
            onClick={t.go}
            className={`flex flex-col items-center gap-[3px] flex-[1_0_auto] min-w-[64px] px-1.5 py-1 text-[10.5px] font-semibold transition-colors ${
              active ? "text-primary" : "text-slate-500"
            }`}
          >
            <span
              className={`flex items-center justify-center w-11 h-[30px] rounded-[10px] transition-colors ${
                active ? "bg-primary/10 text-primary" : ""
              }`}
            >
              <t.icon className="w-[19px] h-[19px]" />
            </span>
            <span className="whitespace-nowrap">{t.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
