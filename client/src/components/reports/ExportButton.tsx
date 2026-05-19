import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Download, FileText, Table } from "lucide-react";

interface ExportButtonProps {
  onExportCsv: (dataset: string) => void;
  csvDatasets: Array<{ key: string; label: string }>;
  loading?: boolean;
}

export function ExportButton({ onExportCsv, csvDatasets, loading }: ExportButtonProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={loading}>
          <Download className="h-4 w-4 mr-2" />
          {loading ? "Esportazione..." : "Esporta"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {csvDatasets.map((ds) => (
          <DropdownMenuItem key={ds.key} onClick={() => onExportCsv(ds.key)}>
            <Table className="h-4 w-4 mr-2" />
            CSV: {ds.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Helper to trigger CSV download from content string */
export function downloadCsv(content: string, filename: string) {
  // Add BOM for Excel to recognize UTF-8
  const bom = "\uFEFF";
  const blob = new Blob([bom + content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
