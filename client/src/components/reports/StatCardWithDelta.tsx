import { Card, CardContent } from "@/components/ui/card";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

interface StatCardWithDeltaProps {
  title: string;
  value: string;
  previousValue?: number;
  currentValue?: number;
  /** Override delta text (e.g. "Top: Farmacia X") */
  subtitle?: string;
  icon?: React.ReactNode;
  /** Color accent for the card border */
  accent?: "green" | "red" | "amber" | "default";
}

function computeDelta(current?: number, previous?: number): { percent: number; direction: "up" | "down" | "flat" } {
  if (previous === undefined || current === undefined || previous === 0) {
    return { percent: 0, direction: "flat" };
  }
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  if (Math.abs(pct) < 0.5) return { percent: 0, direction: "flat" };
  return { percent: Math.round(pct * 10) / 10, direction: pct > 0 ? "up" : "down" };
}

export function StatCardWithDelta({
  title,
  value,
  previousValue,
  currentValue,
  subtitle,
  icon,
  accent = "default",
}: StatCardWithDeltaProps) {
  const delta = computeDelta(currentValue, previousValue);

  const accentClasses: Record<string, string> = {
    green: "border-l-4 border-l-green-500",
    red: "border-l-4 border-l-red-500",
    amber: "border-l-4 border-l-amber-500",
    default: "",
  };

  return (
    <Card className={`${accentClasses[accent]} h-full`}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {title}
          </span>
          {icon && <span className="text-muted-foreground">{icon}</span>}
        </div>
        <div className="text-2xl font-bold tabular-nums">{value}</div>
        {subtitle ? (
          <span className="text-xs text-muted-foreground mt-1 block">{subtitle}</span>
        ) : delta.direction !== "flat" ? (
          <div className={`flex items-center gap-1 mt-1 text-xs font-medium ${
            delta.direction === "up" ? "text-green-600" : "text-red-600"
          }`}>
            {delta.direction === "up" ? (
              <TrendingUp className="h-3 w-3" />
            ) : (
              <TrendingDown className="h-3 w-3" />
            )}
            <span>{delta.direction === "up" ? "+" : ""}{delta.percent}% vs periodo prec.</span>
          </div>
        ) : previousValue !== undefined ? (
          <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
            <Minus className="h-3 w-3" />
            <span>Invariato vs periodo prec.</span>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
