import Link from "next/link";

import { EmptyState } from "@or-on/ui";

export default function NotFound() {
  return (
    <EmptyState
      action={
        <Link className="or-button or-button--primary" href="/">
          Return to foundation
        </Link>
      }
      description="This route is not part of the Phase 1 product shell."
      title="Page unavailable"
    />
  );
}
