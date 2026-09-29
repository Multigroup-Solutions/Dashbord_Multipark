// Botões do Google Drive para usar nas páginas:
//  - SaveToDriveButton: "Guardar no Drive" (anexo de email, prova de
//    reclamação) → pasta "Multipark" do Drive da pessoa. Os documentos do RH
//    NUNCA vão para o Drive (decisão do dono, 26 set 2026);
//  - ExportToSheetsButton: "Exportar para Sheets" de um relatório (os mesmos
//    dados e permissões da página; a folha fica na pasta "Multipark");
//  - ImportFromSheetButton: lê uma folha Google como CSV para as importações
//    existentes (a validação continua a ser a da importação).
// Sem o Drive ativo, os botões levam a "Ativar Drive" (autorização
// incremental; o resto que já foi autorizado mantém-se).
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { FileSpreadsheet, HardDrive, HardDriveUpload, Loader2, Sparkles } from "lucide-react";
import { SHEET_EXPORT_GATES, parseDriveFileId, type SheetExportInput, type SheetImportPurpose } from "@shared/drive";
import { can } from "@shared/access";
import { useAuth } from "@/_core/hooks/useAuth";
import { googleFeaturesHref } from "./GoogleSyncCard";
import { useGooglePicker } from "./useGooglePicker";

type SaveSource =
  | { kind: "mail_attachment"; messageId: number; index: number }
  | { kind: "complaint_photo"; id: number };

const here = () => window.location.pathname + window.location.search;

/** Estado do Drive da pessoa; `ready` = ligado e autorizado. */
function useDriveReady() {
  const s = trpc.googleDrive.status.useQuery(undefined, { staleTime: 60_000 });
  const d = s.data;
  return { loading: s.isLoading, configured: !!d?.configured, ready: !!d?.granted, connected: !!d?.connected, needsReauth: !!d?.needsReauth };
}

function openLinkToast(message: string, url: string | null | undefined) {
  if (url) toast.success(message, { action: { label: "Abrir", onClick: () => window.open(url, "_blank", "noopener,noreferrer") } });
  else toast.success(message);
}

export function SaveToDriveButton({ source, size = "sm", variant = "ghost", label = "Guardar no Drive", iconOnly = false, className }: {
  source: SaveSource; size?: "sm" | "default" | "icon"; variant?: "ghost" | "outline"; label?: string; iconOnly?: boolean; className?: string;
}) {
  const cls = className ?? (iconOnly ? "h-7 w-7" : undefined);
  const st = useDriveReady();
  const save = trpc.googleDrive.save.useMutation({
    onSuccess: (r) => openLinkToast(`Guardado no teu Drive (pasta "Multipark"): ${r.name}`, r.url),
    onError: (e) => toast.error(e.message),
  });
  if (!st.configured) return null;
  if (!st.ready) {
    return (
      <Button asChild size={iconOnly ? "icon" : size} variant={variant} className={cls} title="Ativar o Google Drive para guardar ficheiros">
        <a href={googleFeaturesHref(["drive"], here())} aria-label="Ativar o Google Drive"><HardDrive className="h-4 w-4" />{!iconOnly && <span className="ml-1">Ativar Drive</span>}</a>
      </Button>
    );
  }
  return (
    <Button type="button" size={iconOnly ? "icon" : size} variant={variant} className={cls} disabled={save.isPending} title={label} aria-label={label}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); save.mutate({ source }); }}>
      {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <HardDriveUpload className="h-4 w-4" />}{!iconOnly && <span className="ml-1">{label}</span>}
    </Button>
  );
}

export function ExportToSheetsButton({ input, disabled, size = "sm" }: { input: SheetExportInput; disabled?: boolean; size?: "sm" | "default" }) {
  const { user } = useAuth();
  const st = useDriveReady();
  const exp = trpc.googleDrive.sheets.export.useMutation({
    onSuccess: (r) => {
      openLinkToast(r.partial ? `Folha criada (incompleta — o relatório é grande): ${r.name}` : `Folha criada no teu Drive: ${r.name}`, r.url);
    },
    onError: (e) => toast.error(e.message),
  });
  const gate = SHEET_EXPORT_GATES[input.report];
  if (!st.configured || !user || !can(user as any, gate.module, gate.action)) return null;
  if (!st.ready) {
    return (
      <Button asChild size={size} variant="outline" title="Ativa o Google Drive para exportar para o Google Sheets">
        <a href={googleFeaturesHref(["drive"], here())}><Sparkles className="h-4 w-4 mr-1" />Ativar Sheets</a>
      </Button>
    );
  }
  return (
    <Button type="button" size={size} variant="outline" disabled={disabled || exp.isPending} onClick={() => exp.mutate(input)}>
      {exp.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <FileSpreadsheet className="h-4 w-4 mr-1 text-emerald-600" />}Exportar para Sheets
    </Button>
  );
}

/**
 * "Importar do Google Sheets": escolhe a folha (Picker) ou cola o link; o
 * servidor lê o 1.º separador e devolve CSV → `onCsv` (a página valida e
 * importa pelo caminho de sempre).
 */
export function ImportFromSheetButton({ purpose, onCsv, size = "sm" }: { purpose: SheetImportPurpose; onCsv: (csv: string) => void; size?: "sm" | "default" }) {
  const st = useDriveReady();
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState("");
  const picker = useGooglePicker();
  const read = trpc.googleDrive.sheets.readCsv.useMutation({
    onSuccess: (r) => {
      onCsv(r.csv);
      toast.success(`${r.rows} linha(s) lidas de "${r.title}". Confirma antes de importar.`);
      setOpen(false);
    },
    onError: (e) => toast.error(e.message),
  });
  if (!st.configured) return null;
  if (!st.ready) {
    return (
      <Button asChild size={size} variant="outline">
        <a href={googleFeaturesHref(["drive"], here())}><FileSpreadsheet className="h-4 w-4 mr-1 text-emerald-600" />Ativar Google Sheets</a>
      </Button>
    );
  }
  const pick = async () => {
    const f = await picker.open({ kind: "spreadsheet", title: "Escolher a folha a importar" });
    if (f) read.mutate({ link: f.id, purpose });
  };
  return (
    <>
      <Button type="button" size={size} variant="outline" onClick={() => (picker.available ? pick() : setOpen(true))} disabled={read.isPending || picker.busy}>
        {read.isPending || picker.busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <FileSpreadsheet className="h-4 w-4 mr-1 text-emerald-600" />}Importar do Google Sheets
      </Button>
      {picker.available && (
        <button type="button" className="text-[11.5px] text-primary underline ml-2" onClick={() => setOpen(true)}>colar link</button>
      )}
      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpen(false)}>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle className="flex items-center gap-2"><FileSpreadsheet className="h-5 w-5 text-emerald-600" />Importar do Google Sheets</DialogTitle></DialogHeader>
            <div className="space-y-2">
              <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" inputMode="url" />
              <p className="text-[11.5px] text-muted-foreground">
                Lê o primeiro separador. A app só tem acesso a folhas criadas por ela ou escolhidas com "Escolher do Drive"
                {picker.available ? "" : " (peça ao administrador para ativar o Google Picker)"} — com um link de outra folha a Google recusa o acesso.
              </p>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
              <Button disabled={!parseDriveFileId(link) || read.isPending} onClick={() => read.mutate({ link, purpose })}>
                {read.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Ler folha
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
