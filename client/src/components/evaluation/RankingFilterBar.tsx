/**
 * Avaliação → Mês: a barra de pesquisa e filtros do ranking "como no Odoo"
 * (Jorge, 14 out 2026). O MESMO padrão e os mesmos componentes do CRM
 * (components/crm/CrmFilters.tsx): barra única com facetas, chips, grupos (OU
 * dentro, E entre), regras sobre as colunas, agrupar por e filtros guardados.
 * As regras e o filtro em si são puros (shared/evaluationFilters.ts) — a
 * exportação para Sheets aplica os mesmos no servidor.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Search, Layers, X } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePersistedState } from "@/hooks/usePersistedState";
import {
  FacetRow, FilterChips, FilterGroup, RulesEditor, SavedFiltersMenu, SelButton, useSavedFilters,
  type FilterChip, type Opt, type RuleOpDef,
} from "@/components/crm/CrmFilters";
import {
  EVAL_FILTER_LIMITS, EVAL_GROUP_BY, EVAL_GROUP_CHIP_LABELS, EVAL_GROUP_LABELS, EVAL_GROUP_ORDER, EVAL_RULE_FIELDS, EVAL_RULE_OPS, EVAL_SEARCH_FIELDS,
  evalRuleText, facetCounts, groupOptions, groupValueLabel, isFilterActive, sanitizeEvalSavedView, usableRules,
  type EvalGroupBy, type EvalGroups, type EvalRankingRowLike, type EvalRule, type EvalRules, type EvalSavedView, type EvalSearchField,
} from "@shared/evaluationFilters";

const { searches: MAX_SEARCHES, rules: MAX_RULES } = EVAL_FILTER_LIMITS;

const RULE_FIELDS = EVAL_RULE_FIELDS.map((f) => ({ id: f.id, label: f.label, type: "number" }));
const RULE_OPS: Record<string, RuleOpDef[]> = { number: EVAL_RULE_OPS.map((o) => ({ id: o.id, label: o.label, arity: o.arity })) };

/** O filtro do ranking, guardado na sessão (e limpo do que já não vale). */
export function useRankingFilter() {
  const [raw, setRaw] = usePersistedState<EvalSavedView>("avaliacao.mes.filtro", {});
  const value = useMemo(() => sanitizeEvalSavedView(raw).view, [raw]);
  return [value, setRaw] as const;
}

/** Vazio = sem filtro nem agrupamento (para o "abrir com este"). */
const isEmptyView = (v: EvalSavedView) => !isFilterActive(v) && (!v.groupBy || v.groupBy === "none");

export function RankingFilterBar({ rows, value, onChange, shown, extras, onApplyExtras }: {
  /** todas as linhas do período (as opções e as contagens vêm daqui) */
  rows: EvalRankingRowLike[];
  value: EvalSavedView;
  onChange: (v: EvalSavedView) => void;
  /** quantas linhas o filtro deixa */
  shown: number;
  /** a vista e a ordem do ranking (vão nos filtros guardados) */
  extras: Pick<EvalSavedView, "view" | "sort">;
  onApplyExtras: (v: Pick<EvalSavedView, "view" | "sort">) => void;
}) {
  const [focus, setFocus] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [saveReq, setSaveReq] = useState(false);
  const text = value.text ?? "";
  const set = (p: Partial<EvalSavedView>) => onChange({ ...value, ...p });

  // "Abrir com este": o filtro por omissão aplica-se uma vez por sessão, se não houver outro.
  const saved = useSavedFilters("avaliacao");
  const [defaultTried, setDefaultTried] = usePersistedState<boolean>("avaliacao.mes.filtroOmissao", false);
  const tried = useRef(defaultTried);
  useEffect(() => {
    if (tried.current || !saved.list.data) return;
    tried.current = true;
    setDefaultTried(true);
    const def = saved.list.data.find((f) => f.isDefault);
    if (def && isEmptyView(value)) applySaved(def.payload as EvalSavedView, def.dropped);
  }, [saved.list.data]); // eslint-disable-line react-hooks/exhaustive-deps

  function applySaved(p: EvalSavedView, dropped: number) {
    const { view, dropped: more } = sanitizeEvalSavedView(p);
    onChange({ text: view.text, searches: view.searches, groups: view.groups, rules: view.rules, groupBy: view.groupBy });
    onApplyExtras({ view: view.view, sort: view.sort });
    const lost = dropped + more;
    if (lost > 0) toast.warning(`${lost === 1 ? "1 parte do filtro deixou" : `${lost} partes do filtro deixaram`} de existir. O resto foi aplicado.`);
  }

  const counts = useMemo(() => (focus && text.trim() ? facetCounts(rows, text) : null), [rows, text, focus]);
  const options = useMemo(() => groupOptions(rows), [rows]);
  const optsOf = (g: keyof EvalGroups): Opt[] => options[g].map((o) => ({ value: o.value, label: o.label, n: o.n }));

  const commit = (field: EvalSearchField) => {
    const t = text.trim();
    if (!t) return;
    // os mesmos limites do que se guarda e exporta (shared/evaluationFilters.ts)
    if ((value.searches ?? []).length >= MAX_SEARCHES) { toast.warning(`No máximo ${MAX_SEARCHES} pesquisas. Tira uma antes de pôr outra.`); return; }
    set({ text: "", searches: [...(value.searches ?? []), { field, text: t }] });
  };
  /** Regras do editor → filtro (no máximo MAX_RULES, como o que se guarda e exporta). */
  const rulesFrom = (r: EvalRules | null): EvalRules | null => {
    if (!r || r.items.length <= MAX_RULES) return r;
    toast.warning(`No máximo ${MAX_RULES} regras: ficaram as primeiras ${MAX_RULES}.`);
    return { match: r.match, items: r.items.slice(0, MAX_RULES) };
  };

  // chips do filtro ativo (o texto que se está a escrever filtra já, sem chip)
  const chips: FilterChip[] = [];
  (value.searches ?? []).forEach((s, i) => {
    const label = EVAL_SEARCH_FIELDS.find((f) => f.id === s.field)?.label ?? s.field;
    chips.push({ key: `s${i}`, label: `${label}: «${s.text}»`, remove: () => set({ searches: (value.searches ?? []).filter((_, j) => j !== i) }) });
  });
  for (const g of EVAL_GROUP_ORDER) {
    const vals = (value.groups?.[g] ?? []) as string[];
    if (!vals.length) continue;
    chips.push({
      key: `g-${g}`, label: `${EVAL_GROUP_CHIP_LABELS[g]}: ${vals.map((v) => groupValueLabel(g, v, rows)).join(" ou ")}`,
      remove: () => set({ groups: { ...value.groups, [g]: [] } }),
    });
  }
  const rules = usableRules(value.rules);
  rules.forEach((r, i) => {
    chips.push({
      key: `r${i}`, label: (i > 0 && value.rules?.match === "any" ? "ou " : "") + evalRuleText(r),
      remove: () => { const items = rules.filter((_, j) => j !== i); set({ rules: items.length ? { match: value.rules?.match ?? "all", items } : null }); },
    });
  });
  const clearAll = () => onChange({ groupBy: value.groupBy });
  const active = isFilterActive(value);

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-[14px] border bg-card p-3.5">
      <div className="relative">
        <label htmlFor="aval-q" className="sr-only">Procurar no ranking</label>
        <div className="flex h-11 min-w-0 items-center gap-2.5 rounded-[10px] border-2 border-primary bg-card px-3">
          <Search className="h-[18px] w-[18px] shrink-0 text-muted-foreground" />
          {/* o mesmo limite do que se guarda e exporta (evalSearchSchema: 200) */}
          <input id="aval-q" value={text} autoComplete="off" maxLength={200}
            onChange={(e) => set({ text: e.target.value })}
            onFocus={() => setFocus(true)} onBlur={() => setTimeout(() => setFocus(false), 150)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commit("name"); }
              if (e.key === "Escape") (e.target as HTMLInputElement).blur();
            }}
            className="min-w-0 flex-1 border-0 bg-transparent text-sm font-medium outline-none"
            placeholder="Procurar condutor ou n.º de agente…" />
          {text && (
            <button type="button" aria-label="Limpar a pesquisa" onClick={() => set({ text: "" })} className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          <span className="hidden shrink-0 text-xs text-muted-foreground lg:inline">Nome, n.º de agente, cidade, marca, posto ou equipa</span>
        </div>
        {focus && text.trim().length > 0 && counts && (
          <div className="absolute left-0 top-full z-30 mt-1.5 w-[420px] max-w-full rounded-[10px] border bg-popover p-1.5 shadow-[0_12px_32px_rgba(12,31,63,.14)]">
            <div className="px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.05em] text-muted-foreground">Procurar «{text.trim()}» em</div>
            {EVAL_SEARCH_FIELDS.map((f) => {
              const n = counts[f.id];
              return (
                <FacetRow key={f.id} label={f.label} on={f.id === "name"} dim={n === 0} onPick={() => commit(f.id)}
                  hint={n === 0 ? "ninguém" : `${n} ${n === 1 ? "pessoa" : "pessoas"}`} />
              );
            })}
          </div>
        )}
      </div>

      <FilterChips chips={chips} onClear={clearAll} />

      <div className="flex flex-wrap items-center gap-2">
        {EVAL_GROUP_ORDER.map((g) => {
          const opts = optsOf(g);
          const sel = (value.groups?.[g] ?? []) as string[];
          if (!opts.length && !sel.length) return null;
          return (
            <FilterGroup key={g} label={EVAL_GROUP_LABELS[g]} options={opts} value={sel} countLabel="pessoas"
              onChange={(v) => set({ groups: { ...value.groups, [g]: v } as EvalGroups })} />
          );
        })}
        <SelButton active onClick={() => setRulesOpen((x) => !x)} className="font-bold">+ Regra</SelButton>
        <Select value={value.groupBy ?? "none"} onValueChange={(v) => set({ groupBy: v as EvalGroupBy })}>
          <SelectTrigger className="h-[34px] w-auto min-w-[150px] bg-card text-[13px]" aria-label="Agrupar por">
            <Layers className="h-3.5 w-3.5 opacity-70" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EVAL_GROUP_BY.map((g) => <SelectItem key={g.id} value={g.id}>{g.id === "none" ? "Sem grupos" : `Agrupar: ${g.label}`}</SelectItem>)}
          </SelectContent>
        </Select>
        <SavedFiltersMenu<EvalSavedView>
          page="avaliacao" namePlaceholder="Nome (ex.: Porto com excessos de velocidade)"
          current={{ ...value, ...extras }}
          onApply={(p, meta) => applySaved(p, meta.dropped)} saveRequest={saveReq} onSaveHandled={() => setSaveReq(false)} />
      </div>

      {rulesOpen && (
        <RulesEditor<EvalRule> fields={RULE_FIELDS} opsByType={RULE_OPS} subject="colaboradores" initial={value.rules?.items?.length ? { match: value.rules.match, items: value.rules.items } : null}
          onApply={(r) => { set({ rules: rulesFrom(r) }); setRulesOpen(false); }}
          onCancel={() => setRulesOpen(false)}
          onSave={(r) => { set({ rules: rulesFrom(r) }); setRulesOpen(false); setSaveReq(true); }} />
      )}

      {active && (
        <p className="text-xs text-muted-foreground" role="status">
          A mostrar <strong className="text-foreground">{shown}</strong> de {rows.length} {rows.length === 1 ? "colaborador" : "colaboradores"}. Os totais, o melhor, o CSV e a folha levam só estes.
        </p>
      )}
    </div>
  );
}
