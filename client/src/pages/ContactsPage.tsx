/**
 * Contactos — pedido do dono (set 2026).
 *
 *  - Pesquisa: uma caixa para clientes, contactos do CRM, leads de extras,
 *    parceiros, fornecedores, colaboradores, diretório da empresa e os teus
 *    contactos Google. Cada tipo só aparece a quem vê o módulo de origem (e só
 *    na sua cidade). "Todos" mostra poucos resultados por tipo; escolher um
 *    tipo percorre-o às páginas (nada é carregado de uma vez).
 *  - Diretório: perfis do Workspace (foto, cargo, telefone), atualizado 1×/dia.
 *  - Os meus contactos Google: sugestões de ligação (email/telefone →
 *    cliente, lead, parceiro, colaborador) e "Criar cliente/lead" num clique.
 * Clicar num contacto abre a ficha: reservas, reclamações, WhatsApp, emails.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearch } from "wouter";
import { trpc } from "@/lib/trpc";
import { fmtPTDate, fmtPTDateTime } from "@/lib/lisbonTime";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import {
  BookUser, Building2, CalendarDays, ChevronDown, ExternalLink, Loader2, Mail, MessageCircle, MessageSquareWarning, Phone, Plus, RefreshCw, Search, Users,
} from "lucide-react";
import { CONTACT_KIND_LABELS, CREATE_FROM_GOOGLE_LABELS, type ContactKind } from "@shared/contacts";
import { CommunicationsTimeline } from "@/components/mail/CommunicationsTimeline";
import { GoogleContactsCard } from "@/components/google/GoogleContactsCard";

type Tab = "pesquisa" | "diretorio" | "google";
const TABS: Tab[] = ["pesquisa", "diretorio", "google"];

const KIND_CLASS: Record<ContactKind, string> = {
  client: "bg-sky-100 text-sky-800 border-sky-200",
  crm: "bg-cyan-100 text-cyan-800 border-cyan-200",
  lead: "bg-amber-100 text-amber-900 border-amber-200",
  partner: "bg-violet-100 text-violet-800 border-violet-200",
  supplier: "bg-stone-100 text-stone-800 border-stone-200",
  employee: "bg-emerald-100 text-emerald-800 border-emerald-200",
  directory: "bg-indigo-100 text-indigo-800 border-indigo-200",
  google: "bg-rose-100 text-rose-800 border-rose-200",
};

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";

function PersonAvatar({ name, photoUrl, size = "h-9 w-9" }: { name: string; photoUrl?: string | null; size?: string }) {
  return (
    <Avatar className={`${size} shrink-0`}>
      {photoUrl ? <AvatarImage src={photoUrl} alt="" referrerPolicy="no-referrer" /> : null}
      <AvatarFallback className="text-xs font-semibold bg-primary/10 text-primary">{initials(name)}</AvatarFallback>
    </Avatar>
  );
}

type Item = { ref: string; kind: ContactKind; id: string; name: string; subtitle: string | null; email: string | null; phone: string | null; photoUrl: string | null };

function ContactRow({ it, onOpen }: { it: Item; onOpen: (it: Item) => void }) {
  return (
    <button type="button" onClick={() => onOpen(it)} className="w-full flex items-center gap-3 px-3 py-2.5 min-h-[52px] text-left hover:bg-muted/50 rounded-lg">
      <PersonAvatar name={it.name} photoUrl={it.photoUrl} />
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-sm truncate">{it.name}</span>
          <Badge variant="outline" className={`text-[10.5px] shrink-0 ${KIND_CLASS[it.kind]}`}>{CONTACT_KIND_LABELS[it.kind]}</Badge>
        </span>
        {it.subtitle && <span className="block text-xs text-muted-foreground truncate">{it.subtitle}</span>}
        <span className="flex flex-wrap gap-x-3 text-[11.5px] text-muted-foreground">
          {it.email && <span className="truncate max-w-[240px]"><Mail className="inline h-3 w-3 mr-0.5" />{it.email}</span>}
          {it.phone && <span><Phone className="inline h-3 w-3 mr-0.5" />{it.phone}</span>}
        </span>
      </span>
    </button>
  );
}

/** Carrega a página seguinte quando o fim da lista fica visível. */
function LoadMore({ hasMore, loading, onMore }: { hasMore: boolean; loading: boolean; onMore: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !hasMore || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((e) => { if (e[0]?.isIntersecting && !loading) onMore(); }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, onMore]);
  if (!hasMore) return null;
  return (
    <div ref={ref} className="flex justify-center py-2">
      <Button size="sm" variant="outline" onClick={onMore} disabled={loading}>{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Carregar mais"}</Button>
    </div>
  );
}

// ─── Pesquisa ───────────────────────────────────────────────────────────────

function SearchTab({ onOpen }: { onOpen: (it: Item) => void }) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<ContactKind | "all">("all");
  const q = useDebounced(text.trim());
  const kindsQ = trpc.contacts.kinds.useQuery(undefined, { staleTime: 5 * 60_000 });
  const kinds = (kindsQ.data ?? []) as ContactKind[];
  const all = kind === "all";
  const allQ = trpc.contacts.search.useQuery({ q, kind: "all" }, { enabled: all && q.length >= 2, placeholderData: (p) => p });
  const oneQ = trpc.contacts.search.useInfiniteQuery(
    { q, kind: all ? "client" : kind, limit: 30 },
    { enabled: !all, getNextPageParam: (last) => last.groups[0]?.nextCursor ?? undefined, initialCursor: 0 },
  );
  const oneItems = useMemo(() => (oneQ.data?.pages ?? []).flatMap((p) => p.groups[0]?.items ?? []) as Item[], [oneQ.data]);

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Nome, email, telefone ou matrícula…" className="pl-9 h-11" />
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant={all ? "default" : "outline"} className="h-8" onClick={() => setKind("all")}>Todos</Button>
        {kinds.map((k) => (
          <Button key={k} size="sm" variant={kind === k ? "default" : "outline"} className="h-8" onClick={() => setKind(k)}>{CONTACT_KIND_LABELS[k]}</Button>
        ))}
      </div>

      {all && q.length < 2 && (
        <p className="text-sm text-muted-foreground">Escreve pelo menos 2 letras para procurar em todos os tipos, ou escolhe um tipo para o percorrer.</p>
      )}
      {all && q.length >= 2 && (
        <div className="space-y-3">
          {allQ.isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          {allQ.data && allQ.data.groups.every((g) => !g.items.length) && <p className="text-sm text-muted-foreground">Nenhum contacto encontrado.</p>}
          {(allQ.data?.groups ?? []).filter((g) => g.items.length).map((g) => (
            <Card key={g.kind}>
              <CardContent className="p-2">
                <div className="flex items-center justify-between px-2 pt-1 pb-1">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{CONTACT_KIND_LABELS[g.kind as ContactKind]}</span>
                  {g.hasMore && <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setKind(g.kind as ContactKind)}>Ver todos</Button>}
                </div>
                {(g.items as Item[]).map((it) => <ContactRow key={it.ref} it={it} onOpen={onOpen} />)}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {!all && (
        <Card>
          <CardContent className="p-2">
            {oneQ.isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground m-2" />}
            {oneQ.error && <p className="text-sm text-red-700 p-2">{oneQ.error.message}</p>}
            {!oneQ.isLoading && !oneItems.length && !oneQ.error && <p className="text-sm text-muted-foreground p-2">Nenhum contacto encontrado.</p>}
            {oneItems.map((it) => <ContactRow key={it.ref} it={it} onOpen={onOpen} />)}
            <LoadMore hasMore={!!oneQ.hasNextPage} loading={oneQ.isFetchingNextPage} onMore={() => oneQ.fetchNextPage()} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Diretório ──────────────────────────────────────────────────────────────

function DirectoryTab({ onOpen }: { onOpen: (it: Item) => void }) {
  const utils = trpc.useUtils();
  const [text, setText] = useState("");
  const q = useDebounced(text.trim());
  const st = trpc.contacts.directory.status.useQuery(undefined, { staleTime: 60_000 });
  const listQ = trpc.contacts.search.useInfiniteQuery(
    { q, kind: "directory", limit: 30 },
    { getNextPageParam: (last) => last.groups[0]?.nextCursor ?? undefined, initialCursor: 0 },
  );
  const sync = trpc.contacts.directory.syncNow.useMutation({
    onSuccess: (r) => {
      utils.contacts.directory.status.invalidate(); utils.contacts.search.invalidate();
      if (!r.configured) toast.message("O diretório está desligado (Definições → Comunicação → Contactos Google).");
      else if (r.error) toast.error(r.error);
      else toast.success(r.done ? `Diretório atualizado (${r.count ?? 0} pessoas).` : "Diretório a meio — continua na próxima corrida.");
    },
    onError: (e) => toast.error(e.message),
  });
  const items = useMemo(() => (listQ.data?.pages ?? []).flatMap((p) => p.groups[0]?.items ?? []) as Item[], [listQ.data]);
  const s = st.data;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {s && !s.enabled && <span>O diretório da empresa ainda não está ligado (Definições → Comunicação → Contactos Google).</span>}
        {s?.enabled && <span>{s.count} pessoa(s) · {s.lastFullSyncAt ? `atualizado ${fmtPTDateTime(s.lastFullSyncAt)}` : "ainda por ler"}{s.inProgress ? " · leitura em curso" : ""}</span>}
        {s?.lastError && <span className="text-red-700 dark:text-red-300 w-full">{s.lastError}</span>}
        {s?.canSync && s.enabled && (
          <Button size="sm" variant="outline" className="ml-auto h-8" disabled={sync.isPending} onClick={() => sync.mutate()}>
            {sync.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}Atualizar agora
          </Button>
        )}
      </div>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Procurar no diretório (nome, cargo, departamento, email, telefone)…" className="pl-9 h-11" />
      </div>
      {listQ.isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      {!listQ.isLoading && !items.length && <p className="text-sm text-muted-foreground">Sem pessoas no diretório{q ? " para esta pesquisa" : ""}.</p>}
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((it) => (
          <button key={it.ref} type="button" onClick={() => onOpen(it)} className="flex items-center gap-3 rounded-xl border bg-card p-3 text-left hover:bg-muted/50 min-w-0">
            <PersonAvatar name={it.name} photoUrl={it.photoUrl} size="h-11 w-11" />
            <span className="min-w-0">
              <span className="block font-medium text-sm truncate">{it.name}</span>
              {it.subtitle && <span className="block text-xs text-muted-foreground truncate"><Building2 className="inline h-3 w-3 mr-0.5" />{it.subtitle}</span>}
              {it.phone && <span className="block text-[11.5px] text-muted-foreground"><Phone className="inline h-3 w-3 mr-0.5" />{it.phone}</span>}
              {it.email && <span className="block text-[11.5px] text-muted-foreground truncate"><Mail className="inline h-3 w-3 mr-0.5" />{it.email}</span>}
            </span>
          </button>
        ))}
      </div>
      <LoadMore hasMore={!!listQ.hasNextPage} loading={listQ.isFetchingNextPage} onMore={() => listQ.fetchNextPage()} />
    </div>
  );
}

// ─── Os meus contactos Google ───────────────────────────────────────────────

function GoogleTab({ onOpen }: { onOpen: (it: Item) => void }) {
  const utils = trpc.useUtils();
  const [text, setText] = useState("");
  const [onlyUnmatched, setOnlyUnmatched] = useState(false);
  const q = useDebounced(text.trim());
  const status = trpc.googleAccount.contacts.status.useQuery(undefined, { staleTime: 30_000 });
  const ready = !!status.data?.granted && !!status.data?.prefs.suggestions;
  const listQ = trpc.contacts.google.suggestions.useInfiniteQuery(
    { q, onlyUnmatched },
    { enabled: ready, getNextPageParam: (last) => last.nextCursor ?? undefined, initialCursor: 0 },
  );
  const create = trpc.contacts.google.create.useMutation({
    onSuccess: () => { toast.success("Criado."); utils.contacts.google.suggestions.invalidate(); utils.contacts.search.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const items = useMemo(() => (listQ.data?.pages ?? []).flatMap((p) => p.items), [listQ.data]);
  const canCreate = listQ.data?.pages[0]?.canCreate ?? [];
  if (status.isLoading) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  if (!ready) return <GoogleContactsCard returnTo="/contactos?tab=google" />;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Procurar nos meus contactos Google…" className="pl-9 h-11" />
        </div>
        <label className="flex items-center gap-2 text-sm min-h-[44px]">
          <Switch checked={onlyUnmatched} onCheckedChange={setOnlyUnmatched} />Só sem correspondência
        </label>
      </div>
      <p className="text-xs text-muted-foreground">Só tu vês os teus contactos. As correspondências são pelo email ou pelo telefone (normalizado, +351 por omissão).</p>
      {listQ.isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      {!listQ.isLoading && !items.length && <p className="text-sm text-muted-foreground">Sem contactos{q ? " para esta pesquisa" : " (a primeira leitura corre nos próximos minutos)"}.</p>}
      <div className="space-y-1.5">
        {items.map((c) => (
          <div key={c.id} className="rounded-lg border bg-card px-3 py-2 flex flex-wrap items-center gap-2">
            <PersonAvatar name={c.name || c.emails[0] || "?"} />
            <div className="flex-1 min-w-[180px]">
              <div className="text-sm font-medium truncate">{c.name || c.emails[0] || c.phones[0] || "(sem nome)"}</div>
              <div className="text-[11.5px] text-muted-foreground truncate">{[...c.emails.slice(0, 2), ...c.phones.slice(0, 2)].join(" · ")}</div>
              {c.matches.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {c.matches.map((m) => (
                    <button key={`${m.kind}:${m.id}`} type="button" onClick={() => onOpen({ ref: `${m.kind}:${m.id}`, kind: m.kind, id: m.id, name: m.label, subtitle: null, email: null, phone: null, photoUrl: null })}>
                      <Badge variant="outline" className={`text-[10.5px] ${KIND_CLASS[m.kind]}`}>{CONTACT_KIND_LABELS[m.kind]}: {m.label} · {m.via === "email" ? "email" : "telefone"}</Badge>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {canCreate.length > 0 && c.matches.length === 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" disabled={create.isPending}><Plus className="h-4 w-4 mr-1" />Criar<ChevronDown className="h-3 w-3 ml-1" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {canCreate.map((a) => (
                    <DropdownMenuItem key={a} onClick={() => create.mutate({ id: c.id, as: a })}>{CREATE_FROM_GOOGLE_LABELS[a]}</DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        ))}
      </div>
      <LoadMore hasMore={!!listQ.hasNextPage} loading={listQ.isFetchingNextPage} onMore={() => listQ.fetchNextPage()} />
    </div>
  );
}

// ─── Ficha ──────────────────────────────────────────────────────────────────

function ContactSheet({ item, onClose }: { item: Item | null; onClose: () => void }) {
  const q = trpc.contacts.detail.useQuery({ kind: item?.kind ?? "client", id: item?.id ?? "" }, { enabled: !!item, retry: false });
  const d = q.data;
  return (
    <Sheet open={!!item} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-3">
            {item && <PersonAvatar name={d?.name ?? item.name} photoUrl={d?.photoUrl ?? item.photoUrl} size="h-12 w-12" />}
            <span className="min-w-0">
              <span className="block truncate">{d?.name ?? item?.name}</span>
              {item && <Badge variant="outline" className={`text-[10.5px] ${KIND_CLASS[item.kind]}`}>{CONTACT_KIND_LABELS[item.kind]}</Badge>}
            </span>
          </SheetTitle>
        </SheetHeader>
        <div className="px-4 pb-6 space-y-4 text-sm">
          {q.isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          {q.error && <p className="text-red-700 dark:text-red-300">{q.error.message}</p>}
          {d && (
            <>
              {d.subtitle && <p className="text-muted-foreground">{d.subtitle}</p>}
              <div className="space-y-1">
                {d.emails.map((e) => <a key={e} href={`mailto:${e}`} className="flex items-center gap-2 text-primary break-all"><Mail className="h-4 w-4 shrink-0" />{e}</a>)}
                {d.phones.map((p) => <a key={p} href={`tel:${p}`} className="flex items-center gap-2 text-primary"><Phone className="h-4 w-4 shrink-0" />{p}</a>)}
                {d.openHref && <Link href={d.openHref} className="inline-flex items-center gap-1 text-xs text-primary underline">Abrir no módulo <ExternalLink className="h-3 w-3" /></Link>}
                {d.clientEmail && d.kind !== "client" && <Link href={`/clientes?email=${encodeURIComponent(d.clientEmail)}`} className="block text-xs text-primary underline">Também é cliente — abrir ficha de cliente</Link>}
              </div>
              {d.bookings && (
                <Section icon={<CalendarDays className="h-4 w-4 text-primary" />} title={`Reservas (${d.bookings.length}${d.bookings.length === 10 ? "+" : ""})`}>
                  {d.bookings.length === 0 && <Empty />}
                  {d.bookings.map((b) => (
                    <div key={b.id} className="rounded-lg border px-3 py-1.5 text-xs flex flex-wrap gap-x-2">
                      <span className="font-medium">{b.bookingNumber ?? b.externalId}</span>
                      <span className="text-muted-foreground">{b.parkName ?? ""}</span>
                      <span className="text-muted-foreground">{b.checkIn ? fmtPTDate(b.checkIn) : "—"} → {b.checkOut ? fmtPTDate(b.checkOut) : "—"}</span>
                      {b.licensePlate && <span className="text-muted-foreground">{b.licensePlate}</span>}
                      {b.status && <Badge variant="outline" className="text-[10px]">{b.status}</Badge>}
                    </div>
                  ))}
                </Section>
              )}
              {d.complaints && (
                <Section icon={<MessageSquareWarning className="h-4 w-4 text-primary" />} title={`Reclamações (${d.complaints.length})`}>
                  {d.complaints.length === 0 && <Empty />}
                  {d.complaints.map((c) => (
                    <Link key={c.id} href={`/reclamacoes?id=${c.id}`} className="block rounded-lg border px-3 py-1.5 text-xs hover:bg-muted/50">
                      <span className="font-medium">#{c.id} {c.title}</span> <span className="text-muted-foreground">· {c.status}{c.createdAt ? ` · ${fmtPTDate(c.createdAt)}` : ""}</span>
                    </Link>
                  ))}
                </Section>
              )}
              {d.whatsapp && (
                <Section icon={<MessageCircle className="h-4 w-4 text-green-600" />} title={`WhatsApp (${d.whatsapp.length})`}>
                  {d.whatsapp.length === 0 && <Empty />}
                  {d.whatsapp.map((w) => (
                    <Link key={w.id} href="/whatsapp" className="block rounded-lg border px-3 py-1.5 text-xs hover:bg-muted/50">
                      <span className="font-medium">{w.name ?? w.phone}</span> <span className="text-muted-foreground">· {w.phone}{w.lastMessageAt ? ` · ${fmtPTDateTime(w.lastMessageAt)}` : ""}{w.unreadCount ? ` · ${w.unreadCount} por ler` : ""}{w.status ? ` · ${w.status}` : ""}</span>
                    </Link>
                  ))}
                </Section>
              )}
              {d.mail && (
                <Section icon={<Mail className="h-4 w-4 text-primary" />} title={`Emails (${d.mail.length})`}>
                  {d.mail.length === 0 && <Empty />}
                  {d.mail.map((m) => (
                    <Link key={m.id} href={m.link} className="block rounded-lg border px-3 py-1.5 text-xs hover:bg-muted/50">
                      <span className="font-medium">{m.subject || "(sem assunto)"}</span> <span className="text-muted-foreground">· {m.source}{m.lastMessageAt ? ` · ${fmtPTDateTime(m.lastMessageAt)}` : ""}</span>
                    </Link>
                  ))}
                </Section>
              )}
              {d.clientEmail && <CommunicationsTimeline type="client" id={d.clientEmail} title="Comunicações do cliente" />}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-sm font-semibold flex items-center gap-1.5">{icon}{title}</div>
      {children}
    </div>
  );
}
const Empty = () => <p className="text-xs text-muted-foreground">Nada ligado.</p>;

// ─── Página ─────────────────────────────────────────────────────────────────

export default function ContactsPage() {
  const search = useSearch();
  const initial = new URLSearchParams(search).get("tab") as Tab | null;
  const [tab, setTab] = useState<Tab>(initial && TABS.includes(initial) ? initial : "pesquisa");
  const [open, setOpen] = useState<Item | null>(null);
  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center gap-3">
        <span className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0"><BookUser className="h-5 w-5" /></span>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">Contactos</h1>
          <p className="text-sm text-muted-foreground">Clientes, leads, parceiros, fornecedores, colaboradores e os teus contactos Google — numa só pesquisa.</p>
        </div>
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="pesquisa"><Search className="h-4 w-4 mr-1" />Pesquisa</TabsTrigger>
          <TabsTrigger value="diretorio"><Users className="h-4 w-4 mr-1" />Diretório</TabsTrigger>
          <TabsTrigger value="google"><BookUser className="h-4 w-4 mr-1" />Meus Google</TabsTrigger>
        </TabsList>
        <TabsContent value="pesquisa" className="pt-3"><SearchTab onOpen={setOpen} /></TabsContent>
        <TabsContent value="diretorio" className="pt-3"><DirectoryTab onOpen={setOpen} /></TabsContent>
        <TabsContent value="google" className="pt-3"><GoogleTab onOpen={setOpen} /></TabsContent>
      </Tabs>
      <ContactSheet item={open} onClose={() => setOpen(null)} />
    </div>
  );
}
