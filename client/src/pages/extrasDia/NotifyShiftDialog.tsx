/**
 * "Avisar este turno" (Extras-dia, pedido 8, Jorge 7 out 2026): janela de
 * confirmação com o aviso de trabalho EXATO de cada pessoa (o seu dia e horas,
 * cidade, ponto de encontro), os canais (WhatsApp e email), quem fica de fora
 * e porquê, e as propostas por confirmar (assinaladas — não recebem). Depois
 * de enviar, o resultado por pessoa. Regras: shared/shiftNotice.ts.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Mail, MessageCircle, Send, XCircle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NOTICE_CHANNELS, NOTICE_CHANNEL_LABELS, type ChannelPlan } from "@shared/shiftNotice";

type CityId = "lisbon" | "porto" | "faro";
type ShiftId = "morning" | "night";
type Channel = (typeof NOTICE_CHANNELS)[number];

const CHANNEL_ICON: Record<Channel, typeof Mail> = { whatsapp: MessageCircle, email: Mail };

function PlanChip({ channel, plan }: { channel: Channel; plan: ChannelPlan }) {
  const Icon = CHANNEL_ICON[channel];
  if (plan.action === "off") return null;
  if (plan.action === "send") {
    return (
      <Badge variant="outline" className="gap-1 text-[11px] border-emerald-300 text-emerald-800 dark:text-emerald-300">
        <Icon className="h-3 w-3" /> {NOTICE_CHANNEL_LABELS[channel]}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 text-[11px] text-muted-foreground" title={plan.reason}>
      <Icon className="h-3 w-3" /> {plan.kind === "already" ? "já avisado" : "não recebe"}
    </Badge>
  );
}

export function NotifyShiftDialog({
  open,
  onOpenChange,
  date,
  city,
  shift,
  shiftLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  date: string;
  city: CityId;
  shift: ShiftId;
  shiftLabel: string;
}) {
  const utils = trpc.useUtils();
  const [channels, setChannels] = useState<Channel[]>(["whatsapp", "email"]);
  useEffect(() => { if (open) setChannels(["whatsapp", "email"]); }, [open]);
  const preview = trpc.extrasDia.notifyPreview.useQuery({ date, city, shift, channels }, { enabled: open && !!date, staleTime: 0 });
  const send = trpc.extrasDia.notify.useMutation({
    onSuccess: (r) => {
      utils.extrasDia.notices.invalidate();
      utils.extrasDia.schedule.invalidate();
      utils.extrasDia.notifyPreview.invalidate();
      const parts = channels.map((c) => `${NOTICE_CHANNEL_LABELS[c]}: ${r.sent[c]} enviado(s)${r.failed[c] ? `, ${r.failed[c]} falhado(s)` : ""}`);
      const nothing = channels.every((c) => r.sent[c] === 0 && r.failed[c] === 0);
      if (nothing) toast.info("Ninguém por avisar: quem está confirmado já tinha sido avisado destas horas.");
      else if (channels.some((c) => r.failed[c] > 0) || r.errors.length) toast.warning(`${parts.join(" · ")} — vê o motivo por pessoa.`);
      else toast.success(parts.join(" · ") + (r.rulesSent ? ` · ${r.rulesSent} com morada e regras` : ""));
    },
    onError: (e) => toast.error(e.message),
  });
  const close = () => { if (send.isPending) return; send.reset(); onOpenChange(false); };

  const p = preview.data;
  const result = send.data;
  const toggle = (c: Channel, on: boolean) => setChannels((prev) => (on ? NOTICE_CHANNELS.filter((x) => x === c || prev.includes(x)) : prev.filter((x) => x !== c)));
  const totalToSend = p ? channels.reduce((n, c) => n + p.toSend[c], 0) : 0;
  const skipped = p ? p.people.filter((x) => channels.every((c) => x.channels[c].action !== "send")) : [];

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-5 w-5 text-primary" /> Avisar este turno — {shiftLabel}
          </DialogTitle>
          <DialogDescription>
            Aviso de trabalho de {p?.dayLabel ?? date}, com as horas de cada pessoa. Só recebem as linhas confirmadas;
            quem já foi avisado destas horas não recebe outra vez.
          </DialogDescription>
        </DialogHeader>

        {!result && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-4" role="group" aria-label="Canais">
              {NOTICE_CHANNELS.map((c) => {
                const Icon = CHANNEL_ICON[c];
                const notConfigured = p && !p.configured[c];
                return (
                  <label key={c} className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox checked={channels.includes(c)} onCheckedChange={(v) => toggle(c, v === true)} disabled={send.isPending} />
                    <Icon className="h-4 w-4" /> {NOTICE_CHANNEL_LABELS[c]}
                    {c === "whatsapp" && <span className="text-xs text-muted-foreground">(template "aviso de trabalho")</span>}
                    {notConfigured && <span className="text-xs text-amber-700">— não configurado</span>}
                  </label>
                );
              })}
            </div>

            {preview.isLoading && <div className="text-sm text-muted-foreground">A preparar a pré-visualização…</div>}
            {preview.error && <QueryErrorNote error={preview.error} onRetry={() => preview.refetch()} retrying={preview.isFetching} what="a pré-visualização" />}

            {p && (
              <>
                {p.pastDay && <div className="rounded-md border border-red-300 bg-red-50/60 p-2 text-sm text-red-900">Esse dia já passou: não se avisa ninguém.</div>}
                {p.people.length === 0 && (
                  <p className="text-sm text-muted-foreground">Ninguém confirmado neste turno para avisar.</p>
                )}
                {p.people.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Quem recebe ({p.people.length - skipped.length} de {p.people.length})
                    </div>
                    <ul className="space-y-2">
                      {p.people.map((x) => {
                        const out = channels.every((c) => x.channels[c].action !== "send");
                        return (
                          <li key={x.employeeId} className={`rounded-md border p-2 text-sm ${out ? "bg-muted/40 text-muted-foreground" : ""}`}>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-medium">{x.name}</span>
                              {NOTICE_CHANNELS.filter((c) => channels.includes(c)).map((c) => <PlanChip key={c} channel={c} plan={x.channels[c]} />)}
                            </div>
                            <div className="mt-1 text-xs break-words">{x.text}</div>
                            {channels.includes("email") && x.channels.email.action === "send" && (
                              <div className="mt-0.5 text-[11px] text-muted-foreground break-all">Email: “{x.subject}” → {x.emailTo}</div>
                            )}
                            {NOTICE_CHANNELS.filter((c) => channels.includes(c)).map((c) => {
                              const plan = x.channels[c];
                              return plan.action === "skip"
                                ? <div key={c} className="mt-0.5 text-[11px] text-muted-foreground">{NOTICE_CHANNEL_LABELS[c]}: {plan.reason}</div>
                                : null;
                            })}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
                {p.proposals.length > 0 && (
                  <div className="rounded-md border border-violet-300 bg-violet-50/60 p-2 text-sm dark:bg-violet-950/30">
                    <div className="font-medium text-violet-900 dark:text-violet-200">Propostas por confirmar ({p.proposals.length}) — não recebem</div>
                    <div className="text-xs text-violet-900/80 dark:text-violet-200/80">
                      {p.proposals.map((x) => `${x.personName} (${x.hours})`).join(" · ")}. Confirma a escala primeiro para estas pessoas serem avisadas.
                    </div>
                  </div>
                )}
                {p.withoutRecord.length > 0 && (
                  <div className="text-xs text-muted-foreground">
                    Sem ficha no RH (não há a quem avisar): {p.withoutRecord.map((x) => x.personName).join(", ")}.
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {result && (
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Resultado por pessoa</div>
            {result.people.length === 0 && <p className="text-sm text-muted-foreground">Ninguém confirmado neste turno.</p>}
            <ul className="space-y-1">
              {result.people.map((x) => (
                <li key={x.employeeId} className="flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-sm">
                  <span className="font-medium">{x.name}</span>
                  {NOTICE_CHANNELS.map((c) => {
                    const o = x[c];
                    if (!o) return null;
                    const ok = o.status === "sent";
                    const Icon = CHANNEL_ICON[c];
                    return (
                      <span key={c} className={`inline-flex items-center gap-1 text-xs ${ok ? "text-emerald-700" : o.status === "failed" ? "text-red-700" : "text-muted-foreground"}`} title={o.detail ?? undefined}>
                        <Icon className="h-3 w-3" />
                        {ok ? <CheckCircle2 className="h-3 w-3" /> : o.status === "failed" ? <XCircle className="h-3 w-3" /> : null}
                        {ok && !o.fresh ? "já avisado" : o.label}
                        {o.detail && !ok ? ` — ${o.detail}` : ""}
                      </span>
                    );
                  })}
                </li>
              ))}
            </ul>
            {[...result.warnings, ...result.errors].map((w, i) => <div key={i} className="text-xs text-amber-800">{w}</div>)}
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={close}>Fechar</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={close} disabled={send.isPending}>Cancelar</Button>
              <Button
                disabled={!p || p.pastDay || channels.length === 0 || totalToSend === 0 || send.isPending || preview.isFetching}
                onClick={() => send.mutate({ date, city, shift, channels })}
              >
                <Send className="h-4 w-4 mr-1" />
                {send.isPending ? "A enviar…" : totalToSend === 0 ? "Nada por enviar" : `Enviar (${totalToSend} aviso${totalToSend === 1 ? "" : "s"})`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
