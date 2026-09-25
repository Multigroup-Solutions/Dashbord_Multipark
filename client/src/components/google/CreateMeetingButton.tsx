// "Criar reunião" (Google Meet) a partir de um cliente, reclamação ou
// parceria: o evento vai para o calendário PRINCIPAL de quem cria, com link
// do Meet; o email do cliente só é convidado se "Convidar cliente" estiver
// marcado. A reunião fica nas Comunicações do registo.
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { ExternalLink, Loader2, Sparkles, Video } from "lucide-react";
import type { MeetingEntityType } from "@shared/googleSync";
import { googleFeaturesHref } from "./GoogleSyncCard";

/** Próxima meia hora redonda (hora de Lisboa) em "YYYY-MM-DDTHH:MM". */
function nextSlotLocal(): string {
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date(Date.now() + 60 * 60_000)).replace(" ", "T");
  const [d, t] = parts.split("T");
  const [h, m] = t.split(":").map(Number);
  const mm = m < 30 ? 30 : 0;
  const hh = m < 30 ? h : (h + 1) % 24;
  return `${d}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function CreateMeetingButton({ entityType, entityId, defaultTitle, size = "sm" }: { entityType: MeetingEntityType; entityId: string | number | null | undefined; defaultTitle?: string; size?: "sm" | "default" }) {
  const [open, setOpen] = useState(false);
  const id = entityId == null ? "" : String(entityId).trim();
  if (!id) return null;
  return (
    <>
      <Button type="button" size={size} variant="outline" onClick={() => setOpen(true)}>
        <Video className="h-4 w-4 mr-1" />Criar reunião
      </Button>
      {open && <MeetingDialog entityType={entityType} entityId={id} defaultTitle={defaultTitle} onClose={() => setOpen(false)} />}
    </>
  );
}

function MeetingDialog({ entityType, entityId, defaultTitle, onClose }: { entityType: MeetingEntityType; entityId: string; defaultTitle?: string; onClose: () => void }) {
  const utils = trpc.useUtils();
  const ctx = trpc.googleCalendar.meetingContext.useQuery({ entityType, entityId }, { retry: false });
  const [title, setTitle] = useState(defaultTitle ?? "");
  const [start, setStart] = useState(nextSlotLocal());
  const [duration, setDuration] = useState("30");
  const [invite, setInvite] = useState(false);
  const [notes, setNotes] = useState("");
  const [created, setCreated] = useState<{ meetLink: string | null; htmlLink: string | null } | null>(null);
  const create = trpc.googleCalendar.createMeeting.useMutation({
    onSuccess: (r) => { setCreated(r); toast.success("Reunião criada no teu Google Calendar."); utils.mail.timeline.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const c = ctx.data;
  const effectiveTitle = title || (c ? `Reunião — ${c.label}` : "");

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Video className="h-4 w-4 text-primary" />Criar reunião (Google Meet)</DialogTitle></DialogHeader>
        {ctx.isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
        {ctx.error && <p className="text-sm text-destructive">{ctx.error.message}</p>}
        {c && !c.calendarGranted && (
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2 text-sm">
            <p>{c.needsReauth ? "A tua conta Google precisa de ser religada." : c.connected ? "Ativa o Calendário na tua conta Google para criares reuniões com Meet." : "Liga a tua conta Google para criares reuniões com Meet."}</p>
            <Button asChild size="sm">
              <a href={googleFeaturesHref(c.connected && !c.needsReauth ? ["calendar"] : ["gmail", "calendar", "tasks"], window.location.pathname + window.location.search)}>
                <Sparkles className="h-4 w-4 mr-1" />{c.connected && !c.needsReauth ? "Ativar Calendário" : "Ligar conta Google"}
              </a>
            </Button>
          </div>
        )}
        {c && c.calendarGranted && !created && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">{c.label}</p>
            <div className="space-y-1">
              <Label htmlFor="mt-title">Título</Label>
              <Input id="mt-title" value={effectiveTitle} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="mt-start">Início (Lisboa)</Label>
                <Input id="mt-start" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Duração</Label>
                <Select value={duration} onValueChange={setDuration}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["15", "30", "45", "60", "90", "120"].map((m) => <SelectItem key={m} value={m}>{m} min</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="mt-notes">Notas (opcional)</Label>
              <Textarea id="mt-notes" rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
            <label className={`flex items-start gap-2 min-h-[44px] text-sm ${c.clientEmail ? "cursor-pointer" : "opacity-60"}`}>
              <Checkbox checked={invite} disabled={!c.clientEmail} onCheckedChange={(v) => setInvite(v === true)} className="mt-0.5" />
              <span>
                Convidar cliente{c.clientEmail ? ` (${c.clientEmail})` : " — sem email no registo"}
                <span className="block text-[11.5px] text-muted-foreground">Sem esta opção, o evento fica só no teu calendário e ninguém recebe convite.</span>
              </span>
            </label>
          </div>
        )}
        {created && (
          <div className="space-y-2 text-sm">
            <p className="text-emerald-700 dark:text-emerald-300">Reunião criada{invite ? " e convite enviado ao cliente" : ""}.</p>
            {created.meetLink && <a href={created.meetLink} target="_blank" rel="noreferrer" className="text-primary underline inline-flex items-center gap-1 break-all">{created.meetLink} <ExternalLink className="h-3 w-3" /></a>}
            {created.htmlLink && <a href={created.htmlLink} target="_blank" rel="noreferrer" className="block text-xs text-muted-foreground underline">Abrir no Google Calendar</a>}
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>{created ? "Fechar" : "Cancelar"}</Button>
          {c?.calendarGranted && !created && (
            <Button disabled={create.isPending || !effectiveTitle.trim() || !start}
              onClick={() => create.mutate({ entityType, entityId, title: effectiveTitle.trim(), startLocal: start.slice(0, 16), durationMin: Number(duration), inviteClient: invite, notes: notes || undefined })}>
              {create.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Criar reunião
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
