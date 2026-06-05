/**
 * M11.B — CompanySwitcher
 *
 * Dropdown in the DashboardLayout header that shows the active company
 * and allows switching between companies the user has access to.
 * On switch, updates localStorage and reloads the page to re-fetch all data.
 */
import { Building2, Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

export function CompanySwitcher() {
  const { data: companies, isLoading } = trpc.companies.listMine.useQuery();
  const { data: activeCompany } = trpc.companies.getActive.useQuery();

  if (isLoading || !companies || companies.length <= 1) {
    // Single company or loading — show badge only, no dropdown
    return <CompanyBadge name={activeCompany?.name} />;
  }

  const handleSwitch = (companyId: string) => {
    if (companyId === activeCompany?.id) return;
    localStorage.setItem("activeCompanyId", companyId);
    window.location.reload();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-2 text-sm font-medium h-8 px-3"
        >
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <span className="max-w-[160px] truncate">
            {activeCompany?.name ?? "..."}
          </span>
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[220px]">
        {companies.map((c) => (
          <DropdownMenuItem
            key={c.id}
            onClick={() => handleSwitch(c.id)}
            className={cn(
              "flex items-center gap-2",
              !c.isActive && "opacity-50",
            )}
            disabled={!c.isActive}
          >
            <Check
              className={cn(
                "h-4 w-4",
                c.id === activeCompany?.id
                  ? "text-primary"
                  : "text-transparent",
              )}
            />
            <span className="truncate">{c.name}</span>
            {!c.isActive && (
              <span className="ml-auto text-xs text-muted-foreground">
                disattivata
              </span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * CompanyBadge — standalone badge showing the active company name.
 * Used when there's only one company (no dropdown needed).
 */
export function CompanyBadge({ name }: { name?: string | null }) {
  if (!name) return null;

  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground px-2">
      <Building2 className="h-4 w-4" />
      <span className="max-w-[160px] truncate font-medium">{name}</span>
    </div>
  );
}
