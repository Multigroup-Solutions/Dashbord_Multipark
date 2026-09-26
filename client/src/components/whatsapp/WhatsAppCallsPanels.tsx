/**
 * Chamadas de voz do WhatsApp no inbox:
 *  - `CallTimelineEntry`: entrada da chamada na conversa;
 *  - `CallContactDialog`: "Ligar" (autorização do cliente → ligar);
 *  - `PendingCallbacksDialog`: "Chamadas perdidas por devolver";
 *  - `CallSettingsDialog`: ativar chamadas / horário na Meta (super admin).
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Clock, Hourglass, Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing, Settings2, ShieldCheck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { callTimelineLabel, dbUtcMs } from "@shared/whatsappCalls";
import { startOutbound, useActiveCall, webrtcSupported, type CallClient } from "@/lib/whatsappCall";

function fmtLocal(s: string | null, withDate = false): string {
  const ms = dbUtcMs(s);
  if (ms == null) return "";
  const d = new Date(ms);
  const time = d.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
  return withDate ? `${d.toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit" })} ${time}` : time;
}

// ─── Entrada na conversa ────────────────────────────────────────────────────

export interface TimelineCall {
  id: number;
  direction: "in" | "out";
  status: string;
  startedAt: string;
  durationSec: number | null;
  missed: boolean;
  answeredByName: string | null;
  startedByName: string | null;
  callbackDone: boolean;
}

export function CallTimelineEntry({ c }: { c: TimelineCall }) {
  const missed = c.direction === "in" && (c.status === "missed" || c.missed || c.status === "rejected");
  const Icon = c.direction === "out" ? PhoneOutgoing : missed ? PhoneMissed : PhoneIncoming;
  return (
    <div className="flex justify-center">
      <div
        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${
          missed ? "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300" : "bg-background text-muted-foreground"
        }`}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span>{callTimelineLabel(c, fmtLocal(c.startedAt))}</span>
        {missed && c.callbackDone && <span className="opacity-70">· devolvida</span>}
      </div>
    </div>
  );
}

// ─── Ligar ──────────────────────────────────────────────────────────────────

export function CallContactDialog({
  open, onOpenChange, conversationId, name, subtitle,
}: { open: boolean; onOpenChange: (v: boolean) => void; conversationId: number; name: string; subtitle: string | null }) {
  const utils = trpc.useUtils();
  const client = utils.client as unknown as CallClient;
  const active = useActiveCall();
  const [text, setText] = useState("Podemos ligar-lhe pelo WhatsApp para ajudar com o seu pedido?");
  const [starting, setStarting] = useState(false);
  const perm = trpc.whatsapp.calls.permission.useQuery(
    { conversationId },
    { enabled: open, retry: false, refetchInterval: (q) => (open && (q.state.data as any)?.status === "requested" ? 5_000 : false) },
  );
  const request = trpc.whatsapp.calls.requestPermission.useMutation({
    onSuccess: () => {
      toast.success("Pedido de autorização enviado. Assim que o cliente aceitar, podes ligar.");
      void perm.refetch();
      void utils.whatsapp.messages.byConversation.invalidate({ conversationId });
    },
    onError: (e) => toast.error(e.message),
  });
  useEffect(() => {
    if (open) void perm.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const p = perm.data;
  const inCall = !!active && active.phase !== "ended";

  async function call() {
    setStarting(true);
    const r = await startOutbound(client, { conversationId, name, subtitle });
    setStarting(false);
    if (r.error) {
      toast.error(r.error);
      void perm.refetch();
      return;
    }
    if (r.warning) toast.warning(r.warning);
    onOpenChange(false);
    void utils.whatsapp.calls.byConversation.invalidate({ conversationId });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !starting && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Phone className="h-5 w-5 text-green-600" /> Ligar a {name}</DialogTitle>
          <DialogDescription>Chamada de voz pelo WhatsApp da empresa, no browser (usa o microfone deste computador).</DialogDescription>
        </DialogHeader>
        {!webrtcSupported() ? (
          <p className="text-sm text-red-700">Este browser não suporta chamadas (WebRTC). Usa o Chrome, Edge, Firefox ou Safari atualizados.</p>
        ) : perm.isLoading ? (
          <p className="text-sm text-muted-foreground">A verificar a autorização do cliente…</p>
        ) : perm.error ? (
          <p className="text-sm text-red-700">{perm.error.message}</p>
        ) : p ? (
          <div className="space-y-3 text-sm">
            {p.valid ? (
              <div className="flex items-start gap-2 rounded-md border border-green-300 bg-green-50 dark:bg-green-950/30 dark:border-green-900 p-2.5 text-green-900 dark:text-green-200">
                <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0" />
                <span>
                  O cliente autorizou chamadas{p.status === "permanent" ? " (sem prazo)" : p.expiresAt ? ` até ${fmtLocal(p.expiresAt, true)}` : ""}.
                  {p.connectedLast24h > 0 && ` ${p.connectedLast24h} chamada(s) nas últimas 24 h (máx. 100).`}
                </span>
              </div>
            ) : p.status === "requested" ? (
              <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900 p-2.5 text-amber-900 dark:text-amber-200">
                <Hourglass className="h-4 w-4 mt-0.5 shrink-0" />
                <span><strong>À espera de autorização.</strong> O cliente recebeu o pedido no WhatsApp; esta janela atualiza sozinha quando ele responder.</span>
              </div>
            ) : (
              <p className="text-muted-foreground">
                {p.status === "rejected" ? "O cliente recusou o último pedido de autorização." : "Para a empresa poder ligar, o cliente tem de autorizar chamadas (pedido no WhatsApp, válido 7 dias)."}
              </p>
            )}
            {p.warning && <p className="text-xs text-amber-700 dark:text-amber-300">{p.warning}</p>}
            {!p.valid && p.canRequest && (
              <div className="space-y-1">
                {p.windowOpen ? (
                  <>
                    <Label className="text-xs">Mensagem do pedido</Label>
                    <Textarea rows={2} value={text} maxLength={1024} onChange={(e) => setText(e.target.value)} />
                  </>
                ) : p.templateConfigured ? (
                  <p className="text-xs text-muted-foreground">Janela de 24 h fechada — o pedido vai no template aprovado.</p>
                ) : (
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    Janela de 24 h fechada e sem template de autorização configurado: só é possível pedir depois de o cliente escrever (ou com WHATSAPP_CALL_PERMISSION_TEMPLATE).
                  </p>
                )}
              </div>
            )}
            {!p.valid && !p.canRequest && p.requestBlockedReason && <p className="text-xs text-muted-foreground">{p.requestBlockedReason}</p>}
            {p.optedOut && <p className="text-xs text-red-700">Este contacto pediu para não receber mensagens (STOP).</p>}
          </div>
        ) : null}
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={starting}>Fechar</Button>
          {p && !p.valid && p.canRequest && (p.windowOpen || p.templateConfigured) && (
            <Button variant="outline" disabled={request.isPending || p.optedOut} onClick={() => request.mutate({ conversationId, text: p.windowOpen ? text : undefined })}>
              {request.isPending ? <Clock className="h-4 w-4 mr-1.5 animate-spin" /> : <ShieldCheck className="h-4 w-4 mr-1.5" />}
              {p.status === "requested" ? "Pedir outra vez" : "Pedir autorização para ligar"}
            </Button>
          )}
          {p?.valid && (
            <Button className="bg-green-600 hover:bg-green-700 text-white" disabled={starting || inCall || !webrtcSupported()} onClick={call}>
              {starting ? <Clock className="h-4 w-4 mr-1.5 animate-spin" /> : <Phone className="h-4 w-4 mr-1.5" />}
              {inCall ? "Já estás numa chamada" : "Ligar agora"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Por devolver ───────────────────────────────────────────────────────────

export function PendingCallbacksDialog({
  open, onOpenChange, onOpenConversation, canEdit, isSuperAdmin,
}: { open: boolean; onOpenChange: (v: boolean) => void; onOpenConversation: (id: number) => void; canEdit: boolean; isSuperAdmin: boolean }) {
  const list = trpc.whatsapp.calls.pendingCallbacks.useQuery(undefined, { enabled: open, refetchInterval: open ? 20_000 : false });
  const utils = trpc.useUtils();
  const done = trpc.whatsapp.calls.markCallbackDone.useMutation({
    onSuccess: () => {
      void list.refetch();
      void utils.whatsapp.calls.pendingCallbacks.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><PhoneMissed className="h-5 w-5 text-red-600" /> Chamadas perdidas por devolver</DialogTitle>
            <DialogDescription>Chamadas de clientes dos últimos 7 dias que ninguém atendeu (ou foram recusadas). Saem da lista quando alguém devolve a chamada com sucesso ou as marca como devolvidas.</DialogDescription>
          </DialogHeader>
          <div className="max-h-[50vh] overflow-y-auto divide-y border rounded-md">
            {list.isLoading && <div className="p-3 text-sm text-muted-foreground">A carregar…</div>}
            {!list.isLoading && !(list.data ?? []).length && <div className="p-3 text-sm text-muted-foreground">Nada por devolver. 🎉</div>}
            {(list.data ?? []).map((c) => (
              <div key={c.id} className="p-2.5 flex items-center gap-2 text-sm">
                <PhoneMissed className="h-4 w-4 text-red-600 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{c.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {fmtLocal(c.startedAt, true)}{c.attempts > 1 ? ` · ${c.attempts} tentativas` : ""}{c.status === "rejected" ? " · recusada" : ""}
                  </div>
                </div>
                {c.conversationId != null && (
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { onOpenConversation(c.conversationId!); onOpenChange(false); }}>
                    Abrir
                  </Button>
                )}
                {canEdit && (
                  <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={done.isPending} onClick={() => done.mutate({ id: c.id })}>
                    Devolvida
                  </Button>
                )}
              </div>
            ))}
          </div>
          {isSuperAdmin && (
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
                <Settings2 className="h-4 w-4 mr-1.5" /> Configuração das chamadas (Meta)
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
      {isSuperAdmin && <CallSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />}
    </>
  );
}

// ─── Configuração (super admin) ─────────────────────────────────────────────

const DAYS: Array<{ id: "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY"; label: string }> = [
  { id: "MONDAY", label: "Segunda" }, { id: "TUESDAY", label: "Terça" }, { id: "WEDNESDAY", label: "Quarta" },
  { id: "THURSDAY", label: "Quinta" }, { id: "FRIDAY", label: "Sexta" }, { id: "SATURDAY", label: "Sábado" }, { id: "SUNDAY", label: "Domingo" },
];

type DayRow = { on: boolean; open: string; close: string };
const toHHMM = (v: string) => v.replace(":", "");
const fromHHMM = (v: string) => (/^\d{4}$/.test(v) ? `${v.slice(0, 2)}:${v.slice(2)}` : v);

export function CallSettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const q = trpc.whatsapp.calls.settings.useQuery(undefined, { enabled: open, retry: false });
  const save = trpc.whatsapp.calls.configure.useMutation({
    onSuccess: () => { toast.success("Configuração das chamadas guardada na Meta."); void q.refetch(); },
    onError: (e) => toast.error(e.message),
  });
  const [enabled, setEnabled] = useState(false);
  const [callback, setCallback] = useState(true);
  const [hoursOn, setHoursOn] = useState(false);
  const [days, setDays] = useState<Record<string, DayRow>>(() =>
    Object.fromEntries(DAYS.map((d) => [d.id, { on: d.id !== "SUNDAY", open: "08:00", close: "20:00" }])),
  );
  useEffect(() => {
    const c: any = q.data && q.data.ok ? q.data.calling : null;
    if (!c) return;
    setEnabled(String(c.status ?? "").toUpperCase() === "ENABLED");
    setCallback(String(c.callback_permission_status ?? "ENABLED").toUpperCase() === "ENABLED");
    const h = c.call_hours;
    setHoursOn(String(h?.status ?? "").toUpperCase() === "ENABLED");
    if (Array.isArray(h?.weekly_operating_hours) && h.weekly_operating_hours.length) {
      const next: Record<string, DayRow> = Object.fromEntries(DAYS.map((d) => [d.id, { on: false, open: "08:00", close: "20:00" }]));
      for (const w of h.weekly_operating_hours) next[w.day_of_week] = { on: true, open: fromHHMM(String(w.open_time)), close: fromHHMM(String(w.close_time)) };
      setDays(next);
    }
  }, [q.data]);

  function submit() {
    save.mutate({
      enabled,
      callbackPermission: callback,
      callHours: {
        enabled: hoursOn,
        timezoneId: "Europe/Lisbon",
        weekly: DAYS.filter((d) => days[d.id].on).map((d) => ({ day: d.id, open: toHHMM(days[d.id].open), close: toHHMM(days[d.id].close) })),
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Settings2 className="h-5 w-5" /> Chamadas do WhatsApp — configuração</DialogTitle>
          <DialogDescription>Definições do número na Meta (POST /settings). Mudanças aplicam-se aos clientes em poucos minutos.</DialogDescription>
        </DialogHeader>
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">A ler da Meta…</p>
        ) : q.data && !q.data.ok ? (
          <p className="text-sm text-red-700">{q.data.error}</p>
        ) : (
          <div className="space-y-3 text-sm">
            {q.data?.ok && q.data.summary.restrictions.length > 0 && (
              <p className="text-xs text-red-700">Restrições da Meta: {q.data.summary.restrictions.join("; ")}</p>
            )}
            <label className="flex items-center justify-between gap-2">
              <span>Chamadas ativas no número</span>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </label>
            <label className="flex items-center justify-between gap-2">
              <span>Pedir autorização ao cliente quando ele liga (para podermos devolver)</span>
              <Switch checked={callback} onCheckedChange={setCallback} />
            </label>
            <label className="flex items-center justify-between gap-2">
              <span>Horário de chamadas (fora do horário o botão de chamar fica indisponível)</span>
              <Switch checked={hoursOn} onCheckedChange={setHoursOn} />
            </label>
            {hoursOn && (
              <div className="space-y-1.5 border rounded-md p-2">
                <p className="text-[11px] text-muted-foreground">Fuso: Europe/Lisbon</p>
                {DAYS.map((d) => (
                  <div key={d.id} className="flex items-center gap-2">
                    <Switch checked={days[d.id].on} onCheckedChange={(v) => setDays((s) => ({ ...s, [d.id]: { ...s[d.id], on: v } }))} aria-label={d.label} />
                    <span className="w-20">{d.label}</span>
                    <Input type="time" className="h-8 w-28" disabled={!days[d.id].on} value={days[d.id].open} onChange={(e) => setDays((s) => ({ ...s, [d.id]: { ...s[d.id], open: e.target.value } }))} />
                    <span>–</span>
                    <Input type="time" className="h-8 w-28" disabled={!days[d.id].on} value={days[d.id].close} onChange={(e) => setDays((s) => ({ ...s, [d.id]: { ...s[d.id], close: e.target.value } }))} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Fechar</Button>
          <Button disabled={save.isPending || !q.data?.ok} onClick={submit}>
            {save.isPending ? <Clock className="h-4 w-4 mr-1.5 animate-spin" /> : null} Guardar na Meta
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


