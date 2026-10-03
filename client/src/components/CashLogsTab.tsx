/**
 * D59: separador "Caixa" dos Logs — a história guardada nas tabelas da caixa
 * (casos, contagens, talões e dias de multibanco, extratos Viva, recebimentos
 * do fim do mês). Só leitura.
 */
import { useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { Bot, Download, Loader2, Wallet, X } from "lucide-react";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { csvLine } from "@shared/logsView";

const ALL = "all";
const KINDS: Array<{ value: string; label: string }> = [
  { value: "case", label: "Casos da caixa" },
  { value: "count", label: "Contagens" },
  { value: "mb_receipt", label: "Talões multibanco" },
  { value: "mb_day", label: "Multibanco do dia" },
  { value: "viva", label: "Extratos Viva Wallet" },
  { value: "monthly", label: "Recebimentos fim do mês" },
];
const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.value, k.label]));

export function CashLogsTab({ people }: { people: Array<{ id: number; name: string | null; isActive?: number | boolean | null }> }) {
  const [kind, setKind] = useState(ALL);
  const [person, setPerson] = useState(ALL);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [limit, setLimit] = useState(500);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  const input = useMemo(() => {
    const i: any = { limit };
    if (kind !== ALL) i.kind = kind;
    if (person !== ALL) i.userId = Number(person);
    if (from) i.from = from;
    if (to) i.to = to;
    if (debounced) i.search = debounced;
    return i;
  }, [kind, person, from, to, debounced, limit]);
  const q = trpc.logs.cash.useQuery(input);
  const rows = q.data ?? [];
  const anyFilter = kind !== ALL || person !== ALL || !!from || !!to || !!search.trim();

  const exportCsv = () => {
    const lines = [csvLine(["Data", "Quem", "Tipo", "Ação", "Parque", "Detalhes"])];
    for (const r of rows) lines.push(csvLine([fmtPTDateTime(r.at), r.userName ?? "Sistema", KIND_LABEL[r.kind] ?? r.kind, r.action, r.parkId ?? "", r.detail]));
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `logs_caixa_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        A história da caixa (casos, contagens, talões, multibanco do dia, extratos Viva e recebimentos do fim do mês), como fica guardada na própria caixa · {rows.length} entradas{rows.length >= limit ? ` (limite ${limit} — afina os filtros)` : ""}
      </p>
      <Card>
        <CardContent className="p-3 flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[180px]">
            <Label className="text-xs" htmlFor="cash-logs-search">Pesquisar</Label>
            <Input id="cash-logs-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Caso, parque, valor, pessoa..." className="h-9" />
          </div>
          <div>
            <Label className="text-xs" htmlFor="cash-logs-from">De</Label>
            <Input id="cash-logs-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="h-9 w-40" />
          </div>
          <div>
            <Label className="text-xs" htmlFor="cash-logs-to">Até</Label>
            <Input id="cash-logs-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="h-9 w-40" />
          </div>
          <div>
            <Label className="text-xs">Tipo</Label>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger className="w-52 h-9" aria-label="Filtrar por tipo"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Tudo</SelectItem>
                {KINDS.map((k) => <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Quem</Label>
            <Select value={person} onValueChange={setPerson}>
              <SelectTrigger className="w-48 h-9" aria-label="Filtrar por pessoa (caixa)"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Todos</SelectItem>
                {people.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name ?? `#${p.id}`}{p.isActive === false || p.isActive === 0 ? " (desativada)" : ""}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Limite</Label>
            <Select value={String(limit)} onValueChange={(v) => setLimit(parseInt(v))}>
              <SelectTrigger className="w-28 h-9" aria-label="Limite (caixa)"><SelectValue /></SelectTrigger>
              <SelectContent>
                {[200, 500, 1000, 2000].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {anyFilter && (
            <Button variant="ghost" size="sm" onClick={() => { setKind(ALL); setPerson(ALL); setFrom(""); setTo(""); setSearch(""); }}><X className="w-4 h-4 mr-1" />Limpar</Button>
          )}
          <Button variant="outline" size="sm" disabled={rows.length === 0} onClick={exportCsv}>
            <Download className="w-4 h-4 mr-1" /> CSV
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {q.isLoading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
          ) : q.error ? (
            <div className="p-3"><QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="os registos da caixa" /></div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Wallet className="h-12 w-12 text-muted-foreground/30 mb-4" />
              <p className="text-muted-foreground">Nenhum registo da caixa com os filtros atuais</p>
            </div>
          ) : (
            <div className="divide-y">
              {rows.map((r) => (
                <div key={r.key} className="flex flex-wrap sm:flex-nowrap items-start gap-x-3 gap-y-1 sm:gap-4 p-3 sm:p-4 hover:bg-muted/30 transition-colors">
                  <div className="mt-0.5 shrink-0 text-muted-foreground">{r.userId ? <Wallet className="h-4 w-4" /> : <Bot className="h-4 w-4" />}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5 text-sm">
                      <span className="font-medium text-foreground">{r.userName ?? "Sistema"}</span>
                      <span className="font-medium text-primary">{r.action}</span>
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">{KIND_LABEL[r.kind] ?? r.kind}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 break-words [overflow-wrap:anywhere]">{r.detail}</p>
                  </div>
                  <div className="shrink-0 text-xs text-muted-foreground whitespace-nowrap tabular-nums order-first basis-full pl-7 sm:order-none sm:basis-auto sm:pl-0">
                    {fmtPTDateTime(r.at)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
