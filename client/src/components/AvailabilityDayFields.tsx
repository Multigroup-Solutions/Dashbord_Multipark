import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sun, Moon } from "lucide-react";

/**
 * Um dia de disponibilidade de um extra — a MESMA forma que o servidor devolve
 * em `getMyWeek().days` e que `setMyAvailability` recebe.
 */
export type AvailabilityDayState = {
  day: string; // YYYY-MM-DD
  label: string; // ex.: "Segunda 14/09"
  morning: boolean;
  night: boolean;
  fromHour: number | null;
  toHour: number | null;
  note: string | null;
};

export function isDayMarked(d: Pick<AvailabilityDayState, "morning" | "night" | "fromHour">): boolean {
  return d.morning || d.night || d.fromHour != null;
}

/** Converte o valor de um `<input type="number">` em hora 0–23 ou null (vazio/inválido). */
function parseHour(raw: string): number | null {
  if (raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 23) return null;
  return n;
}

/**
 * Campos de UM dia (turnos manhã/noite, horas opcionais, nota). Partilhado
 * entre a página do próprio extra ("A minha disponibilidade") e o diálogo do
 * backoffice que marca a disponibilidade por um extra — os dois têm de
 * oferecer exatamente as mesmas opções, senão o que o backoffice marca não
 * cabe no que o extra vê (e vice-versa).
 *
 * Não tem cabeçalho nem moldura: quem chama decide o invólucro (Card na página
 * do extra, linha compacta no diálogo).
 */
export function AvailabilityDayFields({
  day,
  onChange,
  disabled,
  compact,
}: {
  day: AvailabilityDayState;
  onChange: (patch: Partial<AvailabilityDayState>) => void;
  disabled?: boolean;
  /** Layout numa só linha (diálogo do backoffice). */
  compact?: boolean;
}) {
  return (
    <div className={compact ? "flex flex-wrap items-center gap-x-4 gap-y-2" : "space-y-3"}>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <label className="flex items-center gap-2 cursor-pointer">
          <Switch
            checked={day.morning}
            disabled={disabled}
            onCheckedChange={(v) => onChange({ morning: v })}
            aria-label={`Manhã ${day.label}`}
          />
          <Sun className="h-4 w-4 text-amber-500" />
          <span className="text-sm">{compact ? "Manhã" : "Manhã (03h–15h)"}</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <Switch
            checked={day.night}
            disabled={disabled}
            onCheckedChange={(v) => onChange({ night: v })}
            aria-label={`Noite ${day.label}`}
          />
          <Moon className="h-4 w-4 text-indigo-500" />
          <span className="text-sm">{compact ? "Noite" : "Noite (15h–03h)"}</span>
        </label>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Label className="text-xs text-muted-foreground">{compact ? "Horas:" : "Horas (opcional):"}</Label>
        <Input
          type="number"
          min={0}
          max={23}
          placeholder="das"
          className="w-20 h-8"
          disabled={disabled}
          value={day.fromHour ?? ""}
          aria-label={`Das (hora) ${day.label}`}
          onChange={(e) => onChange({ fromHour: parseHour(e.target.value) })}
        />
        <span className="text-muted-foreground">→</span>
        <Input
          type="number"
          min={0}
          max={23}
          placeholder="às"
          className="w-20 h-8"
          disabled={disabled}
          value={day.toHour ?? ""}
          aria-label={`Às (hora) ${day.label}`}
          onChange={(e) => onChange({ toHour: parseHour(e.target.value) })}
        />
        <Input
          placeholder="Nota (opcional)"
          className="flex-1 min-w-[140px] h-8"
          maxLength={300}
          disabled={disabled}
          value={day.note ?? ""}
          aria-label={`Nota ${day.label}`}
          onChange={(e) => onChange({ note: e.target.value || null })}
        />
      </div>
    </div>
  );
}
