/**
 * Telemóveis pessoais (shared/personalDevice.ts): em cada entrada diz ao
 * servidor quem está neste telemóvel agora — é o nome que aparece na lista
 * ("Telemóvel de …"). Sem UI.
 *
 * Um PDA convertido em telemóvel pessoal por uma chefia ainda tem o token na
 * chave do PDA: o servidor reconhece-o (`migrated`) e o token passa para a
 * chave do telemóvel pessoal — o aparelho deixa de ser PDA aqui (os fluxos do
 * PDA já não o reconhecem no servidor). Os avisos que estavam presos ao PDA
 * (só com o texto "Tens um aviso" e desligados no fim da sessão) passam a
 * avisos normais desta pessoa, se o browser já os tinha autorizado.
 */
import { useEffect } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { getPdaToken, getPersonalToken, movePdaTokenToPersonal, setPersonalToken } from "@/lib/pdaDevice";
import { currentPushSubscription, notificationPermission, toInput } from "@/lib/webPush";

const SEEN_KEY = "mp.device.seenFor";

function seenFor(key: string): boolean {
  try { return sessionStorage.getItem(SEEN_KEY) === key; } catch { return false; }
}
function markSeen(key: string): void {
  try { sessionStorage.setItem(SEEN_KEY, key); } catch { /* sem storage */ }
}

export function PersonalDeviceBinder({ userId }: { userId: number | null | undefined }) {
  const seen = trpc.operational.personalDevices.seen.useMutation();
  const pushSubscribe = trpc.notifications.pushSubscribe.useMutation();

  useEffect(() => {
    if (!userId) return;
    const personal = getPersonalToken();
    const pda = personal ? null : getPdaToken();
    if (!personal && !pda) return;
    const key = `${userId}:${personal ? "pessoal" : "pda"}`;
    if (seenFor(key)) return;
    markSeen(key);
    seen.mutate(
      { token: personal, pdaToken: pda },
      {
        onSuccess: (r) => {
          if (r.kind === "none") {
            // Deixou de ser pessoal (noutro aparelho ou na lista): o browser esquece-o.
            if (personal) setPersonalToken(null);
            return;
          }
          if (r.migrated && pda) {
            movePdaTokenToPersonal(pda);
            if (notificationPermission() === "granted") {
              void currentPushSubscription().then((sub) => {
                const input = sub ? toInput(sub) : null;
                if (input) pushSubscribe.mutate(input, { onError: (e) => console.warn("[push] avisos do telemóvel pessoal:", e) });
              });
            }
            toast.info(`Este aparelho passou a ${r.device?.title ?? "telemóvel pessoal"}: já não é um PDA partilhado.`, { duration: 10000 });
          }
        },
        onError: (e) => console.warn("[aparelho] telemóvel pessoal:", e),
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  return null;
}
