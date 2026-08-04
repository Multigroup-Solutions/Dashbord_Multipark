import { createContext, useContext, useState, useMemo, type ReactNode } from "react";
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
  /** Single projectId for tRPC queries (undefined = no filter) */
  projectId: number | undefined;
  isLoading: boolean;
}

const GlobalFiltersContext = createContext<GlobalFiltersState | null>(null);

export function GlobalFiltersProvider({ children }: { children: ReactNode }) {
  const [cityId, setCityId] = useState<number | null>(null);
  const [brandId, setBrandId] = useState<number | null>(null);
  const [dateRange, setDateRange] = useState<DateRange>({ from: null, to: null });

  const { data: allProjects, isLoading } = trpc.projects.list.useQuery();

  const cities = useMemo(() => {
    if (!allProjects) return [];
    return allProjects
      .filter((p: any) => p.level === "city")
      .map((p: any) => ({ id: p.id, name: p.name }))
      .sort((a: any, b: any) => a.name.localeCompare(b.name));
  }, [allProjects]);

  const brands = useMemo(() => {
    if (!allProjects) return [];
    if (cityId !== null) {
      // Com cidade escolhida: marcas dessa cidade (comportamento normal)
      return allProjects
        .filter((p: any) => p.level === "brand" && p.parentId === cityId)
        .map((p: any) => ({ id: p.id, name: p.name }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name));
    }
    // SEM cidade: MARCAS GLOBAIS — a mesma marca existe nas várias cidades
    // com o mesmo nome; agrupamos e usamos um ID NEGATIVO (−id do primeiro nó)
    // que o servidor (resolveProjectIds) expande para a marca em TODAS as
    // cidades. Pedido do Jorge: "medir o que uma marca fez nas diferentes cidades".
    const byName = new Map<string, { id: number; name: string; count: number }>();
    for (const p of allProjects as any[]) {
      if (p.level !== "brand") continue;
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
  useMemo(() => {
    if (brandId !== null && brands.length > 0) {
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
        brandId,
        dateRange,
        setCityId,
        setBrandId,
        setDateRange,
        cities,
        brands,
        projectIds,
        projectId,
        isLoading,
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
