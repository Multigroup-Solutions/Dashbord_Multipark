import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Clock, Mail, MessageCircle, Send, Users } from "lucide-react";
import { buildAvailabilityMessage, AVAILABILITY_KINDS, type AvailabilityMessageKind } from "@shared/availabilityMessages";
import { needsBroadcastConfirm } from "@shared/whatsappBroadcastRules";
import { emailConfirmText, sendAllLabel, type AvailabilitySendScope } from "@shared/availabilityFilters";

const pad = (n: number) => String(n).padStart(2, "0");
const isoOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Envio por email do pedido de disponibilidade — o mesmo formato do diálogo do
 * WhatsApp: para quem vai (em cima), a mensagem (tipo de pedido + nota +
 * pré-visualização), o teste para 1 endereço e o envio com "Confirmar".
 * Antes isto vivia num painel "Mensagem e envio de teste" solto na página e o
 * envio era um `confirm()` do browser.
 */
export function AvailabilityEmailDialog({
  open,
  onOpenChange,
  scope,
  targetPhrase,
  breakdown,
  closedNote,
  forceConfirm,
  statesCount,
  targetIds,
  weekStart,
  weekLabel,
  note,
  onNoteChange,
  onUseInWhatsApp,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: AvailabilitySendScope;
  /** "aos 12 extras selecionados" / "a todos os 317 extras" (a mesma frase da barra). */
  targetPhrase: string;
  /** "40 disponíveis · 237 sem resposta · 43 indisponíveis". */
  breakdown: string;
  /** "inclui 237 em secções fechadas" (null = nada escondido). */
  closedNote: string | null;
  /** Envio a todos os estados sem seleção: pede SEMPRE "Enviar a todos os N". */
  forceConfirm: boolean;
  /** Quantos estados diferentes há no alvo (para "… (2 estados)"). */
  statesCount: number;
  /** Ids dos destinatários (selecionados ou filtrados) — mandados sempre explícitos. */
  targetIds: number[];
  weekStart: string;
  /** "Segunda 19/10 a Domingo 25/10" — a MESMA fórmula do email no servidor. */
  weekLabel: string;
  note: string;
  onNoteChange: (v: string) => void;
  /** "Usar este texto no WhatsApp": fecha este diálogo e abre o do WhatsApp com o texto. */
  onUseInWhatsApp: (text: string) => void;
  onSent: () => void;
}) {
  // Tipo de pedido (templates do Jorge): semana / dia+turno / que-horas / das X às Y
  const [msgKind, setMsgKind] = useState<AvailabilityMessageKind>("week");
  const [msgDate, setMsgDate] = useState(() => { const d = new Date(); d.setDate(d.getDate() + 1); return isoOf(d); });
  const [msgShift, setMsgShift] = useState<"morning" | "afternoon" | "night">("morning");
  const [msgFrom, setMsgFrom] = useState(8);
  const [msgTo, setMsgTo] = useState(20);
  const [testEmail, setTestEmail] = useState("");
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { if (open) setConfirming(false); }, [open]);
  // Mudou a mensagem ou o alvo → volta a pedir confirmação.
  useEffect(() => { setConfirming(false); }, [msgKind, msgDate, msgShift, msgFrom, msgTo, note, targetIds.length]);

  const msgDateLabel = useMemo(() => {
    const today = new Date();
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
    const dm = msgDate.slice(8, 10) + "/" + msgDate.slice(5, 7);
    if (msgDate === isoOf(today)) return `hoje (${dm})`;
    if (msgDate === isoOf(tomorrow)) return `amanhã (${dm})`;
    return `dia ${dm}`;
  }, [msgDate]);
  const msgInput = useMemo(() => msgKind === "week" ? null : ({
    kind: msgKind, dateLabel: msgDateLabel, targetDate: msgDate || null,
    ...(msgKind === "day_shift" ? { shift: msgShift } : {}),
    ...(msgKind === "day_range" ? { fromHour: msgFrom, toHour: msgTo } : {}),
  }), [msgKind, msgDateLabel, msgDate, msgShift, msgFrom, msgTo]);
  const msgPreview = useMemo(() => buildAvailabilityMessage({
    kind: msgKind, dateLabel: msgDateLabel, shift: msgShift,
    fromHour: msgFrom, toHour: msgTo, note: note.trim() || null,
    weekLabel: weekLabel || undefined,
  }), [msgKind, msgDateLabel, msgShift, msgFrom, msgTo, note, weekLabel]);

  const send = trpc.extrasAvailability.sendRequest.useMutation({
    onSuccess: (r, v) => {
      toast.success(`Pedido enviado: ${r.sent} extras${r.failed ? `, ${r.failed} falhas` : ""}${r.noEmail ? `, ${r.noEmail} sem email` : ""}${r.optedOut ? `, ${r.optedOut} com "Não enviar email"` : ""}`);
      onSent();
      if (!v.testEmail) onOpenChange(false);
    },
    onError: (e) => toast.error(e.message),
  });

  const count = targetIds.length;
  function sendReal() {
    // D32: a várias pessoas, primeiro "Confirmar".
    if (!confirming && (forceConfirm || needsBroadcastConfirm(count))) { setConfirming(true); return; }
    setConfirming(false);
    // Sempre a lista explícita: com um filtro aplicado, deixar o servidor
    // decidir "todos" enviaria a gente que não está na grelha.
    send.mutate({
      weekStart,
      origin: window.location.origin,
      note: note.trim() || null,
      employeeIds: targetIds,
      message: msgInput,
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!send.isPending) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5 text-primary" />
            Pedido por email
          </DialogTitle>
          <DialogDescription>Semana de {weekLabel}. Escolhe a mensagem, testa no teu email e envia.</DialogDescription>
        </DialogHeader>

        {/* Para quem vai — sempre à vista, antes de tudo. */}
        <div className="rounded-[10px] border bg-muted/40 p-3 text-sm">
          <div className="flex items-center gap-2 font-medium">
            <Users className="h-4 w-4 text-primary shrink-0" />
            <span>Vai {targetPhrase}</span>
          </div>
          {breakdown && <p className="mt-1 text-xs text-muted-foreground">{breakdown}</p>}
          {closedNote && <p className="mt-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">Atenção: {closedNote} da grelha.</p>}
        </div>

        <div className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs">Tipo de pedido</Label>
              <Select value={msgKind} onValueChange={(v) => setMsgKind(v as AvailabilityMessageKind)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {AVAILABILITY_KINDS.map((k) => <SelectItem key={k.id} value={k.id}>{k.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {msgKind !== "week" && (
              <div className="space-y-1">
                <Label className="text-xs">Dia</Label>
                <Input type="date" value={msgDate} onChange={(e) => setMsgDate(e.target.value)} />
              </div>
            )}
            {msgKind === "day_shift" && (
              <div className="space-y-1">
                <Label className="text-xs">Turno</Label>
                <Select value={msgShift} onValueChange={(v) => setMsgShift(v as "morning" | "afternoon" | "night")}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="morning">Manhã</SelectItem>
                    <SelectItem value="afternoon">Tarde</SelectItem>
                    <SelectItem value="night">Noite</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            {msgKind === "day_range" && (
              <div className="flex gap-2">
                <div className="space-y-1 flex-1"><Label className="text-xs">Das</Label><Input type="number" min={0} max={23} value={msgFrom} onChange={(e) => setMsgFrom(parseInt(e.target.value) || 0)} /></div>
                <div className="space-y-1 flex-1"><Label className="text-xs">Às</Label><Input type="number" min={0} max={27} value={msgTo} onChange={(e) => setMsgTo(parseInt(e.target.value) || 0)} /></div>
              </div>
            )}
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Nota opcional (vai no fim do email)</Label>
            <Input placeholder="Ex: Reforço para o fim de semana do festival..." value={note} onChange={(e) => onNoteChange(e.target.value)} />
          </div>

          {/* Pré-visualização: exatamente o que o email vai dizer. */}
          <div className="rounded-[10px] border bg-background p-3 text-xs">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Pré-visualização</p>
            <p className="font-semibold">{msgPreview.subject}</p>
            <p className="text-muted-foreground mt-0.5">{msgPreview.lines.join(" ")} <span className="text-primary font-medium">{msgPreview.cta} [link]</span></p>
            <button
              type="button"
              className="mt-2 inline-flex items-center gap-1 text-[11px] text-green-700 dark:text-green-400 hover:underline"
              title="Abre o envio por WhatsApp com este texto no campo do pedido de disponibilidade"
              onClick={() => onUseInWhatsApp(msgPreview.text)}
            >
              <MessageCircle className="h-3 w-3" /> Usar este texto no WhatsApp
            </button>
          </div>

          {/* Teste: enviar só para um endereço (não toca nos extras) */}
          <div className="rounded-[10px] border border-dashed p-3 space-y-2">
            <Label className="text-xs font-medium">Testar primeiro (envia só para 1 email)</Label>
            <div className="flex gap-2 flex-wrap">
              <Input
                type="email"
                placeholder="o-teu-email@multipark.pt"
                className="flex-1 min-w-[12rem]"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
              />
              <Button
                variant="outline"
                disabled={!weekStart || !testEmail.includes("@") || send.isPending}
                onClick={() => send.mutate({
                  weekStart,
                  origin: window.location.origin,
                  note: note.trim() || null,
                  testEmail: testEmail.trim(),
                  message: msgInput,
                })}
              >
                <Send className="h-4 w-4" /> Enviar teste
              </Button>
            </div>
          </div>
        </div>

        {confirming && (
          <div role="alert" className="rounded-[10px] border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
            {emailConfirmText(scope, count, weekLabel, breakdown)}
            {closedNote && <span className="block mt-1 font-medium">Atenção: {closedNote} da grelha.</span>}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => (confirming ? setConfirming(false) : onOpenChange(false))} disabled={send.isPending}>
            {confirming ? "Voltar" : "Fechar"}
          </Button>
          <Button variant="selected" disabled={!weekStart || count === 0 || send.isPending} onClick={sendReal}>
            {send.isPending ? <Clock className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
            {confirming ? (forceConfirm ? sendAllLabel(scope, count, statesCount) : `Confirmar envio a ${count}`) : `Enviar email a ${count}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
