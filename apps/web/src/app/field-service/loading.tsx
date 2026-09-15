import { LoadingSkeleton } from "@or-on/ui";
import { useLocale } from "next-intl";

export default function FieldServiceLoading() {
  const he = useLocale().startsWith("he");
  const label = he ? "טוען את סביבת שירות השטח" : "Loading field service";

  return (
    <main
      aria-busy="true"
      aria-label={label}
      className="page page--wide page--field-service page--workspace-premium"
    >
      <div className="field-service-loading">
        <LoadingSkeleton label={label} />
        <div aria-hidden="true" className="field-service-loading__metrics">
          <span className="or-skeleton" />
          <span className="or-skeleton" />
          <span className="or-skeleton" />
          <span className="or-skeleton" />
        </div>
        <div aria-hidden="true" className="field-service-loading__toolbar">
          <span className="or-skeleton" />
          <span className="or-skeleton" />
        </div>
        <div aria-hidden="true" className="field-service-loading__content">
          <span className="or-skeleton" />
          <span className="or-skeleton" />
          <span className="or-skeleton" />
        </div>
      </div>
    </main>
  );
}
