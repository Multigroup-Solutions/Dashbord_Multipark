/**
 * Extras-dia → escalar alguém (Jorge, 7 out 2026): carta com menos de 3 anos,
 * por validar ou sem carta → AVISO (nunca bloqueia). Texto em
 * shared/drivingLicence.ts (licenceScheduleWarning).
 */
import { AlertTriangle } from "lucide-react";
import { licenceScheduleWarning, type LicenceStatus } from "@shared/drivingLicence";

export function LicenceWarning({ status, name }: { status: LicenceStatus | null | undefined; name?: string | null }) {
  const text = licenceScheduleWarning(status, name);
  if (!text) return null;
  return (
    <div role="status" className="flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{text}</span>
    </div>
  );
}
