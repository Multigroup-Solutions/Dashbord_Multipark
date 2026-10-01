/**
 * Definições → Parâmetros → "Serviços → tarefas": por cidade e por tipo de
 * serviço extra (catálogo ExtraService da Multipark, agrupado por tipo), se
 * gera tarefa e quem é o responsável (opcional). Os team leaders do turno da
 * saída e do anterior entram sempre. Grava a definição "services.taskRules".
 */
import { useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { toast } from "sonner";
import { AlertTriangle, ListChecks, Loader2, Save } from "lucide-react";
import {
  DEFAULT_SERVICE_TASK_RULES, SERVICE_TASK_CITIES, SERVICE_TASK_CITY_LABELS, SERVICE_TASKS_SETTING_KEY,
  serviceTaskRulesSchema, type ServiceTaskCity, type ServiceTaskRules,
} from "@shared/serviceTasks";

const NONE = "__none__";

export function ServiceTasksSettings() {
  const utils = trpc.useUtils();
  const values = trpc.settings.values.list.useQuery();
  const catalog = trpc.settings.serviceTasks.catalog.useQuery(undefined, { staleTime: 5 * 60_000 });
  const save = trpc.settings.values.set.useMutation({
    onSuccess: (r) => { utils.settings.values.invalidate(); toast.success(r.changed ? "Guardado." : "Sem alterações."); },
    onError: (e) => toast.error(e.message),
  });

  const stored = useMemo<ServiceTaskRules>(() => {
    const row = values.data?.find((s) => s.key === SERVICE_TASKS_SETTING_KEY);
    const parsed = serviceTaskRulesSchema.safeParse(row?.isSet ? row.value : DEFAULT_SERVICE_TASK_RULES);
    return parsed.success ? parsed.data : DEFAULT_SERVICE_TASK_RULES;
  }, [values.data]);

  const [rules, setRules] = useState<ServiceTaskRules>(stored);
  const [city, setCity] = useState<ServiceTaskCity>("lisbon");
  useEffect(() => { setRules(stored); }, [stored]);
  const dirty = JSON.stringify(rules) !== JSON.stringify(stored);

  // Tipos do catálogo + os que já estão configurados mas saíram do catálogo.
  const types = useMemo(() => {
    const fromCatalog = catalog.data?.cities[city] ?? [];
    const keys = new Set(fromCatalog.map((t) => t.key));
    const extra = Object.keys(rules[city] ?? {}).filter((k) => !keys.has(k))
      .map((k) => ({ key: k, label: k, names: [] as string[], parks: 0, orphan: true }));
    return [...fromCatalog.map((t) => ({ ...t, orphan: false })), ...extra];
  }, [catalog.data, city, rules]);

  const people = catalog.data?.employees[city] ?? [];
  const options = useMemo(() => [
    { value: NONE, label: "Só os team leaders do turno" },
    ...people.map((p) => ({ value: String(p.id), label: p.fullName })),
  ], [people]);

  const setRule = (key: string, patch: { enabled?: boolean; responsibleEmployeeId?: number | null }) => {
    setRules((prev) => {
      const cur = prev[city]?.[key] ?? { enabled: false, responsibleEmployeeId: null };
      return { ...prev, [city]: { ...prev[city], [key]: { ...cur, ...patch } } };
    });
  };

  const enabledCount = (c: ServiceTaskCity) => Object.values(rules[c] ?? {}).filter((r) => r.enabled).length;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><ListChecks className="h-4 w-4" />Serviços → tarefas</CardTitle>
        <p className="text-xs text-muted-foreground">
          Para cada tipo de serviço extra das reservas (lista lida do catálogo da Multipark), escolhe se cada reserva com esse serviço gera uma
          tarefa em <strong>Tarefas</strong>, com prazo na <strong>saída do carro</strong>. Os <strong>team leaders do turno da saída e do turno anterior</strong> (escala
          do Extras-Dia) são sempre responsáveis; podes juntar uma pessoa da cidade. A tarefa nasce quando chega o webhook da reserva (saídas até 72 h); as mais longe nascem na volta diária das 18:00 (saídas nas próximas 48 h). O que falhar no webhook repete-se de hora a hora. Mudanças aqui chegam às tarefas já criadas na volta seguinte.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {SERVICE_TASK_CITIES.map((c) => (
            <Button key={c} size="sm" variant={c === city ? "default" : "outline"} onClick={() => setCity(c)}>
              {SERVICE_TASK_CITY_LABELS[c]}
              {enabledCount(c) > 0 && <Badge variant="secondary" className="ml-2">{enabledCount(c)}</Badge>}
            </Button>
          ))}
        </div>
        {catalog.isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
        {catalog.data && !catalog.data.available && (
          <p className="text-xs text-amber-800"><AlertTriangle className="inline h-3 w-3 mr-1" />Não foi possível ler o catálogo da Multipark: {catalog.data.reason ?? "indisponível"}</p>
        )}
        {catalog.data?.available && types.length === 0 && (
          <p className="text-sm text-muted-foreground">Sem serviços no catálogo dos parques de {SERVICE_TASK_CITY_LABELS[city]}.</p>
        )}
        <div className="divide-y rounded-md border">
          {types.map((t) => {
            const r = rules[city]?.[t.key];
            return (
              <div key={t.key} className="p-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm">{t.label}{t.orphan && <Badge variant="outline" className="ml-2 text-[10px]">já não está no catálogo</Badge>}</div>
                  {t.names.length > 0 && <div className="text-xs text-muted-foreground truncate" title={t.names.join(", ")}>{t.names.join(", ")}{t.parks ? ` · ${t.parks} parque(s)` : ""}</div>}
                </div>
                <label className="flex items-center gap-2 text-sm shrink-0">
                  <Switch checked={!!r?.enabled} onCheckedChange={(v) => setRule(t.key, { enabled: v })} />
                  Gera tarefa
                </label>
                <div className="w-full sm:w-64 shrink-0">
                  <SearchableSelect
                    value={r?.responsibleEmployeeId ? String(r.responsibleEmployeeId) : NONE}
                    onChange={(v) => setRule(t.key, { responsibleEmployeeId: v === NONE ? null : Number(v) })}
                    options={r?.responsibleEmployeeId && !people.some((p) => p.id === r.responsibleEmployeeId)
                      ? [...options, { value: String(r.responsibleEmployeeId), label: `Ficha #${r.responsibleEmployeeId}` }]
                      : options}
                    placeholder="Responsável (opcional)"
                    searchPlaceholder="Procurar pessoa…"
                    emptyText="Ninguém com esse nome nesta cidade."
                    disabled={!r?.enabled}
                  />
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex gap-2">
          <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate({ key: SERVICE_TASKS_SETTING_KEY, value: rules })}>
            {save.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}Guardar
          </Button>
          {dirty && <Button size="sm" variant="ghost" onClick={() => setRules(stored)}>Descartar</Button>}
        </div>
      </CardContent>
    </Card>
  );
}
