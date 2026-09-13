import type { ReactNode } from "react";

export interface DataTableProps {
  readonly children: ReactNode;
  readonly label: string;
  readonly minWidth?: string;
}

export function DataTable({
  children,
  label,
  minWidth = "48rem",
}: DataTableProps) {
  return (
    <div
      className="or-data-table"
      tabIndex={0}
      role="region"
      aria-label={label}
    >
      <table style={{ minWidth }}>
        <caption className="or-visually-hidden">{label}</caption>
        {children}
      </table>
    </div>
  );
}
