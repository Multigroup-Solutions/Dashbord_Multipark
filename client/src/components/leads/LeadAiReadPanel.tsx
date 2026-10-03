import { FileText, Sparkles } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { DOC_KIND_LABEL } from "@shared/rhAttachments";

/**
 * D39 (Jorge, 3 out 2026): o que a IA leu nos anexos do email do RH.
 * O resumo do CV é para quem entrevista; NIF e números dos documentos só
 * chegam ao ecrã do RH (o servidor tira-os aos outros).
 */
export function LeadAiReadPanel({ lead }: {
  lead: { id: number; aiSummary?: string | null; nif?: string | null; idDocNumber?: string | null; drivingLicenseNumber?: string | null };
}) {
  const reads = trpc.extraLeads.attachmentReads.useQuery({ leadId: lead.id }, { staleTime: 60_000, retry: false });
  const ids = [
    lead.nif ? `NIF ${lead.nif}` : null,
    lead.idDocNumber ? `BI/CC ${lead.idDocNumber}` : null,
    lead.drivingLicenseNumber ? `Carta ${lead.drivingLicenseNumber}` : null,
  ].filter(Boolean) as string[];
  const list = reads.data ?? [];
  if (!lead.aiSummary && !ids.length && !list.length) return null;
  return (
    <div className="rounded-md border bg-violet-50/60 dark:bg-violet-950/30 p-2.5 space-y-1.5 text-xs">
      <div className="flex items-center gap-1.5 font-medium text-violet-900 dark:text-violet-100">
        <Sparkles className="h-3.5 w-3.5" /> Lido pela IA nos anexos do email
      </div>
      {lead.aiSummary && <p className="whitespace-pre-wrap text-foreground">{lead.aiSummary}</p>}
      {ids.length > 0 && <p className="text-muted-foreground">{ids.join(" · ")}</p>}
      {list.length > 0 && (
        <ul className="space-y-0.5 text-muted-foreground">
          {list.map((r, i) => (
            <li key={i} className="flex items-center gap-1.5">
              <FileText className="h-3 w-3 shrink-0" />
              <span className="truncate">{r.filename ?? "anexo"}</span>
              <span className="shrink-0">
                — {r.status === "done" ? (DOC_KIND_LABEL[r.docKind ?? ""] ?? "lido") : r.status === "skipped" ? `não lido (${r.reason ?? "formato"})` : "falhou"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
