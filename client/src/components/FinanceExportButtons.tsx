import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { can } from "@shared/access";
import { Button } from "@/components/ui/button";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";

type ExportInput =
  | { kind: "billing"; from: string; to: string; projectId?: number; granularity?: "day" | "week" | "month" | "year" }
  | { kind: "annual"; year: number; projectId?: number };

/**
 * Exportar CSV / XLSX da Faturação ou do Anual. Só aparece a quem tem a ação
 * "export" da Faturação (o servidor verifica outra vez — requireAccess).
 */
export default function FinanceExportButtons({ input }: { input: ExportInput }) {
  const { user } = useAuth();
  const mut = trpc.invoices.export.useMutation({
    onSuccess: (file) => {
      const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: file.mime }));
      const a = document.createElement("a");
      a.href = url;
      a.download = file.filename;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exportado: ${file.filename}`);
    },
    onError: (e) => toast.error(e.message || "Erro ao exportar"),
  });
  if (!can(user?.role, "faturacao", "export")) return null;
  const run = (format: "csv" | "xlsx") => mut.mutate({ ...input, format } as any);
  return (
    <div className="flex items-center gap-1">
      <Button size="sm" variant="outline" className="h-9" disabled={mut.isPending} onClick={() => run("xlsx")}>
        {mut.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Download className="w-3.5 h-3.5 mr-1" />} XLSX
      </Button>
      <Button size="sm" variant="outline" className="h-9" disabled={mut.isPending} onClick={() => run("csv")}>CSV</Button>
    </div>
  );
}
