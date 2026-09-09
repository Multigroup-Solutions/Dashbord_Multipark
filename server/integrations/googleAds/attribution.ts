/**
 * Atribuição de uma reserva ao Google Ads a partir do URL de origem.
 *
 * O detalhe da reserva (/bookings/:id) devolve `originUrl` com os parâmetros
 * de acompanhamento que o site preservou. Regra LOCAL, documentada e distinta
 * da atribuição da Google:
 *   - `gclid` / `gbraid` / `wbraid` presente → clique Google pago (prova forte);
 *   - `utm_source=google` + `utm_medium` de pago (cpc/ppc/paid…) → Google pago;
 *   - `utm_source=google` sem medium pago → orgânico/desconhecido (NÃO atribuir);
 *   - URL genérico sem parâmetros → "unknown" (nunca inventar atribuição).
 * O ID da campanha vem de `campaignid`/`campaign_id` (ValueTrack) ou de um
 * `utm_campaign` numérico; um nome de campanha em `utm_campaign` fica guardado
 * mas não é um ID.
 */
export type AdAttribution = "google_paid" | "unknown";

export interface UrlAttribution {
  adAttribution: AdAttribution;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  /** ID numérico da campanha Google quando disponível (ValueTrack {campaignid}) */
  adCampaignExternalId: string | null;
  /** o que provou a atribuição */
  evidence: "gclid" | "gbraid" | "wbraid" | "utm_paid" | null;
}

const PAID_MEDIUMS = new Set(["cpc", "ppc", "paid", "paidsearch", "paid_search", "sem", "cpm", "display", "pmax", "performance_max", "video", "youtube"]);
const cut = (v: string | null, n: number) => (v == null ? null : v.slice(0, n));

function parseParams(url: string): URLSearchParams | null {
  const s = url.trim();
  if (!s) return null;
  try {
    const u = new URL(s.includes("://") ? s : `https://x/${s.replace(/^\/+/, "")}`);
    const params = new URLSearchParams(u.search);
    // parâmetros também podem vir no fragmento (#?gclid=…) em SPAs
    if (u.hash && u.hash.includes("=")) {
      const h = u.hash.slice(1);
      const q = h.includes("?") ? h.slice(h.indexOf("?") + 1) : h;
      const frag = new URLSearchParams(q);
      for (const [k, v] of frag) if (!params.has(k)) params.set(k, v);
    }
    return params;
  } catch {
    // não é URL: tenta como query string solta
    if (s.includes("=")) return new URLSearchParams(s.replace(/^\?/, ""));
    return null;
  }
}

export function attributionFromUrl(originUrl: string | null | undefined): UrlAttribution {
  const empty: UrlAttribution = {
    adAttribution: "unknown", gclid: null, gbraid: null, wbraid: null,
    utmSource: null, utmMedium: null, utmCampaign: null, utmContent: null, utmTerm: null,
    adCampaignExternalId: null, evidence: null,
  };
  if (!originUrl) return empty;
  const p = parseParams(originUrl);
  if (!p) return empty;
  const get = (k: string) => { const v = p.get(k); return v && v.trim() ? v.trim() : null; };
  const lower = (v: string | null) => (v ? v.toLowerCase() : null);

  const gclid = get("gclid"), gbraid = get("gbraid"), wbraid = get("wbraid");
  const utmSource = lower(get("utm_source")), utmMedium = lower(get("utm_medium"));
  const utmCampaign = get("utm_campaign"), utmContent = get("utm_content"), utmTerm = get("utm_term");
  const campaignIdRaw = get("campaignid") ?? get("campaign_id") ?? get("campaignId") ?? (utmCampaign && /^\d{6,}$/.test(utmCampaign) ? utmCampaign : null);
  const adCampaignExternalId = campaignIdRaw && /^\d+$/.test(campaignIdRaw) ? campaignIdRaw : null;

  let evidence: UrlAttribution["evidence"] = null;
  if (gclid) evidence = "gclid";
  else if (gbraid) evidence = "gbraid";
  else if (wbraid) evidence = "wbraid";
  else if (utmSource === "google" && utmMedium && PAID_MEDIUMS.has(utmMedium)) evidence = "utm_paid";

  return {
    adAttribution: evidence ? "google_paid" : "unknown",
    gclid: cut(gclid, 128), gbraid: cut(gbraid, 128), wbraid: cut(wbraid, 128),
    utmSource: cut(utmSource, 128), utmMedium: cut(utmMedium, 128), utmCampaign: cut(utmCampaign, 256),
    utmContent: cut(utmContent, 256), utmTerm: cut(utmTerm, 256),
    adCampaignExternalId, evidence,
  };
}

/** Campos a gravar em multipark_bookings (sem `evidence`). */
export function attributionColumns(a: UrlAttribution) {
  const { evidence: _e, ...cols } = a;
  return cols;
}
