/**
 * Ficha de cliente — CRM (Jorge, 27 set 2026; desenho "Ficha de cliente").
 *
 * Cabeçalho com o n.º de cliente (nosso), avisos (ficha repetida, sem email,
 * email estranho), identidade (foto → foto do carro, emails, telefones, NIF,
 * ligações pessoa ↔ empresa, origem, perfil, etiquetas, consentimentos),
 * indicadores (gasto por mês, parques), linha do tempo (reservas, registo,
 * reclamações, críticas, perdidos), reservas com "Abrir na Multipark",
 * carros com fotos, próxima reserva, hábitos, parques usados, fusões.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CommunicationsTimeline } from "@/components/mail/CommunicationsTimeline";
import {
  AlertTriangle, Camera, ChevronLeft, ExternalLink, Loader2, MailX, MoreHorizontal, Pencil, Plus, Trash2, Undo2,
} from "lucide-react";
import { REASON_LABELS, type SuggestionReason } from "@shared/crmIdentity";
import {
  ALERT_CLASS, BookingStatusPill, CarGlyph, ClientAvatar, Lbl, Pill, SegmentPill, eur, fmtPhone, monthYear, num, relDays,
  shortDate, shortDateTime, utcDate, waLink,
} from "@/components/crm/crmUi";
import { EditClientDialog, IbanDialog, MergeDialog, RelationDialog, VehicleDialog, type VehicleForm } from "@/components/crm/CrmClientDialogs";
import { FindEmailButton } from "@/components/crm/FindEmail";
import { ProAccountSection } from "@/components/crm/ProAccountSection";
import { isCrmFile, type CrmBooking, type CrmFile } from "@/components/crm/crmTypes";

/** Sistema antigo (Firebase): endereço por confirmar com o Rafael. */
const FIREBASE_CLIENT_URL: ((c: { email: string | null; phone: string | null }) => string) | null = null;

type Tab = "timeline" | "bookings" | "comms" | "notes" | "log";

export default function CrmClientPage() {
  const { id: raw } = useParams<{ id: string }>();
  const id = Number(raw);
  const [, navigate] = useLocation();
  const q = trpc.crm.get.useQuery({ id }, { enabled: Number.isInteger(id) && id > 0, retry: false });
  const file = isCrmFile(q.data) ? q.data : null;
  const redirectTo = q.data && !file ? (q.data as { redirectTo?: number | null }).redirectTo ?? null : null;
  useEffect(() => { if (redirectTo) navigate(`/clientes/${redirectTo}`, { replace: true }); }, [redirectTo, navigate]);

  if (!Number.isInteger(id) || id <= 0) return <NotFound />;
  if (q.isLoading || redirectTo) return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  if (q.error || !file) return <NotFound message={q.error?.message} />;
  return <ClientFile c={file} refetch={() => q.refetch()} />;
}

function NotFound({ message }: { message?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-20 text-center">
      <p className="text-sm font-semibold">{message ?? "Cliente não encontrado."}</p>
      <Button variant="outline" asChild><Link href="/clientes"><ChevronLeft className="h-4 w-4" />Voltar aos clientes</Link></Button>
    </div>
  );
}

type FileData = CrmFile;
type Booking = CrmBooking;

function ClientFile({ c, refetch }: { c: FileData; refetch: () => void }) {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const reload = () => { refetch(); utils.crm.list.invalidate(); };
  const [tab, setTab] = useState<Tab>("timeline");
  const [editOpen, setEditOpen] = useState(false);
  const [vehicle, setVehicle] = useState<VehicleForm | null | undefined>(undefined);
  const [relOpen, setRelOpen] = useState(false);
  const [personOpen, setPersonOpen] = useState(false);
  const [merge, setMerge] = useState<{ id: number; name: string | null } | null | undefined>(undefined);
  const [ibanOpen, setIbanOpen] = useState(false);
  const tabsRef = useRef<HTMLDivElement>(null);

  const history = trpc.clients.history.useQuery(
    { clientId: c.id },
    { retry: false, staleTime: 60_000 },
  );
  const mail = trpc.mail.timeline.useQuery({ type: "client", id: c.primaryEmail ?? "" }, { enabled: !!c.primaryEmail, retry: false, staleTime: 60_000 });
  // fase 2: conta corrente Pro (null = a ficha não é uma conta Pro da Multipark)
  const pro = trpc.crm.proAccount.useQuery({ clientId: c.id }, { retry: false, staleTime: 60_000 });

  const contact = trpc.crm.contact.useMutation({ onSuccess: reload, onError: (e) => toast.error(e.message) });
  const removeRel = trpc.crm.relation.useMutation({ onSuccess: reload, onError: (e) => toast.error(e.message) });
  const split = trpc.crm.split.useMutation({ onSuccess: () => { toast.success("Fichas separadas"); reload(); }, onError: (e) => toast.error(e.message) });
  const dismiss = trpc.crm.dismissSuggestion.useMutation({ onSuccess: reload, onError: (e) => toast.error(e.message) });

  const upload = trpc.crm.uploadPhoto.useMutation({ onSuccess: () => { toast.success("Foto guardada"); reload(); }, onError: (e) => toast.error(e.message) });
  const pickPhoto = (vehicleId: number | null) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/jpeg,image/png,image/webp";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        // reduzida no browser: o pedido à API tem de ficar abaixo de 4,5 MB (Vercel)
        const b64 = await shrinkImage(file, 1280);
        upload.mutate({ clientId: c.id, vehicleId, fileBase64: b64, mimeType: "image/jpeg" });
      } catch {
        toast.error("Não foi possível ler a imagem.");
      }
    };
    input.click();
  };

  const m = c.metrics;
  const now = new Date();
  const thisYear = c.bookings.filter((b) => utcDate(b.checkIn)?.getUTCFullYear() === now.getUTCFullYear() && !isCancelled(b)).length;
  const habits = useMemo(() => habitsOf(c.bookings), [c.bookings]);
  const latest = c.bookings[0] ?? null;
  const complaints = history.data?.complaints ?? [];
  const openComplaints = complaints.filter((x: any) => !/resolv|fechad|closed|resolved/i.test(String(x.status ?? ""))).length;
  const messages = mail.data?.items?.length ?? null;
  const car = c.vehicles[0] ?? null;

  const kpis: { label: string; value: string; note: string; onClick?: () => void }[] = [
    { label: "Reservas", value: num(m.bookings), note: thisYear ? `${thisYear} este ano` : `${num(m.cancelled)} canceladas`, onClick: () => goTab("bookings") },
    ...(c.canSeeTotals ? [
      { label: "Gasto total", value: eur(m.totalSpent), note: m.firstVisit ? `desde ${new Date(utcDate(m.firstVisit)!).getUTCFullYear()}` : "" },
      { label: "Gasto por mês", value: eur(m.spentPerMonth), note: "média 12 meses" },
      { label: "Por estadia", value: eur(m.avgPerStay), note: "média" },
    ] : [
      { label: "Estadias", value: num(m.completed), note: "concluídas" },
      { label: "Canceladas", value: num(m.cancelled), note: "" },
      { label: "Futuras", value: num(m.upcoming), note: "" },
    ]),
    { label: "Última vinda", value: shortDate(m.lastVisit), note: relDays(m.lastVisit) },
    { label: "Parques", value: num(m.parks.length), note: m.preferredPark ?? "" },
    { label: "Reclamações", value: history.data ? num(complaints.length) : "—", note: complaints.length ? (openComplaints ? `${openComplaints} em aberto` : "resolvidas") : "" },
    { label: "Mensagens", value: messages == null ? "—" : num(messages), note: "email e WhatsApp", onClick: () => goTab("comms") },
  ];

  function goTab(t: Tab) {
    setTab(t);
    tabsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const relText = (r: FileData["relations"][number]) => {
    if (r.kind === "employee") return r.direction === "out" ? "Trabalha em" : "Funcionário:";
    if (r.kind === "manager") return r.direction === "out" ? "Gestor de" : "Gestor:";
    if (r.kind === "family") return "Familiar:";
    return "Ligado a";
  };

  return (
    <div className="flex flex-col gap-4">
      {/* cabeçalho */}
      <div className="flex flex-wrap items-center gap-2.5">
        <Button variant="ghost" onClick={() => (window.history.length > 1 ? window.history.back() : navigate("/clientes"))}><ChevronLeft className="h-4 w-4" />Voltar</Button>
        <h1 className="font-display text-[22px] font-bold tracking-[-0.02em]">{c.displayName ?? "Sem nome"}</h1>
        {c.isPro && <SegmentPill id="pro" />}
        {c.segments.map((s) => <SegmentPill key={s} id={s} />)}
        <Pill className="bg-secondary text-secondary-foreground">N.º {c.id.toLocaleString("pt-PT")}</Pill>
        {c.kind === "company" && <Pill className="bg-muted text-foreground">Empresa</Pill>}
        {m.firstVisit && <Pill className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">Cliente desde {monthYear(m.firstVisit)}</Pill>}
        <div className="flex-1" />
        {latest && (
          <Button variant="outline" asChild>
            <a href={latest.multiparkUrl} target="_blank" rel="noreferrer">Abrir na Multipark<ExternalLink className="h-3.5 w-3.5" /></a>
          </Button>
        )}
        {FIREBASE_CLIENT_URL ? (
          <Button variant="outline" asChild><a href={FIREBASE_CLIENT_URL({ email: c.primaryEmail, phone: c.primaryPhone })} target="_blank" rel="noreferrer">Abrir no sistema antigo<ExternalLink className="h-3.5 w-3.5" /></a></Button>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild><span><Button variant="outline" disabled>Abrir no sistema antigo<ExternalLink className="h-3.5 w-3.5" /></Button></span></TooltipTrigger>
            <TooltipContent>Falta o endereço do sistema antigo (Firebase).</TooltipContent>
          </Tooltip>
        )}
        <Button variant="outline" onClick={() => goTab("log")}>Registo de ações</Button>
        {c.canMerge && <Button variant="outline" onClick={() => setMerge(null)}>Juntar com…</Button>}
        {c.canEdit && <Button onClick={() => setEditOpen(true)}><Pencil className="h-4 w-4" />Editar</Button>}
      </div>

      {/* avisos */}
      {c.suggestions.slice(0, 2).map((s) => (
        <Banner key={s.id} tone="amber">
          <span className="flex-1">
            <strong>Possível ficha repetida:</strong> <Link href={`/clientes/${s.otherId}`} className="font-semibold underline">{s.otherName ?? `N.º ${s.otherId}`}</Link>{" "}
            ({s.reasons.map((r) => REASON_LABELS[r as SuggestionReason] ?? r).join(", ")} · semelhança {s.score} %).
          </span>
          {c.canMerge && <Button size="sm" variant="outline" className="h-[30px]" onClick={() => setMerge({ id: s.otherId, name: s.otherName })}>Juntar</Button>}
          {c.canEdit && <Button size="sm" variant="ghost" className="h-[30px]" disabled={dismiss.isPending} onClick={() => dismiss.mutate({ id: s.id })}>Não é a mesma pessoa</Button>}
        </Banner>
      ))}
      {c.alerts.genericEmailOnly && (
        <Banner tone="amber">
          <MailX className="h-4 w-4 shrink-0 text-amber-700" />
          <span className="flex-1"><strong>Email estranho:</strong> o email desta ficha é de balcão ou de agregador, não do cliente. Procure o verdadeiro na nossa caixa ou peça-o ao cliente.</span>
          <FindEmailButton clientId={c.id} onUsed={reload} genericIds={c.emails.filter((e) => e.generic).map((e) => e.id)} canEdit={c.canEdit} />
        </Banner>
      )}
      {c.alerts.noEmail && !c.alerts.genericEmailOnly && (
        <Banner tone="red">
          <MailX className="h-4 w-4 shrink-0 text-red-700" />
          <span className="flex-1"><strong>Sem email:</strong> pedir o email ao cliente {c.nextBooking ? `na próxima vinda (${shortDate(c.nextBooking.checkIn)})` : "no próximo contacto"}.</span>
        </Banner>
      )}

      {/* identidade */}
      <div className="flex flex-col gap-6 rounded-[10px] border bg-card p-5 md:flex-row">
        <div className="flex w-full shrink-0 flex-col items-center gap-2 md:w-[132px]">
          <div className="relative">
            <ClientAvatar name={c.displayName} photoUrl={c.photoUrl} carPhotoUrl={car?.photoUrl} carColor={car?.color} size={112} carFallback={!!car}
              className="border-[3px] border-card shadow-[0_0_0_1px_var(--border)]" />
            {c.canEdit && (
              <button type="button" aria-label="Alterar foto" onClick={() => pickPhoto(null)} disabled={upload.isPending}
                className="absolute bottom-1 right-1 flex h-7 w-7 items-center justify-center rounded-full border bg-card hover:bg-muted">
                {upload.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
              </button>
            )}
          </div>
          {!c.photoUrl && <div className="text-center text-[11px] leading-snug text-muted-foreground">{car ? "Sem foto do cliente: mostra a do carro" : "Sem foto"}</div>}
        </div>

        <div className="grid flex-1 grid-cols-1 gap-x-6 gap-y-4 text-[13px] sm:grid-cols-2 lg:grid-cols-3">
          <Block title="Emails" addInline={c.canEdit ? { placeholder: "email@exemplo.pt", type: "email", submit: (v) => contact.mutateAsync({ op: "addEmail", clientId: c.id, value: v, primary: c.emails.every((e) => e.generic) }) } : undefined}>
            {c.emails.length === 0 && <span className="text-muted-foreground">Sem email</span>}
            {c.emails.map((e) => (
              <Row key={e.id} menu={c.canEdit ? [
                ...(!e.isPrimary && !e.generic ? [{ label: "Tornar principal", run: () => contact.mutate({ op: "primaryEmail", clientId: c.id, itemId: e.id }) }] : []),
                { label: "Retirar", danger: true, run: () => contact.mutate({ op: "removeEmail", clientId: c.id, itemId: e.id, reason: e.generic ? "email de balcão/agregador" : null }) },
              ] : undefined}>
                <a href={`mailto:${e.email}`} className={cn("truncate", e.isPrimary ? "font-bold text-foreground" : "text-muted-foreground")}>{e.email}</a>
                {e.isPrimary && <Pill className="h-[18px] bg-secondary text-secondary-foreground">principal</Pill>}
                {e.generic && <Pill className="h-[18px] bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">estranho</Pill>}
              </Row>
            ))}
          </Block>

          <Block title="Telefones" addInline={c.canEdit ? { placeholder: "+351 912 345 678", type: "tel", submit: (v) => contact.mutateAsync({ op: "addPhone", clientId: c.id, value: v, primary: c.phones.length === 0 }) } : undefined}>
            {c.phones.length === 0 && <span className="text-muted-foreground">Sem telefone</span>}
            {c.phones.map((p) => (
              <Row key={p.id} menu={c.canEdit ? [
                ...(!p.isPrimary ? [{ label: "Tornar principal", run: () => contact.mutate({ op: "primaryPhone", clientId: c.id, itemId: p.id }) }] : []),
                ...(!p.whatsapp ? [{ label: "Tem WhatsApp", run: () => contact.mutate({ op: "addPhone", clientId: c.id, value: p.phone, whatsapp: true }) }] : []),
                { label: "Retirar", danger: true, run: () => contact.mutate({ op: "removePhone", clientId: c.id, itemId: p.id }) },
              ] : undefined}>
                <a href={`tel:${p.phone}`} className={cn("truncate", p.isPrimary ? "font-bold text-foreground" : "text-muted-foreground")}>{fmtPhone(p.phone)}</a>
                {p.whatsapp && <a href={waLink(p.phone)} target="_blank" rel="noreferrer"><Pill className="h-[18px] bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">WhatsApp</Pill></a>}
                {p.label && <span className="text-xs text-muted-foreground">({p.label})</span>}
              </Row>
            ))}
          </Block>

          <Block title="NIF e faturação">
            <div><strong>{c.nif ?? "—"}</strong></div>
            {(c.taxName || c.taxAddress) && <div className="text-muted-foreground">{[c.taxName, c.taxAddress].filter(Boolean).join(" · ")}</div>}
            {c.canSeeTotals && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">IBAN:</span>
                <span className="font-mono">{c.ibanMasked ?? "—"}</span>
                {c.canEdit && <button type="button" className="text-xs font-semibold text-primary" onClick={() => setIbanOpen(true)}>{c.hasIban ? "alterar" : "acrescentar"}</button>}
              </div>
            )}
          </Block>

          <Block title="Ligações" onAdd={c.canEdit ? () => setRelOpen(true) : undefined}>
            {c.relations.length === 0 && <span className="text-muted-foreground">Sem ligações</span>}
            {c.relations.map((r) => (
              <Row key={r.id} menu={c.canEdit ? [{ label: "Tirar ligação", danger: true, run: () => removeRel.mutate({ op: "remove", relationId: r.id }) }] : undefined}>
                <span className="truncate">
                  {relText(r)} <Link href={`/clientes/${r.otherId}`} className="font-bold text-primary hover:underline">{r.otherName ?? `N.º ${r.otherId}`}</Link>
                  {r.label && <span className="text-muted-foreground"> ({r.label})</span>}
                </span>
                {r.otherPro && <Pill className="h-[18px] bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200">Pro</Pill>}
                {r.pays && <Pill className="h-[18px] bg-muted text-foreground">paga</Pill>}
              </Row>
            ))}
          </Block>

          <Block title="Origem e parceiro">
            <div>{c.originChannel ?? habits.channel ?? "—"}</div>
            {c.originPartnerName && <div className="text-muted-foreground">1.ª reserva via {c.originPartnerName}</div>}
            {c.isPro && c.proDiscount != null && <div className="text-muted-foreground">Desconto Pro: {c.proDiscount} %</div>}
          </Block>

          <Block title="Perfil">
            <div>Zona: <strong>{c.zone ?? "—"}</strong> · Língua: <strong>{c.language ?? "—"}</strong></div>
            <div className="text-muted-foreground">
              {c.countryName ? `País: ${c.countryName}` : "País: —"}
              {(c.gender || c.ageBand) ? ` · ${[c.gender === "F" ? "Feminino" : c.gender === "M" ? "Masculino" : c.gender ? "Outro" : null, c.ageBand].filter(Boolean).join(", ")}` : " · Sexo e faixa etária por preencher"}
            </div>
          </Block>

          <div className="flex flex-wrap items-center gap-2 border-t pt-2 sm:col-span-2 lg:col-span-3">
            <Lbl className="mr-1">Etiquetas</Lbl>
            {c.tags.length === 0 && <span className="text-xs text-muted-foreground">—</span>}
            {c.tags.map((t) => <Pill key={t} className="bg-muted text-foreground">{t}</Pill>)}
            <div className="flex-1" />
            <Lbl>Aceita</Lbl>
            <Consent label="Email" v={c.consentEmail} />
            <Consent label="WhatsApp" v={c.consentWhatsapp} />
            <Consent label="SMS" v={c.consentSms} />
          </div>
        </div>
      </div>

      {/* conta corrente Pro (fase 2) */}
      {pro.data && <ProAccountSection a={pro.data} onLinkPerson={c.canEdit ? () => setPersonOpen(true) : undefined} />}

      {/* indicadores */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 xl:grid-cols-8">
        {kpis.map((k) => (
          <button key={k.label} type="button" onClick={k.onClick} disabled={!k.onClick}
            className="flex flex-col gap-0.5 rounded-[10px] border bg-card p-3 text-left enabled:hover:border-primary">
            <Lbl>{k.label}</Lbl>
            <span className="font-display text-xl font-bold">{k.value}</span>
            <span className="truncate text-[11px] text-muted-foreground">{k.note || " "}</span>
          </button>
        ))}
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
        {/* separadores */}
        <div ref={tabsRef} className="scroll-mt-4 rounded-[10px] border bg-card px-[18px] pb-[18px]">
          <div className="flex gap-1 overflow-x-auto border-b">
            {([["timeline", "Linha do tempo"], ["bookings", `Reservas (${c.bookings.length})`], ["comms", "Emails e WhatsApp"], ["notes", "Notas"], ["log", "Registo"]] as const).map(([t, label]) => (
              <button key={t} type="button" onClick={() => setTab(t)}
                className={cn("-mb-px whitespace-nowrap border-b-[3px] px-3 py-3 text-[13px]", tab === t ? "border-primary font-bold text-primary" : "border-transparent font-semibold hover:text-primary")}>
                {label}
              </button>
            ))}
          </div>
          {tab === "timeline" && <Timeline c={c} history={history.data} />}
          {tab === "bookings" && <BookingsTable bookings={c.bookings} canSeeTotals={c.canSeeTotals} />}
          {tab === "comms" && (
            <div className="pt-3">
              {c.primaryEmail ? <CommunicationsTimeline type="client" id={c.primaryEmail} compact /> : <p className="py-6 text-sm text-muted-foreground">Sem email: não há mensagens ligadas.</p>}
            </div>
          )}
          {tab === "notes" && <NotesEditor c={c} onSaved={reload} />}
          {tab === "log" && <LogList log={c.log} />}
        </div>

        {/* coluna direita */}
        <div className="flex flex-col gap-4">
          <Card title={`Carros (${c.vehicles.length})`} action={c.canEdit ? <Button size="sm" variant="outline" className="h-[30px]" onClick={() => setVehicle(null)}><Plus className="h-3.5 w-3.5" />Carro</Button> : null}>
            {c.vehicles.length === 0 && <p className="text-xs text-muted-foreground">Sem carros registados.</p>}
            {c.vehicles.map((v) => (
              <div key={v.id} className="flex items-center gap-3 rounded-[10px] border p-2.5">
                <div className="relative flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
                  {v.photoUrl ? <img src={v.photoUrl} alt="" className="h-full w-full object-cover" loading="lazy" /> : <CarGlyph color={v.color} className="w-[72px]" />}
                  {c.canEdit && (
                    <button type="button" aria-label="Foto do carro" onClick={() => pickPhoto(v.id)}
                      className="absolute bottom-1 right-1 flex h-6 w-6 items-center justify-center rounded-full border bg-card/90 hover:bg-card">
                      <Camera className="h-3 w-3" />
                    </button>
                  )}
                </div>
                <div className="min-w-0 flex-1 text-[13px]">
                  <div className="font-mono text-[13px] font-bold tracking-[0.04em]">{v.plate}</div>
                  <div className="truncate">{[v.brand, v.model].filter(Boolean).join(" ") || "—"}{v.color ? ` · ${v.color}` : ""}</div>
                  <div className="text-xs text-muted-foreground">{num(v.bookings)} {v.bookings === 1 ? "reserva" : "reservas"}{v.lastKm ? ` · último km ${num(v.lastKm)}` : ""}</div>
                </div>
                {c.canEdit && (
                  <RowMenu items={[
                    { label: "Editar", run: () => setVehicle({ id: v.id, plate: v.plate, brand: v.brand, model: v.model, color: v.color, vehicleType: v.vehicleType }) },
                    { label: "Retirar", danger: true, run: () => contact.mutate({ op: "removeVehicle", clientId: c.id, itemId: v.id }) },
                  ]} />
                )}
              </div>
            ))}
          </Card>

          {c.nextBooking && (
            <Card title="Próxima reserva">
              <div className="text-[13px]"><strong>{shortDate(c.nextBooking.checkIn)} → {shortDate(c.nextBooking.checkOut)}</strong> · {c.nextBooking.park ?? "—"}</div>
              <div className="text-xs text-muted-foreground">
                {[c.nextBooking.flight ? `Voo ${c.nextBooking.flight}` : null, c.canSeeTotals && c.nextBooking.totalPrice != null ? eur(c.nextBooking.totalPrice) : null,
                  c.canSeeTotals && (c.nextBooking.remainingToPay ?? 0) > 0 ? `${eur(c.nextBooking.remainingToPay)} por pagar` : null].filter(Boolean).join(" · ") || relDays(c.nextBooking.checkIn)}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="h-[30px]" asChild>
                  <a href={c.bookings.find((b) => b.externalId === c.nextBooking!.externalId)?.multiparkUrl} target="_blank" rel="noreferrer">Ver reserva<ExternalLink className="h-3 w-3" /></a>
                </Button>
              </div>
            </Card>
          )}

          <Card title={`Parques usados (${m.parks.length})`}>
            {m.parks.length === 0 && <p className="text-xs text-muted-foreground">Ainda sem reservas.</p>}
            {m.parks.map((p) => {
              const max = m.parks[0]?.bookings || 1;
              return (
                <div key={p.park} className="text-[13px]">
                  <div className="flex justify-between gap-2"><span className="truncate"><strong>{p.park}</strong>{p.city && <span className="text-muted-foreground"> · {p.city}</span>}</span><span className="tabular-nums">{num(p.bookings)}</span></div>
                  <div className="mt-1 h-1.5 rounded-full bg-muted"><div className="h-1.5 rounded-full bg-primary" style={{ width: `${Math.max(4, (p.bookings / max) * 100)}%` }} /></div>
                </div>
              );
            })}
          </Card>

          <Card title="Hábitos">
            <Habit label="Parque preferido" value={m.preferredPark} />
            <Habit label="Estadia média" value={habits.avgDays != null ? `${habits.avgDays} ${habits.avgDays === 1 ? "dia" : "dias"}` : null} />
            <Habit label="Paga normalmente" value={habits.payment} />
            <Habit label="Canal habitual" value={habits.channel} />
            <Habit label="Volta a cada" value={habits.every} />
            {habits.partner && <Habit label="Parceiro habitual" value={habits.partner} />}
          </Card>

          {c.merges.length > 0 && (
            <Card title="Fichas juntas">
              {c.merges.map((e) => (
                <div key={e.id} className="flex items-center gap-2 text-[13px]">
                  <span className="min-w-0 flex-1">
                    <strong>{e.mergedName ?? `N.º ${e.mergedId}`}</strong> juntou-se a esta ficha
                    <span className="block text-xs text-muted-foreground">{shortDate(e.mergedAt)}{e.byName ? ` · por ${e.byName}` : ""}{e.reason ? ` · ${e.reason}` : ""}</span>
                  </span>
                  {c.canMerge && <Button size="sm" variant="outline" className="h-[30px]" disabled={split.isPending} onClick={() => split.mutate({ eventId: e.id })}><Undo2 className="h-3.5 w-3.5" />Separar</Button>}
                </div>
              ))}
            </Card>
          )}
        </div>
      </div>

      <EditClientDialog c={c} open={editOpen} onOpenChange={setEditOpen} onSaved={reload} />
      <VehicleDialog clientId={c.id} vehicle={vehicle ?? null} open={vehicle !== undefined} onOpenChange={(o) => { if (!o) setVehicle(undefined); }} onSaved={reload} />
      <RelationDialog clientId={c.id} open={relOpen} onOpenChange={setRelOpen} onSaved={reload} />
      <RelationDialog asCompany clientId={c.id} open={personOpen} onOpenChange={setPersonOpen} onSaved={() => { reload(); pro.refetch(); }} />
      <MergeDialog clientId={c.id} clientName={c.displayName} preset={merge ?? null} open={merge !== undefined}
        onOpenChange={(o) => { if (!o) setMerge(undefined); }}
        onMerged={(sid) => { utils.crm.invalidate(); if (sid !== c.id) navigate(`/clientes/${sid}`); else reload(); }} />
      {c.canSeeTotals && <IbanDialog clientId={c.id} hasIban={c.hasIban} open={ibanOpen} onOpenChange={setIbanOpen} onSaved={reload} />}
    </div>
  );
}

/** Imagem → JPEG com o lado maior ≤ `max` px, em base64 (sem o prefixo data:). */
async function shrinkImage(file: File, max: number): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = url; });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * k);
    canvas.height = Math.round(img.naturalHeight * k);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85).split(",")[1] ?? "";
  } finally {
    URL.revokeObjectURL(url);
  }
}

function isCancelled(b: Booking) { return String(b.status ?? "").toUpperCase().includes("CANCEL"); }

function habitsOf(bookings: Booking[]) {
  const done = bookings.filter((b) => !isCancelled(b));
  const mode = (xs: (string | null)[]) => {
    const n = new Map<string, number>();
    for (const x of xs) if (x) n.set(x, (n.get(x) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };
  const stays = done.map((b) => {
    const a = utcDate(b.checkIn), z = utcDate(b.checkOut);
    return a && z ? Math.max(1, Math.round((z.getTime() - a.getTime()) / 86_400_000)) : null;
  }).filter((x): x is number => x != null);
  const ins = done.map((b) => utcDate(b.checkIn)?.getTime()).filter((x): x is number => x != null).sort((a, b) => a - b);
  let every: string | null = null;
  if (ins.length >= 3) {
    const gap = (ins[ins.length - 1] - ins[0]) / (ins.length - 1) / 86_400_000;
    every = gap < 45 ? `${Math.round(gap)} dias` : gap < 365 ? `${Math.round(gap / 30.44)} meses` : `${(gap / 365.25).toFixed(1)} anos`;
  }
  return {
    avgDays: stays.length ? Math.round(stays.reduce((s, x) => s + x, 0) / stays.length) : null,
    payment: mode(done.map((b) => b.paymentMethod)),
    channel: mode(done.map((b) => b.origin)),
    partner: mode(done.map((b) => b.partnerName)),
    every,
  };
}

// ─── peças ──────────────────────────────────────────────────────────────────

function Banner({ tone, children }: { tone: "amber" | "red"; children: React.ReactNode }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2.5 rounded-[10px] border px-3.5 py-2.5 text-[13px]",
      tone === "amber" ? "border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40" : "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/40")}>
      {tone === "amber" && <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700" />}
      {children}
    </div>
  );
}

/** Bloco da ficha; "+" abre um campo para acrescentar (email, telefone) ou chama `onAdd`. */
function Block({ title, onAdd, addInline, children }: {
  title: string; onAdd?: () => void; children: React.ReactNode;
  addInline?: { placeholder: string; type: string; submit: (v: string) => Promise<unknown> };
}) {
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!addInline || !value.trim()) return;
    setBusy(true);
    try { await addInline.submit(value.trim()); setValue(""); setAdding(false); } catch { /* erro já mostrado */ } finally { setBusy(false); }
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Lbl>{title}</Lbl>
        {(onAdd || addInline) && (
          <button type="button" aria-label={`Acrescentar ${title.toLowerCase()}`} onClick={onAdd ?? (() => setAdding((x) => !x))} className="text-muted-foreground hover:text-primary">
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {children}
      {adding && addInline && (
        <div className="flex gap-1.5">
          <Input autoFocus type={addInline.type} value={value} placeholder={addInline.placeholder} className="h-8 text-[13px]"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setAdding(false); }} />
          <Button size="sm" className="h-8" disabled={busy || !value.trim()} onClick={submit}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Guardar"}</Button>
        </div>
      )}
    </div>
  );
}

type MenuItem = { label: string; run: () => void; danger?: boolean };

function RowMenu({ items }: { items: MenuItem[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Ações" className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"><MoreHorizontal className="h-4 w-4" /></button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map((i) => (
          <DropdownMenuItem key={i.label} onClick={i.run} className={cn(i.danger && "text-destructive")}>
            {i.danger && <Trash2 className="h-3.5 w-3.5" />}{i.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Row({ menu, children }: { menu?: MenuItem[]; children: React.ReactNode }) {
  return (
    <div className="group flex min-w-0 items-center gap-1.5">
      {children}
      {menu && menu.length > 0 && <span className="transition-opacity focus-within:opacity-100 group-hover:opacity-100 md:opacity-0"><RowMenu items={menu} /></span>}
    </div>
  );
}

function Consent({ label, v }: { label: string; v: boolean | null }) {
  if (v == null) return <Pill className="bg-muted text-muted-foreground">{label} ?</Pill>;
  return v
    ? <Pill className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">{label}</Pill>
    : <Pill className="bg-muted text-muted-foreground">{label} não</Pill>;
}

function Card({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-[10px] border bg-card p-4">
      <div className="flex items-center"><span className="flex-1 font-display text-[15px] font-bold">{title}</span>{action}</div>
      {children}
    </div>
  );
}

function Habit({ label, value }: { label: string; value: string | null | undefined }) {
  return <div className="flex justify-between gap-3 text-[13px]"><span className="text-muted-foreground">{label}</span><strong className="truncate text-right">{value || "—"}</strong></div>;
}

// ─── linha do tempo ─────────────────────────────────────────────────────────

type Ev = { at: string; icon: string; tone: string; title: string; detail?: string | null; meta?: string | null; href?: string | null; external?: boolean };
const TONE: Record<string, string> = {
  blue: "bg-secondary text-primary",
  amber: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
  green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  red: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  violet: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200",
  gray: "bg-muted text-foreground",
};

const LOG_LABEL: Record<string, string> = {
  crm_client_create: "Ficha criada", crm_client_update: "Ficha editada",
  crm_email_add: "Email acrescentado", crm_email_remove: "Email retirado", crm_email_primary: "Email principal alterado",
  crm_phone_add: "Telefone acrescentado", crm_phone_remove: "Telefone retirado", crm_phone_primary: "Telefone principal alterado",
  crm_vehicle_add: "Carro acrescentado", crm_vehicle_update: "Carro editado", crm_vehicle_remove: "Carro retirado",
  crm_client_photo: "Foto do cliente alterada", crm_vehicle_photo: "Foto do carro alterada", crm_iban: "IBAN alterado",
  crm_relation_add: "Ligação acrescentada", crm_relation_remove: "Ligação retirada", crm_suggestion_dismiss: "Sugestão para juntar descartada",
  crm_merge: "Fichas juntas", crm_merged_into: "Esta ficha juntou-se a outra", crm_split: "Fichas separadas",
};

const FIELD_LABEL: Record<string, string> = {
  displayName: "nome", firstName: "nome próprio", lastName: "apelido", kind: "tipo", nif: "NIF", taxName: "nome na fatura",
  taxAddress: "morada na fatura", address: "morada", zone: "zona", gender: "sexo", ageBand: "faixa etária", birthDate: "data de nascimento",
  language: "língua", isPro: "Pro", proDiscount: "desconto Pro", consentEmail: "aceita email", consentWhatsapp: "aceita WhatsApp",
  consentSms: "aceita SMS", notes: "notas", originChannel: "canal de origem", tags: "etiquetas",
};
const REL_LABEL: Record<string, string> = { employee: "trabalha em", manager: "gestor", family: "familiar", other: "outra" };

function logDetail(action: string, raw: unknown): string | null {
  let d: any = raw;
  if (typeof raw === "string") { try { d = JSON.parse(raw); } catch { return raw.slice(0, 160); } }
  if (!d || typeof d !== "object") return null;
  if (d.email) return String(d.email) + (d.reason ? ` (${d.reason})` : "");
  if (d.phone) return fmtPhone(String(d.phone));
  if (d.plate) return String(d.plate);
  if (action === "crm_client_update") return Object.keys(d).map((k) => FIELD_LABEL[k] ?? k).join(", ");
  if (action === "crm_relation_add" || action === "crm_relation_remove") return REL_LABEL[String(d.kind)] ?? null;
  if (action === "crm_iban") return d.set ? "guardado" : "apagado";
  if (d.mergedId) return `ficha N.º ${d.mergedId}${d.reason ? ` · ${d.reason}` : ""}`;
  if (d.survivorId) return `ficha N.º ${d.survivorId}`;
  return null;
}

function Timeline({ c, history }: { c: FileData; history: any }) {
  const events = useMemo(() => {
    const ev: Ev[] = [];
    for (const b of c.bookings) {
      const route = `${shortDate(b.checkIn)} → ${shortDate(b.checkOut)} · ${b.park ?? "—"}${c.canSeeTotals && b.totalPrice != null ? ` · ${eur(b.totalPrice)}` : ""}`;
      if (b.createdAt) ev.push({ at: b.createdAt, icon: "R", tone: "blue", title: `Reserva ${b.bookingNumber ? `N.º ${b.bookingNumber}` : "criada"}`, detail: route, meta: [b.partnerName ? `via ${b.partnerName}` : b.origin, b.role === "payer" ? "pagou" : null].filter(Boolean).join(" · "), href: b.multiparkUrl, external: true });
      const st = String(b.status ?? "").toUpperCase();
      if (st.includes("CANCEL")) ev.push({ at: b.cancelledAt ?? b.checkIn ?? b.createdAt ?? "", icon: "×", tone: "red", title: "Reserva cancelada", detail: route });
      else if (st === "CHECKED_OUT" && b.checkOut) ev.push({ at: b.checkOut, icon: "OUT", tone: "blue", title: "Carro entregue", detail: `${b.park ?? ""}${b.plate ? ` · ${b.plate}` : ""}`, meta: b.checkoutAgent ? `condutor ${b.checkoutAgent}` : null });
    }
    for (const x of history?.complaints ?? []) ev.push({ at: String(x.createdAt ?? ""), icon: "!", tone: "amber", title: "Reclamação", detail: x.title, meta: x.status, href: `/reclamacoes?id=${x.id}` });
    for (const x of history?.reviews ?? []) ev.push({ at: String(x.createdAt ?? ""), icon: "★", tone: "violet", title: `Crítica no Google (${x.rating ?? "?"}★)`, detail: x.reviewText ? String(x.reviewText).slice(0, 140) : null, href: "/criticas" });
    for (const x of history?.lostFound ?? []) ev.push({ at: String(x.createdAt ?? ""), icon: "?", tone: "gray", title: "Perdidos e achados", detail: x.description ?? x.itemType, meta: x.status, href: `/perdidos-achados/caso/${x.id}` });
    for (const l of c.log) ev.push({ at: l.at, icon: l.action.includes("merge") || l.action.includes("split") ? "JN" : "ED", tone: l.action.includes("merge") || l.action.includes("split") ? "amber" : "gray", title: LOG_LABEL[l.action] ?? l.action, detail: logDetail(l.action, l.details), meta: l.byName ? `por ${l.byName}` : null });
    return ev.filter((e) => e.at).sort((a, b) => (utcDate(b.at)?.getTime() ?? 0) - (utcDate(a.at)?.getTime() ?? 0));
  }, [c, history]);
  const [limit, setLimit] = useState(40);
  if (!events.length) return <p className="py-6 text-sm text-muted-foreground">Sem acontecimentos.</p>;
  return (
    <div className="flex flex-col pt-2">
      {events.slice(0, limit).map((e, i) => (
        <div key={i} className="flex gap-3 border-t border-border/60 py-2.5 first:border-t-0">
          <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-display text-[11px] font-bold", TONE[e.tone])}>{e.icon}</div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px]">
              {e.href ? (
                e.external ? <a href={e.href} target="_blank" rel="noreferrer" className="font-bold hover:underline">{e.title}</a> : <Link href={e.href} className="font-bold hover:underline">{e.title}</Link>
              ) : <strong>{e.title}</strong>}
              {e.detail && <span className="text-muted-foreground"> {e.detail}</span>}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">{shortDateTime(e.at)}{e.meta ? ` · ${e.meta}` : ""}</div>
          </div>
        </div>
      ))}
      {events.length > limit && <Button variant="ghost" size="sm" className="mt-2 self-center" onClick={() => setLimit(limit + 40)}>Mostrar mais</Button>}
    </div>
  );
}

function BookingsTable({ bookings, canSeeTotals }: { bookings: Booking[]; canSeeTotals: boolean }) {
  if (!bookings.length) return <p className="py-6 text-sm text-muted-foreground">Sem reservas.</p>;
  return (
    <div className="-mx-[18px] overflow-x-auto">
      <table className="w-full min-w-[760px] text-[13px]">
        <thead>
          <tr className="bg-muted text-left text-[11px] font-bold uppercase text-muted-foreground">
            <th className="px-3 py-2">Reserva</th><th className="px-3 py-2">Entrada → saída</th><th className="px-3 py-2">Parque</th>
            <th className="px-3 py-2">Estado</th>{canSeeTotals && <th className="px-3 py-2 text-right">Preço</th>}<th className="px-3 py-2">Origem</th><th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {bookings.map((b) => (
            <tr key={b.externalId + b.role} className="border-t align-top">
              <td className="px-3 py-2">
                <div className="font-semibold">{b.bookingNumber ? `N.º ${b.bookingNumber}` : b.externalId.slice(0, 10)}</div>
                <div className="text-xs text-muted-foreground">{[b.plate, b.flight ? `voo ${b.flight}` : null, b.role === "payer" ? "pagou" : null].filter(Boolean).join(" · ")}</div>
              </td>
              <td className="px-3 py-2 whitespace-nowrap">{shortDate(b.checkIn)} → {shortDate(b.checkOut)}</td>
              <td className="px-3 py-2"><div>{b.park ?? "—"}</div>{b.city && <div className="text-xs text-muted-foreground">{b.city}</div>}</td>
              <td className="px-3 py-2"><BookingStatusPill status={b.status} />{b.pro && <Pill className="ml-1 bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200">Pro</Pill>}</td>
              {canSeeTotals && (
                <td className="px-3 py-2 text-right">
                  <div className="font-semibold">{eur(b.totalPrice, 2)}</div>
                  {(b.remainingToPay ?? 0) > 0 ? <div className={cn("text-xs font-bold", ALERT_CLASS)}>{eur(b.remainingToPay, 2)} por pagar</div> : <div className="text-xs text-muted-foreground">{b.paymentMethod ?? ""}</div>}
                </td>
              )}
              <td className="px-3 py-2 text-xs">{b.partnerName ?? b.origin ?? "—"}</td>
              <td className="px-3 py-2 text-right">
                <a href={b.multiparkUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-semibold text-primary hover:underline">Abrir na Multipark<ExternalLink className="h-3 w-3" /></a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NotesEditor({ c, onSaved }: { c: FileData; onSaved: () => void }) {
  const [notes, setNotes] = useState(c.notes ?? "");
  useEffect(() => setNotes(c.notes ?? ""), [c.notes]);
  const save = trpc.crm.update.useMutation({ onSuccess: () => { toast.success("Notas guardadas"); onSaved(); }, onError: (e) => toast.error(e.message) });
  const dirty = notes !== (c.notes ?? "");
  return (
    <div className="flex flex-col gap-2 pt-3">
      <Textarea rows={8} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!c.canEdit}
        placeholder="Notas internas sobre o cliente (preferências, avisos para a equipa…)" />
      {c.canEdit && (
        <div className="flex justify-end">
          <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate({ id: c.id, patch: { notes: notes.trim() || null } })}>Guardar notas</Button>
        </div>
      )}
    </div>
  );
}

function LogList({ log }: { log: FileData["log"] }) {
  if (!log.length) return <p className="py-6 text-sm text-muted-foreground">Ainda não há ações registadas nesta ficha.</p>;
  return (
    <div className="flex flex-col pt-2">
      {log.map((l, i) => (
        <div key={i} className="flex gap-3 border-t border-border/60 py-2 text-[13px] first:border-t-0">
          <span className="w-32 shrink-0 text-xs text-muted-foreground">{shortDateTime(l.at)}</span>
          <span className="min-w-0 flex-1"><strong>{LOG_LABEL[l.action] ?? l.action}</strong>{logDetail(l.action, l.details) && <span className="text-muted-foreground"> · {logDetail(l.action, l.details)}</span>}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{l.byName ?? "sistema"}</span>
        </div>
      ))}
    </div>
  );
}

