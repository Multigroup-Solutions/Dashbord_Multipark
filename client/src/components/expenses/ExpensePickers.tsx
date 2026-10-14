/**
 * Escolhas com pesquisa da Nova Despesa (Jorge, 14 out 2026):
 *  - `SearchPicker`: lista com barra de pesquisa no topo (Categoria, Funcionário).
 *    Escrever filtra (sem contar acentos nem maiúsculas) e salta para o 1.º.
 *  - `CostCentrePicker`: primeiro e fixos Multipark, Lisboa, Porto, Faro e
 *    Marketplace ("Principais"); por baixo, uma seta abre a árvore toda (como
 *    nos Projetos) — com o rato ou com as setas → / ← no item ativo.
 *    A pesquisa procura na árvore toda.
 * Regras puras: shared/costCentrePicker.ts.
 */
import { useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, ChevronsUpDown, Loader2, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { textMatches } from "@shared/textKey";
import {
  costCentrePath, costCentreTreeRows, defaultExpandedCostCentres, pinnedCostCentres, searchCostCentres, selectableCostCentres,
  type CostCentreNode,
} from "@shared/costCentrePicker";

export type PickerOption = { value: string; label: string; color?: string | null; hint?: string | null };

const TRIGGER = "w-full justify-between font-normal rounded-[10px] h-9 px-3";
const CONTENT = "p-0 w-[var(--radix-popover-trigger-width)] min-w-[min(260px,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] rounded-[10px]";

function Dot({ color }: { color?: string | null }) {
  if (!color) return null;
  return <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />;
}

/** Lista com pesquisa no topo. `noneLabel` acrescenta a opção "Nenhum" (valor ""). */
export function SearchPicker({
  value, onChange, options, placeholder = "Selecionar…", searchPlaceholder = "Pesquisar…", emptyText = "Sem resultados",
  noneLabel, ariaLabel, invalid, loading, error, onRetry,
}: {
  value: string;
  onChange: (v: string) => void;
  options: PickerOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  noneLabel?: string;
  ariaLabel?: string;
  invalid?: boolean;
  /** A lista ainda está a carregar / não carregou (com "tentar outra vez"). */
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = options.find((o) => o.value === value);
  const shown = useMemo(() => options.filter((o) => textMatches(`${o.label} ${o.hint ?? ""}`, query)), [options, query]);
  const pick = (v: string) => { onChange(v); setOpen(false); setQuery(""); };
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(""); }} modal>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" role="combobox" aria-expanded={open} aria-label={ariaLabel}
          className={cn(TRIGGER, invalid && "border-amber-400")}>
          <span className={cn("flex min-w-0 items-center gap-2 truncate", !selected && "text-muted-foreground")}>
            {selected && <Dot color={selected.color} />}
            <span className="truncate">{selected ? selected.label : loading ? "A carregar…" : placeholder}</span>
          </span>
          {loading ? <Loader2 className="ml-2 h-4 w-4 shrink-0 animate-spin opacity-60" /> : <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent className={CONTENT} align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder={searchPlaceholder} value={query} onValueChange={setQuery} />
          <CommandList>
            {loading ? (
              <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground" role="status">
                <Loader2 className="h-4 w-4 animate-spin" /> A carregar…
              </div>
            ) : error ? (
              <div className="space-y-2 px-3 py-3 text-sm" role="alert">
                <p className="text-destructive">Não foi possível carregar a lista.</p>
                {onRetry && <Button type="button" variant="outline" size="sm" onClick={onRetry}>Tentar outra vez</Button>}
              </div>
            ) : <CommandEmpty>{emptyText}</CommandEmpty>}
            <CommandGroup>
              {noneLabel && !query.trim() && (
                <CommandItem value="__none__" onSelect={() => pick("")}>
                  <Check className={cn("h-4 w-4", value === "" ? "opacity-100" : "opacity-0")} />
                  <span className="text-muted-foreground">{noneLabel}</span>
                </CommandItem>
              )}
              {!loading && !error && shown.map((o) => (
                <CommandItem key={o.value} value={`opt-${o.value}`} onSelect={() => pick(o.value)}>
                  <Check className={cn("h-4 w-4", value === o.value ? "opacity-100" : "opacity-0")} />
                  <Dot color={o.color} />
                  <span className="truncate">{o.label}</span>
                  {o.hint && <span className="ml-auto truncate text-xs text-muted-foreground">{o.hint}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

const LEVEL_LABEL: Record<string, string> = { group: "Grupo", city: "Cidade", brand: "Marca", project: "Projeto" };
const LEVEL_COLOR: Record<string, string> = {
  group: "bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-900",
  city: "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-900",
  brand: "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
  project: "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
};

function LevelBadge({ level }: { level?: string | null }) {
  if (!level) return null;
  return <span className={cn("shrink-0 rounded border px-1.5 py-0.5 text-[11px] leading-none", LEVEL_COLOR[level])}>{LEVEL_LABEL[level] ?? level}</span>;
}

/** Centro de custos: 5 fixos no topo + árvore toda por baixo (seta), com pesquisa na árvore toda. */
export function CostCentrePicker({ value, onChange, projects }: { value: string; onChange: (v: string) => void; projects: CostCentreNode[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [showTree, setShowTree] = useState(false);
  const selectedId = value ? Number(value) : null;
  const nodes = useMemo(() => selectableCostCentres(projects, selectedId), [projects, selectedId]);
  // Abertos: o grupo e as cidades, até a pessoa abrir/fechar à mão.
  const [expandedOverride, setExpandedOverride] = useState<Set<number> | null>(null);
  const expanded = useMemo(() => expandedOverride ?? defaultExpandedCostCentres(nodes), [expandedOverride, nodes]);
  const pinned = useMemo(() => pinnedCostCentres(nodes), [nodes]);
  const rows = useMemo(() => costCentreTreeRows(nodes, expanded), [nodes, expanded]);
  const found = useMemo(() => searchCostCentres(nodes, query), [nodes, query]);
  const selected = nodes.find((n) => n.id === selectedId);
  const searching = query.trim().length > 0;

  const pick = (id: number) => { onChange(String(id)); setOpen(false); setQuery(""); };
  const toggle = (id: number) => { const n = new Set(expanded); if (n.has(id)) n.delete(id); else n.add(id); setExpandedOverride(n); };
  // Linha ativa do cmdk (controlada) — para abrir/fechar nós com as setas → / ←, como numa árvore.
  const [active, setActive] = useState("");
  const onTreeKey = (e: React.KeyboardEvent) => {
    if (searching || !showTree || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
    const m = /^t-(\d+)$/.exec(active);
    if (!m) return;
    const row = rows.find((r) => r.node.id === Number(m[1]));
    if (!row) return;
    e.preventDefault();
    if (e.key === "ArrowRight") {
      if (row.hasChildren && !row.open) toggle(row.node.id);
      else if (row.open) { const child = rows[rows.indexOf(row) + 1]; if (child && child.depth > row.depth) setActive(`t-${child.node.id}`); }
    } else if (row.open) toggle(row.node.id);
    else if (row.node.parentId != null && rows.some((r) => r.node.id === row.node.parentId)) setActive(`t-${row.node.parentId}`);
  };

  return (
    <Popover open={open} onOpenChange={(o) => {
      setOpen(o);
      if (!o) setQuery("");
      // Escolhido um centro mais específico (fora dos fixos): abre já a árvore
      else if (selectedId != null && !pinned.some((p) => p.id === selectedId)) setShowTree(true);
    }} modal>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" role="combobox" aria-expanded={open} aria-label="Centro de custos"
          className={cn(TRIGGER, !selected && "border-amber-400")}>
          <span className={cn("flex min-w-0 items-center gap-2", !selected && "text-muted-foreground")}>
            {selected && <LevelBadge level={selected.level} />}
            <span className="truncate">{selected ? costCentrePath(selected, nodes) : "Escolher centro de custos…"}</span>
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className={CONTENT} align="start">
        <Command shouldFilter={false} value={active} onValueChange={setActive} onKeyDown={onTreeKey}>
          <CommandInput placeholder="Pesquisar em todos os centros…" value={query} onValueChange={setQuery} />
          <CommandList className="max-h-[min(360px,55vh)]">
            <CommandEmpty>Nenhum centro de custos com esse nome</CommandEmpty>
            {searching ? (
              <CommandGroup heading="Resultados">
                {found.map(({ node, path }) => (
                  <CommandItem key={node.id} value={`s-${node.id}`} onSelect={() => pick(node.id)}>
                    <Check className={cn("h-4 w-4", selectedId === node.id ? "opacity-100" : "opacity-0")} />
                    <LevelBadge level={node.level} />
                    <span className="truncate">{path}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : (
              <>
                {pinned.length > 0 && (
                  <CommandGroup heading="Principais">
                    {pinned.map((p) => (
                      <CommandItem key={p.id} value={`p-${p.id}`} onSelect={() => pick(p.id)}>
                        <Check className={cn("h-4 w-4", selectedId === p.id ? "opacity-100" : "opacity-0")} />
                        <Star className="h-3.5 w-3.5 text-primary" aria-hidden />
                        <span className="truncate font-medium">{p.label}</span>
                        <span className="ml-auto"><LevelBadge level={p.level} /></span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem value="__tree__" onSelect={() => setShowTree((v) => !v)} aria-expanded={showTree}>
                    {showTree ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    <span className="text-sm">{showTree ? "Esconder a árvore" : "Mais específico: parques, marcas e projetos"}</span>
                  </CommandItem>
                  {showTree && rows.map(({ node, depth, hasChildren, open: isOpen }) => (
                    <CommandItem key={node.id} value={`t-${node.id}`} onSelect={() => pick(node.id)} style={{ paddingLeft: `${8 + depth * 16}px` }}
                      aria-expanded={hasChildren ? isOpen : undefined} aria-level={depth + 1}>
                      {hasChildren ? (
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-label={isOpen ? `Fechar ${node.name}` : `Abrir ${node.name}`}
                          className="-m-1 rounded p-1 hover:bg-muted"
                          onPointerDown={(e) => e.preventDefault()}
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggle(node.id); }}
                        >
                          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </button>
                      ) : <span className="w-4 shrink-0" />}
                      <span className="min-w-0 flex-1 truncate">{node.name}</span>
                      <LevelBadge level={node.level} />
                      <Check className={cn("h-4 w-4", selectedId === node.id ? "opacity-100" : "opacity-0")} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
