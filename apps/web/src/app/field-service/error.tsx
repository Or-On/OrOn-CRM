"use client";

import { Button, ErrorState } from "@or-on/ui";
import { ArrowLeft, Wrench } from "lucide-react";
import Link from "next/link";
import { useLocale } from "next-intl";
import { useEffect } from "react";

export default function FieldServiceError({
  error,
  retry,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly retry: () => void;
}) {
  const he = useLocale().startsWith("he");

  useEffect(() => {
    console.error("field_service_segment_error", { digest: error.digest });
  }, [error]);

  return (
    <main
      aria-label={he ? "שגיאה בשירות השטח" : "Field service error"}
      className="page page--wide page--field-service page--workspace-premium route-state field-service-route-state"
    >
      <span className="route-state__symbol" aria-hidden="true">
        <Wrench size={28} />
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
              {he ? "חזרה לתיקי השירות" : "Back to service cases"}
            </Link>
          </div>
        }
        description={
          he
            ? "לא הצלחנו לטעון את סביבת השירות הזו. לא בוצע שינוי בתיק. נסו שוב, או חזרו לרשימת התיקים."
            : "We could not load this service workspace. No case changes were made. Try again, or return to the case list."
        }
        headingLevel={1}
        title={he ? "סביבת השירות לא נטענה" : "Service workspace unavailable"}
      />
    </main>
  );
}
