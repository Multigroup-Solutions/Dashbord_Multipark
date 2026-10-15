/**
 * Cartão "Modo do ponto" (plano 63, passo 1) em RH → ficha → Horário. Só com o
 * interruptor PONTO_MODOS ligado (desligado: não aparece nada).
 *  - Todos os que veem o ponto da ficha veem o modo, o histórico e o aviso.
 *  - Só o super admin muda o modo (com "a partir de" e o motivo). As guardas
 *    são as do servidor (shared/pontoMode.ts), mostradas antes de gravar.
 *  - A própria pessoa carrega em "Li"; o RH regista a leitura em papel.
 *  - Os alertas aparecem a quem os pode ver (nunca na própria ficha).
 * Neste passo nenhuma regra muda: o modo fica só marcado.
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, BadgeCheck, CalendarClock, Check, FileSignature, History, Lock, ShieldCheck } from "lucide-react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../server/routers";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import {
  PONTO_ALERT_LABEL, PONTO_ALERT_STATUS_LABEL, PONTO_MODE_HINT, PONTO_MODE_LABEL, PONTO_MODE_NUMBER,
  fmtIsoDayPt, isPontoAlertKind, isForwardOnlyMode, pontoModeChangeCheck, pontoModeLabel,
  type PontoAlertStatus, type PontoMode,
} from "@shared/pontoMode";

type Option = "none" | PontoMode;
const OPTIONS: Option[] = ["none", "fixed", "exempt", "always_on"];
const optionMode = (o: Option): PontoMode | null => (o === "none" ? null : o);
const optionTitle = (o: Option) => (o === "none" ? "Sem modo" : `${PONTO_MODE_NUMBER[o]} · ${PONTO_MODE_LABEL[o]}`);

export function PontoModeCard({ employeeId }: { employeeId: number }) {
  const q = trpc.pontoModes.get.useQuery({ employeeId }, { staleTime: 30_000, retry: false, refetchOnWindowFocus: false });
  const d = q.data;
  if (!d || !d.enabled) return null;
  return <PontoModeCardBody data={d} />;
}

type View = Extract<inferRouterOutputs<AppRouter>["pontoModes"]["get"], { enabled: true }>;

function PontoModeCardBody({ data: d }: { data: View }) {
  const utils = trpc.useUtils();
  const refresh = () => utils.pontoModes.get.invalidate({ employeeId: d.employeeId });
  const ack = trpc.pontoModes.ack.useMutation({
    onSuccess: (r) => { toast.success(r.already ? "Já estava lido." : "Obrigado: ficou registado que leste o aviso."); refresh(); },
    onError: (e) => toast.error(e.message),
  });
  const ackPaper = trpc.pontoModes.ackPaper.useMutation({
    onSuccess: (r) => { toast.success(r.already ? "Já estava lido." : "Leitura em papel registada."); refresh(); },
    onError: (e) => toast.error(e.message),
  });
  const review = trpc.pontoModes.reviewAlert.useMutation({
    onSuccess: () => { toast.success("Alerta revisto."); refresh(); },
    onError: (e) => toast.error(e.message),
  });
  const [showHistory, setShowHistory] = useState(false);
  const current = d.current;

  return (
    <section className="rounded-[14px] border bg-card p-3.5 space-y-3" data-ponto-mode-card>
      <header className="flex flex-wrap items-start gap-2">
        <CalendarClock className="h-5 w-5 shrink-0 text-[#0055D2] mt-0.5" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Modo do ponto</h3>
          <p className="text-xs text-muted-foreground">
            {current ? PONTO_MODE_HINT[current] : "Pica como até aqui (as regras de hoje)."}
          </p>
        </div>
        <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${current ? "bg-[#0055D2] text-white" : "border border-[#0055D2]/40 text-[#0055D2]"}`}>
          {pontoModeLabel(current)}
        </span>
      </header>

      <p className="rounded-[10px] bg-[#0055D2]/5 px-3 py-2 text-xs text-muted-foreground">
        Por agora o modo fica só marcado: horas, ordenado, atrasos e faltas não mudam. As regras de cada modo entram depois, cada uma com o seu interruptor.
      </p>

      {d.notice && (
        <div className="rounded-[10px] border px-3 py-2 space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <FileSignature className="h-4 w-4 shrink-0 text-[#0055D2]" aria-hidden />
            <span className="font-medium">Aviso escrito — {d.notice.title}</span>
            {d.notice.ack ? (
              <span className="inline-flex items-center gap-1 text-xs text-green-700 dark:text-green-400">
                <BadgeCheck className="h-3.5 w-3.5" aria-hidden />
                Lido em {fmtPTDateTime(d.notice.ack.at)} · {d.notice.ack.channel === "paper" ? `em papel${d.notice.ack.byName ? ` (registado por ${d.notice.ack.byName})` : ""}` : "na app"}
              </span>
            ) : (
              <span className="text-xs text-amber-700 dark:text-amber-400">Por ler</span>
            )}
          </div>
          {d.viewer.isOwn && !d.notice.ack ? (
            <>
              <p className="text-sm leading-relaxed">{d.notice.text}</p>
              <Button size="sm" variant="selected" className="rounded-[10px] w-full sm:w-auto" disabled={ack.isPending}
                onClick={() => ack.mutate({ employeeId: d.employeeId, notice: d.notice!.key })}>
                <Check className="h-4 w-4 mr-1" aria-hidden />Li
              </Button>
            </>
          ) : (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">Ver o texto</summary>
              <p className="mt-1 text-sm leading-relaxed text-foreground">{d.notice.text}</p>
            </details>
          )}
          {d.viewer.canRecordPaper && !d.notice.ack && (
            <Button size="sm" variant="outline" className="rounded-[10px] w-full sm:w-auto" disabled={ackPaper.isPending}
              onClick={() => {
                if (!window.confirm("Confirmas que a pessoa leu e assinou este aviso em papel? Fica registado em teu nome.")) return;
                ackPaper.mutate({ employeeId: d.employeeId, notice: d.notice!.key, note: "Papel assinado" });
              }}>
              <FileSignature className="h-4 w-4 mr-1" aria-hidden />Registar leitura em papel
            </Button>
          )}
        </div>
      )}

      {d.alerts.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden />Alertas do ponto
          </div>
          {d.alerts.map((a) => (
            <div key={a.id} className={`rounded-[10px] border px-3 py-2 text-sm ${a.severity === "red" ? "border-red-300 bg-red-50 dark:bg-red-950/30" : "border-amber-300 bg-amber-50 dark:bg-amber-950/30"}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{isPontoAlertKind(a.kind) ? PONTO_ALERT_LABEL[a.kind] : a.kind}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{fmtIsoDayPt(a.day)}</span>
                <span className="text-xs">{PONTO_ALERT_STATUS_LABEL[a.status as PontoAlertStatus] ?? a.status}</span>
              </div>
              {a.detail && <p className="text-xs text-muted-foreground mt-0.5">{a.detail}</p>}
              {a.reviewedByName && <p className="text-xs text-muted-foreground mt-0.5">Revisto por {a.reviewedByName}{a.reviewedAt ? ` a ${fmtPTDateTime(a.reviewedAt)}` : ""}{a.reviewNote ? ` · ${a.reviewNote}` : ""}</p>}
              {a.status === "open" && (
                <div className="mt-1.5 grid grid-cols-3 gap-1.5 sm:flex sm:flex-wrap">
                  {(["seen", "justified", "confirmed"] as const).map((st) => (
                    <Button key={st} size="sm" variant="outline" className="rounded-[10px]" disabled={review.isPending}
                      onClick={() => review.mutate({ alertId: a.id, status: st })}>
                      {PONTO_ALERT_STATUS_LABEL[st]}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {d.viewer.canEdit && d.guard && <PontoModeEditor data={d} onSaved={refresh} />}

      {d.history.length > 0 && (
        <div>
          <Button size="sm" variant="ghost" className="h-8 px-2 text-xs" onClick={() => setShowHistory((v) => !v)}>
            <History className="h-4 w-4 mr-1" aria-hidden />{showHistory ? "Esconder o histórico" : `Histórico (${d.history.length})`}
          </Button>
          {showHistory && (
            <ul className="mt-1 space-y-1">
              {d.history.map((h) => (
                <li key={h.id} className={`rounded-[10px] border px-3 py-1.5 text-xs ${h.superseded ? "opacity-60" : ""}`}>
                  <div className="flex flex-wrap items-center gap-x-2">
                    <span className="font-medium">{pontoModeLabel(h.mode)}</span>
                    <span className="tabular-nums">a partir de {fmtIsoDayPt(h.effectiveFrom)}</span>
                    {h.superseded && <span className="text-muted-foreground">(substituída)</span>}
                  </div>
                  <div className="text-muted-foreground">
                    {h.setByName ?? "—"}{h.setAt ? ` · ${fmtPTDateTime(h.setAt)}` : ""}{h.note ? ` · ${h.note}` : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function PontoModeEditor({ data: d, onSaved }: { data: View; onSaved: () => void }) {
  const g = d.guard!;
  const [option, setOption] = useState<Option>(d.current ?? "none");
  const [from, setFrom] = useState(d.today);
  const [note, setNote] = useState("");
  const mode = optionMode(option);
  const earliest = g.earliestFrom[option];
  const fixedToToday = isForwardOnlyMode(mode) || isForwardOnlyMode(d.current);
  // a data fica sempre entre o mais antigo permitido e hoje
  useEffect(() => {
    if (fixedToToday) setFrom(d.today);
    else if (from < earliest) setFrom(earliest);
    else if (from > d.today) setFrom(d.today);
  }, [option, earliest, fixedToToday, d.today]);

  const check = useMemo(() => pontoModeChangeCheck({
    actorRole: "super_admin",
    employee: g.employee,
    history: g.history,
    mode, effectiveFrom: from, today: d.today,
    closedMonths: new Set(g.closedMonths), hasOpenCheckIn: g.hasOpenCheckIn,
    note: note.trim().length >= 3 ? note : "xxx", // o motivo vê-se no botão
  }), [g, mode, from, d.today, note]);
  const noteOk = note.trim().length >= 3;
  const set = trpc.pontoModes.set.useMutation({
    onSuccess: (r) => {
      toast.success(`Modo do ponto: ${pontoModeLabel(r.mode)} a partir de ${fmtIsoDayPt(r.effectiveFrom)}.`);
      for (const w of r.warnings) toast.warning(w, { duration: 10000 });
      setNote("");
      onSaved();
    },
    onError: (e) => toast.error(e.message),
  });
  const canSave = !g.closedMonthsReadFailed && !check.error && noteOk && !set.isPending;
  // por abrir (o modo de hoje, a partir de hoje): sem mensagem a vermelho
  const untouched = option === (d.current ?? "none") && from === d.today;

  return (
    <div className="rounded-[10px] border border-[#0055D2]/30 p-3 space-y-2.5">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <ShieldCheck className="h-4 w-4 text-[#0055D2]" aria-hidden />Mudar o modo <span className="text-xs font-normal text-muted-foreground">(só o super admin)</span>
      </div>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4" role="radiogroup" aria-label="Modo do ponto">
        {OPTIONS.map((o) => (
          <Button key={o} size="sm" role="radio" aria-checked={option === o} variant={option === o ? "selected" : "outline"}
            className="rounded-[10px] h-auto min-h-8 whitespace-normal py-1.5 text-xs" onClick={() => setOption(o)}>
            {optionTitle(o)}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{mode ? PONTO_MODE_HINT[mode] : "As regras de hoje, sem modo."}</p>
      <div className="grid gap-2 sm:grid-cols-[auto_1fr] sm:items-start">
        <label className="text-xs font-medium sm:pt-2" htmlFor={`ponto-mode-from-${d.employeeId}`}>A partir de</label>
        <div className="space-y-1">
          <Input id={`ponto-mode-from-${d.employeeId}`} type="date" className="h-9 w-full sm:w-44 rounded-[10px]" value={from}
            min={earliest} max={d.today} disabled={fixedToToday} onChange={(e) => setFrom(e.target.value)} />
          {fixedToToday && (
            <p className="flex items-center gap-1 text-xs text-muted-foreground"><Lock className="h-3 w-3" aria-hidden />A isenção e o "Sempre em serviço" (pôr ou tirar) só valem a partir de hoje.</p>
          )}
        </div>
        <label className="text-xs font-medium sm:pt-2" htmlFor={`ponto-mode-note-${d.employeeId}`}>Motivo</label>
        <Textarea id={`ponto-mode-note-${d.employeeId}`} rows={2} maxLength={255} className="rounded-[10px] text-sm" value={note}
          placeholder="Ex.: passa a back office; reformado; isenção acordada" onChange={(e) => setNote(e.target.value)} />
      </div>
      {g.closedMonthsReadFailed && <p className="text-xs text-red-600">Não deu para ler os meses fechados do ordenado: tenta outra vez daqui a pouco.</p>}
      {check.error && !untouched && <p className="text-xs text-red-600">{check.error}</p>}
      {!check.error && check.warnings.map((w) => <p key={w} className="text-xs text-amber-700 dark:text-amber-400">{w}</p>)}
      <Button size="sm" variant="selected" className="rounded-[10px] w-full sm:w-auto" disabled={!canSave}
        onClick={() => set.mutate({ employeeId: d.employeeId, mode, effectiveFrom: from, note: note.trim() })}>
        {set.isPending ? "A gravar…" : noteOk ? "Gravar o modo" : "Escreve o motivo para gravar"}
      </Button>
    </div>
  );
}
