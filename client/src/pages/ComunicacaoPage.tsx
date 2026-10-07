// Comunicação — as caixas de email (lote 45, Jorge 7 out 2026): "caixas de
// email e de WhatsApp já não existe, é só de email"; "cada um começava pela
// sua"; "as caixas como no Gmail, umas por baixo das outras, para no mesmo
// sítio se poder trocar de caixa e ver o que cada uma tem"; "isto ficar maior
// para trabalharmos daqui" (fica tudo registado na ficha do cliente).
// /comunicacao = caixas partilhadas; /comunicacao/meu-email = a caixa pessoal
// @multipark (só o próprio; o super admin pode consultar as dos outros) — as
// duas na MESMA lista de caixas, à esquerda.
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useIsMobile } from "@/hooks/useMobile";
import { toast } from "sonner";
import { AlarmClock, Archive, Bot, Inbox, Loader2, Mail, PenSquare, RefreshCw, Search, Star, UserRound } from "lucide-react";
import {
  MAIL_BRAND_LABELS, MAIL_THREAD_STATUSES, MAIL_THREAD_STATUS_LABELS, MAIL_TRIAGE_KEY, MAIL_TRIAGE_LABEL, isMailBrand, isMailOverdue, pickInitialMailbox, type MailThreadStatus,
} from "@shared/mail";
import { GoogleAccountCard, useGoogleOAuthReturnToast } from "@/components/GoogleAccountCard";
import { MailThreadView } from "@/components/mail/MailThreadView";
import { MailComposer } from "@/components/mail/MailComposer";
import { BrandChip, LinkChip, listTime, waitingLabel } from "@/components/mail/mailUi";
import { QueryErrorNote } from "@/components/QueryErrorNote";

const POLL_MS = 60_000;
const ME = "me";

export default function ComunicacaoPage({ personal = false }: { personal?: boolean }) {
  const isMobile = useIsMobile();
  const [location, navigate] = useLocation();
  const search = useSearch();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const utils = trpc.useUtils();
  useGoogleOAuthReturnToast(() => { utils.mail.overview.invalidate(); utils.googleAccount.status.invalidate(); });

  const overview = trpc.mail.overview.useQuery(undefined, { refetchInterval: POLL_MS });
  const boxes = overview.data?.mailboxes ?? [];
  const triage = overview.data?.triage ?? null;
  // A caixa vem da rota (O meu email) ou do ?caixa=; sem nada, a inicial da pessoa (pickInitialMailbox).
  const routeBox = personal ? ME : params.get("caixa");
  const autoBox = useMemo(
    () => overview.data ? pickInitialMailbox({ home: overview.data.homeBox ?? null, boxes, triage: !!triage }) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [overview.data],
  );
  const mailbox = routeBox ?? autoBox;
  const isMe = mailbox === ME;
  const [ownerUserId, setOwnerUserId] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(() => Number(params.get("t")) || null);
  const [brand, setBrand] = useState("all");
  // ?q= (pesquisa global → "ver todos"): pesquisa já escrita e todos os estados.
  const [status, setStatus] = useState<MailThreadStatus | "all">(personal || params.get("q") ? "all" : "aberto");
  const [assigned, setAssigned] = useState<"all" | "me" | "none">("all");
  const [awaiting, setAwaiting] = useState(false);
  const [unread, setUnread] = useState(false);
  // Notificações automáticas de reserva: escondidas por omissão (a pesquisa encontra-as sempre).
  const [showAutomatic, setShowAutomatic] = useState(false);
  // Arquivo da retenção (+5 anos, sem ligação): só o super admin, a pedido.
  const [archived, setArchived] = useState(false);
  const [q, setQ] = useState(() => (params.get("q") ?? "").slice(0, 120));
  const [page, setPage] = useState(1);
  const [composeNew, setComposeNew] = useState(false);
  const [composeTo, setComposeTo] = useState("");

  useEffect(() => { setPage(1); }, [mailbox, brand, status, assigned, awaiting, unread, showAutomatic, archived, q, ownerUserId]);
  useEffect(() => { const t = Number(params.get("t")) || null; if (t) setSelected(t); }, [params]);

  // Trocar de caixa: um clique na lista da esquerda (o "O meu email" tem a rota dele).
  const selectBox = (key: string) => {
    setSelected(null);
    if (key === ME) { setStatus("all"); navigate("/comunicacao/meu-email"); }
    else { if (isMe) setStatus("aberto"); navigate(`/comunicacao?caixa=${encodeURIComponent(key)}`); }
  };
  const setHome = trpc.mail.setHomeBox.useMutation({
    onSuccess: (r) => { toast.success(r.key ? "É por esta caixa que entras na Comunicação." : "Caixa inicial automática."); utils.mail.overview.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  // "Email" nas fichas (17f parte 3): ?novo=<email>[&caixa=] abre "Nova mensagem" já com o
  // destinatário, na caixa sugerida se a pessoa puder escrever nela (senão na atual ou na primeira).
  const novoHandled = useRef<string | null>(null);
  useEffect(() => {
    const to = params.get("novo");
    if (personal || !to || !overview.data || novoHandled.current === to) return;
    novoHandled.current = to;
    const want = params.get("caixa");
    const box = boxes.find((b) => b.key === want && b.canCompose) ?? boxes.find((b) => b.key === mailbox && b.canCompose) ?? boxes.find((b) => b.canCompose);
    const p = new URLSearchParams(search);
    p.delete("novo");
    if (!box) toast.error("Não tens nenhuma caixa de onde possas escrever um email.");
    else { p.set("caixa", box.key); setComposeTo(to.slice(0, 320)); setComposeNew(true); }
    navigate(`${location.split("?")[0]}${p.toString() ? `?${p}` : ""}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, personal, overview.data]);

  const google = overview.data?.google;
  const personalReady = !!google?.connected;
  const enabled = !!mailbox && (!isMe || personalReady || ownerUserId != null);
  const list = trpc.mail.threads.list.useQuery({
    mailbox: mailbox ?? ME, ownerUserId: isMe ? ownerUserId : null,
    brand: brand === "all" ? null : brand, status, assigned: isMe ? "all" : assigned, awaiting, unread,
    search: q.trim() || null, showAutomatic, archived: archived && !!overview.data?.isSuperAdmin, page, pageSize: 40,
  }, { enabled, refetchInterval: POLL_MS, placeholderData: (p) => p });

  const syncMine = trpc.mail.syncMine.useMutation({
    // "Sem emails novos" só quando a leitura correu bem (17d: antes dizia-o com a conta em erro).
    onSuccess: (r) => {
      const acc = r.accounts[0];
      if (!r.configured || !acc) toast.error("A tua conta Google não está ligada ao Gmail — liga-a no cartão acima.");
      else if (acc.status === "locked") toast.info("Já está a sincronizar — tenta daqui a pouco.");
      else if (acc.status === "reauth_required" || acc.status === "disconnected") toast.error("A ligação ao Google expirou — volta a ligar a conta (cartão acima).");
      else if (acc.status !== "ok") toast.error(`Não foi possível ler o teu Gmail: ${acc.error ?? acc.status}`);
      else toast.success(r.stored ? `${r.stored} email(s) novos.` : "Sem emails novos.");
      list.refetch(); overview.refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const current = boxes.find((b) => b.key === mailbox);
  const slaHours = overview.data?.slaHours ?? 24;
  const now = Date.now();
  const refresh = () => { list.refetch(); overview.refetch(); utils.mail.badge.invalidate(); };
  const open = (id: number) => {
    setSelected(id);
    const p = new URLSearchParams(search);
    p.set("t", String(id));
    if (!isMe && mailbox) p.set("caixa", mailbox);
    navigate(`${location.split("?")[0]}?${p.toString()}`, { replace: true });
  };
  const close = () => {
    setSelected(null);
    const p = new URLSearchParams(search);
    p.delete("t");
    navigate(`${location.split("?")[0]}${p.toString() ? `?${p}` : ""}`, { replace: true });
  };

  const canCompose = isMe ? (personalReady && ownerUserId == null) : !!current?.canCompose;
  const homeBox = overview.data?.homeBox ?? null;
  const boxTitle = isMe ? "O meu email" : mailbox === MAIL_TRIAGE_KEY ? MAIL_TRIAGE_LABEL : current?.label ?? "Email";

  if (overview.isLoading) return <div className="p-6"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  // Erro ≠ "sem acesso" nem "liga a tua conta" (17d).
  if (overview.error && !overview.data) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-bold flex items-center gap-2"><Mail className="h-5 w-5 text-primary" /> Email</h1>
        <QueryErrorNote error={overview.error} onRetry={() => overview.refetch()} retrying={overview.isFetching} what="as caixas de email" />
      </div>
    );
  }

  const threads = list.data?.threads ?? [];
  const total = list.data?.total ?? 0;

  // ── Coluna 1: as caixas, umas por baixo das outras (como no Gmail) ──
  const boxButton = (key: string, label: string, count: number, opts: { mine?: boolean; awaitingN?: number; icon?: React.ReactNode; canStar?: boolean } = {}) => {
    const active = mailbox === key;
    const isHome = homeBox === key;
    return (
      <div key={key} className={`group flex items-center rounded-r-full pr-1 ${active ? "bg-primary/10 text-primary font-semibold" : "hover:bg-accent"}`}>
        <button type="button" onClick={() => selectBox(key)} className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-3 text-left text-[13px]" aria-current={active ? "page" : undefined}
          title={opts.awaitingN ? `${opts.awaitingN} por responder` : undefined}>
          {opts.icon ?? <Inbox className="h-4 w-4 shrink-0 opacity-70" />}
          <span className={`flex-1 truncate ${count ? "font-semibold" : ""}`}>{label}</span>
          {opts.mine && <UserRound className="h-3 w-3 shrink-0 opacity-60" aria-label="Caixa tua" />}
          {count > 0 && <span className="shrink-0 text-[11px] font-bold tabular-nums">{count > 999 ? "999+" : count}</span>}
        </button>
        {opts.canStar && (
          <button type="button" onClick={() => setHome.mutate({ key: isHome ? null : key })} disabled={setHome.isPending}
            className={`shrink-0 rounded p-1 ${isHome ? "text-amber-500" : "text-muted-foreground opacity-0 group-hover:opacity-100 focus:opacity-100"}`}
            title={isHome ? "É por esta caixa que entras (carrega para voltar à automática)" : "Entrar sempre por esta caixa"} aria-label={isHome ? "Caixa inicial" : "Tornar caixa inicial"}>
            <Star className={`h-3.5 w-3.5 ${isHome ? "fill-current" : ""}`} />
          </button>
        )}
      </div>
    );
  };
  const boxesColumn = (
    <nav className="flex h-full min-h-0 flex-col gap-0.5 overflow-y-auto border-r py-2 pr-1" aria-label="Caixas de email">
      {canCompose && (
        <Button className="mx-2 mb-2 justify-start" size="sm" onClick={() => { setComposeTo(""); setComposeNew(true); }}>
          <PenSquare className="h-4 w-4 mr-1" />Nova mensagem
        </Button>
      )}
      {boxes.length > 0 && <div className="px-3 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Caixas</div>}
      {boxes.map((b) => boxButton(b.key, b.label, b.unread, { mine: b.mine, awaitingN: b.awaiting, canStar: true }))}
      {triage && boxButton(MAIL_TRIAGE_KEY, MAIL_TRIAGE_LABEL, triage.open, { icon: <Inbox className="h-4 w-4 shrink-0 text-amber-600" /> })}
      <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Pessoal</div>
      {boxButton(ME, "O meu email", overview.data?.personalUnread ?? 0, { icon: <Mail className="h-4 w-4 shrink-0 opacity-70" />, canStar: true })}
      {isMe && (overview.data?.others?.length ?? 0) > 0 && (
        <div className="px-2 pt-1"><OthersPicker others={overview.data!.others} value={ownerUserId} onChange={(v) => { setOwnerUserId(v); close(); }} /></div>
      )}
      <p className="mt-auto px-3 pt-3 text-[10.5px] leading-snug text-muted-foreground">A ★ escolhe a caixa por onde entras. O que envias daqui fica ligado à ficha do cliente.</p>
    </nav>
  );

  // ── Coluna 2: as conversas da caixa ──
  const needsGoogle = isMe && !personalReady && ownerUserId == null;
  const listColumn = (
    <div className="flex flex-col h-full min-h-0 border-r">
      <div className="p-2 space-y-2 border-b">
        {isMobile && (
          <Select value={mailbox ?? ""} onValueChange={(v) => selectBox(v)}>
            <SelectTrigger className="h-9"><Inbox className="h-4 w-4 mr-1 text-muted-foreground" /><SelectValue placeholder="Caixa" /></SelectTrigger>
            <SelectContent>
              {boxes.map((b) => <SelectItem key={b.key} value={b.key}>{b.label}{b.unread ? ` (${b.unread})` : ""}</SelectItem>)}
              {triage && <SelectItem value={MAIL_TRIAGE_KEY}>{MAIL_TRIAGE_LABEL}{triage.open ? ` (${triage.open})` : ""}</SelectItem>}
              <SelectItem value={ME}>O meu email{overview.data?.personalUnread ? ` (${overview.data.personalUnread})` : ""}</SelectItem>
            </SelectContent>
          </Select>
        )}
        {isMobile && isMe && (overview.data?.others?.length ?? 0) > 0 && <OthersPicker others={overview.data!.others} value={ownerUserId} onChange={(v) => { setOwnerUserId(v); close(); }} />}
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <Search className="h-4 w-4 absolute left-2 top-2.5 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Pesquisar em ${boxTitle}`} className="h-9 pl-8 text-sm" />
          </div>
          {isMe && personalReady && ownerUserId == null && (
            <Button size="icon" variant="ghost" className="h-9 w-9" disabled={syncMine.isPending} onClick={() => syncMine.mutate()} title="Ir buscar os emails novos" aria-label="Atualizar">
              {syncMine.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </Button>
          )}
          {isMobile && canCompose && (
            <Button size="icon" className="h-9 w-9" onClick={() => { setComposeTo(""); setComposeNew(true); }} aria-label="Nova mensagem"><PenSquare className="h-4 w-4" /></Button>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Select value={status} onValueChange={(v) => setStatus(v as any)}>
            <SelectTrigger className="h-7 w-[110px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas</SelectItem>
              {MAIL_THREAD_STATUSES.map((s) => <SelectItem key={s} value={s}>{MAIL_THREAD_STATUS_LABELS[s]}s</SelectItem>)}
            </SelectContent>
          </Select>
          {!isMe && (
            <Select value={assigned} onValueChange={(v) => setAssigned(v as any)}>
              <SelectTrigger className="h-7 w-[130px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Qualquer responsável</SelectItem>
                <SelectItem value="me">Atribuídas a mim</SelectItem>
                <SelectItem value="none">Sem responsável</SelectItem>
              </SelectContent>
            </Select>
          )}
          {(current?.brands.length ?? 0) > 1 && (
            <Select value={brand} onValueChange={setBrand}>
              <SelectTrigger className="h-7 w-[110px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas as marcas</SelectItem>
                {current!.brands.filter(isMailBrand).map((b) => <SelectItem key={b} value={b}>{MAIL_BRAND_LABELS[b]}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          <Button size="sm" variant={awaiting ? "selected" : "ghost"} className="h-7 text-xs" onClick={() => setAwaiting((x) => !x)}><AlarmClock className="h-3.5 w-3.5 mr-1" />Por responder</Button>
          <Button size="sm" variant={unread ? "selected" : "ghost"} className="h-7 text-xs" onClick={() => setUnread((x) => !x)}>Não lidas</Button>
          <Button size="sm" variant={showAutomatic ? "selected" : "ghost"} className="h-7 text-xs" onClick={() => setShowAutomatic((x) => !x)}
            title="Notificações automáticas de reserva: escondidas por omissão; a pesquisa encontra-as sempre.">
            <Bot className="h-3.5 w-3.5 mr-1" />Automáticos
          </Button>
          {overview.data?.isSuperAdmin && (
            <Button size="sm" variant={archived ? "selected" : "ghost"} className="h-7 text-xs" onClick={() => { setArchived((x) => !x); if (!archived) setStatus("all"); }}
              title="Emails com mais de 5 anos e sem ligação a nenhum registo: não se apagam, ficam aqui e só tu os vês.">
              <Archive className="h-3.5 w-3.5 mr-1" />Arquivo (+5 anos)
            </Button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {needsGoogle && (
          <div className="p-3 space-y-2">
            <p className="text-xs text-muted-foreground">Liga a tua conta Google @multipark para usares o teu email aqui.</p>
            <GoogleAccountCard compact returnTo="/comunicacao/meu-email" />
          </div>
        )}
        {isMe && !needsGoogle && google && google.status !== "connected" && ownerUserId == null && <div className="p-2"><GoogleAccountCard compact returnTo="/comunicacao/meu-email" /></div>}
        {enabled && list.isLoading && <div className="p-4"><Loader2 className="h-4 w-4 animate-spin" /></div>}
        {enabled && list.error && <div className="p-2"><QueryErrorNote error={list.error} onRetry={() => list.refetch()} retrying={list.isFetching} what="as conversas" /></div>}
        {enabled && !list.isLoading && !list.error && threads.length === 0 && <p className="p-4 text-sm text-muted-foreground">Sem conversas com estes filtros.</p>}
        {threads.map((t) => {
          const overdue = t.status !== "resolvido" && isMailOverdue(t.awaitingSince, slaHours, now);
          return (
            <button key={t.id} type="button" onClick={() => open(t.id)}
              className={`w-full text-left px-3 py-2.5 border-b hover:bg-accent/60 ${selected === t.id ? "bg-accent" : ""}`}>
              <div className="flex items-center gap-1.5">
                <span className={`flex-1 truncate text-[13px] ${t.unreadCount ? "font-bold" : "font-medium"}`}>{t.contactName || t.contactEmail || t.subject || "(sem remetente)"}</span>
                <span className="text-[11px] text-muted-foreground shrink-0">{listTime(t.lastMessageAt, now)}</span>
              </div>
              <div className={`text-[12.5px] truncate ${t.unreadCount ? "font-semibold" : ""}`}>{t.subject || "(sem assunto)"}</div>
              <div className="text-xs text-muted-foreground truncate">{t.snippet}</div>
              <div className="flex flex-wrap items-center gap-1 mt-1">
                <BrandChip brand={t.brand} />
                {t.routeLabel && <Badge variant="outline" className="h-5 px-1.5 text-[10.5px] font-normal">{t.routeLabel}</Badge>}
                {t.needsTriage && mailbox !== MAIL_TRIAGE_KEY && <Badge variant="outline" className="h-5 px-1.5 text-[10.5px] border-amber-400 text-amber-700 dark:text-amber-300">Por classificar</Badge>}
                {t.automated && <Badge variant="outline" className="h-5 px-1.5 text-[10.5px] gap-1"><Bot className="h-3 w-3" />Automático</Badge>}
                {t.unreadCount > 0 && <Badge className="h-5 px-1.5 text-[10.5px]">{t.unreadCount} nova{t.unreadCount > 1 ? "s" : ""}</Badge>}
                {t.awaitingSince && t.status !== "resolvido" && (
                  <Badge variant="outline" className={`h-5 px-1.5 text-[10.5px] gap-1 ${overdue ? "border-red-400 text-red-700 dark:text-red-300" : ""}`}>
                    <AlarmClock className="h-3 w-3" />{waitingLabel(t.awaitingSince, now)}
                  </Badge>
                )}
                {t.status !== "aberto" && <Badge variant="secondary" className="h-5 px-1.5 text-[10.5px]">{MAIL_THREAD_STATUS_LABELS[t.status]}</Badge>}
                {t.assignedName && <span className="text-[10.5px] text-muted-foreground inline-flex items-center gap-0.5"><UserRound className="h-3 w-3" />{t.assignedName}</span>}
                {t.links.slice(0, 2).map((l) => <LinkChip key={`${l.type}:${l.id}`} type={l.type} id={l.id} />)}
              </div>
            </button>
          );
        })}
        {total > threads.length + (page - 1) * 40 && (
          <div className="p-2 flex justify-center gap-2">
            {page > 1 && <Button size="sm" variant="ghost" onClick={() => setPage((p) => p - 1)}>Anteriores</Button>}
            <Button size="sm" variant="outline" onClick={() => setPage((p) => p + 1)}>Mais antigas</Button>
          </div>
        )}
      </div>
    </div>
  );

  // ── Coluna 3: a conversa (a maior parte do ecrã) ──
  const threadColumn = selected
    ? <MailThreadView threadId={selected} onBack={isMobile ? close : undefined} onChanged={refresh} canAi />
    : <div className="flex-1 hidden sm:flex items-center justify-center text-sm text-muted-foreground">Escolhe uma conversa.</div>;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-bold flex items-center gap-2"><Mail className="h-5 w-5 text-primary" /> Email <span className="font-normal text-muted-foreground">· {boxTitle}</span></h1>
        <span className="text-xs text-muted-foreground">Ler, responder e ligar cada conversa ao cliente, reserva ou caso — fica tudo registado na ficha.</span>
      </div>
      <Card className="overflow-hidden p-0">
        <div className="flex h-[calc(100vh-9.5rem)] min-h-[480px]">
          {isMobile ? (selected == null ? <div className="flex-1 min-w-0">{listColumn}</div> : threadColumn) : (
            <>
              <div className="w-52 xl:w-60 shrink-0 min-h-0">{boxesColumn}</div>
              <div className="w-[300px] xl:w-[360px] shrink-0 min-h-0">{listColumn}</div>
              <div className="flex min-w-0 flex-1">{threadColumn}</div>
            </>
          )}
        </div>
      </Card>

      <Dialog open={composeNew} onOpenChange={(o) => { setComposeNew(o); if (!o) setComposeTo(""); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader><DialogTitle>Nova mensagem{current && !isMe ? ` — ${current.label}` : isMe ? " — O meu email" : ""}</DialogTitle></DialogHeader>
          {composeNew && (
            <MailComposer
              mode="new"
              prefillTo={composeTo}
              mailbox={isMe ? ME : mailbox}
              defaults={{
                fromOptions: isMe ? (google?.email ? [google.email] : []) : (current?.addresses.map((a) => a.address) ?? []),
                defaultFrom: isMe ? google?.email ?? null : current?.addresses[0]?.address ?? null,
                replyTo: [], replyAllCc: [], subject: "",
                signature: isMe ? "" : (current?.addresses[0] ? (current.signatures as Record<string, string>)[current.addresses[0].brand] ?? "" : ""),
              }}
              onCancel={() => { setComposeNew(false); setComposeTo(""); }}
              onSent={(r) => { setComposeNew(false); setComposeTo(""); refresh(); if (r.threadId) open(r.threadId); }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function OthersPicker({ others, value, onChange }: { others: Array<{ userId: number; name: string; email: string }>; value: number | null; onChange: (v: number | null) => void }) {
  return (
    <Select value={value == null ? "me" : String(value)} onValueChange={(v) => onChange(v === "me" ? null : Number(v))}>
      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="me">O meu email</SelectItem>
        {others.map((o) => <SelectItem key={o.userId} value={String(o.userId)}>{o.name} ({o.email})</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
