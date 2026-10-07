/**
 * Lote 42b — Pessoas → Condutores e agentes: primeiro a LISTA (uma linha por
 * pessoa, com os totais do período), depois o detalhe.
 *  - Condutores: recolhas, entregas, movimentos e km do GPS;
 *  - Agentes: todas as ações (reservas criadas, alterações, mudanças de lugar…).
 * Clicar no NOME abre a ficha; clicar num NÚMERO abre a lista desses
 * movimentos. O filtro de cidade e marca é o do topo da app; aqui escolhe-se o
 * período e a pessoa. Quem gere o RH une/separa (Ligações) e tira da lista
 * agentes que não interessam (fica como "não é funcionário", desfaz-se no RH).
 */
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { can } from "@shared/access";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { useOpenEmployee } from "@/hooks/useOpenEmployee";
import { lisbonDayOf } from "@shared/lisbonDay";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { movementLabel } from "@shared/multiparkMovements";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { Th, useTableSort } from "@/components/SortableTable";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { PersonLinksDialog } from "@/components/PersonLinksDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { EyeOff, Link2, Loader2 } from "lucide-react";
import { toast } from "sonner";

export function monthToDate(): { start: string; end: string } {
  const today = lisbonDayOf(new Date());
  return { start: `${today.slice(0, 8)}01`, end: today };
}

type Row = {
  key: string; employeeId: number | null; name: string; kind: string; agentUserIds: string[]; agentName: string | null;
  recolhas: number; entregas: number; movements: number; spotChanges: number; bookings: number; total: number;
  byType: Record<string, number>; lastAt: string | null; km: number | null;
};

/** O que cada coluna clicável mostra no detalhe (changeType da Multipark). */
const COLUMN_TYPES: Record<string, string[] | null> = {
  recolhas: ["CHECK_IN"],
  entregas: ["CHECK_OUT"],
  movements: ["MOVEMENT"],
  total: null,
};

export interface DetailTarget { employeeId: number | null; agentUserIds: string[]; name: string; types: string[] | null; label: string }

export function MovementPeoplePanel({ mode, initialDetail }: { mode: "drivers" | "agents"; initialDetail?: DetailTarget | null }) {
  const { user } = useAuth();
  const canManageRh = !!user && can(user as any, "rh", "manage");
  const { projectId } = useGlobalFilters();
  const openEmployee = useOpenEmployee();
  const utils = trpc.useUtils();
  const [{ start, end }, setRange] = useState(monthToDate);
  const [person, setPerson] = useState("");
  const [q, setQ] = useState("");
  const [detail, setDetail] = useState<DetailTarget | null>(initialDetail ?? null);
  const [links, setLinks] = useState<{ employeeId: number; name: string } | null>(null);
  const valid = !!start && !!end && start <= end;
  const listQ = trpc.reviews.movementPeople.useQuery({ startDate: start, endDate: end, projectId, drivers: mode === "drivers" }, { enabled: valid, refetchOnWindowFocus: false });
  const data = listQ.data;
  const all = (data && data.available ? data.rows : []) as Row[];
  const options = useMemo(() => all.map((r) => ({ value: r.key, label: `${r.name}${r.kind === "por_ligar" ? " (sem ficha)" : r.kind === "parceiro" ? " (parceiro)" : ""}` })), [all]);
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return all.filter((r) => (!person || r.key === person)
      && (!t || r.name.toLowerCase().includes(t) || (r.agentName ?? "").toLowerCase().includes(t) || r.agentUserIds.some((id) => id.toLowerCase().includes(t))));
  }, [all, person, q]);
  const sort = useTableSort(rows, mode === "drivers" ? "entregas" : "total", -1);
  const ignore = trpc.multipark.ignoreAgent.useMutation({
    onSuccess: () => { toast.success("Tirado da lista (fica como \"não é funcionário\"; desfaz-se no RH → Agentes)."); utils.reviews.movementPeople.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const totals = useMemo(() => rows.reduce((s, r) => ({ recolhas: s.recolhas + r.recolhas, entregas: s.entregas + r.entregas, movements: s.movements + r.movements, total: s.total + r.total, km: s.km + (r.km ?? 0) }), { recolhas: 0, entregas: 0, movements: 0, total: 0, km: 0 }), [rows]);

  const num = (r: Row, k: keyof typeof COLUMN_TYPES, label: string) => {
    const v = r[k as keyof Row] as number;
    if (!v) return <span className="text-muted-foreground">·</span>;
    return (
      <button type="button" className="tabular-nums underline decoration-dotted underline-offset-4 hover:text-primary" title={`Ver ${label.toLowerCase()}`}
        onClick={() => setDetail({ employeeId: r.employeeId, agentUserIds: r.agentUserIds, name: r.name, types: COLUMN_TYPES[k], label })}>
        {v}
      </button>
    );
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{mode === "drivers" ? "Condutores" : "Agentes"}</CardTitle>
        <p className="text-xs text-muted-foreground">
          {mode === "drivers"
            ? "Quem recolheu, entregou ou moveu carros no período (lido ao vivo da Multipark) e os km do GPS do Zello."
            : "Todos os agentes da Multipark com ações no período: recolhas, entregas, movimentos, mudanças de lugar, reservas criadas e alterações."}
          {" "}Cidade e marca: o filtro do topo. Clica no nome para abrir a ficha e num número para ver esses movimentos.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div><Label className="text-xs">De</Label><Input type="date" value={start} onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))} className="w-40" /></div>
          <div><Label className="text-xs">Até</Label><Input type="date" value={end} onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))} className="w-40" /></div>
          <div className="min-w-[220px] flex-1">
            <Label className="text-xs">{mode === "drivers" ? "Condutor" : "Pessoa / agente"}</Label>
            <SearchableSelect value={person} onChange={setPerson} options={[{ value: "", label: mode === "drivers" ? "Todos os condutores" : "Todos" }, ...options]}
              placeholder={mode === "drivers" ? "Todos os condutores" : "Todos"} searchPlaceholder="Procurar nome…" className="w-full" />
          </div>
          {mode === "agents" && (
            <div className="min-w-[180px]"><Label className="text-xs">Nome ou código do agente</Label>
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Procurar…" className="w-full" /></div>
          )}
          {listQ.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>

        {!valid ? <p className="text-sm text-muted-foreground">A data "De" tem de ser antes de "Até".</p>
          : listQ.error ? <QueryErrorNote error={listQ.error} onRetry={() => listQ.refetch()} retrying={listQ.isFetching} what="os movimentos (BD da Multipark)" />
          : data && !data.available ? <p className="text-sm text-amber-700">{data.reason}</p>
          : listQ.isLoading ? <p className="text-sm text-muted-foreground">A ler a Multipark…</p>
          : rows.length === 0 ? <p className="text-sm text-muted-foreground">Ninguém com movimentos neste período{person || q ? " com esse filtro" : ""}.</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead><tr className="border-b text-left text-xs">
                  <Th k="name" label="Pessoa" sortKey={sort.sortKey} sortDir={sort.sortDir} onToggle={sort.toggle} />
                  {mode === "agents" && <Th k="total" label="Ações" align="right" sortKey={sort.sortKey} sortDir={sort.sortDir} onToggle={sort.toggle} />}
                  <Th k="recolhas" label="Recolhas" align="right" sortKey={sort.sortKey} sortDir={sort.sortDir} onToggle={sort.toggle} />
                  <Th k="entregas" label="Entregas" align="right" sortKey={sort.sortKey} sortDir={sort.sortDir} onToggle={sort.toggle} />
                  <Th k="movements" label="Movimentos" align="right" sortKey={sort.sortKey} sortDir={sort.sortDir} onToggle={sort.toggle} />
                  {mode === "drivers"
                    ? <Th k="km" label="Km (GPS)" align="right" sortKey={sort.sortKey} sortDir={sort.sortDir} onToggle={sort.toggle} />
                    : <>
                        <Th k="spotChanges" label="Mudanças de lugar" align="right" sortKey={sort.sortKey} sortDir={sort.sortDir} onToggle={sort.toggle} />
                        <Th k="bookings" label="Reservas" align="right" sortKey={sort.sortKey} sortDir={sort.sortDir} onToggle={sort.toggle} />
                        <Th k="lastAt" label="Última ação" align="right" sortKey={sort.sortKey} sortDir={sort.sortDir} onToggle={sort.toggle} />
                      </>}
                  {canManageRh && <th className="p-2" />}
                </tr></thead>
                <tbody>
                  {(sort.sorted as Row[]).map((r) => (
                    <tr key={r.key} className="border-b hover:bg-muted/40">
                      <td className="p-2 min-w-[180px]">
                        {r.employeeId != null
                          ? <button type="button" className="font-medium text-left hover:underline" title="Abrir a ficha" onClick={() => openEmployee(r.employeeId)}>{r.name}</button>
                          : <span className="font-medium">{r.name}</span>}
                        {r.kind === "por_ligar" && <Badge variant="outline" className="ml-1 text-[10px]">sem ficha</Badge>}
                        {r.kind === "parceiro" && <Badge variant="outline" className="ml-1 text-[10px]">parceiro</Badge>}
                        {r.agentName && r.agentName !== r.name && <span className="block text-[11px] text-muted-foreground">agente {r.agentName}</span>}
                      </td>
                      {mode === "agents" && <td className="p-2 text-right">{num(r, "total", "Todas as ações")}</td>}
                      <td className="p-2 text-right">{num(r, "recolhas", "Recolhas")}</td>
                      <td className="p-2 text-right">{num(r, "entregas", "Entregas")}</td>
                      <td className="p-2 text-right">{num(r, "movements", "Movimentos")}</td>
                      {mode === "drivers"
                        ? <td className="p-2 text-right tabular-nums">{r.km != null ? r.km.toLocaleString("pt-PT") : <span className="text-muted-foreground">·</span>}</td>
                        : <>
                            <td className="p-2 text-right tabular-nums">{r.spotChanges || <span className="text-muted-foreground">·</span>}</td>
                            <td className="p-2 text-right tabular-nums">{r.bookings}</td>
                            <td className="p-2 text-right text-xs text-muted-foreground whitespace-nowrap">{r.lastAt ? fmtPTDateTime(r.lastAt) : "—"}</td>
                          </>}
                      {canManageRh && (
                        <td className="p-2 text-right whitespace-nowrap">
                          {r.employeeId != null ? (
                            <Button size="sm" variant="ghost" className="h-7 px-2" title="Ligações: unir / separar conta e agente" onClick={() => setLinks({ employeeId: r.employeeId!, name: r.name })}>
                              <Link2 className="h-3.5 w-3.5" />
                            </Button>
                          ) : r.agentName ? (
                            <Button size="sm" variant="ghost" className="h-7 px-2" title="Tirar da lista (não é funcionário)" disabled={ignore.isPending}
                              onClick={() => { if (confirm(`Tirar "${r.agentName}" desta lista? Fica como "não é funcionário" (desfaz-se no RH → Agentes). Na Multipark não muda nada.`)) ignore.mutate({ agentName: r.agentName!, ignored: true }); }}>
                              <EyeOff className="h-3.5 w-3.5" />
                            </Button>
                          ) : null}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr className="text-xs text-muted-foreground">
                  <td className="p-2">{rows.length} pessoa(s)</td>
                  {mode === "agents" && <td className="p-2 text-right tabular-nums">{totals.total}</td>}
                  <td className="p-2 text-right tabular-nums">{totals.recolhas}</td>
                  <td className="p-2 text-right tabular-nums">{totals.entregas}</td>
                  <td className="p-2 text-right tabular-nums">{totals.movements}</td>
                  {mode === "drivers" ? <td className="p-2 text-right tabular-nums">{Math.round(totals.km).toLocaleString("pt-PT")}</td> : <td colSpan={3} />}
                  {canManageRh && <td />}
                </tr></tfoot>
              </table>
            </div>
          )}
      </CardContent>
      <MovementDetailSheet target={detail} from={start} to={end} onClose={() => setDetail(null)} />
      <PersonLinksDialog employeeId={links?.employeeId ?? null} name={links?.name} open={!!links} onOpenChange={(o) => !o && setLinks(null)} />
    </Card>
  );
}

/** O detalhe: os movimentos da pessoa no período (todos ou só o tipo clicado). */
export function MovementDetailSheet({ target, from, to, onClose }: { target: DetailTarget | null; from: string; to: string; onClose: () => void }) {
  const openEmployee = useOpenEmployee();
  const q = trpc.reviews.agentHistory.useQuery(
    target?.employeeId != null
      ? { startDate: from, endDate: to, employeeId: target.employeeId }
      : { startDate: from, endDate: to, agentUserIds: target?.agentUserIds ?? ["-"], agentName: target?.name },
    { enabled: !!target && from <= to && (target.employeeId != null || target.agentUserIds.length > 0) },
  );
  const history = ((q.data?.history ?? []) as any[]).filter((h) => !target?.types || target.types.includes(String(h.changeType)));
  const byType = history.reduce((acc: Record<string, number>, h) => { acc[h.changeType] = (acc[h.changeType] ?? 0) + 1; return acc; }, {});
  return (
    <Sheet open={!!target} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{target?.name}</SheetTitle>
          <SheetDescription>{target?.label} · {from === to ? from : `${from} a ${to}`}</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6 space-y-3 text-sm">
          {target?.employeeId != null && <Button size="sm" variant="outline" onClick={() => openEmployee(target.employeeId)}>Abrir a ficha</Button>}
          {q.isLoading ? <p className="text-muted-foreground">A ler a Multipark…</p>
            : q.error ? <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="os movimentos" />
            : q.data?.noAgent ? <p className="text-muted-foreground">Esta ficha não tem agente da Multipark ligado (RH → Ligações).</p>
            : !history.length ? <p className="text-muted-foreground">Sem movimentos destes no período.</p>
            : (
              <>
                <div className="flex flex-wrap gap-1">{Object.entries(byType).map(([k, v]) => <Badge key={k} variant="secondary">{movementLabel(k)}: {v as number}</Badge>)}</div>
                {q.data?.truncated && <p className="text-xs text-amber-700">Só as {q.data.total} ações mais recentes: escolhe um período mais curto para ver tudo.</p>}
                <div className="space-y-1">
                  {history.map((h) => (
                    <div key={h.id} className="flex items-center justify-between gap-2 flex-wrap rounded bg-muted p-2">
                      <div className="flex items-center gap-2 flex-wrap min-w-0">
                        <Badge variant="outline" className="text-xs">{movementLabel(h.changeType)}</Badge>
                        <span>{h.booking?.licensePlate || "—"}</span>
                        <span className="text-muted-foreground">{h.booking?.parkName || ""}</span>
                      </div>
                      <span className="text-xs text-muted-foreground">{h.actionTime ? fmtPTDateTime(h.actionTime) : "—"}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
