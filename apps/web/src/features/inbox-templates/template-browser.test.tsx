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

const sendable = {
  ...page,
  templates: [
    {
      id: "3",
      name: "order_ready",
      language: "en",
      status: "APPROVED",
      category: "UTILITY",
      header: "Order update",
      body: "Hi {{1}}, your order is ready.",
      footer: null,
      preview: "Order update\nHi {{1}}, your order is ready.",
      buttons: [{ type: "QUICK_REPLY", text: "Thanks" }],
      draft: { parameterCount: 1 },
      unsupported: null,
    },
    {
      id: "4",
      name: "with_image",
      language: "en",
      status: "APPROVED",
      category: "MARKETING",
      body: "New arrivals",
      preview: "New arrivals",
      buttons: [],
      draft: null,
      unsupported: "media_header",
    },
    {
      id: "5",
      name: "waiting_review",
      language: "en",
      status: "PENDING",
      category: "UTILITY",
      body: "Hello",
      preview: "Hello",
      buttons: [],
      draft: { parameterCount: 0 },
      unsupported: null,
    },
  ],
};

function serve(body: unknown) {
  const fetcher = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response(JSON.stringify(body))),
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

it("loads the scoped catalog on demand, filters, searches and previews literal text", async () => {
  const fetcher = serve(page);
  render(<TemplateBrowser conversationId="conversation-a" locale="en" />);
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Existing WhatsApp templates" }),
  );
  expect(screen.getByRole("status").textContent).toContain("Loading");
  await screen.findByRole("button", { name: /approved_he/u });
  expect(screen.queryByRole("button", { name: /pending_en/u })).toBeNull();
  expect(screen.getByText(/Preview only/u)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /approved_he/u }));
  expect(
    screen.getAllByText("<script>literal preview</script>").length,
  ).toBeGreaterThan(0);
  expect(document.querySelector("script")).toBeNull();
  expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  fireEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByRole("button", { name: /pending_en/u })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "English" }));
  expect(screen.queryByRole("button", { name: /approved_he/u })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "All languages" }));
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "pending" },
  });
  expect(screen.queryByRole("button", { name: /approved_he/u })).toBeNull();
  expect(screen.getByRole("button", { name: /pending_en/u })).toBeTruthy();
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    "/api/messaging/conversations/conversation-a/templates",
  ]);
});

it("shows a recoverable error and clears the previous conversation's preview", async () => {
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

it("sends an approved template with its typed variables", async () => {
  serve(sendable);
  const onSend = vi.fn(() => Promise.resolve());
  render(
    <TemplateBrowser
      conversationId="conversation-a"
      locale="en"
      expanded
      onSend={onSend}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: /order_ready/u }));
  const send = screen.getByRole("button", { name: "Send" });
  expect(send.hasAttribute("disabled")).toBe(true);
  fireEvent.change(screen.getByLabelText("{{1}}"), {
    target: { value: " Dana " },
  });
  expect(screen.getByText("Dana").tagName).toBe("MARK");
  expect(screen.getByText("Order update")).toBeTruthy();
  expect(screen.getByText("Thanks")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({ name: "order_ready", language: "en" }),
      ["Dana"],
    ),
  );
});

it("shows a delivery refusal in place and never sends what Meta would reject", async () => {
  serve(sendable);
  const onSend = vi.fn(() =>
    Promise.reject(new Error("WhatsApp consent is required")),
  );
  render(
    <TemplateBrowser
      conversationId="conversation-a"
      locale="en"
      expanded
      onSend={onSend}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: /order_ready/u }));
  fireEvent.change(screen.getByLabelText("{{1}}"), {
    target: { value: "Dana" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "WhatsApp consent is required",
  );
  fireEvent.click(screen.getByRole("button", { name: /with_image/u }));
  expect(screen.getByText(/image, video or document header/u)).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Send" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: /waiting_review/u }));
  expect(screen.getByText(/approved by Meta/u)).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Send" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(onSend).toHaveBeenCalledTimes(1);
});

it("fills the reply instead of sending, and explains when delivery is unavailable", async () => {
  serve(sendable);
  const onSelect = vi.fn();
  const onSend = vi.fn(() => Promise.resolve());
  render(
    <TemplateBrowser
      conversationId="conversation-a"
      locale="en"
      expanded
      onSelect={onSelect}
      onSend={onSend}
      sendUnavailable="WhatsApp sending is not available."
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: /order_ready/u }));
  fireEvent.change(screen.getByLabelText("{{1}}"), {
    target: { value: "Dana" },
  });
  expect(screen.getByText("WhatsApp sending is not available.")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Send" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Insert into reply" }));
  expect(onSelect).toHaveBeenCalledWith(
    expect.objectContaining({ name: "order_ready" }),
    ["Dana"],
  );
  expect(onSend).not.toHaveBeenCalled();
});
