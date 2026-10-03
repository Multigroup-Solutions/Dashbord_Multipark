/**
 * Rever fichas — CRM (Jorge, 27 set 2026; regras de identidade de 3 out 2026, lote 21c).
 *
 * O CRM junta sozinho o que as regras do dono resolvem (mesmo 1.º e último
 * nome + email/telefone/matrícula; nome diferente só com email E telefone) e,
 * se a IA estiver ligada, as dúvidas em que ela tem a certeza. Aqui a equipa
 * decide o resto:
 *   · sugestões para juntar — as duas fichas lado a lado, os avisos das regras
 *     e o parecer da IA; Juntar / Não é a mesma pessoa;
 *   · recusadas — "não é a mesma pessoa", com Desfazer;
 *   · emails estranhos (balcão/agregador) — procurar o verdadeiro na caixa;
 *   · reservas dos próximos 3 dias de clientes sem email — pedir à chegada;
 *   · juntas recentemente — por uma pessoa, pelas regras ou pela IA; Separar.
 * Juntar, recusar e separar ficam no registo das duas fichas, com quem e quando.
 */
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, ArrowLeftRight, Loader2, Sparkles, Undo2 } from "lucide-react";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { useConfirm } from "@/pages/training/shared";
import { FindEmailButton } from "@/components/crm/FindEmail";
import { isCrmFile, type CrmDismissed, type CrmGenericEmails, type CrmMerges, type CrmSuggestions, type CrmUpcomingNoEmail } from "@/components/crm/crmTypes";
import { ClientAvatar, Lbl, Pill, fmtPhone, num, relDays, shortDate, shortDateTime } from "@/components/crm/crmUi";

type Tab = "suggestions" | "dismissed" | "generic" | "noEmail" | "merges";
type SourceFilter = "all" | "ui" | "auto" | "ai";
const PAGE = 10;
const MERGES_PAGE = 30;

const AMBER = "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200";
const RED = "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200";
const GREEN = "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200";

export default function CrmReviewPage() {
  const [tab, setTab] = useState<Tab>("suggestions");
  const [offset, setOffset] = useState(0);
  const [source, setSource] = useState<SourceFilter>("all");
  useEffect(() => setOffset(0), [tab, source]);
  const q = trpc.crm.review.useQuery(
    { tab, offset, limit: tab === "merges" ? MERGES_PAGE : PAGE, ...(tab === "merges" ? { source } : {}) },
    { placeholderData: (p) => (p?.tab === tab ? p : undefined) },
  );
  const options = trpc.crm.options.useQuery(undefined, { staleTime: 5 * 60_000 });
  const canMerge = !!options.data?.canMerge;
  const canEdit = !!options.data?.canEdit;
  const counts = q.data?.counts;

  // a última página ficou vazia (juntou/recusou o último): o servidor devolve o offset certo
  const serverOffset = q.data && "suggestions" in q.data ? q.data.suggestions?.offset
    : q.data && "dismissed" in q.data ? q.data.dismissed?.offset
    : q.data && "merges" in q.data ? q.data.merges?.offset : undefined;
  useEffect(() => { if (serverOffset != null && serverOffset !== offset) setOffset(serverOffset); }, [serverOffset]); // eslint-disable-line react-hooks/exhaustive-deps

  const tabs: { id: Tab; label: string; badge?: { n: number | null; tone: "amber" | "red"; suffix?: string } }[] = [
    { id: "suggestions", label: "Sugestões para juntar", badge: counts ? { n: counts.suggestions, tone: "amber" } : undefined },
    { id: "dismissed", label: "Recusadas" },
    { id: "generic", label: "Sem email próprio" },
    { id: "noEmail", label: "Reservas sem email", badge: counts ? { n: counts.noEmail, tone: "red", suffix: "em 3 dias" } : undefined },
    { id: "merges", label: "Juntas recentemente" },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href="/clientes" className="inline-flex items-center gap-1 text-[13px] text-primary hover:underline"><ChevronLeft className="h-3.5 w-3.5" />Clientes</Link>
        <h1 className="mt-1 font-display text-2xl font-bold tracking-[-0.02em]">Rever fichas</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Todas as madrugadas o CRM junta sozinho as fichas com o mesmo 1.º e último nome e um dado igual (email, telefone ou matrícula), e as que têm o mesmo email <strong>e</strong> o mesmo telefone mesmo com outro nome. Nunca junta sozinho empresas, clientes Pro, emails genéricos (info@, reservas@…), dados que estão em mais de 2 fichas nem contribuintes diferentes. As dúvidas vão à IA, se estiver ligada, e o resto fica aqui. Juntar, recusar e separar ficam no registo das duas fichas.
        </p>
        {q.data?.canAutoMerge && <AutoMergeButton onDone={() => q.refetch()} />}
      </div>

      <div className="flex gap-1 overflow-x-auto border-b">
        {tabs.map((t) => (
          <button key={t.id} type="button" onClick={(e) => { setTab(t.id); e.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" }); }}
            className={cn("-mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-[3px] px-3 py-3 text-[13px]", tab === t.id ? "border-primary font-bold text-primary" : "border-transparent font-semibold hover:text-primary")}>
            {t.label}
            {t.badge && t.badge.n == null && (
              <Pill className="bg-muted text-muted-foreground" title="Não foi possível ler as reservas da Multipark">—</Pill>
            )}
            {t.badge && t.badge.n != null && t.badge.n > 0 && (
              <Pill className={t.badge.tone === "red" ? RED : AMBER}>
                {num(t.badge.n)}{t.badge.suffix ? ` ${t.badge.suffix}` : ""}
              </Pill>
            )}
          </button>
        ))}
      </div>

      {q.isLoading && <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}
      {q.error && <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="esta lista" />}

      {q.data?.tab === "suggestions" && q.data.suggestions && (
        <Suggestions data={q.data.suggestions} canMerge={canMerge} canEdit={canEdit} setOffset={setOffset} refetch={() => q.refetch()} />
      )}
      {q.data?.tab === "dismissed" && q.data.dismissed && (
        <Dismissed data={q.data.dismissed} canEdit={canEdit} setOffset={setOffset} refetch={() => q.refetch()} />
      )}
      {q.data?.tab === "generic" && q.data.generic && (
        <GenericEmails data={q.data.generic} offset={offset} setOffset={setOffset} refetch={() => q.refetch()} />
      )}
      {q.data?.tab === "noEmail" && q.data.upcoming && <NoEmail rows={q.data.upcoming} />}
      {q.data?.tab === "merges" && q.data.merges && (
        <Merges data={q.data.merges} source={source} setSource={setSource} setOffset={setOffset} canMerge={canMerge} refetch={() => q.refetch()} />
      )}
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

const BLOCKING = new Set(["nif_diff", "company", "pro"]);

/** Avisos das regras (vermelho = nunca se junta sozinho) e o parecer da IA. */
function SignalPills({ s }: { s: Pick<Sug, "signals" | "ai"> }) {
  return (
    <>
      {s.signals.map((x) => <Pill key={x.id} className={BLOCKING.has(x.id) ? RED : AMBER}>{x.label}</Pill>)}
      {s.ai && (
        <Pill className={cn("h-auto min-h-[22px] whitespace-normal py-0.5", s.ai.verdict === "same" ? GREEN : s.ai.verdict === "diff" ? RED : "bg-secondary text-secondary-foreground")}
          title={s.ai.reason ?? undefined}>
          <Sparkles className="h-3 w-3" aria-hidden />IA: {s.ai.label}{s.ai.confidence != null ? ` (${s.ai.confidence} %)` : ""}
        </Pill>
      )}
    </>
  );
}

function Suggestions({ data, canMerge, canEdit, setOffset, refetch }: { data: SugData; canMerge: boolean; canEdit: boolean; setOffset: (n: number) => void; refetch: () => void }) {
  const [selId, setSelId] = useState<number | null>(null);
  const sel = data.rows.find((r) => r.id === selId) ?? data.rows[0] ?? null;
  if (!sel) return <Empty text="Não há sugestões por rever." />;
  const more = data.rows.filter((r) => r.id !== sel.id);
  return (
    <div className="flex flex-col gap-4">
      <SuggestionCompare key={sel.id} s={sel} canMerge={canMerge} canEdit={canEdit} onDone={() => { setSelId(null); refetch(); }} />
      {more.length > 0 && (
        <div className="flex flex-col gap-2.5 rounded-[10px] border bg-card p-4">
          <span className="font-display text-[15px] font-bold">Mais sugestões</span>
          {more.map((m) => (
            <div key={m.id} className="flex flex-wrap items-center gap-2.5 rounded-lg border p-2.5">
              <Pill className="w-11 justify-center bg-secondary text-secondary-foreground">{m.score}</Pill>
              <span className="min-w-0 flex-1 text-[13px]">
                <strong className="break-words">{m.keep?.name ?? "?"} ↔ {m.absorb?.name ?? "?"}</strong><br />
                <span className="text-xs text-muted-foreground">{m.reasons.map((r) => r.label).join(", ")}</span>
              </span>
              <Button size="sm" variant="outline" className="h-[30px]" onClick={() => { setSelId(m.id); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Rever</Button>
              {(m.signals.length > 0 || m.ai) && <div className="flex min-w-0 basis-full flex-wrap gap-1"><SignalPills s={m} /></div>}
            </div>
          ))}
        </div>
      )}
      <Pager total={data.total} offset={data.offset} size={PAGE} setOffset={setOffset} />
    </div>
  );
}

function SuggestionCompare({ s, canMerge, canEdit, onDone }: { s: Sug; canMerge: boolean; canEdit: boolean; onDone: () => void }) {
  const [swap, setSwap] = useState(false);
  const [ask, confirmUi] = useConfirm();
  const keep = (swap ? s.absorb : s.keep) as Side | null;
  const absorb = (swap ? s.keep : s.absorb) as Side | null;
  const merge = trpc.crm.merge.useMutation({ onSuccess: () => { toast.success("Fichas juntas"); onDone(); }, onError: (e) => { toast.error(e.message); onDone(); } });
  const dismiss = trpc.crm.dismissSuggestion.useMutation({ onSuccess: () => { toast.success("Ficou registado: não é a mesma pessoa"); onDone(); }, onError: (e) => { toast.error(e.message); onDone(); } });
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
  const notSame = async () => {
    const ok = await ask({
      title: "Não é a mesma pessoa?",
      description: `${keep.name ?? "Sem nome"} e ${absorb.name ?? "Sem nome"} ficam separadas: o CRM não as volta a sugerir nem as junta sozinho (também depois de juntar uma delas a outra ficha). Desfaz-se em "Recusadas".`,
      confirmLabel: "Não é a mesma pessoa",
    });
    if (ok) dismiss.mutate({ id: s.id });
  };

  return (
    <div className="flex flex-col gap-3.5 rounded-[10px] border bg-card p-4 sm:p-[18px]">
      {confirmUi}
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="min-w-0 flex-1 break-words font-display text-base font-bold">{keep.name ?? "Sem nome"} ↔ {absorb.name ?? "Sem nome"}</span>
        <Pill className="h-[26px] bg-[#0e2957] text-xs text-white dark:bg-[#1f6be0]">Semelhança {s.score} %</Pill>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {s.reasons.map((r) => <Pill key={r.id} className={GREEN}>{r.label}</Pill>)}
        {keep.emails.length > 0 && absorb.emails.length > 0 && !same(keep.emails, absorb.emails) && <Pill className={AMBER}>email diferente</Pill>}
        <SignalPills s={s} />
      </div>
      {s.ai?.reason && <p className="text-xs text-muted-foreground"><Sparkles className="mr-1 inline h-3 w-3" aria-hidden />Parecer da IA: {s.ai.reason}</p>}
      <div className="grid grid-cols-2 items-center gap-x-2 gap-y-1.5 sm:grid-cols-[140px_minmax(0,1fr)_minmax(0,1fr)] sm:gap-x-3">
        <span className="hidden sm:block" />
        <Link href={`/clientes/${keep.id}`} className="flex min-w-0 items-center gap-2 hover:underline"><ClientAvatar name={keep.name} photoUrl={keep.photoUrl} size={24} /><Lbl>Fica · N.º {keep.id.toLocaleString("pt-PT")}</Lbl></Link>
        <Link href={`/clientes/${absorb.id}`} className="flex min-w-0 items-center gap-2 hover:underline"><ClientAvatar name={absorb.name} photoUrl={absorb.photoUrl} size={24} /><Lbl>Junta-se · N.º {absorb.id.toLocaleString("pt-PT")}</Lbl></Link>
        {rows.map((r) => (
          <div key={r.field} className="contents">
            <span className="col-span-2 mt-1 text-xs font-bold text-muted-foreground sm:col-span-1 sm:mt-0">{r.field}</span>
            <span className={cn("min-w-0 break-words rounded-md px-2.5 py-1.5 text-[13px]", cellTone(r.match))}>{r.a}</span>
            <span className={cn("min-w-0 break-words rounded-md px-2.5 py-1.5 text-[13px]", cellTone(r.match))}>{r.b}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t pt-2.5">
        <span className="min-w-0 basis-full text-xs text-muted-foreground sm:basis-auto sm:flex-1">
          Ao juntar, os emails, telefones, carros e reservas da ficha {absorb.id.toLocaleString("pt-PT")} passam para a {keep.id.toLocaleString("pt-PT")}. Fica guardado o que foi movido, para se poder separar.
        </span>
        <Button variant="outline" onClick={() => setSwap((x) => !x)}><ArrowLeftRight className="h-4 w-4" />Trocar qual fica</Button>
        {canEdit && <Button variant="outline" disabled={dismiss.isPending || merge.isPending} onClick={notSame}>Não é a mesma pessoa</Button>}
        <Button variant="outline" asChild><Link href={`/clientes/${keep.id}`}>Ver fichas</Link></Button>
        {canMerge && (
          <Button disabled={merge.isPending || dismiss.isPending} onClick={() => merge.mutate({ survivorId: keep.id, mergedId: absorb.id, suggestionId: s.id, reason: s.reasons.map((r) => r.label).join(", ") })}>
            {merge.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Juntar
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── Recusadas ──────────────────────────────────────────────────────────────

function Dismissed({ data, canEdit, setOffset, refetch }: { data: CrmDismissed; canEdit: boolean; setOffset: (n: number) => void; refetch: () => void }) {
  const undo = trpc.crm.undismissSuggestion.useMutation({
    onSuccess: (r) => { toast.success(r.status === "pending" ? "A sugestão voltou a \"Sugestões para juntar\"" : "Recusa desfeita (uma das fichas já não existe sozinha)"); refetch(); },
    onError: (e) => { toast.error(e.message); refetch(); },
  });
  if (!data.rows.length) return <Empty text="Ninguém recusou sugestões." />;
  const who = (x: CrmDismissed["rows"][number]["a"]) => (
    <Link href={`/clientes/${x.id}`} className="font-bold hover:underline">{x.name ?? `N.º ${x.id.toLocaleString("pt-PT")}`}{!x.active && <span className="font-normal text-muted-foreground"> (junta a outra)</span>}</Link>
  );
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted-foreground">Pares que alguém disse que <strong>não são a mesma pessoa</strong> (ou que se separaram). O CRM não os volta a sugerir nem os junta sozinho — também quando uma das fichas é junta a outra. Desfazer põe o par outra vez nas sugestões.</p>
      <div className="rounded-[10px] border bg-card">
        {data.rows.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-3 border-t px-4 py-3 text-[13px] first:border-t-0">
            <span className="min-w-0 flex-1 break-words">
              {who(r.a)}{" ↔ "}{who(r.b)}
              <span className="block text-xs text-muted-foreground">
                {r.reasons.length ? `${r.reasons.join(", ")} · ` : ""}recusada{r.decidedAt ? ` a ${shortDateTime(r.decidedAt)}` : ""}{r.byName ? ` por ${r.byName}` : ""}
              </span>
              {r.signals.length > 0 && <span className="mt-1 flex flex-wrap gap-1">{r.signals.map((x) => <Pill key={x.id} className={BLOCKING.has(x.id) ? RED : AMBER}>{x.label}</Pill>)}</span>}
            </span>
            {canEdit && <Button size="sm" variant="outline" disabled={undo.isPending} onClick={() => undo.mutate({ id: r.id })}><Undo2 className="h-3.5 w-3.5" />Desfazer</Button>}
          </div>
        ))}
      </div>
      <Pager total={data.total} offset={data.offset} size={PAGE} setOffset={setOffset} />
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
        <span className="min-w-0 flex-1 break-words">
          <Link href={`/clientes/${r.id}`} className="font-bold hover:underline">{r.name ?? "Sem nome"}</Link>
          <span className="text-muted-foreground"> · N.º {r.id.toLocaleString("pt-PT")}{r.plate ? ` · ${r.plate}` : ""}{r.phone ? ` · ${fmtPhone(r.phone)}` : ""} · {num(r.bookings)} {r.bookings === 1 ? "reserva" : "reservas"}{r.lastVisit ? `, a última ${shortDate(r.lastVisit)}` : ""}</span>
        </span>
        {r.genericEmail && <span className={cn(AMBER, "max-w-full break-all rounded-full px-2 py-0.5 text-[11px] font-bold")}>{r.genericEmail}</span>}
      </div>
      {!open ? (
        <div><Button size="sm" variant="outline" className="h-[30px]" onClick={() => setOpen(true)}>Procurar na nossa caixa</Button></div>
      ) : file.error ? (
        <QueryErrorNote error={file.error} onRetry={() => file.refetch()} retrying={file.isFetching} what="a ficha" />
      ) : f ? (
        <FindEmailButton autoOpen clientId={r.id} hasGeneric={f.emails.some((e) => e.generic)} canEdit={f.canEdit} onUsed={onDone} />
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
          <span className="min-w-0 flex-1 break-words">
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

const SOURCE_LABEL: Record<"ui" | "auto" | "ai", string> = { ui: "à mão", auto: "regras", ai: "IA" };

function Merges({ data, source, setSource, setOffset, canMerge, refetch }: {
  data: CrmMerges; source: SourceFilter; setSource: (s: SourceFilter) => void; setOffset: (n: number) => void; canMerge: boolean; refetch: () => void;
}) {
  const [ask, confirmUi] = useConfirm();
  const split = trpc.crm.split.useMutation({ onSuccess: () => { toast.success("Fichas separadas (ficam como recusadas)"); refetch(); }, onError: (e) => { toast.error(e.message); refetch(); } });
  const doSplit = async (r: CrmMerges["rows"][number]) => {
    const ok = await ask({
      title: "Separar estas fichas?",
      description: `${r.mergedName ?? `N.º ${r.mergedId}`} volta a ser uma ficha à parte, com o que tinha. O par fica em "Recusadas" e o CRM não o volta a juntar sozinho.`,
      confirmLabel: "Separar",
    });
    if (ok) split.mutate({ eventId: r.id });
  };
  const filters: { id: SourceFilter; label: string }[] = [
    { id: "all", label: "Todas" }, { id: "ui", label: "À mão" }, { id: "auto", label: "Pelas regras" }, { id: "ai", label: "Pela IA" },
  ];
  return (
    <div className="flex flex-col gap-3">
      {confirmUi}
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quem juntou">
        {filters.map((f) => (
          <Button key={f.id} size="sm" variant={source === f.id ? "selected" : "outline"} className="h-[30px]" aria-pressed={source === f.id} onClick={() => setSource(f.id)}>{f.label}</Button>
        ))}
      </div>
      {!data.rows.length ? <Empty text={source === "all" ? "Nenhuma ficha foi junta." : "Nenhuma ficha foi junta desta forma."} /> : (
        <div className="rounded-[10px] border bg-card">
          {data.rows.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-3 border-t px-4 py-3 text-[13px] first:border-t-0">
              <span className="min-w-0 flex-1 break-words">
                <Link href={`/clientes/${r.mergedId}`} className="font-bold hover:underline">{r.mergedName ?? `N.º ${r.mergedId}`}</Link>
                {" juntou-se a "}
                <Link href={`/clientes/${r.survivorId}`} className="font-bold hover:underline">{r.survivorName ?? `N.º ${r.survivorId}`}</Link>
                <span className="block text-xs text-muted-foreground">
                  <Pill className={cn("mr-1", r.source === "ai" ? GREEN : r.source === "auto" ? "bg-secondary text-secondary-foreground" : "bg-muted text-muted-foreground")}>{SOURCE_LABEL[r.source]}</Pill>
                  {shortDateTime(r.mergedAt)}{r.byName ? ` · por ${r.byName}` : ""}{r.reason ? ` · ${r.reason}` : ""}
                </span>
              </span>
              {canMerge && <Button size="sm" variant="outline" disabled={split.isPending} onClick={() => doSplit(r)}><Undo2 className="h-3.5 w-3.5" />Separar</Button>}
            </div>
          ))}
        </div>
      )}
      <Pager total={data.total} offset={data.offset} size={MERGES_PAGE} setOffset={setOffset} />
    </div>
  );
}

function AutoMergeButton({ onDone }: { onDone: () => void }) {
  const m = trpc.crm.autoMergeNow.useMutation({
    onSuccess: (r) => {
      const n = r.merged + r.mergedByAi;
      toast.success(n
        ? `${n} fichas juntas sozinhas (${r.merged} pelas regras${r.mergedByAi ? `, ${r.mergedByAi} pela IA` : ""}); ${r.skipped} ficam para rever.`
        : `Não havia casos certos para juntar${r.aiChecked ? ` (a IA viu ${r.aiChecked})` : ""}.`);
      if (r.aiError) toast.warning("A IA não respondeu a todas as dúvidas: ficam para a próxima vez.");
      onDone();
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <button type="button" disabled={m.isPending} onClick={() => m.mutate()}
      className="mt-2 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] font-semibold hover:bg-muted disabled:opacity-50">
      {m.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}Juntar agora
    </button>
  );
}
