import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Hook to manage dashboard filter state */
export function useDashboardFilters(defaults?: { from?: string; to?: string }) {
  const globalFilters = useGlobalFilters();

  const now = new Date();
  const defaultFrom =
    defaults?.from ??
    new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const defaultTo = defaults?.to ?? now.toISOString().slice(0, 10);

  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [cityId, setCityId] = useState<number | null>(null);
  const [brandId, setBrandId] = useState<number | null>(null);
  const [period, setPeriod] = useState("monthly");

  const projectId = useMemo(() => {
    if (brandId !== null) return brandId;
    if (cityId !== null) return cityId;
    return undefined;
  }, [cityId, brandId]);

  return {
    from,
    to,
    setFrom,
    setTo,
    cityId,
    setCityId,
    brandId,
    setBrandId,
    projectId,
    period,
    setPeriod,
  };
}

interface DashboardFilterBarProps {
  from: string;
  to: string;
  onFromChange: (v: string) => void;
  onToChange: (v: string) => void;
  cityId: number | null;
  onCityChange: (id: number | null) => void;
  brandId: number | null;
  onBrandChange: (id: number | null) => void;
  showPeriod?: boolean;
  period?: string;
  onPeriodChange?: (v: string) => void;
}

export function DashboardFilterBar({
  from,
  to,
  onFromChange,
  onToChange,
  cityId,
  onCityChange,
  brandId,
  onBrandChange,
  showPeriod,
  period,
  onPeriodChange,
}: DashboardFilterBarProps) {
  const globalFilters = useGlobalFilters();
  // Lista de marcas coerente com a CIDADE ESCOLHIDA NESTA BARRA (o contexto
  // global segue a cidade do header, que pode ser outra). Sem cidade →
  // marcas globais (ID negativo = a marca em todas as cidades, resolvido
  // no servidor por resolveProjectIds).
  const { data: allProjects } = trpc.projects.list.useQuery();
  const brandOptions = useMemo(() => {
    if (!allProjects) return [];
    if (cityId !== null) {
      return (allProjects as any[])
        .filter((p) => p.level === "brand" && p.parentId === cityId)
        .map((p) => ({ id: p.id, name: p.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
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

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div>
        <Label className="text-xs mb-1 block">De</Label>
        <Input
          type="date"
          value={from}
          onChange={(e) => onFromChange(e.target.value)}
          className="w-[140px]"
        />
      </div>
      <div>
        <Label className="text-xs mb-1 block">Até</Label>
        <Input
          type="date"
          value={to}
          onChange={(e) => onToChange(e.target.value)}
          className="w-[140px]"
        />
      </div>
      <div>
        <Label className="text-xs mb-1 block">Cidade</Label>
        <Select
          value={cityId !== null ? String(cityId) : "all"}
          onValueChange={(v) => {
            onCityChange(v === "all" ? null : Number(v));
            onBrandChange(null);
          }}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Todas" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas</SelectItem>
            {globalFilters.cities.map((c) => (
              <SelectItem key={c.id} value={String(c.id)}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label className="text-xs mb-1 block">Marca</Label>
        <Select
          value={brandId !== null ? String(brandId) : "all"}
          onValueChange={(v) => onBrandChange(v === "all" ? null : Number(v))}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Todas" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas</SelectItem>
            {brandOptions.map((b) => (
              <SelectItem key={b.id} value={String(b.id)}>
                {b.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {showPeriod && onPeriodChange && (
        <div>
          <Label className="text-xs mb-1 block">Período</Label>
          <Select value={period || "monthly"} onValueChange={onPeriodChange}>
            <SelectTrigger className="w-[130px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">Diário</SelectItem>
              <SelectItem value="weekly">Semanal</SelectItem>
              <SelectItem value="monthly">Mensal</SelectItem>
              <SelectItem value="yearly">Anual</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}
