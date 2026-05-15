import { TableHead } from "@/components/ui/table";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { useCallback } from "react";

export type SortDirection = "asc" | "desc";
export type SortConfig = { key: string; dir: SortDirection } | null;

interface SortableTableHeadProps {
  /** Unique sort key for this column */
  sortKey: string;
  /** Current sort state */
  sort: SortConfig;
  /** Callback when user clicks to change sort */
  onSort: (config: SortConfig) => void;
  /** Column label */
  children: React.ReactNode;
  /** Additional className for TableHead */
  className?: string;
}

export function SortableTableHead({
  sortKey,
  sort,
  onSort,
  children,
  className,
}: SortableTableHeadProps) {
  const isActive = sort?.key === sortKey;
  const dir = isActive ? sort.dir : null;

  const handleClick = useCallback(() => {
    if (!isActive) {
      onSort({ key: sortKey, dir: "asc" });
    } else if (dir === "asc") {
      onSort({ key: sortKey, dir: "desc" });
    } else {
      // Third click → remove sort
      onSort(null);
    }
  }, [isActive, dir, sortKey, onSort]);

  const Icon = isActive ? (dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;

  return (
    <TableHead
      className={`cursor-pointer select-none hover:bg-accent/50 transition-colors ${className ?? ""}`}
      onClick={handleClick}
    >
      <div className="flex items-center gap-1">
        <span>{children}</span>
        <Icon
          className={`h-3.5 w-3.5 shrink-0 ${
            isActive ? "text-primary" : "text-muted-foreground/50"
          }`}
        />
      </div>
    </TableHead>
  );
}

/**
 * Generic sort helper — works with any array of objects.
 * Supports string, number, Date, null/undefined.
 */
export function sortData<T>(
  data: T[],
  sort: SortConfig,
  accessor: (item: T, key: string) => unknown,
): T[] {
  if (!sort) return data;
  const { key, dir } = sort;
  const multiplier = dir === "asc" ? 1 : -1;

  return [...data].sort((a, b) => {
    const va = accessor(a, key);
    const vb = accessor(b, key);

    // Nulls last
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;

    if (typeof va === "number" && typeof vb === "number") {
      return (va - vb) * multiplier;
    }

    if (va instanceof Date && vb instanceof Date) {
      return (va.getTime() - vb.getTime()) * multiplier;
    }

    // String comparison (case-insensitive)
    const sa = String(va).toLowerCase();
    const sb = String(vb).toLowerCase();
    return sa.localeCompare(sb) * multiplier;
  });
}
