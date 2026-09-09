import type { LucideIcon } from "lucide-react";
import { useLocation } from "wouter";

interface ModuleCardProps {
  icon: LucideIcon;
  label: string;
  path: string;
  count?: number | string;
  /** Valor opcional em destaque (ex: "220,00 €") */
  value?: string;
  /** Cor base do tile. Default = azul Multipark. */
  accentColor?: string;
  alertCount?: number;
}

/**
 * Tile no estilo Multipark Agent:
 * - Fundo branco
 * - Borda azul
 * - Ícone grande centrado
 * - Label em caps azul + (contagem) por baixo
 */
export function ModuleCard({
  icon: Icon,
  label,
  path,
  count,
  value,
  accentColor = "#1E5BFF",
  alertCount,
}: ModuleCardProps) {
  const [, setLocation] = useLocation();

  return (
    <button
      type="button"
      onClick={() => setLocation(path)}
      aria-label={label}
      className="group relative flex flex-col items-center justify-center gap-3 rounded-2xl border-2 bg-card px-4 py-8 text-center transition-all hover:-translate-y-0.5 hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
      style={{
        borderColor: accentColor,
        boxShadow: `0 0 0 0 ${accentColor}00`,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.boxShadow = `0 10px 25px -5px ${accentColor}33`;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = `0 0 0 0 ${accentColor}00`;
      }}
    >
      {alertCount !== undefined && alertCount > 0 && (
        <span className="absolute right-3 top-3 flex min-w-[22px] items-center justify-center rounded-full bg-destructive px-1.5 py-0.5 text-[10px] font-bold text-destructive-foreground">
          {alertCount}
        </span>
      )}

      <Icon
        className="h-10 w-10 transition-transform group-hover:scale-110"
        style={{ color: accentColor }}
        strokeWidth={1.75}
        aria-hidden="true"
      />

      <div className="flex flex-col items-center gap-0.5">
        <span
          className="text-sm font-bold uppercase tracking-wide"
          style={{ color: accentColor }}
        >
          {label}
        </span>
        {count !== undefined && (
          <span
            className="text-lg font-bold leading-none"
            style={{ color: accentColor }}
          >
            ({count})
          </span>
        )}
        {value && (
          <span
            className="text-base font-semibold leading-none"
            style={{ color: accentColor }}
          >
            ({value})
          </span>
        )}
      </div>
    </button>
  );
}
