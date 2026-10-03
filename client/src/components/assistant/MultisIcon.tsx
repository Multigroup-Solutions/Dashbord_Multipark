import { cn } from "@/lib/utils";

/**
 * Ícone da Multis: o símbolo da Multipark (o "P") com uma estrelinha de IA
 * no canto. O tamanho vem do `className` (ex.: "h-12 w-12").
 */
export function MultisIcon({ className, imgClassName }: { className?: string; imgClassName?: string }) {
  return (
    <span className={cn("relative inline-flex shrink-0", className)} aria-hidden>
      <img src="/icon-192.png" alt="" draggable={false} className={cn("h-full w-full rounded-full object-cover", imgClassName)} />
      <svg viewBox="0 0 24 24" className="absolute -right-[14%] -top-[14%] h-[52%] w-[52%] drop-shadow-sm">
        <path
          d="M12 1.5c.75 5.6 4.9 9.75 10.5 10.5-5.6.75-9.75 4.9-10.5 10.5-.75-5.6-4.9-9.75-10.5-10.5C7.1 11.25 11.25 7.1 12 1.5z"
          fill="#FBBF24"
          stroke="#ffffff"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
