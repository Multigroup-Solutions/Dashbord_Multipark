// Definições → Comunicação → Google Drive:
//  - Shared Drive "Multipark" da empresa (conta de serviço com delegação, a
//    impersonar a conta dona): pastas Clientes/Reclamações/RH criadas a
//    pedido, espelho opcional dos documentos do RH e das provas das
//    reclamações, relatórios ao vivo (folha fixa atualizada 1×/dia). Só o
//    super admin edita; os admins veem o estado.
//  - Modelos Google Docs com {{marcadores}} (admin e super admin).
import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { ExternalLink, FileText, HardDrive, Loader2, Plus, RefreshCw, Search } from "lucide-react";
import {
  DOC_TEMPLATE_ENTITIES, DOC_TEMPLATE_LABELS, DOC_TEMPLATE_TYPES, DRIVE_ENTITY_LABELS, DWD_DRIVE_SCOPES, LIVE_REPORT_KEYS, SHEET_EXPORT_LABELS,
  driveConfigSchema, placeholdersFor, type DocTemplateType, type DriveConfig, type GenerateEntityType,
} from "@shared/drive";
import { fmtPTDateTime } from "@/lib/lisbonTime";

export function GoogleDriveSettings() {
  const utils = trpc.useUtils();
  const q = trpc.googleDrive.settings.get.useQuery(undefined, { retry: false });
  const [cfg, setCfg] = useState<DriveConfig | null>(null);
  useEffect(() => { if (q.data) setCfg(q.data.config); }, [q.data]);
  const save = trpc.googleDrive.settings.save.useMutation({
    onSuccess: () => { toast.success("Guardado."); utils.googleDrive.settings.get.invalidate(); utils.googleDrive.status.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const runNow = trpc.googleDrive.settings.runNow.useMutation({
    onSuccess: (r) => {
      utils.googleDrive.settings.get.invalidate();
      if (!r.configured) toast.message("O Shared Drive está desligado.");
      else if (r.errors.length) toast.error(r.errors[0]);
      else toast.success(`Feito: ${r.mirrored} copiado(s)${r.live?.reports.length ? `, relatórios: ${r.live.reports.length}` : ""}${r.done ? "" : " — continua na próxima corrida"}.`);
    },
    onError: (e) => toast.error(e.message),
  });
  if (q.error) return null;
  if (q.isLoading || !cfg || !q.data) return <Card><CardContent className="py-4"><Loader2 className="h-4 w-4 animate-spin" /></CardContent></Card>;
  const d = q.data;
  const canEdit = d.canEdit;
  const onSave = () => {
    const r = driveConfigSchema.safeParse(cfg);
    if (!r.success) { toast.error(r.error.issues.map((i) => i.message).join(" ")); return; }
    save.mutate(r.data);
  };
  const mirrorCount = (type: string, status: string) => d.mirror.find((m) => m.sourceType === type && m.status === status)?.n ?? 0;
  const toggleReport = (k: (typeof LIVE_REPORT_KEYS)[number], on: boolean) => {
    const set = new Set(cfg.liveReports.reports);
    if (on) set.add(k); else set.delete(k);
    setCfg({ ...cfg, liveReports: { ...cfg.liveReports, reports: LIVE_REPORT_KEYS.filter((x) => set.has(x)) } });
  };

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2 flex-wrap">
            <HardDrive className="h-4 w-4 text-primary" /> Google Drive — Shared Drive da empresa
            <Badge variant="outline" className={cfg.sharedEnabled ? "bg-emerald-100 text-emerald-800 border-emerald-200" : "bg-muted text-secondary-foreground"}>{cfg.sharedEnabled ? "Ligado" : "Desligado"}</Badge>
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Pastas por registo criadas a pedido (Clientes/nome, Reclamações/ano/n.º, RH/cidade/trabalhador, Parcerias/nome, Relatórios), documentos gerados dos modelos
            e, opcionalmente, cópia dos documentos do RH e das provas das reclamações. O Drive pessoal de cada um liga-se no Perfil (só ficheiros da app).
          </p>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {!d.dwd && <p className="text-xs text-amber-800 dark:text-amber-200">Conta de serviço em falta no servidor (GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON).</p>}
          {d.serviceAccountEmail && (
            <p className="text-[11.5px] text-muted-foreground break-all">
              Delegação ao nível do domínio (Admin Google): autoriza a conta de serviço <span className="font-mono">{d.serviceAccountEmail}</span> com os âmbitos{" "}
              <span className="font-mono">{DWD_DRIVE_SCOPES.join(", ")}</span>. Cria o Shared Drive e junta a conta abaixo como <b>Gestor de conteúdo</b> (ou Gestor).
            </p>
          )}
          <label className="flex items-center gap-3 min-h-[44px]">
            <Switch checked={cfg.sharedEnabled} disabled={!canEdit} onCheckedChange={(v) => setCfg({ ...cfg, sharedEnabled: v })} />
            <span>Usar o Shared Drive da empresa</span>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="drive-owner">Conta do Workspace membro do Shared Drive</Label>
              <Input id="drive-owner" type="email" placeholder="drive@multipark.pt" value={cfg.ownerEmail} disabled={!canEdit} onChange={(e) => setCfg({ ...cfg, ownerEmail: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="drive-name">Nome do Shared Drive</Label>
              <Input id="drive-name" value={cfg.sharedDriveName} disabled={!canEdit} onChange={(e) => setCfg({ ...cfg, sharedDriveName: e.target.value })} />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="drive-rh">Shared Drive só do RH (opcional, recomendado — membros restritos)</Label>
              <Input id="drive-rh" placeholder="Multipark RH" value={cfg.rhDriveName} disabled={!canEdit} onChange={(e) => setCfg({ ...cfg, rhDriveName: e.target.value })} />
              <p className="text-[11px] text-muted-foreground">Vazio = pasta "RH" no Shared Drive principal (todos os membros dele a veem). Na app, os ficheiros do RH só aparecem a quem já vê os documentos do RH.</p>
            </div>
          </div>
          <label className="flex items-center gap-3 min-h-[44px]">
            <Switch checked={cfg.mirrorRhDocuments} disabled={!canEdit} onCheckedChange={(v) => setCfg({ ...cfg, mirrorRhDocuments: v })} />
            <span>Copiar os documentos do RH para RH/cidade/trabalhador <span className="text-muted-foreground">({mirrorCount("employee_document", "done")} copiados{mirrorCount("employee_document", "error") ? `, ${mirrorCount("employee_document", "error")} com erro` : ""})</span></span>
          </label>
          <label className="flex items-center gap-3 min-h-[44px]">
            <Switch checked={cfg.mirrorComplaintEvidence} disabled={!canEdit} onCheckedChange={(v) => setCfg({ ...cfg, mirrorComplaintEvidence: v })} />
            <span>Copiar as provas das reclamações para Reclamações/ano/n.º <span className="text-muted-foreground">({mirrorCount("complaint_photo", "done")} copiadas{mirrorCount("complaint_photo", "error") ? `, ${mirrorCount("complaint_photo", "error")} com erro` : ""})</span></span>
          </label>
          <div className="rounded-lg border p-3 space-y-2">
            <label className="flex items-center gap-3 min-h-[44px]">
              <Switch checked={cfg.liveReports.enabled} disabled={!canEdit} onCheckedChange={(v) => setCfg({ ...cfg, liveReports: { ...cfg.liveReports, enabled: v } })} />
              <span>Relatórios ao vivo (folha "Relatórios ao vivo — Multipark" em Relatórios/, atualizada 1×/dia)</span>
            </label>
            <div className="flex flex-wrap gap-4">
              {LIVE_REPORT_KEYS.map((k) => (
                <label key={k} className="flex items-center gap-2 min-h-[44px]">
                  <Switch checked={cfg.liveReports.reports.includes(k)} disabled={!canEdit} onCheckedChange={(v) => toggleReport(k, v)} />
                  <span>{SHEET_EXPORT_LABELS[k]}</span>
                </label>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="live-hour">A partir das</Label>
              <Input id="live-hour" type="number" min={0} max={23} className="w-20" value={cfg.liveReports.hour} disabled={!canEdit}
                onChange={(e) => setCfg({ ...cfg, liveReports: { ...cfg.liveReports, hour: Math.max(0, Math.min(23, Number(e.target.value) || 0)) } })} />
              <span className="text-muted-foreground">h (Lisboa)</span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Os números são calculados com as permissões de quem grava estas definições e ficam visíveis a todos os membros do Shared Drive.
              {d.liveLastRunAt ? ` Última atualização: ${fmtPTDateTime(d.liveLastRunAt)}.` : ""}
            </p>
            {d.liveSpreadsheetUrl && <a href={d.liveSpreadsheetUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline inline-flex items-center gap-1 text-xs">Abrir a folha <ExternalLink className="h-3 w-3" /></a>}
          </div>
          <div className="flex flex-wrap gap-2">
            {canEdit && (
              <Button size="sm" onClick={onSave} disabled={save.isPending}>
                {save.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Guardar
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => runNow.mutate()} disabled={runNow.isPending || !d.config.sharedEnabled}>
              {runNow.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}Correr agora
            </Button>
          </div>
        </CardContent>
      </Card>
      <DocTemplatesCard sharedReady={d.config.sharedEnabled && d.dwd} />
    </>
  );
}

function DocTemplatesCard({ sharedReady }: { sharedReady: boolean }) {
  const utils = trpc.useUtils();
  const q = trpc.googleDrive.templates.all.useQuery(undefined, { retry: false });
  const [form, setForm] = useState<{ id: number | null; name: string; templateType: DocTemplateType; link: string; description: string } | null>(null);
  const [found, setFound] = useState<string[] | null>(null);
  const inspect = trpc.googleDrive.templates.inspect.useMutation({ onSuccess: (r) => setFound(r.placeholders), onError: (e) => toast.error(e.message) });
  const save = trpc.googleDrive.templates.save.useMutation({
    onSuccess: () => { toast.success("Modelo guardado."); setForm(null); setFound(null); utils.googleDrive.templates.all.invalidate(); utils.googleDrive.templates.forEntity.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const setActive = trpc.googleDrive.templates.setActive.useMutation({
    onSuccess: () => { utils.googleDrive.templates.all.invalidate(); utils.googleDrive.templates.forEntity.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  if (q.error) return null;
  const list = q.data ?? [];
  const entities = form ? (DOC_TEMPLATE_ENTITIES[form.templateType] as readonly GenerateEntityType[]) : [];
  const catalog = form ? Array.from(new Map(entities.flatMap((e) => placeholdersFor(e)).map((p) => [p.key, p])).values()) : [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><FileText className="h-4 w-4 text-blue-600" /> Modelos de documentos (Google Docs)</CardTitle>
        <p className="text-xs text-muted-foreground">
          Um Google Doc com marcadores como {"{{nome}}"} ou {"{{cliente_nome}}"}. "Gerar documento" (RH, reclamações, clientes, parcerias) copia o modelo para a pasta do registo
          no Shared Drive (ou para o Drive de quem gera) e substitui os marcadores. Guarda o modelo no Shared Drive para a conta dona lhe chegar.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!sharedReady && <p className="text-xs text-amber-800 dark:text-amber-200">Liga primeiro o Shared Drive (acima): os modelos são lidos pela conta dona.</p>}
        {list.length === 0 && <p className="text-xs text-muted-foreground">Ainda sem modelos.</p>}
        {list.map((t) => (
          <div key={t.id} className="rounded-lg border px-3 py-2 flex flex-wrap items-center gap-2">
            <FileText className="h-4 w-4 text-blue-600" />
            <span className="font-medium">{t.name}</span>
            <Badge variant="outline">{DOC_TEMPLATE_LABELS[t.templateType]}</Badge>
            {!t.active && <Badge variant="outline" className="text-muted-foreground">desativado</Badge>}
            <span className="text-[11px] text-muted-foreground w-full sm:w-auto">{t.placeholders.length ? t.placeholders.map((p) => `{{${p}}}`).join(" ") : "sem marcadores"}</span>
            <span className="ml-auto flex gap-1">
              <a href={`https://docs.google.com/document/d/${encodeURIComponent(t.fileId)}/edit`} target="_blank" rel="noopener noreferrer" className="p-1.5 text-muted-foreground hover:text-foreground" aria-label="Abrir o modelo"><ExternalLink className="h-4 w-4" /></a>
              <Button size="sm" variant="ghost" onClick={() => { setFound(t.placeholders); setForm({ id: t.id, name: t.name, templateType: t.templateType, link: `https://docs.google.com/document/d/${t.fileId}/edit`, description: t.description ?? "" }); }}>Editar</Button>
              <Button size="sm" variant="ghost" disabled={setActive.isPending} onClick={() => setActive.mutate({ id: t.id, active: !t.active })}>{t.active ? "Desativar" : "Ativar"}</Button>
            </span>
          </div>
        ))}
        {form ? (
          <div className="rounded-lg border p-3 space-y-2">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Nome</Label>
                <Input value={form.name} maxLength={160} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Contrato a termo — condutor" />
              </div>
              <div className="space-y-1">
                <Label>Tipo</Label>
                <Select value={form.templateType} onValueChange={(v) => setForm({ ...form, templateType: v as DocTemplateType })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{DOC_TEMPLATE_TYPES.map((t) => <SelectItem key={t} value={t}>{DOC_TEMPLATE_LABELS[t]} ({DOC_TEMPLATE_ENTITIES[t].map((e) => DRIVE_ENTITY_LABELS[e]).join(", ")})</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label>Link do Google Doc</Label>
                <div className="flex gap-2">
                  <Input value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} placeholder="https://docs.google.com/document/d/…" inputMode="url" />
                  <Button size="sm" variant="outline" disabled={inspect.isPending || !form.link} onClick={() => inspect.mutate({ link: form.link })}>
                    {inspect.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}<span className="ml-1 hidden sm:inline">Ler marcadores</span>
                  </Button>
                </div>
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label>Descrição (opcional)</Label>
                <Textarea rows={2} maxLength={500} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </div>
            </div>
            {found && (
              <p className="text-[11.5px]">
                Marcadores no modelo: {found.length ? found.map((p) => (
                  <span key={p} className={`font-mono mr-1 ${catalog.some((c) => c.key === p) ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}`}>{`{{${p}}}`}</span>
                )) : "nenhum"}
              </p>
            )}
            <details className="text-[11.5px] text-muted-foreground">
              <summary className="cursor-pointer">Marcadores disponíveis para este tipo</summary>
              <ul className="mt-1 grid sm:grid-cols-2 gap-x-4">
                {catalog.map((p) => <li key={p.key}><span className="font-mono">{`{{${p.key}}}`}</span> — {p.label}</li>)}
              </ul>
            </details>
            <div className="flex gap-2">
              <Button size="sm" disabled={save.isPending || form.name.trim().length < 2 || !form.link} onClick={() => save.mutate({ id: form.id, name: form.name, templateType: form.templateType, link: form.link, description: form.description || null })}>
                {save.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Guardar modelo
              </Button>
              <Button size="sm" variant="outline" onClick={() => { setForm(null); setFound(null); }}>Cancelar</Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="outline" disabled={!sharedReady} onClick={() => setForm({ id: null, name: "", templateType: "contrato_trabalho", link: "", description: "" })}>
            <Plus className="h-4 w-4 mr-1" />Registar modelo
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
