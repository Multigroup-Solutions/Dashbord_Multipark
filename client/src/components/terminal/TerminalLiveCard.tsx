// "Terminal agora" (Atividade diária → Ao vivo) — plano 56 B1 + B2: por
// cidade, quem está no terminal e desde quando, o GPS (no aeroporto ✓ / fora /
// sem GPS, do vigia de 5 em 5 min), se já se perguntou "Ainda estás no
// terminal?", e as ações do TL/supervisor da cidade (Pôr / Passar / Fechar,
// sempre com motivo). Interruptor PONTO_TERMINAL desligado → não aparece.
import { useState } from "react";
import { toast } from "sonner";
import { Plane, RefreshCw } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fmtPTTime } from "@/lib/lisbonTime";
import { QueryErrorNote } from "@/components/QueryErrorNote";

type CityKey = "lisbon" | "porto" | "faro";
type Action = { kind: "put" | "pass" | "close"; cityKey: CityKey; cityLabel: string; holder: string | null };

const POSITION_LABELS: Record<string, string> = { extra: "extra", driver: "condutor", senior_driver: "condutor sénior", team_leader: "TL" };

/** "a 3,2 km" / "a 800 m". */
function km(m: number | null | undefined): string {
  if (m == null || !Number.isFinite(m)) return "";
  return m < 1000 ? ` a ${Math.max(10, Math.round(m / 10) * 10)} m` : ` a ${(Math.round(m / 100) / 10).toFixed(1).replace(".", ",")} km`;
}

/** GPS da última leitura do vigia (Zello do aparelho com a pessoa). */
function GpsBadge({ s }: { s: { gps: string | null; gpsAt: string | null; gpsDistanceM: number | null; asked: boolean; outsideSince: string | null } }) {
  if (s.asked) return <Badge variant="outline" className="ml-2 whitespace-normal text-left border-amber-400 text-amber-800 dark:text-amber-200">perguntámos se ainda está{s.outsideSince ? ` (fora desde ${fmtPTTime(s.outsideSince)})` : ""}</Badge>;
  if (s.gps === "inside") return <Badge variant="outline" className="ml-2 whitespace-normal border-emerald-400 text-emerald-800 dark:text-emerald-200" title={s.gpsAt ? `GPS das ${fmtPTTime(s.gpsAt)}` : undefined}>no aeroporto ✓</Badge>;
  if (s.gps === "outside") return <Badge variant="outline" className="ml-2 whitespace-normal border-amber-400 text-amber-800 dark:text-amber-200" title={s.gpsAt ? `GPS das ${fmtPTTime(s.gpsAt)}` : undefined}>fora{km(s.gpsDistanceM)}</Badge>;
  if (s.gps === "no_gps") return <Badge variant="outline" className="ml-2 text-muted-foreground">sem GPS</Badge>;
  return null;
}

export function TerminalLiveCard() {
  const utils = trpc.useUtils();
  const q = trpc.terminal.liveByCity.useQuery(undefined, { refetchInterval: 60_000, retry: false });
  const [action, setAction] = useState<Action | null>(null);
  const [person, setPerson] = useState("");
  const [reason, setReason] = useState("");
  const done = (r: { message: string }) => {
    toast.success(r.message);
    setAction(null); setPerson(""); setReason("");
    utils.terminal.liveByCity.invalidate();
    utils.terminal.status.invalidate();
  };
  const onError = (e: { message: string }) => toast.error(e.message, { duration: 10000 });
  const put = trpc.terminal.tl.put.useMutation({ onSuccess: done, onError });
  const pass = trpc.terminal.tl.pass.useMutation({ onSuccess: done, onError });
  const close = trpc.terminal.tl.close.useMutation({ onSuccess: done, onError });
  const pending = put.isPending || pass.isPending || close.isPending;

  if (q.error) return <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="o terminal agora" />;
  if (!q.data?.enabled || !q.data.cities.length) return null;

  const city = action ? q.data.cities.find((c) => c.cityKey === action.cityKey) : null;
  const options = (city?.candidates ?? []).map((p) => ({ value: String(p.employeeId), label: `${p.name}${p.position && POSITION_LABELS[p.position] ? ` (${POSITION_LABELS[p.position]})` : ""}` }));
  const reasonOk = reason.trim().length >= 3;
  const submit = () => {
    if (!action) return;
    if (action.kind === "put") put.mutate({ cityKey: action.cityKey, employeeId: Number(person), reason: reason.trim() });
    else if (action.kind === "pass") pass.mutate({ cityKey: action.cityKey, toEmployeeId: Number(person), reason: reason.trim() });
    else close.mutate({ cityKey: action.cityKey, reason: reason.trim() });
  };

  return (
    <Card className="mb-4">
      <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base flex items-center gap-2"><Plane className="h-4 w-4" />Terminal agora</CardTitle>
        <Button size="sm" variant="ghost" onClick={() => q.refetch()} disabled={q.isFetching} aria-label="Atualizar o terminal">
          <RefreshCw className={`h-4 w-4 ${q.isFetching ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {q.data.cities.map((c) => (
          <div key={c.cityKey} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-sm">
            <span className="font-semibold w-14 shrink-0">{c.cityLabel}</span>
            {c.session ? (
              // basis mínima: no telemóvel os botões passam para a linha de baixo em vez de espremerem o nome e o GPS
              <span className="min-w-0 flex-1 basis-44">
                <strong>{c.session.name}</strong> desde {fmtPTTime(c.session.startedAt)}
                <span className="text-muted-foreground"> · {c.session.sourceLabel}</span>
                <GpsBadge s={c.session} />
                {!c.session.clockOpen && <Badge variant="outline" className="ml-2 border-amber-400 text-amber-800">sem ponto aberto</Badge>}
                {c.requests.map((r) => (
                  <span key={r.requestId} className="block text-xs text-muted-foreground">{r.requesterName} pediu o lugar às {fmtPTTime(r.requestedAt)}</span>
                ))}
              </span>
            ) : (
              <span className="min-w-0 flex-1 basis-44 text-muted-foreground">Livre</span>
            )}
            {c.canManage && (
              <span className="flex gap-2">
                {c.session ? (
                  <>
                    <Button size="sm" variant="outline" className="h-7" onClick={() => setAction({ kind: "pass", cityKey: c.cityKey as CityKey, cityLabel: c.cityLabel, holder: c.session!.name })}>Passar</Button>
                    <Button size="sm" variant="outline" className="h-7" onClick={() => setAction({ kind: "close", cityKey: c.cityKey as CityKey, cityLabel: c.cityLabel, holder: c.session!.name })}>Fechar</Button>
                  </>
                ) : (
                  <Button size="sm" variant="outline" className="h-7" onClick={() => setAction({ kind: "put", cityKey: c.cityKey as CityKey, cityLabel: c.cityLabel, holder: null })}>Pôr</Button>
                )}
              </span>
            )}
          </div>
        ))}
      </CardContent>
      <Dialog open={!!action} onOpenChange={(o) => { if (!o) { setAction(null); setPerson(""); setReason(""); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {action?.kind === "put" ? `Pôr no terminal de ${action.cityLabel}` : action?.kind === "pass" ? `Passar o terminal de ${action.cityLabel}` : `Fechar o terminal de ${action?.cityLabel ?? ""}`}
            </DialogTitle>
            <DialogDescription>
              {action?.kind === "close" ? `${action.holder} sai do terminal.` : action?.kind === "pass" ? `${action.holder} sai e entra a pessoa que escolheres.` : "Sem GPS: fica registado que foste tu."}
            </DialogDescription>
          </DialogHeader>
          {action && action.kind !== "close" && (
            <div className="space-y-1.5">
              <Label>Quem</Label>
              <SearchableSelect value={person} onChange={setPerson} options={options} placeholder="Escolher pessoa com o ponto aberto" emptyText="Ninguém com o ponto aberto nesta cidade" />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="terminal-reason">Motivo</Label>
            <Textarea id="terminal-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} rows={2} placeholder="Ex.: o GPS do PDA não apanha" />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setAction(null)}>Cancelar</Button>
            <Button disabled={pending || !reasonOk || (action?.kind !== "close" && !person)} onClick={submit}>Confirmar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
