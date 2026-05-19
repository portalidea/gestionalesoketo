import { ReactNode } from "react";
import { DateRangePicker, DateRange } from "./DateRangePicker";
import { ExportButton } from "./ExportButton";
import { ChevronLeft } from "lucide-react";
import { Link } from "wouter";

interface ReportLayoutProps {
  title: string;
  dateRange: DateRange;
  onDateRangeChange: (range: DateRange) => void;
  onExportCsv: (dataset: string) => void;
  csvDatasets: Array<{ key: string; label: string }>;
  exportLoading?: boolean;
  children: ReactNode;
}

export function ReportLayout({
  title,
  dateRange,
  onDateRangeChange,
  onExportCsv,
  csvDatasets,
  exportLoading,
  children,
}: ReportLayoutProps) {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Link href="/reports">
            <a className="text-muted-foreground hover:text-foreground transition-colors">
              <ChevronLeft className="h-5 w-5" />
            </a>
          </Link>
          <h1 className="text-2xl font-bold">{title}</h1>
        </div>
        <ExportButton
          onExportCsv={onExportCsv}
          csvDatasets={csvDatasets}
          loading={exportLoading}
        />
      </div>

      {/* Date Range Picker */}
      <DateRangePicker value={dateRange} onChange={onDateRangeChange} />

      {/* Content */}
      {children}
    </div>
  );
}
