import { LayoutGrid, List } from "lucide-react";
import { Button } from "@/components/ui/button";
import { VIEW_MODE_LABELS, type ViewMode } from "@shared/viewPref";

/**
 * D46: "Cartões / Lista" — o mesmo botão em todas as listas de pessoas e
 * contactos. O escolhido fica azul (variante "selected"), o outro branco.
 */
export function ViewToggle({ value, onChange, className }: { value: ViewMode; onChange: (v: ViewMode) => void; className?: string }) {
  return (
    <div role="group" aria-label="Ver em cartões ou lista" className={`inline-flex gap-1 ${className ?? ""}`}>
      {(["cards", "list"] as const).map((v) => {
        const Icon = v === "cards" ? LayoutGrid : List;
        return (
          <Button key={v} type="button" size="sm" className="h-8" variant={value === v ? "selected" : "outline"}
            aria-pressed={value === v} onClick={() => onChange(v)}>
            <Icon className="h-3.5 w-3.5 sm:mr-1" /><span className="hidden sm:inline">{VIEW_MODE_LABELS[v]}</span>
            <span className="sr-only sm:hidden">{VIEW_MODE_LABELS[v]}</span>
          </Button>
        );
      })}
    </div>
  );
}
