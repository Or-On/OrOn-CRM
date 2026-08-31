"use client";

import { Button } from "@or-on/ui";

export default function GlobalError({ retry }: { readonly retry: () => void }) {
  return (
    <html lang="en">
      <body>
        <main className="shell__main">
          <h1>Or-On Platform could not start</h1>
          <p>
            The global shell failed before any real provider action could run.
          </p>
          <Button onClick={retry}>Reload the shell</Button>
        </main>
      </body>
    </html>
  );
}
