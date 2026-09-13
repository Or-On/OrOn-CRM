import type { ReactNode } from "react";

export interface SectionHeaderProps {
  readonly action?: ReactNode;
  readonly description?: ReactNode;
  readonly eyebrow?: ReactNode;
  readonly title: ReactNode;
}

export function SectionHeader({
  action,
  description,
  eyebrow,
  title,
}: SectionHeaderProps) {
  return (
    <header className="or-section-header">
      <div>
        {eyebrow === undefined ? null : (
          <p className="or-section-header__eyebrow">{eyebrow}</p>
        )}
        <h2>{title}</h2>
        {description === undefined ? null : <p>{description}</p>}
      </div>
      {action === undefined ? null : (
        <div className="or-section-header__action">{action}</div>
      )}
    </header>
  );
}
