// Terminal pelo perfil (plano 56 B1 + B2): estado da própria pessoa e as ações
// ("Estou no terminal", Sair, pedir ao colega, Passar / Ainda estou, e no B2
// "Ainda estás no terminal?" → Sim, estou / Já saí, e "Ainda estou" depois de
// o lugar ter sido libertado).
// Interruptor PONTO_TERMINAL desligado → `status.enabled` false e nada aparece.
import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

export type TerminalFix = { lat: number; lng: number; accuracy: number };

/** GPS exato (o terminal exige localização exata). */
export function getExactPosition(timeoutMs = 15000): Promise<TerminalFix> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error("Este aparelho não tem GPS. O terminal precisa da localização exata.")); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      () => reject(new Error("Sem acesso à localização. Autoriza a localização exata e tenta outra vez.")),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
    );
  });
}

/** GPS se der (para fechar o terminal; sem GPS fecha na mesma). */
async function tryPosition(): Promise<TerminalFix | null> {
  try { return await getExactPosition(8000); } catch { return null; }
}

export type TerminalBusyInfo = {
  cityKey: string;
  sessionId: number;
  holderName: string;
  holderFirstName: string;
  since: string;
  message: string;
  requestLabel: string;
};

type OpenResult =
  | { status: "started" | "already"; message: string }
  | ({ status: "busy" } & TerminalBusyInfo)
  | { status: "refused" | "need_checkin" | "off"; message: string }
  | { status: "requested"; requestId: number; message: string };

export function useTerminal(enabled: boolean) {
  const utils = trpc.useUtils();
  const statusQ = trpc.terminal.status.useQuery(undefined, {
    enabled,
    retry: false,
    staleTime: 15_000,
    refetchInterval: (q) => {
      const d = q.state.data as { session?: unknown; incoming?: unknown; outgoing?: unknown; ask?: unknown; released?: unknown } | undefined;
      return d && (d.ask || d.released) ? 20_000 : d && (d.session || d.incoming || d.outgoing) ? 30_000 : 120_000;
    },
  });
  const status = statusQ.data;
  const [busy, setBusy] = useState<TerminalBusyInfo | null>(null);
  const [working, setWorking] = useState(false);
  const startM = trpc.terminal.start.useMutation();
  const stopM = trpc.terminal.stop.useMutation();
  const requestM = trpc.terminal.requestHandover.useMutation();
  const answerM = trpc.terminal.answerHandover.useMutation();
  const stillM = trpc.terminal.answerStillHere.useMutation();
  const reopenM = trpc.terminal.reopen.useMutation();

  const refresh = () => {
    utils.terminal.status.invalidate();
    utils.rh.timeRecords.myStatus.invalidate();
  };

  /** Mostra a resposta de "abrir" (botão, entrada do ponto ou pedido). */
  const handleOpenResult = (r: OpenResult | null | undefined, opts: { onNeedCheckIn?: () => void } = {}) => {
    if (!r) return;
    switch (r.status) {
      case "started": toast.success(r.message, { duration: 8000 }); setBusy(null); break;
      case "already": toast.info(r.message); setBusy(null); break;
      case "requested": toast.success(r.message, { duration: 8000 }); setBusy(null); break;
      case "busy": setBusy(r); break;
      case "need_checkin": if (opts.onNeedCheckIn) opts.onNeedCheckIn(); else toast.info(r.message); break;
      default: toast.error(r.message, { duration: 10000 });
    }
    refresh();
  };

  const guard = async (fn: () => Promise<void>) => {
    if (working) return;
    setWorking(true);
    try { await fn(); } catch (e: any) { toast.error(String(e?.message ?? e), { duration: 10000 }); refresh(); } finally { setWorking(false); }
  };

  /** "Estou no terminal": sem ponto aberto → abre a entrada do ponto (com a opção marcada). */
  const start = (onNeedCheckIn: () => void) => guard(async () => {
    if (status && !status.clockOpen) { onNeedCheckIn(); return; }
    const fix = await getExactPosition();
    handleOpenResult(await startM.mutateAsync(fix) as OpenResult, { onNeedCheckIn });
  });

  /** "Pedir ao João para passar". */
  const askToPass = () => guard(async () => {
    const fix = await getExactPosition();
    handleOpenResult(await requestM.mutateAsync(fix) as OpenResult);
  });

  /** "Sair" (depois de confirmar). */
  const stop = () => guard(async () => {
    const fix = await tryPosition();
    const r = await stopM.mutateAsync(fix ?? {});
    toast.success(r.message, { duration: 8000 });
    refresh();
  });

  /** O João responde ao pedido: Passar / Ainda estou. */
  const answer = (requestId: number, a: "pass" | "stay") => guard(async () => {
    const fix = a === "pass" ? await tryPosition() : null;
    const r = await answerM.mutateAsync({ requestId, answer: a, ...(fix ?? {}) });
    toast.success(r.message, { duration: 8000 });
    refresh();
  });

  /** "Ainda estás no terminal?" → "Sim, estou" (com GPS, se der: também é prova) / "Já saí". */
  const stillHere = (a: "yes" | "left") => guard(async () => {
    const fix = await tryPosition();
    const r = await stillM.mutateAsync({ answer: a, ...(fix ?? {}) }) as { status: string; message: string };
    if (r.status === "ok" || r.status === "closed") { toast.success(r.message, { duration: 8000 }); refresh(); }
    else handleOpenResult(r as OpenResult);
  });

  /** "Ainda estou" depois de o lugar ter sido libertado (até 30 min). */
  const reopen = () => guard(async () => {
    const fix = await tryPosition();
    handleOpenResult(await reopenM.mutateAsync(fix ?? {}) as OpenResult);
  });

  return { status, statusQ, busy, setBusy, working, handleOpenResult, start, askToPass, stop, answer, stillHere, reopen, refresh };
}

export type TerminalApi = ReturnType<typeof useTerminal>;
