/**
 * D51 (Jorge, 3 out 2026): quando alguém desliga uma integração da empresa
 * (Google Business, Google Ads), avisa os administradores e o super admin —
 * menos quem desligou. Tipo `integration_alert` (sino + email conforme a
 * preferência de cada um), atrás do interruptor INTEGRATION_DISCONNECT_NOTIFY
 * (desligado por omissão — coisas novas que avisam gente entram desligadas).
 * O registo nos Logs fica sempre. Nunca lança.
 */
export const INTEGRATION_DISCONNECT_FLAG = "INTEGRATION_DISCONNECT_NOTIFY";

export interface IntegrationDisconnectInput {
  integration: string;
  byUserId: number;
  byName?: string | null;
  accountEmail?: string | null;
  revoked?: boolean;
  nowMs?: number;
}

export interface IntegrationDisconnectDeps {
  flagOn(): Promise<boolean>;
  notify(input: Record<string, any>): Promise<unknown>;
}

/** Texto do aviso. PURA. */
export function disconnectNoticeText(i: IntegrationDisconnectInput): { title: string; body: string } {
  const who = String(i.byName ?? "").trim() || `utilizador #${i.byUserId}`;
  return {
    title: `${i.integration} foi desligado`,
    body: `${who} desligou ${i.integration}${i.accountEmail ? ` (${i.accountEmail})` : ""}${i.revoked === false ? " — não foi possível revogar o acesso na Google" : ""}. Enquanto estiver desligado não há recolha nem envio por esta ligação. Para voltar a ligar: Integrações (só o super admin).`,
  };
}

export async function notifyIntegrationDisconnectedWith(deps: IntegrationDisconnectDeps, i: IntegrationDisconnectInput): Promise<"flag_off" | "notified"> {
  if (!(await deps.flagOn())) return "flag_off";
  const t = disconnectNoticeText(i);
  await deps.notify({
    kind: "integration_alert",
    title: t.title,
    body: t.body,
    link: "/integracoes",
    // Cada "desligar" é um aviso (não junta com o anterior).
    entity: { type: "integration_disconnect", id: `${i.integration}:${i.nowMs ?? Date.now()}` },
    recipientFilter: (c: { id: number }) => c.id !== i.byUserId,
  });
  return "notified";
}

export async function notifyIntegrationDisconnected(i: IntegrationDisconnectInput): Promise<void> {
  try {
    await notifyIntegrationDisconnectedWith({
      async flagOn() {
        const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([import("./_core/featureFlags"), import("../shared/appSettings")]);
        await ensureFeatureFlagOverrides();
        return isFeatureEnabled(INTEGRATION_DISCONNECT_FLAG, { defaultEnabled: automationFlagDefault(INTEGRATION_DISCONNECT_FLAG) });
      },
      async notify(n) {
        const { notify } = await import("./notify");
        return notify(n as any);
      },
    }, i);
  } catch (err) {
    console.warn("[integrationDisconnect] aviso falhou:", String((err as any)?.message ?? err).slice(0, 160));
  }
}
