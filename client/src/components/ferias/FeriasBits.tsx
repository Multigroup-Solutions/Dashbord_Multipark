/**
 * Mapa de férias (plano 63, passo 11): peças pequenas usadas fora da página
 * (RH, Perfil, Extras-Dia). Só aparecem com o interruptor FERIAS_MAPA ligado
 * (o servidor diz — rh.leaves.status).
 */
import { useLocation } from "wouter";
import { CalendarRange, CalendarOff } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { schedulerAbsenceText, type SchedulerAbsence } from "@shared/leaves";

/** Estado do mapa de férias para esta conta (null enquanto carrega / desligado / erro). */
export function useLeaveStatus() {
  const q = trpc.rh.leaves.status.useQuery(undefined, { staleTime: 5 * 60_000, retry: false, refetchOnWindowFocus: false });
  return q.data?.enabled ? q.data : null;
}

/** RH → botão "Mapa de férias" (com o número por aprovar). */
export function FeriasMapButton() {
  const [, navigate] = useLocation();
  const s = useLeaveStatus();
  if (!s) return null;
  return (
    <Button variant="outline" size="sm" onClick={() => navigate("/ferias")}>
      <CalendarRange className="w-4 h-4 mr-2" /> Mapa de férias
      {s.pendingCount > 0 && <span className="ml-1.5 rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">{s.pendingCount}</span>}
    </Button>
  );
}

/** Extras-Dia: etiqueta "Indisponível (avisou a 03/08)" / "De férias" / "Ausente". */
export function AbsenceBadge({ absence, className = "" }: { absence?: SchedulerAbsence | null; className?: string }) {
  const text = schedulerAbsenceText(absence);
  if (!text) return null;
  const tone = absence!.kind === "unavailable"
    ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
    : "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/30 dark:text-sky-200";
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded border px-1 text-[11px] font-medium ${tone} ${className}`} title="Mapa de férias: avisou que não está neste dia">
      <CalendarOff className="h-3 w-3" aria-hidden />{text}
    </span>
  );
}

/** Extras-Dia → ao pôr alguém: aviso (nunca bloqueia). */
export function AbsenceWarning({ absence, name }: { absence?: SchedulerAbsence | null; name?: string | null }) {
  const text = schedulerAbsenceText(absence);
  if (!text) return null;
  return (
    <div role="status" className="flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
      <CalendarOff className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{name ? `${name}: ` : ""}{text.toLowerCase()} neste dia. Se escalares na mesma e faltar, a falta fica sem pontos (avisou antes).</span>
    </div>
  );
}

/** Descarrega um ficheiro que o servidor mandou em base64. */
export function downloadBase64(fileName: string, base64: string, mime = "application/pdf") {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
