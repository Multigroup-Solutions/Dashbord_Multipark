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
  warn: "coberto numa garagem descoberta (passa para a coberta se der)",
};
