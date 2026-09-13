"use client";
import { useTranslations } from "next-intl";

import { Button, ErrorState } from "@or-on/ui";
import { useEffect } from "react";
import { RotateCcw } from "lucide-react";

export default function ErrorBoundary({
  error,
  retry,
}: {
  readonly error: Error & { digest?: string };
  readonly retry: () => void;
}) {
  const t = useTranslations();
  useEffect(() => {
    console.error("web_segment_error", { digest: error.digest });
  }, [error]);

  return (
    <main className="page route-state" aria-label={t("feedback.errorTitle")}>
      <span className="route-state__symbol" aria-hidden="true">
        <RotateCcw size={28} />
      </span>
      <ErrorState
        headingLevel={1}
        action={<Button onClick={retry}>{t("common.retry")}</Button>}
        description={t("feedback.errorDescription")}
        title={t("feedback.errorTitle")}
      />
    </main>
  );
}
