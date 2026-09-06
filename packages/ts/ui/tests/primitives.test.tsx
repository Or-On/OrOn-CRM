import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Badge, Button, Dialog, Input, Surface } from "../src/index.js";

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
    expect(markup).toContain(
      '<label class="or-field__label" for="agent-name">Agent name</label>',
    );
    expect(markup).not.toContain('<label class="or-field"');
    expect(markup).toContain("Unavailable");
  });

  it("preserves consumer input associations while adding hint and error semantics", () => {
    const markup = renderToStaticMarkup(
      <Input
        aria-describedby="external-help agent-name-hint"
        aria-errormessage="external-error"
        className="search-input"
        error="An agent name is required"
        hint="Use the public display name"
        id="agent-name"
        label="Agent name"
      />,
    );

    expect(markup).toContain('class="or-input search-input"');
    expect(markup).toContain(
      'aria-describedby="external-help agent-name-hint agent-name-error"',
    );
    expect(markup).toContain(
      'aria-errormessage="external-error agent-name-error"',
    );
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('id="agent-name-error" role="alert"');
    expect(markup).toContain("An agent name is required");
  });

  it("preserves consumer-provided input validation semantics without an error", () => {
    const markup = renderToStaticMarkup(
      <Input
        aria-invalid="grammar"
        className="custom-input"
        id="display-name"
        label="Display name"
      />,
    );

    expect(markup).toContain('aria-invalid="grammar"');
    expect(markup).toContain('class="or-input custom-input"');
    expect(markup).not.toContain("display-name-error");
  });

  it("allows a surface to use the semantic element appropriate to its content", () => {
    const article = renderToStaticMarkup(
      <Surface as="article" aria-label="Conversation summary" level="raised">
        Summary
      </Surface>,
    );
    const defaultSurface = renderToStaticMarkup(<Surface>Default</Surface>);

    expect(article).toContain("<article");
    expect(article).toContain('aria-label="Conversation summary"');
    expect(article).toContain("or-surface--raised");
    expect(defaultSurface).toContain("<section");
  });

  it("uses caller-localized dialog controls and viewport-safe scrolling", () => {
    const markup = renderToStaticMarkup(
      <Dialog
        closeLabel="סגירה"
        description="פרטי הפעולה"
        onClose={() => undefined}
        open={false}
        title="אישור"
      >
        <p>תוכן ארוך</p>
      </Dialog>,
    );

    expect(markup).toContain("<dialog");
    expect(markup).toContain('aria-label="סגירה"');
    expect(markup).toContain(">סגירה</button>");
    expect(markup).toContain("max-block-size:calc(100dvb - 2rem)");
    expect(markup).toContain("max-inline-size:calc(100dvi - 2rem)");
    expect(markup).toContain("overflow-y:auto");
    expect(markup).toContain("overscroll-behavior:contain");
  });
});
