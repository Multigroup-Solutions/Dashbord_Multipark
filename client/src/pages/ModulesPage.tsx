// Hub "Menu" (modelo "Dashboard Multipark v2" do Claude Design): secções com
// barrinha azul + grelha de cartões-atalho (ícone em quadrado azul sólido,
// label uppercase, hover eleva). ?g=<grupo> mostra só esse grupo; sem g mostra
// tudo. Igual em desktop e telemóvel.
import { useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { Search } from "lucide-react";
import { getFilteredHubGroups } from "@/components/DashboardLayout";

export default function ModulesPage() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const search = useSearch();
  const activeGroup = new URLSearchParams(search).get("g");
  const [q, setQ] = useState("");
  const role = user?.role ?? "user";

  const groups = useMemo(() => {
    let all = getFilteredHubGroups(role);
    if (activeGroup) all = all.filter((g) => g.id === activeGroup);
    const needle = q.trim().toLowerCase();
    if (needle) {
      all = all
        .map((g) => ({ ...g, items: g.items.filter((i) => i.label.toLowerCase().includes(needle)) }))
        .filter((g) => g.items.length > 0);
    }
    return all;
  }, [role, activeGroup, q]);

  return (
    <div className="space-y-6 max-w-[1240px]">
      {/* Pesquisa */}
      <div className="flex items-center gap-2.5 bg-white border border-slate-200 rounded-full px-4 h-11 shadow-sm max-w-md">
        <Search className="w-4 h-4 text-slate-400 shrink-0" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Procurar módulo…"
          className="flex-1 bg-transparent outline-none border-none text-sm text-slate-900 placeholder:text-slate-400"
        />
      </div>

      {groups.map((g) => (
        <section key={g.id}>
          {/* Cabeçalho de secção: barrinha azul + título uppercase + contagem */}
          <div className="flex items-center gap-2.5 mb-3">
            <span className="w-1 h-4 rounded-sm bg-primary inline-block" />
            <h2 className="m-0 font-display text-xs font-bold tracking-[.12em] text-[#0c1f3f] uppercase">
              {g.label}
            </h2>
            <span className="text-xs text-slate-400">· {g.items.length} atalhos</span>
          </div>
          <div className="grid gap-3 md:gap-3.5 grid-cols-2 md:[grid-template-columns:repeat(auto-fill,minmax(190px,1fr))]">
            {g.items.map((m) => (
              <button
                key={m.path + m.label}
                type="button"
                onClick={() => navigate(m.path)}
                className="group flex flex-col items-start gap-3 bg-white border border-slate-200 rounded-[14px] p-4 md:p-[18px] text-left shadow-[0_1px_2px_rgba(12,31,63,0.05)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_8px_20px_rgba(12,31,63,0.10)] hover:border-primary cursor-pointer"
              >
                <span className="w-10 h-10 rounded-xl bg-primary text-white flex items-center justify-center shrink-0">
                  <m.icon className="w-5 h-5" />
                </span>
                <span className="font-display text-[13px] font-semibold text-[#0c1f3f] uppercase tracking-[.02em]">
                  {m.label}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
      {groups.length === 0 && (
        <p className="text-center text-slate-400 text-sm py-8">Nenhum módulo encontrado.</p>
      )}
    </div>
  );
}
