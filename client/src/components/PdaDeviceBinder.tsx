/**
 * Fase 2: num PDA registado, quem faz login fica com o PDA (e o Zello) até
 * sair ou entrar outra pessoa. Corre uma vez por login, sem UI própria —
 * só um aviso quando o PDA muda de mãos.
 *
 * Plano 56 (A2), com "Entrar com email e código" ligado: a sessão fica presa
 * ao PDA. Quem entrou com código/palavra-passe no PDA já vem com ela (o
 * servidor ligou o PDA à pessoa na entrada). Uma sessão SEM PDA num aparelho
 * registado (login Google no PDA, ou sessão de antes de ligar o interruptor)
 * passa a sessão de PDA (`auth.pda.bind`) — nunca é terminada por isso.
 */
import { useEffect } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { claimedFor, getPdaToken, getPendingQr, markClaimed, setPendingQr } from "@/lib/pdaDevice";
import { useCodeLoginOption } from "@/lib/loginOptions";
import { currentPushSubscription, notificationPermission, toInput } from "@/lib/webPush";

const BIND_TRIED_KEY = "mp.pda.bindTried";

function bindTriedFor(userId: number): boolean {
  try { return sessionStorage.getItem(BIND_TRIED_KEY) === String(userId); } catch { return false; }
}
function markBindTried(userId: number): void {
  try { sessionStorage.setItem(BIND_TRIED_KEY, String(userId)); } catch { /* sem storage */ }
}

const PUSH_CLAIMED_KEY = "mp.pda.pushClaimed";

export function PdaDeviceBinder({ userId, pdaSession }: { userId: number | null | undefined; pdaSession?: { pdaId: number; tag?: string } | null }) {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const claim = trpc.operational.pdas.claimOnLogin.useMutation();
  const bind = trpc.auth.pda.bind.useMutation();
  const pushSubscribe = trpc.notifications.pushSubscribe.useMutation();
  const { codeLogin } = useCodeLoginOption();

  // A2: os avisos deste browser (se já estavam ligados) passam para quem tem
  // agora a sessão do PDA — nunca ficam com quem usou o PDA antes.
  useEffect(() => {
    const tag = pdaSession?.tag;
    if (!tag || notificationPermission() !== "granted") return;
    try { if (sessionStorage.getItem(PUSH_CLAIMED_KEY) === tag) return; sessionStorage.setItem(PUSH_CLAIMED_KEY, tag); } catch { /* sem storage */ }
    void currentPushSubscription().then((sub) => {
      const input = sub ? toInput(sub) : null;
      if (input) pushSubscribe.mutate(input, { onError: (e) => console.warn("[push] avisos do PDA não passaram para esta sessão:", e) });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdaSession?.tag]);

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
    if (!token) return;
    if (codeLogin === undefined) return; // ainda a saber se o interruptor está ligado
    if (codeLogin) {
      // Sessão de PDA já aberta na entrada: o PDA já ficou com a pessoa.
      if (pdaSession) return;
      if (bindTriedFor(userId)) return;
      markBindTried(userId);
      bind.mutate(
        { deviceToken: token },
        {
          onSuccess: (r) => {
            if (r.bound) {
              if (!("already" in r && r.already)) toast.success(`Este aparelho (${r.pdaName}) ficou contigo. A sessão termina quando deres saída do ponto.`);
              void utils.auth.me.invalidate();
            }
          },
          onError: (e) => {
            console.warn("[pda] sessão de PDA não abriu:", e);
            toast.warning(e.message || "Não foi possível ligar este aparelho a ti (PDA).");
          },
        },
      );
      return;
    }
    if (claimedFor(userId)) return;
    markClaimed(userId);
    claim.mutate(
      { token },
      {
        onSuccess: (r) => {
          if (r.attached && r.changed) {
            toast.success(`Este aparelho (${r.pdaName}) ficou contigo${r.zelloUsername ? ` · Zello ${r.zelloUsername}` : ""}${r.replacedName ? ` — estava com ${r.replacedName}` : ""}.`);
          }
        },
        onError: (e) => {
          // Não engolir: sem esta ligação o GPS do aparelho fica sem pessoa
          console.warn("[pda] login→PDA falhou:", e);
          toast.warning(e.message || "Não foi possível ligar este aparelho a ti (PDA).");
          markClaimed(null);
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, codeLogin, pdaSession?.pdaId]);

  return null;
}
