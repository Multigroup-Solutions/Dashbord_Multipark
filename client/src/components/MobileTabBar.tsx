// Tab bar inferior (definição final do Jorge): SÓ 5 ícones —
// Dashboards · Pessoas · MENU (central, azul, maior) · Operações · Perfil.
// O resto navega-se pelo Menu (hub de cartões) ou pela sidebar; as permissões
// cortam o que a pessoa não pode ver (getFilteredHubGroups).
import { useLocation, useSearch } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { BarChart3, Users, LayoutGrid, Truck, User } from "lucide-react";
import { getFilteredHubGroups } from "@/components/DashboardLayout";

export function MobileTabBar() {
  const { user } = useAuth();
  const [location, navigate] = useLocation();
  const search = useSearch();
  const activeGroup = new URLSearchParams(search).get("g");
  const groups = getFilteredHubGroups(user?.role ?? "user");
  const has = (id: string) => groups.some((g) => g.id === id);

  const inGroup = (id: string) => {
    if (location === "/modulos" && activeGroup === id) return true;
    const g = groups.find((x) => x.id === id);
    return !!g?.items.some((i) => location === i.path || location.startsWith(i.path + "/"));
  };

  const side = (
    id: string,
    label: string,
    Icon: React.ElementType,
    go: () => void,
    active: boolean,
    hidden = false,
  ) => (
    <button
      key={id}
      type="button"
      onClick={go}
      disabled={hidden}
      className={`flex flex-col items-center justify-center gap-[3px] flex-1 py-1.5 text-[10.5px] font-semibold transition-colors ${
        hidden ? "invisible" : active ? "text-primary" : "text-slate-500"
      }`}
    >
      <span
        className={`flex items-center justify-center w-11 h-[30px] rounded-[10px] transition-colors ${
          active ? "bg-primary/10 text-primary" : ""
        }`}
      >
        <Icon className="w-[19px] h-[19px]" />
      </span>
      <span className="whitespace-nowrap">{label}</span>
    </button>
  );

  return (
    <nav
      className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-white border-t border-slate-200 flex items-end px-2 pt-1.5"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 6px)" }}
    >
      {side("dashboards", "Dashboards", BarChart3, () => navigate("/modulos?g=dashboards"), inGroup("dashboards"), !has("dashboards"))}
      {side("pessoas", "Pessoas", Users, () => navigate("/modulos?g=pessoas"), inGroup("pessoas"), !has("pessoas"))}

      {/* MENU — central, azul, maior */}
      <button
        type="button"
        onClick={() => navigate("/modulos")}
        className="flex flex-col items-center flex-1 -mt-5 pb-0.5"
      >
        <span
          className={`flex items-center justify-center w-14 h-14 rounded-2xl text-white shadow-[0_6px_16px_rgba(0,85,210,0.38)] transition-transform active:scale-95 ${
            location === "/modulos" && !activeGroup ? "bg-[#0046ad]" : "bg-primary"
          }`}
        >
          <LayoutGrid className="w-[26px] h-[26px]" />
        </span>
        <span className="text-[10.5px] font-semibold text-primary mt-1">Menu</span>
      </button>

      {side("operacoes", "Operações", Truck, () => navigate("/modulos?g=operacoes"), inGroup("operacoes"), !has("operacoes"))}
      {side("perfil", "Perfil", User, () => navigate("/perfil"), location === "/perfil")}
    </nav>
  );
}
