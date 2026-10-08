/**
 * De onde veio a ligação reserva → campanha (Jorge, 8 out 2026: "as
 * campanhas dão 0 reservas ligadas"). Regra única para o servidor e o ecrã.
 *
 * Por esta ordem (cada reserva conta uma vez):
 *  1. `link`  — o ID da campanha vem no link de origem (ValueTrack
 *     {campaignid} / {{campaign.id}} ou utm_campaign numérico);
 *  2. `gclid` — o link só traz o gclid (auto-tagging) e o Google Ads diz de
 *     que campanha é esse clique (relatório click_view, lido de hora a hora);
 *  3. `utm`   — utm_campaign ligado à campanha à mão (ROAS por campanha);
 *  4. `code`  — código de desconto ligado à campanha à mão.
 */
export type CampaignMatchBy = "link" | "gclid" | "utm" | "code";

/** Como a campanha da reserva foi encontrada a partir do link (só 1 e 2). */
export type CampaignEvidence = Extract<CampaignMatchBy, "link" | "gclid">;

export const CAMPAIGN_MATCH_LABEL: Record<CampaignMatchBy, string> = {
  link: "ID da campanha no link",
  gclid: "gclid → campanha (Google Ads)",
  utm: "utm_campaign ligado",
  code: "código de desconto ligado",
};

export const CAMPAIGN_MATCH_ORDER: readonly CampaignMatchBy[] = ["link", "gclid", "utm", "code"];

/** Texto curto para o ecrã (a meio de uma frase): "… as ligadas pelo link ou pelo clique (gclid) …". */
export const LINKED_EXPLAINER = "ligadas pelo link (ID da campanha) ou pelo clique (gclid) que o Google Ads identifica";

/** "2 · ID da campanha no link; 3 · gclid → campanha (Google Ads)" — só os que têm reservas. PURA. */
export function describeMatchCounts(counts: Partial<Record<CampaignMatchBy, number>> | null | undefined): string {
  if (!counts) return "";
  return CAMPAIGN_MATCH_ORDER.filter((k) => (counts[k] ?? 0) > 0).map((k) => `${counts[k]} · ${CAMPAIGN_MATCH_LABEL[k]}`).join("; ");
}
