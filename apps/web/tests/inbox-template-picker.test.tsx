// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InboxTemplatePicker } from "../src/features/inbox-templates";
import { parseTemplates } from "../src/features/inbox-templates/catalog";
import { localized } from "./localized";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("keeps unsupported media, named and noncontiguous parameters unavailable", () => {
  const parsed = parseTemplates({ data: [
    { name: "valid", language: "he", status: "APPROVED", components: [{ type: "BODY", text: "שלום {{1}}" }] },
    { name: "gap", language: "he", status: "APPROVED", components: [{ type: "BODY", text: "שלום {{2}}" }] },
    { name: "named", language: "en", status: "APPROVED", components: [{ type: "BODY", text: "Hello {{name}}" }] },
    { name: "media", language: "en", status: "APPROVED", components: [{ type: "BODY", text: "Hello" }, { type: "HEADER", format: "IMAGE" }] },
  ] });
  expect(parsed.map((template) => template.supported)).toEqual([true, false, false, false]);
  expect(parsed[0]?.parameterCount).toBe(1);
});

it("reads the conversation account catalog and selects an approved draft without sending", async () => {
  const chosen = vi.fn();
  const close = vi.fn();
  const templates = [
    { name: "approved", language: "he", status: "APPROVED", body: "שלום", parameterCount: 0, supported: true },
    { name: "pending", language: "en", status: "PENDING", body: "Hello", parameterCount: 0, supported: true },
  ];
  const fetcher = vi.fn(async (_url: string) => ({ ok: true, json: async () => ({ templates, nextCursor: null }) }));
  vi.stubGlobal("fetch", fetcher);
  render(localized(<InboxTemplatePicker conversationId="conversation-a" open onClose={close} onSelect={chosen} />));
  await screen.findByText("approved");
  const buttons = screen.getAllByRole("button", { name: "Use in draft" });
  expect(buttons[1]?.hasAttribute("disabled")).toBe(true);
  fireEvent.click(buttons[0]!);
  expect(chosen).toHaveBeenCalledWith(templates[0]);
  expect(close).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0]).toContain("/conversation-a/templates");
});

it("clears the previous catalog and aborts its load when the conversation changes", async () => {
  const fetcher = vi.fn(async (url: string) => ({ ok: true, json: async () => ({ templates: [{ name: url.includes("tenant-a") ? "Only A" : "Only B", language: "he", status: "APPROVED", body: "hello", parameterCount: 0, supported: true }], nextCursor: null }) }));
  vi.stubGlobal("fetch", fetcher);
  const view = render(localized(<InboxTemplatePicker conversationId="tenant-a" open onClose={() => undefined} onSelect={() => undefined} />));
  await screen.findByText("Only A");
  view.rerender(localized(<InboxTemplatePicker conversationId="tenant-b" open onClose={() => undefined} onSelect={() => undefined} />));
  await waitFor(() => expect(screen.queryByText("Only A")).toBeNull());
  expect(screen.getByText("Only B")).toBeTruthy();
});
