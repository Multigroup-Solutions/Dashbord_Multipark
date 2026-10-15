/**
 * Férias e ausências — o mapa de férias (plano 63, passo 11; Jorge, 15 out
 * 2026: "para toda a gente"). Só com o interruptor FERIAS_MAPA ligado.
 *
 *  - Mapa: o mês, uma linha por pessoa. O que cada um vê vem já filtrado do
 *    servidor (quem vê tudo / supervisor com "ausente" / colegas só férias).
 *  - As minhas: marcar férias (por aprovar) ou, nos extras, "não vou estar".
 *  - Por aprovar: quem aprova vê os pedidos (basta um), aprova ou recusa
 *    com o motivo.
 *  - O RH lança ausências (entram aprovadas) e tira o mapa em PDF.
 * Nada se apaga: cancela-se.
 */
import { useMemo, useState } from "react";
import { useSearch } from "wouter";
import { toast } from "sonner";
import {
  AlertTriangle, CalendarRange, Check, ChevronLeft, ChevronRight, FileDown, Loader2, Palmtree, Plus, Undo2, X, CalendarOff, Info,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { downloadBase64 } from "@/components/ferias/FeriasBits";
import {
  LEAVE_STATUS_LABELS, LEAVE_TYPE_LABELS, alreadyScheduledWarning, isRealIsoDay, leaveInputError, shortDayPt, vacationYearWarning, workingDaysIn,
  type LeaveStatus, type LeaveTypeShown,
} from "@shared/leaves";
import { ptHolidayOf } from "@shared/workSchedule";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";

const MONTHS = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const WD = ["D", "S", "T", "Q", "Q", "S", "S"];
const CITY_LABEL: Record<string, string> = { lisbon: "Lisboa", porto: "Porto", faro: "Faro" };
type CityKey = "all" | "lisbon" | "porto" | "faro";

const todayIso = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon" }).format(new Date());
const pad = (n: number) => String(n).padStart(2, "0");
const periodText = (l: { fromDate: string; toDate: string; hours?: number | null }) =>
  l.fromDate === l.toDate ? `${shortDayPt(l.fromDate)}${l.hours ? ` (${String(l.hours).replace(".", ",")} h)` : ""}` : `${shortDayPt(l.fromDate)} a ${shortDayPt(l.toDate)}`;

/** Cor de cada tipo no mapa (design Multipark: azul #0055D2 = férias aprovadas). */
function cellTone(type: LeaveTypeShown, status: string): string {
  if (type === "vacation") return status === "approved" ? "bg-[#0055D2] text-white" : "bg-[#0055D2]/25 text-[#0055D2] ring-1 ring-inset ring-[#0055D2]/40";
  if (type === "unavailable") return "bg-amber-400/80 text-amber-950";
  if (type === "sick") return "bg-rose-400/80 text-rose-950";
  if (type === "unpaid") return "bg-slate-500/70 text-white";
  if (type === "other") return "bg-violet-400/70 text-violet-950";
  return "bg-slate-400/70 text-slate-950"; // ausente (sem o motivo)
}
const RANK: Record<string, number> = { vacation: 1, sick: 2, unpaid: 2, other: 2, absent: 2, unavailable: 3 };

function StatusBadge({ status }: { status: string }) {
  const label = LEAVE_STATUS_LABELS[status as LeaveStatus] ?? status;
  const tone = status === "approved" ? "bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-900"
    : status === "requested" ? "bg-[#0055D2]/10 text-[#0055D2] border-[#0055D2]/30"
    : status === "rejected" ? "bg-rose-50 text-rose-800 border-rose-200 dark:bg-rose-950/30 dark:text-rose-300 dark:border-rose-900"
    : "bg-muted text-muted-foreground";
  return <Badge variant="outline" className={`text-[11px] ${tone}`}>{label}</Badge>;
}

export default function FeriasPage() {
  const { user } = useAuth();
  const statusQ = trpc.rh.leaves.status.useQuery(undefined, { staleTime: 60_000, retry: false });
  const params = new URLSearchParams(useSearch());
  const s = statusQ.data;
  const ownTabLabel = s?.isExtra ? "Quando não vou estar" : "As minhas férias";
  const showMap = !!s && s.mode !== "extra" && s.mode !== "none";
  const showPending = !!s && (s.pendingCount > 0 || s.mode === "full" || user?.role === "super_admin");
  const showMine = !!s?.employeeId && !s.isPartner;
  const wanted = params.get("tab");
  const fallback = showMap && (s?.mode === "full" || s?.mode === "supervisor") ? "mapa" : showMine ? "minhas" : "mapa";
  const [tab, setTab] = useState<string | null>(null);
  const active = tab ?? (wanted === "aprovar" && showPending ? "aprovar" : wanted === "minhas" && showMine ? "minhas" : wanted === "mapa" && showMap ? "mapa" : fallback);

  if (statusQ.isLoading) return <div className="py-24 flex justify-center"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
  if (statusQ.error) return <div className="max-w-md mx-auto py-10 px-4"><QueryErrorNote error={statusQ.error} onRetry={() => statusQ.refetch()} retrying={statusQ.isFetching} what="o mapa de férias" /></div>;
  if (!s) {
    return (
      <div className="max-w-lg mx-auto py-10 px-4">
        <div className="rounded-[14px] border bg-card p-5 text-sm space-y-2">
          <div className="flex items-center gap-2 font-semibold"><CalendarRange className="h-5 w-5 text-primary" /> Mapa de férias</div>
          <p className="text-muted-foreground">O mapa de férias ainda não está ligado.{user?.role === "super_admin" ? " Liga-o em Definições → Automações → \"RH: mapa de férias e pedidos\"." : " Fala com o RH para marcar férias."}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-6xl mx-auto w-full">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold flex items-center gap-2"><Palmtree className="h-6 w-6 text-primary" />Férias e ausências</h1>
          <p className="text-sm text-muted-foreground">
            {s.mode === "full" ? "Vês todas as cidades, com baixas e ausências." :
              s.mode === "supervisor" ? `Vês ${s.allCities ? "todas as cidades" : "a tua área"}. As baixas e ausências aparecem só como "ausente".` :
              s.mode === "extra" ? "Avisa quando não vais estar: quem escala vê e não te chama." :
              "Marca as tuas férias e vê as dos colegas da tua cidade."}
          </p>
        </div>
      </div>
      <Tabs value={active} onValueChange={setTab}>
        <TabsList className="w-full max-w-full justify-start overflow-x-auto sm:w-auto">
          {showMap && <TabsTrigger value="mapa">Mapa</TabsTrigger>}
          {showMine && <TabsTrigger value="minhas">{ownTabLabel}</TabsTrigger>}
          {showPending && (
            <TabsTrigger value="aprovar">
              Por aprovar{s.pendingCount > 0 && <span className="ml-1.5 rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">{s.pendingCount}</span>}
            </TabsTrigger>
          )}
        </TabsList>
        {showMap && <TabsContent value="mapa" className="mt-4"><MapTab canLaunch={s.canLaunch} canPrint={s.canPrint} mode={s.mode} /></TabsContent>}
        {showMine && <TabsContent value="minhas" className="mt-4"><MineTab isExtra={s.isExtra} daysPerYear={s.daysPerYear} city={s.city} isSuperAdmin={user?.role === "super_admin"} /></TabsContent>}
        {showPending && <TabsContent value="aprovar" className="mt-4"><PendingTab /></TabsContent>}
      </Tabs>
    </div>
  );
}

// ─── Mapa ────────────────────────────────────────────────────────────────────

type MapData = inferRouterOutputs<AppRouter>["rh"]["leaves"]["map"];
type MapLeaveRow = MapData["leaves"][number];

function MapTab({ canLaunch, canPrint, mode }: { canLaunch: boolean; canPrint: boolean; mode: string }) {
  const now = todayIso();
  const [year, setYear] = useState(Number(now.slice(0, 4)));
  const [month, setMonth] = useState(Number(now.slice(5, 7)));
  const [city, setCity] = useState<CityKey>("all");
  const [launch, setLaunch] = useState(false);
  const [detail, setDetail] = useState<MapLeaveRow | null>(null);
  const canChooseCity = mode === "full" || mode === "supervisor";
  const q = trpc.rh.leaves.map.useQuery({ year, cityKey: canChooseCity ? city : undefined }, { staleTime: 30_000 });
  const pdf = trpc.rh.leaves.pdf.useMutation({
    onSuccess: (r) => downloadBase64(r.fileName, r.base64),
    onError: (e) => toast.error("Não deu para gerar o PDF", { description: e.message }),
  });
  const step = (d: number) => {
    let m = month + d, y = year;
    if (m < 1) { m = 12; y--; } else if (m > 12) { m = 1; y++; }
    setMonth(m); setYear(y);
  };
  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const days = Array.from({ length: dim }, (_, i) => `${year}-${pad(month)}-${pad(i + 1)}`);
  const mFrom = days[0], mTo = days[days.length - 1];
  const people = q.data?.people ?? [];
  const leavesByEmp = useMemo(() => {
    const m = new Map<number, MapLeaveRow[]>();
    for (const l of q.data?.leaves ?? []) m.set(l.employeeId, [...(m.get(l.employeeId) ?? []), l]);
    return m;
  }, [q.data]);
  const monthLeaves = (q.data?.leaves ?? []).filter((l) => l.fromDate <= mTo && l.toDate >= mFrom)
    .sort((a, b) => a.fromDate.localeCompare(b.fromDate) || a.employeeId - b.employeeId);
  const nameOf = new Map(people.map((p) => [p.id, p.fullName]));
  const cityOf = new Map(people.map((p) => [p.id, p.city]));
  const visiblePeople = people.filter((p) => !p.isExtra || (leavesByEmp.get(p.id) ?? []).some((l) => l.fromDate <= mTo && l.toDate >= mFrom));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center rounded-md border bg-card">
          <Button variant="ghost" size="sm" className="px-2" onClick={() => step(-1)} aria-label="Mês anterior"><ChevronLeft className="h-4 w-4" /></Button>
          <span className="min-w-[9.5rem] text-center text-sm font-semibold">{MONTHS[month - 1]} {year}</span>
          <Button variant="ghost" size="sm" className="px-2" onClick={() => step(1)} aria-label="Mês seguinte"><ChevronRight className="h-4 w-4" /></Button>
        </div>
        {canChooseCity && (
          <Select value={city} onValueChange={(v) => setCity(v as CityKey)}>
            <SelectTrigger className="w-40 h-9" aria-label="Cidade"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas as cidades</SelectItem>
              <SelectItem value="lisbon">Lisboa</SelectItem>
              <SelectItem value="porto">Porto</SelectItem>
              <SelectItem value="faro">Faro</SelectItem>
            </SelectContent>
          </Select>
        )}
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          {canPrint && (
            <Button variant="outline" size="sm" disabled={pdf.isPending} onClick={() => pdf.mutate({ year, cityKey: canChooseCity ? city : undefined })}>
              {pdf.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <FileDown className="h-4 w-4 mr-2" />}Mapa {year} (PDF)
            </Button>
          )}
          {canLaunch && <Button size="sm" onClick={() => setLaunch(true)}><Plus className="h-4 w-4 mr-2" />Lançar ausência</Button>}
        </div>
      </div>

      <Legend mode={mode} />

      {q.error && <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="o mapa" />}
      {q.isLoading ? (
        <div className="py-10 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
      ) : (
        <div className="rounded-[14px] border bg-card overflow-x-auto" data-leave-map>
          <table className="border-collapse text-[11px]">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-card min-w-[9.5rem] max-w-[12rem] px-2 py-1.5 text-left text-xs font-semibold border-b">Pessoa</th>
                {days.map((d) => {
                  const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
                  const hol = ptHolidayOf(d);
                  return (
                    <th key={d} title={hol ?? undefined} className={`w-[26px] min-w-[26px] px-0 py-1 text-center font-medium border-b ${wd === 0 || wd === 6 || hol ? "bg-muted text-muted-foreground" : ""} ${d === todayIso() ? "text-primary" : ""}`}>
                      <div>{WD[wd]}</div><div className="font-semibold">{Number(d.slice(8))}</div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visiblePeople.length === 0 && (
                <tr><td colSpan={dim + 1} className="px-3 py-6 text-center text-sm text-muted-foreground">Ninguém para mostrar.</td></tr>
              )}
              {visiblePeople.map((p) => {
                const ls = leavesByEmp.get(p.id) ?? [];
                return (
                  <tr key={p.id} className="border-b last:border-b-0">
                    <td className={`sticky left-0 z-10 bg-card px-2 py-1 text-xs truncate max-w-[12rem] ${p.isSelf ? "font-semibold text-primary" : ""}`} title={`${p.fullName}${p.city ? ` · ${CITY_LABEL[p.city] ?? p.city}` : ""}${p.isExtra ? " · extra" : ""}`}>
                      {p.fullName}{p.isExtra && <span className="ml-1 text-[10px] text-muted-foreground">extra</span>}
                    </td>
                    {days.map((d) => {
                      const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
                      const hol = ptHolidayOf(d, p.city);
                      const hits = ls.filter((l) => l.fromDate <= d && d <= l.toDate).sort((a, b) => (RANK[a.leaveType] ?? 9) - (RANK[b.leaveType] ?? 9) || (a.status === "approved" ? -1 : 1));
                      const top = hits[0];
                      const off = wd === 0 || wd === 6 || !!hol;
                      return (
                        <td key={d} className={`p-0 h-7 text-center ${off && !top ? "bg-muted" : ""}`}>
                          {top ? (
                            <button type="button" onClick={() => setDetail(top)}
                              className={`h-6 w-[24px] rounded-sm text-[10px] font-semibold ${cellTone(top.leaveType, top.status)} ${off ? "opacity-60" : ""}`}
                              title={`${p.fullName}: ${LEAVE_TYPE_LABELS[top.leaveType]} ${periodText(top)} (${LEAVE_STATUS_LABELS[top.status as LeaveStatus] ?? top.status})${hol ? ` · ${hol}` : ""}`}
                              aria-label={`${p.fullName}, ${d}: ${LEAVE_TYPE_LABELS[top.leaveType]}`}>
                              {top.hours ? "½" : top.status === "requested" ? "?" : ""}
                            </button>
                          ) : hol ? <span className="block h-6 leading-6 text-[9px] text-muted-foreground" title={hol}>F</span> : null}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="rounded-[14px] border bg-card p-3">
        <div className="text-sm font-semibold mb-2">Em {MONTHS[month - 1].toLowerCase()} ({monthLeaves.length})</div>
        {monthLeaves.length === 0 ? <p className="text-xs text-muted-foreground">Ninguém fora este mês.</p> : (
          <ul className="divide-y">
            {monthLeaves.map((l) => (
              <li key={l.id} className="py-2 flex flex-wrap items-center gap-2 text-sm">
                <span className={`h-3 w-3 rounded-sm shrink-0 ${cellTone(l.leaveType, l.status)}`} aria-hidden />
                <span className="font-medium min-w-0 truncate">{nameOf.get(l.employeeId) ?? "—"}</span>
                <span className="text-muted-foreground">{LEAVE_TYPE_LABELS[l.leaveType]} · {periodText(l)}{l.workingDays ? ` · ${l.workingDays} dia(s) úteis` : ""}</span>
                <StatusBadge status={l.status} />
                {(l.canApprove || l.canCancel) && <Button size="sm" variant="ghost" className="h-7 ml-auto" onClick={() => setDetail(l)}>Tratar</Button>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {detail && <LeaveDetailDialog leave={detail} name={nameOf.get(detail.employeeId) ?? ""} city={cityOf.get(detail.employeeId) ?? null} onClose={() => setDetail(null)} />}
      {launch && <LaunchDialog onClose={() => setLaunch(false)} />}
    </div>
  );
}

function Legend({ mode }: { mode: string }) {
  const items: Array<[LeaveTypeShown, string, string]> = [
    ["vacation", "approved", "Férias aprovadas"],
    ["vacation", "requested", "Férias pedidas"],
    ...(mode === "full" ? [["sick", "approved", "Baixa"], ["unpaid", "approved", "Não remunerada"], ["other", "approved", "Ausência justificada"]] as Array<[LeaveTypeShown, string, string]> : []),
    ...(mode === "supervisor" ? [["absent", "approved", "Ausente"]] as Array<[LeaveTypeShown, string, string]> : []),
    ...(mode === "full" || mode === "supervisor" ? [["unavailable", "approved", "Indisponível (extra)"]] as Array<[LeaveTypeShown, string, string]> : []),
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {items.map(([t, st, label]) => (
        <span key={label} className="inline-flex items-center gap-1"><span className={`h-3 w-3 rounded-sm ${cellTone(t, st)}`} />{label}</span>
      ))}
      <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded-sm bg-muted border" />Fim de semana / feriado (F)</span>
      <span className="inline-flex items-center gap-1">½ = parte do dia</span>
    </div>
  );
}

// ─── Detalhe (aprovar / recusar / cancelar) ──────────────────────────────────

function LeaveDetailDialog({ leave, name, city, onClose }: { leave: MapLeaveRow; name: string; city: string | null; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [note, setNote] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const done = (msg: string) => { toast.success(msg); utils.rh.leaves.invalidate(); onClose(); };
  const decide = trpc.rh.leaves.decide.useMutation({ onSuccess: (r) => done(r.status === "approved" ? "Férias aprovadas." : "Pedido recusado."), onError: (e) => toast.error(e.message) });
  const cancel = trpc.rh.leaves.cancel.useMutation({ onSuccess: () => done("Cancelado (fica no histórico)."), onError: (e) => toast.error(e.message) });
  const busy = decide.isPending || cancel.isPending;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{name || "Ausência"}</DialogTitle>
          <DialogDescription>{LEAVE_TYPE_LABELS[leave.leaveType]} · {periodText(leave)}{city ? ` · ${CITY_LABEL[city] ?? city}` : ""}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2"><StatusBadge status={leave.status} />{leave.workingDays > 0 && <span className="text-muted-foreground">{leave.workingDays} dia(s) úteis</span>}</div>
          {leave.notes && <p className="text-muted-foreground whitespace-pre-wrap [overflow-wrap:anywhere]">Nota: {leave.notes}</p>}
          {leave.decisionNote && <p className="text-muted-foreground whitespace-pre-wrap [overflow-wrap:anywhere]">Motivo: {leave.decisionNote}</p>}
          {(rejecting || leave.canCancel) && (
            <div className="space-y-1">
              <Label htmlFor="leave-note" className="text-xs">{rejecting ? "Motivo da recusa (a pessoa vê-o)" : "Motivo (opcional)"}</Label>
              <Textarea id="leave-note" rows={2} maxLength={255} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          )}
          {!leave.canApprove && !leave.canCancel && <p className="text-xs text-muted-foreground">Não tens nada a tratar aqui.</p>}
        </div>
        <DialogFooter className="flex-wrap gap-2">
          {leave.canCancel && !rejecting && (
            <Button variant="outline" disabled={busy} onClick={() => { if (confirm("Cancelar esta ausência? Fica no histórico (não se apaga).")) cancel.mutate({ id: leave.id, note: note.trim() || undefined }); }}>
              <Undo2 className="h-4 w-4 mr-1" />Cancelar ausência
            </Button>
          )}
          {leave.canApprove && !rejecting && <Button variant="outline" disabled={busy} onClick={() => setRejecting(true)}><X className="h-4 w-4 mr-1" />Recusar</Button>}
          {leave.canApprove && rejecting && <Button variant="destructive" disabled={busy || !note.trim()} onClick={() => decide.mutate({ id: leave.id, approve: false, note: note.trim() })}>Recusar pedido</Button>}
          {leave.canApprove && !rejecting && <Button disabled={busy} onClick={() => decide.mutate({ id: leave.id, approve: true })}><Check className="h-4 w-4 mr-1" />Aprovar</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Lançar (RH) ─────────────────────────────────────────────────────────────

const LAUNCH_TYPES: Array<{ id: "vacation" | "sick" | "unpaid" | "other" | "unavailable"; label: string }> = [
  { id: "vacation", label: "Férias" },
  { id: "sick", label: "Baixa" },
  { id: "unpaid", label: "Ausência não remunerada" },
  { id: "other", label: "Ausência justificada (consulta, funeral…)" },
  { id: "unavailable", label: "Indisponível (só extras)" },
];

function LaunchDialog({ onClose }: { onClose: () => void }) {
  const utils = trpc.useUtils();
  const peopleQ = trpc.rh.leaves.launchPeople.useQuery(undefined, { staleTime: 60_000 });
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [leaveType, setLeaveType] = useState<(typeof LAUNCH_TYPES)[number]["id"]>("vacation");
  const [fromDate, setFrom] = useState(todayIso());
  const [toDate, setTo] = useState(todayIso());
  const [partial, setPartial] = useState(false);
  const [hours, setHours] = useState("");
  const [notes, setNotes] = useState("");
  const person = (peopleQ.data ?? []).find((p) => p.id === employeeId);
  const h = partial ? Number(hours.replace(",", ".")) : null;
  // Férias já aprovadas: só quem as aprova, o RH ou o super admin (o servidor volta a confirmar)
  const vacationBlocked = leaveType === "vacation" && person?.canVacation === false;
  const err = employeeId == null ? "Escolhe a pessoa."
    : vacationBlocked ? "Férias já aprovadas desta pessoa só as lança quem as aprova, o RH ou o super admin. A pessoa pede-as no Mapa de férias."
    : leaveInputError({ leaveType, fromDate, toDate, hours: partial ? (Number.isFinite(h) ? h : NaN) : null });
  const create = trpc.rh.leaves.create.useMutation({
    onSuccess: () => { toast.success("Ausência lançada (aprovada)."); utils.rh.leaves.invalidate(); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Lançar ausência</DialogTitle>
          <DialogDescription>Entra logo aprovada. As baixas e ausências só as veem a pessoa, o RH e quem vê o mapa inteiro. Férias: só a quem tu aprovas (o RH e o super admin a todos).</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Pessoa</Label>
            <SearchableSelect value={employeeId ? String(employeeId) : ""} onChange={(v) => setEmployeeId(Number(v) || null)} className="w-full"
              options={(peopleQ.data ?? []).map((p) => ({ value: String(p.id), label: `${p.fullName}${p.isExtra ? " (extra)" : ""}` }))}
              placeholder={peopleQ.isLoading ? "A carregar…" : "Escolher pessoa"} searchPlaceholder="Procurar pelo nome…" emptyText="Ninguém" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Tipo</Label>
            <Select value={leaveType} onValueChange={(v) => { setLeaveType(v as typeof leaveType); if (v !== "other") setPartial(false); }}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {LAUNCH_TYPES.filter((t) => t.id !== "unavailable" || person?.isExtra).map((t) => <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1"><Label className="text-xs" htmlFor="l-from">De</Label><Input id="l-from" type="date" value={fromDate} onChange={(e) => { setFrom(e.target.value); if (partial || toDate < e.target.value) setTo(e.target.value); }} /></div>
            <div className="space-y-1"><Label className="text-xs" htmlFor="l-to">Até</Label><Input id="l-to" type="date" value={toDate} disabled={partial} onChange={(e) => setTo(e.target.value)} /></div>
          </div>
          {leaveType === "other" && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-sm"><Checkbox checked={partial} onCheckedChange={(v) => { setPartial(v === true); if (v === true) setTo(fromDate); }} />Só parte do dia</label>
              {partial && <Input className="w-24 h-8" inputMode="decimal" placeholder="horas" value={hours} onChange={(e) => setHours(e.target.value)} aria-label="Horas" />}
            </div>
          )}
          <div className="space-y-1"><Label className="text-xs" htmlFor="l-notes">Nota (opcional)</Label><Textarea id="l-notes" rows={2} maxLength={255} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          {err && employeeId != null && <p className="text-xs text-destructive">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Fechar</Button>
          <Button disabled={!!err || create.isPending} onClick={() => create.mutate({ employeeId: employeeId!, leaveType, fromDate, toDate, hours: partial ? h : null, notes: notes.trim() || undefined })}>
            {create.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Lançar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── As minhas ───────────────────────────────────────────────────────────────

function MineTab({ isExtra, daysPerYear, city, isSuperAdmin }: { isExtra: boolean; daysPerYear: number; city: string | null; isSuperAdmin: boolean }) {
  const utils = trpc.useUtils();
  const [year, setYear] = useState(Number(todayIso().slice(0, 4)));
  const q = trpc.rh.leaves.mine.useQuery({ year }, { staleTime: 30_000 });
  const approversQ = trpc.rh.leaves.myApprovers.useQuery(undefined, { enabled: !isExtra, staleTime: 5 * 60_000, retry: false });
  const [fromDate, setFrom] = useState("");
  const [toDate, setTo] = useState("");
  const [notes, setNotes] = useState("");
  const request = trpc.rh.leaves.request.useMutation({
    onSuccess: (r) => {
      toast.success(isExtra ? "Aviso registado: quem escala já vê." : r.status === "approved" ? "Férias marcadas (aprovadas)." : `Pedido enviado${r.approvers ? ` (${r.approvers} ${r.approvers === 1 ? "pessoa pode" : "pessoas podem"} aprovar)` : ""}.`);
      // já estava na escala nalgum desses dias: o aviso não tira a falta desse dia (fala com quem escala)
      const late = alreadyScheduledWarning(r.alreadyScheduled);
      if (late) toast.warning(late, { duration: 15_000 });
      setFrom(""); setTo(""); setNotes("");
      utils.rh.leaves.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const cancel = trpc.rh.leaves.cancel.useMutation({
    onSuccess: () => { toast.success("Cancelado (fica no histórico)."); utils.rh.leaves.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const valid = isRealIsoDay(fromDate) && isRealIsoDay(toDate);
  const err = fromDate || toDate ? (valid ? leaveInputError({ leaveType: isExtra ? "unavailable" : "vacation", fromDate, toDate }) : "Escolhe as duas datas.") : null;
  const past = valid && fromDate < todayIso() ? "Só de hoje em diante (o que já passou lança-o o RH)." : null;
  const days = valid && !err ? workingDaysIn(fromDate, toDate, city) : 0;
  const reqYear = valid ? Number(fromDate.slice(0, 4)) : year;
  const baseTotal = reqYear === year ? (q.data?.yearTotal ?? 0) : null;
  const total = baseTotal != null && !isExtra ? baseTotal + (valid && !err ? workingDaysIn(fromDate, toDate, city, `${reqYear}-01-01`, `${reqYear}-12-31`) : 0) : null;
  const warn = total != null ? vacationYearWarning(total, daysPerYear) : null;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <div className="rounded-[14px] border bg-card p-4 space-y-3 h-fit">
        <div className="flex items-center gap-2 font-semibold">{isExtra ? <CalendarOff className="h-5 w-5 text-primary" /> : <Palmtree className="h-5 w-5 text-primary" />}{isExtra ? "Não vou estar" : "Marcar férias"}</div>
        <p className="text-xs text-muted-foreground">
          {isExtra ? "Avisa de que dia a que dia não podes vir. Entra logo (não precisa de aprovação nem é pago). Avisa antes de seres escalado: assim, se fores escalado na mesma, a falta fica sem pontos."
            : isSuperAdmin ? "As tuas ficam aprovadas logo." : "O pedido fica por aprovar até alguém da tua cadeia aprovar."}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1"><Label className="text-xs" htmlFor="m-from">De</Label><Input id="m-from" type="date" min={todayIso()} value={fromDate} onChange={(e) => { setFrom(e.target.value); if (!toDate || toDate < e.target.value) setTo(e.target.value); }} /></div>
          <div className="space-y-1"><Label className="text-xs" htmlFor="m-to">Até</Label><Input id="m-to" type="date" min={fromDate || todayIso()} value={toDate} onChange={(e) => setTo(e.target.value)} /></div>
        </div>
        <div className="space-y-1"><Label className="text-xs" htmlFor="m-notes">Nota (opcional — {isExtra ? "o supervisor e o RH veem-na" : "quem aprova, o supervisor e o RH veem-na"})</Label><Textarea id="m-notes" rows={2} maxLength={255} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        {valid && !err && !isExtra && (
          <p className="text-xs"><b>{days}</b> dia(s) úteis{total != null ? <> · no ano: <b>{total}</b> de {daysPerYear}</> : null}</p>
        )}
        {warn && <p className="text-xs text-amber-800 dark:text-amber-300 flex gap-1"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />{warn}</p>}
        {!isExtra && !isSuperAdmin && approversQ.data && (
          <p className="text-[11px] text-muted-foreground flex gap-1"><Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />{approversQ.data.names.length ? `Aprova: ${approversQ.data.names.join(" ou ")}.` : "Aprova o super admin."}</p>
        )}
        {(err || past) && (fromDate || toDate) && <p className="text-xs text-destructive">{err ?? past}</p>}
        <Button className="w-full" disabled={!valid || !!err || !!past || request.isPending} onClick={() => request.mutate({ fromDate, toDate, notes: notes.trim() || undefined })}>
          {request.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}{isExtra ? "Avisar" : isSuperAdmin ? "Marcar" : "Pedir férias"}
        </Button>
      </div>

      <div className="rounded-[14px] border bg-card p-4 space-y-3 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold">{isExtra ? "Os meus avisos" : "As minhas férias e ausências"}</span>
          <div className="ml-auto flex items-center rounded-md border">
            <Button variant="ghost" size="sm" className="px-2" onClick={() => setYear(year - 1)} aria-label="Ano anterior"><ChevronLeft className="h-4 w-4" /></Button>
            <span className="text-sm font-semibold px-1">{year}</span>
            <Button variant="ghost" size="sm" className="px-2" onClick={() => setYear(year + 1)} aria-label="Ano seguinte"><ChevronRight className="h-4 w-4" /></Button>
          </div>
        </div>
        {!isExtra && q.data && <p className="text-xs text-muted-foreground">Férias em {year}: <b className="text-foreground">{q.data.yearTotal}</b> de {q.data.daysPerYear} dias úteis (pedidas e aprovadas).</p>}
        {q.error && <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="as tuas férias" />}
        {q.isLoading ? <Loader2 className="h-5 w-5 animate-spin text-primary" /> : (q.data?.leaves ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">Nada marcado em {year}.</p>
        ) : (
          <ul className="divide-y">
            {(q.data?.leaves ?? []).map((l) => (
              <li key={l.id} className="py-2 flex flex-wrap items-center gap-2 text-sm">
                <span className={`h-3 w-3 rounded-sm shrink-0 ${cellTone(l.leaveType, l.status)}`} aria-hidden />
                <span className="font-medium">{periodText(l)}</span>
                <span className="text-muted-foreground">{LEAVE_TYPE_LABELS[l.leaveType]}{l.workingDays ? ` · ${l.workingDays} dia(s) úteis` : ""}</span>
                <StatusBadge status={l.status} />
                {l.decisionNote && <span className="basis-full text-xs text-muted-foreground [overflow-wrap:anywhere]">Motivo: {l.decisionNote}</span>}
                {l.canCancel && (
                  <Button size="sm" variant="ghost" className="h-7 ml-auto" disabled={cancel.isPending}
                    onClick={() => { if (confirm("Cancelar? Fica no histórico.")) cancel.mutate({ id: l.id }); }}>
                    <Undo2 className="h-3.5 w-3.5 mr-1" />Cancelar
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── Por aprovar ─────────────────────────────────────────────────────────────

function PendingTab() {
  const utils = trpc.useUtils();
  const q = trpc.rh.leaves.pending.useQuery(undefined, { staleTime: 15_000 });
  const [rejectId, setRejectId] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const decide = trpc.rh.leaves.decide.useMutation({
    onSuccess: (r) => { toast.success(r.status === "approved" ? "Férias aprovadas." : "Pedido recusado."); setRejectId(null); setNote(""); utils.rh.leaves.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  if (q.isLoading) return <Loader2 className="h-6 w-6 animate-spin text-primary" />;
  if (q.error) return <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="os pedidos" />;
  const items = q.data ?? [];
  if (!items.length) return <div className="rounded-[14px] border bg-card p-5 text-sm text-muted-foreground">Não há férias por aprovar.</div>;
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {items.map((p) => {
        const warn = vacationYearWarning(p.yearTotal, p.daysPerYear);
        return (
          <div key={p.id} className="rounded-[14px] border bg-card p-4 space-y-2 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold truncate">{p.fullName}</span>
              {p.city && <Badge variant="outline" className="text-[11px]">{CITY_LABEL[p.city] ?? p.city}</Badge>}
            </div>
            <div className="text-sm"><b>{periodText(p)}</b> · {p.workingDays} dia(s) úteis</div>
            <div className="text-xs text-muted-foreground">No ano (com este): {p.yearTotal} de {p.daysPerYear} dias úteis</div>
            {warn && <p className="text-xs text-amber-800 dark:text-amber-300 flex gap-1"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />{warn.replace("Com este pedido ficas", "Fica")}</p>}
            {p.colleaguesAway.length > 0 && <p className="text-xs text-muted-foreground">Também fora nesses dias: {p.colleaguesAway.join(", ")}</p>}
            {p.notes && <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">Nota: {p.notes}</p>}
            {rejectId === p.id ? (
              <div className="space-y-2">
                <Textarea rows={2} maxLength={255} placeholder="Motivo da recusa (a pessoa vê-o)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Motivo da recusa" />
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => { setRejectId(null); setNote(""); }}>Voltar</Button>
                  <Button size="sm" variant="destructive" disabled={!note.trim() || decide.isPending} onClick={() => decide.mutate({ id: p.id, approve: false, note: note.trim() })}>Recusar pedido</Button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => { setRejectId(p.id); setNote(""); }}><X className="h-4 w-4 mr-1" />Recusar</Button>
                <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: p.id, approve: true })}><Check className="h-4 w-4 mr-1" />Aprovar</Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
