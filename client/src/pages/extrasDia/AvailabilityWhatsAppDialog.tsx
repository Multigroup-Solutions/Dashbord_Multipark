import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangle, CheckCircle2, Clock, MessageCircle, Send, Users, XCircle } from "lucide-react";
import { DEFAULT_WHATSAPP_TEMPLATE_ID, WHATSAPP_TEMPLATES, findWhatsAppTemplate, firstNameOf } from "@shared/whatsappTemplate";
import { broadcastConfirmText, needsBroadcastConfirm } from "@shared/whatsappBroadcastRules";
import { driverCityFrom, driverCityLabel, type City } from "@shared/driverTemplates";
import { sendAllLabel, type AvailabilitySendScope } from "@shared/availabilityFilters";
import { DriverCityPanel, planEntries, useDriverCity, type DriverCityRecipient } from "@/components/whatsapp/DriverCityPanel";
import type { AvailabilityDayHeader, OverviewExtra } from "./availabilityTypes";

type WaRecipient = {
  employeeId: number | null;
  name: string | null;
  phone: string;
  phoneE164: string | null;
  status: "sent" | "failed" | "invalid_phone" | "opted_out" | "duplicate_phone" | "recent_template";
  error?: string;
  city?: City;
};

const newSendKey = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

/**
 * Envio por WhatsApp da Disponibilidade (template + teste + resultado).
 * Os destinatários vêm de fora, já decididos (`availabilitySendTarget`):
 * selecionados, ou os filtrados — e o topo do diálogo diz qual dos dois.
 */
export function AvailabilityWhatsAppDialog({
  open,
  onOpenChange,
  targets,
  targetPhrase,
  breakdown,
  closedNote,
  forceConfirm,
  scope,
  statesCount,
  weekShortLabel,
  dayHeaders,
  weekStart,
  note,
  prefill,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targets: Pick<OverviewExtra, "employeeId" | "fullName" | "city" | "phoneE164">[];
  /** "aos 12 extras selecionados" / "aos 317 extras filtrados". */
  targetPhrase: string;
  /** "40 disponíveis · 237 sem resposta · 43 indisponíveis". */
  breakdown: string;
  /** "inclui 237 em secções fechadas" (null = nada escondido). */
  closedNote: string | null;
  /** Envio a todos os estados sem seleção: pede SEMPRE "Enviar a todos os N". */
  forceConfirm: boolean;
  scope: AvailabilitySendScope;
  /** Quantos estados diferentes há no alvo (para "… (2 estados)"). */
  statesCount: number;
  weekShortLabel: string;
  dayHeaders: AvailabilityDayHeader[];
  weekStart: string;
  note: string;
  /** Texto vindo do email ("Usar este texto no WhatsApp"); `seq` muda a cada uso. */
  prefill: { text: string; seq: number } | null;
  onSent: () => void;
}) {
  // Template escolhido. Nome e língua são os aprovados na Meta — vêm do
  // catálogo (shared/whatsappTemplate.ts), nunca escritos à mão aqui.
  const [waTemplateId, setWaTemplateId] = useState<string>(DEFAULT_WHATSAPP_TEMPLATE_ID);
  const waTemplate = findWhatsAppTemplate(waTemplateId) ?? WHATSAPP_TEMPLATES[0];
  // Valor partilhado (semana ou dia, conforme o template) — guardado POR
  // template para não se perder ao espreitar o outro e voltar.
  const [waParams, setWaParams] = useState<Record<string, string>>({});
  // O campo "Semana" nasce com a semana escolhida e acompanha-a enquanto o
  // utilizador não escrever nada. `undefined` = nunca tocado → segue a semana.
  const waWeekDefault = waTemplate.sharedParam?.kind === "week" && weekShortLabel ? `semana de ${weekShortLabel}` : "";
  const waParam2IsDefault = waParams[waTemplate.id] === undefined && !!waWeekDefault;
  const waParam2 = waParams[waTemplate.id] ?? waWeekDefault;
  const setWaParam2 = (value: string) => setWaParams((prev) => ({ ...prev, [waTemplate.id]: value }));

  // "Usar este texto no WhatsApp" (diálogo do email): o texto é um PEDIDO DE
  // DISPONIBILIDADE, por isso escolhe esse template e escreve no campo DELE.
  useEffect(() => {
    if (!prefill) return;
    setWaTemplateId(DEFAULT_WHATSAPP_TEMPLATE_ID);
    setWaParams((prev) => ({ ...prev, [DEFAULT_WHATSAPP_TEMPLATE_ID]: prefill.text }));
  }, [prefill]);

  const [waTestPhone, setWaTestPhone] = useState("");
  const [waResult, setWaResult] = useState<
    null | { total: number; sent: number; failed: number; invalidPhone: number; optedOut: number; recentTemplate?: number; recipients: WaRecipient[] }
  >(null);
  // D32: enviar a várias pessoas passa por um passo "Confirmar".
  const [waConfirm, setWaConfirm] = useState(false);
  // Código único de cada envio (17b): carregar outra vez depois de um corte
  // (60 s da Vercel) retoma a mesma difusão — quem já recebeu não recebe 2×.
  const [waSendKey, setWaSendKey] = useState(newSendKey);
  // Depois do envio real o botão fica "Enviado": um 2.º clique não manda outra vez a todos.
  const [waSentReal, setWaSentReal] = useState(false);
  // Cada abertura do diálogo é um envio novo.
  useEffect(() => {
    if (!open) return;
    setWaResult(null);
    setWaSentReal(false);
    setWaConfirm(false);
    setWaSendKey(newSendKey());
  }, [open]);

  const broadcast = trpc.whatsapp.sendBroadcast.useMutation({
    onSuccess: (r, v) => {
      setWaResult(r);
      if (!v.testPhone) setWaSentReal(true);
      toast.success(
        `WhatsApp: ${r.sent} enviados${r.failed ? `, ${r.failed} falhas` : ""}${r.invalidPhone ? `, ${r.invalidPhone} sem número` : ""}${r.optedOut ? `, ${r.optedOut} não querem mensagens` : ""}${r.recentTemplate ? `, ${r.recentTemplate} já o tinham recebido nas últimas 24 h` : ""}`,
      );
      onSent();
    },
    onError: (e) => toast.error(e.message),
  });

  // `phoneE164` vem calculado do servidor — a MESMA normalização que o envio
  // usa, para o resumo "válidos/sem número" nunca divergir do resultado real.
  const waValidCount = targets.filter((e) => !!e.phoneE164).length;
  const waInvalidCount = targets.length - waValidCount;
  // Mudou o template, o campo ou o alvo → volta a pedir confirmação.
  useEffect(() => { setWaConfirm(false); }, [waTemplateId, waParam2, waValidCount]);

  // Cidade do template de cada destinatário (registo shared/driverTemplates.ts):
  // a do extra; sem ela, a do utilizador; senão fica por escolher.
  const waCityKey = targets.map((e) => `${e.employeeId}:${e.city ?? ""}`).join(",");
  const waCityRecipients = useMemo<DriverCityRecipient[]>(
    () => targets.map((e) => ({ id: e.employeeId, city: driverCityFrom(e.city), name: firstNameOf(e.fullName) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [waCityKey],
  );
  const waCity = useDriverCity({ templateId: waTemplate.id, open, recipients: waCityRecipients });

  // Só falta o campo quando o template TEM campo — os sem parâmetros (ex.:
  // "Morada e regras") nunca preenchem `waParam2` e têm de poder ser enviados.
  const waMissingParam = !!waTemplate.sharedParam && !waParam2.trim();

  function submitBroadcast(testPhone?: string) {
    const bodyParam2 = waTemplate.sharedParam ? waParam2.trim() : "";
    if (waTemplate.sharedParam && !bodyParam2) {
      toast.error(`Preenche o campo “${waTemplate.sharedParam.label}”.`);
      return;
    }
    if (testPhone && !waCity.testCity) {
      toast.error("Escolhe a cidade do template a testar.");
      return;
    }
    if (!testPhone && waCity.blockReason) {
      toast.error(waCity.blockReason);
      return;
    }
    setWaResult(null);
    // Invariante (Decisão 1 do Jorge): o que envio é o que vejo. O alvo são os
    // `targets` (selecionados ou filtrados), já agrupados por cidade no painel.
    // O envio de teste ignora o alvo.
    broadcast.mutate({
      templateId: waTemplate.id,
      bodyParam2: bodyParam2 || null,
      // O botão com link do formulário é detetado pelos metadados do template
      // na Meta (server/whatsappTemplateMeta.ts), sem override manual na UI.
      cities: testPhone ? undefined : planEntries(waCity.plan).map((e) => ({ employeeId: e.id, city: e.city })),
      testCity: testPhone ? waCity.testCity : undefined,
      weekStart: weekStart || null,
      note: note.trim() || null,
      testPhone: testPhone ? testPhone.trim() : undefined,
      sendKey: testPhone ? undefined : waSendKey,
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!broadcast.isPending) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5 text-green-600" />
            Pedido por WhatsApp
          </DialogTitle>
          <DialogDescription>Escolhe a mensagem, testa num número teu e envia.</DialogDescription>
        </DialogHeader>

        {/* Para quem vai — sempre à vista, antes de tudo. */}
        <div className="rounded-[10px] border bg-muted/40 p-3 text-sm">
          <div className="flex items-center gap-2 font-medium">
            <Users className="h-4 w-4 text-primary shrink-0" />
            <span>Vai {targetPhrase}</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {waValidCount} com número válido
            {waInvalidCount > 0 ? ` · ${waInvalidCount} sem número válido (ficam de fora)` : ""}
          </p>
          {breakdown && <p className="mt-1 text-xs text-muted-foreground">{breakdown}</p>}
          {closedNote && <p className="mt-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">Atenção: {closedNote} da grelha.</p>}
        </div>

        <div className="space-y-4">
          <div className="space-y-1">
            <Label className="text-xs">Mensagem</Label>
            <Select value={waTemplate.id} onValueChange={(id) => { setWaTemplateId(id); setWaResult(null); }}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WHATSAPP_TEMPLATES.map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{waTemplate.description}</p>
          </div>

          {/* Templates sem parâmetros não têm campo — o texto é fixo na Meta. */}
          {waTemplate.sharedParam && (
            <div className="space-y-1">
              <Label className="text-xs">{waTemplate.sharedParam.label}</Label>
              <Input
                autoFocus
                placeholder={waTemplate.sharedParam.placeholder}
                value={waParam2}
                onChange={(e) => setWaParam2(e.target.value)}
              />
              {waParam2IsDefault && (
                <p className="text-[11px] text-muted-foreground">Preenchido com a semana escolhida — podes editar.</p>
              )}
              {/* Preenchimento rápido pelos dias da semana visível na grelha. */}
              {waTemplate.sharedParam.kind === "day" && dayHeaders.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1">
                  {dayHeaders.map((h) => (
                    <Button
                      key={h.day}
                      type="button"
                      size="sm"
                      variant={waParam2 === h.label ? "selected" : "outline"}
                      className="h-7 text-xs"
                      onClick={() => setWaParam2(h.label)}
                    >
                      {h.label}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Cidade do template (por defeito a de cada extra), contagens por
              cidade e o texto REAL aprovado na Meta de cada cidade. */}
          <DriverCityPanel state={waCity} sharedValue={waParam2} noun="motorista(s)" />

          <div className="space-y-1 rounded-[10px] border border-dashed p-3">
            <Label className="text-xs font-medium">Testar primeiro (envia só para 1 número)</Label>
            <div className="flex gap-2">
              <Input placeholder="+351912345678" value={waTestPhone} onChange={(e) => setWaTestPhone(e.target.value)} />
              <Button
                variant="outline"
                className="shrink-0"
                disabled={waMissingParam || !waTestPhone.trim() || !waCity.testCity || broadcast.isPending}
                onClick={() => submitBroadcast(waTestPhone)}
              >
                {broadcast.isPending ? <Clock className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Enviar teste{waCity.testCity ? ` (${driverCityLabel(waCity.testCity)})` : ""}
              </Button>
            </div>
          </div>

          {/* Resultado por destinatário (só depois de enviar) */}
          {waResult && (
            <div className="rounded-[10px] border p-3 space-y-2">
              <div className="text-sm font-medium">
                {waResult.sent} enviados · {waResult.failed} falhas · {waResult.invalidPhone} sem número
                {waResult.optedOut ? ` · ${waResult.optedOut} não querem mensagens` : ""}
                {waResult.recentTemplate ? ` · ${waResult.recentTemplate} já o tinham recebido nas últimas 24 h` : ""}
              </div>
              <div className="max-h-48 overflow-y-auto text-xs divide-y">
                {waResult.recipients.map((r, i) => (
                  <div key={i} className="flex items-center gap-2 py-1">
                    {r.status === "sent" && <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />}
                    {r.status === "failed" && <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />}
                    {(r.status === "invalid_phone" || r.status === "opted_out" || r.status === "duplicate_phone" || r.status === "recent_template") && (
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                    )}
                    <span className="flex-1 truncate">
                      {r.name || r.phone}
                      {r.phoneE164 ? <span className="text-muted-foreground"> · {r.phoneE164}</span> : null}
                      {r.city ? <span className="text-muted-foreground"> · {driverCityLabel(r.city)}</span> : null}
                    </span>
                    {r.error && <span className="text-red-500 truncate max-w-[45%]">{r.error}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {waConfirm && !waSentReal && (
          <div role="alert" className="rounded-[10px] border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
            {broadcastConfirmText(waTemplate.label, waValidCount)}
            {breakdown && <span className="block mt-1">{breakdown}</span>}
            {closedNote && <span className="block mt-0.5 font-medium">Atenção: {closedNote} da grelha.</span>}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => (waConfirm ? setWaConfirm(false) : onOpenChange(false))} disabled={broadcast.isPending}>
            {waConfirm && !waSentReal ? "Voltar" : "Fechar"}
          </Button>
          <Button
            className="bg-green-700 hover:bg-green-800 text-white"
            disabled={waMissingParam || broadcast.isPending || waValidCount === 0 || waSentReal || !!waCity.blockReason}
            onClick={() => {
              // D32: a várias pessoas, primeiro "Confirmar".
              if (!waConfirm && (forceConfirm || needsBroadcastConfirm(waValidCount))) { setWaConfirm(true); return; }
              setWaConfirm(false);
              submitBroadcast();
            }}
            title={waSentReal ? "Já enviado — fecha e abre o diálogo para um envio novo" : undefined}
          >
            {broadcast.isPending ? <Clock className="h-4 w-4 animate-spin" /> : <MessageCircle className="h-4 w-4" />}
            {waSentReal ? "Enviado" : waConfirm ? (forceConfirm ? sendAllLabel(scope, waValidCount, statesCount) : `Confirmar envio a ${waValidCount}`) : `Enviar a ${waValidCount} extra(s)`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
