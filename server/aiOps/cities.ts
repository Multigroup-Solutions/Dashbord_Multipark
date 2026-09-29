/**
 * Cidades operacionais (lisbon/porto/faro, como a passagem de turno e o
 * Extras-Dia) ↔ árvore de projetos (nó `level='city'` + descendentes).
 */
import { matchCityKey } from "../../shared/city";
import { HANDOVER_CITIES, HANDOVER_CITY_LABELS, type HandoverCity } from "../../shared/shiftHandover";

export type OpsCity = HandoverCity;
export const OPS_CITIES: readonly OpsCity[] = HANDOVER_CITIES;
export const OPS_CITY_LABELS = HANDOVER_CITY_LABELS;

export interface ProjectLite { id: number; name: string; level: string | null; parentId: number | null }
export interface CityTree { city: OpsCity; rootId: number; ids: number[] }

const KEY_TO_CITY = { lisboa: "lisbon", porto: "porto", faro: "faro" } as const;

/** Texto livre ("Lisboa", "lisbon", "Porto") → cidade operacional. PURA. */
export function opsCityOf(text: string | null | undefined): OpsCity | null {
  const t = String(text ?? "").trim().toLowerCase();
  if ((OPS_CITIES as readonly string[]).includes(t)) return t as OpsCity;
  const k = matchCityKey(text);
  return k ? KEY_TO_CITY[k] : null;
}

/** Nó de cidade + descendentes, por cidade (a 1.ª de cada, se houver repetidas). PURA. */
export function cityTrees(projects: ProjectLite[]): CityTree[] {
  const out: CityTree[] = [];
  for (const node of projects.filter((p) => p.level === "city")) {
    const city = opsCityOf(node.name);
    if (!city || out.some((t) => t.city === city)) continue;
    const ids = new Set([node.id]);
    for (let changed = true; changed;) {
      changed = false;
      for (const p of projects) if (p.parentId != null && ids.has(p.parentId) && !ids.has(p.id)) { ids.add(p.id); changed = true; }
    }
    out.push({ city, rootId: node.id, ids: [...ids] });
  }
  return out;
}

export function cityOfProject(projectId: number | null | undefined, trees: CityTree[]): CityTree | null {
  if (projectId == null) return null;
  return trees.find((t) => t.ids.includes(projectId)) ?? null;
}

export async function loadCityTrees(): Promise<CityTree[]> {
  const { getProjects } = await import("../db");
  const rows = (await getProjects()) as any[];
  return cityTrees(rows.map((p) => ({ id: Number(p.id), name: String(p.name ?? ""), level: p.level ?? null, parentId: p.parentId == null ? null : Number(p.parentId) })));
}
