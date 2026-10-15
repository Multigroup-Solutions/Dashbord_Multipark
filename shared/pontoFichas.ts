/**
 * Ponto × fichas: as picagens de uma pessoa nunca podem ficar espalhadas por
 * várias fichas, ou numa ficha que a folha não lê, sem ninguém ver. PURO
 * (testes em server/pontoFichas.test.ts).
 *
 * Caso real (setembro de 2026): duas pessoas "só apareciam até meio do mês".
 * A mesma conta de login pode estar em mais do que uma ficha (employees.userId
 * não é único e o login liga sozinho todas as fichas com o mesmo email). O
 * ponto vai para a ficha que `getEmployeeByUserId` escolhe e, a partir do dia
 * em que a conta fica também noutra ficha, as picagens passam para essa. Se a
 * outra estiver inativa, a folha nem a lia (só fichas com vínculo no mês).
 */

/** Ficha com o mesmo email e ainda sem conta, candidata a ficar ligada à conta que entrou. */
export interface EmailLinkCandidate { id: number; isActive: boolean }

/**
 * A que ficha se liga uma conta pelo email (no login, na criação da conta e na
 * volta de hora a hora). Uma pessoa = uma ficha:
 *  - a conta já é a principal de uma ficha ATIVA → nenhuma (seria a 2.ª ficha
 *    da mesma pessoa e o ponto mudava de ficha a meio do mês; fica para
 *    RH → Ligações → "Juntar fichas");
 *  - há fichas ativas → só a mais antiga (a do RH; as outras são duplicados);
 *  - só inativas → só a mais recente (quem volta a entrar).
 * Devolve no máximo um id.
 */
export function fichasToLinkByEmail(candidates: readonly EmailLinkCandidate[], accountHasActiveFicha: boolean): number[] {
  if (accountHasActiveFicha || candidates.length === 0) return [];
  const active = candidates.filter((c) => c.isActive).map((c) => c.id);
  if (active.length) return [Math.min(...active)];
  return [Math.max(...candidates.map((c) => c.id))];
}

/**
 * Aviso na entrada do ponto quando a conta de quem pica está em mais do que uma
 * ficha ativa (null = tudo bem). A entrada fica na ficha `employeeId`.
 */
export function pontoFichaSplitWarning(employeeId: number, activeFichaIds: readonly number[]): string | null {
  const ids = Array.from(new Set(activeFichaIds));
  if (ids.length < 2) return null;
  const others = ids.filter((id) => id !== employeeId);
  return `A tua conta está em ${ids.length} fichas ativas. Esta entrada ficou na ficha #${employeeId}${others.length ? ` (as outras: #${others.join(", #")})` : ""}. Avisa o RH para juntar as fichas, senão as horas ficam divididas.`;
}

/** Uma ficha com as contas de login que lhe estão ligadas e as entradas do ponto no mês. */
export interface PontoFichaLike {
  employeeId: number;
  fullName: string;
  isActive: boolean;
  /** contas de login da ficha: a principal (employees.userId) e as extra (employee_accounts) */
  logins: readonly number[];
  /** entradas (check-in) do ponto no mês */
  checkIns: number;
}

/**
 * Avisos da folha por ficha (só fichas com picagens no mês):
 *  - ficha INATIVA com picagens — antes ficava fora da folha em silêncio;
 *  - a MESMA conta de login picou também noutra ficha no mês — as horas da
 *    pessoa estão divididas (juntar as fichas passa as picagens para a que fica).
 */
export function pontoFichaWarnings(rows: readonly PontoFichaLike[]): Map<number, string[]> {
  const withPonto = rows.filter((r) => r.checkIns > 0);
  const byLogin = new Map<number, PontoFichaLike[]>();
  for (const r of withPonto) {
    for (const u of new Set(r.logins)) byLogin.set(u, [...(byLogin.get(u) ?? []), r]);
  }
  const out = new Map<number, string[]>();
  for (const r of withPonto) {
    const w: string[] = [];
    if (!r.isActive) w.push(`ficha inativa com ${r.checkIns} entrada(s) no ponto neste mês — as horas contam; confirma se é a ficha certa (RH → Ligações)`);
    const others = new Map<number, PontoFichaLike>();
    for (const u of new Set(r.logins)) for (const o of byLogin.get(u) ?? []) if (o.employeeId !== r.employeeId) others.set(o.employeeId, o);
    if (others.size) {
      const list = Array.from(others.values()).sort((a, b) => a.employeeId - b.employeeId)
        .map((o) => `#${o.employeeId} ${o.fullName} (${o.checkIns} entrada(s))`).join(", ");
      w.push(`a mesma conta picou o ponto também em ${list} neste mês — as horas desta pessoa estão divididas; junta as fichas em RH → Ligações`);
    }
    if (w.length) out.set(r.employeeId, w);
  }
  return out;
}
