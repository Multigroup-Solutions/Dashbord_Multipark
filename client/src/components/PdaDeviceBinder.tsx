/**
 * Fase 2: num PDA registado, quem faz login fica com o PDA (e o Zello) até
 * sair ou entrar outra pessoa. Corre uma vez por login, sem UI própria —
 * só um aviso quando o PDA muda de mãos.
 */
import { useEffect } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { claimedFor, getPdaToken, getPendingQr, markClaimed, setPendingQr } from "@/lib/pdaDevice";

export function PdaDeviceBinder({ userId }: { userId: number | null | undefined }) {
  const [, setLocation] = useLocation();
  const claim = trpc.operational.pdas.claimOnLogin.useMutation();

  useEffect(() => {
    if (!userId) return;
    // QR lido antes de entrar → continua o registo agora
    const pending = getPendingQr();
    if (pending) {
      setPendingQr(null);
      setLocation(`/pda/registar${pending.startsWith("?") ? pending : `?${pending}`}`);
      return;
    }
    const token = getPdaToken();
    if (!token || claimedFor(userId)) return;
    markClaimed(userId);
    claim.mutate(
      { token },
      {
        onSuccess: (r) => {
          if (r.attached && r.changed) {
            toast.success(`Este aparelho (${r.pdaName}) ficou contigo${r.zelloUsername ? ` · Zello ${r.zelloUsername}` : ""}${r.replacedName ? ` — estava com ${r.replacedName}` : ""}.`);
          }
        },
        onError: () => markClaimed(null),
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  return null;
}
