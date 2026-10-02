/**
 * "Feito" de um serviço extra (página Serviços). Há duas fontes:
 *   - a app Multipark (o condutor marca na app; a BD da Multipark é só de leitura);
 *   - a NOSSA marcação, por linha (`service_extra_done`), com quem e quando.
 * Feito = feito na Multipark OU marcado feito cá — a mesma regra das tarefas
 * dos serviços (shared/serviceTasks.ts). Reabrir cá só desfaz o que foi
 * marcado cá; o que está feito na Multipark reabre-se lá. PURO.
 */
export type ServiceDoneSource = "multipark" | "local" | null;

export interface ServiceDoneState {
  done: boolean;
  /** Quem deu o "feito" (a Multipark ganha: é o registo do terreno). */
  doneSource: ServiceDoneSource;
  doneMultipark: boolean;
  /** Última marcação feita cá (feito ou reaberto), se houver. */
  localBy: string | null;
  localAt: string | null;
  /** Dá para reabrir cá? (só o que não está feito na Multipark) */
  canReopen: boolean;
}

export function serviceDoneState(
  doneMultipark: boolean,
  local: { done: boolean; by: string | null; at: string | null } | null | undefined,
): ServiceDoneState {
  const localDone = local?.done === true;
  return {
    done: doneMultipark || localDone,
    doneSource: doneMultipark ? "multipark" : localDone ? "local" : null,
    doneMultipark,
    localBy: local?.by ?? null,
    localAt: local?.at ?? null,
    canReopen: !doneMultipark && localDone,
  };
}
