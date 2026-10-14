/**
 * Quem pode ser Team Leader na escala do Extras-Dia (Jorge, 14 out 2026: "ao
 * escolher o TL ainda aparecem extras"). Regra: decide a CONTA do dashboard
 * ligada à ficha do RH (employees.userId), não o posto da ficha:
 *   - sem conta, ou conta desativada → não;
 *   - permissão "Pode ser Team Leader na escala" (extras_dia.team_leader)
 *     negada na conta → não;
 *   - essa permissão dada à conta (Permissões / Utilizadores) → sim — é
 *     assim que um extra passa a poder ser TL;
 *   - senão, o papel da conta: team_leader ou acima (shared/access.ts →
 *     ROLE_RANK) → sim; extra, condutor, user → não.
 * É o mesmo "por omissão" de shared/userAccessSummary.ts. PURA.
 */
import { ROLE_RANK } from "./access";

export const TL_PERMISSION = "extras_dia.team_leader" as const;

export interface TlAccount {
  role: string | null | undefined;
  isActive?: number | boolean | null;
}

export type TlOverride = "grant" | "deny" | null | undefined;
export type TlRefusal = "no_account" | "inactive_account" | "denied" | "role_below";

export function teamLeaderRefusal(account: TlAccount | null | undefined, override?: TlOverride): TlRefusal | null {
  if (!account) return "no_account";
  if (account.isActive === 0 || account.isActive === false) return "inactive_account";
  if (override === "deny") return "denied";
  if (override === "grant") return null;
  const rank = ROLE_RANK[String(account.role ?? "") as keyof typeof ROLE_RANK] ?? -1;
  return rank >= ROLE_RANK.team_leader ? null : "role_below";
}

export const canBeTeamLeader = (account: TlAccount | null | undefined, override?: TlOverride): boolean =>
  teamLeaderRefusal(account, override) == null;

/** Mensagem para quem tenta pôr como TL alguém que não pode (o servidor recusa). */
export const TL_HOW_TO = "Para ser TL, a conta da pessoa tem de ter papel Team Leader ou acima, ou a permissão «Pode ser Team Leader na escala» (Permissões / Utilizadores).";

export function teamLeaderRefusalMessage(name: string, reason: TlRefusal): string {
  const who = name.trim() || "Esta pessoa";
  switch (reason) {
    case "no_account":
      return `${who} não pode ser Team Leader: não tem conta no dashboard (a permissão de TL é da conta). ${TL_HOW_TO}`;
    case "inactive_account":
      return `${who} não pode ser Team Leader: a conta no dashboard está desativada. ${TL_HOW_TO}`;
    case "denied":
      return `${who} não pode ser Team Leader: a permissão "Pode ser Team Leader na escala" foi retirada à conta.`;
    case "role_below":
      return `${who} não pode ser Team Leader: a conta não tem permissões de Team Leader. ${TL_HOW_TO}`;
  }
}
