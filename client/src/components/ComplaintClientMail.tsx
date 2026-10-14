// Lote 57 (Jorge, 12 out 2026): na reclamação, TODO o histórico de emails com
// o cliente — todas as conversas das caixas partilhadas que a pessoa vê
// (info@, reservas@, reclamações@, cancelamentos…), da mais recente para a
// mais antiga. "O meu email" e caixas sem acesso nunca aparecem. Erro ≠ vazio.
import { useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { retryTransient } from "@/lib/queryRetry";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowDownLeft, ArrowUpRight, Inbox, Loader2, Mail, AlertTriangle } from "lucide-react";
import { CLIENT_MAIL_MAX, CLIENT_MAIL_PAGE, IDENTITY_SOURCE_LABELS } from "@shared/complaintClientMail";

const STATUS_LABEL: Record<string, string> = { aberto: "Por tratar", pendente: "Pendente", resolvido: "Resolvida" };

export default function ComplaintClientMail({ complaintId }: { complaintId: number }) {
  const [limit, setLimit] = useState(CLIENT_MAIL_PAGE);
  const q = trpc.complaints.clientMail.useQuery(
    { complaintId, limit },
    { retry: retryTransient, staleTime: 60_000, placeholderData: (prev) => prev },
  );
  const data = q.data;

  return (
    <div className="space-y-3" data-testid="complaint-client-mail">
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        <Mail className="h-4 w-4 mt-0.5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-tight">Emails do cliente — todas as caixas</p>
          <p className="text-xs text-muted-foreground">
            Todas as conversas com este cliente nas caixas partilhadas que vês (info@, reservas@, reclamações@…), da mais recente para a mais antiga. O teu email pessoal não entra.
          </p>
        </div>
        {q.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" aria-label="A carregar" />}
      </div>

      {q.isError && <QueryErrorNote error={q.error} what="os emails do cliente" onRetry={() => q.refetch()} retrying={q.isFetching} />}

      {!q.isError && q.isLoading && <p className="text-xs text-muted-foreground">A procurar as conversas do cliente…</p>}

      {data?.noMailAccess && (
        <p className="text-xs text-muted-foreground rounded-md border border-dashed p-2">
          Não tens acesso às caixas de email da Comunicação, por isso não vês as conversas com o cliente.
        </p>
      )}

      {data && !data.noMailAccess && (
        <>
          {data.emails.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
              <span>Procurado por:</span>
              {data.emails.map((e) => (
                <Badge key={e.email} variant="outline" className="max-w-full font-normal text-[11px] whitespace-normal break-all text-left" title={`Vem da ${e.sources.map((s) => IDENTITY_SOURCE_LABELS[s]).join(", ")}`}>
                  {e.email}
                </Badge>
              ))}
            </div>
          )}
          {data.warnings.map((w) => (
            <p key={w} role="status" className="flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden /> <span className="min-w-0">{w}</span>
            </p>
          ))}
          {data.threads.length === 0 ? (
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Inbox className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {data.emails.length === 0
                ? "A reclamação não tem nenhum email pessoal do cliente (nem na reserva nem na ficha do CRM) e nenhuma conversa ligada."
                : "Sem conversas com este cliente nas caixas que vês."}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {data.threads.map((t) => (
                <li key={t.id}>
                  <Link
                    href={t.link}
                    className={`block rounded-lg border bg-card px-3 py-2 hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-primary ${t.thisComplaint ? "border-primary/50 ring-1 ring-primary/30" : ""}`}
                  >
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      <Badge variant="secondary" className="text-[11px] max-w-[60%]" title={t.mailboxLabel}><span className="truncate">{t.mailboxLabel}</span></Badge>
                      {t.thisComplaint && <Badge className="text-[11px] bg-primary text-primary-foreground">Esta reclamação</Badge>}
                      {t.otherComplaintIds.length > 0 && (
                        <Badge variant="outline" className="text-[11px]">Reclamação {t.otherComplaintIds.map((x) => `#${x}`).join(", ")}</Badge>
                      )}
                      {t.unread && <Badge variant="outline" className="text-[11px] border-blue-300 text-blue-800 dark:text-blue-200">Por ler</Badge>}
                      <span className="ml-auto text-muted-foreground whitespace-nowrap tabular-nums">{t.lastMessageAt ? fmtPTDateTime(t.lastMessageAt) : "—"}</span>
                    </div>
                    <div className="mt-1 text-sm font-medium break-words [overflow-wrap:anywhere] line-clamp-2">{t.subject}</div>
                    <div className="mt-0.5 flex items-start gap-1 text-xs text-muted-foreground">
                      {t.lastDirection === "out"
                        ? <ArrowUpRight className="h-3.5 w-3.5 mt-px shrink-0" aria-label="Última: enviada por nós" />
                        : <ArrowDownLeft className="h-3.5 w-3.5 mt-px shrink-0" aria-label="Última: do cliente" />}
                      <span className="min-w-0 break-words [overflow-wrap:anywhere] line-clamp-2">{t.snippet || "(sem texto)"}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                      <span>{t.messageCount} mensage{t.messageCount === 1 ? "m" : "ns"} · {STATUS_LABEL[t.status] ?? t.status}</span>
                      {/* Uma linha só (o email completo no title): num email comprido eram 3 linhas em cada conversa. */}
                      {t.contactEmail && <span className="min-w-0 max-w-full truncate" title={t.contactEmail}>{t.contactEmail}</span>}
                      <span className="ml-auto text-primary underline">Abrir conversa</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {data.threads.length > 0 && <span>{data.threads.length} de {data.total} conversa{data.total === 1 ? "" : "s"}</span>}
            {data.hasMore && limit < CLIENT_MAIL_MAX && (
              <Button size="sm" variant="outline" className="h-8" disabled={q.isFetching} onClick={() => setLimit((n) => Math.min(CLIENT_MAIL_MAX, n + CLIENT_MAIL_PAGE))}>
                {q.isFetching ? "A carregar…" : "Ver mais"}
              </Button>
            )}
            {data.hasMore && limit >= CLIENT_MAIL_MAX && <span>Mostram-se as {CLIENT_MAIL_MAX} mais recentes — as outras estão na Comunicação.</span>}
          </div>
        </>
      )}
    </div>
  );
}
