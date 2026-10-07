/**
 * Lote 40a — Xsi da One Net, dentro do cartão da Central Vodafone (só super
 * admin): servidor, utilizador e palavra-passe (guardada cifrada; nunca
 * volta ao ecrã), e "Testar" — perfil, diretório da empresa cruzado com as
 * fichas do RH e os registos de chamadas. Ainda não regista nem liga (40b/40c).
 */
import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { toast } from "sonner";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { CheckCircle2, Network, XCircle } from "lucide-react";

const KIND: Record<string, string> = { placed: "feita", received: "recebida", missed: "não atendida" };

export function CentralXsiSection() {
  const utils = trpc.useUtils();
  const q = trpc.central.xsiStatus.useQuery(undefined, { staleTime: 30_000 });
  const [baseUrl, setBaseUrl] = useState("");
  const [userId, setUserId] = useState("");
  const [readUserId, setReadUserId] = useState("");
  const [password, setPassword] = useState("");
  const [showDir, setShowDir] = useState(false);
  useEffect(() => {
    if (!q.data) return;
    setBaseUrl(q.data.baseUrl ?? "");
    setUserId(q.data.userId ?? "");
    setReadUserId(q.data.readUserId ?? "");
  }, [q.data?.baseUrl, q.data?.userId, q.data?.readUserId]);
  const save = trpc.central.xsiSave.useMutation({
    onSuccess: () => { toast.success("Xsi guardado."); setPassword(""); utils.central.xsiStatus.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const test = trpc.central.xsiTest.useMutation({
    onSuccess: (r) => { r.ok ? toast.success("O Xsi respondeu.") : toast.error(r.error ?? "O Xsi não respondeu."); utils.central.xsiStatus.invalidate(); utils.central.status.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const last = (test.data ?? (q.data?.lastTest as typeof test.data | null)) ?? null;
  const configured = !!(q.data?.baseUrl && q.data?.userId && q.data?.hasPassword);

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="text-xs font-medium flex items-center gap-2 flex-wrap">
        <Network className="h-3.5 w-3.5" /> Xsi da One Net (registo de todas as linhas, telemóveis incluídos)
        {q.data && (configured ? <Badge variant="outline" className="bg-emerald-100 text-emerald-800 border-emerald-200">Configurado</Badge> : <Badge variant="outline" className="bg-muted">Por configurar</Badge>)}
      </div>
      <p className="text-xs text-muted-foreground">
        Com os dados que a Vodafone te deu. A palavra-passe fica guardada <b>cifrada</b> e nunca volta a aparecer. Se te deram um <b>administrador</b>,
        põe em "Utilizador a ler" o teu utilizador One Net para o teste. Por agora só se testa: o registo das chamadas e o "Ligar pela central" vêm a seguir.
      </p>
      {q.isError && <QueryErrorNote error={q.error} onRetry={() => q.refetch()} what="o Xsi" />}
      {q.data?.keySource === "none" && <p className="text-xs text-destructive">Sem chave de cifra no servidor (INTEGRATIONS_ENCRYPTION_KEY ou JWT_SECRET): não dá para guardar a palavra-passe.</p>}
      {q.data?.keySource === "invalid" && <p className="text-xs text-destructive">A chave INTEGRATIONS_ENCRYPTION_KEY está mal (tem de ser 32 bytes em base64).</p>}
      <div className="grid gap-2 sm:grid-cols-2 max-w-3xl">
        <label className="text-xs space-y-1"><span className="text-muted-foreground">Servidor Xsi</span>
          <Input className="h-8 text-xs font-mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://xsi.….vodafone.pt" autoComplete="off" /></label>
        <label className="text-xs space-y-1"><span className="text-muted-foreground">Utilizador</span>
          <Input className="h-8 text-xs font-mono" value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="ex.: 351210000000@dominio" autoComplete="off" /></label>
        <label className="text-xs space-y-1"><span className="text-muted-foreground">Palavra-passe</span>
          <Input className="h-8 text-xs" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password"
            placeholder={q.data?.hasPassword ? "•••••• guardada — escreve só para mudar" : "palavra-passe do Xsi"} /></label>
        <label className="text-xs space-y-1"><span className="text-muted-foreground">Utilizador a ler (opcional)</span>
          <Input className="h-8 text-xs font-mono" value={readUserId} onChange={(e) => setReadUserId(e.target.value)} placeholder="só com administrador" autoComplete="off" /></label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!baseUrl || !userId || save.isPending || (!q.data?.hasPassword && !password)}
          onClick={() => save.mutate({ baseUrl, userId, readUserId: readUserId || null, password: password || null })}>Guardar</Button>
        <Button size="sm" variant="outline" disabled={!configured || test.isPending} onClick={() => test.mutate()}>{test.isPending ? "A testar…" : "Testar ligação"}</Button>
        {q.data?.lastTestAt && !test.data && <span className="text-xs text-muted-foreground self-center">último teste {fmtPTDateTime(q.data.lastTestAt)}</span>}
      </div>

      {last && (
        <div className="space-y-2">
          {last.error && <p className="text-xs text-destructive">{last.error}</p>}
          <div className="divide-y rounded-md border text-xs">
            {last.steps.map((s) => (
              <div key={s.step} className="flex flex-wrap items-center gap-2 p-2">
                {s.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <XCircle className="h-3.5 w-3.5 text-destructive" />}
                <span className="font-medium">{s.step}</span>
                <span className="text-muted-foreground">{s.note} · {s.ms} ms</span>
              </div>
            ))}
          </div>
          {last.profile && (last.profile.firstName || last.profile.userId) && (
            <p className="text-xs">Entrou como <b>{[last.profile.firstName, last.profile.lastName].filter(Boolean).join(" ") || last.profile.userId}</b>
              {last.profile.extension ? ` · extensão ${last.profile.extension}` : ""}{last.profile.number ? ` · ${last.profile.number}` : ""}{last.profile.groupId ? ` · grupo ${last.profile.groupId}` : ""}</p>
          )}
          {last.enhancedCallLogs != null && (
            <p className="text-xs text-muted-foreground">{last.enhancedCallLogs ? "Registos completos disponíveis (com hora de atender e de desligar → durações certas)." : "Sem registos completos: só os básicos (sem durações)."}</p>
          )}
          {last.callLogs && (
            <div className="text-xs space-y-1">
              <div className="font-medium">Registos de chamadas deste utilizador ({last.callLogs.count})</div>
              {last.callLogs.sample.map((c, i) => (
                <div key={`${c.callLogId ?? i}`} className="text-muted-foreground">{c.time ? fmtPTDateTime(c.time) : "?"} · {KIND[c.type] ?? c.type} · {c.name ? `${c.name} ` : ""}{c.phone ?? ""}</div>
              ))}
            </div>
          )}
          {last.directory && (
            <div className="text-xs space-y-1">
              <Button size="sm" variant="ghost" className="h-7 px-0 text-xs underline" onClick={() => setShowDir((v) => !v)}>
                {showDir ? "Esconder" : "Ver"} o diretório da One Net ({last.directory.count}{last.directory.total != null && last.directory.total > last.directory.count ? ` de ${last.directory.total}` : ""} · {last.directory.matched} com ficha no RH)
              </Button>
              {showDir && (
                <div className="divide-y rounded-md border max-h-80 overflow-auto">
                  {last.directory.entries.map((d, i) => (
                    <div key={`${d.userId ?? i}`} className="flex flex-wrap items-center gap-2 p-2">
                      <span className="font-medium">{d.name}</span>
                      {d.extension && <Badge variant="outline" className="h-4 px-1 text-[10px]">ext. {d.extension}</Badge>}
                      <span className="text-muted-foreground">{[d.number, d.mobile].filter(Boolean).join(" · ")}</span>
                      <span className="ml-auto">{d.employeeName ? <>→ <b>{d.employeeName}</b> <span className="text-muted-foreground">(pelo {d.matchedBy})</span></> : <span className="text-amber-700">sem ficha no RH com este número</span>}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
