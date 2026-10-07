/**
 * Etiquetas do RH (Jorge, 7 out 2026): estado da carta de condução e estado
 * de cada documento entregue. Regras em shared/drivingLicence.ts e
 * shared/employeeDocuments.ts — aqui só a apresentação.
 */
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { CheckCircle2, Clock3, IdCard, XCircle } from "lucide-react";
import { LICENCE_STATUS_HINTS, LICENCE_STATUS_LABELS, type LicenceStatus } from "@shared/drivingLicence";
import { DOC_STATUS_LABELS, type DocStatus } from "@shared/employeeDocuments";

const LICENCE_CLASSES: Record<LicenceStatus, string> = {
  validated: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
  pending: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
  under_3y: "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200",
  missing: "border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400",
};

/** "Carta validada" (verde) · "Carta pendente de validação" (âmbar) · "Carta < 3 anos" / "Sem carta" (cinza). */
export function LicenceBadge({ status, className }: { status: LicenceStatus | null | undefined; className?: string }) {
  if (!status) return null;
  return (
    <Badge variant="outline" className={cn("gap-1 font-medium", LICENCE_CLASSES[status], className)} title={LICENCE_STATUS_HINTS[status]}>
      <IdCard aria-hidden />
      {LICENCE_STATUS_LABELS[status]}
    </Badge>
  );
}

const DOC_CLASSES: Record<DocStatus, string> = {
  pending: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
  validated: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
  rejected: "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200",
};
const DOC_ICONS: Record<DocStatus, typeof Clock3> = { pending: Clock3, validated: CheckCircle2, rejected: XCircle };

/** "Pendente de validação" · "Validado" · "Recusado" (o motivo no tooltip). */
export function DocStatusBadge({ status, reason, className }: { status: string | null | undefined; reason?: string | null; className?: string }) {
  const s: DocStatus = status === "pending" || status === "rejected" ? status : "validated";
  const Icon = DOC_ICONS[s];
  return (
    <Badge variant="outline" className={cn("gap-1 text-[11px] font-medium", DOC_CLASSES[s], className)} title={s === "rejected" && reason ? `Motivo: ${reason}` : undefined}>
      <Icon aria-hidden />
      {DOC_STATUS_LABELS[s]}
    </Badge>
  );
}
