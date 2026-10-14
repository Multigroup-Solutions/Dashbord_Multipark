/**
 * Garagens × tipo de lugar — o que está mal arrumado (Jorge, 7 out 2026):
 *   PD                → descoberto
 *   COBERTO           → indoor e cobertos (se der)
 *   PD FORA           → descoberto
 *   CENTRAL           → descoberto
 *   CENTRAL COBERTO   → indoor ou cobertos
 * Leitura: indoor fora de uma garagem coberta e descoberto numa garagem
 * coberta = mal arrumado (vermelho). Coberto numa garagem descoberta = aviso
 * (amarelo): "cobertos se der" — vai para a coberta quando houver lugar.
 * Garagem ou tipo que não se conhece → sem cor (nunca se adivinha). PURA.
 */
export type GarageKind = "covered" | "uncovered" | "unknown";
export type GarageFit = "ok" | "warn" | "bad" | "unknown";

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

export function garageKind(name: string | null | undefined): GarageKind {
  const n = norm(String(name ?? ""));
  if (!n) return "unknown";
  if (/\bDESCOBERT[OA]S?\b/.test(n)) return "uncovered";
  if (/\bCOBERT[OA]S?\b|\bINDOOR\b|\bINTERIOR\b/.test(n)) return "covered";
  if (/^(PD|CENTRAL)\b/.test(n)) return "uncovered";
  return "unknown";
}

/** Tipo de lugar do carro: "uncovered" | "covered" | "indoor" | "vip" | "unknown". */
export function garageFit(spotType: string, garage: string | null | undefined): GarageFit {
  const kind = garageKind(garage);
  if (kind === "unknown" || spotType === "unknown") return "unknown";
  const wantsCover = spotType === "indoor" || spotType === "vip";
  if (kind === "covered") return spotType === "uncovered" ? "bad" : "ok";
  // garagem descoberta
  if (wantsCover) return "bad";
  if (spotType === "covered") return "warn";
  return "ok";
}

export const GARAGE_FIT_LABEL: Record<Exclude<GarageFit, "ok" | "unknown">, string> = {
  bad: "mal arrumado",
  warn: "toldo numa garagem descoberta (passa para a coberta se der)",
};

/** Nome curto do tipo de lugar, para as linhas do resumo dos mal arrumados. */
export const SPOT_TYPE_SHORT: Record<string, string> = {
  uncovered: "Descoberto", covered: "Toldo", indoor: "Interior", vip: "VIP", unknown: "Sem tipo",
};

export interface MisplacedCarLike {
  spotType: string;
  garage: string | null;
  phase?: string;
  parkName?: string | null;
  spot?: string | null;
}

export interface MisplacedGroup<T> {
  key: string;
  fit: "bad" | "warn";
  spotType: string;
  garage: string;
  /** "Descoberto em COBERTO", "Toldo em PD (se der, coberta)". */
  label: string;
  items: T[];
}

/**
 * Resumo dos mal arrumados (Jorge, 14 out 2026: "os humanos não gostamos de
 * ver isto assim"): uma linha por tipo de lugar × garagem, com a contagem; os
 * carros só se veem ao abrir a linha. Ordem: primeiro os mal arrumados
 * (vermelho), depois os "se der" (amarelo); dentro de cada um, os grupos com
 * mais carros primeiro. Só conta carros parados no parque. PURA.
 */
export function groupMisplaced<T extends MisplacedCarLike>(cars: readonly T[]): MisplacedGroup<T>[] {
  const groups = new Map<string, MisplacedGroup<T>>();
  for (const c of cars) {
    if (c.phase != null && c.phase !== "in_park") continue;
    const fit = garageFit(c.spotType, c.garage);
    if (fit !== "bad" && fit !== "warn") continue;
    const garage = String(c.garage ?? "").trim().replace(/\s+/g, " ");
    const key = `${fit}|${c.spotType}|${norm(garage)}`;
    let g = groups.get(key);
    if (!g) {
      const type = SPOT_TYPE_SHORT[c.spotType] ?? c.spotType;
      g = { key, fit, spotType: c.spotType, garage, label: `${type} em ${garage}${fit === "warn" ? " (se der, coberta)" : ""}`, items: [] };
      groups.set(key, g);
    }
    g.items.push(c);
  }
  const byPlace = (a: T, b: T) =>
    String(a.parkName ?? "").localeCompare(String(b.parkName ?? ""), "pt")
    || String(a.spot ?? "").localeCompare(String(b.spot ?? ""), "pt", { numeric: true });
  return [...groups.values()]
    .map((g) => ({ ...g, items: [...g.items].sort(byPlace) }))
    .sort((a, b) => (a.fit === b.fit ? 0 : a.fit === "bad" ? -1 : 1)
      || b.items.length - a.items.length
      || a.label.localeCompare(b.label, "pt"));
}
