// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AutoGreetingSettings } from "./auto-greeting-settings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const catalog = {
  templates: [
    {
      id: "1",
      name: "conversation_start",
      language: "he",
      status: "APPROVED",
      category: "MARKETING",
      body: "שלום! איך אפשר לעזור?",
      preview: "שלום! איך אפשר לעזור?",
      buttons: [],
      draft: { parameterCount: 0 },
    },
    {
      id: "2",
      name: "conversation_start",
      language: "en",
      status: "APPROVED",
      category: "MARKETING",
      body: "Hello! How can we help?",
      preview: "Hello! How can we help?",
      buttons: [],
      draft: { parameterCount: 0 },
    },
    {
      id: "3",
      name: "almog",
      language: "he",
      status: "APPROVED",
      category: "UTILITY",
      body: "שלום {{1}}",
      preview: "שלום {{1}}",
      buttons: [],
      draft: { parameterCount: 1 },
    },
    {
      id: "4",
      name: "draft_only",
      language: "he",
      status: "PENDING",
      category: "UTILITY",
      body: "Pending",
      preview: "Pending",
      buttons: [],
      draft: { parameterCount: 0 },
    },
  ],
  after: null,
  fetchedAt: "2026-10-05T00:00:00Z",
};

function serve(canManage: boolean) {
  const requests: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      requests.push({
        url,
        method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      if (url.endsWith("/templates"))
        return Promise.resolve(Response.json(catalog));
      return Promise.resolve(
        Response.json(
          method === "PUT"
            ? {
                greeting: {
                  channelId: "channel-a",
                  enabled: true,
                  templateName: "conversation_start",
                  languages: ["en", "he"],
                  fallbackLanguage: "en",
                  updatedAt: "2026-10-05T00:00:00Z",
                },
                canManage: true,
              }
            : { greeting: null, canManage },
        ),
      );
    }),
  );
  return requests;
}

it("offers only approved templates without variables and saves the choice", async () => {
  const requests = serve(true);
  render(<AutoGreetingSettings conversationId="conversation-a" locale="en" />);
  const select = await screen.findByLabelText("Template");
  const options = [...select.querySelectorAll("option")].map(
    (option) => option.textContent,
  );
  expect(options).toEqual([
    "Choose a template",
    "conversation_start · English, Hebrew",
  ]);
  expect(screen.getByText("Off")).toBeTruthy();
  fireEvent.change(select, { target: { value: "conversation_start" } });
  expect(screen.getByText("שלום! איך אפשר לעזור?")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Send the template automatically" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect((await screen.findByRole("status")).textContent).toBe("Saved.");
  await waitFor(() => expect(screen.getByText("On")).toBeTruthy());
  expect(requests.filter((request) => request.method === "PUT")).toEqual([
    {
      url: "/api/messaging/conversations/conversation-a/auto-greeting",
      method: "PUT",
      body: {
        enabled: true,
        templateName: "conversation_start",
        fallbackLanguage: "en",
      },
    },
  ]);
});

it("is read-only for people who cannot manage the workspace", async () => {
  const requests = serve(false);
  render(<AutoGreetingSettings conversationId="conversation-a" locale="he" />);
  await screen.findByText("רק מנהלי סביבת העבודה יכולים לשנות הגדרה זו.");
  expect(screen.queryByRole("button", { name: "שמירה" })).toBeNull();
  expect(
    screen
      .getByRole("checkbox", { name: "לשלוח את התבנית אוטומטית" })
      .closest("fieldset")
      ?.hasAttribute("disabled"),
  ).toBe(true);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
});
