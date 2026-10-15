/**
 * Definições → "Férias: quem aprova quem" (plano 63, passo 11). Para cada
 * posto de quem pede escolhe-se quem aprova (RH, supervisor da cidade,
 * qualquer supervisor, super admin, contas escolhidas); a regra de quem está
 * no RH; e as exceções por pessoa (ganham a tudo). Sem nomes no código: as
 * pessoas escolhem-se aqui.
 */
import { useMemo } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  APPROVER_SOURCES, APPROVER_SOURCE_LABELS, REQUESTER_POSITIONS, REQUESTER_POSITION_LABELS,
  type ApprovalRule, type ApproverSource, type VacationApprovals,
} from "@shared/leaves";

type User = { id: number; name?: string | null; email?: string | null };

function AccountsPicker({ ids, users, disabled, onChange }: { ids: number[]; users: User[]; disabled?: boolean; onChange: (ids: number[]) => void }) {
  const byId = new Map(users.map((u) => [Number(u.id), u]));
  return (
    <div className="space-y-1.5">
      {ids.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {ids.map((id) => {
            const u = byId.get(id);
            const label = u?.name || u?.email || `Conta ${id}`;
            return (
              <span key={id} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
                {label}
                <button type="button" className="ml-0.5 rounded hover:bg-muted" aria-label={`Tirar ${label}`} disabled={disabled} onClick={() => onChange(ids.filter((x) => x !== id))}><X className="h-3 w-3" /></button>
              </span>
            );
          })}
        </div>
      )}
      <SearchableSelect value="" disabled={disabled} className="w-full max-w-sm h-8 text-xs"
        options={users.filter((u) => !ids.includes(Number(u.id))).map((u) => ({ value: String(u.id), label: `${u.name || "—"}${u.email ? ` · ${u.email}` : ""}` }))}
        placeholder="+ Juntar conta" searchPlaceholder="Procurar pelo nome ou email…" emptyText="Nenhuma conta"
        onChange={(v) => { const id = Number(v); if (id) onChange([...ids.filter((x) => x !== id), id]); }} />
    </div>
  );
}

function RuleRow({ label, rule, users, disabled, onChange }: { label: string; rule: ApprovalRule; users: User[]; disabled?: boolean; onChange: (r: ApprovalRule) => void }) {
  const toggle = (src: ApproverSource, on: boolean) => onChange({ ...rule, approvers: on ? [...rule.approvers.filter((x) => x !== src), src] : rule.approvers.filter((x) => x !== src) });
  return (
    <div className="rounded-[14px] border p-2.5 space-y-2">
      <div className="text-sm font-semibold">{label}</div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {APPROVER_SOURCES.map((src) => (
          <label key={src} className="flex items-center gap-1.5 text-xs">
            <Checkbox checked={rule.approvers.includes(src)} disabled={disabled} onCheckedChange={(v) => toggle(src, v === true)} aria-label={`${label}: ${APPROVER_SOURCE_LABELS[src]}`} />
            {APPROVER_SOURCE_LABELS[src]}
          </label>
        ))}
      </div>
      {rule.approvers.includes("accounts") && <AccountsPicker ids={rule.userIds} users={users} disabled={disabled} onChange={(userIds) => onChange({ ...rule, userIds })} />}
      {rule.approvers.length === 0 && <p className="text-[11px] text-amber-800 dark:text-amber-300">Sem ninguém: aprova o super admin.</p>}
    </div>
  );
}

export function VacationApprovalsEditor({ value, onChange, disabled }: { value: VacationApprovals; onChange: (v: VacationApprovals) => void; disabled?: boolean }) {
  const usersQ = trpc.users.list.useQuery(undefined, { staleTime: 5 * 60_000, retry: false });
  const peopleQ = trpc.rh.list.useQuery({ isActive: true }, { staleTime: 5 * 60_000, retry: false });
  const users = ((usersQ.data ?? []) as User[]).map((u) => ({ ...u, id: Number(u.id) }));
  const people = useMemo(() => ((peopleQ.data ?? []) as Array<{ employee: { id: number; fullName: string; position?: string | null } }>)
    .filter((r) => r.employee.position !== "extra").map((r) => ({ id: r.employee.id, fullName: r.employee.fullName })), [peopleQ.data]);
  const nameOf = new Map(people.map((p) => [p.id, p.fullName]));
  const empty: ApprovalRule = { approvers: [], userIds: [] };
  return (
    <div className="space-y-3 max-w-3xl" data-vacation-approvals>
      <div className="grid gap-2 md:grid-cols-2">
        {REQUESTER_POSITIONS.map((pos) => (
          <RuleRow key={pos} label={REQUESTER_POSITION_LABELS[pos]} rule={value.positions[pos] ?? empty} users={users} disabled={disabled}
            onChange={(r) => onChange({ ...value, positions: { ...value.positions, [pos]: r } })} />
        ))}
        <RuleRow label="Quem está no RH (Férias: quem é o RH)" rule={value.hrPeople} users={users} disabled={disabled} onChange={(r) => onChange({ ...value, hrPeople: r })} />
      </div>
      <div className="space-y-2">
        <div className="text-sm font-semibold">Exceções por pessoa <span className="font-normal text-xs text-muted-foreground">(ganham a tudo — ex.: o supervisor de todas as cidades → super admin)</span></div>
        {value.people.map((p, i) => (
          <div key={`${p.employeeId}-${i}`} className="rounded-[14px] border p-2.5 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">{nameOf.get(p.employeeId) ?? `Ficha ${p.employeeId}`}</span>
              <Input className="h-7 max-w-xs text-xs" placeholder="Nota (opcional)" value={p.note ?? ""} disabled={disabled} maxLength={120}
                onChange={(e) => onChange({ ...value, people: value.people.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)) })} />
              <Button type="button" size="sm" variant="ghost" className="ml-auto h-7" disabled={disabled} aria-label="Tirar exceção"
                onClick={() => onChange({ ...value, people: value.people.filter((_, j) => j !== i) })}><Trash2 className="h-3.5 w-3.5" /></Button>
            </div>
            <RuleRow label="Quem aprova" rule={{ approvers: p.approvers, userIds: p.userIds }} users={users} disabled={disabled}
              onChange={(r) => onChange({ ...value, people: value.people.map((x, j) => (j === i ? { ...x, approvers: r.approvers, userIds: r.userIds } : x)) })} />
          </div>
        ))}
        <div className="flex items-center gap-2">
          <Plus className="h-4 w-4 text-muted-foreground" />
          <SearchableSelect value="" disabled={disabled || peopleQ.isLoading} className="w-full max-w-sm h-8 text-xs"
            options={people.filter((p) => !value.people.some((x) => x.employeeId === p.id)).map((p) => ({ value: String(p.id), label: p.fullName }))}
            placeholder={peopleQ.isLoading ? "A carregar…" : "Juntar exceção (pessoa)"} searchPlaceholder="Procurar pelo nome…" emptyText="Ninguém"
            onChange={(v) => { const id = Number(v); if (id) onChange({ ...value, people: [...value.people, { employeeId: id, approvers: ["super_admin"], userIds: [] }] }); }} />
        </div>
      </div>
    </div>
  );
}
