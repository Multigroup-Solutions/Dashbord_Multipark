// Página Sistema → Permissões (pedido Jorge 2026-08-06): todas as permissões,
// o que fazem, quem as tem, e dar/negar por utilizador.
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { ShieldCheck, Plus, X } from "lucide-react";

export default function PermissionsPage() {
  const utils = trpc.useUtils();
  const { data: catalog = [] } = trpc.permissions.catalog.useQuery();
  const { data: assignments = [], isLoading } = trpc.permissions.assignments.useQuery();
  const { data: users = [] } = trpc.users.list.useQuery();

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
    const m = new Map<string, typeof assignments>();
    for (const a of assignments as any[]) {
      if (!m.has(a.permission)) m.set(a.permission, [] as any);
      (m.get(a.permission) as any[]).push(a);
    }
    return m;
  }, [assignments]);

  const userOptions = useMemo(
    () => (users as any[])
      .filter((u) => u.isActive !== 0 && u.isActive !== false)
      .map((u) => ({ value: String(u.id), label: `${u.name ?? u.email ?? "#" + u.id}${u.email ? ` (${u.email})` : ""}` })),
    [users]
  );

  const categories = useMemo(() => {
    const cats = new Map<string, typeof catalog>();
    for (const p of catalog as any[]) {
      if (!cats.has(p.category)) cats.set(p.category, [] as any);
      (cats.get(p.category) as any[]).push(p);
    }
    return cats;
  }, [catalog]);

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-[1100px] mx-auto">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ShieldCheck className="w-6 h-6 text-primary" /> Permissões
        </h1>
        <p className="text-muted-foreground text-sm">
          Para além do papel (role), cada utilizador pode receber (✓ dar) ou perder (✕ negar) capacidades específicas.
        </p>
      </div>

      {/* Atribuir */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2"><Plus className="w-4 h-4" /> Atribuir permissão</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-72">
              <SearchableSelect options={userOptions} value={selUser} onChange={setSelUser} placeholder="Utilizador…" />
            </div>
            <Select value={selPerm} onValueChange={setSelPerm}>
              <SelectTrigger className="w-72"><SelectValue placeholder="Permissão…" /></SelectTrigger>
              <SelectContent>
                {(catalog as any[]).map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={selMode} onValueChange={(v) => setSelMode(v as any)}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
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

      {/* Catálogo + quem tem */}
      {Array.from(categories.entries()).map(([cat, perms]) => (
        <div key={cat} className="space-y-3">
          <h2 className="text-xs font-bold text-muted-foreground tracking-wider uppercase">{cat}</h2>
          {(perms as any[]).map((p) => {
            const holders = (byPermission.get(p.id) ?? []) as any[];
            return (
              <Card key={p.id}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-sm">{p.label} <code className="text-[10px] text-muted-foreground font-normal">{p.id}</code></p>
                      <p className="text-xs text-muted-foreground mt-0.5">{p.description}</p>
                      <p className="text-[11px] text-muted-foreground mt-1 italic">Sem override: {p.defaultBehavior}</p>
                    </div>
                    <div className="flex flex-wrap gap-1.5 max-w-[45%]">
                      {isLoading ? (
                        <span className="text-xs text-muted-foreground">…</span>
                      ) : holders.length === 0 ? (
                        <span className="text-xs text-muted-foreground">ninguém com override</span>
                      ) : (
                        holders.map((h) => (
                          <Badge
                            key={`${h.userId}`}
                            variant="outline"
                            className={`gap-1.5 text-xs ${h.mode === "grant" ? "border-green-300 bg-green-50 text-green-800" : "border-red-300 bg-red-50 text-red-800"}`}
                          >
                            {h.mode === "grant" ? "✓" : "✕"} {h.userName ?? h.userEmail ?? `#${h.userId}`}
                            <button
                              type="button"
                              title="Remover override"
                              className="hover:text-foreground"
                              onClick={() => setMut.mutate({ userId: h.userId, permission: p.id, mode: null })}
                            >
                              <X className="w-3 h-3" />
                            </button>
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
