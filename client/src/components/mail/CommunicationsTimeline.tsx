// "Comunicações" de um registo (cliente, reserva, reclamação, perdido,
// ocorrência): emails ligados (automática ou manualmente) + WhatsApp do
// mesmo cliente/reserva, por ordem cronológica.
import { useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Loader2, Mail, MessageCircle, ArrowDownLeft, ArrowUpRight } from "lucide-react";
import type { MailLinkType } from "@shared/mail";
import { fullTime } from "./mailUi";

export function CommunicationsTimeline({ type, id, title = "Comunicações", compact = false }: { type: MailLinkType; id: string | number | null | undefined; title?: string; compact?: boolean }) {
  const key = id == null ? "" : String(id).trim();
  const q = trpc.mail.timeline.useQuery({ type, id: key }, { enabled: key.length > 0, staleTime: 60_000, retry: false });
  const [expanded, setExpanded] = useState<string | null>(null);
  if (!key) return null;
  if (q.error) return null; // sem acesso ao módulo → não mostra nada
  const items = q.data?.items ?? [];
  return (
    <div className="space-y-2">
      {!compact && <div className="text-sm font-semibold flex items-center gap-1.5"><Mail className="h-4 w-4 text-primary" />{title} {q.data ? `(${items.length})` : ""}</div>}
      {q.isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      {!q.isLoading && items.length === 0 && <p className="text-xs text-muted-foreground">Sem emails nem mensagens ligadas.</p>}
      <div className="space-y-1.5">
        {items.map((it) => {
          const open = expanded === it.id;
          return (
            <div key={it.id} className={`rounded-lg border bg-card px-3 py-2 ${it.direction === "out" ? "border-primary/25" : ""}`}>
              <button type="button" className="w-full text-left" onClick={() => setExpanded(open ? null : it.id)}>
                <div className="flex items-center gap-1.5 text-xs">
                  {it.kind === "whatsapp" ? <MessageCircle className="h-3.5 w-3.5 text-green-600 shrink-0" /> : <Mail className="h-3.5 w-3.5 text-primary shrink-0" />}
                  {it.direction === "out" ? <ArrowUpRight className="h-3 w-3 text-muted-foreground shrink-0" /> : <ArrowDownLeft className="h-3 w-3 text-muted-foreground shrink-0" />}
                  <span className="font-semibold truncate">{it.who}</span>
                  <span className="text-muted-foreground truncate">· {it.source}</span>
                  <span className="ml-auto text-muted-foreground shrink-0">{fullTime(it.at)}</span>
                </div>
                {it.subject && <div className="text-[12.5px] font-medium truncate mt-0.5">{it.subject}</div>}
                <div className={`text-xs text-muted-foreground whitespace-pre-wrap break-words ${open ? "" : "line-clamp-2"}`}>{it.text}</div>
              </button>
              {open && it.link && <Link href={it.link} className="text-xs text-primary underline">Abrir {it.kind === "whatsapp" ? "no WhatsApp" : "na Comunicação"}</Link>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
