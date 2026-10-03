/**
 * D20 (Jorge, 3 out 2026): quando o cliente volta a escrever numa reclamação,
 * o responsável recebe no sino "O cliente respondeu à reclamação #X".
 *
 * Interruptor COMPLAINT_CLIENT_REPLY_NOTIFY — desligado por omissão (coisas
 * novas que avisam gente entram desligadas). Regras:
 *  - só emails do PRÓPRIO cliente (remetente externo): um reencaminhamento do
 *    backoffice (reservas@, info@…) não é o cliente a responder;
 *  - só emails recentes (≤ 48 h): recuperar emails antigos não acorda ninguém;
 *  - só ao responsável, e só se ele ainda vê Reclamações (condutores e extras
 *    não veem — D19); sem responsável não avisa ninguém (o caso volta na mesma
 *    a "Em análise" e aparece na lista);
 *  - 1 aviso por reclamação a cada 30 min (vários emails seguidos = 1 aviso).
 * Nunca lança: uma falha a avisar não estraga a entrada do email.
 */
import { seesBeyondOwn } from "../shared/access";
import { parseUtc } from "../shared/caseRules";
import { clientSignalEmail } from "./complaintEmail";

export const CLIENT_REPLY_FLAG = "COMPLAINT_CLIENT_REPLY_NOTIFY";
export const CLIENT_REPLY_MAX_AGE_HOURS = 48;

/** O email chegou há pouco (≤ 48 h; até 1 h "no futuro" por relógios desacertados)? Sem data → não. PURA. */
export function isRecentInbound(receivedAt: string | null | undefined, nowMs: number, maxAgeHours = CLIENT_REPLY_MAX_AGE_HOURS): boolean {
  const t = parseUtc(receivedAt ?? null);
  if (t == null) return false;
  return nowMs - t <= maxAgeHours * 3_600_000 && t - nowMs <= 3_600_000;
}

export interface ClientReplyInput {
  fromEmail?: string | null;
  fromName?: string | null;
  subject?: string | null;
  receivedAt?: string | null;
}

export interface ClientReplyDeps {
  flagOn(): Promise<boolean>;
  /** Email do cliente (externo, não genérico) ou undefined. */
  clientSignalEmail(email?: string | null): string | undefined;
  loadComplaint(id: number): Promise<{ id: number; title?: string | null; projectId?: number | null; assignedToId?: number | null } | null | undefined>;
  assigneeUserIds(employeeIds: Array<number | null | undefined>): Promise<number[]>;
  notify(input: Record<string, any>): Promise<unknown>;
  nowMs(): number;
}

export type ClientReplyOutcome = "flag_off" | "not_client" | "old" | "no_complaint" | "no_assignee" | "notified";

/** Núcleo (dependências injetáveis para os testes). */
export async function notifyClientReplyWith(deps: ClientReplyDeps, complaintId: number, input: ClientReplyInput): Promise<ClientReplyOutcome> {
  if (!(await deps.flagOn())) return "flag_off";
  const from = deps.clientSignalEmail(input.fromEmail);
  if (!from) return "not_client";
  if (!isRecentInbound(input.receivedAt, deps.nowMs())) return "old";
  const c = await deps.loadComplaint(complaintId);
  if (!c) return "no_complaint";
  const users = await deps.assigneeUserIds([c.assignedToId]);
  if (!users.length) return "no_assignee";
  const who = String(input.fromName ?? "").trim() || from;
  const subject = String(input.subject ?? "").trim();
  await deps.notify({
    kind: "complaint_client_reply",
    targetUserIds: users,
    projectId: c.projectId ?? null,
    title: `O cliente respondeu à reclamação #${complaintId}`,
    body: `${who}${subject ? `: ${subject}` : ""}${c.title ? ` · ${c.title}` : ""}`.slice(0, 500),
    link: `/reclamacoes?id=${complaintId}`,
    entity: { type: "complaint", id: complaintId },
    // Só quem ainda vê Reclamações para lá do "próprio" (D19).
    recipientFilter: (u: any) => seesBeyondOwn(u, "reclamacoes"),
  });
  return "notified";
}

export async function notifyComplaintClientReply(complaintId: number, input: ClientReplyInput): Promise<ClientReplyOutcome | "error"> {
  try {
    return await notifyClientReplyWith({
      async flagOn() {
        const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([import("./_core/featureFlags"), import("../shared/appSettings")]);
        await ensureFeatureFlagOverrides();
        return isFeatureEnabled(CLIENT_REPLY_FLAG, { defaultEnabled: automationFlagDefault(CLIENT_REPLY_FLAG) });
      },
      clientSignalEmail,
      async loadComplaint(id) {
        const { getComplaintById } = await import("./db");
        return (await getComplaintById(id)) as any;
      },
      async assigneeUserIds(ids) {
        const { assigneeUserIds } = await import("./complaintsExtended");
        return assigneeUserIds(ids);
      },
      async notify(n) {
        const { notify } = await import("./notify");
        return notify(n as any);
      },
      nowMs: () => Date.now(),
    }, complaintId, input);
  } catch (err) {
    console.warn("[complaintClientReply] aviso ao responsável falhou:", String((err as any)?.message ?? err).slice(0, 160));
    return "error";
  }
}
