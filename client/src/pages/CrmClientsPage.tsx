/**
 * Clientes — CRM (Jorge, 27 set 2026; desenho "Clientes — lista e filtros").
 *
 * Todas as fichas de clientes (server/crm/*): barra única de pesquisa em que
 * se escolhe o campo, filtros em grupos (segmento, cidade, região, país,
 * parque, país do cliente, canal, parceiro, Pro/particular, avisos), regras
 * específicas, filtros guardados, ordem e intervalo, cartões ou lista.
 *
 * `/clientes?email=…` (ligações antigas das reservas, email e WhatsApp) abre
 * a ficha desse email; enquanto o CRM não tiver a ficha, mostra a antiga.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { can } from "@shared/access";
import { useAuth } from "@/_core/hooks/useAuth";
import { usePersistedState } from "@/hooks/usePersistedState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, ChevronLeft, ChevronRight, Loader2, Plus, Search, UsersRound } from "lucide-react";
import { ALERTS, SEARCH_FIELDS, SEGMENTS, SORTS, type CrmGroups, type CrmSort, type SearchField } from "@shared/crmFilters";
import { FilterGroup, RulesEditor, SavedFiltersMenu, SelButton, ruleText, type Opt, type RulesState } from "@/components/crm/CrmFilters";
import { ALERT_CLASS, ClientAvatar, ColorSwatch, Pill, SegmentPill, eur, mainSegment, num, shortDate } from "@/components/crm/crmUi";
import type { CrmListRow } from "@/components/crm/crmTypes";
import LegacyClientsPage from "./ClientsPage";

type ViewState = {
  tab: "clients" | "pro";
  search: { text: string; field: SearchField } | null;
  groups: CrmGroups;
  rules: RulesState | null;
  sort: CrmSort;
  dir: "asc" | "desc";
  limit: number;
  view: "cards" | "list";
};
const DEFAULT_VIEW: ViewState = { tab: "clients", search: null, groups: {}, rules: null, sort: "lastVisit", dir: "desc", limit: 24, view: "cards" };
const PAGE_SIZES = [24, 48, 96, 200];

const GROUP_LABEL: Record<keyof CrmGroups, string> = {
  segment: "Segmento", city: "Cidade", region: "Região", country: "País", park: "Parque", clientCountry: "País do cliente",
  channel: "Canal de origem", partner: "Parceiro", kind: "Pro ou particular", alerts: "Avisos",
};
const GROUP_ORDER: (keyof CrmGroups)[] = ["segment", "city", "region", "country", "park", "clientCountry", "channel", "partner", "kind", "alerts"];

export default function CrmClientsPage() {
  const email = new URLSearchParams(useSearch()).get("email");
  if (email) return <OpenByEmail email={email} />;
  return <CrmList />;
}

/** Ligações antigas `/clientes?email=` → ficha nova (ou a antiga, se ainda não existir). */
function OpenByEmail({ email }: { email: string }) {
  const [, navigate] = useLocation();
  const q = trpc.crm.list.useQuery({ search: { text: email, field: "email" }, limit: 2 }, { retry: false });
  const id = q.data?.rows.length === 1 ? q.data.rows[0].id : null;
  useEffect(() => { if (id) navigate(`/clientes/${id}`, { replace: true }); }, [id, navigate]);
  if (q.isLoading || id) return <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  if (q.data && q.data.rows.length > 1) return <CrmList initialSearch={{ text: email, field: "email" }} />;
  return <LegacyClientsPage />;
}

function CrmList({ initialSearch }: { initialSearch?: ViewState["search"] }) {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const [st, setSt] = usePersistedState<ViewState>("crm.list", DEFAULT_VIEW);
  const s: ViewState = { ...DEFAULT_VIEW, ...st };
  const patch = (p: Partial<ViewState>) => setSt((prev) => ({ ...DEFAULT_VIEW, ...prev, ...p }));
  const [offset, setOffset] = useState(0);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [saveReq, setSaveReq] = useState(false);
  const [newOpen, setNewOpen] = useState(false);

  // pesquisa: o texto aplica-se ao fim de 350 ms, no campo escolhido
  const [text, setText] = useState(initialSearch?.text ?? s.search?.text ?? "");
  const [field, setField] = useState<SearchField>(initialSearch?.field ?? s.search?.field ?? "all");
  const [focus, setFocus] = useState(false);
  useEffect(() => { if (initialSearch) patch({ search: initialSearch }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = setTimeout(() => {
      const next = text.trim() ? { text: text.trim(), field } : null;
      if (JSON.stringify(next) !== JSON.stringify(s.search ?? null)) patch({ search: next });
    }, 350);
    return () => clearTimeout(t);
  }, [text, field]); // eslint-disable-line react-hooks/exhaustive-deps

  const query = { tab: s.tab, search: s.search, groups: s.groups, rules: s.rules, sort: s.sort, dir: s.dir, limit: s.limit };
  const qKey = JSON.stringify(query);
  useEffect(() => setOffset(0), [qKey]);

  const options = trpc.crm.options.useQuery(undefined, { staleTime: 5 * 60_000 });
  const list = trpc.crm.list.useQuery({ ...query, offset }, { placeholderData: (p) => p });
  const review = trpc.crm.review.useQuery({ tab: "suggestions", limit: 1 }, { staleTime: 60_000, retry: false });
  const facets = trpc.crm.facets.useQuery({ ...query, search: null, text: s.search?.text ?? "" }, {
    enabled: focus && (s.search?.text?.length ?? 0) >= 2, staleTime: 30_000, placeholderData: (p) => p,
  });
  const saved = trpc.crm.savedFilters.useQuery(undefined, { staleTime: 60_000 });

  // filtro por defeito ("Abrir com este") numa sessão nova
  const appliedDefault = useRef(false);
  useEffect(() => {
    if (appliedDefault.current || !saved.data || initialSearch) return;
    appliedDefault.current = true;
    const def = saved.data.find((f) => f.isDefault);
    if (def && JSON.stringify(st) === JSON.stringify(DEFAULT_VIEW)) applySaved(def.payload as Partial<ViewState>);
  }, [saved.data]); // eslint-disable-line react-hooks/exhaustive-deps

  function applySaved(p: Partial<ViewState>) {
    const next = { ...DEFAULT_VIEW, ...p, view: s.view };
    setSt(next);
    setText(next.search?.text ?? "");
    setField(next.search?.field ?? "all");
  }

  const o = options.data;
  const canSeeTotals = !!o?.canSeeTotals;
  const groupOptions: Record<keyof CrmGroups, Opt[]> = useMemo(() => ({
    segment: SEGMENTS.filter((x) => x.id !== "vip" || canSeeTotals).map((x) => ({ value: x.id, label: x.label })),
    city: (o?.cities ?? []).map((x) => ({ value: x.value, label: x.label, n: x.n })),
    region: (o?.regions ?? []).map((x) => ({ value: x.value, label: x.label })),
    country: (o?.countries ?? []).map((x) => ({ value: x.value, label: x.label })),
    park: (o?.parks ?? []).map((x) => ({ value: x.value, label: x.label, hint: x.city, n: x.n })),
    clientCountry: (o?.clientCountries ?? []).map((x) => ({ value: x.value, label: x.label, n: x.n })),
    channel: (o?.channels ?? []).map((x) => ({ value: x.value, label: x.label, n: x.n })),
    partner: (o?.partners ?? []).map((x) => ({ value: x.value, label: x.label, n: x.n })),
    kind: [{ value: "pro", label: "Pro" }, { value: "private", label: "Particular" }],
    alerts: ALERTS.map((x) => ({ value: x.id, label: x.label })),
  }), [o, canSeeTotals]);
  const ruleFields = o?.ruleFields ?? [];

  // chips do filtro ativo
  const chips: { key: string; label: string; remove: () => void }[] = [];
  if (s.search) {
    const f = SEARCH_FIELDS.find((x) => x.id === s.search!.field);
    chips.push({ key: "q", label: s.search.field === "all" ? `«${s.search.text}»` : `${f?.label}: «${s.search.text}»`, remove: () => { setText(""); patch({ search: null }); } });
  }
  for (const g of GROUP_ORDER) {
    const vals = (s.groups[g] ?? []) as string[];
    if (!vals.length) continue;
    const labels = vals.map((v) => groupOptions[g].find((x) => x.value === v)?.label ?? v);
    chips.push({ key: g, label: `${GROUP_LABEL[g]}: ${labels.join(" ou ")}`, remove: () => patch({ groups: { ...s.groups, [g]: [] } }) });
  }
  (s.rules?.items ?? []).forEach((r, i) => {
    chips.push({
      key: `r${i}`, label: (i > 0 && s.rules!.match === "any" ? "ou " : "") + ruleText(r, ruleFields),
      remove: () => { const items = s.rules!.items.filter((_, j) => j !== i); patch({ rules: items.length ? { ...s.rules!, items } : null }); },
    });
  });
  const clearAll = () => { setText(""); setField("all"); patch({ search: null, groups: {}, rules: null }); };

  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const pending = (review.data?.counts.suggestions ?? 0);
  const sorts = SORTS.filter((x) => !x.finance || canSeeTotals);
  const facetList = SEARCH_FIELDS.filter((f) => f.id !== "all")
    .map((f) => ({ ...f, n: facets.data?.[f.id] ?? null }))
    .sort((a, b) => (b.n ?? -1) - (a.n ?? -1));

  return (
    <div className="flex flex-col gap-[18px]">
      {/* cabeçalho */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-[26px] font-bold tracking-[-0.02em]">Clientes</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">Todos os clientes da Multipark, das reservas, do telefone, do email e do WhatsApp.</p>
        </div>
        <Button variant="outline" asChild>
          <Link href="/clientes/rever">
            Rever fichas
            {pending > 0 && <Pill className="bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">{num(pending)}</Pill>}
          </Link>
        </Button>
        {can(user as any, "clientes", "edit") && <Button onClick={() => setNewOpen(true)}><Plus className="h-4 w-4" />Novo cliente</Button>}
      </div>

      {/* separadores */}
      <div className="flex gap-1 border-b">
        {([["clients", "Clientes"], ["pro", "Pro"]] as const).map(([id, label]) => (
          <button key={id} type="button" onClick={() => patch({ tab: id })}
            className={cn("-mb-px border-b-[3px] px-3.5 py-2.5 text-sm", s.tab === id ? "border-primary font-bold text-primary" : "border-transparent font-semibold text-foreground hover:text-primary")}>
            {label}
            {s.tab === id && list.data && <span className="ml-1 font-medium text-muted-foreground">{num(total)}</span>}
          </button>
        ))}
      </div>

      {/* pesquisa e filtros */}
      <div className="flex flex-col gap-3 rounded-[10px] border bg-card p-3.5">
        <div className="relative">
          <label htmlFor="crm-q" className="sr-only">Pesquisar clientes</label>
          <div className="flex h-11 items-center gap-2.5 rounded-[10px] border-2 border-primary bg-card px-3">
            <Search className="h-[18px] w-[18px] text-muted-foreground" />
            <input id="crm-q" value={text} autoComplete="off"
              onChange={(e) => setText(e.target.value)}
              onFocus={() => setFocus(true)} onBlur={() => setTimeout(() => setFocus(false), 150)}
              onKeyDown={(e) => { if (e.key === "Escape") (e.target as HTMLInputElement).blur(); }}
              className="min-w-0 flex-1 border-0 bg-transparent text-sm font-medium outline-none"
              placeholder="Pesquisar…" />
            {field !== "all" && (
              <button type="button" onClick={() => setField("all")} className="inline-flex h-7 items-center gap-1 rounded-full bg-secondary px-2.5 text-xs font-semibold text-secondary-foreground">
                em {SEARCH_FIELDS.find((f) => f.id === field)?.label.toLowerCase()} ×
              </button>
            )}
            <span className="hidden text-xs text-muted-foreground lg:inline">Nome, email, telefone, NIF, matrícula, n.º de cliente ou de reserva</span>
          </div>
          {focus && text.trim().length >= 2 && (
            <div className="absolute left-0 top-full z-30 mt-1.5 w-[420px] max-w-full rounded-[10px] border bg-popover p-1.5 shadow-[0_12px_32px_rgba(12,31,63,.14)]">
              <div className="px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.05em] text-muted-foreground">Procurar «{text.trim()}» em</div>
              <FacetRow label="Qualquer campo" hint="pesquisa livre" on={field === "all"} onPick={() => setField("all")} />
              {facetList.map((f) => (
                <FacetRow key={f.id} label={f.label} on={field === f.id} onPick={() => setField(f.id)}
                  hint={f.n == null ? (facets.isFetching ? "…" : "") : f.n === 0 ? "nenhum" : `${num(f.n)} ${f.n === 1 ? "cliente" : "clientes"}`}
                  dim={f.n === 0} />
              ))}
            </div>
          )}
        </div>

        {chips.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold text-muted-foreground">Filtro:</span>
            {chips.map((c) => (
              <span key={c.key} className="inline-flex h-7 items-center gap-1.5 rounded-full bg-secondary pl-2.5 pr-1.5 text-xs font-semibold text-secondary-foreground">
                {c.label}
                <button type="button" aria-label="Tirar filtro" onClick={c.remove} className="h-5 w-5 rounded-full text-sm leading-none hover:bg-black/5">×</button>
              </span>
            ))}
            <button type="button" onClick={clearAll} className="text-xs font-semibold text-primary">Limpar tudo</button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {GROUP_ORDER.map((g) => (
            <FilterGroup key={g} label={GROUP_LABEL[g]} options={groupOptions[g]} value={s.groups[g] as string[] | undefined}
              onChange={(v) => patch({ groups: { ...s.groups, [g]: v } })} />
          ))}
          <SelButton active onClick={() => setRulesOpen((x) => !x)} className="font-bold">+ Regra</SelButton>
          <SavedFiltersMenu<Partial<ViewState>>
            current={{ tab: s.tab, search: s.search, groups: s.groups, rules: s.rules, sort: s.sort, dir: s.dir }}
            onApply={applySaved} saveRequest={saveReq} onSaveHandled={() => setSaveReq(false)} />
        </div>

        {rulesOpen && ruleFields.length > 0 && (
          <RulesEditor fields={ruleFields} initial={s.rules}
            onApply={(r) => { patch({ rules: r }); setRulesOpen(false); }}
            onCancel={() => setRulesOpen(false)}
            onSave={(r) => { patch({ rules: r }); setRulesOpen(false); setSaveReq(true); }} />
        )}
      </div>

      {/* contagem, ordem, intervalo, vista */}
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="text-[13px]">
          <strong>{num(total)} {total === 1 ? "cliente" : "clientes"}</strong>
          {rows.length > 0 && <span className="text-muted-foreground"> · a mostrar {num(offset + 1)}–{num(offset + rows.length)}</span>}
          {list.isFetching && <Loader2 className="ml-2 inline h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>
        <div className="flex-1" />
        <span className="text-xs font-bold text-muted-foreground">Ordenar</span>
        <Select value={s.sort} onValueChange={(v) => patch({ sort: v as CrmSort, dir: v === "name" || v === "nextCheckIn" ? "asc" : "desc" })}>
          <SelectTrigger className="h-[34px] w-48 bg-card"><SelectValue /></SelectTrigger>
          <SelectContent>{sorts.map((x) => <SelectItem key={x.id} value={x.id}>{x.label}</SelectItem>)}</SelectContent>
        </Select>
        <SelButton aria-label={s.dir === "desc" ? "Descendente" : "Ascendente"} title={s.dir === "desc" ? "Do maior/mais recente" : "Do menor/mais antigo"}
          onClick={() => patch({ dir: s.dir === "desc" ? "asc" : "desc" })}>
          {s.dir === "desc" ? <ArrowDownWideNarrow className="h-4 w-4" /> : <ArrowUpNarrowWide className="h-4 w-4" />}
        </SelButton>
        <span className="text-xs font-bold text-muted-foreground">Mostrar</span>
        <Select value={String(s.limit)} onValueChange={(v) => patch({ limit: Number(v) })}>
          <SelectTrigger className="h-[34px] w-28 bg-card"><SelectValue /></SelectTrigger>
          <SelectContent>{PAGE_SIZES.map((n) => <SelectItem key={n} value={String(n)}>{n} por página</SelectItem>)}</SelectContent>
        </Select>
        <SelButton aria-label="Página anterior" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - s.limit))}><ChevronLeft className="h-4 w-4" /></SelButton>
        <SelButton aria-label="Página seguinte" disabled={offset + rows.length >= total} onClick={() => setOffset(offset + s.limit)}><ChevronRight className="h-4 w-4" /></SelButton>
        <div className="flex overflow-hidden rounded-lg border bg-card">
          {([["cards", "Cartões"], ["list", "Lista"]] as const).map(([v, label]) => (
            <button key={v} type="button" onClick={() => patch({ view: v })}
              className={cn("h-[34px] px-3.5 text-[13px]", s.view === v ? "bg-primary font-bold text-primary-foreground" : "font-semibold text-foreground hover:bg-muted")}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {list.isLoading && <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}
      {list.error && <p className="text-sm text-destructive">{list.error.message}</p>}
      {!list.isLoading && !list.error && rows.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-[10px] border bg-card py-14 text-center">
          <UsersRound className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-semibold">{chips.length ? "Nenhum cliente com este filtro." : "Ainda não há fichas de clientes."}</p>
          {!chips.length && <p className="max-w-md text-xs text-muted-foreground">As fichas são criadas a partir das reservas, a cada 15 minutos. Na primeira vez demora algumas horas a carregar tudo.</p>}
        </div>
      )}

      {rows.length > 0 && s.view === "cards" && (
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
          {rows.map((c) => <ClientCard key={c.id} c={c} canSeeTotals={canSeeTotals} />)}
        </div>
      )}
      {rows.length > 0 && s.view === "list" && <ClientTable rows={rows} canSeeTotals={canSeeTotals} onOpen={(id) => navigate(`/clientes/${id}`)} />}

      {rows.length > 0 && offset + rows.length < total && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => { setOffset(offset + s.limit); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
            Seguintes {num(Math.min(s.limit, total - offset - rows.length))}
          </Button>
        </div>
      )}

      <NewClientDialog open={newOpen} onOpenChange={setNewOpen} onCreated={(id) => navigate(`/clientes/${id}`)} />
    </div>
  );
}

function FacetRow({ label, hint, on, dim, onPick }: { label: string; hint: string; on: boolean; dim?: boolean; onPick: () => void }) {
  return (
    <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={onPick}
      className={cn("flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-[13px] font-medium", on ? "bg-secondary" : "hover:bg-muted", dim && "opacity-50")}>
      <span>{label}</span><span className="text-xs text-muted-foreground">{hint}</span>
    </button>
  );
}

type Row = CrmListRow;

function carText(v: Row["vehicle"]) {
  return v ? [v.brand, v.model].filter(Boolean).join(" ") : "";
}

function parksText(c: Row) {
  if (!c.parks.length) return c.preferredPark ?? "—";
  return c.parks.length === 1 ? c.parks[0].park : `${c.parks[0].park} +${c.parks.length - 1}`;
}

function ClientCard({ c, canSeeTotals }: { c: Row; canSeeTotals: boolean }) {
  const seg = mainSegment(c.segments, c.isPro);
  return (
    <Link href={`/clientes/${c.id}`} className="flex flex-col gap-2.5 rounded-[10px] border bg-card p-3.5 text-foreground transition-shadow hover:shadow-[0_6px_20px_rgba(12,31,63,.08)]">
      <div className="flex items-center gap-2.5">
        <ClientAvatar name={c.displayName} photoUrl={c.photoUrl} vip={seg === "vip"} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-bold">{c.displayName ?? "Sem nome"}</div>
          <div className="text-[11px] text-muted-foreground">N.º {c.id.toLocaleString("pt-PT")}</div>
        </div>
        {seg && <SegmentPill id={seg} />}
      </div>
      <div className="flex min-h-[34px] items-center gap-2 rounded-lg bg-muted p-2">
        {c.vehicle ? (
          <>
            <ColorSwatch color={c.vehicle.color} />
            <span className="font-mono text-xs font-bold tracking-[0.04em]">{c.vehicle.plate}</span>
            <span className="truncate text-xs text-muted-foreground">{carText(c.vehicle)}</span>
          </>
        ) : <span className="text-xs text-muted-foreground">Sem carro registado</span>}
      </div>
      <div className="grid grid-cols-3 gap-1.5 text-xs">
        <Kpi label="Reservas" value={num(c.bookings)} />
        {canSeeTotals ? <Kpi label="Gasto" value={eur(c.totalSpent)} /> : <Kpi label="Estadias" value={num(c.completed)} />}
        <Kpi label="Última" value={shortDate(c.lastVisit)} />
      </div>
      <div className="flex justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate" title={c.parks.map((p) => `${p.park} (${p.bookings})`).join(", ")}>{parksText(c)}</span>
        {c.alerts.length > 0 && <span className={cn("shrink-0 font-bold", ALERT_CLASS)}>{c.alerts.join(" · ")}</span>}
      </div>
    </Link>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase text-muted-foreground">{label}</div>
      <div className="font-bold">{value}</div>
    </div>
  );
}

function ClientTable({ rows, canSeeTotals, onOpen }: { rows: Row[]; canSeeTotals: boolean; onOpen: (id: number) => void }) {
  const cols = "grid-cols-[2.2fr_1fr_1.6fr_0.8fr_0.9fr_1fr_1.4fr_1fr]";
  return (
    <div className="overflow-x-auto rounded-[10px] border bg-card">
      <div className="min-w-[900px]">
        <div className={cn("grid gap-2.5 bg-muted px-3.5 py-2.5 text-[11px] font-bold uppercase text-muted-foreground", cols)}>
          <span>Cliente</span><span>Segmento</span><span>Carro</span><span>Reservas</span><span>{canSeeTotals ? "Gasto" : "Estadias"}</span><span>Última vinda</span><span>Parques</span><span>Avisos</span>
        </div>
        {rows.map((c) => {
          const seg = mainSegment(c.segments, c.isPro);
          return (
            <div key={c.id} role="link" tabIndex={0} onClick={() => onOpen(c.id)} onKeyDown={(e) => { if (e.key === "Enter") onOpen(c.id); }}
              className={cn("grid cursor-pointer items-center gap-2.5 border-t px-3.5 py-2.5 text-[13px] hover:bg-muted/60", cols)}>
              <span className="flex min-w-0 items-center gap-2">
                <ClientAvatar name={c.displayName} photoUrl={c.photoUrl} vip={seg === "vip"} size={28} />
                <span className="min-w-0">
                  <span className="block truncate font-bold">{c.displayName ?? "Sem nome"}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">N.º {c.id.toLocaleString("pt-PT")}{c.primaryEmail ? ` · ${c.primaryEmail}` : ""}</span>
                </span>
              </span>
              <span>{seg && <SegmentPill id={seg} />}</span>
              <span className="flex min-w-0 items-center gap-1.5">
                {c.vehicle ? <><ColorSwatch color={c.vehicle.color} className="h-2.5 w-2.5" /><span className="font-mono text-xs font-bold">{c.vehicle.plate}</span><span className="truncate text-xs text-muted-foreground">{carText(c.vehicle)}</span></> : <span className="text-muted-foreground">—</span>}
              </span>
              <span className="font-bold">{num(c.bookings)}</span>
              <span className="font-bold">{canSeeTotals ? eur(c.totalSpent) : num(c.completed)}</span>
              <span>{shortDate(c.lastVisit)}</span>
              <span className="truncate text-muted-foreground" title={c.parks.map((p) => `${p.park} (${p.bookings})`).join(", ")}>{parksText(c)}</span>
              <span className={cn("text-xs font-bold", ALERT_CLASS)}>{c.alerts.join(" · ")}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NewClientDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (id: number) => void }) {
  const [f, setF] = useState({ displayName: "", kind: "person" as "person" | "company", email: "", phone: "", nif: "" });
  const create = trpc.crm.create.useMutation({
    onSuccess: (r) => { toast.success("Ficha criada"); onOpenChange(false); setF({ displayName: "", kind: "person", email: "", phone: "", nif: "" }); if (r.id) onCreated(r.id); },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Novo cliente</DialogTitle></DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Tipo</Label>
            <Select value={f.kind} onValueChange={(v) => setF({ ...f, kind: v as "person" | "company" })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="person">Pessoa</SelectItem><SelectItem value="company">Empresa</SelectItem></SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5"><Label>Nome</Label><Input value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} autoFocus /></div>
          <div className="grid gap-1.5"><Label>Email</Label><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label>Telefone</Label><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="+351 …" /></div>
          <div className="grid gap-1.5"><Label>NIF</Label><Input value={f.nif} onChange={(e) => setF({ ...f, nif: e.target.value })} /></div>
          <p className="text-xs text-muted-foreground">Se já existir uma ficha com o mesmo email e telefone, aparece nas sugestões para juntar.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button disabled={f.displayName.trim().length < 2 || create.isPending}
            onClick={() => create.mutate({ displayName: f.displayName.trim(), kind: f.kind, email: f.email.trim() || null, phone: f.phone.trim() || null, nif: f.nif.trim() || null })}>
            Criar ficha
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
