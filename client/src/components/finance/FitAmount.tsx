import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { eurCompact, eurFull } from "@/lib/financeFormat";

/**
 * Valor monetário que NUNCA transborda da caixa: mostra o valor completo
 * quando cabe; quando não cabe, passa ao formato compacto ("1,2 M €") com o
 * valor completo no `title` (hover) e para leitores de ecrã.
 *
 * Pôr `min-w-0` no pai da grelha/flex para a largura poder encolher.
 */
export default function FitAmount({
  value,
  full,
  compact,
  className,
}: {
  value?: number | string | null;
  /** Texto completo já formatado (por omissão eurFull(value)). */
  full?: string;
  /** Texto compacto (por omissão eurCompact(value)). */
  compact?: string;
  className?: string;
}) {
  const fullText = full ?? eurFull(value);
  const compactText = compact ?? eurCompact(value);
  const boxRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [tight, setTight] = useState(false);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const measure = measureRef.current;
    if (!box || !measure) return;
    const check = () => setTight(measure.offsetWidth > box.clientWidth + 0.5);
    check();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(check);
    ro.observe(box);
    return () => ro.disconnect();
  }, [fullText]);

  const showCompact = tight && compactText !== fullText;
  return (
    <span
      ref={boxRef}
      className={cn("relative block min-w-0 max-w-full whitespace-nowrap tabular-nums", className)}
      title={showCompact ? fullText : undefined}
    >
      {/* Medidor invisível com o valor completo (mesma tipografia). */}
      <span aria-hidden className="invisible pointer-events-none absolute inset-0 overflow-hidden">
        <span ref={measureRef} className="inline-block whitespace-nowrap">
          {fullText}
        </span>
      </span>
      {showCompact ? (
        <>
          <span aria-hidden>{compactText}</span>
          <span className="sr-only">{fullText}</span>
        </>
      ) : (
        fullText
      )}
    </span>
  );
}
