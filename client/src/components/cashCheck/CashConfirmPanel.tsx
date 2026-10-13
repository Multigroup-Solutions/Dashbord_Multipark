/**
 * Caixa → Confirmação (Jorge, 13 out 2026): a caixa de cada cidade e dia,
 * reserva a reserva. O team leader declara na Passagem de turno o que recebeu;
 * o João confirma no dia seguinte, anexa os talões MB, justifica os vermelhos
 * (motivo + explicação + comprovativo) e fecha o dia. Diferença > 30 € ou
 * justificações por aprovar → "à espera do Jorge" (amarelo no mês). O Jorge
 * aprova ou recusa (recusar reabre o dia).
 * O que está bem só aparece (verde, recolhido); na dúvida nunca é verde.
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { can } from "@shared/access";
import { addDays } from "@shared/lisbonDay";
import { lastClosedCashDay } from "@shared/cashDayWindow";
import {
  DAY_STATUS_LABEL, FINDING_LABEL, JUSTIFY_REASONS, JUSTIFY_REASON_LABEL, JUSTIFY_MIN_CHARS, PAY_KIND_LABEL, PROOF_REQUIRED, eur,
  type DayStatus, type FindingCode, type PayKind,
} from "@shared/cashConfirm";
import { compressImage } from "@/lib/compressImage";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, CircleAlert, FileText, Loader2, Lock, Paperclip, ShieldCheck, Undo2 } from "lucide-react";

type City = "lisbon" | "porto" | "faro";
const CITIES: Array<{ id: City; label: string }> = [{ id: "lisbon", label: "Lisboa" }, { id: "porto", label: "Porto" }, { id: "faro", label: "Faro" }];
const COLOR_CLS = { red: "border-l-4 border-l-red-500", amber: "border-l-4 border-l-amber-400", green: "border-l-4 border-l-emerald-500" } as const;
const DOT = { red: "bg-red-500", amber: "bg-amber-400", green: "bg-emerald-500" } as const;
const STATUS_CLS: Record<DayStatus, string> = {
  aberto: "border-slate-300 text-slate-700", reaberto: "border-red-400 text-red-700", fechado: "border-emerald-400 text-emerald-700",
  a_aprovar: "border-amber-400 text-amber-800 bg-amber-50", aprovado: "border-emerald-500 text-emerald-800 bg-emerald-50",
};
const euros = (v: number | null | undefined) => (v == null ? null : Math.round(v * 100));
/** Horas guardadas em UTC → hora de Lisboa ("13/10 09:15"). */
const lisbon = (v: string | null | undefined) => {
  if (!v) return "—";
  const iso = v.includes("T") ? (/[zZ]$/.test(v) ? v : `${v}Z`) : `${v.replace(" ", "T")}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString("pt-PT", { timeZone: "Europe/Lisbon", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};
/** O mesmo limite do servidor (3,3 MB já reduzido; o pedido não passa dos ~4,5 MB da Vercel). */
const FILE_MAX_BYTES = 3_300_000;
const parseEuro = (s: string): number | null => {
  const t = s.trim().replace(/\s/g, "").replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : NaN;
};

async function fileToBase64(file: File): Promise<{ base64: string; mimeType: string }> {
  const f = file.type.startsWith("image/") ? await compressImage(file) : file;
  if (f.size > FILE_MAX_BYTES) throw new Error(`O ficheiro tem ${(f.size / 1_000_000).toFixed(1)} MB: o máximo é 3,3 MB (comprime o PDF ou tira outra foto).`);
  const buf = await f.arrayBuffer();
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { base64: btoa(bin), mimeType: f.type || "application/octet-stream" };
}

export default function CashConfirmPanel() {
  const { user } = useAuth();
  const canEdit = can(user as any, "caixa", "edit") || can(user as any, "faturacao", "edit");
  const canManage = can(user as any, "caixa", "manage") || can(user as any, "faturacao", "manage");
  const initial = useMemo(() => {
    try {
      const q = new URLSearchParams(window.location.search);
      const d = q.get("dia"); const c = q.get("cidade");
      return { day: d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : lastClosedCashDay(), city: (CITIES.some((x) => x.id === c) ? c : "lisbon") as City };
    } catch { return { day: lastClosedCashDay(), city: "lisbon" as City }; }
  }, []);
  const [view, setView] = useState<"dia" | "mes">("dia");
  const [day, setDay] = useState(initial.day);
  const [city, setCity] = useState<City>(initial.city);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border p-0.5">
          {(["dia", "mes"] as const).map((v) => (
            <button key={v} type="button" onClick={() => setView(v)} className={`rounded px-3 py-1 text-sm ${view === v ? "bg-primary text-primary-foreground" : ""}`}>{v === "dia" ? "Dia" : "Mês"}</button>
          ))}
        </div>
        <div className="flex rounded-md border p-0.5" role="group" aria-label="Cidade">
          {CITIES.map((c) => (
            <button key={c.id} type="button" onClick={() => setCity(c.id)} className={`rounded px-3 py-1 text-sm ${city === c.id ? "bg-primary text-primary-foreground" : ""}`}>{c.label}</button>
          ))}
        </div>
        {view === "dia" && (
          <>
            <Button size="icon" variant="outline" aria-label="Dia anterior" onClick={() => setDay((d) => addDays(d, -1))}><ChevronLeft className="h-4 w-4" /></Button>
            <Input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} className="h-9 w-40" aria-label="Dia" />
            <Button size="icon" variant="outline" aria-label="Dia seguinte" onClick={() => setDay((d) => addDays(d, 1))}><ChevronRight className="h-4 w-4" /></Button>
          </>
        )}
      </div>
      {view === "dia"
        ? <DayView day={day} city={city} canEdit={canEdit} canManage={canManage} />
        : <MonthView onOpen={(d, c) => { setDay(d); setCity(c); setView("dia"); }} />}
    </div>
  );
}

// ─── Dia ────────────────────────────────────────────────────────────────────

function DayView({ day, city, canEdit, canManage }: { day: string; city: City; canEdit: boolean; canManage: boolean }) {
  const utils = trpc.useUtils();
  const { user } = useAuth();
  const q = trpc.cashCheck.confirmDay.useQuery({ day, city }, { retry: false });
  const [showAll, setShowAll] = useState(false);
  const [justify, setJustify] = useState<{ key: string; code: FindingCode; color: string; bookingId: string; detail: string } | null>(null);
  const [upload, setUpload] = useState<{ bookingId: string | null; kind: "talao_mb" | "comprovativo"; amount?: number } | null>(null);
  const refresh = () => utils.cashCheck.confirmDay.invalidate({ day, city });
  const close = trpc.cashCheck.confirmClose.useMutation({ onSuccess: (r) => { toast.success(r.status === "a_aprovar" ? "Dia fechado — fica à espera da aprovação do Jorge" : "Dia fechado"); refresh(); }, onError: (e) => toast.error(e.message) });
  const decide = trpc.cashCheck.confirmDecide.useMutation({ onSuccess: () => { toast.success("Decisão gravada"); refresh(); }, onError: (e) => toast.error(e.message) });
  const reopen = trpc.cashCheck.confirmReopen.useMutation({ onSuccess: () => { toast.success("Dia reaberto"); refresh(); }, onError: (e) => toast.error(e.message) });

  if (q.isLoading) return <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  if (q.error) return <p role="alert" className="text-sm text-destructive">{q.error.message}</p>;
  const d = q.data;
  if (!d || !d.available) {
    return <p role="status" className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />A BD da Multipark não respondeu: {(d as any)?.reason ?? ""}. Sem os dados completos nada fica verde. <button className="underline" onClick={() => q.refetch()}>Tentar de novo</button></p>;
  }
  const open = d.status === "aberto" || d.status === "reaberto";
  const s = d.summary;
  const visible = showAll ? d.views : d.views.filter((v) => v.color !== "green");
  const justByKey = new Map(d.justifications.map((j) => [j.findingKey, j]));
  const filesByBooking = new Map<string, typeof d.files>();
  for (const f of d.files) { if (f.removed) continue; const k = f.bookingId ?? ""; filesByBooking.set(k, [...(filesByBooking.get(k) ?? []), f]); }
  const pending = d.justifications.filter((j) => j.decision == null);
  const mine = user?.id != null && d.authors.includes(Number(user.id));
  const canDecide = canManage && !open && !mine;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            Caixa de {day} <span className="text-xs font-normal text-muted-foreground">({d.window})</span>
            <Badge variant="outline" className={STATUS_CLS[d.status as DayStatus]}>{DAY_STATUS_LABEL[d.status as DayStatus]}</Badge>
            {d.integrity.ok ? <span className="flex items-center gap-1 text-xs font-normal text-emerald-700"><ShieldCheck className="h-3.5 w-3.5" />Registo íntegro ({d.integrity.events})</span>
              : <span className="flex items-center gap-1 text-xs font-normal text-red-700" title={d.integrity.problems.join(" ")}><CircleAlert className="h-3.5 w-3.5" />Registo adulterado — {d.integrity.problems[0]}</span>}
          </CardTitle>
          {d.state.closedByName && <p className="text-xs text-muted-foreground">Fechado por {d.state.closedByName} · {lisbon(d.state.closedAt)}{d.state.approvedByName ? ` · aprovado por ${d.state.approvedByName} · ${lisbon(d.state.approvedAt)}` : ""}</p>}
          {d.state.reopenReason && <p className="text-xs text-red-700">Reaberto: {d.state.reopenReason}</p>}
        </CardHeader>
        <CardContent className="space-y-3">
          {!d.stripe.available && <Notice>A Stripe não está a ser verificada: {d.stripe.reason} O dia não fecha com pagamentos online por verificar.</Notice>}
          {d.stripe.available && d.stripe.reason && <Notice>{d.stripe.reason} <button className="underline" onClick={() => q.refetch()}>Atualizar</button></Notice>}
          {d.truncated && <Notice>Há mais reservas/pagamentos do que os lidos: o dia não fecha com dados cortados.</Notice>}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Cell label="Dinheiro registado" value={eur(s.computedCashCents)} hint={s.feesCents ? `+ taxas extra ${eur(s.feesCents)}` : undefined} />
            <Cell label="Despesas do turno" value={`− ${eur(s.shiftExpensesCents)}`} />
            <Cell label="Tem de haver em dinheiro" value={eur(s.expectedCashCents)} strong />
            <Cell label="Multibanco registado" value={eur(s.expectedMbCents)} strong />
            <Cell label="Team leader declarou" value={s.declaredCashCents == null ? "—" : `${eur(s.declaredCashCents)} + MB ${eur(s.declaredMbCents)}`} hint={s.declaredMultiparkTotalCents != null ? `Multipark dava ${eur(s.declaredMultiparkTotalCents)}${s.multiparkTotalGapCents ? ` (≠ ${eur(s.multiparkTotalGapCents)})` : ""}` : undefined} />
            <Cell label="Diferença do dia" value={s.absDifferenceCents == null ? "conta primeiro" : `dinheiro ${eur(s.cashDiffCents)} · MB ${eur(s.mbDiffCents)}`}
              cls={s.absDifferenceCents == null ? "" : s.alert !== "none" ? "text-red-700" : s.absDifferenceCents === 0 ? "text-emerald-700" : "text-amber-700"}
              hint={s.alert === "email" ? "> 70 €: o Jorge recebe email" : s.alert === "amber" ? "> 30 €: fica a amarelo para o Jorge" : s.declaredVsCountedCashCents ? `team leader vs envelope: ${eur(s.declaredVsCountedCashCents)}` : undefined} />
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            {d.shifts.map((sh) => <span key={sh.shift} className="rounded border px-2 py-0.5">{sh.shift === "morning" ? "Manhã" : "Noite"}: dinheiro {sh.cash == null ? "—" : eur(euros(sh.cash))} · MB {sh.mb == null ? "—" : eur(euros(sh.mb))} · Multipark {sh.multiparkTotal == null ? "—" : eur(euros(sh.multiparkTotal))}{sh.byName ? ` · ${sh.byName}` : ""}</span>)}
            {s.missingShifts.map((m) => <span key={m} className="rounded border border-red-300 px-2 py-0.5 text-red-700">{m === "morning" ? "Manhã" : "Noite"}: falta declarar o dinheiro e o Multibanco na Passagem de turno</span>)}
          </div>
          {canEdit && open && <ConfirmValues day={day} city={city} state={d.state} onSaved={refresh} />}
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span><span className={`mr-1 inline-block h-2 w-2 rounded-full ${DOT.red}`} />{d.counts.red} a vermelho</span>
            <span><span className={`mr-1 inline-block h-2 w-2 rounded-full ${DOT.amber}`} />{d.counts.amber} a amarelo</span>
            <span><span className={`mr-1 inline-block h-2 w-2 rounded-full ${DOT.green}`} />{d.counts.green} certas</span>
            <label className="ml-auto flex items-center gap-1"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />Mostrar também as certas</label>
          </div>
          {open && d.blockers.length > 0 && (
            <ul className="space-y-0.5 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-950">
              {d.blockers.map((b, i) => <li key={i}>• {b}</li>)}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            {canEdit && open && (
              <Button size="sm" disabled={close.isPending || d.blockers.length > 0} onClick={() => { if (window.confirm("Fechar o dia? Depois de fechado só o Jorge o reabre.")) close.mutate({ day, city }); }}>
                <Lock className="mr-1 h-4 w-4" />Fechar o dia
              </Button>
            )}
            {canDecide && d.status !== "aprovado" && (
              <Button size="sm" variant="outline" className="border-emerald-500 text-emerald-700" disabled={decide.isPending} onClick={() => {
                const note = window.prompt(`Aprovar o dia${pending.length ? ` e as ${pending.length} justificação(ões) por decidir` : ""}? Nota (opcional):`, "");
                if (note !== null) decide.mutate({ day, city, justificationId: null, decision: "aprovado", note: note || null });
              }}><CheckCircle2 className="mr-1 h-4 w-4" />Aprovar o dia</Button>
            )}
            {canManage && !open && (
              <Button size="sm" variant="ghost" disabled={reopen.isPending} onClick={() => { const r = window.prompt("Porque reabres o dia? (pelo menos 10 carateres)"); if (r) reopen.mutate({ day, city, reason: r }); }}>
                <Undo2 className="mr-1 h-4 w-4" />Reabrir
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {visible.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">{d.views.length ? "Está tudo certo nas reservas deste dia." : "Sem reservas neste dia nos parques que operamos."}</Card>
      ) : visible.map((v) => (
        <Card key={v.id} className={`p-3 ${COLOR_CLS[v.color]}`}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-semibold">{v.code ?? v.id} <span className="font-normal text-muted-foreground">· {v.parkName ?? "?"}{v.driver ? ` · ${v.driver}` : ""}{v.checkOut ? ` · saída ${lisbon(v.checkOut)}` : ""}</span></p>
              <p className="text-xs text-muted-foreground">{v.inDay === "payment_only" ? `Sem saída neste dia (${v.status ?? "?"}) — só conta o dinheiro de balcão recebido no dia` : v.inDay === "cancelled" ? "Cancelada depois do check-in" : v.inDay === "checkout_pending" ? "Saída por concluir na Multipark" : v.status}</p>
            </div>
            <div className="flex gap-1 text-[11px]">
              <Val label="Conferida" v={v.validations.cashValidated} />
              <Val label="Condutor" v={v.validations.driverValidated} />
              <Val label="Caixa" v={v.validations.cashierClosed} />
            </div>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 lg:grid-cols-7">
            <Mini label={v.originSource === "webhook" ? "Quando nasceu (webhook)" : "Original (Multipark)"} value={eur(v.originCents)} />
            <Mini label="Original na Multipark" value={eur(v.originalCents)} />
            <Mini label="Preço final" value={eur(v.finalCents)} strong />
            <Mini label="Devido (− crédito + taxa)" value={eur(v.dueCents)} />
            <Mini label="Pago" value={eur(v.paidCents)} strong />
            <Mini label="Crédito / taxa" value={`${eur(v.creditCents)} / ${eur(v.feesCents)}`} />
            <div className="col-span-2 sm:col-span-4 lg:col-span-1 flex flex-wrap gap-1">
              {(Object.entries(v.paidByKind) as Array<[PayKind, number]>).filter(([, c]) => c !== 0).map(([k, c]) => <span key={k} className="rounded border px-1.5 py-0.5">{PAY_KIND_LABEL[k]} {eur(c)}{v.dayPaidByKind[k] != null && v.dayPaidByKind[k] !== c ? ` (no dia ${eur(v.dayPaidByKind[k])})` : ""}</span>)}
            </div>
          </div>
          {v.findings.length > 0 && (
            <ul className="mt-2 space-y-1">
              {v.findings.map((f) => {
                const j = justByKey.get(f.key);
                return (
                  <li key={f.key} className="rounded border bg-muted/30 p-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`inline-block h-2 w-2 rounded-full ${DOT[f.resolved as keyof typeof DOT]}`} />
                      <b>{FINDING_LABEL[f.code as FindingCode]}</b>
                      {f.amountCents > 0 && <span className="tabular-nums">{eur(f.amountCents)}</span>}
                      <span className="text-muted-foreground">{f.detail}</span>
                    </div>
                    {j && f.stale && <p className="mt-1 text-[11px] text-red-700">A justificação anterior já não vale (o valor mudou ou o comprovativo foi retirado): justifica outra vez.</p>}
                    {j && !f.stale && (
                      <p className="mt-1 text-[11px]">
                        <span className={j.decision === "aprovado" ? "text-emerald-700" : j.decision === "recusado" ? "text-red-700" : "text-amber-800"}>
                          {j.decision === "aprovado" ? "Aprovado" : j.decision === "recusado" ? "Recusado" : "Justificado — à espera do Jorge"}
                        </span>
                        {" · "}{JUSTIFY_REASON_LABEL[j.reason as keyof typeof JUSTIFY_REASON_LABEL] ?? j.reason} · {j.explanation} · {j.byName ?? "?"} {lisbon(j.at)}
                        {j.fileIds.length ? ` · ${j.fileIds.length} comprovativo(s)` : ""}
                        {j.decisionNote ? ` · nota do Jorge: ${j.decisionNote}` : ""}
                        {canDecide && j.decision == null && (
                          <>
                            {" "}<button className="underline text-emerald-700" onClick={() => decide.mutate({ day, city, justificationId: j.id, decision: "aprovado", note: null })}>aprovar</button>
                            {" "}<button className="underline text-red-700" onClick={() => { const n = window.prompt("Porque recusas? (pelo menos 10 carateres) — o dia reabre"); if (n) decide.mutate({ day, city, justificationId: j.id, decision: "recusado", note: n }); }}>recusar</button>
                          </>
                        )}
                      </p>
                    )}
                    {canEdit && open && f.color !== "green" && (
                      <div className="mt-1 flex flex-wrap gap-2">
                        {f.code === "mb_no_receipt" && <Button size="sm" variant="outline" className="h-7" onClick={() => setUpload({ bookingId: v.id, kind: "talao_mb", amount: f.amountCents / 100 })}><Paperclip className="mr-1 h-3.5 w-3.5" />Anexar talão</Button>}
                        <Button size="sm" variant={f.resolved === "red" ? "destructive" : "outline"} className="h-7" onClick={() => setJustify({ key: f.key, code: f.code as FindingCode, color: f.color, bookingId: v.id, detail: f.detail })}>
                          {j && !f.stale && j.decision == null ? "Corrigir justificação" : "Justificar"}
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <BookingFiles files={filesByBooking.get(v.id) ?? []} day={day} city={city} canRemove={canEdit && open} onChanged={refresh}
            onAdd={canEdit && open ? () => setUpload({ bookingId: v.id, kind: "comprovativo" }) : undefined} />
        </Card>
      ))}

      <History events={d.events} />

      {justify && (
        <JustifyDialog day={day} city={city} target={justify} files={(filesByBooking.get(justify.bookingId) ?? []).filter((f) => f.kind === "comprovativo")}
          onUpload={() => setUpload({ bookingId: justify.bookingId, kind: "comprovativo" })} onClose={() => setJustify(null)} onDone={() => { setJustify(null); refresh(); }} />
      )}
      {upload && <UploadDialog day={day} city={city} target={upload} onClose={() => setUpload(null)} onDone={() => { setUpload(null); refresh(); }} />}
    </div>
  );
}

function ConfirmValues({ day, city, state, onSaved }: { day: string; city: City; state: { confirmedCash: number | null; confirmedMb: number | null; note: string | null }; onSaved: () => void }) {
  const [cash, setCash] = useState(state.confirmedCash == null ? "" : String(state.confirmedCash).replace(".", ","));
  const [mb, setMb] = useState(state.confirmedMb == null ? "" : String(state.confirmedMb).replace(".", ","));
  const [note, setNote] = useState(state.note ?? "");
  useEffect(() => { setCash(state.confirmedCash == null ? "" : String(state.confirmedCash).replace(".", ",")); setMb(state.confirmedMb == null ? "" : String(state.confirmedMb).replace(".", ",")); setNote(state.note ?? ""); }, [state.confirmedCash, state.confirmedMb, state.note]);
  const save = trpc.cashCheck.confirmValues.useMutation({ onSuccess: () => { toast.success("Valores do dia gravados"); onSaved(); }, onError: (e) => toast.error(e.message) });
  const c = parseEuro(cash), m = parseEuro(mb);
  const bad = Number.isNaN(c) || Number.isNaN(m);
  return (
    <div className="grid gap-2 rounded-md border bg-muted/30 p-2 sm:grid-cols-[10rem_10rem_1fr_auto] sm:items-end">
      <div><Label className="text-xs" htmlFor="cc-cash">Envelope (dinheiro contado, €)</Label><Input id="cc-cash" inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} placeholder="ex.: 245,50" /></div>
      <div><Label className="text-xs" htmlFor="cc-mb">Multibanco (talões, €)</Label><Input id="cc-mb" inputMode="decimal" value={mb} onChange={(e) => setMb(e.target.value)} placeholder="ex.: 120,00" /></div>
      <div><Label className="text-xs" htmlFor="cc-note">Nota do dia (onde está a diferença, se houver)</Label><Textarea id="cc-note" rows={1} value={note} onChange={(e) => setNote(e.target.value)} /></div>
      <Button size="sm" disabled={save.isPending || bad} onClick={() => save.mutate({ day, city, cash: c as number | null, mb: m as number | null, note: note.trim() || null })}>Gravar</Button>
      {bad && <p className="text-xs text-destructive sm:col-span-4">Valor inválido (usa números, ex.: 245,50).</p>}
    </div>
  );
}

function JustifyDialog({ day, city, target, files, onUpload, onClose, onDone }: {
  day: string; city: City; target: { key: string; code: FindingCode; color: string; detail: string };
  files: Array<{ id: number; mime: string; uploadedAt: string; byName: string | null }>; onUpload: () => void; onClose: () => void; onDone: () => void;
}) {
  const [reason, setReason] = useState<string>("");
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const m = trpc.cashCheck.confirmJustify.useMutation({ onSuccess: () => { toast.success("Justificação gravada"); onDone(); }, onError: (e) => toast.error(e.message) });
  const needsProof = target.color === "red" && PROOF_REQUIRED.has(target.code);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Justificar — {FINDING_LABEL[target.code]}</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">{target.detail}</p>
        <div className="space-y-2">
          <Label className="text-xs" htmlFor="j-reason">Motivo</Label>
          <select id="j-reason" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">Escolhe…</option>
            {JUSTIFY_REASONS.map((r) => <option key={r} value={r}>{JUSTIFY_REASON_LABEL[r]}</option>)}
          </select>
          <Label className="text-xs" htmlFor="j-text">O que aconteceu (pelo menos {JUSTIFY_MIN_CHARS} carateres)</Label>
          <Textarea id="j-text" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
          <p className="text-xs">{needsProof ? "Comprovativo obrigatório (foto ou PDF):" : "Comprovativos (opcional):"}</p>
          {files.length === 0 ? <p className="text-xs text-muted-foreground">Ainda não há comprovativos nesta reserva.</p> : (
            <ul className="space-y-1 text-xs">
              {files.map((f) => (
                <li key={f.id}><label className="flex items-center gap-2"><input type="checkbox" checked={picked.includes(f.id)} onChange={(e) => setPicked((p) => e.target.checked ? [...p, f.id] : p.filter((x) => x !== f.id))} />#{f.id} · {f.mime} · {f.byName ?? "?"} {lisbon(f.uploadedAt)}</label></li>
              ))}
            </ul>
          )}
          <Button size="sm" variant="outline" onClick={onUpload}><Paperclip className="mr-1 h-3.5 w-3.5" />Anexar comprovativo</Button>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button disabled={m.isPending || !reason || text.trim().length < JUSTIFY_MIN_CHARS || (needsProof && picked.length === 0)} onClick={() => m.mutate({ day, city, findingKey: target.key, reason, explanation: text.trim(), fileIds: picked })}>Gravar justificação</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UploadDialog({ day, city, target, onClose, onDone }: { day: string; city: City; target: { bookingId: string | null; kind: "talao_mb" | "comprovativo"; amount?: number }; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [amount, setAmount] = useState(target.amount != null ? String(target.amount).replace(".", ",") : "");
  const [busy, setBusy] = useState(false);
  const m = trpc.cashCheck.confirmUpload.useMutation();
  const talao = target.kind === "talao_mb";
  const value = parseEuro(amount);
  const submit = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const { base64, mimeType } = await fileToBase64(file);
      await m.mutateAsync({ day, city, bookingId: target.bookingId, kind: target.kind, amount: talao ? (value as number) : null, base64, mimeType });
      toast.success(talao ? "Talão anexado" : "Comprovativo anexado");
      onDone();
    } catch (e: any) {
      toast.error(e?.message ?? "Falhou o envio");
    } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{talao ? "Anexar talão Multibanco" : "Anexar comprovativo"}</DialogTitle></DialogHeader>
        <div className="space-y-2">
          {talao && (<><Label className="text-xs" htmlFor="u-amount">Valor do talão (€) — tem de ser igual ao pagamento</Label><Input id="u-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></>)}
          <Label className="text-xs" htmlFor="u-file">Foto ou PDF</Label>
          <Input id="u-file" type="file" accept="image/*,application/pdf" capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <p className="text-[11px] text-muted-foreground">O mesmo ficheiro não pode ser usado duas vezes. Depois de anexado, só se retira com motivo (fica registado).</p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button disabled={busy || !file || (talao && (value == null || Number.isNaN(value) || value <= 0))} onClick={submit}>{busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}Enviar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BookingFiles({ files, day, city, canRemove, onChanged, onAdd }: { files: Array<{ id: number; kind: string; amountCents: number | null; mime: string; uploadedAt: string; byName: string | null }>; day: string; city: City; canRemove: boolean; onChanged: () => void; onAdd?: () => void }) {
  const utils = trpc.useUtils();
  const remove = trpc.cashCheck.confirmRemoveFile.useMutation({ onSuccess: () => { toast.success("Ficheiro retirado (fica no registo)"); onChanged(); }, onError: (e) => toast.error(e.message) });
  if (!files.length && !onAdd) return null;
  const openFile = async (id: number) => {
    try {
      const r = await utils.cashCheck.confirmFileUrl.fetch({ day, city, fileId: id });
      if (r.url) window.open(r.url, "_blank", "noopener"); else toast.error("Ficheiro indisponível");
    } catch (e: any) { toast.error(e?.message ?? "Ficheiro indisponível"); }
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      {files.map((f) => (
        <span key={f.id} className="flex items-center gap-1 rounded border px-1.5 py-0.5">
          <FileText className="h-3 w-3" />
          <button className="underline" onClick={() => openFile(f.id)}>{f.kind === "talao_mb" ? `Talão ${eur(f.amountCents)}` : "Comprovativo"} #{f.id}</button>
          <span className="text-muted-foreground">{f.byName ?? ""}</span>
          {canRemove && <button className="text-red-700" aria-label={`Retirar #${f.id}`} onClick={() => { const r = window.prompt("Porque retiras este ficheiro?"); if (r) remove.mutate({ day, city, fileId: f.id, reason: r }); }}>×</button>}
        </span>
      ))}
      {onAdd && <button className="underline text-muted-foreground" onClick={onAdd}>+ comprovativo</button>}
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = {
  justificar: "Justificou", anexar_talao: "Anexou talão", anexar_comprovativo: "Anexou comprovativo", retirar_ficheiro: "Retirou ficheiro",
  confirmar_valores: "Confirmou valores", fechar: "Fechou o dia", selar: "Selou", aprovar_justificacao: "Aprovou justificação",
  recusar_justificacao: "Recusou justificação", aprovar_dia: "Aprovou o dia", reabrir: "Reabriu", reaberto_multipark: "Reaberto (a Multipark mudou)",
};

function History({ events }: { events: Array<{ id: number; at: string; action: string; findingKey: string | null; byName: string | null }> }) {
  const [open, setOpen] = useState(false);
  if (!events.length) return null;
  return (
    <Card className="p-3">
      <button className="text-sm font-medium" onClick={() => setOpen((v) => !v)}>{open ? "Esconder" : "Ver"} o registo do dia ({events.length})</button>
      {open && (
        <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
          {events.map((e) => <li key={e.id}>{lisbon(e.at)} · {e.byName ?? "Sistema"} · {ACTION_LABEL[e.action] ?? e.action}{e.findingKey ? ` · ${e.findingKey}` : ""}</li>)}
        </ul>
      )}
    </Card>
  );
}

// ─── Mês ────────────────────────────────────────────────────────────────────

function MonthView({ onOpen }: { onOpen: (day: string, city: City) => void }) {
  const [month, setMonth] = useState(() => lastClosedCashDay().slice(0, 7));
  const q = trpc.cashCheck.confirmMonth.useQuery({ month }, { retry: false });
  const rows = q.data ?? [];
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="h-9 w-44" aria-label="Mês" />
        <p className="text-xs text-muted-foreground">Os dias a amarelo esperam pela tua aprovação (diferença &gt; 30 € ou justificações).</p>
      </div>
      {q.isLoading ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /> : q.error ? <p className="text-sm text-destructive">{q.error.message}</p> : rows.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">Sem dias neste mês.</Card>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="p-1.5">Dia</th><th className="p-1.5">Cidade</th><th className="p-1.5">Estado</th><th className="p-1.5 text-right">Diferença</th><th className="p-1.5 text-right">Por aprovar</th><th className="p-1.5">Fechado por</th><th className="p-1.5" /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.day}-${r.city}`} className={`border-b ${r.status === "a_aprovar" || r.status === "reaberto" ? "bg-amber-50" : !r.opened ? "text-muted-foreground" : ""}`}>
                  <td className="p-1.5 tabular-nums">{r.day}</td>
                  <td className="p-1.5">{CITIES.find((c) => c.id === r.city)?.label ?? r.city}</td>
                  <td className="p-1.5"><Badge variant="outline" className={STATUS_CLS[r.status]}>{r.opened ? DAY_STATUS_LABEL[r.status] : "Por fechar (nunca aberto)"}</Badge></td>
                  <td className={`p-1.5 text-right tabular-nums ${r.alert && r.alert !== "none" ? "text-red-700 font-semibold" : ""}`}>{r.cashDiffCents == null && r.mbDiffCents == null ? "—" : `${eur(r.cashDiffCents)} · MB ${eur(r.mbDiffCents)}`}</td>
                  <td className="p-1.5 text-right">{r.pending || ""}</td>
                  <td className="p-1.5 text-xs">{r.closedByName ?? "—"}{r.approvedByName ? ` · aprovado ${r.approvedByName}` : ""}</td>
                  <td className="p-1.5"><Button size="sm" variant="ghost" onClick={() => onOpen(r.day, r.city)}>Abrir</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Peças ──────────────────────────────────────────────────────────────────

function Notice({ children }: { children: React.ReactNode }) {
  return <p role="status" className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-950"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{children}</p>;
}
function Cell({ label, value, hint, strong, cls }: { label: string; value: string; hint?: string; strong?: boolean; cls?: string }) {
  return (
    <div className="min-w-0 rounded-md border p-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`tabular-nums ${strong ? "text-base font-bold" : "text-sm font-semibold"} ${cls ?? ""}`}>{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}
function Mini({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return <div className="min-w-0"><div className="text-[10px] text-muted-foreground">{label}</div><div className={`tabular-nums ${strong ? "font-semibold" : ""}`}>{value}</div></div>;
}
function Val({ label, v }: { label: string; v: { done: boolean; at: string | null; by: string | null } }) {
  return (
    <span title={v.done ? `${v.by ?? "?"}${v.at ? ` · ${lisbon(v.at)}` : ""}` : "por fazer na Multipark"} className={`rounded border px-1.5 py-0.5 ${v.done ? "border-emerald-300 text-emerald-700" : "border-slate-300 text-slate-500"}`}>
      {v.done ? "✓" : "○"} {label}
    </span>
  );
}
