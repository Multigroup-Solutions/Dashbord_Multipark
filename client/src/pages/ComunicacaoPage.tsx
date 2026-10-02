// Comunicação (/comunicacao) — caixas de email partilhadas da empresa; e
// "O meu email" (/comunicacao/meu-email) — a caixa pessoal @multipark de
// cada pessoa (só o próprio; o super_admin pode consultar as dos outros).
import { Suspense, lazy, useEffect, useMemo, useState } from "react";
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
import { AlarmClock, Archive, Bot, Inbox, Loader2, Mail, MessageCircle, PenSquare, RefreshCw, Search, UserRound } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { GENERAL_BOX_KEY } from "@shared/commsBoxes";
import { CONVERSATION_STATUS_LABELS } from "@shared/whatsappConversation";
import {
  MAIL_BRAND_LABELS, MAIL_THREAD_STATUSES, MAIL_THREAD_STATUS_LABELS, MAIL_TRIAGE_KEY, MAIL_TRIAGE_LABEL, isMailBrand, isMailOverdue, type MailThreadStatus,
} from "@shared/mail";
import { GoogleAccountCard, useGoogleOAuthReturnToast } from "@/components/GoogleAccountCard";
import { MailThreadView } from "@/components/mail/MailThreadView";
import { MailComposer } from "@/components/mail/MailComposer";
import { BrandChip, LinkChip, listTime, waitingLabel } from "@/components/mail/mailUi";
import { QueryErrorNote } from "@/components/QueryErrorNote";

const POLL_MS = 60_000;

// Comunicação única (17f): a conversa de WhatsApp abre aqui, com o mesmo ecrã da página do WhatsApp.
const WhatsAppInboxPage = lazy(() => import("./WhatsAppInboxPage"));

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
  const [mailbox, setMailbox] = useState<string | null>(() => personal ? "me" : params.get("caixa"));
  const [ownerUserId, setOwnerUserId] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(() => Number(params.get("t")) || null);
  // Conversa de WhatsApp aberta (17f — ?w=<id>).
  const [selectedWa, setSelectedWa] = useState<number | null>(() => Number(params.get("w")) || null);
  const { user } = useAuth();
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

  // Primeira caixa visível por omissão.
  useEffect(() => {
    if (personal) { setMailbox("me"); return; }
    if (!mailbox && boxes.length) setMailbox(boxes[0].key);
    else if (!mailbox && triage) setMailbox(MAIL_TRIAGE_KEY);
  }, [personal, boxes, mailbox, triage]);
  useEffect(() => { setPage(1); }, [mailbox, brand, status, assigned, awaiting, unread, showAutomatic, archived, q, ownerUserId]);
  useEffect(() => {
    const t = Number(params.get("t")) || null; if (t) { setSelected(t); setSelectedWa(null); }
    const w = Number(params.get("w")) || null; if (w && !personal) { setSelectedWa(w); setSelected(null); }
    const c = params.get("caixa"); if (c && !personal) setMailbox(c);
  }, [params, personal]);

  const google = overview.data?.google;
  const personalReady = !!google?.connected;
  const enabled = !!mailbox && (mailbox !== "me" || personalReady || ownerUserId != null);
  const list = trpc.mail.threads.list.useQuery({
    mailbox: mailbox ?? "me", ownerUserId: mailbox === "me" ? ownerUserId : null,
    brand: brand === "all" ? null : brand, status, assigned: mailbox === "me" ? "all" : assigned, awaiting, unread,
    search: q.trim() || null, showAutomatic, archived: archived && !!overview.data?.isSuperAdmin, page, pageSize: 40,
  }, { enabled, refetchInterval: POLL_MS, placeholderData: (p) => p });

  // 17f: as conversas de WhatsApp desta caixa entram na mesma lista ("Geral" = Info).
  const canWa = !personal && !!overview.data?.canWhatsapp && !!mailbox && mailbox !== MAIL_TRIAGE_KEY && !archived;
  const waBox = mailbox === GENERAL_BOX_KEY ? "geral" : mailbox;
  const wa = trpc.whatsapp.conversations.list.useQuery(
    { boxKey: waBox, ...(q.trim() ? { search: q.trim().slice(0, 120) } : {}) },
    { enabled: canWa, refetchInterval: POLL_MS, placeholderData: (p) => p },
  );

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
  const refresh = () => { list.refetch(); overview.refetch(); utils.mail.badge.invalidate(); if (canWa) void wa.refetch(); };
  const open = (id: number) => {
    setSelected(id);
    setSelectedWa(null);
    const p = new URLSearchParams(search);
    p.set("t", String(id));
    p.delete("w");
    if (!personal && mailbox) p.set("caixa", mailbox);
    navigate(`${location.split("?")[0]}?${p.toString()}`, { replace: true });
  };
  const openWa = (id: number) => {
    setSelectedWa(id);
    setSelected(null);
    const p = new URLSearchParams(search);
    p.set("w", String(id));
    p.delete("t");
    if (mailbox) p.set("caixa", mailbox);
    navigate(`${location.split("?")[0]}?${p.toString()}`, { replace: true });
  };
  const close = () => {
    setSelected(null);
    setSelectedWa(null);
    const p = new URLSearchParams(search);
    p.delete("t");
    p.delete("w");
    navigate(`${location.split("?")[0]}${p.toString() ? `?${p}` : ""}`, { replace: true });
  };

  const title = personal ? "O meu email" : "Comunicação";
  const canCompose = personal ? (personalReady && ownerUserId == null) : !!current?.canCompose;

  const header = (
    <div className="flex flex-wrap items-end gap-2 justify-between">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold flex items-center gap-2"><Mail className="h-5 w-5 text-primary" /> {title}</h1>
        <p className="text-sm text-muted-foreground">
          {personal ? "O teu email @multipark dentro do dashboard. Os emails de clientes ficam ligados à ficha do cliente." : "Caixas partilhadas, com o email e o WhatsApp de cada tema: ler, responder e ligar cada conversa ao cliente, reserva ou caso."}
        </p>
      </div>
      <div className="flex gap-2">
        {personal && personalReady && ownerUserId == null && (
          <Button size="sm" variant="outline" disabled={syncMine.isPending} onClick={() => syncMine.mutate()}>
            {syncMine.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}Atualizar
          </Button>
        )}
        {canCompose && <Button size="sm" onClick={() => setComposeNew(true)}><PenSquare className="h-4 w-4 mr-1" />Nova mensagem</Button>}
      </div>
    </div>
  );

  if (overview.isLoading) return <div className="p-6"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  // Erro ≠ "sem acesso" nem "liga a tua conta" (17d).
  if (overview.error && !overview.data) {
    return (
      <div className="space-y-3">
        {header}
        <QueryErrorNote error={overview.error} onRetry={() => overview.refetch()} retrying={overview.isFetching} what="as caixas de email" />
      </div>
    );
  }

  if (personal && !personalReady && ownerUserId == null) {
    return (
      <div className="space-y-3 max-w-xl">
        {header}
        <GoogleAccountCard returnTo="/comunicacao/meu-email" />
        {(overview.data?.others?.length ?? 0) > 0 && <OthersPicker others={overview.data!.others} value={ownerUserId} onChange={setOwnerUserId} />}
      </div>
    );
  }
  if (!personal && boxes.length === 0 && !triage) {
    return (
      <div className="space-y-3">
        {header}
        <Card className="p-6 text-sm text-muted-foreground">Não tens acesso a nenhuma caixa partilhada. O teu próprio email está em <a className="text-primary underline" href="/comunicacao/meu-email">O meu email</a>.</Card>
      </div>
    );
  }

  const threads = list.data?.threads ?? [];
  const total = list.data?.total ?? 0;
  // WhatsApp da caixa, com os mesmos filtros (a marca e os automáticos são só do email).
  const waConvs = canWa && page === 1 && brand === "all"
    ? (wa.data ?? []).filter((c) =>
        (status === "all" || c.status === status) &&
        (assigned === "all" || (assigned === "me" ? c.assignedUserId === user?.id : c.assignedUserId == null)) &&
        (!awaiting || (!!c.awaitingSince && c.status !== "resolvido")) &&
        (!unread || c.unreadCount > 0))
    : [];
  type Row = { kind: "email"; at: string | null; t: (typeof threads)[number] } | { kind: "wa"; at: string | null; c: (typeof waConvs)[number] };
  const rows: Row[] = [
    ...threads.map((t) => ({ kind: "email" as const, at: t.lastMessageAt, t })),
    ...waConvs.map((c) => ({ kind: "wa" as const, at: c.lastMessageAt, c })),
  ].sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
  const listColumn = (
    <div className="flex flex-col h-full min-h-0 border-r">
      <div className="p-2 space-y-2 border-b">
        {!personal && (
          <Select value={mailbox ?? ""} onValueChange={(v) => { setMailbox(v); close(); }}>
            <SelectTrigger className="h-9"><Inbox className="h-4 w-4 mr-1 text-muted-foreground" /><SelectValue placeholder="Caixa" /></SelectTrigger>
            <SelectContent>
              {boxes.map((b) => (
                <SelectItem key={b.key} value={b.key}>{b.label}{b.unread ? ` (${b.unread})` : ""}</SelectItem>
              ))}
              {triage && (
                <SelectItem value={MAIL_TRIAGE_KEY}>{MAIL_TRIAGE_LABEL}{triage.open ? ` (${triage.open})` : ""}</SelectItem>
              )}
            </SelectContent>
          </Select>
        )}
        {personal && (overview.data?.others?.length ?? 0) > 0 && <OthersPicker others={overview.data!.others} value={ownerUserId} onChange={(v) => { setOwnerUserId(v); close(); }} />}
        <div className="relative">
          <Search className="h-4 w-4 absolute left-2 top-2.5 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Pesquisar assunto, nome ou email" className="h-9 pl-8 text-sm" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Select value={status} onValueChange={(v) => setStatus(v as any)}>
            <SelectTrigger className="h-7 w-[110px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas</SelectItem>
              {MAIL_THREAD_STATUSES.map((s) => <SelectItem key={s} value={s}>{MAIL_THREAD_STATUS_LABELS[s]}s</SelectItem>)}
            </SelectContent>
          </Select>
          {!personal && (
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
          <Button size="sm" variant={awaiting ? "secondary" : "ghost"} className="h-7 text-xs" onClick={() => setAwaiting((x) => !x)}><AlarmClock className="h-3.5 w-3.5 mr-1" />Por responder</Button>
          <Button size="sm" variant={unread ? "secondary" : "ghost"} className="h-7 text-xs" onClick={() => setUnread((x) => !x)}>Não lidas</Button>
          <Button size="sm" variant={showAutomatic ? "secondary" : "ghost"} className="h-7 text-xs" onClick={() => setShowAutomatic((x) => !x)}
            title="Notificações automáticas de reserva: escondidas por omissão; a pesquisa encontra-as sempre.">
            <Bot className="h-3.5 w-3.5 mr-1" />Mostrar automáticos
          </Button>
          {overview.data?.isSuperAdmin && (
            <Button size="sm" variant={archived ? "secondary" : "ghost"} className="h-7 text-xs" onClick={() => { setArchived((x) => !x); if (!archived) setStatus("all"); }}
              title="Emails com mais de 5 anos e sem ligação a nenhum registo: não se apagam, ficam aqui e só tu os vês.">
              <Archive className="h-3.5 w-3.5 mr-1" />Arquivo (+5 anos)
            </Button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {list.isLoading && <div className="p-4"><Loader2 className="h-4 w-4 animate-spin" /></div>}
        {list.error && <div className="p-2"><QueryErrorNote error={list.error} onRetry={() => list.refetch()} retrying={list.isFetching} what="as conversas" /></div>}
        {canWa && wa.error && <div className="p-2"><QueryErrorNote error={wa.error} onRetry={() => wa.refetch()} retrying={wa.isFetching} what="as conversas de WhatsApp" /></div>}
        {!list.isLoading && !list.error && !(canWa && (wa.isLoading || wa.error)) && rows.length === 0 && <p className="p-4 text-sm text-muted-foreground">Sem conversas com estes filtros.</p>}
        {rows.map((row) => {
          if (row.kind === "wa") {
            const c = row.c;
            return (
              <button key={`w${c.id}`} type="button" onClick={() => openWa(c.id)}
                className={`w-full text-left px-3 py-2.5 border-b hover:bg-accent/60 ${selectedWa === c.id ? "bg-accent" : ""}`}>
                <div className="flex items-center gap-1.5">
                  <MessageCircle className="h-3.5 w-3.5 text-green-600 shrink-0" aria-label="WhatsApp" />
                  <span className={`flex-1 truncate text-[13px] ${c.unreadCount ? "font-bold" : "font-medium"}`}>{c.name}</span>
                  <span className="text-[11px] text-muted-foreground shrink-0">{listTime(c.lastMessageAt, now)}</span>
                </div>
                <div className="text-xs text-muted-foreground truncate">{c.previewDirection === "out" ? "Tu: " : ""}{c.preview ?? ""}</div>
                <div className="flex flex-wrap items-center gap-1 mt-1">
                  <Badge variant="outline" className="h-5 px-1.5 text-[10.5px] font-normal border-green-300 text-green-800 dark:text-green-300">WhatsApp</Badge>
                  {c.unreadCount > 0 && <Badge className="h-5 px-1.5 text-[10.5px] bg-green-600">{c.unreadCount} nova{c.unreadCount > 1 ? "s" : ""}</Badge>}
                  {c.awaitingSince && c.status !== "resolvido" && (
                    <Badge variant="outline" className="h-5 px-1.5 text-[10.5px] gap-1"><AlarmClock className="h-3 w-3" />{waitingLabel(c.awaitingSince, now)}</Badge>
                  )}
                  {c.status !== "aberto" && <Badge variant="secondary" className="h-5 px-1.5 text-[10.5px]">{CONVERSATION_STATUS_LABELS[c.status]}</Badge>}
                  {c.assignedName && <span className="text-[10.5px] text-muted-foreground inline-flex items-center gap-0.5"><UserRound className="h-3 w-3" />{c.assignedName}</span>}
                </div>
              </button>
            );
          }
          const t = row.t;
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

  const threadColumn = selectedWa
    ? (
      <Suspense fallback={<div className="flex-1 flex items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}>
        <WhatsAppInboxPage embeddedConversationId={selectedWa} onEmbeddedClose={close} onEmbeddedChanged={() => { void wa.refetch(); }} />
      </Suspense>
    )
    : selected
    ? <MailThreadView threadId={selected} onBack={isMobile ? close : undefined} onChanged={refresh} canAi />
    : <div className="flex-1 hidden sm:flex items-center justify-center text-sm text-muted-foreground">Escolhe uma conversa.</div>;

  return (
    <div className="space-y-3">
      {header}
      {personal && google && google.status !== "connected" && ownerUserId == null && <GoogleAccountCard compact returnTo="/comunicacao/meu-email" />}
      <Card className="overflow-hidden p-0">
        <div className="flex h-[calc(100vh-13rem)] min-h-[440px]">
          {isMobile ? (selected == null && selectedWa == null ? <div className="flex-1 min-w-0">{listColumn}</div> : threadColumn) : (
            <>
              <div className="w-[340px] shrink-0 min-h-0">{listColumn}</div>
              {threadColumn}
            </>
          )}
        </div>
      </Card>

      <Dialog open={composeNew} onOpenChange={setComposeNew}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader><DialogTitle>Nova mensagem{current && !personal ? ` — ${current.label}` : ""}</DialogTitle></DialogHeader>
          {composeNew && (
            <MailComposer
              mode="new"
              mailbox={personal ? "me" : mailbox}
              defaults={{
                fromOptions: personal ? (google?.email ? [google.email] : []) : (current?.addresses.map((a) => a.address) ?? []),
                defaultFrom: personal ? google?.email ?? null : current?.addresses[0]?.address ?? null,
                replyTo: [], replyAllCc: [], subject: "",
                signature: personal ? "" : (current?.addresses[0] ? (current.signatures as Record<string, string>)[current.addresses[0].brand] ?? "" : ""),
              }}
              onCancel={() => setComposeNew(false)}
              onSent={(r) => { setComposeNew(false); refresh(); if (r.threadId) open(r.threadId); }}
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
