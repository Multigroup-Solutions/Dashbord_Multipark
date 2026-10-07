/**
 * 41c (Jorge, 7 out 2026: "cada um tem de poder alterar as suas informações e
 * carregar os seus ficheiros"): com o acesso BLOQUEADO (ex.: documentos em
 * falta), a pessoa ainda carrega os SEUS documentos daqui — antes o bloqueio
 * fechava tudo e nunca se saía dele. O servidor só deixa a própria ficha.
 */
import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Upload } from "lucide-react";

/** Os que o próprio carrega (o contrato, o termo e o seguro são do RH). */
const SELF_DOCS: Array<[string, string]> = [
  ["id_card", "Documento de identificação (CC / BI)"],
  ["residence_permit", "Título de residência"],
  ["driving_license", "Carta de condução"],
  ["nib_proof", "Comprovativo do IBAN"],
  ["address_proof", "Comprovativo de morada"],
  ["photo", "Fotografia"],
  ["other", "Outro"],
];
const LABEL = Object.fromEntries(SELF_DOCS) as Record<string, string>;
const MAX_BYTES = 10 * 1024 * 1024;

const toBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

export function BlockedOwnDocuments() {
  const me = trpc.rh.me.useQuery(undefined, { retry: false });
  const employeeId: number | undefined = (me.data as any)?.employee?.id;
  const checklist = trpc.rh.documents.checklist.useQuery({ employeeId: employeeId ?? 0 }, { enabled: !!employeeId, retry: false });
  const [docType, setDocType] = useState("id_card");
  const upload = trpc.rh.documents.uploadBatch.useMutation({
    onSuccess: () => { toast.success("Documento carregado. O RH revê e liberta o acesso."); checklist.refetch(); },
    onError: (e) => toast.error(e.message),
  });
  if (!employeeId) return null;
  const missing = (checklist.data ?? []).filter((d: any) => !d.present && LABEL[d.docType]).map((d: any) => LABEL[d.docType]);

  const onFiles = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(ev.target.files ?? []).slice(0, 10);
    ev.target.value = "";
    if (!files.length) return;
    if (files.some((f) => f.size > MAX_BYTES)) { toast.error("Cada ficheiro pode ter até 10 MB."); return; }
    const payload = await Promise.all(files.map(async (f) => ({ fileBase64: await toBase64(f), mimeType: f.type || "application/octet-stream", fileName: f.name.slice(0, 200) })));
    upload.mutate({ employeeId, docType: docType as any, files: payload });
  };

  return (
    <div className="space-y-2 border-t pt-3 text-left">
      <p className="text-sm font-medium">Carregar os teus documentos</p>
      {missing.length > 0 && <p className="text-xs text-muted-foreground">Faltam: {missing.join(", ")}.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={docType} onValueChange={setDocType}>
          <SelectTrigger className="h-9 w-56 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>{SELF_DOCS.map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
        </Select>
        <label className="cursor-pointer">
          <input type="file" multiple accept="image/*,application/pdf" className="hidden" onChange={onFiles} disabled={upload.isPending} />
          <Button type="button" size="sm" asChild disabled={upload.isPending}>
            <span>{upload.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Upload className="mr-1 h-4 w-4" />}{upload.isPending ? "A carregar…" : "Escolher ficheiro"}</span>
          </Button>
        </label>
      </div>
      <p className="text-[11px] text-muted-foreground">Fotografia ou PDF, até 10 MB cada. O contrato e o termo de responsabilidade são carregados pelo RH.</p>
    </div>
  );
}
