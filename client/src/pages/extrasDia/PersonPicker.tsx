/**
 * 44a: escolher quem entra na escala do Extras-Dia — só gente do RH (Jorge,
 * 7 out 2026: "devíamos escrever o nome e aparecer ali o RH, porque não pode
 * ninguém vir para cá sem estar registado no RH").
 *
 * Escreve-se o nome e aparece a lista do RH, quem começa pelo que se escreveu
 * primeiro (shared/contactSearch.ts → sortByNameMatch). Secções: a cidade da
 * escala, outras cidades, (no TL) quem ainda não tem a permissão de TL, e no
 * fim quem não tem cidade na ficha — esses não se podem escolher (o servidor
 * recusa).
 */
import { useMemo, useState } from "react";
import { CheckCircle2, ChevronsUpDown, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { matchesContactQuery, sortByNameMatch } from "@shared/contactSearch";
import type { LicenceStatus } from "@shared/drivingLicence";
import { LicenceBadge } from "@/components/rh/RhBadges";

type CityId = "lisbon" | "porto" | "faro";
const CITY_NAMES: Record<CityId, string> = { lisbon: "Lisboa", porto: "Porto", faro: "Faro" };

export interface PickerCandidate {
  id: number;
  fullName: string;
  photoUrl?: string | null;
  /** `hours` = as janelas do dia operacional ("18h–01h"), já com a madrugada marcada no dia seguinte. */
  availability?: { status: "available" | "unavailable" | "no_response"; morning: boolean; night: boolean; hours?: string } | null;
  trainingMissing?: boolean;
  trainingUnknown?: boolean;
  /** Cidade derivada da ficha; null = sem cidade; undefined = não se sabe (leitura falhou). */
  city?: CityId | null;
  hasAccount?: boolean;
  /** Jorge, 7 out 2026: estado da carta (só se mostra quando NÃO está validada). */
  licence?: LicenceStatus;
}

interface Section { key: string; label: string; rows: Array<{ c: PickerCandidate; other: boolean }>; disabled?: boolean }

/** Secções do seletor, já filtradas e ordenadas pela pesquisa. PURA (exportada para os testes). */
export function pickerSections(
  candidates: readonly PickerCandidate[],
  others: readonly PickerCandidate[],
  city: CityId,
  query: string,
): Section[] {
  const all = [...candidates.map((c) => ({ c, other: false })), ...others.map((c) => ({ c, other: true }))];
  const ranked = sortByNameMatch(query, all.filter((x) => matchesContactQuery(query, { name: x.c.fullName })), (x) => x.c.fullName);
  const noCity = (x: { c: PickerCandidate }) => x.c.city === null;
  const sections: Section[] = [
    { key: "here", label: CITY_NAMES[city], rows: ranked.filter((x) => !x.other && !noCity(x) && (x.c.city === undefined || x.c.city === city)) },
    { key: "elsewhere", label: "Outras cidades", rows: ranked.filter((x) => !x.other && !noCity(x) && x.c.city !== undefined && x.c.city !== city) },
    { key: "notTl", label: "Do RH, ainda sem permissão de TL", rows: ranked.filter((x) => x.other && !noCity(x)) },
    { key: "noCity", label: "Sem cidade na ficha — não pode ser escalado(a)", rows: ranked.filter(noCity), disabled: true },
  ];
  return sections.filter((s) => s.rows.length > 0);
}

export function CandidateLabel({ c }: { c: PickerCandidate }) {
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      <Avatar className="h-5 w-5 shrink-0">
        <AvatarImage src={c.photoUrl ?? undefined} className="object-cover" />
        <AvatarFallback className="text-[11px]">{c.fullName.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()}</AvatarFallback>
      </Avatar>
      {c.availability?.status === "available" && (c.availability.hours ? (
        <span className="shrink-0 rounded bg-emerald-50 px-1 text-[11px] text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300" title="Pode nestas horas (dia de trabalho 03h → 03h)">
          {c.availability.hours}
        </span>
      ) : (
        <span className="inline-flex gap-0.5 shrink-0" title="Disse que está disponível">
          {c.availability.morning && <Sun className="h-3 w-3 text-amber-500" />}
          {c.availability.night && <Moon className="h-3 w-3 text-indigo-500" />}
          {!c.availability.morning && !c.availability.night && <CheckCircle2 className="h-3 w-3 text-green-500" />}
        </span>
      ))}
      {c.availability?.status === "no_response" && (
        <span className="h-2 w-2 inline-block rounded-full bg-muted-foreground/30 shrink-0" title="Sem resposta" />
      )}
      {c.availability?.status === "unavailable" && (
        <span className="text-[11px] text-red-500 shrink-0" title="Disse que não está disponível">✕</span>
      )}
      <span className={`truncate ${c.availability?.status === "unavailable" ? "text-muted-foreground" : ""}`}>{c.fullName}</span>
      {c.trainingMissing && (
        <span className="ml-1 shrink-0 rounded bg-amber-100 px-1 text-[11px] font-medium text-amber-800" title="Formação obrigatória por concluir">Formação em falta</span>
      )}
      {c.trainingUnknown && (
        <span className="ml-1 shrink-0 rounded bg-slate-100 px-1 text-[11px] font-medium text-slate-700" title="Não foi possível verificar a formação agora — ao guardar volta a ser verificada">Formação por verificar</span>
      )}
      {c.licence && c.licence !== "validated" && <LicenceBadge status={c.licence} className="ml-1 px-1 py-0 text-[11px]" />}
    </span>
  );
}

export function PersonPicker({
  candidates,
  others = [],
  city,
  value,
  onPick,
}: {
  candidates: readonly PickerCandidate[];
  /** Só no TL: gente do RH que ainda não tem a permissão (pode-se dar daqui). */
  others?: readonly PickerCandidate[];
  city: CityId;
  value: number | null;
  onPick: (c: PickerCandidate) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = useMemo(() => [...candidates, ...others].find((c) => c.id === value) ?? null, [candidates, others, value]);
  const sections = useMemo(() => pickerSections(candidates, others, city, query), [candidates, others, city, query]);

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(""); }}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" role="combobox" aria-expanded={open} className="w-full justify-between font-normal">
          {selected ? <CandidateLabel c={selected} /> : <span className="text-muted-foreground">Escreve o nome (RH)…</span>}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-0 w-[min(440px,calc(100vw-2rem))]" align="start">
        <Command shouldFilter={false}>
          <CommandInput value={query} onValueChange={setQuery} placeholder="Nome da pessoa no RH…" autoFocus />
          <CommandList className="max-h-80">
            <CommandEmpty>Ninguém no RH com esse nome. Cria primeiro a ficha em Recursos Humanos.</CommandEmpty>
            {sections.map((sec) => (
              <CommandGroup key={sec.key} heading={`${sec.label} · ${sec.rows.length}`}>
                {sec.rows.map(({ c }) => (
                  <CommandItem
                    key={`${sec.key}:${c.id}`}
                    value={`${sec.key}:${c.id}`}
                    disabled={sec.disabled}
                    onSelect={() => { onPick(c); setOpen(false); setQuery(""); }}
                  >
                    <CandidateLabel c={c} />
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
