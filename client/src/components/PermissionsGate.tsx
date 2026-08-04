import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle2, XCircle, MapPin, ShieldAlert, RefreshCw, Loader2 } from "lucide-react";

/**
 * Portão de segurança: a aplicação NÃO funciona sem localização ativa e
 * PRECISA (obrigatória para o check-in/checkout dos funcionários). Aplica-se
 * a toda a gente; para exceções futuras, acrescentar roles a EXEMPT_ROLES.
 *
 * (A exigência de CÂMARA foi removida a pedido do Jorge, 2026-08-04 — nos PCs
 * sem câmara bloqueava admins/supervisores. A permissão da câmara é pedida
 * pelo browser no momento em que se usa: selfie de ponto, foto de fatura.)
 *
 * O browser pede a permissão de localização UMA vez; depois de concedida fica
 * memorizada para o site.
 */
const EXEMPT_ROLES: string[] = [];
/** Acima disto (metros) considera-se localização aproximada (IP / iOS "aprox."). */
const ACCURACY_MAX_M = 2000;

type LocState = "checking" | "ok" | "imprecise" | "denied" | "unavailable";

export default function PermissionsGate({ role }: { role?: string | null }) {
  const [loc, setLoc] = useState<LocState>("checking");

  const checkLocation = useCallback(() => {
    if (!("geolocation" in navigator)) { setLoc("unavailable"); return; }
    setLoc("checking");
    navigator.geolocation.getCurrentPosition(
      (pos) => setLoc(pos.coords.accuracy <= ACCURACY_MAX_M ? "ok" : "imprecise"),
      (err) => setLoc(err.code === 1 ? "denied" : "unavailable"),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  }, []);

  useEffect(() => {
    if (role && EXEMPT_ROLES.includes(role)) return;
    checkLocation();
    // Re-verifica quando o utilizador volta ao separador (pode ter ido às
    // definições ativar a localização).
    const onVisible = () => { if (document.visibilityState === "visible") checkLocation(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  if (role && EXEMPT_ROLES.includes(role)) return null;
  if (loc === "ok") return null;

  const locMsg: Record<LocState, string> = {
    checking: "A verificar…",
    ok: "Localização precisa ativa",
    imprecise: "Localização APROXIMADA — ativa a localização precisa/GPS nas definições",
    denied: "Permissão de localização recusada — permite o acesso nas definições do browser",
    unavailable: "Localização desligada ou indisponível — liga o GPS/localização do aparelho",
  };

  return (
    <div className="fixed inset-0 z-[100] bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <ShieldAlert className="w-6 h-6 text-red-600" /> Localização obrigatória
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Por segurança, a aplicação só funciona com a localização ativa e
            precisa (necessária para o check-in/checkout). O browser pede a
            permissão uma única vez.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${loc === "checking" ? "border-muted" : "border-red-300 bg-red-50"}`}>
            <MapPin className="w-4 h-4 mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="font-medium">Localização precisa</p>
              <p className="text-xs text-muted-foreground">{locMsg[loc]}</p>
            </div>
            {loc === "checking" ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4 text-red-600" />}
          </div>

          <Button className="w-full" onClick={checkLocation} disabled={loc === "checking"}>
            <RefreshCw className={`w-4 h-4 mr-2 ${loc === "checking" ? "animate-spin" : ""}`} /> Tentar novamente
          </Button>

          <p className="text-[11px] text-muted-foreground">
            No telemóvel: Definições → Apps → Browser → Permissões → Localização
            ("Permitir" + "Precisa"). Depois volta aqui e carrega em "Tentar novamente".
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
