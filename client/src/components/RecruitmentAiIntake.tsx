/**
 * Recrutamento → "Entraram pela IA" (Jorge, 8 out 2026): a IA separa sozinha
 * os emails das caixas partilhadas e as conversas novas do WhatsApp; quando é
 * alguém a candidatar-se pela 1.ª vez, cria a lead e a candidatura. Aqui vê-se
 * o que entrou assim nos últimos 30 dias, com o motivo, o que se fez e o link
 * para a conversa e para a lead. Só leitura (corrigir = mudar a caixa na
 * conversa; a lead edita-se nos Leads).
 */
import { useState } from "react";
import { Link } from "wouter";
import { ChevronDown, ChevronRight, Mail, MessageCircle, Sparkles } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { fmtPTDateTime } from "@/lib/lisbonTime";

const OUTCOME: Record<string, { label: string; className: string }> = {
  created: { label: "Candidato criado", className: "border-emerald-300 text-emerald-700 dark:text-emerald-300" },
  existing: { label: "Já existia — ligado", className: "border-sky-300 text-sky-700 dark:text-sky-300" },
  employee: { label: "Já é colaborador", className: "border-amber-300 text-amber-700 dark:text-amber-300" },
  invalid: { label: "Sem email nem telefone", className: "border-slate-300 text-slate-600 dark:text-slate-300" },
};

export function RecruitmentAiIntake() {
  const q = trpc.commsRouting.recruitmentIntake.useQuery({ days: 30 }, { refetchInterval: 5 * 60_000, retry: false });
  const [open, setOpen] = useState(true);
  const rows = q.data ?? [];
  if (q.isLoading || (!q.error && rows.length === 0)) return null;
  return (
    <div className="rounded-lg border bg-card">
      <button type="button" className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        <Sparkles className="h-4 w-4 shrink-0 text-violet-600" aria-hidden />
        <span className="flex-1 min-w-0">Entraram pela IA <span className="text-muted-foreground font-normal">(30 dias)</span></span>
        <span className="tabular-nums text-muted-foreground">{rows.length}</span>
      </button>
      {open && (
        <div className="border-t px-3 py-2 space-y-2">
          {q.error && <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="o que entrou pela IA" />}
          <p className="text-xs text-muted-foreground">
            Emails e conversas novas de WhatsApp que a IA reconheceu como candidaturas. No 1.º contacto cria a lead (e a candidatura, quando há email). Se a IA errou, muda a caixa na conversa.
          </p>
          <ul className="divide-y">
            {rows.map((r) => {
              const o = OUTCOME[r.outcome] ?? { label: r.outcome, className: "" };
              const convHref = r.channel === "email"
                ? `/comunicacao?${r.boxKey ? `caixa=${encodeURIComponent(r.boxKey)}&` : ""}t=${r.threadId}`
                : `/whatsapp?c=${r.conversationId}`;
              return (
                <li key={r.id} className="py-2 flex flex-wrap items-start gap-x-2 gap-y-1 text-sm">
                  {r.channel === "email" ? <Mail className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" aria-label="Email" /> : <MessageCircle className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" aria-label="WhatsApp" />}
                  <div className="flex-1 min-w-[12rem]">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {r.leadId ? (
                        <Link href={`/extras-leads?lead=${r.leadId}`} className="font-medium hover:underline">{r.leadName ?? `Lead #${r.leadId}`}</Link>
                      ) : (
                        <span className="font-medium">{r.channel === "email" ? "Email" : "WhatsApp"}</span>
                      )}
                      <Badge variant="outline" className={`text-[11px] ${o.className}`}>{o.label}</Badge>
                      {r.applicationId ? <Badge variant="outline" className="text-[11px]">Candidatura #{r.applicationId}</Badge> : null}
                    </div>
                    {r.reason && <div className="text-xs text-muted-foreground break-words">Entrou pela IA: {r.reason}{r.confidence != null ? ` · ${Math.round(r.confidence * 100)}%` : ""}</div>}
                  </div>
                  <div className="text-xs text-muted-foreground flex items-center gap-2 shrink-0">
                    {r.decidedAt && <span className="tabular-nums">{fmtPTDateTime(r.decidedAt)}</span>}
                    {(r.threadId || r.conversationId) && <Link href={convHref} className="underline hover:no-underline">Abrir conversa</Link>}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
