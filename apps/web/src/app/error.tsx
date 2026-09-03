"use client";
import { useTranslations } from "next-intl";

import { Button, ErrorState } from "@or-on/ui";
import { useEffect } from "react";

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
    <ErrorState
      action={<Button onClick={retry}>{t("common.retry")}</Button>}
      description={t("feedback.errorDescription")}
      title={t("feedback.errorTitle")}
    />
  );
}
