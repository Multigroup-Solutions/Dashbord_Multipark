/**
 * Barra de filtros das listas de pessoas (Condutores, Agentes, Desempenho) —
 * Jorge, 14 out 2026: pesquisa por nome + "Filtros" com parâmetros
 * (coluna ≥ / ≤ valor, várias ao mesmo tempo, cada uma num chip com ×) +,
 * no Desempenho, "Colunas" para a tabela caber no ecrã. Regras em
 * shared/peopleFilters.ts.
 */
import { useState } from "react";
import { METRIC_RULE_OP_LABELS, parseRuleValue, upsertRule, type MetricRule, type MetricRuleOp } from "@shared/peopleFilters";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Columns3, Plus, Search, SlidersHorizontal, X } from "lucide-react";

export interface FilterMetric { key: string; label: string }

export function PeopleFilterBar({
  search, onSearch, metrics, rules, onRules, onlyActive, onOnlyActive, columns, shown, onShown, onToggleShown, onResetShown, children,
}: {
  search: string;
  onSearch: (v: string) => void;
  metrics: FilterMetric[];
  rules: MetricRule[];
  onRules: (r: MetricRule[]) => void;
  /** só no Desempenho (há fichas inativas) */
  onlyActive?: boolean;
  onOnlyActive?: (v: boolean) => void;
  /** só no Desempenho: as colunas que se podem esconder */
  columns?: FilterMetric[];
  shown?: ReadonlySet<string>;
  onShown?: (s: Set<string>) => void;
  /** uma caixa mudada (só essa fica como escolha explícita); sem isto usa-se onShown */
  onToggleShown?: (key: string, show: boolean) => void;
  /** volta às colunas por omissão */
  onResetShown?: () => void;
  children?: React.ReactNode;
}) {
  const [key, setKey] = useState("");
  const [op, setOp] = useState<MetricRuleOp>("gte");
  const [txt, setTxt] = useState("");
  const value = parseRuleValue(txt);
  const label = (k: string) => metrics.find((m) => m.key === k)?.label ?? k;
  const add = () => {
    if (!key || value == null) return;
    onRules(upsertRule(rules, { key, op, value }));
    setTxt("");
  };
  const active = rules.length + (onlyActive ? 1 : 0);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => onSearch(e.target.value)} placeholder="Procurar pelo nome…" aria-label="Procurar pelo nome" className="h-9 pl-8" />
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <Button size="sm" variant={active ? "selected" : "outline"} className="h-9" aria-label="Filtros por parâmetros">
              <SlidersHorizontal className="h-4 w-4" /> Filtros{active ? ` · ${active}` : ""}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 space-y-3">
            <p className="text-xs text-muted-foreground">Mostra só quem cumpre todos os parâmetros (ex.: Por hora ≥ 8).</p>
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <Select value={key} onValueChange={setKey}>
                <SelectTrigger className="h-8 text-xs" aria-label="Coluna"><SelectValue placeholder="Coluna…" /></SelectTrigger>
                <SelectContent>{metrics.map((m) => <SelectItem key={m.key} value={m.key}>{m.label}</SelectItem>)}</SelectContent>
              </Select>
              <div role="group" aria-label="Comparação" className="inline-flex gap-1">
                {(["gte", "lte"] as const).map((o) => (
                  <Button key={o} size="sm" className="h-8 w-9 px-0" variant={op === o ? "selected" : "outline"} onClick={() => setOp(o)} aria-label={o === "gte" ? "maior ou igual" : "menor ou igual"}>{METRIC_RULE_OP_LABELS[o]}</Button>
                ))}
              </div>
              <Input value={txt} onChange={(e) => setTxt(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} inputMode="decimal" placeholder="Valor (ex.: 8 ou 4,5)" aria-label="Valor" className="h-8" />
              <Button size="sm" className="h-8" onClick={add} disabled={!key || value == null}><Plus className="h-4 w-4" /> Pôr</Button>
            </div>
            {onOnlyActive && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={!!onlyActive} onCheckedChange={(v) => onOnlyActive(v === true)} /> Só fichas ativas
              </label>
            )}
            {active > 0 && <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => { onRules([]); onOnlyActive?.(false); }}>Limpar filtros</Button>}
          </PopoverContent>
        </Popover>
        {columns && shown && onShown && (
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline" className="h-9" aria-label="Escolher colunas">
                <Columns3 className="h-4 w-4" /> Colunas · {columns.filter((c) => shown.has(c.key)).length}/{columns.length}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="max-h-[60vh] w-72 overflow-y-auto">
              <div className="mb-2 flex gap-2">
                <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => onShown(new Set(columns.map((c) => c.key)))}>Todas</Button>
                <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => onShown(new Set())}>Nenhuma</Button>
                {onResetShown && <Button size="sm" variant="outline" className="h-7 px-2 text-xs" title="As colunas com algum valor neste período" onClick={onResetShown}>Repor</Button>}
              </div>
              <div className="space-y-1.5">
                {columns.map((c) => (
                  <label key={c.key} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={shown.has(c.key)} onCheckedChange={(v) => {
                      if (onToggleShown) { onToggleShown(c.key, v === true); return; }
                      const next = new Set(shown);
                      if (v === true) next.add(c.key); else next.delete(c.key);
                      onShown(next);
                    }} /> {c.label}
                  </label>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        )}
        {children}
      </div>
      {(rules.length > 0 || onlyActive) && (
        <div className="flex flex-wrap gap-1.5">
          {onlyActive && (
            <Badge variant="outline" className="gap-1 border-primary text-primary">Só fichas ativas
              <button type="button" aria-label="Tirar o filtro Só fichas ativas" onClick={() => onOnlyActive?.(false)}><X className="h-3 w-3" /></button>
            </Badge>
          )}
          {rules.map((r) => (
            <Badge key={`${r.key}:${r.op}`} variant="outline" className="gap-1 border-primary text-primary">
              {label(r.key)} {METRIC_RULE_OP_LABELS[r.op]} {String(r.value).replace(".", ",")}
              <button type="button" aria-label={`Tirar o filtro ${label(r.key)}`} onClick={() => onRules(rules.filter((x) => x !== r))}><X className="h-3 w-3" /></button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
