// Definições → Notificações: "Regras das notificações" — matriz tipo × papel.
// As omissões vêm do código (shared/notificationRouting.ts); o super_admin
// sobrepõe-nas (app_settings `notifications.routing`, validado por zod no
// servidor). Um papel sem acesso ao módulo na matriz de acessos nunca pode
// receber (aparece "—"); o super_admin recebe sempre (cada pessoa silencia no
// seu Perfil).
import { Fragment, useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { Loader2, Lock, RotateCcw, Save } from "lucide-react";
import { ROLES, ROLE_LABELS, type Role } from "@shared/access";
import {
  HOME_CITY_ROLES, NOTIFICATION_GROUP_LABELS, kindDef, notificationRoutingSchema,
  type NotificationGroup, type RoutingTableRow,
} from "@shared/notificationRouting";

type Draft = { roles: Record<string, Role[]>; email: Record<string, boolean>; homeCityOnly: Role[] };

function draftFrom(table: RoutingTableRow[], homeCityOnly: readonly string[]): Draft {
  return {
    roles: Object.fromEntries(table.map((r) => [r.kind, [...r.roles]])),
    email: Object.fromEntries(table.filter((r) => r.email).map((r) => [r.kind, r.emailDefault])),
    homeCityOnly: [...homeCityOnly] as Role[],
  };
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

export function NotificationRoutingCard() {
  const utils = trpc.useUtils();
  const q = trpc.notifications.routing.useQuery();
  const save = trpc.notifications.saveRouting.useMutation({
    onSuccess: (r) => { utils.notifications.routing.invalidate(); utils.notifications.prefs.invalidate(); toast.success(r.changed ? "Regras guardadas." : "Sem alterações."); },
    onError: (e) => toast.error(e.message),
  });
  const table = q.data?.table ?? [];
  const editable = !!q.data?.editable;
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => { if (q.data) setDraft(draftFrom(q.data.table, q.data.routing.homeCityOnly)); }, [q.data]);

  // Só as colunas dos papéis que podem receber algum tipo.
  const roleCols = useMemo(() => ROLES.filter((r) => table.some((t) => t.allowedRoles.includes(r))), [table]);
  const groups = useMemo(() => (Object.keys(NOTIFICATION_GROUP_LABELS) as NotificationGroup[])
    .map((g) => ({ g, rows: table.filter((t) => t.group === g) })).filter((x) => x.rows.length), [table]);

  if (q.isLoading || !draft) return <Loader2 className="h-4 w-4 animate-spin" />;
  if (q.error) return <p className="text-sm text-destructive">{q.error.message}</p>;

  const toggleRole = (kind: string, role: Role, on: boolean) => setDraft((d) => d && ({
    ...d, roles: { ...d.roles, [kind]: on ? [...new Set([...(d.roles[kind] ?? []), role])] : (d.roles[kind] ?? []).filter((r) => r !== role) },
  }));

  // Grava só o que difere das omissões do código.
  const buildValue = () => {
    const kinds: Record<string, { roles?: Role[]; email?: boolean }> = {};
    for (const t of table) {
      const o: { roles?: Role[]; email?: boolean } = {};
      if (!t.personal && !same(draft.roles[t.kind] ?? [], t.defaultRoles)) o.roles = draft.roles[t.kind] ?? [];
      const codeEmail = !!kindDef(t.kind)?.emailDefault;
      if (t.email && draft.email[t.kind] !== undefined && draft.email[t.kind] !== codeEmail) o.email = draft.email[t.kind];
      if (Object.keys(o).length) kinds[t.kind] = o;
    }
    return { kinds, homeCityOnly: draft.homeCityOnly };
  };
  const onSave = () => {
    const value = buildValue();
    const v = notificationRoutingSchema.safeParse(value);
    if (!v.success) { toast.error(v.error.issues.map((i) => i.message).join(" ")); return; }
    save.mutate({ value });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2 flex-wrap">
            Regras das notificações
            {!editable && <Badge variant="outline"><Lock className="h-3 w-3 mr-1" />Só o super admin altera</Badge>}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Quem recebe cada tipo, por papel. Os papéis de cidade só recebem da(s) sua(s) cidade(s); o super admin recebe tudo, de todas as cidades.
            "—" = o papel não tem esse módulo na matriz de acessos. Overrides por pessoa (Permissões) também dão a notificação. Cada pessoa pode silenciar no Perfil (exceto as obrigatórias).
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-x-auto -mx-3 sm:mx-0">
            <table className="w-full text-xs border-collapse min-w-[640px]">
              <thead>
                <tr className="border-b">
                  <th className="text-left font-semibold p-2 sticky left-0 bg-card z-10 min-w-[11rem]">Tipo</th>
                  {roleCols.map((r) => <th key={r} className="p-1.5 font-semibold text-center whitespace-nowrap">{ROLE_LABELS[r]}</th>)}
                  <th className="p-1.5 font-semibold text-center">Email</th>
                </tr>
              </thead>
              <tbody>
                {groups.map(({ g, rows }) => (
                  <Fragment key={g}>
                    <tr><td colSpan={roleCols.length + 2} className="pt-3 pb-1 px-2 text-[11px] uppercase tracking-wide text-muted-foreground font-semibold sticky left-0 bg-card">{NOTIFICATION_GROUP_LABELS[g]}</td></tr>
                    {rows.map((t) => (
                      <tr key={t.kind} className="border-b border-border/60 align-middle">
                        <td className="p-2 sticky left-0 bg-card z-10">
                          <div className="font-medium flex items-center gap-1">{t.label}{t.mandatory && <Lock className="h-3 w-3 text-muted-foreground" aria-label="Obrigatória" />}</div>
                          <div className="text-[10.5px] text-muted-foreground">{t.cityScoped ? "Por cidade" : "Nacional"} · módulo {t.module}</div>
                        </td>
                        {t.personal ? (
                          <td colSpan={roleCols.length} className="p-1.5 text-center text-muted-foreground">Pessoal — só a pessoa a quem se refere{t.mandatory ? " (obrigatória)" : ""}</td>
                        ) : roleCols.map((r) => {
                          const allowed = t.allowedRoles.includes(r);
                          if (!allowed) return <td key={r} className="p-1.5 text-center text-muted-foreground">—</td>;
                          const checked = r === "super_admin" || (draft.roles[t.kind] ?? []).includes(r);
                          return (
                            <td key={r} className="p-1.5 text-center">
                              <Checkbox
                                checked={checked}
                                disabled={!editable || r === "super_admin"}
                                onCheckedChange={(v) => toggleRole(t.kind, r, v === true)}
                                aria-label={`${t.label}: ${ROLE_LABELS[r]}`}
                              />
                            </td>
                          );
                        })}
                        <td className="p-1.5 text-center">
                          {t.email ? (
                            <Checkbox
                              checked={!!draft.email[t.kind]}
                              disabled={!editable}
                              onCheckedChange={(v) => setDraft((d) => d && ({ ...d, email: { ...d.email, [t.kind]: v === true } }))}
                              aria-label={`${t.label}: email por omissão`}
                            />
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rounded-lg border p-3 space-y-2">
            <div className="text-sm font-semibold">Papéis nacionais só da própria cidade</div>
            <p className="text-xs text-muted-foreground">Marcado = esse papel só recebe as notificações da(s) cidade(s) do seu centro de custos (e das cidades dadas), em vez de todas.</p>
            <div className="flex flex-wrap gap-4">
              {HOME_CITY_ROLES.map((r) => (
                <label key={r} className="flex items-center gap-2 text-sm min-h-[36px]">
                  <Checkbox
                    checked={draft.homeCityOnly.includes(r)}
                    disabled={!editable}
                    onCheckedChange={(v) => setDraft((d) => d && ({ ...d, homeCityOnly: v === true ? [...new Set([...d.homeCityOnly, r])] : d.homeCityOnly.filter((x) => x !== r) }))}
                  />
                  {ROLE_LABELS[r]}
                </label>
              ))}
            </div>
          </div>

          {editable && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={onSave} disabled={save.isPending}>
                {save.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}Guardar regras
              </Button>
              <Button size="sm" variant="outline" disabled={save.isPending} onClick={() => save.mutate({ value: null })}>
                <RotateCcw className="h-4 w-4 mr-1" />Repor as regras do código
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
