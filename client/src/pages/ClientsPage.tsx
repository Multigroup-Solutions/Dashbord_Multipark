/**
 * Clientes (CRM leve) — pedido Jorge 24 set 2026.
 *
 * Email = cliente. Tudo o que aqui aparece é o agregado das reservas Multipark
 * já sincronizadas (server/clientsCrm.ts): quantas reservas, quanto gastou,
 * com que frequência vem, cidades/parques, e o que se passou com ele
 * (reclamações, perdidos, críticas — ligados pelo email ou por uma reserva
 * dele). Matrículas que também aparecem noutro email ficam assinaladas.
 *
 * Lista com pesquisa, segmento e ordenação; clicar abre a ficha.
 * Gasto e média só para quem vê totais financeiros (backoffice+ sem deny).
 */
import { CommunicationsTimeline } from "@/components/mail/CommunicationsTimeline";
import { ExportToSheetsButton } from "@/components/google/DriveActions";
import { CreateMeetingButton } from "@/components/google/CreateMeetingButton";
import { DriveFilesPanel } from "@/components/google/DriveFilesPanel";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { trpc } from "@/lib/trpc";
import { fmtPTDate } from "@/lib/lisbonTime";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { usePersistedState } from "@/hooks/usePersistedState";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Contact, Search, ChevronLeft, ChevronRight, Mail, Phone, Car, CalendarDays, Euro, Repeat, MapPin,
  MessageSquareWarning, PackageSearch, Star, Loader2, Users, Crown, AlertTriangle, Sparkles, CalendarClock, Handshake, MailX,
} from "lucide-react";

type Segment = "all" | "new" | "recurring" | "vip" | "at_risk" | "partner" | "shared";
type Sort = "lastCheckIn" | "totalSpent" | "bookings" | "firstCheckIn";
const SORTS: Sort[] = ["lastCheckIn", "totalSpent", "bookings", "firstCheckIn"];

const SEGMENT_LABEL: Record<Exclude<Segment, "all">, string> = {
  new: "Novo", recurring: "Recorrente", vip: "VIP", at_risk: "Em risco", partner: "Parceiro", shared: "Email genérico",
};
const SEGMENT_CLASS: Record<Exclude<Segment, "all">, string> = {
  new: "bg-sky-100 text-sky-800 border-sky-200",
  recurring: "bg-emerald-100 text-emerald-800 border-emerald-200",
  vip: "bg-amber-100 text-amber-900 border-amber-200",
  at_risk: "bg-rose-100 text-rose-800 border-rose-200",
  partner: "bg-violet-100 text-violet-800 border-violet-200",
  shared: "bg-slate-100 text-slate-700 border-slate-200",
};
/** Listas longas (telefones/matrículas de emails genéricos) mostram só as primeiras. */
const few = (xs: string[], n = 6) => (xs.length <= n ? xs.join(" · ") : `${xs.slice(0, n).join(" · ")} · +${xs.length - n}`);

const eur = (v: number | null | undefined, digits = 0) =>
  v == null ? "—" : v.toLocaleString("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: digits });
const d = (s?: string | null) => (s ? fmtPTDate(s) : "—");
const freq = (days: number | null) => {
  if (days == null) return "—";
  if (days < 45) return `a cada ${days} dias`;
  if (days < 365) return `a cada ${Math.round(days / 30.44)} meses`;
  return `a cada ${(days / 365.25).toFixed(1)} anos`;
};
const isCancelled = (s?: string | null) => (s ?? "").toUpperCase().includes("CANCEL");

function SegmentBadges({ segments }: { segments: string[] }) {
  if (!segments.length) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {segments.map((s) => (
        <Badge key={s} variant="outline" className={`text-[11px] ${SEGMENT_CLASS[s as Exclude<Segment, "all">] ?? ""}`}>
          {SEGMENT_LABEL[s as Exclude<Segment, "all">] ?? s}
        </Badge>
      ))}
    </div>
  );
}

function StatTile({ icon: Icon, label, value, hint, onClick, active }: { icon: any; label: string; value: string | number; hint?: string; onClick?: () => void; active?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left min-w-0 rounded-xl border bg-card p-3 transition-colors ${onClick ? "hover:bg-muted/50 cursor-pointer" : "cursor-default"} ${active ? "border-primary ring-1 ring-primary/30" : ""}`}
    >
      <div className="flex items-start gap-2 text-xs text-muted-foreground min-h-8"><Icon className="w-3.5 h-3.5 mt-px shrink-0" /> <span className="line-clamp-2">{label}</span></div>
      <div className="text-xl sm:text-2xl font-bold mt-1 tabular-nums truncate" title={String(value)}>{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground mt-0.5">{hint}</div>}
    </button>
  );
}

export default function ClientsPage() {
  const queryString = useSearch();
  const [, navigate] = useLocation();
  const emailFromUrl = useMemo(() => new URLSearchParams(queryString).get("email"), [queryString]);
  const [selectedEmail, setSelectedEmail] = useState<string | null>(emailFromUrl);
  useEffect(() => { setSelectedEmail(emailFromUrl); }, [emailFromUrl]);

  const open = (email: string) => navigate(`/clientes?email=${encodeURIComponent(email)}`);
  const back = () => navigate("/clientes", { replace: true });

  if (selectedEmail) return <ClientProfile email={selectedEmail} onBack={back} />;
  return <ClientsList onOpen={open} />;
}

// ─── LISTA ───────────────────────────────────────────────────────────────────
function ClientsList({ onOpen }: { onOpen: (email: string) => void }) {
  const { projectId } = useGlobalFilters();
  const [search, setSearch] = usePersistedState("clients.search", "");
  const [segment, setSegment] = usePersistedState<Segment>("clients.segment", "all");
  const [storedSort, setSort] = usePersistedState<Sort>("clients.sort", "lastCheckIn");
  const [page, setPage] = useState(1);
  const [debounced, setDebounced] = useState(search);
  useEffect(() => { const t = setTimeout(() => setDebounced(search), 300); return () => clearTimeout(t); }, [search]);
  useEffect(() => { setPage(1); }, [debounced, segment, storedSort, projectId]);

  const { data: stats, isError: statsError } = trpc.clients.stats.useQuery({ projectId });
  const canSeeTotals = stats?.canSeeTotals ?? false;
  // Sem totais financeiros não se ordena por gasto nem se filtra VIP (o servidor recusa).
  const sort: Sort = SORTS.includes(storedSort) && (canSeeTotals || storedSort !== "totalSpent") ? storedSort : "lastCheckIn";
  const activeSegment: Segment = !canSeeTotals && segment === "vip" ? "all" : segment;
  const { data, isLoading, isFetching } = trpc.clients.list.useQuery({
    search: debounced || null, segment: activeSegment, sort, dir: "desc", page, pageSize: 50, projectId,
  // Espera pelos stats (dizem se há totais), mas se falharem a lista carrega na mesma
  }, { enabled: !!stats || statsError, placeholderData: (prev) => prev });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / (data?.pageSize ?? 50)));
  const toggleSegment = (s: Segment) => setSegment(segment === s ? "all" : s);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Contact className="h-6 w-6 text-primary" /> Clientes
          </h1>
          <p className="text-sm text-muted-foreground">
            Um cliente por email, com todas as reservas Multipark anexadas: quantas, quanto gastou e com que frequência vem.
          </p>
        </div>
        <ExportToSheetsButton input={{ report: "clientes", search: debounced || null, segment: activeSegment, projectId: projectId ?? undefined }} />
      </div>

      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 2xl:grid-cols-8 gap-2">
          <StatTile icon={Users} label="Clientes" value={stats.clients.toLocaleString("pt-PT")} hint="com email nas reservas" onClick={() => setSegment("all")} active={segment === "all"} />
          <StatTile icon={Handshake} label="Parceiros" value={stats.partners.toLocaleString("pt-PT")} hint="agências e Pro" onClick={() => toggleSegment("partner")} active={segment === "partner"} />
          <StatTile icon={Sparkles} label="Novos (30 dias)" value={stats.newLast30d.toLocaleString("pt-PT")} hint="primeira estadia recente" />
          <StatTile icon={Repeat} label="Recorrentes" value={stats.recurring.toLocaleString("pt-PT")} hint="3 ou mais estadias" onClick={() => toggleSegment("recurring")} active={segment === "recurring"} />
          {stats.vip != null && <StatTile icon={Crown} label="VIP" value={stats.vip.toLocaleString("pt-PT")} hint={stats.vipThreshold != null ? `top 10% · desde ${eur(stats.vipThreshold)}` : "top 10% em gasto"} onClick={() => toggleSegment("vip")} active={segment === "vip"} />}
          <StatTile icon={AlertTriangle} label="Em risco" value={stats.atRisk.toLocaleString("pt-PT")} hint="recorrentes sem vir há 12 meses" onClick={() => toggleSegment("at_risk")} active={segment === "at_risk"} />
          <StatTile icon={CalendarClock} label="Com reserva futura" value={stats.upcoming.toLocaleString("pt-PT")} hint="vão voltar" />
          <StatTile icon={MailX} label="Reservas sem email" value={stats.bookingsWithoutEmail.toLocaleString("pt-PT")} hint="não dá para as ligar a um cliente" />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="Pesquisar por email, nome, telefone ou matrícula…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={activeSegment} onValueChange={(v) => setSegment(v as Segment)}>
          <SelectTrigger className="w-[190px]"><SelectValue placeholder="Segmento" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os segmentos</SelectItem>
            <SelectItem value="new">Novos</SelectItem>
            <SelectItem value="recurring">Recorrentes</SelectItem>
            {canSeeTotals && <SelectItem value="vip">VIP</SelectItem>}
            <SelectItem value="at_risk">Em risco</SelectItem>
            <SelectItem value="partner">Parceiros</SelectItem>
            <SelectItem value="shared">Emails genéricos</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
          <SelectTrigger className="w-[190px]"><SelectValue placeholder="Ordenar" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="lastCheckIn">Última estadia</SelectItem>
            {canSeeTotals && <SelectItem value="totalSpent">Total gasto</SelectItem>}
            <SelectItem value="bookings">Nº de reservas</SelectItem>
            <SelectItem value="firstCheckIn">Cliente desde</SelectItem>
          </SelectContent>
        </Select>
        {isFetching && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
      </div>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cliente</TableHead>
                <TableHead className="text-right">Reservas</TableHead>
                <TableHead className="text-right">Estadias</TableHead>
                {canSeeTotals && <TableHead className="text-right">Total gasto</TableHead>}
                {canSeeTotals && <TableHead className="text-right">Média</TableHead>}
                <TableHead>Frequência</TableHead>
                <TableHead>Desde</TableHead>
                <TableHead>Última</TableHead>
                <TableHead>Próxima</TableHead>
                <TableHead>Cidades</TableHead>
                <TableHead>Segmento</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={11} className="text-center py-10 text-muted-foreground">A carregar clientes…</TableCell></TableRow>
              )}
              {!isLoading && rows.length === 0 && (
                <TableRow><TableCell colSpan={11} className="text-center py-10 text-muted-foreground">Sem clientes para estes filtros.</TableCell></TableRow>
              )}
              {rows.map((c) => (
                <TableRow key={c.email} className="cursor-pointer hover:bg-muted/50" onClick={() => onOpen(c.email)}>
                  <TableCell className="min-w-[180px] max-w-[280px]">
                    <div className="font-medium truncate" title={c.name ?? undefined}>{c.name ?? "—"}</div>
                    <div className="text-xs text-muted-foreground truncate" title={c.email}>{c.email}</div>
                    {c.phone && <div className="text-xs text-muted-foreground">{c.phone}</div>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {c.bookings}
                    {c.cancelled > 0 && <span className="text-xs text-muted-foreground"> ({c.cancelled} canc.)</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{c.completed}</TableCell>
                  {canSeeTotals && <TableCell className="text-right tabular-nums font-medium">{eur(c.totalSpent)}</TableCell>}
                  {canSeeTotals && <TableCell className="text-right tabular-nums text-muted-foreground">{eur(c.avgSpend)}</TableCell>}
                  <TableCell className="text-sm">{freq(c.frequencyDays)}</TableCell>
                  <TableCell className="text-sm whitespace-nowrap">{d(c.firstCheckIn)}</TableCell>
                  <TableCell className="text-sm whitespace-nowrap">{d(c.lastCheckIn)}</TableCell>
                  <TableCell className="text-sm whitespace-nowrap">{c.nextCheckIn ? <span className="text-emerald-700">{d(c.nextCheckIn)}</span> : "—"}</TableCell>
                  <TableCell className="text-xs">{c.cities.join(", ") || "—"}</TableCell>
                  <TableCell><SegmentBadges segments={c.segments} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{total.toLocaleString("pt-PT")} clientes · página {page} de {pages}</span>
        <div className="flex gap-1">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="w-4 h-4" /> Anterior</Button>
          <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Seguinte <ChevronRight className="w-4 h-4" /></Button>
        </div>
      </div>
    </div>
  );
}

// ─── FICHA ───────────────────────────────────────────────────────────────────
function ClientProfile({ email, onBack }: { email: string; onBack: () => void }) {
  const { projectId } = useGlobalFilters();
  const { data: p, isLoading, error } = trpc.clients.profile.useQuery({ email, projectId });

  if (isLoading) return <div className="p-8 text-center text-muted-foreground">A carregar ficha…</div>;
  if (!p) {
    return (
      <div className="p-8 text-center space-y-3">
        <p role="alert" className="text-muted-foreground">{error?.message ?? "Cliente não encontrado"}</p>
        <Button variant="outline" onClick={onBack}><ChevronLeft className="w-4 h-4 mr-1" /> Voltar aos clientes</Button>
      </div>
    );
  }
  const canSeeTotals = p.canSeeTotals;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="ghost" onClick={onBack}><ChevronLeft className="w-4 h-4 mr-1" /> Clientes</Button>
        <h1 className="text-2xl font-bold truncate min-w-0">{p.name ?? p.email}</h1>
        <SegmentBadges segments={p.segments} />
      </div>

      <Card>
        <CardContent className="p-4 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-1.5 text-sm">
          <div className="flex items-center gap-2 min-w-0"><Mail className="w-4 h-4 shrink-0 text-muted-foreground" /> <span className="break-all">{p.email}</span></div>
          <div className="flex items-center gap-2"><Phone className="w-4 h-4 text-muted-foreground" /> {p.phones.length ? few(p.phones) : "—"}</div>
          <div className="flex items-center gap-2"><Car className="w-4 h-4 text-muted-foreground" /> {p.plates.length ? few(p.plates) : "—"}</div>
          <div className="flex items-center gap-2"><MapPin className="w-4 h-4 text-muted-foreground" /> {p.cities.join(", ") || "—"}{p.lastPark ? ` · último: ${p.lastPark}` : ""}</div>
          {p.names.length > 1 && (
            <div className="md:col-span-2 text-xs text-muted-foreground">Outros nomes nas reservas: {few(p.names.filter((n) => n !== p.name), 8)}</div>
          )}
          {p.nifs.length > 0 && <div className="md:col-span-2 text-xs text-muted-foreground">NIF: {p.nifs.join(", ")}</div>}
        </CardContent>
      </Card>

      {p.sharedPlates.length > 0 && (
        <Card className="border-amber-300 bg-amber-50/60 dark:bg-amber-950/20">
          <CardContent className="p-3 space-y-1 text-sm">
            <div className="flex items-center gap-2 font-medium"><Car className="w-4 h-4 text-amber-700" /> Matrículas partilhadas com outros clientes</div>
            {p.sharedPlates.map((sp) => (
              <div key={`${sp.plate}-${sp.email}`} className="text-xs">
                A matrícula <span className="font-mono font-semibold">{sp.plate}</span> também pertence a{" "}
                <Link href={`/clientes?email=${encodeURIComponent(sp.email)}`} className="text-primary underline">{sp.name ?? sp.email}</Link>
                {sp.name ? <span className="text-muted-foreground"> ({sp.email})</span> : null}
                <span className="text-muted-foreground"> · {sp.bookings} reserva(s), última {d(sp.lastCheckIn)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <StatTile icon={Car} label="Reservas" value={p.bookings} hint={`${p.completed} estadias · ${p.upcoming} futuras · ${p.cancelled} canceladas`} />
        {canSeeTotals && <StatTile icon={Euro} label="Total gasto" value={eur(p.totalSpent)} hint="só estadias (o carro entrou no parque)" />}
        {canSeeTotals && <StatTile icon={Euro} label="Média por estadia" value={eur(p.avgSpend)} />}
        <StatTile icon={Repeat} label="Frequência" value={freq(p.frequencyDays)} hint={p.frequencyDays != null ? `${p.completed} estadias` : "precisa de 2 dias de estadia"} />
        <StatTile icon={CalendarDays} label="Cliente desde" value={d(p.firstCheckIn)} />
        <StatTile icon={CalendarClock} label={p.nextCheckIn ? "Próxima reserva" : "Última estadia"} value={p.nextCheckIn ? d(p.nextCheckIn) : d(p.lastCheckIn)} hint={p.nextCheckIn ? `última: ${d(p.lastCheckIn)}` : undefined} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Car className="w-4 h-4 text-primary" /> Reservas ({p.bookings})</CardTitle></CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nº</TableHead>
                  <TableHead>Parque</TableHead>
                  <TableHead>Entrada</TableHead>
                  <TableHead>Saída</TableHead>
                  <TableHead>Matrícula</TableHead>
                  {canSeeTotals && <TableHead className="text-right">Valor</TableHead>}
                  <TableHead>Estado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {p.bookings_list.map((b) => (
                  <TableRow key={b.id} className={isCancelled(b.status) ? "opacity-60" : ""}>
                    <TableCell className="font-mono text-xs">{b.bookingNumber ?? b.externalId}</TableCell>
                    <TableCell className="text-sm">{b.parkName ?? "—"}{b.city ? <span className="text-xs text-muted-foreground"> · {b.city}</span> : null}{b.deliveryService ? <Badge variant="outline" className="ml-1 text-[11px]">entrega</Badge> : null}{b.partnerName ? <Badge variant="outline" className="ml-1 text-[11px] bg-violet-50 text-violet-800">{b.partnerName}</Badge> : null}</TableCell>
                    <TableCell className="text-sm whitespace-nowrap">{d(b.checkIn)}</TableCell>
                    <TableCell className="text-sm whitespace-nowrap">{d(b.checkOut)}</TableCell>
                    <TableCell className="font-mono text-xs">{b.licensePlate ?? "—"}</TableCell>
                    {canSeeTotals && <TableCell className="text-right tabular-nums">{b.totalPrice != null ? eur(Number(b.totalPrice), 2) : "—"}</TableCell>}
                    <TableCell><Badge variant={isCancelled(b.status) ? "secondary" : "outline"} className="text-[11px]">{b.status ?? "—"}</Badge></TableCell>
                  </TableRow>
                ))}
                {p.bookings > p.bookings_list.length && (
                  <TableRow><TableCell colSpan={7} className="text-xs text-muted-foreground text-center">A mostrar as {p.bookings_list.length} mais recentes de {p.bookings}.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><MapPin className="w-4 h-4 text-primary" /> Parques</CardTitle></CardHeader>
            <CardContent className="space-y-1 text-sm">
              {p.parks.length === 0 && <p className="text-xs text-muted-foreground">—</p>}
              {p.parks.map((k) => (
                <div key={`${k.parkName}-${k.city ?? ""}`} className="flex items-center justify-between gap-2 border-b last:border-0 py-1">
                  <span>{k.parkName}{k.city ? <span className="text-xs text-muted-foreground"> · {k.city}</span> : null}</span>
                  <span className="text-xs text-muted-foreground whitespace-nowrap tabular-nums">{k.bookings} res.{canSeeTotals ? ` · ${eur(k.spent)}` : ""}</span>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2"><MessageSquareWarning className="w-4 h-4 text-primary" /> Suporte</CardTitle>
              <div className="flex flex-wrap gap-1.5 text-xs">
                <Badge variant="outline"><MessageSquareWarning className="w-3 h-3 mr-1" />{p.complaints.length} reclamações</Badge>
                <Badge variant="outline"><PackageSearch className="w-3 h-3 mr-1" />{p.lostFound.length} perdidos</Badge>
                <Badge variant="outline"><Star className="w-3 h-3 mr-1" />{p.reviews.length} críticas</Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {p.complaints.length + p.lostFound.length + p.reviews.length === 0 && (
                <p className="text-xs text-muted-foreground">Sem reclamações, perdidos ou críticas.</p>
              )}
              <InteractionList title="Reclamações" items={p.complaints} href={(id) => `/reclamacoes?id=${id}`} />
              <InteractionList title="Perdidos & Achados" items={p.lostFound} href={(id) => `/perdidos-achados/caso/${id}`} />
              <InteractionList title="Críticas" items={p.reviews} href={(id) => `/criticas?id=${id}`} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2 flex-wrap"><Mail className="w-4 h-4 text-primary" /> Comunicações
                <span className="ml-auto"><CreateMeetingButton entityType="client" entityId={p.email} /></span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <CommunicationsTimeline type="client" id={p.email} compact />
              <div className="mt-3"><DriveFilesPanel entityType="client" entityId={p.email} compact /></div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

const VIA_LABEL: Record<string, string> = { email: "", reserva: "pela reserva", "reclamação": "pela reclamação" };

function InteractionList({ title, items, href }: {
  title: string;
  items: { id: number; title: string; status: string; createdAt: string | null; via: string; rating?: number }[];
  href: (id: number) => string;
}) {
  if (!items.length) return null;
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground mb-1">{title}</div>
      {items.map((it) => (
        <Link key={it.id} href={href(it.id)} className="flex items-center justify-between gap-2 border-b last:border-0 py-0.5 hover:bg-muted/50 rounded">
          <span className="truncate">{it.rating != null ? `${"★".repeat(Math.max(0, it.rating))} ` : ""}{it.title || "—"}</span>
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {VIA_LABEL[it.via] ? `${VIA_LABEL[it.via]} · ` : ""}{it.status} · {d(it.createdAt)}
          </span>
        </Link>
      ))}
    </div>
  );
}
