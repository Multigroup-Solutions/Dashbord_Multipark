import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle2, XCircle, MapPin, Camera, ShieldAlert, RefreshCw, Loader2 } from "lucide-react";

/**
 * Portão de segurança: a aplicação NÃO funciona sem (1) localização ativa e
 * PRECISA e (2) permissão de câmara. Decisão do Jorge (2026-08-04): aplica-se
 * a TODA a gente, sem exceção de roles — para exceções futuras, acrescentar
 * roles a EXEMPT_ROLES.
 *
 * A localização é obrigatória por causa do check-in/checkout dos funcionários;
 * a câmara pelas selfies de ponto e fotos de faturas.
 */
const EXEMPT_ROLES: string[] = [];
/** Acima disto (metros) considera-se localização aproximada (IP / iOS "aprox."). */
const ACCURACY_MAX_M = 2000;
const CAM_OK_CACHE_KEY = "mp-cam-perm-ok";

type LocState = "checking" | "ok" | "imprecise" | "denied" | "unavailable";
type CamState = "checking" | "ok" | "prompt" | "denied" | "none";

export default function PermissionsGate({ role }: { role?: string | null }) {
  const [loc, setLoc] = useState<LocState>("checking");
  const [cam, setCam] = useState<CamState>("checking");
  const [busy, setBusy] = useState(false);

  const checkLocation = useCallback(() => {
    if (!("geolocation" in navigator)) { setLoc("unavailable"); return; }
    setLoc("checking");
    navigator.geolocation.getCurrentPosition(
      (pos) => setLoc(pos.coords.accuracy <= ACCURACY_MAX_M ? "ok" : "imprecise"),
      (err) => setLoc(err.code === 1 ? "denied" : "unavailable"),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  }, []);

  const checkCamera = useCallback(async (requestIfNeeded: boolean) => {
    if (!navigator.mediaDevices?.getUserMedia) { setCam("none"); return; }
    // Permissions API quando existe (Chrome/Edge/Android); Safari não suporta
    // "camera" — aí confiamos na cache local depois da 1ª autorização.
    try {
      const p = await (navigator.permissions as any)?.query?.({ name: "camera" as PermissionName });
      if (p?.state === "granted") { localStorage.setItem(CAM_OK_CACHE_KEY, "1"); setCam("ok"); return; }
      if (p?.state === "denied") { localStorage.removeItem(CAM_OK_CACHE_KEY); setCam("denied"); return; }
    } catch { /* sem Permissions API para câmara */ }
    if (!requestIfNeeded && localStorage.getItem(CAM_OK_CACHE_KEY) === "1") { setCam("ok"); return; }
    if (!requestIfNeeded) { setCam("prompt"); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach((t) => t.stop());
      localStorage.setItem(CAM_OK_CACHE_KEY, "1");
      setCam("ok");
    } catch (err: any) {
      localStorage.removeItem(CAM_OK_CACHE_KEY);
      if (err?.name === "NotFoundError" || err?.name === "OverconstrainedError") setCam("none");
      else setCam("denied");
    }
  }, []);

  const runChecks = useCallback((requestCam: boolean) => {
    setBusy(true);
    checkLocation();
    void checkCamera(requestCam).finally(() => setBusy(false));
  }, [checkLocation, checkCamera]);

  useEffect(() => {
    if (role && EXEMPT_ROLES.includes(role)) return;
    runChecks(false);
    // Re-verifica quando o utilizador volta ao separador (pode ter ido às
    // definições ativar a localização/câmara).
    const onVisible = () => { if (document.visibilityState === "visible") runChecks(false); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  if (role && EXEMPT_ROLES.includes(role)) return null;

  const locOk = loc === "ok";
  const camOk = cam === "ok";
  if (locOk && camOk) return null;
  const stillChecking = loc === "checking" || cam === "checking";

  const locMsg: Record<LocState, string> = {
    checking: "A verificar…",
    ok: "Localização precisa ativa",
    imprecise: "Localização APROXIMADA — ativa a localização precisa/GPS nas definições",
    denied: "Permissão de localização recusada — permite o acesso nas definições do browser",
    unavailable: "Localização desligada ou indisponível — liga o GPS/localização do aparelho",
  };
  const camMsg: Record<CamState, string> = {
    checking: "A verificar…",
    ok: "Permissão de câmara concedida",
    prompt: "Falta autorizar a câmara — carrega em \"Permitir câmara\"",
    denied: "Permissão de câmara recusada — permite o acesso nas definições do browser",
    none: "Este aparelho não tem câmara disponível",
  };

  return (
    <div className="fixed inset-0 z-[100] bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <ShieldAlert className="w-6 h-6 text-red-600" /> Permissões obrigatórias
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Por segurança, a aplicação só funciona com a localização precisa ativa
            (check-in/checkout) e a permissão da câmara (ponto e faturas).
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${locOk ? "border-green-300 bg-green-50" : "border-red-300 bg-red-50"}`}>
              <MapPin className="w-4 h-4 mt-0.5 shrink-0" />
              <div className="flex-1">
                <p className="font-medium">Localização precisa</p>
                <p className="text-xs text-muted-foreground">{locMsg[loc]}</p>
              </div>
              {loc === "checking" ? <Loader2 className="w-4 h-4 animate-spin" /> : locOk ? <CheckCircle2 className="w-4 h-4 text-green-600" /> : <XCircle className="w-4 h-4 text-red-600" />}
            </div>
            <div className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${camOk ? "border-green-300 bg-green-50" : "border-red-300 bg-red-50"}`}>
              <Camera className="w-4 h-4 mt-0.5 shrink-0" />
              <div className="flex-1">
                <p className="font-medium">Câmara</p>
                <p className="text-xs text-muted-foreground">{camMsg[cam]}</p>
              </div>
              {cam === "checking" ? <Loader2 className="w-4 h-4 animate-spin" /> : camOk ? <CheckCircle2 className="w-4 h-4 text-green-600" /> : <XCircle className="w-4 h-4 text-red-600" />}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            {(cam === "prompt" || cam === "denied") && (
              <Button onClick={() => void checkCamera(true)} disabled={busy}>
                <Camera className="w-4 h-4 mr-2" /> Permitir câmara
              </Button>
            )}
            <Button variant={cam === "prompt" ? "outline" : "default"} onClick={() => runChecks(true)} disabled={busy || stillChecking}>
              <RefreshCw className={`w-4 h-4 mr-2 ${stillChecking ? "animate-spin" : ""}`} /> Tentar novamente
            </Button>
          </div>

          <p className="text-[11px] text-muted-foreground">
            No telemóvel: Definições → Apps → Browser → Permissões (Localização "Precisa" + Câmara).
            Depois de alterares, volta aqui e carrega em "Tentar novamente".
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
