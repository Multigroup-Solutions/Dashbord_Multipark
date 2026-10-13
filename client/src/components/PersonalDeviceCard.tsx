/**
 * "Este telemóvel" (Perfil e Operacional → PDAs): registar o PRÓPRIO telemóvel
 * como pessoal, ver de quem é e tirá-lo de pessoal. Não é um PDA partilhado
 * (shared/personalDevice.ts): a sessão não fica presa a ele, não acaba na
 * saída do ponto e não tira o Zello a ninguém — usa o Zello da ficha do dono.
 *
 * Num PDA registado (token do PDA neste browser) não aparece: um PDA não passa
 * a pessoal por aqui (uma chefia converte-o em Operacional → PDAs).
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Smartphone } from "lucide-react";
import { can, seesBeyondOwn } from "@shared/access";
import { PERSONAL_DEVICE_HELP, looksLikePhone } from "@shared/personalDevice";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { DEVICE_CHANGED_EVENT, getPdaToken, getPersonalToken, setPersonalToken } from "@/lib/pdaDevice";

export function PersonalDeviceCard({ className = "", alwaysOffer = false }: { className?: string; alwaysOffer?: boolean }) {
  const { user } = useAuth();
  const [token, setToken] = useState<string | null>(() => getPersonalToken());
  const [pdaToken, setPdaTokenState] = useState<string | null>(() => getPdaToken());
  useEffect(() => {
    const on = () => { setToken(getPersonalToken()); setPdaTokenState(getPdaToken()); };
    window.addEventListener(DEVICE_CHANGED_EVENT, on);
    return () => window.removeEventListener(DEVICE_CHANGED_EVENT, on);
  }, []);
  const canManage = !!user && can(user as any, "pdas", "edit") && seesBeyondOwn(user as any, "pdas");

  // Quem está neste telemóvel (mutação: o token vai no corpo, nunca no endereço).
  const info = trpc.operational.personalDevices.seen.useMutation({
    onSuccess: (r) => { if (r.kind === "none") setPersonalToken(null); },
  });
  useEffect(() => {
    if (token && user?.id) info.mutate({ token });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, user?.id]);
  const register = trpc.operational.personalDevices.register.useMutation({
    onSuccess: (r) => {
      setPersonalToken(r.token);
      toast.success(r.already ? "Este telemóvel já era teu." : `Registado como ${r.device?.title ?? "telemóvel pessoal"}.`);
    },
    onError: (e) => toast.error(e.message, { duration: 10000 }),
  });
  const unregister = trpc.operational.personalDevices.unregisterMine.useMutation({
    onSuccess: () => { setPersonalToken(null); toast.info("Este telemóvel deixou de ser pessoal (fica no histórico)."); },
    onError: (e) => toast.error(e.message),
  });

  if (!user || pdaToken) return null;
  const device = token && info.data?.kind === "pessoal" ? info.data.device : null;
  const phone = typeof navigator !== "undefined" && looksLikePhone(navigator.userAgent);
  if (!token && !phone && !alwaysOffer) return null;

  return (
    <div className={`bg-card border border-border rounded-2xl shadow-sm p-3.5 space-y-2 ${className}`}>
      <div className="flex items-center gap-3">
        <span className="w-8 h-8 rounded-[9px] bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <Smartphone className="w-4 h-4" />
        </span>
        <div className="flex-1 min-w-0">
          {token && device ? (
            <>
              <div className="text-[13.5px] font-semibold text-foreground truncate">Este telemóvel é pessoal: {device.title}</div>
              <div className="text-[11.5px] text-muted-foreground [overflow-wrap:anywhere]">
                {device.zelloUsername ? `Zello ${device.zelloUsername}${device.zelloOf ? ` (da ficha de ${device.zelloOf})` : ""}` : "Sem Zello na ficha do dono"}
                {device.ownerName && device.ownerName !== device.currentName ? ` · dono: ${device.ownerName}` : ""}
                {device.currentSince ? ` · contigo desde ${fmtPTDateTime(device.currentSince)}` : ""}
              </div>
            </>
          ) : token && info.isPending ? (
            <div className="text-[13.5px] text-muted-foreground">A ver este telemóvel…</div>
          ) : token && info.error ? (
            // Falha a ler ≠ "não é pessoal": o registo fica no browser.
            <div className="text-[13.5px] text-muted-foreground">
              Não foi possível ver este telemóvel.{" "}
              <button type="button" className="text-primary underline" onClick={() => info.mutate({ token })}>Tentar de novo</button>
            </div>
          ) : (
            <>
              <div className="text-[13.5px] font-semibold text-foreground">Este telemóvel é teu?</div>
              <div className="text-[11.5px] text-muted-foreground">Regista-o como teu: aparece com o teu nome na lista dos telemóveis pessoais e usa o teu Zello (o da tua ficha). Não é um PDA partilhado.</div>
            </>
          )}
        </div>
      </div>
      {token && device ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] text-muted-foreground flex-1 min-w-[12rem]">{PERSONAL_DEVICE_HELP}</p>
          {(device.mine || canManage) && (
            <Button size="sm" variant="outline" disabled={unregister.isPending}
              onClick={() => { if (confirm("Este telemóvel deixa de ser pessoal? Fica no histórico; podes voltar a registá-lo.")) unregister.mutate({ token }); }}>
              Deixar de ser pessoal
            </Button>
          )}
        </div>
      ) : !token ? (
        <Button size="sm" className="w-full" disabled={register.isPending}
          onClick={() => register.mutate({ pdaToken: getPdaToken(), currentToken: getPersonalToken() })}>
          {register.isPending ? "A registar…" : "Registar este telemóvel como meu"}
        </Button>
      ) : null}
    </div>
  );
}
