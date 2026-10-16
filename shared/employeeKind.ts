/**
 * "É extra" e "funcionário" — a regra ÚNICA (plano 64, D0). PURA.
 *
 * Antes havia cópias: as finanças (`server/finance/rules.ts`) e o ponto
 * (`shared/pontoMode.ts`) diziam "posto OU contrato extra", mas o RH e o
 * Pessoas contavam os extras só pelo posto e os "permanentes" só pelo
 * contrato "sem termo" (o valor por omissão, que não quer dizer nada).
 *
 *  - extra = posto "extra" OU contrato "extra";
 *  - parceiro-empresa = contrato "partner_company" (fora da folha e do mapa
 *    de férias; nunca conta como funcionário nem como extra);
 *  - funcionário = o resto (sem termo e a termo).
 *
 * A folha de ordenados (`server/payroll/payrollData.ts`) continua a pagar o
 * extra só pelo posto (decisão do Jorge: fica de fora). As fichas em que posto
 * e contrato não batem aparecem no relatório só de leitura `extraRuleMismatch`
 * (RH → Dashboard RH → "Posto e contrato diferentes").
 */

export interface EmployeeKindLike {
  position?: string | null;
  contractType?: string | null;
}

export type EmployeeKind = "extra" | "partner_company" | "staff";

/** Regra ÚNICA para "é extra": posto ou contrato "extra". PURA. */
export function isExtraEmployee(e: EmployeeKindLike | null | undefined): boolean {
  return !!e && (e.position === "extra" || e.contractType === "extra");
}

/**
 * Funcionário, extra ou parceiro-empresa. O contrato de parceiro-empresa
 * manda (está fora da folha, seja qual for o posto). PURA.
 */
export function employeeKind(e: EmployeeKindLike): EmployeeKind {
  if (e.contractType === "partner_company") return "partner_company";
  if (isExtraEmployee(e)) return "extra";
  return "staff";
}

export interface HrCounts {
  /** fichas ativas */
  totalActive: number;
  /** funcionários: ativas que não são extra nem parceiro-empresa (sem termo e a termo) */
  staff: number;
  /** extras: posto ou contrato "extra" */
  extras: number;
  /** parceiros-empresa */
  partners: number;
}

/**
 * Contagens das fichas ATIVAS (as inativas, desativadas e candidatos ficam de
 * fora). `staff + extras + partners = totalActive`. Contrato vazio = "sem
 * termo" (o valor por omissão da BD). PURA.
 */
export function hrCounts(rows: ReadonlyArray<EmployeeKindLike & { isActive?: number | boolean | null }>): HrCounts {
  const out: HrCounts = { totalActive: 0, staff: 0, extras: 0, partners: 0 };
  for (const e of rows) {
    if (!(e.isActive === true || Number(e.isActive) === 1)) continue;
    out.totalActive++;
    const kind = employeeKind({ position: e.position ?? null, contractType: e.contractType ?? "permanent" });
    if (kind === "extra") out.extras++;
    else if (kind === "partner_company") out.partners++;
    else out.staff++;
  }
  return out;
}

export interface ExtraRuleMismatch {
  /** o que a folha faz hoje (o extra só pelo posto) */
  payrollAs: "extra" | "staff" | "outside";
  /** o que diz a regra única (posto ou contrato) — sempre "extra" num desacerto */
  ruleAs: "extra";
  /** o lado que diz "extra" */
  extraBy: "position" | "contract";
  /** explicação curta para o ecrã */
  note: string;
}

/**
 * Posto e contrato não batem quanto a "extra" (um diz extra e o outro não)?
 * Só leitura: serve o relatório do RH para o Jorge decidir cada ficha; a folha
 * não muda. null = batem. PURA.
 */
export function extraRuleMismatch(e: EmployeeKindLike): ExtraRuleMismatch | null {
  const byPosition = e.position === "extra";
  const byContract = e.contractType === "extra";
  if (byPosition === byContract) return null;
  if (e.contractType === "partner_company") {
    return { payrollAs: "outside", ruleAs: "extra", extraBy: "position", note: "Posto Extra com contrato de parceiro-empresa: fica fora da folha." };
  }
  if (byPosition) {
    return { payrollAs: "extra", ruleAs: "extra", extraBy: "position", note: "Posto Extra mas o contrato não é de extra: a folha paga como extra (pelo posto)." };
  }
  return { payrollAs: "staff", ruleAs: "extra", extraBy: "contract", note: "Contrato de extra mas o posto não é Extra: a folha paga como funcionário (pelo posto); o resto da app conta como extra." };
}
