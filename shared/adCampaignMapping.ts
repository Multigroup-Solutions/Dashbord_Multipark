/**
 * Campanhas Google Ads → marca/cidade (nó `brand` da hierarquia
 * Grupo → Cidade → Marca → Parque), a partir do NOME da campanha.
 *
 * As campanhas da Multipark seguem "Marca - Cidade - Língua" ("Airpark -
 * Faro - EN", "Redpark - Lisboa - PT", "Estacionamento - Aeroporto - Porto").
 * A marca vem da CONTA (o nó a que o Jorge associou a conta); a cidade vem
 * do nome.
 *
 * NACIONAL (Jorge, 16 set 2026): há campanhas que não são de uma cidade —
 * "Airpark - Brand", "Skypark - Pmax - PT", "Multipark - Portugal". Essas são
 * da MARCA: `scope = 'national'`, sem cidade; contam no total da marca e em
 * nenhuma cidade. Diferente de "por associar" (scope 'city' + projectId NULL).
 *
 * É uma SUGESTÃO determinística (nunca substring solta): só devolve algo
 * quando encontra exatamente um nó marca com esse nome debaixo dessa cidade,
 * ou quando o nome tem uma palavra nacional inequívoca (brand, pmax, nacional,
 * national, portugal) e nenhuma cidade.
 */

export interface ProjectNode {
  id: number;
  name: string;
  level: string; // group | city | brand | project
  parentId: number | null;
}

export type CampaignScope = "city" | "national";

export interface CampaignForMapping {
  id: number;
  name: string | null;
  /** projectId da CONTA (nó marca ou parque a que a conta está associada). */
  accountProjectId: number | null;
  projectId: number | null;
  scope?: CampaignScope | string | null;
}

export interface MappingSuggestion {
  campaignId: number;
  kind: CampaignScope;
  /** nó marca/cidade (kind 'city'); null quando nacional */
  projectId: number | null;
  projectName: string;
  cityName: string;
  brandName: string;
}

const strip = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** Palavras que, sem cidade no nome, identificam uma campanha nacional (da marca). */
const NATIONAL_TOKENS = new Set(["brand", "pmax", "nacional", "national", "portugal"]);

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

function nameTokens(name: string | null): string[] {
  if (!name) return [];
  return name.split(/[-–|/]/).map((t) => strip(t)).filter(Boolean);
}

/** Cidade referida no nome da campanha (uma das cidades da hierarquia). */
export function cityInCampaignName(name: string | null, projects: ProjectNode[]): ProjectNode | null {
  const tokens = nameTokens(name);
  const cities = projects.filter((p) => p.level === "city");
  const hits = cities.filter((c) => tokens.includes(strip(c.name)));
  return hits.length === 1 ? hits[0] : null;
}

/** Nome com palavra nacional (brand/pmax/nacional/portugal) e sem cidade. */
export function isNationalCampaignName(name: string | null, projects: ProjectNode[]): boolean {
  const tokens = nameTokens(name);
  if (!tokens.some((t) => t.split(/\s+/).some((w) => NATIONAL_TOKENS.has(w)))) return false;
  return cityInCampaignName(name, projects) == null;
}

export function suggestCampaignProject(campaign: CampaignForMapping, projects: ProjectNode[]): MappingSuggestion | null {
  const brand = brandNameForProject(campaign.accountProjectId, projects);
  if (!brand) return null;
  const city = cityInCampaignName(campaign.name, projects);
  if (city) {
    const candidates = projects.filter((p) => p.level === "brand" && p.parentId === city.id && strip(p.name) === strip(brand));
    if (candidates.length !== 1) return null;
    return { campaignId: campaign.id, kind: "city", projectId: candidates[0].id, projectName: `${candidates[0].name} ${city.name}`, cityName: city.name, brandName: candidates[0].name };
  }
  if (isNationalCampaignName(campaign.name, projects)) {
    return { campaignId: campaign.id, kind: "national", projectId: null, projectName: `Nacional · ${brand}`, cityName: "Nacional", brandName: brand };
  }
  return null;
}

/** Já tem marca/cidade escolhida, ou está marcada como nacional. */
export function isCampaignMapped(c: Pick<CampaignForMapping, "projectId" | "scope">): boolean {
  return c.projectId != null || c.scope === "national";
}

/**
 * Repartição do gasto NACIONAL de uma marca pelas cidades dessa marca (Jorge,
 * 16 set 2026: "pões lá como é nacional, só para se ver, e depois divides
 * aquilo na marca pelas cidades"). Peso de cada cidade = gasto das campanhas
 * DE CIDADE dessa marca no período (`cityWeights`, por nó marca-cidade); sem
 * pesos, partes iguais. Devolve frações que somam 1 (ou [] se a marca não
 * existe em nenhuma cidade).
 */
export function nationalSharesForBrand(brand: string, projects: ProjectNode[], cityWeights: Map<number, number>): Array<{ projectId: number; fraction: number }> {
  const nodes = projects.filter((p) => p.level === "brand" && strip(p.name) === strip(brand));
  if (!nodes.length) return [];
  const weights = nodes.map((n) => Math.max(0, cityWeights.get(n.id) ?? 0));
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return nodes.map((n) => ({ projectId: n.id, fraction: 1 / nodes.length }));
  return nodes.map((n, i) => ({ projectId: n.id, fraction: weights[i] / total }));
}

/** Sugestões para todas as campanhas; `onlyUnmapped` ignora as que já têm marca/cidade ou são nacionais. */
export function suggestCampaignProjects(campaigns: CampaignForMapping[], projects: ProjectNode[], onlyUnmapped = true): MappingSuggestion[] {
  const out: MappingSuggestion[] = [];
  for (const c of campaigns) {
    if (onlyUnmapped && isCampaignMapped(c)) continue;
    const s = suggestCampaignProject(c, projects);
    if (!s) continue;
    const same = s.kind === "national" ? c.scope === "national" : s.projectId === c.projectId;
    if (!same) out.push(s);
  }
  return out;
}

/**
 * Separadores do Google Ads por MARCA (Jorge, 24 set 2026): cada campanha vai
 * para a marca que lhe foi escolhida (ex.: "Estacionamento Aeroporto Faro" da
 * conta Multipark.pt marcada Airpark Faro → Airpark), seja de que conta for.
 * Nacional ou por associar → marca da conta (ou o nome da conta, se a conta
 * não tiver marca).
 */
export function campaignTabBrand(
  c: { projectId: number | null; national?: boolean; accountId: number | null },
  projects: ProjectNode[],
  accountBrand: Map<number, string>,
  accountName: Map<number, string>,
): string {
  const chosen = !c.national && c.projectId != null ? brandNameForProject(Number(c.projectId), projects) : null;
  if (chosen) return chosen;
  if (c.accountId == null) return "Sem conta";
  return accountBrand.get(c.accountId) ?? accountName.get(c.accountId) ?? `Conta ${c.accountId}`;
}
