/**
 * Campanhas Google Ads → marca/cidade (nó `brand` da hierarquia
 * Grupo → Cidade → Marca → Parque), a partir do NOME da campanha.
 *
 * As campanhas da Multipark seguem "Marca - Cidade - Língua" ("Airpark -
 * Faro - EN", "Redpark - Lisboa - PT", "Estacionamento - Aeroporto - Porto").
 * A marca vem da CONTA (o nó a que o Jorge associou a conta); a cidade vem
 * do nome. Sem cidade no nome (Brand, Pmax, Espanha…) a campanha é nacional
 * e fica sem marca/cidade — conta no total geral, não numa cidade.
 *
 * É uma SUGESTÃO determinística (nunca substring solta): só devolve algo
 * quando encontra exatamente um nó marca com esse nome debaixo dessa cidade.
 */

export interface ProjectNode {
  id: number;
  name: string;
  level: string; // group | city | brand | project
  parentId: number | null;
}

export interface CampaignForMapping {
  id: number;
  name: string | null;
  /** projectId da CONTA (nó marca ou parque a que a conta está associada). */
  accountProjectId: number | null;
  projectId: number | null;
}

export interface MappingSuggestion {
  campaignId: number;
  projectId: number;
  projectName: string;
  cityName: string;
  brandName: string;
}

const strip = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** Nome do nó marca de que o projeto da conta desce (marca → ela própria; parque → a marca acima). */
export function brandNameForProject(projectId: number | null, projects: ProjectNode[]): string | null {
  if (projectId == null) return null;
  const byId = new Map(projects.map((p) => [p.id, p]));
  let node = byId.get(projectId);
  const seen = new Set<number>();
  while (node && node.level !== "brand") {
    if (seen.has(node.id) || node.parentId == null) return null;
    seen.add(node.id);
    node = byId.get(node.parentId);
  }
  return node ? node.name : null;
}

/** Cidade referida no nome da campanha (uma das cidades da hierarquia). */
export function cityInCampaignName(name: string | null, projects: ProjectNode[]): ProjectNode | null {
  if (!name) return null;
  const tokens = name.split(/[-–|/]/).map((t) => strip(t)).filter(Boolean);
  const cities = projects.filter((p) => p.level === "city");
  const hits = cities.filter((c) => tokens.includes(strip(c.name)));
  return hits.length === 1 ? hits[0] : null;
}

export function suggestCampaignProject(campaign: CampaignForMapping, projects: ProjectNode[]): MappingSuggestion | null {
  const brand = brandNameForProject(campaign.accountProjectId, projects);
  const city = cityInCampaignName(campaign.name, projects);
  if (!brand || !city) return null;
  const candidates = projects.filter((p) => p.level === "brand" && p.parentId === city.id && strip(p.name) === strip(brand));
  if (candidates.length !== 1) return null;
  return { campaignId: campaign.id, projectId: candidates[0].id, projectName: `${candidates[0].name} ${city.name}`, cityName: city.name, brandName: candidates[0].name };
}

/** Sugestões para todas as campanhas; `onlyUnmapped` ignora as que já têm marca/cidade. */
export function suggestCampaignProjects(campaigns: CampaignForMapping[], projects: ProjectNode[], onlyUnmapped = true): MappingSuggestion[] {
  const out: MappingSuggestion[] = [];
  for (const c of campaigns) {
    if (onlyUnmapped && c.projectId != null) continue;
    const s = suggestCampaignProject(c, projects);
    if (s && s.projectId !== c.projectId) out.push(s);
  }
  return out;
}
