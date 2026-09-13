import type { ReactNode } from "react";

export interface PageHeaderProps {
  readonly actions?: ReactNode;
  readonly className?: string;
  readonly description?: ReactNode;
  readonly eyebrow?: ReactNode;
  readonly meta?: ReactNode;
  readonly title: ReactNode;
}

export function PageHeader({
  actions,
  className = "",
  description,
  eyebrow,
  meta,
  title,
}: PageHeaderProps) {
  return (
    <header className={`or-page-header ${className}`.trim()}>
      <div className="or-page-header__copy">
        {eyebrow === undefined ? null : (
          <p className="or-page-header__eyebrow">{eyebrow}</p>
        )}
        <h1>{title}</h1>
        {description === undefined ? null : <p>{description}</p>}
        {meta === undefined ? null : (
          <div className="or-page-header__meta">{meta}</div>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="or-page-header__actions">{actions}</div>
      )}
    </header>
  );
}
