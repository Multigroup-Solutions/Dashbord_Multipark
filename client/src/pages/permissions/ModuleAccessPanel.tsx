// Acessos por pessoa: para cada módulo da matriz, o padrão do papel, o
// override e o acesso efetivo. Mudar alcance/ações, dar validade ou repor o
// padrão. As regras (não dar mais do que se tem, módulos só do super admin,
// cidade, nunca a si próprio) vêm de shared/accessOverrides.ts e são
// verificadas outra vez no servidor.
import { useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Lock, RotateCcw, Save, Search } from "lucide-react";
import { ACCESS_RANK, ACTION_VALUES, ROLE_LABELS, type Access, type Action, type Grant } from "@shared/access";
import { ACCESS_LABELS_PT, ACTION_LABELS_PT, describeGrant } from "@shared/accessOverrides";
import { lisbonToday } from "@shared/expensePeriods";

const SCOPE_CHOICES: Access[] = ["none", "own", "below_city", "city", "national"];
const ACTION_SHORT: Record<Action, string> = { view: "Ver", edit: "Editar", export: "Exportar", manage: "Gerir" };

export function GrantBadge({ g, tone }: { g: Grant; tone?: "override" | "role" | "muted" }) {
  const cls = g.access === "none"
    ? "border-muted text-muted-foreground"
    : tone === "override"
      ? "border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100"
      : "border-emerald-300 bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100";
  return <Badge variant="outline" className={`text-[11px] font-normal whitespace-normal text-left ${cls}`}>{describeGrant(g)}</Badge>;
}

type Row = {
  module: string; label: string; group: string;
  roleDefault: Grant; effective: Grant; mine: Grant; lockReason: string | null;
  override: (Grant & { expiresOn?: string | null; note: string | null; grantedByName: string | null; updatedAt: string | null; expired: boolean }) | null;
};

function ModuleRow({ row, userId, onSaved }: { row: Row; userId: number; onSaved: () => void }) {
  const initial = row.override && !row.override.expired ? row.override : null;
  const [scope, setScope] = useState<Access | "default">(initial ? initial.access : "default");
  const [actions, setActions] = useState<Action[]>([...(initial?.actions ?? row.roleDefault.actions)]);
  const [expiresOn, setExpiresOn] = useState<string>(initial?.expiresOn ?? "");
  useEffect(() => {
    setScope(initial ? initial.access : "default");
    setActions([...(initial?.actions ?? row.roleDefault.actions)]);
    setExpiresOn(initial?.expiresOn ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.override?.access, row.override?.actions.join(), row.override?.expiresOn, row.override?.expired]);

  const mut = trpc.permissions.setModuleAccess.useMutation({
    onSuccess: () => { toast.success(`${row.label}: acesso atualizado`); onSaved(); },
    onError: (e) => toast.error(e.message),
  });

  const locked = !!row.lockReason;
  const scopeAllowed = (a: Access) => a === "none" || (row.mine.access !== "none" && ACCESS_RANK[a] <= ACCESS_RANK[row.mine.access]);
  const actionAllowed = (a: Action) => row.mine.actions.includes(a);
  const dirty = scope === "default"
    ? !!initial
    : !initial || initial.access !== scope || initial.actions.join() !== ACTION_VALUES.filter(a => a === "view" || actions.includes(a)).join()
      || (initial.expiresOn ?? "") !== expiresOn;

  const save = () => {
    if (scope === "default") return mut.mutate({ userId, module: row.module as any, grant: null });
    mut.mutate({ userId, module: row.module as any, grant: { access: scope, actions: scope === "none" ? [] : actions, expiresOn: expiresOn || null } });
  };

  return (
    <div className="flex flex-col lg:flex-row lg:items-center gap-2 py-3 border-b last:border-b-0">
      <div className="lg:w-56 min-w-0">
        <p className="text-sm font-medium flex items-center gap-1.5">
          {locked && <span title={row.lockReason ?? undefined}><Lock className="w-3 h-3 text-muted-foreground" /></span>}
          {row.label}
        </p>
        <div className="flex flex-wrap items-center gap-1 mt-1">
          <span className="text-[11px] text-muted-foreground">Papel:</span>
          <GrantBadge g={row.roleDefault} tone="role" />
        </div>
        {row.override && (
          <p className="text-[11px] text-muted-foreground mt-1">
            {row.override.expired ? "Override expirado" : "Override"}
            {row.override.grantedByName ? ` · por ${row.override.grantedByName}` : ""}
            {row.override.updatedAt ? ` · ${row.override.updatedAt.slice(0, 10)}` : ""}
            {row.override.expiresOn ? ` · até ${row.override.expiresOn}` : ""}
            {row.override.note ? ` · ${row.override.note}` : ""}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 flex-1">
        <Select value={scope} onValueChange={(v) => { setScope(v as Access | "default"); setActions((cur) => cur.filter(actionAllowed)); }} disabled={locked}>
          <SelectTrigger className="w-full sm:w-44 h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="default">Padrão do papel</SelectItem>
            {SCOPE_CHOICES.map((a) => (
              <SelectItem key={a} value={a} disabled={!scopeAllowed(a)}>
                {a === "none" ? "Retirar (sem acesso)" : ACCESS_LABELS_PT[a]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {scope !== "default" && scope !== "none" && (
          <div className="flex flex-wrap gap-1" role="group" aria-label="Ações">
            {ACTION_VALUES.map((a) => {
              const on = a === "view" || actions.includes(a);
              return (
                <button
                  key={a}
                  type="button"
                  disabled={locked || a === "view" || !actionAllowed(a)}
                  aria-pressed={on}
                  title={!actionAllowed(a) ? "Não tens esta ação neste módulo" : ACTION_LABELS_PT[a]}
                  onClick={() => setActions((cur) => cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a])}
                  className={`h-8 px-2.5 rounded-md border text-xs transition-colors disabled:opacity-50 ${on ? "bg-primary text-primary-foreground border-primary" : "bg-background hover:bg-muted"}`}
                >
                  {ACTION_SHORT[a]}
                </button>
              );
            })}
          </div>
        )}

        {scope !== "default" && (
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            até
            <Input type="date" className="h-8 w-36 text-xs" value={expiresOn} min={lisbonToday()} disabled={locked}
              onChange={(e) => setExpiresOn(e.target.value)} aria-label="Válido até (opcional)" />
          </label>
        )}
      </div>

      <div className="flex items-center gap-2 lg:w-64 lg:justify-end">
        <div className="flex-1 lg:flex-none"><GrantBadge g={row.effective} tone={initial ? "override" : "role"} /></div>
        {!locked && dirty && (
          <Button size="sm" className="h-8" onClick={save} disabled={mut.isPending}><Save className="w-3.5 h-3.5 mr-1" />Guardar</Button>
        )}
        {!locked && row.override && (
          <Button size="sm" variant="ghost" className="h-8" title="Repor padrão" disabled={mut.isPending}
            onClick={() => mut.mutate({ userId, module: row.module as any, grant: null })}>
            <RotateCcw className="w-3.5 h-3.5 mr-1" />Repor padrão
          </Button>
        )}
      </div>
    </div>
  );
}

export default function ModuleAccessPanel() {
  const utils = trpc.useUtils();
  const { data: people = [] } = trpc.permissions.people.useQuery();
  const [userId, setUserId] = useState("");
  const [q, setQ] = useState("");
  const [onlyOverrides, setOnlyOverrides] = useState(false);
  const detail = trpc.permissions.moduleAccessForUser.useQuery({ userId: Number(userId) }, { enabled: !!userId });

  const options = useMemo(() => people.map((u) => ({
    value: String(u.id),
    label: `${u.name ?? u.email ?? "#" + u.id} · ${ROLE_LABELS[u.role as keyof typeof ROLE_LABELS] ?? u.role}${u.editError ? " (só ver)" : ""}`,
  })), [people]);

  const groups = useMemo(() => {
    const rows = (detail.data?.rows ?? []) as Row[];
    const needle = q.trim().toLowerCase();
    const filtered = rows.filter((r) => (!needle || r.label.toLowerCase().includes(needle) || r.group.toLowerCase().includes(needle) || r.module.includes(needle))
      && (!onlyOverrides || r.override));
    const m = new Map<string, Row[]>();
    for (const r of filtered) { if (!m.has(r.group)) m.set(r.group, []); m.get(r.group)!.push(r); }
    return [...m.entries()];
  }, [detail.data, q, onlyOverrides]);

  const overrideCount = (detail.data?.rows ?? []).filter((r: any) => r.override && !r.override.expired).length;

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Escolhe uma pessoa e ajusta, módulo a módulo, o que ela vê e faz. Um override substitui o que o papel dá; "Repor padrão" volta ao papel.
        Não podes dar mais do que tens, nem mexer nos teus próprios acessos.
      </p>
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
        <div className="w-full sm:w-96">
          <SearchableSelect options={options} value={userId} onChange={setUserId} placeholder="Escolher pessoa…" searchPlaceholder="Procurar por nome ou email…" />
        </div>
        {detail.data && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="secondary">{ROLE_LABELS[detail.data.user.role as keyof typeof ROLE_LABELS] ?? detail.data.user.role}</Badge>
            <span>{overrideCount} override{overrideCount === 1 ? "" : "s"} ativo{overrideCount === 1 ? "" : "s"}</span>
          </div>
        )}
      </div>

      {userId && detail.isLoading && <p className="text-sm text-muted-foreground">A carregar…</p>}
      {detail.error && <p className="text-sm text-destructive">{detail.error.message}</p>}

      {detail.data && (
        <>
          {detail.data.editError && (
            <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950 px-3 py-2 text-sm text-amber-900 dark:text-amber-100 flex items-center gap-2">
              <Lock className="w-4 h-4 shrink-0" /> {detail.data.editError} Podes ver, mas não alterar.
            </div>
          )}
          <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
            <div className="relative w-full sm:w-72">
              <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-muted-foreground" />
              <Input className="pl-8" placeholder="Filtrar módulos…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={onlyOverrides} onCheckedChange={setOnlyOverrides} /> Só com override
            </label>
          </div>
          {groups.length === 0 && <p className="text-sm text-muted-foreground">Nenhum módulo corresponde ao filtro.</p>}
          {groups.map(([group, rows]) => (
            <Card key={group}>
              <CardContent className="p-4 pt-3">
                <h3 className="text-xs font-bold text-muted-foreground tracking-wider uppercase mb-1">{group}</h3>
                {rows.map((r) => (
                  <ModuleRow key={r.module} row={r} userId={Number(userId)}
                    onSaved={() => { utils.permissions.moduleAccessForUser.invalidate(); utils.permissions.whoHasAccess.invalidate(); }} />
                ))}
              </CardContent>
            </Card>
          ))}
        </>
      )}
    </div>
  );
}
