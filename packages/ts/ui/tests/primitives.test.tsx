import { fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  DataTable,
  Dialog,
  InlineFeedback,
  Input,
  PageHeader,
  Progress,
  Select,
  StatusIndicator,
  Surface,
  Tabs,
  Textarea,
} from "../src/index.js";

describe("UI primitives", () => {
  it("cannot enable an explicitly enabled button while it is busy", () => {
    const markup = renderToStaticMarkup(
      <Button busy disabled={false}>
        Save
      </Button>,
    );
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('aria-busy="true"');
  });

  it("exposes bounded progress without invalid widths or inaccessible values", () => {
    const markup = renderToStaticMarkup(
      <Progress label="Campaign" max={0} value={Infinity} />,
    );
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-label="Campaign"');
    expect(markup).toContain('aria-valuenow="0"');
    expect(markup).toContain('aria-valuemax="100"');
    expect(markup).not.toMatch(/NaN|Infinity/);
    const bounded = renderToStaticMarkup(
      <Progress label="Campaign" max={20} value={30} />,
    );
    expect(bounded).toContain('aria-valuenow="20"');
    expect(bounded).toContain("inline-size:100%");
  });

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
    const plainSurface = renderToStaticMarkup(
      <Surface variant="plain">Plain</Surface>,
    );
    const insetSurface = renderToStaticMarkup(
      <Surface variant="inset">Inset</Surface>,
    );

    expect(article).toContain("<article");
    expect(article).toContain('aria-label="Conversation summary"');
    expect(article).toContain("or-surface--raised");
    expect(article).toContain("or-surface--outlined");
    expect(defaultSurface).toContain("<section");
    expect(defaultSurface).toContain("or-surface--outlined");
    expect(plainSurface).toContain("or-surface--plain");
    expect(insetSurface).toContain("or-surface--inset");
  });

  it("renders compact feedback with explicit urgency and tone", () => {
    const critical = renderToStaticMarkup(
      <InlineFeedback
        description="The operation could not be saved."
        title="Save failed"
        tone="critical"
      />,
    );
    const positive = renderToStaticMarkup(
      <InlineFeedback description="Saved" tone="positive" />,
    );

    expect(critical).toContain('role="alert"');
    expect(critical).toContain('aria-atomic="true"');
    expect(critical).toContain("or-inline-feedback--critical");
    expect(positive).toContain('role="status"');
    expect(positive).toContain("or-inline-feedback--positive");
  });

  it("keeps destructive confirmation explicit and cancel-focused", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const { container, getByText } = render(
      <ConfirmDialog
        cancelLabel="Cancel"
        confirmLabel="Remove member"
        destructive
        onCancel={onCancel}
        onConfirm={onConfirm}
        open={false}
        title="Remove this member?"
      >
        <p>Their workspace access will end.</p>
      </ConfirmDialog>,
    );

    expect(
      container.querySelector("[data-dialog-initial-focus]")?.textContent,
    ).toBe("Cancel");
    expect(container.querySelectorAll("button")).toHaveLength(2);
    expect(getByText("Remove member").className).toContain("or-button--danger");
    fireEvent.click(getByText("Remove member"));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("lets localized page headings retain route-specific layout hooks", () => {
    const markup = renderToStaticMarkup(
      <PageHeader
        className="page-heading"
        description="Current work"
        eyebrow="Workspace"
        title="Inbox"
      />,
    );

    expect(markup).toContain('class="or-page-header page-heading"');
    expect(markup).toContain("<h1>Inbox</h1>");
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

  it("links dense controls and data regions to explicit accessible labels", () => {
    const markup = renderToStaticMarkup(
      <div>
        <Textarea
          error="Required"
          hint="Operational notes only"
          id="notes"
          label="Notes"
        />
        <Select id="status" label="Status">
          <option>Open</option>
        </Select>
        <Checkbox name="consent">Consent confirmed</Checkbox>
        <StatusIndicator label="Healthy" tone="positive" />
        <DataTable label="Contacts">
          <tbody>
            <tr>
              <td>Customer</td>
            </tr>
          </tbody>
        </DataTable>
      </div>,
    );

    expect(markup).toContain('for="notes"');
    expect(markup).toContain('aria-errormessage="notes-error"');
    expect(markup).toContain('for="status"');
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain("Healthy");
    expect(markup).toContain('role="region" aria-label="Contacts"');
  });

  it("moves tabs in visual order for both LTR and RTL interfaces", () => {
    const changes: string[] = [];
    const { getByRole, rerender } = render(
      <Tabs
        activeId="agents"
        ariaLabel="Agent workspace"
        direction="ltr"
        items={[
          { controls: "agents-panel", id: "agents", label: "Agents" },
          { controls: "flows-panel", id: "flows", label: "Flows" },
        ]}
        onChange={(id) => changes.push(id)}
      />,
    );

    fireEvent.keyDown(getByRole("tab", { name: "Agents" }), {
      key: "ArrowRight",
    });
    expect(changes.at(-1)).toBe("flows");
    expect(
      getByRole("tab", { name: "Agents" }).getAttribute("aria-controls"),
    ).toBe("agents-panel");

    rerender(
      <Tabs
        activeId="agents"
        ariaLabel="מרחב סוכנים"
        direction="rtl"
        items={[
          { id: "agents", label: "סוכנים" },
          { id: "flows", label: "תהליכים" },
        ]}
        onChange={(id) => changes.push(id)}
      />,
    );
    fireEvent.keyDown(getByRole("tab", { name: "סוכנים" }), {
      key: "ArrowLeft",
    });
    expect(changes.at(-1)).toBe("flows");
  });
});
