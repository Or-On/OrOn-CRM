import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Badge, Button, Input } from "../src/index.js";

describe("UI primitives", () => {
  it("renders semantic controls and explicit status text", () => {
    const markup = renderToStaticMarkup(
      <div>
        <Button>Continue</Button>
        <Input id="agent-name" label="Agent name" />
        <Badge label="Unavailable" tone="critical" />
      </div>,
    );

    expect(markup).toContain("<button");
    expect(markup).toContain('for="agent-name"');
    expect(markup).toContain("Unavailable");
  });
});
