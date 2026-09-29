// Definições → Comunicação → Contactos Google: diretório da empresa (conta de
// serviço com delegação, a impersonar uma conta do Workspace), grupo
// "Multipark — Serviço" (papéis e dias de retenção) e grupo opcional de
// parceiros. Só o super admin edita; os admins veem o estado.
import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { BookUser, Loader2, RefreshCw } from "lucide-react";
import { DIRECTORY_SCOPES, PUSH_GROUP_NAMES, contactsConfigSchema, serviceRoleEligible, type ContactsConfig } from "@shared/contacts";
import { ROLES, ROLE_LABELS, type Role } from "@shared/access";
import { fmtPTDateTime } from "@/lib/lisbonTime";

function RolePicker({ value, disabled, onChange, allowed }: { value: Role[]; disabled: boolean; onChange: (v: Role[]) => void; allowed?: (r: Role) => boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {ROLES.map((r) => {
        const ok = allowed ? allowed(r) : true;
        const on = ok && value.includes(r);
        return (
          <Button key={r} type="button" size="sm" variant={on ? "default" : "outline"} className="h-8" disabled={disabled || !ok}
            title={ok ? undefined : "Só supervisor ou acima pode receber dados de clientes no telemóvel."}
            onClick={() => onChange(on ? value.filter((x) => x !== r) : [...value, r])}>{ROLE_LABELS[r]}</Button>
        );
      })}
    </div>
  );
}

export function GoogleContactsSettings() {
  const utils = trpc.useUtils();
  const q = trpc.contacts.settings.get.useQuery(undefined, { retry: false });
  const dir = trpc.contacts.directory.status.useQuery(undefined, { retry: false });
  const [cfg, setCfg] = useState<ContactsConfig | null>(null);
  useEffect(() => { if (q.data) setCfg(q.data.config); }, [q.data]);
  const save = trpc.contacts.settings.save.useMutation({
    onSuccess: () => { toast.success("Guardado. Aplicado na próxima sincronização (até 10 min)."); utils.contacts.settings.get.invalidate(); utils.contacts.directory.status.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const sync = trpc.contacts.directory.syncNow.useMutation({
    onSuccess: (r) => {
      utils.contacts.directory.status.invalidate();
      if (!r.configured) toast.message("O diretório está desligado.");
      else if (r.error) toast.error(r.error);
      else toast.success(r.done ? `Diretório atualizado (${r.count ?? 0} pessoas).` : "Diretório a meio — continua na próxima corrida.");
    },
    onError: (e) => toast.error(e.message),
  });
  if (q.error) return null;
  if (q.isLoading || !cfg || !q.data) return <Card><CardContent className="py-4"><Loader2 className="h-4 w-4 animate-spin" /></CardContent></Card>;
  const d = q.data;
  const canEdit = d.canEdit;
  const onSave = () => {
    const r = contactsConfigSchema.safeParse(cfg);
    if (!r.success) { toast.error(r.error.issues.map((i) => i.message).join(" ")); return; }
    save.mutate(r.data);
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          <BookUser className="h-4 w-4 text-primary" /> Contactos Google
          <Badge variant="outline" className={cfg.directory.enabled ? "bg-emerald-100 text-emerald-800 border-emerald-200" : "bg-muted text-secondary-foreground"}>Diretório {cfg.directory.enabled ? "ligado" : "desligado"}</Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Diretório da empresa (foto, cargo e telefone nas listas e em Contactos) e os grupos que a app escreve nos Contactos Google de cada pessoa que ativou
          "Contactos" no Perfil. A app só apaga contactos que ela própria criou.
        </p>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="space-y-2">
          <div className="font-semibold text-[13px]">Diretório da empresa</div>
          {!d.dwd && <p className="text-xs text-amber-800 dark:text-amber-200">Conta de serviço em falta no servidor (GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON).</p>}
          {d.serviceAccountEmail && (
            <p className="text-[11.5px] text-muted-foreground break-all">
              Delegação ao nível do domínio (Admin Google): autoriza a conta de serviço <span className="font-mono">{d.serviceAccountEmail}</span> com o âmbito{" "}
              <span className="font-mono">{DIRECTORY_SCOPES.join(", ")}</span>.
            </p>
          )}
          <label className="flex items-center gap-3 min-h-[44px]">
            <Switch checked={cfg.directory.enabled} disabled={!canEdit} onCheckedChange={(v) => setCfg({ ...cfg, directory: { ...cfg.directory, enabled: v } })} />
            <span>Ler o diretório (1× por dia)</span>
          </label>
          <div className="space-y-1">
            <Label htmlFor="dir-admin">Conta do Workspace a usar (ex.: um administrador)</Label>
            <Input id="dir-admin" type="email" placeholder="admin@multipark.pt" value={cfg.directory.adminEmail} disabled={!canEdit}
              onChange={(e) => setCfg({ ...cfg, directory: { ...cfg.directory, adminEmail: e.target.value } })} />
          </div>
          {dir.data && (
            <p className="text-[11.5px] text-muted-foreground">
              {dir.data.count} pessoa(s) · {dir.data.lastFullSyncAt ? `última leitura completa ${fmtPTDateTime(dir.data.lastFullSyncAt)}` : "ainda não leu"}
              {dir.data.lastError ? <span className="block text-red-700 dark:text-red-300 break-words">{dir.data.lastError}</span> : null}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <div className="font-semibold text-[13px]">Grupo "{PUSH_GROUP_NAMES.service}"</div>
          <p className="text-[11.5px] text-muted-foreground">
            Clientes (nome, matrícula e telefone) das recolhas/entregas de hoje e amanhã: no turno confirmado da pessoa (±1 h) ou o dia inteiro da(s) sua(s) cidade(s)
            de base. Só para quem ativou "Contactos" no Perfil.
          </p>
          <Label>Papéis</Label>
          <RolePicker value={cfg.service.roles} disabled={!canEdit} allowed={serviceRoleEligible}
            onChange={(roles) => setCfg({ ...cfg, service: { ...cfg.service, roles: roles.filter(serviceRoleEligible) } })} />
          <p className="text-[11.5px] text-muted-foreground">
            Só supervisor ou acima (por omissão: supervisor, admin e super admin). O condutor e o team leader nunca recebem os contactos dos clientes no telemóvel —
            o servidor bloqueia-o mesmo que a lista os tenha.
          </p>
          <div className="grid grid-cols-2 gap-3 max-w-md">
            <div className="space-y-1">
              <Label htmlFor="ret-days">Retenção (dias depois do serviço)</Label>
              <Input id="ret-days" type="number" min={0} max={30} value={cfg.service.retentionDays} disabled={!canEdit}
                onChange={(e) => setCfg({ ...cfg, service: { ...cfg.service, retentionDays: Number(e.target.value) } })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="max-user">Máximo por pessoa</Label>
              <Input id="max-user" type="number" min={10} max={1000} value={cfg.service.maxPerUser} disabled={!canEdit}
                onChange={(e) => setCfg({ ...cfg, service: { ...cfg.service, maxPerUser: Number(e.target.value) } })} />
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <div className="font-semibold text-[13px]">Grupo "{PUSH_GROUP_NAMES.partners}"</div>
          <label className="flex items-center gap-3 min-h-[44px]">
            <Switch checked={cfg.partners.enabled} disabled={!canEdit} onCheckedChange={(v) => setCfg({ ...cfg, partners: { ...cfg.partners, enabled: v } })} />
            <span>Escrever os parceiros ativos (com telefone)</span>
          </label>
          <RolePicker value={cfg.partners.roles} disabled={!canEdit || !cfg.partners.enabled} onChange={(roles) => setCfg({ ...cfg, partners: { ...cfg.partners, roles } })} />
        </div>

        <div className="flex flex-wrap gap-2">
          {canEdit && (
            <Button size="sm" onClick={onSave} disabled={save.isPending}>
              {save.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Guardar
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => sync.mutate()} disabled={sync.isPending || !d.config.directory.enabled}>
            {sync.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}Ler o diretório agora
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
