// Página "Módulos" (design Multipark Mobile 2a): pesquisa + grupos com todas
// as entradas da app, com as MESMAS permissões da sidebar (é a mesma fonte).
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { Search, ChevronRight } from "lucide-react";
import { getFilteredMenuGroups, topLevelItems, hasRole } from "@/components/DashboardLayout";

export default function ModulesPage() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const [q, setQ] = useState("");
  const role = user?.role ?? "user";

  const groups = useMemo(() => {
    const base = getFilteredMenuGroups(role);
    const tops = topLevelItems.filter((i) => !i.minRole || hasRole(role, i.minRole));
    const all = tops.length ? [{ label: "Geral", items: tops }, ...base] : base;
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all
      .map((g) => ({ ...g, items: g.items.filter((i) => i.label.toLowerCase().includes(needle)) }))
      .filter((g) => g.items.length > 0);
  }, [role, q]);

  return (
    <div className="p-4 space-y-4 max-w-lg mx-auto">
      {/* Pesquisa (pílula, como no design) */}
      <div className="flex items-center gap-2.5 bg-white border border-slate-200 rounded-full px-4 h-11 shadow-sm">
        <Search className="w-4 h-4 text-slate-400 shrink-0" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Procurar módulo…"
          className="flex-1 bg-transparent outline-none border-none text-sm text-slate-900 placeholder:text-slate-400"
        />
      </div>

      {groups.map((g) => (
        <div key={g.label} className="space-y-2">
          <span className="block text-[11px] font-bold tracking-[.12em] uppercase text-slate-400 px-0.5">
            {g.label}
          </span>
          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
            {g.items.map((m, i) => (
              <button
                key={m.path}
                type="button"
                onClick={() => navigate(m.path)}
                className={`w-full flex items-center gap-3 px-3.5 min-h-[50px] text-left hover:bg-slate-50 transition-colors ${i > 0 ? "border-t border-slate-100" : ""}`}
              >
                <span className="w-8 h-8 rounded-[9px] bg-[#f0f4ff] text-[#0055d2] flex items-center justify-center shrink-0">
                  <m.icon className="w-4 h-4" />
                </span>
                <span className="flex-1 text-[13.5px] font-semibold text-slate-700">{m.label}</span>
                <ChevronRight className="w-4 h-4 text-slate-300" />
              </button>
            ))}
          </div>
        </div>
      ))}
      {groups.length === 0 && (
        <p className="text-center text-slate-400 text-sm py-8">Nenhum módulo encontrado.</p>
      )}
    </div>
  );
}
