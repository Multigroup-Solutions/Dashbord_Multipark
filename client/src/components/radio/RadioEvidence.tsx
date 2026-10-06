/**
 * Rádio → Provas (34a, Jorge 6 out 2026): "guardar alguns registos com o
 * histórico e a transcrição para servir de prova para algumas situações".
 *
 *  - `EvidenceSaveDialog`: guarda as mensagens escolhidas na pesquisa do Zello
 *    com a situação (obrigatória), a referência e notas. O servidor volta a
 *    ler cada mensagem no Zello e grava a fotografia com um selo.
 *  - `RadioEvidenceList`: as provas guardadas, com pesquisa, imprimir/PDF,
 *    juntar/ouvir o áudio e arquivar (nunca apagar).
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { can } from "@shared/access";
import { canSaveEvidence, evidenceText, EVIDENCE_NOTES_MAX, EVIDENCE_REFERENCE_MAX, EVIDENCE_SITUATION_MAX, type EvidenceRecord } from "@shared/radioEvidence";
import { changeLabel, fmtDelta } from "@shared/radioCross";
import { retryTransient } from "@/lib/queryRetry";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Archive, FileText, Loader2, MapPin, Mic, Paperclip, Play, Printer, Search, Truck } from "lucide-react";

export type EvidencePick = { id: number; at: number; sender: string };

const dt = (ms: number) => new Intl.DateTimeFormat("pt-PT", { timeZone: "Europe/Lisbon", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(ms));
const hms = (ms: number) => new Intl.DateTimeFormat("pt-PT", { timeZone: "Europe/Lisbon", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(ms));

export function EvidenceSaveDialog({ picks, onClose, onSaved }: { picks: EvidencePick[]; onClose: () => void; onSaved: () => void }) {
  const utils = trpc.useUtils();
  const [situation, setSituation] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const save = trpc.operational.radio.evidenceSave.useMutation({
    onSuccess: (r) => {
      const audioOk = r.saved.filter((s) => s.audio === "saved").length;
      const parts = [
        r.saved.length ? `${r.saved.length} guardada(s) como prova${r.saved.length ? ` (áudio em ${audioOk})` : ""}` : null,
        r.already.length ? `${r.already.length} já era(m) prova (${r.already.map((a) => `#${a.id}`).join(", ")})` : null,
      ].filter(Boolean).join(" · ");
      if (r.failed.length) toast.error(`${parts ? `${parts} · ` : ""}${r.failed.length} não guardada(s): ${r.failed[0].reason}`);
      else toast.success(parts || "Nada para guardar.");
      utils.operational.radio.evidenceList.invalidate();
      utils.operational.radio.zelloSearch.invalidate();
      if (r.saved.length || r.already.length) onSaved();
    },
    onError: (e) => toast.error(e.message),
  });
  const ok = situation.trim().length >= 3;
  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Guardar {picks.length === 1 ? "a mensagem" : `${picks.length} mensagens`} como prova</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">Fica guardado tal como está agora: quem falou, a hora, a transcrição, a posição e a velocidade, e o que fez na Multipark à volta da hora. Não se edita nem se apaga (arquiva-se com motivo). O áudio do Zello junta-se se o Zello o der.</p>
          <div className="space-y-1">
            <Label htmlFor="ev-sit">Situação *</Label>
            <Input id="ev-sit" value={situation} maxLength={EVIDENCE_SITUATION_MAX} onChange={(e) => setSituation(e.target.value)} placeholder="Ex.: dano no carro da reserva X; atraso na entrega" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ev-ref">Referência</Label>
            <Input id="ev-ref" value={reference} maxLength={EVIDENCE_REFERENCE_MAX} onChange={(e) => setReference(e.target.value)} placeholder="Reserva, matrícula, ocorrência ou reclamação" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ev-notes">Notas</Label>
            <Textarea id="ev-notes" value={notes} maxLength={EVIDENCE_NOTES_MAX} rows={3} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancelar</Button>
          <Button disabled={!ok || save.isPending} onClick={() => save.mutate({ picks, situation, ...(reference.trim() ? { reference } : {}), ...(notes.trim() ? { notes } : {}) })}>
            {save.isPending ? <><Loader2 className="mr-1 h-4 w-4 animate-spin" /> A guardar…</> : "Guardar como prova"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Abre uma página só com as provas (texto) e pede para imprimir / guardar em PDF. */
export function printEvidence(items: EvidenceRecord[]) {
  const w = window.open("", "_blank");
  if (!w) { toast.error("O browser bloqueou a janela de impressão — deixa abrir janelas para este site."); return; }
  const body = items.map((e) => `<section><pre>${esc(evidenceText(e))}</pre></section>`).join("");
  w.document.write(`<!doctype html><html lang="pt"><head><meta charset="utf-8"><title>Provas do rádio</title>
<style>body{font:12px/1.45 system-ui,sans-serif;margin:24px;color:#111}h1{font-size:16px}section{border:1px solid #ccc;border-radius:6px;padding:10px 12px;margin:0 0 12px;page-break-inside:avoid}pre{white-space:pre-wrap;word-break:break-word;font:inherit;margin:0}</style>
</head><body><h1>Provas do rádio — Multipark</h1><p>Impresso em ${esc(dt(Date.now()))} (hora de Lisboa).</p>${body}</body></html>`);
  w.document.close();
  w.focus();
  w.print();
}

export function RadioEvidenceList() {
  const { user } = useAuth();
  // 36a: juntar o áudio = quem pode guardar provas (supervisor, backoffice, admin, super admin)
  const canEdit = !!user && can(user as any, "radio", "edit") && canSaveEvidence((user as any).role);
  const canManage = !!user && can(user as any, "radio", "manage");
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [archived, setArchived] = useState(false);
  const list = trpc.operational.radio.evidenceList.useInfiniteQuery(
    { ...(q ? { q } : {}), ...(archived ? { includeArchived: true } : {}) },
    { retry: retryTransient, getNextPageParam: (last) => last.nextCursor ?? undefined },
  );
  const items = useMemo(() => (list.data?.pages ?? []).flatMap((p) => p.items) as EvidenceRecord[], [list.data]);
  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardContent className="p-4 flex flex-wrap items-end gap-3">
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); setQ(text.trim()); }}>
            <div className="space-y-1"><Label htmlFor="ev-q">Procurar</Label><Input id="ev-q" value={text} onChange={(e) => setText(e.target.value)} placeholder="Situação, referência, pessoa, texto" className="h-9 w-64" /></div>
            <Button type="submit" variant="outline"><Search className="mr-1 h-4 w-4" /> Procurar</Button>
          </form>
          <label className="flex items-center gap-1 pb-2 text-xs text-muted-foreground"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> mostrar arquivadas</label>
          <Button variant="outline" className="ml-auto" disabled={!items.length} onClick={() => printEvidence(items)}><Printer className="mr-1 h-4 w-4" /> Imprimir / PDF ({items.length})</Button>
        </CardContent>
      </Card>
      {list.isLoading ? <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        : list.error ? <QueryErrorNote error={list.error} onRetry={() => list.refetch()} retrying={list.isFetching} what="as provas" />
        : !items.length ? <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">{q ? "Nenhuma prova com esse texto." : "Ainda não há provas guardadas. Na pesquisa do Zello, escolhe as mensagens e carrega em \"Guardar como prova\"."}</CardContent></Card>
        : items.map((e) => <EvidenceCard key={e.id} e={e} canEdit={canEdit} canManage={canManage} />)}
      {list.hasNextPage && <Button variant="outline" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>Ver mais</Button>}
    </div>
  );
}

function EvidenceCard({ e, canEdit, canManage }: { e: EvidenceRecord; canEdit: boolean; canManage: boolean }) {
  const utils = trpc.useUtils();
  const [listen, setListen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [reason, setReason] = useState("");
  const audioUrl = trpc.operational.radio.evidenceAudioUrl.useQuery({ id: e.id }, { enabled: listen && e.hasAudio, retry: false, staleTime: 10 * 60_000 });
  const attach = trpc.operational.radio.evidenceAttachAudio.useMutation({
    onSuccess: (r) => {
      if (r.status === "pending") toast.message(`O Zello ainda está a preparar o áudio${r.progress != null ? ` (${r.progress}%)` : ""} — tenta daqui a uns segundos.`);
      else toast.success("Áudio guardado na prova.");
      utils.operational.radio.evidenceList.invalidate();
    },
    onError: (err) => { toast.error(err.message); utils.operational.radio.evidenceList.invalidate(); },
  });
  const archive = trpc.operational.radio.evidenceArchive.useMutation({
    onSuccess: () => { toast.success(`Prova #${e.id} arquivada.`); setArchiving(false); utils.operational.radio.evidenceList.invalidate(); utils.operational.radio.zelloSearch.invalidate(); },
    onError: (err) => toast.error(err.message),
  });
  const who = e.personName ?? e.senderName ?? e.sender;
  return (
    <Card className={e.archivedAt ? "opacity-70" : undefined}>
      <CardContent className="p-4 space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <FileText className="h-4 w-4 text-primary" aria-hidden />
          <b>Prova #{e.id}</b>
          <span className="font-medium">{e.situation}</span>
          {e.reference && <Badge variant="outline">{e.reference}</Badge>}
          {e.archivedAt && <Badge variant="secondary" title={e.archiveReason ?? undefined}>Arquivada</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Mic className="h-4 w-4 text-muted-foreground" aria-hidden />
          <b className="tabular-nums">{dt(e.at)}</b>
          <span>{who}</span>
          {e.personVia === "pda" && <Badge variant="outline">PDA {e.sender}</Badge>}
          {!e.personVia && <Badge variant="outline">por identificar</Badge>}
          {e.recipient && <span className="text-xs text-muted-foreground">→ {e.recipientType === "channel" ? `canal ${e.recipient}` : e.recipient}</span>}
          {e.durationS != null && <span className="text-xs text-muted-foreground">{e.durationS} s</span>}
        </div>
        <p className="text-sm whitespace-pre-wrap break-words">
          {e.transcriptionSource && <Badge variant="outline" className="mr-1">{e.transcriptionSource === "zello" ? (e.transcriptionInaccurate ? "Zello · pode ter erros" : "Zello") : "IA"}</Badge>}
          {e.transcription ?? <span className="text-muted-foreground">Sem transcrição.</span>}
        </p>
        {e.summary && <p className="rounded bg-muted/50 p-2 text-xs">{e.summary}</p>}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <MapPin className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          {e.position ? <span><b className="tabular-nums">{Math.round(e.position.speed)} km/h</b>
            {e.position.lat != null && e.position.lon != null && <> · <a className="underline" href={`https://www.google.com/maps?q=${e.position.lat},${e.position.lon}`} target="_blank" rel="noopener noreferrer">ver no mapa</a></>}
            <span className="text-muted-foreground"> · GPS {fmtDelta(e.position.deltaS)}</span></span>
            : <span className="text-muted-foreground">Sem GPS do Zello nesses 5 minutos.</span>}
        </div>
        <div className="flex flex-wrap items-start gap-2 text-xs">
          <Truck className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          {e.actions.length ? <ul className="space-y-0.5">{e.actions.map((a, i) => <li key={i}><b className="tabular-nums">{hms(a.at)}</b> · {changeLabel(a.changeType)}{a.plate ? ` · ${a.plate}` : ""}{a.bookingCode ? ` · reserva ${a.bookingCode}` : ""}{a.park ? ` · ${a.park}` : ""} <span className="text-muted-foreground">({fmtDelta(a.deltaS)})</span></li>)}</ul>
            : <span className="text-muted-foreground">{e.employeeId == null ? "Sem pessoa identificada: sem ligação à Multipark." : "Sem ações na Multipark 10 min antes ou depois."}</span>}
        </div>
        {e.notes && <p className="text-xs whitespace-pre-wrap"><b>Notas:</b> {e.notes}</p>}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {e.hasAudio
            ? (listen && audioUrl.data?.url ? <audio controls autoPlay src={audioUrl.data.url} className="h-8" />
              : <Button size="sm" variant="outline" onClick={() => setListen(true)} disabled={listen && audioUrl.isLoading}><Play className="mr-1 h-3.5 w-3.5" /> Ouvir</Button>)
            : canEdit && e.mediaKey && !e.archivedAt && <Button size="sm" variant="outline" onClick={() => attach.mutate({ id: e.id })} disabled={attach.isPending}><Paperclip className="mr-1 h-3.5 w-3.5" /> {attach.isPending ? "A juntar…" : "Juntar o áudio"}</Button>}
          <Button size="sm" variant="outline" onClick={() => printEvidence([e])}><Printer className="mr-1 h-3.5 w-3.5" /> Imprimir</Button>
          {canManage && !e.archivedAt && <Button size="sm" variant="ghost" onClick={() => setArchiving(true)}><Archive className="mr-1 h-3.5 w-3.5" /> Arquivar</Button>}
        </div>
        {!e.hasAudio && e.audioNote && <p className="text-xs text-amber-800">{e.audioNote}</p>}
        {listen && audioUrl.error && <p className="text-xs text-destructive">{audioUrl.error.message}</p>}
        <p className="text-[11px] text-muted-foreground">Guardada por {e.savedByName ?? "—"} em {e.savedAt} UTC · selo {e.contentHash.slice(0, 16)}{e.archivedAt ? ` · arquivada em ${e.archivedAt} UTC${e.archiveReason ? ` (${e.archiveReason})` : ""}` : ""}</p>
        {archiving && (
          <Dialog open onOpenChange={(o) => !o && setArchiving(false)}>
            <DialogContent className="max-w-md">
              <DialogHeader><DialogTitle>Arquivar a prova #{e.id}?</DialogTitle></DialogHeader>
              <p className="text-sm text-muted-foreground">Sai da lista (fica em "mostrar arquivadas"). Não se apaga.</p>
              <div className="space-y-1"><Label htmlFor={`ev-arch-${e.id}`}>Motivo *</Label><Input id={`ev-arch-${e.id}`} value={reason} maxLength={255} onChange={(x) => setReason(x.target.value)} /></div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setArchiving(false)}>Cancelar</Button>
                <Button disabled={reason.trim().length < 3 || archive.isPending} onClick={() => archive.mutate({ id: e.id, reason })}>Arquivar</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </CardContent>
    </Card>
  );
}
