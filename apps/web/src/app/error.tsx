"use client";

import { Button, ErrorState } from "@or-on/ui";
import { useEffect } from "react";

export default function ErrorBoundary({
  error,
  retry,
}: {
  readonly error: Error & { digest?: string };
  readonly retry: () => void;
}) {
  useEffect(() => {
    console.error("web_segment_error", { digest: error.digest });
  }, [error]);

  return (
    <ErrorState
      action={<Button onClick={retry}>Try again</Button>}
      description="The current view could not be rendered. No provider action was attempted."
      title="This view needs another pass"
    />
  );
}
