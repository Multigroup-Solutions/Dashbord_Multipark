/**
 * "Perguntas que falharam" (/multis/falhas) — Multis 2, só admin/super_admin.
 * As respostas com 👎 da pessoa e as que o servidor marcou sozinho (o Multis
 * disse que não sabia / não tinha acesso / não encontrou nos manuais, ou uma
 * ferramenta deu erro), para afinar a ajuda (docs/ajuda) e as ferramentas.
 * "Marcar como tratada" leva uma nota e tem Desfazer. Nada se apaga.
 */
import { useState } from "react";
import { Link } from "wouter";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";
import { toast } from "sonner";
import { CheckCircle2, Loader2, MessageSquareWarning, RotateCcw, ThumbsDown, ThumbsUp, Bot } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { isMultisAdmin } from "@shared/assistantMemory";
import {
  FEEDBACK_COMMENT_MAX, FEEDBACK_PERIODS, FEEDBACK_REASONS, FEEDBACK_REASON_LABELS, FEEDBACK_STATUSES, FEEDBACK_STATUS_LABELS,
  type FeedbackPeriod, type FeedbackReason, type FeedbackStatus,
} from "@shared/assistantFeedback";

const ALL = "all";

const fmtWhen = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("pt-PT", { timeZone: "Europe/Lisbon", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

export default function MultisFalhasPage() {
  const { user } = useAuth();
  const [days, setDays] = useState<FeedbackPeriod>(30);
  const [reason, setReason] = useState<FeedbackReason | typeof ALL>(ALL);
  const [status, setStatus] = useState<FeedbackStatus>("open");
  const allowed = !!user && isMultisAdmin(user.role);
  const q = trpc.assistant.feedback.list.useQuery(
    { days, reason: reason === ALL ? null : reason, status },
    { enabled: allowed, staleTime: 30_000 },
  );
  if (!user) return null;
  if (!allowed) return <div className="p-6 text-sm text-muted-foreground">Só os administradores veem as perguntas que falharam.</div>;
  const d = q.data;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold sm:text-2xl"><MessageSquareWarning className="h-5 w-5" /> Perguntas que falharam</h1>
        <p className="text-sm text-muted-foreground">
          Respostas do Multis com 👎 e as que ele próprio não conseguiu responder (marcadas sozinhas). Servem para melhorar a ajuda e as ferramentas.
          Os interruptores estão em <Link href="/definicoes?tab=automacoes" className="underline">Definições → Automações</Link>.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v) as FeedbackPeriod)}>
          <SelectTrigger className="h-9 w-40" aria-label="Período"><SelectValue /></SelectTrigger>
          <SelectContent>
            {FEEDBACK_PERIODS.map((p) => <SelectItem key={p} value={String(p)}>Últimos {p} dias</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={reason} onValueChange={(v) => setReason(v as FeedbackReason | typeof ALL)}>
          <SelectTrigger className="h-9 w-52" aria-label="Motivo"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos os motivos</SelectItem>
            {FEEDBACK_REASONS.map((r) => <SelectItem key={r} value={r}>{FEEDBACK_REASON_LABELS[r]}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={(v) => setStatus(v as FeedbackStatus)}>
          <SelectTrigger className="h-9 w-36" aria-label="Estado"><SelectValue /></SelectTrigger>
          <SelectContent>
            {FEEDBACK_STATUSES.map((s) => <SelectItem key={s} value={s}>{FEEDBACK_STATUS_LABELS[s]}</SelectItem>)}
          </SelectContent>
        </Select>
        {q.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      {d && (
        <div className="flex flex-wrap gap-2 text-sm">
          <Badge variant="outline" className="gap-1 bg-emerald-50 text-emerald-800 border-emerald-200"><ThumbsUp className="h-3 w-3" /> {d.counts.up}</Badge>
          <Badge variant="outline" className="gap-1 bg-red-50 text-red-800 border-red-200"><ThumbsDown className="h-3 w-3" /> {d.counts.down}</Badge>
          <Badge variant="outline" className="gap-1"><Bot className="h-3 w-3" /> {d.counts.auto} marcadas sozinhas</Badge>
          <Badge variant="outline" className="gap-1 bg-amber-50 text-amber-900 border-amber-200">{d.counts.open} por tratar</Badge>
          <span className="text-xs text-muted-foreground self-center">nos últimos {days} dias</span>
        </div>
      )}

      {q.error && <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="as perguntas que falharam" />}
      {q.isLoading && <div className="flex justify-center py-8 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>}
      {d && d.items.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground">Nada {status === "resolved" ? "tratado" : "por tratar"} neste período.</p>
      )}
      {d?.truncated && <p className="text-xs text-muted-foreground">Mostram-se as 300 mais recentes. Encurta o período para ver as outras.</p>}

      <div className="space-y-3">
        {d?.items.map((it) => <FailedCard key={it.id} item={it} />)}
      </div>
    </div>
  );
}

type Item = inferRouterOutputs<AppRouter>["assistant"]["feedback"]["list"]["items"][number];

function FailedCard({ item }: { item: Item }) {
  const utils = trpc.useUtils();
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const [showAll, setShowAll] = useState(false);
  const refresh = () => utils.assistant.feedback.list.invalidate();
  const unresolve = trpc.assistant.feedback.unresolve.useMutation({ onSuccess: () => { void refresh(); }, onError: (e) => toast.error(e.message) });
  const resolve = trpc.assistant.feedback.resolve.useMutation({
    onSuccess: () => {
      setNoting(false);
      setNote("");
      void refresh();
      toast.success("Marcada como tratada.", { action: { label: "Desfazer", onClick: () => unresolve.mutate({ id: item.id }) } });
    },
    onError: (e) => toast.error(e.message),
  });
  const answer = item.answer ?? "";
  const longAnswer = answer.length > 400;
  return (
    <Card>
      <CardContent className="space-y-2 p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{fmtWhen(item.createdAt)}</span>
          <span>· {item.userName ?? `#${item.userId}`}</span>
          {item.path && <span>· <span className="font-mono">{item.path}</span></span>}
          <Badge variant="outline" className={item.auto ? "" : "bg-red-50 text-red-800 border-red-200"}>
            {item.auto ? "Automática" : "👎 da pessoa"}{item.alsoAuto ? " + automática" : ""}
          </Badge>
          {item.reason && <Badge variant="outline">{FEEDBACK_REASON_LABELS[item.reason as FeedbackReason] ?? item.reason}</Badge>}
          {item.resolvedAt && <Badge variant="outline" className="bg-emerald-50 text-emerald-800 border-emerald-200"><CheckCircle2 className="mr-1 h-3 w-3" />Tratada</Badge>}
        </div>
        <p className="whitespace-pre-wrap break-words text-sm font-medium">{item.question ?? "(pergunta não guardada)"}</p>
        <div className="rounded-md bg-muted px-3 py-2 text-sm">
          <p className="whitespace-pre-wrap break-words">{longAnswer && !showAll ? `${answer.slice(0, 400)}…` : answer || "(sem resposta)"}</p>
          {longAnswer && (
            <button type="button" className="mt-1 text-xs text-primary underline" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Ver menos" : "Ver a resposta toda"}
            </button>
          )}
        </div>
        {item.comment && <p className="text-sm"><span className="text-muted-foreground">{item.auto ? "Porquê: " : "Comentário: "}</span>{item.comment}</p>}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>Ferramentas: {item.tools.length ? item.tools.join(", ") : "nenhuma"}</span>
          <span>Ajuda usada: {item.helpFiles.length ? item.helpFiles.join(", ") : "nenhuma"}</span>
        </div>
        {item.resolvedAt ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">
              Tratada {fmtWhen(item.resolvedAt)}{item.resolvedByName ? ` por ${item.resolvedByName}` : ""}{item.resolvedNote ? ` — ${item.resolvedNote}` : ""}
            </span>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={unresolve.isPending} onClick={() => unresolve.mutate({ id: item.id })}>
              <RotateCcw className="mr-1 h-3 w-3" /> Desfazer
            </Button>
          </div>
        ) : noting ? (
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => { e.preventDefault(); resolve.mutate({ id: item.id, note: note.trim() || null }); }}
          >
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, FEEDBACK_COMMENT_MAX))}
              placeholder="O que se fez? (ex.: ajuda da Caixa atualizada)"
              className="h-8 text-sm"
              aria-label="Nota"
              autoFocus
            />
            <div className="flex gap-1">
              <Button type="submit" size="sm" className="h-8" disabled={resolve.isPending}>Marcar como tratada</Button>
              <Button type="button" variant="ghost" size="sm" className="h-8" onClick={() => setNoting(false)}>Cancelar</Button>
            </div>
          </form>
        ) : (
          <Button variant="outline" size="sm" className="h-8" onClick={() => setNoting(true)}>
            <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> Marcar como tratada
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
