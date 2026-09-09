/**
 * Troca `phone` ↔ `nif` nas fichas de colaborador (`employees`) quando os
 * valores estão nas colunas erradas — ficha preenchida com o telemóvel no
 * campo do NIF e o NIF no campo do telefone (site multidriver, CSV de extras,
 * backoffice). Não há bug de mapeamento no código (`webIntake.ts` e
 * `extrasImport.ts` ligam cada campo à coluna certa): é erro de quem preenche.
 *
 * Regra pedida (Jorge, 2026-09-09):
 *   - `nif` começa por 9                      → é um telemóvel PT, não um NIF.
 *   - `phone` não começa por +351 nem por 9   → é um NIF, não um telefone.
 *   Em qualquer dos casos, trocar os dois campos.
 *
 * Refinamentos de segurança — o script nunca INVENTA um valor: ou grava um
 * valor verificado normalizado, ou transporta o texto original tal e qual:
 *   - Telefone estrangeiro (`+44…`, `0033…`) não começa por +351 nem por 9 mas
 *     É um telefone: fica (aparece no relatório com kind `intl`).
 *   - Só consideramos VERIFICADO um NIF em `phone` quando são 9 dígitos, o 1.º
 *     é 1–8 e o DÍGITO DE CONTROLO bate (mod 11). Um valor que falha o checksum
 *     (fixo 2xxxxxxxx com gralha, 8 dígitos, texto) só muda de coluna se do
 *     outro lado houver um telemóvel verificado a precisar do lugar.
 *   - Troca-se quando PELO MENOS UM lado é um valor verificado do tipo da outra
 *     coluna e o outro lado NÃO é um valor válido da coluna onde está: um
 *     telemóvel certo em `nif` vai sempre para `phone`, e o que estava em
 *     `phone` (NIF válido, NIF com checksum errado, 8 dígitos…) passa para
 *     `nif` tal e qual — estava igualmente errado onde estava e o backoffice
 *     corrige à mão. A linha fica marcada `swap-nif-unverified` /
 *     `swap-phone-unverified` no relatório. (Decisão do Jorge após a 1.ª
 *     aplicação, 2026-09-09: a regra literal manda trocar.)
 *   - Dois telefones, dois NIFs, o mesmo valor nos dois campos ou lixo nos dois
 *     lados → REVISÃO com o motivo, nunca escrita (a troca não resolveria nada).
 *   - Valores gravados: telefone em E.164 (`normalizePhoneE164`, a convenção
 *     da app — ver shared/phone.ts) e NIF só com dígitos.
 *
 * `planContactSwap` é PURA (testada em employeeContactSwap.test.ts).
 * `applyContactSwap` escreve numa transação com guarda otimista (só actualiza
 * se `phone`/`nif` ainda forem exatamente os valores lidos) e regista em
 * `activity_logs` (`action = 'employee_contact_swap'`, `userId = 0` = sistema,
 * como a fusão de duplicados) o antes/depois de cada linha — é o trilho de
 * rollback.
 */
import { sql } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { activityLogs } from "../drizzle/schema";
import { normalizePhoneE164 } from "../shared/phone";

export const CONTACT_SWAP_ACTION = "employee_contact_swap";

export type ValueKind =
  /** null / vazio */
  | "empty"
  /** telefone português (+351 explícito ou 9 dígitos a começar por 9) */
  | "phone"
  /** telefone de outro país (`+` ou `00` sem ser 351) */
  | "intl"
  /** 9 dígitos, 1.º dígito 1–8, checksum válido */
  | "nif"
  /** não reconhecido — só transportado tal e qual (`carryOver`), nunca normalizado */
  | "other";

export interface ClassifiedValue {
  raw: string | null;
  kind: ValueKind;
  /** valor canónico a gravar se este valor for parar à coluna do seu tipo */
  normalized: string | null;
  detail?: string;
}

/** Dígito de controlo do NIF português (pesos 9..2, mod 11). */
export function isValidNifChecksum(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += Number(digits[i]) * (9 - i);
  const mod = sum % 11;
  const check = mod < 2 ? 0 : 11 - mod;
  return check === Number(digits[8]);
}

/**
 * Classifica o texto de UMA coluna sem saber de que coluna veio. A distinção
 * "telefone PT" vs "NIF" nos 9 dígitos nus é feita pelo 1.º dígito (regra do
 * Jorge) e, para os que não começam por 9, confirmada pelo checksum.
 */
export function classifyContactValue(raw: string | null | undefined): ClassifiedValue {
  if (typeof raw !== "string" || !raw.trim()) return { raw: raw ?? null, kind: "empty", normalized: null };

  const text = raw.normalize("NFKC").trim();
  const digits = text.replace(/\D/g, "");
  const explicitIntlPrefix = /^(\+|00)/.test(text);
  const e164 = normalizePhoneE164(text);

  if (!e164) {
    return {
      raw,
      kind: "other",
      normalized: null,
      detail: digits ? `${digits.length} dígitos, não normalizável` : "sem dígitos",
    };
  }

  if (!e164.startsWith("+351")) return { raw, kind: "intl", normalized: e164 };

  const national = e164.slice("+351".length);
  const explicitPt = explicitIntlPrefix || (digits.length === 12 && digits.startsWith("351"));
  if (explicitPt || national.startsWith("9")) {
    const detail =
      !explicitPt && isValidNifChecksum(national)
        ? "9 dígitos a começar por 9 (regra: telemóvel); checksum de NIF também válido"
        : undefined;
    return { raw, kind: "phone", normalized: e164, detail };
  }

  // 9 dígitos nus que não começam por 9: candidato a NIF — só se o checksum bater.
  if (national.startsWith("0")) {
    return { raw, kind: "other", normalized: null, detail: "9 dígitos a começar por 0 (nem NIF nem telefone)" };
  }
  if (isValidNifChecksum(national)) return { raw, kind: "nif", normalized: national };
  return {
    raw,
    kind: "other",
    normalized: null,
    detail: "9 dígitos sem começar por 9 mas checksum de NIF inválido",
  };
}

export interface EmployeeContactRow {
  id: number;
  fullName: string;
  isActive: number;
  phone: string | null;
  nif: string | null;
}

export type SwapDecision = "swap" | "review" | "ok";

export type ReviewReason =
  | "both-phones"
  | "same-value"
  | "both-nifs"
  | "phone-unrecognized";

export type SwapReason =
  /** os dois lados verificados (ou um verificado e o outro vazio) */
  | "swap"
  /** telemóvel verificado sai de `nif`; o valor que vai para `nif` não é um NIF válido */
  | "swap-nif-unverified"
  /** NIF verificado sai de `phone`; o valor que vai para `phone` não é um telefone reconhecido */
  | "swap-phone-unverified";

export interface ContactSwapPlanItem {
  id: number;
  fullName: string;
  isActive: number;
  phone: ClassifiedValue;
  nif: ClassifiedValue;
  decision: SwapDecision;
  reason: ReviewReason | SwapReason | "ok";
  /** só em `swap` */
  newPhone?: string | null;
  newNif?: string | null;
}

export interface ContactSwapPlan {
  total: number;
  swaps: number;
  reviews: number;
  ok: number;
  items: ContactSwapPlanItem[];
}

const PHONE_KINDS: ReadonlySet<ValueKind> = new Set(["phone", "intl"]);
/** larguras das colunas em drizzle/schema.ts */
const PHONE_MAX_LENGTH = 32;
const NIF_MAX_LENGTH = 20;

/** Valor não verificado que muda de coluna: só limpo (NFKC, espaços) e cortado. */
function carryOver(raw: string | null, maxLength: number): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function decide(row: EmployeeContactRow): ContactSwapPlanItem {
  const phone = classifyContactValue(row.phone);
  const nif = classifyContactValue(row.nif);
  const base = { id: row.id, fullName: row.fullName, isActive: row.isActive, phone, nif };

  const nifHoldsPhone = PHONE_KINDS.has(nif.kind);
  const phoneHoldsNonPhone = phone.kind === "nif" || phone.kind === "other";
  if (!nifHoldsPhone && !phoneHoldsNonPhone) return { ...base, decision: "ok", reason: "ok" };

  // Telemóvel verificado preso em `nif` → vai sempre para `phone`; o que estava
  // em `phone` passa para `nif` (verificado, vazio, ou tal e qual se for lixo).
  if (nifHoldsPhone && !PHONE_KINDS.has(phone.kind)) {
    return {
      ...base,
      decision: "swap",
      reason: phone.kind === "other" ? "swap-nif-unverified" : "swap",
      newPhone: nif.normalized,
      newNif: phone.kind === "other" ? carryOver(phone.raw, NIF_MAX_LENGTH) : phone.normalized,
    };
  }

  // NIF verificado preso em `phone` → vai sempre para `nif`; simétrico.
  if (phone.kind === "nif" && nif.kind !== "nif") {
    return {
      ...base,
      decision: "swap",
      reason: nif.kind === "other" ? "swap-phone-unverified" : "swap",
      newPhone: nif.kind === "other" ? carryOver(nif.raw, PHONE_MAX_LENGTH) : null,
      newNif: phone.normalized,
    };
  }

  let reason: ReviewReason;
  if (nifHoldsPhone && PHONE_KINDS.has(phone.kind)) {
    reason = nif.normalized === phone.normalized ? "same-value" : "both-phones";
  } else if (nif.kind === "nif" && phone.kind === "nif") {
    reason = nif.normalized === phone.normalized ? "same-value" : "both-nifs";
  } else {
    // `phone` tem lixo e `nif` não tem um telefone para o substituir
    reason = "phone-unrecognized";
  }
  return { ...base, decision: "review", reason };
}

/** PURA. Decide, linha a linha, trocar / rever / nada. */
export function planContactSwap(rows: EmployeeContactRow[]): ContactSwapPlan {
  const items = rows.map(decide);
  return {
    total: items.length,
    swaps: items.filter((i) => i.decision === "swap").length,
    reviews: items.filter((i) => i.decision === "review").length,
    ok: items.filter((i) => i.decision === "ok").length,
    items,
  };
}

export interface ApplyContactSwapResult {
  applied: number[];
  /** linhas cujo phone/nif mudaram entre a leitura e a escrita — não tocadas */
  stale: number[];
}

/**
 * Escreve as trocas do plano. Uma transação; cada UPDATE é guardado por
 * `phone <=> lido AND nif <=> lido` para não pisar edições concorrentes.
 */
export async function applyContactSwap(
  db: MySql2Database<Record<string, never>>,
  plan: ContactSwapPlan,
): Promise<ApplyContactSwapResult> {
  const swaps = plan.items.filter((i) => i.decision === "swap");
  const applied: number[] = [];
  const stale: number[] = [];
  if (!swaps.length) return { applied, stale };

  await db.transaction(async (tx) => {
    for (const item of swaps) {
      const newPhone = item.newPhone ?? null;
      const newNif = item.newNif ?? null;
      const [header] = await tx.execute(sql`
        UPDATE employees
           SET phone = ${newPhone}, nif = ${newNif}
         WHERE id = ${item.id}
           AND phone <=> ${item.phone.raw}
           AND nif <=> ${item.nif.raw}`);
      const affected = Number((header as { affectedRows?: number }).affectedRows ?? 0);
      if (affected !== 1) {
        stale.push(item.id);
        continue;
      }
      await tx.insert(activityLogs).values({
        userId: 0,
        action: CONTACT_SWAP_ACTION,
        entity: "employees",
        entityId: item.id,
        details: JSON.stringify({
          before: { phone: item.phone.raw, nif: item.nif.raw },
          after: { phone: newPhone, nif: newNif },
          kinds: { phone: item.phone.kind, nif: item.nif.kind },
        }),
      });
      applied.push(item.id);
    }
  });

  return { applied, stale };
}
