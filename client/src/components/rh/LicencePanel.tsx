/**
 * Carta de condução na ficha (Jorge, 7 out 2026): estado, data de emissão e
 * "Validar carta" para o RH (lê a data na carta e confirma). Com menos de 3
 * anos fica "Carta < 3 anos" — aviso ao escalar, nunca bloqueia.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { fmtPTDate } from "@/lib/lisbonTime";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BadgeCheck, IdCard } from "lucide-react";
import { LicenceBadge } from "./RhBadges";
import { fullYearsBetween, isCalendarDay, licenceAnniversary, licenceStatus, LICENCE_MIN_YEARS, LICENCE_STATUS_LABELS, type LicenceStatus } from "@shared/drivingLicence";
import { lisbonDayOf } from "@shared/lisbonDay";

const fmtDay = (day: string) => day.split("-").reverse().join("/");

export function LicencePanel({ employeeId, issuedAt, validatedAt, licence, canValidate }: {
  employeeId: number;
  issuedAt: string | null | undefined;
  validatedAt: string | null | undefined;
  licence: LicenceStatus | null | undefined;
  canValidate: boolean;
}) {
  const [open, setOpen] = useState(false);
  const today = lisbonDayOf(new Date());
  const issued = isCalendarDay(issuedAt ?? null) ? (issuedAt as string) : null;
  const years = issued && issued <= today ? fullYearsBetween(issued, today) : null;

  const detail = issued
    ? `Emitida a ${fmtDay(issued)}${years != null ? ` (${years} ano${years === 1 ? "" : "s"})` : ""}${validatedAt ? ` · validada pelo RH a ${fmtPTDate(validatedAt)}` : " · data declarada, por confirmar"}`
    : licence === "missing" ? "Sem documento, número ou data da carta." : "Data de emissão por confirmar.";
  const turnsThree = licence === "under_3y" && issued ? licenceAnniversary(issued, LICENCE_MIN_YEARS) : null;

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
        <IdCard className="h-4 w-4 text-muted-foreground" aria-hidden />
        <span className="text-sm font-medium">Carta de condução</span>
        <LicenceBadge status={licence} />
        <span className="min-w-0 basis-full text-xs text-muted-foreground sm:basis-auto">
          {detail}
          {turnsThree ? ` · faz ${LICENCE_MIN_YEARS} anos a ${fmtDay(turnsThree)}` : ""}
        </span>
        {canValidate && (
          <Button size="sm" variant="outline" className="h-8 sm:ml-auto" onClick={() => setOpen(true)}>
            <BadgeCheck className="mr-1 h-4 w-4" /> {validatedAt ? "Corrigir validação" : "Validar carta"}
          </Button>
        )}
      </CardContent>
      {canValidate && open && (
        <ValidateLicenceDialog employeeId={employeeId} initial={issued} onClose={() => setOpen(false)} />
      )}
    </Card>
  );
}

function ValidateLicenceDialog({ employeeId, initial, onClose }: { employeeId: number; initial: string | null; onClose: () => void }) {
  const utils = trpc.useUtils();
  const today = lisbonDayOf(new Date());
  const [day, setDay] = useState(initial ?? "");
  const valid = isCalendarDay(day) && day <= today && day >= "1940-01-01";
  const preview = useMemo(() => (valid ? licenceStatus({ issuedAt: day, validatedAt: "now" }, today) : null), [valid, day, today]);
  const validate = trpc.rh.validateDrivingLicence.useMutation({
    onSuccess: (r) => {
      utils.rh.byId.invalidate({ id: employeeId });
      utils.rh.list.invalidate();
      utils.rh.documents.list.invalidate({ employeeId });
      utils.rh.documents.checklist.invalidate({ employeeId });
      utils.rh.documents.allStatus.invalidate();
      toast.success(`${LICENCE_STATUS_LABELS[r.licence as LicenceStatus] ?? "Carta validada"}${r.documentsValidated ? ` · ${r.documentsValidated} ficheiro(s) da carta validado(s)` : ""}.`);
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Validar carta de condução</DialogTitle>
          <DialogDescription>
            Confirma a data na carta: na carta europeia é o campo 10 (data da 1.ª emissão) da categoria B. Os ficheiros da carta por validar ficam validados.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="licence-issued-at">Data de emissão</Label>
          <Input id="licence-issued-at" type="date" value={day} max={today} min="1940-01-01" onChange={(e) => setDay(e.target.value)} />
          {preview && (
            <p className="text-xs text-muted-foreground">
              Fica: <strong>{LICENCE_STATUS_LABELS[preview]}</strong>
              {preview === "under_3y" ? ` — faz ${LICENCE_MIN_YEARS} anos a ${fmtDay(licenceAnniversary(day, LICENCE_MIN_YEARS))} (passa sozinha a validada). Pode ser escalada, com aviso.` : "."}
            </p>
          )}
          {day && !valid && <p className="text-xs text-destructive">Data inválida (tem de ser um dia real, até hoje).</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={!valid || validate.isPending} onClick={() => validate.mutate({ employeeId, issuedAt: day })}>
            {validate.isPending ? "A validar…" : "Validar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
