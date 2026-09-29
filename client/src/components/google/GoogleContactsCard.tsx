// Perfil → Google → Contactos: "Ativar Contactos" (autorização incremental —
// o que já está autorizado mantém-se), o grupo "Multipark — Serviço" no
// telemóvel (clientes das recolhas/entregas de hoje e amanhã, apagados depois
// da retenção — só os que a app criou) e as sugestões a partir dos contactos
// Google. O token nunca chega ao browser; os contactos só a própria pessoa vê.
import type { ReactNode } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { AlertTriangle, BookUser, Handshake, Loader2, PhoneCall, RefreshCw, Sparkles, Users } from "lucide-react";
import { PUSH_GROUP_NAMES, DEFAULT_GOOGLE_CONTACTS_PREFS, type GoogleContactsPrefs } from "@shared/contacts";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { can } from "@shared/access";
import { useAuth } from "@/_core/hooks/useAuth";
import { googleFeaturesHref } from "./GoogleSyncCard";

const STATUS_LABEL: Record<string, string> = {
  ok: "Sincronizado", partial: "Em curso (continua na próxima corrida)", skipped: "Nada a sincronizar", reauth_required: "Conta por religar",
  scope_missing: "Falta autorizar", rate_limited: "Limite de pedidos da Google — continua daqui a pouco", error: "Erro",
};

export function GoogleContactsCard({ returnTo = "/perfil" }: { returnTo?: string }) {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const q = trpc.googleAccount.contacts.status.useQuery(undefined, { staleTime: 30_000 });
  const setPrefs = trpc.googleAccount.contacts.setPrefs.useMutation({
    onSuccess: () => { utils.googleAccount.contacts.status.invalidate(); toast.success("Preferências guardadas. Aplicadas na próxima sincronização."); },
    onError: (e) => toast.error(e.message),
  });
  const syncNow = trpc.googleAccount.contacts.syncNow.useMutation({
    onSuccess: (r) => {
      utils.googleAccount.contacts.status.invalidate();
      if (r.status === "ok") toast.success("Contactos sincronizados.");
      else if (r.status === "partial" || r.status === "rate_limited") toast.message("Sincronização a meio — continua automaticamente.");
      else toast.error(r.error || STATUS_LABEL[r.status] || "Não foi possível sincronizar.");
    },
    onError: (e) => toast.error(e.message),
  });
  const s = q.data;
  if (q.isLoading) return <div className="bg-card border border-border rounded-2xl p-4"><Loader2 className="h-4 w-4 animate-spin" /></div>;
  if (!s || !s.account.configured) return null;
  const connected = s.account.connected;
  const needsReauth = s.account.status === "reauth_required" || s.account.status === "error";
  const prefs: GoogleContactsPrefs = s.prefs ?? DEFAULT_GOOGLE_CONTACTS_PREFS;
  const toggle = (key: keyof GoogleContactsPrefs, value: boolean) => setPrefs.mutate({ ...prefs, [key]: value });
  const seesContacts = can(user as any, "contactos", "view");

  return (
    <div className="bg-card border border-border rounded-2xl shadow-sm p-4 space-y-3">
      <div className="flex items-center gap-3">
        <span className="w-8 h-8 rounded-[9px] bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <BookUser className="w-4 h-4" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13.5px] font-semibold text-foreground">Google Contactos</div>
          <div className="text-[11.5px] text-muted-foreground">
            {connected ? "Quem te liga aparece identificado e os teus contactos sugerem ligações a clientes." : "Liga primeiro a tua conta Google (acima)."}
          </div>
        </div>
      </div>

      {connected && !needsReauth && !s.granted && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
          <p className="text-xs text-foreground">
            Autoriza os Contactos para: {s.serviceAllowed ? <>veres no telemóvel quem te liga (grupo "{PUSH_GROUP_NAMES.service}" com os clientes dos teus serviços de hoje e amanhã, apagados {s.retentionDays} dia(s) depois); </> : null}
            receber sugestões de ligação entre os teus contactos Google e os clientes, leads e parceiros. A app só apaga contactos que ela própria criou.
          </p>
          <Button asChild size="sm">
            <a href={googleFeaturesHref(["contacts"], returnTo)}><Sparkles className="h-4 w-4 mr-1" />Ativar Contactos</a>
          </Button>
        </div>
      )}

      {connected && s.granted && (
        <div className="space-y-2">
          <PrefRow icon={<PhoneCall className="h-4 w-4 text-primary" />} label={`Grupo "${PUSH_GROUP_NAMES.service}"`}
            hint={s.serviceAllowed
              ? `Clientes das recolhas/entregas de hoje e amanhã do teu turno (ou da tua cidade), com nome e matrícula. Apagados ${s.retentionDays} dia(s) depois do serviço.${s.counts.service ? ` Agora: ${s.counts.service}.` : ""}`
              : "Não disponível para o teu papel (Definições → Comunicação → Contactos Google)."}
            checked={s.serviceAllowed && prefs.serviceGroup} disabled={!s.serviceAllowed || setPrefs.isPending} onChange={(v) => toggle("serviceGroup", v)} />
          {s.partnersAllowed && (
            <PrefRow icon={<Handshake className="h-4 w-4 text-primary" />} label={`Grupo "${PUSH_GROUP_NAMES.partners}"`}
              hint={`Parceiros ativos com telefone.${s.counts.partners ? ` Agora: ${s.counts.partners}.` : ""}`}
              checked={prefs.partnersGroup} disabled={setPrefs.isPending} onChange={(v) => toggle("partnersGroup", v)} />
          )}
          <PrefRow icon={<Users className="h-4 w-4 text-primary" />} label="Sugestões a partir dos meus contactos"
            hint={`Lê "Os meus contactos" e "Outros contactos" (só nome, email e telefone; só tu os vês) para sugerir ligações e criar clientes/leads.${s.counts.contacts ? ` ${s.counts.contacts} lido(s).` : ""} Desligar apaga o que foi lido.`}
            checked={prefs.suggestions} disabled={setPrefs.isPending} onChange={(v) => toggle("suggestions", v)} />
        </div>
      )}

      {connected && s.granted && (s.lastError || s.lastWarning) && (
        <p className={`text-xs ${s.lastError ? "text-red-700 dark:text-red-300" : "text-amber-800 dark:text-amber-200"}`}>
          <AlertTriangle className="inline h-3 w-3 mr-1" />{s.lastError ?? s.lastWarning}
        </p>
      )}
      {connected && s.granted && (
        <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground">
          <span>{s.lastRunAt ? `Última sincronização: ${fmtPTDateTime(s.lastRunAt)}` : "Ainda não sincronizou."}</span>
          {s.lastStatus && <span>· {STATUS_LABEL[s.lastStatus] ?? s.lastStatus}</span>}
          {seesContacts && prefs.suggestions && <Link href="/contactos?tab=google" className="text-primary underline">Ver sugestões</Link>}
          <Button size="sm" variant="outline" className="ml-auto" disabled={syncNow.isPending} onClick={() => syncNow.mutate()}>
            {syncNow.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}Sincronizar agora
          </Button>
        </div>
      )}
    </div>
  );
}

function PrefRow({ label, hint, checked, disabled, onChange, icon }: { label: string; hint: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; icon?: ReactNode }) {
  return (
    <label className={`flex items-start gap-3 rounded-lg border px-3 py-2 min-h-[44px] ${disabled ? "opacity-60" : "cursor-pointer"}`}>
      {icon && <span className="mt-0.5">{icon}</span>}
      <span className="flex-1 min-w-0">
        <span className="block text-[13px] font-medium text-foreground">{label}</span>
        <span className="block text-[11.5px] text-muted-foreground">{hint}</span>
      </span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} className="mt-0.5" />
    </label>
  );
}
