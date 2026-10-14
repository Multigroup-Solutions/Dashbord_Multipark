/**
 * Controlos de filtro "como no Odoo" (do Odoo ficaram só os filtros, Jorge):
 * grupos de escolha múltipla (OU dentro do grupo, E entre grupos), regras
 * específicas ("carro vermelho, saiu a 10 set, com familiar cliente"),
 * filtros guardados, a lista "Procurar «x» em" das facetas e os chips do
 * filtro ativo. Nasceram no CRM (Clientes); desde 14 out 2026 servem também
 * a Avaliação → Mês ("pontos ≥ 500 e excessos de velocidade ≥ 1").
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChevronDown, Plus, Star, Trash2, X } from "lucide-react";
import { OPS_BY_TYPE, type CrmRule, type RuleType } from "@shared/crmFilters";

export type Opt = { value: string; label: string; hint?: string | null; n?: number };

/** Botão ".sel" do desenho: altura 34, borda, seta. */
export function SelButton({ children, active, className, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        "inline-flex h-[34px] items-center gap-1.5 rounded-lg border bg-card px-2.5 text-[13px] font-medium text-foreground hover:bg-muted",
        active && "border-primary text-primary",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Grupo de filtro com escolha múltipla e pesquisa (listas longas: parques, parceiros). */
export function FilterGroup({ label, options, value, onChange, countLabel }: {
  label: string; options: Opt[]; value: string[] | undefined; onChange: (v: string[]) => void;
  /** o que conta o número de cada opção (ex.: "reservas") — diz-se no topo da lista */
  countLabel?: string;
}) {
  const [q, setQ] = useState("");
  const sel = new Set(value ?? []);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    const xs = t ? options.filter((o) => o.label.toLowerCase().includes(t) || (o.hint ?? "").toLowerCase().includes(t)) : options;
    // escolhidos primeiro
    return [...xs.filter((o) => sel.has(o.value)), ...xs.filter((o) => !sel.has(o.value))];
  }, [options, q, value]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (v: string) => {
    const next = new Set(sel);
    if (next.has(v)) next.delete(v); else next.add(v);
    onChange([...next]);
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <SelButton active={sel.size > 0}>
          {label}
          {sel.size > 0 && <span className="rounded-full bg-primary px-1.5 text-[11px] font-bold text-primary-foreground">{sel.size}</span>}
          <ChevronDown className="h-3 w-3 opacity-70" />
        </SelButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        {options.length > 8 && (
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Procurar ${label.toLowerCase()}…`} className="mb-2 h-8" />
        )}
        {countLabel && options.some((o) => o.n != null) && <p className="px-2 pb-1 text-right text-[11px] text-muted-foreground">n.º de {countLabel}</p>}
        <div className="max-h-72 space-y-0.5 overflow-y-auto">
          {shown.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">Nada a mostrar.</p>}
          {shown.map((o) => (
            <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-muted">
              <Checkbox checked={sel.has(o.value)} onCheckedChange={() => toggle(o.value)} />
              <span className="min-w-0 flex-1 truncate">{o.label}{o.hint && <span className="ml-1 text-xs text-muted-foreground">· {o.hint}</span>}</span>
              {o.n != null && <span className="text-xs tabular-nums text-muted-foreground">{o.n.toLocaleString("pt-PT")}</span>}
            </label>
          ))}
        </div>
        {sel.size > 0 && (
          <div className="mt-2 border-t pt-2 text-right">
            <button type="button" className="text-xs font-semibold text-primary" onClick={() => onChange([])}>Limpar {label.toLowerCase()}</button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ─── Facetas e chips (barra única, como no Odoo) ───────────────────────────

/** Uma linha do "Procurar «x» em …" (a faceta escolhida vira chip). */
export function FacetRow({ label, hint, on, dim, onPick }: { label: string; hint: string; on: boolean; dim?: boolean; onPick: () => void }) {
  return (
    <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={onPick}
      className={cn("flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-[13px] font-medium", on ? "bg-secondary" : "hover:bg-muted", dim && "opacity-50")}>
      <span className="min-w-0 truncate">{label}</span><span className="shrink-0 text-xs text-muted-foreground">{hint}</span>
    </button>
  );
}

export type FilterChip = { key: string; label: string; remove: () => void };

/** Os chips do filtro ativo + "Limpar tudo". Quebram de linha (telemóvel: sem deslizar de lado). */
export function FilterChips({ chips, onClear }: { chips: FilterChip[]; onClear: () => void }) {
  if (!chips.length) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="text-xs font-bold text-muted-foreground">Filtro:</span>
      {chips.map((c) => (
        <span key={c.key} className="inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-full bg-secondary py-0.5 pl-2.5 pr-1 text-xs font-semibold text-secondary-foreground">
          <span className="min-w-0 break-words">{c.label}</span>
          <button type="button" aria-label={`Tirar filtro: ${c.label}`} onClick={c.remove} className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full hover:bg-black/5 dark:hover:bg-white/10">
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <button type="button" onClick={onClear} className="text-xs font-semibold text-primary">Limpar tudo</button>
    </div>
  );
}

// ─── Regras ─────────────────────────────────────────────────────────────────

export type RuleField = { id: string; label: string; type: string };
export type RulesState = { match: "all" | "any"; items: CrmRule[] };
/** Operador de uma regra: `arity` 0 = sem valor ("tem"), 1 = um valor, 2 = dois ("entre"). */
export type RuleOpDef = { id: string; label: string; arity?: 0 | 1 | 2 };
/** Regra genérica (CRM: `CrmRule`; Avaliação: `EvalRule`, com `value2` no "entre"). */
export type AnyRule = { field: string; op: string; value?: string | number | null; value2?: string | number | null };

/** Os operadores do CRM (sim/não sem valor). */
const CRM_OPS: Record<string, RuleOpDef[]> = Object.fromEntries(
  Object.entries(OPS_BY_TYPE).map(([t, ops]) => [t, ops.map((o) => ({ ...o, arity: o.id === "yes" || o.id === "no" ? 0 : 1 }))]),
);
const arityOf = (op: RuleOpDef | undefined): 0 | 1 | 2 => op?.arity ?? 1;

export function ruleText(r: CrmRule, fields: RuleField[]): string {
  const f = fields.find((x) => x.id === r.field);
  const op = f ? OPS_BY_TYPE[f.type as RuleType]?.find((o) => o.id === r.op)?.label : r.op;
  const v = r.op === "yes" || r.op === "no" ? "" : ` ${r.op === "within_days" || r.op === "older_than_days" ? `${r.value} dias` : fmtRuleValue(r.value, f?.type as RuleType | undefined)}`;
  return `${f?.label ?? r.field}: ${op}${v}`;
}

function fmtRuleValue(v: unknown, type?: RuleType) {
  if (type === "date" && typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v.split("-").reverse().join("/");
  return String(v ?? "");
}

export function RulesEditor<R extends AnyRule = CrmRule>({ fields, initial, onApply, onCancel, onSave, opsByType = CRM_OPS, subject = "clientes" }: {
  fields: RuleField[]; initial: { match: "all" | "any"; items: R[] } | null;
  onApply: (r: { match: "all" | "any"; items: R[] } | null) => void; onCancel: () => void; onSave: (r: { match: "all" | "any"; items: R[] }) => void;
  /** operadores por tipo de campo (omissão: os do CRM) */
  opsByType?: Record<string, RuleOpDef[]>;
  /** "Mostrar <subject> que cumprem" */
  subject?: string;
}) {
  const first = fields[0];
  const opsOf = (type: string) => opsByType[type] ?? [];
  const blank = (): AnyRule => ({ field: first?.id ?? "", op: first ? opsOf(first.type)[0]?.id ?? "" : "", value: "" });
  const [match, setMatch] = useState<"all" | "any">(initial?.match ?? "all");
  const [items, setItems] = useState<AnyRule[]>(initial?.items?.length ? initial.items : [blank()]);
  const typeOf = (id: string) => fields.find((f) => f.id === id)?.type ?? "text";
  const opDef = (r: AnyRule) => opsOf(typeOf(r.field)).find((o) => o.id === r.op);
  const set = (i: number, patch: Partial<AnyRule>) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const filled = (v: unknown) => String(v ?? "").trim() !== "";
  const valid = items.filter((r) => {
    const a = arityOf(opDef(r));
    return r.field && opDef(r) && (a === 0 || (filled(r.value) && (a === 1 || filled(r.value2))));
  });
  const result = (): { match: "all" | "any"; items: R[] } | null => (valid.length
    ? { match, items: valid.map((r) => normRule(r, typeOf(r.field), arityOf(opDef(r))) as R) }
    : null);

  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border border-dashed border-[#b8c7e6] bg-muted p-3.5 dark:border-border">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-bold">Mostrar {subject} que cumprem</span>
        <Select value={match} onValueChange={(v) => setMatch(v as "all" | "any")}>
          <SelectTrigger className="h-[30px] w-44 max-w-full bg-card"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">todas as regras</SelectItem>
            <SelectItem value="any">pelo menos uma regra</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {items.map((r, i) => {
        const type = typeOf(r.field);
        const ops = opsOf(type);
        const arity = arityOf(opDef(r));
        const isDays = r.op === "within_days" || r.op === "older_than_days";
        const inputType = isDays || type === "number" ? "number" : type === "date" ? "date" : "text";
        const valueInput = (key: "value" | "value2", placeholder: string, cls: string) => (
          <Input
            className={cn("h-[34px] bg-card font-bold", cls)}
            type={inputType}
            inputMode={inputType === "number" ? "decimal" : undefined}
            value={String(r[key] ?? "")}
            placeholder={placeholder}
            aria-label={key === "value2" ? "Até" : "Valor"}
            onChange={(e) => set(i, { [key]: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") onApply(result()); }}
          />
        );
        return (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Select value={r.field} onValueChange={(v) => { const t = typeOf(v); set(i, { field: v, op: opsOf(t)[0]?.id ?? "", value: "", value2: "" }); }}>
              <SelectTrigger className="h-[34px] w-full bg-card sm:w-[250px]"><SelectValue placeholder="Campo" /></SelectTrigger>
              <SelectContent>{fields.map((f) => <SelectItem key={f.id} value={f.id}>{f.label}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={r.op} onValueChange={(v) => set(i, { op: v })}>
              <SelectTrigger className="h-[34px] w-[calc(100%-42px)] bg-card sm:w-[170px]"><SelectValue /></SelectTrigger>
              <SelectContent>{ops.map((o) => <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>)}</SelectContent>
            </Select>
            {/* telemóvel: o valor (ou os dois do "entre") e o X cabem na mesma linha */}
            {arity >= 1 && valueInput("value", isDays ? "dias" : type === "text" ? "valor (ex.: vermelho)" : arity === 2 ? "de" : "", arity === 2 ? "w-[calc(50%-25px)] sm:w-[120px]" : "w-[calc(100%-42px)] sm:w-[220px]")}
            {arity === 2 && valueInput("value2", "até", "w-[calc(50%-25px)] sm:w-[120px]")}
            <Button type="button" variant="outline" size="icon" className="h-[34px] w-[34px]" aria-label="Tirar regra"
              onClick={() => setItems((xs) => (xs.length > 1 ? xs.filter((_, j) => j !== i) : [blank()]))}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setItems((xs) => [...xs, blank()])}><Plus className="h-3.5 w-3.5" />Regra</Button>
        <div className="flex-1" />
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Fechar</Button>
        <Button type="button" variant="outline" size="sm" disabled={!valid.length} onClick={() => { const r = result(); if (r) onSave(r); }}>Guardar filtro</Button>
        <Button type="button" size="sm" onClick={() => onApply(result())}>Aplicar</Button>
      </div>
    </div>
  );
}

function normRule(r: AnyRule, type: string, arity: 0 | 1 | 2): AnyRule {
  const num = (v: unknown) => Number(String(v ?? "").trim().replace(",", ".")) || 0;
  const isDays = r.op === "within_days" || r.op === "older_than_days";
  const norm = (v: unknown) => (type === "number" || isDays ? num(v) : String(v ?? "").trim());
  if (arity === 0) return { field: r.field, op: r.op, value: null };
  if (arity === 1) return { field: r.field, op: r.op, value: norm(r.value) };
  return { field: r.field, op: r.op, value: norm(r.value), value2: norm(r.value2) };
}

// ─── Filtros guardados ──────────────────────────────────────────────────────

/** Página dos filtros guardados (a mesma tabela, server/savedFilters.ts). */
export type SavedFiltersPage = "crm" | "avaliacao";

/**
 * Lista + guardar + apagar dos filtros guardados de UMA página. Só lê a da
 * página pedida (quem vê a Avaliação pode não ter o CRM, e vice-versa).
 */
export function useSavedFilters(page: SavedFiltersPage) {
  const utils = trpc.useUtils();
  const crmList = trpc.crm.savedFilters.useQuery(undefined, { staleTime: 60_000, enabled: page === "crm" });
  const evalList = trpc.evaluation.savedFilters.useQuery(undefined, { staleTime: 60_000, enabled: page === "avaliacao" });
  const refresh = () => (page === "crm" ? utils.crm.savedFilters.invalidate() : utils.evaluation.savedFilters.invalidate());
  const opts = (ok: string) => ({ onSuccess: () => { void refresh(); toast.success(ok); }, onError: (e: { message: string }) => toast.error(e.message) });
  const crmSave = trpc.crm.saveFilter.useMutation(opts("Filtro guardado"));
  const evalSave = trpc.evaluation.saveFilter.useMutation(opts("Filtro guardado"));
  const crmDel = trpc.crm.deleteFilter.useMutation(opts("Filtro apagado"));
  const evalDel = trpc.evaluation.deleteFilter.useMutation(opts("Filtro apagado"));
  return page === "crm"
    ? { list: crmList, save: crmSave, del: crmDel }
    : { list: evalList, save: evalSave, del: evalDel };
}

export function SavedFiltersMenu<T>({ current, onApply, saveRequest, onSaveHandled, page = "crm", namePlaceholder = "Nome (ex.: Pro de Lisboa sem email)" }: {
  current: T; onApply: (payload: T, meta: { dropped: number }) => void;
  /** pedido para guardar vindo do editor de regras */
  saveRequest?: boolean; onSaveHandled?: () => void;
  page?: SavedFiltersPage;
  namePlaceholder?: string;
}) {
  const { list, save, del } = useSavedFilters(page);
  const [confirmDel, setConfirmDel] = useState<{ id: number; name: string; shared: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [isDefault, setIsDefault] = useState(false);
  const saving = !!saveRequest;

  return (
    <Popover open={open || !!saveRequest} onOpenChange={(o) => { setOpen(o); if (!o) onSaveHandled?.(); }}>
      <PopoverTrigger asChild>
        <SelButton onClick={() => setOpen(true)}><Star className="h-3.5 w-3.5" />Filtros guardados</SelButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-2">
        <div className="max-h-64 space-y-0.5 overflow-y-auto">
          {(list.data ?? []).length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">Ainda não há filtros guardados.</p>}
          {(list.data ?? []).map((f) => (
            <div key={f.id} className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted">
              <button type="button" className="min-w-0 flex-1 truncate text-left text-[13px] font-medium"
                onClick={() => { onApply(f.payload as T, { dropped: f.dropped ?? 0 }); setOpen(false); onSaveHandled?.(); }}>
                {f.isDefault && <Star className="mr-1 inline h-3 w-3 fill-amber-400 text-amber-400" />}
                {f.name}
                {!f.mine && <span className="ml-1 text-xs text-muted-foreground">· de {f.ownerName ?? "outro"}</span>}
                {f.mine && f.shared && <span className="ml-1 text-xs text-muted-foreground">· partilhado</span>}
              </button>
              {f.mine && (
                <button type="button" aria-label={`Apagar o filtro ${f.name}`} className="opacity-50 hover:opacity-100" onClick={() => setConfirmDel({ id: f.id, name: f.name, shared: f.shared })}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
        {confirmDel && (
          <div role="alertdialog" aria-label="Apagar filtro" className="mt-2 space-y-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-900 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
            <p>Apagar «{confirmDel.name}»?{confirmDel.shared ? " Está partilhado: desaparece também para a equipa." : ""}</p>
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => setConfirmDel(null)}>Cancelar</Button>
              <Button type="button" size="sm" variant="destructive" className="h-7" disabled={del.isPending}
                onClick={() => del.mutate({ id: confirmDel.id }, { onSettled: () => setConfirmDel(null) })}>Apagar</Button>
            </div>
          </div>
        )}
        <div className={cn("mt-2 space-y-2 border-t pt-2", saving && "rounded-md bg-secondary/60 p-2")}>
          <Label className="text-xs">Guardar o filtro atual</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={namePlaceholder} className="h-8" autoFocus={saving} />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <label className="flex items-center gap-2"><Switch checked={shared} onCheckedChange={setShared} />Partilhar com a equipa</label>
            <label className="flex items-center gap-2"><Switch checked={isDefault} onCheckedChange={setIsDefault} />Abrir com este</label>
          </div>
          <Button type="button" size="sm" className="w-full" disabled={!name.trim() || save.isPending}
            onClick={() => save.mutate({ name: name.trim(), payload: current, shared, isDefault }, { onSuccess: () => { setName(""); setOpen(false); onSaveHandled?.(); } })}>
            Guardar
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
