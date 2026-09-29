// Ficheiros do Google Drive ligados a um registo (cliente, reclamação,
// conversa de email, colaborador/RH, tarefa, parceria): lista com ícone e
// link, "Anexar do Drive" (colar o link ou escolher com o Google Picker) e
// "Gerar documento" a partir dos modelos Google Docs. Só referências — o
// ficheiro fica no Drive e o link respeita as partilhas do próprio Drive.
// As permissões são as do registo (o servidor verifica sempre).
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import {
  ExternalLink, File, FileImage, FilePlus2, FileSpreadsheet, FileText, FileVideo, Folder, HardDrive, Link2, Loader2, Presentation, Sparkles, Trash2, Wand2,
} from "lucide-react";
import {
  DOC_TEMPLATE_LABELS, driveFileKind, parseDriveFileId, type DriveEntityType, type DriveFileKind, type GenerateEntityType,
} from "@shared/drive";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { googleFeaturesHref } from "./GoogleSyncCard";
import { useGooglePicker } from "./useGooglePicker";

const KIND_ICON: Record<DriveFileKind, typeof File> = {
  folder: Folder, doc: FileText, sheet: FileSpreadsheet, slides: Presentation, pdf: FileText, image: FileImage, video: FileVideo, other: File,
};
const KIND_COLOR: Record<DriveFileKind, string> = {
  folder: "text-muted-foreground", doc: "text-blue-600", sheet: "text-emerald-600", slides: "text-amber-600", pdf: "text-red-600",
  image: "text-purple-600", video: "text-pink-600", other: "text-muted-foreground",
};
const SOURCE_LABEL: Record<string, string> = { link: "ligado", picker: "ligado", saved: "guardado", generated: "gerado", pdf: "PDF gerado" };

export function DriveFileIcon({ mimeType, className = "h-4 w-4" }: { mimeType: string | null | undefined; className?: string }) {
  const k = driveFileKind(mimeType);
  const Icon = KIND_ICON[k];
  return <Icon className={`${className} ${KIND_COLOR[k]} shrink-0`} />;
}

const GENERATE_TYPES: readonly DriveEntityType[] = ["employee", "complaint", "client", "partner"];

export function DriveFilesPanel({ entityType, entityId, title = "Google Drive", compact = false }: { entityType: DriveEntityType; entityId: string | number | null | undefined; title?: string; compact?: boolean }) {
  const id = entityId == null ? "" : String(entityId).trim();
  const utils = trpc.useUtils();
  const q = trpc.googleDrive.links.list.useQuery({ entityType, entityId: id }, { enabled: !!id, retry: false, staleTime: 30_000 });
  const status = trpc.googleDrive.status.useQuery(undefined, { staleTime: 60_000 });
  const canGenerate = GENERATE_TYPES.includes(entityType);
  const templates = trpc.googleDrive.templates.forEntity.useQuery({ entityType }, { enabled: !!id && canGenerate && !!q.data?.canEdit, staleTime: 60_000 });
  const remove = trpc.googleDrive.links.remove.useMutation({
    onSuccess: () => { utils.googleDrive.links.list.invalidate({ entityType, entityId: id }); toast.success("Ligação removida (o ficheiro continua no Drive)."); },
    onError: (e) => toast.error(e.message),
  });
  const [attachOpen, setAttachOpen] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  if (!id || q.error || !status.data?.configured) return null;
  const d = q.data;
  const links = d?.links ?? [];
  const s = status.data;

  return (
    <div className={compact ? "space-y-2" : "rounded-xl border border-border bg-card p-3 space-y-2"}>
      <div className="flex items-center gap-2 flex-wrap">
        <HardDrive className="h-4 w-4 text-primary" />
        <span className="text-[13px] font-semibold text-foreground">{title}</span>
        {links.length > 0 && <span className="text-[11.5px] text-muted-foreground">({links.length})</span>}
        {d?.canEdit && (
          <span className="ml-auto flex gap-1.5 flex-wrap">
            <Button type="button" size="sm" variant="outline" onClick={() => setAttachOpen(true)}><Link2 className="h-4 w-4 mr-1" />Anexar do Drive</Button>
            {canGenerate && (templates.data?.length ?? 0) > 0 && (
              <Button type="button" size="sm" variant="outline" onClick={() => setGenOpen(true)}><Wand2 className="h-4 w-4 mr-1" />Gerar documento</Button>
            )}
          </span>
        )}
      </div>
      {q.isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : links.length === 0 ? (
        <p className="text-xs text-muted-foreground">Sem ficheiros do Drive ligados.</p>
      ) : (
        <ul className="divide-y divide-border">
          {links.map((l) => (
            <li key={l.id} className="flex items-center gap-2 py-1.5 min-h-[40px]">
              <DriveFileIcon mimeType={l.mimeType} />
              <a href={l.webViewLink ?? "#"} target="_blank" rel="noopener noreferrer" className="flex-1 min-w-0 text-[13px] text-foreground hover:underline truncate" title={l.name}>
                {l.name}
              </a>
              <span className="hidden sm:inline text-[11px] text-muted-foreground whitespace-nowrap">
                {SOURCE_LABEL[l.source] ?? l.source}{l.location === "shared" ? " · Shared Drive" : ""}{l.createdByName ? ` · ${l.createdByName}` : ""}{l.createdAt ? ` · ${fmtPTDateTime(l.createdAt)}` : ""}
              </span>
              <a href={l.webViewLink ?? "#"} target="_blank" rel="noopener noreferrer" aria-label="Abrir no Google Drive" className="p-1.5 text-muted-foreground hover:text-foreground">
                <ExternalLink className="h-4 w-4" />
              </a>
              {d?.canEdit && (
                <button type="button" aria-label="Remover ligação" className="p-1.5 text-muted-foreground hover:text-red-600" disabled={remove.isPending}
                  onClick={() => { if (confirm("Remover a ligação? O ficheiro continua no Google Drive.")) remove.mutate({ id: l.id }); }}>
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {d?.canEdit && s.connected && !s.granted && !s.needsReauth && (
        <p className="text-[11.5px] text-muted-foreground">
          <Sparkles className="inline h-3 w-3 mr-1 text-primary" />
          <a className="text-primary underline" href={googleFeaturesHref(["drive"], window.location.pathname + window.location.search)}>Ativa o Drive</a> para ver nomes e tipos, escolher ficheiros do Drive e guardar documentos na tua pasta "Multipark".
        </p>
      )}
      {attachOpen && <AttachDialog entityType={entityType} entityId={id} onClose={() => setAttachOpen(false)} />}
      {genOpen && canGenerate && (
        <GenerateDialog entityType={entityType as GenerateEntityType} entityId={id} label={d?.label ?? ""} sharedAvailable={!!s.sharedEnabled && !!d?.hasSharedFolder}
          userAvailable={!!s.granted} templates={templates.data ?? []} onClose={() => setGenOpen(false)} />
      )}
    </div>
  );
}

/** Botão que abre os ficheiros do Drive de um registo (listas com muitas linhas — carrega só ao abrir). */
export function DriveFilesButton({ entityType, entityId, title }: { entityType: DriveEntityType; entityId: string | number; title: string }) {
  const [open, setOpen] = useState(false);
  const status = trpc.googleDrive.status.useQuery(undefined, { staleTime: 60_000 });
  if (!status.data?.configured) return null;
  return (
    <>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)} aria-label="Ficheiros do Google Drive" title="Google Drive (ficheiros e documentos gerados)">
        <HardDrive className="h-4 w-4" />
      </Button>
      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpen(false)}>
          <DialogContent className="max-w-2xl">
            <DialogHeader><DialogTitle className="flex items-center gap-2"><HardDrive className="h-5 w-5 text-primary" />{title}</DialogTitle></DialogHeader>
            <DriveFilesPanel entityType={entityType} entityId={entityId} title="Ficheiros" compact />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function AttachDialog({ entityType, entityId, onClose }: { entityType: DriveEntityType; entityId: string; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [link, setLink] = useState("");
  const [name, setName] = useState("");
  const picker = useGooglePicker();
  const status = trpc.googleDrive.status.useQuery(undefined, { staleTime: 60_000 });
  const attach = trpc.googleDrive.links.attach.useMutation({
    onSuccess: () => { utils.googleDrive.links.list.invalidate({ entityType, entityId }); toast.success("Ficheiro do Drive ligado."); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  const valid = !!parseDriveFileId(link);
  const pick = async () => {
    const f = await picker.open();
    if (f) attach.mutate({ entityType, entityId, link: f.id, name: f.name, source: "picker" });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Link2 className="h-5 w-5 text-primary" />Anexar do Google Drive</DialogTitle></DialogHeader>
        <div className="space-y-3">
          {picker.available && status.data?.granted && (
            <Button type="button" variant="outline" className="w-full" disabled={picker.busy || attach.isPending} onClick={pick}>
              {picker.busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <HardDrive className="h-4 w-4 mr-1" />}Escolher do Drive
            </Button>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="drive-link">Link do ficheiro (Drive, Docs, Sheets ou Slides)</Label>
            <Input id="drive-link" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://drive.google.com/file/d/…" inputMode="url" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="drive-name">Nome a mostrar (se a app não tiver acesso ao ficheiro)</Label>
            <Input id="drive-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="Ex.: Orçamento da reparação" />
          </div>
          <p className="text-[11.5px] text-muted-foreground">
            Guarda-se só a referência (nome, tipo e link). Quem abre o link precisa de ter acesso ao ficheiro no Google Drive.
          </p>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={!valid || attach.isPending} onClick={() => attach.mutate({ entityType, entityId, link, name: name || null, source: "link" })}>
            {attach.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Ligar ficheiro
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GenerateDialog({ entityType, entityId, label, templates, sharedAvailable, userAvailable, onClose }: {
  entityType: GenerateEntityType; entityId: string; label: string; sharedAvailable: boolean; userAvailable: boolean;
  templates: Array<{ id: number; name: string; templateType: string; description: string | null }>; onClose: () => void;
}) {
  const utils = trpc.useUtils();
  // RH: os documentos nunca vão para o Drive — só o PDF nos documentos da ficha (26 set 2026).
  const hrOnlyApp = entityType === "employee";
  const [templateId, setTemplateId] = useState(templates[0] ? String(templates[0].id) : "");
  const [destination, setDestination] = useState<"shared" | "user">(sharedAvailable ? "shared" : "user");
  const [pdf, setPdf] = useState(entityType === "complaint");
  const [result, setResult] = useState<{ url: string | null; pdfUrl?: string | null; warnings: string[]; missing: string[] } | null>(null);
  const [step, setStep] = useState<"idle" | "doc" | "pdf">("idle");
  const generate = trpc.googleDrive.generate.useMutation();
  const toPdf = trpc.googleDrive.pdf.useMutation();
  const run = async () => {
    try {
      setStep("doc");
      if (hrOnlyApp) {
        const r = await generate.mutateAsync({ templateId: Number(templateId), entityType, entityId, destination: "app" });
        setResult({ url: null, pdfUrl: null, warnings: r.warnings, missing: r.missing });
        utils.rh.documents.list.invalidate().catch(() => {});
        toast.success("PDF gerado e guardado nos documentos da ficha.");
        return;
      }
      const r = await generate.mutateAsync({ templateId: Number(templateId), entityType, entityId, destination });
      let pdfUrl: string | null = null;
      if (pdf && r.linkId != null) {
        setStep("pdf");
        try { pdfUrl = (await toPdf.mutateAsync({ linkId: r.linkId })).url; }
        catch (e: any) { toast.error(`Documento criado, mas o PDF falhou: ${e.message}`); }
      }
      setResult({ url: r.url, pdfUrl, warnings: r.warnings, missing: r.missing });
      utils.googleDrive.links.list.invalidate({ entityType, entityId });
      toast.success("Documento gerado.");
    } catch (e: any) {
      toast.error(e.message);
    } finally { setStep("idle"); }
  };
  const busy = step !== "idle";
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><FilePlus2 className="h-5 w-5 text-primary" />Gerar documento</DialogTitle></DialogHeader>
        {result ? (
          <div className="space-y-2 text-sm">
            <p>{hrOnlyApp ? <>PDF criado para <b>{label}</b> e guardado nos documentos da ficha (nada fica no Google Drive).</> : <>Documento criado para <b>{label}</b>.</>}</p>
            {result.url && <a className="text-primary underline flex items-center gap-1" href={result.url} target="_blank" rel="noopener noreferrer"><FileText className="h-4 w-4" />Abrir o documento</a>}
            {result.pdfUrl && <a className="text-primary underline flex items-center gap-1" href={result.pdfUrl} target="_blank" rel="noopener noreferrer"><FileText className="h-4 w-4 text-red-600" />Abrir o PDF</a>}
            {result.warnings.map((w) => <p key={w} className="text-xs text-amber-800 dark:text-amber-200">{w}</p>)}
            {result.missing.length > 0 && <p className="text-xs text-muted-foreground">Marcadores sem valor na app (ficaram como estão): {result.missing.map((m) => `{{${m}}}`).join(", ")}</p>}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Modelo</Label>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger><SelectValue placeholder="Escolhe o modelo" /></SelectTrigger>
                <SelectContent>
                  {templates.map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name} · {DOC_TEMPLATE_LABELS[t.templateType as keyof typeof DOC_TEMPLATE_LABELS] ?? t.templateType}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {hrOnlyApp ? (
              <p className="text-xs text-muted-foreground">
                O PDF fica só nos documentos da ficha, na app. Os documentos do RH nunca vão para o Google Drive (a cópia de trabalho é apagada logo a seguir).
              </p>
            ) : (<>
            <div className="space-y-1.5">
              <Label>Onde guardar</Label>
              <Select value={destination} onValueChange={(v) => setDestination(v as "shared" | "user")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {sharedAvailable && <SelectItem value="shared">Shared Drive da empresa (pasta do registo)</SelectItem>}
                  <SelectItem value="user" disabled={!userAvailable}>O meu Drive (pasta "Multipark"){userAvailable ? "" : " — ativa o Drive no Perfil"}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-2 text-sm min-h-[44px]">
              <Checkbox checked={pdf} onCheckedChange={(v) => setPdf(!!v)} />
              Criar também o PDF e anexá-lo ao registo
            </label>
            </>)}
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>{result ? "Fechar" : "Cancelar"}</Button>
          {!result && (
            <Button disabled={!templateId || busy || (!hrOnlyApp && destination === "user" && !userAvailable)} onClick={run}>
              {busy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}{step === "pdf" ? "A criar o PDF…" : step === "doc" ? "A gerar…" : "Gerar"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
