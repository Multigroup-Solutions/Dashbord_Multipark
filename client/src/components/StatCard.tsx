import type { LucideIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

interface StatCardProps {
  icon?: LucideIcon;
  label: string;
  value: string | number;
  subtitle?: string;
  loading?: boolean;
  /** Tom do ícone: default=primary, semantic para success/warning/danger. */
  tone?: "primary" | "success" | "warning" | "danger" | "muted";
  onClick?: () => void;
}

const TONE_BG: Record<NonNullable<StatCardProps["tone"]>, string> = {
  primary: "bg-primary/10",
  success: "bg-emerald-100",
  warning: "bg-amber-100",
  danger: "bg-red-100",
  muted: "bg-muted",
};

const TONE_FG: Record<NonNullable<StatCardProps["tone"]>, string> = {
  primary: "text-primary",
  success: "text-emerald-600",
  warning: "text-amber-600",
  danger: "text-red-600",
  muted: "text-muted-foreground",
};

/**
 * StatCard — KPI padrão para dashboards.
 * Usar em vez de definir um KPI local em cada página.
 */
export function StatCard({
  icon: Icon,
  label,
  value,
  subtitle,
  loading,
  tone = "primary",
  onClick,
}: StatCardProps) {
  const clickable = typeof onClick === "function";

  return (
    <div
      onClick={onClick}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") onClick?.();
            }
          : undefined
      }
      className={`rounded-2xl border bg-card p-5 transition-all ${
        clickable ? "cursor-pointer hover:-translate-y-0.5 hover:shadow-md" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </div>
          {loading ? (
            <Skeleton className="h-8 w-24" />
          ) : (
            <div className="text-2xl font-bold text-foreground leading-none">
              {value}
            </div>
          )}
          {subtitle && !loading && (
            <div className="text-xs text-muted-foreground">{subtitle}</div>
          )}
        </div>
        {Icon && (
          <div
            className={`h-10 w-10 shrink-0 rounded-xl flex items-center justify-center ${TONE_BG[tone]}`}
          >
            <Icon className={`h-5 w-5 ${TONE_FG[tone]}`} strokeWidth={1.75} />
          </div>
        )}
      </div>
    </div>
  );
}
