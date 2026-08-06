// Página "Perfil" (design Multipark Mobile 2a): cartão do utilizador + atalhos.
import { useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Clock, Shield, LogOut, ChevronRight, UserCheck } from "lucide-react";

const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super Admin", admin: "Admin", supervisor: "Supervisor",
  team_leader: "Team Leader", backoffice: "Backoffice", frontoffice: "Frontoffice",
  extra: "Extra", user: "Utilizador",
};

export default function ProfilePage() {
  const { user, logout } = useAuth();
  const [, navigate] = useLocation();
  const { data: myStatus } = trpc.rh.timeRecords.myStatus.useQuery();

  const initials = (user?.name ?? "?")
    .split(/\s+/).filter(Boolean).map((p: string) => p[0]).slice(0, 2).join("").toUpperCase();

  // Abre a PRÓPRIA ficha nos RH (não a lista): escreve o id no estado
  // persistido do HRPage; "tab" escolhe a aba do detalhe (ex.: ponto).
  const openMyEmployee = (tab?: string) => {
    const myId = myStatus?.employeeId;
    if (!myId) {
      navigate("/rh");
      return;
    }
    try {
      sessionStorage.setItem("mp.filters.hr.selectedId", JSON.stringify(myId));
      if (tab) sessionStorage.setItem("mp.hr.detailTab", tab);
    } catch { /* sem sessionStorage — cai na lista */ }
    navigate("/rh");
  };

  const rows = [
    { icon: Clock, label: "O meu ponto", note: myStatus?.status === "in" ? "entrada aberta" : "picar entrada", action: () => openMyEmployee("timerecords") },
    { icon: UserCheck, label: "A minha ficha", note: "RH", action: () => openMyEmployee() },
    ...(user?.role && ["admin", "super_admin"].includes(user.role)
      ? [{ icon: Shield, label: "Roles e permissões", note: "granular", action: () => navigate("/permissoes") }]
      : []),
  ];

  return (
    <div className="p-4 space-y-3 max-w-lg mx-auto">
      {/* Cartão do utilizador */}
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4 flex items-center gap-3.5">
        <div className="w-[52px] h-[52px] rounded-full bg-[#0e2957] text-white flex items-center justify-center font-bold text-lg shrink-0">
          {initials}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-bold text-[16px] text-[#0c1f3f] truncate">{user?.name ?? "—"}</div>
          <div className="text-xs text-slate-500 truncate">{user?.email ?? ""}</div>
        </div>
        <span className="text-[10.5px] font-bold px-2.5 py-1 rounded-full bg-[#e1ecff] text-[#0046ad] shrink-0">
          {ROLE_LABELS[user?.role ?? "user"] ?? user?.role}
        </span>
      </div>

      {/* Atalhos */}
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
        {rows.map((r, i) => (
          <button
            key={r.label}
            type="button"
            onClick={r.action}
            className={`w-full flex items-center gap-3 px-3.5 min-h-[52px] text-left hover:bg-slate-50 ${i > 0 ? "border-t border-slate-100" : ""}`}
          >
            <span className="w-8 h-8 rounded-[9px] bg-[#f0f4ff] text-[#0055d2] flex items-center justify-center shrink-0">
              <r.icon className="w-4 h-4" />
            </span>
            <span className="flex-1 text-[13.5px] font-semibold text-slate-700">{r.label}</span>
            <span className="text-[11.5px] text-slate-400">{r.note}</span>
            <ChevronRight className="w-4 h-4 text-slate-300" />
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={() => logout()}
        className="w-full bg-white border border-red-200 rounded-2xl shadow-sm flex items-center gap-3 px-3.5 min-h-[52px] text-left hover:bg-red-50"
      >
        <span className="w-8 h-8 rounded-[9px] bg-red-50 text-red-600 flex items-center justify-center shrink-0">
          <LogOut className="w-4 h-4" />
        </span>
        <span className="flex-1 text-[13.5px] font-semibold text-red-600">Sair</span>
      </button>
    </div>
  );
}
