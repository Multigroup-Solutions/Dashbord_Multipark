// Permissões especiais (catálogo antigo, shared/permissions.ts): TL na escala,
// totais financeiros e cidades extra. Continuam a valer ao lado dos acessos
// por módulo — não são módulos da matriz.
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { canGrantPermissionsTo, canTouchPermission } from "@shared/access";

export default function LegacyPermissionsPanel() {
  const utils = trpc.useUtils();
  const { user: me } = useAuth();
  const { data: catalog = [] } = trpc.permissions.catalog.useQuery();
  const { data: assignments = [], isLoading } = trpc.permissions.assignments.useQuery();
  const { data: people = [] } = trpc.permissions.people.useQuery();

  const setMut = trpc.permissions.setForUser.useMutation({
    onSuccess: () => {
      utils.permissions.assignments.invalidate();
      toast.success("Permissão atualizada");
    },
    onError: (e) => toast.error(e.message),
  });

  const [selUser, setSelUser] = useState("");
  const [selPerm, setSelPerm] = useState("");
  const [selMode, setSelMode] = useState<"grant" | "deny">("grant");

  const byPermission = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const a of assignments as any[]) {
      if (!m.has(a.permission)) m.set(a.permission, []);
      m.get(a.permission)!.push(a);
    }
    return m;
  }, [assignments]);

  const userOptions = useMemo(
    () => people
      .filter((u) => u.id !== me?.id && canGrantPermissionsTo(me, u.role))
      .map((u) => ({ value: String(u.id), label: `${u.name ?? u.email ?? "#" + u.id}${u.email ? ` (${u.email})` : ""}` })),
    [people, me],
  );

  const categories = useMemo(() => {
    const cats = new Map<string, any[]>();
    for (const p of catalog as any[]) {
      if (!cats.has(p.category)) cats.set(p.category, []);
      cats.get(p.category)!.push(p);
    }
    return cats;
  }, [catalog]);

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        Capacidades que não são módulos do menu: ser escolhido como TL na escala, ver os totais financeiros e cidades extra.
        Dar (✓) ou negar (✕) por pessoa.
      </p>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2"><Plus className="w-4 h-4" /> Atribuir permissão especial</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2">
            <div className="w-full sm:w-72">
              <SearchableSelect options={userOptions} value={selUser} onChange={setSelUser} placeholder="Utilizador…" />
            </div>
            <Select value={selPerm} onValueChange={setSelPerm}>
              <SelectTrigger className="w-full sm:w-72"><SelectValue placeholder="Permissão…" /></SelectTrigger>
              <SelectContent>
                {(catalog as any[]).filter((p) => canTouchPermission(me, p.id)).map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={selMode} onValueChange={(v) => setSelMode(v as "grant" | "deny")}>
              <SelectTrigger className="w-full sm:w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="grant">✓ Dar</SelectItem>
                <SelectItem value="deny">✕ Negar</SelectItem>
              </SelectContent>
            </Select>
            <Button
              disabled={!selUser || !selPerm || setMut.isPending}
              onClick={() => setMut.mutate({ userId: Number(selUser), permission: selPerm, mode: selMode })}
            >
              Aplicar
            </Button>
          </div>
        </CardContent>
      </Card>

      {Array.from(categories.entries()).map(([cat, perms]) => (
        <div key={cat} className="space-y-3">
          <h2 className="text-xs font-bold text-muted-foreground tracking-wider uppercase">{cat}</h2>
          {perms.map((p) => {
            const holders = byPermission.get(p.id) ?? [];
            return (
              <Card key={p.id}>
                <CardContent className="p-4">
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-sm">{p.label} <code className="text-[10px] text-muted-foreground font-normal">{p.id}</code></p>
                      <p className="text-xs text-muted-foreground mt-0.5">{p.description}</p>
                      <p className="text-[11px] text-muted-foreground mt-1 italic">Sem override: {p.defaultBehavior}</p>
                    </div>
                    <div className="flex flex-wrap gap-1.5 sm:max-w-[45%]">
                      {isLoading ? (
                        <span className="text-xs text-muted-foreground">…</span>
                      ) : holders.length === 0 ? (
                        <span className="text-xs text-muted-foreground">ninguém com override</span>
                      ) : (
                        holders.map((h) => (
                          <Badge
                            key={`${h.userId}`}
                            variant="outline"
                            className={`gap-1.5 text-xs ${h.mode === "grant" ? "border-green-300 bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200" : "border-red-300 bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200"}`}
                          >
                            {h.mode === "grant" ? "✓" : "✕"} {h.userName ?? h.userEmail ?? `#${h.userId}`}
                            {h.canManage !== false && h.userId !== me?.id && (
                              <button
                                type="button"
                                title="Remover override"
                                aria-label="Remover override"
                                className="hover:text-foreground"
                                onClick={() => setMut.mutate({ userId: h.userId, permission: p.id, mode: null })}
                              >
                                <X className="w-3 h-3" />
                              </button>
                            )}
                          </Badge>
                        ))
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ))}
    </div>
  );
}
