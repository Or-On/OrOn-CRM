// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TemplateBrowser } from "./template-browser";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const page = {
  templates: [
    {
      id: "1",
      name: "approved_he",
      language: "he",
      status: "APPROVED",
      category: "UTILITY",
      preview: "<script>literal preview</script>",
      buttons: [{ type: "QUICK_REPLY", text: "Support" }],
    },
    {
      id: "2",
      name: "pending_en",
      language: "en",
      status: "PENDING",
      category: "MARKETING",
      preview: "Pending",
      buttons: [],
    },
  ],
  after: null,
  fetchedAt: "2026-10-04T00:00:00Z",
};

it("loads scoped catalog, filters approval and previews literal text without sending", async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      requests.push(url);
      return Promise.resolve(new Response(JSON.stringify(page)));
    }),
  );
  render(<TemplateBrowser conversationId="conversation-a" locale="en" />);
  expect(requests).toEqual([]);
  fireEvent.click(
    screen.getByRole("button", { name: "Existing WhatsApp templates" }),
  );
  expect(screen.getByRole("status").textContent).toContain("Loading");
  await screen.findByRole("button", { name: /approved_he/u });
  expect(screen.queryByRole("button", { name: /pending_en/u })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /approved_he/u }));
  expect(screen.getByText("<script>literal preview</script>")).toBeTruthy();
  expect(document.querySelector("script")).toBeNull();
  fireEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByRole("button", { name: /pending_en/u })).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "en" } });
  expect(screen.queryByRole("button", { name: /approved_he/u })).toBeNull();
  expect(requests).toEqual([
    "/api/messaging/conversations/conversation-a/templates",
  ]);
});

it("shows recoverable error and clears previous conversation preview on switch", async () => {
  let call = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      call++;
      return Promise.resolve(
        call === 1
          ? new Response("unavailable", { status: 503 })
          : new Response(JSON.stringify(page)),
      );
    }),
  );
  const view = render(<TemplateBrowser conversationId="a" locale="en" />);
  fireEvent.click(
    screen.getByRole("button", { name: "Existing WhatsApp templates" }),
  );
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  fireEvent.click(await screen.findByRole("button", { name: /approved_he/u }));
  view.rerender(<TemplateBrowser conversationId="b" locale="he" />);
  expect(screen.queryByText("<script>literal preview</script>")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "תבניות WhatsApp קיימות" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /approved_he/u })).toBeTruthy(),
  );
});

it("fills only an approved supported draft and never submits delivery", async () => {
  const onSelect = vi.fn();
  const fetcher = vi.fn(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          ...page,
          templates: page.templates.map((item) => ({
            ...item,
            draft: { parameterCount: 1 },
          })),
        }),
      ),
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  render(
    <TemplateBrowser
      conversationId="conversation-a"
      locale="en"
      expanded
      onSelect={onSelect}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: /approved_he/u }));
  fireEvent.click(screen.getByRole("button", { name: "Use in draft" }));
  expect(onSelect).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "approved_he",
      language: "he",
      draft: { parameterCount: 1 },
    }),
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: /pending_en/u }));
  expect(
    screen
      .getByRole("button", { name: "Use in draft" })
      .hasAttribute("disabled"),
  ).toBe(true);
});
