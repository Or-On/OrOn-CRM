// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NotificationCenter } from "../src/features/shell";
import { localized } from "./localized";

const transport = vi.hoisted(() => ({
  mutate: vi.fn(),
  push: vi.fn(),
  read: vi.fn(),
}));

const inboundNotification = {
  id: "notification-1",
  title: "New WhatsApp message",
  body: "A customer message is waiting in the Inbox.",
  read: false,
  createdAt: "2026-09-13T08:00:00.000Z",
  referenceType: "conversation",
  referenceId: "conversation-1",
  type: "whatsapp.inbound",
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: transport.push }),
}));
vi.mock("../src/features/crm", () => ({
  crmMutation: transport.mutate,
  crmRead: transport.read,
}));

describe("durable notification center", () => {
  beforeEach(() => {
    transport.push.mockReset();
    transport.mutate.mockReset().mockResolvedValue({ updated: 1 });
    transport.read.mockReset().mockResolvedValue({
      notifications: [inboundNotification],
    });
    vi.stubGlobal("localStorage", {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows unread WhatsApp notifications in the top bar and opens their conversation", async () => {
    render(localized(<NotificationCenter />));

    await waitFor(() => expect(transport.read).toHaveBeenCalledOnce());
    const trigger = screen.getByRole("button", { name: "Notifications" });
    expect(trigger.textContent).toContain("1");
    fireEvent.click(trigger);
    const item = await screen.findByRole("button", {
      name: /New WhatsApp message/i,
    });
    fireEvent.click(item);

    await waitFor(() =>
      expect(transport.mutate).toHaveBeenCalledWith(
        "/api/notifications",
        { id: "notification-1" },
        { method: "PATCH" },
      ),
    );
    expect(transport.push).toHaveBeenCalledWith(
      "/inbox?conversation=conversation-1",
    );
  });

  it("announces only notifications that arrive after the initial durable baseline", async () => {
    const start = vi.fn();
    const stop = vi.fn();
    vi.stubGlobal(
      "AudioContext",
      class {
        currentTime = 0;
        destination = {};
        state = "running";
        close = vi.fn().mockResolvedValue(undefined);
        resume = vi.fn().mockResolvedValue(undefined);
        createGain() {
          return {
            gain: {
              setValueAtTime: vi.fn(),
              exponentialRampToValueAtTime: vi.fn(),
            },
            connect: vi.fn(),
          };
        }
        createOscillator() {
          return {
            frequency: { value: 0 },
            type: "sine",
            connect: vi.fn(),
            start,
            stop,
          };
        }
      },
    );
    let fresh = false;
    transport.read.mockImplementation(() =>
      Promise.resolve({
        notifications: fresh ? [inboundNotification] : [],
      }),
    );

    render(localized(<NotificationCenter pollIntervalMs={10} />));
    await waitFor(() => expect(transport.read).toHaveBeenCalled());
    const baselineCalls = transport.read.mock.calls.length;
    expect(baselineCalls).toBeGreaterThan(0);
    fireEvent.pointerDown(document.body);
    fresh = true;
    await waitFor(() =>
      expect(transport.read.mock.calls.length).toBeGreaterThan(baselineCalls),
    );
    expect((await screen.findByRole("status")).textContent).toContain(
      "New WhatsApp message",
    );
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(stop).toHaveBeenCalledTimes(2);
  });
});
