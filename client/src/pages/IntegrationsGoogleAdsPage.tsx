import { useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { Plug, PlugZap, RefreshCw, Loader2, AlertTriangle, CheckCircle2, Unplug, PlayCircle, Link2 } from "lucide-react";

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  connected: { label: "Ligado", cls: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  disconnected: { label: "Desligado", cls: "bg-muted text-muted-foreground" },
  reauth_required: { label: "Reautorização necessária", cls: "bg-amber-100 text-amber-800 border-amber-200" },
  error: { label: "Erro", cls: "bg-red-100 text-red-800 border-red-200" },
};
const KIND_LABEL: Record<string, string> = { initial: "Inicial (37 meses)", daily: "Diária (última semana)", monthly: "Mensal (mês anterior)", manual: "Manual (tudo)", hourly: "Horária (antiga)", nightly: "Noturna (antiga)" };
const RUN_STATUS: Record<string, string> = { running: "a correr", partial: "parcial (contas falhadas, ou a continuar)", done: "concluída", failed: "falhou", skipped: "saltada" };

export default function IntegrationsGoogleAdsPage() {
  const utils = trpc.useUtils();
  const status = trpc.integrations.googleAds.status.useQuery(undefined, { refetchInterval: 30_000 });
  const accounts = trpc.integrations.googleAds.accounts.list.useQuery();
  const runs = trpc.integrations.googleAds.sync.runs.useQuery({ limit: 15 }, { refetchInterval: 30_000 });
  const { data: projects = [] } = trpc.projects.list.useQuery();
  const invalidate = () => { utils.integrations.googleAds.invalidate(); };

  const refreshAccounts = trpc.integrations.googleAds.accounts.refresh.useMutation({
    onSuccess: (r) => { invalidate(); r.error ? toast.error("Listagem parcial", { description: r.error }) : toast.success(`${r.found} conta(s) encontrada(s)`); },
    onError: (e) => toast.error("Não foi possível listar as contas", { description: e.message }),
  });
  const updateAccount = trpc.integrations.googleAds.accounts.update.useMutation({ onSuccess: invalidate, onError: (e) => toast.error(e.message) });
  const runSync = trpc.integrations.googleAds.sync.run.useMutation({
    onSuccess: (r) => {
      invalidate();
      if (r.status === "skipped") toast.warning("Recolha não correu", { description: r.reason });
      else if (!r.done) toast.info(`Recolha parcial: ${r.accountsDone}/${r.accountsTotal} contas, ${r.rowsWritten} linhas. Carrega outra vez para continuar.`);
      else if (r.status === "failed") toast.error("Recolha falhou", { description: r.reason });
      else toast.success(`Recolha concluída: ${r.rowsWritten} linhas${r.warnings.length ? ` · ${r.warnings.length} aviso(s)` : ""}`);
    },
    onError: (e) => toast.error("Erro na recolha", { description: e.message }),
  });
  const disconnect = trpc.integrations.googleAds.disconnect.useMutation({ onSuccess: () => { invalidate(); toast.success("Google Ads desligado"); } });
  const backfill = trpc.integrations.googleAds.backfillAttribution.useMutation({
    onSuccess: (r) => toast.success(`Atribuição: ${r.scanned} reservas analisadas, ${r.attributed} atribuídas ao Google Ads, ${r.remaining} por analisar`),
    onError: (e) => toast.error(e.message),
  });

  // mensagem do retorno OAuth (?connected=1&accounts=N | accountsError=…)
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("connected") === "1") {
      if (p.get("accountsError")) toast.warning("Ligado à Google, mas a listagem de contas falhou", { description: p.get("accountsError") ?? "", duration: 10000 });
      else toast.success(`Google Ads ligado${p.get("accounts") ? ` · ${p.get("accounts")} conta(s) encontrada(s)` : ""}`);
      window.history.replaceState({}, "", window.location.pathname);
      invalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const s = status.data;
  const st = STATUS_LABEL[s?.status ?? "disconnected"] ?? STATUS_LABEL.disconnected;
  const projectOptions = useMemo(() => (projects as any[]).filter((p) => p.level === "city" || p.level === "brand" || p.level === "group"), [projects]);
  const missingOAuth = s?.config.missingOAuth ?? [];
  const missingApi = s?.config.missingApi ?? [];
  const canConnect = missingOAuth.length === 0;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2"><Plug className="h-5 w-5" /> Integrações · Google Ads</h1>
          <p className="text-sm text-muted-foreground max-w-2xl">Ligação de leitura à Google Ads API. Depois de ligada, o servidor recolhe custo, impressões, cliques e conversões por campanha uma vez por dia (última semana) e no dia 2 de cada mês (mês anterior fechado), sem CSV, emails ou browser aberto. Nada aqui altera campanhas ou orçamentos.</p>
        </div>
        <Badge variant="outline" className={`text-sm px-3 py-1 ${st.cls}`}>{status.isLoading ? "…" : st.label}</Badge>
      </div>

      {/* 1. Estado e ligação */}
      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><PlugZap className="h-4 w-4" /> Ligação</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {missingOAuth.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 text-amber-900 text-sm px-3 py-2 flex gap-2" role="alert">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">Falta configurar o servidor antes de ligar.</p>
                <p>Variáveis em falta: <code className="bg-white/60 px-1 rounded">{missingOAuth.join(", ")}</code>. Configura o cliente OAuth no servidor com o endereço de retorno abaixo. O projeto Google Cloud precisa de acesso Exploração ou superior para consultar contas reais.</p>
              </div>
            </div>
          )}
          {missingOAuth.length === 0 && missingApi.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 text-amber-900 text-sm px-3 py-2 flex gap-2" role="alert">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <p>Podes ligar, mas a recolha só funciona com <code className="bg-white/60 px-1 rounded">{missingApi.join(", ")}</code> definido no servidor.</p>
            </div>
          )}
          {s?.status === "reauth_required" && (
            <div className="rounded-md border border-red-300 bg-red-50 text-red-900 text-sm px-3 py-2" role="alert">
              A Google deixou de aceitar a autorização ({s.lastError}). Volta a carregar em “Ligar Google Ads”. Se a aplicação OAuth estiver em modo Testing, o token expira ao fim de 7 dias: passa-a a “In production” na Google Cloud Console.
            </div>
          )}
          {s?.status === "error" && s.lastError && (
            <div className="rounded-md border border-red-300 bg-red-50 text-red-900 text-sm px-3 py-2" role="alert">{s.lastError}</div>
          )}
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Endereço de retorno (registar no cliente OAuth)</dt>
            <dd className="font-mono text-xs break-all">{typeof window !== "undefined" ? `${window.location.origin}/api/integrations/google-ads/oauth/callback` : s?.config.redirectUri}</dd>
            <dt className="text-muted-foreground">Conta gestora (login-customer-id)</dt>
            <dd className="font-mono text-xs">{s?.loginCustomerId ?? s?.config.loginCustomerId ?? "— (acesso direto)"}</dd>
            <dt className="text-muted-foreground">Ligado em</dt>
            <dd>{s?.connectedAt ? fmtPTDateTime(s.connectedAt) : "—"}</dd>
            <dt className="text-muted-foreground">Última recolha concluída</dt>
            <dd>{s?.lastSuccessfulSyncAt ? fmtPTDateTime(s.lastSuccessfulSyncAt) : "nunca"}{s?.stale && s?.status === "connected" ? <span className="ml-2 text-amber-700 text-xs">atrasada (&gt; 2 ciclos)</span> : null}</dd>
            <dt className="text-muted-foreground">Cifra do token</dt>
            <dd className="text-xs">{s?.encryptionKeySource === "env" ? "chave dedicada (INTEGRATIONS_ENCRYPTION_KEY)" : s?.encryptionKeySource === "derived" ? "derivada do JWT_SECRET (define INTEGRATIONS_ENCRYPTION_KEY para produção)" : s?.encryptionKeySource ?? "—"}</dd>
            <dt className="text-muted-foreground">Versão da API</dt>
            <dd className="font-mono text-xs">{s?.config.apiVersion}</dd>
          </dl>
          <div className="flex flex-wrap gap-2">
            <Button asChild disabled={!canConnect} className="gap-2">
              <a href="/api/integrations/google-ads/oauth/start" aria-disabled={!canConnect} onClick={(e) => { if (!canConnect) e.preventDefault(); }}>
                <Link2 className="h-4 w-4" /> {s?.status === "connected" ? "Voltar a autorizar" : "Ligar Google Ads"}
              </a>
            </Button>
            {s?.status !== "disconnected" && (
              <Button variant="outline" className="gap-2" onClick={() => { if (confirm("Desligar o Google Ads? Os dados já recolhidos ficam.")) disconnect.mutate(); }}>
                <Unplug className="h-4 w-4" /> Desligar
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 2. Contas */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">Contas publicitárias</CardTitle>
          <Button variant="outline" size="sm" className="gap-1.5" disabled={s?.status !== "connected" || refreshAccounts.isPending} onClick={() => refreshAccounts.mutate()}>
            {refreshAccounts.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Atualizar lista
          </Button>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-3">Seleciona as contas que a dashboard deve consultar e associa cada uma a uma marca ou cidade. Campanhas sem associação entram no total geral e ficam assinaladas no Marketing.</p>
          {(accounts.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">{s?.status === "connected" ? "Sem contas listadas. Carrega em “Atualizar lista” e confirma o acesso do projeto Google Cloud à API." : "Liga o Google Ads para listar as contas."}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="p-2">Consultar</th><th className="p-2">Conta</th><th className="p-2">ID</th><th className="p-2">Moeda · Fuso</th><th className="p-2">Marca / cidade</th><th className="p-2">Última recolha</th></tr></thead>
                <tbody>
                  {(accounts.data ?? []).map((a) => (
                    <tr key={a.id} className={`border-b ${a.isManager ? "opacity-70" : ""}`}>
                      <td className="p-2">{a.isManager ? <span className="text-xs text-muted-foreground">gestora</span> : <Switch checked={!!a.selected} onCheckedChange={(v) => updateAccount.mutate({ id: a.id, selected: v })} aria-label={`Consultar ${a.name ?? a.customerId}`} />}</td>
                      <td className="p-2 font-medium">{a.name ?? "—"}{a.lastError && <div className="text-[11px] text-red-700">{a.lastError}</div>}</td>
                      <td className="p-2 font-mono text-xs">{a.customerId}</td>
                      <td className="p-2 text-xs">{a.currency ?? "—"} · {a.timezone ?? "—"}</td>
                      <td className="p-2">
                        {a.isManager ? "—" : (
                          <Select value={a.projectId ? String(a.projectId) : "none"} onValueChange={(v) => updateAccount.mutate({ id: a.id, projectId: v === "none" ? null : Number(v) })}>
                            <SelectTrigger className="h-8 w-52"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">Sem associação</SelectItem>
                              {projectOptions.map((p: any) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        )}
                      </td>
                      <td className="p-2 text-xs">{a.lastSyncAt ? fmtPTDateTime(a.lastSyncAt) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 3. Recolha */}
      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><PlayCircle className="h-4 w-4" /> Recolha</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">Automática pelo cron: diária às 05:45 (última semana, hoje e os 2 dias anteriores provisórios) e mensal no dia 2 (o mês anterior inteiro, os números finais da fatura). A dashboard não volta a pedir o resto. Aqui só se dispara à mão.</p>
          <div className="flex flex-wrap gap-2">
            {(["daily", "monthly", "initial"] as const).map((k) => (
              <Button key={k} variant="outline" size="sm" disabled={s?.status !== "connected" || runSync.isPending} onClick={() => runSync.mutate({ kind: k })} className="gap-1.5">
                {runSync.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5" />} {KIND_LABEL[k]}
              </Button>
            ))}
            <Button variant="ghost" size="sm" disabled={backfill.isPending} onClick={() => backfill.mutate({ limit: 2000 })} className="gap-1.5" title="Lê o originUrl das reservas já sincronizadas e marca as que vieram de anúncios Google (gclid/utm)">
              {backfill.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />} Atribuir reservas (originUrl)
            </Button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="p-2">Início</th><th className="p-2">Tipo</th><th className="p-2">Intervalo</th><th className="p-2">Contas</th><th className="p-2 text-right">Linhas</th><th className="p-2">Estado</th><th className="p-2">Avisos / erro</th></tr></thead>
              <tbody>
                {(runs.data ?? []).length === 0 && <tr><td className="p-3 text-center text-muted-foreground" colSpan={7}>Ainda não houve recolhas.</td></tr>}
                {(runs.data ?? []).map((r) => (
                  <tr key={r.id} className="border-b align-top">
                    <td className="p-2 text-xs whitespace-nowrap">{fmtPTDateTime(r.startedAt)}</td>
                    <td className="p-2 text-xs">{KIND_LABEL[r.kind] ?? r.kind}</td>
                    <td className="p-2 text-xs whitespace-nowrap">{r.rangeFrom} → {r.rangeTo}</td>
                    <td className="p-2 text-xs">{r.accountsDone}/{r.accountsTotal}</td>
                    <td className="p-2 text-xs text-right tabular-nums">{r.rowsWritten}</td>
                    <td className="p-2 text-xs">{RUN_STATUS[r.status] ?? r.status}</td>
                    <td className="p-2 text-xs max-w-md">{r.error ? <span className="text-red-700">{r.error}</span> : r.warnings ? <span className="text-amber-700 whitespace-pre-wrap">{String(r.warnings).split("\n").slice(0, 3).join("\n")}</span> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <MetaAdsCard projectOptions={projectOptions} />
    </div>
  );
}

/**
 * Meta Ads (Facebook/Instagram) — dormente até META_ACCESS_TOKEN e
 * META_AD_ACCOUNT_IDS estarem no servidor. Mostra se está configurada, as
 * contas (marca/cidade da conta), a última recolha e os erros. A marca/cidade
 * de cada CAMPANHA escolhe-se no Marketing → Anúncios, como no Google.
 */
function MetaAdsCard({ projectOptions }: { projectOptions: any[] }) {
  const utils = trpc.useUtils();
  const status = trpc.integrations.meta.status.useQuery(undefined, { refetchInterval: 60_000 });
  const runs = trpc.integrations.meta.sync.runs.useQuery({ limit: 5 });
  const invalidate = () => { utils.integrations.meta.invalidate(); };
  const update = trpc.integrations.meta.accounts.update.useMutation({ onSuccess: invalidate, onError: (e) => toast.error(e.message) });
  const run = trpc.integrations.meta.sync.run.useMutation({
    onSuccess: (r) => {
      invalidate();
      if (r.status === "skipped") toast.warning("Recolha Meta não correu", { description: r.reason });
      else if (!r.done) toast.info(`Recolha Meta parcial: ${r.rowsWritten} linhas. Carrega outra vez para continuar.`);
      else if (!r.ok) toast.error("Recolha Meta com falhas", { description: r.reason });
      else toast.success(`Recolha Meta concluída: ${r.rowsWritten} linhas`);
    },
    onError: (e) => toast.error(e.message),
  });
  const s = status.data;
  const connStatus = s?.connection?.status ?? null;
  return (
    <Card id="meta">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          <Plug className="h-4 w-4" /> Meta Ads (Facebook / Instagram)
          <Badge variant="outline" className={`ml-auto text-xs ${!s ? "" : !s.configured ? "bg-muted text-muted-foreground" : connStatus === "reauth_required" || connStatus === "error" ? "bg-red-100 text-red-800 border-red-200" : "bg-emerald-100 text-emerald-800 border-emerald-200"}`}>
            {!s ? "…" : !s.configured ? "Não configurada" : connStatus === "reauth_required" ? "Token inválido" : connStatus === "error" ? "Erro" : "Configurada"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {s && !s.configured && (
          <div className="rounded-md border bg-muted/40 p-3 text-xs space-y-1">
            <p>Integração dormente. Para ligar, definir no servidor (Vercel → Environment Variables):</p>
            <ul className="list-disc pl-5">
              <li><code>META_ACCESS_TOKEN</code> — token de longa duração de um utilizador de sistema (Business Manager) com <code>ads_read</code>;</li>
              <li><code>META_AD_ACCOUNT_IDS</code> — IDs das contas de anúncios, separados por vírgula (ex.: <code>act_123,act_456</code>);</li>
              <li><code>META_API_VERSION</code> — opcional (por omissão {s.apiVersion}).</li>
            </ul>
            <p>Em falta: {s.missing.join(", ")}.</p>
          </div>
        )}
        {s?.configured && (
          <>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
              <span>API {s.apiVersion}</span>
              <span>Última recolha com sucesso: {s.lastSuccessfulSyncAt ? fmtPTDateTime(s.lastSuccessfulSyncAt) : "nunca"}{s.stale ? " (parada há mais de 26 h)" : ""}</span>
              {s.connection?.lastError && <span className="text-red-700 flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" /> {s.connection.lastError}</span>}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="p-2">Conta</th><th className="p-2">ID</th><th className="p-2">Recolher</th><th className="p-2">Marca / cidade da conta</th><th className="p-2">Última recolha</th><th className="p-2">Erro</th></tr></thead>
                <tbody>
                  {(s.accounts ?? []).length === 0 && <tr><td colSpan={6} className="p-3 text-center text-muted-foreground text-xs">As contas aparecem depois da primeira recolha.</td></tr>}
                  {(s.accounts ?? []).map((a: any) => (
                    <tr key={a.id} className="border-b align-top">
                      <td className="p-2">{a.name ?? `Meta ${a.customerId}`}{!s.configuredAccountIds.includes(a.customerId) && <Badge variant="outline" className="ml-1.5 text-[10px]">fora de META_AD_ACCOUNT_IDS</Badge>}</td>
                      <td className="p-2 text-xs text-muted-foreground">act_{a.customerId}</td>
                      <td className="p-2"><Switch checked={!!a.selected} onCheckedChange={(v) => update.mutate({ id: a.id, selected: v })} aria-label={`Recolher a conta ${a.name ?? a.customerId}`} /></td>
                      <td className="p-2">
                        <Select value={a.projectId != null ? String(a.projectId) : "none"} onValueChange={(v) => update.mutate({ id: a.id, projectId: v === "none" ? null : Number(v) })}>
                          <SelectTrigger className="h-8 w-56 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">— sem marca —</SelectItem>
                            {projectOptions.map((p: any) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="p-2 text-xs">{a.lastSyncAt ? fmtPTDateTime(a.lastSyncAt) : "—"}</td>
                      <td className="p-2 text-xs text-red-700 max-w-xs">{a.lastError ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap gap-2">
              {(["daily", "monthly", "initial"] as const).map((k) => (
                <Button key={k} variant="outline" size="sm" disabled={run.isPending} onClick={() => run.mutate({ kind: k })} className="gap-1.5">
                  {run.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5" />} {KIND_LABEL[k]}
                </Button>
              ))}
            </div>
            <ul className="text-xs space-y-0.5">
              {(runs.data ?? []).map((r: any) => (
                <li key={r.id}>{fmtPTDateTime(r.startedAt)} · {KIND_LABEL[r.kind] ?? r.kind} · {r.rangeFrom} → {r.rangeTo} · {r.accountsDone}/{r.accountsTotal} contas · {r.rowsWritten} linhas · <b>{RUN_STATUS[r.status] ?? r.status}</b>{r.error ? <span className="text-red-700"> — {r.error}</span> : null}</li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
