import { useMemo, useState, type ReactNode } from "react";
import { Link, useLocation, useParams } from "wouter";
import { trpc } from "@/lib/trpc";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";
import { useAuth } from "@/_core/hooks/useAuth";
import { seesBeyondOwn } from "@shared/access";
import { PARKING_TYPE_LABELS } from "@shared/opsLists";
import { operatedLabel } from "@shared/marketplace";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { fmtPTDate, fmtPTDateTime } from "@/lib/lisbonTime";
import { multiparkBookingUrl } from "@/lib/multiparkLinks";
import BookingCashCheck from "@/components/cashCheck/BookingCashCheck";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ContactActions } from "@/components/ContactActions";
import {
  AlertTriangle, Car, ChevronDown, ChevronRight, Clock, CreditCard, ExternalLink, FileSearch, FileText, Info, Lock,
  MapPin, MessageSquare, PenLine, Search, Sparkles, Star, User, Video,
} from "lucide-react";

/**
 * Ficha da reserva (/reserva/:id) — tudo sobre uma reserva num só sítio, lido
 * AO VIVO da BD da Multipark (server/multiparkDb/bookingFile.ts). Aceita o id
 * da Multipark ou o n.º da reserva. Cada secção carrega sozinha; assinaturas,
 * linha do tempo e comunicação só quando se abrem.
 */

type Unavail = { available: false; reason: string };
type Missing = Array<{ part: string; reason: string }>;

const STATUS_TONE: Record<string, string> = {
  BOOKED: "bg-blue-100 text-blue-800",
  PENDING: "bg-slate-100 text-slate-700",
  CHECKING_IN: "bg-amber-100 text-amber-800",
  CHECKED_IN: "bg-emerald-100 text-emerald-800",
  MOVING: "bg-violet-100 text-violet-800",
  PENDING_CHECKOUT: "bg-orange-100 text-orange-800",
  CHECKING_OUT: "bg-amber-100 text-amber-800",
  CHECKED_OUT: "bg-slate-200 text-slate-800",
  CANCELLED: "bg-red-100 text-red-800",
};

const PART_LABELS: Record<string, string> = {
  core: "reserva", location: "lugar", drivers: "condutores", attachments: "anexos", pricing: "linhas de preço", payments: "pagamentos",
  billing: "faturas", cancellation: "cancelamento", extras: "serviços extra", history: "histórico", activity: "auditoria",
  chat: "chat", emails: "emails", occurrences: "ocorrências", review: "avaliação",
};

function eur(v: number | null | undefined, currency = "EUR"): string {
  return v == null ? "—" : v.toLocaleString("pt-PT", { style: "currency", currency });
}
const dt = (v: string | null | undefined) => (v ? fmtPTDateTime(v) : "—");

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-medium break-words">{children ?? "—"}</div>
    </div>
  );
}

function UnavailableNote({ reason }: { reason: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
      <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" /> <span>{reason}</span>
    </div>
  );
}

function MissingNote({ missing }: { missing?: Missing }) {
  if (!missing?.length) return null;
  return <p className="text-[11px] text-amber-700">Sem dados de: {missing.map((m) => PART_LABELS[m.part] ?? m.part).join(", ")} (BD Multipark).</p>;
}

/** Link para um valor guardado: URL abre; caminho interno → app Multipark. */
function StoredLink({ url, raw, bookingId, label }: { url: string | null; raw: string | null; bookingId: string; label: string }) {
  if (url) {
    return <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary underline">{label} <ExternalLink className="w-3 h-3" /></a>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <a href={multiparkBookingUrl(bookingId)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary underline">
        {label}: abrir na app Multipark <ExternalLink className="w-3 h-3" />
      </a>
      {raw && <span className="text-[11px] text-muted-foreground break-all">({raw.slice(0, 80)})</span>}
    </span>
  );
}

function Section({ title, icon, children, lazy, onOpen, defaultOpen = true, right }: {
  title: string; icon: ReactNode; children: ReactNode; lazy?: boolean; onOpen?: () => void; defaultOpen?: boolean; right?: ReactNode;
}) {
  const [open, setOpen] = useState(lazy ? false : defaultOpen);
  return (
    <Card>
      <CardHeader className="py-3">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 text-left"
          onClick={() => { const n = !open; setOpen(n); if (n) onOpen?.(); }}
        >
          <CardTitle className="flex items-center gap-2 text-sm">{icon} {title}</CardTitle>
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {right}
            {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </span>
        </button>
      </CardHeader>
      {open && <CardContent className="space-y-3 pt-0 text-sm">{children}</CardContent>}
    </Card>
  );
}

function Loading() {
  return <p className="text-xs text-muted-foreground">A carregar…</p>;
}

export default function BookingFilePage() {
  const { user } = useAuth();
  const params = useParams<{ ref?: string }>();
  const ref = useMemo(() => {
    try { return params.ref ? decodeURIComponent(params.ref) : ""; } catch { return params.ref ?? ""; }
  }, [params.ref]);
  const [, navigate] = useLocation();
  const [search, setSearch] = useState(ref);
  const canView = seesBeyondOwn(user, "reservas_operacoes");

  const go = (e: React.FormEvent) => {
    e.preventDefault();
    const r = search.trim();
    if (r) navigate(`/reserva/${encodeURIComponent(r)}`);
  };

  if (!canView) {
    return (
      <Card className="p-10 text-center">
        <Lock className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
        <p className="text-muted-foreground">A ficha da reserva está disponível para quem vê as reservas da cidade.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2"><FileSearch className="w-5 h-5" /> Ficha da reserva</h1>
          <p className="text-xs text-muted-foreground">Lida em tempo real da BD da Multipark. Aceita o n.º da reserva ou o id da Multipark.</p>
        </div>
        <form onSubmit={go} className="flex gap-2">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="N.º ou id da reserva" className="w-56" />
          <Button type="submit" variant="outline"><Search className="w-4 h-4" /></Button>
        </form>
      </div>
      {ref ? <BookingFile key={ref} refValue={ref} /> : (
        <Card className="p-8 text-center text-sm text-muted-foreground">Escreve o n.º da reserva (ex.: 29484) ou o id da Multipark.</Card>
      )}
    </div>
  );
}

function BookingFile({ refValue }: { refValue: string }) {
  const { projectId } = useGlobalFilters();
  const scope = projectId !== undefined ? { projectId } : {};
  const main = trpc.bookingFile.main.useQuery({ ref: refValue, ...scope }, { staleTime: 60_000, retry: false });
  const d = main.data;

  if (main.isLoading) return <Card className="p-6"><Loading /></Card>;
  if (main.error) return <Card className="p-6"><QueryErrorNote error={main.error} onRetry={() => main.refetch()} retrying={main.isFetching} /></Card>;
  if (!d) return null;
  if (!d.available) return <Card className="p-6"><UnavailableNote reason={`Ficha indisponível de momento. ${(d as Unavail).reason}`} /></Card>;
  if (d.kind === "not_found") {
    return <Card className="p-6 text-sm text-muted-foreground">Não há nenhuma reserva "{refValue}" nas tuas cidades (procura pelo id da Multipark, pelo n.º ou pela referência do parceiro).</Card>;
  }
  if (d.kind === "ambiguous") {
    return (
      <Card>
        <CardHeader><CardTitle className="text-sm">Há várias reservas com "{refValue}" — escolhe uma</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {d.candidates.map((c) => (
            <Link key={c.id} href={`/reserva/${encodeURIComponent(c.id)}`} className="flex flex-wrap items-center gap-3 rounded-md border p-2 text-sm hover:bg-muted/50">
              <span className="font-semibold">#{c.code ?? c.id}</span>
              <Badge className={STATUS_TONE[c.status ?? ""] ?? ""}>{c.statusLabel}</Badge>
              <span>{c.parkName ?? "—"}{c.parkCity ? ` (${c.parkCity})` : ""}</span>
              <span>{c.plate ?? ""}</span>
              <span className="text-muted-foreground">{c.checkInDate ? fmtPTDate(c.checkInDate) : "?"} → {c.checkOutDate ? fmtPTDate(c.checkOutDate) : "?"}</span>
            </Link>
          ))}
        </CardContent>
      </Card>
    );
  }
  return <FoundFile data={d} scope={scope} />;
}

type MainOutput = inferRouterOutputs<AppRouter>["bookingFile"]["main"];
type MainFound = Extract<MainOutput, { kind: "found" }>;

function FoundFile({ data, scope }: { data: MainFound; scope: { projectId?: number } }) {
  const b = data.core;
  const id = data.id;
  const input = { id, ...scope };
  const accounts = trpc.bookingFile.accounts.useQuery(input, { staleTime: 60_000, retry: false });
  const cur = b.price.currency || "EUR";
  const paid = useMemo(() => {
    const a = accounts.data;
    if (!a?.available || !a.pricing.length) return null;
    return a.pricing.reduce((s, l) => s + (l.amountPaid ?? 0), 0);
  }, [accounts.data]);

  return (
    <div className="space-y-4">
      <Header data={data} paid={paid} />
      <MissingNote missing={data.missing} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <ClientVehicle data={data} scope={scope} />
          <EvidenceSection data={data} scope={scope} />
          <TimelineSection id={id} scope={scope} />
          <AccountsSection core={b} accounts={accounts.data} loading={accounts.isLoading} currency={cur}
            error={accounts.error} onRetry={() => accounts.refetch()} retrying={accounts.isFetching} />
          <BookingCashCheck id={id} scope={scope} />
          <ExtrasSection id={id} scope={scope} currency={cur} />
          <CommunicationSection id={id} scope={scope} />
          <FeedbackSection id={id} scope={scope} />
        </div>
        <div className="space-y-4">
          <LocationSection data={data} />
          <OurCases id={id} code={b.code} email={b.client.email} scope={scope} />
        </div>
      </div>
    </div>
  );
}

/** Cores do canal (contabilidade) — as mesmas das Reservas do dia. */
const CHANNEL_TONE: Record<string, string> = {
  direto: "border-sky-300 text-sky-700",
  parceiro: "border-violet-300 text-violet-700",
  marketplace: "border-rose-300 text-rose-700",
};

function Header({ data, paid }: { data: MainFound; paid: number | null }) {
  const b = data.core;
  const cur = b.price.currency || "EUR";
  const priceChanged = b.price.originalBookingPrice != null && b.price.bookingPrice != null && b.price.originalBookingPrice > 0
    && Math.abs(b.price.originalBookingPrice - b.price.bookingPrice) >= 0.01;
  return (
    <Card>
      <CardContent className="space-y-4 pt-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-2xl font-bold">#{b.code ?? b.id}</span>
          <Badge className={STATUS_TONE[b.status ?? ""] ?? ""}>{b.statusLabel}</Badge>
          <Badge variant="outline" className={CHANNEL_TONE[b.origin.channel] ?? ""} title={b.origin.channelDetail}>
            {b.origin.badge}{b.origin.channel === "parceiro" && b.origin.partnerTypeLabel ? ` (${b.origin.partnerTypeLabel})` : ""}
          </Badge>
          {b.pro && <Badge variant="outline">Pro</Badge>}
          <span className="text-sm text-muted-foreground">{b.park.name ?? "—"}{b.park.city ? ` · ${b.park.city}` : ""}</span>
          <Badge variant="outline" className={b.park.ours ? "text-xs font-normal" : "text-xs font-normal border-dashed"} title={b.park.reason}>
            {b.park.ours ? `Parque nosso · ${b.park.groupLabel}` : `Parque Marketplace · ${operatedLabel(b.park.operated).toLowerCase()}`}
            {b.park.listingType ? ` · ${b.park.listingType === "DIRECTORY" ? "diretório" : b.park.listingType === "ON_PLATFORM" ? "na plataforma" : b.park.listingType}` : ""}
          </Badge>
          <a href={multiparkBookingUrl(b.id)} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-primary underline">
            Ver na Multipark <ExternalLink className="w-3 h-3" />
          </a>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Field label="Entrada">{b.checkIn.at ? dt(b.checkIn.at) : `${b.checkIn.day ? fmtPTDate(b.checkIn.day) : "—"} ${b.checkIn.time ?? ""}`}</Field>
          <Field label="Saída">{b.checkOut.at ? dt(b.checkOut.at) : `${b.checkOut.day ? fmtPTDate(b.checkOut.day) : "—"} ${b.checkOut.time ?? ""}`}</Field>
          <Field label="Voo de ida">{b.flights.departing.flight ?? "—"}{b.flights.departing.eta ? ` · ETA ${dt(b.flights.departing.eta)}` : ""}</Field>
          <Field label="Voo de regresso">{b.flights.return.flight ?? "—"}{b.flights.return.eta ? ` · ETA ${dt(b.flights.return.eta)}` : ""}</Field>
          <Field label="Entrega">{[b.delivery.type, b.delivery.location].filter(Boolean).join(" · ") || "—"}</Field>
          <Field label="Canal">{b.origin.channelLabel} · {b.origin.channelDetail}</Field>
          <Field label="Origem">{b.origin.label}{b.origin.externalReference ? ` · ref. ${b.origin.externalReference}` : ""}{b.origin.partnerFee ? ` · comissão ${b.origin.partnerFee}` : ""}</Field>
          <Field label="Preço">
            {eur(b.price.bookingPrice, cur)}
            {priceChanged && <span className="ml-1 text-xs text-amber-700">(na criação {eur(b.price.originalBookingPrice, cur)})</span>}
          </Field>
          <Field label="Pago / método">{paid != null ? eur(paid, cur) : "—"} · {b.price.paymentMethod ?? "—"}{b.price.paymentSource ? ` (${b.price.paymentSource})` : ""}</Field>
        </div>
        {b.phases.length > 0 && (
          <div className="flex flex-wrap gap-2 border-t pt-3">
            {b.phases.map((p) => (
              <span key={p.key} className="rounded-full bg-muted px-2 py-0.5 text-xs"><span className="text-muted-foreground">{p.label}:</span> {dt(p.at)}</span>
            ))}
            {b.customerCheckinEtaMin != null && <span className="rounded-full bg-muted px-2 py-0.5 text-xs">Cliente chega em ~{b.customerCheckinEtaMin} min</span>}
          </div>
        )}
        {b.remarks && <p className="rounded bg-muted/50 p-2 text-xs whitespace-pre-wrap"><span className="text-muted-foreground">Notas: </span>{b.remarks}</p>}
      </CardContent>
    </Card>
  );
}

function ClientVehicle({ data, scope }: { data: MainFound; scope: { projectId?: number } }) {
  const b = data.core;
  const cases = trpc.bookingFile.ourCases.useQuery({ id: data.id, code: b.code, email: b.client.email, ...scope }, { staleTime: 60_000, retry: false });
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader className="py-3"><CardTitle className="flex items-center gap-2 text-sm"><User className="w-4 h-4" /> Cliente</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 pt-0">
          <Field label="Nome">{b.client.name ?? "—"}{b.client.anonymized ? " (anonimizado)" : ""}</Field>
          <Field label="Língua">{b.client.language ?? "—"}</Field>
          <Field label="Email">{b.client.email ?? "—"}</Field>
          <Field label="Telefone">{b.client.phone ?? "—"}</Field>
          <Field label="NIF">{b.client.nif ?? "—"}</Field>
          <Field label="Nome fiscal">{b.client.taxName ?? "—"}</Field>
          {/* 17f: ligar, WhatsApp e email ao cliente daqui (anonimizado: não).
              D41 (Jorge, 3 out 2026): o email ao cliente sai pela caixa info. */}
          {!b.client.anonymized && (
            <ContactActions className="col-span-2" phones={[b.client.phone]} emails={[b.client.email]} mailbox="info" />
          )}
          {cases.data?.crmEmail && (
            <div className="col-span-2">
              <Link href={`/clientes?email=${encodeURIComponent(cases.data.crmEmail)}`} className="inline-flex items-center gap-1 text-xs text-primary underline">
                Ver ficha do cliente (CRM) <ExternalLink className="w-3 h-3" />
              </Link>
            </div>
          )}
          {/* D42: quem entrega/levanta pelo cliente — com os mesmos botões (ligar, WhatsApp, email). */}
          {data.drivers.length > 0 && (
            <div className="col-span-2 space-y-1.5 text-xs">
              <span className="text-muted-foreground">Outra pessoa entrega/levanta:</span>
              {data.drivers.map((dr, i) => (
                <div key={i} className="rounded-md border p-2 space-y-1">
                  <div>{[dr.name, dr.phone, dr.email].filter(Boolean).join(" · ") || "—"}</div>
                  {!b.client.anonymized && (dr.phone || dr.email) && (
                    <ContactActions phones={[dr.phone]} emails={[dr.email]} mailbox="info" />
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="py-3"><CardTitle className="flex items-center gap-2 text-sm"><Car className="w-4 h-4" /> Viatura</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 pt-0">
          <Field label="Matrícula">{b.vehicle.plate ?? "—"}</Field>
          <Field label="Tipo">{b.vehicle.type ?? "—"}</Field>
          <Field label="Marca / modelo">{[b.vehicle.brand, b.vehicle.model].filter(Boolean).join(" ") || "—"}</Field>
          <Field label="Cor">{b.vehicle.color ?? "—"}</Field>
          <Field label="Km">{b.vehicle.kms ?? "—"}</Field>
          <Field label="Autonomia">{b.vehicle.range ?? "—"}</Field>
          <Field label="Condutor da entrada">{b.agents.checkIn ?? "—"}</Field>
          <Field label="Condutor da saída">{b.agents.checkOut ?? "—"}</Field>
        </CardContent>
      </Card>
    </div>
  );
}

function SignatureView({ label, sig }: { label: string; sig: any }) {
  if (!sig) return <Field label={label}>—</Field>;
  if (sig.kind === "image") return <div><div className="text-[11px] uppercase text-muted-foreground">{label}</div><img src={sig.src} alt={label} className="mt-1 max-h-40 rounded border bg-white" /></div>;
  if (sig.kind === "link") return <Field label={label}><a href={sig.url} target="_blank" rel="noopener noreferrer" className="text-primary underline">Abrir assinatura</a></Field>;
  if (sig.kind === "too_large") return <Field label={label}>Demasiado grande para mostrar aqui</Field>;
  return <Field label={label}><span className="text-xs break-all">{sig.raw}</span></Field>;
}

function EvidenceSection({ data, scope }: { data: MainFound; scope: { projectId?: number } }) {
  const b = data.core;
  const ev = trpc.bookingFile.evidence.useQuery({ id: data.id, ...scope }, { staleTime: 60_000, retry: false });
  const [showSigs, setShowSigs] = useState(false);
  const hasSigs = b.evidence.hasCheckinSignature || b.evidence.hasCheckoutSignature;
  const sigs = trpc.bookingFile.signatures.useQuery({ id: data.id, ...scope }, { enabled: showSigs && hasSigs, staleTime: 5 * 60_000, retry: false });
  const e = ev.data;
  return (
    <Section title="Provas" icon={<Video className="w-4 h-4" />}>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Vídeo do check-in">
          {b.evidence.video ? <StoredLink url={b.evidence.video.url} raw={b.evidence.video.url ? null : b.evidence.video.raw} bookingId={b.id} label="Ver vídeo" /> : "Sem vídeo"}
        </Field>
        <Field label="Assinaturas">
          {!hasSigs ? "Sem assinaturas" : !showSigs ? (
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setShowSigs(true)}><PenLine className="w-3 h-3 mr-1" /> Mostrar assinaturas</Button>
          ) : sigs.isLoading ? <Loading /> : sigs.error ? <QueryErrorNote error={sigs.error} onRetry={() => sigs.refetch()} retrying={sigs.isFetching} /> : null}
        </Field>
      </div>
      {showSigs && sigs.data && (sigs.data.available ? (
        <div className="grid gap-3 md:grid-cols-2">
          <SignatureView label="Entrada" sig={sigs.data.checkin} />
          <SignatureView label="Saída" sig={sigs.data.checkout} />
        </div>
      ) : <UnavailableNote reason={(sigs.data as Unavail).reason} />)}
      <div>
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Anexos</div>
        {ev.isLoading ? <Loading /> : ev.error ? <QueryErrorNote error={ev.error} onRetry={() => ev.refetch()} retrying={ev.isFetching} /> : !e ? null : !e.available ? <UnavailableNote reason={(e as Unavail).reason} /> : e.attachments.length === 0 ? (
          <p className="text-xs text-muted-foreground">Sem anexos.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {e.attachments.map((a) => (
              <li key={a.id} className="text-xs"><StoredLink url={a.url} raw={a.url ? null : a.raw} bookingId={b.id} label={a.typeLabel} /> <span className="text-muted-foreground">{dt(a.createdAt)}</span></li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

function TimelineSection({ id, scope }: { id: string; scope: { projectId?: number } }) {
  const [enabled, setEnabled] = useState(false);
  const q = trpc.bookingFile.timeline.useQuery({ id, ...scope }, { enabled, staleTime: 60_000, retry: false });
  const [all, setAll] = useState(false);
  const d = q.data;
  const entries = d?.available ? d.entries : [];
  const shown = all ? entries : entries.slice(0, 40);
  return (
    <Section title="Linha do tempo" icon={<Clock className="w-4 h-4" />} lazy onOpen={() => setEnabled(true)} right={d?.available ? `${entries.length}` : undefined}>
      {q.error ? <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} /> : q.isLoading || (!d && enabled) ? <Loading /> : !d ? null : !d.available ? <UnavailableNote reason={(d as Unavail).reason} /> : (
        <>
          <MissingNote missing={d.missing} />
          {entries.length === 0 && <p className="text-xs text-muted-foreground">Sem histórico (o sistema da Multipark só guarda histórico desde 2 mar 2026).</p>}
          <ol className="space-y-2">
            {shown.map((t) => (
              <li key={t.id} className="rounded-md border p-2">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium">{dt(t.at)}</span>
                  <Badge variant="outline" className={t.source === "activity" ? "border-sky-300 text-sky-700" : ""}>{t.kindLabel}</Badge>
                  {t.who && <span>{t.who}{t.role ? ` (${t.role})` : ""}</span>}
                  {t.platform && <span className="text-muted-foreground">· {t.platform}</span>}
                  {t.gps && (
                    <a href={t.gps.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-primary underline">
                      <MapPin className="w-3 h-3" /> mapa
                    </a>
                  )}
                </div>
                {t.changes.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-xs">
                    {t.changes.map((c, i) => (
                      <li key={i}>
                        <span className="text-muted-foreground">{c.label}</span>
                        {(c.from != null || c.to != null) && <>: <span className="line-through decoration-slate-400">{c.from ?? "—"}</span> → <span className="font-medium">{c.to ?? "—"}</span></>}
                      </li>
                    ))}
                  </ul>
                )}
                {t.snapshotSummary && <p className="mt-1 text-[11px] text-muted-foreground">Estado: {t.snapshotSummary}</p>}
                {t.remarks && <p className="mt-1 text-xs whitespace-pre-wrap">{t.remarks}</p>}
              </li>
            ))}
          </ol>
          {entries.length > shown.length && <Button size="sm" variant="ghost" onClick={() => setAll(true)}>Ver todas ({entries.length})</Button>}
          <p className="text-[11px] text-muted-foreground">O GPS vem da app Multipark; o percurso real dos condutores está nos dados do Zello.</p>
        </>
      )}
    </Section>
  );
}

function LocationSection({ data }: { data: MainFound }) {
  const l = data.location;
  return (
    <Card>
      <CardHeader className="py-3"><CardTitle className="flex items-center gap-2 text-sm"><MapPin className="w-4 h-4" /> Onde está o carro</CardTitle></CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 pt-0">
        {!l ? <p className="col-span-2 text-xs text-muted-foreground">Sem dados de lugar.</p> : (
          <>
            <Field label="N.º">{l.code ?? "—"}</Field>
            <Field label="Alocação">{l.allocation ? [l.allocation.name, l.allocation.parkingType ? (PARKING_TYPE_LABELS[l.allocation.parkingType] ?? l.allocation.parkingType) : null].filter(Boolean).join(" · ") : "—"}</Field>
            <Field label="Garagem">
              {l.garage ? (l.garage.mapLink ? <a href={l.garage.mapLink} target="_blank" rel="noopener noreferrer" className="text-primary underline">{l.garage.name ?? "Garagem"}</a> : l.garage.name ?? "—") : "—"}
            </Field>
            <Field label="Lugar">{l.spot ? `Fila ${l.spot.row ?? "?"} · ${l.spot.spot ?? "?"}${l.spot.hasCharger ? " · carregador" : ""}` : "—"}</Field>
            {l.external && <Field label="Lugar (externo)">{[l.external.garage, l.external.row, l.external.spot].filter(Boolean).join(" · ")}</Field>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Validation({ label, v }: { label: string; v: { done: boolean; at: string | null; by: string | null } }) {
  return (
    <Field label={label}>
      {v.done ? <span className="text-emerald-700">Sim</span> : <span className="text-muted-foreground">Não</span>}
      {(v.by || v.at) && <span className="block text-xs font-normal text-muted-foreground">{[v.by, v.at ? dt(v.at) : null].filter(Boolean).join(" · ")}</span>}
    </Field>
  );
}

function AccountsSection({ core, accounts, loading, currency, error, onRetry, retrying }: {
  core: MainFound["core"]; accounts: any; loading: boolean; currency: string; error: { message: string } | null; onRetry: () => void; retrying: boolean;
}) {
  const a = accounts;
  return (
    <Section title="Contas" icon={<CreditCard className="w-4 h-4" />}>
      <div className="grid grid-cols-3 gap-3">
        <Validation label="Condutor validou" v={core.cashier.driverValidated} />
        <Validation label="Dinheiro conferido" v={core.cashier.cashValidated} />
        <Validation label="Caixa fechada" v={core.cashier.cashierClosed} />
      </div>
      {loading ? <Loading /> : error ? <QueryErrorNote error={error} onRetry={onRetry} retrying={retrying} /> : !a ? null : !a.available ? <UnavailableNote reason={a.reason} /> : (
        <>
          <MissingNote missing={a.missing} />
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Linhas da conta</div>
            {a.pricing.length === 0 ? <p className="text-xs text-muted-foreground">Sem linhas.</p> : (
              <table className="mt-1 w-full text-xs">
                <thead><tr className="text-left text-muted-foreground"><th className="py-1">Descrição</th><th>Tipo</th><th className="text-right">Total</th><th className="text-right">Pago</th><th>Método</th></tr></thead>
                <tbody>
                  {a.pricing.map((l: any) => (
                    <tr key={l.id} className="border-t">
                      <td className="py-1">{l.description ?? "—"}</td><td>{l.category ?? ""}</td>
                      <td className="text-right">{eur(l.total, currency)}</td><td className="text-right">{eur(l.amountPaid, currency)}</td><td>{l.paymentMethod ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {a.payments.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Pagamentos</div>
              <ul className="mt-1 space-y-0.5 text-xs">
                {a.payments.map((p: any) => <li key={p.id}>{dt(p.recordedAt)} · <span className="font-medium">{eur(p.amount, currency)}</span> · {p.paymentMethod ?? "—"}{p.line ? <span className="text-muted-foreground"> ({p.line})</span> : null}</li>)}
              </ul>
            </div>
          )}
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Faturas</div>
            {a.billing.length === 0 ? <p className="text-xs text-muted-foreground">Sem faturas.</p> : (
              <ul className="mt-1 space-y-0.5 text-xs">
                {a.billing.map((f: any) => (
                  <li key={f.id}>
                    <span className="font-medium">{f.invoice ?? (f.invoiceExpressId ? `InvoiceExpress ${f.invoiceExpressId}` : "—")}</span>
                    {f.invoiceExpressType ? ` · ${f.invoiceExpressType}` : ""} · {f.emitted ? "emitida" : "por emitir"} · {eur(f.amount, f.currency || currency)} · {dt(f.createdAt)}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {a.cancellation && (
            <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs">
              <span className="font-medium">Cancelada</span> {dt(a.cancellation.createdAt)} · {a.cancellation.type ?? "—"}
              {a.cancellation.notes && <span className="block whitespace-pre-wrap">{a.cancellation.notes}</span>}
              <span className="block">Reembolso: {a.cancellation.refund ? (a.cancellation.refunded ? `feito, ${eur(a.cancellation.refundedAmount, currency)} em ${dt(a.cancellation.refundedAt)}` : "pedido, ainda por fazer") : "não"}</span>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

function ExtrasSection({ id, scope, currency }: { id: string; scope: { projectId?: number }; currency: string }) {
  const q = trpc.bookingFile.extras.useQuery({ id, ...scope }, { staleTime: 60_000, retry: false });
  const d = q.data;
  return (
    <Section title="Serviços extra" icon={<Sparkles className="w-4 h-4" />}>
      {q.isLoading ? <Loading /> : q.error ? <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} /> : !d ? null : !d.available ? <UnavailableNote reason={(d as Unavail).reason} /> : d.extras.length === 0 ? (
        <p className="text-xs text-muted-foreground">Sem serviços extra.</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {d.extras.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={x.done ? "border-emerald-400 text-emerald-700" : "border-amber-400 text-amber-700"}>{x.done ? "Feito" : "Por fazer"}</Badge>
              <span className="font-medium">{x.name ?? "—"}</span>
              <span>{eur(x.price, currency)}</span>
              {x.catalogPrice != null && x.price != null && Math.abs(x.catalogPrice - x.price) >= 0.01 && <span className="text-muted-foreground">(tabela {eur(x.catalogPrice, currency)})</span>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function CommunicationSection({ id, scope }: { id: string; scope: { projectId?: number } }) {
  const [enabled, setEnabled] = useState(false);
  const q = trpc.bookingFile.communication.useQuery({ id, ...scope }, { enabled, staleTime: 60_000, retry: false });
  const d = q.data;
  return (
    <Section title="Comunicação (app Multipark)" icon={<MessageSquare className="w-4 h-4" />} lazy onOpen={() => setEnabled(true)}>
      {q.error ? <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} /> : q.isLoading || (!d && enabled) ? <Loading /> : !d ? null : !d.available ? <UnavailableNote reason={(d as Unavail).reason} /> : (
        <>
          <MissingNote missing={d.missing} />
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Chat</div>
            {d.chat.length === 0 ? <p className="text-xs text-muted-foreground">Sem mensagens.</p> : (
              <ul className="mt-1 space-y-1">
                {d.chat.map((m) => (
                  <li key={m.id} className={`rounded-md p-2 text-xs ${m.senderRole === "CLIENT" ? "bg-muted/60" : "bg-primary/5"}`}>
                    <div className="text-[11px] text-muted-foreground">{m.senderName ?? "—"} · {m.senderRole ?? ""} · {dt(m.at)}</div>
                    <div className="whitespace-pre-wrap">{m.content ?? ""}</div>
                    {m.attachmentUrl && <a href={m.attachmentUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline">anexo</a>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Emails enviados pela app</div>
            {d.emails.length === 0 ? <p className="text-xs text-muted-foreground">Sem emails.</p> : (
              <ul className="mt-1 space-y-0.5 text-xs">
                {d.emails.map((e) => <li key={e.id}>{dt(e.sentAt)} · <span className="font-medium">{e.emailType ?? "—"}</span> · {e.subject ?? ""} <span className="text-muted-foreground">→ {e.recipient ?? ""}</span></li>)}
              </ul>
            )}
          </div>
        </>
      )}
    </Section>
  );
}

function FeedbackSection({ id, scope }: { id: string; scope: { projectId?: number } }) {
  const q = trpc.bookingFile.feedback.useQuery({ id, ...scope }, { staleTime: 60_000, retry: false });
  const d = q.data;
  return (
    <Section title="Ocorrências e avaliação" icon={<AlertTriangle className="w-4 h-4" />}>
      {q.isLoading ? <Loading /> : q.error ? <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} /> : !d ? null : !d.available ? <UnavailableNote reason={(d as Unavail).reason} /> : (
        <>
          <MissingNote missing={d.missing} />
          {d.occurrencesHidden ? <p className="text-xs text-muted-foreground">As ocorrências só aparecem a team leaders e acima.</p> : d.occurrences.length === 0 ? <p className="text-xs text-muted-foreground">Sem ocorrências na app Multipark.</p> : (
            <ul className="space-y-1 text-xs">
              {d.occurrences.map((o) => (
                <li key={o.id} className="rounded-md border p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/ocorrencias?mp=${encodeURIComponent(o.id)}`} className="font-medium text-primary underline">{o.title}</Link>
                    <Badge variant="outline" className={o.resolved ? "border-emerald-400 text-emerald-700" : "border-red-300 text-red-700"}>{o.resolved ? "Resolvida" : "Aberta"}</Badge>
                    {o.priority && <span className="text-muted-foreground">{o.priority}</span>}
                    <span className="text-muted-foreground">{dt(o.createdAt)}{o.createdBy ? ` · ${o.createdBy}` : ""}</span>
                    {o.gpsUrl && <a href={o.gpsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-primary underline"><MapPin className="w-3 h-3" /> mapa</a>}
                    {o.attachmentUrl && <a href={o.attachmentUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline">anexo</a>}
                  </div>
                  {o.remarks && <p className="mt-1 whitespace-pre-wrap">{o.remarks}</p>}
                </li>
              ))}
            </ul>
          )}
          <div className="border-t pt-2 text-xs">
            {d.review ? (
              <span className="inline-flex flex-wrap items-center gap-1">
                <Star className="w-3.5 h-3.5 text-amber-500" /> <span className="font-medium">{d.review.rating ?? "?"}/5</span>
                <span className="text-muted-foreground">{d.review.clientName ?? ""} · {dt(d.review.createdAt)}</span>
                {d.review.text && <span className="block w-full whitespace-pre-wrap">{d.review.text}</span>}
              </span>
            ) : <span className="text-muted-foreground">Sem avaliação na app Multipark.</span>}
          </div>
        </>
      )}
    </Section>
  );
}

const COMPLAINT_STATUS: Record<string, string> = { new: "Nova", analyzing: "Em análise", waiting_client: "À espera do cliente", resolved: "Resolvida", closed: "Fechada", converted: "Convertida" };
const LOST_STATUS: Record<string, string> = { new: "Novo", investigating: "Em investigação", found: "Encontrado", returned: "Devolvido", closed: "Fechado", converted: "Convertido" };

function OurCases({ id, code, email, scope }: { id: string; code: string | null; email: string | null; scope: { projectId?: number } }) {
  const q = trpc.bookingFile.ourCases.useQuery({ id, code, email, ...scope }, { staleTime: 60_000, retry: false });
  const d = q.data;
  return (
    <Card>
      <CardHeader className="py-3"><CardTitle className="flex items-center gap-2 text-sm"><FileText className="w-4 h-4" /> Os nossos casos</CardTitle></CardHeader>
      <CardContent className="space-y-2 pt-0 text-xs">
        {q.isLoading ? <Loading /> : q.error ? <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} /> : !d ? null : (
          <>
            {!d.canComplaints && !d.canLost && <p className="text-muted-foreground">Sem acesso a reclamações nem a perdidos e achados.</p>}
            {d.canComplaints && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Reclamações</div>
                {d.complaints.length === 0 ? <p className="text-muted-foreground">Nenhuma.</p> : d.complaints.map((c) => (
                  <Link key={c.id} href={`/reclamacoes?id=${c.id}`} className="block rounded border px-2 py-1 hover:bg-muted/50">
                    #{c.id} · {c.title} <span className="text-muted-foreground">· {COMPLAINT_STATUS[c.status] ?? c.status} · {fmtPTDate(c.createdAt)}</span>
                  </Link>
                ))}
              </div>
            )}
            {d.canLost && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Perdidos e achados</div>
                {d.lostFound.length === 0 ? <p className="text-muted-foreground">Nenhum.</p> : d.lostFound.map((l) => (
                  <Link key={l.id} href={`/perdidos-achados/caso/${l.id}`} className="block rounded border px-2 py-1 hover:bg-muted/50">
                    #{l.id} · {l.title} <span className="text-muted-foreground">· {LOST_STATUS[l.status] ?? l.status} · {fmtPTDate(l.createdAt)}</span>
                  </Link>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
