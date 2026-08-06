// Seletor de cidades MULTI (regra do Jorge): em cada página deve poder
// escolher-se todas, uma, duas… — limitado às cidades a que a pessoa tem
// direito (permissions.myCityAccess). Quem só tem UMA cidade vê o seletor
// bloqueado nessa cidade.
//
// value = [] significa "todas as permitidas". O onChange devolve os IDs dos
// projetos-cidade selecionados (vazio = todas).
import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { MapPin, ChevronDown } from "lucide-react";

export function CityMultiSelect({
  value,
  onChange,
  className,
}: {
  value: number[];
  onChange: (cityIds: number[]) => void;
  className?: string;
}) {
  const { data: allProjects } = trpc.projects.list.useQuery();
  const { data: access } = trpc.permissions.myCityAccess.useQuery();

  const cities = useMemo(() => {
    if (!allProjects) return [] as { id: number; name: string }[];
    let list = (allProjects as any[])
      .filter((p) => p.level === "city")
      .map((p) => ({ id: p.id, name: p.name }));
    if (access && !access.all) {
      const allowed = new Set(access.cityIds);
      list = list.filter((c) => allowed.has(c.id));
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }, [allProjects, access]);

  const locked = cities.length <= 1;
  const selected = value.length === 0 ? cities.map((c) => c.id) : value;
  const label =
    value.length === 0
      ? locked && cities[0] ? cities[0].name : "Todas as cidades"
      : cities.filter((c) => value.includes(c.id)).map((c) => c.name).join(", ");

  const toggle = (id: number) => {
    const set = new Set(selected);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    // todas marcadas = sem filtro
    const next = cities.every((c) => set.has(c.id)) ? [] : Array.from(set);
    if (next.length === 0 && !cities.every((c) => set.has(c.id))) return; // nunca zero cidades
    onChange(next);
  };

  if (locked) {
    return (
      <Badge variant="outline" className={`gap-1.5 h-9 px-3 text-[13px] font-medium ${className ?? ""}`}>
        <MapPin className="w-3.5 h-3.5" /> {cities[0]?.name ?? "—"}
      </Badge>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className={`h-9 gap-2 font-normal ${className ?? ""}`}>
          <MapPin className="w-4 h-4 text-muted-foreground" />
          <span className="max-w-[180px] truncate">{label}</span>
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-52 p-2" align="start">
        <button
          type="button"
          className="w-full text-left text-sm font-medium px-2 py-1.5 rounded hover:bg-accent"
          onClick={() => onChange([])}
        >
          Todas as cidades
        </button>
        <div className="border-t my-1" />
        {cities.map((c) => (
          <label key={c.id} className="flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-accent cursor-pointer text-sm">
            <Checkbox checked={selected.includes(c.id)} onCheckedChange={() => toggle(c.id)} />
            {c.name}
          </label>
        ))}
      </PopoverContent>
    </Popover>
  );
}
