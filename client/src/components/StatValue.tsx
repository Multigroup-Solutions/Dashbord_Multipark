import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Valor grande de um cartão KPI/estatística que NUNCA sai da caixa.
 *
 * O tamanho da letra ajusta-se à largura disponível (container query `cqi`)
 * e ao comprimento do texto: "51" fica grande, "1 234 567,89 €" encolhe até
 * `min` px. Se mesmo assim não couber, corta com reticências e o valor
 * completo fica no tooltip (`title`). Algarismos tabulares para alinharem.
 *
 * Uso: <StatValue value={fmtEur(total)} className="text-[#0c1f3f]" />
 */
export function StatValue({
  value,
  title,
  min = 16,
  max = 28,
  className,
  style,
}: {
  value: ReactNode;
  /** Texto completo para o tooltip (por omissão, o próprio valor se for texto). */
  title?: string;
  /** Tamanho mínimo/máximo da letra em px. */
  min?: number;
  max?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const text = typeof value === "string" || typeof value === "number" ? String(value) : title ?? "";
  // ~0.58em por carácter em Poppins bold com algarismos tabulares (medido); se
  // falhar por pouco, o truncate + title seguram
  const chars = Math.max(text.length, 3) * 0.58;
  return (
    <div className="@container min-w-0 w-full">
      <div
        title={title ?? (text || undefined)}
        className={cn("font-display font-bold leading-tight tabular-nums truncate", className)}
        style={{ fontSize: `clamp(${min}px, calc(100cqi / ${chars.toFixed(2)}), ${max}px)`, ...style }}
      >
        {value}
      </div>
    </div>
  );
}
