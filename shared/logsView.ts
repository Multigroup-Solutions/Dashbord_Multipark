/**
 * Página de Logs (P3 lote 20c): nomes legíveis das ações e entidades e o CSV
 * seguro. PURO (testado no servidor).
 */

export const LOG_ACTION_LABELS: Record<string, string> = {
  create: "Criou",
  update: "Atualizou",
  delete: "Apagou",
  archive: "Arquivou",
  unarchive: "Repôs",
  revoke: "Revogou",
  update_role: "Mudou o papel de",
  set_permission: "Mudou uma permissão de",
  set_module_access: "Mudou o acesso de",
  account_link: "Ligou",
  account_unlink: "Separou",
  account_merge: "Fundiu contas",
  users_merge: "Fundiu contas",
  user_autocreate: "Criou a conta",
  employee_autocreate: "Criou a ficha (site)",
  extra_city_requested: "Pediu a cidade a",
  employee_city_auto: "Definiu a cidade de",
  login: "Entrou",
  login_denied: "Entrada recusada",
  test: "Testou",
  sync: "Sincronizou",
  import: "Importou",
  submit: "Submeteu",
  upsert: "Registou",
  connect: "Ligou",
  disconnect: "Desligou",
};

export function logActionLabel(action: string | null | undefined): string {
  const a = String(action ?? "");
  return LOG_ACTION_LABELS[a] ?? a;
}

/**
 * Entidades registadas com mais de um nome (singular/plural, nomes antigos)
 * → uma só opção no filtro ("employee|employees" filtra as duas). PURO.
 */
export function groupLogEntities(entities: readonly string[]): Array<{ value: string; label: string }> {
  const byBase = new Map<string, string[]>();
  for (const e of entities) {
    const base = e.toLowerCase().replace(/s$/, "");
    const list = byBase.get(base) ?? [];
    if (!list.includes(e)) list.push(e);
    byBase.set(base, list);
  }
  return Array.from(byBase.values())
    .map((list) => ({ value: list.join("|"), label: list.length > 1 ? `${list[0]} (${list.slice(1).join(", ")})` : list[0] }))
    .sort((a, b) => a.label.localeCompare(b.label, "pt"));
}

/**
 * Uma célula de CSV que o Excel abre como texto: entre aspas, aspas dobradas
 * e, se começar por = + - @ (ou tab/CR), com um apóstrofo à frente — uma
 * fórmula num detalhe nunca corre (injeção de fórmulas). PURO.
 */
export function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  s = s.replace(/\r\n|\r|\n/g, " ");
  if (/^[=+\-@\t]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function csvLine(cells: readonly unknown[]): string {
  return cells.map(csvCell).join(";");
}
