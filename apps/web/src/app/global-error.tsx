"use client";

import { Button } from "@or-on/ui";
import en from "../i18n/messages/en.json";
import he from "../i18n/messages/he.json";

export default function GlobalError({ retry }: { readonly retry: () => void }) {
  return (
    <html lang="en">
      <body>
        <main className="shell__main">
          <h1>{en.feedback.errorTitle}</h1>
          <p>{en.feedback.errorDescription}</p>
          <section lang="he" dir="rtl">
            <h2>{he.feedback.errorTitle}</h2>
            <p>{he.feedback.errorDescription}</p>
          </section>
          <Button onClick={retry}>
            {en.common.retry} / {he.common.retry}
          </Button>
        </main>
      </body>
    </html>
  );
}
