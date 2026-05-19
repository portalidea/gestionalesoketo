import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Calendar } from "lucide-react";

export interface DateRange {
  dateFrom: string; // ISO date string
  dateTo: string;
}

interface DateRangePickerProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
}

function startOfMonth(d: Date): string {
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}

function endOfDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function getPresets(): Array<{ label: string; range: DateRange }> {
  const now = new Date();
  const thisMonthStart = startOfMonth(now);
  const today = endOfDay(now);

  // Previous month
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

  // Quarter (last 3 months)
  const quarterStart = new Date(now.getFullYear(), now.getMonth() - 2, 1);

  // Year
  const yearStart = new Date(now.getFullYear(), 0, 1);

  return [
    { label: "Mese corrente", range: { dateFrom: thisMonthStart, dateTo: today } },
    { label: "Mese precedente", range: { dateFrom: startOfMonth(prevMonth), dateTo: endOfDay(prevMonthEnd) } },
    { label: "Trimestre", range: { dateFrom: startOfMonth(quarterStart), dateTo: today } },
    { label: "Anno", range: { dateFrom: startOfMonth(yearStart), dateTo: today } },
  ];
}

export function DateRangePicker({ value, onChange }: DateRangePickerProps) {
  const [showCustom, setShowCustom] = useState(false);
  const [customFrom, setCustomFrom] = useState(value.dateFrom);
  const [customTo, setCustomTo] = useState(value.dateTo);
  const presets = useMemo(() => getPresets(), []);

  const activePreset = presets.find(
    (p) => p.range.dateFrom === value.dateFrom && p.range.dateTo === value.dateTo
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Calendar className="h-4 w-4 text-muted-foreground" />
      {presets.map((preset) => (
        <Button
          key={preset.label}
          variant={activePreset?.label === preset.label ? "default" : "outline"}
          size="sm"
          onClick={() => {
            onChange(preset.range);
            setShowCustom(false);
          }}
        >
          {preset.label}
        </Button>
      ))}
      <Button
        variant={showCustom && !activePreset ? "default" : "outline"}
        size="sm"
        onClick={() => setShowCustom(!showCustom)}
      >
        Personalizzato
      </Button>

      {showCustom && (
        <div className="flex items-center gap-2 ml-2">
          <input
            type="date"
            value={customFrom}
            onChange={(e) => setCustomFrom(e.target.value)}
            className="border rounded px-2 py-1 text-sm bg-background"
          />
          <span className="text-muted-foreground text-sm">→</span>
          <input
            type="date"
            value={customTo}
            onChange={(e) => setCustomTo(e.target.value)}
            className="border rounded px-2 py-1 text-sm bg-background"
          />
          <Button
            size="sm"
            onClick={() => {
              if (customFrom && customTo) {
                onChange({ dateFrom: customFrom, dateTo: customTo });
              }
            }}
          >
            Applica
          </Button>
        </div>
      )}
    </div>
  );
}

export function getDefaultDateRange(): DateRange {
  const now = new Date();
  return {
    dateFrom: startOfMonth(now),
    dateTo: endOfDay(now),
  };
}
