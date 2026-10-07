/**
 * "Pedir documentos em falta" (pauta do Rafael, 7 out 2026): na ficha de um
 * extra e em grupo na lista do RH. Janela de confirmação com o texto EXATO
 * por canal (WhatsApp: template da cidade + os dois campos; email: assunto e
 * corpo), quem recebe e quem fica de fora (e porquê), depois o resultado por
 * pessoa. Regras: shared/docsRequest.ts; servidor: server/rhDocsRequest.ts.
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, ChevronDown, ChevronRight, FileWarning, Mail, MessageCircle, Send, XCircle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DOCS_REQUEST_CHANNELS,
  DOCS_REQUEST_CHANNEL_LABELS,
  DOCS_REQUEST_CITY_LABELS,
  docsPlanIgnoredReasons,
  docsPlanWillSend,
  requestedDocLabel,
  type DocsChannelPlan,
  type DocsRequestChannel,
  type DocsRequestPersonPlan,
} from "@shared/docsRequest";

const CHANNEL_ICON: Record<DocsRequestChannel, typeof Mail> = { whatsapp: MessageCircle, email: Mail };

/** Código do pedido (um por abertura da janela): carregar outra vez não reenvia. */
function newRequestKey(): string {
  const raw = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}${Math.random()}`;
  return raw.replace(/[^A-Za-z0-9]/g, "").slice(0, 40).padEnd(12, "0");
}

function useChannels(open: boolean) {
  const [channels, setChannels] = useState<DocsRequestChannel[]>(["whatsapp", "email"]);
  useEffect(() => { if (open) setChannels(["whatsapp", "email"]); }, [open]);
  const toggle = (c: DocsRequestChannel, on: boolean) =>
    setChannels((prev) => (on ? DOCS_REQUEST_CHANNELS.filter((x) => x === c || prev.includes(x)) : prev.filter((x) => x !== c)));
  return { channels, toggle };
}

function ChannelPicker({ channels, toggle, configured, disabled }: {
  channels: DocsRequestChannel[];
  toggle: (c: DocsRequestChannel, on: boolean) => void;
  configured?: Record<DocsRequestChannel, boolean>;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-4" role="group" aria-label="Canais">
      {DOCS_REQUEST_CHANNELS.map((c) => {
        const Icon = CHANNEL_ICON[c];
        return (
          <label key={c} className="flex items-center gap-2 text-sm cursor-pointer">
            <Checkbox checked={channels.includes(c)} onCheckedChange={(v) => toggle(c, v === true)} disabled={disabled} />
            <Icon className="h-4 w-4" /> {DOCS_REQUEST_CHANNEL_LABELS[c]}
            {c === "whatsapp" && <span className="text-xs text-muted-foreground">(template da cidade)</span>}
            {configured && !configured[c] && <span className="text-xs text-amber-700 dark:text-amber-300">— não configurado</span>}
          </label>
        );
      })}
    </div>
  );
}

function PlanChip({ channel, plan }: { channel: DocsRequestChannel; plan: DocsChannelPlan }) {
  const Icon = CHANNEL_ICON[channel];
  if (plan.action === "off") return null;
  if (plan.action === "send") {
    return (
      <Badge variant="outline" className="gap-1 text-[11px] border-emerald-300 text-emerald-800 dark:text-emerald-300">
        <Icon className="h-3 w-3" /> {DOCS_REQUEST_CHANNEL_LABELS[channel]}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 text-[11px] text-muted-foreground" title={plan.reason}>
      <Icon className="h-3 w-3" /> {plan.kind === "template_missing" ? "template por configurar" : "não recebe"}
    </Badge>
  );
}

/** O texto exato de cada canal para UMA pessoa. */
function PersonPreview({ p, channels }: { p: DocsRequestPersonPlan; channels: DocsRequestChannel[] }) {
  return (
    <div className="space-y-2 text-sm">
      <div>
        <div className="text-xs font-medium text-muted-foreground">Documentos pedidos</div>
        {p.docs.length ? (
          <ul className="mt-0.5 list-disc pl-5 text-xs">
            {p.docs.map((d) => <li key={d.docType} className={d.state === "rejected" ? "text-red-700 dark:text-red-300" : ""}>{requestedDocLabel(d)}</li>)}
          </ul>
        ) : <div className="text-xs text-muted-foreground">Nenhum (o que falta é do RH).</div>}
        {p.rhOnly.length > 0 && (
          <div className="mt-1 text-[11px] text-muted-foreground">A tratar pelo RH (não se pede à pessoa): {p.rhOnly.map((d) => d.label).join(", ")}.</div>
        )}
      </div>
      {channels.includes("whatsapp") && (
        <div className="rounded-md border p-2">
          <div className="flex items-center gap-1.5 text-xs font-medium"><MessageCircle className="h-3.5 w-3.5" /> WhatsApp</div>
          {p.channels.whatsapp.action === "skip" ? (
            <div className="mt-0.5 text-xs text-amber-800 dark:text-amber-300">{p.channels.whatsapp.reason}</div>
          ) : p.template ? (
            <div className="mt-0.5 space-y-0.5 text-xs">
              <div className="text-muted-foreground">Template {p.template.name} · {p.template.language}{p.city ? ` · ${DOCS_REQUEST_CITY_LABELS[p.city]}` : ""}</div>
              <div><span className="text-muted-foreground">{"{{1}}"}</span> {p.whatsappParams[0]}</div>
              <div className="break-words"><span className="text-muted-foreground">{"{{2}}"}</span> {p.whatsappParams[1]}</div>
            </div>
          ) : null}
        </div>
      )}
      {channels.includes("email") && (
        <div className="rounded-md border p-2">
          <div className="flex items-center gap-1.5 text-xs font-medium"><Mail className="h-3.5 w-3.5" /> Email</div>
          {p.channels.email.action === "skip" ? (
            <div className="mt-0.5 text-xs text-amber-800 dark:text-amber-300">{p.channels.email.reason}</div>
          ) : (
            <div className="mt-0.5 space-y-1 text-xs">
              <div className="text-muted-foreground break-all">“{p.emailSubject}” → {p.emailTo}</div>
              <div className="whitespace-pre-wrap break-words rounded bg-muted/50 p-2">{p.emailLines.join("\n\n")}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type ResultPerson = { employeeId: number; name: string; already: boolean } & Record<DocsRequestChannel, { status: string; label: string; detail: string | null } | null>;

function ResultList({ people }: { people: ResultPerson[] }) {
  if (!people.length) return null;
  return (
    <ul className="space-y-1">
      {people.map((x) => (
        <li key={x.employeeId} className="flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-sm">
          <span className="font-medium">{x.name}</span>
          {x.already && <span className="text-xs text-muted-foreground">(já tinha seguido — nada reenviado)</span>}
          {DOCS_REQUEST_CHANNELS.map((c) => {
            const o = x[c];
            if (!o) return null;
            const ok = o.status === "sent";
            const Icon = CHANNEL_ICON[c];
            return (
              <span key={c} className={`inline-flex items-center gap-1 text-xs ${ok ? "text-emerald-700 dark:text-emerald-300" : o.status === "failed" ? "text-red-700 dark:text-red-300" : "text-muted-foreground"}`} title={o.detail ?? undefined}>
                <Icon className="h-3 w-3" />
                {ok ? <CheckCircle2 className="h-3 w-3" /> : o.status === "failed" ? <XCircle className="h-3 w-3" /> : null}
                {o.label}{o.detail && !ok ? ` — ${o.detail}` : ""}
              </span>
            );
          })}
        </li>
      ))}
    </ul>
  );
}

function resultToast(r: { sent: Record<DocsRequestChannel, number>; failed: Record<DocsRequestChannel, number>; errors: string[]; remaining: number; people: unknown[] }) {
  const parts = DOCS_REQUEST_CHANNELS.map((c) => `${DOCS_REQUEST_CHANNEL_LABELS[c]}: ${r.sent[c]} enviado(s)${r.failed[c] ? `, ${r.failed[c]} falhado(s)` : ""}`);
  if (r.remaining) toast.warning(`${parts.join(" · ")} — faltam ${r.remaining}: carrega outra vez em Enviar para continuar.`);
  else if (!r.people.length) toast.info("Ninguém por pedir: vê na janela quem ficou de fora e porquê.");
  else if (DOCS_REQUEST_CHANNELS.some((c) => r.failed[c] > 0) || r.errors.length) toast.warning(`${parts.join(" · ")} — vê o motivo por pessoa.`);
  else toast.success(parts.join(" · "));
}

// ─── Na ficha ───────────────────────────────────────────────────────────────

export function DocsRequestDialog({ open, onOpenChange, employeeId, name }: { open: boolean; onOpenChange: (o: boolean) => void; employeeId: number; name: string }) {
  const utils = trpc.useUtils();
  const { channels, toggle } = useChannels(open);
  const [force, setForce] = useState(false);
  const [requestKey, setRequestKey] = useState(newRequestKey);
  useEffect(() => { if (open) { setForce(false); setRequestKey(newRequestKey()); } }, [open]);
  const preview = trpc.rh.docsRequest.preview.useQuery({ employeeId, channels, force }, { enabled: open && channels.length > 0, staleTime: 0 });
  const send = trpc.rh.docsRequest.send.useMutation({
    onSuccess: (r) => {
      utils.rh.docsRequest.history.invalidate({ employeeId });
      utils.rh.docsRequest.preview.invalidate();
      resultToast(r);
    },
    onError: (e) => toast.error(e.message),
  });
  const close = () => { if (send.isPending) return; send.reset(); onOpenChange(false); };
  const p = preview.data?.person ?? null;
  const result = send.data;
  const willSend = !!p && docsPlanWillSend(p);
  const cooldown = p?.skip?.kind === "cooldown";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><FileWarning className="h-5 w-5 text-primary" /> Pedir documentos em falta</DialogTitle>
          <DialogDescription>
            Pede a {name} os documentos obrigatórios em falta ou recusados. Vês o texto exato antes de enviar.
          </DialogDescription>
        </DialogHeader>

        {!result && (
          <div className="space-y-4">
            <ChannelPicker channels={channels} toggle={toggle} configured={preview.data?.configured} disabled={send.isPending} />
            {channels.length === 0 && <p className="text-sm text-muted-foreground">Escolhe pelo menos um canal.</p>}
            {preview.isLoading && channels.length > 0 && <div className="text-sm text-muted-foreground">A preparar a pré-visualização…</div>}
            {preview.error && <QueryErrorNote error={preview.error} onRetry={() => preview.refetch()} retrying={preview.isFetching} what="a pré-visualização" />}
            {p && (
              <>
                {p.skip && (
                  <div className="rounded-md border border-amber-300 bg-amber-50/60 p-2 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                    Não segue: {p.skip.reason}.
                  </div>
                )}
                {(cooldown || force) && (
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox checked={force} onCheckedChange={(v) => setForce(v === true)} disabled={send.isPending} />
                    Enviar mesmo assim (passa por cima dos 7 dias)
                  </label>
                )}
                {!p.skip && <PersonPreview p={p} channels={channels} />}
                {!p.skip && !willSend && (
                  <div className="text-xs text-muted-foreground">Não há canal por onde enviar: {docsPlanIgnoredReasons(p).join(" · ")}.</div>
                )}
              </>
            )}
          </div>
        )}

        {result && (
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Resultado</div>
            <ResultList people={result.people as ResultPerson[]} />
            {result.ignored.map((x) => <div key={x.employeeId} className="text-xs text-muted-foreground">{x.name}: {x.reasons.join(" · ")}</div>)}
            {result.errors.map((w, i) => <div key={i} className="text-xs text-red-700 dark:text-red-300">{w}</div>)}
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={close}>Fechar</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={close} disabled={send.isPending}>Cancelar</Button>
              <Button disabled={!willSend || send.isPending || preview.isFetching} onClick={() => send.mutate({ employeeId, channels, force, requestKey })}>
                <Send className="h-4 w-4 mr-1" />
                {send.isPending ? "A enviar…" : willSend ? "Enviar pedido" : "Nada por enviar"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Cartão na ficha (separador Documentos): último pedido + botão. Só para quem valida documentos de um extra. */
export function DocsRequestCard({ employeeId, name, missingCount }: { employeeId: number; name: string; missingCount: number }) {
  const [open, setOpen] = useState(false);
  const history = trpc.rh.docsRequest.history.useQuery({ employeeId }, { staleTime: 30_000 });
  const label = history.data?.label ?? null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
      <div className="min-w-0 text-sm">
        <div className="font-medium">{missingCount > 0 ? `${missingCount} documento${missingCount > 1 ? "s" : ""} obrigatório${missingCount > 1 ? "s" : ""} em falta` : "Documentos obrigatórios entregues"}</div>
        <div className="text-xs text-muted-foreground">{label ?? "Ainda sem pedidos de documentos."}</div>
      </div>
      <Button size="sm" variant="outline" disabled={missingCount === 0} onClick={() => setOpen(true)}>
        <FileWarning className="h-4 w-4 mr-1" /> Pedir documentos em falta
      </Button>
      {open && <DocsRequestDialog open={open} onOpenChange={setOpen} employeeId={employeeId} name={name} />}
    </div>
  );
}

// ─── Em grupo (lista do RH) ─────────────────────────────────────────────────

export function DocsRequestBulkDialog({ open, onOpenChange, projectId }: { open: boolean; onOpenChange: (o: boolean) => void; projectId?: number | null }) {
  const utils = trpc.useUtils();
  const { channels, toggle } = useChannels(open);
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const [expanded, setExpanded] = useState<number | null>(null);
  useEffect(() => { if (open) { setRequestKey(newRequestKey()); setExpanded(null); } }, [open]);
  const preview = trpc.rh.docsRequest.bulkPreview.useQuery({ channels, projectId: projectId ?? null }, { enabled: open && channels.length > 0, staleTime: 0 });
  const send = trpc.rh.docsRequest.bulkSend.useMutation({
    onSuccess: (r) => {
      utils.rh.docsRequest.invalidate();
      resultToast(r);
    },
    onError: (e) => toast.error(e.message),
  });
  const close = () => { if (send.isPending) return; send.reset(); onOpenChange(false); };
  const plan = preview.data;
  const recipients = useMemo(() => (plan?.people ?? []).filter(docsPlanWillSend), [plan]);
  const ignored = useMemo(() => (plan?.people ?? []).filter((p) => !docsPlanWillSend(p)), [plan]);
  const result = send.data;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><FileWarning className="h-5 w-5 text-primary" /> Pedir documentos em falta aos extras</DialogTitle>
          <DialogDescription>
            Os extras ativos com documentos obrigatórios em falta ou recusados, nas tuas cidades. Quem já recebeu um pedido nos últimos 7 dias não recebe outro.
          </DialogDescription>
        </DialogHeader>

        {!result && (
          <div className="space-y-4">
            <ChannelPicker channels={channels} toggle={toggle} configured={plan?.configured} disabled={send.isPending} />
            {channels.length === 0 && <p className="text-sm text-muted-foreground">Escolhe pelo menos um canal.</p>}
            {preview.isLoading && channels.length > 0 && <div className="text-sm text-muted-foreground">A preparar a pré-visualização…</div>}
            {preview.error && <QueryErrorNote error={preview.error} onRetry={() => preview.refetch()} retrying={preview.isFetching} what="a pré-visualização" />}
            {plan && plan.people.length === 0 && <p className="text-sm text-muted-foreground">Nenhum extra com documentos em falta nas tuas cidades.</p>}
            {plan && plan.people.length > 0 && (
              <>
                <div className="space-y-2">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Quem recebe ({recipients.length} de {plan.people.length}) · WhatsApp {plan.toSend.whatsapp} · Email {plan.toSend.email}
                  </div>
                  <ul className="space-y-1.5">
                    {recipients.map((p) => (
                      <li key={p.employeeId} className="rounded-md border p-2 text-sm">
                        <button type="button" className="flex w-full flex-wrap items-center gap-1.5 text-left" onClick={() => setExpanded(expanded === p.employeeId ? null : p.employeeId)} aria-expanded={expanded === p.employeeId}>
                          {expanded === p.employeeId ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                          <span className="font-medium">{p.name}</span>
                          {DOCS_REQUEST_CHANNELS.filter((c) => channels.includes(c)).map((c) => <PlanChip key={c} channel={c} plan={p.channels[c]} />)}
                          <span className="w-full pl-5 text-xs text-muted-foreground break-words">{p.docs.map((d) => requestedDocLabel(d, 60)).join(", ")}</span>
                        </button>
                        {expanded === p.employeeId && <div className="mt-2 pl-5"><PersonPreview p={p} channels={channels} /></div>}
                      </li>
                    ))}
                  </ul>
                </div>
                {ignored.length > 0 && (
                  <div className="space-y-1 rounded-md border bg-muted/40 p-2">
                    <div className="text-xs font-medium text-muted-foreground">Ficam de fora ({ignored.length})</div>
                    <ul className="space-y-0.5">
                      {ignored.map((p) => (
                        <li key={p.employeeId} className="text-xs"><span className="font-medium">{p.name}</span>: <span className="text-muted-foreground">{docsPlanIgnoredReasons(p).join(" · ")}</span></li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {result && (
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Resultado por pessoa</div>
            <ResultList people={result.people as ResultPerson[]} />
            {result.remaining > 0 && <div className="text-sm text-amber-800 dark:text-amber-300">Faltam {result.remaining}: abre outra vez e carrega em Enviar para continuar (quem já recebeu não recebe outra vez).</div>}
            {result.outOfScope > 0 && <div className="text-xs text-muted-foreground">{result.outOfScope} já não estavam nas tuas cidades (ou deixaram de ser extras ativos) — não receberam.</div>}
            {result.errors.map((w, i) => <div key={i} className="text-xs text-red-700 dark:text-red-300">{w}</div>)}
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={close}>Fechar</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={close} disabled={send.isPending}>Cancelar</Button>
              <Button
                disabled={!plan || recipients.length === 0 || send.isPending || preview.isFetching}
                onClick={() => send.mutate({ channels, projectId: projectId ?? null, employeeIds: recipients.map((p) => p.employeeId), requestKey })}
              >
                <Send className="h-4 w-4 mr-1" />
                {send.isPending ? "A enviar…" : recipients.length === 0 ? "Nada por enviar" : `Enviar (${recipients.length} pessoa${recipients.length === 1 ? "" : "s"})`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
