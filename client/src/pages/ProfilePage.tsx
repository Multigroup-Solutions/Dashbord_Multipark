// Página "Perfil" (design Multipark Mobile 2a): cartão do utilizador + atalhos.
import { useLocation } from "wouter";
import { can, roleRank, seesBeyondOwn } from "@shared/access";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Clock, Shield, LogOut, ChevronRight, UserCheck, Smartphone, SlidersHorizontal, Bell, Lock, Mail } from "lucide-react";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { NOTIFICATION_GROUP_LABELS, NOTIFICATION_KIND_DEFS, type NotificationGroup } from "@shared/notificationRouting";

import { ROLE_LABELS as ACCESS_ROLE_LABELS } from "@shared/access";
const ROLE_LABELS: Record<string, string> = { ...ACCESS_ROLE_LABELS };

export default function ProfilePage() {
  const { user, logout } = useAuth();
  const [, navigate] = useLocation();
  const { data: myStatus } = trpc.rh.timeRecords.myStatus.useQuery();

  const { data: cityAccess } = trpc.permissions.myCityAccess.useQuery();
  const { data: myPda } = trpc.operational.pdas.mine.useQuery(undefined, { staleTime: 60_000 });

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
    ...(can(user, "permissoes", "manage")
      ? [{ icon: Shield, label: "Roles e permissões", note: "granular", action: () => navigate("/permissoes") }]
      : []),
    ...(can(user, "definicoes", "view")
      ? [{ icon: SlidersHorizontal, label: "Definições", note: "sistema", action: () => navigate("/definicoes") }]
      : []),
  ];

  return (
    <div className="p-4 space-y-3 max-w-lg mx-auto">
      {/* Cartão do utilizador */}
      <div className="bg-card text-card-foreground border border-border rounded-2xl shadow-sm p-4 flex items-center gap-3.5">
        <div className="w-[52px] h-[52px] rounded-full bg-primary text-primary-foreground flex items-center justify-center font-bold text-lg shrink-0">
          {initials}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-bold text-[16px] text-foreground truncate">{user?.name ?? "—"}</div>
          <div className="text-xs text-muted-foreground truncate">{user?.email ?? ""}</div>
        </div>
        <span className="text-[10.5px] font-bold px-2.5 py-1 rounded-full bg-primary/10 text-primary shrink-0">
          {ROLE_LABELS[user?.role ?? "user"] ?? user?.role}
        </span>
      </div>

      {cityAccess?.missingCostCenter && (
        <div role="status" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
          <strong>Sem centro de custos atribuído.</strong> O acesso às cidades fica indisponível até à atribuição.
        </div>
      )}
      {/* PDA ligado (check-in aberto) */}
      {myPda && (
        <div className="bg-card border border-border rounded-2xl shadow-sm p-3.5 flex items-center gap-3">
          <span className="w-8 h-8 rounded-[9px] bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Smartphone className="w-4 h-4" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-[13.5px] font-semibold text-foreground truncate">PDA: {myPda.name}</div>
            <div className="text-[11.5px] text-muted-foreground truncate">
              {myPda.zelloUsername ? `Zello ${myPda.zelloUsername} · ` : ""}desde {fmtPTDateTime(myPda.since)}
            </div>
          </div>
        </div>
      )}
      {/* Atalhos */}
      <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden">
        {rows.map((r, i) => (
          <button
            key={r.label}
            type="button"
            onClick={r.action}
            className={`w-full flex items-center gap-3 px-3.5 min-h-[52px] text-left hover:bg-accent ${i > 0 ? "border-t border-border" : ""}`}
          >
            <span className="w-8 h-8 rounded-[9px] bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <r.icon className="w-4 h-4" />
            </span>
            <span className="flex-1 text-[13.5px] font-semibold text-foreground">{r.label}</span>
            <span className="text-[11.5px] text-muted-foreground">{r.note}</span>
            <ChevronRight className="w-4 h-4 text-muted-foreground/60" />
          </button>
        ))}
      </div>

      <NotificationPrefsCard />

      <button
        type="button"
        onClick={() => logout()}
        className="w-full bg-card border border-destructive/30 rounded-2xl shadow-sm flex items-center gap-3 px-3.5 min-h-[52px] text-left hover:bg-destructive/10"
      >
        <span className="w-8 h-8 rounded-[9px] bg-destructive/10 text-destructive flex items-center justify-center shrink-0">
          <LogOut className="w-4 h-4" />
        </span>
        <span className="flex-1 text-[13.5px] font-semibold text-destructive">Sair</span>
      </button>
    </div>
  );
}

// Preferências de notificação da própria pessoa: só aparecem os tipos que as
// regras (shared/notificationRouting.ts) lhe podem enviar, agrupados. As
// obrigatórias (ex.: passagem de turno) ficam trancadas; nos tipos com email
// há um segundo interruptor para o email.
function NotificationPrefsCard() {
  const utils = trpc.useUtils();
  const { data } = trpc.notifications.prefs.useQuery(undefined, { staleTime: 60_000 });
  const save = trpc.notifications.savePrefs.useMutation({
    onSuccess: (prefs) => {
      utils.notifications.prefs.setData(undefined, (old) => (old ? { ...old, ...prefs } : old));
      toast.success("Preferências guardadas.");
    },
    onError: (e) => toast.error(e.message),
  });
  const muted = new Set(data?.muted ?? []);
  const email = data?.email ?? {};
  const receivable = new Set(data?.kinds ?? []);
  const defs = NOTIFICATION_KIND_DEFS.filter((d) => receivable.has(d.kind));
  const groups = (Object.keys(NOTIFICATION_GROUP_LABELS) as NotificationGroup[])
    .map((g) => ({ g, items: defs.filter((d) => d.group === g) }))
    .filter((x) => x.items.length);
  const emailOn = (kind: string, emailDefault: boolean) => email[kind] ?? (data?.routing?.kinds?.[kind]?.email ?? emailDefault);
  const toggle = (kind: string, on: boolean) => {
    const next = new Set(muted);
    if (on) next.delete(kind); else next.add(kind);
    save.mutate({ muted: Array.from(next), email });
  };
  const toggleEmail = (kind: string, on: boolean) => {
    save.mutate({ muted: Array.from(muted), email: { ...email, [kind]: on } });
  };
  return (
    <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden">
      <div className="flex items-center gap-3 px-3.5 pt-3 pb-2">
        <span className="w-8 h-8 rounded-[9px] bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <Bell className="w-4 h-4" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13.5px] font-semibold text-foreground">Notificações</div>
          <div className="text-[11.5px] text-muted-foreground">O que recebes (só da tua área e da tua cidade). Desliga o que não precisas.</div>
        </div>
      </div>
      {data && groups.length === 0 && (
        <p className="px-3.5 pb-3 text-[12px] text-muted-foreground">Não há notificações para o teu papel.</p>
      )}
      {groups.map(({ g, items }) => (
        <div key={g} className="border-t border-border">
          <div className="px-3.5 pt-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{NOTIFICATION_GROUP_LABELS[g]}</div>
          {items.map((k) => {
            const locked = "mandatory" in k && !!k.mandatory;
            const hasEmail = (k.channels as readonly string[]).includes("email");
            const appOn = locked ? true : !muted.has(k.kind);
            return (
              <div key={k.kind} className="px-3.5 py-2 border-t border-border/60 first-of-type:border-t-0">
                <label className="flex items-center gap-3 min-h-[40px]">
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-1 text-[13px] font-medium text-foreground">
                      {k.label}
                      {locked && <Lock className="w-3 h-3 text-muted-foreground" aria-label="Obrigatória" />}
                    </span>
                    <span className="block text-[11.5px] text-muted-foreground">{k.description}{locked ? " Obrigatória." : ""}</span>
                  </span>
                  <Switch
                    checked={appOn}
                    disabled={locked || !data || save.isPending}
                    onCheckedChange={(v) => toggle(k.kind, v)}
                    aria-label={`${k.label} na aplicação`}
                  />
                </label>
                {hasEmail && (
                  <label className="flex items-center gap-3 min-h-[36px] pl-1">
                    <span className="flex-1 flex items-center gap-1.5 text-[12px] text-muted-foreground"><Mail className="w-3.5 h-3.5" /> Também por email</span>
                    <Switch
                      checked={appOn && emailOn(k.kind, !!("emailDefault" in k && k.emailDefault))}
                      disabled={!appOn || !data || save.isPending}
                      onCheckedChange={(v) => toggleEmail(k.kind, v)}
                      aria-label={`${k.label} por email`}
                    />
                  </label>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
