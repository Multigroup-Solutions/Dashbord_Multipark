/**
 * As fichas que a lista do RH mostra a quem pede (plano 64, D1/D4) — o filtro
 * ÚNICO partilhado por `rh.list`, `rh.stats`, `rh.documents.allStatus` e
 * `rh.extraMismatch`, para os números baterem com a lista:
 *  1. âmbito de cidade do pedido (`scopedProjectIds()`; com âmbito, as fichas
 *     sem centro de custos ficam de fora);
 *  2. a cidade/marca escolhida no topo (`resolveProjectIds`, com descendentes;
 *     o id negativo é a marca em todas as cidades);
 *  3. quem pode ver cada ficha (`canViewEmployee`: o team leader só quem está
 *     abaixo dele, o supervisor só a cidade…).
 * As linhas saem SEM limpar (o `rh.list` limpa-as com `sanitizeEmployeeRows`).
 */
import { getAllEmployees, getAllUsers, resolveProjectIds } from "./db";
import { scopedProjectIds } from "./cityScope";
import { canViewEmployee, type RhViewer } from "./rhAccess";

type EmployeeRow = Awaited<ReturnType<typeof getAllEmployees>>[number];

/** Filtro de cidade (passos 1 e 2). PURA. */
export function filterEmployeeRowsInScope<T extends { employee: { projectId: number | null } }>(
  rows: readonly T[],
  allowedIds: readonly number[] | undefined,
  pickIds: ReadonlySet<number> | null,
): T[] {
  let out = rows as T[];
  if (allowedIds) out = out.filter((r) => r.employee.projectId != null && allowedIds.includes(r.employee.projectId));
  if (pickIds) out = out.filter((r) => r.employee.projectId != null && pickIds.has(r.employee.projectId));
  return out;
}

export async function scopedEmployeeRows(
  viewer: RhViewer,
  input: { isActive?: boolean; position?: string; projectId?: number | null } = {},
): Promise<{ rows: EmployeeRow[]; roleOf: (emp: Record<string, any>) => string | null | undefined }> {
  const all = await getAllEmployees({ isActive: input.isActive, position: input.position });
  const pickIds = input.projectId ? new Set(await resolveProjectIds(input.projectId)) : null;
  const inScope = filterEmployeeRowsInScope(all, scopedProjectIds(), pickIds);
  // role da conta de cada ficha: fichas de admin/super_admin ficam protegidas
  // de quem está abaixo (dados pessoais escondidos; o team leader só vê quem
  // está abaixo dele).
  const roleByUserId = new Map<number, string>();
  for (const u of await getAllUsers()) roleByUserId.set(u.id, u.role);
  const roleOf = (emp: Record<string, any>) => (emp.userId != null ? roleByUserId.get(emp.userId) : null);
  const rows = inScope.filter((r) => canViewEmployee(viewer, {
    id: r.employee.id, projectId: r.employee.projectId ?? null, role: roleOf(r.employee) ?? null, position: r.employee.position ?? null,
  }));
  return { rows, roleOf };
}
