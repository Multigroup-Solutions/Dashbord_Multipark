/**
 * Memória do Multis (Multis 2): as notas que ele segue em todas as conversas.
 *  - As minhas: acrescentar à mão (ou escrever no chat «Lembra-te: …»),
 *    arquivar (com Desfazer) e repor as arquivadas.
 *  - Da empresa: toda a gente vê; admin/super_admin acrescentam e arquivam.
 * Nada se apaga.
 */
import { useState } from "react";
import { Archive, ArrowLeft, Building2, Loader2, RotateCcw, User } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { trpc } from "@/lib/trpc";
import { MEMORY_MAX_CHARS } from "@shared/assistantMemory";

type Item = { id: number; text: string; createdAt: string; createdByName: string | null; archivedAt: string | null; archivedByName: string | null };

const fmtDay = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("pt-PT", { timeZone: "Europe/Lisbon", day: "2-digit", month: "2-digit", year: "numeric" });
};

export function MultisMemoryPanel({ onBack }: { onBack: () => void }) {
  const utils = trpc.useUtils();
  const q = trpc.assistant.memory.list.useQuery(undefined, { staleTime: 15_000 });
  const refresh = () => utils.assistant.memory.list.invalidate();
  const restore = trpc.assistant.memory.restore.useMutation({
    onSuccess: () => { void refresh(); },
    onError: (e) => toast.error(e.message),
  });
  const archive = trpc.assistant.memory.archive.useMutation({
    onSuccess: (_r, v) => {
      void refresh();
      toast.success("Nota arquivada.", { action: { label: "Desfazer", onClick: () => restore.mutate({ id: v.id }) } });
    },
    onError: (e) => toast.error(e.message),
  });
  const d = q.data;

  return (
    <div className="flex-1 overflow-y-auto px-4 py-3">
      <div className="mb-3 flex items-center gap-2">
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onBack}>
          <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Voltar à conversa
        </Button>
      </div>
      <h2 className="text-sm font-semibold">Memória</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        O Multis segue estas notas em todas as conversas (nunca para passar por cima das permissões). Para guardar uma, escreve no chat
        <b> «Lembra-te: …»</b> ou acrescenta aqui. Arquivar não apaga.
      </p>
      {q.isLoading && <div className="flex justify-center py-4 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>}
      {q.error && <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="a memória" />}
      {d && !d.enabled && (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950">A memória do Multis está desligada (Definições → Automações).</p>
      )}
      {d && d.enabled && (
        <div className="space-y-5">
          <Section
            icon={<User className="h-3.5 w-3.5" />}
            title={`As minhas notas (${d.mine.length}/${d.limits.personal})`}
            items={d.mine}
            archived={d.mineArchived}
            empty="Ainda não tens notas. Ex.: «Lembra-te: sou do Porto, dá-me sempre os números por parque.»"
            canEdit
            scope="user"
            onArchive={(id) => archive.mutate({ id })}
            onRestore={(id) => restore.mutate({ id })}
            busy={archive.isPending || restore.isPending}
            onAdded={refresh}
          />
          <Section
            icon={<Building2 className="h-3.5 w-3.5" />}
            title={`Memória da empresa (${d.company.length}${d.canManageCompany ? `/${d.limits.company}` : ""})`}
            items={d.company}
            archived={d.companyArchived}
            empty={d.canManageCompany ? "Sem notas da empresa. Ex.: «O parque X fecha às 2h.»" : "Sem notas da empresa."}
            canEdit={d.canManageCompany}
            scope="company"
            note={d.canManageCompany ? "Toda a gente vê estas notas e o Multis segue-as com todos." : "Escritas pelos administradores. Só leitura."}
            onArchive={(id) => archive.mutate({ id })}
            onRestore={(id) => restore.mutate({ id })}
            busy={archive.isPending || restore.isPending}
            onAdded={refresh}
          />
        </div>
      )}
    </div>
  );
}

function Section(props: {
  icon: React.ReactNode;
  title: string;
  items: Item[];
  archived: Item[];
  empty: string;
  canEdit: boolean;
  scope: "user" | "company";
  note?: string;
  busy: boolean;
  onArchive: (id: number) => void;
  onRestore: (id: number) => void;
  onAdded: () => void;
}) {
  const [text, setText] = useState("");
  const add = trpc.assistant.memory.add.useMutation({
    onSuccess: () => { setText(""); props.onAdded(); toast.success("Fica guardado."); },
    onError: (e) => toast.error(e.message),
  });
  const t = text.trim();
  return (
    <section aria-label={props.title} className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{props.icon}{props.title}</h3>
      {props.note && <p className="text-[11px] text-muted-foreground">{props.note}</p>}
      {props.items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{props.empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {props.items.map((m) => (
            <li key={m.id} className="flex items-start gap-2 rounded-md border bg-card px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="whitespace-pre-wrap break-words text-sm">{m.text}</p>
                <p className="text-[11px] text-muted-foreground">
                  {fmtDay(m.createdAt)}{props.scope === "company" && m.createdByName ? ` · ${m.createdByName}` : ""}
                </p>
              </div>
              {props.canEdit && (
                <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" disabled={props.busy} onClick={() => props.onArchive(m.id)} aria-label="Arquivar nota" title="Arquivar (não apaga)">
                  <Archive className="h-3.5 w-3.5" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {props.canEdit && (
        <form
          className="space-y-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (t && t.length <= MEMORY_MAX_CHARS && !add.isPending) add.mutate({ scope: props.scope, text: t });
          }}
        >
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            placeholder={props.scope === "company" ? "Nova nota da empresa…" : "Nova nota…"}
            className="min-h-0 text-sm"
            aria-label={props.scope === "company" ? "Nova nota da empresa" : "Nova nota"}
          />
          <div className="flex items-center justify-between gap-2">
            <span className={`text-[11px] ${t.length > MEMORY_MAX_CHARS ? "text-red-600" : "text-muted-foreground"}`}>{t.length}/{MEMORY_MAX_CHARS}</span>
            <Button type="submit" size="sm" className="h-7 text-xs" disabled={!t || t.length > MEMORY_MAX_CHARS || add.isPending}>
              {add.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Guardar
            </Button>
          </div>
        </form>
      )}
      {props.canEdit && props.archived.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Arquivadas ({props.archived.length})</summary>
          <ul className="mt-1.5 space-y-1">
            {props.archived.map((m) => (
              <li key={m.id} className="flex items-start gap-2 rounded-md border border-dashed px-2 py-1">
                <div className="min-w-0 flex-1">
                  <p className="whitespace-pre-wrap break-words text-muted-foreground">{m.text}</p>
                  <p className="text-[11px] text-muted-foreground">Arquivada {fmtDay(m.archivedAt)}{m.archivedByName ? ` por ${m.archivedByName}` : ""}</p>
                </div>
                <Button variant="ghost" size="sm" className="h-6 shrink-0 px-2 text-[11px]" disabled={props.busy} onClick={() => props.onRestore(m.id)}>
                  <RotateCcw className="mr-1 h-3 w-3" /> Repor
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
