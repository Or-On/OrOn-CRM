"use client";

import { Button, ErrorState } from "@or-on/ui";
import { ArrowLeft, ScanText } from "lucide-react";
import { useLocale } from "next-intl";
import Link from "next/link";
import { useEffect } from "react";

export default function FieldServiceOcrError({
  error,
  retry,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly retry: () => void;
}) {
  const he = useLocale().startsWith("he");

  useEffect(() => {
    console.error("field_service_ocr_segment_error", { digest: error.digest });
  }, [error]);

  return (
    <main
      aria-label={he ? "שגיאה בתור בקרת OCR" : "OCR review queue error"}
      className="page page--wide page--field-service page--workspace-premium route-state field-service-route-state"
    >
      <span aria-hidden="true" className="route-state__symbol">
        <ScanText size={28} />
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
              {he ? "חזרה לשירות השטח" : "Back to field service"}
            </Link>
          </div>
        }
        description={
          he
            ? "לא הצלחנו לטעון את תוצאות ה-OCR. לא בוצעו עיבוד או שינויים בתיק."
            : "We could not load OCR results. No processing or case changes were performed."
        }
        headingLevel={1}
        title={he ? "תור בקרת ה-OCR לא נטען" : "OCR review queue unavailable"}
      />
    </main>
  );
}
