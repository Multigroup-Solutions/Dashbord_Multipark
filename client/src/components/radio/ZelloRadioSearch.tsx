/**
 * Rádio → Gravações do Zello (32a, Jorge 6 out 2026): escolhe-se o dia e o
 * intervalo de horas (e, se se quiser, um utilizador do Zello ou um canal); a
 * app vai buscar ao Zello as mensagens de voz — com a transcrição do Zello, ou
 * transcreve-se com a IA — e cruza cada uma com a posição e a velocidade de
 * quem falou nessa hora (GPS do Zello) e com o que essa pessoa fez na
 * Multipark à volta da hora (entradas, saídas, movimentos).
 * 34a: escolhem-se mensagens e guardam-se como prova (separador Provas).
 */
import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { can, seesBeyondOwn } from "@shared/access";
import { lisbonDayOf } from "@shared/lisbonDay";
import { changeLabel, fmtDelta } from "@shared/radioCross";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FileText, Loader2, MapPin, Mic, Play, Search, Sparkles, Truck } from "lucide-react";
import { EvidenceSaveDialog, type EvidencePick } from "./RadioEvidence";
import { EVIDENCE_MAX_PER_SAVE } from "@shared/radioEvidence";

const ALL = "__all__";
const hms = (ms: number) => new Intl.DateTimeFormat("pt-PT", { timeZone: "Europe/Lisbon", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(ms));
type Params = { day: string; from: string; to: string; user?: string; channel?: string; includeReceived?: boolean };

export function ZelloRadioSearch() {
  const opts = trpc.operational.radio.zelloOptions.useQuery(undefined, { staleTime: 10 * 60_000, retry: false });
  const [day, setDay] = useState(() => lisbonDayOf(new Date()));
  const [from, setFrom] = useState("00:00");
  const [to, setTo] = useState("23:59");
  const [user, setUser] = useState(ALL);
  const [channel, setChannel] = useState(ALL);
  const [received, setReceived] = useState(false);
  const [params, setParams] = useState<Params | null>(null);
  const [starts, setStarts] = useState<number[]>([0]);
  // 34a: mensagens escolhidas para guardar como prova
  const { user: me } = useAuth();
  const canSave = !!me && can(me as any, "radio", "edit");
  const [picked, setPicked] = useState<Map<number, EvidencePick>>(new Map());
  const [saving, setSaving] = useState<EvidencePick[] | null>(null);
  const toggle = (p: EvidencePick) => setPicked((cur) => {
    const next = new Map(cur);
    if (next.has(p.id)) next.delete(p.id);
    else if (next.size >= EVIDENCE_MAX_PER_SAVE) { toast.error(`No máximo ${EVIDENCE_MAX_PER_SAVE} mensagens de cada vez.`); return cur; }
    else next.set(p.id, p);
    return next;
  });
  const sel = canSave ? { picked, toggle, saveOne: (p: EvidencePick) => setSaving([p]) } : null;

  const search = () => {
    setStarts([0]);
    setParams({ day, from, to, ...(user !== ALL ? { user } : {}), ...(channel !== ALL ? { channel } : {}), ...(user !== ALL && received ? { includeReceived: true } : {}) });
  };

  if (opts.data && !opts.data.configured) return <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">O Zello não está configurado (Integrações).</CardContent></Card>;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1"><Label htmlFor="rz-day">Dia</Label><Input id="rz-day" type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} className="h-9 w-40" /></div>
            <div className="space-y-1"><Label htmlFor="rz-from">De</Label><Input id="rz-from" type="time" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} className="h-9 w-28" /></div>
            <div className="space-y-1"><Label htmlFor="rz-to">Até</Label><Input id="rz-to" type="time" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} className="h-9 w-28" /></div>
            <div className="space-y-1 min-w-[12rem]">
              <Label>Utilizador do Zello</Label>
              <Select value={user} onValueChange={setUser}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Todos</SelectItem>
                  {(opts.data?.users ?? []).map((u) => <SelectItem key={u.username} value={u.username}>{u.fullName}{u.fullName !== u.username ? ` (${u.username})` : ""}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 min-w-[10rem]">
              <Label>Canal</Label>
              <Select value={channel} onValueChange={setChannel}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Todos</SelectItem>
                  {(opts.data?.channels ?? []).map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {user !== ALL && <label className="flex items-center gap-1 pb-2 text-xs text-muted-foreground"><input type="checkbox" checked={received} onChange={(e) => setReceived(e.target.checked)} /> também as que recebeu</label>}
            <Button onClick={search}><Search className="mr-1 h-4 w-4" /> Procurar</Button>
          </div>
          <p className="text-xs text-muted-foreground">Hora de Lisboa, no máximo 24 horas de cada vez ("até" antes do "de" = dia seguinte, como no turno da noite). Para cada mensagem: quem falou (pelo PDA ou pela ficha), a posição e a velocidade nessa hora (GPS do Zello) e o que fez na Multipark 10 minutos antes e depois.</p>
        </CardContent>
      </Card>
      {canSave && picked.size > 0 && (
        <div className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-md border bg-background p-2 shadow-sm">
          <span className="text-sm"><b>{picked.size}</b> mensage{picked.size === 1 ? "m escolhida" : "ns escolhidas"}</span>
          <Button size="sm" onClick={() => setSaving([...picked.values()])}><FileText className="mr-1 h-4 w-4" /> Guardar como prova</Button>
          <Button size="sm" variant="ghost" onClick={() => setPicked(new Map())}>Limpar</Button>
        </div>
      )}
      {params && starts.map((s, i) => <ResultPage key={`${JSON.stringify(params)}-${s}`} params={params} start={s} last={i === starts.length - 1} onMore={(n) => setStarts((x) => [...x, n])} sel={sel} />)}
      {saving && <EvidenceSaveDialog picks={saving} onClose={() => setSaving(null)} onSaved={() => { setSaving(null); setPicked(new Map()); }} />}
    </div>
  );
}

type Sel = { picked: Map<number, EvidencePick>; toggle: (p: EvidencePick) => void; saveOne: (p: EvidencePick) => void } | null;

function ResultPage({ params, start, last, onMore, sel }: { params: Params; start: number; last: boolean; onMore: (next: number) => void; sel: Sel }) {
  const q = trpc.operational.radio.zelloSearch.useQuery({ ...params, start }, { retry: false, staleTime: 5 * 60_000 });
  if (q.isLoading) return <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (q.error) return <p role="alert" className="text-sm text-destructive">{q.error.message}</p>;
  const d = q.data;
  if (!d) return null;
  if (!d.available) return <p role="status" className="text-sm text-amber-800">{d.reason}</p>;
  return (
    <div className="space-y-3">
      {d.notices.map((n, i) => <p key={i} role="status" className="text-xs text-amber-800">{n}</p>)}
      {d.messages.length === 0 && start === 0 ? <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">Sem mensagens de voz nesse intervalo.</CardContent></Card>
        : d.messages.map((m) => <MessageCard key={m.id} m={m} sel={sel} />)}
      {last && d.hasMore && <Button variant="outline" onClick={() => onMore(d.nextStart)}>Ver mais</Button>}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function MessageCard({ m, sel }: { m: any; sel: Sel }) {
  const { user } = useAuth();
  const canTranscribe = !!user && can(user as any, "radio", "edit") && seesBeyondOwn(user as any, "radio");
  const utils = trpc.useUtils();
  const [audio, setAudio] = useState<string | null>(null);
  const [preparing, setPreparing] = useState<string | null>(null);
  const media = trpc.operational.radio.zelloMedia.useMutation();
  const transcribe = trpc.operational.radio.zelloTranscribe.useMutation({
    onSuccess: (r) => {
      if ("pending" in r) toast.message("O Zello ainda está a preparar o áudio — tenta daqui a uns segundos.");
      else { toast.success(r.reused ? "Já estava transcrita." : "Transcrição feita."); utils.operational.radio.zelloSearch.invalidate(); }
    },
    onError: (e) => toast.error(e.message),
  });

  async function play() {
    for (let i = 0; i < 10; i++) {
      try {
        const r = await media.mutateAsync({ key: m.mediaKey });
        if (r.ready && r.url) { setAudio(r.url); setPreparing(null); return; }
        setPreparing(`O Zello está a preparar o áudio${r.progress != null ? ` (${r.progress}%)` : ""}…`);
      } catch (e: any) { toast.error(e?.message ?? "Sem áudio."); setPreparing(null); return; }
      await new Promise((res) => setTimeout(res, 2000));
    }
    setPreparing("O áudio ainda não ficou pronto — tenta outra vez.");
  }

  const who = m.person?.name ?? m.senderName ?? m.sender;
  const text = m.transcription ?? m.aiTranscription?.text ?? null;
  return (
    <Card>
      <CardContent className="p-4 space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {sel && !m.evidenceId && <input type="checkbox" aria-label="Escolher para guardar como prova" checked={sel.picked.has(m.id)} onChange={() => sel.toggle({ id: m.id, at: m.at, sender: m.sender })} />}
          <Mic className="h-4 w-4 text-primary" aria-hidden />
          <b className="tabular-nums">{hms(m.at)}</b>
          <span className="font-medium">{who}</span>
          {m.person?.via === "pda" && <Badge variant="outline" title={`Zello ${m.sender}`}>PDA {m.sender}</Badge>}
          {!m.person && <Badge variant="outline" title="Sem check-in no PDA nem ficha com este Zello">por identificar</Badge>}
          {m.recipient && <span className="text-xs text-muted-foreground">→ {m.recipientType === "channel" ? `canal ${m.recipient}` : m.recipient}</span>}
          {m.durationS != null && <span className="text-xs text-muted-foreground">{m.durationS} s</span>}
          {m.mediaKey && (audio
            ? <audio controls autoPlay src={audio} className="h-8" />
            : <Button size="sm" variant="outline" onClick={play} disabled={media.isPending || !!preparing}><Play className="mr-1 h-3.5 w-3.5" /> Ouvir</Button>)}
          {m.evidenceId ? <Badge variant="secondary" title="Já guardada (separador Provas)"><FileText className="mr-1 h-3 w-3" /> Prova #{m.evidenceId}</Badge>
            : sel && <Button size="sm" variant="ghost" onClick={() => sel.saveOne({ id: m.id, at: m.at, sender: m.sender })}><FileText className="mr-1 h-3.5 w-3.5" /> Guardar como prova</Button>}
        </div>
        {preparing && !audio && <p className="text-xs text-muted-foreground">{preparing}</p>}

        {text ? (
          <p className="text-sm whitespace-pre-wrap break-words">
            {m.transcription ? (m.transcriptionInaccurate ? <Badge variant="outline" className="mr-1">Zello · pode ter erros</Badge> : <Badge variant="outline" className="mr-1">Zello</Badge>) : <Badge variant="outline" className="mr-1">IA</Badge>}
            {text}
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            Sem transcrição.
            {canTranscribe && m.mediaKey && <Button size="sm" variant="outline" disabled={transcribe.isPending} onClick={() => transcribe.mutate({ messageId: m.id, mediaKey: m.mediaKey, ...(m.durationS != null ? { durationS: m.durationS } : {}) })}><Sparkles className="mr-1 h-3.5 w-3.5" /> Transcrever (IA)</Button>}
          </div>
        )}
        {m.aiTranscription?.summary && <p className="rounded bg-muted/50 p-2 text-xs">{m.aiTranscription.summary}</p>}

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <MapPin className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          {m.position ? (
            <span>
              <b className="tabular-nums">{Math.round(m.position.speed)} km/h</b>
              {m.position.lat != null && m.position.lon != null && <> · <a className="underline" href={`https://www.google.com/maps?q=${m.position.lat},${m.position.lon}`} target="_blank" rel="noopener noreferrer">ver no mapa</a></>}
              <span className="text-muted-foreground"> · GPS {fmtDelta(m.position.deltaS)}</span>
            </span>
          ) : <span className="text-muted-foreground">Sem GPS do Zello nesses 5 minutos.</span>}
        </div>

        <div className="flex flex-wrap items-start gap-2 text-xs">
          <Truck className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          {!m.person ? <span className="text-muted-foreground">Sem pessoa identificada: sem ligação à Multipark.</span>
            : m.actions.length === 0 ? <span className="text-muted-foreground">Sem ações na Multipark 10 min antes ou depois.</span>
            : (
              <ul className="space-y-0.5">
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {m.actions.map((a: any, i: number) => (
                  <li key={i}><b className="tabular-nums">{hms(a.at)}</b> · {changeLabel(a.changeType)}{a.plate ? ` · ${a.plate}` : ""}{a.bookingCode ? ` · reserva ${a.bookingCode}` : ""}{a.park ? ` · ${a.park}` : ""} <span className="text-muted-foreground">({fmtDelta(a.deltaS)})</span></li>
                ))}
              </ul>
            )}
        </div>
      </CardContent>
    </Card>
  );
}
