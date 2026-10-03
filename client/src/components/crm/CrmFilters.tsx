/**
 * CRM — controlos de filtro da lista (do Odoo ficaram só os filtros, Jorge):
 * grupos de escolha múltipla (OU dentro do grupo, E entre grupos), regras
 * específicas ("carro vermelho, saiu a 10 set, com familiar cliente") e
 * filtros guardados.
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
import { OPS_BY_TYPE, type CrmRule, type RuleOp, type RuleType } from "@shared/crmFilters";

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

// ─── Regras ─────────────────────────────────────────────────────────────────

export type RuleField = { id: string; label: string; type: RuleType };
export type RulesState = { match: "all" | "any"; items: CrmRule[] };

export function ruleText(r: CrmRule, fields: RuleField[]): string {
  const f = fields.find((x) => x.id === r.field);
  const op = f ? OPS_BY_TYPE[f.type].find((o) => o.id === r.op)?.label : r.op;
  const v = r.op === "yes" || r.op === "no" ? "" : ` ${r.op === "within_days" || r.op === "older_than_days" ? `${r.value} dias` : fmtRuleValue(r.value, f?.type)}`;
  return `${f?.label ?? r.field}: ${op}${v}`;
}

function fmtRuleValue(v: unknown, type?: RuleType) {
  if (type === "date" && typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v.split("-").reverse().join("/");
  return String(v ?? "");
}

export function RulesEditor({ fields, initial, onApply, onCancel, onSave }: {
  fields: RuleField[]; initial: RulesState | null;
  onApply: (r: RulesState | null) => void; onCancel: () => void; onSave: (r: RulesState) => void;
}) {
  const first = fields[0];
  const blank = (): CrmRule => ({ field: first?.id ?? "", op: first ? OPS_BY_TYPE[first.type][0].id : "is", value: "" });
  const [match, setMatch] = useState<"all" | "any">(initial?.match ?? "all");
  const [items, setItems] = useState<CrmRule[]>(initial?.items?.length ? initial.items : [blank()]);
  const typeOf = (id: string) => fields.find((f) => f.id === id)?.type ?? "text";
  const set = (i: number, patch: Partial<CrmRule>) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const valid = items.filter((r) => r.field && (r.op === "yes" || r.op === "no" || String(r.value ?? "").trim() !== ""));
  const result = (): RulesState | null => (valid.length ? { match, items: valid.map((r) => ({ ...r, value: normValue(r, typeOf(r.field)) })) } : null);

  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border border-dashed border-[#b8c7e6] bg-muted p-3.5 dark:border-border">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-bold">Mostrar clientes que cumprem</span>
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
        const ops = OPS_BY_TYPE[type];
        const needsValue = r.op !== "yes" && r.op !== "no";
        const isDays = r.op === "within_days" || r.op === "older_than_days";
        return (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Select value={r.field} onValueChange={(v) => { const t = typeOf(v); set(i, { field: v, op: OPS_BY_TYPE[t][0].id, value: "" }); }}>
              <SelectTrigger className="h-[34px] w-full bg-card sm:w-[250px]"><SelectValue placeholder="Campo" /></SelectTrigger>
              <SelectContent>{fields.map((f) => <SelectItem key={f.id} value={f.id}>{f.label}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={r.op} onValueChange={(v) => set(i, { op: v as RuleOp })}>
              <SelectTrigger className="h-[34px] w-[calc(100%-42px)] bg-card sm:w-[170px]"><SelectValue /></SelectTrigger>
              <SelectContent>{ops.map((o) => <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>)}</SelectContent>
            </Select>
            {needsValue && (
              <Input
                className="h-[34px] w-full bg-card font-bold sm:w-[220px]"
                type={isDays || type === "number" ? "number" : type === "date" ? "date" : "text"}
                value={String(r.value ?? "")}
                placeholder={isDays ? "dias" : type === "text" ? "valor (ex.: vermelho)" : ""}
                onChange={(e) => set(i, { value: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") onApply(result()); }}
              />
            )}
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

function normValue(r: CrmRule, type: RuleType): string | number | null {
  if (r.op === "yes" || r.op === "no") return null;
  if (type === "number" || r.op === "within_days" || r.op === "older_than_days") return Number(r.value) || 0;
  return String(r.value ?? "").trim();
}

// ─── Filtros guardados ──────────────────────────────────────────────────────

export function SavedFiltersMenu<T>({ current, onApply, saveRequest, onSaveHandled }: {
  current: T; onApply: (payload: T, meta: { dropped: number }) => void;
  /** pedido para guardar vindo do editor de regras */
  saveRequest?: boolean; onSaveHandled?: () => void;
}) {
  const utils = trpc.useUtils();
  const list = trpc.crm.savedFilters.useQuery(undefined, { staleTime: 60_000 });
  const save = trpc.crm.saveFilter.useMutation({ onSuccess: () => { utils.crm.savedFilters.invalidate(); toast.success("Filtro guardado"); }, onError: (e) => toast.error(e.message) });
  const del = trpc.crm.deleteFilter.useMutation({ onSuccess: () => { utils.crm.savedFilters.invalidate(); toast.success("Filtro apagado"); }, onError: (e) => toast.error(e.message) });
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
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome (ex.: Pro de Lisboa sem email)" className="h-8" autoFocus={saving} />
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
