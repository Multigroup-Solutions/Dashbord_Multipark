/**
 * 49c (Jorge, 8 out 2026) — "Liga a tua conta": quem entra com uma conta
 * Google sem ficha diz com que email ou telefone se candidatou / trabalhou
 * connosco. Regras PURAS (servidor em server/accountLink.ts).
 *
 *  - Nunca liga só pelo nome. Só email ou telefone, e só quando dá UMA pessoa.
 *  - A resposta à pessoa é sempre a mesma, haja ou não correspondência (não
 *    se revela quem existe).
 *  - 5 pedidos por dia por conta; código de 6 algarismos, 10 minutos, 5
 *    tentativas, guardado só em hash.
 */
import { normalizeEmail, isPlausibleEmail } from "./email";
import { normalizePhoneE164 } from "./phone";
import { deactivationBlocksLogin } from "./deactivationReasons";
import { isComebackPosition } from "./comeback";

export const ACCOUNT_LINK_LIMITS = {
  /** Pedidos por conta em 24 h. */
  perDay: 5,
  /** Validade do código, em minutos. */
  codeMinutes: 10,
  /** Tentativas por código. */
  maxAttempts: 5,
  /** Algarismos do código. */
  codeLength: 6,
} as const;

export const ACCOUNT_LINK_FLAG = "ACCOUNT_LINK_EMAIL_CODE";

/** Resposta à pessoa — IGUAL com e sem correspondência. */
export function linkRequestReply(codeExpected: boolean): string {
  return codeExpected
    ? `Se encontrarmos o teu registo, enviámos um código de ${ACCOUNT_LINK_LIMITS.codeLength} algarismos para o email que lá está (vale ${ACCOUNT_LINK_LIMITS.codeMinutes} minutos). Escreve-o aqui. Se não chegar, o RH vê o teu pedido e liga a tua conta.`
    : "Pedido enviado. O RH vai confirmar quem és e ligar a tua conta à tua ficha. Quando estiver feito, sai e volta a entrar.";
}

export const LINK_CODE_WRONG = "Código errado ou expirado.";
export const LINK_CODE_EXHAUSTED = "Código errado. Já não há mais tentativas: o RH vai ver o teu pedido.";
export const LINK_LIMIT_MESSAGE = `Já fizeste ${ACCOUNT_LINK_LIMITS.perDay} pedidos nas últimas 24 horas. Tenta amanhã ou fala com o RH.`;

export type LinkClaim = { kind: "email"; email: string } | { kind: "phone"; phone: string };

/** O que a pessoa escreveu: um email ou um telefone (normalizados). null = nenhum dos dois. PURA. */
export function parseLinkClaim(raw: string | null | undefined): LinkClaim | null {
  const text = String(raw ?? "").trim();
  if (!text || text.length > 320) return null;
  if (text.includes("@")) {
    const email = normalizeEmail(text);
    return isPlausibleEmail(email) ? { kind: "email", email } : null;
  }
  const digits = text.replace(/\D/g, "");
  if (digits.length < 9 || digits.length > 15) return null;
  const phone = normalizePhoneE164(text);
  return phone ? { kind: "phone", phone } : null;
}

/** Uma ficha encontrada pelo email/telefone. */
export interface LinkMatchEmployee {
  kind: "employee";
  id: number;
  email: string | null;
  position: string | null;
  isActive: number | boolean | null;
  deactivationReason?: string | null;
}
/** Uma candidatura encontrada (ainda sem ficha). */
export interface LinkMatchApplication {
  kind: "application";
  id: number;
  email: string;
  employeeId?: number | null;
}
export type LinkMatch = LinkMatchEmployee | LinkMatchApplication;

export type LinkTarget =
  | { kind: "employee"; employeeId: number; sendTo: string }
  | { kind: "application"; applicationId: number; sendTo: string };

const on = (v: number | boolean | null | undefined) => v === true || Number(v) === 1;

/** A ficha pode ser ligada pela própria pessoa (código ou "Sou novo")? Extra/condutor e não DESATIVADA. PURA. */
export function selfLinkableEmployee(e: Pick<LinkMatchEmployee, "position" | "isActive" | "deactivationReason">): boolean {
  if (!isComebackPosition(e.position)) return false; // estrutura: decide o RH
  if (on(e.isActive)) return true;
  return !deactivationBlocksLogin(e.deactivationReason);
}

/**
 * Para onde vai o código (ou null → decide o RH): UMA pessoa só — uma ficha,
 * ou uma candidatura sem ficha —, que a pessoa pode ligar sozinha e com email
 * para onde mandar o código. Duas fichas, estrutura, desativada ou sem email
 * → RH. PURA.
 */
export function pickAutoTarget(matches: readonly LinkMatch[]): LinkTarget | null {
  const emps = new Map<number, LinkMatchEmployee>();
  for (const m of matches) if (m.kind === "employee") emps.set(m.id, m);
  if (emps.size > 1) return null;
  if (emps.size === 1) {
    const e = [...emps.values()][0];
    // uma candidatura que já tem OUTRA ficha → duas pessoas possíveis
    if (matches.some((m) => m.kind === "application" && m.employeeId != null && m.employeeId !== e.id)) return null;
    const to = normalizeEmail(e.email);
    if (!selfLinkableEmployee(e) || !isPlausibleEmail(to)) return null;
    return { kind: "employee", employeeId: e.id, sendTo: to };
  }
  const apps = new Map<number, LinkMatchApplication>();
  for (const m of matches) if (m.kind === "application") apps.set(m.id, m);
  if (apps.size !== 1) return null;
  const a = [...apps.values()][0];
  const to = normalizeEmail(a.email);
  return isPlausibleEmail(to) ? { kind: "application", applicationId: a.id, sendTo: to } : null;
}

export interface CodeState {
  codeHash: string | null;
  codeExpiresAt: string | Date | null;
  attempts: number;
  status: string;
}

/** O código ainda se pode tentar? (pendente, com código, dentro do prazo e das tentativas). PURA. */
export function codeUsable(s: CodeState, now: Date): boolean {
  if (s.status !== "pending" || !s.codeHash) return false;
  if (s.attempts >= ACCOUNT_LINK_LIMITS.maxAttempts) return false;
  const exp = s.codeExpiresAt instanceof Date ? s.codeExpiresAt : s.codeExpiresAt ? new Date(String(s.codeExpiresAt).replace(" ", "T") + (String(s.codeExpiresAt).includes("Z") ? "" : "Z")) : null;
  return !!exp && !Number.isNaN(exp.getTime()) && exp.getTime() > now.getTime();
}

/** Uma linha para o RH: "Pedido de ligação: <email Google> diz ser <email/telefone>". PURA. */
export function linkRequestSummary(r: { kind?: string | null; googleEmail: string | null; claimedEmail: string | null; claimedPhone: string | null; matchedEmployeeId?: number | null }): string {
  if (r.kind === "duplicate") return `Possível duplicado${r.matchedEmployeeId ? ` de #${r.matchedEmployeeId}` : ""}: ${r.googleEmail ?? "conta sem email"}`;
  return `Pedido de ligação: ${r.googleEmail ?? "conta sem email"} diz ser ${r.claimedEmail ?? r.claimedPhone ?? "—"}`;
}
