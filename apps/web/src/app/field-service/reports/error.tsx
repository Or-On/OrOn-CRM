"use client";

import { Button, ErrorState } from "@or-on/ui";
import { ArrowLeft, FileWarning } from "lucide-react";
import Link from "next/link";
import { useLocale } from "next-intl";
import { useEffect } from "react";

export default function ServiceReportsError({
  error,
  retry,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly retry: () => void;
}) {
  const he = useLocale().startsWith("he");

  useEffect(() => {
    console.error("field_service_reports_error", { digest: error.digest });
  }, [error]);

  return (
    <main
      aria-label={he ? "שגיאה בדוחות שירות" : "Service reports error"}
      className="page page--wide page--field-service page--workspace-premium route-state field-service-route-state"
    >
      <span aria-hidden="true" className="route-state__symbol">
        <FileWarning size={28} />
      </span>
      <ErrorState
        action={
          <div className="field-service-route-actions">
            <Button onClick={retry}>{he ? "ניסיון נוסף" : "Try again"}</Button>
            <Link
              className="or-button or-button--secondary or-button--medium"
              href="/field-service"
            >
              <ArrowLeft aria-hidden="true" size={16} />
              {he ? "חזרה לשירות השטח" : "Back to Field Service"}
            </Link>
          </div>
        }
        description={
          he
            ? "לא הצלחנו לטעון את היסטוריית הדוחות. לא בוצעו שינויים."
            : "We could not load report history. No changes were made."
        }
        headingLevel={1}
        title={he ? "הדוחות לא נטענו" : "Reports unavailable"}
      />
    </main>
  );
}
