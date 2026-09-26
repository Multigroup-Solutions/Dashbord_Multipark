// Definições → Comunicação: calendários partilhados "Escala Multipark —
// <cidade>" escritos pela conta de serviço (delegação ao nível do domínio)
// em nome de uma conta dona — para quem não ligou a conta Google poder
// subscrever a escala. Só o super admin edita; os admins veem o estado.
import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { CalendarDays, ExternalLink, Loader2, RefreshCw, XCircle } from "lucide-react";
import { DWD_CALENDAR_SCOPES, SHARED_CALENDAR_CITIES, SHARED_CALENDAR_CITY_LABELS, sharedCalendarsConfigSchema, type SharedCalendarsConfig } from "@shared/googleSync";
import { fmtPTDateTime } from "@/lib/lisbonTime";

export function SharedCalendarsSettings() {
  const utils = trpc.useUtils();
  const q = trpc.googleCalendar.shared.get.useQuery(undefined, { retry: false });
  const [cfg, setCfg] = useState<SharedCalendarsConfig | null>(null);
  useEffect(() => { if (q.data) setCfg(q.data.config); }, [q.data]);
  const save = trpc.googleCalendar.shared.save.useMutation({
    onSuccess: () => { toast.success("Guardado. Os calendários são criados/atualizados na próxima sincronização."); utils.googleCalendar.shared.get.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const syncNow = trpc.googleCalendar.shared.syncNow.useMutation({
    onSuccess: (r) => {
      utils.googleCalendar.shared.get.invalidate();
      if (!r.configured) toast.message("Os calendários partilhados estão desligados.");
      else if (r.errors.length) toast.error(r.errors[0]);
      else toast.success("Calendários partilhados sincronizados.");
    },
    onError: (e) => toast.error(e.message),
  });
  if (q.error) return null;
  if (q.isLoading || !cfg || !q.data) return <Card><CardContent className="py-4"><Loader2 className="h-4 w-4 animate-spin" /></CardContent></Card>;
  const d = q.data;
  const canEdit = d.canEdit;
  const onSave = () => {
    const r = sharedCalendarsConfigSchema.safeParse(cfg);
    if (!r.success) { toast.error(r.error.issues.map((i) => i.message).join(" ")); return; }
    save.mutate(r.data);
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          <CalendarDays className="h-4 w-4 text-primary" /> Calendários partilhados da escala (Google)
          <Badge variant="outline" className={cfg.enabled ? "bg-emerald-100 text-emerald-800 border-emerald-200" : "bg-muted text-secondary-foreground"}>{cfg.enabled ? "Ligados" : "Desligados"}</Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Um calendário "Escala Multipark — cidade" por cidade com os turnos confirmados (e as passagens de turno, se ligadas abaixo), escrito pela conta de serviço em nome da conta dona.
          Quem não ligou a conta Google pode subscrevê-lo. Quem ligou recebe os seus turnos no próprio calendário "Multipark" (Perfil → Google).
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!d.dwd && (
          <p className="text-xs text-amber-800 dark:text-amber-200">Conta de serviço em falta no servidor (GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON).</p>
        )}
        {d.serviceAccountEmail && (
          <p className="text-[11.5px] text-muted-foreground break-all">
            Delegação ao nível do domínio (Admin Google): autoriza a conta de serviço <span className="font-mono">{d.serviceAccountEmail}</span> com os âmbitos{" "}
            <span className="font-mono">{DWD_CALENDAR_SCOPES.join(", ")}</span>.
          </p>
        )}
        <label className="flex items-center gap-3 min-h-[44px]">
          <Switch checked={cfg.enabled} disabled={!canEdit} onCheckedChange={(v) => setCfg({ ...cfg, enabled: v })} />
          <span>Escrever os calendários partilhados</span>
        </label>
        <div className="space-y-1">
          <Label htmlFor="shared-owner">Conta dona dos calendários (Workspace)</Label>
          <Input id="shared-owner" type="email" placeholder="escala@multipark.pt" value={cfg.ownerEmail} disabled={!canEdit}
            onChange={(e) => setCfg({ ...cfg, ownerEmail: e.target.value })} />
        </div>
        <div className="flex flex-wrap gap-4">
          {SHARED_CALENDAR_CITIES.map((c) => (
            <label key={c} className="flex items-center gap-2 min-h-[44px]">
              <Switch checked={cfg.cities[c]} disabled={!canEdit} onCheckedChange={(v) => setCfg({ ...cfg, cities: { ...cfg.cities, [c]: v } })} />
              <span>{SHARED_CALENDAR_CITY_LABELS[c]}</span>
            </label>
          ))}
        </div>
        <label className="flex items-center gap-3 min-h-[44px]">
          <Switch checked={cfg.shareWithDomain} disabled={!canEdit} onCheckedChange={(v) => setCfg({ ...cfg, shareWithDomain: v })} />
          <span>Partilhar (só leitura) com todo o domínio da conta dona</span>
        </label>
        <div className="rounded-lg border p-3 space-y-1">
          <div className="text-sm font-semibold">Eventos automáticos dos TL/supervisores</div>
          <p className="text-xs text-muted-foreground">
            Desligados por omissão. Os turnos confirmados de cada pessoa vão sempre para o calendário pessoal (Perfil → Google).
          </p>
          <label className="flex items-center gap-3 min-h-[44px]">
            <Switch checked={cfg.leadCityDayEvents} disabled={!canEdit} onCheckedChange={(v) => setCfg({ ...cfg, leadCityDayEvents: v })} />
            <span>Escala da cidade: um evento por dia (próximos 30 dias) no calendário do TL/supervisor</span>
          </label>
          <label className="flex items-center gap-3 min-h-[44px]">
            <Switch checked={cfg.handoverEvents} disabled={!canEdit} onCheckedChange={(v) => setCfg({ ...cfg, handoverEvents: v })} />
            <span>Passagem de turno (15h): um evento por dia no calendário do TL e nos calendários partilhados</span>
          </label>
        </div>
        {d.calendars.length > 0 && (
          <div className="space-y-1.5">
            {d.calendars.map((c) => (
              <div key={c.city} className="rounded-lg border px-3 py-2 text-xs flex flex-wrap items-center gap-2">
                <span className="font-semibold">{SHARED_CALENDAR_CITY_LABELS[c.city as keyof typeof SHARED_CALENDAR_CITY_LABELS] ?? c.city}</span>
                <span className="text-muted-foreground">{c.ownerEmail}</span>
                <span className="text-muted-foreground">{c.lastSyncAt ? `· ${fmtPTDateTime(c.lastSyncAt)}` : "· por sincronizar"}</span>
                {c.aclDomain && <Badge variant="outline">partilhado com {c.aclDomain}</Badge>}
                {c.subscribeUrl && <a href={c.subscribeUrl} target="_blank" rel="noreferrer" className="text-primary underline inline-flex items-center gap-1 ml-auto">Subscrever <ExternalLink className="h-3 w-3" /></a>}
                {c.lastError && <span className="w-full text-red-700 dark:text-red-300 break-words"><XCircle className="inline h-3 w-3 mr-1" />{c.lastError}</span>}
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {canEdit && (
            <Button size="sm" onClick={onSave} disabled={save.isPending}>
              {save.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Guardar
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => syncNow.mutate()} disabled={syncNow.isPending || !d.config.enabled}>
            {syncNow.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}Sincronizar agora
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
