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

import { lisbonDayOf, utcMs } from "./lisbonDay";

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

/**
 * "A minha ficha" de uma conta (ponto, foto, "A minha ficha") quando a conta
 * está em mais do que uma (`getEmployeeByUserId`). Regra fixa, sempre a mesma
 * resposta para os mesmos dados:
 *  1. ativa antes de inativa (uma inativa não pica o ponto);
 *  2. entre várias ativas, a que tem o ponto MAIS RECENTE — o ponto nunca muda
 *     de ficha sozinho a meio do mês (set 2026: mudou e as horas "sumiram");
 *  3. a conta principal antes da conta extra;
 *  4. a ficha mais recente (id mais alto).
 * Devolve o id escolhido (null = nenhuma).
 */
export interface OwnFichaCandidate { id: number; isActive: boolean; via: "principal" | "extra"; lastPontoAt?: string | null }
export function chooseOwnFicha(candidates: readonly OwnFichaCandidate[]): number | null {
  if (!candidates.length) return null;
  const active = candidates.filter((c) => c.isActive);
  const pool = active.length ? active : candidates;
  const byPonto = active.length > 1;
  const sorted = [...pool].sort((a, b) => {
    if (byPonto) {
      const la = a.lastPontoAt ?? "", lb = b.lastPontoAt ?? "";
      if (la !== lb) return la < lb ? 1 : -1;
    }
    if (a.via !== b.via) return a.via === "principal" ? -1 : 1;
    return b.id - a.id;
  });
  return sorted[0].id;
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
  /** a ficha entra na folha deste mês (vínculo ou picagens), em qualquer cidade */
  inPayroll?: boolean;
}

const fichaLabel = (o: { employeeId: number; fullName: string }) => `#${o.employeeId} ${o.fullName}`;

/**
 * Avisos da folha por ficha:
 *  - ficha INATIVA com picagens — antes ficava fora da folha em silêncio;
 *  - a MESMA conta de login picou também noutra ficha no mês — as horas da
 *    pessoa estão divididas (juntar as fichas passa as picagens para a que fica);
 *  - a mesma conta está noutra ficha ATIVA que também entra na folha (sem
 *    picagens nas duas) — a mesma pessoa pode estar a ser paga duas vezes (ex.:
 *    o salário base nas duas fichas). Uma readmissão (a ficha antiga inativa,
 *    com fim de contrato) não avisa.
 */
export function pontoFichaWarnings(rows: readonly PontoFichaLike[]): Map<number, string[]> {
  const relevant = rows.filter((r) => r.checkIns > 0 || r.inPayroll);
  const byLogin = new Map<number, PontoFichaLike[]>();
  for (const r of relevant) {
    for (const u of new Set(r.logins)) byLogin.set(u, [...(byLogin.get(u) ?? []), r]);
  }
  const out = new Map<number, string[]>();
  for (const r of relevant) {
    const w: string[] = [];
    if (!r.isActive && r.checkIns > 0) w.push(`ficha inativa com ${r.checkIns} entrada(s) no ponto neste mês — confirma se é a ficha certa (RH → Ligações)`);
    const others = new Map<number, PontoFichaLike>();
    for (const u of new Set(r.logins)) for (const o of byLogin.get(u) ?? []) if (o.employeeId !== r.employeeId) others.set(o.employeeId, o);
    const sorted = Array.from(others.values()).sort((a, b) => a.employeeId - b.employeeId);
    const split = r.checkIns > 0 ? sorted.filter((o) => o.checkIns > 0) : [];
    if (split.length) {
      const list = split.map((o) => `${fichaLabel(o)} (${o.checkIns} entrada(s))`).join(", ");
      w.push(`a mesma conta picou o ponto também em ${list} neste mês — as horas desta pessoa estão divididas; junta as fichas em RH → Ligações`);
    }
    // só duas ATIVAS: uma readmissão (a antiga inativa, com fim de contrato) não é aviso
    const alsoPaid = r.inPayroll && r.isActive ? sorted.filter((o) => o.inPayroll && o.isActive && !split.includes(o)) : [];
    if (alsoPaid.length) {
      w.push(`a mesma conta de login está também na ficha ${alsoPaid.map(fichaLabel).join(", ")}, que também entra nesta folha — confirma que não pagas a mesma pessoa duas vezes; junta as fichas em RH → Ligações`);
    }
    if (w.length) out.set(r.employeeId, w);
  }
  return out;
}

/** Turno que conta (fechado e não suspeito/rejeitado) de uma ficha, com as contas dela. */
export interface FichaShiftsLike {
  employeeId: number;
  fullName: string;
  logins: readonly number[];
  /** instantes UTC da BD ("YYYY-MM-DD HH:MM:SS") */
  shifts: ReadonlyArray<{ inAt: string; outAt: string | null }>;
}

/**
 * A MESMA conta com turnos sobrepostos em duas fichas (o mesmo tempo picado
 * nas duas): essas horas contavam duas vezes na folha. Avisa nas duas fichas
 * com as horas em duplicado. Só turnos que contam; abertos não entram.
 */
export function shiftOverlapWarnings(fichas: readonly FichaShiftsLike[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const push = (id: number, msg: string) => out.set(id, [...(out.get(id) ?? []), msg]);
  for (let i = 0; i < fichas.length; i++) {
    for (let j = i + 1; j < fichas.length; j++) {
      const a = fichas[i], b = fichas[j];
      if (a.employeeId === b.employeeId || !a.logins.some((u) => b.logins.includes(u))) continue;
      let ms = 0;
      for (const x of a.shifts) {
        if (!x.outAt) continue;
        const x0 = utcMs(x.inAt), x1 = utcMs(x.outAt);
        for (const y of b.shifts) {
          if (!y.outAt) continue;
          const lo = Math.max(x0, utcMs(y.inAt)), hi = Math.min(x1, utcMs(y.outAt));
          if (hi > lo) ms += hi - lo;
        }
      }
      if (ms <= 0) continue;
      const h = Math.round((ms / 3600000) * 100) / 100;
      push(a.employeeId, `o mesmo tempo está picado também na ficha ${fichaLabel(b)} (${h} h sobrepostas) — essas horas contam duas vezes; rejeita a picagem a mais antes de fechar o mês`);
      push(b.employeeId, `o mesmo tempo está picado também na ficha ${fichaLabel(a)} (${h} h sobrepostas) — essas horas contam duas vezes; rejeita a picagem a mais antes de fechar o mês`);
    }
  }
  return out;
}

/**
 * Fim do vínculo que a folha usa para uma ficha INATIVA sem data de fim de
 * contrato (a ficha entra na folha pelas picagens do mês):
 *  - extra → nenhum: paga-se à hora o que picou (as horas são trabalho feito);
 *  - outros → o dia (Lisboa) da desativação, como nas Finanças
 *    (server/finance/rules.ts assumedContractEnd); sem data de desativação →
 *    `unknown` e a folha não paga salário base por esta ficha (antes contava o
 *    mês inteiro — numa 2.ª ficha da mesma pessoa era o salário pago duas
 *    vezes). Aqui não se usa a última alteração da ficha: é ordenado, não estimativa.
 */
export function inactiveContractEnd(e: {
  isActive: boolean; isExtra: boolean; contractEnd?: string | null; deactivatedAt?: string | null;
}): { kind: "none" | "extra" | "assumed" | "unknown"; end: string | null } {
  if (e.isActive || e.contractEnd) return { kind: "none", end: null };
  if (e.isExtra) return { kind: "extra", end: null };
  return e.deactivatedAt ? { kind: "assumed", end: lisbonDayOf(e.deactivatedAt) } : { kind: "unknown", end: null };
}
