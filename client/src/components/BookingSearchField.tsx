import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { fmtPTDate, fmtPTDateTime } from "@/lib/lisbonTime";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Search } from "lucide-react";

export type FoundBooking = {
  id: number;
  externalId: string;
  bookingNumber: string | null;
  status: string | null;
  parkName: string | null;
  city: string | null;
  projectId: number | null;
  checkIn: string | null;
  checkOut: string | null;
  totalPrice: number | null;
  clientFirstName: string | null;
  clientLastName: string | null;
  clientEmail: string | null;
  clientPhone: string | null;
  licensePlate: string | null;
};

export type BookingSearchFieldProps = {
  /** Callback quando o utilizador escolhe uma reserva. */
  onSelect: (b: FoundBooking) => void;
  /** Label do campo. Default: "Buscar reserva (nº reserva, matrícula, email, nome)" */
  label?: string;
  /** Placeholder. */
  placeholder?: string;
  /** Texto de hint pequeno acima do input. */
  hint?: string;
  /** Cor do destaque do bloco (light tailwind class para o bg). */
  accent?: "blue" | "emerald" | "amber" | "violet";
};

const ACCENTS: Record<NonNullable<BookingSearchFieldProps["accent"]>, { bg: string; border: string; label: string }> = {
  blue: { bg: "bg-blue-50 dark:bg-blue-950/30", border: "border-blue-200", label: "text-blue-700 dark:text-blue-300" },
  emerald: { bg: "bg-emerald-50 dark:bg-emerald-950/30", border: "border-emerald-200", label: "text-emerald-700 dark:text-emerald-300" },
  amber: { bg: "bg-amber-50 dark:bg-amber-950/30", border: "border-amber-200", label: "text-amber-700 dark:text-amber-300" },
  violet: { bg: "bg-violet-50 dark:bg-violet-950/30", border: "border-violet-200", label: "text-violet-700 dark:text-violet-300" },
};

/**
 * Campo de pesquisa universal de reservas Multipark.
 * Procura por nº reserva, matrícula, email ou nome (DB local).
 * Mostra resultados clicáveis; ao escolher um, chama onSelect com os
 * dados da reserva (cópia local, já completa pelo webhook — sem chamadas à API).
 */
export default function BookingSearchField({
  onSelect,
  label = "Buscar reserva (nº reserva, matrícula, email, nome)",
  placeholder = "Ex: 15413 ou AA-00-BB ou nome do cliente...",
  hint,
  accent = "blue",
}: BookingSearchFieldProps) {
  const [query, setQuery] = useState("");
  const accentCfg = ACCENTS[accent];

  const { data: results = [] } = trpc.multipark.searchBooking.useQuery(
    { search: query },
    { enabled: query.trim().length >= 2 },
  );

  const handleChoose = (b: FoundBooking) => {
    onSelect(b);
    setQuery("");
  };

  return (
    <div className={`p-3 rounded-lg border ${accentCfg.bg} ${accentCfg.border}`}>
      <Label className={`font-medium ${accentCfg.label}`}>{label}</Label>
      {hint && <p className="text-xs text-muted-foreground mb-1">{hint}</p>}
      <div className="flex items-center gap-2 mt-1">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-muted-foreground" />
          <Input
            placeholder={placeholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>
      {results.length > 0 && (
        <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
          {results.map((b: any) => (
            <button
              key={b.id}
              type="button"
              onClick={() => handleChoose(b as FoundBooking)}
              className="w-full flex items-center justify-between p-2 bg-white dark:bg-gray-900 rounded border cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/30 text-left"
            >
              <div className="text-sm min-w-0 flex-1">
                <span className="font-mono font-medium">#{b.bookingNumber}</span>
                {b.licensePlate && <span className="font-mono ml-2">{b.licensePlate}</span>}
                {(b.clientFirstName || b.clientLastName) && (
                  <span className="text-muted-foreground ml-2">
                    {[b.clientFirstName, b.clientLastName].filter(Boolean).join(" ")}
                  </span>
                )}
                {b.clientEmail && (
                  <span className="text-xs text-muted-foreground ml-2">{b.clientEmail}</span>
                )}
              </div>
              <div className="text-xs text-muted-foreground whitespace-nowrap ml-2">
                {b.parkName} {b.city && !b.parkName?.includes(b.city) ? b.city : ""}
                {b.checkIn && <span className="ml-2">{fmtPTDate(b.checkIn)}</span>}
              </div>
            </button>
          ))}
        </div>
      )}
      {query.trim().length >= 2 && results.length === 0 && (
        <p className="text-xs text-muted-foreground mt-1">Nenhuma reserva encontrada</p>
      )}
    </div>
  );
}
