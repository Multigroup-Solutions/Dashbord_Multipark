/**
 * Alertas do Marketing (Jorge, 24 set 2026) — regras puras; os dados vêm da
 * rota marketing.alerts (server/routers.ts).
 *
 *  - Atribuição partida: há gasto e nenhuma reserva do site traz o clique do
 *    Google — nesse caso não se acusa campanha nenhuma de "não trazer
 *    reservas" (seria culpa da medição, não da campanha).
 *  - Campanha a gastar sem trazer nada: ≥ WASTE_MIN_SPEND € nos últimos
 *    ALERT_WINDOW_DAYS dias, zero reservas atribuídas E zero conversões Google.
 *    Todas numa só entrada, com a lista e "sugestão: pausar" (nada é pausado
 *    automaticamente).
 *  - Ritmo do mês: projeção do mês corrente (gasto até ONTEM ÷ dias completos
 *    × dias do mês — hoje está a meio e não conta) ≥ PACE_MAX_RATIO × gasto
 *    do mês passado.
 *  - Orçamentos (marketing_budgets): ritmo por objetivo > 110 % / < 80 %.
 *  - Recolhas (Google Ads / Meta) falhadas, a pedir reautorização ou paradas
 *    há mais de 26 h → CRÍTICO com ligação "Religar …".
 *  - Campanhas por associar (sem marca/cidade nem nacional).
 *  - Recolha do Google Ads parada / dias em falta.
 */
import { attributionHealth, type AttributionQuality } from "./marketingAttribution";
import type { BudgetPacing } from "./marketingRules";

export const ALERT_WINDOW_DAYS = 14;
export const WASTE_MIN_SPEND = 50;
export const PACE_MAX_RATIO = 1.2;
/** Antes deste dia do mês a projeção é demasiado ruidosa. */
export const PACE_MIN_DAYS = 5;

export type AlertLevel = "critical" | "warning";
export interface MarketingAlert { level: AlertLevel; code: string; title: string; detail: string; link?: string; linkLabel?: string; items?: string[] }

export interface SyncHealth {
  provider: "google_ads" | "meta";
  /** estado da ligação: connected | reauth_required | error | disconnected */
  connection: string | null;
  /** estado da última execução terminada: done | partial | failed */
  lastRunStatus: string | null;
  lastRunError?: string | null;
  stale: boolean;
  lastSuccessAt: string | null;
}

export interface AlertsInput {
  windowCampaigns: Array<{ name: string; accountName: string | null; cost: number; conversions: number; attributedBookings: number }>;
  attribution: AttributionQuality;
  windowSpend: number;
  /** conversões Google na mesma janela */
  windowConversions?: number;
  monthSpend: number;
  prevMonthSpend: number;
  /** dia do mês de hoje (1..31) e dias do mês corrente */
  dayOfMonth: number;
  daysInMonth: number;
  unmappedCampaigns: number;
  coverage: { status: string; missingDays?: number } | null;
  syncHealth?: SyncHealth[];
  budgets?: Array<{ label: string; amount: number; spentToDate: number; pacing: BudgetPacing }>;
}

const PROVIDER_LABEL: Record<SyncHealth["provider"], string> = { google_ads: "Google Ads", meta: "Meta Ads" };
const PROVIDER_LINK: Record<SyncHealth["provider"], string> = { google_ads: "/integracoes/google-ads", meta: "/integracoes/google-ads#meta" };

/** Alerta vermelho de uma recolha com problemas (ou null se está bem). */
export function syncHealthAlert(h: SyncHealth): MarketingAlert | null {
  const name = PROVIDER_LABEL[h.provider];
  const base = { level: "critical" as const, code: `ads_sync_${h.provider}`, link: PROVIDER_LINK[h.provider], linkLabel: `Religar ${name}` };
  const last = h.lastSuccessAt ? ` Última recolha com sucesso: ${h.lastSuccessAt.slice(0, 16).replace("T", " ")}.` : " Nunca houve uma recolha com sucesso.";
  if (h.connection === "reauth_required") return { ...base, title: `${name} precisa de ser religado`, detail: `A autorização expirou ou foi revogada — os números de gasto deixaram de atualizar.${last}` };
  if (h.lastRunStatus === "failed") return { ...base, title: `Recolha do ${name} falhou`, detail: `${h.lastRunError ? `${h.lastRunError}. ` : ""}O gasto mostrado pode estar incompleto.${last}` };
  if (h.lastRunStatus === "partial") return { ...base, title: `Recolha do ${name} com contas falhadas`, detail: `${h.lastRunError ? `${h.lastRunError}. ` : ""}O gasto dessas contas pode estar incompleto.${last}` };
  if (h.stale) return { ...base, title: `Recolha do ${name} parada há mais de 26 h`, detail: `A recolha é diária e não correu com sucesso.${last}` };
  if (h.connection === "error") return { ...base, title: `Ligação ao ${name} com erro`, detail: `Verifica a ligação em Integrações.${last}` };
  return null;
}

const EUR0 = new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: 0, minimumFractionDigits: 0 });
const eur = (v: number) => EUR0.format(Math.round(v));

export function computeMarketingAlerts(i: AlertsInput): MarketingAlert[] {
  const out: MarketingAlert[] = [];
  const health = attributionHealth(i.attribution, i.windowSpend, i.windowConversions);
  const attributionBroken = health.level === "critical";
  if (attributionBroken) {
    out.push({ level: "critical", code: "attribution_broken", title: "Atribuição partida", detail: health.message, link: "/marketing" });
  }

  const syncAlerts = (i.syncHealth ?? []).map(syncHealthAlert).filter((a): a is MarketingAlert => !!a);
  out.push(...syncAlerts);
  const googleSyncAlert = syncAlerts.some((a) => a.code === "ads_sync_google_ads");

  if (i.coverage && ((i.coverage.status === "stale" && !googleSyncAlert) || i.coverage.status === "partial")) {
    out.push({
      level: "warning", code: "sync_stale", title: "Dados do Google Ads desatualizados",
      detail: i.coverage.status === "stale" ? "A recolha do Google Ads não corre há mais de um dia." : `Faltam ${i.coverage.missingDays ?? "alguns"} dia(s) de dados do Google Ads.`,
      link: "/integracoes/google-ads",
    });
  }

  const wasting = i.windowCampaigns
    .filter((c) => c.cost >= WASTE_MIN_SPEND && c.conversions <= 0 && (attributionBroken || c.attributedBookings === 0))
    .sort((a, b) => b.cost - a.cost);
  if (wasting.length) {
    const total = wasting.reduce((t, c) => t + c.cost, 0);
    out.push({
      level: "critical", code: "campaign_no_results",
      title: wasting.length === 1 ? `Campanha a gastar sem resultados: ${wasting[0].name}` : `${wasting.length} campanhas a gastar sem resultados`,
      detail: `${eur(total)} nos últimos ${ALERT_WINDOW_DAYS} dias sem conversões na plataforma${attributionBroken ? "" : " nem reservas atribuídas"}. Sugestão: pausar (nada é pausado automaticamente).`,
      items: wasting.slice(0, 15).map((c) => `${c.name}${c.accountName ? ` (${c.accountName})` : ""} — ${eur(c.cost)}`),
      link: "/marketing/google-ads",
    });
  }

  // `monthSpend` = gasto do dia 1 até ONTEM; hoje (a meio) não conta.
  const fullDays = i.dayOfMonth - 1;
  if (fullDays >= PACE_MIN_DAYS && i.prevMonthSpend > 0) {
    const projected = (i.monthSpend / fullDays) * i.daysInMonth;
    if (projected >= i.prevMonthSpend * PACE_MAX_RATIO) {
      const up = Math.round((projected / i.prevMonthSpend - 1) * 100);
      out.push({
        level: "warning", code: "month_pace",
        title: `Gasto do mês a caminho de +${up}% face ao mês passado`,
        detail: `${eur(i.monthSpend)} até ontem (${fullDays} dia(s) completos); a este ritmo fecha em ~${eur(projected)}, contra ${eur(i.prevMonthSpend)} no mês passado.`,
        link: "/marketing",
      });
    }
  }

  for (const b of i.budgets ?? []) {
    if (b.pacing.status !== "over" && b.pacing.status !== "under") continue;
    const pct = Math.round((b.pacing.ratio ?? 0) * 100);
    out.push({
      level: "warning", code: b.pacing.status === "over" ? "budget_over" : "budget_under",
      title: b.pacing.status === "over" ? `${b.label}: gasto acima do orçamento (${pct}% do esperado)` : `${b.label}: gasto abaixo do orçamento (${pct}% do esperado)`,
      detail: `${eur(b.spentToDate)} até ontem contra ${eur(b.pacing.expected)} esperados (orçamento ${eur(b.amount)}/mês); a este ritmo fecha em ~${eur(b.pacing.projected ?? 0)}.`,
      link: "/marketing/orcamentos",
    });
  }

  if (i.unmappedCampaigns > 0) {
    out.push({
      level: "warning", code: "campaigns_unmapped",
      title: `${i.unmappedCampaigns} campanha(s) sem marca/cidade`,
      detail: "Contam só no total da marca até lhes escolheres cidade ou Nacional — os números por cidade ficam por baixo.",
      link: "/marketing/google-ads",
    });
  }

  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === "critical" ? -1 : 1));
}
