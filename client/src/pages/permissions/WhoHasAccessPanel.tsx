// "Quem tem acesso a X": para um módulo, cada conta ativa (da tua cidade, se
// não fores nacional) com o acesso efetivo — do papel ou de um override.
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MODULES, ROLE_LABELS, ACCESS_RANK, type ModuleId } from "@shared/access";
import { GrantBadge } from "./ModuleAccessPanel";

export default function WhoHasAccessPanel() {
  const [module, setModule] = useState<ModuleId>("despesas");
  const [q, setQ] = useState("");
  const { data = [], isLoading, error } = trpc.permissions.whoHasAccess.useQuery({ module });

  const groups = useMemo(() => [...new Set(MODULES.map((m) => m.group))], []);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data
      .filter((r) => !needle || `${r.name ?? ""} ${r.email ?? ""} ${r.role}`.toLowerCase().includes(needle))
      .sort((a, b) => ACCESS_RANK[b.grant.access] - ACCESS_RANK[a.grant.access] || (a.name ?? "").localeCompare(b.name ?? ""));
  }, [data, q]);
  const overrides = data.filter((r) => r.source === "override").length;

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
        <Select value={module} onValueChange={(v) => setModule(v as ModuleId)}>
          <SelectTrigger className="w-full sm:w-80"><SelectValue /></SelectTrigger>
          <SelectContent>
            {groups.map((g) => (
              <SelectGroup key={g}>
                <SelectLabel>{g}</SelectLabel>
                {MODULES.filter((m) => m.group === g).map((m) => <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>)}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        <Input className="w-full sm:w-64" placeholder="Filtrar pessoas…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="text-xs text-muted-foreground">{data.length} pessoa{data.length === 1 ? "" : "s"} · {overrides} por override</span>
      </div>
      {error && <p className="text-sm text-destructive">{error.message}</p>}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <p className="p-4 text-sm text-muted-foreground">A carregar…</p>
          ) : rows.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Ninguém tem acesso a este módulo.</p>
          ) : (
            <ul className="divide-y">
              {rows.map((r) => (
                <li key={r.id} className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{r.name ?? r.email ?? `#${r.id}`}</p>
                    <p className="text-[11px] text-muted-foreground truncate">{ROLE_LABELS[r.role as keyof typeof ROLE_LABELS] ?? r.role}{r.email ? ` · ${r.email}` : ""}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <GrantBadge g={r.grant} tone={r.source === "override" ? "override" : "role"} />
                    <Badge variant="secondary" className="text-[11px] font-normal">{r.source === "override" ? "override" : "papel"}</Badge>
                    {r.override?.expiresOn && !r.overrideExpired && <span className="text-[11px] text-muted-foreground">até {r.override.expiresOn}</span>}
                    {r.overrideExpired && <span className="text-[11px] text-muted-foreground">override expirado</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
