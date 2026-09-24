import { createContext, useContext, useState, useMemo, useEffect, type ReactNode } from "react";
import { trpc } from "@/lib/trpc";

interface DateRange {
  from: Date | null;
  to: Date | null;
}

interface GlobalFiltersState {
  cityId: number | null;
  brandId: number | null;
  dateRange: DateRange;
  setCityId: (id: number | null) => void;
  setBrandId: (id: number | null) => void;
  setDateRange: (range: DateRange) => void;
  /** All cities from hierarchy */
  cities: { id: number; name: string }[];
  /** Brands filtered by selected city (or all if no city) */
  brands: { id: number; name: string }[];
  /** Project IDs matching current city+brand filter */
  projectIds: number[] | undefined;
  missingCostCenter: boolean;
  /** Single projectId for tRPC queries (undefined = no filter) */
  projectId: number | undefined;
  isLoading: boolean;
}

const GlobalFiltersContext = createContext<GlobalFiltersState | null>(null);

export function GlobalFiltersProvider({ children }: { children: ReactNode }) {
  const [selectedCityId, setSelectedCityId] = useState<number | null>(null);
  const [brandId, setBrandId] = useState<number | null>(null);
  const [dateRange, setDateRange] = useState<DateRange>({ from: null, to: null });

  const { data: allProjects, isLoading } = trpc.projects.list.useQuery();
  // Acesso por cidade (pedido Jorge): cada um vê a cidade do seu centro de
  // custos (+ extras por permissão); admin/grupo vê todas. O seletor global só
  // mostra as permitidas e entra por defeito na cidade da pessoa.
  const { data: cityAccess, isLoading: accessLoading, error: accessError } = trpc.permissions.myCityAccess.useQuery();

  const cities = useMemo(() => {
    if (!allProjects || !cityAccess) return [];
    let list = allProjects
      .filter((p: any) => p.level === "city")
      .map((p: any) => ({ id: p.id, name: p.name }));
    if (cityAccess && !cityAccess.all) {
      const allowed = new Set(cityAccess.cityIds);
      list = list.filter((c: any) => allowed.has(c.id));
    }
    return list.sort((a: any, b: any) => a.name.localeCompare(b.name));
  }, [allProjects, cityAccess]);

  const allowedSelection = selectedCityId != null && cities.some(c => c.id === selectedCityId);
  const cityId = allowedSelection ? selectedCityId : cityAccess?.all ? null : cityAccess?.defaultCityId ?? null;
  const setCityId = (id: number | null) => {
    if ((id === null && cityAccess?.all) || (id != null && cities.some(c => c.id === id))) {
      setSelectedCityId(id);
      setBrandId(null);
    }
  };
  useEffect(() => {
    if (cityAccess && !cityAccess.all) setBrandId(null);
  }, [cityAccess?.all, cityAccess?.defaultCityId]);

  const brands = useMemo(() => {
    if (!allProjects) return [];
    if (cityId !== null) {
      // Com cidade escolhida: marcas dessa cidade (comportamento normal)
      return allProjects
        // Nós inativos (marca fechada) não entram no seletor — o histórico
        // continua acessível porque o servidor inclui descendentes inativos.
        .filter((p: any) => p.level === "brand" && p.parentId === cityId && !!p.isActive)
        .map((p: any) => ({ id: p.id, name: p.name }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name));
    }
    // SEM cidade: MARCAS GLOBAIS — a mesma marca existe nas várias cidades
    // com o mesmo nome; agrupamos e usamos um ID NEGATIVO (−id do primeiro nó)
    // que o servidor (resolveProjectIds) expande para a marca em TODAS as
    // cidades. Pedido do Jorge: "medir o que uma marca fez nas diferentes cidades".
    const byName = new Map<string, { id: number; name: string; count: number }>();
    for (const p of allProjects as any[]) {
      if (p.level !== "brand" || !p.isActive) continue;
      const key = p.name.trim().toLowerCase();
      const ex = byName.get(key);
      if (ex) ex.count += 1;
      else byName.set(key, { id: -p.id, name: p.name, count: 1 });
    }
    return Array.from(byName.values())
      .map((b) => ({ id: b.id, name: b.count > 1 ? `${b.name} (todas as cidades)` : b.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [allProjects, cityId]);

  // When city changes and selected brand is no longer valid, reset brand
  useEffect(() => {
    if (brandId !== null) {
      const brandExists = brands.some((b) => b.id === brandId);
      if (!brandExists) {
        setBrandId(null);
      }
    }
  }, [brands, brandId]);

  // Compute project IDs that match current filters
  const projectIds = useMemo(() => {
    if (!allProjects) return undefined;
    if (cityId === null && brandId === null) return undefined; // no filter

    const ids: number[] = [];
    const collectDescendants = (parentId: number) => {
      for (const p of allProjects as any[]) {
        if (p.parentId === parentId) {
          ids.push(p.id);
          collectDescendants(p.id);
        }
      }
    };

    if (brandId !== null && brandId < 0) {
      // Marca global: todos os nós brand com o mesmo nome + descendentes
      const anchor = (allProjects as any[]).find((p) => p.id === -brandId);
      if (anchor) {
        for (const p of allProjects as any[]) {
          if (p.level === "brand" && p.name.trim().toLowerCase() === anchor.name.trim().toLowerCase()) {
            ids.push(p.id);
            collectDescendants(p.id);
          }
        }
      }
    } else if (brandId !== null) {
      // Specific brand selected: get brand + its descendants
      ids.push(brandId);
      collectDescendants(brandId);
    } else if (cityId !== null) {
      // Only city selected: get city + all its descendants
      ids.push(cityId);
      collectDescendants(cityId);
    }

    return ids;
  }, [allProjects, cityId, brandId]);

  // For tRPC queries that accept a single projectId
  // If brand is selected, use brand. If only city, use city. If neither, undefined.
  const projectId = useMemo(() => {
    if (brandId !== null) return brandId;
    if (cityId !== null) return cityId;
    return undefined;
  }, [cityId, brandId]);

  return (
    <GlobalFiltersContext.Provider
      value={{
        cityId,
        missingCostCenter: cityAccess?.missingCostCenter ?? !!accessError,
        brandId,
        dateRange,
        setCityId,
        setBrandId,
        setDateRange,
        cities,
        brands,
        projectIds,
        projectId,
        isLoading: isLoading || accessLoading,
      }}
    >
      {children}
    </GlobalFiltersContext.Provider>
  );
}

export function useGlobalFilters() {
  const ctx = useContext(GlobalFiltersContext);
  if (!ctx) throw new Error("useGlobalFilters must be used within GlobalFiltersProvider");
  return ctx;
}
