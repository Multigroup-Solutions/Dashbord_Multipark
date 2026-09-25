// Hub das Integrações (/integracoes): um cartão por fornecedor com
// configurada sim/não (nunca segredos), estado da ligação, última recolha,
// último erro, avisos, "Testar" e ligações para as páginas de gestão.
// Módulo "integracoes": ver = view; testar = edit.
import { GoogleAccountCard } from "@/components/GoogleAccountCard";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { can } from "@shared/access";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { AlertTriangle, CheckCircle2, ExternalLink, KeyRound, Loader2, Plug, XCircle } from "lucide-react";

const CONN: Record<string, { label: string; cls: string }> = {
  connected: { label: "Ligado", cls: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  disconnected: { label: "Desligado", cls: "bg-muted text-secondary-foreground" },
  reauth_required: { label: "Reautorização necessária", cls: "bg-red-100 text-red-800 border-red-200" },
  error: { label: "Erro", cls: "bg-red-100 text-red-800 border-red-200" },
};

type TestResult = { ok: boolean; message: string; ms: number };

export default function IntegrationsHubPage() {
  const { user } = useAuth();
  const canView = can(user?.role, "integracoes", "view");
  const canTest = can(user?.role, "integracoes", "edit");
  const q = trpc.integrations.hub.list.useQuery(undefined, { enabled: canView, refetchInterval: 60_000 });
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const test = trpc.integrations.hub.test.useMutation({
    onSuccess: (r, v) => { setResults((p) => ({ ...p, [v.id]: r })); r.ok ? toast.success(r.message) : toast.error(r.message); q.refetch(); },
    onError: (e) => toast.error(e.message),
    onSettled: () => setTesting(null),
  });

  if (!user) return null;
  if (!canView) return <div className="p-6 text-sm text-muted-foreground">Sem acesso às Integrações.</div>;

  const items = q.data?.items ?? [];
  const main = items.filter((i) => i.group === "main");
  const system = items.filter((i) => i.group === "system");
  const key = q.data?.encryptionKey;
  const problems = main.filter((i) => i.configured && (i.connection?.status === "reauth_required" || i.connection?.status === "error" || !!i.lastError)).length;

  return (
    <div className="space-y-4 max-w-6xl mx-auto">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold flex items-center gap-2"><Plug className="h-5 w-5" /> Integrações</h1>
          <p className="text-sm text-muted-foreground max-w-3xl">
            Estado de cada ligação externa. Só se mostra se está configurada — os valores dos segredos nunca saem do servidor. "Testar" não envia nem altera nada.
            Quando uma ligação precisa de ser religada ou um cron para, os administradores recebem um aviso (uma vez por mudança).
          </p>
        </div>
        {!q.isLoading && (problems > 0
          ? <Badge variant="outline" className="bg-red-100 text-red-800 border-red-200">{problems} com problemas</Badge>
          : <Badge variant="outline" className="bg-emerald-100 text-emerald-800 border-emerald-200">Sem problemas conhecidos</Badge>)}
      </div>
      <div className="max-w-xl"><GoogleAccountCard compact returnTo="/integracoes" /></div>

      {key?.warning && (
        <div className={`rounded-md border px-3 py-2 text-sm flex gap-2 ${key.source === "derived" ? "border-amber-300 bg-amber-50 text-amber-900" : "border-red-300 bg-red-50 text-red-900"}`} role="alert">
          <KeyRound className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{key.warning}</span>
        </div>
      )}
      {key && !key.warning && (
        <p className="text-xs text-muted-foreground flex items-center gap-1"><KeyRound className="h-3 w-3" /> Tokens guardados cifrados com chave dedicada (INTEGRATIONS_ENCRYPTION_KEY).</p>
      )}

      {q.isLoading && <Loader2 className="h-5 w-5 animate-spin" />}
      {q.error && <p className="text-sm text-destructive">{q.error.message}</p>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {main.map((i) => (
          <IntegrationCard key={i.id} item={i} result={results[i.id]} canTest={canTest} testing={testing}
            onTest={() => { setTesting(i.id); test.mutate({ id: i.id }); }} />
        ))}
      </div>

      {system.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Sistema</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {system.map((i) => (
              <div key={i.id} className="flex flex-wrap items-center gap-2 text-sm border-b last:border-0 pb-2">
                <span className="font-medium flex-1 min-w-[10rem]">{i.label}</span>
                <span className="text-xs text-muted-foreground flex-[2] min-w-[12rem]">{i.description}</span>
                <ConfiguredBadge configured={i.configured} />
                {i.testable && canTest && (
                  <Button size="sm" variant="outline" disabled={!i.configured || testing != null} onClick={() => { setTesting(i.id); test.mutate({ id: i.id }); }}>
                    {testing === i.id ? <Loader2 className="h-4 w-4 animate-spin" /> : "Testar"}
                  </Button>
                )}
                {!i.configured && i.missing.length > 0 && <div className="w-full text-[11px] text-muted-foreground font-mono break-all">Falta: {i.missing.join(", ")}</div>}
                {results[i.id] && <TestLine r={results[i.id]} />}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ConfiguredBadge({ configured }: { configured: boolean }) {
  return (
    <Badge variant="outline" className={configured ? "bg-emerald-100 text-emerald-800 border-emerald-200" : "bg-muted text-secondary-foreground"}>
      {configured ? "Configurada" : "Não configurada"}
    </Badge>
  );
}

function TestLine({ r }: { r: TestResult }) {
  return (
    <div className={`w-full text-xs ${r.ok ? "text-emerald-700" : "text-red-700"}`}>
      {r.ok ? <CheckCircle2 className="inline h-3 w-3 mr-1" /> : <XCircle className="inline h-3 w-3 mr-1" />}
      <span className="whitespace-pre-line">{r.message}</span> <span className="text-muted-foreground">({r.ms} ms)</span>
    </div>
  );
}

type HubItem = {
  id: string; label: string; description: string; configured: boolean; missing: string[]; testable: boolean;
  links: Array<{ label: string; href: string }>;
  connection?: { status: string; lastCheckedAt: string | null; hasError: boolean } | null;
  lastSyncAt?: string | null; lastError?: string | null; warnings?: string[];
};

function IntegrationCard({ item: i, result, canTest, testing, onTest }: { item: HubItem; result?: TestResult; canTest: boolean; testing: string | null; onTest: () => void }) {
  const conn = i.connection ? CONN[i.connection.status] ?? { label: i.connection.status, cls: "bg-muted" } : null;
  const bad = i.configured && (i.connection?.status === "reauth_required" || i.connection?.status === "error");
  return (
    <Card className={bad ? "border-red-300" : undefined}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          {i.label}
          <ConfiguredBadge configured={i.configured} />
          {conn && <Badge variant="outline" className={conn.cls}>{conn.label}</Badge>}
        </CardTitle>
        <p className="text-xs text-muted-foreground">{i.description}</p>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {!i.configured && i.missing.length > 0 && (
          <div className="text-[11px] text-muted-foreground font-mono break-all">Falta: {i.missing.join(", ")}</div>
        )}
        <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Última recolha OK</dt>
          <dd>{i.lastSyncAt ? fmtPTDateTime(i.lastSyncAt) : "—"}</dd>
          {i.connection?.lastCheckedAt && (<>
            <dt className="text-muted-foreground">Última verificação</dt>
            <dd>{fmtPTDateTime(i.connection.lastCheckedAt)}</dd>
          </>)}
        </dl>
        {i.lastError && (
          <p className="text-xs text-red-700 dark:text-red-300 break-words"><XCircle className="inline h-3 w-3 mr-1" />{i.lastError}</p>
        )}
        {(i.warnings ?? []).map((w, k) => (
          <p key={k} className="text-xs text-amber-800 dark:text-amber-300 break-words"><AlertTriangle className="inline h-3 w-3 mr-1" />{w}</p>
        ))}
        {result && <TestLine r={result} />}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {i.testable && canTest && (
            <Button size="sm" variant="outline" disabled={!i.configured || testing != null} onClick={onTest}>
              {testing === i.id ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plug className="h-4 w-4 mr-1" />}
              Testar
            </Button>
          )}
          {i.links.map((l) => (
            <a key={l.href} href={l.href} className="text-xs underline inline-flex items-center gap-1 text-primary">
              {l.label} <ExternalLink className="h-3 w-3" />
            </a>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
