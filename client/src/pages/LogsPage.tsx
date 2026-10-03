import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import {
  ScrollText, Loader2, AlertCircle, User, Receipt, Trash2, Edit, Plus, Download, Archive, Ban, Bot, X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { can } from "@shared/access";
import { LOG_SOURCES, LOG_SOURCE_LABELS, type LogSource } from "@shared/logMask";
import { csvLine, groupLogEntities, logActionLabel } from "@shared/logsView";

const ACTION_STYLE: Record<string, { icon: any; color: string }> = {
  create: { icon: Plus, color: "text-green-600" },
  update: { icon: Edit, color: "text-blue-600" },
  delete: { icon: Trash2, color: "text-red-600" },
  archive: { icon: Archive, color: "text-amber-700" },
  revoke: { icon: Ban, color: "text-red-600" },
  update_role: { icon: User, color: "text-purple-600" },
  set_module_access: { icon: User, color: "text-purple-600" },
  set_permission: { icon: User, color: "text-purple-600" },
};

const ALL = "all";
const SYSTEM = "system";

export default function LogsPage() {
  const { user: currentUser } = useAuth();
  // 20c: pela matriz — os Logs são só do super admin (não se dão por pessoa).
  const allowed = can(currentUser as any, "logs", "view");
  const [limit, setLimit] = useState(500);
  const [entity, setEntity] = useState<string>(ALL);
  const [action, setAction] = useState<string>(ALL);
  const [person, setPerson] = useState<string>(ALL);
  const [source, setSource] = useState<string>(ALL);
  const [entityId, setEntityId] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  // Pesquisa no SERVIDOR (antes filtrava só os N registos já carregados).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  const queryInput = useMemo(() => {
    const i: any = { limit };
    if (entity !== ALL) i.entity = entity;
    if (action !== ALL) i.action = action;
    if (person === SYSTEM) i.systemOnly = true;
    else if (person !== ALL) i.userId = Number(person);
    if (source !== ALL) i.source = source;
    const id = Number(entityId.trim().replace(/^#/, ""));
    if (entityId.trim() && Number.isInteger(id)) i.entityId = id;
    if (from) i.from = from;
    if (to) i.to = to;
    if (debouncedSearch) i.search = debouncedSearch;
    return i;
  }, [limit, entity, action, person, source, entityId, from, to, debouncedSearch]);

  const logsQ = trpc.logs.list.useQuery(queryInput, { enabled: allowed });
  // Listas dos filtros vêm da BD (todas as ações, todas as entidades), não só das linhas carregadas.
  const entitiesQ = trpc.logs.entities.useQuery(undefined, { enabled: allowed, staleTime: 5 * 60_000 });
  const optionsQ = trpc.logs.filterOptions.useQuery(undefined, { enabled: allowed, staleTime: 5 * 60_000 });
  const logs = logsQ.data ?? [];
  const entityOptions = useMemo(() => groupLogEntities(entitiesQ.data ?? []), [entitiesQ.data]);
  const anyFilter = entity !== ALL || action !== ALL || person !== ALL || source !== ALL || !!entityId.trim() || !!from || !!to || !!search.trim();

  const clearFilters = () => {
    setEntity(ALL); setAction(ALL); setPerson(ALL); setSource(ALL); setEntityId(""); setFrom(""); setTo(""); setSearch("");
  };
  /** Ver só a história deste registo (entidade + #id). */
  const focusRecord = (ent: string, id: number) => {
    const group = entityOptions.find((o) => o.value.split("|").includes(ent));
    setEntity(group?.value ?? ent);
    setEntityId(String(id));
  };

  const exportCsv = () => {
    // 20c: cada célula entre aspas e sem fórmulas (um detalhe "=…" não corre no Excel).
    const lines = [csvLine(["Data", "Quem", "Origem", "Ação", "Entidade", "EntityID", "Detalhes"])];
    for (const item of logs as any[]) {
      const log = item.log ?? item;
      const u = item.user ?? null;
      lines.push(csvLine([
        log.createdAt ? fmtPTDateTime(log.createdAt) : "",
        u?.name ?? "Sistema",
        log.source ? LOG_SOURCE_LABELS[log.source as LogSource] ?? log.source : "",
        logActionLabel(log.action),
        log.entity ?? "",
        log.entityId ?? "",
        log.details ?? "",
      ]));
    }
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `logs_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!allowed) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <AlertCircle className="h-12 w-12 text-muted-foreground/30 mb-4" />
        <p className="text-muted-foreground font-medium">Acesso restrito</p>
        <p className="text-sm text-muted-foreground mt-1">Apenas o Super Admin pode ver os logs de atividade</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-7xl mx-auto w-full">
      <p className="text-sm text-muted-foreground">
        Registo das ações na plataforma (retenção: 24 meses; o histórico do CRM e das permissões fica sempre) · {logs.length} entradas{logs.length >= limit ? ` (limite ${limit} — afina os filtros)` : ""}
      </p>

      {/* Filtros */}
      <Card>
        <CardContent className="p-3 flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[180px]">
            <Label className="text-xs" htmlFor="logs-search">Pesquisar</Label>
            <Input id="logs-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Detalhes, ação, entidade ou pessoa..." className="h-9" />
          </div>
          <div>
            <Label className="text-xs" htmlFor="logs-from">De</Label>
            <Input id="logs-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="h-9 w-40" />
          </div>
          <div>
            <Label className="text-xs" htmlFor="logs-to">Até</Label>
            <Input id="logs-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="h-9 w-40" />
          </div>
          <div>
            <Label className="text-xs">Quem</Label>
            <Select value={person} onValueChange={setPerson}>
              <SelectTrigger className="w-48 h-9" aria-label="Filtrar por pessoa"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Todos</SelectItem>
                <SelectItem value={SYSTEM}>Só automático (Sistema)</SelectItem>
                {(optionsQ.data?.people ?? []).map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>{p.name ?? `#${p.id}`}{p.isActive ? "" : " (desativada)"}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Origem</Label>
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger className="w-44 h-9" aria-label="Filtrar por origem"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Todas</SelectItem>
                {LOG_SOURCES.map((s) => <SelectItem key={s} value={s}>{LOG_SOURCE_LABELS[s]}</SelectItem>)}
                <SelectItem value="unknown">Sem origem (registos antigos)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Entidade</Label>
            <Select value={entity} onValueChange={setEntity}>
              <SelectTrigger className="w-44 h-9" aria-label="Filtrar por entidade"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Todas</SelectItem>
                {entityOptions.map((e) => <SelectItem key={e.value} value={e.value}>{e.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs" htmlFor="logs-id">Registo #</Label>
            <Input id="logs-id" inputMode="numeric" value={entityId} onChange={(e) => setEntityId(e.target.value)} placeholder="ex.: 123" className="h-9 w-24" />
          </div>
          <div>
            <Label className="text-xs">Ação</Label>
            <Select value={action} onValueChange={setAction}>
              <SelectTrigger className="w-44 h-9" aria-label="Filtrar por ação"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Todas</SelectItem>
                {(optionsQ.data?.actions ?? []).map((a) => (
                  <SelectItem key={a} value={a}>{logActionLabel(a)}{logActionLabel(a) !== a ? ` (${a})` : ""}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Limite</Label>
            <Select value={String(limit)} onValueChange={(v) => setLimit(parseInt(v))}>
              <SelectTrigger className="w-28 h-9" aria-label="Limite"><SelectValue /></SelectTrigger>
              <SelectContent>
                {[200, 500, 1000, 2000].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {anyFilter && (
            <Button variant="ghost" size="sm" onClick={clearFilters}><X className="w-4 h-4 mr-1" />Limpar</Button>
          )}
          <Button variant="outline" size="sm" disabled={logs.length === 0} onClick={exportCsv}>
            <Download className="w-4 h-4 mr-1" /> CSV
          </Button>
        </CardContent>
      </Card>

      {(entitiesQ.error || optionsQ.error) && (
        <QueryErrorNote error={(entitiesQ.error ?? optionsQ.error)!} onRetry={() => { entitiesQ.refetch(); optionsQ.refetch(); }} retrying={entitiesQ.isFetching || optionsQ.isFetching} what="as listas dos filtros" />
      )}

      <Card>
        <CardContent className="p-0">
          {logsQ.isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : logsQ.error ? (
            // 20c: erro ≠ "nenhum log"
            <div className="p-3"><QueryErrorNote error={logsQ.error} onRetry={() => logsQ.refetch()} retrying={logsQ.isFetching} what="os logs" /></div>
          ) : logs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <ScrollText className="h-12 w-12 text-muted-foreground/30 mb-4" />
              <p className="text-muted-foreground">Nenhum log com os filtros atuais</p>
            </div>
          ) : (
            <div className="divide-y">
              {(logs as any[]).map((item) => {
                const logEntry = item.log ?? item;
                const logUser = item.user ?? null;
                const style = ACTION_STYLE[logEntry.action] ?? { icon: Receipt, color: "text-muted-foreground" };
                const Icon = logUser ? style.icon : Bot;
                const src = logEntry.source as LogSource | null;
                return (
                  <div key={logEntry.id} className="flex flex-wrap sm:flex-nowrap items-start gap-x-3 gap-y-1 sm:gap-4 p-3 sm:p-4 hover:bg-muted/30 transition-colors">
                    <div className={`mt-0.5 shrink-0 ${style.color}`}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5 text-sm">
                        <span className="font-medium text-foreground">{logUser?.name ?? "Sistema"}</span>
                        {src && src !== "ui" && <Badge variant="outline" className="text-[10px] px-1.5 py-0">{LOG_SOURCE_LABELS[src] ?? src}</Badge>}
                        <span className={`font-medium ${style.color}`}>{logActionLabel(logEntry.action)}</span>
                        <span className="text-muted-foreground">{logEntry.entity}</span>
                        {logEntry.entityId != null && (
                          <button type="button" className="text-muted-foreground text-xs underline decoration-dotted hover:text-foreground"
                            title="Ver só a história deste registo" onClick={() => focusRecord(logEntry.entity, Number(logEntry.entityId))}>
                            #{logEntry.entityId}
                          </button>
                        )}
                      </div>
                      {logEntry.details && (
                        <p className="text-xs text-muted-foreground mt-0.5 break-words [overflow-wrap:anywhere]">{logEntry.details}</p>
                      )}
                    </div>
                    <div className="shrink-0 text-xs text-muted-foreground whitespace-nowrap tabular-nums order-first basis-full pl-7 sm:order-none sm:basis-auto sm:pl-0">
                      {logEntry.createdAt ? fmtPTDateTime(logEntry.createdAt) : "—"}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
