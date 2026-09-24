// Conversa de email: mensagens (HTML seguro em iframe sandbox, imagens
// remotas bloqueadas até "Mostrar imagens"), anexos, estado/responsável,
// ligações (cliente, reserva, reclamação…) e editor.
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import {
  ArrowLeft, Forward, ImageOff, Image as ImageIcon, Link2, Loader2, MailOpen, Paperclip, Reply, ReplyAll, Unlink, UserRound,
} from "lucide-react";
import {
  MAIL_LINK_LABELS, MAIL_LINK_TYPES, MAIL_THREAD_STATUSES, MAIL_THREAD_STATUS_LABELS, type MailLinkType, type MailThreadStatus,
} from "@shared/mail";
import { BrandChip, EmailHtmlFrame, MAIL_LINK_HREF, fullTime } from "./mailUi";
import { MailComposer, type ComposeMode } from "./MailComposer";

function LinksPanel({ threadId, links, canAct, onChanged }: {
  threadId: number;
  links: Array<{ type: string; id: string; confidence: number; source: string; reason: string | null }>;
  canAct: boolean;
  onChanged: () => void;
}) {
  const [type, setType] = useState<MailLinkType>("client");
  const [value, setValue] = useState("");
  const link = trpc.mail.threads.link.useMutation({
    onSuccess: () => { setValue(""); toast.success("Ligado."); onChanged(); },
    onError: (e) => toast.error(e.message),
  });
  const unlink = trpc.mail.threads.unlink.useMutation({ onSuccess: onChanged, onError: (e) => toast.error(e.message) });
  const placeholder = { client: "email do cliente", booking: "referência / nº da reserva", complaint: "nº da reclamação", lost_found: "nº do caso", incident: "nº da ocorrência" }[type];
  return (
    <div className="rounded-lg border bg-muted/40 p-2.5 space-y-2">
      <div className="text-xs font-semibold flex items-center gap-1"><Link2 className="h-3.5 w-3.5" /> Ligado a</div>
      {links.length === 0 && <p className="text-xs text-muted-foreground">Sem ligações.</p>}
      <div className="flex flex-col gap-1">
        {links.map((l) => {
          const href = MAIL_LINK_HREF[l.type as MailLinkType]?.(l.id) ?? null;
          return (
            <div key={`${l.type}:${l.id}`} className="flex items-center gap-2 text-xs">
              <Badge variant="outline" className="h-5 px-1.5 text-[10.5px] font-normal shrink-0">{MAIL_LINK_LABELS[l.type as MailLinkType] ?? l.type}</Badge>
              {href ? <Link href={href} className="text-primary underline truncate">{l.id}</Link> : <span className="truncate font-mono">{l.id}</span>}
              <span className="text-[10.5px] text-muted-foreground shrink-0" title={l.reason ?? undefined}>{l.source === "manual" ? "manual" : `${l.confidence}%`}</span>
              {canAct && (
                <button type="button" className="ml-auto text-muted-foreground hover:text-destructive" title="Desligar"
                  onClick={() => unlink.mutate({ id: threadId, type: l.type as MailLinkType, entityId: l.id })}>
                  <Unlink className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {canAct && (
        <div className="flex flex-wrap gap-1.5">
          <Select value={type} onValueChange={(v) => setType(v as MailLinkType)}>
            <SelectTrigger className="h-7 w-[150px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>{MAIL_LINK_TYPES.map((t) => <SelectItem key={t} value={t}>{MAIL_LINK_LABELS[t]}</SelectItem>)}</SelectContent>
          </Select>
          <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} className="h-7 text-xs flex-1 min-w-[140px]" />
          <Button size="sm" className="h-7 text-xs" disabled={!value.trim() || link.isPending} onClick={() => link.mutate({ id: threadId, type, entityId: value.trim() })}>Ligar</Button>
        </div>
      )}
    </div>
  );
}

export function MailThreadView({ threadId, onBack, onChanged, canAi }: { threadId: number; onBack?: () => void; onChanged: () => void; canAi?: boolean }) {
  const [showImages, setShowImages] = useState(false);
  const [compose, setCompose] = useState<ComposeMode | null>(null);
  const [showLinks, setShowLinks] = useState(false);
  const utils = trpc.useUtils();
  const q = trpc.mail.threads.get.useQuery({ id: threadId, showImages }, { refetchInterval: 60_000 });
  const t = q.data;
  const markRead = trpc.mail.threads.markRead.useMutation({ onSuccess: () => { onChanged(); utils.mail.badge.invalidate(); } });
  const setStatus = trpc.mail.threads.setStatus.useMutation({ onSuccess: () => { q.refetch(); onChanged(); }, onError: (e) => toast.error(e.message) });
  const assign = trpc.mail.threads.assign.useMutation({ onSuccess: () => { q.refetch(); onChanged(); }, onError: (e) => toast.error(e.message) });
  const assignees = trpc.mail.threads.assignees.useQuery({ mailbox: t?.mailbox?.key ?? "" }, { enabled: !!t?.mailbox && !!t?.canAct, staleTime: 10 * 60_000 });

  useEffect(() => { setShowImages(false); setCompose(null); }, [threadId]);
  useEffect(() => {
    if (t && t.thread.unreadCount > 0) markRead.mutate({ id: threadId, read: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t?.thread.id, t?.thread.unreadCount]);

  if (q.isLoading) return <div className="flex-1 flex items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (q.error || !t) return <div className="flex-1 p-4 text-sm text-muted-foreground">{q.error?.message ?? "Conversa não encontrada."}</div>;

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      {/* Cabeçalho */}
      <div className="border-b p-3 space-y-2">
        <div className="flex items-start gap-2">
          {onBack && <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onBack} aria-label="Voltar"><ArrowLeft className="h-4 w-4" /></Button>}
          <div className="flex-1 min-w-0">
            <h2 className="font-semibold text-[15px] leading-snug break-words">{t.thread.subject || "(sem assunto)"}</h2>
            <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-1.5 mt-0.5">
              <span>{t.mailbox?.label ?? (t.personal ? "O meu email" : "Sem caixa")}</span>
              <BrandChip brand={t.thread.brand} />
              {t.thread.contactEmail && <span className="truncate">· {t.thread.contactName ? `${t.thread.contactName} <${t.thread.contactEmail}>` : t.thread.contactEmail}</span>}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {t.canAct && (
            <Select value={t.thread.status} onValueChange={(v) => setStatus.mutate({ id: threadId, status: v as MailThreadStatus })}>
              <SelectTrigger className="h-7 w-[120px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{MAIL_THREAD_STATUSES.map((s) => <SelectItem key={s} value={s}>{MAIL_THREAD_STATUS_LABELS[s]}</SelectItem>)}</SelectContent>
            </Select>
          )}
          {t.canAct && t.mailbox && (
            <Select value={t.thread.assignedUserId ? String(t.thread.assignedUserId) : "none"} onValueChange={(v) => assign.mutate({ id: threadId, userId: v === "none" ? null : Number(v) })}>
              <SelectTrigger className="h-7 w-[170px] text-xs"><UserRound className="h-3.5 w-3.5 mr-1" /><SelectValue placeholder="Responsável" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Sem responsável</SelectItem>
                {(assignees.data ?? []).map((u) => <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          <Button size="sm" variant={showLinks ? "secondary" : "outline"} className="h-7 text-xs" onClick={() => setShowLinks((x) => !x)}>
            <Link2 className="h-3.5 w-3.5 mr-1" />Ligações ({t.links.length})
          </Button>
          {t.canAct && (
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => markRead.mutate({ id: threadId, read: false }, { onSuccess: () => { toast.success("Marcada como não lida."); onBack?.(); } })}>
              <MailOpen className="h-3.5 w-3.5 mr-1" />Não lida
            </Button>
          )}
          {t.blockedImages > 0 && !showImages && (
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setShowImages(true)}>
              <ImageIcon className="h-3.5 w-3.5 mr-1" />Mostrar imagens ({t.blockedImages})
            </Button>
          )}
          {showImages && <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1"><ImageOff className="h-3 w-3" />imagens carregadas</span>}
        </div>
        {showLinks && <LinksPanel threadId={threadId} links={t.links} canAct={t.canAct} onChanged={() => { q.refetch(); onChanged(); }} />}
      </div>

      {/* Mensagens */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3 bg-muted/30">
        {t.messages.map((m, i) => (
          <MessageCard key={m.id} m={m} defaultOpen={i >= t.messages.length - 3} />
        ))}
      </div>

      {/* Editor */}
      <div className="border-t p-3">
        {t.canSend ? (
          compose ? (
            <MailComposer mode={compose} threadId={threadId} defaults={t.compose} canAi={canAi}
              onCancel={() => setCompose(null)} onSent={() => { setCompose(null); q.refetch(); onChanged(); }} />
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setCompose("reply")}><Reply className="h-4 w-4 mr-1" />Responder</Button>
              {t.compose.replyAllCc.length > 0 && <Button size="sm" variant="outline" onClick={() => setCompose("replyAll")}><ReplyAll className="h-4 w-4 mr-1" />Responder a todos</Button>}
              <Button size="sm" variant="outline" onClick={() => setCompose("forward")}><Forward className="h-4 w-4 mr-1" />Reencaminhar</Button>
            </div>
          )
        ) : (
          <p className="text-xs text-muted-foreground">{t.personal ? "Só o dono desta caixa pode responder." : "Podes ver esta conversa, mas não responder."}</p>
        )}
      </div>
    </div>
  );
}

type Msg = {
  id: number; direction: "in" | "out"; fromName: string | null; fromEmail: string | null; to: string[]; cc: string[];
  subject: string; snippet: string; text: string; htmlDocument: string | null; attachments: Array<{ index: number; filename: string; size: number; href: string }>;
  sentAt: string | null; sentByName: string | null; pipeline: string | null; pipelineStatus: string | null;
};

function MessageCard({ m, defaultOpen }: { m: Msg; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`rounded-xl border bg-card shadow-sm ${m.direction === "out" ? "border-primary/30" : ""}`}>
      <button type="button" className="w-full text-left px-3 py-2 flex items-start gap-2" onClick={() => setOpen((x) => !x)}>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold truncate">
            {m.direction === "out" ? `${m.sentByName ? `${m.sentByName} · ` : ""}${m.fromEmail ?? ""}` : (m.fromName ?? m.fromEmail ?? "—")}
            {m.direction === "in" && m.fromName && <span className="font-normal text-muted-foreground"> &lt;{m.fromEmail}&gt;</span>}
          </div>
          {open ? (
            <div className="text-[11.5px] text-muted-foreground break-words">Para: {m.to.join(", ") || "—"}{m.cc.length ? ` · Cc: ${m.cc.join(", ")}` : ""}</div>
          ) : (
            <div className="text-xs text-muted-foreground truncate">{m.snippet}</div>
          )}
        </div>
        <div className="text-[11px] text-muted-foreground shrink-0 text-right">
          {fullTime(m.sentAt)}
          {m.direction === "out" && <div className="text-primary font-medium">enviado</div>}
          {m.pipeline && m.pipelineStatus === "processed" && <div className="text-emerald-700 dark:text-emerald-300">→ {m.pipeline}</div>}
        </div>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2">
          {m.htmlDocument ? <EmailHtmlFrame doc={m.htmlDocument} /> : <pre className="whitespace-pre-wrap break-words text-sm font-sans">{m.text || m.snippet}</pre>}
          {m.attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {m.attachments.map((a) => (
                <a key={a.index} href={a.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs border rounded px-1.5 py-0.5 hover:bg-accent max-w-full">
                  <Paperclip className="h-3 w-3 shrink-0" /><span className="truncate">{a.filename}</span>
                  <span className="text-muted-foreground shrink-0">{a.size > 0 ? `${Math.max(1, Math.round(a.size / 1024))} KB` : ""}</span>
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
