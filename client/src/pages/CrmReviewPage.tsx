/**
 * Rever fichas — CRM (Jorge, 27 set 2026; desenho "Rever fichas").
 *
 * Nada se junta só pelo nome nem só pelo email. Aqui a equipa decide:
 *   · sugestões para juntar — as duas fichas lado a lado, Juntar/Descartar;
 *   · emails estranhos (balcão/agregador) — procurar o verdadeiro na caixa;
 *   · reservas dos próximos 3 dias de clientes sem email — pedir à chegada;
 *   · juntas recentemente — Separar (repõe o que foi movido).
 * Juntar e separar ficam no registo, com quem e quando.
 */
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, ArrowLeftRight, Loader2, Undo2 } from "lucide-react";
import { FindEmailButton } from "@/components/crm/FindEmail";
import { isCrmFile, type CrmGenericEmails, type CrmMergeEvent, type CrmSuggestions, type CrmUpcomingNoEmail } from "@/components/crm/crmTypes";
import { ClientAvatar, Lbl, Pill, fmtPhone, num, relDays, shortDate, shortDateTime } from "@/components/crm/crmUi";

type Tab = "suggestions" | "generic" | "noEmail" | "merges";
const PAGE = 10;

export default function CrmReviewPage() {
  const [tab, setTab] = useState<Tab>("suggestions");
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [tab]);
  const q = trpc.crm.review.useQuery({ tab, offset, limit: tab === "merges" ? 50 : PAGE }, { placeholderData: (p) => (p?.tab === tab ? p : undefined) });
  const options = trpc.crm.options.useQuery(undefined, { staleTime: 5 * 60_000 });
  const canMerge = !!options.data?.canMerge;
  const counts = q.data?.counts;

  const tabs: { id: Tab; label: string; badge?: { n: number; tone: "amber" | "red"; suffix?: string } }[] = [
    { id: "suggestions", label: "Sugestões para juntar", badge: counts ? { n: counts.suggestions, tone: "amber" } : undefined },
    { id: "generic", label: "Sem email próprio" },
    { id: "noEmail", label: "Reservas sem email", badge: counts ? { n: counts.noEmail, tone: "red", suffix: "em 3 dias" } : undefined },
    { id: "merges", label: "Juntas recentemente" },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href="/clientes" className="inline-flex items-center gap-1 text-[13px] text-primary hover:underline"><ChevronLeft className="h-3.5 w-3.5" />Clientes</Link>
        <h1 className="mt-1 font-display text-2xl font-bold tracking-[-0.02em]">Rever fichas</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">O CRM junta sozinho, todas as madrugadas (depois das sugestões das 05:15), as fichas com o mesmo nome e o mesmo telefone, email ou NIF. Aqui ficam só os casos duvidosos. Nada se junta só pelo nome; juntar e separar ficam no registo, com quem e quando.</p>
        {canMerge && <AutoMergeButton onDone={() => q.refetch()} />}
      </div>

      <div className="flex gap-1 overflow-x-auto border-b">
        {tabs.map((t) => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)}
            className={cn("-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-[3px] px-3 py-3 text-[13px]", tab === t.id ? "border-primary font-bold text-primary" : "border-transparent font-semibold hover:text-primary")}>
            {t.label}
            {t.badge && t.badge.n > 0 && (
              <Pill className={t.badge.tone === "red" ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200" : "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"}>
                {num(t.badge.n)}{t.badge.suffix ? ` ${t.badge.suffix}` : ""}
              </Pill>
            )}
          </button>
        ))}
      </div>

      {q.isLoading && <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}
      {q.error && <p className="text-sm text-destructive">{q.error.message}</p>}

      {q.data?.tab === "suggestions" && q.data.suggestions && (
        <Suggestions data={q.data.suggestions} canMerge={canMerge} offset={offset} setOffset={setOffset} refetch={() => q.refetch()} />
      )}
      {q.data?.tab === "generic" && q.data.generic && (
        <GenericEmails data={q.data.generic} offset={offset} setOffset={setOffset} refetch={() => q.refetch()} />
      )}
      {q.data?.tab === "noEmail" && q.data.upcoming && <NoEmail rows={q.data.upcoming} />}
      {q.data?.tab === "merges" && q.data.merges && <Merges rows={q.data.merges} canMerge={canMerge} refetch={() => q.refetch()} />}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="rounded-[10px] border bg-card py-12 text-center text-sm text-muted-foreground">{text}</div>;
}

function Pager({ total, offset, size, setOffset }: { total: number; offset: number; size: number; setOffset: (n: number) => void }) {
  if (total <= size) return null;
  return (
    <div className="flex items-center justify-end gap-2 text-[13px]">
      <span className="text-muted-foreground">{num(offset + 1)}–{num(Math.min(total, offset + size))} de {num(total)}</span>
      <Button size="icon" variant="outline" className="h-8 w-8" aria-label="Anteriores" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - size))}><ChevronLeft className="h-4 w-4" /></Button>
      <Button size="icon" variant="outline" className="h-8 w-8" aria-label="Seguintes" disabled={offset + size >= total} onClick={() => setOffset(offset + size)}><ChevronRight className="h-4 w-4" /></Button>
    </div>
  );
}

// ─── Sugestões para juntar ──────────────────────────────────────────────────

type SugData = CrmSuggestions;
type Sug = SugData["rows"][number];
type Side = NonNullable<Sug["keep"]>;

function Suggestions({ data, canMerge, offset, setOffset, refetch }: { data: SugData; canMerge: boolean; offset: number; setOffset: (n: number) => void; refetch: () => void }) {
  const [selId, setSelId] = useState<number | null>(null);
  const sel = data.rows.find((r) => r.id === selId) ?? data.rows[0] ?? null;
  if (!sel) return <Empty text="Não há sugestões por rever." />;
  const more = data.rows.filter((r) => r.id !== sel.id);
  return (
    <div className="flex flex-col gap-4">
      <SuggestionCompare key={sel.id} s={sel} canMerge={canMerge} onDone={() => { setSelId(null); refetch(); }} />
      {more.length > 0 && (
        <div className="flex flex-col gap-2.5 rounded-[10px] border bg-card p-4">
          <span className="font-display text-[15px] font-bold">Mais sugestões</span>
          {more.map((m) => (
            <div key={m.id} className="flex items-center gap-2.5 rounded-lg border p-2.5">
              <Pill className="w-11 justify-center bg-secondary text-secondary-foreground">{m.score}</Pill>
              <span className="min-w-0 flex-1 text-[13px]">
                <strong>{m.keep?.name ?? "?"} ↔ {m.absorb?.name ?? "?"}</strong><br />
                <span className="text-xs text-muted-foreground">{m.reasons.map((r) => r.label).join(", ")}</span>
              </span>
              <Button size="sm" variant="outline" className="h-[30px]" onClick={() => { setSelId(m.id); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Rever</Button>
            </div>
          ))}
        </div>
      )}
      <Pager total={data.total} offset={offset} size={PAGE} setOffset={setOffset} />
    </div>
  );
}

function SuggestionCompare({ s, canMerge, onDone }: { s: Sug; canMerge: boolean; onDone: () => void }) {
  const [swap, setSwap] = useState(false);
  const keep = (swap ? s.absorb : s.keep) as Side | null;
  const absorb = (swap ? s.keep : s.absorb) as Side | null;
  const merge = trpc.crm.merge.useMutation({ onSuccess: () => { toast.success("Fichas juntas"); onDone(); }, onError: (e) => toast.error(e.message) });
  const dismiss = trpc.crm.dismissSuggestion.useMutation({ onSuccess: () => { toast.success("Sugestão descartada"); onDone(); }, onError: (e) => toast.error(e.message) });
  if (!keep || !absorb) return null;

  const same = (a: string[], b: string[]) => a.some((x) => b.includes(x));
  const rows: { field: string; a: string; b: string; match: boolean | null }[] = [
    { field: "Nome", a: keep.name ?? "—", b: absorb.name ?? "—", match: null },
    { field: "Emails", a: keep.emails.join(", ") || "—", b: absorb.emails.join(", ") || "—", match: keep.emails.length && absorb.emails.length ? same(keep.emails, absorb.emails) : null },
    { field: "Telefones", a: keep.phones.map(fmtPhone).join(", ") || "—", b: absorb.phones.map(fmtPhone).join(", ") || "—", match: keep.phones.length && absorb.phones.length ? same(keep.phones, absorb.phones) : null },
    { field: "Carros", a: keep.vehicles.join(" / ") || "—", b: absorb.vehicles.join(" / ") || "—", match: null },
    { field: "NIF", a: keep.nif ?? "—", b: absorb.nif ?? "—", match: keep.nif && absorb.nif ? keep.nif === absorb.nif : null },
    { field: "Reservas", a: num(keep.bookings), b: num(absorb.bookings), match: null },
    { field: "Última vinda", a: `${shortDate(keep.lastVisit)} ${relDays(keep.lastVisit) ? `(${relDays(keep.lastVisit)})` : ""}`, b: `${shortDate(absorb.lastVisit)} ${relDays(absorb.lastVisit) ? `(${relDays(absorb.lastVisit)})` : ""}`, match: null },
    { field: "Origem", a: keep.origin ?? "—", b: absorb.origin ?? "—", match: null },
  ];
  const cellTone = (m: boolean | null) => (m === true ? "bg-emerald-50 dark:bg-emerald-950/30" : m === false ? "bg-amber-50 dark:bg-amber-950/30" : "bg-muted");

  return (
    <div className="flex flex-col gap-3.5 rounded-[10px] border bg-card p-[18px]">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="flex-1 font-display text-base font-bold">{keep.name ?? "Sem nome"} ↔ {absorb.name ?? "Sem nome"}</span>
        <Pill className="h-[26px] bg-[#0e2957] text-xs text-white dark:bg-[#1f6be0]">Semelhança {s.score} %</Pill>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {s.reasons.map((r) => <Pill key={r.id} className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">{r.label}</Pill>)}
        {keep.emails.length > 0 && absorb.emails.length > 0 && !same(keep.emails, absorb.emails) && <Pill className="bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">email diferente</Pill>}
      </div>
      <div className="overflow-x-auto">
        <div className="grid min-w-[560px] grid-cols-[140px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5">
          <span />
          <Link href={`/clientes/${keep.id}`} className="flex items-center gap-2 hover:underline"><ClientAvatar name={keep.name} photoUrl={keep.photoUrl} size={24} /><Lbl>Fica · N.º {keep.id.toLocaleString("pt-PT")}</Lbl></Link>
          <Link href={`/clientes/${absorb.id}`} className="flex items-center gap-2 hover:underline"><ClientAvatar name={absorb.name} photoUrl={absorb.photoUrl} size={24} /><Lbl>Junta-se · N.º {absorb.id.toLocaleString("pt-PT")}</Lbl></Link>
          {rows.map((r) => (
            <div key={r.field} className="contents">
              <span className="text-xs font-bold text-muted-foreground">{r.field}</span>
              <span className={cn("rounded-md px-2.5 py-1.5 text-[13px]", cellTone(r.match))}>{r.a}</span>
              <span className={cn("rounded-md px-2.5 py-1.5 text-[13px]", cellTone(r.match))}>{r.b}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t pt-2.5">
        <span className="min-w-[240px] flex-1 text-xs text-muted-foreground">
          Ao juntar, os emails, telefones, carros e reservas da ficha {absorb.id.toLocaleString("pt-PT")} passam para a {keep.id.toLocaleString("pt-PT")}. Fica guardado o que foi movido, para se poder separar.
        </span>
        <Button variant="outline" onClick={() => setSwap((x) => !x)}><ArrowLeftRight className="h-4 w-4" />Trocar qual fica</Button>
        <Button variant="outline" disabled={dismiss.isPending} onClick={() => dismiss.mutate({ id: s.id })}>Descartar</Button>
        <Button variant="outline" asChild><Link href={`/clientes/${keep.id}`}>Ver fichas</Link></Button>
        {canMerge && (
          <Button disabled={merge.isPending} onClick={() => merge.mutate({ survivorId: keep.id, mergedId: absorb.id, reason: s.reasons.map((r) => r.label).join(", ") })}>
            {merge.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Juntar
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── Emails estranhos ───────────────────────────────────────────────────────

type GenData = CrmGenericEmails;

function GenericEmails({ data, offset, setOffset, refetch }: { data: GenData; offset: number; setOffset: (n: number) => void; refetch: () => void }) {
  if (!data.rows.length) return <Empty text="Não há fichas com emails estranhos." />;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted-foreground">Fichas cujo único email é de balcão ou de agregador (partilhado por muitos clientes diferentes). <strong>Não é preciso fazer nada</strong>: esse email já não liga reservas nem conta como email do cliente. Se quiseres, procura o email verdadeiro na nossa caixa.</p>
      {data.rows.map((r) => <GenericRow key={r.id} r={r} onDone={refetch} />)}
      <Pager total={data.total} offset={offset} size={PAGE} setOffset={setOffset} />
    </div>
  );
}

function GenericRow({ r, onDone }: { r: GenData["rows"][number]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const file = trpc.crm.get.useQuery({ id: r.id }, { enabled: open, staleTime: 60_000 });
  const f = isCrmFile(file.data) ? file.data : null;
  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="min-w-0 flex-1">
          <Link href={`/clientes/${r.id}`} className="font-bold hover:underline">{r.name ?? "Sem nome"}</Link>
          <span className="text-muted-foreground"> · N.º {r.id.toLocaleString("pt-PT")}{r.plate ? ` · ${r.plate}` : ""}{r.phone ? ` · ${fmtPhone(r.phone)}` : ""} · {num(r.bookings)} {r.bookings === 1 ? "reserva" : "reservas"}{r.lastVisit ? `, a última ${shortDate(r.lastVisit)}` : ""}</span>
        </span>
        {r.genericEmail && <Pill className="bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">{r.genericEmail}</Pill>}
      </div>
      {!open ? (
        <div><Button size="sm" variant="outline" className="h-[30px]" onClick={() => setOpen(true)}>Procurar na nossa caixa</Button></div>
      ) : f ? (
        <FindEmailButton autoOpen clientId={r.id} genericIds={f.emails.filter((e) => e.generic).map((e) => e.id)} canEdit={f.canEdit} onUsed={onDone} />
      ) : <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
    </div>
  );
}

// ─── Reservas sem email ─────────────────────────────────────────────────────

type NoEmailRow = CrmUpcomingNoEmail;

function NoEmail({ rows }: { rows: NoEmailRow[] }) {
  if (!rows.length) return <Empty text="Nenhuma reserva nos próximos 3 dias de clientes sem email." />;
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-[13px] text-muted-foreground">Clientes sem email que chegam nos próximos 3 dias. Pedir o email antes de o cliente sair e acrescentá-lo na ficha.</p>
      {rows.map((r) => (
        <div key={r.bookingId} className="flex flex-wrap items-center gap-2.5 rounded-lg border border-red-200 bg-red-50/60 p-2.5 text-[13px] dark:border-red-900 dark:bg-red-950/30">
          <span className="min-w-0 flex-1">
            <Link href={`/clientes/${r.id}`} className="font-bold hover:underline">{r.name ?? "Sem nome"}</Link>
            {r.plate && <span className="font-mono text-xs"> · {r.plate}</span>}
            {" · entra "}{shortDateTime(r.checkIn)} ({relDays(r.checkIn)}){r.park ? ` em ${r.park}` : ""}
            {r.phone && <span className="text-muted-foreground"> · {fmtPhone(r.phone)}</span>}
          </span>
          <Button size="sm" variant="outline" className="h-[30px]" asChild><Link href={`/clientes/${r.id}`}>Abrir ficha</Link></Button>
        </div>
      ))}
    </div>
  );
}

// ─── Juntas recentemente ────────────────────────────────────────────────────

type MergeRow = CrmMergeEvent;

function Merges({ rows, canMerge, refetch }: { rows: MergeRow[]; canMerge: boolean; refetch: () => void }) {
  const split = trpc.crm.split.useMutation({ onSuccess: () => { toast.success("Fichas separadas"); refetch(); }, onError: (e) => toast.error(e.message) });
  if (!rows.length) return <Empty text="Nenhuma ficha foi junta." />;
  return (
    <div className="overflow-x-auto rounded-[10px] border bg-card">
      {rows.map((r) => (
        <div key={r.id} className="flex flex-wrap items-center gap-3 border-t px-4 py-3 text-[13px] first:border-t-0">
          <span className="min-w-0 flex-1">
            <Link href={`/clientes/${r.mergedId}`} className="font-bold hover:underline">{r.mergedName ?? `N.º ${r.mergedId}`}</Link>
            {" juntou-se a "}
            <Link href={`/clientes/${r.survivorId}`} className="font-bold hover:underline">{r.survivorName ?? `N.º ${r.survivorId}`}</Link>
            <span className="block text-xs text-muted-foreground">{shortDateTime(r.mergedAt)}{r.byName ? ` · por ${r.byName}` : ""}{r.reason ? ` · ${r.reason}` : ""}</span>
          </span>
          {canMerge && <Button size="sm" variant="outline" disabled={split.isPending} onClick={() => split.mutate({ eventId: r.id })}><Undo2 className="h-3.5 w-3.5" />Separar</Button>}
        </div>
      ))}
    </div>
  );
}

function AutoMergeButton({ onDone }: { onDone: () => void }) {
  const m = trpc.crm.autoMergeNow.useMutation({
    onSuccess: (r) => { toast.success(r.merged ? `${r.merged} fichas juntas sozinhas (${r.skipped} ficam para rever).` : "Não havia casos óbvios para juntar."); onDone(); },
    onError: (e) => toast.error(e.message),
  });
  return (
    <button type="button" disabled={m.isPending} onClick={() => m.mutate()}
      className="mt-2 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] font-semibold hover:bg-muted disabled:opacity-50">
      {m.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}Juntar agora os óbvios
    </button>
  );
}
