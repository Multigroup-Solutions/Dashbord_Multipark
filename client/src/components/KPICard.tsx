import type { LucideIcon } from "lucide-react";
import { TrendingUp, TrendingDown } from "lucide-react";
import { Card } from "@/components/ui/card";
import { StatValue } from "@/components/StatValue";

interface KPICardProps {
  icon: LucideIcon;
  iconColor: string;
  iconBg: string;
  label: string;
  value: string;
  delta: number;
  deltaLabel: string;
}

export function KPICard({
  icon: Icon,
  iconColor,
  iconBg,
  label,
  value,
  delta,
  deltaLabel,
}: KPICardProps) {
  const isPositive = delta >= 0;

  return (
    <Card className="p-4 sm:p-5 gap-0 min-w-0 hover:shadow-md hover:-translate-y-0.5 transition-all cursor-default">
      <div className="flex items-start justify-between gap-2 mb-4">
        <div
          className="h-11 w-11 sm:h-12 sm:w-12 shrink-0 rounded-[10px] flex items-center justify-center"
          style={{ backgroundColor: iconBg }}
        >
          <Icon className="h-6 w-6" style={{ color: iconColor }} />
        </div>
        <div
          className={`flex items-center gap-1 px-2 py-1 rounded-md text-[13px] font-semibold tabular-nums shrink-0 ${
            isPositive
              ? "bg-green-100 text-green-700"
              : "bg-red-100 text-red-700"
          }`}
        >
          {isPositive ? (
            <TrendingUp className="h-3.5 w-3.5" />
          ) : (
            <TrendingDown className="h-3.5 w-3.5" />
          )}
          {Math.abs(delta)}%
        </div>
      </div>
      <div className="text-[13px] font-medium text-muted-foreground mb-2 truncate" title={label}>
        {label}
      </div>
      <StatValue value={value} className="text-foreground mb-1" />
      <div className="text-xs text-muted-foreground truncate" title={deltaLabel}>{deltaLabel}</div>
    </Card>
  );
}
