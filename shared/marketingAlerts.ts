/**
 * Alertas do Marketing (Jorge, 24 set 2026) — regras puras; os dados vêm da
 * rota marketing.alerts (server/routers.ts).
 *
 *  - Atribuição partida: há gasto e nenhuma reserva do site traz o clique do
 *    Google — nesse caso não se acusa campanha nenhuma de "não trazer
 *    reservas" (seria culpa da medição, não da campanha).
 *  - Campanha a gastar sem trazer nada: ≥ WASTE_MIN_SPEND € nos últimos
 *    ALERT_WINDOW_DAYS dias, zero reservas atribuídas E zero conversões Google.
 *  - Ritmo do mês: projeção do mês corrente (gasto até hoje ÷ dias decorridos
 *    × dias do mês) ≥ PACE_MAX_RATIO × gasto do mês passado.
 *  - Campanhas por associar (sem marca/cidade nem nacional).
 *  - Recolha do Google Ads parada / dias em falta.
 */
import { attributionHealth, type AttributionQuality } from "./marketingAttribution";

export const ALERT_WINDOW_DAYS = 14;
export const WASTE_MIN_SPEND = 50;
export const PACE_MAX_RATIO = 1.2;
/** Antes deste dia do mês a projeção é demasiado ruidosa. */
export const PACE_MIN_DAYS = 5;

export type AlertLevel = "critical" | "warning";
export interface MarketingAlert { level: AlertLevel; code: string; title: string; detail: string; link?: string }

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
}

const eur = (v: number) => `${Math.round(v).toLocaleString("pt-PT")} €`;

export function computeMarketingAlerts(i: AlertsInput): MarketingAlert[] {
  const out: MarketingAlert[] = [];
  const health = attributionHealth(i.attribution, i.windowSpend, i.windowConversions);
  const attributionBroken = health.level === "critical";
  if (attributionBroken) {
    out.push({ level: "critical", code: "attribution_broken", title: "Atribuição partida", detail: health.message, link: "/marketing" });
  }

  if (i.coverage && (i.coverage.status === "stale" || i.coverage.status === "partial")) {
    out.push({
      level: "warning", code: "sync_stale", title: "Dados do Google Ads desatualizados",
      detail: i.coverage.status === "stale" ? "A recolha do Google Ads não corre há mais de um dia." : `Faltam ${i.coverage.missingDays ?? "alguns"} dia(s) de dados do Google Ads.`,
      link: "/integracoes/google-ads",
    });
  }

  const wasting = i.windowCampaigns
    .filter((c) => c.cost >= WASTE_MIN_SPEND && c.conversions <= 0 && (attributionBroken || c.attributedBookings === 0))
    .sort((a, b) => b.cost - a.cost);
  for (const c of wasting.slice(0, 10)) {
    out.push({
      level: "critical", code: "campaign_no_results",
      title: `Campanha a gastar sem resultados: ${c.name}`,
      detail: `${eur(c.cost)} nos últimos ${ALERT_WINDOW_DAYS} dias${c.accountName ? ` (${c.accountName})` : ""}, sem conversões na Google${attributionBroken ? "" : " nem reservas atribuídas"}.`,
      link: "/marketing/google-ads",
    });
  }

  if (i.dayOfMonth >= PACE_MIN_DAYS && i.prevMonthSpend > 0) {
    const projected = (i.monthSpend / i.dayOfMonth) * i.daysInMonth;
    if (projected >= i.prevMonthSpend * PACE_MAX_RATIO) {
      const up = Math.round((projected / i.prevMonthSpend - 1) * 100);
      out.push({
        level: "warning", code: "month_pace",
        title: `Gasto do mês a caminho de +${up}% face ao mês passado`,
        detail: `${eur(i.monthSpend)} até hoje (dia ${i.dayOfMonth}); a este ritmo fecha em ~${eur(projected)}, contra ${eur(i.prevMonthSpend)} no mês passado.`,
        link: "/marketing",
      });
    }
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
